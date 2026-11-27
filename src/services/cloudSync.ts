import type { User } from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { db, handleFirestoreError, OperationType } from "../firebase";
import type {
  ActiveAlarm,
  ChatMessage,
  FamilyProfile,
  StudyNote,
  VoiceName,
} from "../types";

const ALLOWED_VOICES = new Set<VoiceName>([
  "Zephyr",
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
]);

export function sanitizeDocId(raw: string, fallbackPrefix = "doc"): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 128);
  return cleaned.length > 0 ? cleaned : `${fallbackPrefix}-${Date.now()}`;
}

function clampStr(value: unknown, maxLen: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLen);
}

function timestampToIso(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === "string" && val.length > 0) {
    return val;
  }
  return new Date().toISOString();
}

function buildProfilePayload(uid: string, profile: FamilyProfile) {
  const safeId = sanitizeDocId(profile.id, "profile");
  const safeVoice: VoiceName = ALLOWED_VOICES.has(profile.voiceName)
    ? profile.voiceName
    : "Kore";

  const payload: Record<string, unknown> = {
    ownerId: uid,
    id: safeId,
    name: clampStr(profile.name, 80, "Family Member"),
    relation: clampStr(profile.relation, 60, "Member"),
    role: profile.role === "parent" ? "parent" : "student",
    voiceName: safeVoice,
    initials: clampStr(profile.initials, 4, "FM"),
    accentColor: clampStr(profile.accentColor, 32, "#1D4ED8"),
  };

  if (typeof profile.grade === "string") {
    payload.grade = clampStr(profile.grade, 60);
  }
  if (typeof profile.learningGoal === "string") {
    payload.learningGoal = clampStr(profile.learningGoal, 300);
  }
  if (typeof profile.preferredLanguage === "string") {
    payload.preferredLanguage = clampStr(profile.preferredLanguage, 60);
  }
  payload.avatarUrl =
    typeof profile.avatarUrl === "string"
      ? profile.avatarUrl.slice(0, 180000)
      : "";

  return { safeId, payload };
}

function buildNotePayload(uid: string, note: StudyNote) {
  const safeId = sanitizeDocId(note.id, "note");
  const safeProfileId = sanitizeDocId(note.profileId, "profile");
  const sourceMode =
    note.sourceMode === "voice" || note.sourceMode === "topic"
      ? note.sourceMode
      : "chat";

  const keyPoints = (Array.isArray(note.keyPoints) ? note.keyPoints : [])
    .slice(0, 30)
    .map((p) => clampStr(String(p ?? ""), 600))
    .filter(Boolean);

  const definitions = (Array.isArray(note.definitions) ? note.definitions : [])
    .slice(0, 30)
    .map((d) => ({
      term: clampStr(d?.term, 120, "Term"),
      meaning: clampStr(d?.meaning, 600),
    }));

  const practiceQuestions = (
    Array.isArray(note.practiceQuestions) ? note.practiceQuestions : []
  )
    .slice(0, 20)
    .map((q) => ({
      question: clampStr(q?.question, 400, "Question"),
      answer: clampStr(q?.answer, 800),
    }));

  const payload = {
    ownerId: uid,
    id: safeId,
    profileId: safeProfileId,
    profileName: clampStr(note.profileName, 80, "Family Member"),
    title: clampStr(note.title, 200, "Study Note"),
    subject: clampStr(note.subject, 80, "General"),
    summary: clampStr(note.summary, 4000),
    keyPoints,
    definitions,
    practiceQuestions,
    teacherTip: clampStr(note.teacherTip, 1000),
    sourceMode,
  };

  return { safeId, payload };
}

function buildChatPayload(uid: string, profileId: string, messages: ChatMessage[]) {
  const safeProfileId = sanitizeDocId(profileId, "profile");
  // Keep latest 40 text messages and strip raw base64/dataUrl homework photos to stay well under Firestore 1MB limit
  const sanitizedMessages = messages.slice(-40).map((m) => {
    const clean: Record<string, unknown> = {
      id: sanitizeDocId(m.id, "msg"),
      role: m.role === "user" ? "user" : "assistant",
      content: clampStr(m.content, 8000, ""),
      timestamp: clampStr(m.timestamp, 40, new Date().toISOString()),
    };
    if (m.subject) clean.subject = clampStr(m.subject, 80);
    if (m.noteSavedId) clean.noteSavedId = sanitizeDocId(m.noteSavedId, "note");
    if (Array.isArray(m.sources) && m.sources.length > 0) {
      clean.sources = m.sources.slice(0, 6).map((s) => ({
        uri: clampStr(s.uri, 500),
        title: clampStr(s.title, 160),
      }));
    }
    if (Array.isArray(m.actions) && m.actions.length > 0) {
      clean.actions = m.actions.slice(0, 4).map((a) => ({
        id: sanitizeDocId(a.id, "act"),
        kind: a.kind,
        label: clampStr(a.label, 80),
        subtitle: a.subtitle ? clampStr(a.subtitle, 120) : "",
        href: a.href ? clampStr(a.href, 600) : "",
        external: Boolean(a.external),
      }));
    }
    return clean;
  });

  return {
    safeProfileId,
    payload: {
      ownerId: uid,
      profileId: safeProfileId,
      messages: sanitizedMessages,
    },
  };
}

