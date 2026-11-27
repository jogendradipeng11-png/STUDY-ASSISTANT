import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileDown,
  Languages,
  Loader2,
  Plus,
  Printer,
  Search,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import type { FamilyProfile, StudyNote } from "../types";
import { LANGUAGE_OPTIONS, SUBJECT_LIST } from "../data/defaults";
import { formatShortDate, noteToMarkdown } from "../utils/storage";
import { exportStudyNotesToPdf } from "../utils/pdfExport";
import { LanguagePicker } from "./LanguagePicker";
import {
  StudyMediaQuickButtons,
  StudyMediaStudioModal,
  type StudyMediaMode,
} from "./StudyMediaStudioModal";
import {
  getSavedLocalModelKey,
  isLocalBrowserEnginePreferred,
} from "../utils/localLlm";
import { generateLocalStudyNote } from "../utils/localStudyMedia";

interface StudyNotesViewProps {
  notes: StudyNote[];
  profiles: FamilyProfile[];
  activeProfile: FamilyProfile;
  selectedNoteId: string | null;
  onSelectNote: (id: string | null) => void;
  onAddNote: (note: StudyNote) => void;
  onUpdateNote: (note: StudyNote) => void;
  onDeleteNote: (id: string) => void;
  onOpenInReader?: (text: string, language?: string) => void;
}

interface QuizFeedback {
  isCorrect: boolean;
  feedback: string;
  hint?: string;
}

