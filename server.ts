import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, ThinkingLevel, Type } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === "production";

interface ProfilePayload {
  id: string;
  name: string;
  role: "parent" | "student";
  relation: string;
  grade?: string;
  learningGoal?: string;
  voiceName?: string;
  preferredLanguage?: string;
}

interface IncomingMessage {
  role: "user" | "assistant";
  content: string;
  imageBase64?: string;
  imageMimeType?: string;
}

const NVIDIA_API_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

type FallbackProviderId =
  | "nvidia"
  | "groq"
  | "openrouter"
  | "cerebras"
  | "mistral"
  | "openai"
  | "local";

interface ModelCandidate {
  provider: FallbackProviderId;
  providerLabel: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
}

const GEMINI_TEXT_MODELS = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"] as const;

// 12 verified NVIDIA NIM chat models (ordered with fastest proven models first)
const NVIDIA_FAST_FALLBACKS = [
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "meta/llama-3.3-70b-instruct",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "qwen/qwen2.5-72b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "google/gemma-3-27b-it",
  "google/gemma-3-12b-it",
  "mistralai/mistral-large-2-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "nvidia/nemotron-3.5-bolt-e4b",
];

// 12 math/reasoning-prioritized NVIDIA NIM models
const NVIDIA_MATH_FALLBACKS = [
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "meta/llama-3.3-70b-instruct",
  "qwen/qwen2.5-72b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "google/gemma-3-27b-it",
  "qwen/qwen2.5-coder-32b-instruct",
  "mistralai/mistral-large-2-instruct",
  "google/gemma-3-12b-it",
  "meta/llama-3.1-70b-instruct",
  "deepseek-ai/deepseek-r1-distill-llama-8b",
  "nvidia/nemotron-3.5-bolt-e4b",
];

// Optional additional single-key OpenAI-compatible providers (activated automatically if key is set)
const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "qwen/qwen3-32b",
  "gemma2-9b-it",
];

const OPENROUTER_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-3-27b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
];

const CEREBRAS_MODELS = ["llama-3.3-70b", "llama3.1-8b"];

const MISTRAL_MODELS = ["mistral-small-latest", "open-mistral-nemo"];

const OPENAI_MODELS = ["gpt-4o-mini"];

const LOCAL_LLM_DEFAULT_MODELS = [
  "llama3.2",
  "qwen2.5",
  "mistral",
  "gemma3",
  "phi4-mini",
];

// Per-model smart cooldown cache so rate-limited or retired models are skipped immediately
const modelCooldownUntil = new Map<string, number>();

function getCooldownKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

function isModelCoolingDown(provider: string, model: string): boolean {
  const until = modelCooldownUntil.get(getCooldownKey(provider, model));
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldownUntil.delete(getCooldownKey(provider, model));
    return false;
  }
  return true;
}

function markModelCooldown(provider: string, model: string, ms: number): void {
  modelCooldownUntil.set(getCooldownKey(provider, model), Date.now() + ms);
}

function orderByCooldown<T>(
  items: T[],
  getKey: (item: T) => { provider: string; model: string }
): T[] {
  const now = Date.now();
  const ready: T[] = [];
  const cooling: Array<{ item: T; until: number }> = [];

  for (const item of items) {
    const { provider, model } = getKey(item);
    const until = modelCooldownUntil.get(getCooldownKey(provider, model)) || 0;
    if (until > now) {
      cooling.push({ item, until });
    } else {
      ready.push(item);
    }
  }

  cooling.sort((a, b) => a.until - b.until);
  return [...ready, ...cooling.map((c) => c.item)];
}

function getCooldownMsForError(err: unknown, status?: number): number {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    status === 404 ||
    status === 410 ||
    status === 422 ||
    msg.includes("NOT_FOUND") ||
    msg.includes("(404)") ||
    msg.includes("(410)")
  ) {
    return 20 * 60 * 1000; // 20 min for unavailable/retired model
  }
  if (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.toLowerCase().includes("rate limit")
  ) {
    return 90 * 1000; // 90s for per-model rate limit
  }
  return 45 * 1000; // 45s for transient upstream failure
}

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function isNonChatModelId(modelId: string): boolean {
  return /embed|rerank|nvclip|whisper|parakeet|riva|flux|stable-diffusion|ocr|parse|guard|safety|detector/i.test(
    modelId
  );
}

function hasGeminiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

function hasNvidiaKey(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY?.trim());
}

function hasGroqKey(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

function hasOpenRouterKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function hasCerebrasKey(): boolean {
  return Boolean(process.env.CEREBRAS_API_KEY?.trim());
}

function hasMistralKey(): boolean {
  return Boolean(process.env.MISTRAL_API_KEY?.trim());
}

function hasOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getLocalLlmChatUrl(): string | null {
  const raw = process.env.LOCAL_LLM_URL?.trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  const trimmed = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function hasLocalLlmServer(): boolean {
  return Boolean(getLocalLlmChatUrl());
}

function getLocalLlmModels(): string[] {
  const custom = parseEnvModelList(process.env.LOCAL_LLM_MODELS);
  return custom.length > 0 ? custom : LOCAL_LLM_DEFAULT_MODELS;
}

function parseEnvModelList(raw?: string): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => Boolean(m && !isNonChatModelId(m)));
}

function getNvidiaCandidateModels(speedMode: "fast" | "detailed" = "fast"): string[] {
  const customList = parseEnvModelList(process.env.NVIDIA_MODELS);
  const envCustom =
    speedMode === "detailed"
      ? [
          process.env.NVIDIA_MATH_MODEL?.trim(),
          process.env.NVIDIA_MODEL?.trim(),
          ...customList,
        ]
      : [process.env.NVIDIA_MODEL?.trim(), ...customList];

  const validEnvModels = envCustom.filter(
    (m): m is string => Boolean(m && m.includes("/") && !isNonChatModelId(m))
  );

  const defaults =
    speedMode === "detailed" ? NVIDIA_MATH_FALLBACKS : NVIDIA_FAST_FALLBACKS;

  return Array.from(new Set([...validEnvModels, ...defaults]));
}

function getNvidiaModel(speedMode: "fast" | "detailed" = "fast"): string {
  return getNvidiaCandidateModels(speedMode)[0];
}

function getFallbackPoolCandidates(
  speedMode: "fast" | "detailed" = "fast",
  providerFilter?: FallbackProviderId
): ModelCandidate[] {
  const candidates: ModelCandidate[] = [];

  const addProvider = (
    provider: FallbackProviderId,
    providerLabel: string,
    apiUrl: string,
    apiKey: string | undefined,
    models: string[],
    extraHeaders?: Record<string, string>
  ) => {
    if (providerFilter && providerFilter !== provider) return;
    const key = apiKey?.trim();
    if (!key) return;
    for (const model of models) {
      candidates.push({
        provider,
        providerLabel,
        apiUrl,
        apiKey: key,
        model,
        extraHeaders,
      });
    }
  };

  addProvider(
    "nvidia",
    "NVIDIA NIM",
    NVIDIA_API_URL,
    process.env.NVIDIA_API_KEY,
    getNvidiaCandidateModels(speedMode)
  );
  addProvider(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1/chat/completions",
    process.env.GROQ_API_KEY,
    [...parseEnvModelList(process.env.GROQ_MODELS), ...GROQ_MODELS]
  );
  addProvider(
    "openrouter",
    "OpenRouter",
    "https://openrouter.ai/api/v1/chat/completions",
    process.env.OPENROUTER_API_KEY,
    [...parseEnvModelList(process.env.OPENROUTER_MODELS), ...OPENROUTER_MODELS],
    {
      "HTTP-Referer": process.env.APP_URL?.trim() || "https://study-assistant-0fvk.onrender.com",
      "X-Title": "Jogi Jarvis",
    }
  );
  addProvider(
    "cerebras",
    "Cerebras",
    "https://api.cerebras.ai/v1/chat/completions",
    process.env.CEREBRAS_API_KEY,
    [...parseEnvModelList(process.env.CEREBRAS_MODELS), ...CEREBRAS_MODELS]
  );
  addProvider(
    "mistral",
    "Mistral",
    "https://api.mistral.ai/v1/chat/completions",
    process.env.MISTRAL_API_KEY,
    [...parseEnvModelList(process.env.MISTRAL_MODELS), ...MISTRAL_MODELS]
  );
  addProvider(
    "openai",
    "OpenAI",
    "https://api.openai.com/v1/chat/completions",
    process.env.OPENAI_API_KEY,
    [...parseEnvModelList(process.env.OPENAI_MODELS), ...OPENAI_MODELS]
  );

  const localChatUrl = getLocalLlmChatUrl();
  if (localChatUrl) {
    addProvider(
      "local",
      "Local LLM Server",
      localChatUrl,
      process.env.LOCAL_LLM_API_KEY?.trim() || "local",
      getLocalLlmModels()
    );
  }

  // Deduplicate by provider+model
  const unique = Array.from(
    new Map(candidates.map((c) => [`${c.provider}:${c.model}`, c])).values()
  );
  return orderByCooldown(unique, (c) => ({ provider: c.provider, model: c.model }));
}

function hasAnyFallbackProvider(): boolean {
  return (
    hasNvidiaKey() ||
    hasGroqKey() ||
    hasOpenRouterKey() ||
    hasCerebrasKey() ||
    hasMistralKey() ||
    hasOpenAiKey() ||
    hasLocalLlmServer()
  );
}

function getProviderSummary() {
  const extraProviders: string[] = [];
  if (hasNvidiaKey()) extraProviders.push("NVIDIA NIM");
  if (hasGroqKey()) extraProviders.push("Groq");
  if (hasOpenRouterKey()) extraProviders.push("OpenRouter");
  if (hasCerebrasKey()) extraProviders.push("Cerebras");
  if (hasMistralKey()) extraProviders.push("Mistral");
  if (hasOpenAiKey()) extraProviders.push("OpenAI");
  if (hasLocalLlmServer()) extraProviders.push("Local LLM Server");

  const geminiCount = hasGeminiKey() ? GEMINI_TEXT_MODELS.length : 0;
  const fallbackCount = getFallbackPoolCandidates("fast").length;

  return {
    geminiConfigured: hasGeminiKey(),
    nvidiaConfigured: hasNvidiaKey(),
    localServerConfigured: hasLocalLlmServer(),
    fallbackPoolConfigured: hasAnyFallbackProvider(),
    extraProviders,
    totalActiveModels: geminiCount + fallbackCount,
    nvidiaModel: getNvidiaModel("fast"),
    nvidiaMathModel: getNvidiaModel("detailed"),
  };
}

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Please check your API key in Settings > Secrets."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion: "v1beta",
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function getLiveAiClient(): GoogleGenAI {
  return getAiClient();
}

function parseJsonFromText<T = Record<string, unknown>>(raw: string): T {
  const cleaned = stripThinkingTags(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("Could not parse structured JSON response from AI model.");
  }
}

function normalizePromptText(text: string): string {
  return text.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ");
}

