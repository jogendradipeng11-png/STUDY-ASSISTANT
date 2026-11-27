export type AppTab = "assistant" | "live" | "translate" | "read" | "notes" | "family";

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

export interface StudyPhotoResult {
  title: string;
  imageUrl: string;
  pageUrl: string;
  credit?: string;
}

export type Study3DArchetype =
  | "solar"
  | "atom"
  | "dna"
  | "heart"
  | "plant"
  | "watercycle"
  | "rocket"
  | "circuit"
  | "earth"
  | "volcano"
  | "wave"
  | "architecture"
  | "custom";

export type Study3DEnvironment =
  | "studio"
  | "space"
  | "outdoor"
  | "lab"
  | "sunset";

export interface Study3DPartSpec {
  shape:
    | "sphere"
    | "box"
    | "cylinder"
    | "cone"
    | "torus"
    | "capsule"
    | "icosahedron"
    | "ring";
  position: [number, number, number];
  rotation?: [number, number, number];
  scale: [number, number, number];
  color: string;
  metalness?: number;
  roughness?: number;
  emissive?: string;
  opacity?: number;
  animate?: "spin" | "orbit" | "pulse" | "float" | "none";
}

export interface Study3DSceneBlueprint {
  archetype: Study3DArchetype;
  environment: Study3DEnvironment;
  primaryColor: string;
  accentColor: string;
  title: string;
  subtitle?: string;
  customParts?: Study3DPartSpec[];
}

export interface StudyDiagramMedia {
  title: string;
  caption: string;
  svgCode: string;
  scene3d?: Study3DSceneBlueprint;
}

export interface StudyVideoScene {
  heading: string;
  narration: string;
  keyFact: string;
  visualAccent:
    | "sun"
    | "atom"
    | "globe"
    | "wave"
    | "chart"
    | "book"
    | "leaf"
    | "rocket"
    | "circuit"
    | "heart";
  bulletPoints: string[];
  durationSec: number;
}

export interface StudyVideoStoryboard {
  title: string;
  subtitle: string;
  subject: string;
  language?: string;
  themeColor: string;
  scenes: StudyVideoScene[];
  scene3d?: Study3DSceneBlueprint;
}

export interface StudyVideoLink {
  title: string;
  url: string;
  source: string;
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
  studyDiagram?: StudyDiagramMedia;
  studyPhotos?: StudyPhotoResult[];
  studyVideo?: StudyVideoStoryboard;
  studyVideoLinks?: StudyVideoLink[];
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
