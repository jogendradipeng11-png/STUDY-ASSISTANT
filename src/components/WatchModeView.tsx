import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Globe,
  Loader2,
  Mic,
  Newspaper,
  Square,
  Trophy,
  Volume2,
  VolumeX,
  Watch,
  X,
} from "lucide-react";
import type {
  ActiveAlarm,
  FamilyProfile,
  GroundingSource,
  MobileAction,
} from "../types";
import { blobToBase64 } from "../utils/audio";
import {
  formatAlarmTime,
  parseMobileActions,
  triggerMobileAction,
} from "../utils/mobileActions";

interface WatchModeViewProps {
  profile: FamilyProfile;
  onAddAlarm?: (alarm: Omit<ActiveAlarm, "id" | "ringing">) => void;
  onExitWatchMode: () => void;
}

export function WatchModeView({
  profile,
  onAddAlarm,
  onExitWatchMode,
}: WatchModeViewProps) {
  const activeLanguage = profile.preferredLanguage || "Auto-Detect";
  const [isRecording, setIsRecording] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [statusLabel, setStatusLabel] = useState("Tap mic to ask anything live");
  const [questionText, setQuestionText] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [sources, setSources] = useState<GroundingSource[]>([]);
  const [watchActions, setWatchActions] = useState<MobileAction[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showWatchGuide, setShowWatchGuide] = useState(false);
  const [copiedWatchUrl, setCopiedWatchUrl] = useState(false);
  const [clock, setClock] = useState(() =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);

  const watchUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/?mode=watch`
      : "/?mode=watch";

  useEffect(() => {
    const id = window.setInterval(() => {
      setClock(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    }, 15000);
    return () => window.clearInterval(id);
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      void wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      const nav = navigator as unknown as {
        wakeLock?: {
          request: (type: "screen") => Promise<{ release: () => Promise<void> }>;
        };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      // Wake Lock not available on this browser
    }
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsSpeaking(false);
    releaseWakeLock();
  }, [releaseWakeLock]);

  useEffect(() => {
    return () => {
      stopAudio();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [stopAudio]);

  const speakAnswer = useCallback(
    async (text: string, titleLabel: string) => {
      stopAudio();
      try {
        const ttsRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voiceName: profile.voiceName,
            role: profile.role,
            language: activeLanguage,
          }),
        });
        if (!ttsRes.ok) return;
        const ttsData = (await ttsRes.json()) as { audioBase64?: string };
        if (!ttsData.audioBase64) return;

        const audio = new Audio(
          `data:audio/wav;base64,${ttsData.audioBase64}`
        );
        audioRef.current = audio;
        setIsSpeaking(true);
        void requestWakeLock();

        // Register Android / Wear OS Media Session controls so wrist buttons control playback
        if ("mediaSession" in navigator) {
          try {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: titleLabel || "Jogi Jarvis Live",
              artist: "Jogi Jarvis",
              album: "Watch Live Voice",
              artwork: [
                {
                  src: "/pwa-192x192.png",
                  sizes: "192x192",
                  type: "image/png",
                },
              ],
            });
            navigator.mediaSession.setActionHandler("play", () => {
              void audio.play();
              setIsSpeaking(true);
            });
            navigator.mediaSession.setActionHandler("pause", () => {
              audio.pause();
              setIsSpeaking(false);
            });
            navigator.mediaSession.setActionHandler("stop", () => {
              stopAudio();
            });
          } catch {
            // ignore unsupported MediaSession handlers
          }
        }

        audio.onended = () => {
          setIsSpeaking(false);
          audioRef.current = null;
          releaseWakeLock();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          audioRef.current = null;
          releaseWakeLock();
        };
        await audio.play().catch(() => {
          setIsSpeaking(false);
        });
      } catch {
        setIsSpeaking(false);
      }
    },
    [
      activeLanguage,
      profile.role,
      profile.voiceName,
      releaseWakeLock,
      requestWakeLock,
      stopAudio,
    ]
  );

  const askLiveWatch = useCallback(
    async (
      category: "news" | "sports" | "weather" | "custom",
      customQuery = "",
      label = "Live Update"
    ) => {
      stopAudio();
      setIsBusy(true);
      setErrorMsg(null);
      setWatchActions([]);
      setStatusLabel(`Fetching ${label.toLowerCase()}...`);
      setQuestionText(customQuery || label);

      if (category === "custom" && customQuery) {
        const parsed = parseMobileActions(customQuery);
        if (parsed.autoAlarm && onAddAlarm) {
          onAddAlarm(parsed.autoAlarm);
          const confirmText =
            parsed.autoAlarm.type === "timer"
              ? `Done! I started your timer for ${parsed.autoAlarm.label}.`
              : `Done! I set your alarm for ${formatAlarmTime(parsed.autoAlarm.triggerAt)} for ${parsed.autoAlarm.label}.`;
          setAnswerText(confirmText);
          setWatchActions(parsed.actions);
          setSources([]);
          setIsBusy(false);
          await speakAnswer(confirmText, "Alarm Set");
          setStatusLabel("Tap mic to ask anything live");
          return;
        }
        if (parsed.actions.length > 0) {
          setWatchActions(parsed.actions);
          const primary = parsed.actions[0];
          if (primary.kind !== "alarm" && primary.kind !== "timer") {
            triggerMobileAction(primary);
            if (parsed.isDirectCommandOnly) {
              const confirmText = `Opening ${primary.label} now.`;
              setAnswerText(confirmText);
              setSources([]);
              setIsBusy(false);
              await speakAnswer(confirmText, primary.label);
              setStatusLabel("Tap mic to ask anything live");
              return;
            }
          }
        }
      }

      try {
        const res = await fetch("/api/live-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            query: customQuery,
            language: activeLanguage,
            conciseForWatch: true,
            profile,
          }),
        });
        const data = (await res.json()) as {
          answer?: string;
          sources?: GroundingSource[];
          error?: string;
        };
        if (!res.ok || !data.answer) {
          throw new Error(data.error || "Could not fetch live data right now.");
        }

        setAnswerText(data.answer);
        setSources(Array.isArray(data.sources) ? data.sources : []);
        setStatusLabel("Speaking live answer...");
        setIsBusy(false);
        await speakAnswer(data.answer, label);
        setStatusLabel("Tap mic to ask anything live");
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Live request failed."
        );
        setStatusLabel("Tap mic to try again");
        setIsBusy(false);
      }
    },
    [activeLanguage, profile, speakAnswer, stopAudio]
  );

  const handleToggleMic = async () => {
    setErrorMsg(null);
    stopAudio();

    if (isRecording) {
      recorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      await requestWakeLock();

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 200) {
          releaseWakeLock();
          setStatusLabel("Tap mic to ask anything live");
          return;
        }

        setIsBusy(true);
        setStatusLabel("Listening...");
        try {
          const audioBase64 = await blobToBase64(blob);
          const cleanMime = mimeType.split(";")[0];
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioBase64, mimeType: cleanMime }),
          });
          const data = (await res.json()) as {
            transcript?: string;
            error?: string;
          };
          if (!res.ok || !data.transcript?.trim()) {
            throw new Error(data.error || "Could not hear clearly. Try again.");
          }
          await askLiveWatch("custom", data.transcript.trim(), "Live Answer");
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : "Voice capture failed."
          );
          setStatusLabel("Tap mic to try again");
          setIsBusy(false);
          releaseWakeLock();
        }
      };

      recorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
      setStatusLabel("Listening... Tap to stop");
    } catch {
      setErrorMsg("Allow microphone permission on your watch/device to speak.");
    }
  };

  const handleCopyWatchUrl = async () => {
    try {
      await navigator.clipboard.writeText(watchUrl);
      setCopiedWatchUrl(true);
      window.setTimeout(() => setCopiedWatchUrl(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-white flex flex-col items-center justify-center p-2 sm:p-6">
      {/* Desktop/phone top bar (hidden on actual tiny watch viewports <= 340px) */}
      <div className="hidden sm:flex w-full max-w-md items-center justify-between gap-3 mb-5">
        <button
          type="button"
          onClick={onExitWatchMode}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200 transition-colors whitespace-nowrap"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Full App</span>
        </button>

        <button
          type="button"
          onClick={() => setShowWatchGuide(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
        >
          <Watch className="h-3.5 w-3.5" />
          <span>Open on Android Watch</span>
        </button>
      </div>

      {/* Circular/Compact Wear OS Watch Face Container */}
      <div className="w-full max-w-[340px] min-h-[340px] sm:rounded-[44px] sm:border sm:border-slate-800 sm:bg-[#060D1F] sm:shadow-2xl px-4 py-5 flex flex-col items-center justify-between gap-3 text-center">
        {/* Top Watch Clock & Brand */}
        <div className="space-y-0.5">
          <p className="text-[11px] font-mono tabular-nums text-blue-400">
            {clock} · LIVE
          </p>
          <h1 className="text-sm font-bold tracking-tight text-white">
            Jogi Jarvis
          </h1>
        </div>

        {/* Center Giant Wrist Mic Trigger */}
        <div className="flex flex-col items-center gap-2 my-1">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleToggleMic()}
            aria-label={isRecording ? "Stop speaking" : "Speak to Jogi Jarvis"}
            className={`h-24 w-24 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95 disabled:opacity-60 ${
              isRecording
                ? "bg-red-600 hover:bg-red-700 ring-8 ring-red-500/25"
                : isSpeaking
                  ? "bg-emerald-600 hover:bg-emerald-700 ring-8 ring-emerald-500/25"
                  : "bg-blue-600 hover:bg-blue-700 ring-8 ring-blue-500/20"
            }`}
          >
            {isBusy ? (
              <Loader2 className="h-9 w-9 animate-spin text-white" />
            ) : isRecording ? (
              <Square className="h-8 w-8 fill-white text-white" />
            ) : (
              <Mic className="h-10 w-10 text-white" />
            )}
          </button>

          <p className="text-[11px] font-medium text-slate-300 px-2">
            {statusLabel}
          </p>
        </div>

        {/* 1-Tap Live Wrist Tiles (News / Sports / World) */}
        <div className="w-full grid grid-cols-3 gap-1.5">
          <button
            type="button"
            disabled={isBusy || isRecording}
            onClick={() => void askLiveWatch("news", "", "Live News")}
            className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-semibold text-slate-100 disabled:opacity-50"
          >
            <Newspaper className="h-4 w-4 text-blue-400" />
            <span>News</span>
          </button>

          <button
            type="button"
            disabled={isBusy || isRecording}
            onClick={() => void askLiveWatch("sports", "", "Live Sports")}
            className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-semibold text-slate-100 disabled:opacity-50"
          >
            <Trophy className="h-4 w-4 text-amber-400" />
            <span>Sports</span>
          </button>

          <button
            type="button"
            disabled={isBusy || isRecording}
            onClick={() => void askLiveWatch("weather", "", "Live Update")}
            className="flex flex-col items-center justify-center gap-1 py-2.5 px-1 rounded-2xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] font-semibold text-slate-100 disabled:opacity-50"
          >
            <Globe className="h-4 w-4 text-emerald-400" />
            <span>Live Info</span>
          </button>
        </div>

        {/* Live Answer Readout Card */}
        {errorMsg && (
          <div className="w-full rounded-xl bg-red-950/80 border border-red-800 px-3 py-2 text-[11px] text-red-200">
            {errorMsg}
          </div>
        )}

        {answerText && (
          <div className="w-full rounded-2xl bg-slate-900/90 border border-slate-800 p-3 text-left space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-400 truncate">
                {questionText}
              </span>
              <button
                type="button"
                onClick={() =>
                  isSpeaking
                    ? stopAudio()
                    : void speakAnswer(answerText, questionText)
                }
                aria-label={isSpeaking ? "Stop voice" : "Replay voice"}
                className="h-7 w-7 rounded-full bg-slate-800 hover:bg-slate-700 inline-flex items-center justify-center text-white shrink-0"
              >
                {isSpeaking ? (
                  <VolumeX className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <Volume2 className="h-3.5 w-3.5 text-blue-400" />
                )}
              </button>
            </div>
            <p className="text-xs leading-relaxed text-slate-100">
              {answerText}
            </p>
            {watchActions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {watchActions.slice(0, 2).map((act) => (
                  <a
                    key={act.id}
                    href={act.href}
                    target={act.external ? "_blank" : undefined}
                    rel={act.external ? "noopener noreferrer" : undefined}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-[11px] font-semibold text-white"
                  >
                    <span>{act.label}</span>
                  </a>
                ))}
              </div>
            )}
            {sources.length > 0 && (
              <p className="text-[10px] text-slate-400 truncate">
                Source: {sources[0].title}
              </p>
            )}
          </div>
        )}

        {/* Small exit link visible on mobile/watch */}
        <button
          type="button"
          onClick={onExitWatchMode}
          className="sm:hidden text-[11px] font-medium text-slate-400 hover:text-white pt-1"
        >
          Switch to Full Mode
        </button>
      </div>

      {/* Android Watch (Wear OS) Setup Guide Modal */}
      {showWatchGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="watch-guide-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4"
          onClick={() => setShowWatchGuide(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-6 text-left space-y-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
                  <Watch className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <h2
                    id="watch-guide-title"
                    className="text-base font-bold text-white"
                  >
                    Use Jogi Jarvis on Android Watch
                  </h2>
                  <p className="text-xs text-slate-400">
                    Works on Wear OS (Galaxy Watch, Pixel Watch, OnePlus Watch)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowWatchGuide(false)}
                className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ol className="space-y-2.5 text-xs sm:text-sm text-slate-200 list-decimal pl-5 leading-relaxed">
              <li>
                On your Android Watch (Wear OS), open{" "}
                <strong className="text-white">Samsung Internet</strong> or{" "}
                <strong className="text-white">Wear Browser</strong> (free on
                the Watch Play Store).
              </li>
              <li>
                Open your Watch Mode link below (or send the link from your
                phone to your watch browser):
              </li>
              <li>
                Bookmark it or tap{" "}
                <strong className="text-white">Add to Watch Home / Tile</strong>{" "}
                for 1-tap voice news, live sports scores, and answers directly
                on your wrist.
              </li>
            </ol>

            <div className="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2.5 flex items-center justify-between gap-2">
              <code className="text-[11px] text-blue-300 truncate">
                {watchUrl}
              </code>
              <button
                type="button"
                onClick={() => void handleCopyWatchUrl()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold whitespace-nowrap shrink-0"
              >
                {copiedWatchUrl ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy Link</span>
                  </>
                )}
              </button>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              Tip: When playing spoken answers on your Android phone, your
              paired Android watch also shows live Play/Pause controls
              automatically via Media Session.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
