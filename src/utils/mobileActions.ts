import type { ActiveAlarm, AppTab, FamilyProfile, MobileAction } from "../types";

export type AppCommand =
  | { type: "tab"; tab: AppTab; autoStartVoice?: boolean }
  | { type: "watch" }
  | { type: "profile"; profileId: string; profileName: string }
  | {
      type: "read";
      text?: string;
      language?: string;
      readLastReply?: boolean;
      autoStart: boolean;
    };

export interface ParsedMobileIntent {
  actions: MobileAction[];
  autoAlarm?: Omit<ActiveAlarm, "id" | "ringing">;
  appCommand?: AppCommand;
  isScriptRequest: boolean;
  isDirectCommandOnly: boolean;
}

/**
 * Automatically navigates to a mobile action link (YouTube, WhatsApp, SMS, Phone,
 * Maps, Android Clock Intent, etc.) using a synthetic anchor click rather than window.open.
 * Must be called as close to the user gesture as possible for best mobile browser compatibility.
 */
export function triggerMobileAction(action: MobileAction): boolean {
  if (!action.href || typeof document === "undefined") return false;
  try {
    const a = document.createElement("a");
    a.href = action.href;
    if (action.external) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch {
    return false;
  }
}

function cleanPhoneDigits(raw: string): string {
  return raw.replace(/[^\d+]/g, "");
}

function buildAndroidClockAlarmIntent(
  hour24: number,
  minute: number,
  message: string
): string {
  const safeMsg = encodeURIComponent(message || "Jogi Jarvis Alarm");
  return `intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=${hour24};i.android.intent.extra.alarm.MINUTES=${minute};S.android.intent.extra.alarm.MESSAGE=${safeMsg};B.android.intent.extra.alarm.SKIP_UI=false;end`;
}

function buildAndroidTimerIntent(seconds: number, message: string): string {
  const safeMsg = encodeURIComponent(message || "Jogi Jarvis Timer");
  return `intent:#Intent;action=android.intent.action.SET_TIMER;i.android.intent.extra.alarm.LENGTH=${seconds};S.android.intent.extra.alarm.MESSAGE=${safeMsg};B.android.intent.extra.alarm.SKIP_UI=false;end`;
}

function buildGoogleCalendarUrl(title: string, startMs: number): string {
  const toCalDate = (ms: number) =>
    new Date(ms).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const start = toCalDate(startMs);
  const end = toCalDate(startMs + 30 * 60 * 1000);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(
    title
  )}&dates=${start}/${end}`;
}

export function formatAlarmTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRemainingCountdown(msLeft: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function parseMobileActions(
  rawInput: string,
  profiles: FamilyProfile[] = []
): ParsedMobileIntent {
  const text = rawInput.trim();
  const lower = text.toLowerCase();
  const actions: MobileAction[] = [];
  let autoAlarm: Omit<ActiveAlarm, "id" | "ringing"> | undefined;
  let appCommand: AppCommand | undefined;

  const isScriptRequest =
    /\b(script|youtube script|video script|reels? script|shorts? script|speech|python script|bash script|shell script|termux|automation script|code script|write a script|generate.*script)\b/i.test(
      text
    );

  // 0a. In-app direct Read Aloud command (e.g. "read aloud ...", "read this in Odia: ...", "read last answer")
  const readLastMatch =
    /\b(read|speak)\s+(?:the\s+)?(?:last|previous|this)\s+(?:answer|reply|message|text)\b/i.test(
      text
    );
  const readInLangMatch = text.match(
    /^(?:please\s+)?(?:read(?:\s+aloud)?|speak)\s+(?:this\s+)?(?:in\s+([a-zA-Z]+)\s*)?[:,-]\s*(.+)$/i
  );
  const readDirectMatch =
    !readInLangMatch &&
    text.match(
      /^(?:please\s+)?read\s+aloud(?:\s+in\s+([a-zA-Z]+))?\s+(.+)$/i
    );
  const openReadTabMatch =
    /\b(?:open|go\s+to|show|start)\s+(?:the\s+)?read(?:\s+aloud|\s+tab|\s+studio|\s+mode|er)?\b/i.test(
      lower
    );

  if (readLastMatch) {
    appCommand = { type: "read", readLastReply: true, autoStart: true };
  } else if (readInLangMatch) {
    appCommand = {
      type: "read",
      language: readInLangMatch[1]?.trim() || undefined,
      text: readInLangMatch[2]?.trim(),
      autoStart: true,
    };
  } else if (readDirectMatch) {
    appCommand = {
      type: "read",
      language: readDirectMatch[1]?.trim() || undefined,
      text: readDirectMatch[2]?.trim(),
      autoStart: true,
    };
  } else if (openReadTabMatch) {
    appCommand = { type: "tab", tab: "read" };
  }

  // 0b. In-app tab & profile navigation commands
  if (!appCommand) {
    if (
      /\b(?:open|go\s+to|show|switch\s+to)\s+(?:my\s+|the\s+)?(?:study\s+)?notes?\b/i.test(
        lower
      )
    ) {
      appCommand = { type: "tab", tab: "notes" };
    } else if (
      /\b(?:open|go\s+to|start|launch)\s+(?:the\s+)?(?:live\s+voice|voice\s+studio|talk\s+now|live\s+chat)\b/i.test(
        lower
      )
    ) {
      appCommand = { type: "tab", tab: "live", autoStartVoice: true };
    } else if (
      /\b(?:open|go\s+to|show)\s+(?:the\s+)?family(?:\s+profiles?)?\b/i.test(
        lower
      )
    ) {
      appCommand = { type: "tab", tab: "family" };
    } else if (
      /\b(?:open|go\s+to|start|enable)\s+(?:android\s+)?watch\s+mode\b/i.test(
        lower
      )
    ) {
      appCommand = { type: "watch" };
    } else if (profiles.length > 0) {
      const switchMatch = text.match(
        /\b(?:switch\s+to|use|open|select)\s+([a-zA-Z0-9\s]{2,28}?)(?:'s\s+profile|\s+profile|\s+mode)?$/i
      );
      if (switchMatch) {
        const candidate = switchMatch[1].trim().toLowerCase();
        const found = profiles.find(
          (p) =>
            p.name.toLowerCase() === candidate ||
            p.name.toLowerCase().includes(candidate) ||
            p.relation.toLowerCase() === candidate
        );
        if (found) {
          appCommand = {
            type: "profile",
            profileId: found.id,
            profileName: found.name,
          };
        }
      }
    }
  }

  // 1. YouTube open / search / play
  const ytMatch =
    text.match(
      /(?:open|launch|go to)\s+youtube(?:\s+(?:and\s+)?(?:search|play|watch|find|for)\s+(.+))?/i
    ) ||
    text.match(
      /(?:play|watch|search)\s+(.+?)\s+(?:on|in)\s+youtube/i
    ) ||
    text.match(/youtube\s+(?:search|play)\s+(.+)/i);

  if (ytMatch) {
    const query = (ytMatch[1] || "").trim().replace(/[.?!]+$/, "");
    actions.push({
      id: `act-yt-${Date.now()}`,
      kind: "youtube",
      label: query ? `Open YouTube: ${query.slice(0, 32)}` : "Open YouTube",
      subtitle: query
        ? "Opens YouTube app with your search"
        : "Launches YouTube on your phone",
      href: query
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        : "https://m.youtube.com",
      external: true,
    });
  }

  // 2. WhatsApp / SMS / Send Message
  const msgMatch = text.match(
    /(?:send\s+(?:a\s+)?(?:whatsapp|sms|text|message)|whatsapp|text|message)\s+(?:to\s+)?([^\s,]+(?:\s+[^\s,]+)?)(?:\s+(?:saying|that|message|:|-)\s*|\s*,\s*)(.+)/i
  );
  const simpleMsgIntent =
    !msgMatch &&
    /\b(send\s+(?:a\s+)?(?:whatsapp|sms|text|message)|open\s+whatsapp|compose\s+sms)\b/i.test(
      text
    );

  if (msgMatch) {
    const recipientRaw = (msgMatch[1] || "").trim();
    const body = (msgMatch[2] || "").trim();
    const digits = cleanPhoneDigits(recipientRaw);
    const waDigits = digits.replace(/^\+/, "");
    const wantsWhatsApp = /whatsapp/i.test(text);
    const wantsSms = /\b(sms|text)\b/i.test(text);

    if (wantsWhatsApp || !wantsSms) {
      actions.push({
        id: `act-wa-${Date.now()}`,
        kind: "whatsapp",
        label: `Send WhatsApp${recipientRaw ? ` to ${recipientRaw}` : ""}`,
        subtitle: body.slice(0, 48),
        href: waDigits.length >= 7
          ? `https://wa.me/${waDigits}?text=${encodeURIComponent(body)}`
          : `https://wa.me/?text=${encodeURIComponent(body)}`,
        external: true,
      });
    }

    if (wantsSms || !wantsWhatsApp) {
      actions.push({
        id: `act-sms-${Date.now() + 1}`,
        kind: "sms",
        label: `Send SMS${recipientRaw ? ` to ${recipientRaw}` : ""}`,
        subtitle: body.slice(0, 48),
        href: digits.length >= 4
          ? `sms:${digits}?body=${encodeURIComponent(body)}`
          : `sms:?body=${encodeURIComponent(body)}`,
        external: false,
      });
    }
  } else if (simpleMsgIntent) {
    const isWa = /whatsapp/i.test(text);
    actions.push({
      id: `act-msg-${Date.now()}`,
      kind: isWa ? "whatsapp" : "sms",
      label: isWa ? "Open WhatsApp" : "Open Messages (SMS)",
      subtitle: "Compose and send a message on your phone",
      href: isWa ? "https://wa.me/" : "sms:",
      external: isWa,
    });
  }

  // 3. Phone Call
  const callMatch = text.match(/\b(?:call|dial|phone)\s+([\d+\-\s()]{5,18})/i);
  if (callMatch) {
    const digits = cleanPhoneDigits(callMatch[1]);
    if (digits.length >= 4) {
      actions.push({
        id: `act-call-${Date.now()}`,
        kind: "call",
        label: `Call ${digits}`,
        subtitle: "Opens phone dialer",
        href: `tel:${digits}`,
        external: false,
      });
    }
  }

  // 4. Email
  const emailMatch = text.match(
    /(?:send\s+(?:an?\s+)?email|email)\s+(?:to\s+)?([\w.+-]+@[\w.-]+\.\w+)(?:\s+(?:about|subject|saying)\s+(.+))?/i
  );
  if (emailMatch) {
    const addr = emailMatch[1];
    const body = (emailMatch[2] || "").trim();
    actions.push({
      id: `act-mail-${Date.now()}`,
      kind: "email",
      label: `Email ${addr}`,
      subtitle: body ? body.slice(0, 45) : "Opens your mail app",
      href: `mailto:${addr}${body ? `?subject=${encodeURIComponent(body.slice(0, 60))}&body=${encodeURIComponent(body)}` : ""}`,
      external: false,
    });
  }

  // 5. Set Alarm (e.g., "set alarm for 6:30 am", "wake me up at 7 pm for gym")
  const alarmMatch = text.match(
    /(?:set\s+(?:an?\s+)?alarm|wake\s+me\s+(?:up\s+)?|alarm)\s*(?:for|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?:\s+(?:for|to|about|label)\s+(.+))?/i
  );
  if (alarmMatch) {
    let hour = parseInt(alarmMatch[1], 10);
    const minute = alarmMatch[2] ? parseInt(alarmMatch[2], 10) : 0;
    const meridiem = (alarmMatch[3] || "").toLowerCase().replace(/\./g, "");
    const label = (alarmMatch[4] || "Personal Alarm").trim().replace(/[.?!]+$/, "");

    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;

      const target = new Date();
      target.setHours(hour, minute, 0, 0);
      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }

      autoAlarm = {
        label,
        triggerAt: target.getTime(),
        type: "alarm",
      };

      actions.push({
        id: `act-alarm-android-${Date.now()}`,
        kind: "alarm",
        label: `Set in Android Clock (${formatAlarmTime(target.getTime())})`,
        subtitle: `Opens Android Clock app · "${label}"`,
        href: buildAndroidClockAlarmIntent(hour, minute, label),
        external: false,
      });

      actions.push({
        id: `act-alarm-cal-${Date.now() + 1}`,
        kind: "calendar",
        label: "Save Reminder to Google Calendar",
        subtitle: `${label} at ${formatAlarmTime(target.getTime())}`,
        href: buildGoogleCalendarUrl(label, target.getTime()),
        external: true,
      });
    }
  }

  // 6. Set Countdown Timer / Reminder in X minutes/seconds/hours
  const timerMatch = text.match(
    /(?:set\s+(?:a\s+)?timer|timer|remind\s+me\s+in)\s*(?:for|of)?\s*(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+(?:for|to)\s+(.+))?/i
  );
  if (timerMatch) {
    const qty = parseInt(timerMatch[1], 10);
    const unit = timerMatch[2].toLowerCase();
    const label = (timerMatch[3] || `${qty} ${unit} timer`)
      .trim()
      .replace(/[.?!]+$/, "");

    const seconds = unit.startsWith("h")
      ? qty * 3600
      : unit.startsWith("m")
        ? qty * 60
        : qty;

    if (seconds > 0 && seconds <= 24 * 3600) {
      const triggerAt = Date.now() + seconds * 1000;
      autoAlarm = {
        label,
        triggerAt,
        type: "timer",
      };

      actions.push({
        id: `act-timer-android-${Date.now()}`,
        kind: "timer",
        label: `Open in Android Clock Timer (${qty} ${unit})`,
        subtitle: `Also counting down live inside Jogi Jarvis`,
        href: buildAndroidTimerIntent(seconds, label),
        external: false,
      });
    }
  }

  // 7. Maps & Navigation
  const mapsMatch = text.match(
    /(?:open\s+(?:google\s+)?maps(?:\s+(?:for|to)\s+(.+))?|(?:navigate|directions)\s+to\s+(.+))/i
  );
  if (mapsMatch) {
    const place = (mapsMatch[1] || mapsMatch[2] || "")
      .trim()
      .replace(/[.?!]+$/, "");
    actions.push({
      id: `act-maps-${Date.now()}`,
      kind: "maps",
      label: place ? `Open Maps: ${place.slice(0, 32)}` : "Open Google Maps",
      subtitle: "Launches Google Maps on your phone",
      href: place
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`
        : "https://maps.google.com",
      external: true,
    });
  }

  // 8. Popular Mobile Apps / Quick Web Launch
  const appShortcuts: Array<{
    regex: RegExp;
    label: string;
    href: string;
    subtitle: string;
  }> = [
    {
      regex: /\bopen\s+spotify\b/i,
      label: "Open Spotify",
      href: "https://open.spotify.com",
      subtitle: "Opens Spotify music app",
    },
    {
      regex: /\bopen\s+instagram\b/i,
      label: "Open Instagram",
      href: "https://www.instagram.com",
      subtitle: "Opens Instagram on mobile",
    },
    {
      regex: /\bopen\s+gmail\b/i,
      label: "Open Gmail",
      href: "https://mail.google.com",
      subtitle: "Opens Gmail inbox",
    },
    {
      regex: /\bopen\s+(?:google\s+)?calendar\b/i,
      label: "Open Google Calendar",
      href: "https://calendar.google.com",
      subtitle: "View and schedule reminders",
    },
  ];

  for (const sc of appShortcuts) {
    if (sc.regex.test(lower)) {
      actions.push({
        id: `act-app-${Date.now()}-${sc.label.length}`,
        kind: "web",
        label: sc.label,
        subtitle: sc.subtitle,
        href: sc.href,
        external: true,
      });
    }
  }

  const isDirectCommandOnly =
    !isScriptRequest &&
    (Boolean(appCommand) ||
      ((actions.length > 0 || Boolean(autoAlarm)) &&
        text.length <= 140 &&
        !/\b(explain|why|how does|what is|write|teach|solve|summarize)\b/i.test(
          lower
        )));

  return {
    actions,
    autoAlarm,
    appCommand,
    isScriptRequest,
    isDirectCommandOnly,
  };
}

/**
 * Downloads a generated script (Python, Bash/Termux, JavaScript, or Video/Speech script)
 * directly to the user's phone/desktop with the appropriate file extension.
 */
export function downloadGeneratedScript(content: string, hint = "jogi-jarvis-script") {
  const codeBlockMatch = content.match(/```(\w+)?\n([\s\S]*?)```/);
  const lang = (codeBlockMatch?.[1] || "").toLowerCase();
  const body = codeBlockMatch ? codeBlockMatch[2].trim() : content.trim();

  const extMap: Record<string, string> = {
    python: "py",
    py: "py",
    bash: "sh",
    sh: "sh",
    shell: "sh",
    javascript: "js",
    js: "js",
    typescript: "ts",
    ts: "ts",
    html: "html",
    json: "json",
  };
  const ext = extMap[lang] || "txt";
  const safeName =
    hint
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "jogi-jarvis-script";

  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Plays a clear, pleasant Web Audio chime when an in-app alarm or timer finishes.
 */
export function playAlarmChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = [880, 1108.73, 1318.51, 880, 1108.73, 1318.51];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.22;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.24, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.22);
    });
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 1800);
  } catch {
    // Ignore autoplay restriction if audio context is locked
  }
}
