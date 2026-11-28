import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Copy,
  Languages,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { FamilyProfile } from "../types";
import { WORLD_TRANSLATION_LANGUAGES } from "../data/defaults";
import {
  blobToBase64,
  float32ToPcm16Base64,
  LiveAudioPlayer,
} from "../utils/audio";
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
  StudyMediaQuickButtons,
  StudyMediaStudioModal,
  type StudyMediaMode,
} from "./StudyMediaStudioModal";
import {
  generateLocalLlmPrompt,
  getReadyLocalModelKey,
  isLocalBrowserEnginePreferred,
} from "../utils/localLlm";

type SessionStatus = "idle" | "connecting" | "connected" | "error";
type TransportMode = "live-ws" | "handsfree-https";
type HandsFreePhase = "idle" | "listening" | "hearing" | "interpreting" | "speaking";
type TurnMode = "auto" | "them" | "me";

interface InterpreterEntry {
  id: string;
  speaker: "heard" | "interpreter";
  speakerSide?: "me" | "them";
  text: string;
  secondaryText?: string;
  pronunciation?: string;
  metaLabel?: string;
  targetLanguage?: string;
  suggestedReplies?: string[];
  timestamp: string;
}

interface TranslateViewProps {
  profile: FamilyProfile;
  onStudySessionComplete?: (profileId: string, reason?: string) => void;
}

const STORAGE_MY_LANG = "jogi_jarvis_translate_from_v2";
const STORAGE_OTHER_LANG = "jogi_jarvis_translate_to_v2";

const QUICK_PHRASES = [
  "Hello! Nice to meet you.",
  "Excuse me, can you please help me?",
  "Tell them I will be there in five minutes.",
  "Please speak slowly, my live interpreter is translating for us.",
];

