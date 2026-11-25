import { useEffect, useMemo, useState } from "react";
import type { AppTab, ChatMessage, FamilyProfile, StudyNote } from "./types";
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

function getInitialTabFromUrl(): AppTab {
  if (typeof window === "undefined") return "assistant";
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (tab === "live" || tab === "notes" || tab === "family" || tab === "assistant") {
    return tab;
  }
  return "assistant";
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

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onStartQuickVoice={handleStartQuickVoice}
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
      <OfflineIndicator />
    </div>
  );
}
