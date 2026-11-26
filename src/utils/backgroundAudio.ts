// Background & lock-screen audio continuity helpers (MediaSession + Blob WAV + silent keep-alive + WakeLock)

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
  // PCM samples remain 0 (silent)

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
