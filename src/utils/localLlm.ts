import type { ChatMessage, FamilyProfile } from "../types";

export type LocalModelTier = "mobile" | "mid" | "large";

export interface LocalModelOption {
  key: string;
  label: string;
  tier: LocalModelTier;
  sizeLabel: string;
  vramLabel: string;
  bestFor: string;
  f16Id: string;
  f32Id: string;
  /** Optional official 1k-context low-VRAM variant in WebLLM prebuiltAppConfig */
  f16Id1k?: string;
  f32Id1k?: string;
}

export const LOCAL_LLM_MODELS: LocalModelOption[] = [
  // Phone & Everyday (Low VRAM)
  {
    key: "smollm2-360m",
    label: "SmolLM2 360M",
    tier: "mobile",
    sizeLabel: "~280 MB",
    vramLabel: "~0.4 GB RAM",
    bestFor: "Fastest on phones & older laptops",
    f16Id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    f32Id: "SmolLM2-360M-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-0.5b",
    label: "Qwen 2.5 0.5B",
    tier: "mobile",
    sizeLabel: "~400 MB",
    vramLabel: "~1 GB RAM",
    bestFor: "Lightweight Hindi & world languages on phones",
    f16Id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama-3.2-1b",
    label: "Llama 3.2 1B",
    tier: "mobile",
    sizeLabel: "~700 MB",
    vramLabel: "~1 GB RAM",
    bestFor: "Recommended balanced everyday Jarvis",
    f16Id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    f32Id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-1.5b",
    label: "Qwen 2.5 1.5B",
    tier: "mobile",
    sizeLabel: "~1.0 GB",
    vramLabel: "~1.6 GB RAM",
    bestFor: "Strong study tutoring, math & multilingual",
    f16Id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
  },
  {
    key: "gemma-2-2b",
    label: "Gemma 2 2B",
    tier: "mobile",
    sizeLabel: "~1.5 GB",
    vramLabel: "~2 GB RAM",
    bestFor: "Google Gemma 2 · Clear explanations & writing",
    f16Id: "gemma-2-2b-it-q4f16_1-MLC",
    f32Id: "gemma-2-2b-it-q4f32_1-MLC",
    f16Id1k: "gemma-2-2b-it-q4f16_1-MLC-1k",
    f32Id1k: "gemma-2-2b-it-q4f32_1-MLC-1k",
  },

  // Mid-Size Power (Laptops & Flagship Phones)
  {
    key: "llama-3.2-3b",
    label: "Llama 3.2 3B",
    tier: "mid",
    sizeLabel: "~1.9 GB",
    vramLabel: "~2.5 GB VRAM",
    bestFor: "Fast & smart all-rounder for laptops",
    f16Id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    f32Id: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-3b",
    label: "Qwen 2.5 3B",
    tier: "mid",
    sizeLabel: "~2.0 GB",
    vramLabel: "~2.6 GB VRAM",
    bestFor: "Strong Indian languages, math & coding",
    f16Id: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-3B-Instruct-q4f32_1-MLC",
  },
  {
    key: "phi-3.5-mini",
    label: "Phi 3.5 Mini 3.8B",
    tier: "mid",
    sizeLabel: "~2.4 GB",
    vramLabel: "~3.7 GB VRAM",
    bestFor: "Microsoft 3.8B · Deep reasoning & science",
    f16Id: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    f32Id: "Phi-3.5-mini-instruct-q4f32_1-MLC",
    f16Id1k: "Phi-3.5-mini-instruct-q4f16_1-MLC-1k",
    f32Id1k: "Phi-3.5-mini-instruct-q4f32_1-MLC-1k",
  },

  // Large Pro Models (Desktop / Laptop GPUs · 6–8+ GB VRAM)
  {
    key: "mistral-7b-v0.3",
    label: "Mistral 7B v0.3",
    tier: "large",
    sizeLabel: "~4.2 GB",
    vramLabel: "~4.6 GB VRAM",
    bestFor: "Large 7B · Rich writing & daily assistant",
    f16Id: "Mistral-7B-Instruct-v0.3-q4f16_1-MLC",
    f32Id: "Mistral-7B-Instruct-v0.3-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-7b",
    label: "Qwen 2.5 7B",
    tier: "large",
    sizeLabel: "~4.5 GB",
    vramLabel: "~5.1 GB VRAM",
    bestFor: "Large 7B · Top multilingual, math & tutoring",
    f16Id: "Qwen2.5-7B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-7B-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama-3.1-8b",
    label: "Llama 3.1 8B",
    tier: "large",
    sizeLabel: "~4.6 GB",
    vramLabel: "~5.0 GB VRAM",
    bestFor: "Large 8B · Meta flagship on-device model",
    f16Id: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
    f32Id: "Llama-3.1-8B-Instruct-q4f32_1-MLC",
    f16Id1k: "Llama-3.1-8B-Instruct-q4f16_1-MLC-1k",
    f32Id1k: "Llama-3.1-8B-Instruct-q4f32_1-MLC-1k",
  },
  {
    key: "deepseek-r1-7b",
    label: "DeepSeek-R1 7B",
    tier: "large",
    sizeLabel: "~4.5 GB",
    vramLabel: "~5.1 GB VRAM",
    bestFor: "Large 7B Reasoning · Step-by-step math & STEM",
    f16Id: "DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC",
    f32Id: "DeepSeek-R1-Distill-Qwen-7B-q4f32_1-MLC",
  },
  {
    key: "gemma-2-9b",
    label: "Gemma 2 9B",
    tier: "large",
    sizeLabel: "~5.5 GB",
    vramLabel: "~6.4 GB VRAM",
    bestFor: "Largest 9B · Highest quality on-device AI",
    f16Id: "gemma-2-9b-it-q4f16_1-MLC",
    f32Id: "gemma-2-9b-it-q4f32_1-MLC",
  },
];

