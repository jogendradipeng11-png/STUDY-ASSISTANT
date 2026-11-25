import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookMarked,
  Check,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Volume2,
} from "lucide-react";
import type {
  FamilyProfile,
  LiveTranscriptItem,
  StudyNote,
  VoiceName,
} from "../types";
import { VOICE_OPTIONS } from "../data/defaults";
import { float32ToPcm16Base64, LiveAudioPlayer } from "../utils/audio";
import { formatShortDate } from "../utils/storage";
import { LanguagePicker } from "./LanguagePicker";
import { ProfileAvatar } from "./ProfileAvatar";

interface LiveVoiceViewProps {
  profile: FamilyProfile;
  subject: string;
  autoStartSignal: number;
  onChangeLanguage: (language: string) => void;
  onSaveNote: (note: StudyNote) => void;
  onOpenNote: (noteId: string) => void;
}

type LiveStatus = "idle" | "connecting" | "connected" | "error";

export function LiveVoiceView({
  profile,
  subject,
  autoStartSignal,
  onChangeLanguage,
  onSaveNote,
  onOpenNote,
}: LiveVoiceViewProps) {
  const activeLanguage = profile.preferredLanguage || "Auto-Detect";
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>(
    profile.voiceName
  );
  const [isMuted, setIsMuted] = useState(false);
  const [isJarvisSpeaking, setIsJarvisSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [textNudge, setTextNudge] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Notes generation from spoken session
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);

  // Refs to avoid stale closures inside audio/WebSocket callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const isMutedRef = useRef(false);
  const micLevelRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastAutoStartRef = useRef(autoStartSignal);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelectedVoice(profile.voiceName);
  }, [profile.id, profile.voiceName]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  const appendTranscriptChunk = useCallback(
    (speaker: "user" | "jarvis", chunkText: string) => {
      const cleaned = chunkText;
      if (!cleaned) return;
      setTranscripts((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.speaker === speaker) {
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            text: last.text + cleaned,
          };
          return updated;
        }
        return [
          ...prev,
          {
            id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            speaker,
            text: cleaned.trimStart(),
            timestamp: new Date().toISOString(),
          },
        ];
      });
    },
    []
  );

  const stopSession = useCallback(() => {
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
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "stop" }));
        }
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    micLevelRef.current = 0;
    setAudioLevel(0);
    setIsJarvisSpeaking(false);
    setStatus("idle");
  }, []);

  const startSession = useCallback(async () => {
    stopSession();
    setErrorMsg(null);
    setSavedNoteId(null);
    setStatus("connecting");
    setElapsedSeconds(0);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const player = new LiveAudioPlayer((speaking) => {
        setIsJarvisSpeaking(speaking);
      });
      playerRef.current = player;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/api/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "start",
            profile,
            subject: profile.role === "student" ? subject : undefined,
            voiceName: selectedVoice,
            language: activeLanguage,
          })
        );
      };

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

            // Start 16kHz PCM microphone streaming once Gemini Live session is ready
            const inputCtx = new AudioContext({ sampleRate: 16000 });
            inputAudioCtxRef.current = inputCtx;
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              if (
                !wsRef.current ||
                wsRef.current.readyState !== WebSocket.OPEN
              ) {
                return;
              }
              const channel = e.inputBuffer.getChannelData(0);

              if (isMutedRef.current) {
                micLevelRef.current = 0;
                return;
              }

              // Compute RMS level for subtle ring animation
              let sum = 0;
              for (let i = 0; i < channel.length; i++) {
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
            playerRef.current?.enqueuePcmBase64(msg.audio);
            return;
          }

          if (msg.type === "interrupted") {
            playerRef.current?.interrupt();
            return;
          }

          if (msg.type === "inputTranscript" && msg.text) {
            appendTranscriptChunk("user", msg.text);
            return;
          }

          if (msg.type === "outputTranscript" && msg.text) {
            appendTranscriptChunk("jarvis", msg.text);
            return;
          }

          if (msg.type === "error") {
            setErrorMsg(
              msg.message || "Live voice encountered a connection issue."
            );
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
        setErrorMsg(
          "Could not connect to Jogi Jarvis Live Voice server. Please try again."
        );
        stopSession();
        setStatus("error");
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stopSession();
        }
      };
    } catch {
      setErrorMsg(
        "Microphone access is needed for Live Voice. Please allow microphone permission in your browser and try again."
      );
      stopSession();
      setStatus("error");
    }
  }, [appendTranscriptChunk, profile, selectedVoice, stopSession, subject]);

  // Trigger session start when user clicks top bar "Talk Now"
  useEffect(() => {
    if (autoStartSignal !== lastAutoStartRef.current) {
      lastAutoStartRef.current = autoStartSignal;
      if (status === "idle" || status === "error") {
        void startSession();
      }
    }
  }, [autoStartSignal, startSession, status]);

  // Clean up on unmount or profile switch
  useEffect(() => {
    return () => {
      stopSession();
    };
  }, [stopSession, profile.id]);

  const handleSendTextNudge = () => {
    const text = textNudge.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      return;
    wsRef.current.send(JSON.stringify({ type: "text", text }));
    appendTranscriptChunk("user", text);
    setTextNudge("");
  };

  const handleMakeStudyNote = async () => {
    if (transcripts.length === 0 || isGeneratingNote) return;
    setIsGeneratingNote(true);
    setErrorMsg(null);

    try {
      const formatted = transcripts
        .map(
          (t) =>
            `${t.speaker === "user" ? profile.name : "Jogi Jarvis"}: ${t.text}`
        )
        .join("\n\n");

      const res = await fetch("/api/notes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: formatted,
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
        throw new Error(data.error || "Could not create notes from transcript.");
      }

      const now = new Date().toISOString();
      const newNote: StudyNote = {
        id: `note-voice-${Date.now()}`,
        profileId: profile.id,
        profileName: profile.name,
        title: data.note.title || "Voice Session Study Notes",
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
        sourceMode: "voice",
      };

      onSaveNote(newNote);
      setSavedNoteId(newNote.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to create study notes."
      );
    } finally {
      setIsGeneratingNote(false);
    }
  };

  const formatTimer = (sec: number) => {
    const mins = Math.floor(sec / 60)
      .toString()
      .padStart(2, "0");
    const rem = (sec % 60).toString().padStart(2, "0");
    return `${mins}:${rem}`;
  };

  const ringScaleOuter = 1 + audioLevel * 0.28;
  const ringScaleMid = 1 + audioLevel * 0.16;

  const statusText =
    status === "connecting"
      ? "Connecting to Jogi Jarvis..."
      : status === "connected"
        ? isJarvisSpeaking
          ? "Jogi Jarvis is speaking"
          : isMuted
            ? "Microphone muted"
            : `Listening to ${profile.name}`
        : status === "error"
          ? "Connection paused"
          : "Ready for hands-free voice conversation";

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] p-5 sm:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-medium text-slate-500">
              {profile.role === "parent"
                ? `${profile.name} · Live Voice Assistant`
                : `${profile.name} · ${profile.grade || "Student"} · ${subject}`}
            </p>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Live Voice Studio
            </h1>
          </div>

          {status === "connected" && (
            <div className="text-sm font-mono tabular-nums text-slate-700 bg-white border border-slate-200 px-3.5 py-1.5 rounded-lg">
              Session {formatTimer(elapsedSeconds)}
            </div>
          )}
        </div>

        {errorMsg && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800 flex items-center justify-between gap-4">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="text-xs font-semibold text-red-700 hover:underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Balanced 2-Column Live Stage */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
          {/* Left: Voice Presence Stage */}
          <section className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 flex flex-col justify-between min-h-[460px]">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <ProfileAvatar profile={profile} size="sm" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    Speaking with {profile.name}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    Voice: {selectedVoice} · Speaks naturally in your language
                  </p>
                </div>
              </div>
            </div>

            {/* Center acoustic ring */}
            <div className="my-10 flex flex-col items-center justify-center">
              <div className="relative h-48 w-48 flex items-center justify-center">
                <div
                  style={{
                    transform: `scale(${status === "connected" ? ringScaleOuter : 1})`,
                    opacity: status === "connected" ? 0.2 + audioLevel * 0.45 : 0.1,
                  }}
                  className="absolute inset-0 rounded-full bg-blue-600 transition-transform duration-150 motion-reduce:transition-none"
                />
                <div
                  style={{
                    transform: `scale(${status === "connected" ? ringScaleMid : 1})`,
                    opacity: status === "connected" ? 0.35 + audioLevel * 0.45 : 0.18,
                  }}
                  className="absolute inset-5 rounded-full bg-blue-700 transition-transform duration-150 motion-reduce:transition-none"
                />
                <div
                  className={`relative h-28 w-28 rounded-full flex items-center justify-center transition-colors ${
                    status === "connected"
                      ? isJarvisSpeaking
                        ? "bg-blue-700 text-white"
                        : "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 border border-slate-200"
                  }`}
                >
                  {status === "connecting" ? (
                    <Loader2 className="h-9 w-9 animate-spin text-blue-700" />
                  ) : isJarvisSpeaking ? (
                    <Volume2 className="h-9 w-9" />
                  ) : isMuted && status === "connected" ? (
                    <MicOff className="h-9 w-9" />
                  ) : (
                    <Mic className="h-9 w-9" />
                  )}
                </div>
              </div>

              <p className="mt-6 text-base font-semibold text-slate-900 text-center">
                {statusText}
              </p>
              <p className="mt-1.5 text-xs text-slate-500 text-center max-w-sm leading-relaxed">
                {status === "connected"
                  ? "Speak naturally — you can interrupt Jogi Jarvis at any time just like a real conversation."
                  : profile.role === "parent"
                    ? "Talk to Jogi Jarvis about work, daily plans, or any question on your mind."
                    : "Talk through homework, practice speaking, or ask for a step-by-step lesson aloud."}
              </p>
            </div>

            {/* Voice selector & primary controls */}
            <div className="space-y-4">
              {status !== "connected" && (
                <div className="space-y-3 pt-4 border-t border-slate-100">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium text-slate-600 whitespace-nowrap">
                      Language
                    </span>
                    <LanguagePicker
                      value={activeLanguage}
                      onChange={onChangeLanguage}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <label
                      htmlFor="live-voice-select"
                      className="text-xs font-medium text-slate-600 whitespace-nowrap"
                    >
                      Jarvis Voice
                    </label>
                    <select
                      id="live-voice-select"
                      value={selectedVoice}
                      onChange={(e) =>
                        setSelectedVoice(e.target.value as VoiceName)
                      }
                      className="text-xs font-medium text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-600"
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label} — {v.tone}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-center gap-3">
                {status === "connected" || status === "connecting" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setIsMuted((m) => !m)}
                      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold border transition-colors min-h-[44px] whitespace-nowrap ${
                        isMuted
                          ? "bg-amber-50 border-amber-300 text-amber-900"
                          : "bg-white border-slate-200 text-slate-800 hover:bg-slate-50"
                      }`}
                    >
                      {isMuted ? (
                        <MicOff className="h-4 w-4" />
                      ) : (
                        <Mic className="h-4 w-4" />
                      )}
                      <span>{isMuted ? "Unmute" : "Mute Mic"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={stopSession}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors min-h-[44px] whitespace-nowrap"
                    >
                      <PhoneOff className="h-4 w-4" />
                      <span>End Voice</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startSession()}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold bg-blue-700 hover:bg-blue-800 text-white transition-colors min-h-[46px] whitespace-nowrap"
                  >
                    <Mic className="h-4 w-4" />
                    <span>Start Live Voice Session</span>
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Right: Live Transcript & Instant AI Study Notes */}
          <section className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl flex flex-col min-h-[460px] max-h-[600px]">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Live Transcript
                </h2>
                <p className="text-xs text-slate-500">
                  Every spoken answer is captured here for instant AI study notes
                </p>
              </div>

              {savedNoteId ? (
                <button
                  type="button"
                  onClick={() => onOpenNote(savedNoteId)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 whitespace-nowrap shrink-0"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>Open Saved Note</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={transcripts.length === 0 || isGeneratingNote}
                  onClick={() => void handleMakeStudyNote()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0"
                >
                  {isGeneratingNote ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <BookMarked className="h-3.5 w-3.5" />
                  )}
                  <span>Make AI Notes</span>
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {transcripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10 space-y-2">
                  <p className="text-sm font-medium text-slate-700">
                    Your spoken conversation will appear here live.
                  </p>
                  <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                    When you finish a study lesson or Q&amp;A, click{" "}
                    <strong className="text-slate-700">Make AI Notes</strong> to
                    turn the conversation into a clean revision sheet with
                    practice questions.
                  </p>
                </div>
              ) : (
                transcripts.map((item) => (
                  <div key={item.id} className="space-y-1">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span
                        className={`font-semibold ${
                          item.speaker === "user"
                            ? "text-blue-700"
                            : "text-slate-900"
                        }`}
                      >
                        {item.speaker === "user" ? profile.name : "Jogi Jarvis"}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {formatShortDate(item.timestamp)}
                      </span>
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed">
                      {item.text}
                    </p>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>

            {/* Optional mid-call text follow-up */}
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 rounded-b-2xl flex items-center gap-2">
              <input
                type="text"
                value={textNudge}
                disabled={status !== "connected"}
                onChange={(e) => setTextNudge(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSendTextNudge();
                  }
                }}
                placeholder={
                  status === "connected"
                    ? "Type a formula, spelling, or follow-up during voice chat..."
                    : "Start a Live Voice session to speak or send live notes"
                }
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 disabled:opacity-60"
              />
              <button
                type="button"
                disabled={status !== "connected" || !textNudge.trim()}
                onClick={handleSendTextNudge}
                aria-label="Send text into live session"
                className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white transition-colors shrink-0"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
