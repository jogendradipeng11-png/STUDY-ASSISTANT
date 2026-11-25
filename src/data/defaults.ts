import type { FamilyProfile, StudyNote, VoiceName } from "../types";

export const STUDY_DESK_HERO_URL =
  "/src/assets/images/hero_study_desk_1795584490604.jpg";

export const AVATAR_PRESETS = {
  parent: "/src/assets/images/avatar_jogi_parent_1795584487775.jpg",
  son: "/src/assets/images/avatar_son_student_1795584488464.jpg",
  daughter: "/src/assets/images/avatar_daughter_student_1795584489041.jpg",
};

export const VOICE_OPTIONS: Array<{
  id: VoiceName;
  label: string;
  tone: string;
}> = [
  { id: "Zephyr", label: "Zephyr", tone: "Warm & calm mentor" },
  { id: "Kore", label: "Kore", tone: "Clear & bright teacher" },
  { id: "Puck", label: "Puck", tone: "Friendly & lively guide" },
  { id: "Charon", label: "Charon", tone: "Steady & composed" },
  { id: "Fenrir", label: "Fenrir", tone: "Deep & reassuring" },
];

export const SUBJECT_LIST = [
  "All Subjects",
  "Mathematics",
  "Science",
  "English",
  "History",
  "Geography",
  "Computer Science",
  "Languages",
  "Personal",
];

export const LANGUAGE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "Auto-Detect", label: "Any Language (Auto)" },
  { id: "Odia", label: "ଓଡ଼ିଆ (Odia)" },
  { id: "English", label: "English" },
  { id: "Hindi", label: "हिन्दी (Hindi)" },
  { id: "Hinglish", label: "Hinglish (Hindi + English)" },
  { id: "Punjabi", label: "ਪੰਜਾਬੀ (Punjabi)" },
  { id: "Bengali", label: "বাংলা (Bengali)" },
  { id: "Marathi", label: "मराठी (Marathi)" },
  { id: "Gujarati", label: "ગુજરાતી (Gujarati)" },
  { id: "Tamil", label: "தமிழ் (Tamil)" },
  { id: "Telugu", label: "తెలుగు (Telugu)" },
  { id: "Kannada", label: "ಕನ್ನಡ (Kannada)" },
  { id: "Malayalam", label: "മലയാളം (Malayalam)" },
  { id: "Urdu", label: "اردو (Urdu)" },
  { id: "Nepali", label: "नेपाली (Nepali)" },
  { id: "Spanish", label: "Español (Spanish)" },
  { id: "French", label: "Français (French)" },
  { id: "German", label: "Deutsch (German)" },
  { id: "Arabic", label: "العربية (Arabic)" },
  { id: "Chinese", label: "中文 (Chinese)" },
  { id: "Japanese", label: "日本語 (Japanese)" },
  { id: "Korean", label: "한국어 (Korean)" },
];

export const DEFAULT_PROFILES: FamilyProfile[] = [
  {
    id: "jogi-parent",
    name: "Jogi",
    relation: "Parent · Personal Assistant",
    role: "parent",
    learningGoal: "Daily answers, planning, research, and family study oversight",
    voiceName: "Charon",
    preferredLanguage: "Auto-Detect",
    avatarUrl: AVATAR_PRESETS.parent,
    initials: "JG",
    accentColor: "#1D4ED8",
  },
  {
    id: "son-1",
    name: "Son (Aarav)",
    relation: "Son · Study Desk",
    role: "student",
    grade: "Grade 8",
    learningGoal: "Step-by-step Science, Math problem-solving, and clear exam notes",
    voiceName: "Zephyr",
    preferredLanguage: "Auto-Detect",
    avatarUrl: AVATAR_PRESETS.son,
    initials: "SN",
    accentColor: "#0F766E",
  },
  {
    id: "daughter-1",
    name: "Daughter (Ananya)",
    relation: "Daughter · Study Desk",
    role: "student",
    grade: "Grade 6",
    learningGoal: "Friendly explanations, vocabulary, Science diagrams, and revision notes",
    voiceName: "Kore",
    preferredLanguage: "Auto-Detect",
    avatarUrl: AVATAR_PRESETS.daughter,
    initials: "DT",
    accentColor: "#B45309",
  },
];

