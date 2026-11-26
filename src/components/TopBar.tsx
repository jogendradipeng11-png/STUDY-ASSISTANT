import type { ReactNode } from "react";
import { BookOpen, Languages, Menu, Mic, Watch } from "lucide-react";
import type { AppTab } from "../types";
import { PWAInstallButton } from "./PWAInstallButton";

interface TopBarProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onStartQuickVoice: () => void;
  onOpenWatchMode: () => void;
  onToggleMobileMenu: () => void;
  cloudSyncControl?: ReactNode;
}

const NAV_ITEMS: Array<{ id: AppTab; label: string }> = [
  { id: "assistant", label: "Assistant" },
  { id: "live", label: "Live Voice" },
  { id: "translate", label: "Translate" },
  { id: "read", label: "Read" },
  { id: "notes", label: "Study Notes" },
  { id: "family", label: "Family" },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onStartQuickVoice,
  onOpenWatchMode,
  onToggleMobileMenu,
  cloudSyncControl,
}: TopBarProps) {
  return (
    <header className="no-print sticky top-0 z-30 h-16 bg-white/95 backdrop-blur-sm border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-3 sm:gap-6">
      {/* Zone 1: Brand wordmark (single text element) */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onToggleMobileMenu}
          aria-label="Open family profiles menu"
          className="lg:hidden inline-flex items-center justify-center h-10 w-10 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Menu className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => onSelectTab("assistant")}
          className="font-display text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 rounded"
        >
          Jogi Jarvis
        </button>
      </div>

      {/* Zone 2: Clean single-line navigation links */}
      <nav
        aria-label="Primary navigation"
        className="hidden md:flex items-center gap-6 text-sm font-medium"
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`relative py-5 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 ${
                isActive
                  ? "text-slate-950 font-semibold"
                  : "text-slate-600 hover:text-slate-950"
              }`}
            >
              {item.label}
              {isActive && (
                <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-blue-700" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Mobile Translate/Read shortcuts, Cloud Sync, Watch Mode, Install App & primary Talk Now action */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onSelectTab("translate")}
          title="Open Live Voice Translator & Conversation Mode"
          className={`md:hidden inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
            activeTab === "translate"
              ? "bg-blue-50 border-blue-300 text-blue-800"
              : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
          }`}
        >
          <Languages className="h-4 w-4 text-blue-700 shrink-0" />
          <span>Translate</span>
        </button>
        <button
          type="button"
          onClick={() => onSelectTab("read")}
          title="Open Read Aloud Studio (any language)"
          className={`md:hidden inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 min-h-[40px] ${
            activeTab === "read"
              ? "bg-blue-50 border-blue-300 text-blue-800"
              : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
          }`}
        >
          <BookOpen className="h-4 w-4 text-blue-700 shrink-0" />
          <span className="hidden sm:inline">Read</span>
        </button>
        {cloudSyncControl}
        <button
          type="button"
          onClick={onOpenWatchMode}
          title="Open Android Watch (Wear OS) live voice mode"
          className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs sm:text-sm font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Watch className="h-4 w-4 text-blue-700 shrink-0" />
          <span className="hidden sm:inline">Watch</span>
        </button>
        <PWAInstallButton />
        <button
          type="button"
          onClick={onStartQuickVoice}
          className="inline-flex items-center gap-2 px-3.5 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Mic className="h-4 w-4" />
          <span>Talk Now</span>
        </button>
      </div>
    </header>
  );
}
