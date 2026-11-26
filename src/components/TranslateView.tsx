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

type SessionStatus = "idle" | "connecting" | "connected" | "error";
type TransportMode = "live-ws" | "handsfree-https";
type HandsFreePhase = "idle" | "listening" | "hearing" | "interpreting" | "speaking";

interface InterpreterEntry {
  id: string;
  speaker: "heard" | "interpreter";
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
}

const STORAGE_MY_LANG = "jogi_jarvis_translate_from_v2";
const STORAGE_OTHER_LANG = "jogi_jarvis_translate_to_v2";

const QUICK_PHRASES = [
  "Hello! Nice to meet you.",
  "Excuse me, can you please help me?",
  "Tell them I will be there in five minutes.",
  "Please speak slowly, my live interpreter is translating for us.",
];

export function TranslateView({ profile }: TranslateViewProps) {
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

  // Real-time live interpreter state (Gemini Live WebSocket + automatic Hands-Free HTTPS VAD fallback)
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [transport, setTransport] = useState<TransportMode>("live-ws");
  const [handsFreePhase, setHandsFreePhase] = useState<HandsFreePhase>("idle");
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
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fullscreenEntry, setFullscreenEntry] =
    useState<InterpreterEntry | null>(null);

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
        el.volume = 0.01;
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
      onComplete?: () => void
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
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15000);

      setLoadingAudioId(entryId);
      setIsJarvisSpeaking(true);

      const bcp47 =
        WORLD_TRANSLATION_LANGUAGES.find(
          (l) => l.id.toLowerCase() === (targetLanguage || "").toLowerCase()
        )?.bcp47 || "en-IN";

      try {
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

        const audio = getAudioEl();
        revokeActiveBlob();
        const blobUrl = base64ToAudioBlobUrl(
          data.audioBase64,
          data.mimeType || "audio/wav"
        );
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

  // Automatic Hands-Free HTTPS VAD Loop (zero stop-button clicking if WebSocket is unavailable)
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
        scheduleNextClip(120);
        return;
      }

      const blob = new Blob(vadChunksRef.current, { type: mimeType });
      if (blob.size < 450) {
        scheduleNextClip(200);
        return;
      }

      setHandsFreePhase("interpreting");
      if (autoSpeakRef.current) {
        startKeepAliveAudio("Jogi Jarvis is interpreting…");
      }

      try {
        const audioBase64 = await blobToBase64(blob);
        const recent = entriesRef.current.slice(-6);
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

        const res = await fetch("/api/translate/conversation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64,
            audioMimeType: mimeType.split(";")[0],
            myLanguage: myLangRef.current,
            otherLanguage: otherLangRef.current,
            lastOtherLanguage: lastDetectedOtherRef.current,
            direction: "auto_conversation",
            sameLanguageAnswer: sameLangRef.current,
            recentContext,
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
          error?: string;
        };

        if (!handsFreeActiveRef.current) return;

        if (!res.ok) {
          throw new Error(data.error || "Could not interpret right now.");
        }

        if (data.empty || !data.translatedText) {
          stopUnaryPlayback();
          scheduleNextClip(220);
          return;
        }

        if (
          data.speakerSide === "them" &&
          data.detectedLanguage &&
          data.detectedLanguage.toLowerCase() !== myLangRef.current.toLowerCase()
        ) {
          setLastDetectedOtherLang(data.detectedLanguage);
        }

        const nowTime = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        const newEntry: InterpreterEntry = {
          id: `tr-${Date.now()}`,
          speaker: "interpreter",
          text: data.translatedText,
          secondaryText: data.originalText,
          pronunciation: data.pronunciation || "",
          metaLabel: `${data.detectedLanguage || "Detected"} → ${data.targetLanguage || myLangRef.current}`,
          targetLanguage: data.targetLanguage || myLangRef.current,
          suggestedReplies: Array.isArray(data.suggestedReplies)
            ? data.suggestedReplies
            : [],
          timestamp: nowTime,
        };
        setEntries((prev) => [...prev, newEntry]);

        if (autoSpeakRef.current && newEntry.text) {
          setHandsFreePhase("speaking");
          void speakEntryAudio(
            newEntry.id,
            newEntry.text,
            newEntry.targetLanguage || myLangRef.current,
            true,
            () => {
              if (handsFreeActiveRef.current) {
                scheduleNextClip(420);
              }
            }
          );
        } else {
          stopUnaryPlayback();
          scheduleNextClip(350);
        }
      } catch (err) {
        stopUnaryPlayback();
        setErrorMsg(
          err instanceof Error
            ? err.message
            : "Live interpretation paused briefly."
        );
        scheduleNextClip(900);
      }
    };

    try {
      recorder.start();
    } catch {
      scheduleNextClip(500);
      return;
    }

    // Monitor RMS speech energy via Web Audio AnalyserNode
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
        setAudioLevel((prev) => prev * 0.65 + Math.min(1, rms * 5.5) * 0.35);

        const now = Date.now();
        if (rms > 0.018) {
          voiceFrames += 1;
          lastSpeechAt = now;
          if (voiceFrames >= 3 && !heardSpeech) {
            heardSpeech = true;
            setHandsFreePhase("hearing");
          }
        }

        if (
          (heardSpeech && now - lastSpeechAt >= 1350) ||
          (heardSpeech && now - clipStartedAt >= 18000)
        ) {
          if (vadRecorderRef.current.state === "recording") {
            vadRecorderRef.current.stop();
          }
          return;
        }

        // Recycle quiet buffer every 10s so memory stays tiny
        if (!heardSpeech && now - clipStartedAt >= 10000) {
          silentRecycle = true;
          if (vadRecorderRef.current.state === "recording") {
            vadRecorderRef.current.stop();
          }
        }
      }, 80);
    } catch {
      // Fallback: 6-second auto turn if AudioContext fails
      vadIntervalRef.current = window.setInterval(() => {
        if (vadRecorderRef.current?.state === "recording") {
          vadForceSendRef.current = true;
          vadRecorderRef.current.stop();
        }
      }, 6000);
    }
  }, [speakEntryAudio, startKeepAliveAudio, stopSession, stopUnaryPlayback]);

  // Start Real-Time Gemini Live Human Interpreter (with automatic Hands-Free HTTPS VAD fallback)
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

      await fetch("/api/health").catch(() => {});

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live`;

      const openLiveWs = (attempt: number): Promise<WebSocket> =>
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
              reject(new Error(`Timeout attempt ${attempt}`));
            }
          }, 7000);

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
              reject(new Error(`Error attempt ${attempt}`));
            }
          };
        });

      let ws: WebSocket | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          ws = await openLiveWs(attempt);
          break;
        } catch {
          if (attempt < 2) {
            await new Promise((r) => window.setTimeout(r, 500));
          }
        }
      }

      // If WebSockets are blocked, seamlessly activate automatic Hands-Free HTTPS VAD loop (still zero stop clicks!)
      if (!ws) {
        if (playerRef.current) {
          void playerRef.current.close();
          playerRef.current = null;
        }
        setTransport("handsfree-https");
        setStatus("connected");
        handsFreeActiveRef.current = true;
        setInfoMsg(
          "Hands-Free Auto Interpreter active — just speak naturally in any language; Jogi Jarvis listens, explains fast, and converts your reply back automatically."
        );
        timerRef.current = window.setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
        startHandsFreeVadClip();
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
          otherLanguage: otherLangRef.current,
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
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
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
            setErrorMsg(
              msg.message ||
                "Live interpreter encountered a temporary connection issue."
            );
            // Automatically fall back to Hands-Free HTTPS VAD if Gemini Live errors out
            if (wsRef.current === ws) {
              try {
                ws.close();
              } catch {
                // ignore
              }
              wsRef.current = null;
            }
            setStatus("error");
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
          setErrorMsg(
            "Live interpreter connection interrupted. Tap Start Live Interpreter to reconnect."
          );
          stopSession();
          setStatus("error");
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
  }, [appendLiveTranscript, profile, startHandsFreeVadClip, stopSession]);

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
        }),
      });
      const data = (await res.json()) as {
        originalText?: string;
        detectedLanguage?: string;
        targetLanguage?: string;
        translatedText?: string;
        pronunciation?: string;
        suggestedReplies?: string[];
        error?: string;
      };
      if (!res.ok || !data.translatedText) {
        throw new Error(data.error || "Could not interpret right now.");
      }

      const nowTime = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      const entry: InterpreterEntry = {
        id: `typed-${Date.now()}`,
        speaker: "interpreter",
        text: data.translatedText,
        secondaryText: data.originalText || clean,
        pronunciation: data.pronunciation || "",
        metaLabel: `${data.detectedLanguage || effectiveMyLanguage} → ${data.targetLanguage || effectiveOtherLanguage}`,
        targetLanguage: data.targetLanguage || effectiveOtherLanguage,
        suggestedReplies: Array.isArray(data.suggestedReplies)
          ? data.suggestedReplies
          : [],
        timestamp: nowTime,
      };
      setEntries((prev) => [...prev, entry]);

      if (autoSpeakRef.current) {
        void speakEntryAudio(
          entry.id,
          entry.text,
          entry.targetLanguage || effectiveOtherLanguage,
          true
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

  const liveStatusText =
    status === "connecting"
      ? "Connecting Live Human Interpreter…"
      : status === "connected"
        ? transport === "handsfree-https"
          ? handsFreePhase === "hearing"
            ? "Hearing voice — will explain automatically when they pause…"
            : handsFreePhase === "interpreting"
              ? `Interpreting into ${effectiveMyLanguage} / speaker's language…`
              : handsFreePhase === "speaking"
                ? "Jarvis Interpreter is speaking…"
                : isMuted
                  ? "Microphone muted"
                  : `Auto-Listening (${isOtherAuto ? "Any Language" : effectiveOtherLanguage} ↔ ${effectiveMyLanguage})`
          : isJarvisSpeaking
            ? "Jarvis Interpreter is speaking…"
            : isMuted
              ? "Microphone muted"
              : `Live To-and-Fro Listening (${isOtherAuto ? "Any Language" : effectiveOtherLanguage} ↔ ${effectiveMyLanguage})`
        : "Ready for instant to-and-fro human translation";

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

          <div className="flex items-center gap-2">
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

        {/* Same-Language Toggle & Detected Partner Language info */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <p className="text-xs text-slate-500">
            {isSameLanguage || sameLanguageReplyMode
              ? `Same-Language Mode: Jarvis listens and replies directly in ${effectiveMyLanguage}.`
              : isOtherAuto
                ? lastDetectedOtherLang
                  ? `Auto-Detect active · Last speaker language detected: ${lastDetectedOtherLang}`
                  : `Auto-Detect active · Listens to any language, explains in ${effectiveMyLanguage}, and answers back in their language.`
                : `To-and-Fro active · ${effectiveMyLanguage} ↔ ${effectiveOtherLanguage}`}
          </p>

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
          <div className="bg-white border border-blue-200 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <div className="relative h-14 w-14 flex items-center justify-center shrink-0">
                <div
                  style={{
                    transform: `scale(${status === "connected" ? ringScaleOuter : 1})`,
                    opacity: status === "connected" ? 0.22 + audioLevel * 0.45 : 0.12,
                  }}
                  className="absolute inset-0 rounded-full bg-blue-600 transition-transform duration-150 motion-reduce:transition-none"
                />
                <div
                  style={{
                    transform: `scale(${status === "connected" ? ringScaleMid : 1})`,
                    opacity: status === "connected" ? 0.35 + audioLevel * 0.4 : 0.2,
                  }}
                  className="absolute inset-1.5 rounded-full bg-blue-700 transition-transform duration-150 motion-reduce:transition-none"
                />
                <div
                  className={`relative h-10 w-10 rounded-full flex items-center justify-center ${
                    isJarvisSpeaking
                      ? "bg-blue-700 text-white"
                      : isMuted
                        ? "bg-slate-200 text-slate-600"
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
                  No need to click anything — just let the other person speak, hear Jarvis explain in {effectiveMyLanguage}, and answer back naturally.
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
        )}

        {/* Empty Idle Hero Stage */}
        {entries.length === 0 && status !== "connected" && status !== "connecting" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center justify-center h-14 w-14 rounded-2xl bg-blue-50 text-blue-700 mx-auto">
              <Languages className="h-7 w-7" />
            </div>

            <div className="space-y-2">
              <h2 className="font-display text-xl font-bold text-slate-950">
                Instant To-and-Fro Human Translator
              </h2>
              <p className="text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
                Tap <strong>Start Live Interpreter</strong> once — no record or stop clicks needed. Jogi Jarvis listens live in{" "}
                <strong>{isOtherAuto ? "any world language" : effectiveOtherLanguage}</strong>, explains quickly to you in{" "}
                <strong>{effectiveMyLanguage}</strong>, asks for your answer, and speaks your reply straight back to them in their language.
              </p>
            </div>

            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void startLiveInterpreter()}
                className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm sm:text-base font-semibold transition-colors min-h-[52px]"
              >
                <Mic className="h-5 w-5" />
                <span>Start Live Interpreter (To &amp; Fro)</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left pt-2 border-t border-slate-100">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-blue-700">1. Listen Live</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Anyone speaks in any language — Jarvis hears them automatically without tapping stop.
                </p>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-teal-700">2. Explain Fast</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Jarvis explains clearly in {effectiveMyLanguage} and asks what you want to reply.
                </p>
              </div>
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                <p className="text-xs font-bold text-slate-900">3. Answer Them</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  You answer in {effectiveMyLanguage} (or say &ldquo;tell them…&rdquo;) and Jarvis speaks to them in their language.
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
          const isSpeaking = speakingEntryId === entry.id;
          const isLoadingAudio = loadingAudioId === entry.id;

          return (
            <div
              key={entry.id}
              className={`flex flex-col ${
                isInterpreter ? "items-start" : "items-end"
              }`}
            >
              <div
                className={`w-full max-w-2xl rounded-2xl border p-4 sm:p-5 space-y-2.5 ${
                  isInterpreter
                    ? "bg-white border-blue-200"
                    : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`font-semibold ${
                        isInterpreter ? "text-blue-700" : "text-slate-700"
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

        {/* Primary Live To-and-Fro Session Controls */}
        <div className="flex items-center justify-center gap-3 flex-wrap">
          {status === "connected" || status === "connecting" ? (
            <>
              <button
                type="button"
                onClick={() => setIsMuted((m) => !m)}
                className={`inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold border transition-colors min-h-[48px] whitespace-nowrap ${
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
                <span>{isMuted ? "Unmute Mic" : "Mute Mic"}</span>
              </button>

              <button
                type="button"
                onClick={stopSession}
                className="inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors min-h-[48px] whitespace-nowrap"
              >
                <PhoneOff className="h-4 w-4" />
                <span>End Live Interpreter</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void startLiveInterpreter()}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-8 py-3.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm sm:text-base font-semibold transition-colors min-h-[52px] whitespace-nowrap"
            >
              <Mic className="h-5 w-5" />
              <span>
                Start Live To-and-Fro Interpreter ({effectiveMyLanguage} ↔{" "}
                {isOtherAuto ? "Any Language" : effectiveOtherLanguage})
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

      <audio ref={audioElRef} playsInline preload="auto" className="hidden" />
    </div>
  );
}
