import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  BookOpen,
  Check,
  ImagePlus,
  Languages,
  Loader2,
  Mic,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import type { FamilyProfile, StudyNote, VoiceName } from "../types";
import { VOICE_OPTIONS } from "../data/defaults";
import { blobToBase64 } from "../utils/audio";
import { LanguagePicker } from "./LanguagePicker";
import { ProfileAvatar } from "./ProfileAvatar";
import {
  StudyMediaQuickButtons,
  StudyMediaStudioModal,
  type StudyMediaMode,
} from "./StudyMediaStudioModal";

interface ReadAloudViewProps {
  profile: FamilyProfile;
  notes: StudyNote[];
  initialText?: string;
  initialLanguage?: string;
  autoStartSignal?: number;
  onChangeLanguage: (language: string) => void;
  onSaveNote: (note: StudyNote) => void;
  onOpenNote: (noteId: string) => void;
  onStudySessionComplete?: (profileId: string, reason?: string) => void;
}

type ReadingMode = "exact" | "translate" | "explain";

const SAMPLE_PASSAGES: Array<{ label: string; language: string; text: string }> = [
  {
    label: "Science (English)",
    language: "English",
    text: "Photosynthesis is the process by which green plants use sunlight, water, and carbon dioxide to make their own food. Chlorophyll in the leaves absorbs sunlight and converts it into chemical energy, releasing oxygen into the air.",
  },
  {
    label: "Odia Practice (ଓଡ଼ିଆ)",
    language: "Odia",
    text: "ବିଦ୍ୟା ହେଉଛି ମଣିଷର ସବୁଠାରୁ ବଡ଼ ଧନ। ନିୟମିତ ଅଭ୍ୟାସ ଏବଂ ମନଯୋଗ ଦେଇ ପଢ଼ିଲେ ପ୍ରତ୍ୟେକ ବିଷୟ ସହଜ ହୋଇଯାଏ।",
  },
  {
    label: "Hindi Practice (हिन्दी)",
    language: "Hindi",
    text: "नियमित अभ्यास और ध्यान से पढ़ने पर कठिन से कठिन विषय भी आसान हो जाता है। रोज़ थोड़ा-थोड़ा दोहराने से याददाश्त मजबूत होती है।",
  },
];

function splitIntoSentences(raw: string): string[] {
  const cleaned = raw.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  const paragraphs = cleaned
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const sentences: string[] = [];
  for (const para of paragraphs) {
    // Split on English (. ! ?), Hindi/Odia danda (। ॥), or CJK punctuation
    const parts = para.match(/[^.!?।॥。！？]+[.!?।॥。！？]*\s*/g);
    if (!parts) {
      sentences.push(para);
      continue;
    }
    for (const part of parts) {
      const s = part.trim();
      if (s) sentences.push(s);
    }
  }
  return sentences;
}

function getSpeechLangCode(language: string): string {
  const map: Record<string, string> = {
    English: "en-IN",
    Hindi: "hi-IN",
    Odia: "or-IN",
    Bengali: "bn-IN",
    Tamil: "ta-IN",
    Telugu: "te-IN",
    Marathi: "mr-IN",
    Gujarati: "gu-IN",
    Kannada: "kn-IN",
    Malayalam: "ml-IN",
    Punjabi: "pa-IN",
    Urdu: "ur-IN",
    Spanish: "es-ES",
    French: "fr-FR",
    German: "de-DE",
    Japanese: "ja-JP",
    Korean: "ko-KR",
    Arabic: "ar-SA",
    Chinese: "zh-CN",
  };
  return map[language] || "en-IN";
}