export function StudyNotesView({
  notes,
  profiles,
  activeProfile,
  selectedNoteId,
  onSelectNote,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onOpenInReader,
}: StudyNotesViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filterProfileId, setFilterProfileId] = useState<string>("all");
  const [filterSubject, setFilterSubject] = useState<string>("All Subjects");

  // New AI Note creator
  const [showCreator, setShowCreator] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newSubject, setNewSubject] = useState("Science");
  const [newTargetProfileId, setNewTargetProfileId] = useState(activeProfile.id);
  const [newNoteLanguage, setNewNoteLanguage] = useState(
    activeProfile.preferredLanguage || "Auto-Detect"
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [exportingPdfMode, setExportingPdfMode] = useState<
    "single" | "all" | null
  >(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Interactive self-test quiz state
  const [revealedAnswers, setRevealedAnswers] = useState<Record<string, boolean>>({});
  const [studentAnswers, setStudentAnswers] = useState<Record<string, string>>({});
  const [quizFeedback, setQuizFeedback] = useState<Record<string, QuizFeedback>>({});
  const [checkingIdx, setCheckingIdx] = useState<number | null>(null);

  // Audio summary playback
  const [isReadingAloud, setIsReadingAloud] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Free Search / Picture / Video Studio modal
  const [mediaStudio, setMediaStudio] = useState<{
    isOpen: boolean;
    mode: StudyMediaMode;
    prompt: string;
    autoRun: boolean;
  }>({
    isOpen: false,
    mode: "picture",
    prompt: "",
    autoRun: false,
  });

  const openMediaStudio = (mode: StudyMediaMode, customTopic?: string) => {
    const topic = (
      customTopic ??
      (activeNote ? `${activeNote.title} (${activeNote.subject})` : searchQuery)
    ).trim();
    setMediaStudio({
      isOpen: true,
      mode,
      prompt: topic,
      autoRun: Boolean(topic),
    });
  };

  useEffect(() => {
    setNewTargetProfileId(activeProfile.id);
  }, [activeProfile.id]);

  useEffect(() => {
    setRevealedAnswers({});
    setStudentAnswers({});
    setQuizFeedback({});
    stopReadingAloud();
  }, [selectedNoteId]);

  useEffect(() => {
    return () => {
      stopReadingAloud();
    };
  }, []);

  const stopReadingAloud = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setIsReadingAloud(false);
  };

  const filteredNotes = useMemo(() => {
    return notes.filter((n) => {
      if (filterProfileId !== "all" && n.profileId !== filterProfileId) {
        return false;
      }
      if (
        filterSubject !== "All Subjects" &&
        n.subject.toLowerCase() !== filterSubject.toLowerCase()
      ) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = [
          n.title,
          n.subject,
          n.profileName,
          n.summary,
          ...n.keyPoints,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [notes, filterProfileId, filterSubject, searchQuery]);

  const activeNote =
    notes.find((n) => n.id === selectedNoteId) || filteredNotes[0] || null;

  const handleGenerateTopicNote = async () => {
    if (!newTopic.trim() || isGenerating) return;
    setIsGenerating(true);
    setErrorMsg(null);

    try {
      const targetProfile =
        profiles.find((p) => p.id === newTargetProfileId) || activeProfile;
      const isOfflineNow =
        typeof navigator !== "undefined" && !navigator.onLine;
      const preferLocal = isOfflineNow || isLocalBrowserEnginePreferred();
      const targetLang =
        newNoteLanguage || targetProfile.preferredLanguage || "Auto-Detect";

      let created: StudyNote | null = null;

      if (!preferLocal) {
        try {
          const res = await fetch("/api/notes/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              topicHint: newTopic.trim(),
              profile: targetProfile,
              subject: newSubject,
              language: targetLang,
            }),
          });

          const data = await res.json();
          if (res.ok && data.note) {
            const now = new Date().toISOString();
            created = {
              id: `note-topic-${Date.now()}`,
              profileId: targetProfile.id,
              profileName: targetProfile.name,
              title: data.note.title || newTopic.trim().slice(0, 60),
              subject: data.note.subject || newSubject,
              summary: data.note.summary || "",
              keyPoints: Array.isArray(data.note.keyPoints)
                ? data.note.keyPoints
                : [],
              definitions: Array.isArray(data.note.definitions)
                ? data.note.definitions
                : [],
              practiceQuestions: Array.isArray(data.note.practiceQuestions)
                ? data.note.practiceQuestions
                : [],
              teacherTip: data.note.teacherTip || "",
              createdAt: now,
              updatedAt: now,
              sourceMode: "topic",
            };
          }
        } catch {
          // Fall through to on-device Local LLM / offline note generator
        }
      }

      if (!created) {
        created = await generateLocalStudyNote({
          topic: newTopic.trim(),
          profile: targetProfile,
          subject: newSubject,
          language: targetLang,
          modelKey: getSavedLocalModelKey(),
        });
      }

      onAddNote(created);
      onSelectNote(created.id);
      setNewTopic("");
      setShowCreator(false);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Failed to generate AI note."
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReadNoteAloud = async (note: StudyNote) => {
    if (isReadingAloud) {
      stopReadingAloud();
      return;
    }
    stopReadingAloud();
    setIsLoadingAudio(true);
    setErrorMsg(null);

    try {
      const owner =
        profiles.find((p) => p.id === note.profileId) || activeProfile;
      const narration = [
        `${note.title}.`,
        note.summary,
        ...note.keyPoints.slice(0, 5),
        note.teacherTip || "",
      ]
        .filter(Boolean)
        .join(" ");

      const speakOffline = (): boolean => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) {
          return false;
        }
        try {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(narration.slice(0, 2200));
          utter.volume = 1.0;
          utter.rate = 0.96;
          utter.onend = () => setIsReadingAloud(false);
          utter.onerror = () => setIsReadingAloud(false);
          setIsReadingAloud(true);
          window.speechSynthesis.speak(utter);
          return true;
        } catch {
          return false;
        }
      };

      if (typeof navigator !== "undefined" && !navigator.onLine) {
        if (!speakOffline()) {
          throw new Error("Offline voice synthesis is unavailable in this browser.");
        }
        return;
      }

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: narration,
            voiceName: owner.voiceName,
            role: owner.role,
            language: owner.preferredLanguage || "Auto-Detect",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.audioBase64) {
          throw new Error(data.error || "Could not generate voice summary.");
        }

        const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
        audio.muted = false;
        audio.volume = 1.0;
        audioRef.current = audio;
        setIsReadingAloud(true);
        audio.onended = () => {
          setIsReadingAloud(false);
          audioRef.current = null;
        };
        audio.onerror = () => {
          setIsReadingAloud(false);
          audioRef.current = null;
        };
        await audio.play();
      } catch {
        if (!speakOffline()) {
          throw new Error("Audio playback failed.");
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Audio playback failed.");
    } finally {
      setIsLoadingAudio(false);
    }
  };

  const handleCheckPracticeAnswer = async (
    note: StudyNote,
    idx: number,
    question: string,
    expectedAnswer: string
  ) => {
    const key = `${note.id}-${idx}`;
    const studentAnswer = (studentAnswers[key] || "").trim();
    if (!studentAnswer) return;

    setCheckingIdx(idx);
    setErrorMsg(null);

    try {
      const owner =
        profiles.find((p) => p.id === note.profileId) || activeProfile;
      const res = await fetch("/api/quiz/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          expectedAnswer,
          studentAnswer,
          profile: owner,
          language: owner.preferredLanguage || "Auto-Detect",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not check answer.");
      }
      setQuizFeedback((prev) => ({ ...prev, [key]: data }));
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Answer check failed.");
    } finally {
      setCheckingIdx(null);
    }
  };

  const handleDownloadMarkdown = (note: StudyNote) => {
    const md = noteToMarkdown(note);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${note.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "study-note"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = async (
    targetNotes: StudyNote[],
    mode: "single" | "all"
  ) => {
    if (targetNotes.length === 0 || exportingPdfMode) return;
    setExportingPdfMode(mode);
    setErrorMsg(null);
    try {
      await exportStudyNotesToPdf(
        targetNotes,
        mode === "all"
          ? `jogi-jarvis-all-study-notes-${targetNotes.length}.pdf`
          : undefined
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not export study notes to PDF."
      );
    } finally {
      setExportingPdfMode(null);
    }
  };

  const handleTranslateNote = async (
    note: StudyNote,
    targetLanguage: string
  ) => {
    if (!targetLanguage || isTranslating) return;
    setIsTranslating(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/notes/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetLanguage,
          note: {
            title: note.title,
            subject: note.subject,
            summary: note.summary,
            keyPoints: note.keyPoints,
            definitions: note.definitions,
            practiceQuestions: note.practiceQuestions,
            teacherTip: note.teacherTip,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.note) {
        throw new Error(data.error || "Could not translate this study note.");
      }

      const now = new Date().toISOString();
      const translatedNote: StudyNote = {
        id: `note-tr-${Date.now()}`,
        profileId: note.profileId,
        profileName: note.profileName,
        title: data.note.title || `${note.title} (${targetLanguage})`,
        subject: data.note.subject || note.subject,
        summary: data.note.summary || note.summary,
        keyPoints: Array.isArray(data.note.keyPoints)
          ? data.note.keyPoints
          : note.keyPoints,
        definitions: Array.isArray(data.note.definitions)
          ? data.note.definitions
          : note.definitions,
        practiceQuestions: Array.isArray(data.note.practiceQuestions)
          ? data.note.practiceQuestions
          : note.practiceQuestions,
        teacherTip: data.note.teacherTip || note.teacherTip,
        createdAt: now,
        updatedAt: now,
        sourceMode: note.sourceMode,
      };

      onAddNote(translatedNote);
      onSelectNote(translatedNote.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Note translation failed."
      );
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100vh-4rem)] bg-[#F8FAFC]">
      {/* Left Note Directory */}
      <div className="no-print w-full lg:w-88 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col lg:h-[calc(100vh-4rem)] lg:sticky lg:top-16">
        <div className="p-4 border-b border-slate-200 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-bold text-slate-900">Study Notes</h1>
            <div className="flex items-center gap-1.5 shrink-0">
              {notes.length > 0 && (
                <button
                  type="button"
                  disabled={exportingPdfMode !== null}
                  onClick={() =>
                    void handleExportPdf(
                      filteredNotes.length > 0 ? filteredNotes : notes,
                      "all"
                    )
                  }
                  title={
                    filteredNotes.length !== notes.length
                      ? `Export ${filteredNotes.length} filtered notes to a printable PDF`
                      : `Export all ${notes.length} study notes to a printable PDF`
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {exportingPdfMode === "all" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileDown className="h-3.5 w-3.5" />
                  )}
                  <span className="tabular-nums">
                    {exportingPdfMode === "all"
                      ? "PDF..."
                      : `All PDF (${
                          filteredNotes.length > 0
                            ? filteredNotes.length
                            : notes.length
                        })`}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowCreator((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-700 hover:bg-blue-800 text-white transition-colors whitespace-nowrap shrink-0"
              >
                {showCreator ? (
                  <X className="h-3.5 w-3.5" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span>{showCreator ? "Close" : "New Note"}</span>
              </button>
            </div>
          </div>

          {/* Search input */}
          <div className="relative">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes, formulas, topics..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600"
            />
          </div>

          {/* Profile filter tabs */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            <button
              type="button"
              onClick={() => setFilterProfileId("all")}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filterProfileId === "all"
                  ? "bg-white text-slate-900 shadow-xs"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              All
            </button>
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setFilterProfileId(p.id)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  filterProfileId === p.id
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {p.name.split(" ")[0]}
              </button>
            ))}
          </div>

          {/* Subject filter */}
          <select
            aria-label="Filter by subject"
            value={filterSubject}
            onChange={(e) => setFilterSubject(e.target.value)}
            className="w-full text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-600"
          >
            {SUBJECT_LIST.map((sub) => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>

          {/* Direct Free Search / Picture / Video triggers */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[11px] font-semibold text-slate-500">
              Free Media
            </span>
            <StudyMediaQuickButtons
              compact
              onOpen={(mode) => openMediaStudio(mode)}
            />
          </div>
        </div>

        {/* Inline AI Note Generator Drawer */}
        {showCreator && (
          <div className="p-4 bg-slate-50 border-b border-slate-200 space-y-3">
            <p className="text-xs font-semibold text-slate-900">
              Generate AI Study Notes from any topic or chapter
            </p>
            <textarea
              rows={3}
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              placeholder="e.g. Newton's 3 Laws of Motion with simple examples, OR paste textbook paragraphs..."
              className="w-full p-2.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                value={newTargetProfileId}
                onChange={(e) => setNewTargetProfileId(e.target.value)}
                className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-800"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    For: {p.name}
                  </option>
                ))}
              </select>
              <select
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-slate-800"
              >
                {SUBJECT_LIST.filter((s) => s !== "All Subjects").map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-600">
                Note Language
              </span>
              <LanguagePicker
                compact
                value={newNoteLanguage}
                onChange={setNewNoteLanguage}
              />
            </div>
            <button
              type="button"
              disabled={isGenerating || !newTopic.trim()}
              onClick={() => void handleGenerateTopicNote()}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-40 text-white text-xs font-semibold transition-colors"
            >
              {isGenerating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>
                {isGenerating ? "Writing AI Study Notes..." : "Create Study Note"}
              </span>
            </button>
          </div>
        )}

        {/* Saved Notes Hairline List */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {filteredNotes.length === 0 ? (
            <div className="p-6 text-center space-y-2">
              <p className="text-sm font-medium text-slate-700">
                No matching study notes
              </p>
              <p className="text-xs text-slate-500">
                Click New AI Note above or save any lesson from Assistant or Live
                Voice.
              </p>
            </div>
          ) : (
            filteredNotes.map((note) => {
              const isSelected = activeNote?.id === note.id;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => onSelectNote(note.id)}
                  className={`w-full text-left px-4 py-3.5 transition-colors block ${
                    isSelected ? "bg-blue-50/70" : "hover:bg-slate-50"
                  }`}
                >
                  <p
                    className={`text-sm font-semibold leading-snug line-clamp-2 ${
                      isSelected ? "text-blue-950" : "text-slate-900"
                    }`}
                  >
                    {note.title}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500 truncate">
                    <span>{note.subject}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{note.profileName}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums shrink-0">
                      {formatShortDate(note.createdAt)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right Full Study Sheet */}
      <div className="flex-1 p-5 sm:p-8 lg:p-10 overflow-y-auto">
        {errorMsg && (
          <div className="max-w-3xl mx-auto mb-5 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-800 flex items-center justify-between">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="font-semibold hover:underline"
            >
              Close
            </button>
          </div>
        )}

        {!activeNote ? (
          <div className="max-w-xl mx-auto py-16 text-center space-y-4">
            <h2 className="text-xl font-bold text-slate-900">
              Select or create a study note
            </h2>
            <p className="text-sm text-slate-600">
              Jogi Jarvis turns every study question, textbook photo, and spoken
              lesson into structured notes with key definitions and self-test
              practice questions.
            </p>
            <button
              type="button"
              onClick={() => setShowCreator(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold"
            >
              <Plus className="h-4 w-4" />
              <span>Create First AI Note</span>
            </button>
          </div>
        ) : (
          <article className="max-w-3xl mx-auto bg-white border border-slate-200 rounded-2xl p-6 sm:p-10 space-y-8">
            {/* Note Header */}
            <header className="space-y-4 pb-6 border-b border-slate-200">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-semibold text-blue-700">
                    {activeNote.subject}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{activeNote.profileName}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">
                    {new Date(activeNote.createdAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>

                <div className="no-print flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={isLoadingAudio}
                    onClick={() => void handleReadNoteAloud(activeNote)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors whitespace-nowrap"
                  >
                    {isLoadingAudio ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isReadingAloud ? (
                      <Square className="h-3.5 w-3.5 fill-blue-700 text-blue-700" />
                    ) : (
                      <Volume2 className="h-3.5 w-3.5" />
                    )}
                    <span>{isReadingAloud ? "Stop Audio" : "Listen"}</span>
                  </button>

                  {onOpenInReader && (
                    <button
                      type="button"
                      onClick={() => {
                        const owner =
                          profiles.find((p) => p.id === activeNote.profileId) ||
                          activeProfile;
                        const fullText = [
                          `${activeNote.title}.`,
                          activeNote.summary,
                          ...activeNote.keyPoints,
                          ...activeNote.definitions.map(
                            (d) => `${d.term}: ${d.meaning}.`
                          ),
                          activeNote.teacherTip
                            ? `Teacher Tip: ${activeNote.teacherTip}`
                            : "",
                        ]
                          .filter(Boolean)
                          .join("\n\n");
                        onOpenInReader(fullText, owner.preferredLanguage);
                      }}
                      title="Open this note in Read Aloud Studio with sentence highlighting and speed control"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-blue-50 hover:bg-blue-100 text-blue-800 transition-colors whitespace-nowrap"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      <span>Read Tab</span>
                    </button>
                  )}

                  <StudyMediaQuickButtons
                    compact
                    onOpen={(mode) =>
                      openMediaStudio(
                        mode,
                        `${activeNote.title} (${activeNote.subject})`
                      )
                    }
                  />

                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700">
                    {isTranslating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                    ) : (
                      <Languages className="h-3.5 w-3.5 text-slate-500" />
                    )}
                    <select
                      aria-label="Translate this study note into another language"
                      disabled={isTranslating}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          void handleTranslateNote(activeNote, e.target.value);
                        }
                      }}
                      className="bg-transparent text-xs font-medium text-slate-700 focus:outline-none cursor-pointer"
                    >
                      <option value="">
                        {isTranslating ? "Translating..." : "Translate Note"}
                      </option>
                      {LANGUAGE_OPTIONS.filter(
                        (l) => l.id !== "Auto-Detect"
                      ).map((lang) => (
                        <option key={lang.id} value={lang.id}>
                          {lang.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    disabled={exportingPdfMode !== null}
                    onClick={() => void handleExportPdf([activeNote], "single")}
                    title="Export this study note as a formatted PDF for printing"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
                  >
                    {exportingPdfMode === "single" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileDown className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {exportingPdfMode === "single"
                        ? "Exporting..."
                        : "Export PDF"}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadMarkdown(activeNote)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors whitespace-nowrap"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Export .md</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-200 hover:bg-slate-50 text-slate-700 transition-colors whitespace-nowrap"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    <span>Print</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteNote(activeNote.id)}
                    aria-label="Delete study note"
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <input
                type="text"
                aria-label="Study note title"
                value={activeNote.title}
                onChange={(e) =>
                  onUpdateNote({
                    ...activeNote,
                    title: e.target.value,
                    updatedAt: new Date().toISOString(),
                  })
                }
                className="w-full font-display text-2xl sm:text-3xl font-bold text-slate-950 tracking-tight bg-transparent focus:outline-none focus:bg-slate-50 rounded px-1 -mx-1"
              />
            </header>

            {/* 01. The Big Idea */}
            <section className="space-y-2.5">
              <h2 className="text-sm font-semibold text-slate-900">
                01. The Big Idea
              </h2>
              <p className="text-sm sm:text-base text-slate-700 leading-relaxed">
                {activeNote.summary}
              </p>
            </section>

            {/* 02. Key Takeaways */}
            {activeNote.keyPoints.length > 0 && (
              <section className="space-y-3 pt-6 border-t border-slate-100">
                <h2 className="text-sm font-semibold text-slate-900">
                  02. Key Takeaways
                </h2>
                <ul className="space-y-2.5">
                  {activeNote.keyPoints.map((pt, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-3 text-sm sm:text-[15px] text-slate-800 leading-relaxed"
                    >
                      <span className="font-mono text-xs font-medium text-slate-400 tabular-nums mt-1 shrink-0">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span>{pt}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* 03. Key Terms & Formulas */}
            {activeNote.definitions.length > 0 && (
              <section className="space-y-3 pt-6 border-t border-slate-100">
                <h2 className="text-sm font-semibold text-slate-900">
                  03. Key Terms &amp; Formulas
                </h2>
                <div className="divide-y divide-slate-100 border-t border-b border-slate-200">
                  {activeNote.definitions.map((def, i) => (
                    <div
                      key={i}
                      className="py-3 grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-4"
                    >
                      <div className="sm:col-span-4 font-mono text-xs sm:text-sm font-medium text-slate-900 break-words">
                        {def.term}
                      </div>
                      <div className="sm:col-span-8 text-sm text-slate-700 leading-relaxed">
                        {def.meaning}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* 04. Interactive Practice Self-Test */}
            {activeNote.practiceQuestions.length > 0 && (
              <section className="space-y-4 pt-6 border-t border-slate-100">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    04. Practice &amp; Self-Check
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Try answering in your own words and let Jogi Jarvis check
                    your understanding.
                  </p>
                </div>

                <div className="space-y-5 divide-y divide-slate-100">
                  {activeNote.practiceQuestions.map((pq, idx) => {
                    const key = `${activeNote.id}-${idx}`;
                    const isRevealed = !!revealedAnswers[key];
                    const fb = quizFeedback[key];

                    return (
                      <div key={key} className="pt-4 first:pt-0 space-y-3">
                        <p className="text-sm font-semibold text-slate-900">
                          <span className="font-mono text-xs text-slate-400 mr-2 tabular-nums">
                            Q{idx + 1}.
                          </span>
                          {pq.question}
                        </p>

                        <div className="no-print flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={studentAnswers[key] || ""}
                            onChange={(e) =>
                              setStudentAnswers((prev) => ({
                                ...prev,
                                [key]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void handleCheckPracticeAnswer(
                                  activeNote,
                                  idx,
                                  pq.question,
                                  pq.answer
                                );
                              }
                            }}
                            placeholder="Write your answer here to test yourself..."
                            className="flex-1 text-xs sm:text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:border-blue-600"
                          />
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={
                                checkingIdx === idx ||
                                !(studentAnswers[key] || "").trim()
                              }
                              onClick={() =>
                                void handleCheckPracticeAnswer(
                                  activeNote,
                                  idx,
                                  pq.question,
                                  pq.answer
                                )
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                            >
                              {checkingIdx === idx ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              <span>Check</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setRevealedAnswers((prev) => ({
                                  ...prev,
                                  [key]: !prev[key],
                                }))
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-medium transition-colors whitespace-nowrap"
                            >
                              {isRevealed ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                              <span>{isRevealed ? "Hide" : "Answer"}</span>
                            </button>
                          </div>
                        </div>

                        {fb && (
                          <div
                            className={`rounded-lg px-3.5 py-2.5 text-xs sm:text-sm border ${
                              fb.isCorrect
                                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                                : "bg-amber-50 border-amber-200 text-amber-950"
                            }`}
                          >
                            <p className="font-semibold">
                              {fb.isCorrect ? "Well done" : "Almost there"} —{" "}
                              <span className="font-normal">{fb.feedback}</span>
                            </p>
                            {fb.hint && (
                              <p className="mt-1 text-xs opacity-85">
                                Tip: {fb.hint}
                              </p>
                            )}
                          </div>
                        )}

                        {isRevealed && (
                          <div className="bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs sm:text-sm text-slate-700">
                            <span className="font-semibold text-slate-900">
                              Answer:{" "}
                            </span>
                            {pq.answer}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Teacher's Revision Tip */}
            {activeNote.teacherTip && (
              <section className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-4 sm:p-5 space-y-1">
                <h2 className="text-xs font-semibold text-amber-900">
                  Teacher&apos;s Revision Tip
                </h2>
                <p className="text-sm text-amber-950 leading-relaxed">
                  {activeNote.teacherTip}
                </p>
              </section>
            )}
          </article>
        )}
      </div>

      <StudyMediaStudioModal
        isOpen={mediaStudio.isOpen}
        initialMode={mediaStudio.mode}
        initialPrompt={mediaStudio.prompt}
        autoRun={mediaStudio.autoRun}
        profile={
          (activeNote &&
            profiles.find((p) => p.id === activeNote.profileId)) ||
          activeProfile
        }
        subject={activeNote?.subject}
        language={
          (activeNote &&
            profiles.find((p) => p.id === activeNote.profileId)
              ?.preferredLanguage) ||
          activeProfile.preferredLanguage ||
          "Auto-Detect"
        }
        contextLabel="Study Notes"
        onClose={() =>
          setMediaStudio((prev) => ({ ...prev, isOpen: false }))
        }
      />
    </div>
  );
}