export const STARTER_PROMPTS: Record<"parent" | "student", string[]> = {
  parent: [
    "Help me plan a balanced 2-hour evening study routine for my sons and daughter.",
    "Explain today's biggest global science or technology news in 3 short points.",
    "Draft a polite message to my child's school teacher requesting a quick progress update.",
    "Give me a quick healthy dinner idea I can make in 25 minutes.",
  ],
  student: [
    "Explain photosynthesis like a story and quiz me with 2 quick questions.",
    "Walk me step-by-step through solving linear equations like 3x + 7 = 22.",
    "Help me understand why seasons change on Earth and make revision notes.",
    "Explain the difference between speed, velocity, and acceleration with everyday examples.",
  ],
};

export const SAMPLE_NOTES: StudyNote[] = [
  {
    id: "sample-note-photosynthesis",
    profileId: "daughter-1",
    profileName: "Daughter (Ananya)",
    title: "How Plants Make Food: Photosynthesis",
    subject: "Science",
    summary:
      "Photosynthesis is the process green plants use to turn sunlight, water, and carbon dioxide into glucose (sugar) for energy, while releasing oxygen into the air we breathe.",
    keyPoints: [
      "Takes place mainly inside the leaves, inside tiny green structures called chloroplasts.",
      "Chlorophyll is the green pigment that traps energy from sunlight.",
      "Roots absorb water (H2O) from the soil, and tiny leaf pores called stomata take in carbon dioxide (CO2) from the air.",
      "The plant uses light energy to combine water and carbon dioxide into glucose (C6H12O6) and releases oxygen (O2).",
      "Plants store extra glucose as starch so they have energy at night when there is no sunlight.",
    ],
    definitions: [
      {
        term: "6CO2 + 6H2O + Sunlight -> C6H12O6 + 6O2",
        meaning: "The balanced chemical equation for photosynthesis.",
      },
      {
        term: "Chlorophyll",
        meaning: "The green pigment inside chloroplasts that absorbs sunlight.",
      },
      {
        term: "Stomata",
        meaning: "Microscopic pores on the underside of leaves that let gases move in and out.",
      },
    ],
    practiceQuestions: [
      {
        question: "What three ingredients does a plant need to perform photosynthesis?",
        answer: "Sunlight, water (absorbed by roots), and carbon dioxide (taken in through stomata).",
      },
      {
        question: "Which gas do plants release during photosynthesis that humans and animals need?",
        answer: "Oxygen (O2).",
      },
    ],
    teacherTip:
      "Remember the word itself: 'Photo' means light, and 'Synthesis' means putting together — putting ingredients together using light!",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    sourceMode: "chat",
  },
  {
    id: "sample-note-linear-equations",
    profileId: "son-1",
    profileName: "Son (Aarav)",
    title: "Solving One-Variable Linear Equations",
    subject: "Mathematics",
    summary:
      "A linear equation is like a balanced scale: whatever mathematical operation you do to one side, you must do to the other side to isolate the unknown variable (x).",
    keyPoints: [
      "Goal: get the variable (such as x) completely alone on one side of the equals sign.",
      "Undo addition or subtraction first by applying the opposite operation to both sides.",
      "Undo multiplication or division next to solve for a single x.",
      "Always substitute your final answer back into the original equation to verify both sides match.",
    ],
    definitions: [
      {
        term: "Inverse Operation",
        meaning: "An operation that reverses another: addition reverses subtraction, and division reverses multiplication.",
      },
      {
        term: "Example: 3x + 7 = 22",
        meaning: "Subtract 7 from both sides -> 3x = 15. Divide both sides by 3 -> x = 5.",
      },
    ],
    practiceQuestions: [
      {
        question: "Solve for x: 4x - 5 = 19",
        answer: "Add 5 to both sides -> 4x = 24. Divide by 4 -> x = 6.",
      },
      {
        question: "What should you always do after finding a value for x?",
        answer: "Plug it back into the original equation to confirm the left side equals the right side.",
      },
    ],
    teacherTip:
      "Think of peeling an onion from the outside in: remove loose numbers added or subtracted before touching the number multiplied directly with x.",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
    sourceMode: "voice",
  },
];
