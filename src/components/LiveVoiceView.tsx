import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  Check,
  FileDown,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Printer,
  Send,
  Square,
  Star,
  Volume2,
  VolumeX,
} from "lucide-react";
import type {
  FamilyProfile,
  LiveTranscriptItem,
  StudyNote,
  VoiceName,
} from "../types";
import { VOICE_OPTIONS } from "../data/defaults";
import {
  blobToBase64,
  float32ToPcm16Base64,
  LiveAudioPlayer,
} from "../utils/audio";
import { exportStudyNotesToPdf } from "../utils/pdfExport";
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
type VoiceTransport = "live-ws" | "turn-https";
type LiveSessionMode = "interactive" | "listen-only";

const CASUAL_FILLER_REGEX =
  /^(hi+|hey+|hello+|ok+|okay|yes|yeah|yep|no|nope|hmm+|uh+|um+|thanks|thank you|got it|sure|alright|good morning|good evening|good night|bye|goodbye|wait|hold on|one second|can you hear me|hello jarvis|hey jarvis|hi jarvis|jogi jarvis)[.!?,\s]*$/i;

const IMPORTANT_CUE_REGEX =
  /(\b(important|remember|note|formula|definition|defined as|rule|law|theorem|principle|equation|because|therefore|means|is called|steps?|first|second|third|example|exam|revision|summary|key point|difference|causes?|effects?|process|answer|solution|ascending|descending|multiply|divide|fraction|percent|angle|triangle|photosynthesis|gravity|energy|cell|atom|molecule|grammar|tense|verb|noun)\b|[=×÷%²³]|:\s+\S|\d+\s*[+\-*/=]\s*\d+|(याद|सूत्र|परिभाषा|नियम|उत्तर|महत्वपूर्ण|ମୁଖ୍ୟ|ସୂତ୍ର|ମନେ ରଖ|ଉତ୍ତର|ଗୁରୁତ୍ୱପୂର୍ଣ୍ଣ))/i;

