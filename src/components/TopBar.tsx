import { Menu, Mic } from "lucide-react";
import type { AppTab } from "../types";

interface TopBarProps {
  activeTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onStartQuickVoice: () => void;
  onToggleMobileMenu: () => void;
}

const NAV_ITEMS: Array<{ id: AppTab; label: string }> = [
  { id: "assistant", label: "Assistant" },
  { id: "live", label: "Live Voice" },
  { id: "notes", label: "Study Notes" },
  { id: "family", label: "Family" },
];

export function TopBar({
  activeTab,
  onSelectTab,
  onStartQuickVoice,
  onToggleMobileMenu,
}: TopBarProps) {
  return (
    <header className="no-print sticky top-0 z-30 h-16 bg-white/95 backdrop-blur-sm border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-8">
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

      {/* Zone 2: 4 clean single-line navigation links */}
      <nav
        aria-label="Primary navigation"
        className="hidden md:flex items-center gap-7 text-sm font-medium"
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

      {/* Zone 3: 1 primary action */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={onStartQuickVoice}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
        >
          <Mic className="h-4 w-4" />
          <span>Talk Now</span>
        </button>
      </div>
    </header>
  );
}