function buildAlarmPayload(uid: string, alarm: ActiveAlarm) {
  const safeId = sanitizeDocId(alarm.id, "alarm");
  const triggerAt =
    typeof alarm.triggerAt === "number" && alarm.triggerAt > 0
      ? alarm.triggerAt
      : Date.now() + 60_000;

  return {
    safeId,
    payload: {
      ownerId: uid,
      id: safeId,
      label: clampStr(alarm.label, 120, "Jogi Jarvis Alarm"),
      triggerAt,
      type: alarm.type === "timer" ? "timer" : "alarm",
      ringing: Boolean(alarm.ringing),
    },
  };
}

export async function ensureUserAccount(user: User): Promise<void> {
  const userPath = `users/${user.uid}`;
  const ref = doc(db, "users", user.uid);
  const displayName = clampStr(
    user.displayName || user.email?.split("@")[0] || "Jogi Family",
    120,
    "Jogi Family"
  );
  const photoURL = clampStr(user.photoURL || "", 500);

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const data: Record<string, unknown> = {
        uid: user.uid,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (photoURL) data.photoURL = photoURL;
      await setDoc(ref, data);
    } else {
      const updateData: Record<string, unknown> = {
        displayName,
        updatedAt: serverTimestamp(),
      };
      if (photoURL) updateData.photoURL = photoURL;
      await updateDoc(ref, updateData);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export async function saveCloudProfile(
  uid: string,
  profile: FamilyProfile
): Promise<void> {
  const { safeId, payload } = buildProfilePayload(uid, profile);
  const docPath = `users/${uid}/profiles/${safeId}`;
  const ref = doc(db, "users", uid, "profiles", safeId);

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const updateFields: Record<string, unknown> = {
        name: payload.name,
        relation: payload.relation,
        role: payload.role,
        voiceName: payload.voiceName,
        initials: payload.initials,
        accentColor: payload.accentColor,
        updatedAt: serverTimestamp(),
      };
      if ("grade" in payload) updateFields.grade = payload.grade;
      if ("learningGoal" in payload)
        updateFields.learningGoal = payload.learningGoal;
      if ("preferredLanguage" in payload)
        updateFields.preferredLanguage = payload.preferredLanguage;
      if ("avatarUrl" in payload) updateFields.avatarUrl = payload.avatarUrl;
      await updateDoc(ref, updateFields);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docPath);
  }
}