const CACHED_MODELS_STORAGE_KEY = "jogi_jarvis_cached_local_models_v1";

export interface LocalLlmProgress {
  progress: number; // 0 to 1
  text: string;
}

export interface WebGpuSupportInfo {
  supported: boolean;
  supportsF16: boolean;
  maxBufferMB?: number;
  isLowVramDevice?: boolean;
  reason?: string;
}

export class LocalLlmGpuError extends Error {
  public readonly suggestedModelKey: string;
  public readonly rawError: string;

  constructor(message: string, suggestedModelKey: string, rawError: string) {
    super(message);
    this.name = "LocalLlmGpuError";
    this.suggestedModelKey = suggestedModelKey;
    this.rawError = rawError;
  }
}

type WebLlmEngine = {
  chat: {
    completions: {
      create: (params: {
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        stream: true;
        temperature?: number;
        max_tokens?: number;
      }) => Promise<
        AsyncIterable<{
          choices?: Array<{ delta?: { content?: string | null } }>;
        }>
      >;
    };
  };
  resetChat?: (keepStats?: boolean) => Promise<void>;
  unload?: () => Promise<void>;
};

let cachedEngine: WebLlmEngine | null = null;
let cachedWorker: Worker | null = null;
let loadedModelKey: string | null = null;
let loadedLowMemoryMode = false;
let loadingPromise: Promise<WebLlmEngine> | null = null;
let loadingModelKey: string | null = null;
let activeInferencePromise: Promise<unknown> | null = null;

function isWebGpuContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /mapAsync|GPUBuffer|external Instance reference|device lost|GPUDevice|GPUValidationError|out of memory|oom|allocation|context lost|disposed|terminated|Wasm|memory access out of bounds/i.test(
    msg
  );
}

function getSuggestedLighterModelKey(currentKey: string): string {
  const current = LOCAL_LLM_MODELS.find((m) => m.key === currentKey);
  if (!current) return "llama-3.2-1b";
  if (current.tier === "large") return "llama-3.2-3b";
  if (current.tier === "mid") return "llama-3.2-1b";
  if (current.key !== "smollm2-360m") return "smollm2-360m";
  return "smollm2-360m";
}

function resolveModelId(
  modelMeta: LocalModelOption,
  supportsF16: boolean,
  lowMemoryMode: boolean
): string {
  if (lowMemoryMode) {
    if (supportsF16 && modelMeta.f16Id1k) return modelMeta.f16Id1k;
    if (!supportsF16 && modelMeta.f32Id1k) return modelMeta.f32Id1k;
  }
  return supportsF16 ? modelMeta.f16Id : modelMeta.f32Id;
}

