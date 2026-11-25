import { useState } from "react";
import { Check, Languages, X } from "lucide-react";
import { LANGUAGE_OPTIONS } from "../data/defaults";

interface LanguagePickerProps {
  value: string;
  onChange: (lang: string) => void;
  compact?: boolean;
  disabled?: boolean;
}

const CUSTOM_SENTINEL = "__CUSTOM_LANGUAGE__";

export function LanguagePicker({
  value,
  onChange,
  compact = false,
  disabled = false,
}: LanguagePickerProps) {
  const normalized = value?.trim() || "Auto-Detect";
  const isPreset = LANGUAGE_OPTIONS.some((opt) => opt.id === normalized);
  const [enteringCustom, setEnteringCustom] = useState(false);
  const [customInput, setCustomInput] = useState(isPreset ? "" : normalized);

  const commitCustom = () => {
    const trimmed = customInput.trim();
    if (trimmed) {
      onChange(trimmed);
    }
    setEnteringCustom(false);
  };

  if (enteringCustom) {
    return (
      <div className="inline-flex items-center gap-1 bg-white border border-blue-400 rounded-md px-2 py-1">
        <input
          type="text"
          autoFocus
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitCustom();
            } else if (e.key === "Escape") {
              setEnteringCustom(false);
            }
          }}
          placeholder="Type any language..."
          className="w-32 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none bg-transparent"
        />
        <button
          type="button"
          onClick={commitCustom}
          aria-label="Apply custom language"
          className="text-blue-700 hover:text-blue-900 p-0.5"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setEnteringCustom(false)}
          aria-label="Cancel custom language"
          className="text-slate-400 hover:text-slate-700 p-0.5"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      className={`inline-flex items-center gap-1.5 bg-white border border-slate-200 rounded-md ${
        compact ? "px-2.5 py-1.5" : "px-3 py-2"
      } ${disabled ? "opacity-60" : "hover:border-slate-300"} transition-colors`}
    >
      <Languages className="h-3.5 w-3.5 text-slate-500 shrink-0" />
      <select
        aria-label="Select response language"
        disabled={disabled}
        value={isPreset ? normalized : normalized}
        onChange={(e) => {
          if (e.target.value === CUSTOM_SENTINEL) {
            setCustomInput(isPreset ? "" : normalized);
            setEnteringCustom(true);
          } else {
            onChange(e.target.value);
          }
        }}
        className="text-xs font-medium text-slate-700 bg-transparent focus:outline-none cursor-pointer max-w-[165px] truncate"
      >
        {!isPreset && (
          <option value={normalized}>{normalized} (Custom)</option>
        )}
        {LANGUAGE_OPTIONS.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
        <option value={CUSTOM_SENTINEL}>+ Other language...</option>
      </select>
    </div>
  );
}
