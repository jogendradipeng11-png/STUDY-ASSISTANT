import type { ChatMessage, FamilyProfile } from "../types";

export interface LocalModelOption {
  key: string;
  label: string;
  sizeLabel: string;
  bestFor: string;
  f16Id: string;
  f32Id: string;
}

export const LOCAL_LLM_MODELS: LocalModelOption[] = [
  {
    key: "smollm2-360m",
    label: "SmolLM2 360M",
    sizeLabel: "~280 MB · Ultra-Fast",
    bestFor: "Fastest on phones & laptops",
    f16Id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    f32Id: "SmolLM2-360M-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama-3.2-1b",
    label: "Llama 3.2 1B",
    sizeLabel: "~700 MB · Balanced",
    bestFor: "Recommended everyday Jarvis",
    f16Id: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    f32Id: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-0.5b",
    label: "Qwen 2.5 0.5B",
    sizeLabel: "~400 MB · Multilingual",
    bestFor: "Lightweight Hindi & world languages",
    f16Id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen-2.5-1.5b",
    label: "Qwen 2.5 1.5B",
    sizeLabel: "~1.0 GB · Study & Math",
    bestFor: "Stronger tutoring, math & multilingual",
    f16Id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    f32Id: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama-3.2-3b",
    label: "Llama 3.2 3B",
    sizeLabel: "~1.8 GB · Power",
    bestFor: "Best quality on desktop/laptop GPUs",
    f16Id: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    f32Id: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  },
];

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
        "WebGPU is not enabled in this browser. Open in Chrome/Edge 113+ or Android Chrome for in-browser Local AI, or configure Ollama / LM Studio via LOCAL_LLM_URL.",
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
    LOCAL_LLM_MODELS.find((m) => m.key === modelKey) || LOCAL_LLM_MODELS[1];

  if (cachedEngine && loadedModelKey === modelMeta.key) {
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

  // Unload prior model to keep device GPU RAM clean
  if (cachedEngine && loadedModelKey !== modelMeta.key) {
    await unloadLocalLlmModel();
  }

  const resolvedModelId = gpu.supportsF16 ? modelMeta.f16Id : modelMeta.f32Id;
  loadingModelKey = modelMeta.key;

  loadingPromise = (async () => {
    try {
      onProgress?.({
        progress: 0.02,
        text: `Preparing ${modelMeta.label} (${modelMeta.sizeLabel})…`,
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
      onProgress?.({ progress: 1, text: `${modelMeta.label} ready on device` });
      return engine;
    } catch (err) {
      cachedEngine = null;
      loadedModelKey = null;
      throw err;
    } finally {
      loadingPromise = null;
      loadingModelKey = null;
    }
  })();

  return loadingPromise;
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
  const engine = await loadLocalLlmModel(options.modelKey, options.onProgress);

  const systemPrompt = buildLocalSystemPrompt({
    profile: options.profile,
    subject: options.subject,
    language: options.language,
    spokenMode: options.spokenMode,
  });

  // Keep context compact so on-device inference stays fast & fits comfortably in local VRAM
  const recent = options.messages.slice(-10).map((m) => ({
    role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
    content: (m.content || "").trim().slice(0, 2000),
  }));

  const completion = await engine.chat.completions.create({
    messages: [{ role: "system", content: systemPrompt }, ...recent],
    stream: true,
    temperature: 0.65,
    max_tokens: 900,
  });

  let accumulated = "";
  for await (const chunk of completion) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      accumulated += delta;
      options.onDelta(accumulated);
    }
  }

  return accumulated.trim();
}
