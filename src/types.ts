export type AppTab = "assistant" | "live" | "read" | "notes" | "family";

export type VoiceName = "Zephyr" | "Kore" | "Puck" | "Charon" | "Fenrir";

export type ProfileRole = "parent" | "student";

export interface FamilyProfile {
  id: string;
  name: string;
  relation: string;
  role: ProfileRole;
  grade?: string;
  learningGoal?: string;
  voiceName: VoiceName;
  preferredLanguage?: string;
  avatarUrl?: string;
  initials: string;
  accentColor: string;
}

export interface GroundingSource {
  uri: string;
  title: string;
}

export type MobileActionKind =
  | "youtube"
  | "whatsapp"
  | "sms"
  | "call"
  | "email"
  | "maps"
  | "calendar"
  | "alarm"
  | "timer"
  | "web";

export interface MobileAction {
  id: string;
  kind: MobileActionKind;
  label: string;
  subtitle?: string;
  href?: string;
  external?: boolean;
}

export interface ActiveAlarm {
  id: string;
  label: string;
  triggerAt: number;
  type: "alarm" | "timer";
  ringing?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  subject?: string;
  imageDataUrl?: string;
  imageBase64?: string;
  imageMimeType?: string;
  sources?: GroundingSource[];
  actions?: MobileAction[];
  noteSavedId?: string;
}

export interface TermDefinition {
  term: string;
  meaning: string;
}

export interface PracticeQuestion {
  question: string;
  answer: string;
}

export interface StudyNote {
  id: string;
  profileId: string;
  profileName: string;
  title: string;
  subject: string;
  summary: string;
  keyPoints: string[];
  definitions: TermDefinition[];
  practiceQuestions: PracticeQuestion[];
  teacherTip: string;
  createdAt: string;
  updatedAt: string;
  sourceMode: "chat" | "voice" | "topic";
}

export interface LiveTranscriptItem {
  id: string;
  speaker: "user" | "jarvis";
  text: string;
  timestamp: string;
  isImportant?: boolean;
  importantManuallySet?: boolean;
}
