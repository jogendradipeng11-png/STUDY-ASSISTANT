import { useEffect, useRef, useState } from "react";
import { AlarmClock, BellRing, Plus, Timer, X } from "lucide-react";
import type { ActiveAlarm } from "../types";
import {
  formatAlarmTime,
  formatRemainingCountdown,
  playAlarmChime,
} from "../utils/mobileActions";

interface AlarmTrayProps {
  alarms: ActiveAlarm[];
  onDismissAlarm: (id: string) => void;
  onSnoozeAlarm: (id: string, minutes: number) => void;
  onMarkRinging: (id: string) => void;
}

export function AlarmTray({
  alarms,
  onDismissAlarm,
  onSnoozeAlarm,
  onMarkRinging,
}: AlarmTrayProps) {
  const [now, setNow] = useState(() => Date.now());
  const chimedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (alarms.length === 0) return;
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [alarms.length]);

  useEffect(() => {
    for (const alarm of alarms) {
      if (now >= alarm.triggerAt && !alarm.ringing) {
        onMarkRinging(alarm.id);
      }
      if (now >= alarm.triggerAt && !chimedIdsRef.current.has(alarm.id)) {
        chimedIdsRef.current.add(alarm.id);
        playAlarmChime();
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          try {
            new Notification(`Jogi Jarvis: ${alarm.label}`, {
              body:
                alarm.type === "timer"
                  ? "Your timer is complete."
                  : `Alarm for ${formatAlarmTime(alarm.triggerAt)}`,
              icon: "/pwa-192x192.png",
            });
          } catch {
            // ignore notification errors
          }
        }
      }
    }
  }, [alarms, now, onMarkRinging]);

  // Repeat chime gently every 6 seconds while an alarm is actively ringing
  const hasRinging = alarms.some((a) => a.ringing || now >= a.triggerAt);
  useEffect(() => {
    if (!hasRinging) return;
    const id = window.setInterval(() => {
      playAlarmChime();
    }, 6000);
    return () => window.clearInterval(id);
  }, [hasRinging]);

  if (alarms.length === 0) return null;

  return (
    <div className="no-print fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-xs w-[calc(100vw-2rem)]">
      {alarms.map((alarm) => {
        const isRinging = alarm.ringing || now >= alarm.triggerAt;
        const remaining = alarm.triggerAt - now;

        return (
          <div
            key={alarm.id}
            role="status"
            aria-live="assertive"
            className={`rounded-xl border px-3.5 py-2.5 shadow-lg flex items-center justify-between gap-3 ${
              isRinging
                ? "bg-amber-600 border-amber-500 text-white"
                : "bg-slate-900 border-slate-800 text-white"
            }`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              {isRinging ? (
                <BellRing className="h-4 w-4 shrink-0 animate-bounce" />
              ) : alarm.type === "timer" ? (
                <Timer className="h-4 w-4 shrink-0 text-blue-400" />
              ) : (
                <AlarmClock className="h-4 w-4 shrink-0 text-amber-400" />
              )}
              <div className="min-w-0">
                <p className="text-xs font-semibold truncate">{alarm.label}</p>
                <p className="text-[11px] font-mono tabular-nums opacity-90">
                  {isRinging
                    ? "Time is up!"
                    : alarm.type === "timer"
                      ? `${formatRemainingCountdown(remaining)} left`
                      : `${formatAlarmTime(alarm.triggerAt)} (${formatRemainingCountdown(remaining)})`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {isRinging && (
                <button
                  type="button"
                  onClick={() => {
                    chimedIdsRef.current.delete(alarm.id);
                    onSnoozeAlarm(alarm.id, 5);
                  }}
                  title="Snooze 5 minutes"
                  className="inline-flex items-center gap-0.5 px-2 py-1 rounded-md text-[11px] font-semibold bg-white/20 hover:bg-white/30 text-white whitespace-nowrap"
                >
                  <Plus className="h-3 w-3" />
                  <span>5m</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  chimedIdsRef.current.delete(alarm.id);
                  onDismissAlarm(alarm.id);
                }}
                aria-label={`Dismiss ${alarm.label}`}
                className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap ${
                  isRinging
                    ? "bg-white text-amber-900 hover:bg-amber-50"
                    : "text-slate-300 hover:text-white hover:bg-slate-800"
                }`}
              >
                {isRinging ? "Stop" : <X className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
