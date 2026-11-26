// Background & lock-screen audio continuity helpers (MediaSession + Blob WAV + silent keep-alive + WakeLock + reliable playback)

let cachedSilentWavUrl: string | null = null;

/**
 * Generates a valid 1-second silent 8kHz mono 16-bit PCM WAV Blob URL.
 * Playing this silently while waiting for an AI reply keeps mobile Chrome/Safari's
 * audio session alive even if the user minimizes the app or locks the screen immediately.
 */
export function getSilentKeepAliveWavUrl(): string {
  if (cachedSilentWavUrl) return cachedSilentWavUrl;

  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const blob = new Blob([buffer], { type: "audio/wav" });
  cachedSilentWavUrl = URL.createObjectURL(blob);
  return cachedSilentWavUrl;
}

/**
 * Converts a base64 audio string into a Blob URL (more reliable than huge data: URIs for mobile background playback).
 */
export function base64ToAudioBlobUrl(
  base64: string,
  mimeType = "audio/wav"
): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

/**
 * Safely switches an unlocked HTMLAudioElement to a new Blob URL and starts playback
 * without hitting Chrome/Safari's "AbortError: play() interrupted by a new load request" race.
 */
export async function playAudioBlobReliably(
  audio: HTMLAudioElement,
  blobUrl: string
): Promise<void> {
  // Cleanly stop any prior silent keep-alive loop before loading new source
  audio.onended = null;
  audio.onerror = null;
  audio.loop = false;
  try {
    audio.pause();
  } catch {
    // ignore pause errors
  }
  audio.muted = false;
  audio.volume = 1.0;
  audio.src = blobUrl;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("canplay", finish);
      audio.removeEventListener("loadeddata", finish);
      audio.removeEventListener("error", finish);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(finish, 1200);
    audio.addEventListener("canplay", finish, { once: true });
    audio.addEventListener("loadeddata", finish, { once: true });
    audio.addEventListener("error", finish, { once: true });
    audio.load();
  });

  try {
    await audio.play();
  } catch (err) {
    // Retry once if interrupted by media load timing
    if (err instanceof DOMException && err.name === "AbortError") {
      await new Promise((r) => window.setTimeout(r, 150));
      await audio.play();
      return;
    }
    throw err;
  }
}

/**
 * Unlocks browser speechSynthesis inside a user gesture so fallback voice works on mobile Chrome/Safari.
 */
export function unlockBrowserSpeech(): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.getVoices();
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
}

function splitSpeechChunks(text: string, maxLen = 190): string[] {
  const sentences = text
    .split(/(?<=[.!?।॥\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const words = s.split(/\s+/);
      let part = "";
      for (const w of words) {
        if ((part + " " + w).trim().length > maxLen) {
          if (part) chunks.push(part);
          part = w;
        } else {
          part = (part + " " + w).trim();
        }
      }
      if (part) chunks.push(part);
    } else if ((current + " " + s).trim().length > maxLen) {
      if (current) chunks.push(current);
      current = s;
    } else {
      current = (current + " " + s).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
}

/**
 * Reliable chunked Web Speech fallback (avoids Chrome's 15-second long-utterance silence bug).
 */
export function speakWithChunkedBrowserTts(options: {
  text: string;
  bcp47?: string;
  isStillCurrent: () => boolean;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
}): boolean {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return false;
  }
  try {
    const clean = options.text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/[#*_>`~[\]()]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || !options.isStillCurrent()) return false;

    window.speechSynthesis.cancel();
    const voices = window.speechSynthesis.getVoices();
    const targetLang = options.bcp47 || "en-IN";
    const langPrefix = targetLang.split("-")[0].toLowerCase();
    const preferredVoice =
      voices.find((v) => v.lang.toLowerCase() === targetLang.toLowerCase()) ||
      voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) ||
      null;

    const chunks = splitSpeechChunks(clean);
    let idx = 0;

    const speakNext = () => {
      if (!options.isStillCurrent()) return;
      if (idx >= chunks.length) {
        options.onEnd?.();
        return;
      }
      const utter = new SpeechSynthesisUtterance(chunks[idx]);
      utter.lang = preferredVoice?.lang || targetLang;
      if (preferredVoice) utter.voice = preferredVoice;
      utter.rate = 0.98;
      utter.pitch = 1.0;

      utter.onend = () => {
        if (!options.isStillCurrent()) return;
        idx += 1;
        speakNext();
      };
      utter.onerror = (ev) => {
        if (!options.isStillCurrent()) return;
        if (ev.error === "canceled" || ev.error === "interrupted") return;
        options.onError?.();
      };

      window.speechSynthesis.speak(utter);
      try {
        window.speechSynthesis.resume();
      } catch {
        // ignore
      }
    };

    options.onStart?.();
    // Brief delay after cancel() prevents Chrome/Android from silently dropping the first utterance
    window.setTimeout(() => {
      if (options.isStillCurrent()) {
        speakNext();
      }
    }, 60);
    return true;
  } catch {
    return false;
  }
}

export interface MediaSessionHandlers {
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
}

export function updateJarvisMediaSession(options: {
  title: string;
  artist?: string;
  album?: string;
  playbackState: "playing" | "paused" | "none";
  handlers?: MediaSessionHandlers;
}): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }

  try {
    if (options.playbackState === "none") {
      navigator.mediaSession.playbackState = "none";
      return;
    }

    if (typeof MediaMetadata !== "undefined") {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: options.title.slice(0, 80),
        artist: options.artist || "Jogi Jarvis",
        album: options.album || "Human Voice Assistant",
        artwork: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    }

    navigator.mediaSession.playbackState = options.playbackState;

    if (options.handlers) {
      navigator.mediaSession.setActionHandler(
        "play",
        options.handlers.onPlay ? () => options.handlers?.onPlay?.() : null
      );
      navigator.mediaSession.setActionHandler(
        "pause",
        options.handlers.onPause ? () => options.handlers?.onPause?.() : null
      );
      navigator.mediaSession.setActionHandler(
        "stop",
        options.handlers.onStop ? () => options.handlers?.onStop?.() : null
      );
    }
  } catch {
    // Ignore unsupported MediaSession operations on older browsers
  }
}

export interface WakeLockHandle {
  release: () => Promise<void>;
}

export async function requestAudioWakeLock(): Promise<WakeLockHandle | null> {
  if (typeof navigator === "undefined") return null;
  try {
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (type: "screen") => Promise<WakeLockHandle>;
      };
    };
    if (nav.wakeLock) {
      return await nav.wakeLock.request("screen");
    }
  } catch {
    // WakeLock may be denied if page is already hidden or unsupported
  }
  return null;
}
