import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Check,
  Copy,
  Ear,
  Languages,
  Loader2,
  Maximize2,
  MessageCircle,
  Mic,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { FamilyProfile } from "../types";
import { WORLD_TRANSLATION_LANGUAGES } from "../data/defaults";
import { blobToBase64 } from "../utils/audio";
import {
  base64ToAudioBlobUrl,
  getSilentKeepAliveWavUrl,
  requestAudioWakeLock,
  updateJarvisMediaSession,
  type WakeLockHandle,
} from "../utils/backgroundAudio";

type TranslateDirection =
  | "me_to_them"
  | "them_to_me"
  | "auto_conversation"
  | "listen_any";

interface ConversationTurn {
  id: string;
  originalText: string;
  detectedLanguage: string;
  targetLanguage: string;
  translatedText: string;
  pronunciation?: string;
  speakerSide: "me" | "them";
  suggestedReplies?: string[];
  modeUsed: "translate" | "same_language_reply";
  timestamp: string;
}

interface TranslateViewProps {
  profile: FamilyProfile;
}

const STORAGE_MY_LANG = "jogi_jarvis_translate_from_v1";
const STORAGE_OTHER_LANG = "jogi_jarvis_translate_to_v1";

const QUICK_PHRASES = [
  "Hello! Nice to meet you.",
  "Excuse me, can you please help me?",
  "How much does this cost?",
  "Please speak slowly, I am using a live voice translator.",
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
      return (
        localStorage.getItem(STORAGE_OTHER_LANG) ||
        (defaultMyLang === "Hindi" ? "English" : "Hindi")
      );
    } catch {
      return defaultMyLang === "Hindi" ? "English" : "Hindi";
    }
  });

  const [customMyLanguage, setCustomMyLanguage] = useState("");
  const [customOtherLanguage, setCustomOtherLanguage] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [sameLanguageReplyMode, setSameLanguageReplyMode] = useState(false);

  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [typedText, setTypedText] = useState("");
  const [activeRecordingMode, setActiveRecordingMode] =
    useState<TranslateDirection | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [speakingTurnId, setSpeakingTurnId] = useState<string | null>(null);
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [fullscreenTurn, setFullscreenTurn] = useState<ConversationTurn | null>(
    null
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const activeBlobUrlRef = useRef<string | null>(null);
  const wakeLockRef = useRef<WakeLockHandle | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const playbackTokenRef = useRef(0);
  const autoSpeakRef = useRef(autoSpeak);
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  const effectiveMyLanguage =
    myLanguage === "__custom__"
      ? customMyLanguage.trim() || "English"
      : myLanguage;
  const effectiveOtherLanguage =
    otherLanguage === "__custom__"
      ? customOtherLanguage.trim() || "English"
      : otherLanguage;

  const isSameLanguage =
    effectiveMyLanguage.toLowerCase() === effectiveOtherLanguage.toLowerCase();

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

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length, isProcessing]);

  useEffect(() => {
    return () => {
      stopPlayback();
      if (recordTimerRef.current) {
        window.clearInterval(recordTimerRef.current);
      }
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  };

  const revokeActiveBlob = () => {
    if (activeBlobUrlRef.current) {
      URL.revokeObjectURL(activeBlobUrlRef.current);
      activeBlobUrlRef.current = null;
    }
  };

  const getAudioEl = (): HTMLAudioElement => {
    if (!audioElRef.current) {
      audioElRef.current = new Audio();
    }
    return audioElRef.current;
  };

  const startKeepAliveAudio = (title: string) => {
    try {
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
        artist: "Jogi Jarvis Translator",
        album: `${effectiveMyLanguage} ↔ ${effectiveOtherLanguage}`,
        playbackState: "playing",
        handlers: {
          onStop: () => stopPlayback(),
        },
      });
      void requestAudioWakeLock().then((lock) => {
        if (lock) wakeLockRef.current = lock;
      });
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
    revokeActiveBlob();
    updateJarvisMediaSession({
      title: "Jogi Jarvis Translator",
      playbackState: "none",
    });
    releaseWakeLock();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setLoadingAudioId(null);
    setSpeakingTurnId(null);
  };

  const speakBrowserFallback = (
    turnId: string,
    text: string,
    targetLanguage: string,
    token: number
  ): boolean => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return false;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const langEntry = WORLD_TRANSLATION_LANGUAGES.find(
        (l) => l.id.toLowerCase() === targetLanguage.toLowerCase()
      );
      if (langEntry?.bcp47) {
        utter.lang = langEntry.bcp47;
      }
      utter.rate = 0.96;
      utter.onend = () => {
        if (playbackTokenRef.current === token) {
          setSpeakingTurnId(null);
          releaseWakeLock();
        }
      };
      utter.onerror = () => {
        if (playbackTokenRef.current === token) {
          setSpeakingTurnId(null);
          releaseWakeLock();
        }
      };
      setSpeakingTurnId(turnId);
      window.speechSynthesis.speak(utter);
      return true;
    } catch {
      return false;
    }
  };

  const speakTurnAudio = async (
    turnId: string,
    text: string,
    targetLanguage: string,
    preserveKeepAlive = false
  ) => {
    if (speakingTurnId === turnId || loadingAudioId === turnId) {
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
    }

    const myToken = playbackTokenRef.current;
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setLoadingAudioId(turnId);

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          voiceName: profile.voiceName,
          role: profile.role,
          language: targetLanguage,
          conversational: true,
        }),
      });
      const data = await res.json();
      if (playbackTokenRef.current !== myToken) return;
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

      audio.loop = false;
      audio.muted = false;
      audio.volume = 1.0;
      audio.src = blobUrl;

      setSpeakingTurnId(turnId);
      setLoadingAudioId(null);

      updateJarvisMediaSession({
        title: text.slice(0, 72),
        artist: `Jogi Jarvis (${targetLanguage})`,
        album: "Live Voice Translator",
        playbackState: "playing",
        handlers: {
          onPlay: () => void audio.play().catch(() => {}),
          onPause: () => audio.pause(),
          onStop: () => stopPlayback(),
        },
      });

      audio.onended = () => {
        if (playbackTokenRef.current === myToken) {
          setSpeakingTurnId(null);
          revokeActiveBlob();
          updateJarvisMediaSession({
            title: "Jogi Jarvis Translator",
            playbackState: "none",
          });
          releaseWakeLock();
        }
      };
      audio.onerror = () => {
        if (playbackTokenRef.current === myToken) {
          setSpeakingTurnId(null);
          revokeActiveBlob();
          updateJarvisMediaSession({
            title: "Jogi Jarvis Translator",
            playbackState: "none",
          });
          releaseWakeLock();
        }
      };

      await audio.play();
    } catch (err) {
      if (playbackTokenRef.current !== myToken) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (audioElRef.current) {
        audioElRef.current.loop = false;
        audioElRef.current.pause();
      }
      const ok = speakBrowserFallback(turnId, text, targetLanguage, myToken);
      if (!ok) {
        setSpeakingTurnId(null);
        releaseWakeLock();
      }
    } finally {
      if (playbackTokenRef.current === myToken) {
        setLoadingAudioId(null);
      }
    }
  };

  const runTranslation = async (payload: {
    audioBase64?: string;
    audioMimeType?: string;
    text?: string;
    direction: TranslateDirection;
  }) => {
    setErrorMsg(null);
    setIsProcessing(true);
    setProcessingLabel(
      payload.direction === "listen_any"
        ? `Listening & translating into ${effectiveMyLanguage}...`
        : isSameLanguage || sameLanguageReplyMode
          ? `Understanding & replying in ${effectiveMyLanguage}...`
          : "Translating conversation..."
    );

    if (autoSpeakRef.current) {
      startKeepAliveAudio("Jogi Jarvis is translating…");
    }

    try {
      const res = await fetch("/api/translate/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: payload.audioBase64,
          audioMimeType: payload.audioMimeType,
          text: payload.text,
          myLanguage: effectiveMyLanguage,
          otherLanguage: effectiveOtherLanguage,
          direction: payload.direction,
          sameLanguageAnswer:
            payload.direction !== "listen_any" &&
            (isSameLanguage || sameLanguageReplyMode),
          recentContext: turns.slice(-4).map((t) => ({
            originalText: t.originalText,
            translatedText: t.translatedText,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Translation failed. Please try again.");
      }

      const newTurn: ConversationTurn = {
        id: `tr-${Date.now()}`,
        originalText: data.originalText || payload.text || "",
        detectedLanguage: data.detectedLanguage || effectiveMyLanguage,
        targetLanguage: data.targetLanguage || effectiveOtherLanguage,
        translatedText: data.translatedText || "",
        pronunciation: data.pronunciation || "",
        speakerSide: data.speakerSide === "them" ? "them" : "me",
        suggestedReplies: Array.isArray(data.suggestedReplies)
          ? data.suggestedReplies
          : [],
        modeUsed:
          data.modeUsed === "same_language_reply"
            ? "same_language_reply"
            : "translate",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };

      setTurns((prev) => [...prev, newTurn]);

      if (autoSpeakRef.current && newTurn.translatedText) {
        void speakTurnAudio(
          newTurn.id,
          newTurn.translatedText,
          newTurn.targetLanguage,
          true
        );
      } else {
        stopPlayback();
      }
    } catch (err) {
      stopPlayback();
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not translate right now. Please try again."
      );
    } finally {
      setIsProcessing(false);
      setProcessingLabel("");
    }
  };

  const handleToggleRecord = async (mode: TranslateDirection) => {
    setErrorMsg(null);

    // If currently recording this button (or any button), stop and process it
    if (activeRecordingMode) {
      mediaRecorderRef.current?.stop();
      setActiveRecordingMode(null);
      if (recordTimerRef.current) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      setRecordingSeconds(0);
      return;
    }

    stopPlayback();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) {
          window.clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        setRecordingSeconds(0);
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        if (blob.size < 400) {
          setErrorMsg("Recording was too short. Tap again and speak clearly.");
          return;
        }
        try {
          const base64 = await blobToBase64(blob);
          await runTranslation({
            audioBase64: base64,
            audioMimeType: mimeType,
            direction: mode,
          });
        } catch (e) {
          setErrorMsg(
            e instanceof Error ? e.message : "Could not process voice audio."
          );
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setActiveRecordingMode(mode);
      setRecordingSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSeconds((s) => s + 1);
      }, 1000);
    } catch {
      setErrorMsg(
        "Microphone access is required for live voice translation. Please allow microphone permission in your browser."
      );
    }
  };

  const handleSwapLanguages = () => {
    const prevMy = myLanguage;
    const prevCustomMy = customMyLanguage;
    setMyLanguage(otherLanguage);
    setCustomMyLanguage(customOtherLanguage);
    setOtherLanguage(prevMy);
    setCustomOtherLanguage(prevCustomMy);
  };

  const handleSendTyped = async (
    customText?: string,
    direction: TranslateDirection = "me_to_them"
  ) => {
    const clean = (customText ?? typedText).trim();
    if (!clean || isProcessing) return;
    if (!customText) setTypedText("");
    await runTranslation({ text: clean, direction });
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

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-5xl mx-auto w-full bg-[#F8FAFC]">
      {/* Top Language & Mode Control Header */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-4 space-y-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-lg sm:text-xl font-bold text-slate-950 tracking-tight">
              Live Voice Translator & Conversation
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 mt-0.5">
              Listen to any voice from any country or hold a live two-way conversation in any language.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !autoSpeak;
                setAutoSpeak(next);
                if (!next) stopPlayback();
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

            {turns.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  stopPlayback();
                  setTurns([]);
                }}
                title="Clear conversation history"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 transition-colors min-h-[40px] whitespace-nowrap shrink-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Clear</span>
              </button>
            )}
          </div>
        </div>

        {/* From <-> To Language Picker Row */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-end gap-2.5">
          <div>
            <label
              htmlFor="translate-from-lang"
              className="block text-xs font-semibold text-slate-600 mb-1"
            >
              My Language (From)
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
              aria-label="Swap From and To languages"
              title="Swap From and To languages"
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
              Other Person&apos;s Language (To)
            </label>
            <select
              id="translate-to-lang"
              value={otherLanguage}
              onChange={(e) => setOtherLanguage(e.target.value)}
              className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600"
            >
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

        {/* Dedicated 1-Tap Listen Any Voice & Same-Language Mode Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => void handleToggleRecord("listen_any")}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-colors min-h-[44px] whitespace-nowrap shrink-0 disabled:opacity-50 ${
              activeRecordingMode === "listen_any"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-slate-900 hover:bg-slate-800 text-white"
            }`}
          >
            {activeRecordingMode === "listen_any" ? (
              <>
                <Square className="h-4 w-4 fill-white shrink-0" />
                <span className="tabular-nums">
                  Stop Listening ({formatTimer(recordingSeconds)})
                </span>
              </>
            ) : (
              <>
                <Ear className="h-4 w-4 shrink-0" />
                <span>
                  Listen Any Voice → {effectiveMyLanguage}
                </span>
              </>
            )}
          </button>

          <div className="flex items-center gap-2">
            {isSameLanguage ? (
              <p className="text-xs font-medium text-teal-800">
                Same language selected ({effectiveMyLanguage}) · Jogi Jarvis will listen and reply directly in {effectiveMyLanguage}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setSameLanguageReplyMode((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors min-h-[40px] whitespace-nowrap ${
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
      </div>

      {/* Scrollable Conversation Transcript Feed */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
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

        {turns.length === 0 && !isProcessing && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 max-w-2xl mx-auto text-center space-y-5">
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-blue-50 text-blue-700 mx-auto">
              <Languages className="h-6 w-6" />
            </div>
            <div className="space-y-1.5">
              <h2 className="font-display text-lg font-bold text-slate-950">
                Talk freely with anyone, anywhere in the world
              </h2>
              <p className="text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
                Tap <strong>Listen Any Voice</strong> to understand any stranger, announcement, or call in{" "}
                <strong>{effectiveMyLanguage}</strong> — or use the{" "}
                <strong>Conversation</strong> buttons below to speak back and forth in{" "}
                <strong>{effectiveMyLanguage}</strong> and{" "}
                <strong>{effectiveOtherLanguage}</strong>.
              </p>
            </div>

            <div className="pt-2 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-500 mb-3">
                Tap a phrase to translate & speak aloud right now
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                {QUICK_PHRASES.map((phrase) => (
                  <button
                    key={phrase}
                    type="button"
                    onClick={() => void handleSendTyped(phrase, "me_to_them")}
                    className="px-3.5 py-2.5 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/40 text-xs sm:text-sm text-slate-800 transition-colors min-h-[44px]"
                  >
                    {phrase}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {turns.map((turn) => {
          const isMe = turn.speakerSide === "me";
          const isSpeaking = speakingTurnId === turn.id;
          const isLoadingAudio = loadingAudioId === turn.id;

          return (
            <div
              key={turn.id}
              className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
            >
              <div
                className={`w-full max-w-2xl rounded-2xl border p-4 sm:p-5 space-y-3 ${
                  isMe
                    ? "bg-white border-blue-200"
                    : "bg-white border-teal-200"
                }`}
              >
                {/* Clean unboxed metadata row */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={`font-semibold ${
                        isMe ? "text-blue-700" : "text-teal-700"
                      }`}
                    >
                      {turn.modeUsed === "same_language_reply"
                        ? "Same-Language Conversation"
                        : isMe
                          ? "You Spoke"
                          : "Heard Voice"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {turn.detectedLanguage} → {turn.targetLanguage}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">{turn.timestamp}</span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void speakTurnAudio(
                          turn.id,
                          turn.translatedText,
                          turn.targetLanguage
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
                      <span>{isSpeaking ? "Stop" : "Speak"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setFullscreenTurn(turn)}
                      title="Show large text on screen for the other person to read"
                      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 min-h-[34px]"
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Show Big</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCopy(turn.id, turn.translatedText)}
                      title="Copy translated text"
                      className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 min-h-[34px]"
                    >
                      {copiedId === turn.id ? (
                        <Check className="h-3.5 w-3.5 text-emerald-700" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Original spoken text */}
                <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
                  {turn.originalText}
                </p>

                {/* Primary translated output */}
                <div className="pt-2 border-t border-slate-100">
                  <p className="text-lg sm:text-xl font-semibold text-slate-950 leading-snug">
                    {turn.translatedText}
                  </p>
                  {turn.pronunciation && (
                    <p className="text-xs sm:text-sm text-slate-500 mt-1.5">
                      Pronunciation: {turn.pronunciation}
                    </p>
                  )}
                </div>

                {/* One-tap natural reply chips */}
                {turn.suggestedReplies && turn.suggestedReplies.length > 0 && (
                  <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] font-medium text-slate-500 mr-1">
                      Quick reply:
                    </span>
                    {turn.suggestedReplies.map((reply) => (
                      <button
                        key={reply}
                        type="button"
                        disabled={isProcessing}
                        onClick={() => void handleSendTyped(reply, "me_to_them")}
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

        {isProcessing && (
          <div className="flex items-center justify-center gap-2.5 py-4 text-sm font-medium text-blue-800">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{processingLabel || "Translating..."}</span>
          </div>
        )}

        <div ref={feedEndRef} />
      </div>

      {/* Bottom Sticky Thumb-Zone Conversation Bar */}
      <div className="bg-white border-t border-slate-200 px-4 sm:px-6 py-3 space-y-3 shrink-0">
        {/* Quick Type & Translate row */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSendTyped(undefined, "me_to_them");
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={typedText}
            onChange={(e) => setTypedText(e.target.value)}
            placeholder={
              isSameLanguage || sameLanguageReplyMode
                ? `Type in ${effectiveMyLanguage} to get a spoken reply...`
                : `Type in ${effectiveMyLanguage} to translate & speak in ${effectiveOtherLanguage}...`
            }
            className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <button
            type="submit"
            disabled={isProcessing || !typedText.trim()}
            className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">Translate</span>
          </button>
        </form>

        {/* Primary 3-Button Conversation Control Dock */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {/* Button 1: I Speak (From -> To) */}
          <button
            type="button"
            disabled={
              isProcessing ||
              (activeRecordingMode !== null &&
                activeRecordingMode !== "me_to_them")
            }
            onClick={() => void handleToggleRecord("me_to_them")}
            className={`flex flex-col items-center justify-center gap-1 px-2 sm:px-4 py-2.5 rounded-xl font-semibold transition-colors min-h-[58px] disabled:opacity-40 ${
              activeRecordingMode === "me_to_them"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-blue-700 hover:bg-blue-800 text-white"
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs sm:text-sm whitespace-nowrap">
              {activeRecordingMode === "me_to_them" ? (
                <Square className="h-4 w-4 fill-white shrink-0" />
              ) : (
                <Mic className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate max-w-[110px] sm:max-w-[160px]">
                {activeRecordingMode === "me_to_them"
                  ? `Stop (${formatTimer(recordingSeconds)})`
                  : "I Speak"}
              </span>
            </div>
            <span className="text-[11px] font-normal opacity-90 truncate max-w-full">
              {effectiveMyLanguage}
            </span>
          </button>

          {/* Button 2: Auto Conversation (Bi-Directional Smart Detect) */}
          <button
            type="button"
            disabled={
              isProcessing ||
              (activeRecordingMode !== null &&
                activeRecordingMode !== "auto_conversation")
            }
            onClick={() => void handleToggleRecord("auto_conversation")}
            className={`flex flex-col items-center justify-center gap-1 px-2 sm:px-4 py-2.5 rounded-xl font-semibold border transition-colors min-h-[58px] disabled:opacity-40 ${
              activeRecordingMode === "auto_conversation"
                ? "bg-red-600 hover:bg-red-700 border-red-600 text-white"
                : "bg-slate-900 hover:bg-slate-800 border-slate-900 text-white"
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs sm:text-sm whitespace-nowrap">
              {activeRecordingMode === "auto_conversation" ? (
                <Square className="h-4 w-4 fill-white shrink-0" />
              ) : (
                <MessageCircle className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate max-w-[110px] sm:max-w-[160px]">
                {activeRecordingMode === "auto_conversation"
                  ? `Stop (${formatTimer(recordingSeconds)})`
                  : "Conversation"}
              </span>
            </div>
            <span className="text-[11px] font-normal opacity-90 truncate max-w-full">
              {isSameLanguage || sameLanguageReplyMode
                ? "Same-Lang Reply"
                : "Auto Both Sides"}
            </span>
          </button>

          {/* Button 3: They Speak (To -> From) */}
          <button
            type="button"
            disabled={
              isProcessing ||
              (activeRecordingMode !== null &&
                activeRecordingMode !== "them_to_me")
            }
            onClick={() => void handleToggleRecord("them_to_me")}
            className={`flex flex-col items-center justify-center gap-1 px-2 sm:px-4 py-2.5 rounded-xl font-semibold transition-colors min-h-[58px] disabled:opacity-40 ${
              activeRecordingMode === "them_to_me"
                ? "bg-red-600 hover:bg-red-700 text-white"
                : "bg-teal-700 hover:bg-teal-800 text-white"
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs sm:text-sm whitespace-nowrap">
              {activeRecordingMode === "them_to_me" ? (
                <Square className="h-4 w-4 fill-white shrink-0" />
              ) : (
                <Mic className="h-4 w-4 shrink-0" />
              )}
              <span className="truncate max-w-[110px] sm:max-w-[160px]">
                {activeRecordingMode === "them_to_me"
                  ? `Stop (${formatTimer(recordingSeconds)})`
                  : "They Speak"}
              </span>
            </div>
            <span className="text-[11px] font-normal opacity-90 truncate max-w-full">
              {effectiveOtherLanguage}
            </span>
          </button>
        </div>
      </div>

      {/* Full-Screen High-Contrast Show-to-Other-Person Modal */}
      {fullscreenTurn && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-slate-950/95 text-white p-6 flex flex-col justify-between"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-300">
              {fullscreenTurn.detectedLanguage} → {fullscreenTurn.targetLanguage}
            </span>
            <button
              type="button"
              onClick={() => setFullscreenTurn(null)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-semibold min-h-[44px]"
            >
              <X className="h-4 w-4" />
              <span>Close</span>
            </button>
          </div>

          <div className="max-w-3xl mx-auto text-center space-y-5 my-auto">
            <p className="text-3xl sm:text-5xl font-bold leading-tight text-white">
              {fullscreenTurn.translatedText}
            </p>
            {fullscreenTurn.pronunciation && (
              <p className="text-lg sm:text-xl text-slate-300">
                {fullscreenTurn.pronunciation}
              </p>
            )}
            <p className="text-sm text-slate-400 pt-4 border-t border-white/15">
              {fullscreenTurn.originalText}
            </p>
          </div>

          <div className="flex justify-center">
            <button
              type="button"
              onClick={() =>
                void speakTurnAudio(
                  fullscreenTurn.id,
                  fullscreenTurn.translatedText,
                  fullscreenTurn.targetLanguage
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
