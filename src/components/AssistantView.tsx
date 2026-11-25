import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookMarked,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  ImagePlus,
  Loader2,
  Mic,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import type { ChatMessage, FamilyProfile, StudyNote } from "../types";
import { STARTER_PROMPTS } from "../data/defaults";
import { blobToBase64 } from "../utils/audio";
import { formatShortDate } from "../utils/storage";
import {
  generateStudySummaryFromSession,
  isLongStudySession,
} from "../utils/studySummary";
import { LanguagePicker } from "./LanguagePicker";
import { ProfileAvatar } from "./ProfileAvatar";

interface AssistantViewProps {
  profile: FamilyProfile;
  subject: string;
  messages: ChatMessage[];
  autoNoteEnabled: boolean;
  onUpdateMessages: (profileId: string, messages: ChatMessage[]) => void;
  onChangeLanguage: (language: string) => void;
  onSaveNote: (note: StudyNote) => void;
  onOpenNote: (noteId: string) => void;
  onOpenLiveVoice: () => void;
}

export function AssistantView({
  profile,
  subject,
  messages,
  autoNoteEnabled,
  onUpdateMessages,
  onChangeLanguage,
  onSaveNote,
  onOpenNote,
  onOpenLiveVoice,
}: AssistantViewProps) {
  const activeLanguage = profile.preferredLanguage || "Auto-Detect";
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [speedMode, setSpeedMode] = useState<"fast" | "detailed">("fast");
  const [useSearch, setUseSearch] = useState(profile.role === "parent");
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Voice dictation state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Photo / homework attachment state
  const [attachedImage, setAttachedImage] = useState<{
    dataUrl: string;
    base64: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // TTS audio playback state
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [loadingTtsId, setLoadingTtsId] = useState<string | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  // Study note creation state
  const [savingNoteForId, setSavingNoteForId] = useState<string | null>(null);
  const [savingSessionNote, setSavingSessionNote] = useState(false);
  const [generatingStudySummary, setGeneratingStudySummary] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; noteId?: string } | null>(
    null
  );

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setUseSearch(profile.role === "parent");
    setErrorMsg(null);
  }, [profile.id, profile.role]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isSending]);

  useEffect(() => {
    return () => {
      stopPlayback();
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

  const stopPlayback = () => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }
    setSpeakingMessageId(null);
  };

  const speakText = async (messageId: string, text: string) => {
    if (speakingMessageId === messageId) {
      stopPlayback();
      return;
    }
    stopPlayback();
    setLoadingTtsId(messageId);
    setErrorMsg(null);

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceName: profile.voiceName,
          role: profile.role,
          language: activeLanguage,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not generate speech audio.");
      }

      const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
      audioElRef.current = audio;
      setSpeakingMessageId(messageId);
      audio.onended = () => {
        setSpeakingMessageId(null);
        audioElRef.current = null;
      };
      audio.onerror = () => {
        setSpeakingMessageId(null);
        audioElRef.current = null;
      };
      await audio.play();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Audio playback failed.");
    } finally {
      setLoadingTtsId(null);
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

  const handleSend = async (overrideText?: string) => {
    const promptText = (overrideText ?? input).trim();
    if ((!promptText && !attachedImage) || isSending) return;

    setErrorMsg(null);
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

    const nextMessages = [...messages, userMsg];
    onUpdateMessages(profile.id, nextMessages);
    setInput("");
    setAttachedImage(null);
    setIsSending(true);

    try {
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
          useSearch,
          language: activeLanguage,
          speedMode,
          stream: true,
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
      };

      const updatedMessages = [...nextMessages, assistantMsg];
      onUpdateMessages(profile.id, updatedMessages);

      if (autoSpeak) {
        void speakText(assistantMsg.id, assistantMsg.content);
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
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Something went wrong reaching Jogi Jarvis."
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleToggleVoiceDictation = async () => {
    setErrorMsg(null);

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

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
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        if (blob.size < 200) return;

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
            setInput((prev) =>
              prev ? `${prev} ${data.transcript}` : data.transcript
            );
            textareaRef.current?.focus();
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

          <button
            type="button"
            onClick={() => setUseSearch((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
              useSearch
                ? "bg-blue-50 border-blue-200 text-blue-800"
                : "bg-white border-slate-200 text-slate-600 hover:text-slate-900"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            <span>{useSearch ? "Web Search On" : "Web Search Off"}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (autoSpeak) stopPlayback();
              setAutoSpeak((v) => !v);
            }}
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
        <div className="bg-red-50 border-b border-red-200 px-6 py-2.5 text-xs font-medium text-red-800 flex items-center justify-between gap-4">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-red-700 hover:text-red-900 shrink-0"
          >
            Close
          </button>
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
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-100 transition-colors whitespace-nowrap"
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

                          {msg.noteSavedId ? (
                            <button
                              type="button"
                              onClick={() => onOpenNote(msg.noteSavedId!)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors whitespace-nowrap"
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
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap"
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
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 transition-colors whitespace-nowrap"
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
                  <span>Jogi Jarvis is thinking...</span>
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
    </div>
  );
}
