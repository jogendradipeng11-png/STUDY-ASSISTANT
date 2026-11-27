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

// 12 verified NVIDIA NIM chat models (all usable under a single NVIDIA_API_KEY)
const NVIDIA_FAST_FALLBACKS = [
  "google/gemma-3-12b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "meta/llama-3.3-70b-instruct",
  "google/gemma-3-27b-it",
  "qwen/qwen2.5-72b-instruct",
  "meta/llama-3.1-70b-instruct",
  "mistralai/mistral-large-2-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "meta/llama-3.1-8b-instruct",
  "mistralai/mixtral-8x22b-instruct-v0.1",
  "nvidia/nemotron-3.5-bolt-e4b",
  "z-ai/glm-5.3-flash",
];

// 12 math/reasoning-prioritized NVIDIA NIM models
const NVIDIA_MATH_FALLBACKS = [
  "qwen/qwen2.5-72b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "meta/llama-3.3-70b-instruct",
  "google/gemma-3-27b-it",
  "qwen/qwen2.5-coder-32b-instruct",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "mistralai/mistral-large-2-instruct",
  "google/gemma-3-12b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
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
  const cleaned = messages.map((m) => ({
    role: m.role,
    content: normalizePromptText(m.content),
  }));

  // Gemma chat templates work most reliably when system instructions are folded into the first user turn
  if (/gemma/i.test(model)) {
    const systemParts = cleaned
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const nonSystem = cleaned.filter((m) => m.role !== "system");
    if (systemParts && nonSystem.length > 0 && nonSystem[0].role === "user") {
      nonSystem[0] = {
        role: "user",
        content: `Instructions:\n${systemParts}\n\nUser Request:\n${nonSystem[0].content}`,
      };
      return nonSystem;
    }
    if (systemParts) {
      return [{ role: "user", content: systemParts }, ...nonSystem];
    }
    return nonSystem;
  }

  return cleaned;
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

  // Prevent reasoning-capable Nemotron models on NVIDIA NIM from exhausting max_tokens in hidden thinking
  if (
    candidate.provider === "nvidia" &&
    speedMode === "fast" &&
    /nemotron/i.test(candidate.model)
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
    signal: AbortSignal.timeout(candidate.provider === "local" ? 45000 : 22000),
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
          ? " at a slow, extra-clear, word-by-word student learning pace with gentle pauses"
          : readingStyle === "explain"
            ? " like a warm classroom teacher explaining clearly to a student"
            : "";

      const style = conversational
        ? role === "student"
          ? `Warm, expressive, lifelike human mentor speaking naturally face-to-face with genuine warmth, natural breathing rhythm, friendly intonation, and clear pacing${langCue}${paceCue}`
          : `Warm, natural, lifelike human companion speaking conversationally like a trusted family member, with genuine human inflection, relaxed natural pauses, and effortless clarity${langCue}${paceCue}`
        : role === "student"
          ? `Warm, patient, encouraging personal teacher${langCue}${paceCue}`
          : `Calm, articulate, helpful personal assistant${langCue}${paceCue}`;

      const ai = getAiClient();
      const ttsModels = orderByCooldown(
        ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"],
        (model) => ({ provider: "gemini-tts", model })
      );

      let audioBase64: string | undefined;
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
          const data =
            response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (data) {
            audioBase64 = data;
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

      return res.json({
        audioBase64,
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

  // 3c. Live Voice & Face-to-Face Human Interpreter Endpoint (Any Language / Any Country + Same-Language Reply Mode)
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

      let spokenText = (text || "").trim();

      // Step 1: Transcribe live voice audio accurately across ANY language/country
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
            text: "Automatically detect the exact spoken language (any world language, regional Indian language, or dialect) and transcribe this audio faithfully in its natural native script without translating. Return ONLY the clean spoken transcript. If there is only silence, breathing, or background noise with no intelligible speech, return an empty string.",
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

      const contextLines = Array.isArray(recentContext)
        ? recentContext
            .slice(-5)
            .map(
              (c, i) =>
                `Turn ${i + 1}: "${(c.originalText || "").slice(0, 160)}" -> "${(c.translatedText || "").slice(0, 160)}"`
            )
            .join("\n")
        : "";

      const systemInstruction =
        "You are Jogi Jarvis, an elite real-time human interpreter sitting right next to the user, supporting every country and language on Earth (including English, Odia, Hindi, Tamil, Telugu, Bengali, Marathi, Arabic, Spanish, French, German, Chinese, Japanese, Korean, Russian, Thai, Swahili, and all regional dialects). Work strictly like a fast, warm, intelligent human interpreter—never robotic or stiff.";

      let taskInstructions = "";
      if (useSameLangReply) {
        taskInstructions = [
          `SAME-LANGUAGE CONVERSATION MODE: Both sides are speaking ${cleanMyLang}.`,
          `1. Detect the spoken language (detectedLanguage).`,
          `2. Set targetLanguage to "${cleanMyLang}".`,
          `3. Write a warm, natural, helpful conversational reply in ${cleanMyLang} inside translatedText (2 to 3 concise spoken sentences ready to speak aloud).`,
          `4. Set speakerSide to "${direction === "them_to_me" ? "them" : "me"}".`,
          `5. Provide 2 short natural follow-up phrases in ${cleanMyLang} inside suggestedReplies.`,
          `6. Leave pronunciation as "".`,
        ].join("\n");
      } else if (direction === "listen_any") {
        taskInstructions = [
          `HUMAN INTERPRETER LISTEN & EXPLAIN MODE: Auto-detect whatever language was spoken and explain it naturally and clearly to the user in ${cleanMyLang}.`,
          `1. Identify the exact spoken language in detectedLanguage.`,
          `2. Set targetLanguage to "${cleanMyLang}".`,
          `3. Explain what was just said/asked naturally and clearly in ${cleanMyLang} inside translatedText, then briefly ask in ${cleanMyLang} how the user wants to reply (e.g. "What would you like to reply?").`,
          `4. Set speakerSide to "them".`,
          `5. Provide 2 short reply options in ${cleanMyLang} inside suggestedReplies.`,
          `6. Leave pronunciation as "".`,
        ].join("\n");
      } else if (direction === "me_to_them") {
        const destLang = effectivePartnerLang || "Hindi";
        taskInstructions = [
          `HUMAN INTERPRETER (USER -> SPEAKER): The user is speaking in ${cleanMyLang} and wants you to speak directly to the other person in ${destLang} (or another language if the user explicitly named one like "tell them in Arabic").`,
          `1. Identify the spoken language in detectedLanguage.`,
          `2. Set targetLanguage to the language explicitly named by the user, or "${destLang}" if none named.`,
          `3. Strip any meta-commands like "tell them", "answer them in their language", or "say to them", and speak the actual message politely, warmly, and directly to the other person in targetLanguage inside translatedText.`,
          `4. Set speakerSide to "me".`,
          `5. Provide 2 short follow-up phrases in ${cleanMyLang} inside suggestedReplies.`,
          `6. If targetLanguage uses a non-Latin script, put an easy Latin pronunciation hint in pronunciation; otherwise "".`,
        ].join("\n");
      } else if (direction === "them_to_me") {
        taskInstructions = [
          `HUMAN INTERPRETER (SPEAKER -> USER): The other person is speaking in ${effectivePartnerLang || "another language"} and the user understands ${cleanMyLang}.`,
          `1. Identify the exact spoken language in detectedLanguage.`,
          `2. Set targetLanguage to "${cleanMyLang}".`,
          `3. Explain clearly and naturally in ${cleanMyLang} what they just said or asked inside translatedText, and end with a brief natural prompt asking how the user wants to respond.`,
          `4. Set speakerSide to "them".`,
          `5. Provide 2 short helpful reply suggestions in ${cleanMyLang} inside suggestedReplies.`,
          `6. Leave pronunciation as "".`,
        ].join("\n");
      } else {
        const partnerHint = effectivePartnerLang
          ? `The other speaker's language is currently "${effectivePartnerLang}".`
          : `The other speaker's language is Auto-Detect (any world language other than ${cleanMyLang}).`;
        taskInstructions = [
          `LIVE TO-AND-FRO HUMAN INTERPRETER MODE: User's language is "${cleanMyLang}". ${partnerHint}`,
          `1. Detect the exact spoken language in detectedLanguage.`,
          `2. CASE A — The speaker spoke in ANY language DIFFERENT from ${cleanMyLang}:`,
          `   - Set speakerSide = "them", targetLanguage = "${cleanMyLang}".`,
          `   - Explain quickly, clearly, and naturally in ${cleanMyLang} what they just said or asked (like a human interpreter right beside the user), and briefly ask what the user wants to answer back (e.g. "How would you like to reply?").`,
          `3. CASE B — The user spoke in ${cleanMyLang}:`,
          `   - Check if they named a language (e.g. "answer in Arabic", "tell them in Spanish") OR want to reply to the other speaker (${effectivePartnerLang || "last detected speaker language"}).`,
          `   - If a target language is named OR ${effectivePartnerLang ? `"${effectivePartnerLang}" is known` : "a partner language exists from recent conversation context"}: set speakerSide = "me", set targetLanguage to that partner/named language, strip meta-instructions like "tell them" or "answer in their language", and put the natural, polite direct response spoken to the other person inside translatedText.`,
          `   - Otherwise (if nobody else has spoken yet and no target language was named): set speakerSide = "me", targetLanguage = "${cleanMyLang}", and answer warmly in ${cleanMyLang}.`,
          `4. Provide 2 short natural reply suggestions in ${cleanMyLang} inside suggestedReplies.`,
          `5. If targetLanguage uses a non-Latin script and differs from ${cleanMyLang}, include an easy Latin pronunciation guide in pronunciation; otherwise "".`,
        ].join("\n");
      }

      const userPrompt = [
        taskInstructions,
        contextLines ? `\nRecent conversation context:\n${contextLines}` : "",
        `\nSpoken input to process:\n"${spokenText}"`,
      ]
        .filter(Boolean)
        .join("\n");

      const schemaHint =
        '{"detectedLanguage":"string","targetLanguage":"string","translatedText":"string","pronunciation":"string","speakerSide":"me|them","suggestedReplies":["string","string"]}';

      const responseSchema = {
        type: Type.OBJECT,
        properties: {
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
        detectedLanguage?: string;
        targetLanguage?: string;
        translatedText?: string;
        pronunciation?: string;
        speakerSide?: string;
        suggestedReplies?: string[];
      };

      let parsed: TranslationResult;
      if (!hasGeminiKey() && hasAnyFallbackProvider()) {
        parsed = await callFallbackPoolJson<TranslationResult>(
          systemInstruction,
          userPrompt,
          schemaHint
        );
      } else {
        try {
          const ai = getAiClient();
          const { response } = await generateGeminiTextWithFallback(
            ai,
            userPrompt,
            (model) => ({
              systemInstruction,
              ...(model === "gemini-4-hydrogen"
                ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                : {}),
              responseMimeType: "application/json",
              responseSchema,
            })
          );
          parsed = parseJsonFromText<TranslationResult>(response.text || "{}");
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

      const safeSide = parsed.speakerSide === "them" ? "them" : "me";
      const safeTarget =
        (parsed.targetLanguage || "").trim() ||
        (safeSide === "me" ? cleanOtherLang : cleanMyLang);

      return res.json({
        originalText: spokenText,
        detectedLanguage: (parsed.detectedLanguage || cleanMyLang).trim(),
        targetLanguage: safeTarget,
        translatedText: (parsed.translatedText || spokenText).trim(),
        pronunciation: (parsed.pronunciation || "").trim(),
        speakerSide: safeSide,
        suggestedReplies: Array.isArray(parsed.suggestedReplies)
          ? parsed.suggestedReplies
              .filter((r): r is string => typeof r === "string" && Boolean(r.trim()))
              .slice(0, 3)
          : [],
        modeUsed: useSameLangReply ? "same_language_reply" : "translate",
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
                `You are Jogi Jarvis, an ultra-fast, warm, real-time human interpreter helping the user have a smooth, live to-and-fro face-to-face conversation.`,
                `The user's preferred language is ${myLang}. The other speaker's language is ${otherDesc}.`,
                `FOLLOW THIS EXACT TO-AND-FRO HUMAN INTERPRETER WORKFLOW:`,
                `1. WHEN THE OTHER PERSON SPEAKS (in ${otherLang.toLowerCase() === "auto-detect" ? `any language other than ${myLang}` : otherLang}):`,
                `   - Immediately remember the exact language they spoke.`,
                `   - Speak FAST, clearly, and naturally to the user in ${myLang}, explaining what the person just said or asked like a real human interpreter sitting right beside the user (concise and crystal clear, never stiff or robotic).`,
                `   - End with a very short natural prompt in ${myLang} like "What would you like to reply?" so the user can immediately answer back.`,
                `2. WHEN THE USER SPEAKS BACK (in ${myLang}):`,
                `   - Convert their answer immediately and speak DIRECTLY to the other person in ${otherLang.toLowerCase() === "auto-detect" ? "the exact language the other person just spoke (or any language the user explicitly requests, like 'answer in Arabic' or 'tell them in Hindi')" : otherLang}.`,
                `   - CRITICAL: If the user says meta-instructions like "tell them...", "answer them in their language...", "reply to them...", or "say that...", DO NOT translate those meta-words—speak the actual polite, natural human reply directly to the other person in their language!`,
                `   - If the user asks you to answer the other person's question on their behalf in their language, give a polite, accurate answer directly in the other person's language.`,
                `   - If nobody else has spoken yet and the user speaks in ${myLang} with Auto-Detect active (without naming a target language), reply briefly in ${myLang} letting them know you are listening and ready to interpret any voice, or ask which language they want to speak in.`,
                `3. SPEED & NATURAL HUMAN TONE: Keep every interpretation brisk, clear, polite, and lifelike like a professional human interpreter. Never output markdown, asterisks, or brackets.`,
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
              ? `[INTERPRETER SETTINGS UPDATED: Switch immediately to same-language conversation in ${myLang}. Reply briefly only if spoken to next; do not speak right now.]`
              : `[INTERPRETER SETTINGS UPDATED: User's language is now ${myLang}, other speaker's language is now ${otherLang}. Apply immediately on the next spoken turn; stay quiet until someone speaks.]`,
          });
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
