import type { ChatMessage, FamilyProfile, StudyNote } from "../types";

export interface GenerateStudySummaryParams {
  messages: ChatMessage[];
  profile: FamilyProfile;
  subject?: string;
  language?: string;
}

/**
 * Returns true when a chat session is long enough to benefit from a condensed
 * Study Summary (4+ messages or substantial discussion length).
 */
export function isLongStudySession(messages: ChatMessage[]): boolean {
  if (messages.length >= 4) return true;
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return totalChars >= 600;
}

/**
 * Formats a multi-turn chat session into a clean transcript suitable for
 * concise Study Summary synthesis, keeping long sessions within a focused window.
 */
export function formatChatSessionForSummary(
  messages: ChatMessage[],
  profileName: string,
  maxMessages = 40
): string {
  const relevant = messages.slice(-maxMessages);
  return relevant
    .map((msg, index) => {
      const speaker = msg.role === "user" ? profileName : "Jogi Jarvis";
      const trimmed = msg.content.trim();
      const body =
        trimmed.length > 2200
          ? `${trimmed.slice(0, 2200)}... [trimmed for brevity]`
          : trimmed;
      return `[Turn ${index + 1}] ${speaker}: ${body}`;
    })
    .join("\n\n");
}

/**
 * Generates a concise 'Study Summary' StudyNote from a chat session via the
 * server-side Gemini endpoint and returns a ready-to-save StudyNote object.
 */
export async function generateStudySummaryFromSession({
  messages,
  profile,
  subject,
  language,
}: GenerateStudySummaryParams): Promise<StudyNote> {
  if (!messages || messages.length === 0) {
    throw new Error("Start a conversation first to generate a Study Summary.");
  }

  const transcript = formatChatSessionForSummary(messages, profile.name);
  const resolvedSubject =
    profile.role === "parent"
      ? "Personal"
      : !subject || subject === "All Subjects"
        ? "General"
        : subject;

  const res = await fetch("/api/notes/study-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript,
      messageCount: messages.length,
      profile,
      subject: resolvedSubject,
      language: language || profile.preferredLanguage || "Auto-Detect",
    }),
  });

  const data = (await res.json()) as {
    error?: string;
    note?: {
      title?: string;
      subject?: string;
      summary?: string;
      keyPoints?: string[];
      definitions?: Array<{ term: string; meaning: string }>;
      practiceQuestions?: Array<{ question: string; answer: string }>;
      teacherTip?: string;
    };
  };

  if (!res.ok || !data.note) {
    throw new Error(
      data.error || "Could not generate a Study Summary from this session."
    );
  }

  const rawTitle = (data.note.title || "Session Recap").trim();
  const title = rawTitle.toLowerCase().startsWith("study summary")
    ? rawTitle
    : `Study Summary: ${rawTitle}`;

  const now = new Date().toISOString();
  return {
    id: `note-summary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    profileId: profile.id,
    profileName: profile.name,
    title,
    subject: data.note.subject || resolvedSubject,
    summary: data.note.summary || "",
    keyPoints: Array.isArray(data.note.keyPoints) ? data.note.keyPoints : [],
    definitions: Array.isArray(data.note.definitions)
      ? data.note.definitions
      : [],
    practiceQuestions: Array.isArray(data.note.practiceQuestions)
      ? data.note.practiceQuestions
      : [],
    teacherTip: data.note.teacherTip || "",
    createdAt: now,
    updatedAt: now,
    sourceMode: "chat",
  };
}