export function ReadAloudView({
  profile,
  notes,
  initialText = "",
  initialLanguage,
  autoStartSignal = 0,
  onChangeLanguage,
  onSaveNote,
  onOpenNote,
  onStudySessionComplete,
}: ReadAloudViewProps) {
  const [sourceText, setSourceText] = useState(initialText);
  const [preparedText, setPreparedText] = useState("");
  const [readLanguage, setReadLanguage] = useState<string>(
    initialLanguage || profile.preferredLanguage || "Auto-Detect"
  );
  const [voiceName, setVoiceName] = useState<VoiceName>(profile.voiceName);
  const [mode, setMode] = useState<ReadingMode>("exact");
  const [speed, setSpeed] = useState<number>(
    profile.role === "student" ? 0.9 : 1.0
  );

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [activeSentenceIdx, setActiveSentenceIdx] = useState<number | null>(
    null
  );

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

  // Prepare / OCR / Voice capture / Note save states
  const [isPreparing, setIsPreparing] = useState(false);
  const [isScanningPhoto, setIsScanningPhoto] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackRunIdRef = useRef(0);
  const prefetchCacheRef = useRef<Map<string, Promise<string | null>>>(
    new Map()
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const lastSignalRef = useRef(0);

  const activeText = useMemo(
    () => (mode === "exact" ? sourceText : preparedText || sourceText),
    [mode, preparedText, sourceText]
  );

  const sentences = useMemo(() => splitIntoSentences(activeText), [activeText]);

  useEffect(() => {
    setVoiceName(profile.voiceName);
  }, [profile.voiceName]);

  useEffect(() => {
    if (initialLanguage) {
      setReadLanguage(initialLanguage);
    }
  }, [initialLanguage]);

  const stopReading = useCallback(() => {
    playbackRunIdRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setIsPlaying(false);
    setIsPaused(false);
    setIsLoadingAudio(false);
    setActiveSentenceIdx(null);
  }, []);

  useEffect(() => {
    return () => {
      stopReading();
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, [stopReading]);

  const fetchSentenceAudio = useCallback(
    async (
      sentence: string,
      lang: string,
      voice: VoiceName,
      currentSpeed: number,
      currentMode: ReadingMode
    ): Promise<string | null> => {
      const cacheKey = `${lang}|${voice}|${currentMode}|${currentSpeed <= 0.85 ? "slow" : "norm"}|${sentence}`;
      const existing = prefetchCacheRef.current.get(cacheKey);
      if (existing) return existing;

      const req = fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: sentence,
          voiceName: voice,
          role: profile.role,
          language: lang,
          readingStyle:
            currentSpeed <= 0.85
              ? "slow"
              : currentMode === "explain"
                ? "explain"
                : "normal",
        }),
      })
        .then(async (res) => {
          if (!res.ok) return null;
          const data = (await res.json()) as { audioBase64?: string };
          return data.audioBase64 || null;
        })
        .catch(() => null);

      prefetchCacheRef.current.set(cacheKey, req);
      if (prefetchCacheRef.current.size > 40) {
        const firstKey = prefetchCacheRef.current.keys().next().value;
        if (firstKey) prefetchCacheRef.current.delete(firstKey);
      }
      return req;
    },
    [profile.role]
  );

  const speakWithBrowserFallback = useCallback(
    (sentence: string, lang: string, rate: number): Promise<void> =>
      new Promise((resolve) => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) {
          resolve();
          return;
        }
        try {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(sentence);
          utter.lang = getSpeechLangCode(lang);
          utter.volume = 1.0;
          utter.rate = Math.min(1.5, Math.max(0.6, rate));
          utter.onend = () => resolve();
          utter.onerror = () => resolve();
          window.speechSynthesis.speak(utter);
        } catch {
          resolve();
        }
      }),
    []
  );

  const playSentenceSequence = useCallback(
    async (
      list: string[],
      startIdx: number,
      lang: string,
      voice: VoiceName,
      currentSpeed: number,
      currentMode: ReadingMode
    ) => {
      if (list.length === 0) return;
      stopReading();
      const runId = playbackRunIdRef.current;
      setIsPlaying(true);
      setIsPaused(false);
      setErrorMsg(null);

      for (let i = startIdx; i < list.length; i++) {
        if (playbackRunIdRef.current !== runId) return;
        const sentence = list[i];
        setActiveSentenceIdx(i);
        setIsLoadingAudio(true);

        // Pre-fetch next sentence in parallel for gapless reading
        if (i + 1 < list.length) {
          void fetchSentenceAudio(
            list[i + 1],
            lang,
            voice,
            currentSpeed,
            currentMode
          );
        }

        const audioBase64 = await fetchSentenceAudio(
          sentence,
          lang,
          voice,
          currentSpeed,
          currentMode
        );
        if (playbackRunIdRef.current !== runId) return;
        setIsLoadingAudio(false);

        if (audioBase64) {
          await new Promise<void>((resolve) => {
            const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
            audio.muted = false;
            audio.volume = 1.0;
            audio.playbackRate = currentSpeed;
            audioRef.current = audio;
            audio.onended = () => {
              audioRef.current = null;
              resolve();
            };
            audio.onerror = () => {
              audioRef.current = null;
              resolve();
            };
            audio.play().catch(() => {
              audioRef.current = null;
              resolve();
            });
          });
        } else {
          await speakWithBrowserFallback(sentence, lang, currentSpeed);
        }
      }

      if (playbackRunIdRef.current === runId) {
        setIsPlaying(false);
        setIsPaused(false);
        setActiveSentenceIdx(null);
        onStudySessionComplete?.(profile.id, "Read Aloud study session");
      }
    },
    [
      fetchSentenceAudio,
      onStudySessionComplete,
      profile.id,
      speakWithBrowserFallback,
      stopReading,
    ]
  );

  const handleStartReading = useCallback(
    async (startIdx = 0, overrideText?: string, overrideLang?: string) => {
      const textToUse = (overrideText ?? sourceText).trim();
      const langToUse = overrideLang || readLanguage;
      if (!textToUse) {
        setErrorMsg(
          "Type, paste, speak, or scan a page photo first so Jogi Jarvis can read it aloud."
        );
        return;
      }

      setErrorMsg(null);
      setStatusMsg(null);

      let finalText = textToUse;
      if (mode !== "exact" && !overrideText) {
        setIsPreparing(true);
        try {
          const res = await fetch("/api/read/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: textToUse,
              targetLanguage: langToUse,
              mode,
              profile,
            }),
          });
          const data = (await res.json()) as { text?: string; error?: string };
          if (!res.ok || !data.text) {
            throw new Error(data.error || "Could not prepare reading text.");
          }
          finalText = data.text.trim();
          setPreparedText(finalText);
        } catch (err) {
          setErrorMsg(
            err instanceof Error
              ? err.message
              : "Could not prepare text for reading."
          );
          setIsPreparing(false);
          return;
        } finally {
          setIsPreparing(false);
        }
      }

      const list = splitIntoSentences(finalText);
      if (list.length === 0) return;
      await playSentenceSequence(
        list,
        Math.min(startIdx, list.length - 1),
        langToUse,
        voiceName,
        speed,
        mode
      );
    },
    [
      mode,
      playSentenceSequence,
      profile,
      readLanguage,
      sourceText,
      speed,
      voiceName,
    ]
  );

  // Auto-load & auto-start when triggered via voice command or "Read in Read Tab" button
  useEffect(() => {
    if (initialText) {
      setSourceText(initialText);
      setPreparedText("");
      setMode("exact");
    }
    if (autoStartSignal > 0 && autoStartSignal !== lastSignalRef.current) {
      lastSignalRef.current = autoStartSignal;
      const targetText = (initialText || sourceText).trim();
      const targetLang = initialLanguage || readLanguage;
      if (targetText) {
        const list = splitIntoSentences(targetText);
        if (list.length > 0) {
          void playSentenceSequence(
            list,
            0,
            targetLang,
            voiceName,
            speed,
            "exact"
          );
        }
      }
    }
  }, [
    autoStartSignal,
    initialLanguage,
    initialText,
    playSentenceSequence,
    readLanguage,
    sourceText,
    speed,
    voiceName,
  ]);

  const handleTogglePause = () => {
    if (!audioRef.current) return;
    if (isPaused) {
      void audioRef.current.play();
      setIsPaused(false);
    } else {
      audioRef.current.pause();
      setIsPaused(true);
    }
  };

  const handleJumpSentence = (idx: number) => {
    if (idx < 0 || idx >= sentences.length) return;
    void playSentenceSequence(
      sentences,
      idx,
      readLanguage,
      voiceName,
      speed,
      mode
    );
  };

  const handleScanBookPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErrorMsg("Please choose a photo of a textbook, notebook, or page.");
      return;
    }

    stopReading();
    setIsScanningPhoto(true);
    setErrorMsg(null);
    setStatusMsg("Reading text from your photo...");

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(new Error("Could not read photo file."));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : "";

      const res = await fetch("/api/read/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: base64,
          imageMimeType: file.type,
          targetLanguage: readLanguage,
          mode: mode === "explain" ? "explain" : "exact",
          profile,
        }),
      });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok || !data.text) {
        throw new Error(data.error || "Could not extract text from the photo.");
      }

      setSourceText(data.text.trim());
      setPreparedText("");
      setStatusMsg("Page text extracted! Starting Read Aloud...");
      const list = splitIntoSentences(data.text.trim());
      if (list.length > 0) {
        void playSentenceSequence(
          list,
          0,
          readLanguage,
          voiceName,
          speed,
          mode
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not scan book photo."
      );
      setStatusMsg(null);
    } finally {
      setIsScanningPhoto(false);
    }
  };

  const handleToggleDictation = async () => {
    setErrorMsg(null);
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    stopReading();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "audio/mp4";

      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 120) return;

        setIsTranscribing(true);
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
            throw new Error(data.error || "Could not transcribe voice.");
          }
          const spoken = data.transcript.trim();
          setSourceText((prev) => (prev ? `${prev}\n${spoken}` : spoken));
          setPreparedText("");
          setStatusMsg("Voice text added! Tap Read Aloud to listen.");
        } catch (err) {
          setErrorMsg(
            err instanceof Error ? err.message : "Voice dictation failed."
          );
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setErrorMsg("Allow microphone access to dictate text for reading.");
    }
  };

  const handleLoadNote = (noteId: string) => {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return;
    stopReading();
    const combined = [
      `${note.title}.`,
      note.summary,
      ...note.keyPoints,
      ...note.definitions.map((d) => `${d.term}: ${d.meaning}.`),
      note.teacherTip ? `Teacher Tip: ${note.teacherTip}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    setSourceText(combined);
    setPreparedText("");
    setMode("exact");
    setStatusMsg(`Loaded "${note.title}" — ready to read aloud.`);
  };

  const handleSaveAsStudyNote = async () => {
    const contentToSave = activeText.trim();
    if (!contentToSave || isSavingNote) return;
    setIsSavingNote(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/notes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: contentToSave,
          profile,
          subject: profile.role === "parent" ? "Personal" : "General",
          language: readLanguage,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.note) {
        throw new Error(data.error || "Could not create study note.");
      }
      const now = new Date().toISOString();
      const created: StudyNote = {
        id: `note-read-${Date.now()}`,
        profileId: profile.id,
        profileName: profile.name,
        title: data.note.title || "Reading Study Note",
        subject: data.note.subject || "General",
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
      onSaveNote(created);
      setSavedNoteId(created.id);
      setStatusMsg(`Saved "${created.title}" to Study Notes.`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Could not save study note."
      );
    } finally {
      setIsSavingNote(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] px-4 sm:px-8 py-6">
      <div className="max-w-4xl mx-auto space-y-5">
        {/* Header Bar */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <ProfileAvatar profile={profile} size="md" />
            <div className="min-w-0">
              <h1 className="font-display text-lg sm:text-xl font-bold text-slate-900 truncate">
                {profile.name}&apos;s Read Aloud Studio
              </h1>
              <p className="text-xs sm:text-sm text-slate-500">
                Listen to any text, textbook photo, or study note in any
                language with sentence highlighting
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker
              compact
              value={readLanguage}
              onChange={(lang) => {
                setReadLanguage(lang);
                onChangeLanguage(lang);
                setPreparedText("");
              }}
            />

            <select
              aria-label="Reading voice"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value as VoiceName)}
              className="h-8 px-2.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:outline-none focus:border-blue-500"
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  Voice: {v.label}
                </option>
              ))}
            </select>

            <div className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold">
              {[
                { label: "0.75x", val: 0.75 },
                { label: "1.0x", val: 1.0 },
                { label: "1.25x", val: 1.25 },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => {
                    setSpeed(opt.val);
                    if (audioRef.current) {
                      audioRef.current.playbackRate = opt.val;
                    }
                  }}
                  className={`px-2 py-1 rounded transition-colors ${
                    Math.abs(speed - opt.val) < 0.1
                      ? "bg-blue-700 text-white"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Reading Mode Selector + Quick Input Sources */}
        <div className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  {
                    id: "exact",
                    label: "Read Exact Text",
                    icon: Volume2,
                  },
                  {
                    id: "translate",
                    label:
                      readLanguage === "Auto-Detect"
                        ? "Translate & Read"
                        : `Translate & Read (${readLanguage})`,
                    icon: Languages,
                  },
                  {
                    id: "explain",
                    label: "Read & Explain Simply",
                    icon: Sparkles,
                  },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                const active = mode === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setMode(item.id);
                      setPreparedText("");
                    }}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? "bg-blue-700 text-white border-blue-700"
                        : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void handleScanBookPhoto(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />

              <button
                type="button"
                disabled={isScanningPhoto}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-blue-50 text-slate-800 hover:text-blue-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {isScanningPhoto ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                ) : (
                  <ImagePlus className="h-3.5 w-3.5 text-blue-700" />
                )}
                <span>
                  {isScanningPhoto ? "Scanning Page..." : "Scan Book Photo"}
                </span>
              </button>

              <button
                type="button"
                disabled={isTranscribing}
                onClick={() => void handleToggleDictation()}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
                  isRecording
                    ? "bg-red-600 text-white hover:bg-red-700"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-800"
                }`}
              >
                {isTranscribing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : isRecording ? (
                  <Square className="h-3.5 w-3.5 fill-white" />
                ) : (
                  <Mic className="h-3.5 w-3.5 text-blue-700" />
                )}
                <span>
                  {isTranscribing
                    ? "Transcribing..."
                    : isRecording
                      ? "Stop Dictation"
                      : "Speak Text"}
                </span>
              </button>

              <StudyMediaQuickButtons
                compact
                onOpen={(targetMode) => {
                  const raw = (preparedText || sourceText).trim();
                  const firstLine = raw.split(/\n+/)[0] || "";
                  const snippet = firstLine
                    .replace(/[#*_`]/g, "")
                    .trim()
                    .slice(0, 120);
                  setMediaStudio({
                    isOpen: true,
                    mode: targetMode,
                    prompt: snippet,
                    autoRun: Boolean(snippet),
                  });
                }}
              />

              {notes.length > 0 && (
                <select
                  aria-label="Load saved study note"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      handleLoadNote(e.target.value);
                      e.target.value = "";
                    }
                  }}
                  className="h-8 max-w-[190px] px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-blue-500"
                >
                  <option value="" disabled>
                    Load Study Note...
                  </option>
                  {notes.slice(0, 20).map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title} ({n.profileName})
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          {errorMsg && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-xs font-medium text-red-800">
              {errorMsg}
            </div>
          )}

          {statusMsg && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-xs font-medium text-emerald-900 flex items-center justify-between gap-2">
              <span>{statusMsg}</span>
              {savedNoteId && (
                <button
                  type="button"
                  onClick={() => onOpenNote(savedNoteId)}
                  className="font-semibold underline text-emerald-800 hover:text-emerald-950 whitespace-nowrap"
                >
                  Open Study Note
                </button>
              )}
            </div>
          )}

          {/* Text Input Area */}
          <div className="space-y-2">
            <textarea
              rows={5}
              value={sourceText}
              onChange={(e) => {
                setSourceText(e.target.value);
                setPreparedText("");
                setSavedNoteId(null);
              }}
              placeholder="Paste or type any paragraph, chapter, question, or story in English, Odia, Hindi, or any language — or tap 'Scan Book Photo' above..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:border-blue-500 focus:outline-none p-4 text-sm sm:text-base text-slate-900 leading-relaxed resize-y"
            />

            {!sourceText.trim() && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs font-medium text-slate-500">
                  Quick practice samples:
                </span>
                {SAMPLE_PASSAGES.map((sample) => (
                  <button
                    key={sample.label}
                    type="button"
                    onClick={() => {
                      setSourceText(sample.text);
                      setReadLanguage(sample.language);
                      setPreparedText("");
                    }}
                    className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-blue-50 text-xs font-medium text-slate-700 hover:text-blue-800 transition-colors"
                  >
                    {sample.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Primary Read Aloud Transport Controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div className="flex flex-wrap items-center gap-2">
              {!isPlaying ? (
                <button
                  type="button"
                  disabled={
                    !sourceText.trim() || isPreparing || isScanningPhoto
                  }
                  onClick={() => void handleStartReading(0)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
                >
                  {isPreparing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 fill-white" />
                  )}
                  <span>
                    {isPreparing
                      ? "Preparing text..."
                      : mode === "exact"
                        ? "Read Aloud"
                        : mode === "translate"
                          ? "Translate & Read Aloud"
                          : "Explain & Read Aloud"}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleTogglePause}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    {isLoadingAudio ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isPaused ? (
                      <Play className="h-4 w-4 fill-white" />
                    ) : (
                      <Pause className="h-4 w-4" />
                    )}
                    <span>
                      {isLoadingAudio
                        ? "Speaking..."
                        : isPaused
                          ? "Resume"
                          : "Pause"}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={
                      activeSentenceIdx === null || activeSentenceIdx <= 0
                    }
                    onClick={() =>
                      handleJumpSentence((activeSentenceIdx ?? 1) - 1)
                    }
                    aria-label="Previous sentence"
                    className="h-10 w-10 inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 text-slate-700"
                  >
                    <SkipBack className="h-4 w-4" />
                  </button>

                  <button
                    type="button"
                    disabled={
                      activeSentenceIdx === null ||
                      activeSentenceIdx >= sentences.length - 1
                    }
                    onClick={() =>
                      handleJumpSentence((activeSentenceIdx ?? 0) + 1)
                    }
                    aria-label="Next sentence"
                    className="h-10 w-10 inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white hover:bg-slate-100 disabled:opacity-40 text-slate-700"
                  >
                    <SkipForward className="h-4 w-4" />
                  </button>

                  <button
                    type="button"
                    onClick={stopReading}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
                  >
                    <Square className="h-3.5 w-3.5 fill-red-700" />
                    <span>Stop</span>
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              {activeText.trim() && (
                <button
                  type="button"
                  disabled={isSavingNote}
                  onClick={() => void handleSaveAsStudyNote()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  {isSavingNote ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-700" />
                  ) : savedNoteId ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <BookMarked className="h-3.5 w-3.5 text-blue-700" />
                  )}
                  <span>
                    {savedNoteId ? "Saved to Notes" : "Save Study Note"}
                  </span>
                </button>
              )}

              {sourceText.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    stopReading();
                    setSourceText("");
                    setPreparedText("");
                    setSavedNoteId(null);
                    setStatusMsg(null);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-medium text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Clear</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Interactive Follow-Along Highlighted Reader */}
        {sentences.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-blue-700" />
                <h2 className="text-sm font-semibold text-slate-900">
                  Follow-Along Reader
                </h2>
              </div>
              <span className="text-xs text-slate-500">
                Tap any sentence to hear it spoken
              </span>
            </div>

            <div className="space-y-1.5 text-base sm:text-lg leading-relaxed text-slate-800">
              {sentences.map((sentence, idx) => {
                const isCurrent = activeSentenceIdx === idx;
                return (
                  <button
                    key={`${idx}-${sentence.slice(0, 18)}`}
                    type="button"
                    onClick={() => handleJumpSentence(idx)}
                    className={`block w-full text-left px-3 py-2 rounded-xl transition-colors ${
                      isCurrent
                        ? "bg-blue-50 text-blue-950 font-medium ring-1 ring-blue-300"
                        : "hover:bg-slate-50 text-slate-800"
                    }`}
                  >
                    <span className="inline-block w-6 text-xs font-mono text-slate-400 mr-1 select-none">
                      {idx + 1}.
                    </span>
                    {sentence}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <StudyMediaStudioModal
        isOpen={mediaStudio.isOpen}
        initialMode={mediaStudio.mode}
        initialPrompt={mediaStudio.prompt}
        autoRun={mediaStudio.autoRun}
        profile={profile}
        language={readLanguage}
        contextLabel="Read Aloud Studio"
        onClose={() =>
          setMediaStudio((prev) => ({ ...prev, isOpen: false }))
        }
      />
    </div>
  );
}
