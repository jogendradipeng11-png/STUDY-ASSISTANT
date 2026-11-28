import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import type {
  ActiveAlarm,
  AppTab,
  ChatMessage,
  FamilyProfile,
  StudyNote,
} from "./types";
import { auth, googleProvider } from "./firebase";
import {
  deleteCloudAlarm,
  deleteCloudNote,
  deleteCloudProfile,
  ensureUserAccount,
  saveCloudAlarm,
  saveCloudChatThread,
  saveCloudNote,
  saveCloudProfile,
  subscribeToFamilyCloud,
  syncLocalWorkspaceToCloud,
} from "./services/cloudSync";
import {
  loadChats,
  loadNotes,
  loadProfiles,
  saveChats,
  saveNotes,
  saveProfiles,
} from "./utils/storage";
import {
  applyStudyActivityToProfile,
  STUDY_POINTS,
} from "./utils/studyPoints";
import { TopBar } from "./components/TopBar";
import {
  ProfileSidebar,
  type RecentPointsAward,
} from "./components/ProfileSidebar";
import { AssistantView } from "./components/AssistantView";
import { LiveVoiceView } from "./components/LiveVoiceView";
import { StudyNotesView } from "./components/StudyNotesView";
import { FamilyView } from "./components/FamilyView";
import { OfflineIndicator } from "./components/OfflineIndicator";
import { WatchModeView } from "./components/WatchModeView";
import { AlarmTray } from "./components/AlarmTray";
import { ReadAloudView } from "./components/ReadAloudView";
import { TranslateView } from "./components/TranslateView";
import { CloudSyncButton } from "./components/CloudSyncButton";
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
  const [readDraftLanguage, setReadDraftLanguage] = useState<
    string | undefined
  >(undefined);
  const [readAutoStartSignal, setReadAutoStartSignal] = useState(0);
  const [alarms, setAlarms] = useState<ActiveAlarm[]>(() => loadStoredAlarms());

  // Firebase Auth & Cloud Sync state
  const [cloudUser, setCloudUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState<
    "idle" | "syncing" | "synced" | "error"
  >("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [recentPointsAward, setRecentPointsAward] =
    useState<RecentPointsAward | null>(null);

  const cloudUidRef = useRef<string | null>(null);
  const chatSyncTimersRef = useRef<Record<string, number>>({});
  const recentAwardTimerRef = useRef<number | null>(null);
  const awardedAssistantMsgIdsRef = useRef<Set<string> | null>(null);
  const awardedQuizKeysRef = useRef<Set<string>>(new Set());

  if (awardedAssistantMsgIdsRef.current === null) {
    const initialIds = new Set<string>();
    for (const msgs of Object.values(chatsByProfile)) {
      for (const m of msgs) {
        if (m.role === "assistant" && m.id) {
          initialIds.add(m.id);
        }
      }
    }
    awardedAssistantMsgIdsRef.current = initialIds;
  }
  const latestLocalStateRef = useRef({
    profiles,
    notes,
    chatsByProfile,
    alarms,
  });

  useEffect(() => {
    latestLocalStateRef.current = {
      profiles,
      notes,
      chatsByProfile,
      alarms,
    };
  }, [profiles, notes, chatsByProfile, alarms]);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCloudUser(user);
      cloudUidRef.current = user && user.emailVerified ? user.uid : null;
      setAuthReady(true);
      if (!user) {
        setSyncStatus("idle");
        setSyncError(null);
      }
    });
    return () => unsubscribe();
  }, []);

  // Connect real-time Firestore cloud sync once authenticated and verified
  useEffect(() => {
    if (!authReady || !cloudUser) return;
    if (!cloudUser.emailVerified) {
      setSyncStatus("error");
      setSyncError("Please verify your Google email address to enable cloud sync.");
      return;
    }

    let cancelled = false;
    let unsubscribeCloud: (() => void) | null = null;

    const connectCloud = async () => {
      setSyncStatus("syncing");
      setSyncError(null);
      try {
        await ensureUserAccount(cloudUser);
        if (cancelled) return;

        // Automatically migrate existing local Study Notes, profiles, chats, and alarms if cloud is empty
        await syncLocalWorkspaceToCloud(
          cloudUser.uid,
          latestLocalStateRef.current,
          true
        );
        if (cancelled) return;

        unsubscribeCloud = subscribeToFamilyCloud(cloudUser.uid, {
          onProfiles: (cloudProfiles) => {
            setProfiles(cloudProfiles);
            setActiveProfileId((prev) =>
              cloudProfiles.some((p) => p.id === prev)
                ? prev
                : cloudProfiles[0]?.id || prev
            );
          },
          onNotes: (cloudNotes) => {
            setNotes(cloudNotes);
            setSelectedNoteId((prev) =>
              prev && cloudNotes.some((n) => n.id === prev)
                ? prev
                : cloudNotes[0]?.id || null
            );
          },
          onChats: (cloudChats) => {
            if (awardedAssistantMsgIdsRef.current) {
              for (const msgs of Object.values(cloudChats)) {
                for (const m of msgs) {
                  if (m.role === "assistant" && m.id) {
                    awardedAssistantMsgIdsRef.current.add(m.id);
                  }
                }
              }
            }
            setChatsByProfile((prev) => ({ ...prev, ...cloudChats }));
          },
          onAlarms: (cloudAlarms) => {
            setAlarms(cloudAlarms);
          },
          onSyncError: (message) => {
            setSyncStatus("error");
            setSyncError(message);
          },
        });
        setSyncStatus("synced");
      } catch (err) {
        if (!cancelled) {
          setSyncStatus("error");
          setSyncError(
            err instanceof Error ? err.message : "Could not connect to Cloud Sync."
          );
        }
      }
    };

    void connectCloud();

    return () => {
      cancelled = true;
      if (unsubscribeCloud) unsubscribeCloud();
      for (const timerId of Object.values(chatSyncTimersRef.current)) {
        window.clearTimeout(timerId);
      }
      chatSyncTimersRef.current = {};
    };
  }, [authReady, cloudUser]);

  const handleSignInCloud = useCallback(async () => {
    setSyncError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setSyncStatus("error");
      setSyncError(
        err instanceof Error ? err.message : "Google Sign-In was cancelled."
      );
    }
  }, []);

  const handleSignOutCloud = useCallback(async () => {
    await signOut(auth);
  }, []);

  const handleBackupNow = useCallback(async () => {
    const uid = cloudUidRef.current;
    if (!uid) return;
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      await syncLocalWorkspaceToCloud(uid, latestLocalStateRef.current, false);
      setSyncStatus("synced");
    } catch (err) {
      setSyncStatus("error");
      setSyncError(
        err instanceof Error ? err.message : "Manual cloud backup failed."
      );
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(alarms));
    } catch {
      // ignore storage quota errors
    }
  }, [alarms]);

  const handleAddAlarm = useCallback(
    (alarm: Omit<ActiveAlarm, "id" | "ringing">) => {
      const created: ActiveAlarm = {
        ...alarm,
        id: `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        ringing: false,
      };
      setAlarms((prev) => [...prev, created]);
      const uid = cloudUidRef.current;
      if (uid) {
        void saveCloudAlarm(uid, created).catch((err) => {
          setSyncStatus("error");
          setSyncError(err instanceof Error ? err.message : "Alarm sync error.");
        });
      }
    },
    []
  );

  const handleDismissAlarm = useCallback((id: string) => {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    const uid = cloudUidRef.current;
    if (uid) {
      void deleteCloudAlarm(uid, id).catch(() => {});
    }
  }, []);

  const handleSnoozeAlarm = useCallback((id: string, minutes: number) => {
    let updatedAlarm: ActiveAlarm | null = null;
    setAlarms((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        updatedAlarm = {
          ...a,
          triggerAt: Date.now() + minutes * 60 * 1000,
          ringing: false,
        };
        return updatedAlarm;
      })
    );
    const uid = cloudUidRef.current;
    if (uid && updatedAlarm) {
      void saveCloudAlarm(uid, updatedAlarm).catch(() => {});
    }
  }, []);

  const handleMarkAlarmRinging = useCallback((id: string) => {
    let updatedAlarm: ActiveAlarm | null = null;
    setAlarms((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        updatedAlarm = { ...a, ringing: true };
        return updatedAlarm;
      })
    );
    const uid = cloudUidRef.current;
    if (uid && updatedAlarm) {
      void saveCloudAlarm(uid, updatedAlarm).catch(() => {});
    }
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

  const completedNotesCountByProfile = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of notes) {
      if (n.completed) {
        counts[n.profileId] = (counts[n.profileId] || 0) + 1;
      }
    }
    return counts;
  }, [notes]);

  const awardProfileStudyActivity = useCallback(
    (
      profileId: string,
      opts: {
        pointsDelta: number;
        sessionsDelta?: number;
        completedNotesDelta?: number;
        reason?: string;
      }
    ) => {
      if (
        opts.pointsDelta === 0 &&
        !opts.sessionsDelta &&
        !opts.completedNotesDelta
      ) {
        return;
      }

      const currentProfile = latestLocalStateRef.current.profiles.find(
        (p) => p.id === profileId
      );
      if (!currentProfile) return;

      const updatedTarget = applyStudyActivityToProfile(currentProfile, {
        pointsDelta: opts.pointsDelta,
        sessionsDelta: opts.sessionsDelta,
        completedNotesDelta: opts.completedNotesDelta,
        touchTimestamp: opts.pointsDelta > 0,
      });

      latestLocalStateRef.current = {
        ...latestLocalStateRef.current,
        profiles: latestLocalStateRef.current.profiles.map((p) =>
          p.id === profileId ? updatedTarget : p
        ),
      };

      setProfiles((prev) =>
        prev.map((p) =>
          p.id === profileId
            ? applyStudyActivityToProfile(p, {
                pointsDelta: opts.pointsDelta,
                sessionsDelta: opts.sessionsDelta,
                completedNotesDelta: opts.completedNotesDelta,
                touchTimestamp: opts.pointsDelta > 0,
              })
            : p
        )
      );

      if (opts.reason) {
        if (recentAwardTimerRef.current) {
          window.clearTimeout(recentAwardTimerRef.current);
        }
        setRecentPointsAward({
          profileId,
          delta: opts.pointsDelta,
          reason: opts.reason,
          id: Date.now(),
        });
        recentAwardTimerRef.current = window.setTimeout(() => {
          setRecentPointsAward(null);
        }, 4200);
      }

      const uid = cloudUidRef.current;
      if (uid) {
        void saveCloudProfile(uid, updatedTarget).catch(() => {});
      }
    },
    []
  );

  const handleRecordStudySession = useCallback(
    (profileId: string, reason = "Active study session") => {
      awardProfileStudyActivity(profileId, {
        pointsDelta: STUDY_POINTS.ACTIVE_SESSION,
        sessionsDelta: 1,
        reason,
      });
    },
    [awardProfileStudyActivity]
  );

  const handlePracticeCorrect = useCallback(
    (profileId: string, noteId: string, questionIndex: number) => {
      const key = `${noteId}:${questionIndex}`;
      if (awardedQuizKeysRef.current.has(key)) return;
      awardedQuizKeysRef.current.add(key);
      awardProfileStudyActivity(profileId, {
        pointsDelta: STUDY_POINTS.QUIZ_CORRECT,
        reason: "Correct self-check answer",
      });
    },
    [awardProfileStudyActivity]
  );

  const handleUpdateMessages = (profileId: string, updated: ChatMessage[]) => {
    setChatsByProfile((prev) => ({ ...prev, [profileId]: updated }));

    // Award active study session points once for each new Assistant Desk reply
    const awardedSet = awardedAssistantMsgIdsRef.current;
    if (awardedSet && updated.length > 0) {
      const lastMsg = updated[updated.length - 1];
      if (
        lastMsg.role === "assistant" &&
        lastMsg.id &&
        !awardedSet.has(lastMsg.id) &&
        (lastMsg.content.trim().length >= 8 ||
          Boolean(lastMsg.studyDiagram) ||
          Boolean(lastMsg.studyVideo))
      ) {
        awardedSet.add(lastMsg.id);
        handleRecordStudySession(profileId, "Active study session");
      }
    }

    const uid = cloudUidRef.current;
    if (uid) {
      const prevTimer = chatSyncTimersRef.current[profileId];
      if (prevTimer) window.clearTimeout(prevTimer);
      chatSyncTimersRef.current[profileId] = window.setTimeout(() => {
        void saveCloudChatThread(uid, profileId, updated).catch(() => {});
      }, 1200);
    }
  };

  const handleAddNote = (note: StudyNote) => {
    setNotes((prev) => [note, ...prev]);
    awardProfileStudyActivity(note.profileId, {
      pointsDelta: STUDY_POINTS.NOTE_CREATED,
      reason: "Saved study note",
    });
    const uid = cloudUidRef.current;
    if (uid) {
      void saveCloudNote(uid, note).catch((err) => {
        setSyncStatus("error");
        setSyncError(err instanceof Error ? err.message : "Note sync error.");
      });
    }
  };

  const handleUpdateNote = (updated: StudyNote) => {
    setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    const uid = cloudUidRef.current;
    if (uid) {
      void saveCloudNote(uid, updated).catch((err) => {
        setSyncStatus("error");
        setSyncError(err instanceof Error ? err.message : "Note update sync error.");
      });
    }
  };

  const handleToggleNoteCompleted = useCallback(
    (noteId: string) => {
      const target = latestLocalStateRef.current.notes.find(
        (n) => n.id === noteId
      );
      if (!target) return;

      const nextCompleted = !target.completed;
      const now = new Date().toISOString();
      const updatedNote: StudyNote = {
        ...target,
        completed: nextCompleted,
        completedAt: nextCompleted ? now : undefined,
        updatedAt: now,
      };

      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? updatedNote : n))
      );

      awardProfileStudyActivity(target.profileId, {
        pointsDelta: nextCompleted
          ? STUDY_POINTS.NOTE_COMPLETED
          : -STUDY_POINTS.NOTE_COMPLETED,
        completedNotesDelta: nextCompleted ? 1 : -1,
        reason: nextCompleted ? "Completed study note" : "Note marked in-progress",
      });

      const uid = cloudUidRef.current;
      if (uid) {
        void saveCloudNote(uid, updatedNote).catch((err) => {
          setSyncStatus("error");
          setSyncError(
            err instanceof Error ? err.message : "Note completion sync error."
          );
        });
      }
    },
    [awardProfileStudyActivity]
  );

  const handleDeleteNote = (id: string) => {
    setNotes((prev) => {
      const remaining = prev.filter((n) => n.id !== id);
      if (selectedNoteId === id) {
        setSelectedNoteId(remaining[0]?.id || null);
      }
      return remaining;
    });
    const uid = cloudUidRef.current;
    if (uid) {
      void deleteCloudNote(uid, id).catch(() => {});
    }
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
        translate: "Live Voice Translator & Conversation",
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
    const uid = cloudUidRef.current;
    if (uid) {
      void saveCloudProfile(uid, updated).catch((err) => {
        setSyncStatus("error");
        setSyncError(err instanceof Error ? err.message : "Profile sync error.");
      });
    }
  };

  const handleAddProfile = (created: FamilyProfile) => {
    setProfiles((prev) => [...prev, created]);
    setActiveProfileId(created.id);
    const uid = cloudUidRef.current;
    if (uid) {
      void saveCloudProfile(uid, created).catch((err) => {
        setSyncStatus("error");
        setSyncError(err instanceof Error ? err.message : "Profile sync error.");
      });
    }
  };

  const handleDeleteProfile = (id: string) => {
    setProfiles((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      if (activeProfileId === id && remaining[0]) {
        setActiveProfileId(remaining[0].id);
      }
      return remaining;
    });
    const uid = cloudUidRef.current;
    if (uid) {
      void deleteCloudProfile(uid, id).catch(() => {});
    }
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
        cloudSyncControl={
          <CloudSyncButton
            user={cloudUser}
            authReady={authReady}
            syncStatus={syncStatus}
            syncError={syncError}
            onSignIn={handleSignInCloud}
            onSignOut={handleSignOutCloud}
            onBackupNow={handleBackupNow}
          />
        }
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
          completedNotesCountByProfile={completedNotesCountByProfile}
          totalNotesCount={notes.length}
          recentPointsAward={recentPointsAward}
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
              onStudySessionComplete={handleRecordStudySession}
            />
          )}

          {activeTab === "translate" && (
            <TranslateView
              profile={activeProfile}
              onStudySessionComplete={handleRecordStudySession}
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
              onStudySessionComplete={handleRecordStudySession}
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
              onToggleNoteCompleted={handleToggleNoteCompleted}
              onPracticeCorrect={handlePracticeCorrect}
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