export async function deleteCloudProfile(
  uid: string,
  profileId: string
): Promise<void> {
  const safeId = sanitizeDocId(profileId, "profile");
  const docPath = `users/${uid}/profiles/${safeId}`;
  try {
    await deleteDoc(doc(db, "users", uid, "profiles", safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}

export async function saveCloudNote(
  uid: string,
  note: StudyNote
): Promise<void> {
  const { safeId, payload } = buildNotePayload(uid, note);
  const docPath = `users/${uid}/notes/${safeId}`;
  const ref = doc(db, "users", uid, "notes", safeId);

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        profileId: payload.profileId,
        profileName: payload.profileName,
        title: payload.title,
        subject: payload.subject,
        summary: payload.summary,
        keyPoints: payload.keyPoints,
        definitions: payload.definitions,
        practiceQuestions: payload.practiceQuestions,
        teacherTip: payload.teacherTip,
        sourceMode: payload.sourceMode,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docPath);
  }
}

export async function deleteCloudNote(
  uid: string,
  noteId: string
): Promise<void> {
  const safeId = sanitizeDocId(noteId, "note");
  const docPath = `users/${uid}/notes/${safeId}`;
  try {
    await deleteDoc(doc(db, "users", uid, "notes", safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}

export async function saveCloudChatThread(
  uid: string,
  profileId: string,
  messages: ChatMessage[]
): Promise<void> {
  const { safeProfileId, payload } = buildChatPayload(uid, profileId, messages);
  const docPath = `users/${uid}/chats/${safeProfileId}`;
  const ref = doc(db, "users", uid, "chats", safeProfileId);

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        messages: payload.messages,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docPath);
  }
}

export async function saveCloudAlarm(
  uid: string,
  alarm: ActiveAlarm
): Promise<void> {
  const { safeId, payload } = buildAlarmPayload(uid, alarm);
  const docPath = `users/${uid}/alarms/${safeId}`;
  const ref = doc(db, "users", uid, "alarms", safeId);

  try {
    const existingSnap = await getDoc(ref);
    if (!existingSnap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        label: payload.label,
        triggerAt: payload.triggerAt,
        type: payload.type,
        ringing: payload.ringing,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, docPath);
  }
}

export async function deleteCloudAlarm(
  uid: string,
  alarmId: string
): Promise<void> {
  const safeId = sanitizeDocId(alarmId, "alarm");
  const docPath = `users/${uid}/alarms/${safeId}`;
  try {
    await deleteDoc(doc(db, "users", uid, "alarms", safeId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, docPath);
  }
}

/**
 * Uploads local device profiles, Study Notes, chats, and alarms to Firestore
 * when the cloud workspace is brand-new (or when the user manually requests a backup).
 */
export async function syncLocalWorkspaceToCloud(
  uid: string,
  localData: {
    profiles: FamilyProfile[];
    notes: StudyNote[];
    chatsByProfile: Record<string, ChatMessage[]>;
    alarms: ActiveAlarm[];
  },
  onlyIfCloudEmpty = true
): Promise<boolean> {
  if (onlyIfCloudEmpty) {
    const profilesPath = `users/${uid}/profiles`;
    try {
      const existingProfiles = await getDocs(
        query(collection(db, "users", uid, "profiles"), where("ownerId", "==", uid))
      );
      if (!existingProfiles.empty) {
        return false;
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, profilesPath);
    }
  }

  for (const p of localData.profiles) {
    await saveCloudProfile(uid, p);
  }
  for (const n of localData.notes) {
    await saveCloudNote(uid, n);
  }
  for (const [profileId, msgs] of Object.entries(localData.chatsByProfile)) {
    if (Array.isArray(msgs) && msgs.length > 0) {
      await saveCloudChatThread(uid, profileId, msgs);
    }
  }
  for (const alarm of localData.alarms) {
    await saveCloudAlarm(uid, alarm);
  }
  return true;
}

export interface CloudListeners {
  onProfiles: (profiles: FamilyProfile[]) => void;
  onNotes: (notes: StudyNote[]) => void;
  onChats: (chatsByProfile: Record<string, ChatMessage[]>) => void;
  onAlarms: (alarms: ActiveAlarm[]) => void;
  onSyncError?: (message: string) => void;
}

export function subscribeToFamilyCloud(
  uid: string,
  listeners: CloudListeners
): Unsubscribe {
  const unsubs: Unsubscribe[] = [];

  // 1. Profiles listener
  const profilesPath = `users/${uid}/profiles`;
  const profilesQ = query(
    collection(db, "users", uid, "profiles"),
    where("ownerId", "==", uid)
  );
  unsubs.push(
    onSnapshot(
      profilesQ,
      (snap) => {
        if (snap.empty) return;
        const list: FamilyProfile[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            name: String(data.name || "Family Member"),
            relation: String(data.relation || "Member"),
            role: data.role === "parent" ? "parent" : "student",
            grade: typeof data.grade === "string" ? data.grade : undefined,
            learningGoal:
              typeof data.learningGoal === "string"
                ? data.learningGoal
                : undefined,
            voiceName: ALLOWED_VOICES.has(data.voiceName)
              ? data.voiceName
              : "Kore",
            preferredLanguage:
              typeof data.preferredLanguage === "string"
                ? data.preferredLanguage
                : "Auto-Detect",
            avatarUrl:
              typeof data.avatarUrl === "string" && data.avatarUrl
                ? data.avatarUrl
                : undefined,
            initials: String(data.initials || "FM"),
            accentColor: String(data.accentColor || "#1D4ED8"),
          };
        });
        // Keep parent profile first for consistent order
        list.sort((a, b) =>
          a.role === b.role ? a.name.localeCompare(b.name) : a.role === "parent" ? -1 : 1
        );
        listeners.onProfiles(list);
      },
      (error) => {
        if (error.code === "unavailable") {
          listeners.onSyncError?.(
            "Cloud Sync is temporarily offline and will reconnect automatically."
          );
          return;
        }
        listeners.onSyncError?.(error.message);
        handleFirestoreError(error, OperationType.LIST, profilesPath);
      }
    )
  );

  // 2. Study Notes listener
  const notesPath = `users/${uid}/notes`;
  const notesQ = query(
    collection(db, "users", uid, "notes"),
    where("ownerId", "==", uid)
  );
  unsubs.push(
    onSnapshot(
      notesQ,
      (snap) => {
        const list: StudyNote[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            profileId: String(data.profileId || "jogi-parent"),
            profileName: String(data.profileName || "Family"),
            title: String(data.title || "Study Note"),
            subject: String(data.subject || "General"),
            summary: String(data.summary || ""),
            keyPoints: Array.isArray(data.keyPoints)
              ? data.keyPoints.map(String)
              : [],
            definitions: Array.isArray(data.definitions)
              ? data.definitions.map((item) => ({
                  term: String(item?.term || ""),
                  meaning: String(item?.meaning || ""),
                }))
              : [],
            practiceQuestions: Array.isArray(data.practiceQuestions)
              ? data.practiceQuestions.map((item) => ({
                  question: String(item?.question || ""),
                  answer: String(item?.answer || ""),
                }))
              : [],
            teacherTip: String(data.teacherTip || ""),
            createdAt: timestampToIso(data.createdAt),
            updatedAt: timestampToIso(data.updatedAt),
            sourceMode:
              data.sourceMode === "voice" || data.sourceMode === "topic"
                ? data.sourceMode
                : "chat",
          };
        });
        list.sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
        listeners.onNotes(list);
      },
      (error) => {
        if (error.code === "unavailable") {
          listeners.onSyncError?.(
            "Cloud Sync is temporarily offline and will reconnect automatically."
          );
          return;
        }
        listeners.onSyncError?.(error.message);
        handleFirestoreError(error, OperationType.LIST, notesPath);
      }
    )
  );

  // 3. Chats listener
  const chatsPath = `users/${uid}/chats`;
  const chatsQ = query(
    collection(db, "users", uid, "chats"),
    where("ownerId", "==", uid)
  );
  unsubs.push(
    onSnapshot(
      chatsQ,
      (snap) => {
        const mapped: Record<string, ChatMessage[]> = {};
        for (const d of snap.docs) {
          const data = d.data();
          const pid = String(data.profileId || d.id);
          if (Array.isArray(data.messages)) {
            mapped[pid] = data.messages.map((m) => ({
              id: String(m?.id || `m-${Math.random().toString(36).slice(2, 7)}`),
              role: m?.role === "user" ? "user" : "assistant",
              content: String(m?.content || ""),
              timestamp: String(m?.timestamp || new Date().toISOString()),
              subject: typeof m?.subject === "string" ? m.subject : undefined,
              noteSavedId:
                typeof m?.noteSavedId === "string" ? m.noteSavedId : undefined,
              sources: Array.isArray(m?.sources) ? m.sources : undefined,
              actions: Array.isArray(m?.actions) ? m.actions : undefined,
            }));
          }
        }
        listeners.onChats(mapped);
      },
      (error) => {
        if (error.code === "unavailable") {
          listeners.onSyncError?.(
            "Cloud Sync is temporarily offline and will reconnect automatically."
          );
          return;
        }
        listeners.onSyncError?.(error.message);
        handleFirestoreError(error, OperationType.LIST, chatsPath);
      }
    )
  );

  // 4. Alarms listener
  const alarmsPath = `users/${uid}/alarms`;
  const alarmsQ = query(
    collection(db, "users", uid, "alarms"),
    where("ownerId", "==", uid)
  );
  unsubs.push(
    onSnapshot(
      alarmsQ,
      (snap) => {
        const list: ActiveAlarm[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            label: String(data.label || "Alarm"),
            triggerAt:
              typeof data.triggerAt === "number" ? data.triggerAt : Date.now(),
            type: data.type === "timer" ? "timer" : "alarm",
            ringing: Boolean(data.ringing),
          };
        });
        listeners.onAlarms(list);
      },
      (error) => {
        if (error.code === "unavailable") {
          listeners.onSyncError?.(
            "Cloud Sync is temporarily offline and will reconnect automatically."
          );
          return;
        }
        listeners.onSyncError?.(error.message);
        handleFirestoreError(error, OperationType.LIST, alarmsPath);
      }
    )
  );

  return () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        // ignore
      }
    }
  };
}
