import type { ChatMessage, FamilyProfile, StudyNote } from "../types";
import { DEFAULT_PROFILES, SAMPLE_NOTES } from "../data/defaults";

const PROFILES_KEY = "jogi_jarvis_profiles_v1";
const CHATS_KEY = "jogi_jarvis_chats_v1";
const NOTES_KEY = "jogi_jarvis_notes_v1";

export function loadProfiles(): FamilyProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return DEFAULT_PROFILES;
    const parsed = JSON.parse(raw) as FamilyProfile[];
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_PROFILES;
    return parsed;
  } catch {
    return DEFAULT_PROFILES;
  }
}

export function saveProfiles(profiles: FamilyProfile[]): void {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore storage quota errors
  }
}

export function loadChats(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(CHATS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ChatMessage[]>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveChats(chats: Record<string, ChatMessage[]>): void {
  try {
    // Strip large raw base64 payloads from persisted localStorage to avoid quota overflow
    const sanitized: Record<string, ChatMessage[]> = {};
    for (const [profileId, list] of Object.entries(chats)) {
      sanitized[profileId] = list.slice(-40).map((m) => ({
        ...m,
        imageBase64: undefined,
      }));
    }
    localStorage.setItem(CHATS_KEY, JSON.stringify(sanitized));
  } catch {
    // ignore storage quota errors
  }
}

export function loadNotes(): StudyNote[] {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    if (!raw) return SAMPLE_NOTES;
    const parsed = JSON.parse(raw) as StudyNote[];
    return Array.isArray(parsed) ? parsed : SAMPLE_NOTES;
  } catch {
    return SAMPLE_NOTES;
  }
}

export function saveNotes(notes: StudyNote[]): void {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {
    // ignore storage quota errors
  }
}

export function formatShortDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 1) return "Just now";
    if (diffHours < 24 && date.getDate() === now.getDate()) {
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function noteToMarkdown(note: StudyNote): string {
  const lines: string[] = [
    `# ${note.title}`,
    "",
    `**Subject:** ${note.subject} | **For:** ${note.profileName} | **Date:** ${new Date(note.createdAt).toLocaleDateString()}`,
    "",
    "## The Big Idea",
    note.summary,
    "",
    "## Key Takeaways",
    ...note.keyPoints.map((pt) => `- ${pt}`),
  ];

  if (note.definitions.length > 0) {
    lines.push("", "## Key Terms & Formulas");
    for (const def of note.definitions) {
      lines.push(`- **${def.term}:** ${def.meaning}`);
    }
  }

  if (note.practiceQuestions.length > 0) {
    lines.push("", "## Practice Check");
    note.practiceQuestions.forEach((pq, idx) => {
      lines.push(`${idx + 1}. **Q:** ${pq.question}`);
      lines.push(`   **A:** ${pq.answer}`);
    });
  }

  if (note.teacherTip) {
    lines.push("", "## Teacher's Revision Tip", `> ${note.teacherTip}`);
  }

  return lines.join("\n");
}
