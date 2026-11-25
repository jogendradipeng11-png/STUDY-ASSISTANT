/**
 * Audio encoding/decoding helpers for Gemini Live API (16kHz input PCM / 24kHz output PCM)
 * and unary Gemini TTS WAV playback.
 */

export function float32ToPcm16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToPcm16Float32(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const samples = new Float32Array(new ArrayBuffer(sampleCount * 4));
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    samples[i] = int16 / 32768;
  }
  return samples;
}

export class LiveAudioPlayer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private onSpeakingChange?: (speaking: boolean) => void;

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: 24000 });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public enqueuePcmBase64(base64: string): void {
    const ctx = this.ensureContext();
    const floatData = base64ToPcm16Float32(base64);
    if (floatData.length === 0) return;

    const buffer = ctx.createBuffer(1, floatData.length, 24000);
    buffer.copyToChannel(floatData, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (this.analyser) {
      source.connect(this.analyser);
    } else {
      source.connect(ctx.destination);
    }

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.02, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    if (this.activeSources.size === 1) {
      this.onSpeakingChange?.(true);
    }

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) {
        this.onSpeakingChange?.(false);
      }
    };

    source.start(startAt);
  }

  public getOutputLevel(): number {
    if (!this.analyser || this.activeSources.size === 0) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const normalized = (data[i] - 128) / 128;
      sum += normalized * normalized;
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 3.2);
  }

  public interrupt(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // ignore already stopped
      }
    }
    this.activeSources.clear();
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    } else {
      this.nextStartTime = 0;
    }
    this.onSpeakingChange?.(false);
  }

  public async close(): Promise<void> {
    this.interrupt();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
      this.analyser = null;
    }
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read audio recording."));
    reader.readAsDataURL(blob);
  });
}
