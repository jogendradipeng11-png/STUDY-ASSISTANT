import type { FamilyProfile, StudyNote } from "../types";

export const STUDY_POINTS = {
  ACTIVE_SESSION: 10,
  NOTE_CREATED: 15,
  NOTE_COMPLETED: 25,
  QUIZ_CORRECT: 10,
} as const;

export const STUDY_BOUNDS = {
  MAX_POINTS: 1_000_000,
  MAX_SESSIONS: 100_000,
  MAX_COMPLETED_NOTES: 100_000,
} as const;

export interface StudyRankInfo {
  level: number;
  title: string;
  minPoints: number;
  nextMilestone: number | null;
  progressPercent: number;
  pointsToNext: number;
}

const RANK_TIERS: Array<{ level: number; title: string; minPoints: number }> = [
  { level: 1, title: "Starter", minPoints: 0 },
  { level: 2, title: "Explorer", minPoints: 100 },
  { level: 3, title: "Scholar", minPoints: 250 },
  { level: 4, title: "Achiever", minPoints: 500 },
  { level: 5, title: "Champion", minPoints: 1000 },
  { level: 6, title: "Master", minPoints: 2000 },
];

export function clampNonNegativeInt(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

export function getProfileStudyPoints(profile: FamilyProfile): number {
  return clampNonNegativeInt(profile.studyPoints ?? 0, STUDY_BOUNDS.MAX_POINTS);
}

export function getProfileStudySessions(profile: FamilyProfile): number {
  return clampNonNegativeInt(
    profile.studySessionsCount ?? 0,
    STUDY_BOUNDS.MAX_SESSIONS
  );
}

export function getProfileCompletedNotes(
  profile: FamilyProfile,
  notes?: StudyNote[]
): number {
  const stored = clampNonNegativeInt(
    profile.completedNotesCount ?? 0,
    STUDY_BOUNDS.MAX_COMPLETED_NOTES
  );
  if (!notes) return stored;
  const actual = notes.filter(
    (n) => n.profileId === profile.id && Boolean(n.completed)
  ).length;
  return Math.max(stored, actual);
}

export function getStudyRankInfo(points: number): StudyRankInfo {
  const safePoints = clampNonNegativeInt(points, STUDY_BOUNDS.MAX_POINTS);
  let currentIdx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    if (safePoints >= RANK_TIERS[i].minPoints) {
      currentIdx = i;
    }
  }
  const current = RANK_TIERS[currentIdx];
  const next = RANK_TIERS[currentIdx + 1] || null;
  if (!next) {
    return {
      level: current.level,
      title: current.title,
      minPoints: current.minPoints,
      nextMilestone: null,
      progressPercent: 100,
      pointsToNext: 0,
    };
  }
  const span = Math.max(1, next.minPoints - current.minPoints);
  const earned = safePoints - current.minPoints;
  const progressPercent = Math.min(100, Math.max(0, Math.round((earned / span) * 100)));
  return {
    level: current.level,
    title: current.title,
    minPoints: current.minPoints,
    nextMilestone: next.minPoints,
    progressPercent,
    pointsToNext: Math.max(0, next.minPoints - safePoints),
  };
}

export function applyStudyActivityToProfile(
  profile: FamilyProfile,
  update: {
    pointsDelta: number;
    sessionsDelta?: number;
    completedNotesDelta?: number;
    touchTimestamp?: boolean;
  }
): FamilyProfile {
  const nextPoints = clampNonNegativeInt(
    getProfileStudyPoints(profile) + update.pointsDelta,
    STUDY_BOUNDS.MAX_POINTS
  );
  const nextSessions = clampNonNegativeInt(
    getProfileStudySessions(profile) + (update.sessionsDelta ?? 0),
    STUDY_BOUNDS.MAX_SESSIONS
  );
  const nextCompletedNotes = clampNonNegativeInt(
    clampNonNegativeInt(
      profile.completedNotesCount ?? 0,
      STUDY_BOUNDS.MAX_COMPLETED_NOTES
    ) + (update.completedNotesDelta ?? 0),
    STUDY_BOUNDS.MAX_COMPLETED_NOTES
  );

  return {
    ...profile,
    studyPoints: nextPoints,
    studySessionsCount: nextSessions,
    completedNotesCount: nextCompletedNotes,
    lastStudiedAt:
      update.touchTimestamp !== false
        ? new Date().toISOString()
        : profile.lastStudiedAt,
  };
}
