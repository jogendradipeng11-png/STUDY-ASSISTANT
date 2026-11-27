import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlarmClock,
  BookMarked,
  BookOpen,
  Calendar,
  Check,
  CloudSun,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Globe,
  ImagePlus,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Mic,
  Newspaper,
  Phone,
  Play,
  Send,
  Square,
  Timer,
  Trash2,
  Trophy,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type {
  ActiveAlarm,
  ChatMessage,
  FamilyProfile,
  MobileActionKind,
  StudyNote,
} from "../types";
import { STARTER_PROMPTS } from "../data/defaults";
import { blobToBase64 } from "../utils/audio";
import {
  base64ToAudioBlobUrl,
  getSilentKeepAliveWavUrl,
  playAudioBlobReliably,
  requestAudioWakeLock,
  speakWithChunkedBrowserTts,
  unlockBrowserSpeech,
  updateJarvisMediaSession,
  type WakeLockHandle,
} from "../utils/backgroundAudio";
import {
  downloadGeneratedScript,
  formatAlarmTime,
  parseMobileActions,
  triggerMobileAction,
  type AppCommand,
} from "../utils/mobileActions";
import { formatShortDate } from "../utils/storage";
import {
  generateStudySummaryFromSession,
  isLongStudySession,
} from "../utils/studySummary";
import {
  LOCAL_LLM_MODELS,
  checkWebGpuSupport,
  deleteCachedLocalModel,
  getLoadedLocalModelKey,
  getRecordedDownloadedModels,
  loadLocalLlmModel,
  streamLocalLlmChat,
  syncCachedLocalModels,
  unloadLocalLlmModel,
  type LocalLlmProgress,
  type WebGpuSupportInfo,
} from "../utils/localLlm";
import { LanguagePicker } from "./LanguagePicker";
import {
  MobileTaskModal,
  type MobileTaskModalMode,
} from "./MobileTaskModal";
import { ProfileAvatar } from "./ProfileAvatar";

type AiEngine = "auto" | "local-browser" | "gemini" | "nvidia" | "local-server";

interface AssistantViewProps {
  profile: FamilyProfile;
  profiles: FamilyProfile[];
  subject: string;
  messages: ChatMessage[];
  autoNoteEnabled: boolean;
  onUpdateMessages: (profileId: string, messages: ChatMessage[]) => void;
  onChangeLanguage: (language: string) => void;
  onSaveNote: (note: StudyNote) => void;
  onOpenNote: (noteId: string) => void;
  onOpenLiveVoice: () => void;
  onAddAlarm: (alarm: Omit<ActiveAlarm, "id" | "ringing">) => void;
  onExecuteAppCommand: (
    cmd: AppCommand,
    lastAssistantReply?: string
  ) => string;
  onOpenInReader: (text: string, language?: string) => void;
}

function getActionIcon(kind: MobileActionKind) {
  switch (kind) {
    case "youtube":
      return <Play className="h-4 w-4 text-red-600 shrink-0" />;
    case "whatsapp":
      return <MessageSquare className="h-4 w-4 text-emerald-600 shrink-0" />;
    case "sms":
      return <MessageSquare className="h-4 w-4 text-blue-700 shrink-0" />;
    case "call":
      return <Phone className="h-4 w-4 text-emerald-700 shrink-0" />;
    case "email":
      return <Mail className="h-4 w-4 text-blue-700 shrink-0" />;
    case "maps":
      return <MapPin className="h-4 w-4 text-red-600 shrink-0" />;
    case "calendar":
      return <Calendar className="h-4 w-4 text-blue-700 shrink-0" />;
    case "alarm":
      return <AlarmClock className="h-4 w-4 text-amber-600 shrink-0" />;
    case "timer":
      return <Timer className="h-4 w-4 text-amber-600 shrink-0" />;
    default:
      return <ExternalLink className="h-4 w-4 text-slate-600 shrink-0" />;
  }
}