export function getRecordedDownloadedModels(): string[] {
  try {
    const raw = localStorage.getItem(CACHED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = new Set(LOCAL_LLM_MODELS.map((m) => m.key));
    return parsed.filter((k): k is string => typeof k === "string" && valid.has(k));
  } catch {
    return [];
  }
}

function saveRecordedDownloadedModels(keys: string[]): void {
  try {
    localStorage.setItem(
      CACHED_MODELS_STORAGE_KEY,
      JSON.stringify(Array.from(new Set(keys)))
    );
  } catch {
    // ignore storage errors
  }
}

function recordDownloadedModel(key: string): void {
  const existing = getRecordedDownloadedModels();
  if (!existing.includes(key)) {
    saveRecordedDownloadedModels([...existing, key]);
  }
}

export async function syncCachedLocalModels(): Promise<string[]> {
  const recorded = new Set(getRecordedDownloadedModels());
  try {
    const webllm = await import("@mlc-ai/web-llm");
    if (typeof webllm.hasModelInCache === "function") {
      await Promise.all(
        LOCAL_LLM_MODELS.map(async (m) => {
          try {
            const candidateIds = [m.f16Id, m.f32Id, m.f16Id1k, m.f32Id1k].filter(
              (id): id is string => Boolean(id)
            );
            let found = false;
            for (const id of candidateIds) {
              if (await webllm.hasModelInCache(id)) {
                found = true;
                break;
              }
            }
            if (found) {
              recorded.add(m.key);
            } else {
              recorded.delete(m.key);
            }
          } catch {
            // ignore individual check errors
          }
        })
      );
    }
  } catch {
    // ignore if webllm cannot be imported
  }
  const result = Array.from(recorded);
  saveRecordedDownloadedModels(result);
  return result;
}

export async function deleteCachedLocalModel(modelKey: string): Promise<string[]> {
  const modelMeta = LOCAL_LLM_MODELS.find((m) => m.key === modelKey);
  if (loadedModelKey === modelKey) {
    await unloadLocalLlmModel();
  }
  if (modelMeta) {
    try {
      const webllm = await import("@mlc-ai/web-llm");
      if (typeof webllm.deleteModelAllInfoInCache === "function") {
        const ids = [
          modelMeta.f16Id,
          modelMeta.f32Id,
          modelMeta.f16Id1k,
          modelMeta.f32Id1k,
        ].filter((id): id is string => Boolean(id));
        await Promise.allSettled(ids.map((id) => webllm.deleteModelAllInfoInCache(id)));
      }
    } catch {
      // ignore cache delete errors
    }
  }
  const remaining = getRecordedDownloadedModels().filter((k) => k !== modelKey);
  saveRecordedDownloadedModels(remaining);
  return remaining;
}

export async function checkWebGpuSupport(): Promise<WebGpuSupportInfo> {
  if (typeof navigator === "undefined") {
    return {
      supported: false,
      supportsF16: false,
      reason: "Browser environment not detected.",
    };
  }
  const nav = navigator as Navigator & {
    gpu?: {
      requestAdapter: (opts?: { powerPreference?: string }) => Promise<{
        features?: { has: (name: string) => boolean };
        limits?: {
          maxBufferSize?: number;
          maxStorageBufferBindingSize?: number;
        };
      } | null>;
    };
  };

  if (!nav.gpu) {
    return {
      supported: false,
      supportsF16: false,
      reason:
        "WebGPU is not enabled in this browser. Open in Chrome/Edge 113+ or Android Chrome for direct browser Local AI, or use Auto Cloud mode.",
    };
  }

  try {
    const adapter =
      (await nav.gpu.requestAdapter({ powerPreference: "high-performance" })) ||
      (await nav.gpu.requestAdapter());
    if (!adapter) {
      return {
        supported: false,
        supportsF16: false,
        reason:
          "No compatible WebGPU adapter was found on this device. You can still use Cloud Auto mode (Gemini + NVIDIA NIM).",
      };
    }
    const supportsF16 = Boolean(adapter.features?.has("shader-f16"));
    const maxBufferBytes = adapter.limits?.maxBufferSize || 0;
    const maxBufferMB = maxBufferBytes
      ? Math.round(maxBufferBytes / (1024 * 1024))
      : undefined;
    const isMobileUa =
      typeof navigator !== "undefined" &&
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const isLowVramDevice =
      isMobileUa || (typeof maxBufferMB === "number" && maxBufferMB < 1024);

    return {
      supported: true,
      supportsF16,
      maxBufferMB,
      isLowVramDevice,
    };
  } catch {
    return {
      supported: false,
      supportsF16: false,
      reason: "WebGPU initialization was blocked by the browser.",
    };
  }
}

export function getLoadedLocalModelKey(): string | null {
  return loadedModelKey;
}

function forceResetLocalEngineState(): void {
  if (cachedWorker) {
    try {
      cachedWorker.terminate();
    } catch {
      // ignore worker termination errors
    }
    cachedWorker = null;
  }
  cachedEngine = null;
  loadedModelKey = null;
  loadedLowMemoryMode = false;
  loadingPromise = null;
  loadingModelKey = null;
}

export async function unloadLocalLlmModel(): Promise<void> {
  const engineToUnload = cachedEngine;
  const workerToStop = cachedWorker;

  cachedEngine = null;
  cachedWorker = null;
  loadedModelKey = null;
  loadedLowMemoryMode = false;
  loadingPromise = null;
  loadingModelKey = null;

  if (engineToUnload?.unload) {
    try {
      await Promise.race([
        engineToUnload.unload(),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // ignore unload error if GPU device was already lost
    }
  }
  if (workerToStop) {
    try {
      workerToStop.terminate();
    } catch {
      // ignore
    }
  }
}

export async function loadLocalLlmModel(
  modelKey: string,
  onProgress?: (info: LocalLlmProgress) => void,
  options?: { forceReload?: boolean; lowMemoryMode?: boolean }
): Promise<WebLlmEngine> {
  const modelMeta =
    LOCAL_LLM_MODELS.find((m) => m.key === modelKey) || LOCAL_LLM_MODELS[2];
  const wantLowMemory = Boolean(options?.lowMemoryMode);

  if (
    !options?.forceReload &&
    cachedEngine &&
    loadedModelKey === modelMeta.key &&
    loadedLowMemoryMode === wantLowMemory
  ) {
    recordDownloadedModel(modelMeta.key);
    onProgress?.({ progress: 1, text: `${modelMeta.label} ready on device` });
    return cachedEngine;
  }

  if (!options?.forceReload && loadingPromise && loadingModelKey === modelMeta.key) {
    return loadingPromise;
  }

  const gpu = await checkWebGpuSupport();
  if (!gpu.supported) {
    throw new Error(
      gpu.reason || "WebGPU is not available on this device for in-browser Local AI."
    );
  }

  // Always terminate prior worker / unload prior model cleanly to free GPU VRAM
  if (cachedEngine || cachedWorker) {
    await unloadLocalLlmModel();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const effectiveLowMem = wantLowMemory || Boolean(gpu.isLowVramDevice);
  const resolvedModelId = resolveModelId(modelMeta, gpu.supportsF16, effectiveLowMem);
  const safeContextWindow = effectiveLowMem
    ? 1024
    : modelMeta.tier === "large"
      ? 2048
      : 2048;

  loadingModelKey = modelMeta.key;

  loadingPromise = (async () => {
    let worker: Worker | null = null;
    try {
      onProgress?.({
        progress: 0.02,
        text: effectiveLowMem
          ? `Loading ${modelMeta.label} in safe low-VRAM mode…`
          : `Loading ${modelMeta.label} (${modelMeta.sizeLabel})…`,
      });
      const webllm = await import("@mlc-ai/web-llm");

      const engineConfig = {
        initProgressCallback: (report: { progress?: number; text?: string }) => {
          onProgress?.({
            progress: typeof report.progress === "number" ? report.progress : 0,
            text: report.text || `Loading ${modelMeta.label}…`,
          });
        },
      };
      const chatOpts = {
        context_window_size: safeContextWindow,
      };

      let engine: WebLlmEngine;
      if (
        typeof Worker !== "undefined" &&
        typeof webllm.CreateWebWorkerMLCEngine === "function"
      ) {
        try {
          worker = new Worker(new URL("./localLlmWorker.ts", import.meta.url), {
            type: "module",
          });
          worker.onerror = () => {
            if (cachedWorker === worker) {
              forceResetLocalEngineState();
            }
          };
          worker.onmessageerror = () => {
            if (cachedWorker === worker) {
              forceResetLocalEngineState();
            }
          };
          engine = (await webllm.CreateWebWorkerMLCEngine(
            worker,
            resolvedModelId,
            engineConfig,
            chatOpts
          )) as unknown as WebLlmEngine;
        } catch (workerErr) {
          if (worker) {
            try {
              worker.terminate();
            } catch {
              // ignore
            }
            worker = null;
          }
          // Only fall back to main thread if Worker instantiation itself failed (not GPU OOM)
          if (isWebGpuContextError(workerErr)) {
            throw workerErr;
          }
          engine = (await webllm.CreateMLCEngine(
            resolvedModelId,
            engineConfig,
            chatOpts
          )) as unknown as WebLlmEngine;
        }
      } else {
        engine = (await webllm.CreateMLCEngine(
          resolvedModelId,
          engineConfig,
          chatOpts
        )) as unknown as WebLlmEngine;
      }

      cachedWorker = worker;
      cachedEngine = engine;
      loadedModelKey = modelMeta.key;
      loadedLowMemoryMode = wantLowMemory;
      recordDownloadedModel(modelMeta.key);
      onProgress?.({ progress: 1, text: `${modelMeta.label} ready on device` });
      return engine;
    } catch (err) {
      if (worker) {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
      }
      forceResetLocalEngineState();
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (isWebGpuContextError(err)) {
        const suggested = getSuggestedLighterModelKey(modelMeta.key);
        const suggestedLabel =
          LOCAL_LLM_MODELS.find((m) => m.key === suggested)?.label || "Llama 3.2 1B";
        throw new LocalLlmGpuError(
          `${modelMeta.label} (${modelMeta.vramLabel}) exceeded this device's WebGPU buffer/memory limit. Try ${suggestedLabel} or Cloud Auto mode.`,
          suggested,
          rawMsg
        );
      }
      throw err;
    } finally {
      loadingPromise = null;
      loadingModelKey = null;
    }
  })();

  return loadingPromise;
}

function stripLocalThinkingTags(raw: string): string {
  const withoutComplete = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const openIdx = withoutComplete.toLowerCase().indexOf("<think>");
  if (openIdx !== -1) {
    return withoutComplete.slice(0, openIdx).trim();
  }
  return withoutComplete.trim();
}

function buildLocalSystemPrompt(options: {
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  spokenMode?: boolean;
}): string {
  const { profile, subject, language, spokenMode } = options;
  const langRule =
    language && language !== "Auto-Detect"
      ? `Reply clearly and naturally in ${language}.`
      : "Reply naturally in the exact same language the user used.";
  const spokenRule = spokenMode
    ? "Keep your answer warm, conversational, and easy to listen to aloud (no raw markdown noise)."
    : "Give a clear, well-structured, concise answer.";

  if (profile.role === "student") {
    return [
      `You are Jogi Jarvis, a warm, patient AI study teacher for ${profile.name}${profile.grade ? ` (${profile.grade})` : ""}.`,
      subject && subject !== "All Subjects"
        ? `Focus on ${subject}.`
        : "Help with any school subject.",
      "Explain concepts step-by-step with clear examples and verify calculations carefully.",
      langRule,
      spokenRule,
    ].join(" ");
  }

  return [
    `You are Jogi Jarvis, the dedicated personal AI assistant for ${profile.name} and their family.`,
    "Give helpful, direct, warm, and accurate answers.",
    langRule,
    spokenRule,
  ].join(" ");
}

function buildSafeLocalMessages(options: {
  modelKey: string;
  systemPrompt: string;
  messages: ChatMessage[];
  maxHistory: number;
  maxCharsPerMsg: number;
}): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recent = options.messages.slice(-options.maxHistory);
  const normalized: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of recent) {
    const role: "user" | "assistant" =
      m.role === "assistant" ? "assistant" : "user";
    const text = (m.content || "").trim().slice(0, options.maxCharsPerMsg);
    if (!text) continue;

    // Ensure history starts with a user turn (required by Gemma / Mistral / Llama templates)
    if (normalized.length === 0 && role === "assistant") {
      continue;
    }

    // Merge consecutive messages of the same role so templates never fail
    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${text}`.slice(0, options.maxCharsPerMsg);
    } else {
      normalized.push({ role, content: text });
    }
  }

  if (normalized.length === 0) {
    normalized.push({ role: "user", content: "Hello" });
  }

  // Gemma 2 chat templates reject or break on standalone system role in WebLLM
  if (/gemma/i.test(options.modelKey)) {
    const first = normalized[0];
    normalized[0] = {
      role: "user",
      content: `Instructions: ${options.systemPrompt}\n\nRequest: ${first.content}`,
    };
    return normalized;
  }

  return [{ role: "system", content: options.systemPrompt }, ...normalized];
}

async function runSingleLocalCompletion(options: {
  modelMeta: LocalModelOption;
  messages: ChatMessage[];
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  spokenMode?: boolean;
  lowMemoryMode: boolean;
  forceReload: boolean;
  onProgress?: (info: LocalLlmProgress) => void;
  onDelta: (accumulated: string) => void;
}): Promise<string> {
  const engine = await loadLocalLlmModel(options.modelMeta.key, options.onProgress, {
    forceReload: options.forceReload,
    lowMemoryMode: options.lowMemoryMode,
  });

  const systemPrompt = buildLocalSystemPrompt({
    profile: options.profile,
    subject: options.subject,
    language: options.language,
    spokenMode: options.spokenMode,
  });

  const chatMessages = buildSafeLocalMessages({
    modelKey: options.modelMeta.key,
    systemPrompt,
    messages: options.messages,
    maxHistory: options.lowMemoryMode ? 4 : options.modelMeta.tier === "large" ? 8 : 6,
    maxCharsPerMsg: options.lowMemoryMode ? 900 : 1600,
  });

  // Reset KV cache cleanly before each completion so stale GPU buffers don't accumulate
  if (typeof engine.resetChat === "function") {
    try {
      await engine.resetChat(false);
    } catch {
      // ignore if engine doesn't need reset
    }
  }

  const completion = await engine.chat.completions.create({
    messages: chatMessages,
    stream: true,
    temperature: 0.6,
    max_tokens: options.lowMemoryMode
      ? 512
      : options.modelMeta.tier === "mobile"
        ? 768
        : 1024,
  });

  let rawAccumulated = "";
  for await (const chunk of completion) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      rawAccumulated += delta;
      const cleaned = stripLocalThinkingTags(rawAccumulated);
      if (cleaned) {
        options.onDelta(cleaned);
      }
    }
  }

  return stripLocalThinkingTags(rawAccumulated);
}

export async function streamLocalLlmChat(options: {
  modelKey: string;
  messages: ChatMessage[];
  profile: FamilyProfile;
  subject?: string;
  language?: string;
  spokenMode?: boolean;
  onProgress?: (info: LocalLlmProgress) => void;
  onDelta: (accumulated: string) => void;
}): Promise<string> {
  // Serialize inference so two WebGPU passes can never race on the same GPUBuffer
  if (activeInferencePromise) {
    try {
      await activeInferencePromise;
    } catch {
      // ignore previous error
    }
  }

  const modelMeta =
    LOCAL_LLM_MODELS.find((m) => m.key === options.modelKey) ||
    LOCAL_LLM_MODELS[2];

  const task = (async (): Promise<string> => {
    try {
      return await runSingleLocalCompletion({
        modelMeta,
        messages: options.messages,
        profile: options.profile,
        subject: options.subject,
        language: options.language,
        spokenMode: options.spokenMode,
        lowMemoryMode: false,
        forceReload: false,
        onProgress: options.onProgress,
        onDelta: options.onDelta,
      });
    } catch (firstErr) {
      if (!isWebGpuContextError(firstErr)) {
        throw firstErr;
      }

      // GPU device / GPUBuffer external Instance reference was lost:
      // Hard-terminate dead Web Worker, wait briefly for browser Dawn cleanup, and auto-retry ONCE in safe low-VRAM mode.
      await unloadLocalLlmModel();
      options.onProgress?.({
        progress: 0.15,
        text: `GPU reset detected — recovering ${modelMeta.label} in safe low-VRAM mode…`,
      });
      await new Promise((resolve) => setTimeout(resolve, 350));

      try {
        return await runSingleLocalCompletion({
          modelMeta,
          messages: options.messages,
          profile: options.profile,
          subject: options.subject,
          language: options.language,
          spokenMode: options.spokenMode,
          lowMemoryMode: true,
          forceReload: true,
          onProgress: options.onProgress,
          onDelta: options.onDelta,
        });
      } catch (retryErr) {
        await unloadLocalLlmModel();
        const rawMsg =
          retryErr instanceof Error ? retryErr.message : String(retryErr);
        const suggested = getSuggestedLighterModelKey(modelMeta.key);
        const suggestedLabel =
          LOCAL_LLM_MODELS.find((m) => m.key === suggested)?.label ||
          "Llama 3.2 1B";
        throw new LocalLlmGpuError(
          `${modelMeta.label} could not stay loaded in this device's WebGPU memory (${rawMsg.slice(0, 90)}). Try ${suggestedLabel} or Cloud Auto.`,
          suggested,
          rawMsg
        );
      }
    }
  })();

  activeInferencePromise = task;
  try {
    return await task;
  } finally {
    if (activeInferencePromise === task) {
      activeInferencePromise = null;
    }
  }
}
