import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActiveAlarm,
  AppTab,
  ChatMessage,
  FamilyProfile,
  StudyNote,
} from "./types";
import {
  loadChats,
  loadNotes,
  loadProfiles,
  saveChats,
  saveNotes,
  saveProfiles,
} from "./utils/storage";
import { TopBar } from "./components/TopBar";
import { ProfileSidebar } from "./components/ProfileSidebar";
import { AssistantView } from "./components/AssistantView";
import { LiveVoiceView } from "./components/LiveVoiceView";
import { StudyNotesView } from "./components/StudyNotesView";
import { FamilyView } from "./components/FamilyView";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { WatchModeView } from "./components/WatchModeView";
import { AlarmTray } from "./components/AlarmTray";
import { ReadAloudView } from "./components/ReadAloudView";
import type { AppCommand } from "./utils/mobileActions";

const ALARMS_STORAGE_KEY = "jogi_jarvis_alarms_v1";

function loadStoredAlarms(): ActiveAlarm[] {
  try {
    const raw = localStorage.getItem(ALARMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a) => a && typeof a.id === "string" && typeof a.triggerAt === "number"
    );
  } catch {
    return [];
  }
}

function getInitialTabFromUrl(): AppTab {
  if (typeof window === "undefined") return "assistant";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (
    tab === "live" ||
    tab === "read" ||
    tab === "notes" ||
    tab === "family" ||
    tab === "assistant"
  ) {
    return tab;
  }
  return "assistant";
}

function getInitialWatchMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") === "watch") return true;
  // Auto-enable Wear OS Watch Mode on smartwatch viewports
  return window.innerWidth <= 320 && window.innerHeight <= 360;
}

