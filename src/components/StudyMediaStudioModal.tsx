import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ExternalLink,
  Film,
  Globe,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  Send,
  X,
} from "lucide-react";
import type {
  FamilyProfile,
  StudyDiagramMedia,
  StudyPhotoResult,
  StudyVideoLink,
  StudyVideoStoryboard,
} from "../types";
import { WORLD_TRANSLATION_LANGUAGES } from "../data/defaults";
import {
  StudyDiagramCard,
  StudyPhotoGallery,
  StudyVideoLinksStrip,
  StudyVideoPlayer,
} from "./StudyMediaCards";
import {
  getSavedLocalModelKey,
  isLocalBrowserEnginePreferred,
} from "../utils/localLlm";
import {
  generateLocalStudyPicture,
  generateLocalStudySearch,
  generateLocalStudyVideo,
} from "../utils/localStudyMedia";

export type StudyMediaMode = "search" | "picture" | "video";

interface StudioResult {
  promptKey: string;
  reply: string;
  diagram?: StudyDiagramMedia;
  storyboard?: StudyVideoStoryboard;
  photos?: StudyPhotoResult[];
  videoLinks?: StudyVideoLink[];
  sources?: Array<{ uri: string; title: string }>;
}

interface StudyMediaQuickButtonsProps {
  onOpen: (mode: StudyMediaMode) => void;
  compact?: boolean;
  className?: string;
}

export function StudyMediaQuickButtons({
  onOpen,
  compact = false,
  className = "",
}: StudyMediaQuickButtonsProps) {
  const btnPadding = compact ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-xs";

  return (
    <div
      className={`inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 ${className}`}
      role="group"
      aria-label="Free Search, Picture, and Video generation"
    >
      <button
        type="button"
        onClick={() => onOpen("search")}
        title="Free Search (works online & offline with Local AI)"
        className={`inline-flex items-center gap-1 ${btnPadding} rounded-md font-medium text-slate-700 hover:bg-white hover:text-blue-700 hover:shadow-2xs transition-colors whitespace-nowrap shrink-0`}
      >
        <Search className="h-3.5 w-3.5 text-blue-700 shrink-0" />
        <span>Search</span>
      </button>

      <button
        type="button"
        onClick={() => onOpen("picture")}
        title="Generate free labeled Picture / Diagram (works online & offline)"
        className={`inline-flex items-center gap-1 ${btnPadding} rounded-md font-medium text-slate-700 hover:bg-white hover:text-emerald-700 hover:shadow-2xs transition-colors whitespace-nowrap shrink-0`}
      >
        <ImageIcon className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
        <span>Picture</span>
      </button>

      <button
        type="button"
        onClick={() => onOpen("video")}
        title="Generate free 5-scene narrated Video (.webm download — works online & offline)"
        className={`inline-flex items-center gap-1 ${btnPadding} rounded-md font-medium text-slate-700 hover:bg-white hover:text-indigo-700 hover:shadow-2xs transition-colors whitespace-nowrap shrink-0`}
      >
        <Film className="h-3.5 w-3.5 text-indigo-700 shrink-0" />
        <span>Video</span>
      </button>
    </div>
  );
}

interface StudyMediaStudioModalProps {
  isOpen: boolean;
  initialMode: StudyMediaMode;
  initialPrompt?: string;
  autoRun?: boolean;
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  contextLabel?: string;
  onClose: () => void;
}

const MODE_META: Record<
  StudyMediaMode,
  {
    label: string;
    buttonLabel: string;
    placeholder: string;
    loadingText: string;
    examples: string[];
  }
> = {
  search: {
    label: "Search",
    buttonLabel: "Search",
    placeholder: "Search live web facts, study photos & videos (works offline with Local AI too)...",
    loadingText: "Searching facts, study photos & visual breakdown...",
    examples: [
      "Photosynthesis process for students",
      "Solar system planets latest facts",
      "Water cycle evaporation condensation",
    ],
  },
  picture: {
    label: "Picture",
    buttonLabel: "Generate Picture",
    placeholder: "Describe any diagram or picture to draw (works online & offline)...",
    loadingText: "Drawing labeled study picture & visual diagram...",
    examples: [
      "Labeled diagram of Human Heart",
      "Structure of a Plant Cell",
      "Water Cycle diagram with labels",
    ],
  },
  video: {
    label: "Video",
    buttonLabel: "Generate Video",
    placeholder: "Enter a topic for a 5-scene narrated animated video (works offline too)...",
    loadingText: "Creating 5-scene narrated animated explainer video...",
    examples: [
      "How Newton's 3 Laws of Motion work",
      "How Photosynthesis works step by step",
      "How Electricity flows in a circuit",
    ],
  },
};

