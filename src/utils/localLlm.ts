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
  reason?: string;
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
  unload?: () => Promise<void>;
};

let cachedEngine: WebLlmEngine | null = null;
let loadedModelKey: string | null = null;
let loadingPromise: Promise<WebLlmEngine> | null = null;
let loadingModelKey: string | null = null;

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
            const hasF16 = await webllm.hasModelInCache(m.f16Id);
            const hasF32 = hasF16 ? true : await webllm.hasModelInCache(m.f32Id);
            if (hasF16 || hasF32) {
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
        await Promise.allSettled([
          webllm.deleteModelAllInfoInCache(modelMeta.f16Id),
          webllm.deleteModelAllInfoInCache(modelMeta.f32Id),
        ]);
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
      requestAdapter: () => Promise<{
        features?: { has: (name: string) => boolean };
      } | null>;
    };
  };

  if (!nav.gpu) {
    return {
      supported: false,
      supportsF16: false,
      reason:
        "WebGPU is not enabled in this browser. Open in Chrome/Edge 113+ or Android Chrome for direct browser Local AI, or connect Ollama / LM Studio via LOCAL_LLM_URL.",
    };
  }

  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return {
        supported: false,
        supportsF16: false,
        reason:
          "No compatible WebGPU adapter was found on this device. You can still use Cloud Auto mode or connect Ollama / LM Studio via LOCAL_LLM_URL.",
      };
    }
    const supportsF16 = Boolean(adapter.features?.has("shader-f16"));
    return { supported: true, supportsF16 };
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

export async function unloadLocalLlmModel(): Promise<void> {
  if (cachedEngine?.unload) {
    try {
      await cachedEngine.unload();
    } catch {
      // ignore
    }
  }
  cachedEngine = null;
  loadedModelKey = null;
  loadingPromise = null;
  loadingModelKey = null;
}

export async function loadLocalLlmModel(
  modelKey: string,
  onProgress?: (info: LocalLlmProgress) => void
): Promise<WebLlmEngine> {
  const modelMeta =
    LOCAL_LLM_MODELS.find((m) => m.key === modelKey) || LOCAL_LLM_MODELS[2];

  if (cachedEngine && loadedModelKey === modelMeta.key) {
    recordDownloadedModel(modelMeta.key);
    onProgress?.({ progress: 1, text: `${modelMeta.label} ready on device` });
    return cachedEngine;
  }

  if (loadingPromise && loadingModelKey === modelMeta.key) {
    return loadingPromise;
  }

  const gpu = await checkWebGpuSupport();
  if (!gpu.supported) {
    throw new Error(
      gpu.reason || "WebGPU is not available on this device for in-browser Local AI."
    );
  }

  // Unload prior model to keep device GPU RAM clean before loading a larger model
  if (cachedEngine && loadedModelKey !== modelMeta.key) {
    await unloadLocalLlmModel();
  }

  const resolvedModelId = gpu.supportsF16 ? modelMeta.f16Id : modelMeta.f32Id;
  loadingModelKey = modelMeta.key;

  loadingPromise = (async () => {
    try {
      onProgress?.({
        progress: 0.02,
        text: `Downloading ${modelMeta.label} (${modelMeta.sizeLabel})…`,
      });
      const webllm = await import("@mlc-ai/web-llm");
      const engine = (await webllm.CreateMLCEngine(resolvedModelId, {
        initProgressCallback: (report: { progress?: number; text?: string }) => {
          onProgress?.({
            progress: typeof report.progress === "number" ? report.progress : 0,
            text: report.text || `Loading ${modelMeta.label}…`,
          });
        },
      })) as unknown as WebLlmEngine;

      cachedEngine = engine;
      loadedModelKey = modelMeta.key;
      recordDownloadedModel(modelMeta.key);
      onProgress?.({ progress: 1, text: `${modelMeta.label} ready on device` });
      return engine;
    } catch (err) {
      cachedEngine = null;
      loadedModelKey = null;
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (/out of memory|oom|allocation|buffer|device lost/i.test(rawMsg)) {
        throw new Error(
          `${modelMeta.label} (${modelMeta.vramLabel}) exceeded this device's GPU memory. Try a smaller model like Qwen 2.5 3B, Llama 3.2 3B, or Llama 3.2 1B.`
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
  // Remove complete <think>...</think> blocks
  const withoutComplete = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // While a reasoning model is still inside an open <think> block, keep UI clean
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
  const modelMeta =
    LOCAL_LLM_MODELS.find((m) => m.key === options.modelKey) ||
    LOCAL_LLM_MODELS[2];
  const engine = await loadLocalLlmModel(modelMeta.key, options.onProgress);

  const systemPrompt = buildLocalSystemPrompt({
    profile: options.profile,
    subject: options.subject,
    language: options.language,
    spokenMode: options.spokenMode,
  });

  const historyLimit = modelMeta.tier === "large" ? 14 : 10;
  const recent = options.messages.slice(-historyLimit).map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: (m.content || "").trim().slice(0, 2400),
  }));

  const completion = await engine.chat.completions.create({
    messages: [{ role: "system", content: systemPrompt }, ...recent],
    stream: true,
    temperature: 0.6,
    max_tokens: modelMeta.tier === "mobile" ? 900 : 1400,
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