export default function App() {
  const [profiles, setProfiles] = useState<FamilyProfile[]>(() =>
    loadProfiles()
  );
  const [activeProfileId, setActiveProfileId] = useState<string>(() => {
    const initial = loadProfiles();
    return initial[0]?.id || "jogi-parent";
  });
  const [activeTab, setActiveTab] = useState<AppTab>(() =>
    getInitialTabFromUrl()
  );
  const [watchMode, setWatchMode] = useState<boolean>(() =>
    getInitialWatchMode()
  );
  const [activeSubject, setActiveSubject] = useState<string>("All Subjects");
  const [autoNoteEnabled, setAutoNoteEnabled] = useState<boolean>(true);
  const [chatsByProfile, setChatsByProfile] = useState<
    Record<string, ChatMessage[]>
  >(() => loadChats());
  const [notes, setNotes] = useState<StudyNote[]>(() => loadNotes());
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(
    () => loadNotes()[0]?.id || null
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [voiceStartSignal, setVoiceStartSignal] = useState(0);
  const [readDraftText, setReadDraftText] = useState("");
  const [readDraftLanguage, setReadDraftLanguage] = useState<string | undefined>(
    undefined
  );
  const [readAutoStartSignal, setReadAutoStartSignal] = useState(0);
  const [alarms, setAlarms] = useState<ActiveAlarm[]>(() => loadStoredAlarms());

  useEffect(() => {
    try {
      localStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(alarms));
    } catch {
      // ignore storage quota errors
    }
  }, [alarms]);

  const handleAddAlarm = useCallback(
    (alarm: Omit<ActiveAlarm, "id" | "ringing">) => {
      setAlarms((prev) => [
        ...prev,
        {
          ...alarm,
          id: `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          ringing: false,
        },
      ]);
    },
    []
  );

  const handleDismissAlarm = useCallback((id: string) => {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleSnoozeAlarm = useCallback((id: string, minutes: number) => {
    setAlarms((prev) =>
      prev.map((a) =>
        a.id === id
          ? {
              ...a,
              triggerAt: Date.now() + minutes * 60 * 1000,
              ringing: false,
            }
          : a
      )
    );
  }, []);

  const handleMarkAlarmRinging = useCallback((id: string) => {
    setAlarms((prev) =>
      prev.map((a) => (a.id === id ? { ...a, ringing: true } : a))
    );
  }, []);

  useEffect(() => {
    saveProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    saveChats(chatsByProfile);
  }, [chatsByProfile]);

  useEffect(() => {
    saveNotes(notes);
  }, [notes]);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || profiles[0],
    [profiles, activeProfileId]
  );

  const notesCountByProfile = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of notes) {
      counts[n.profileId] = (counts[n.profileId] || 0) + 1;
    }
    return counts;
  }, [notes]);

  const handleUpdateMessages = (profileId: string, updated: ChatMessage[]) => {
    setChatsByProfile((prev) => ({ ...prev, [profileId]: updated }));
  };

  const handleAddNote = (note: StudyNote) => {
    setNotes((prev) => [note, ...prev]);
  };

  const handleUpdateNote = (updated: StudyNote) => {
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
  };

  const handleDeleteNote = (id: string) => {
    setNotes((prev) => {
      const remaining = prev.filter((n) => n.id !== id);
      if (selectedNoteId === id) {
        setSelectedNoteId(remaining[0]?.id || null);
      }
      return remaining;
    });
  };

  const handleOpenNote = (noteId: string) => {
    setSelectedNoteId(noteId);
    setActiveTab("notes");
  };

  const handleStartQuickVoice = () => {
    setActiveTab("live");
    setVoiceStartSignal((n) => n + 1);
  };

  const handleOpenInReader = useCallback(
    (text: string, language?: string, autoStart = true) => {
      setReadDraftText(text);
      setReadDraftLanguage(language);
      setActiveTab("read");
      if (autoStart) {
        setReadAutoStartSignal((n) => n + 1);
      }
    },
    []
  );

  const handleExecuteAppCommand = useCallback(
    (cmd: AppCommand, lastAssistantReply?: string): string => {
      if (cmd.type === "watch") {
        setWatchMode(true);
        return "Opening Android Watch Mode now.";
      }
      if (cmd.type === "profile") {
        setActiveProfileId(cmd.profileId);
        setActiveSubject("All Subjects");
        return `Switched to ${cmd.profileName}'s profile.`;
      }
      if (cmd.type === "read") {
        const textToRead = cmd.readLastReply
          ? (lastAssistantReply || "").trim()
          : (cmd.text || "").trim();
        if (textToRead) {
          handleOpenInReader(textToRead, cmd.language, cmd.autoStart);
          return cmd.language
            ? `Opening Read Studio and reading aloud in ${cmd.language}.`
            : "Opening Read Studio and reading aloud now.";
        }
        setActiveTab("read");
        return "Opened the Read tab. Paste, speak, or scan a page to listen.";
      }
      setActiveTab(cmd.tab);
      if (cmd.tab === "live" && cmd.autoStartVoice) {
        setVoiceStartSignal((n) => n + 1);
        return "Opening Live Voice Studio now.";
      }
      const labels: Record<AppTab, string> = {
        assistant: "Assistant",
        live: "Live Voice",
        read: "Read Aloud Studio",
        notes: "Study Notes",
        family: "Family Profiles",
      };
      return `Navigated to ${labels[cmd.tab]}.`;
    },
    [handleOpenInReader]
  );

  const handleUpdateProfile = (updated: FamilyProfile) => {
    setProfiles((prev) =>
      prev.map((p) => (p.id === updated.id ? updated : p))
    );
  };

  const handleAddProfile = (created: FamilyProfile) => {
    setProfiles((prev) => [...prev, created]);
    setActiveProfileId(created.id);
  };

  const handleDeleteProfile = (id: string) => {
    setProfiles((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (activeProfileId === id && remaining[0]) {
        setActiveProfileId(remaining[0].id);
      }
      return remaining;
    });
  };

  if (watchMode) {
    return (
      <>
        <WatchModeView
          profile={activeProfile}
          onAddAlarm={handleAddAlarm}
          onExitWatchMode={() => {
            setWatchMode(false);
            if (window.location.search.includes("mode=watch")) {
              window.history.replaceState({}, "", "/");
            }
          }}
        />
        <AlarmTray
          alarms={alarms}
          onDismissAlarm={handleDismissAlarm}
          onSnoozeAlarm={handleSnoozeAlarm}
          onMarkRinging={handleMarkAlarmRinging}
        />
        <OfflineIndicator />
      </>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onStartQuickVoice={handleStartQuickVoice}
        onOpenWatchMode={() => setWatchMode(true)}
        onToggleMobileMenu={() => setMobileMenuOpen((v) => !v)}
      />

      <div className="flex flex-1 min-h-0">
        <ProfileSidebar
          profiles={profiles}
          activeProfileId={activeProfile.id}
          onSelectProfile={(id) => {
            setActiveProfileId(id);
            setActiveSubject("All Subjects");
          }}
          activeSubject={activeSubject}
          onSelectSubject={setActiveSubject}
          autoNoteEnabled={autoNoteEnabled}
          onToggleAutoNote={() => setAutoNoteEnabled((v) => !v)}
          notesCountByProfile={notesCountByProfile}
          totalNotesCount={notes.length}
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <main className="flex-1 min-w-0">
          {activeTab === "assistant" && (
            <AssistantView
              profile={activeProfile}
              profiles={profiles}
              subject={activeSubject}
              messages={chatsByProfile[activeProfile.id] || []}
              autoNoteEnabled={autoNoteEnabled}
              onUpdateMessages={handleUpdateMessages}
              onChangeLanguage={(lang) =>
                handleUpdateProfile({ ...activeProfile, preferredLanguage: lang })
              }
              onSaveNote={handleAddNote}
              onOpenNote={handleOpenNote}
              onOpenLiveVoice={handleStartQuickVoice}
              onAddAlarm={handleAddAlarm}
              onExecuteAppCommand={handleExecuteAppCommand}
              onOpenInReader={(text, lang) =>
                handleOpenInReader(text, lang, true)
              }
            />
          )}

          {activeTab === "live" && (
            <LiveVoiceView
              profile={activeProfile}
              subject={activeSubject}
              autoStartSignal={voiceStartSignal}
              onChangeLanguage={(lang) =>
                handleUpdateProfile({ ...activeProfile, preferredLanguage: lang })
              }
              onSaveNote={handleAddNote}
              onOpenNote={handleOpenNote}
            />
          )}

          {activeTab === "read" && (
            <ReadAloudView
              profile={activeProfile}
              notes={notes}
              initialText={readDraftText}
              initialLanguage={readDraftLanguage}
              autoStartSignal={readAutoStartSignal}
              onChangeLanguage={(lang) =>
                handleUpdateProfile({ ...activeProfile, preferredLanguage: lang })
              }
              onSaveNote={handleAddNote}
              onOpenNote={handleOpenNote}
            />
          )}

          {activeTab === "notes" && (
            <StudyNotesView
              notes={notes}
              profiles={profiles}
              activeProfile={activeProfile}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              onAddNote={handleAddNote}
              onUpdateNote={handleUpdateNote}
              onDeleteNote={handleDeleteNote}
              onOpenInReader={(text, lang) =>
                handleOpenInReader(text, lang, true)
              }
            />
          )}

          {activeTab === "family" && (
            <FamilyView
              profiles={profiles}
              activeProfileId={activeProfile.id}
              notesCountByProfile={notesCountByProfile}
              onSelectProfile={(id) => {
                setActiveProfileId(id);
                setActiveTab("assistant");
              }}
              onUpdateProfile={handleUpdateProfile}
              onAddProfile={handleAddProfile}
              onDeleteProfile={handleDeleteProfile}
            />
          )}
        </main>
      </div>
      <AlarmTray
        alarms={alarms}
        onDismissAlarm={handleDismissAlarm}
        onSnoozeAlarm={handleSnoozeAlarm}
        onMarkRinging={handleMarkAlarmRinging}
      />
      <OfflineIndicator />
    </div>
  );
}
