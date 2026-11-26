# Jogi Jarvis Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Default Deny:** Any path outside `/users/{userId}` and its four explicitly declared subcollections (`profiles`, `notes`, `chats`, `alarms`) is strictly denied for all reads and writes.
2. **Strict Owner Isolation (Zero Cross-User Access):** A user can only read, list, create, update, or delete documents inside `/users/{userId}` when `request.auth != null`, `request.auth.uid == userId`, and `request.auth.token.email_verified == true`.
3. **Master Gate Parent Existence:** Every write to `profiles`, `notes`, `chats`, or `alarms` requires the parent `/users/{userId}` document to exist (`exists(...)`) and belong to `request.auth.uid`.
4. **Strict Keys & No Shadow Fields:** Every `create` enforces exact `keys().hasAll(...) && keys().hasOnly(...)`; every `update` enforces `incoming().diff(existing()).affectedKeys().hasOnly(...)` and invokes the entity's `isValid[Entity]()` helper.
5. **Immutable Ownership & Timestamps:** `uid`, `ownerId`, `id`, and `createdAt` can never be altered after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
6. **Path Variable & Payload Size Hardening:** Every single-document ID path variable (`userId`, `profileId`, `noteId`, `alarmId`) must match `^[a-zA-Z0-9_\-]+$` and `<= 128` chars; every string and array has an explicit `.size()` bound.
7. **Secure List Queries:** Every `allow list` verifies `isVerifiedOwner(userId)` AND `resource.data.ownerId == request.auth.uid` without invoking `get()` or `exists()`.

## 2. The "Dirty Dozen" Adversarial Payloads (Must All Return PERMISSION_DENIED)
1. **Unauthenticated Read:** `GET /users/user-a/notes/note-1` with `auth = null`.
2. **Unverified Email Write:** `CREATE /users/user-a` with `auth = { uid: "user-a", token: { email_verified: false } }`.
3. **Cross-User Read:** `GET /users/user-a/notes/note-1` with `auth = { uid: "user-b", token: { email_verified: true } }`.
4. **Identity Spoofing on Create:** `CREATE /users/user-a/notes/note-1` with `{ ownerId: "user-b", ... }`.
5. **Shadow / Ghost Field Injection:** `CREATE /users/user-a/profiles/p-1` including unexpected field `{ isAdmin: true }`.
6. **Client-Forged Timestamp:** `CREATE /users/user-a/notes/note-1` with `createdAt: Timestamp(2020-01-01)` instead of `serverTimestamp()`.
7. **Immutable Field Mutation:** `UPDATE /users/user-a/notes/note-1` modifying `ownerId` or `createdAt`.
8. **Path ID Poisoning:** `CREATE /users/user-a/notes/bad..id$with/junk` or 500-char document ID.
9. **Oversized String / Denial-of-Wallet:** `CREATE /users/user-a/notes/note-2` with `title` length > 200 or `summary` length > 4000.
10. **Oversized Array Poisoning:** `CREATE /users/user-a/notes/note-3` with `keyPoints` having 50 items (> 30 max) or non-string first element (`keyPoints: [123]`).
11. **Value Poisoning on Allowed Update Field:** `UPDATE /users/user-a/alarms/a-1` setting `ringing: "yes"` (string instead of boolean) or `triggerAt: -5`.
12. **Orphaned Subcollection Write:** `CREATE /users/user-a/profiles/p-1` before `/users/user-a` root document exists.