function detectImportantPoint(
  text: string,
  speaker: "user" | "jarvis",
  listenOnlyMode: boolean
): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (CASUAL_FILLER_REGEX.test(clean)) return false;

  // Short formulas or equations like "F = m * a" or "Area = l × b"
  if (clean.length >= 5 && /[=×÷%²³]/.test(clean)) {
    return true;
  }

  if (clean.length < 14) return false;

  const words = clean.split(/\s+/).filter(Boolean);
  if (IMPORTANT_CUE_REGEX.test(clean) && words.length >= 4) {
    return true;
  }
  if (listenOnlyMode) {
    return clean.length >= 22 && words.length >= 4;
  }
  if (speaker === "jarvis") {
    return clean.length >= 52 && words.length >= 8;
  }
  return clean.length >= 65 && words.length >= 10 && !clean.endsWith("?");
}

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
  const [transport, setTransport] = useState<VoiceTransport>("live-ws");
  const [sessionMode, setSessionMode] =
    useState<LiveSessionMode>("interactive");
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>(
    profile.voiceName
  );
  const [isMuted, setIsMuted] = useState(false);
  const [isJarvisSpeaking, setIsJarvisSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<LiveTranscriptItem[]>([]);
  const [transcriptFilter, setTranscriptFilter] = useState<"all" | "important">(
    "all"
  );
  const [textNudge, setTextNudge] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Turn-by-turn HTTPS fallback & Listen-Only capture voice state
  const [isTurnRecording, setIsTurnRecording] = useState(false);
  const [isTurnProcessing, setIsTurnProcessing] = useState(false);

  // Notes generation + direct PDF/Print + Listen to Revision playback
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isPlayingRevision, setIsPlayingRevision] = useState(false);
  const [savedNote, setSavedNote] = useState<StudyNote | null>(null);
  const savedNoteSignatureRef = useRef("");

  // Refs to avoid stale closures inside audio/WebSocket callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playerRef = useRef<LiveAudioPlayer | null>(null);
  const fallbackRecorderRef = useRef<MediaRecorder | null>(null);
  const fallbackChunksRef = useRef<Blob[]>([]);
  const fallbackAudioElRef = useRef<HTMLAudioElement | null>(null);
  const revisionAudioElRef = useRef<HTMLAudioElement | null>(null);
  const fallbackHistoryRef = useRef<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const isMutedRef = useRef(false);
  const sessionModeRef = useRef<LiveSessionMode>("interactive");
  const micLevelRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastAutoStartRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelectedVoice(profile.voiceName);
  }, [profile.id, profile.voiceName]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    sessionModeRef.current = sessionMode;
  }, [sessionMode]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcripts]);

  const importantTranscripts = useMemo(
    () => transcripts.filter((t) => t.isImportant),
    [transcripts]
  );

  const importantSignature = useMemo(
    () => importantTranscripts.map((t) => `${t.id}:${t.text.length}`).join("|"),
    [importantTranscripts]
  );

  const visibleTranscripts = useMemo(
    () =>
      transcriptFilter === "important" ? importantTranscripts : transcripts,
    [transcriptFilter, importantTranscripts, transcripts]
  );

  const appendTranscriptChunk = useCallback(
    (
      speaker: "user" | "jarvis",
      chunkText: string,
      forceNewTurn = false,
      forceImportant?: boolean
    ) => {
      const cleaned = chunkText;
      if (!cleaned) return;
      const listenOnly = sessionModeRef.current === "listen-only";
      setTranscripts((prev) => {
        const last = prev[prev.length - 1];
        if (!forceNewTurn && last && last.speaker === speaker) {
          const combined = last.text + cleaned;
          const updated = [...prev];
          updated[updated.length - 1] = {
            ...last,
            text: combined,
            isImportant: last.importantManuallySet
              ? last.isImportant
              : forceImportant ??
                detectImportantPoint(combined, speaker, listenOnly),
          };
          return updated;
        }
        const initialText = cleaned.trimStart();
        return [
          ...prev,
          {
            id: `${speaker}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            speaker,
            text: initialText,
            timestamp: new Date().toISOString(),
            isImportant:
              forceImportant ??
              detectImportantPoint(initialText, speaker, listenOnly),
            importantManuallySet: forceImportant !== undefined,
          },
        ];
      });
    },
    []
  );

  const toggleTranscriptImportant = useCallback((id: string) => {
    setTranscripts((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              isImportant: !item.isImportant,
              importantManuallySet: true,
            }
          : item
      )
    );
  }, []);

  const stopRevisionPlayback = useCallback(() => {
    if (revisionAudioElRef.current) {
      revisionAudioElRef.current.pause();
      revisionAudioElRef.current = null;
    }
    setIsPlayingRevision(false);
  }, []);

  const stopFallbackPlayback = useCallback(() => {
    if (fallbackAudioElRef.current) {
      fallbackAudioElRef.current.pause();
      fallbackAudioElRef.current = null;
    }
    setIsJarvisSpeaking(false);
  }, []);

  const stopSession = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (
      fallbackRecorderRef.current &&
      fallbackRecorderRef.current.state !== "inactive"
    ) {
      try {
        fallbackRecorderRef.current.stop();
      } catch {
        // ignore
      }
      fallbackRecorderRef.current = null;
    }
    stopFallbackPlayback();
    stopRevisionPlayback();

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

    micLevelRef.current = 0;
    setAudioLevel(0);
    setIsTurnRecording(false);
    setIsTurnProcessing(false);
    setIsJarvisSpeaking(false);
    setStatus("idle");
  }, [stopFallbackPlayback, stopRevisionPlayback]);

  // Runs a spoken or typed turn over HTTPS (/api/chat + /api/tts) when WebSockets are blocked
  const processTurnOverHttps = useCallback(
    async (userText: string) => {
      const cleanPrompt = userText.trim();
      if (!cleanPrompt) return;

      // In Listen & Revision mode, silently capture & auto-mark points without Jarvis interrupting
      if (sessionModeRef.current === "listen-only") {
        const segments = cleanPrompt
          .split(/(?<=[.!?।])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);

        if (segments.length > 1) {
          for (const seg of segments) {
            appendTranscriptChunk("user", seg, true);
          }
        } else {
          appendTranscriptChunk("user", cleanPrompt, true);
        }
        setIsTurnProcessing(false);
        return;
      }

      setIsTurnProcessing(true);
      setErrorMsg(null);
      appendTranscriptChunk("user", cleanPrompt, true);

      const nextHistory = [
        ...fallbackHistoryRef.current,
        { role: "user" as const, content: cleanPrompt },
      ];
      fallbackHistoryRef.current = nextHistory.slice(-14);

      try {
        const chatRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: fallbackHistoryRef.current,
            profile,
            subject: profile.role === "student" ? subject : undefined,
            useSearch: true,
            language: activeLanguage,
            speedMode: "fast",
            stream: false,
          }),
        });
        const chatData = (await chatRes.json()) as {
          reply?: string;
          error?: string;
        };
        if (!chatRes.ok || !chatData.reply) {
          throw new Error(
            chatData.error || "Jogi Jarvis could not reply right now."
          );
        }

        const reply = chatData.reply.trim();
        fallbackHistoryRef.current = [
          ...fallbackHistoryRef.current,
          { role: "assistant" as const, content: reply },
        ].slice(-14);
        appendTranscriptChunk("jarvis", reply, true);

        // Speak the answer aloud via Gemini TTS
        const ttsRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: reply,
            voiceName: selectedVoice,
            role: profile.role,
            language: activeLanguage,
          }),
        });
        if (ttsRes.ok) {
          const ttsData = (await ttsRes.json()) as { audioBase64?: string };
          if (ttsData.audioBase64) {
            stopFallbackPlayback();
            const audio = new Audio(
              `data:audio/wav;base64,${ttsData.audioBase64}`
            );
            fallbackAudioElRef.current = audio;
            setIsJarvisSpeaking(true);
            setAudioLevel(0.45);
            audio.onended = () => {
              setIsJarvisSpeaking(false);
              setAudioLevel(0);
              fallbackAudioElRef.current = null;
            };
            audio.onerror = () => {
              setIsJarvisSpeaking(false);
              setAudioLevel(0);
              fallbackAudioElRef.current = null;
            };
            await audio.play().catch(() => {
              setIsJarvisSpeaking(false);
              setAudioLevel(0);
            });
          }
        }
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : "Voice conversation turn failed."
        );
      } finally {
        setIsTurnProcessing(false);
      }
    },
    [
      activeLanguage,
      appendTranscriptChunk,
      profile,
      selectedVoice,
      stopFallbackPlayback,
      subject,
    ]
  );

  const toggleFallbackRecording = useCallback(async () => {
    setErrorMsg(null);
    stopFallbackPlayback();

    if (isTurnRecording) {
      fallbackRecorderRef.current?.stop();
      setIsTurnRecording(false);
      setAudioLevel(0);
      return;
    }

    const stream = mediaStreamRef.current;
    if (!stream) {
      setErrorMsg("Microphone stream is not active. Please restart Voice.");
      return;
    }

    try {
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      fallbackChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          fallbackChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(fallbackChunksRef.current, { type: mimeType });
        if (blob.size < 200) return;

        setIsTurnProcessing(true);
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
          if (!res.ok) {
            throw new Error(data.error || "Could not understand your voice.");
          }
          if (data.transcript?.trim()) {
            await processTurnOverHttps(data.transcript.trim());
          } else {
            setIsTurnProcessing(false);
          }
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : "Voice transcription failed."
          );
          setIsTurnProcessing(false);
        }
      };

      fallbackRecorderRef.current = recorder;
      recorder.start();
      setIsTurnRecording(true);
      setAudioLevel(0.5);
    } catch {
      setErrorMsg("Could not start voice recording in this browser.");
    }
  }, [isTurnRecording, processTurnOverHttps, stopFallbackPlayback]);

  const startSession = useCallback(async (overrideMode?: LiveSessionMode) => {
    const activeMode = overrideMode ?? sessionModeRef.current;
    sessionModeRef.current = activeMode;
    setSessionMode(activeMode);
    stopSession();
    setErrorMsg(null);
    setInfoMsg(null);
    setSavedNote(null);
    savedNoteSignatureRef.current = "";
    setStatus("connecting");
    setElapsedSeconds(0);

    try {
      // 1. Request microphone access immediately inside the user click gesture
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      // 2. Wake up the server (important for Render free-tier cold starts)
      await fetch("/api/health").catch(() => {});

      // Silent Listen & Revision mode: capture spoken study material and auto-mark important points without interrupting
      if (activeMode === "listen-only") {
        setTransport("turn-https");
        setStatus("connected");
        setInfoMsg(
          "Silent Listen & Revision mode active — Jogi Jarvis listens quietly, auto-marks important points, and keeps them ready for your study note."
        );
        timerRef.current = window.setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
        return;
      }

      const player = new LiveAudioPlayer((speaking) => {
        setIsJarvisSpeaking(speaking);
      });
      playerRef.current = player;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live`;

      // Try WebSocket handshake with 1 automatic retry
      const openLiveWebSocket = (attempt: number): Promise<WebSocket> =>
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
              reject(new Error("WebSocket handshake timed out."));
            }
          }, 8000);

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
              reject(new Error(`WebSocket attempt ${attempt} failed.`));
            }
          };
        });

      let ws: WebSocket | null = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          ws = await openLiveWebSocket(attempt);
          break;
        } catch {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 700));
          }
        }
      }

      // If WebSockets are blocked by a proxy/firewall/iframe, seamlessly use HTTPS Voice Mode
      if (!ws) {
        setTransport("turn-https");
        setStatus("connected");
        setInfoMsg(
          "Connected in Voice Talk mode (Tap 'Speak Now' to talk and hear Jogi Jarvis reply aloud)."
        );
        timerRef.current = window.setInterval(() => {
          setElapsedSeconds((s) => s + 1);
        }, 1000);
        return;
      }

      setTransport("live-ws");
      wsRef.current = ws;

      ws.send(
        JSON.stringify({
          type: "start",
          profile,
          subject: profile.role === "student" ? subject : undefined,
          voiceName: selectedVoice,
          language: activeLanguage,
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
        if (wsRef.current === ws) {
          setErrorMsg(
            "Live voice connection interrupted. Please click Start Live Voice Session to reconnect."
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
        "Microphone access is needed for Live Voice. Please allow microphone permission in your browser and try again."
      );
      stopSession();
      setStatus("error");
    }
  }, [
    activeLanguage,
    appendTranscriptChunk,
    profile,
    selectedVoice,
    stopSession,
    subject,
  ]);

  // Trigger session start when user clicks top bar "Talk Now"
  useEffect(() => {
    if (autoStartSignal > 0 && autoStartSignal !== lastAutoStartRef.current) {
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
    if (!text || status !== "connected") return;

    if (sessionMode === "listen-only") {
      setTextNudge("");
      appendTranscriptChunk("user", text, true, true);
      return;
    }

    if (transport === "turn-https") {
      setTextNudge("");
      void processTurnOverHttps(text);
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "text", text }));
    appendTranscriptChunk("user", text, true);
    setTextNudge("");
  };

  const ensureStudyNoteFromTranscript = async (): Promise<StudyNote | null> => {
    if (transcripts.length === 0) return null;

    if (importantTranscripts.length === 0) {
      setErrorMsg(
        "No important points are marked yet. Click the star on any study point you want included in your Study Note."
      );
      return null;
    }

    if (savedNote && savedNoteSignatureRef.current === importantSignature) {
      return savedNote;
    }

    setIsGeneratingNote(true);
    setErrorMsg(null);

    try {
      const formattedImportant = importantTranscripts
        .map(
          (t, idx) =>
            `${idx + 1}. [${t.speaker === "user" ? profile.name : "Jogi Jarvis"}]: ${t.text}`
        )
        .join("\n\n");

      const res = await fetch("/api/notes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: formattedImportant,
          profile,
          subject:
            profile.role === "parent"
              ? "Personal"
              : subject === "All Subjects"
                ? "General"
                : subject,
          language: activeLanguage,
          importantPointsOnly: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.note) {
        throw new Error(data.error || "Could not create notes from important points.");
      }

      const now = new Date().toISOString();
      const newNote: StudyNote = {
        id: `note-voice-${Date.now()}`,
        profileId: profile.id,
        profileName: profile.name,
        title: data.note.title || "Important Points Study Notes",
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
      setSavedNote(newNote);
      savedNoteSignatureRef.current = importantSignature;
      return newNote;
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to create study notes."
      );
      return null;
    } finally {
      setIsGeneratingNote(false);
    }
  };

  const handleMakeStudyNote = async () => {
    if (transcripts.length === 0 || isGeneratingNote) return;
    await ensureStudyNoteFromTranscript();
  };

  const handleExportVoiceNotePdf = async () => {
    if (transcripts.length === 0 || isGeneratingNote || isExportingPdf) return;
    setIsExportingPdf(true);
    try {
      const note = await ensureStudyNoteFromTranscript();
      if (note) {
        await exportStudyNotesToPdf([note]);
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not export PDF right now."
      );
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handlePrintVoiceNote = async () => {
    if (transcripts.length === 0 || isGeneratingNote) return;
    const note = await ensureStudyNoteFromTranscript();
    if (!note) return;
    window.setTimeout(() => {
      window.print();
    }, 150);
  };

  const handleListenToRevision = async () => {
    if (isPlayingRevision) {
      stopRevisionPlayback();
      return;
    }
    if (importantTranscripts.length === 0 || isGeneratingNote) return;

    stopFallbackPlayback();
    setErrorMsg(null);
    const note = await ensureStudyNoteFromTranscript();
    if (!note) return;

    setIsPlayingRevision(true);
    try {
      const spokenRevision = [
        `Revision note: ${note.title}.`,
        note.summary ? `Summary: ${note.summary}` : "",
        note.keyPoints.length > 0
          ? `Important points: ${note.keyPoints.join(". ")}`
          : "",
        note.teacherTip ? `Revision tip: ${note.teacherTip}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: spokenRevision,
          voiceName: selectedVoice,
          role: profile.role,
          language: activeLanguage,
        }),
      });
      const data = (await res.json()) as {
        audioBase64?: string;
        error?: string;
      };
      if (!res.ok || !data.audioBase64) {
        throw new Error(data.error || "Could not read the revision note aloud.");
      }

      const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
      revisionAudioElRef.current = audio;
      audio.onended = () => {
        setIsPlayingRevision(false);
        revisionAudioElRef.current = null;
      };
      audio.onerror = () => {
        setIsPlayingRevision(false);
        revisionAudioElRef.current = null;
      };
      await audio.play();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not play revision audio."
      );
      setIsPlayingRevision(false);
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
        ? sessionMode === "listen-only"
          ? isTurnRecording
            ? `Listening quietly to ${profile.name}... Tap Save Point when done`
            : isTurnProcessing
              ? "Auto-marking important points for revision..."
              : "Silent Listen Mode — Tap Record Study Point"
          : transport === "turn-https"
            ? isTurnRecording
              ? `Listening to ${profile.name}... Tap Stop to send`
              : isTurnProcessing
                ? "Jogi Jarvis is preparing a spoken reply..."
                : isJarvisSpeaking
                  ? "Jogi Jarvis is speaking"
                  : "Ready — Tap Speak Now to ask a question"
            : isJarvisSpeaking
              ? "Jogi Jarvis is speaking"
              : isMuted
                ? "Microphone muted"
                : `Listening to ${profile.name}`
        : status === "error"
          ? "Connection paused"
          : sessionMode === "listen-only"
            ? "Ready to listen silently & keep notes for revision"
            : "Ready for hands-free voice conversation";

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] p-5 sm:p-8 print:bg-white print:p-0">
      <div className="max-w-6xl mx-auto space-y-6 no-print">
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

        {infoMsg && (
          <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-sm text-blue-900 flex items-center justify-between gap-4">
            <span>{infoMsg}</span>
            <button
              type="button"
              onClick={() => setInfoMsg(null)}
              className="text-xs font-semibold text-blue-700 hover:underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

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
                      ? isTurnRecording
                        ? "bg-red-600 text-white"
                        : isJarvisSpeaking
                          ? "bg-blue-700 text-white"
                          : "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 border border-slate-200"
                  }`}
                >
                  {status === "connecting" || isTurnProcessing ? (
                    <Loader2 className="h-9 w-9 animate-spin text-blue-700" />
                  ) : isJarvisSpeaking ? (
                    <Volume2 className="h-9 w-9" />
                  ) : isMuted && status === "connected" && transport === "live-ws" ? (
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
                  ? sessionMode === "listen-only"
                    ? "Read aloud, recite a lesson, or listen to class — Jogi Jarvis stays silent, auto-marks important points, and keeps them ready for revision."
                    : transport === "turn-https"
                      ? "Tap Speak Now to ask your question in Odia, Hindi, English, or any language, then tap Stop & Send."
                      : "Speak naturally — Jogi Jarvis replies aloud and automatically marks important study points for your notes."
                  : sessionMode === "listen-only"
                    ? "Jogi Jarvis listens without interrupting, auto-marks important study points, and keeps them ready for revision, PDF, or Print."
                    : profile.role === "parent"
                      ? "Talk to Jogi Jarvis about work, daily plans, or any question on your mind."
                      : "Talk through homework, practice speaking, or ask for a step-by-step lesson aloud."}
              </p>
            </div>

            {/* Mode switcher, voice selector & primary controls */}
            <div className="space-y-4">
              {status !== "connected" && (
                <div className="space-y-3 pt-4 border-t border-slate-100">
                  {/* Interactive vs Silent Listen & Revision Mode */}
                  <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-100 border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setSessionMode("interactive")}
                      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                        sessionMode === "interactive"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <Mic className="h-3.5 w-3.5 text-blue-700" />
                      <span>Talk &amp; Ask</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSessionMode("listen-only")}
                      className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                        sessionMode === "listen-only"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <Headphones className="h-3.5 w-3.5 text-amber-600" />
                      <span>Listen Only (Revision)</span>
                    </button>
                  </div>

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

              <div className="flex items-center justify-center gap-3 flex-wrap">
                {status === "connected" || status === "connecting" ? (
                  <>
                    {transport === "turn-https" ? (
                      <button
                        type="button"
                        disabled={isTurnProcessing}
                        onClick={() => void toggleFallbackRecording()}
                        className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-colors min-h-[44px] whitespace-nowrap disabled:opacity-50 ${
                          isTurnRecording
                            ? "bg-amber-600 hover:bg-amber-700 text-white"
                            : "bg-blue-700 hover:bg-blue-800 text-white"
                        }`}
                      >
                        {isTurnRecording ? (
                          <Square className="h-4 w-4 fill-white" />
                        ) : (
                          <Mic className="h-4 w-4" />
                        )}
                        <span>
                          {sessionMode === "listen-only"
                            ? isTurnRecording
                              ? "Save Study Point"
                              : "Record Study Point"
                            : isTurnRecording
                              ? "Stop & Send"
                              : "Speak Now"}
                        </span>
                      </button>
                    ) : (
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
                    )}

                    <button
                      type="button"
                      onClick={stopSession}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition-colors min-h-[44px] whitespace-nowrap"
                    >
                      <PhoneOff className="h-4 w-4" />
                      <span>
                        {sessionMode === "listen-only"
                          ? "Finish Listening"
                          : "End Voice"}
                      </span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startSession()}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold bg-blue-700 hover:bg-blue-800 text-white transition-colors min-h-[46px] whitespace-nowrap"
                  >
                    {sessionMode === "listen-only" ? (
                      <Headphones className="h-4 w-4" />
                    ) : (
                      <Mic className="h-4 w-4" />
                    )}
                    <span>
                      {sessionMode === "listen-only"
                        ? "Start Silent Listen & Note"
                        : "Start Live Voice Session"}
                    </span>
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Right: Live Transcript, Auto-Marked Important Points & Revision Note */}
          <section className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl flex flex-col min-h-[460px] max-h-[660px]">
            <div className="px-6 py-4 border-b border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">
                    Live Transcript &amp; Study Note
                  </h2>
                  <p className="text-xs text-slate-500">
                    Important points are auto-marked — Study Notes, PDF &amp;
                    Print use only marked points
                  </p>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {savedNote &&
                  savedNoteSignatureRef.current === importantSignature ? (
                    <button
                      type="button"
                      onClick={() => onOpenNote(savedNote.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 whitespace-nowrap shrink-0"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Open Note</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        importantTranscripts.length === 0 || isGeneratingNote
                      }
                      onClick={() => void handleMakeStudyNote()}
                      title="Create Study Note from marked important points only"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0"
                    >
                      {isGeneratingNote ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <BookMarked className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {isGeneratingNote ? "Creating..." : "Make Study Note"}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={
                      importantTranscripts.length === 0 ||
                      isGeneratingNote ||
                      isExportingPdf
                    }
                    onClick={() => void handleExportVoiceNotePdf()}
                    title="Download formatted A4 PDF of important study points"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white transition-colors whitespace-nowrap shrink-0"
                  >
                    {isExportingPdf ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileDown className="h-3.5 w-3.5" />
                    )}
                    <span>{isExportingPdf ? "Exporting..." : "PDF"}</span>
                  </button>

                  <button
                    type="button"
                    disabled={
                      importantTranscripts.length === 0 || isGeneratingNote
                    }
                    onClick={() => void handlePrintVoiceNote()}
                    title="Print important study points sheet directly"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    <span>Print</span>
                  </button>
                </div>
              </div>

              {/* Filter bar + Listen to Revision quick control */}
              {transcripts.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="inline-flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setTranscriptFilter("all")}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        transcriptFilter === "all"
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      All ({transcripts.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setTranscriptFilter("important")}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                        transcriptFilter === "important"
                          ? "bg-amber-50 text-amber-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      <Star className="h-3 w-3 fill-amber-500 text-amber-500" />
                      <span>Important ({importantTranscripts.length})</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={
                      importantTranscripts.length === 0 || isGeneratingNote
                    }
                    onClick={() => void handleListenToRevision()}
                    title="Listen aloud to your marked revision note"
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                      isPlayingRevision
                        ? "bg-amber-50 border-amber-300 text-amber-900"
                        : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {isPlayingRevision ? (
                      <>
                        <VolumeX className="h-3.5 w-3.5 text-amber-700" />
                        <span>Stop Revision</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3.5 w-3.5 text-blue-700" />
                        <span>Listen Revision</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>

            {savedNote && (
              <div className="px-6 py-3 bg-emerald-50/70 border-b border-emerald-200 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-emerald-900 truncate">
                    Revision Note Ready: {savedNote.title}
                  </p>
                  <p className="text-xs text-emerald-800 truncate">
                    {savedNote.subject} · {savedNote.keyPoints.length} key
                    points · {savedNote.practiceQuestions.length} practice Qs
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenNote(savedNote.id)}
                  className="text-xs font-semibold text-emerald-900 underline underline-offset-2 hover:text-emerald-950 whitespace-nowrap shrink-0"
                >
                  Open for Revision
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {transcripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10 space-y-2">
                  <p className="text-sm font-medium text-slate-700">
                    Your spoken study points will appear here live.
                  </p>
                  <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                    Important points are{" "}
                    <strong className="text-slate-700">auto-marked</strong>{" "}
                    while you study. Click{" "}
                    <strong className="text-slate-700">Make Study Note</strong>{" "}
                    to turn only the important points into a revision sheet, or
                    use <strong className="text-slate-700">Listen Revision</strong>,{" "}
                    <strong className="text-slate-700">PDF</strong>, or{" "}
                    <strong className="text-slate-700">Print</strong> directly.
                  </p>
                </div>
              ) : visibleTranscripts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10 space-y-2">
                  <p className="text-sm font-medium text-slate-700">
                    No important points marked yet.
                  </p>
                  <p className="text-xs text-slate-500 max-w-xs leading-relaxed">
                    Switch to <strong className="text-slate-700">All</strong>{" "}
                    and click the star icon on any point you want saved for
                    revision.
                  </p>
                </div>
              ) : (
                visibleTranscripts.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-xl px-3.5 py-2.5 border transition-colors space-y-1 ${
                      item.isImportant
                        ? "bg-amber-50/60 border-amber-200"
                        : "bg-transparent border-transparent hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs text-slate-500 min-w-0">
                        <span
                          className={`font-semibold ${
                            item.speaker === "user"
                              ? "text-blue-700"
                              : "text-slate-900"
                          }`}
                        >
                          {item.speaker === "user"
                            ? profile.name
                            : "Jogi Jarvis"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {formatShortDate(item.timestamp)}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => toggleTranscriptImportant(item.id)}
                        title={
                          item.isImportant
                            ? "Marked as important for Study Note (click to unmark)"
                            : "Mark as important point for Study Note"
                        }
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          item.isImportant
                            ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
                            : "text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        <Star
                          className={`h-3 w-3 ${
                            item.isImportant
                              ? "fill-amber-500 text-amber-600"
                              : ""
                          }`}
                        />
                        <span>{item.isImportant ? "Important" : "Mark"}</span>
                      </button>
                    </div>
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {item.text}
                    </p>
                  </div>
                ))
              )}
              <div ref={transcriptEndRef} />
            </div>

            {/* Optional mid-call text follow-up or quick typed revision point */}
            <div className="px-4 py-3 border-t border-slate-200 bg-slate-50/70 rounded-b-2xl flex items-center gap-2">
              <input
                type="text"
                value={textNudge}
                disabled={status !== "connected" || isTurnProcessing}
                onChange={(e) => setTextNudge(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSendTextNudge();
                  }
                }}
                placeholder={
                  status === "connected"
                    ? sessionMode === "listen-only"
                      ? "Type an extra important point or formula to save for revision..."
                      : "Type a formula, spelling, or follow-up during voice chat..."
                    : "Start Talk & Ask or Listen Only to capture study points"
                }
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 disabled:opacity-60"
              />
              <button
                type="button"
                disabled={
                  status !== "connected" ||
                  isTurnProcessing ||
                  !textNudge.trim()
                }
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

      {/* Print-only formatted Study Note sheet for direct printing from Live Voice */}
      {savedNote && (
        <article className="hidden print:block max-w-3xl mx-auto p-8 text-slate-900 space-y-6">
          <header className="border-b border-slate-300 pb-4 space-y-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Jogi Jarvis Study Note · {savedNote.subject} · {savedNote.profileName}
            </p>
            <h1 className="text-2xl font-bold text-slate-900">
              {savedNote.title}
            </h1>
            <p className="text-xs text-slate-500">
              {formatShortDate(savedNote.createdAt)}
            </p>
          </header>

          {savedNote.summary && (
            <section className="space-y-1.5">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                Big Idea Summary
              </h2>
              <p className="text-sm leading-relaxed text-slate-800">
                {savedNote.summary}
              </p>
            </section>
          )}

          {savedNote.keyPoints.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                Key Points
              </h2>
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-800">
                {savedNote.keyPoints.map((pt, i) => (
                  <li key={i}>{pt}</li>
                ))}
              </ul>
            </section>
          )}

          {savedNote.definitions.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                Key Terms &amp; Formulas
              </h2>
              <div className="space-y-1.5 text-sm">
                {savedNote.definitions.map((d, i) => (
                  <p key={i}>
                    <strong className="font-semibold text-slate-900">
                      {d.term}:
                    </strong>{" "}
                    <span className="text-slate-800">{d.meaning}</span>
                  </p>
                ))}
              </div>
            </section>
          )}

          {savedNote.practiceQuestions.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-700">
                Practice Questions
              </h2>
              <ol className="list-decimal pl-5 space-y-2 text-sm text-slate-800">
                {savedNote.practiceQuestions.map((pq, i) => (
                  <li key={i}>
                    <p className="font-medium text-slate-900">{pq.question}</p>
                    <p className="text-slate-700">Answer: {pq.answer}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {savedNote.teacherTip && (
            <section className="border-t border-slate-200 pt-3">
              <p className="text-sm text-slate-800">
                <strong className="font-semibold">Teacher&apos;s Tip:</strong>{" "}
                {savedNote.teacherTip}
              </p>
            </section>
          )}
        </article>
      )}
    </div>
  );
}