export function TranslateView({
  profile,
  onStudySessionComplete,
}: TranslateViewProps) {
  const defaultMyLang =
    profile.preferredLanguage && profile.preferredLanguage !== "Auto-Detect"
      ? profile.preferredLanguage
      : "English";

  const [myLanguage, setMyLanguage] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_MY_LANG) || defaultMyLang;
    } catch {
      return defaultMyLang;
    }
  });
  const [otherLanguage, setOtherLanguage] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_OTHER_LANG) || "Auto-Detect";
    } catch {
      return "Auto-Detect";
    }
  });

  const [customMyLanguage, setCustomMyLanguage] = useState("");
  const [customOtherLanguage, setCustomOtherLanguage] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [sameLanguageReplyMode, setSameLanguageReplyMode] = useState(false);

  // Real-time live interpreter state (Gemini Live WebSocket + automatic Turbo Hands-Free HTTPS VAD fallback)
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [transport, setTransport] = useState<TransportMode>("live-ws");
  const [handsFreePhase, setHandsFreePhase] = useState<HandsFreePhase>("idle");
  const [turnMode, setTurnMode] = useState<TurnMode>("auto");
  const [isMuted, setIsMuted] = useState(false);
  const [isJarvisSpeaking, setIsJarvisSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [lastDetectedOtherLang, setLastDetectedOtherLang] = useState<string>("");

  const [entries, setEntries] = useState<InterpreterEntry[]>([]);
  const [typedText, setTypedText] = useState("");
  const [isSendingTyped, setIsSendingTyped] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);

  const [speakingEntryId, setSpeakingEntryId] = useState<string | null>(null);
  const lastStudyAwardAtRef = useRef<number>(0);
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fullscreenEntry, setFullscreenEntry] =
    useState<InterpreterEntry | null>(null);
  const [mediaStudio, setMediaStudio] = useState<{
    isOpen: boolean;
    mode: StudyMediaMode;
    prompt: string;
    autoRun: boolean;
  }>({
    isOpen: false,
    mode: "search",
    prompt: "",
    autoRun: false,
  });

  const effectiveMyLanguage =
    myLanguage === "__custom__"
      ? customMyLanguage.trim() || "English"
      : myLanguage;
  const effectiveOtherLanguage =
    otherLanguage === "__custom__"
      ? customOtherLanguage.trim() || "Auto-Detect"
      : otherLanguage;

  const isOtherAuto = effectiveOtherLanguage.toLowerCase() === "auto-detect";
  const isSameLanguage =
    !isOtherAuto &&
    effectiveMyLanguage.toLowerCase() === effectiveOtherLanguage.toLowerCase();

  // Live refs to avoid stale closures in WebSocket / VAD / Audio callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const micLevelRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const isMutedRef = useRef(false);
  const autoSpeakRef = useRef(autoSpeak);
  const myLangRef = useRef(effectiveMyLanguage);
  const otherLangRef = useRef(effectiveOtherLanguage);
  const sameLangRef = useRef(sameLanguageReplyMode || isSameLanguage);
  const lastDetectedOtherRef = useRef(lastDetectedOtherLang);
  const turnModeRef = useRef<TurnMode>(turnMode);
  const entriesRef = useRef(entries);

  // Live transcript sealing ref so each speaker turn starts a clean card
  const sealNextLiveTurnRef = useRef(true);

  // Hands-free HTTPS VAD fallback refs
  const handsFreeActiveRef = useRef(false);
  const vadCtxRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const vadResumeTimerRef = useRef<number | null>(null);
  const vadRecorderRef = useRef<MediaRecorder | null>(null);
  const vadChunksRef = useRef<Blob[]>([]);
  const vadForceSendRef = useRef(false);

  // Unary TTS audio playback refs (for Replay, Typed Translate, and HTTPS fallback)
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeBlobUrlRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const playbackTokenRef = useRef(0);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  myLangRef.current = effectiveMyLanguage;
  otherLangRef.current = effectiveOtherLanguage;
  sameLangRef.current = sameLanguageReplyMode || isSameLanguage;
  lastDetectedOtherRef.current = lastDetectedOtherLang;
  turnModeRef.current = turnMode;
  entriesRef.current = entries;

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    autoSpeakRef.current = autoSpeak;
  }, [autoSpeak]);

  useEffect(() => {
    try {
      if (myLanguage !== "__custom__") {
        localStorage.setItem(STORAGE_MY_LANG, myLanguage);
      }
      if (otherLanguage !== "__custom__") {
        localStorage.setItem(STORAGE_OTHER_LANG, otherLanguage);
      }
    } catch {
      // ignore storage errors
    }
  }, [myLanguage, otherLanguage]);

  // Propagate mid-conversation language changes live over WebSocket with zero reconnect
  useEffect(() => {
    if (
      status === "connected" &&
      transport === "live-ws" &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      wsRef.current.send(
        JSON.stringify({
          type: "update_languages",
          myLanguage: effectiveMyLanguage,
          otherLanguage: effectiveOtherLanguage,
          sameLanguageReply: sameLanguageReplyMode || isSameLanguage,
        })
      );
    }
  }, [
    effectiveMyLanguage,
    effectiveOtherLanguage,
    isSameLanguage,
    sameLanguageReplyMode,
    status,
    transport,
  ]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length, isSendingTyped, handsFreePhase]);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  const revokeActiveBlob = useCallback(() => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
  }, []);

  const getAudioEl = useCallback((): HTMLAudioElement => {
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
    }
    return audioElRef.current;
  }, []);

  const stopUnaryPlayback = useCallback(() => {
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
    revokeActiveBlob();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setLoadingAudioId(null);
    setSpeakingEntryId(null);
  }, [revokeActiveBlob]);

  const startKeepAliveAudio = useCallback(
    (title: string) => {
      try {
        unlockBrowserSpeech();
        const el = getAudioEl();
        revokeActiveBlob();
        el.onended = null;
        el.onerror = null;
        el.loop = true;
        el.muted = false;
        el.volume = 1.0;
        el.src = getSilentKeepAliveWavUrl();
        void el.play().catch(() => {});
        updateJarvisMediaSession({
          title,
          artist: "Jogi Jarvis Human Interpreter",
          album: `${myLangRef.current} ↔ ${otherLangRef.current}`,
          playbackState: "playing",
          handlers: {
            onStop: () => stopUnaryPlayback(),
          },
        });
      } catch {
        // ignore
      }
    },
    [getAudioEl, revokeActiveBlob, stopUnaryPlayback]
  );

  const speakEntryAudio = useCallback(
    async (
      entryId: string,
      text: string,
      targetLanguage: string,
      preserveKeepAlive = false,
      onComplete?: () => void,
      inlineAudio?: { base64: string; mimeType?: string } | null
    ) => {
      let didFinish = false;
      const notifyComplete = () => {
        if (didFinish) return;
        didFinish = true;
        onComplete?.();
      };

      if (!preserveKeepAlive && (speakingEntryId === entryId || loadingAudioId === entryId)) {
        stopUnaryPlayback();
        notifyComplete();
        return;
      }

      if (preserveKeepAlive) {
        playbackTokenRef.current += 1;
        if (ttsAbortRef.current) {
          ttsAbortRef.current.abort();
          ttsAbortRef.current = null;
        }
      } else {
        stopUnaryPlayback();
        unlockBrowserSpeech();
      }

      const myToken = playbackTokenRef.current;
      const controller = new AbortController();
      ttsAbortRef.current = controller;
      let timedOut = false;
      const timeoutMs = preserveKeepAlive ? 3600 : 12000;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      setLoadingAudioId(entryId);
      setIsJarvisSpeaking(true);

      const bcp47 =
        WORLD_TRANSLATION_LANGUAGES.find(
          (l) => l.id.toLowerCase() === (targetLanguage || "").toLowerCase()
        )?.bcp47 || "en-IN";

      try {
        let audioBase64 = inlineAudio?.base64 || "";
        let audioMimeType = inlineAudio?.mimeType || "audio/wav";

        if (!audioBase64) {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              text,
              voiceName: profile.voiceName,
              role: profile.role,
              language: targetLanguage || myLangRef.current,
              conversational: true,
            }),
          });
          window.clearTimeout(timeoutId);
          const data = (await res.json()) as {
            audioBase64?: string;
            mimeType?: string;
            error?: string;
          };
          if (playbackTokenRef.current !== myToken) {
            notifyComplete();
            return;
          }
          if (!res.ok || !data.audioBase64) {
            throw new Error(data.error || "Could not generate voice audio.");
          }
          audioBase64 = data.audioBase64;
          audioMimeType = data.mimeType || "audio/wav";
        } else {
          window.clearTimeout(timeoutId);
        }

        const audio = getAudioEl();
        revokeActiveBlob();
        const blobUrl = base64ToAudioBlobUrl(audioBase64, audioMimeType);
        activeBlobUrlRef.current = blobUrl;

        await playAudioBlobReliably(audio, blobUrl);
        if (playbackTokenRef.current !== myToken) {
          audio.pause();
          notifyComplete();
          return;
        }

        setSpeakingEntryId(entryId);
        setLoadingAudioId(null);

        updateJarvisMediaSession({
          title: text.slice(0, 72),
          artist: `Jogi Jarvis (${targetLanguage || myLangRef.current})`,
          album: "Live Human Interpreter",
          playbackState: "playing",
          handlers: {
            onPlay: () => void audio.play().catch(() => {}),
            onPause: () => audio.pause(),
            onStop: () => stopUnaryPlayback(),
          },
        });

        audio.onended = () => {
          if (playbackTokenRef.current === myToken) {
            setSpeakingEntryId(null);
            setIsJarvisSpeaking(false);
            revokeActiveBlob();
            notifyComplete();
          }
        };
        audio.onerror = () => {
          if (playbackTokenRef.current === myToken) {
            setSpeakingEntryId(null);
            setIsJarvisSpeaking(false);
            revokeActiveBlob();
            notifyComplete();
          }
        };
      } catch {
        window.clearTimeout(timeoutId);
        if (playbackTokenRef.current !== myToken) {
          notifyComplete();
          return;
        }
        if (controller.signal.aborted && !timedOut) {
          setIsJarvisSpeaking(false);
          notifyComplete();
          return;
        }

        if (audioElRef.current) {
          audioElRef.current.onended = null;
          audioElRef.current.onerror = null;
          audioElRef.current.loop = false;
          audioElRef.current.pause();
        }

        const fellBack = speakWithChunkedBrowserTts({
          text,
          bcp47,
          isStillCurrent: () => playbackTokenRef.current === myToken,
          onStart: () => {
            setSpeakingEntryId(entryId);
            setLoadingAudioId(null);
            setIsJarvisSpeaking(true);
          },
          onEnd: () => {
            setSpeakingEntryId(null);
            setIsJarvisSpeaking(false);
            notifyComplete();
          },
          onError: () => {
            setSpeakingEntryId(null);
            setIsJarvisSpeaking(false);
            notifyComplete();
          },
        });

        if (!fellBack) {
          setSpeakingEntryId(null);
          setIsJarvisSpeaking(false);
          notifyComplete();
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (playbackTokenRef.current === myToken) {
          setLoadingAudioId(null);
        }
      }
    },
    [
      getAudioEl,
      loadingAudioId,
      profile.role,
      profile.voiceName,
      revokeActiveBlob,
      speakingEntryId,
      stopUnaryPlayback,
    ]
  );

  const appendLiveTranscript = useCallback(
    (speaker: "heard" | "interpreter", chunkText: string, forceNew = false) => {
      if (!chunkText) return;
      const nowTime = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      setEntries((prev) => {
        const last = prev[prev.length - 1];
        if (!forceNew && !sealNextLiveTurnRef.current && last && last.speaker === speaker) {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            text: last.text + chunkText,
          };
          return updated;
        }
        sealNextLiveTurnRef.current = false;
        return [
          ...prev,
          {
            id: `live-${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            speaker,
            text: chunkText.trimStart(),
            metaLabel:
              speaker === "heard"
                ? "Live Speech Heard"
                : "Jarvis Human Interpreter",
            targetLanguage: myLangRef.current,
            timestamp: nowTime,
          },
        ];
      });
    },
    []
  );

  const cleanupHandsFreeVad = useCallback(() => {
    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (vadResumeTimerRef.current !== null) {
      window.clearTimeout(vadResumeTimerRef.current);
      vadResumeTimerRef.current = null;
    }
    if (vadRecorderRef.current && vadRecorderRef.current.state !== "inactive") {
      try {
        vadRecorderRef.current.onstop = null;
        vadRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    vadRecorderRef.current = null;
    if (vadCtxRef.current) {
      void vadCtxRef.current.close().catch(() => {});
      vadCtxRef.current = null;
    }
  }, []);

  const stopSession = useCallback(() => {
    handsFreeActiveRef.current = false;
    cleanupHandsFreeVad();
    stopUnaryPlayback();

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      void inputAudioCtxRef.current.close().catch(() => {});
      inputAudioCtxRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (playerRef.current) {
      void playerRef.current.close();
      playerRef.current = null;
    }
    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "stop" }));
        }
        ws.close();
      } catch {
        // ignore
      }
    }

    updateJarvisMediaSession({
      title: "Jogi Jarvis Human Interpreter",
      playbackState: "none",
    });
    releaseWakeLock();

    micLevelRef.current = 0;
    setAudioLevel(0);
    setIsJarvisSpeaking(false);
    setHandsFreePhase("idle");
    setStatus("idle");
  }, [cleanupHandsFreeVad, releaseWakeLock, stopUnaryPlayback]);

  // Automatic Turbo Hands-Free HTTPS VAD Loop (fast endpointing + single-shot audio translate + inline voice)
  const startHandsFreeVadClip = useCallback(() => {
    if (!handsFreeActiveRef.current) return;
    const stream = mediaStreamRef.current;
    if (!stream) return;

    if (vadIntervalRef.current !== null) {
      window.clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      setErrorMsg("Could not start automatic voice capture in this browser.");
      stopSession();
      return;
    }

    vadRecorderRef.current = recorder;
    vadChunksRef.current = [];
    vadForceSendRef.current = false;

    let voiceFrames = 0;
    let heardSpeech = false;
    let lastSpeechAt = Date.now();
    const clipStartedAt = Date.now();
    let silentRecycle = false;

    setHandsFreePhase("listening");

    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) {
        vadChunksRef.current.push(ev.data);
      }
    };

    const scheduleNextClip = (delayMs: number) => {
      if (!handsFreeActiveRef.current) return;
      if (vadResumeTimerRef.current !== null) {
        window.clearTimeout(vadResumeTimerRef.current);
      }
      vadResumeTimerRef.current = window.setTimeout(() => {
        vadResumeTimerRef.current = null;
        if (handsFreeActiveRef.current) {
          startHandsFreeVadClip();
        }
      }, delayMs);
    };

    recorder.onstop = async () => {
      if (vadIntervalRef.current !== null) {
        window.clearInterval(vadIntervalRef.current);
        vadIntervalRef.current = null;
      }
      if (!handsFreeActiveRef.current) return;

      if (silentRecycle || (!heardSpeech && !vadForceSendRef.current)) {
        scheduleNextClip(80);
        return;
      }

      const blob = new Blob(vadChunksRef.current, { type: mimeType });
      if (blob.size < 400) {
        scheduleNextClip(120);
        return;
      }

      setHandsFreePhase("interpreting");
      if (autoSpeakRef.current) {
        startKeepAliveAudio("Jogi Jarvis is translating…");
      }

      try {
        const audioBase64 = await blobToBase64(blob);
        const recent = entriesRef.current.slice(-4);
        const recentContext: Array<{
          originalText: string;
          translatedText: string;
        }> = [];
        for (let i = 0; i < recent.length; i += 1) {
          const e = recent[i];
          if (e.speaker === "interpreter") {
            recentContext.push({
              originalText: e.secondaryText || "",
              translatedText: e.text,
            });
          }
        }

        const activeDirection =
          turnModeRef.current === "them"
            ? "them_to_me"
            : turnModeRef.current === "me"
              ? "me_to_them"
              : "auto_conversation";

        const res = await fetch("/api/translate/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64,
            audioMimeType: mimeType.split(";")[0],
            myLanguage: myLangRef.current,
            otherLanguage: otherLangRef.current,
            lastOtherLanguage: lastDetectedOtherRef.current,
            direction: activeDirection,
            sameLanguageAnswer: sameLangRef.current,
            recentContext,
            fastMode: true,
            includeAudio: autoSpeakRef.current,
            voiceName: profile.voiceName,
          }),
        });
        const data = (await res.json()) as {
          empty?: boolean;
          originalText?: string;
          detectedLanguage?: string;
          targetLanguage?: string;
          translatedText?: string;
          pronunciation?: string;
          speakerSide?: "me" | "them";
          suggestedReplies?: string[];
          audioBase64?: string;
          audioMimeType?: string;
          error?: string;
        };

        if (!handsFreeActiveRef.current) return;

        if (!res.ok) {
          throw new Error(data.error || "Could not interpret right now.");
        }

        if (data.empty || !data.translatedText) {
          stopUnaryPlayback();
          scheduleNextClip(140);
          return;
        }

        const resolvedSide: "me" | "them" =
          data.speakerSide ||
          (activeDirection === "me_to_them" ? "me" : "them");

        // Lock the other person's language immediately so replies go back in their exact language
        if (
          resolvedSide === "them" &&
          data.detectedLanguage &&
          data.detectedLanguage.toLowerCase() !== "auto-detect" &&
          data.detectedLanguage.toLowerCase() !== myLangRef.current.toLowerCase()
        ) {
          lastDetectedOtherRef.current = data.detectedLanguage;
          setLastDetectedOtherLang(data.detectedLanguage);
        } else if (
          resolvedSide === "me" &&
          !lastDetectedOtherRef.current &&
          data.targetLanguage &&
          data.targetLanguage.toLowerCase() !== myLangRef.current.toLowerCase()
        ) {
          lastDetectedOtherRef.current = data.targetLanguage;
          setLastDetectedOtherLang(data.targetLanguage);
        }

        const detLang = data.detectedLanguage || (resolvedSide === "me" ? myLangRef.current : "Detected");
        const tgtLang = data.targetLanguage || myLangRef.current;
        const metaLabel =
          resolvedSide === "them"
            ? `Other Person (${detLang}) → Explained to You (${tgtLang})`
            : `You (${detLang}) → Spoken to Them (${tgtLang})`;

        const nowTime = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const newEntry: InterpreterEntry = {
          id: `tr-${Date.now()}`,
          speaker: "interpreter",
          speakerSide: resolvedSide,
          text: data.translatedText,
          secondaryText: data.originalText,
          pronunciation: data.pronunciation || "",
          metaLabel,
          targetLanguage: tgtLang,
          suggestedReplies: Array.isArray(data.suggestedReplies)
            ? data.suggestedReplies
            : [],
          timestamp: nowTime,
        };
        setEntries((prev) => [...prev, newEntry]);

        const nowMs = Date.now();
        if (nowMs - lastStudyAwardAtRef.current >= 30_000) {
          lastStudyAwardAtRef.current = nowMs;
          onStudySessionComplete?.(profile.id, "Live translation conversation");
        }

        if (autoSpeakRef.current && newEntry.text) {
          setHandsFreePhase("speaking");
          const inlineAudio = data.audioBase64
            ? { base64: data.audioBase64, mimeType: data.audioMimeType || "audio/wav" }
            : null;
          void speakEntryAudio(
            newEntry.id,
            newEntry.text,
            newEntry.targetLanguage || myLangRef.current,
            true,
            () => {
              if (handsFreeActiveRef.current) {
                scheduleNextClip(140);
              }
            },
            inlineAudio
          );
        } else {
          stopUnaryPlayback();
          scheduleNextClip(160);
        }
      } catch (err) {
        stopUnaryPlayback();
        setErrorMsg(
          err instanceof Error
            ? err.message
            : "Live interpretation paused briefly."
        );
        scheduleNextClip(650);
      }
    };

    try {
      recorder.start();
    } catch {
      scheduleNextClip(350);
      return;
    }

    // Fast 50ms RMS speech detector with 620ms silence endpointing for crisp face-to-face speed
    try {
      if (!vadCtxRef.current || vadCtxRef.current.state === "closed") {
        vadCtxRef.current = new AudioContext();
      }
      if (vadCtxRef.current.state === "suspended") {
        void vadCtxRef.current.resume();
      }
      const source = vadCtxRef.current.createMediaStreamSource(stream);
      const analyser = vadCtxRef.current.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);

      vadIntervalRef.current = window.setInterval(() => {
        if (
          !handsFreeActiveRef.current ||
          !vadRecorderRef.current ||
          vadRecorderRef.current.state !== "recording"
        ) {
          return;
        }
        if (isMutedRef.current) {
          setAudioLevel(0);
          return;
        }
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) {
          sum += buf[i] * buf[i];
        }
        const rms = Math.sqrt(sum / buf.length);
        setAudioLevel((prev) => prev * 0.55 + Math.min(1, rms * 6.0) * 0.45);

        const now = Date.now();
        if (rms > 0.014) {
          voiceFrames += 1;
          lastSpeechAt = now;
          if (voiceFrames >= 2 && !heardSpeech) {
            heardSpeech = true;
            setHandsFreePhase("hearing");
          }
        }

        if (
          (heardSpeech && now - lastSpeechAt >= 620) ||
          (heardSpeech && now - clipStartedAt >= 15000)
        ) {
          if (vadRecorderRef.current.state === "recording") {
            vadRecorderRef.current.stop();
          }
          return;
        }

        // Recycle quiet buffer every 9s so memory stays tiny
        if (!heardSpeech && now - clipStartedAt >= 9000) {
          silentRecycle = true;
          if (vadRecorderRef.current.state === "recording") {
            vadRecorderRef.current.stop();
          }
        }
      }, 50);
    } catch {
      // Fallback: 5-second auto turn if AudioContext fails
      vadIntervalRef.current = window.setInterval(() => {
        if (vadRecorderRef.current?.state === "recording") {
          vadForceSendRef.current = true;
          vadRecorderRef.current.stop();
        }
      }, 5000);
    }
  }, [
    onStudySessionComplete,
    profile.id,
    profile.voiceName,
    speakEntryAudio,
    startKeepAliveAudio,
    stopSession,
    stopUnaryPlayback,
  ]);

  // Seamlessly switch to Turbo Hands-Free VAD without closing the microphone
  const activateHandsFreeFallback = useCallback(
    (notice?: string) => {
      if (!mediaStreamRef.current) {
        stopSession();
        return;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (processorRef.current) {
        processorRef.current.disconnect();
        processorRef.current.onaudioprocess = null;
        processorRef.current = null;
      }
      if (inputAudioCtxRef.current) {
        void inputAudioCtxRef.current.close().catch(() => {});
        inputAudioCtxRef.current = null;
      }
      if (playerRef.current) {
        void playerRef.current.close();
        playerRef.current = null;
      }
      if (wsRef.current) {
        const oldWs = wsRef.current;
        wsRef.current = null;
        try {
          oldWs.close();
        } catch {
          // ignore
        }
      }

      setErrorMsg(null);
      setTransport("handsfree-https");
      setStatus("connected");
      handsFreeActiveRef.current = true;
      setInfoMsg(
        notice ||
          "Fast Hands-Free Interpreter active — listens to the other person, explains to you immediately, and translates your reply back in their exact language."
      );
      if (timerRef.current === null) {
        timerRef.current = window.setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
      }
      startHandsFreeVadClip();
    },
    [startHandsFreeVadClip, stopSession]
  );

  // Start Real-Time Gemini Live Human Interpreter (with instant Turbo Hands-Free VAD auto-fallback)
  const startLiveInterpreter = useCallback(async () => {
    stopSession();
    setErrorMsg(null);
    setInfoMsg(null);
    setStatus("connecting");
    setElapsedSeconds(0);
    sealNextLiveTurnRef.current = true;

    // Unlock audio & speech immediately inside user click gesture
    unlockBrowserSpeech();
    const player = new LiveAudioPlayer((speaking) => {
      setIsJarvisSpeaking(speaking);
    });
    player.unlock();
    playerRef.current = player;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      void requestAudioWakeLock().then((lock) => {
        if (lock) wakeLockRef.current = lock;
      });

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live`;

      const openLiveWs = (): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(wsUrl);
          let settled = false;
          const timeoutId = window.setTimeout(() => {
            if (!settled) {
              settled = true;
              try {
                socket.close();
              } catch {
                // ignore
              }
              reject(new Error("WS connect timeout"));
            }
          }, 3500);

          socket.onopen = () => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeoutId);
              resolve(socket);
            }
          };
          socket.onerror = () => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeoutId);
              reject(new Error("WS connect error"));
            }
          };
        });

      let ws: WebSocket | null = null;
      try {
        ws = await openLiveWs();
      } catch {
        ws = null;
      }

      // If WebSockets are unavailable, seamlessly activate Turbo Hands-Free VAD (zero clicks!)
      if (!ws) {
        activateHandsFreeFallback();
        return;
      }

      setTransport("live-ws");
      wsRef.current = ws;

      ws.send(
        JSON.stringify({
          type: "start",
          mode: "interpreter",
          profile,
          voiceName: profile.voiceName,
          myLanguage: myLangRef.current,
          otherLanguage:
            otherLangRef.current === "Auto-Detect" && lastDetectedOtherRef.current
              ? lastDetectedOtherRef.current
              : otherLangRef.current,
          sameLanguageReply: sameLangRef.current,
        })
      );

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as {
            type?: string;
            audio?: string;
            text?: string;
            message?: string;
          };

          if (msg.type === "ready") {
            setStatus("connected");
            if (turnModeRef.current !== "auto" && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(
                JSON.stringify({
                  type: "speaker_hint",
                  side: turnModeRef.current,
                  myLanguage: myLangRef.current,
                  partnerLanguage:
                    otherLangRef.current === "Auto-Detect"
                      ? lastDetectedOtherRef.current || ""
                      : otherLangRef.current,
                })
              );
            }
            updateJarvisMediaSession({
              title: "Live Human Interpreter Active",
              artist: "Jogi Jarvis",
              album: `${myLangRef.current} ↔ ${otherLangRef.current}`,
              playbackState: "playing",
              handlers: {
                onStop: () => stopSession(),
              },
            });

            const inputCtx = new AudioContext({ sampleRate: 16000 });
            inputAudioCtxRef.current = inputCtx;
            const source = inputCtx.createMediaStreamSource(stream);
            // 2048 samples @ 16kHz = 128ms chunks (2x faster streaming response)
            const processor = inputCtx.createScriptProcessor(2048, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                return;
              }
              const channel = e.inputBuffer.getChannelData(0);
              if (isMutedRef.current) {
                micLevelRef.current = 0;
                return;
              }
              let sum = 0;
              for (let i = 0; i < channel.length; i += 1) {
                sum += channel[i] * channel[i];
              }
              micLevelRef.current = Math.min(
                1,
                Math.sqrt(sum / channel.length) * 4.5
              );

              const base64Audio = float32ToPcm16Base64(channel);
              wsRef.current.send(
                JSON.stringify({ type: "audio", audio: base64Audio })
              );
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);

            timerRef.current = window.setInterval(() => {
              setElapsedSeconds((s) => s + 1);
            }, 1000);

            const updateMeter = () => {
              const outLvl = playerRef.current?.getOutputLevel() || 0;
              const combined = Math.max(micLevelRef.current, outLvl);
              setAudioLevel((prev) => prev * 0.7 + combined * 0.3);
              rafRef.current = requestAnimationFrame(updateMeter);
            };
            rafRef.current = requestAnimationFrame(updateMeter);
            return;
          }

          if (msg.type === "audio" && msg.audio) {
            if (autoSpeakRef.current) {
              playerRef.current?.enqueuePcmBase64(msg.audio);
            }
            return;
          }

          if (msg.type === "interrupted") {
            playerRef.current?.interrupt();
            sealNextLiveTurnRef.current = true;
            return;
          }

          if (msg.type === "inputTranscript" && msg.text) {
            appendLiveTranscript("heard", msg.text);
            return;
          }

          if (msg.type === "outputTranscript" && msg.text) {
            appendLiveTranscript("interpreter", msg.text);
            return;
          }

          if (msg.type === "turnComplete") {
            sealNextLiveTurnRef.current = true;
            return;
          }

          if (msg.type === "error") {
            // Automatically fall back to Turbo Hands-Free VAD instead of stopping the conversation!
            if (wsRef.current === ws) {
              activateHandsFreeFallback(
                "Switched automatically to Fast Hands-Free Interpreter — keep speaking naturally without interruption."
              );
            }
            return;
          }

          if (msg.type === "closed") {
            stopSession();
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onerror = () => {
        if (wsRef.current === ws) {
          activateHandsFreeFallback(
            "Switched automatically to Fast Hands-Free Interpreter — keep speaking naturally."
          );
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stopSession();
        }
      };
    } catch {
      setErrorMsg(
        "Microphone permission is required for the Live Human Interpreter. Please allow microphone access in your browser."
      );
      stopSession();
      setStatus("error");
    }
  }, [activateHandsFreeFallback, appendLiveTranscript, profile, stopSession]);

  // Instant speaker-turn switch with zero-wait barge-in
  const handleSelectTurnMode = useCallback(
    (nextMode: TurnMode) => {
      turnModeRef.current = nextMode;
      setTurnMode(nextMode);
      setErrorMsg(null);

      // Interrupt any current speech immediately so the new speaker never waits
      playerRef.current?.interrupt();
      stopUnaryPlayback();
      setIsJarvisSpeaking(false);

      if (status === "idle" || status === "error") {
        void startLiveInterpreter();
        return;
      }

      if (
        status === "connected" &&
        transport === "live-ws" &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        wsRef.current.send(
          JSON.stringify({
            type: "speaker_hint",
            side: nextMode,
            myLanguage: myLangRef.current,
            partnerLanguage:
              otherLangRef.current === "Auto-Detect"
                ? lastDetectedOtherRef.current || ""
                : otherLangRef.current,
          })
        );
        return;
      }

      if (status === "connected" && transport === "handsfree-https") {
        if (
          vadRecorderRef.current &&
          vadRecorderRef.current.state === "recording" &&
          handsFreePhase === "hearing"
        ) {
          vadForceSendRef.current = true;
          vadRecorderRef.current.stop();
        } else if (handsFreeActiveRef.current && handsFreePhase !== "interpreting") {
          cleanupHandsFreeVad();
          startHandsFreeVadClip();
        }
      }
    },
    [
      cleanupHandsFreeVad,
      handsFreePhase,
      startHandsFreeVadClip,
      startLiveInterpreter,
      status,
      stopUnaryPlayback,
      transport,
    ]
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession]);

  const handleSwapLanguages = () => {
    if (otherLanguage === "Auto-Detect") {
      const partner =
        lastDetectedOtherLang &&
        lastDetectedOtherLang.toLowerCase() !== effectiveMyLanguage.toLowerCase()
          ? lastDetectedOtherLang
          : effectiveMyLanguage === "Hindi"
            ? "English"
            : "Hindi";
      setOtherLanguage(myLanguage);
      setCustomOtherLanguage(customMyLanguage);
      setMyLanguage(
        WORLD_TRANSLATION_LANGUAGES.some((l) => l.id === partner)
          ? partner
          : "__custom__"
      );
      if (!WORLD_TRANSLATION_LANGUAGES.some((l) => l.id === partner)) {
        setCustomMyLanguage(partner);
      }
      return;
    }
    const prevMy = myLanguage;
    const prevCustomMy = customMyLanguage;
    setMyLanguage(otherLanguage);
    setCustomMyLanguage(customOtherLanguage);
    setOtherLanguage(prevMy);
    setCustomOtherLanguage(prevCustomMy);
  };

  const handleSendTyped = async (customText?: string) => {
    const clean = (customText ?? typedText).trim();
    if (!clean || isSendingTyped) return;
    if (!customText) setTypedText("");
    setErrorMsg(null);

    // If Live WebSocket Interpreter is active, send text directly into the live session so Jarvis speaks it right away!
    if (
      status === "connected" &&
      transport === "live-ws" &&
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN
    ) {
      wsRef.current.send(JSON.stringify({ type: "text", text: clean }));
      sealNextLiveTurnRef.current = true;
      appendLiveTranscript("heard", clean, true);
      sealNextLiveTurnRef.current = true;
      return;
    }

    // Otherwise run instant HTTPS human interpretation + speak aloud
    setIsSendingTyped(true);
    if (autoSpeakRef.current) {
      startKeepAliveAudio("Jogi Jarvis is translating…");
    }

    try {
      const isOfflineNow =
        typeof navigator !== "undefined" && !navigator.onLine;
      const preferLocal = isOfflineNow || isLocalBrowserEnginePreferred();
      const targetLang =
        isOtherAuto && lastDetectedOtherLang
          ? lastDetectedOtherLang
          : isOtherAuto
            ? effectiveMyLanguage
            : effectiveOtherLanguage;

      let translatedText = "";
      let originalText = clean;
      let detectedLanguage = effectiveMyLanguage;
      let resolvedTargetLanguage = targetLang;
      let pronunciation = "";
      let suggestedReplies: string[] = [];
      let inlineAudio: { base64: string; mimeType?: string } | null = null;

      if (!preferLocal) {
        try {
          const res = await fetch("/api/translate/conversation", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: clean,
              myLanguage: effectiveMyLanguage,
              otherLanguage: effectiveOtherLanguage,
              lastOtherLanguage: lastDetectedOtherLang,
              direction: "me_to_them",
              sameLanguageAnswer: sameLanguageReplyMode || isSameLanguage,
              fastMode: true,
              includeAudio: autoSpeakRef.current,
              voiceName: profile.voiceName,
            }),
          });
          const data = (await res.json()) as {
            originalText?: string;
            detectedLanguage?: string;
            targetLanguage?: string;
            translatedText?: string;
            pronunciation?: string;
            suggestedReplies?: string[];
            audioBase64?: string;
            audioMimeType?: string;
            error?: string;
          };
          if (res.ok && data.translatedText) {
            translatedText = data.translatedText;
            originalText = data.originalText || clean;
            detectedLanguage = data.detectedLanguage || effectiveMyLanguage;
            resolvedTargetLanguage = data.targetLanguage || targetLang;
            pronunciation = data.pronunciation || "";
            suggestedReplies = Array.isArray(data.suggestedReplies)
              ? data.suggestedReplies
              : [];
            if (data.audioBase64) {
              inlineAudio = {
                base64: data.audioBase64,
                mimeType: data.audioMimeType || "audio/wav",
              };
            }
          }
        } catch {
          // Fall through to on-device Local LLM translation
        }
      }

      if (!translatedText) {
        const localKey = getReadyLocalModelKey();
        if (localKey) {
          const localOut = await generateLocalLlmPrompt({
            modelKey: localKey,
            systemPrompt: `You are an expert translator. Translate the user's text naturally into ${targetLang}. Return ONLY the translated sentence(s) without extra commentary.`,
            userPrompt: clean,
            maxTokens: 320,
            temperature: 0.2,
          });
          if (localOut.trim()) {
            translatedText = localOut.trim();
            detectedLanguage = "On-Device Local AI";
            resolvedTargetLanguage = targetLang;
          }
        }
      }

      if (!translatedText) {
        throw new Error(
          isOfflineNow
            ? "Offline translation needs a downloaded Local AI model. Download Llama 3.2 1B or Qwen 2.5 1.5B in Assistant Desk once while online to translate 100% offline."
            : "Could not interpret right now."
        );
      }

      const nowTime = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const entry: InterpreterEntry = {
        id: `typed-${Date.now()}`,
        speaker: "interpreter",
        speakerSide: "me",
        text: translatedText,
        secondaryText: originalText,
        pronunciation,
        metaLabel: `You (${detectedLanguage}) → Spoken to Them (${resolvedTargetLanguage})`,
        targetLanguage: resolvedTargetLanguage,
        suggestedReplies,
        timestamp: nowTime,
      };
      setEntries((prev) => [...prev, entry]);
      const nowMs = Date.now();
      if (nowMs - lastStudyAwardAtRef.current >= 30_000) {
        lastStudyAwardAtRef.current = nowMs;
        onStudySessionComplete?.(profile.id, "Language practice session");
      }

      if (autoSpeakRef.current) {
        void speakEntryAudio(
          entry.id,
          entry.text,
          entry.targetLanguage || effectiveOtherLanguage,
          true,
          undefined,
          inlineAudio
        );
      } else {
        stopUnaryPlayback();
      }
    } catch (err) {
      stopUnaryPlayback();
      setErrorMsg(
        err instanceof Error ? err.message : "Could not translate right now."
      );
    } finally {
      setIsSendingTyped(false);
    }
  };

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 1800);
  };

  const formatTimer = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

  const ringScaleOuter = 1 + audioLevel * 0.25;
  const ringScaleMid = 1 + audioLevel * 0.14;

  const activePartnerLabel = isOtherAuto
    ? lastDetectedOtherLang || "Their Language"
    : effectiveOtherLanguage;

  const liveStatusText =
    status === "connecting"
      ? "Connecting Fast Live Interpreter…"
      : status === "connected"
        ? transport === "handsfree-https"
          ? handsFreePhase === "hearing"
            ? turnMode === "me"
              ? `Hearing you — translating to ${activePartnerLabel}…`
              : turnMode === "them"
                ? `Hearing them — explaining to you in ${effectiveMyLanguage}…`
                : "Hearing speech — translating on pause…"
            : handsFreePhase === "interpreting"
              ? turnMode === "me"
                ? `Translating your reply into ${activePartnerLabel}…`
                : `Explaining fast into ${effectiveMyLanguage}…`
              : handsFreePhase === "speaking"
                ? "Jarvis Interpreter is speaking…"
                : isMuted
                  ? "Microphone muted"
                  : turnMode === "them"
                    ? `Fast Listening to Them → Explain in ${effectiveMyLanguage}`
                    : turnMode === "me"
                      ? `Fast Listening to You → Speak in ${activePartnerLabel}`
                      : `Fast Auto Two-Way (${activePartnerLabel} ↔ ${effectiveMyLanguage})`
          : isJarvisSpeaking
            ? "Jarvis Interpreter is speaking…"
            : isMuted
              ? "Microphone muted"
              : turnMode === "them"
                ? `Live Listening to Them → Explain in ${effectiveMyLanguage}`
                : turnMode === "me"
                  ? `Live Listening to You → Speak in ${activePartnerLabel}`
                  : `Live Fast Two-Way (${activePartnerLabel} ↔ ${effectiveMyLanguage})`
        : "Ready for instant face-to-face live translation";

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-5xl mx-auto w-full bg-[#F8FAFC]">
      {/* Top Language & Mode Control Header */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-4 space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-lg sm:text-xl font-bold text-slate-950 tracking-tight">
              Live Human Interpreter
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              Real-time to-and-fro voice translator — listens in any language, explains fast to you, and speaks your answer back in their language.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StudyMediaQuickButtons
              compact
              onOpen={(targetMode) => {
                const latestEntry = entries[entries.length - 1];
                const raw = (
                  typedText.trim() ||
                  latestEntry?.secondaryText ||
                  latestEntry?.text ||
                  ""
                )
                  .trim()
                  .slice(0, 140);
                setMediaStudio({
                  isOpen: true,
                  mode: targetMode,
                  prompt: raw,
                  autoRun: Boolean(raw),
                });
              }}
            />

            {status === "connected" && (
              <span className="text-xs font-mono tabular-nums font-semibold text-blue-800 bg-blue-50 border border-blue-200 px-2.5 py-2 rounded-lg min-h-[40px] inline-flex items-center">
                {formatTimer(elapsedSeconds)}
              </span>
            )}

            <button
              type="button"
              onClick={() => {
                const next = !autoSpeak;
                setAutoSpeak(next);
                if (!next) {
                  stopUnaryPlayback();
                  playerRef.current?.interrupt();
                } else {
                  unlockBrowserSpeech();
                }
              }}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors min-h-[40px] whitespace-nowrap shrink-0 ${
                autoSpeak
                  ? "bg-blue-50 border-blue-200 text-blue-800"
                  : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
              }`}
            >
              {autoSpeak ? (
                <Volume2 className="h-4 w-4" />
              ) : (
                <VolumeX className="h-4 w-4" />
              )}
              <span>{autoSpeak ? "Auto-Speak On" : "Auto-Speak Off"}</span>
            </button>

            {entries.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  stopUnaryPlayback();
                  setEntries([]);
                }}
                title="Clear transcript"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 transition-colors min-h-[40px] whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Clear</span>
              </button>
            )}
          </div>
        </div>

        {/* My Language <-> Speaker's Language Picker Row */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-end gap-2.5">
          <div>
            <label
              htmlFor="translate-from-lang"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              My Language (Explain To Me In)
            </label>
            <select
              id="translate-from-lang"
              value={myLanguage}
              onChange={(e) => setMyLanguage(e.target.value)}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              {WORLD_TRANSLATION_LANGUAGES.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.label} — {lang.region}
                </option>
              ))}
              <option value="__custom__">Other Language (Type Any)...</option>
            </select>
            {myLanguage === "__custom__" && (
              <input
                type="text"
                value={customMyLanguage}
                onChange={(e) => setCustomMyLanguage(e.target.value)}
                placeholder="Type any language (e.g. Sambalpuri, Bhojpuri, Zulu)"
                className="mt-1.5 w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            )}
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={handleSwapLanguages}
              aria-label="Swap My Language and Speaker Language"
              title="Swap languages"
              className="inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-3 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 hover:text-blue-700 transition-colors"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
          </div>

          <div>
            <label
              htmlFor="translate-to-lang"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              Speaker&apos;s Language (Answer Them In)
            </label>
            <select
              id="translate-to-lang"
              value={otherLanguage}
              onChange={(e) => setOtherLanguage(e.target.value)}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
              <option value="Auto-Detect">
                Auto-Detect — Any World Language (Recommended)
              </option>
              {WORLD_TRANSLATION_LANGUAGES.map((lang) => (
                <option key={lang.id} value={lang.id}>
                  {lang.label} — {lang.region}
                </option>
              ))}
              <option value="__custom__">Other Language (Type Any)...</option>
            </select>
            {otherLanguage === "__custom__" && (
              <input
                type="text"
                value={customOtherLanguage}
                onChange={(e) => setCustomOtherLanguage(e.target.value)}
                placeholder="Type any language (e.g. Irish, Kazakh, Khmer)"
                className="mt-1.5 w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            )}
          </div>
        </div>

        {/* Same-Language Toggle & Locked Partner Language Info */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>
              {isSameLanguage || sameLanguageReplyMode
                ? `Same-Language Mode: Jarvis listens and replies directly in ${effectiveMyLanguage}.`
                : isOtherAuto
                  ? lastDetectedOtherLang
                    ? `Auto-Detect locked to their language:`
                    : `Auto-Detect active · Listens fast to any language, explains in ${effectiveMyLanguage}, and speaks your reply back in their exact language.`
                  : `Two-Way active · ${effectiveMyLanguage} ↔ ${effectiveOtherLanguage}`}
            </span>

            {isOtherAuto && lastDetectedOtherLang && !sameLanguageReplyMode && (
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-teal-50 border border-teal-200 text-teal-800 font-semibold">
                <span>{lastDetectedOtherLang}</span>
                <button
                  type="button"
                  onClick={() => {
                    lastDetectedOtherRef.current = "";
                    setLastDetectedOtherLang("");
                  }}
                  title="Reset detected speaker language"
                  aria-label="Reset detected speaker language"
                  className="hover:text-teal-950"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>

          {!isSameLanguage && (
            <button
              type="button"
              onClick={() => setSameLanguageReplyMode((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors min-h-[36px] whitespace-nowrap ${
                sameLanguageReplyMode
                  ? "bg-teal-50 border-teal-200 text-teal-800"
                  : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
              }`}
            >
              <MessageCircle className="h-3.5 w-3.5 shrink-0" />
              <span>
                {sameLanguageReplyMode
                  ? `Same-Language Reply (${effectiveMyLanguage}) On`
                  : `Answer in Same Language (${effectiveMyLanguage})`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Live Interpreter Feed & Presence Stage */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
        {infoMsg && (
          <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs sm:text-sm text-blue-900 flex items-start justify-between gap-3">
            <span>{infoMsg}</span>
            <button
              type="button"
              onClick={() => setInfoMsg(null)}
              aria-label="Dismiss info"
              className="text-blue-700 hover:text-blue-900 shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-sm text-red-800 flex items-start justify-between gap-3">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              aria-label="Dismiss error"
              className="text-red-700 hover:text-red-900 shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Active Live Interpreter Acoustic Header (stays cleanly visible when live) */}
        {(status === "connected" || status === "connecting") && (
          <div className="bg-white border border-blue-200 rounded-2xl p-4 sm:p-5 space-y-3.5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="relative h-14 w-14 flex items-center justify-center shrink-0">
                  <div
                    style={{
                      transform: `scale(${status === "connected" ? ringScaleOuter : 1})`,
                      opacity: status === "connected" ? 0.22 + audioLevel * 0.45 : 0.12,
                    }}
                    className={`absolute inset-0 rounded-full transition-transform duration-100 motion-reduce:transition-none ${
                      turnMode === "them" ? "bg-teal-600" : "bg-blue-600"
                    }`}
                  />
                  <div
                    style={{
                      transform: `scale(${status === "connected" ? ringScaleMid : 1})`,
                      opacity: status === "connected" ? 0.35 + audioLevel * 0.4 : 0.2,
                    }}
                    className={`absolute inset-1.5 rounded-full transition-transform duration-100 motion-reduce:transition-none ${
                      turnMode === "them" ? "bg-teal-700" : "bg-blue-700"
                    }`}
                  />
                  <div
                    className={`relative h-10 w-10 rounded-full flex items-center justify-center ${
                      isJarvisSpeaking
                        ? "bg-blue-700 text-white"
                        : isMuted
                          ? "bg-slate-200 text-slate-600"
                          : turnMode === "them"
                            ? "bg-teal-700 text-white"
                            : "bg-slate-900 text-white"
                    }`}
                  >
                    {status === "connecting" || handsFreePhase === "interpreting" ? (
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    ) : isJarvisSpeaking ? (
                      <Volume2 className="h-5 w-5" />
                    ) : isMuted ? (
                      <MicOff className="h-5 w-5" />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </div>
                </div>

                <div className="min-w-0">
                  <p className="text-sm sm:text-base font-semibold text-slate-950 truncate">
                    {liveStatusText}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Listens to the other person, explains fast to you in {effectiveMyLanguage}, and speaks your reply back in{" "}
                    <strong className="text-slate-700">{activePartnerLabel}</strong>.
                  </p>
                </div>
              </div>

              {transport === "handsfree-https" && handsFreePhase === "hearing" && (
                <button
                  type="button"
                  onClick={() => {
                    vadForceSendRef.current = true;
                    if (vadRecorderRef.current?.state === "recording") {
                      vadRecorderRef.current.stop();
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold min-h-[40px] whitespace-nowrap shrink-0"
                >
                  <Send className="h-3.5 w-3.5" />
                  <span>Translate Now</span>
                </button>
              )}
            </div>

            {/* Instant Face-to-Face Turn Controls (zero-wait barge-in) */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => handleSelectTurnMode("auto")}
                className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors min-h-[42px] text-center ${
                  turnMode === "auto"
                    ? "bg-slate-900 border-slate-900 text-white"
                    : "bg-slate-50 hover:bg-slate-100 border-slate-200 text-slate-700"
                }`}
              >
                Auto Two-Way
              </button>
              <button
                type="button"
                onClick={() => handleSelectTurnMode("them")}
                className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors min-h-[42px] text-center ${
                  turnMode === "them"
                    ? "bg-teal-700 border-teal-700 text-white"
                    : "bg-teal-50/70 hover:bg-teal-50 border-teal-200 text-teal-900"
                }`}
              >
                Listen to Them → {effectiveMyLanguage}
              </button>
              <button
                type="button"
                onClick={() => handleSelectTurnMode("me")}
                className={`px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors min-h-[42px] text-center ${
                  turnMode === "me"
                    ? "bg-blue-700 border-blue-700 text-white"
                    : "bg-blue-50/70 hover:bg-blue-50 border-blue-200 text-blue-900"
                }`}
              >
                I&apos;m Speaking → {activePartnerLabel}
              </button>
            </div>
          </div>
        )}

        {/* Empty Idle Hero Stage */}
        {entries.length === 0 && status !== "connected" && status !== "connecting" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-blue-50 text-blue-700 mx-auto">
              <Languages className="h-7 w-7" />
            </div>

            <div className="space-y-2">
              <h2 className="font-display text-xl font-bold text-slate-950">
                Fast Two-Way Live Conversation Translator
              </h2>
              <p className="text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
                Tap <strong>Start Live Interpreter</strong> once. Jarvis listens fast to the other person in{" "}
                <strong>{isOtherAuto ? "any language" : effectiveOtherLanguage}</strong>, explains straight to you in{" "}
                <strong>{effectiveMyLanguage}</strong>, and when you reply, translates and speaks back in the exact same language they spoke.
              </p>
            </div>

            <div className="flex flex-wrap justify-center gap-2.5">
              <button
                type="button"
                onClick={() => handleSelectTurnMode("auto")}
                className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm sm:text-base font-semibold transition-colors min-h-[52px]"
              >
                <Mic className="h-5 w-5" />
                <span>Start Fast Auto Interpreter</span>
              </button>
              <button
                type="button"
                onClick={() => handleSelectTurnMode("them")}
                className="inline-flex items-center gap-2 px-5 py-3.5 rounded-xl bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-900 text-sm font-semibold transition-colors min-h-[52px]"
              >
                <span>Listen to Them First</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-2 border-t border-slate-100">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-teal-700">1. Fast Listen</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Hears the other person immediately and locks their exact language automatically.
                </p>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-blue-700">2. Direct Explain</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Explains clearly to you in {effectiveMyLanguage} with zero filler or delay.
                </p>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-slate-900">3. Reply in Their Language</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Speak naturally in {effectiveMyLanguage} and Jarvis speaks back in the exact same language they used.
                </p>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 mb-3">
                Or tap a quick phrase to translate &amp; speak aloud
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                {QUICK_PHRASES.map((phrase) => (
                  <button
                    key={phrase}
                    type="button"
                    onClick={() => void handleSendTyped(phrase)}
                    className="px-3.5 py-2.5 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 text-xs sm:text-sm text-slate-800 transition-colors min-h-[44px]"
                  >
                    {phrase}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Conversation Transcript Cards */}
        {entries.map((entry) => {
          const isInterpreter = entry.speaker === "interpreter";
          const isOtherPersonTurn = entry.speakerSide === "them";
          const isSpeaking = speakingEntryId === entry.id;
          const isLoadingAudio = loadingAudioId === entry.id;

          return (
            <div
              key={entry.id}
              className={`flex flex-col ${
                isInterpreter && !isOtherPersonTurn
                  ? "items-end"
                  : isInterpreter
                    ? "items-start"
                    : "items-end"
              }`}
            >
              <div
                className={`w-full max-w-2xl rounded-2xl border p-4 sm:p-5 space-y-2.5 ${
                  isInterpreter
                    ? isOtherPersonTurn
                      ? "bg-white border-teal-200"
                      : "bg-white border-blue-200"
                    : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`font-semibold ${
                        isInterpreter
                          ? isOtherPersonTurn
                            ? "text-teal-700"
                            : "text-blue-700"
                          : "text-slate-700"
                      }`}
                    >
                      {entry.metaLabel ||
                        (isInterpreter ? "Jarvis Interpreter" : "Heard Speech")}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{entry.timestamp}</span>
                  </div>

                  {isInterpreter && (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          void speakEntryAudio(
                            entry.id,
                            entry.text,
                            entry.targetLanguage || effectiveMyLanguage
                          )
                        }
                        className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors min-h-[34px] ${
                          isSpeaking
                            ? "bg-blue-700 text-white"
                            : "text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        {isLoadingAudio ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : isSpeaking ? (
                          <Square className="h-3 w-3 fill-white" />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5" />
                        )}
                        <span>{isSpeaking ? "Stop" : "Replay"}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setFullscreenEntry(entry)}
                        title="Show large text on screen for the other person to read"
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 min-h-[34px]"
                      >
                        <Maximize2 className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Show Big</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleCopy(entry.id, entry.text)}
                        title="Copy text"
                        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 min-h-[34px]"
                      >
                        {copiedId === entry.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-700" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {entry.secondaryText && (
                  <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
                    {entry.secondaryText}
                  </p>
                )}

                <p
                  className={`${
                    isInterpreter
                      ? "text-base sm:text-lg font-semibold text-slate-950 leading-snug"
                      : "text-sm sm:text-base text-slate-800 leading-relaxed"
                  }`}
                >
                  {entry.text}
                </p>

                {entry.pronunciation && (
                  <p className="text-xs sm:text-sm text-slate-500">
                    Pronunciation: {entry.pronunciation}
                  </p>
                )}

                {isInterpreter && (
                  <div className="pt-1.5 flex flex-wrap items-center gap-2">
                    <StudyMediaQuickButtons
                      compact
                      onOpen={(targetMode) => {
                        const topic = (entry.secondaryText || entry.text)
                          .trim()
                          .slice(0, 140);
                        setMediaStudio({
                          isOpen: true,
                          mode: targetMode,
                          prompt: topic,
                          autoRun: Boolean(topic),
                        });
                      }}
                    />
                  </div>
                )}

                {entry.suggestedReplies && entry.suggestedReplies.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500 mr-1">
                      Quick reply:
                    </span>
                    {entry.suggestedReplies.map((reply) => (
                      <button
                        key={reply}
                        type="button"
                        disabled={isSendingTyped}
                        onClick={() => void handleSendTyped(reply)}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-blue-50 hover:text-blue-800 text-xs font-medium text-slate-700 transition-colors min-h-[34px]"
                      >
                        {reply}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isSendingTyped && (
          <div className="flex items-center justify-center gap-2.5 py-3 text-sm font-medium text-blue-800">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Interpreting &amp; preparing voice…</span>
          </div>
        )}

        <div ref={feedEndRef} />
      </div>

      {/* Bottom Sticky Live Interpreter Control Dock */}
      <div className="bg-white border-t border-slate-200 px-4 sm:px-6 py-3 space-y-3 shrink-0">
        {/* Quick Type / Nudge Row */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSendTyped();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={typedText}
            onChange={(e) => setTypedText(e.target.value)}
            placeholder={
              status === "connected"
                ? `Type anything for Jarvis to say aloud in ${isOtherAuto ? lastDetectedOtherLang || "their language" : effectiveOtherLanguage}…`
                : `Type in ${effectiveMyLanguage} to interpret & speak aloud…`
            }
            className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <button
            type="submit"
            disabled={isSendingTyped || !typedText.trim()}
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">Speak</span>
          </button>
        </form>

        {/* Primary Live Two-Way Session Controls */}
        <div className="flex items-center justify-center gap-2 sm:gap-3 flex-wrap">
          {status === "connected" || status === "connecting" ? (
            <>
              <button
                type="button"
                onClick={() => handleSelectTurnMode("them")}
                className={`inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl text-xs sm:text-sm font-semibold border transition-colors min-h-[48px] whitespace-nowrap ${
                  turnMode === "them"
                    ? "bg-teal-700 border-teal-700 text-white"
                    : "bg-teal-50 hover:bg-teal-100 border-teal-200 text-teal-900"
                }`}
              >
                <span>Listen to Them</span>
              </button>

              <button
                type="button"
                onClick={() => handleSelectTurnMode("me")}
                className={`inline-flex items-center justify-center gap-1.5 px-4 py-3 rounded-xl text-xs sm:text-sm font-semibold border transition-colors min-h-[48px] whitespace-nowrap ${
                  turnMode === "me"
                    ? "bg-blue-700 border-blue-700 text-white"
                    : "bg-blue-50 hover:bg-blue-100 border-blue-200 text-blue-900"
                }`}
              >
                <span>Reply → {activePartnerLabel}</span>
              </button>

              <button
                type="button"
                onClick={() => setIsMuted((m) => !m)}
                className={`inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-xs sm:text-sm font-semibold border transition-colors min-h-[48px] whitespace-nowrap ${
                  isMuted
                    ? "bg-amber-50 border-amber-300 text-amber-900"
                    : "bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-900"
                }`}
              >
                {isMuted ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
                <span>{isMuted ? "Unmute" : "Mute"}</span>
              </button>

              <button
                type="button"
                onClick={stopSession}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs sm:text-sm font-semibold transition-colors min-h-[48px] whitespace-nowrap"
              >
                <PhoneOff className="h-4 w-4" />
                <span>End</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleSelectTurnMode("auto")}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm sm:text-base font-semibold transition-colors min-h-[52px] whitespace-nowrap"
            >
              <Mic className="h-5 w-5" />
              <span>
                Start Fast Live Interpreter ({effectiveMyLanguage} ↔{" "}
                {activePartnerLabel})
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Full-Screen High-Contrast Show-to-Other-Person Modal */}
      {fullscreenEntry && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-slate-950/95 text-white p-6 flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-300">
              {fullscreenEntry.metaLabel || "Jarvis Human Interpreter"}
            </span>
            <button
              type="button"
              onClick={() => setFullscreenEntry(null)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-semibold min-h-[44px]"
            >
              <X className="h-4 w-4" />
              <span>Close</span>
            </button>
          </div>

          <div className="max-w-3xl mx-auto text-center space-y-5 my-auto">
            <p className="text-3xl sm:text-5xl font-bold leading-tight text-white">
              {fullscreenEntry.text}
            </p>
            {fullscreenEntry.pronunciation && (
              <p className="text-lg sm:text-xl text-slate-300">
                {fullscreenEntry.pronunciation}
              </p>
            )}
            {fullscreenEntry.secondaryText && (
              <p className="text-sm text-slate-400 pt-4 border-t border-white/15">
                {fullscreenEntry.secondaryText}
              </p>
            )}
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={() =>
                void speakEntryAudio(
                  fullscreenEntry.id,
                  fullscreenEntry.text,
                  fullscreenEntry.targetLanguage || effectiveMyLanguage
                )
              }
              className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-base font-semibold min-h-[48px]"
            >
              <Volume2 className="h-5 w-5" />
              <span>Play Aloud</span>
            </button>
          </div>
        </div>
      )}

      <StudyMediaStudioModal
        isOpen={mediaStudio.isOpen}
        initialMode={mediaStudio.mode}
        initialPrompt={mediaStudio.prompt}
        autoRun={mediaStudio.autoRun}
        profile={profile}
        language={effectiveMyLanguage}
        contextLabel="Translate"
        onClose={() =>
          setMediaStudio((prev) => ({ ...prev, isOpen: false }))
        }
      />

      <audio ref={audioElRef} playsInline preload="auto" className="hidden" />
    </div>
  );
}