export function AssistantView({
  profile,
  profiles,
  subject,
  messages,
  autoNoteEnabled,
  onUpdateMessages,
  onChangeLanguage,
  onSaveNote,
  onOpenNote,
  onOpenLiveVoice,
  onAddAlarm,
  onExecuteAppCommand,
  onOpenInReader,
}: AssistantViewProps) {
  const activeLanguage = profile.preferredLanguage || "Auto-Detect";
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [speedMode, setSpeedMode] = useState<"fast" | "detailed">("fast");
  const [engine, setEngine] = useState<AiEngine>(() => {
    try {
      const saved = localStorage.getItem("jogi_jarvis_engine_v1");
      if (
        saved === "auto" ||
        saved === "local-browser" ||
        saved === "gemini" ||
        saved === "nvidia" ||
        saved === "local-server"
      ) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return "auto";
  });
  const [nvidiaAvailable, setNvidiaAvailable] = useState(false);
  const [localServerAvailable, setLocalServerAvailable] = useState(false);
  const [fallbackPoolAvailable, setFallbackPoolAvailable] = useState(false);
  const [totalActiveModels, setTotalActiveModels] = useState(2);
  const [localModelKey, setLocalModelKey] = useState<string>(() => {
    try {
      const saved = localStorage.getItem("jogi_jarvis_local_model_v1");
      if (saved && LOCAL_LLM_MODELS.some((m) => m.key === saved)) {
        return saved;
      }
    } catch {
      // ignore storage errors
    }
    return "llama-3.2-1b";
  });
  const [localStatus, setLocalStatus] = useState<
    "idle" | "loading" | "ready" | "unsupported"
  >(() => (getLoadedLocalModelKey() ? "ready" : "idle"));
  const [localProgress, setLocalProgress] = useState<LocalLlmProgress | null>(
    null
  );
  const [downloadingModelKey, setDownloadingModelKey] = useState<string | null>(
    null
  );
  const [downloadedModels, setDownloadedModels] = useState<string[]>(() =>
    getRecordedDownloadedModels()
  );
  const [autoSelectOnDownload, setAutoSelectOnDownload] = useState<boolean>(
    () => {
      try {
        const saved = localStorage.getItem("jogi_jarvis_local_autoselect_v1");
        return saved === null ? true : saved === "true";
      } catch {
        return true;
      }
    }
  );
  const autoSelectOnDownloadRef = useRef(autoSelectOnDownload);
  autoSelectOnDownloadRef.current = autoSelectOnDownload;
  const [gpuInfo, setGpuInfo] = useState<WebGpuSupportInfo | null>(null);
  const [useSearch, setUseSearch] = useState(true);
  const [autoSpeak, setAutoSpeak] = useState<boolean>(() => {
    try {
      return localStorage.getItem("jogi_jarvis_autospeak_v1") === "true";
    } catch {
      return false;
    }
  });
  const autoSpeakRef = useRef(autoSpeak);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [autoRunActions, setAutoRunActions] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Voice dictation state (+ lightweight silence auto-stop when Auto-Speak is ON)
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const micVadIntervalRef = useRef<number | null>(null);
  const micVadCtxRef = useRef<AudioContext | null>(null);

  // Photo / homework attachment state
  const [attachedImage, setAttachedImage] = useState<{
    dataUrl: string;
    base64: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // TTS audio playback state (DOM <audio> + MediaSession + WakeLock for background/lock-screen playback)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [loadingTtsId, setLoadingTtsId] = useState<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioBlobUrlRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const playbackTokenRef = useRef(0);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
    try {
      localStorage.setItem("jogi_jarvis_autospeak_v1", String(autoSpeak));
    } catch {
      // ignore storage errors
    }
  }, [autoSpeak]);

  // Study note creation state
  const [savingNoteForId, setSavingNoteForId] = useState<string | null>(null);
  const [savingSessionNote, setSavingSessionNote] = useState(false);
  const [generatingStudySummary, setGeneratingStudySummary] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; noteId?: string } | null>(
    null
  );
  const [taskModalMode, setTaskModalMode] =
    useState<MobileTaskModalMode | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setErrorMsg(null);
  }, [profile.id, profile.role]);

  useEffect(() => {
    try {
      localStorage.setItem("jogi_jarvis_engine_v1", engine);
    } catch {
      // ignore storage errors
    }
  }, [engine]);

  useEffect(() => {
    try {
      localStorage.setItem("jogi_jarvis_local_model_v1", localModelKey);
    } catch {
      // ignore storage errors
    }
    setLocalStatus((prev) => {
      if (prev === "unsupported" || prev === "loading") return prev;
      return getLoadedLocalModelKey() === localModelKey ? "ready" : "idle";
    });
  }, [localModelKey]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "jogi_jarvis_local_autoselect_v1",
        String(autoSelectOnDownload)
      );
    } catch {
      // ignore storage errors
    }
  }, [autoSelectOnDownload]);

  useEffect(() => {
    if (engine !== "local-browser") return;
    let cancelled = false;
    void checkWebGpuSupport().then((info) => {
      if (cancelled) return;
      setGpuInfo(info);
      if (!info.supported) {
        setLocalStatus("unsupported");
      } else {
        setLocalStatus((prev) =>
          prev === "loading"
            ? "loading"
            : getLoadedLocalModelKey() === localModelKey
              ? "ready"
              : "idle"
        );
      }
    });
    void syncCachedLocalModels().then((keys) => {
      if (!cancelled) {
        setDownloadedModels(keys);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [engine, localModelKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/providers")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            nvidiaConfigured?: boolean;
            localServerConfigured?: boolean;
            fallbackPoolConfigured?: boolean;
            totalActiveModels?: number;
          } | null
        ) => {
          if (!cancelled && data) {
            const hasNvidia = Boolean(data.nvidiaConfigured);
            const hasLocalSrv = Boolean(data.localServerConfigured);
            setNvidiaAvailable(hasNvidia);
            setLocalServerAvailable(hasLocalSrv);
            setFallbackPoolAvailable(
              Boolean(data.fallbackPoolConfigured || hasNvidia)
            );
            setEngine((prev) => {
              if (prev === "nvidia" && !hasNvidia) return "auto";
              if (prev === "local-server" && !hasLocalSrv) return "auto";
              return prev;
            });
            if (typeof data.totalActiveModels === "number" && data.totalActiveModels > 0) {
              setTotalActiveModels(data.totalActiveModels);
            }
          }
        }
      )
      .catch(() => {
        // non-blocking provider check
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isSending]);

  useEffect(() => {
    return () => {
      stopPlayback();
      if (micVadIntervalRef.current !== null) {
        window.clearInterval(micVadIntervalRef.current);
        micVadIntervalRef.current = null;
      }
      if (micVadCtxRef.current) {
        void micVadCtxRef.current.close().catch(() => {});
        micVadCtxRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const showToast = (message: string, noteId?: string) => {
    setToast({ message, noteId });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 5500);
  };

  const activeLocalModel =
    LOCAL_LLM_MODELS.find((m) => m.key === localModelKey) || LOCAL_LLM_MODELS[2];
  const downloadingLocalModel = downloadingModelKey
    ? LOCAL_LLM_MODELS.find((m) => m.key === downloadingModelKey) || null
    : null;
  const isCurrentLocalModelCached = downloadedModels.includes(localModelKey);

  const handleLoadLocalModel = async (targetKey = localModelKey) => {
    const targetMeta =
      LOCAL_LLM_MODELS.find((m) => m.key === targetKey) || activeLocalModel;
    setErrorMsg(null);
    setDownloadingModelKey(targetMeta.key);
    setLocalStatus("loading");
    setLocalProgress({
      progress: 0.02,
      text: `Downloading ${targetMeta.label} (${targetMeta.sizeLabel})…`,
    });
    try {
      await loadLocalLlmModel(targetMeta.key, (info) => {
        setLocalProgress(info);
        if (info.progress >= 1) {
          setLocalStatus("ready");
        }
      });
      setLocalStatus("ready");
      setDownloadingModelKey(null);
      setDownloadedModels((prev) =>
        prev.includes(targetMeta.key) ? prev : [...prev, targetMeta.key]
      );
      setLocalModelKey(targetMeta.key);
      if (autoSelectOnDownloadRef.current) {
        setEngine("local-browser");
        showToast(
          `${targetMeta.label} finished downloading and was auto-selected as your active Unlimited Local AI.`
        );
      } else {
        showToast(
          `${targetMeta.label} is ready on your device — unlimited chats with zero API quota.`
        );
      }
    } catch (err) {
      setDownloadingModelKey(null);
      setLocalStatus(gpuInfo?.supported === false ? "unsupported" : "idle");
      setLocalProgress(null);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not load the on-device Local AI model."
      );
    }
  };

  const handleUnloadLocalModel = async () => {
    await unloadLocalLlmModel();
    setLocalStatus("idle");
    setLocalProgress(null);
    showToast("Unloaded Local AI model from device GPU memory (file stays cached for fast reload).");
  };

  const handleDeleteCachedLocalModel = async () => {
    const target = activeLocalModel;
    const remaining = await deleteCachedLocalModel(target.key);
    setDownloadedModels(remaining);
    setLocalStatus("idle");
    setLocalProgress(null);
    showToast(`Cleared ${target.label} from browser storage.`);
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  };

  const acquireWakeLock = async () => {
    if (wakeLockRef.current) return;
    wakeLockRef.current = await requestAudioWakeLock();
  };

  const revokeActiveBlobUrl = () => {
    if (activeAudioBlobUrlRef.current) {
      URL.revokeObjectURL(activeAudioBlobUrlRef.current);
      activeAudioBlobUrlRef.current = null;
    }
  };

  const getAudioElement = (): HTMLAudioElement => {
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
    }
    return audioElRef.current;
  };

  const bindLockScreenControls = (title: string, playbackState: "playing" | "paused") => {
    updateJarvisMediaSession({
      title,
      artist: `Jogi Jarvis (${profile.name})`,
      album: "Human Voice Assistant",
      playbackState,
      handlers: {
        onPlay: () => {
          const el = audioElRef.current;
          if (el && el.src) {
            void el.play().catch(() => {});
            updateJarvisMediaSession({
              title,
              artist: `Jogi Jarvis (${profile.name})`,
              album: "Human Voice Assistant",
              playbackState: "playing",
            });
          }
        },
        onPause: () => {
          const el = audioElRef.current;
          if (el && !el.paused) {
            el.pause();
            updateJarvisMediaSession({
              title,
              artist: `Jogi Jarvis (${profile.name})`,
              album: "Human Voice Assistant",
              playbackState: "paused",
            });
          }
        },
        onStop: () => {
          stopPlayback();
        },
      },
    });
  };

  // Keeps mobile Chrome/Safari audio session alive while thinking so Jogi Jarvis still speaks if screen locks or app minimizes
  const startBackgroundAudioKeepAlive = (statusTitle = "Jogi Jarvis is replying…") => {
    try {
      unlockBrowserSpeech();
      const el = getAudioElement();
      revokeActiveBlobUrl();
      el.onended = null;
      el.onerror = null;
      el.loop = true;
      el.muted = false;
      el.volume = 0.01;
      el.src = getSilentKeepAliveWavUrl();
      void el
        .play()
        .then(() => {
          bindLockScreenControls(statusTitle, "playing");
        })
        .catch(() => {
          // Non-fatal if browser hasn't unlocked audio yet
        });
      void acquireWakeLock();
    } catch {
      // ignore unlock errors
    }
  };

  // Unlock HTMLAudioElement + Web Speech inside a user click gesture on mobile Chrome/Safari
  const unlockAudioElement = () => {
    try {
      unlockBrowserSpeech();
      const el = getAudioElement();
      if (el.paused && !el.src) {
        el.src = getSilentKeepAliveWavUrl();
        el.loop = false;
        el.muted = true;
        void el
          .play()
          .then(() => {
            el.pause();
            el.muted = false;
            el.currentTime = 0;
          })
          .catch(() => {
            el.muted = false;
          });
      }
    } catch {
      // ignore unlock errors
    }
  };

  const stopPlayback = () => {
    playbackTokenRef.current += 1;
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    if (audioElRef.current) {
      audioElRef.current.onended = null;
      audioElRef.current.onerror = null;
      audioElRef.current.loop = false;
      audioElRef.current.pause();
      audioElRef.current.removeAttribute("src");
      audioElRef.current.load();
    }
    revokeActiveBlobUrl();
    updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
    releaseWakeLock();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setLoadingTtsId(null);
    setSpeakingMessageId(null);
  };

  const speakWithBrowserFallback = (
    messageId: string,
    rawText: string,
    token: number
  ): boolean => {
    const langMap: Record<string, string> = {
      English: "en-IN",
      Hindi: "hi-IN",
      Odia: "or-IN",
      Bengali: "bn-IN",
      Tamil: "ta-IN",
      Telugu: "te-IN",
      Marathi: "mr-IN",
      Gujarati: "gu-IN",
      Punjabi: "pa-IN",
      Kannada: "kn-IN",
      Malayalam: "ml-IN",
      Urdu: "ur-PK",
      Spanish: "es-ES",
      French: "fr-FR",
      German: "de-DE",
      Arabic: "ar-SA",
      Japanese: "ja-JP",
      Korean: "ko-KR",
      Chinese: "zh-CN",
    };

    return speakWithChunkedBrowserTts({
      text: rawText,
      bcp47: langMap[activeLanguage] || "en-IN",
      isStillCurrent: () => playbackTokenRef.current === token,
      onStart: () => {
        setSpeakingMessageId(messageId);
        setLoadingTtsId(null);
      },
      onEnd: () => {
        setSpeakingMessageId(null);
        updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
        releaseWakeLock();
      },
      onError: () => {
        setSpeakingMessageId(null);
        updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
        releaseWakeLock();
      },
    });
  };

  const speakText = async (
    messageId: string,
    text: string,
    preserveKeepAlive = false
  ) => {
    if (speakingMessageId === messageId || loadingTtsId === messageId) {
      stopPlayback();
      return;
    }
    if (preserveKeepAlive) {
      playbackTokenRef.current += 1;
      if (ttsAbortRef.current) {
        ttsAbortRef.current.abort();
        ttsAbortRef.current = null;
      }
    } else {
      stopPlayback();
      unlockBrowserSpeech();
    }
    const myToken = playbackTokenRef.current;
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    let timedOut = false;
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);

    setLoadingTtsId(messageId);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          voiceName: profile.voiceName,
          role: profile.role,
          language: activeLanguage,
          conversational: true,
        }),
      });
      window.clearTimeout(timeoutId);
      const data = await res.json();
      if (playbackTokenRef.current !== myToken) return;
      if (!res.ok || !data.audioBase64) {
        throw new Error(data.error || "Could not generate speech audio.");
      }

      const audio = getAudioElement();
      revokeActiveBlobUrl();
      const blobUrl = base64ToAudioBlobUrl(
        data.audioBase64,
        data.mimeType || "audio/wav"
      );
      activeAudioBlobUrlRef.current = blobUrl;

      await playAudioBlobReliably(audio, blobUrl);
      if (playbackTokenRef.current !== myToken) {
        audio.pause();
        return;
      }

      setSpeakingMessageId(messageId);
      setLoadingTtsId(null);

      const lockTitle =
        text
          .replace(/[#*_>`~[\]()]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 68) || "Jogi Jarvis Voice Reply";
      bindLockScreenControls(lockTitle, "playing");
      void acquireWakeLock();

      audio.onended = () => {
        if (playbackTokenRef.current === myToken) {
          setSpeakingMessageId(null);
          revokeActiveBlobUrl();
          updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
          releaseWakeLock();
        }
      };
      audio.onerror = () => {
        if (playbackTokenRef.current === myToken) {
          setSpeakingMessageId(null);
          revokeActiveBlobUrl();
          updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
          releaseWakeLock();
        }
      };
    } catch (err) {
      window.clearTimeout(timeoutId);
      // Only stop silently if user explicitly cancelled/replaced playback (token changed)
      if (playbackTokenRef.current !== myToken) return;
      if (controller.signal.aborted && !timedOut) return;

      // Stop silent keep-alive before falling back to browser speech synthesis
      if (audioElRef.current) {
        audioElRef.current.onended = null;
        audioElRef.current.onerror = null;
        audioElRef.current.loop = false;
        audioElRef.current.pause();
      }
      const fellBack = speakWithBrowserFallback(messageId, text, myToken);
      if (!fellBack) {
        setSpeakingMessageId(null);
        updateJarvisMediaSession({ title: "Jogi Jarvis", playbackState: "none" });
        releaseWakeLock();
        setErrorMsg(
          err instanceof Error ? err.message : "Audio playback failed."
        );
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (playbackTokenRef.current === myToken) {
        setLoadingTtsId(null);
      }
    }
  };

  const generateNoteFromContent = async (
    content: string,
    messageIdToMark?: string
  ) => {
    if (messageIdToMark) {
      setSavingNoteForId(messageIdToMark);
    } else {
      setSavingSessionNote(true);
    }
    setErrorMsg(null);

    try {
      const res = await fetch("/api/notes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          profile,
          subject:
            profile.role === "parent"
              ? "Personal"
              : subject === "All Subjects"
                ? "General"
                : subject,
          language: activeLanguage,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.note) {
        throw new Error(data.error || "Could not create study note.");
      }

      const now = new Date().toISOString();
      const newNote: StudyNote = {
        id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        profileId: profile.id,
        profileName: profile.name,
        title: data.note.title || "Study Note",
        subject: data.note.subject || subject || "General",
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

      onSaveNote(newNote);

      if (messageIdToMark) {
        const updated = messages.map((m) =>
          m.id === messageIdToMark ? { ...m, noteSavedId: newNote.id } : m
        );
        onUpdateMessages(profile.id, updated);
      }

      showToast(`Saved note: ${newNote.title}`);
      return newNote;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to save AI study note."
      );
      return null;
    } finally {
      setSavingNoteForId(null);
      setSavingSessionNote(false);
    }
  };

  const handleSend = async (overrideText?: string, forceLiveSearch = false) => {
    const promptText = (overrideText ?? input).trim();
    if ((!promptText && !attachedImage) || isSending) return;

    if (engine === "local-browser" && attachedImage) {
      setErrorMsg(
        "Homework photo reading uses Cloud Vision. Switch AI Engine to Auto or Gemini to analyze photos."
      );
      return;
    }

    if (autoSpeakRef.current) {
      startBackgroundAudioKeepAlive(
        promptText ? `Replying to: ${promptText.slice(0, 48)}` : "Jogi Jarvis is replying…"
      );
    }

    const currentMessages = messagesRef.current;
    setErrorMsg(null);
    const parsedMobile = parseMobileActions(promptText, profiles);
    const lastAssistantReply = [...currentMessages]
      .reverse()
      .find((m) => m.role === "assistant")?.content;

    const autoFeedbackLines: string[] = [];

    // 1. Live in-app alarm / countdown timer
    if (parsedMobile.autoAlarm) {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "default"
      ) {
        void Notification.requestPermission().catch(() => {});
      }
      onAddAlarm(parsedMobile.autoAlarm);
      const alarmMsg =
        parsedMobile.autoAlarm.type === "timer"
          ? `Started live timer: **${parsedMobile.autoAlarm.label}**.`
          : `Set live alarm for **${formatAlarmTime(parsedMobile.autoAlarm.triggerAt)}** (${parsedMobile.autoAlarm.label}).`;
      autoFeedbackLines.push(alarmMsg);
      showToast(alarmMsg.replace(/\*\*/g, ""));
    }

    // 2. Automatic in-app navigation / profile switch / Read Studio command
    if (autoRunActions && parsedMobile.appCommand) {
      const navConfirm = onExecuteAppCommand(
        parsedMobile.appCommand,
        lastAssistantReply
      );
      autoFeedbackLines.push(navConfirm);
      setInput("");
      if (parsedMobile.isDirectCommandOnly) {
        stopPlayback();
        return;
      }
    }

    // 3. Automatic external mobile app / task launch (YouTube, WhatsApp, SMS, Call, Maps, Android Clock)
    if (autoRunActions && parsedMobile.actions.length > 0 && !attachedImage) {
      const primary = parsedMobile.actions[0];
      // For pure alarms/timers we already started the live in-app alarm, so only auto-open external apps for non-alarm tasks or explicit external launches
      if (primary.kind !== "alarm" && primary.kind !== "timer") {
        triggerMobileAction(primary);
        autoFeedbackLines.push(
          `Automatically opening **${primary.label}** for you.`
        );
        showToast(`Opening ${primary.label}...`);
      }
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content:
        promptText ||
        "Please look at this study photo and teach me how to solve or understand it step-by-step.",
      timestamp: new Date().toISOString(),
      subject: profile.role === "student" ? subject : undefined,
      imageDataUrl: attachedImage?.dataUrl,
      imageBase64: attachedImage?.base64,
      imageMimeType: attachedImage?.mimeType,
    };

    const nextMessages = [...currentMessages, userMsg];
    messagesRef.current = nextMessages;
    onUpdateMessages(profile.id, nextMessages);
    setInput("");
    setAttachedImage(null);

    // For direct mobile/navigation commands (e.g. "open YouTube", "set alarm for 6:30 AM"), respond instantaneously without waiting for an LLM round-trip
    if (
      autoRunActions &&
      parsedMobile.isDirectCommandOnly &&
      !attachedImage &&
      autoFeedbackLines.length > 0
    ) {
      const instantReply: ChatMessage = {
        id: `a-${Date.now()}`,
        role: "assistant",
        content:
          autoFeedbackLines.join(" ") +
          (parsedMobile.actions.length > 0
            ? "\n\nIf your mobile browser paused the automatic redirect, tap the shortcut below to continue."
            : ""),
        timestamp: new Date().toISOString(),
        subject: profile.role === "student" ? subject : undefined,
        actions:
          parsedMobile.actions.length > 0 ? parsedMobile.actions : undefined,
      };
      onUpdateMessages(profile.id, [...nextMessages, instantReply]);
      if (autoSpeakRef.current) {
        void speakText(instantReply.id, autoFeedbackLines.join(" "), true);
      }
      return;
    }

    setIsSending(true);

    try {
      // Unlimited On-Device Local AI (WebGPU / WebLLM — runs directly in browser, zero API key, zero quota)
      if (engine === "local-browser") {
        const assistantId = `a-${Date.now()}`;
        const replyText = await streamLocalLlmChat({
          modelKey: localModelKey,
          messages: nextMessages,
          profile,
          subject: profile.role === "student" ? subject : undefined,
          language: activeLanguage,
          spokenMode: autoSpeakRef.current,
          onProgress: (info) => {
            setLocalProgress(info);
            setLocalStatus(info.progress >= 1 ? "ready" : "loading");
          },
          onDelta: (acc) => {
            const liveMsg: ChatMessage = {
              id: assistantId,
              role: "assistant",
              content: acc,
              timestamp: new Date().toISOString(),
              subject: profile.role === "student" ? subject : undefined,
            };
            onUpdateMessages(profile.id, [...nextMessages, liveMsg]);
          },
        });

        setLocalStatus("ready");
        setDownloadingModelKey(null);
        setDownloadedModels((prev) =>
          prev.includes(localModelKey) ? prev : [...prev, localModelKey]
        );
        const assistantMsg: ChatMessage = {
          id: assistantId,
          role: "assistant",
          content:
            replyText ||
            "I heard you, but I could not form a response. Please try asking again.",
          timestamp: new Date().toISOString(),
          subject: profile.role === "student" ? subject : undefined,
          actions:
            parsedMobile.actions.length > 0 ? parsedMobile.actions : undefined,
        };
        const updatedMessages = [...nextMessages, assistantMsg];
        onUpdateMessages(profile.id, updatedMessages);

        if (autoSpeakRef.current) {
          void speakText(assistantMsg.id, assistantMsg.content, true);
        }
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({
            role: m.role,
            content: m.content,
            imageBase64: m.imageBase64,
            imageMimeType: m.imageMimeType,
          })),
          profile,
          subject: profile.role === "student" ? subject : undefined,
          useSearch: forceLiveSearch || useSearch,
          language: activeLanguage,
          speedMode,
          engine,
          stream: true,
          spokenMode: autoSpeakRef.current,
        }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          errData.error || "Jogi Jarvis could not reply right now."
        );
      }

      const assistantId = `a-${Date.now()}`;
      let accumulated = "";
      let sources: Array<{ uri: string; title: string }> = [];

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const rawEvent of events) {
            const line = rawEvent
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!line) continue;
            const payload = JSON.parse(line.slice(6)) as {
              delta?: string;
              done?: boolean;
              sources?: Array<{ uri: string; title: string }>;
              error?: string;
            };

            if (payload.error) {
              throw new Error(payload.error);
            }
            if (payload.delta) {
              accumulated += payload.delta;
              const liveMsg: ChatMessage = {
                id: assistantId,
                role: "assistant",
                content: accumulated,
                timestamp: new Date().toISOString(),
                subject: profile.role === "student" ? subject : undefined,
                sources,
              };
              onUpdateMessages(profile.id, [...nextMessages, liveMsg]);
            }
            if (Array.isArray(payload.sources)) {
              sources = payload.sources;
            }
          }
        }
      } else {
        const data = (await res.json()) as {
          reply?: string;
          sources?: Array<{ uri: string; title: string }>;
        };
        accumulated = data.reply || "";
        sources = Array.isArray(data.sources) ? data.sources : [];
      }

      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content:
          accumulated.trim() ||
          "I heard you, but I could not form a response. Please try asking again.",
        timestamp: new Date().toISOString(),
        subject: profile.role === "student" ? subject : undefined,
        sources,
        actions:
          parsedMobile.actions.length > 0 ? parsedMobile.actions : undefined,
      };

      const updatedMessages = [...nextMessages, assistantMsg];
      onUpdateMessages(profile.id, updatedMessages);

      if (autoSpeakRef.current) {
        void speakText(assistantMsg.id, assistantMsg.content, true);
      }

      // If student has Auto-Take AI Notes enabled, automatically distill substantial study explanations
      if (
        profile.role === "student" &&
        autoNoteEnabled &&
        assistantMsg.content.length > 180
      ) {
        const qaBlock = `Student asked: ${userMsg.content}\n\nTeacher Jogi Jarvis explained:\n${assistantMsg.content}`;
        try {
          const noteRes = await fetch("/api/notes/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: qaBlock,
              profile,
              subject: subject === "All Subjects" ? "General" : subject,
              language: activeLanguage,
            }),
          });
          if (noteRes.ok) {
            const noteData = await noteRes.json();
            if (noteData.note) {
              const now = new Date().toISOString();
              const autoNote: StudyNote = {
                id: `note-${Date.now()}-auto`,
                profileId: profile.id,
                profileName: profile.name,
                title: noteData.note.title || "Study Note",
                subject: noteData.note.subject || subject || "General",
                summary: noteData.note.summary || "",
                keyPoints: Array.isArray(noteData.note.keyPoints)
                  ? noteData.note.keyPoints
                  : [],
                definitions: Array.isArray(noteData.note.definitions)
                  ? noteData.note.definitions
                  : [],
                practiceQuestions: Array.isArray(noteData.note.practiceQuestions)
                  ? noteData.note.practiceQuestions
                  : [],
                teacherTip: noteData.note.teacherTip || "",
                createdAt: now,
                updatedAt: now,
                sourceMode: "chat",
              };
              onSaveNote(autoNote);
              onUpdateMessages(
                profile.id,
                updatedMessages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, noteSavedId: autoNote.id }
                    : m
                )
              );
              showToast(`Auto-saved AI note: ${autoNote.title}`);
            }
          }
        } catch {
          // non-blocking auto-note failure
        }
      }
    } catch (err) {
      if (autoSpeakRef.current) {
        stopPlayback();
      }
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Something went wrong reaching Jogi Jarvis."
      );
    } finally {
      setIsSending(false);
    }
  };

  const cleanupMicVad = () => {
    if (micVadIntervalRef.current !== null) {
      window.clearInterval(micVadIntervalRef.current);
      micVadIntervalRef.current = null;
    }
    if (micVadCtxRef.current) {
      void micVadCtxRef.current.close().catch(() => {});
      micVadCtxRef.current = null;
    }
  };

  const handleToggleVoiceDictation = async () => {
    setErrorMsg(null);

    if (isRecording) {
      cleanupMicVad();
      if (autoSpeakRef.current) {
        unlockAudioElement();
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      setIsRecording(false);
      return;
    }

    stopPlayback();
    if (autoSpeakRef.current) {
      unlockAudioElement();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      recordedChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        cleanupMicVad();
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        if (blob.size < 250) return;

        setIsTranscribing(true);
        try {
          const audioBase64 = await blobToBase64(blob);
          const cleanMime = mimeType.split(";")[0];
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioBase64, mimeType: cleanMime }),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error || "Could not transcribe voice audio.");
          }
          if (data.transcript) {
            const spoken = String(data.transcript).trim();
            if (!spoken) return;
            const parsedSpoken = parseMobileActions(spoken, profiles);
            // When Auto-Speak is ON, automatically ask Jogi Jarvis and speak the reply aloud right away!
            if (
              autoSpeakRef.current ||
              (autoRunActions &&
                (parsedSpoken.appCommand ||
                  parsedSpoken.autoAlarm ||
                  parsedSpoken.actions.length > 0))
            ) {
              void handleSend(spoken);
            } else {
              setInput((prev) => (prev ? `${prev} ${spoken}` : spoken));
              textareaRef.current?.focus();
            }
          }
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : "Voice transcription failed."
          );
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);

      // When Auto-Speak is ON, auto-detect natural pause after user speaks so Jogi Jarvis replies automatically
      if (autoSpeakRef.current) {
        try {
          const vadCtx = new AudioContext();
          micVadCtxRef.current = vadCtx;
          const src = vadCtx.createMediaStreamSource(stream);
          const analyser = vadCtx.createAnalyser();
          analyser.fftSize = 1024;
          src.connect(analyser);
          const samples = new Float32Array(analyser.fftSize);

          let voiceFrames = 0;
          let heardSpeech = false;
          let lastSpeechAt = Date.now();
          const startedAt = Date.now();

          micVadIntervalRef.current = window.setInterval(() => {
            if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
              cleanupMicVad();
              return;
            }
            analyser.getFloatTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i += 1) {
              sum += samples[i] * samples[i];
            }
            const rms = Math.sqrt(sum / samples.length);
            const now = Date.now();
            if (rms > 0.018) {
              voiceFrames += 1;
              lastSpeechAt = now;
              if (voiceFrames >= 3) {
                heardSpeech = true;
              }
            }
            // Auto-send after 1.7s pause once user finished speaking (or 22s cap)
            if (
              (heardSpeech && now - lastSpeechAt >= 1700) ||
              now - startedAt >= 22000
            ) {
              cleanupMicVad();
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.stop();
              }
            }
          }, 90);
        } catch {
          // If AudioContext VAD isn't available, manual tap-to-stop still works seamlessly
        }
      }
    } catch {
      setErrorMsg(
        "Microphone permission was denied. Please allow microphone access in your browser to speak to Jogi Jarvis."
      );
    }
  };

  const handleImageFile = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Please attach an image file (photo of homework or textbook).");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";
      setAttachedImage({
        dataUrl,
        base64,
        mimeType: file.type,
        name: file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleSaveEntireSession = async () => {
    if (messages.length === 0) return;
    const transcript = messages
      .map(
        (m) =>
          `${m.role === "user" ? profile.name : "Jogi Jarvis"}: ${m.content}`
      )
      .join("\n\n");
    await generateNoteFromContent(transcript);
  };

  const handleGenerateStudySummary = async () => {
    if (messages.length === 0 || generatingStudySummary) return;
    setGeneratingStudySummary(true);
    setErrorMsg(null);

    try {
      const summaryNote = await generateStudySummaryFromSession({
        messages,
        profile,
        subject,
        language: activeLanguage,
      });
      onSaveNote(summaryNote);
      showToast(`Saved ${summaryNote.title}`, summaryNote.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not generate a Study Summary right now."
      );
    } finally {
      setGeneratingStudySummary(false);
    }
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {
      // ignore
    }
  };

  const starters = STARTER_PROMPTS[profile.role];

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#F8FAFC]">
      {/* Workspace context bar */}
      <div className="bg-white border-b border-slate-200 px-5 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <ProfileAvatar profile={profile} size="sm" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-slate-900 truncate">
              {profile.role === "parent"
                ? `${profile.name}'s Assistant Desk`
                : `${profile.name}'s AI Teacher`}
            </h1>
            <p className="text-xs text-slate-500 truncate">
              {profile.role === "parent"
                ? `Voice: ${profile.voiceName} · Ask anything or plan for the family`
                : `${profile.grade || "Student"} · ${subject} · Voice: ${profile.voiceName}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <LanguagePicker
            compact
            value={activeLanguage}
            onChange={onChangeLanguage}
          />

          <button
            type="button"
            onClick={() =>
              setSpeedMode((m) => (m === "fast" ? "detailed" : "fast"))
            }
            title={
              speedMode === "fast"
                ? "Fast Answer mode active (click for Deep Math & reasoning)"
                : "Deep Math & reasoning mode active (click for Fast Answer)"
            }
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              speedMode === "fast"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-amber-50 border-amber-200 text-amber-900"
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{speedMode === "fast" ? "Fast Mode" : "Deep Math"}</span>
          </button>

          <label
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border whitespace-nowrap shrink-0 transition-colors ${
              engine === "local-browser" || engine === "local-server"
                ? "bg-emerald-50 border-emerald-300 text-emerald-900"
                : "bg-white border-slate-200 text-slate-700"
            }`}
            title="Choose AI Engine — use Local AI (On-Device) for unlimited chats with zero API quota"
          >
            <Cpu className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
            <select
              aria-label="AI Engine"
              value={engine}
              onChange={(e) => setEngine(e.target.value as AiEngine)}
              className="bg-transparent text-xs font-medium text-slate-800 focus:outline-none cursor-pointer"
            >
              <option value="auto">
                {fallbackPoolAvailable
                  ? `Auto (${totalActiveModels} Cloud Models)`
                  : "Auto (Cloud)"}
              </option>
              <option value="local-browser">Local AI (Unlimited · On-Device)</option>
              <option value="gemini">Gemini Cloud</option>
              {nvidiaAvailable && (
                <option value="nvidia">NVIDIA NIM (12 Models)</option>
              )}
              {localServerAvailable && (
                <option value="local-server">Local Server (Ollama / LM Studio)</option>
              )}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setUseSearch((v) => !v)}
            title="Real-time Google Search access for live news, sports scores, weather, and current facts"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              useSearch
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>{useSearch ? "Live Data On" : "Live Data Off"}</span>
          </button>

          <button
            type="button"
            onClick={() => setAutoRunActions((v) => !v)}
            title="Automatically navigate and launch tasks (YouTube, WhatsApp, SMS, Calls, Alarms, Read Tab) as soon as you ask"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              autoRunActions
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
            }`}
          >
            <Zap className="h-3.5 w-3.5" />
            <span>{autoRunActions ? "Auto-Run On" : "Auto-Run Off"}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              const nextVal = !autoSpeak;
              autoSpeakRef.current = nextVal;
              setAutoSpeak(nextVal);
              if (!nextVal) {
                stopPlayback();
                showToast("Auto-Speak turned off.");
              } else {
                unlockAudioElement();
                showToast(
                  "Human Auto-Speak enabled — replies stay natural and continue playing when minimized or screen-locked."
                );
              }
            }}
            title={
              autoSpeak
                ? "Human Auto-Speak is ON (supports minimized & lock-screen playback) — click to turn off"
                : "Auto-Speak is OFF — click for natural human voice replies with lock-screen playback"
            }
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              autoSpeak
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
            }`}
          >
            {autoSpeak ? (
              <Volume2 className="h-3.5 w-3.5" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" />
            )}
            <span>{autoSpeak ? "Auto-Speak On" : "Auto-Speak Off"}</span>
          </button>

          {messages.length > 0 && (
            <>
              <button
                type="button"
                disabled={generatingStudySummary}
                onClick={() => void handleGenerateStudySummary()}
                title="Condense this chat session into a concise Study Summary note"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
                  isLongStudySession(messages)
                    ? "bg-blue-700 text-white hover:bg-blue-800"
                    : "bg-slate-900 text-white hover:bg-slate-800"
                }`}
              >
                {generatingStudySummary ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="h-3.5 w-3.5" />
                )}
                <span>
                  {generatingStudySummary ? "Summarizing..." : "Study Summary"}
                </span>
              </button>

              <button
                type="button"
                disabled={savingSessionNote}
                onClick={handleSaveEntireSession}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                {savingSessionNote ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BookMarked className="h-3.5 w-3.5" />
                )}
                <span>Full Note</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  stopPlayback();
                  onUpdateMessages(profile.id, []);
                }}
                aria-label="Clear current conversation"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Background download progress strip if user switches engine while a large Local AI model finishes downloading */}
      {engine !== "local-browser" && localStatus === "loading" && downloadingLocalModel && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-5 sm:px-8 py-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-700 shrink-0" />
            <span className="text-xs font-medium text-emerald-900 truncate">
              Downloading {downloadingLocalModel.label} ({Math.round((localProgress?.progress || 0) * 100)}%)
              {autoSelectOnDownload ? " · Will auto-select when finished" : ""}
            </span>
          </div>
          <div className="w-36 h-1.5 rounded-full bg-emerald-200 overflow-hidden shrink-0">
            <div
              className="h-full bg-emerald-700 transition-all duration-200"
              style={{
                width: `${Math.max(4, Math.round((localProgress?.progress || 0) * 100))}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* On-Device Unlimited Local AI Control Strip */}
      {engine === "local-browser" && (
        <div className="bg-slate-50 border-b border-slate-200 px-5 sm:px-8 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
              <Cpu className="h-3.5 w-3.5 shrink-0" />
              <span>Local AI · Unlimited</span>
            </span>
            <select
              aria-label="Local AI Model"
              disabled={localStatus === "loading" || isSending}
              value={localModelKey}
              onChange={(e) => setLocalModelKey(e.target.value)}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-800 focus:outline-none focus:border-emerald-600 disabled:opacity-60 max-w-full"
            >
              <optgroup label="Phone & Everyday (0.3B – 2B)">
                {LOCAL_LLM_MODELS.filter((m) => m.tier === "mobile").map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label} ({m.sizeLabel}){downloadedModels.includes(m.key) ? " · Downloaded" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Mid-Size Power (3B – 3.8B)">
                {LOCAL_LLM_MODELS.filter((m) => m.tier === "mid").map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label} ({m.sizeLabel}){downloadedModels.includes(m.key) ? " · Downloaded" : ""}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Large Pro · Desktop / Laptop GPU (7B – 9B)">
                {LOCAL_LLM_MODELS.filter((m) => m.tier === "large").map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label} ({m.sizeLabel}){downloadedModels.includes(m.key) ? " · Downloaded" : ""}
                  </option>
                ))}
              </optgroup>
            </select>
            <span className="text-[11px] text-slate-500 hidden lg:inline">
              {activeLocalModel.bestFor} · {activeLocalModel.vramLabel}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <label
              className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-600 cursor-pointer select-none whitespace-nowrap"
              title="Automatically switch to this Local AI model as soon as its download finishes"
            >
              <input
                type="checkbox"
                checked={autoSelectOnDownload}
                onChange={(e) => setAutoSelectOnDownload(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
              />
              <span>Auto-select when ready</span>
            </label>

            {localStatus === "unsupported" ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-amber-900">
                <span>
                  {gpuInfo?.reason ||
                    "WebGPU is unavailable in this browser for on-device Local AI."}
                </span>
                <button
                  type="button"
                  onClick={() => setEngine("auto")}
                  className="px-2.5 py-1 rounded-md bg-white border border-amber-300 text-amber-900 font-semibold hover:bg-amber-50 whitespace-nowrap"
                >
                  Switch to Auto
                </button>
              </div>
            ) : localStatus === "loading" ? (
              <div className="flex items-center gap-2.5 min-w-[210px]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-700 shrink-0" />
                <div className="flex-1 min-w-[130px]">
                  <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 transition-all duration-200"
                      style={{
                        width: `${Math.max(4, Math.round((localProgress?.progress || 0) * 100))}%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-600 truncate max-w-[240px] mt-0.5">
                    {Math.round((localProgress?.progress || 0) * 100)}% ·{" "}
                    {localProgress?.text || `Downloading ${activeLocalModel.label}…`}
                  </p>
                </div>
              </div>
            ) : localStatus === "ready" ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-800">
                  <Check className="h-3.5 w-3.5" />
                  <span>Active on Device</span>
                </span>
                <button
                  type="button"
                  onClick={() => void handleUnloadLocalModel()}
                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                >
                  Unload
                </button>
                {isCurrentLocalModelCached && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteCachedLocalModel()}
                    title="Delete downloaded model files from browser storage to free disk space"
                    className="px-2 py-1 rounded-md text-xs font-medium text-slate-500 hover:text-red-700 hover:bg-red-50 whitespace-nowrap"
                  >
                    Clear Cache
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isSending}
                  onClick={() => void handleLoadLocalModel()}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-emerald-700 hover:bg-emerald-800 text-white disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>
                    {isCurrentLocalModelCached ? "Load Cached Model" : "Download & Activate"}
                  </span>
                </button>
                {isCurrentLocalModelCached && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteCachedLocalModel()}
                    title="Delete downloaded model files from browser storage to free disk space"
                    className="px-2 py-1 rounded-md text-xs font-medium text-slate-500 hover:text-red-700 hover:bg-red-50 whitespace-nowrap"
                  >
                    Clear Cache
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Inline notification banners */}
      {toast && (
        <div className="bg-emerald-50 border-b border-emerald-200 px-6 py-2.5 text-xs font-medium text-emerald-900 flex items-center justify-between gap-4">
          <span className="truncate">{toast.message}</span>
          <div className="flex items-center gap-3 shrink-0">
            {toast.noteId && (
              <button
                type="button"
                onClick={() => {
                  const id = toast.noteId!;
                  setToast(null);
                  onOpenNote(id);
                }}
                className="font-semibold text-emerald-800 underline underline-offset-2 hover:text-emerald-950 whitespace-nowrap"
              >
                Open Note
              </button>
            )}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="text-emerald-700 hover:text-emerald-900"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 text-xs font-medium text-red-800 flex flex-wrap items-center justify-between gap-3">
          <span className="min-w-0 flex-1">{errorMsg}</span>
          <div className="flex items-center gap-3 shrink-0">
            {engine !== "local-browser" &&
              /(quota|rate limit|429|exhausted|busy|limit)/i.test(errorMsg) && (
                <button
                  type="button"
                  onClick={() => {
                    setEngine("local-browser");
                    setErrorMsg(null);
                    showToast(
                      "Switched to Unlimited On-Device Local AI — zero API limits."
                    );
                  }}
                  className="px-2.5 py-1 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white font-semibold whitespace-nowrap transition-colors"
                >
                  Use Unlimited Local AI
                </button>
              )}
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-red-700 hover:text-red-900 shrink-0"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Conversation viewport */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 ? (
            <div className="py-8 sm:py-12 space-y-8">
              <div className="space-y-3">
                <p className="text-xs font-medium text-slate-500">
                  {profile.role === "parent"
                    ? "Personal Assistant · Ready for any question"
                    : `${profile.grade || "Study Desk"} · Patient AI Teacher & Note-Taker`}
                </p>
                <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight max-w-2xl">
                  {profile.role === "parent"
                    ? `Good to see you, ${profile.name}. What can Jogi Jarvis help you with today?`
                    : `Hi ${profile.name}, what are we studying today?`}
                </h2>
                <p className="text-sm sm:text-base text-slate-600 max-w-xl leading-relaxed">
                  {profile.role === "parent"
                    ? "Ask anything by typing or speaking, check live facts with Web Search, or switch to Live Voice for a hands-free conversation."
                    : "Ask any doubt, snap a photo of a homework page, or talk out loud. I will explain step-by-step and turn our lesson into clean study notes."}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={onOpenLiveVoice}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors whitespace-nowrap"
                >
                  <Mic className="h-4 w-4" />
                  <span>Start Live Voice Conversation</span>
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white border border-slate-200 hover:border-slate-300 text-slate-800 text-sm font-medium transition-colors whitespace-nowrap"
                >
                  <ImagePlus className="h-4 w-4 text-slate-600" />
                  <span>Upload Homework Photo</span>
                </button>
              </div>

              {/* Live Real-Time Data Quick Access */}
              <div className="pt-6 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-slate-500">
                    Live Data · Real-time News, Sports &amp; Updates
                  </h3>
                  <span className="text-[11px] font-medium text-blue-700">
                    Google Search Grounded
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      void handleSend(
                        "What are today's top breaking news headlines in India and around the world? Give a crisp summary.",
                        true
                      )
                    }
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-left"
                  >
                    <Newspaper className="h-4 w-4 text-blue-700 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Top News
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void handleSend(
                        "Give me today's live sports scores, latest cricket and football match updates, and major sports headlines.",
                        true
                      )
                    }
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-amber-300 hover:bg-amber-50/30 transition-colors text-left"
                  >
                    <Trophy className="h-4 w-4 text-amber-600 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Live Sports
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void handleSend(
                        "What are the latest science, space, and technology updates today?",
                        true
                      )
                    }
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30 transition-colors text-left"
                  >
                    <Globe className="h-4 w-4 text-emerald-700 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Science &amp; Tech
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      void handleSend(
                        "Give me today's major weather alerts, gold/market highlights, and key world updates.",
                        true
                      )
                    }
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-sky-300 hover:bg-sky-50/30 transition-colors text-left"
                  >
                    <CloudSun className="h-4 w-4 text-sky-600 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Weather &amp; World
                    </span>
                  </button>
                </div>
              </div>

              {/* Mobile Personal Tasks & Script Studio */}
              <div className="pt-6 border-t border-slate-200 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-slate-500">
                    Mobile Personal Tasks &amp; Script Generator
                  </h3>
                  <span className="text-[11px] font-medium text-slate-500">
                    1-Tap Mobile Actions
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <a
                    href="https://m.youtube.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-red-300 hover:bg-red-50/30 transition-colors text-left"
                  >
                    <Play className="h-4 w-4 text-red-600 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Open YouTube
                    </span>
                  </a>

                  <button
                    type="button"
                    onClick={() => setTaskModalMode("message")}
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30 transition-colors text-left"
                  >
                    <MessageSquare className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Send Message
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTaskModalMode("alarm")}
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-amber-300 hover:bg-amber-50/30 transition-colors text-left"
                  >
                    <AlarmClock className="h-4 w-4 text-amber-600 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Set Alarm / Timer
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setTaskModalMode("script")}
                    className="flex items-center gap-2 p-3 rounded-xl bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors text-left"
                  >
                    <FileCode2 className="h-4 w-4 text-indigo-700 shrink-0" />
                    <span className="text-xs font-semibold text-slate-800">
                      Generate Script
                    </span>
                  </button>
                </div>
              </div>

              <div className="pt-6 border-t border-slate-200">
                <h3 className="text-xs font-semibold text-slate-500 mb-3">
                  Try asking
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {starters.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => void handleSend(prompt)}
                      className="text-left p-4 rounded-xl bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors text-sm text-slate-800 leading-snug"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6 pb-4">
              {messages.map((msg, idx) => {
                const isUser = msg.role === "user";
                const previousUserPrompt =
                  !isUser && idx > 0 && messages[idx - 1].role === "user"
                    ? messages[idx - 1].content
                    : "";

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${
                      isUser ? "items-end" : "items-start"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs text-slate-500 mb-1.5 px-1">
                      <span className="font-medium text-slate-700">
                        {isUser ? profile.name : "Jogi Jarvis"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {formatShortDate(msg.timestamp)}
                      </span>
                    </div>

                    {isUser ? (
                      <div className="max-w-[85%] bg-blue-700 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed space-y-2.5">
                        {msg.imageDataUrl && (
                          <img
                            src={msg.imageDataUrl}
                            alt="Uploaded homework or study page"
                            referrerPolicy="no-referrer"
                            className="max-h-56 rounded-lg object-contain bg-white/10"
                          />
                        )}
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    ) : (
                      <div className="w-full bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-5 py-4 space-y-4">
                        <div className="jarvis-prose">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>

                        {/* Quick Mobile Action cards (auto-launched when Auto-Run is on, kept as fallback) */}
                        {msg.actions && msg.actions.length > 0 && (
                          <div className="pt-3 border-t border-slate-100">
                            <p className="text-xs font-semibold text-slate-500 mb-2">
                              {autoRunActions
                                ? "Mobile Action · Auto-launched (tap below if your browser paused it)"
                                : "Quick Mobile Actions · Tap to launch"}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              {msg.actions.map((action) => (
                                <a
                                  key={action.id}
                                  href={action.href}
                                  target={action.external ? "_blank" : undefined}
                                  rel={
                                    action.external
                                      ? "noopener noreferrer"
                                      : undefined
                                  }
                                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-slate-50 hover:bg-blue-50/70 border border-slate-200 hover:border-blue-300 transition-colors group"
                                >
                                  {getActionIcon(action.kind)}
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-slate-900 truncate group-hover:text-blue-800">
                                      {action.label}
                                    </p>
                                    {action.subtitle && (
                                      <p className="text-[11px] text-slate-500 truncate">
                                        {action.subtitle}
                                      </p>
                                    )}
                                  </div>
                                  <ExternalLink className="h-3.5 w-3.5 text-slate-400 group-hover:text-blue-600 shrink-0" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Grounding sources if Google Search was used */}
                        {msg.sources && msg.sources.length > 0 && (
                          <div className="pt-3 border-t border-slate-100">
                            <p className="text-xs font-semibold text-slate-500 mb-1.5">
                              Web Sources
                            </p>
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              {msg.sources.map((src) => (
                                <a
                                  key={src.uri}
                                  href={src.uri}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline max-w-xs truncate"
                                >
                                  <span className="truncate">{src.title}</span>
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Per-message study & voice action bar */}
                        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={loadingTtsId === msg.id}
                            onClick={() => void speakText(msg.id, msg.content)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                          >
                            {loadingTtsId === msg.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : speakingMessageId === msg.id ? (
                              <Square className="h-3.5 w-3.5 text-blue-700 fill-blue-700" />
                            ) : (
                              <Volume2 className="h-3.5 w-3.5" />
                            )}
                            <span>
                              {speakingMessageId === msg.id ? "Stop" : "Listen"}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              onOpenInReader(msg.content, activeLanguage)
                            }
                            title="Open in Read Tab with sentence highlighting, speed control, and translation"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap shrink-0"
                          >
                            <BookOpen className="h-3.5 w-3.5" />
                            <span>Read Tab</span>
                          </button>

                          {(msg.content.includes("```") ||
                            /\b(script|speech|automation|python|bash|termux)\b/i.test(
                              previousUserPrompt
                            )) && (
                            <button
                              type="button"
                              onClick={() =>
                                downloadGeneratedScript(
                                  msg.content,
                                  previousUserPrompt || "jogi-jarvis-script"
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-indigo-700 hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>Download Script</span>
                            </button>
                          )}

                          {msg.noteSavedId ? (
                            <button
                              type="button"
                              onClick={() => onOpenNote(msg.noteSavedId!)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0"
                            >
                              <Check className="h-3.5 w-3.5" />
                              <span>Saved · Open Study Note</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={savingNoteForId === msg.id}
                              onClick={() =>
                                void generateNoteFromContent(
                                  previousUserPrompt
                                    ? `Question: ${previousUserPrompt}\n\nExplanation:\n${msg.content}`
                                    : msg.content,
                                  msg.id
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap shrink-0"
                            >
                              {savingNoteForId === msg.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <BookMarked className="h-3.5 w-3.5" />
                              )}
                              <span>Make AI Study Note</span>
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void handleCopy(msg.id, msg.content)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                          >
                            {copiedId === msg.id ? (
                              <Check className="h-3.5 w-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                            <span>{copiedId === msg.id ? "Copied" : "Copy"}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {isSending && (
                <div className="flex items-center gap-2.5 text-sm text-slate-600 px-2 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-blue-700" />
                  <span>
                    {engine === "local-browser" && localStatus === "loading"
                      ? `Downloading ${activeLocalModel.label} to your device (${Math.round((localProgress?.progress || 0) * 100)}%)...`
                      : engine === "local-browser"
                        ? `Jogi Jarvis (${activeLocalModel.label} · Local AI) is replying on your device...`
                        : "Jogi Jarvis is thinking..."}
                  </span>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </div>

      {/* Bottom Composer */}
      <div className="bg-white border-t border-slate-200 px-4 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto space-y-2.5">
          {messages.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
              <a
                href="https://m.youtube.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-red-50 hover:text-red-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Play className="h-3.5 w-3.5 text-red-600" />
                <span>YouTube</span>
              </a>
              <button
                type="button"
                onClick={() => setTaskModalMode("message")}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-emerald-50 hover:text-emerald-700 transition-colors whitespace-nowrap shrink-0"
              >
                <MessageSquare className="h-3.5 w-3.5 text-emerald-600" />
                <span>Send Message</span>
              </button>
              <button
                type="button"
                onClick={() => setTaskModalMode("alarm")}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-amber-50 hover:text-amber-700 transition-colors whitespace-nowrap shrink-0"
              >
                <AlarmClock className="h-3.5 w-3.5 text-amber-600" />
                <span>Alarm / Timer</span>
              </button>
              <button
                type="button"
                onClick={() => setTaskModalMode("script")}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 transition-colors whitespace-nowrap shrink-0"
              >
                <FileCode2 className="h-3.5 w-3.5 text-indigo-700" />
                <span>Script Generator</span>
              </button>
            </div>
          )}

          {attachedImage && (
            <div className="flex items-center gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
              <img
                src={attachedImage.dataUrl}
                alt="Attached homework preview"
                referrerPolicy="no-referrer"
                className="h-12 w-12 rounded object-cover border border-slate-200"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-800 truncate">
                  {attachedImage.name}
                </p>
                <p className="text-xs text-slate-500">
                  Attached photo · Jarvis will read and explain this
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAttachedImage(null)}
                aria-label="Remove attached photo"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="flex items-end gap-2 bg-slate-50 border border-slate-200 focus-within:border-blue-500 focus-within:bg-white rounded-xl p-2 transition-colors">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                handleImageFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach homework or textbook photo"
              aria-label="Attach photo"
              className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 transition-colors"
            >
              <ImagePlus className="h-5 w-5" />
            </button>

            <button
              type="button"
              disabled={isTranscribing}
              onClick={() => void handleToggleVoiceDictation()}
              title={isRecording ? "Stop recording voice" : "Speak your question"}
              aria-label={isRecording ? "Stop voice recording" : "Record voice question"}
              className={`h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-lg transition-colors ${
                isRecording
                  ? "bg-red-600 text-white hover:bg-red-700"
                  : "text-slate-600 hover:text-slate-900 hover:bg-slate-200/70"
              }`}
            >
              {isTranscribing ? (
                <Loader2 className="h-5 w-5 animate-spin text-blue-700" />
              ) : isRecording ? (
                <Square className="h-4 w-4 fill-white" />
              ) : (
                <Mic className="h-5 w-5" />
              )}
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder={
                isRecording
                  ? "Listening... click stop when finished speaking"
                  : isTranscribing
                    ? "Transcribing your voice..."
                    : profile.role === "parent"
                      ? `Ask Jogi Jarvis anything, ${profile.name}...`
                      : `Ask your teacher about ${subject === "All Subjects" ? "any subject" : subject}...`
              }
              className="flex-1 resize-none bg-transparent py-2.5 px-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none max-h-36"
            />

            <button
              type="button"
              disabled={isSending || (!input.trim() && !attachedImage)}
              onClick={() => void handleSend()}
              className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="h-4 w-4" />
              <span className="hidden sm:inline">Ask</span>
            </button>
          </div>
        </div>
      </div>

      {taskModalMode && (
        <MobileTaskModal
          mode={taskModalMode}
          onClose={() => setTaskModalMode(null)}
          onAddAlarm={(alarm) => {
            onAddAlarm(alarm);
            showToast(
              alarm.type === "timer"
                ? `Live timer started: ${alarm.label}`
                : `Live alarm set for ${formatAlarmTime(alarm.triggerAt)} (${alarm.label})`
            );
          }}
          onRunScriptPrompt={(scriptPrompt) => {
            void handleSend(scriptPrompt, false);
          }}
        />
      )}
      <audio ref={audioElRef} playsInline preload="auto" className="hidden" />
    </div>
  );
}
