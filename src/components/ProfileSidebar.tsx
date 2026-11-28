import { BookOpen, CheckCircle2, Flame, Plus, Trophy, X } from "lucide-react";
import type { AppTab, FamilyProfile } from "../types";
import { SUBJECT_LIST } from "../data/defaults";
import {
  getProfileStudyPoints,
  getProfileStudySessions,
  getStudyRankInfo,
} from "../utils/studyPoints";
import { ProfileAvatar } from "./ProfileAvatar";

export interface RecentPointsAward {
  profileId: string;
  delta: number;
  reason: string;
  id: number;
}

interface ProfileSidebarProps {
  profiles: FamilyProfile[];
  activeProfileId: string;
  onSelectProfile: (id: string) => void;
  activeSubject: string;
  onSelectSubject: (subject: string) => void;
  autoNoteEnabled: boolean;
  onToggleAutoNote: () => void;
  notesCountByProfile: Record<string, number>;
  completedNotesCountByProfile: Record<string, number>;
  totalNotesCount: number;
  recentPointsAward?: RecentPointsAward | null;
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const MOBILE_NAV: Array<{ id: AppTab; label: string }> = [
  { id: "assistant", label: "Assistant" },
  { id: "live", label: "Live Voice" },
  { id: "translate", label: "Translate" },
  { id: "read", label: "Read Aloud" },
  { id: "notes", label: "Study Notes" },
  { id: "family", label: "Family" },
];

export function ProfileSidebar({
  profiles,
  activeProfileId,
  onSelectProfile,
  activeSubject,
  onSelectSubject,
  autoNoteEnabled,
  onToggleAutoNote,
  notesCountByProfile,
  completedNotesCountByProfile,
  totalNotesCount,
  recentPointsAward,
  activeTab,
  onSelectTab,
  mobileOpen,
  onCloseMobile,
}: ProfileSidebarProps) {
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) || profiles[0];

