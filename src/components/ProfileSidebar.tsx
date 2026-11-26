import { BookOpen, Plus, X } from "lucide-react";
import type { AppTab, FamilyProfile } from "../types";
import { SUBJECT_LIST } from "../data/defaults";
import { ProfileAvatar } from "./ProfileAvatar";

interface ProfileSidebarProps {
  profiles: FamilyProfile[];
  activeProfileId: string;
  onSelectProfile: (id: string) => void;
  activeSubject: string;
  onSelectSubject: (subject: string) => void;
  autoNoteEnabled: boolean;
  onToggleAutoNote: () => void;
  notesCountByProfile: Record<string, number>;
  totalNotesCount: number;
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
  totalNotesCount,
  activeTab,
  onSelectTab,
  mobileOpen,
  onCloseMobile,
}: ProfileSidebarProps) {
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) || profiles[0];

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
      <div className="p-4 flex-1 overflow-y-auto space-y-6">
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
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => {
                    onSelectProfile(profile.id);
                    onCloseMobile();
                  }}
                  className={`w-full flex items-center gap-3 p-2.5 rounded-lg text-left transition-colors min-h-[52px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 ${
                    isSelected
                      ? "bg-slate-100 text-slate-950"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <ProfileAvatar profile={profile} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold truncate text-slate-900">
                        {profile.name}
                      </span>
                      {isSelected && (
                        <span className="text-[11px] font-semibold text-blue-700 shrink-0">
                          Active
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {profile.role === "parent"
                        ? "Personal Assistant"
                        : `${profile.grade || "Student"} · ${noteCount} ${
                            noteCount === 1 ? "note" : "notes"
                          }`}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

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
