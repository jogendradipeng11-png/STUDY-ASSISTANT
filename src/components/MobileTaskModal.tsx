import { useState } from "react";
import {
  AlarmClock,
  FileCode2,
  MessageSquare,
  Send,
  Timer,
  X,
} from "lucide-react";
import type { ActiveAlarm } from "../types";

export type MobileTaskModalMode = "alarm" | "message" | "script";

interface MobileTaskModalProps {
  mode: MobileTaskModalMode;
  onClose: () => void;
  onAddAlarm: (alarm: Omit<ActiveAlarm, "id" | "ringing">) => void;
  onRunScriptPrompt: (prompt: string) => void;
}

export function MobileTaskModal({
  mode,
  onClose,
  onAddAlarm,
  onRunScriptPrompt,
}: MobileTaskModalProps) {
  // Alarm / Timer state
  const [alarmKind, setAlarmKind] = useState<"alarm" | "timer">("alarm");
  const [alarmTime, setAlarmTime] = useState("06:30");
  const [timerMinutes, setTimerMinutes] = useState("10");
  const [alarmLabel, setAlarmLabel] = useState("Personal Reminder");

  // WhatsApp / SMS state
  const [recipientPhone, setRecipientPhone] = useState("");
  const [messageText, setMessageText] = useState("");

  // Script Generator state
  const [scriptType, setScriptType] = useState<
    "youtube" | "shorts" | "speech" | "whatsapp" | "python" | "termux"
  >("youtube");
  const [scriptTopic, setScriptTopic] = useState("");
  const [scriptTone, setScriptTone] = useState("Engaging & clear");

  const handleSetAlarm = () => {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission().catch(() => {});
    }

    if (alarmKind === "timer") {
      const mins = Math.max(1, parseInt(timerMinutes, 10) || 5);
      onAddAlarm({
        label: alarmLabel.trim() || `${mins} min Timer`,
        triggerAt: Date.now() + mins * 60 * 1000,
        type: "timer",
      });
      onClose();
      return;
    }

    const [hStr, mStr] = alarmTime.split(":");
    const hour = parseInt(hStr || "6", 10);
    const minute = parseInt(mStr || "30", 10);
    const target = new Date();
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }

    onAddAlarm({
      label: alarmLabel.trim() || "Personal Alarm",
      triggerAt: target.getTime(),
      type: "alarm",
    });
    onClose();
  };

  const buildAndroidAlarmHref = () => {
    if (alarmKind === "timer") {
      const secs = Math.max(60, (parseInt(timerMinutes, 10) || 5) * 60);
      return `intent:#Intent;action=android.intent.action.SET_TIMER;i.android.intent.extra.alarm.LENGTH=${secs};S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(
        alarmLabel.trim() || "Jogi Jarvis Timer"
      )};B.android.intent.extra.alarm.SKIP_UI=false;end`;
    }
    const [hStr, mStr] = alarmTime.split(":");
    const hour = parseInt(hStr || "6", 10);
    const minute = parseInt(mStr || "30", 10);
    return `intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${hour};i.android.intent.extra.alarm.MINUTES=${minute};S.android.intent.extra.alarm.MESSAGE=${encodeURIComponent(
      alarmLabel.trim() || "Jogi Jarvis Alarm"
    )};B.android.intent.extra.alarm.SKIP_UI=false;end`;
  };

  const cleanDigits = recipientPhone.replace(/[^\d+]/g, "");
  const waDigits = cleanDigits.replace(/^\+/, "");
  const waHref = waDigits.length >= 7
    ? `https://wa.me/${waDigits}?text=${encodeURIComponent(messageText.trim())}`
    : `https://wa.me/?text=${encodeURIComponent(messageText.trim())}`;
  const smsHref = cleanDigits.length >= 4
    ? `sms:${cleanDigits}?body=${encodeURIComponent(messageText.trim())}`
    : `sms:?body=${encodeURIComponent(messageText.trim())}`;

  const handleGenerateScript = () => {
    const topic = scriptTopic.trim();
    if (!topic) return;

    const promptMap: Record<typeof scriptType, string> = {
      youtube: `Generate a complete, ready-to-record YouTube video script about "${topic}". Tone: ${scriptTone}. Include a 15-second Hook, Intro, structured Main Points with visual cues, and a Call-to-Action Outro.`,
      shorts: `Generate a punchy 45-second YouTube Shorts / Instagram Reels video script about "${topic}". Tone: ${scriptTone}. Include exact spoken lines and scene/caption cues.`,
      speech: `Write a polished, natural speech script about "${topic}". Tone: ${scriptTone}. Include a memorable opening, clear key points, and a strong closing.`,
      whatsapp: `Write a crisp, ready-to-send WhatsApp announcement/message script about "${topic}". Tone: ${scriptTone}. Keep it clean and easy to forward.`,
      python: `Write a complete, clean, well-commented Python script to accomplish: "${topic}". Put the entire runnable code in a \`\`\`python code block and include brief usage instructions.`,
      termux: `Write a clean Android Termux / Bash automation script to accomplish: "${topic}". Put the full script in a \`\`\`bash code block with step-by-step instructions to run on Android.`,
    };

    onRunScriptPrompt(promptMap[scriptType]);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-xs p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 shadow-xl space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
              {mode === "alarm" ? (
                <AlarmClock className="h-5 w-5 text-blue-700" />
              ) : mode === "message" ? (
                <MessageSquare className="h-5 w-5 text-emerald-700" />
              ) : (
                <FileCode2 className="h-5 w-5 text-indigo-700" />
              )}
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                {mode === "alarm"
                  ? "Set Mobile Alarm or Timer"
                  : mode === "message"
                    ? "Send Mobile Message"
                    : "AI Script Generator"}
              </h3>
              <p className="text-xs text-slate-500">
                {mode === "alarm"
                  ? "Rings live in Jogi Jarvis or opens Android Clock"
                  : mode === "message"
                    ? "Opens WhatsApp or SMS with your message pre-filled"
                    : "Create video, speech, WhatsApp, or automation scripts"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="h-8 w-8 rounded-lg inline-flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {mode === "alarm" && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 p-1 rounded-xl bg-slate-100">
              <button
                type="button"
                onClick={() => setAlarmKind("alarm")}
                className={`inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold ${
                  alarmKind === "alarm"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                <AlarmClock className="h-3.5 w-3.5 text-blue-700" />
                <span>Alarm</span>
              </button>
              <button
                type="button"
                onClick={() => setAlarmKind("timer")}
                className={`inline-flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold ${
                  alarmKind === "timer"
                    ? "bg-white text-slate-900 shadow-xs"
                    : "text-slate-600"
                }`}
              >
                <Timer className="h-3.5 w-3.5 text-amber-600" />
                <span>Timer</span>
              </button>
            </div>

            {alarmKind === "alarm" ? (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Alarm Time
                </label>
                <input
                  type="time"
                  value={alarmTime}
                  onChange={(e) => setAlarmTime(e.target.value)}
                  className="w-full px-3 py-2.5 text-base font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                />
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-700">
                  Countdown Minutes
                </label>
                <div className="flex items-center gap-2">
                  {["5", "10", "15", "30"].map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setTimerMinutes(m)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${
                        timerMinutes === m
                          ? "bg-blue-50 border-blue-300 text-blue-800"
                          : "bg-white border-slate-200 text-slate-700"
                      }`}
                    >
                      {m}m
                    </button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    max={720}
                    value={timerMinutes}
                    onChange={(e) => setTimerMinutes(e.target.value)}
                    className="w-20 px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Label
              </label>
              <input
                type="text"
                value={alarmLabel}
                onChange={(e) => setAlarmLabel(e.target.value)}
                placeholder="e.g. Morning Walk, Pick up kids, Study break"
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <a
                href={buildAndroidAlarmHref()}
                className="px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors whitespace-nowrap"
              >
                Open Android Clock
              </a>
              <button
                type="button"
                onClick={handleSetAlarm}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 transition-colors whitespace-nowrap"
              >
                Set Live {alarmKind === "alarm" ? "Alarm" : "Timer"}
              </button>
            </div>
          </div>
        )}

        {mode === "message" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Phone Number (optional — include country code for WhatsApp)
              </label>
              <input
                type="tel"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
                placeholder="e.g. +91 9876543210 (leave blank to pick contact)"
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Message
              </label>
              <textarea
                rows={3}
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                placeholder="Write your message..."
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <a
                href={smsHref}
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 transition-colors whitespace-nowrap"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                <span>Send SMS</span>
              </a>
              <a
                href={waHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors whitespace-nowrap"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Send on WhatsApp</span>
              </a>
            </div>
          </div>
        )}

        {mode === "script" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Script Type
              </label>
              <select
                value={scriptType}
                onChange={(e) =>
                  setScriptType(e.target.value as typeof scriptType)
                }
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              >
                <option value="youtube">YouTube Video Script</option>
                <option value="shorts">YouTube Shorts / Reels Script</option>
                <option value="speech">Speech / Presentation Script</option>
                <option value="whatsapp">WhatsApp Message / Notice Script</option>
                <option value="python">Python Automation Script (.py)</option>
                <option value="termux">Android Termux / Bash Script (.sh)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Topic or Goal
              </label>
              <textarea
                rows={3}
                value={scriptTopic}
                onChange={(e) => setScriptTopic(e.target.value)}
                placeholder="e.g. 5 morning study habits for kids, or auto-backup photos on Android"
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">
                Tone / Style
              </label>
              <input
                type="text"
                value={scriptTone}
                onChange={(e) => setScriptTone(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={onClose}
                className="px-3.5 py-2 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!scriptTopic.trim()}
                onClick={handleGenerateScript}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40 whitespace-nowrap"
              >
                <FileCode2 className="h-3.5 w-3.5" />
                <span>Generate Script</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