  const activePoints = activeProfile ? getProfileStudyPoints(activeProfile) : 0;
  const activeSessions = activeProfile
    ? getProfileStudySessions(activeProfile)
    : 0;
  const activeTotalNotes = activeProfile
    ? notesCountByProfile[activeProfile.id] || 0
    : 0;
  const activeCompletedNotes = activeProfile
    ? Math.max(
        activeProfile.completedNotesCount || 0,
        completedNotesCountByProfile[activeProfile.id] || 0
      )
    : 0;
  const activeRank = getStudyRankInfo(activePoints);
  const activeRecentAward =
    recentPointsAward && activeProfile && recentPointsAward.profileId === activeProfile.id
      ? recentPointsAward
      : null;

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-slate-200">
      {/* Mobile-only header & view switcher */}
      <div className="lg:hidden flex items-center justify-between px-5 py-4 border-b border-slate-200">
        <span className="font-display text-lg font-bold text-slate-900">
          Jogi Jarvis
        </span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close menu"
          className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="md:hidden px-4 py-3 border-b border-slate-200 grid grid-cols-2 gap-1.5">
        {MOBILE_NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              onSelectTab(item.id);
              onCloseMobile();
            }}
            className={`px-3 py-2 text-xs font-semibold rounded-md text-left transition-colors whitespace-nowrap ${
              activeTab === item.id
                ? "bg-blue-700 text-white"
                : "bg-slate-100 text-slate-700 hover:bg-slate-200"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Family Profiles Section */}
      <div className="p-4 flex-1 overflow-y-auto space-y-5">
        <div>
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-xs font-semibold text-slate-500 tracking-wide">
              Who is using Jarvis
            </h2>
            <button
              type="button"
              onClick={() => {
                onSelectTab("family");
                onCloseMobile();
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Manage</span>
            </button>
          </div>

          <div className="space-y-1">
            {profiles.map((profile) => {
              const isSelected = profile.id === activeProfileId;
              const noteCount = notesCountByProfile[profile.id] || 0;
              const doneCount = Math.max(
                profile.completedNotesCount || 0,
                completedNotesCountByProfile[profile.id] || 0
              );
              const points = getProfileStudyPoints(profile);
              const sessions = getProfileStudySessions(profile);
              const justAwarded =
                recentPointsAward &&
                recentPointsAward.profileId === profile.id &&
                recentPointsAward.delta > 0
                  ? recentPointsAward.delta
                  : null;

              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => {
                    onSelectProfile(profile.id);
                    onCloseMobile();
                  }}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors min-h-[54px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 ${
                    isSelected
                      ? "bg-slate-100 text-slate-950 ring-1 ring-slate-200"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <ProfileAvatar profile={profile} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold truncate text-slate-900">
                        {profile.name}
                      </span>
                      <span
                        className="inline-flex items-center gap-1 text-[11px] font-mono font-semibold tabular-nums text-slate-700 shrink-0"
                        title={`${points} Study Points`}
                      >
                        <Trophy className="h-3 w-3 text-amber-600 shrink-0" />
                        <span>{points} pts</span>
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1.5 mt-0.5">
                      <p className="text-[11px] text-slate-500 truncate">
                        {profile.role === "parent"
                          ? sessions > 0
                            ? `Personal · ${sessions} ${sessions === 1 ? "session" : "sessions"}`
                            : "Personal Assistant"
                          : doneCount > 0
                            ? `${profile.grade || "Student"} · ${doneCount} done`
                            : `${profile.grade || "Student"} · ${noteCount} ${
                                noteCount === 1 ? "note" : "notes"
                              }`}
                      </p>
                      {justAwarded !== null ? (
                        <span className="text-[10px] font-mono font-semibold text-emerald-700 shrink-0 tabular-nums">
                          +{justAwarded}
                        </span>
                      ) : (
                        isSelected && (
                          <span className="text-[10px] font-semibold text-blue-700 shrink-0">
                            Active
                          </span>
                        )
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Active Profile Study Points Summary */}
        {activeProfile && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/75 p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Trophy className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                <span className="text-xs font-semibold text-slate-900 truncate">
                  Study Points
                </span>
              </div>
              <span className="text-[11px] font-medium text-blue-700 shrink-0">
                Lvl {activeRank.level} · {activeRank.title}
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-display text-2xl font-bold text-slate-950 tabular-nums leading-none">
                  {activePoints.toLocaleString()}
                  <span className="text-xs font-semibold text-slate-500 ml-1">
                    pts
                  </span>
                </span>
                {activeRecentAward && activeRecentAward.delta !== 0 ? (
                  <span
                    className={`text-[11px] font-medium truncate ${
                      activeRecentAward.delta > 0
                        ? "text-emerald-700"
                        : "text-slate-500"
                    }`}
                  >
                    {activeRecentAward.delta > 0
                      ? `+${activeRecentAward.delta} pts`
                      : `${activeRecentAward.delta} pts`}
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500 tabular-nums truncate">
                    {activeRank.nextMilestone
                      ? `${activeRank.pointsToNext} to next`
                      : "Top rank"}
                  </span>
                )}
              </div>

              <div
                className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden"
                role="progressbar"
                aria-valuenow={activeRank.progressPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Study Points level progress"
              >
                <div
                  className="h-full rounded-full bg-blue-700 transition-all duration-300"
                  style={{ width: `${activeRank.progressPercent}%` }}
                />
              </div>

              {activeRecentAward && (
                <p className="text-[11px] text-emerald-700 truncate">
                  {activeRecentAward.reason}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200/80">
              <div className="bg-white rounded-lg border border-slate-200/80 px-2.5 py-2">
                <div className="flex items-center gap-1 text-[11px] text-slate-500">
                  <Flame className="h-3 w-3 text-blue-700 shrink-0" />
                  <span>Sessions</span>
                </div>
                <p className="mt-0.5 text-sm font-bold text-slate-900 font-mono tabular-nums">
                  {activeSessions}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  onSelectTab("notes");
                  onCloseMobile();
                }}
                title="Open Study Notes to mark notes completed"
                className="text-left bg-white hover:border-blue-300 rounded-lg border border-slate-200/80 px-2.5 py-2 transition-colors"
              >
                <div className="flex items-center gap-1 text-[11px] text-slate-500">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
                  <span>Notes Done</span>
                </div>
                <p className="mt-0.5 text-sm font-bold text-slate-900 font-mono tabular-nums">
                  {activeCompletedNotes}
                  <span className="text-xs font-normal text-slate-400">
                    /{activeTotalNotes}
                  </span>
                </p>
              </button>
            </div>

            <p className="text-[10px] text-slate-500 leading-relaxed">
              +10 active session · +15 saved note · +25 completed note
            </p>
          </div>
        )}

        {/* Study Focus Controls when in Student Mode */}
        {activeProfile?.role === "student" && (
          <div className="pt-5 border-t border-slate-200 space-y-4">
            <div>
              <h2 className="text-xs font-semibold text-slate-500 tracking-wide px-1 mb-2.5">
                Study Subject
              </h2>
              <div className="grid grid-cols-1 gap-1">
                {SUBJECT_LIST.filter((s) => s !== "Personal").map((subject) => {
                  const selected = activeSubject === subject;
                  return (
                    <button
                      key={subject}
                      type="button"
                      onClick={() => {
                        onSelectSubject(subject);
                        onCloseMobile();
                      }}
                      className={`w-full text-left px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap truncate ${
                        selected
                          ? "bg-blue-700 text-white"
                          : "text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      {subject}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200">
              <div className="flex items-start justify-between gap-3 px-1">
                <div>
                  <p className="text-xs font-semibold text-slate-900">
                    Auto-take AI notes
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                    Save key study points automatically after each lesson reply.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoNoteEnabled}
                  aria-label="Toggle automatic AI study notes"
                  onClick={onToggleAutoNote}
                  className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                    autoNoteEnabled ? "bg-blue-700" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transform transition-transform mt-0.5 ${
                      autoNoteEnabled ? "translate-x-5.5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Quiet bottom notebook summary */}
      <div className="p-4 border-t border-slate-200 bg-slate-50/70">
        <button
          type="button"
          onClick={() => {
            onSelectTab("notes");
            onCloseMobile();
          }}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left hover:bg-white border border-transparent hover:border-slate-200 transition-colors"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <BookOpen className="h-4 w-4 text-slate-600 shrink-0" />
            <span className="text-xs font-semibold text-slate-800 truncate">
              Family Study Notebook
            </span>
          </div>
          <span className="text-xs font-mono tabular-nums text-slate-600 shrink-0">
            {totalNotesCount}
          </span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="no-print hidden lg:block w-68 shrink-0 h-[calc(100vh-4rem)] sticky top-16">
        {sidebarContent}
      </aside>

      {/* Mobile slide-over drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/40"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <aside className="relative w-72 max-w-[85vw] h-full z-50">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
}