function formatOpenAiMessagesForModel(
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const systemParts: string[] = [];
  const dialogue: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of messages) {
    const content = normalizePromptText(m.content || "").trim();
    if (!content) continue;
    if (m.role === "system") {
      systemParts.push(content);
      continue;
    }
    const role: "user" | "assistant" =
      m.role === "assistant" ? "assistant" : "user";
    if (dialogue.length === 0 && role === "assistant") {
      continue;
    }
    const prev = dialogue[dialogue.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${content}`;
    } else {
      dialogue.push({ role, content });
    }
  }

  if (dialogue.length === 0) {
    dialogue.push({ role: "user", content: "Hello" });
  }

  const combinedSystem = systemParts.join("\n\n").trim();

  // Gemma chat templates work most reliably when system instructions are folded into the first user turn
  if (/gemma/i.test(model)) {
    if (combinedSystem) {
      dialogue[0] = {
        role: "user",
        content: `Instructions:\n${combinedSystem}\n\nUser Request:\n${dialogue[0].content}`,
      };
    }
    return dialogue;
  }

  return combinedSystem
    ? [{ role: "system", content: combinedSystem }, ...dialogue]
    : dialogue;
}

function buildOpenAiRequestBody(
  candidate: ModelCandidate,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed",
  stream: boolean,
  options?: { temperature?: number; maxTokens?: number }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: candidate.model,
    messages: formatOpenAiMessagesForModel(candidate.model, messages),
    temperature: options?.temperature ?? 0.35,
    max_tokens: options?.maxTokens ?? 4096,
    stream,
  };

  // Prevent reasoning-capable Nemotron / Qwen3 models on NVIDIA NIM from exhausting max_tokens in hidden thinking
  if (
    candidate.provider === "nvidia" &&
    speedMode === "fast" &&
    /nemotron|qwen3/i.test(candidate.model)
  ) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  return body;
}

async function fetchOpenAiCandidate(
  candidate: ModelCandidate,
  body: Record<string, unknown>,
  acceptHeader?: string
): Promise<globalThis.Response> {
  const sendAuth =
    Boolean(candidate.apiKey) &&
    !(candidate.provider === "local" && candidate.apiKey === "local");

  return fetch(candidate.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(acceptHeader ? { Accept: acceptHeader } : {}),
      ...(sendAuth ? { Authorization: `Bearer ${candidate.apiKey}` } : {}),
      ...(candidate.extraHeaders || {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(candidate.provider === "local" ? 45000 : 15000),
  });
}

async function callFallbackPoolChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed" = "fast",
  options?: {
    temperature?: number;
    maxTokens?: number;
    providerFilter?: FallbackProviderId;
  }
): Promise<{ text: string; provider: FallbackProviderId; model: string }> {
  const candidates = getFallbackPoolCandidates(speedMode, options?.providerFilter);
  if (candidates.length === 0) {
    throw new Error(
      "No fallback AI provider key is configured. Add NVIDIA_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY) in Settings > Secrets."
    );
  }

  let lastError: Error | null = null;
  const authFailedProviders = new Set<FallbackProviderId>();

  for (const candidate of candidates) {
    if (authFailedProviders.has(candidate.provider)) continue;

    try {
      const response = await fetchOpenAiCandidate(
        candidate,
        buildOpenAiRequestBody(candidate, messages, speedMode, false, options)
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(
          `${candidate.providerLabel} (${candidate.model}) error (${response.status}): ${errText.slice(0, 220) || response.statusText}`
        );
        if (response.status === 401 || response.status === 403) {
          authFailedProviders.add(candidate.provider);
          continue;
        }
        markModelCooldown(
          candidate.provider,
          candidate.model,
          getCooldownMsForError(lastError, response.status)
        );
        continue;
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
        }>;
      };
      const text = stripThinkingTags(data.choices?.[0]?.message?.content || "");
      if (text) {
        return { text, provider: candidate.provider, model: candidate.model };
      }

      markModelCooldown(candidate.provider, candidate.model, 45 * 1000);
      lastError = new Error(
        `${candidate.providerLabel} model ${candidate.model} returned an empty response.`
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      markModelCooldown(
        candidate.provider,
        candidate.model,
        getCooldownMsForError(lastError)
      );
    }
  }

  throw lastError || new Error("No AI model in the fallback pool returned an answer.");
}

async function streamFallbackPoolChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed",
  res: express.Response,
  providerFilter?: FallbackProviderId
): Promise<void> {
  const candidates = getFallbackPoolCandidates(speedMode, providerFilter);
  if (candidates.length === 0) {
    throw new Error(
      "No fallback AI provider key is configured. Add NVIDIA_API_KEY (or GROQ_API_KEY / OPENROUTER_API_KEY) in Settings > Secrets."
    );
  }

  let lastError: Error | null = null;
  const authFailedProviders = new Set<FallbackProviderId>();

  for (const candidate of candidates) {
    if (authFailedProviders.has(candidate.provider)) continue;

    let emittedAnyText = false;
    try {
      const upstream = await fetchOpenAiCandidate(
        candidate,
        buildOpenAiRequestBody(candidate, messages, speedMode, true),
        "text/event-stream"
      );

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        lastError = new Error(
          `${candidate.providerLabel} (${candidate.model}) error (${upstream.status}): ${errText.slice(0, 220) || upstream.statusText}`
        );
        if (upstream.status === 401 || upstream.status === 403) {
          authFailedProviders.add(candidate.provider);
          continue;
        }
        markModelCooldown(
          candidate.provider,
          candidate.model,
          getCooldownMsForError(lastError, upstream.status)
        );
        continue;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let insideThink = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payloadStr = line.slice(5).trim();
          if (!payloadStr || payloadStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payloadStr) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
            };
            let delta = parsed.choices?.[0]?.delta?.content || "";
            if (!delta) continue;

            // Filter hidden <think>...</think> blocks from reasoning models while streaming
            if (delta.includes("<think>")) {
              insideThink = true;
              delta = delta.split("<think>")[0] || "";
            }
            if (insideThink) {
              if (delta.includes("</think>")) {
                insideThink = false;
                delta = delta.split("</think>").slice(1).join("");
              } else {
                delta = "";
              }
            }

            if (delta) {
              if (!emittedAnyText) {
                emittedAnyText = true;
                res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-transform");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders?.();
              }
              res.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch {
            // ignore partial or malformed SSE metadata frames
          }
        }
      }

      if (emittedAnyText) {
        res.write(
          `data: ${JSON.stringify({
            done: true,
            sources: [],
            provider: candidate.provider,
            model: candidate.model,
          })}\n\n`
        );
        res.end();
        return;
      }

      markModelCooldown(candidate.provider, candidate.model, 45 * 1000);
      lastError = new Error(
        `${candidate.providerLabel} model ${candidate.model} returned an empty stream.`
      );
    } catch (err) {
      if (emittedAnyText) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      markModelCooldown(
        candidate.provider,
        candidate.model,
        getCooldownMsForError(lastError)
      );
    }
  }

  throw lastError || new Error("No AI model in the fallback pool returned an answer.");
}

async function callFallbackPoolJson<T>(
  systemInstruction: string,
  userPrompt: string,
  schemaDescription: string
): Promise<T> {
  const candidates = getFallbackPoolCandidates("fast");
  if (candidates.length === 0) {
    throw new Error(
      "No fallback AI provider key is configured for structured generation."
    );
  }

  let lastError: Error | null = null;
  const authFailedProviders = new Set<FallbackProviderId>();
  const messages = [
    {
      role: "system" as const,
      content: `${systemInstruction} Return ONLY valid JSON matching this schema with no markdown fences or commentary:\n${schemaDescription}`,
    },
    { role: "user" as const, content: userPrompt },
  ];

  for (const candidate of candidates) {
    if (authFailedProviders.has(candidate.provider)) continue;

    try {
      const response = await fetchOpenAiCandidate(
        candidate,
        buildOpenAiRequestBody(candidate, messages, "fast", false, {
          temperature: 0.2,
          maxTokens: 2048,
        })
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(
          `${candidate.providerLabel} (${candidate.model}) error (${response.status}): ${errText.slice(0, 220) || response.statusText}`
        );
        if (response.status === 401 || response.status === 403) {
          authFailedProviders.add(candidate.provider);
          continue;
        }
        markModelCooldown(
          candidate.provider,
          candidate.model,
          getCooldownMsForError(lastError, response.status)
        );
        continue;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const rawContent = data.choices?.[0]?.message?.content || "";
      if (!rawContent.trim()) {
        markModelCooldown(candidate.provider, candidate.model, 45 * 1000);
        continue;
      }
      return parseJsonFromText<T>(rawContent);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      markModelCooldown(
        candidate.provider,
        candidate.model,
        getCooldownMsForError(lastError)
      );
    }
  }

  throw lastError || new Error("No AI model returned valid structured JSON.");
}

async function generateGeminiTextWithFallback(
  ai: GoogleGenAI,
  contents: unknown,
  buildConfig: (model: string) => Record<string, unknown>
): Promise<{ response: Awaited<ReturnType<typeof ai.models.generateContent>>; model: string }> {
  const orderedModels = orderByCooldown([...GEMINI_TEXT_MODELS], (model) => ({
    provider: "gemini",
    model,
  }));

  let lastErr: unknown = null;
  for (const model of orderedModels) {
    try {
      const response = await withRetry(
        () =>
          ai.models.generateContent({
            model,
            contents: contents as never,
            config: buildConfig(model),
          }),
        // Keep retries quick (2 attempts) so failover to next model is fast
        2
      );
      if (response.text?.trim()) {
        return { response, model };
      }
      lastErr = new Error(`Gemini model ${model} returned an empty response.`);
    } catch (err) {
      lastErr = err;
      markModelCooldown("gemini", model, getCooldownMsForError(err));
    }
  }

  throw lastErr || new Error("All Gemini models failed to respond.");
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("503") ||
    msg.includes("500") ||
    msg.includes("UNAVAILABLE") ||
    msg.includes("ECONNRESET") ||
    msg.includes("fetch failed")
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isTransientError(err)) {
        const delayMs = 600 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function buildLanguageGuidance(preferredLanguage?: string): string {
  const lang = (preferredLanguage || "").trim();
  if (!lang || lang.toLowerCase() === "auto-detect" || lang.toLowerCase() === "auto") {
    return (
      "Multilingual rule: Understand input in ANY world language, regional dialect, or mixed-script style — especially Odia (ଓଡ଼ିଆ), English, Hindi (हिन्दी), Hinglish, Punjabi, Bengali, Marathi, Gujarati, Tamil, Telugu, Kannada, Malayalam, Urdu, Nepali, Spanish, French, German, Arabic, Chinese, Japanese, Korean, and any other language. " +
      "Always answer naturally and fluently in the exact same language and script the user used in their latest message (unless they explicitly ask you to answer or translate into a different language). Keep mathematical symbols, numbers, and equations crystal clear."
    );
  }
  return (
    `Multilingual rule: Understand input in ANY world language, regional dialect, or mixed-script style (including Odia, Hindi, English, Hinglish, etc.). ` +
    `Respond clearly, accurately, and naturally in ${lang} (using its authentic native script, such as Odia script ଓଡ଼ିଆ for Odia or Devanagari हिन्दी for Hindi, or romanized form if ${lang} is Hinglish), unless the user explicitly asks for another language in their message. Keep mathematical formulas, symbols, and numbers clean and easy to read.`
  );
}

function buildSystemInstruction(
  profile: ProfilePayload | undefined,
  subject: string | undefined,
  mode: "chat" | "live",
  languageOverride?: string
): string {
  const voiceGuidance =
    mode === "live"
      ? "You are speaking in a real-time voice conversation. Keep your answers warm, natural, conversational, and easy to follow aloud (typically 2 to 5 concise sentences unless asked for a detailed walkthrough). Avoid reading out markdown symbols, bullet markers, or long URLs."
      : "Format your responses with clean, scannable Markdown (clear headings, short bullet steps, and concrete examples) when helpful, without overwhelming walls of text.";

  const mathGuidance =
    "For Mathematics, Physics, Chemistry, or calculation questions: always show the formula first, solve cleanly step-by-step (Step 1, Step 2, ...), clearly state the Final Answer, and include a quick verification check.";

  const languageGuidance = buildLanguageGuidance(
    languageOverride || profile?.preferredLanguage
  );

  if (!profile || profile.role === "parent") {
    const ownerName = profile?.name || "Jogi";
    return [
      `You are Jogi Jarvis, the dedicated personal AI assistant for ${ownerName} and their family.`,
      `Your job is to listen carefully and answer anything ${ownerName} asks — daily planning, mobile personal tasks (opening YouTube, preparing WhatsApp/SMS messages, setting alarms/timers, navigating in Maps, dialing numbers), script generation (YouTube/Reels video scripts, speeches, WhatsApp notices, Python/Bash/Termux scripts), Math/Science help, live news & sports, or checking their sons' and daughter's schoolwork.`,
      "MOBILE ACTIONS RULE: The Jogi Jarvis app automatically renders clickable 1-tap mobile action cards (Open YouTube, Send WhatsApp/SMS, Call, Open Maps, Set Android Clock Alarm) and live ticking alarms/timers directly below your reply whenever the user asks for a mobile action. Never say 'I cannot open YouTube' or 'I cannot set alarms'—instead, briefly confirm the action is ready to tap below (or that the live alarm/timer is active) and provide any drafted message cleanly.",
      "SCRIPT GENERATION RULE: When asked to generate or write a script (YouTube video, Shorts/Reels, speech, WhatsApp broadcast, or Python/Bash/Termux automation code), deliver a complete, ready-to-use script immediately (using fenced code blocks for code scripts).",
      "Be crisp, fast, trustworthy, warm, respectful, and action-oriented. Give direct answers first, followed by helpful options or next steps.",
      mathGuidance,
      languageGuidance,
      voiceGuidance,
    ].join(" ");
  }

  const studentName = profile.name || "the student";
  const gradeLabel = profile.grade ? `(${profile.grade})` : "";
  const subjectFocus =
    subject && subject !== "All Subjects"
      ? `The current study subject is ${subject}.`
      : "Help across any school subject they bring up (Mathematics, Science, Odia, Hindi, English, Social Studies, Computer Science, etc.).";
  const goalText = profile.learningGoal
    ? `Learning focus: ${profile.learningGoal}.`
    : "";

  return [
    `You are Jogi Jarvis, a warm, patient, encouraging personal AI teacher and study companion for ${studentName} ${gradeLabel}.`,
    subjectFocus,
    goalText,
    "Teach like a wonderful human tutor: explain concepts step-by-step in age-appropriate language, use relatable everyday analogies, show worked examples clearly, and encourage curiosity.",
    "When helping with homework or a photo of a question, guide them through the reasoning step-by-step so they truly understand how to solve it themselves, and end with a quick check-in question or mini-practice prompt when helpful.",
    mathGuidance,
    "Never be condescending or dry. Celebrate effort and clarity.",
    languageGuidance,
    voiceGuidance,
  ]
    .filter(Boolean)
    .join(" ");
}

function stripMarkdownForSpeech(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " I have included the code on your screen. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/(\d+)\s*°\s*C\b/gi, "$1 degrees Celsius")
    .replace(/(\d+)\s*°\s*F\b/gi, "$1 degrees Fahrenheit")
    .replace(/(\d+)\s*%/g, "$1 percent")
    .replace(/[*_~>]+/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2600);
}

function formatApiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("GEMINI_API_KEY") || raw.includes("NVIDIA_API_KEY")) {
    return { status: 500, message: raw };
  }
  if (raw.includes("NVIDIA NIM error (401)") || raw.includes("NVIDIA NIM error (403)")) {
    return {
      status: 403,
      message:
        "Your NVIDIA_API_KEY could not be verified. Please check your nvapi- key in Settings > Secrets.",
    };
  }
  if (raw.includes("PERMISSION_DENIED") || raw.includes("API_KEY_INVALID") || raw.includes("403")) {
    return {
      status: 403,
      message:
        "Your Gemini API key could not be verified. Please check your key in Settings > Secrets.",
    };
  }
  if (raw.includes("RESOURCE_EXHAUSTED") || raw.includes("429")) {
    return {
      status: 429,
      message:
        "The AI API key reached its temporary rate limit. Add a billing-enabled Gemini key or an optional NVIDIA_API_KEY in Settings > Secrets, or try again in a few seconds.",
    };
  }
  return {
    status: 500,
    message: raw || "Something went wrong while contacting Jogi Jarvis.",
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "Jogi Jarvis" });
  });

  // Configured server-side AI providers & multi-model count (booleans/counts only, never exposes keys)
  app.get("/api/providers", (_req, res) => {
    res.json(getProviderSummary());
  });

  // 1. Conversational Ask & Study Tutor Endpoint (supports fast SSE streaming, Gemini + optional NVIDIA NIM fallback/routing)
  app.post("/api/chat", async (req, res) => {
    const {
      messages = [],
      profile,
      subject,
      useSearch = false,
      language,
      speedMode = "fast",
      stream = false,
      engine = "auto",
      spokenMode = false,
    } = req.body as {
      messages: IncomingMessage[];
      profile?: ProfilePayload;
      subject?: string;
      useSearch?: boolean;
      language?: string;
      speedMode?: "fast" | "detailed";
      stream?: boolean;
      engine?: "auto" | "gemini" | "nvidia" | "local-server";
      spokenMode?: boolean;
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Please provide a message to Jogi Jarvis." });
    }

    const safeEngine: "auto" | "gemini" | "nvidia" | "local-server" =
      engine === "gemini" || engine === "nvidia" || engine === "local-server"
        ? engine
        : "auto";
    const safeSpeedMode: "fast" | "detailed" =
      speedMode === "detailed" ? "detailed" : "fast";

    const extractSources = (groundingChunks: unknown[]) => {
      const sources = groundingChunks
        .map((chunk) => {
          const web = (chunk as { web?: { uri?: string; title?: string } }).web;
          if (web?.uri) {
            return { uri: web.uri, title: web.title || web.uri };
          }
          return null;
        })
        .filter((s): s is { uri: string; title: string } => s !== null);
      return Array.from(new Map(sources.map((s) => [s.uri, s])).values()).slice(0, 6);
    };

    const shouldAutoEnableLiveSearch = (text: string): boolean => {
      const normalized = text.trim();
      if (!normalized) return false;
      return /\b(news|headlines?|breaking|sports?|cricket|ipl|football|soccer|nba|nfl|tennis|badminton|hockey|f1|score|scores|match|matches|live|today|tonight|yesterday|latest|current|recent|weather|temperature|forecast|rain|stock|stocks|share price|sensex|nifty|gold price|petrol|diesel|bitcoin|crypto|election|result|results|who won|won the|schedule|fixture|trending|update|updates|happening|right now|current affairs|prime minister|president|world cup|olympics)\b|(समाचार|खबर|ताजा|स्कोर|मैच|मौसम|आज का|क्रिकेट|ଖବର|ତାଜା|ସ୍କୋର|ମ୍ୟାଚ୍|ପାଣିପାଗ|ଆଜିର)/i.test(
        normalized
      );
    };

    const lastUserMessageText =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const effectiveUseSearch =
      Boolean(useSearch) || shouldAutoEnableLiveSearch(lastUserMessageText);

    const baseSystemInstruction = buildSystemInstruction(
      profile,
      subject,
      "chat",
      language
    );
    const spokenGuidance = spokenMode
      ? "\n\nHUMAN VOICE CONVERSATION MODE ACTIVE: Your reply will be spoken aloud automatically like a real, caring human friend and mentor talking face-to-face. Use natural everyday phrasing, smooth conversational transitions, and warm human rhythm. Avoid reading out raw markdown symbols, long URLs, or stiff robotic bullet formatting; keep everyday replies warm, clear, and easy to listen to even with the phone screen locked."
      : "";
    const liveSearchGuidance = effectiveUseSearch
      ? `\n\nLIVE WEB DATA ACCESS ENABLED (Current UTC time: ${new Date().toUTCString()}): Use Google Search grounding to answer questions about live news, sports scores, weather, current events, prices, or any real-time information accurately and up-to-date. Mention dates/scores clearly when relevant.`
      : "";
    const systemInstruction = `${baseSystemInstruction}${spokenGuidance}${liveSearchGuidance}`;
    const recentMessages = messages.slice(-18);
    const hasImage = recentMessages.some((m) =>
      Boolean(m.imageBase64 && m.imageMimeType)
    );

    const buildNvidiaHistory = () => [
      { role: "system" as const, content: systemInstruction },
      ...recentMessages.map((msg) => ({
        role: (msg.role === "assistant" ? "assistant" : "user") as
          | "user"
          | "assistant",
        content:
          msg.content?.trim() ||
          "Please explain this study topic clearly step-by-step.",
      })),
    ];

    const respondWithFallbackPool = async (providerFilter?: FallbackProviderId) => {
      const poolMessages = buildNvidiaHistory();
      if (stream) {
        await streamFallbackPoolChat(poolMessages, safeSpeedMode, res, providerFilter);
        return;
      }
      const result = await callFallbackPoolChat(poolMessages, safeSpeedMode, {
        providerFilter,
      });
      res.json({
        reply:
          result.text ||
          "I heard you, but I could not form a response. Please try asking again.",
        sources: [],
        provider: result.provider,
        model: result.model,
      });
    };

    try {
      // Explicit self-hosted Local LLM server (Ollama / LM Studio / LocalAI)
      if (safeEngine === "local-server") {
        if (!hasLocalLlmServer()) {
          return res.status(400).json({
            error:
              "LOCAL_LLM_URL is not configured yet. Add your Ollama or LM Studio URL in Settings > Secrets, or choose Local AI (Unlimited · On-Device) in the Engine selector.",
          });
        }
        if (hasImage) {
          return res.status(400).json({
            error:
              "Homework photo reading uses Gemini vision. Switch Engine to Auto or Gemini to analyze images.",
          });
        }
        await respondWithFallbackPool("local");
        return;
      }

      // Explicit NVIDIA NIM selection (cascades across 12 NVIDIA NIM models)
      if (safeEngine === "nvidia") {
        if (!hasNvidiaKey()) {
          return res.status(400).json({
            error:
              "NVIDIA_API_KEY is not configured yet. Add your NVIDIA key in Settings > Secrets.",
          });
        }
        if (hasImage) {
          return res.status(400).json({
            error:
              "Homework photo reading uses Gemini vision. Switch Engine to Auto or Gemini to analyze images.",
          });
        }
        await respondWithFallbackPool("nvidia");
        return;
      }

      // Auto mode when Gemini key is absent but fallback providers are configured (text-only)
      if (safeEngine === "auto" && !hasGeminiKey() && hasAnyFallbackProvider() && !hasImage) {
        await respondWithFallbackPool();
        return;
      }

      const ai = getAiClient();
      const contents = recentMessages.map((msg) => {
        const parts: Array<
          { text: string } | { inlineData: { mimeType: string; data: string } }
        > = [];
        if (msg.imageBase64 && msg.imageMimeType) {
          parts.push({
            inlineData: {
              mimeType: msg.imageMimeType,
              data: msg.imageBase64,
            },
          });
        }
        parts.push({
          text:
            normalizePromptText(msg.content?.trim() || "") ||
            "Please examine this study photo and explain it step-by-step.",
        });
        return {
          role: msg.role === "assistant" ? "model" : "user",
          parts,
        };
      });

      const thinkingLevel =
        safeSpeedMode === "detailed" ? ThinkingLevel.HIGH : ThinkingLevel.LOW;

      const geminiModels = orderByCooldown(
        [
          {
            name: "gemini-4-hydrogen",
            config: {
              systemInstruction,
              thinkingConfig: { thinkingLevel },
              ...(effectiveUseSearch ? { tools: [{ googleSearch: {} }] } : {}),
            },
          },
          {
            name: "gemini-3.1-flash-lite",
            config: {
              systemInstruction,
              ...(effectiveUseSearch ? { tools: [{ googleSearch: {} }] } : {}),
            },
          },
        ],
        (c) => ({ provider: "gemini", model: c.name })
      );

      if (stream) {
        let lastGeminiErr: unknown = null;
        for (const candidate of geminiModels) {
          let emittedAnyText = false;
          try {
            const streamResponse = await withRetry(
              () =>
                ai.models.generateContentStream({
                  model: candidate.name,
                  contents,
                  config: candidate.config,
                }),
              2
            );

            const allChunks: unknown[] = [];
            for await (const chunk of streamResponse) {
              if (chunk.text) {
                if (!emittedAnyText) {
                  emittedAnyText = true;
                  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
                  res.setHeader("Cache-Control", "no-cache, no-transform");
                  res.setHeader("Connection", "keep-alive");
                  res.flushHeaders?.();
                }
                res.write(`data: ${JSON.stringify({ delta: chunk.text })}\n\n`);
              }
              const gChunks =
                chunk.candidates?.[0]?.groundingMetadata?.groundingChunks;
              if (Array.isArray(gChunks) && gChunks.length > 0) {
                allChunks.push(...gChunks);
              }
            }

            if (emittedAnyText) {
              const uniqueSources = extractSources(allChunks);
              res.write(
                `data: ${JSON.stringify({
                  done: true,
                  sources: uniqueSources,
                  provider: "gemini",
                  model: candidate.name,
                })}\n\n`
              );
              return res.end();
            }

            markModelCooldown("gemini", candidate.name, 45 * 1000);
            lastGeminiErr = new Error(
              `Gemini model ${candidate.name} returned an empty stream.`
            );
          } catch (geminiErr) {
            if (emittedAnyText) {
              throw geminiErr;
            }
            markModelCooldown(
              "gemini",
              candidate.name,
              getCooldownMsForError(geminiErr)
            );
            lastGeminiErr = geminiErr;
          }
        }

        if (safeEngine === "auto" && hasAnyFallbackProvider() && !hasImage) {
          await respondWithFallbackPool();
          return;
        }
        throw lastGeminiErr || new Error("Gemini could not generate a response.");
      }

      let lastGeminiErr: unknown = null;
      for (const candidate of geminiModels) {
        try {
          const response = await withRetry(
            () =>
              ai.models.generateContent({
                model: candidate.name,
                contents,
                config: candidate.config,
              }),
            2
          );

          const reply = response.text?.trim() || "";
          if (reply) {
            const uniqueSources = extractSources(
              response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
            );
            return res.json({
              reply,
              sources: uniqueSources,
              provider: "gemini",
              model: candidate.name,
            });
          }

          markModelCooldown("gemini", candidate.name, 45 * 1000);
          lastGeminiErr = new Error(
            `Gemini model ${candidate.name} returned an empty response.`
          );
        } catch (geminiErr) {
          markModelCooldown(
            "gemini",
            candidate.name,
            getCooldownMsForError(geminiErr)
          );
          lastGeminiErr = geminiErr;
        }
      }

      if (safeEngine === "auto" && hasAnyFallbackProvider() && !hasImage) {
        await respondWithFallbackPool();
        return;
      }
      throw lastGeminiErr || new Error("Gemini could not generate a response.");
    } catch (err) {
      const formatted = formatApiError(err);
      if (stream && res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: formatted.message })}\n\n`);
        return res.end();
      }
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 1b. Live Real-Time Data Endpoint (News, Sports, Weather, Anything Current — also powers Android Watch Mode)
  app.post("/api/live-data", async (req, res) => {
    try {
      const {
        category = "custom",
        query = "",
        language,
        conciseForWatch = false,
        profile,
      } = req.body as {
        category?: "news" | "sports" | "tech" | "weather" | "custom";
        query?: string;
        language?: string;
        conciseForWatch?: boolean;
        profile?: ProfilePayload;
      };

      const categoryPrompts: Record<string, string> = {
        news: "Give me the latest top breaking news headlines today with brief, clear facts.",
        sports:
          "Give me today's live sports scores, cricket and football match updates, and major sports headlines right now.",
        tech: "Give me today's latest science, AI, and technology news updates.",
        weather:
          "Give me today's major weather highlights and notable global updates.",
      };

      const userPrompt =
        query.trim() ||
        categoryPrompts[category] ||
        "Give me today's top live news and sports updates.";

      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );
      const watchRule = conciseForWatch
        ? "WATCH MODE FORMAT: Keep the answer ultra-concise (2 to 4 short sentences, max 65 words) with plain spoken text (no markdown tables or long lists) so it reads cleanly on an Android smartwatch screen and sounds crisp aloud."
        : "Give a clear, well-structured, up-to-date live briefing with bullet points and exact scores/dates where available.";

      const ai = getAiClient();
      const liveSystemInstruction = [
        `You are Jogi Jarvis, providing verified real-time live information (Current UTC time: ${new Date().toUTCString()}).`,
        "Use Google Search grounding to retrieve the freshest news, sports scores, weather, and live facts.",
        watchRule,
        langRule,
      ].join("\n");

      const liveCandidates = orderByCooldown(
        [
          {
            model: "gemini-4-hydrogen",
            config: {
              systemInstruction: liveSystemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              tools: [{ googleSearch: {} }],
            },
          },
          {
            model: "gemini-3.1-flash-lite",
            config: {
              systemInstruction: liveSystemInstruction,
              tools: [{ googleSearch: {} }],
            },
          },
        ],
        (c) => ({ provider: "gemini", model: c.model })
      );

      let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null =
        null;
      let lastErr: unknown = null;
      for (const candidate of liveCandidates) {
        try {
          response = await withRetry(
            () =>
              ai.models.generateContent({
                model: candidate.model,
                contents: userPrompt,
                config: candidate.config,
              }),
            2
          );
          if (response.text?.trim()) {
            break;
          }
        } catch (err) {
          markModelCooldown("gemini", candidate.model, getCooldownMsForError(err));
          lastErr = err;
        }
      }

      if (!response || !response.text?.trim()) {
        // Resilient live fallback: fetch real-time headlines from Google News RSS
        const rssUrl =
          query.trim()
            ? `https://news.google.com/rss/search?q=${encodeURIComponent(query.trim())}&hl=en-IN&gl=IN&ceid=IN:en`
            : category === "sports"
              ? "https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-IN&gl=IN&ceid=IN:en"
              : category === "tech"
                ? "https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-IN&gl=IN&ceid=IN:en"
                : "https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en";

        const rssRes = await fetch(rssUrl, {
          headers: { "User-Agent": "JogiJarvisLive/1.0" },
        }).catch(() => null);

        if (rssRes && rssRes.ok) {
          const xml = await rssRes.text();
          const itemMatches = Array.from(
            xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)
          ).slice(0, conciseForWatch ? 3 : 6);

          const decodeXml = (s: string) =>
            s
              .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .trim();

          const liveItems = itemMatches
            .map((m) => {
              const block = m[1] || "";
              const title = decodeXml(
                (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ""
              );
              const link = decodeXml(
                (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || ""
              );
              return title ? { title, uri: link || rssUrl } : null;
            })
            .filter(
              (x): x is { title: string; uri: string } => x !== null
            );

          if (liveItems.length > 0) {
            const answer = conciseForWatch
              ? liveItems.map((i) => i.title).join(". ") + "."
              : liveItems.map((i, idx) => `${idx + 1}. ${i.title}`).join("\n");
            return res.json({
              answer,
              sources: liveItems.map((i) => ({ uri: i.uri, title: i.title })),
              updatedAt: new Date().toISOString(),
            });
          }
        }

        throw lastErr || new Error("Could not fetch live updates right now.");
      }

      const rawChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = rawChunks
        .map((chunk: unknown) => {
          const web = (chunk as { web?: { uri?: string; title?: string } })?.web;
          if (web?.uri) {
            return { uri: web.uri, title: web.title || web.uri };
          }
          return null;
        })
        .filter((s): s is { uri: string; title: string } => s !== null);
      const uniqueSources = Array.from(
        new Map(sources.map((s) => [s.uri, s])).values()
      ).slice(0, 6);

      return res.json({
        answer:
          response.text?.trim() ||
          "I checked for live updates, but could not find details right now. Please try again.",
        sources: uniqueSources,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 2. Audio Transcription Endpoint (gemini-3.5-transcribe)
  app.post("/api/transcribe", async (req, res) => {
    try {
      const { audioBase64, mimeType = "audio/webm" } = req.body as {
        audioBase64?: string;
        mimeType?: string;
      };

      if (!audioBase64) {
        return res.status(400).json({ error: "No audio data provided." });
      }

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            {
              text: "Automatically detect the spoken language (any world language, regional Indian language, or mixed-language speech like Hinglish) and transcribe this audio accurately in its natural script without translating. Return only the clean transcribed text without extra commentary.",
            },
          ],
        },
      });

      const transcript = (response.text || "").trim();
      return res.json({ transcript });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Broadcast-grade voice loudness maximizer for Gemini TTS 16-bit PCM WAV output.
  // Applies 85Hz rumble filter + 2.8kHz speech presence EQ + envelope compressor + soft-knee limiter
  // so voices sound ~2.5x–3x louder and crystal-clear on phone and laptop speakers with zero clipping.
  function masterTtsWavLoudness(
    audioBase64: string,
    inlineMimeType?: string
  ): string {
    try {
      let buf = Buffer.from(audioBase64, "base64");
      if (buf.length < 16) return audioBase64;

      let sampleRate = 24000;
      let numChannels = 1;
      let dataOffset = 0;
      let dataLength = buf.length;

      const isRiffWave =
        buf.length >= 44 &&
        buf.subarray(0, 4).toString("ascii") === "RIFF" &&
        buf.subarray(8, 12).toString("ascii") === "WAVE";

      if (isRiffWave) {
        let off = 12;
        let audioFormat = 1;
        let bitsPerSample = 16;
        let foundData = false;

        while (off + 8 <= buf.length) {
          const chunkId = buf.subarray(off, off + 4).toString("ascii");
          const chunkSize = buf.readUInt32LE(off + 4);
          if (chunkId === "fmt " && off + 24 <= buf.length) {
            audioFormat = buf.readUInt16LE(off + 8);
            numChannels = Math.max(1, buf.readUInt16LE(off + 10));
            sampleRate = Math.max(8000, buf.readUInt32LE(off + 12));
            bitsPerSample = buf.readUInt16LE(off + 22);
          } else if (chunkId === "data") {
            dataOffset = off + 8;
            dataLength = Math.min(chunkSize, buf.length - dataOffset);
            foundData = true;
            break;
          }
          off += 8 + chunkSize + (chunkSize % 2);
        }

        // Only process uncompressed 16-bit PCM WAV
        if (!foundData || audioFormat !== 1 || bitsPerSample !== 16) {
          return audioBase64;
        }
      } else {
        // Raw 16-bit LE PCM fallback: wrap with a standard WAV header so browsers play it reliably
        const rateMatch = inlineMimeType?.match(/rate=(\d+)/i);
        if (rateMatch) {
          const parsed = Number(rateMatch[1]);
          if (Number.isFinite(parsed) && parsed >= 8000 && parsed <= 96000) {
            sampleRate = parsed;
          }
        }
        const pcmBytes = buf.length - (buf.length % 2);
        const wav = Buffer.alloc(44 + pcmBytes);
        wav.write("RIFF", 0, "ascii");
        wav.writeUInt32LE(36 + pcmBytes, 4);
        wav.write("WAVE", 8, "ascii");
        wav.write("fmt ", 12, "ascii");
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20); // PCM
        wav.writeUInt16LE(1, 22); // Mono
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(sampleRate * 2, 28);
        wav.writeUInt16LE(2, 32);
        wav.writeUInt16LE(16, 34);
        wav.write("data", 36, "ascii");
        wav.writeUInt32LE(pcmBytes, 40);
        buf.copy(wav, 44, 0, pcmBytes);
        buf = wav;
        dataOffset = 44;
        dataLength = pcmBytes;
      }

      const totalSamples = Math.floor(dataLength / 2);
      const frames = Math.floor(totalSamples / numChannels);
      if (frames < 64) return buf.toString("base64");

      // High-pass filter (~85Hz) to remove sub-bass rumble that wastes speaker headroom
      const rc = 1 / (2 * Math.PI * 85);
      const dt = 1 / sampleRate;
      const hpAlpha = rc / (rc + dt);

      // Speech clarity peaking EQ (+3.0 dB around 2.8 kHz, Q = 0.9) for crisp phone/laptop projection
      const f0 = Math.min(2800, sampleRate * 0.38);
      const Q = 0.9;
      const eqGainDb = 3.0;
      const A = Math.pow(10, eqGainDb / 40);
      const w0 = (2 * Math.PI * f0) / sampleRate;
      const cosW0 = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * Q);
      const a0 = 1 + alpha / A;
      const b0 = (1 + alpha * A) / a0;
      const b1 = (-2 * cosW0) / a0;
      const b2 = (1 - alpha * A) / a0;
      const a1 = (-2 * cosW0) / a0;
      const a2 = (1 - alpha / A) / a0;

      // Envelope compressor parameters (smooth smart-speaker broadcast speech leveler)
      const attackCoeff = Math.exp(-1 / (0.003 * sampleRate));
      const releaseCoeff = Math.exp(-1 / (0.08 * sampleRate));
      const compThreshold = 0.26;
      const compRatio = 5.5;
      const makeupGain = 2.15;
      const softKneeStart = 0.84;
      const softKneeHeadroom = 0.14; // Smoothly caps below 0.98

      // Process each channel independently
      const work = new Float32Array(frames);
      for (let ch = 0; ch < numChannels; ch++) {
        let hpPrevX = 0;
        let hpPrevY = 0;
        let eqX1 = 0;
        let eqX2 = 0;
        let eqY1 = 0;
        let eqY2 = 0;

        let activeSqSum = 0;
        let activeCount = 0;

        // Pass 1: Read Int16 -> HPF -> Presence EQ -> measure active speech RMS
        for (let i = 0; i < frames; i++) {
          const bytePos = dataOffset + (i * numChannels + ch) * 2;
          const raw = buf.readInt16LE(bytePos) / 32768;

          const hpY = hpAlpha * (hpPrevY + raw - hpPrevX);
          hpPrevX = raw;
          hpPrevY = hpY;

          const eqY =
            b0 * hpY + b1 * eqX1 + b2 * eqX2 - a1 * eqY1 - a2 * eqY2;
          eqX2 = eqX1;
          eqX1 = hpY;
          eqY2 = eqY1;
          eqY1 = eqY;

          work[i] = eqY;
          const absVal = Math.abs(eqY);
          if (absVal > 0.015) {
            activeSqSum += eqY * eqY;
            activeCount += 1;
          }
        }

        if (activeCount < 32) continue;
        const activeRms = Math.sqrt(activeSqSum / activeCount);
        if (activeRms < 0.002) continue;

        // Pre-gain targets strong active speech RMS (~0.48) while capping max boost on whisper-quiet audio
        const preGain = Math.min(5.5, Math.max(1.8, 0.48 / activeRms));

        // Pass 2: Envelope compressor + makeup gain + smooth soft-knee peak limiter -> Int16
        let env = 0;
        for (let i = 0; i < frames; i++) {
          const driven = work[i] * preGain;
          const absDriven = Math.abs(driven);
          if (absDriven > env) {
            env = attackCoeff * env + (1 - attackCoeff) * absDriven;
          } else {
            env = releaseCoeff * env + (1 - releaseCoeff) * absDriven;
          }

          let compGain = 1.0;
          if (env > compThreshold) {
            const compressedEnv =
              compThreshold + (env - compThreshold) / compRatio;
            compGain = compressedEnv / env;
          }

          let out = driven * compGain * makeupGain;
          const absOut = Math.abs(out);
          if (absOut > softKneeStart) {
            const limited =
              softKneeStart +
              softKneeHeadroom *
                Math.tanh((absOut - softKneeStart) / softKneeHeadroom);
            out = out < 0 ? -limited : limited;
          }

          const clampedInt = Math.max(
            -32767,
            Math.min(32767, Math.round(out * 32767))
          );
          const bytePos = dataOffset + (i * numChannels + ch) * 2;
          buf.writeInt16LE(clampedInt, bytePos);
        }
      }

      return buf.toString("base64");
    } catch {
      return audioBase64;
    }
  }

  // 3. Natural Text-to-Speech Endpoint (gemini-3.8-flash-lite-tts)
  app.post("/api/tts", async (req, res) => {
    try {
      const {
        text,
        voiceName = "Kore",
        role = "parent",
        language,
        readingStyle = "normal",
        conversational = false,
      } = req.body as {
        text?: string;
        voiceName?: string;
        role?: "parent" | "student";
        language?: string;
        readingStyle?: "normal" | "slow" | "explain";
        conversational?: boolean;
      };

      const cleanText = stripMarkdownForSpeech(text || "");
      if (!cleanText) {
        return res.status(400).json({ error: "No text provided to speak." });
      }

      const allowedVoices = new Set(["Puck", "Charon", "Kore", "Fenrir", "Zephyr"]);
      const safeVoice = allowedVoices.has(voiceName) ? voiceName : "Kore";

      const langCue =
        language && language !== "Auto-Detect"
          ? ` speaking naturally in ${language}`
          : " speaking naturally in the exact language of the text";

      const paceCue =
        readingStyle === "slow"
          ? " at a slow, extra-clear, word-by-word student learning pace with clear pauses"
          : readingStyle === "explain"
            ? " like a confident classroom teacher projecting clearly to a student"
            : "";

      const style = conversational
        ? role === "student"
          ? `Warm, expressive, well-projected human mentor speaking clearly face-to-face with genuine warmth, natural breathing rhythm, friendly intonation, and crisp clarity${langCue}${paceCue}`
          : `Warm, confident, well-projected human companion speaking clearly like a trusted family member, with genuine human inflection, natural pauses, and effortless clarity${langCue}${paceCue}`
        : role === "student"
          ? `Warm, confident, encouraging personal teacher speaking with clear projection${langCue}${paceCue}`
          : `Clear, confident, well-projected, articulate personal assistant${langCue}${paceCue}`;

      const ai = getAiClient();
      const ttsModels = orderByCooldown(
        ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"],
        (model) => ({ provider: "gemini-tts", model })
      );

      let audioBase64: string | undefined;
      let inlineMimeType: string | undefined;
      let lastTtsErr: unknown = null;

      for (const ttsModel of ttsModels) {
        try {
          const response = await ai.models.generateContent({
            model: ttsModel,
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: cleanText,
                    speechMetadata: { style },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
            },
          });
          const inlineData =
            response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (inlineData?.data) {
            audioBase64 = inlineData.data;
            inlineMimeType = inlineData.mimeType;
            break;
          }
        } catch (err) {
          markModelCooldown("gemini-tts", ttsModel, getCooldownMsForError(err));
          lastTtsErr = err;
        }
      }

      if (!audioBase64) {
        if (lastTtsErr) throw lastTtsErr;
        return res.status(502).json({ error: "Speech audio was not returned by Gemini." });
      }

      const boostedAudioBase64 = masterTtsWavLoudness(
        audioBase64,
        inlineMimeType
      );

      return res.json({
        audioBase64: boostedAudioBase64,
        mimeType: "audio/wav",
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 3b. Read Studio Prepare Endpoint (OCR textbook photo, translate to any language, or simplify & explain for student reading aloud)
  app.post("/api/read/prepare", async (req, res) => {
    try {
      const {
        text = "",
        imageBase64,
        imageMimeType = "image/jpeg",
        targetLanguage = "Auto-Detect",
        mode = "exact",
        profile,
      } = req.body as {
        text?: string;
        imageBase64?: string;
        imageMimeType?: string;
        targetLanguage?: string;
        mode?: "exact" | "translate" | "explain";
        profile?: ProfilePayload;
      };

      const cleanInput = text.trim();
      if (!cleanInput && !imageBase64) {
        return res.status(400).json({
          error: "Please enter text or attach a textbook photo to read.",
        });
      }

      const targetLangInstruction =
        targetLanguage && targetLanguage !== "Auto-Detect"
          ? `Output MUST be written naturally in ${targetLanguage} using its authentic native script (for example, Odia in ଓଡ଼ିଆ, Hindi in हिन्दी, English in English).`
          : "Keep the exact original language and script of the text.";

      const studentContext =
        profile?.role === "student"
          ? `The listener is ${profile.name} (${profile.grade || "school student"}).`
          : `The listener is ${profile?.name || "Jogi"}.`;

      let taskPrompt = "";
      if (imageBase64 && mode === "exact") {
        taskPrompt = [
          "Extract all readable text cleanly from this textbook, notebook, or worksheet image in reading order.",
          "Return ONLY the clean extracted text formatted into natural readable paragraphs/sentences with no extra commentary or markdown headers.",
          targetLanguage && targetLanguage !== "Auto-Detect"
            ? `If the text is in another language, translate it cleanly into ${targetLanguage} so it can be read aloud directly.`
            : "Preserve the exact original language and script.",
        ].join("\n");
      } else if (mode === "translate") {
        taskPrompt = [
          "Translate the provided passage naturally and accurately for smooth read-aloud listening.",
          targetLangInstruction,
          "Keep every sentence clear, natural to speak aloud, and accurate. Return ONLY the translated reading text without preamble or markdown symbols.",
        ].join("\n");
      } else {
        taskPrompt = [
          `${studentContext} Prepare a warm, crystal-clear read-aloud teaching script based on the provided material.`,
          "First state the main idea clearly, then walk through the key facts sentence by sentence in easy, memorable language suitable for listening and learning.",
          targetLangInstruction,
          "Return ONLY clean plain spoken paragraphs (no markdown asterisks, bullets, or code blocks) so it sounds natural when read aloud.",
        ].join("\n");
      }

      const parts: Array<
        { text: string } | { inlineData: { mimeType: string; data: string } }
      > = [];
      if (imageBase64) {
        parts.push({
          inlineData: { mimeType: imageMimeType, data: imageBase64 },
        });
      }
      parts.push({
        text: cleanInput ? `${taskPrompt}\n\nMaterial:\n${cleanInput}` : taskPrompt,
      });

      let preparedText = "";
      let lastErr: unknown = null;

      if (hasGeminiKey()) {
        try {
          const ai = getAiClient();
          const { response } = await generateGeminiTextWithFallback(
            ai,
            [{ role: "user", parts }],
            () => ({
              systemInstruction:
                "You are Jogi Jarvis, an expert multilingual reading coach and study teacher.",
            })
          );
          preparedText = response.text?.trim() || "";
        } catch (err) {
          lastErr = err;
        }
      }

      if (!preparedText && !imageBase64 && hasAnyFallbackProvider()) {
        const fallback = await callFallbackPoolChat(
          [
            {
              role: "system",
              content:
                "You are Jogi Jarvis, an expert multilingual reading coach and study teacher.",
            },
            {
              role: "user",
              content: cleanInput
                ? `${taskPrompt}\n\nMaterial:\n${cleanInput}`
                : taskPrompt,
            },
          ],
          "fast"
        );
        preparedText = fallback.text;
      }

      if (!preparedText) {
        throw lastErr || new Error("Could not prepare text for reading.");
      }

      return res.json({ text: preparedText });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 3c. Ultra-Fast Live Voice & Face-to-Face Human Interpreter Endpoint (Single-Shot Multimodal + Inline Fast TTS)
  app.post("/api/translate/conversation", async (req, res) => {
    try {
      const {
        audioBase64,
        audioMimeType = "audio/webm",
        text = "",
        myLanguage = "English",
        otherLanguage = "Auto-Detect",
        lastOtherLanguage = "",
        direction = "auto_conversation",
        sameLanguageAnswer = false,
        recentContext = [],
        fastMode = true,
        includeAudio = false,
        voiceName = "Kore",
      } = req.body as {
        audioBase64?: string;
        audioMimeType?: string;
        text?: string;
        myLanguage?: string;
        otherLanguage?: string;
        lastOtherLanguage?: string;
        direction?: "me_to_them" | "them_to_me" | "auto_conversation" | "listen_any";
        sameLanguageAnswer?: boolean;
        recentContext?: Array<{ originalText: string; translatedText: string }>;
        fastMode?: boolean;
        includeAudio?: boolean;
        voiceName?: string;
      };

      const cleanMyLang = (myLanguage || "English").trim() || "English";
      const cleanOtherLang = (otherLanguage || "Auto-Detect").trim() || "Auto-Detect";
      const isOtherAuto = cleanOtherLang.toLowerCase() === "auto-detect";
      const cleanLastOther = (lastOtherLanguage || "").trim();
      const effectivePartnerLang = !isOtherAuto
        ? cleanOtherLang
        : cleanLastOther && cleanLastOther.toLowerCase() !== cleanMyLang.toLowerCase()
          ? cleanLastOther
          : "";
      const isSameLanguageSelected =
        !isOtherAuto && cleanMyLang.toLowerCase() === cleanOtherLang.toLowerCase();
      const useSameLangReply =
        direction !== "listen_any" &&
        (Boolean(sameLanguageAnswer) || isSameLanguageSelected);

      const contextLines = Array.isArray(recentContext)
        ? recentContext
            .slice(-4)
            .map(
              (c, i) =>
                `Turn ${i + 1}: "${(c.originalText || "").slice(0, 120)}" -> "${(c.translatedText || "").slice(0, 120)}"`
            )
            .join("\n")
        : "";

      const systemInstruction =
        "You are Jogi Jarvis, an ultra-fast real-time face-to-face human interpreter supporting every world language and dialect. Be brisk, accurate, and natural — zero robotic preamble and zero filler questions so live conversations flow effortlessly.";

      let taskInstructions = "";
      if (useSameLangReply) {
        taskInstructions = [
          `SAME-LANGUAGE MODE (${cleanMyLang}):`,
          `1. Detect spoken language (detectedLanguage). Set targetLanguage="${cleanMyLang}".`,
          `2. Give a natural, brisk reply in ${cleanMyLang} inside translatedText (1-2 short sentences).`,
          `3. Set speakerSide="${direction === "them_to_me" ? "them" : "me"}", pronunciation="".`,
          `4. Provide 2 very short follow-up phrases in ${cleanMyLang} inside suggestedReplies.`,
        ].join("\n");
      } else if (direction === "listen_any" || direction === "them_to_me") {
        taskInstructions = [
          `OTHER PERSON -> EXPLAIN TO USER MODE: Another person is speaking${effectivePartnerLang ? ` (likely ${effectivePartnerLang})` : " in any world language"} and the user understands ${cleanMyLang}.`,
          `1. Identify their exact spoken language in detectedLanguage (e.g. "Spanish", "Hindi", "Odia", "Tamil", "Arabic").`,
          `2. Set speakerSide="them" and targetLanguage="${cleanMyLang}".`,
          `3. Put a crisp, clear, natural explanation of what they just said or asked in ${cleanMyLang} inside translatedText. Keep it direct and concise so the user understands immediately — DO NOT add filler like "What would you like to reply?" or "The person said".`,
          `4. Provide 2 short natural reply options in ${cleanMyLang} inside suggestedReplies. Set pronunciation="".`,
        ].join("\n");
      } else if (direction === "me_to_them") {
        const destLang = effectivePartnerLang || "Hindi";
        taskInstructions = [
          `USER -> TRANSLATE TO OTHER PERSON MODE: The user is speaking in ${cleanMyLang} and needs you to translate directly for the other person in "${destLang}" (or another language ONLY if the user explicitly names one like "in Arabic").`,
          `1. Set detectedLanguage="${cleanMyLang}" (or the language spoken), speakerSide="me".`,
          `2. Set targetLanguage to the language explicitly named by the user, otherwise "${destLang}".`,
          `3. Strip meta-commands like "tell them", "say to them", "answer them", and put the direct, natural, polite spoken translation in targetLanguage inside translatedText — ZERO extra commentary.`,
          `4. If targetLanguage uses a non-Latin script, include a brief Latin pronunciation hint in pronunciation; otherwise "".`,
          `5. Provide 2 very short follow-up phrases in ${cleanMyLang} inside suggestedReplies.`,
        ].join("\n");
      } else {
        const partnerHint = effectivePartnerLang
          ? `The other person's locked language is "${effectivePartnerLang}".`
          : `The other person's language is Auto-Detect (any world language different from ${cleanMyLang}).`;
        taskInstructions = [
          `FAST TWO-WAY FACE-TO-FACE INTERPRETER MODE: User's language is "${cleanMyLang}". ${partnerHint}`,
          `1. Identify the exact spoken language in detectedLanguage.`,
          `2. CASE A — The speech is in ANY language DIFFERENT from ${cleanMyLang}:`,
          `   - Set speakerSide="them", targetLanguage="${cleanMyLang}".`,
          `   - Explain clearly and concisely in ${cleanMyLang} what they just said or asked inside translatedText (direct human explanation, NO robotic preamble and NO trailing "What would you like to reply?" filler).`,
          `3. CASE B — The speech is in ${cleanMyLang} (the user is speaking):`,
          `   - Set speakerSide="me".`,
          `   - Set targetLanguage to the language explicitly named by the user OR "${effectivePartnerLang || "the exact language the other person spoke in recent context"}".`,
          `   - Strip meta-commands like "tell them", "answer them", "say that", and put the direct, natural spoken translation in targetLanguage inside translatedText.`,
          `   - Only if NO other person has spoken yet and NO target language was named: set targetLanguage="${cleanMyLang}" and give a 1-sentence confirmation in ${cleanMyLang} that you are listening for the other person.`,
          `4. Provide 2 very short reply hints in ${cleanMyLang} inside suggestedReplies.`,
          `5. If targetLanguage uses a non-Latin script and differs from ${cleanMyLang}, add a short Latin pronunciation hint; otherwise "".`,
        ].join("\n");
      }

      const schemaHint =
        '{"empty":false,"originalText":"string","detectedLanguage":"string","targetLanguage":"string","translatedText":"string","pronunciation":"string","speakerSide":"me|them","suggestedReplies":["string","string"]}';

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          empty: { type: Type.BOOLEAN },
          originalText: { type: Type.STRING },
          detectedLanguage: { type: Type.STRING },
          targetLanguage: { type: Type.STRING },
          translatedText: { type: Type.STRING },
          pronunciation: { type: Type.STRING },
          speakerSide: { type: Type.STRING },
          suggestedReplies: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "detectedLanguage",
          "targetLanguage",
          "translatedText",
          "speakerSide",
        ],
      };

      type TranslationResult = {
        empty?: boolean;
        originalText?: string;
        detectedLanguage?: string;
        targetLanguage?: string;
        translatedText?: string;
        pronunciation?: string;
        speakerSide?: string;
        suggestedReplies?: string[];
      };

      let spokenText = (text || "").trim();
      let parsed: TranslationResult | null = null;

      // FAST PATH (1 single round-trip!): Audio -> Transcribe + Detect + Explain/Translate in ONE shot using gemini-3.1-flash-lite (zero-thinking MINIMAL)
      if (!spokenText && audioBase64 && hasGeminiKey() && fastMode) {
        try {
          const ai = getAiClient();
          const oneShotPrompt = [
            taskInstructions,
            contextLines ? `\nRecent turns:\n${contextLines}` : "",
            `\nListen to the attached audio clip:`,
            `- If it is only silence, breathing, or background noise with no clear speech, return {"empty":true,"originalText":"","detectedLanguage":"","targetLanguage":"","translatedText":"","pronunciation":"","speakerSide":"them","suggestedReplies":[]}.`,
            `- Otherwise, put the faithful original spoken transcript in its native script in originalText, and complete the JSON response immediately.`,
          ]
            .filter(Boolean)
            .join("\n");

          const oneShotRes = await ai.models.generateContent({
            model: "gemini-3.1-flash-lite",
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: audioMimeType,
                    data: audioBase64,
                  },
                },
                { text: oneShotPrompt },
              ],
            },
            config: {
              systemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              responseMimeType: "application/json",
              responseSchema,
            },
          });

          const candidate = parseJsonFromText<TranslationResult>(
            oneShotRes.text || "{}"
          );
          if (candidate?.empty) {
            return res.json({ empty: true });
          }
          if (candidate?.translatedText && candidate.translatedText.trim()) {
            parsed = candidate;
            spokenText = (candidate.originalText || "").trim();
          }
        } catch (oneShotErr) {
          console.warn(
            "[Fast Translate One-Shot] Falling back to 2-step pipeline:",
            oneShotErr instanceof Error ? oneShotErr.message : oneShotErr
          );
        }
      }

      // Standard fallback pipeline if text was provided or one-shot audio wasn't used
      if (!parsed) {
        if (!spokenText && audioBase64) {
          const ai = getAiClient();
          const transcribeParts = [
            {
              inlineData: {
                mimeType: audioMimeType,
                data: audioBase64,
              },
            },
            {
              text: "Automatically detect the exact spoken language (any world language or dialect) and transcribe this audio faithfully in its natural native script without translating. Return ONLY the clean spoken transcript. If there is only silence or background noise, return an empty string.",
            },
          ];

          try {
            const transcribeRes = await withRetry(
              () =>
                ai.models.generateContent({
                  model: "gemini-3.5-transcribe",
                  contents: { parts: transcribeParts },
                }),
              2
            );
            spokenText = (transcribeRes.text || "").trim();
          } catch {
            const { response: fallbackAudioRes } =
              await generateGeminiTextWithFallback(
                ai,
                [{ role: "user", parts: transcribeParts }],
                () => ({
                  systemInstruction:
                    "You are an accurate multilingual speech transcriber. Output only the clean spoken words in their original language, or empty string if only noise.",
                })
              );
            spokenText = (fallbackAudioRes.text || "").trim();
          }
        }

        const cleanedNoiseCheck = spokenText
          .replace(/^\[.*\]$/g, "")
          .replace(/[.!?,…\s]+/g, "")
          .trim();

        if (!cleanedNoiseCheck) {
          return res.json({ empty: true });
        }

        const userPrompt = [
          taskInstructions,
          contextLines ? `\nRecent conversation context:\n${contextLines}` : "",
          `\nSpoken input to process:\n"${spokenText}"`,
        ]
          .filter(Boolean)
          .join("\n");

        if (!hasGeminiKey() && hasAnyFallbackProvider()) {
          parsed = await callFallbackPoolJson<TranslationResult>(
            systemInstruction,
            userPrompt,
            schemaHint
          );
        } else {
          try {
            const ai = getAiClient();
            if (fastMode) {
              try {
                const fastTextRes = await ai.models.generateContent({
                  model: "gemini-3.1-flash-lite",
                  contents: userPrompt,
                  config: {
                    systemInstruction,
                    thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                    responseMimeType: "application/json",
                    responseSchema,
                  },
                });
                parsed = parseJsonFromText<TranslationResult>(
                  fastTextRes.text || "{}"
                );
              } catch {
                // Fall through to standard Gemini fallback
              }
            }
            if (!parsed?.translatedText) {
              const { response } = await generateGeminiTextWithFallback(
                ai,
                userPrompt,
                (model) => ({
                  systemInstruction,
                  ...(model === "gemini-4-hydrogen"
                    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                    : { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }),
                  responseMimeType: "application/json",
                  responseSchema,
                })
              );
              parsed = parseJsonFromText<TranslationResult>(response.text || "{}");
            }
          } catch (geminiErr) {
            if (hasAnyFallbackProvider()) {
              parsed = await callFallbackPoolJson<TranslationResult>(
                systemInstruction,
                userPrompt,
                schemaHint
              );
            } else {
              throw geminiErr;
            }
          }
        }
      }

      const safeSide = parsed.speakerSide === "them" ? "them" : "me";
      const safeTarget =
        (parsed.targetLanguage || "").trim() ||
        (safeSide === "me" ? effectivePartnerLang || cleanOtherLang : cleanMyLang);
      const finalTranslatedText = (parsed.translatedText || spokenText).trim();
      const finalOriginalText = (spokenText || parsed.originalText || "").trim();

      const cleanedOutNoise = finalOriginalText
        .replace(/^\[.*\]$/g, "")
        .replace(/[.!?,…\s]+/g, "")
        .trim();
      if (!cleanedOutNoise && !finalTranslatedText) {
        return res.json({ empty: true });
      }

      // Optional inline fast TTS so the client plays speech IMMEDIATELY with zero extra network round-trip!
      let inlineAudioBase64: string | undefined;
      if (includeAudio && finalTranslatedText && hasGeminiKey()) {
        try {
          const ai = getAiClient();
          const allowedVoices = new Set(["Puck", "Charon", "Kore", "Fenrir", "Zephyr"]);
          const safeVoice = allowedVoices.has(voiceName) ? voiceName : "Kore";
          const ttsSpeechText = stripMarkdownForSpeech(finalTranslatedText);
          const ttsPromise = ai.models.generateContent({
            model: "gemini-3.8-flash-lite-tts",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: ttsSpeechText,
                    speechMetadata: {
                      style: `Crisp, warm, brisk live human interpreter speaking clearly in ${safeTarget} at natural conversational speed`,
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
            },
          });

          const timeoutPromise = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 2800)
          );
          const ttsRes = await Promise.race([ttsPromise, timeoutPromise]);
          const inlineData =
            ttsRes?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (inlineData?.data) {
            inlineAudioBase64 = masterTtsWavLoudness(
              inlineData.data,
              inlineData.mimeType
            );
          }
        } catch {
          // Non-fatal: client falls back immediately to fast browser TTS
        }
      }

      return res.json({
        originalText: finalOriginalText,
        detectedLanguage: (parsed.detectedLanguage || cleanMyLang).trim(),
        targetLanguage: safeTarget,
        translatedText: finalTranslatedText,
        pronunciation: (parsed.pronunciation || "").trim(),
        speakerSide: safeSide,
        suggestedReplies: Array.isArray(parsed.suggestedReplies)
          ? parsed.suggestedReplies
              .filter((r): r is string => typeof r === "string" && Boolean(r.trim()))
              .slice(0, 3)
          : [],
        modeUsed: useSameLangReply ? "same_language_reply" : "translate",
        ...(inlineAudioBase64
          ? { audioBase64: inlineAudioBase64, audioMimeType: "audio/wav" }
          : {}),
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4. Structured AI Study Note Generator (gemini-4-hydrogen + JSON responseSchema)
  app.post("/api/notes/generate", async (req, res) => {
    try {
      const {
        content,
        profile,
        subject = "General",
        topicHint,
        language,
        importantPointsOnly = false,
      } = req.body as {
        content?: string;
        profile?: ProfilePayload;
        subject?: string;
        topicHint?: string;
        language?: string;
        importantPointsOnly?: boolean;
      };

      const sourceMaterial = (content || topicHint || "").trim();
      if (!sourceMaterial) {
        return res.status(400).json({ error: "Please provide a topic or study conversation to turn into notes." });
      }

      const isStudent = profile?.role === "student";
      const audience = isStudent
        ? `${profile?.name || "a student"} (${profile?.grade || "school level"})`
        : `${profile?.name || "Jogi"} (personal & family reference)`;
      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );

      const prompt = [
        `Create crisp, memorable, high-clarity AI study notes for ${audience}.`,
        `Preferred subject category: ${subject}.`,
        importantPointsOnly
          ? "STRICT REVISION FOCUS: The source material below contains ONLY the auto-marked important study points from a live voice study session. Build the revision note strictly around these marked important points without adding unrelated filler."
          : "Distill the material below into well-organized notes that are genuinely useful for revision, homework, or quick recall.",
        "Include 4 to 7 clear keyPoints, 2 to 5 key definitions/formulas (if applicable), 2 to 4 practiceQuestions with clear answers for self-testing, and 1 warm teacherTip for remembering the topic.",
        langRule,
        "",
        importantPointsOnly ? "Marked important study points:" : "Source material:",
        sourceMaterial,
      ].join("\n");

      const noteSystemInstruction =
        "You are Jogi Jarvis, an expert educator and executive note-taker who writes crystal-clear, structured revision notes in any requested language (including Odia, Hindi, English, and Math notation).";
      const noteJsonSchemaHint =
        '{"title":"string","subject":"string","summary":"string","keyPoints":["string"],"definitions":[{"term":"string","meaning":"string"}],"practiceQuestions":[{"question":"string","answer":"string"}],"teacherTip":"string"}';

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        const parsed = await callFallbackPoolJson(
          noteSystemInstruction,
          prompt,
          noteJsonSchemaHint
        );
        return res.json({ note: parsed });
      }

      const noteResponseSchema = {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: "Concise, clear study note title (3 to 9 words).",
          },
          subject: {
            type: Type.STRING,
            description:
              "Best matching subject name such as Mathematics, Science, English, History, Geography, Computer Science, Languages, or Personal.",
          },
          summary: {
            type: Type.STRING,
            description: "2 to 3 sentence Big Idea summary of the topic.",
          },
          keyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "4 to 7 clear, self-contained bullet points.",
          },
          definitions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING },
                meaning: { type: Type.STRING },
              },
              required: ["term", "meaning"],
            },
            description: "Important vocabulary terms, rules, or formulas.",
          },
          practiceQuestions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                answer: { type: Type.STRING },
              },
              required: ["question", "answer"],
            },
            description: "2 to 4 self-check questions with clear answers.",
          },
          teacherTip: {
            type: Type.STRING,
            description: "One practical, encouraging memory tip or study takeaway.",
          },
        },
        required: [
          "title",
          "subject",
          "summary",
          "keyPoints",
          "definitions",
          "practiceQuestions",
          "teacherTip",
        ],
      };

      try {
        const ai = getAiClient();
        const { response } = await generateGeminiTextWithFallback(
          ai,
          prompt,
          (model) => ({
            systemInstruction: noteSystemInstruction,
            ...(model === "gemini-4-hydrogen"
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            responseMimeType: "application/json",
            responseSchema: noteResponseSchema,
          })
        );

        const parsed = parseJsonFromText(response.text || "{}");
        return res.json({ note: parsed });
      } catch (geminiErr) {
        if (hasAnyFallbackProvider()) {
          const parsed = await callFallbackPoolJson(
            noteSystemInstruction,
            prompt,
            noteJsonSchemaHint
          );
          return res.json({ note: parsed });
        }
        throw geminiErr;
      }
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4b. Concise Study Summary Generator for Long Chat Sessions
  app.post("/api/notes/study-summary", async (req, res) => {
    try {
      const {
        transcript,
        messageCount = 0,
        profile,
        subject = "General",
        language,
      } = req.body as {
        transcript?: string;
        messageCount?: number;
        profile?: ProfilePayload;
        subject?: string;
        language?: string;
      };

      const cleanTranscript = (transcript || "").trim();
      if (!cleanTranscript) {
        return res.status(400).json({
          error: "Please provide a chat session to summarize.",
        });
      }

      const isStudent = profile?.role === "student";
      const audience = isStudent
        ? `${profile?.name || "a student"} (${profile?.grade || "school level"})`
        : `${profile?.name || "Jogi"} (personal & family reference)`;
      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );

      const prompt = [
        `Distill the following ${messageCount > 0 ? `${messageCount}-turn ` : ""}chat session into a concise, high-retention "Study Summary" for ${audience}.`,
        `Subject focus: ${subject}.`,
        "Instructions for condensing long sessions:",
        "- Strip out greetings, small talk, repeated clarifications, and filler.",
        "- Synthesize the entire conversation into a tight, unified Study Summary that can be reviewed in 60 seconds.",
        "- Title must start with 'Study Summary:' followed by a crisp 3 to 7 word topic label.",
        "- Summary must be 2 to 3 concise sentences capturing the overarching concept or decision.",
        "- KeyPoints must contain 3 to 5 brief, high-signal bullet takeaways (1 sentence each).",
        "- Definitions must include only the 1 to 4 most essential terms, rules, or formulas discussed.",
        "- PracticeQuestions must include 2 to 3 quick revision check questions covering the session.",
        "- TeacherTip must be 1 short sentence highlighting the single most important thing to review next.",
        `- ${langRule}`,
        "",
        "Chat session transcript:",
        cleanTranscript,
      ].join("\n");

      const summarySystemInstruction =
        "You are Jogi Jarvis, an expert educator who condenses long study conversations into ultra-concise, crystal-clear Study Summaries in any requested language.";
      const summaryJsonSchemaHint =
        '{"title":"string","subject":"string","summary":"string","keyPoints":["string"],"definitions":[{"term":"string","meaning":"string"}],"practiceQuestions":[{"question":"string","answer":"string"}],"teacherTip":"string"}';

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        const parsed = await callFallbackPoolJson(
          summarySystemInstruction,
          prompt,
          summaryJsonSchemaHint
        );
        return res.json({ note: parsed });
      }

      const summaryResponseSchema = {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description:
              "Concise title starting with 'Study Summary:' (e.g. 'Study Summary: Linear Equations & Slope').",
          },
          subject: {
            type: Type.STRING,
            description:
              "Best matching subject name such as Mathematics, Science, English, History, Geography, Computer Science, Languages, or Personal.",
          },
          summary: {
            type: Type.STRING,
            description: "Concise 2 to 3 sentence synthesis of the entire session.",
          },
          keyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "3 to 5 brief, high-signal bullet takeaways.",
          },
          definitions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING },
                meaning: { type: Type.STRING },
              },
              required: ["term", "meaning"],
            },
            description: "Essential terms, rules, or formulas from the session.",
          },
          practiceQuestions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                answer: { type: Type.STRING },
              },
              required: ["question", "answer"],
            },
            description: "2 to 3 quick self-check revision questions.",
          },
          teacherTip: {
            type: Type.STRING,
            description: "One short sentence on what to remember or practice next.",
          },
        },
        required: [
          "title",
          "subject",
          "summary",
          "keyPoints",
          "definitions",
          "practiceQuestions",
          "teacherTip",
        ],
      };

      try {
        const ai = getAiClient();
        const { response } = await generateGeminiTextWithFallback(
          ai,
          prompt,
          (model) => ({
            systemInstruction: summarySystemInstruction,
            ...(model === "gemini-4-hydrogen"
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            responseMimeType: "application/json",
            responseSchema: summaryResponseSchema,
          })
        );

        const parsed = parseJsonFromText(response.text || "{}");
        return res.json({ note: parsed });
      } catch (geminiErr) {
        if (hasAnyFallbackProvider()) {
          const parsed = await callFallbackPoolJson(
            summarySystemInstruction,
            prompt,
            summaryJsonSchemaHint
          );
          return res.json({ note: parsed });
        }
        throw geminiErr;
      }
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4c. Translate Existing Study Note into Any Language (Odia, Hindi, English, etc.)
  app.post("/api/notes/translate", async (req, res) => {
    try {
      const { note, targetLanguage } = req.body as {
        note?: {
          title?: string;
          subject?: string;
          summary?: string;
          keyPoints?: string[];
          definitions?: Array<{ term: string; meaning: string }>;
          practiceQuestions?: Array<{ question: string; answer: string }>;
          teacherTip?: string;
        };
        targetLanguage?: string;
      };

      if (!note || !targetLanguage?.trim()) {
        return res.status(400).json({
          error: "Please select a target language to translate this note.",
        });
      }

      const prompt = [
        `Translate this structured study note naturally and accurately into ${targetLanguage.trim()} (using its authentic native script, e.g., ଓଡ଼ିଆ for Odia, हिन्दी for Hindi).`,
        "Keep mathematical formulas, equations, chemical symbols (like H2O, CO2, x = 5), and scientific notation clear and intact.",
        "Return the exact same JSON structure with every field translated clearly for easy studying.",
        "",
        JSON.stringify(note),
      ].join("\n");

      const translateSystemInstruction =
        "You are an expert multilingual teacher translating study notes accurately while preserving formulas and educational clarity.";
      const translateJsonSchemaHint =
        '{"title":"string","subject":"string","summary":"string","keyPoints":["string"],"definitions":[{"term":"string","meaning":"string"}],"practiceQuestions":[{"question":"string","answer":"string"}],"teacherTip":"string"}';

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        const translated = await callFallbackPoolJson(
          translateSystemInstruction,
          prompt,
          translateJsonSchemaHint
        );
        return res.json({ note: translated });
      }

      const translateResponseSchema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          subject: { type: Type.STRING },
          summary: { type: Type.STRING },
          keyPoints: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          definitions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                term: { type: Type.STRING },
                meaning: { type: Type.STRING },
              },
              required: ["term", "meaning"],
            },
          },
          practiceQuestions: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                answer: { type: Type.STRING },
              },
              required: ["question", "answer"],
            },
          },
          teacherTip: { type: Type.STRING },
        },
        required: [
          "title",
          "subject",
          "summary",
          "keyPoints",
          "definitions",
          "practiceQuestions",
          "teacherTip",
        ],
      };

      try {
        const ai = getAiClient();
        const { response } = await generateGeminiTextWithFallback(
          ai,
          prompt,
          (model) => ({
            systemInstruction: translateSystemInstruction,
            ...(model === "gemini-4-hydrogen"
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
            responseMimeType: "application/json",
            responseSchema: translateResponseSchema,
          })
        );

        const translated = parseJsonFromText(response.text || "{}");
        return res.json({ note: translated });
      } catch (geminiErr) {
        if (hasAnyFallbackProvider()) {
          const translated = await callFallbackPoolJson(
            translateSystemInstruction,
            prompt,
            translateJsonSchemaHint
          );
          return res.json({ note: translated });
        }
        throw geminiErr;
      }
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 5. Interactive Teacher Quiz Answer Checker
  app.post("/api/quiz/check", async (req, res) => {
    try {
      const { question, expectedAnswer, studentAnswer, profile, language } = req.body as {
        question?: string;
        expectedAnswer?: string;
        studentAnswer?: string;
        profile?: ProfilePayload;
        language?: string;
      };

      if (!question || !studentAnswer?.trim()) {
        return res.status(400).json({ error: "Please write an answer first." });
      }

      const studentName = profile?.name || "student";
      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );
      const quizPrompt = [
        `Student: ${studentName} (${profile?.grade || "General"})`,
        `Question: ${question}`,
        `Reference answer: ${expectedAnswer || "Evaluate logically."}`,
        `Student's answer: ${studentAnswer}`,
        "Evaluate whether the student's answer demonstrates understanding even if written in a different language than the question. Respond kindly like a supportive personal teacher.",
        langRule,
      ].join("\n");
      const quizSystemInstruction =
        "You are Jogi Jarvis, a supportive personal teacher checking a student's practice quiz answer.";
      const quizSchemaHint =
        '{"isCorrect":true,"feedback":"1 to 2 warm encouraging sentences","hint":"Optional short next-step tip"}';

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        const result = await callFallbackPoolJson(
          quizSystemInstruction,
          quizPrompt,
          quizSchemaHint
        );
        return res.json(result);
      }

      const quizResponseSchema = {
        type: Type.OBJECT,
        properties: {
          isCorrect: { type: Type.BOOLEAN },
          feedback: {
            type: Type.STRING,
            description: "1 to 2 warm, encouraging sentences explaining what was right or what to refine.",
          },
          hint: {
            type: Type.STRING,
            description: "Optional short next-step tip or memory cue.",
          },
        },
        required: ["isCorrect", "feedback"],
      };

      try {
        const ai = getAiClient();
        const { response } = await generateGeminiTextWithFallback(
          ai,
          quizPrompt,
          () => ({
            responseMimeType: "application/json",
            responseSchema: quizResponseSchema,
          })
        );

        const result = parseJsonFromText(response.text || "{}");
        return res.json(result);
      } catch (geminiErr) {
        if (hasAnyFallbackProvider()) {
          const result = await callFallbackPoolJson(
            quizSystemInstruction,
            quizPrompt,
            quizSchemaHint
          );
          return res.json(result);
        }
        throw geminiErr;
      }
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Helper: sanitize generated SVG diagrams strictly (no scripts, event handlers, or external frames)
  const sanitizeSvgMarkup = (raw: string): string => {
    const match = raw.match(/<svg[\s\S]*?<\/svg>/i);
    if (!match) return "";
    let svg = match[0]
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/<(iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(iframe|object|embed|link|meta)[^>]*\/?>/gi, "")
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/data\s*:\s*text\/html/gi, "");

    if (!/xmlns=/i.test(svg)) {
      svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    if (!/viewBox=/i.test(svg)) {
      svg = svg.replace(/<svg/i, '<svg viewBox="0 0 800 520"');
    }
    return svg.trim();
  };

  // Helper: fetch free verified educational reference photos from Wikimedia Commons (no API key needed)
  const searchWikimediaPhotos = async (
    queryText: string
  ): Promise<
    Array<{ title: string; imageUrl: string; pageUrl: string; credit?: string }>
  > => {
    const cleanQuery = queryText
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!cleanQuery) return [];
    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(
        cleanQuery
      )}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=760&format=json&origin=*`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "JogiJarvisStudyAssistant/1.0" },
        signal: AbortSignal.timeout(7000),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              title?: string;
              imageinfo?: Array<{
                url?: string;
                thumburl?: string;
                descriptionurl?: string;
                mime?: string;
                extmetadata?: { Artist?: { value?: string } };
              }>;
            }
          >;
        };
      };
      const pages = Object.values(data.query?.pages || {});
      const results: Array<{
        title: string;
        imageUrl: string;
        pageUrl: string;
        credit?: string;
      }> = [];

      for (const page of pages) {
        const info = page.imageinfo?.[0];
        if (!info) continue;
        const mime = (info.mime || "").toLowerCase();
        if (
          !["image/jpeg", "image/png", "image/webp", "image/svg+xml"].includes(mime)
        ) {
          continue;
        }
        const imgUrl = info.thumburl || info.url;
        if (!imgUrl || !/^https:\/\//i.test(imgUrl)) continue;
        const title = (page.title || "Study Picture")
          .replace(/^File:/i, "")
          .replace(/\.[a-z0-9]+$/i, "")
          .replace(/_/g, " ")
          .trim()
          .slice(0, 90);
        results.push({
          title,
          imageUrl: imgUrl,
          pageUrl: info.descriptionurl || imgUrl,
          credit: "Wikimedia Commons",
        });
        if (results.length >= 4) break;
      }
      return results;
    } catch {
      return [];
    }
  };

  const buildStudyVideoLinks = (topic: string, subject?: string) => {
    const cleanTopic = topic.trim().slice(0, 90);
    const subjectSuffix =
      subject && subject !== "All Subjects" ? ` ${subject}` : "";
    const ytQuery = encodeURIComponent(`${cleanTopic}${subjectSuffix} explained`);
    const khanQuery = encodeURIComponent(cleanTopic);
    const wikiQuery = encodeURIComponent(cleanTopic);
    return [
      {
        title: `YouTube: ${cleanTopic.slice(0, 32)} Explained`,
        url: `https://www.youtube.com/results?search_query=${ytQuery}`,
        source: "YouTube",
      },
      {
        title: "Khan Academy Lessons",
        url: `https://www.khanacademy.org/search?page_search_query=${khanQuery}`,
        source: "Khan Academy",
      },
      {
        title: "Wikimedia Educational Media",
        url: `https://commons.wikimedia.org/w/index.php?search=${wikiQuery}&title=Special:MediaSearch&type=video`,
        source: "Wikimedia",
      },
    ];
  };

  // Shared server-side validator/inferrer for AI-directed 3D PBR scene blueprints
  function normalizeServerScene3d(
    raw: unknown,
    title: string,
    subject?: string,
    fallbackAccent = "#2563EB"
  ) {
    const allowedArchetypes = new Set([
      "solar",
      "atom",
      "dna",
      "heart",
      "plant",
      "watercycle",
      "rocket",
      "circuit",
      "earth",
      "volcano",
      "wave",
      "architecture",
      "custom",
    ]);
    const allowedEnvs = new Set(["studio", "space", "outdoor", "lab", "sunset"]);
    const allowedShapes = new Set([
      "sphere",
      "box",
      "cylinder",
      "cone",
      "torus",
      "capsule",
      "icosahedron",
      "ring",
    ]);
    const allowedAnims = new Set(["spin", "orbit", "pulse", "float", "none"]);

    const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const hay = `${title} ${subject || ""}`.toLowerCase();

    let defaultArch = "architecture";
    let defaultEnv = "studio";
    let defaultPrimary = /^#[0-9a-fA-F]{6}$/.test(fallbackAccent) ? fallbackAccent : "#2563EB";
    let defaultAccent = "#38BDF8";

    if (/(solar|planet|sun|moon|orbit|galaxy|star|saturn|jupiter|mars|astronomy)/i.test(hay)) {
      defaultArch = "solar";
      defaultEnv = "space";
      defaultPrimary = "#F59E0B";
    } else if (/(dna|gene|helix|chromosome|rna|genetics|cell|mitochondria)/i.test(hay)) {
      defaultArch = "dna";
      defaultEnv = "lab";
      defaultPrimary = "#06B6D4";
      defaultAccent = "#EC4899";
    } else if (/(heart|blood|circulat|artery|vein|organ|anatomy|human body)/i.test(hay)) {
      defaultArch = "heart";
      defaultEnv = "lab";
      defaultPrimary = "#DC2626";
      defaultAccent = "#3B82F6";
    } else if (/(photosynthesis|plant|leaf|tree|flower|forest|botany|chlorophyll)/i.test(hay)) {
      defaultArch = "plant";
      defaultEnv = "outdoor";
      defaultPrimary = "#10B981";
      defaultAccent = "#FBBF24";
    } else if (/(water cycle|rain|cloud|evaporat|condens|river|ocean|weather|climate)/i.test(hay)) {
      defaultArch = "watercycle";
      defaultEnv = "outdoor";
      defaultPrimary = "#0284C7";
      defaultAccent = "#F59E0B";
    } else if (/(volcano|magma|lava|earthquake|tectonic|crust|geology)/i.test(hay)) {
      defaultArch = "volcano";
      defaultEnv = "sunset";
      defaultPrimary = "#EA580C";
      defaultAccent = "#FACC15";
    } else if (/(rocket|spacecraft|launch|satellite|newton|gravity|thrust|airplane|flight)/i.test(hay)) {
      defaultArch = "rocket";
      defaultEnv = "space";
      defaultPrimary = "#E2E8F0";
      defaultAccent = "#F97316";
    } else if (/(circuit|electric|ohm|voltage|chip|cpu|computer|robot|microchip|battery)/i.test(hay)) {
      defaultArch = "circuit";
      defaultEnv = "lab";
      defaultPrimary = "#10B981";
      defaultAccent = "#38BDF8";
    } else if (/(atom|electron|proton|neutron|molecule|chemistry|periodic|quantum)/i.test(hay)) {
      defaultArch = "atom";
      defaultEnv = "lab";
      defaultPrimary = "#6366F1";
      defaultAccent = "#22D3EE";
    } else if (/(earth|globe|world|continent|geography|map|latitude|longitude)/i.test(hay)) {
      defaultArch = "earth";
      defaultEnv = "space";
      defaultPrimary = "#2563EB";
      defaultAccent = "#10B981";
    } else if (/(wave|sound|light|prism|optics|spectrum|rainbow|frequency|sine)/i.test(hay)) {
      defaultArch = "wave";
      defaultEnv = "studio";
      defaultPrimary = "#8B5CF6";
      defaultAccent = "#06B6D4";
    }

    const rawArch = String(obj.archetype || "").trim().toLowerCase();
    const rawEnv = String(obj.environment || "").trim().toLowerCase();
    const rawPrimary = String(obj.primaryColor || "").trim();
    const rawAccent = String(obj.accentColor || "").trim();

    const customParts = Array.isArray(obj.customParts)
      ? obj.customParts
          .slice(0, 12)
          .map((p) => {
            const part = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
            const shape = String(part.shape || "box").toLowerCase();
            const pos = Array.isArray(part.position) ? part.position : [0, 1, 0];
            const rot = Array.isArray(part.rotation) ? part.rotation : undefined;
            const scl = Array.isArray(part.scale) ? part.scale : [1, 1, 1];
            const anim = String(part.animate || "none").toLowerCase();
            return {
              shape: allowedShapes.has(shape) ? shape : "box",
              position: [
                Number(pos[0]) || 0,
                Number(pos[1]) || 1,
                Number(pos[2]) || 0,
              ] as [number, number, number],
              ...(rot
                ? {
                    rotation: [
                      Number(rot[0]) || 0,
                      Number(rot[1]) || 0,
                      Number(rot[2]) || 0,
                    ] as [number, number, number],
                  }
                : {}),
              scale: [
                Math.max(0.12, Math.min(3.5, Number(scl[0]) || 1)),
                Math.max(0.12, Math.min(3.5, Number(scl[1]) || 1)),
                Math.max(0.12, Math.min(3.5, Number(scl[2]) || 1)),
              ] as [number, number, number],
              color: /^#[0-9a-fA-F]{6}$/.test(String(part.color || ""))
                ? String(part.color)
                : defaultPrimary,
              metalness:
                typeof part.metalness === "number"
                  ? Math.max(0, Math.min(1, part.metalness))
                  : 0.35,
              roughness:
                typeof part.roughness === "number"
                  ? Math.max(0.05, Math.min(1, part.roughness))
                  : 0.4,
              ...(typeof part.emissive === "string" && /^#[0-9a-fA-F]{6}$/.test(part.emissive)
                ? { emissive: part.emissive }
                : {}),
              ...(typeof part.opacity === "number"
                ? { opacity: Math.max(0.2, Math.min(1, part.opacity)) }
                : {}),
              animate: allowedAnims.has(anim) ? anim : "none",
            };
          })
      : undefined;

    const archetype = allowedArchetypes.has(rawArch)
      ? rawArch === "custom" && (!customParts || customParts.length < 3)
        ? defaultArch
        : rawArch
      : defaultArch;

    return {
      archetype,
      environment: allowedEnvs.has(rawEnv) ? rawEnv : defaultEnv,
      primaryColor: /^#[0-9a-fA-F]{6}$/.test(rawPrimary) ? rawPrimary : defaultPrimary,
      accentColor: /^#[0-9a-fA-F]{6}$/.test(rawAccent) ? rawAccent : defaultAccent,
      title: title.slice(0, 90),
      subtitle: subject || "Interactive 3D Real Render",
      ...(customParts && customParts.length >= 3 ? { customParts } : {}),
    };
  }

  // 6a. Free 3D Real Image & Labeled Diagram Generator (+ Real Wikimedia Photos)
  app.post("/api/study/picture", async (req, res) => {
    try {
      const { prompt, profile, subject, language } = req.body as {
        prompt?: string;
        profile?: ProfilePayload;
        subject?: string;
        language?: string;
      };

      const cleanPrompt = prompt?.trim();
      if (!cleanPrompt) {
        return res
          .status(400)
          .json({ error: "Please describe the 3D picture or diagram you want." });
      }

      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );
      const diagramSystem =
        "You are Jogi Jarvis, an expert 3D studio director, textbook illustrator, and AI teacher. Design BOTH a realistic 3D PBR scene blueprint (scene3d) AND a crisp labeled 2D SVG diagram.";
      const diagramPrompt = [
        `Create a realistic 3D PBR scene blueprint AND a colorful textbook SVG diagram illustrating: "${cleanPrompt}".`,
        subject && subject !== "All Subjects" ? `Subject: ${subject}.` : "",
        profile?.grade ? `Student level: ${profile.grade}.` : "",
        "3D Scene Blueprint Requirements (scene3d):",
        "- Choose the best matching archetype from: solar, atom, dna, heart, plant, watercycle, rocket, circuit, earth, volcano, wave, architecture, custom.",
        "- If the subject is a specific real-world object, monument, vehicle, animal, molecule, or geometry NOT covered by the specialized archetypes above, set archetype to \"custom\" and design 6 to 10 composite PBR 3D parts in customParts (using shapes: sphere, box, cylinder, cone, torus, capsule, icosahedron, ring; positions in [-2.5,2.5] X/Z and [0.3,3.5] Y; varied metalness & roughness; vibrant realistic hex colors; animations: spin, orbit, pulse, float, none) that assemble into a recognizable 3D sculpture.",
        "- Choose environment: studio, space, outdoor, lab, or sunset.",
        "2D SVG Requirements:",
        "- Root element MUST be <svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 800 520\">.",
        "- Clean light background rectangle (#F8FAFC or soft gradient) with a crisp title banner at top, rich vector shapes, and well-spaced readable labels (font-family=\"sans-serif\", font-size 13-22px). No external URLs, scripts, or foreignObject.",
        "- Also provide a short English searchQuery (2-4 words) for Wikimedia Commons reference photos and a warm 2-3 sentence teacher explanation.",
        langRule,
      ]
        .filter(Boolean)
        .join("\n");

      const schemaHint =
        '{"title":"string","caption":"string","explanation":"string","searchQuery":"2-4 English keywords","svgCode":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 800 520\\">...</svg>","scene3d":{"archetype":"solar|atom|dna|heart|plant|watercycle|rocket|circuit|earth|volcano|wave|architecture|custom","environment":"studio|space|outdoor|lab|sunset","primaryColor":"#2563EB","accentColor":"#38BDF8","customParts":[{"shape":"sphere","position":[0,1.5,0],"scale":[1,1,1],"color":"#3B82F6","metalness":0.4,"roughness":0.3,"animate":"spin"}]}}';

      const diagramSchema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          caption: { type: Type.STRING },
          explanation: { type: Type.STRING },
          searchQuery: { type: Type.STRING },
          svgCode: { type: Type.STRING },
          scene3d: {
            type: Type.OBJECT,
            properties: {
              archetype: { type: Type.STRING },
              environment: { type: Type.STRING },
              primaryColor: { type: Type.STRING },
              accentColor: { type: Type.STRING },
              customParts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    shape: { type: Type.STRING },
                    position: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    rotation: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    scale: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    color: { type: Type.STRING },
                    metalness: { type: Type.NUMBER },
                    roughness: { type: Type.NUMBER },
                    emissive: { type: Type.STRING },
                    opacity: { type: Type.NUMBER },
                    animate: { type: Type.STRING },
                  },
                  required: ["shape", "position", "scale", "color"],
                },
              },
            },
            required: ["archetype", "environment", "primaryColor", "accentColor"],
          },
        },
        required: ["title", "caption", "explanation", "searchQuery", "svgCode", "scene3d"],
      };

      let generated: {
        title?: string;
        caption?: string;
        explanation?: string;
        searchQuery?: string;
        svgCode?: string;
        scene3d?: unknown;
      } = {};

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        generated = (await callFallbackPoolJson(
          diagramSystem,
          diagramPrompt,
          schemaHint
        )) as typeof generated;
      } else {
        try {
          const ai = getAiClient();
          const { response } = await generateGeminiTextWithFallback(
            ai,
            diagramPrompt,
            (model) => ({
              systemInstruction: diagramSystem,
              ...(model === "gemini-4-hydrogen"
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: "application/json",
              responseSchema: diagramSchema,
            })
          );
          generated = parseJsonFromText<typeof generated>(response.text || "{}");
        } catch (geminiErr) {
          if (hasAnyFallbackProvider()) {
            generated = (await callFallbackPoolJson(
              diagramSystem,
              diagramPrompt,
              schemaHint
            )) as typeof generated;
          } else {
            throw geminiErr;
          }
        }
      }

      const sanitizedSvg = sanitizeSvgMarkup(String(generated.svgCode || ""));
      const photoQuery =
        String(generated.searchQuery || "").trim() || cleanPrompt;
      const photos = await searchWikimediaPhotos(photoQuery);
      const resolvedTitle = String(generated.title || cleanPrompt).slice(0, 100);
      const scene3d = normalizeServerScene3d(
        generated.scene3d,
        resolvedTitle,
        subject
      );

      return res.json({
        reply:
          String(generated.explanation || "").trim() ||
          `Here is an interactive 3D real render, labeled diagram, and reference pictures for **${cleanPrompt}**.`,
        diagram: {
          title: resolvedTitle,
          caption: String(
            generated.caption || "Interactive 3D Real Render & Study Illustration"
          ).slice(0, 160),
          svgCode:
            sanitizedSvg ||
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520"><rect width="800" height="520" fill="#F8FAFC"/><text x="400" y="260" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="700" fill="#0F172A">${resolvedTitle.replace(/[<>&"']/g, "")}</text></svg>`,
          scene3d,
        },
        photos,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 6b. Free 3D Real Animated Narrated Study Video Generator (+ Educational Video Links)
  app.post("/api/study/video", async (req, res) => {
    try {
      const { prompt, profile, subject, language } = req.body as {
        prompt?: string;
        profile?: ProfilePayload;
        subject?: string;
        language?: string;
      };

      const cleanPrompt = prompt?.trim();
      if (!cleanPrompt) {
        return res
          .status(400)
          .json({ error: "Please enter a topic for the 3D video." });
      }

      const activeLang = language || profile?.preferredLanguage || "Auto-Detect";
      const langRule = buildLanguageGuidance(activeLang);
      const videoSystem =
        "You are Jogi Jarvis, a warm, patient classroom teacher creating slow, easy-to-understand 5-step physical 3D explainer videos for students. Always use plain everyday words, short clear sentences, and real-world analogies so even a beginner understands effortlessly.";
      const videoPrompt = [
        `Design a slow, simple, easy-to-understand 5-step physical 3D explainer video about: "${cleanPrompt}".`,
        subject && subject !== "All Subjects" ? `Subject: ${subject}.` : "",
        profile?.grade ? `Student level: ${profile.grade}.` : "",
        "Teaching Method (STRICT — follow this exact 5-step classroom flow):",
        "1. Step 1 (What Is It?): Explain what the topic is in simple everyday words using a friendly analogy ('Think of it like...' or 'Imagine...').",
        "2. Step 2 (Look at the Main Parts): Point clearly to the 2-3 main physical parts the student sees on the 3D model and explain what each part does.",
        "3. Step 3 (How It Works Step by Step): Explain the action slowly in order using 'First... Then... Finally...'.",
        "4. Step 4 (Real-Life Example): Give one familiar example from daily life that makes the concept click.",
        "5. Step 5 (Easy Way to Remember): Give one simple memory trick or takeaway sentence.",
        "Formatting Requirements:",
        "- For each of the 5 scenes, provide: heading (short, <= 6 words), narration (calm spoken teacher explanation in plain everyday language, 18-28 words, no jargon without explaining it), keyFact (1 simple takeaway <= 85 chars), bulletPoints (2-3 very short plain-language points <= 60 chars each), visualAccent (one of: sun, atom, globe, wave, chart, book, leaf, rocket, circuit, heart), durationSec (9 to 11).",
        "- Choose a clean hex themeColor (e.g. #2563EB, #059669, #0284C7, #EA580C, #7C3AED).",
        "- Design a realistic physical 3D model in scene3d (archetype: solar, atom, dna, heart, plant, watercycle, rocket, circuit, earth, volcano, wave, architecture, or custom with 6-10 physical customParts; environment: studio, space, outdoor, lab, or sunset).",
        "- Also include a friendly 2-sentence written summary in replyText and a clean 2-4 word English searchTopic for related study video links.",
        langRule,
      ]
        .filter(Boolean)
        .join("\n");

      const schemaHint =
        '{"title":"string","subtitle":"string","themeColor":"#2563EB","replyText":"string","searchTopic":"string","scene3d":{"archetype":"solar|atom|dna|heart|plant|watercycle|rocket|circuit|earth|volcano|wave|architecture|custom","environment":"studio|space|outdoor|lab|sunset","primaryColor":"#2563EB","accentColor":"#38BDF8"},"scenes":[{"heading":"string","narration":"string","keyFact":"string","visualAccent":"atom","bulletPoints":["string"],"durationSec":10}]}';

      const videoSchema = {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          subtitle: { type: Type.STRING },
          themeColor: { type: Type.STRING },
          replyText: { type: Type.STRING },
          searchTopic: { type: Type.STRING },
          scene3d: {
            type: Type.OBJECT,
            properties: {
              archetype: { type: Type.STRING },
              environment: { type: Type.STRING },
              primaryColor: { type: Type.STRING },
              accentColor: { type: Type.STRING },
              customParts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    shape: { type: Type.STRING },
                    position: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    rotation: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    scale: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    color: { type: Type.STRING },
                    metalness: { type: Type.NUMBER },
                    roughness: { type: Type.NUMBER },
                    emissive: { type: Type.STRING },
                    opacity: { type: Type.NUMBER },
                    animate: { type: Type.STRING },
                  },
                  required: ["shape", "position", "scale", "color"],
                },
              },
            },
            required: ["archetype", "environment", "primaryColor", "accentColor"],
          },
          scenes: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING },
                narration: { type: Type.STRING },
                keyFact: { type: Type.STRING },
                visualAccent: { type: Type.STRING },
                bulletPoints: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                durationSec: { type: Type.INTEGER },
              },
              required: [
                "heading",
                "narration",
                "keyFact",
                "visualAccent",
                "bulletPoints",
                "durationSec",
              ],
            },
          },
        },
        required: [
          "title",
          "subtitle",
          "themeColor",
          "replyText",
          "searchTopic",
          "scene3d",
          "scenes",
        ],
      };

      let generated: {
        title?: string;
        subtitle?: string;
        themeColor?: string;
        replyText?: string;
        searchTopic?: string;
        scene3d?: unknown;
        scenes?: Array<{
          heading?: string;
          narration?: string;
          keyFact?: string;
          visualAccent?: string;
          bulletPoints?: string[];
          durationSec?: number;
        }>;
      } = {};

      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        generated = (await callFallbackPoolJson(
          videoSystem,
          videoPrompt,
          schemaHint
        )) as typeof generated;
      } else {
        try {
          const ai = getAiClient();
          const { response } = await generateGeminiTextWithFallback(
            ai,
            videoPrompt,
            (model) => ({
              systemInstruction: videoSystem,
              ...(model === "gemini-4-hydrogen"
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: "application/json",
              responseSchema: videoSchema,
            })
          );
          generated = parseJsonFromText<typeof generated>(response.text || "{}");
        } catch (geminiErr) {
          if (hasAnyFallbackProvider()) {
            generated = (await callFallbackPoolJson(
              videoSystem,
              videoPrompt,
              schemaHint
            )) as typeof generated;
          } else {
            throw geminiErr;
          }
        }
      }

      const allowedAccents = new Set([
        "sun",
        "atom",
        "globe",
        "wave",
        "chart",
        "book",
        "leaf",
        "rocket",
        "circuit",
        "heart",
      ]);

      const normalizedScenes = (Array.isArray(generated.scenes) ? generated.scenes : [])
        .slice(0, 6)
        .map((sc, idx) => ({
          heading: String(sc?.heading || `Step ${idx + 1}`).slice(0, 80),
          narration: String(sc?.narration || "").slice(0, 280),
          keyFact: String(sc?.keyFact || "").slice(0, 120),
          visualAccent: (allowedAccents.has(String(sc?.visualAccent || ""))
            ? String(sc?.visualAccent)
            : "book") as
            | "sun"
            | "atom"
            | "globe"
            | "wave"
            | "chart"
            | "book"
            | "leaf"
            | "rocket"
            | "circuit"
            | "heart",
          bulletPoints: Array.isArray(sc?.bulletPoints)
            ? sc.bulletPoints.slice(0, 3).map((b) => String(b).slice(0, 110))
            : [],
          durationSec: Math.max(8, Math.min(12, Number(sc?.durationSec) || 10)),
        }));

      const resolvedTitle = String(generated.title || cleanPrompt).slice(0, 90);
      const themeColor = /^#[0-9a-fA-F]{6}$/.test(String(generated.themeColor || ""))
        ? String(generated.themeColor)
        : "#2563EB";
      const scene3d = normalizeServerScene3d(
        generated.scene3d,
        resolvedTitle,
        subject,
        themeColor
      );

      const searchTopic =
        String(generated.searchTopic || "").trim() || cleanPrompt;
      const videoLinks = buildStudyVideoLinks(searchTopic, subject);

      return res.json({
        reply:
          String(generated.replyText || "").trim() ||
          `I created a calm ${normalizedScenes.length}-step physical 3D lesson for **${cleanPrompt}**. Press **Play Lesson** to watch at an easy student pace, or turn on **Step-by-Step** to pause after every step.`,
        storyboard: {
          title: resolvedTitle,
          subtitle: String(generated.subtitle || "Physical 3D Step-by-Step Lesson").slice(
            0,
            120
          ),
          subject: subject || "General",
          language: activeLang,
          themeColor,
          scenes: normalizedScenes,
          scene3d,
        },
        videoLinks,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 6c. Free Live Study Web Search (+ Real Educational Photos + Related Video Links)
  app.post("/api/study/search", async (req, res) => {
    try {
      const { query, profile, subject, language } = req.body as {
        query?: string;
        profile?: ProfilePayload;
        subject?: string;
        language?: string;
      };

      const cleanQuery = query?.trim();
      if (!cleanQuery) {
        return res.status(400).json({ error: "Please enter a topic to search." });
      }

      const langRule = buildLanguageGuidance(
        language || profile?.preferredLanguage
      );
      const searchSystem = [
        buildSystemInstruction(profile, subject, "chat", language),
        `LIVE WEB SEARCH MODE (Current UTC: ${new Date().toUTCString()}): Use Google Search to gather accurate, up-to-date study facts, definitions, dates, and clear explanations. Structure the answer cleanly with key bullet points.`,
        langRule,
      ].join("\n\n");

      const [photos, searchResult] = await Promise.all([
        searchWikimediaPhotos(cleanQuery),
        (async () => {
          if (!hasGeminiKey() && hasAnyFallbackProvider()) {
            const fallback = await callFallbackPoolChat([
              { role: "system", content: searchSystem },
              { role: "user", content: cleanQuery },
            ]);
            return { reply: fallback.text, sources: [] as Array<{ uri: string; title: string }> };
          }
          try {
            const ai = getAiClient();
            const { response } = await generateGeminiTextWithFallback(
              ai,
              cleanQuery,
              (model) => ({
                systemInstruction: searchSystem,
                ...(model === "gemini-4-hydrogen"
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                  : {}),
                tools: [{ googleSearch: {} }],
              })
            );
            const chunks =
              response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
            const sources = chunks
              .map((chunk) => {
                const web = (chunk as { web?: { uri?: string; title?: string } }).web;
                return web?.uri ? { uri: web.uri, title: web.title || web.uri } : null;
              })
              .filter((s): s is { uri: string; title: string } => s !== null);
            const uniqueSources = Array.from(
              new Map(sources.map((s) => [s.uri, s])).values()
            ).slice(0, 6);
            return {
              reply: response.text?.trim() || "Here is what I found on that topic.",
              sources: uniqueSources,
            };
          } catch (geminiErr) {
            if (hasAnyFallbackProvider()) {
              const fallback = await callFallbackPoolChat([
                { role: "system", content: searchSystem },
                { role: "user", content: cleanQuery },
              ]);
              return { reply: fallback.text, sources: [] as Array<{ uri: string; title: string }> };
            }
            throw geminiErr;
          }
        })(),
      ]);

      return res.json({
        reply: searchResult.reply,
        sources: searchResult.sources,
        photos,
        videoLinks: buildStudyVideoLinks(cleanQuery, subject),
      });
    } catch (err) {
      const formatted = formatApiError(err);
      return res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Create HTTP server so we can attach WebSocket for Gemini Live API (/api/live)
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`
      );
      if (url.pathname === "/api/live" || url.pathname === "/api/live/") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (clientWs: WebSocket) => {
    let liveSession: Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null = null;
    let isClosing = false;

    const heartbeat = setInterval(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.ping();
        } catch {
          // ignore
        }
      }
    }, 20000);

    const sendSafe = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    clientWs.on("message", async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type?: string;
          mode?: "assistant" | "interpreter";
          audio?: string;
          text?: string;
          profile?: ProfilePayload;
          subject?: string;
          voiceName?: string;
          language?: string;
          myLanguage?: string;
          otherLanguage?: string;
          sameLanguageReply?: boolean;
        };

        if (msg.type === "start") {
          if (liveSession) {
            try {
              liveSession.close();
            } catch {
              // ignore
            }
            liveSession = null;
          }

          const ai = getLiveAiClient();
          const allowedVoices = new Set(["Puck", "Charon", "Kore", "Fenrir", "Zephyr"]);
          const safeVoice =
            msg.voiceName && allowedVoices.has(msg.voiceName)
              ? msg.voiceName
              : msg.profile?.voiceName && allowedVoices.has(msg.profile.voiceName)
                ? msg.profile.voiceName
                : "Zephyr";

          const isInterpreter = msg.mode === "interpreter";
          let systemInstruction = "";

          if (isInterpreter) {
            const myLang = (msg.myLanguage || "English").trim() || "English";
            const otherLang = (msg.otherLanguage || "Auto-Detect").trim() || "Auto-Detect";
            const isSameLang =
              Boolean(msg.sameLanguageReply) ||
              (otherLang.toLowerCase() !== "auto-detect" &&
                myLang.toLowerCase() === otherLang.toLowerCase());

            if (isSameLang) {
              systemInstruction = [
                `You are Jogi Jarvis, a warm, fast, real-time human voice companion speaking in ${myLang}.`,
                `Listen naturally and respond warmly, clearly, and concisely in ${myLang} (2 to 3 natural spoken sentences).`,
                `Never read markdown symbols aloud.`,
              ].join(" ");
            } else {
              const otherDesc =
                otherLang.toLowerCase() === "auto-detect"
                  ? `ANY language the other speaker uses (automatically detect their exact language and remember it throughout this conversation!)`
                  : otherLang;

              systemInstruction = [
                `You are Jogi Jarvis, an ultra-fast, zero-delay live face-to-face human interpreter.`,
                `The user's language is ${myLang}. The other person's language is ${otherDesc}.`,
                `STRICT INSTANT TWO-WAY RULES:`,
                `1. WHEN THE OTHER PERSON SPEAKS (in ${otherLang.toLowerCase() === "auto-detect" ? `any language other than ${myLang}` : otherLang}):`,
                `   - Immediately lock and remember the EXACT language they just spoke.`,
                `   - INSTANTLY explain clearly and naturally to the user in ${myLang} what they just said or asked.`,
                `   - Be ultra-brisk and direct: DO NOT say "The person said..." and DO NOT add "What would you like to reply?" at the end — finish fast so the user can answer immediately.`,
                `2. WHEN THE USER SPEAKS (in ${myLang}):`,
                `   - INSTANTLY translate and speak DIRECTLY to the other person in ${otherLang.toLowerCase() === "auto-detect" ? "the EXACT SAME LANGUAGE the other person just spoke (or another language only if the user explicitly names one)" : otherLang}.`,
                `   - Strip any meta-commands like "tell them...", "say to them...", or "answer them..." and speak the actual polite message directly in the other person's exact language.`,
                `   - ZERO extra chatter, ZERO preamble, ZERO markdown.`,
                `3. SPEED: Respond immediately in crisp, natural spoken sentences so a real face-to-face conversation feels effortless and fast.`,
              ].join(" ");
            }
          } else {
            const baseLiveSystemInstruction = buildSystemInstruction(
              msg.profile,
              msg.subject,
              "live",
              msg.language
            );
            systemInstruction = `${baseLiveSystemInstruction}\n\nLIVE WEB ACCESS (UTC ${new Date().toUTCString()}): You have Google Search enabled for real-time news, sports scores, weather, and current facts. Use it whenever asked about today's events, live matches, or up-to-date information.`;
          }

          const liveCallbacks = {
            onopen: () => {
              // Wait until ai.live.connect resolves (setupComplete) before notifying client
            },
            onmessage: (message: LiveServerMessage) => {
              const content = message.serverContent;
              if (!content) return;

              if (content.interrupted) {
                sendSafe({ type: "interrupted" });
              }

              if (content.inputTranscription?.text) {
                sendSafe({
                  type: "inputTranscript",
                  text: content.inputTranscription.text,
                });
              }

              if (content.outputTranscription?.text) {
                sendSafe({
                  type: "outputTranscript",
                  text: content.outputTranscription.text,
                });
              }

              for (const part of content.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                  sendSafe({
                    type: "audio",
                    audio: part.inlineData.data,
                  });
                }
              }

              if (content.turnComplete) {
                sendSafe({ type: "turnComplete" });
              }
            },
            onerror: (e: unknown) => {
              const ev = e as {
                message?: string;
                error?: { message?: string };
              };
              const rawErr =
                e instanceof Error
                  ? e.message
                  : ev?.error?.message ||
                    ev?.message ||
                    "Live voice connection encountered an error.";
              console.error("[Live API error]", rawErr, e);
              const formatted = formatApiError(new Error(rawErr));
              sendSafe({ type: "error", message: formatted.message });
            },
            onclose: (closeEv: unknown) => {
              const ev = closeEv as { code?: number; reason?: string };
              if (ev?.reason) {
                console.error("[Live API close]", ev.code, ev.reason);
              }
              if (!isClosing) {
                if (ev?.code && ev.code !== 1000 && ev.reason) {
                  sendSafe({
                    type: "error",
                    message: `Live voice closed (${ev.code}): ${ev.reason}`,
                  });
                } else {
                  sendSafe({ type: "closed" });
                }
              }
            },
          };

          const baseLiveConfig = {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: safeVoice },
              },
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction,
          };

          if (isInterpreter) {
            liveSession = await ai.live.connect({
              model: "gemini-3.8-live",
              config: baseLiveConfig,
              callbacks: liveCallbacks,
            });
          } else {
            try {
              liveSession = await ai.live.connect({
                model: "gemini-3.8-live",
                config: {
                  ...baseLiveConfig,
                  tools: [{ googleSearch: {} }],
                },
                callbacks: liveCallbacks,
              });
            } catch (liveWithSearchErr) {
              console.warn(
                "[Live API] Retrying without googleSearch tool:",
                liveWithSearchErr instanceof Error
                  ? liveWithSearchErr.message
                  : liveWithSearchErr
              );
              liveSession = await ai.live.connect({
                model: "gemini-3.8-live",
                config: baseLiveConfig,
                callbacks: liveCallbacks,
              });
            }
          }

          // Session is now assigned and setupComplete has finished
          sendSafe({ type: "ready", voiceName: safeVoice });
          return;
        }

        if (msg.type === "update_languages" && liveSession) {
          const myLang = (msg.myLanguage || "English").trim() || "English";
          const otherLang = (msg.otherLanguage || "Auto-Detect").trim() || "Auto-Detect";
          const sameMode = Boolean(msg.sameLanguageReply);
          liveSession.sendRealtimeInput({
            text: sameMode
              ? `[INTERPRETER SETTINGS UPDATED: Switch immediately to same-language conversation in ${myLang}. Stay quiet until someone speaks.]`
              : `[INTERPRETER SETTINGS UPDATED: User's language is now ${myLang}, other person's language is now ${otherLang}. Apply immediately on the next spoken turn; stay quiet until someone speaks.]`,
          });
          return;
        }

        if (msg.type === "speaker_hint" && liveSession) {
          const hint = msg as unknown as {
            side?: "them" | "me" | "auto";
            myLanguage?: string;
            partnerLanguage?: string;
          };
          const myLang = (hint.myLanguage || "English").trim() || "English";
          const partner = (hint.partnerLanguage || "their exact spoken language").trim();
          const instruction =
            hint.side === "them"
              ? `[NEXT SPEAKER IS THE OTHER PERSON: Listen to them, remember their exact language, and immediately explain what they say to the user in ${myLang} with zero filler. Stay silent until they speak.]`
              : hint.side === "me"
                ? `[NEXT SPEAKER IS THE USER (${myLang}): Immediately translate what the user says directly into ${partner} for the other person with zero filler. Stay silent until the user speaks.]`
                : `[AUTO TWO-WAY MODE: Automatically detect who speaks — explain other person in ${myLang}, translate user into ${partner}. Stay silent until someone speaks.]`;
          liveSession.sendRealtimeInput({ text: instruction });
          return;
        }

        if (msg.type === "audio" && msg.audio && liveSession) {
          liveSession.sendRealtimeInput({
            audio: {
              data: msg.audio,
              mimeType: "audio/pcm;rate=16000",
            },
          });
          return;
        }

        if (msg.type === "text" && msg.text && liveSession) {
          liveSession.sendRealtimeInput({
            text: msg.text,
          });
          return;
        }

        if (msg.type === "stop" && liveSession) {
          liveSession.close();
          liveSession = null;
          sendSafe({ type: "closed" });
        }
      } catch (err) {
        const formatted = formatApiError(err);
        sendSafe({ type: "error", message: formatted.message });
      }
    });

    clientWs.on("close", () => {
      isClosing = true;
      clearInterval(heartbeat);
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          // ignore
        }
        liveSession = null;
      }
    });
  });

  // Mount Vite middleware in development or static dist in production
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import("vite");
    const hmrDisabled = process.env.DISABLE_HMR === "true";
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: !hmrDisabled,
        watch: hmrDisabled ? null : {},
        ws: {
          server,
          path: "/__vite_hmr",
        },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(
      express.static(distDir, {
        setHeaders: (res, filePath) => {
          if (
            filePath.endsWith("sw.js") ||
            filePath.endsWith("registerSW.js") ||
            filePath.endsWith("manifest.webmanifest")
          ) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      })
    );
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Jogi Jarvis server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start Jogi Jarvis server:", err);
  process.exit(1);
});