export function StudyMediaStudioModal({
  isOpen,
  initialMode,
  initialPrompt = "",
  autoRun = false,
  profile,
  subject,
  language,
  contextLabel,
  onClose,
}: StudyMediaStudioModalProps) {
  const [mode, setMode] = useState<StudyMediaMode>(initialMode);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [videoLangOption, setVideoLangOption] = useState<string>(() => {
    const pref = (language || profile.preferredLanguage || "").trim();
    if (!pref || pref.toLowerCase() === "auto-detect") return "English";
    const found = WORLD_TRANSLATION_LANGUAGES.find(
      (l) => l.id.toLowerCase() === pref.toLowerCase()
    );
    return found ? found.id : "__custom__";
  });
  const [customVideoLang, setCustomVideoLang] = useState<string>(() => {
    const pref = (language || profile.preferredLanguage || "").trim();
    if (!pref || pref.toLowerCase() === "auto-detect") return "";
    const found = WORLD_TRANSLATION_LANGUAGES.find(
      (l) => l.id.toLowerCase() === pref.toLowerCase()
    );
    return found ? "" : pref;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [resultsByMode, setResultsByMode] = useState<
    Partial<Record<StudyMediaMode, StudioResult>>
  >({});

  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const effectiveVideoLanguage =
    videoLangOption === "__custom__"
      ? customVideoLang.trim() || "English"
      : videoLangOption;

  const runGeneration = useCallback(
    async (
      targetMode: StudyMediaMode,
      rawPrompt: string,
      overrideLang?: string
    ) => {
      const cleanPrompt = rawPrompt.trim();
      if (!cleanPrompt) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setErrorMsg(null);

      const isOfflineNow =
        typeof navigator !== "undefined" && !navigator.onLine;
      const preferLocal = isOfflineNow || isLocalBrowserEnginePreferred();
      const resolvedSubject =
        subject || (profile.role === "student" ? "General" : undefined);
      const resolvedLanguage =
        targetMode === "video"
          ? overrideLang || effectiveVideoLanguage
          : language || profile.preferredLanguage || "Auto-Detect";

      const runOnDevice = async (): Promise<StudioResult> => {
        const modelKey = getSavedLocalModelKey();
        if (targetMode === "picture") {
          const pic = await generateLocalStudyPicture({
            prompt: cleanPrompt,
            profile,
            subject: resolvedSubject,
            language: resolvedLanguage,
            modelKey,
          });
          return {
            promptKey: cleanPrompt,
            reply: pic.reply,
            diagram: pic.diagram,
            photos: pic.photos.length > 0 ? pic.photos : undefined,
          };
        }
        if (targetMode === "video") {
          const vid = await generateLocalStudyVideo({
            prompt: cleanPrompt,
            profile,
            subject: resolvedSubject,
            language: resolvedLanguage,
            modelKey,
          });
          return {
            promptKey: cleanPrompt,
            reply: vid.reply,
            storyboard: vid.storyboard,
            videoLinks: vid.videoLinks.length > 0 ? vid.videoLinks : undefined,
          };
        }
        const searchRes = await generateLocalStudySearch({
          query: cleanPrompt,
          profile,
          subject: resolvedSubject,
          language: resolvedLanguage,
          modelKey,
        });
        return {
          promptKey: cleanPrompt,
          reply: searchRes.reply,
          diagram: searchRes.diagram,
          photos: searchRes.photos.length > 0 ? searchRes.photos : undefined,
          videoLinks:
            searchRes.videoLinks.length > 0 ? searchRes.videoLinks : undefined,
          sources: searchRes.sources,
        };
      };

      try {
        if (preferLocal) {
          const localResult = await runOnDevice();
          if (controller.signal.aborted) return;
          setResultsByMode((prev) => ({ ...prev, [targetMode]: localResult }));
          return;
        }

        const endpoint =
          targetMode === "picture"
            ? "/api/study/picture"
            : targetMode === "video"
              ? "/api/study/video"
              : "/api/study/search";

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            prompt: cleanPrompt,
            query: cleanPrompt,
            profile,
            subject: resolvedSubject,
            language: resolvedLanguage,
          }),
        });

        const data = (await res.json().catch(() => ({}))) as {
          reply?: string;
          diagram?: StudyDiagramMedia;
          storyboard?: StudyVideoStoryboard;
          photos?: StudyPhotoResult[];
          videoLinks?: StudyVideoLink[];
          sources?: Array<{ uri: string; title: string }>;
          error?: string;
        };

        if (!res.ok) {
          throw new Error(
            data.error || `Could not generate ${targetMode} right now.`
          );
        }

        setResultsByMode((prev) => ({
          ...prev,
          [targetMode]: {
            promptKey: cleanPrompt,
            reply: data.reply || "",
            diagram: data.diagram,
            storyboard: data.storyboard,
            photos: Array.isArray(data.photos) ? data.photos : undefined,
            videoLinks: Array.isArray(data.videoLinks)
              ? data.videoLinks
              : undefined,
            sources: Array.isArray(data.sources) ? data.sources : undefined,
          },
        }));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        // Seamless on-device / offline fallback so Picture, Video, and Search ALWAYS work!
        try {
          const fallbackResult = await runOnDevice();
          if (controller.signal.aborted) return;
          setResultsByMode((prev) => ({
            ...prev,
            [targetMode]: fallbackResult,
          }));
        } catch (fallbackErr) {
          setErrorMsg(
            fallbackErr instanceof Error
              ? fallbackErr.message
              : "Something went wrong while generating media."
          );
        }
      } finally {
        if (abortRef.current === controller) {
          setIsLoading(false);
        }
      }
    },
    [effectiveVideoLanguage, language, profile, subject]
  );

  // Sync open state & optional auto-run
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      setIsLoading(false);
      return;
    }

    const cleanInitial = initialPrompt.trim();
    setMode(initialMode);
    setPrompt(cleanInitial);
    setErrorMsg(null);
    setResultsByMode({});

    if (autoRun && cleanInitial) {
      void runGeneration(initialMode, cleanInitial);
    } else {
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [isOpen, initialMode, initialPrompt, autoRun, runGeneration]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeMeta = MODE_META[mode];
  const currentResult = resultsByMode[mode];

  const handleSwitchMode = (nextMode: StudyMediaMode) => {
    setMode(nextMode);
    setErrorMsg(null);
    const cleanPrompt = prompt.trim();
    const cached = resultsByMode[nextMode];
    if (cleanPrompt && (!cached || cached.promptKey !== cleanPrompt)) {
      void runGeneration(nextMode, cleanPrompt);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Free Search, Picture, and Video Studio"
      className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-center justify-center p-3 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-4xl max-h-[90vh] bg-white border border-slate-200 rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-4 sm:px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 bg-white shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm sm:text-base font-bold text-slate-900">
                Free Search, Picture &amp; Video Studio
              </h2>
              {contextLabel && (
                <span className="text-xs font-medium text-slate-500">
                  · {contextLabel}
                </span>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">
              100% free web search, interactive 3D real images (PNG/SVG), reference photos &amp; 3D cinema .webm videos
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              {(
                [
                  { id: "search", label: "Search", icon: Search, activeCls: "bg-blue-700 text-white" },
                  { id: "picture", label: "Picture", icon: ImageIcon, activeCls: "bg-emerald-700 text-white" },
                  { id: "video", label: "Video", icon: Film, activeCls: "bg-indigo-700 text-white" },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = mode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => handleSwitchMode(tab.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? tab.activeCls
                        : "text-slate-600 hover:text-slate-900 hover:bg-white/70"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close media studio"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Prompt Input Form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runGeneration(mode, prompt);
          }}
          className="px-4 sm:px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-col gap-2 shrink-0"
        >
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              ref={inputRef}
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={activeMeta.placeholder}
              className="flex-1 min-w-0 px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
            />
            {mode === "video" && (
              <div className="inline-flex items-center gap-1.5 px-2.5 py-2 bg-white border border-slate-300 rounded-xl shrink-0">
                <Globe className="h-4 w-4 text-indigo-600 shrink-0" />
                <select
                  aria-label="3D Video Lesson Language"
                  value={videoLangOption}
                  onChange={(e) => setVideoLangOption(e.target.value)}
                  className="bg-transparent text-xs sm:text-sm font-medium text-slate-800 focus:outline-none max-w-[165px] cursor-pointer"
                >
                  {WORLD_TRANSLATION_LANGUAGES.map((lang) => (
                    <option key={lang.id} value={lang.id}>
                      {lang.label}
                    </option>
                  ))}
                  <option value="__custom__">Other Language (Type Any)...</option>
                </select>
              </div>
            )}
            <button
              type="submit"
              disabled={isLoading || !prompt.trim()}
              className={`inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold text-white disabled:opacity-45 transition-colors whitespace-nowrap shrink-0 ${
                mode === "picture"
                  ? "bg-emerald-700 hover:bg-emerald-800"
                  : mode === "video"
                    ? "bg-indigo-700 hover:bg-indigo-800"
                    : "bg-blue-700 hover:bg-blue-800"
              }`}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span>{isLoading ? "Generating..." : activeMeta.buttonLabel}</span>
            </button>
          </div>
          {mode === "video" && videoLangOption === "__custom__" && (
            <input
              type="text"
              value={customVideoLang}
              onChange={(e) => setCustomVideoLang(e.target.value)}
              placeholder="Type any world language (e.g. Sambalpuri, Bhojpuri, Zulu, Irish, Kazakh)..."
              className="w-full px-3.5 py-2 text-xs sm:text-sm bg-white border border-slate-300 rounded-xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-indigo-600"
            />
          )}
        </form>

        {/* Scrollable Result Viewport */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-5 bg-[#F8FAFC]">
          {errorMsg && (
            <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs sm:text-sm text-red-800 flex items-center justify-between gap-3">
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => void runGeneration(mode, prompt)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-white border border-red-200 text-red-800 font-semibold hover:bg-red-100/50 shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 flex flex-col items-center justify-center text-center gap-3">
              <Loader2 className="h-7 w-7 animate-spin text-blue-700" />
              <p className="text-sm font-semibold text-slate-900">
                {activeMeta.loadingText}
              </p>
              <p className="text-xs text-slate-500 max-w-md">
                Topic: &ldquo;{prompt.trim()}&rdquo;
              </p>
            </div>
          ) : currentResult ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
              {currentResult.reply && (
                <div className="jarvis-prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {currentResult.reply}
                  </ReactMarkdown>
                </div>
              )}

              {currentResult.diagram && (
                <StudyDiagramCard diagram={currentResult.diagram} />
              )}

              {currentResult.storyboard && (
                <StudyVideoPlayer
                  storyboard={currentResult.storyboard}
                  videoLinks={currentResult.videoLinks}
                />
              )}

              {currentResult.photos && currentResult.photos.length > 0 && (
                <StudyPhotoGallery photos={currentResult.photos} />
              )}

              {!currentResult.storyboard &&
                currentResult.videoLinks &&
                currentResult.videoLinks.length > 0 && (
                  <StudyVideoLinksStrip links={currentResult.videoLinks} />
                )}

              {currentResult.sources && currentResult.sources.length > 0 && (
                <div className="pt-4 border-t border-slate-100">
                  <p className="text-xs font-semibold text-slate-500 mb-2">
                    Web Sources
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {currentResult.sources.map((src) => (
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
            </div>
          ) : (
            <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 text-center space-y-4">
              <div className="space-y-1">
                <h3 className="text-sm sm:text-base font-bold text-slate-900">
                  {mode === "picture"
                    ? "Generate a Free Labeled Picture & Reference Photos"
                    : mode === "video"
                      ? "Generate a Free 5-Scene Narrated Explainer Video"
                      : "Search Live Web Facts, Study Photos & Videos"}
                </h3>
                <p className="text-xs sm:text-sm text-slate-500 max-w-lg mx-auto">
                  Enter any topic above or pick an example below to generate instantly.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {activeMeta.examples.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      setPrompt(ex);
                      void runGeneration(mode, ex);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-xs font-medium text-slate-700 hover:text-blue-800 transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
