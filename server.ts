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

const NVIDIA_FAST_FALLBACKS = [
  "google/gemma-3-12b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "meta/llama-3.3-70b-instruct",
  "nvidia/nemotron-3.5-bolt-e4b",
  "z-ai/glm-5.3-flash",
];

const NVIDIA_MATH_FALLBACKS = [
  "google/gemma-3-12b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "meta/llama-3.3-70b-instruct",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  "nvidia/nemotron-3.5-bolt-e4b",
];

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

function getNvidiaCandidateModels(speedMode: "fast" | "detailed" = "fast"): string[] {
  const envCustom =
    speedMode === "detailed"
      ? [process.env.NVIDIA_MATH_MODEL?.trim(), process.env.NVIDIA_MODEL?.trim()]
      : [process.env.NVIDIA_MODEL?.trim()];

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
  const cleaned = raw
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

function isUnavailableNvidiaModelStatus(status: number): boolean {
  return status === 404 || status === 410 || status === 422;
}

function normalizePromptText(text: string): string {
  return text.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ");
}

function formatNvidiaMessagesForModel(
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const cleaned = messages.map((m) => ({
    role: m.role,
    content: normalizePromptText(m.content),
  }));

  // Gemma chat templates work most reliably when system instructions are folded into the first user turn
  if (/^google\/gemma/i.test(model)) {
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

function buildNvidiaRequestBody(
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed",
  stream: boolean,
  options?: { temperature?: number; maxTokens?: number }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: formatNvidiaMessagesForModel(model, messages),
    temperature: options?.temperature ?? 0.35,
    max_tokens: options?.maxTokens ?? 4096,
    stream,
  };

  // Prevent reasoning-capable Nemotron models from exhausting max_tokens in hidden thinking
  if (speedMode === "fast" && /nemotron/i.test(model)) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

  return body;
}

async function fetchSingleNvidiaModel(
  model: string,
  body: Record<string, unknown>,
  acceptHeader?: string
): Promise<globalThis.Response> {
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "NVIDIA_API_KEY is missing. Add it in Settings > Secrets to use NVIDIA NIM."
    );
  }

  return withRetry(async () => {
    const res = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(acceptHeader ? { Accept: acceptHeader } : {}),
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });

    if (res.status === 429 || res.status >= 500) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `NVIDIA NIM error (${res.status}): ${errText.slice(0, 240) || res.statusText}`
      );
    }
    return res;
  });
}

async function callNvidiaChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed" = "fast",
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const candidates = getNvidiaCandidateModels(speedMode);
  let lastError: Error | null = null;

  for (const model of candidates) {
    try {
      const response = await fetchSingleNvidiaModel(
        model,
        buildNvidiaRequestBody(model, messages, speedMode, false, options)
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        lastError = new Error(
          `NVIDIA NIM error (${response.status}): ${errText.slice(0, 240) || response.statusText}`
        );
        if (response.status === 401 || response.status === 403) {
          throw lastError;
        }
        if (isUnavailableNvidiaModelStatus(response.status)) {
          continue;
        }
        continue;
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
        }>;
      };
      const text = (data.choices?.[0]?.message?.content || "").trim();
      if (text) {
        return text;
      }
      // Empty content (e.g., hidden thinking exhausted max_tokens) -> try next live model
      lastError = new Error(`NVIDIA model ${model} returned an empty response.`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("(401)") || lastError.message.includes("(403)")) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("No NVIDIA NIM chat model returned an answer.");
}

async function streamNvidiaChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  speedMode: "fast" | "detailed",
  res: express.Response
): Promise<void> {
  const candidates = getNvidiaCandidateModels(speedMode);
  let lastError: Error | null = null;

  for (const model of candidates) {
    let emittedAnyText = false;
    try {
      const upstream = await fetchSingleNvidiaModel(
        model,
        buildNvidiaRequestBody(model, messages, speedMode, true),
        "text/event-stream"
      );

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        lastError = new Error(
          `NVIDIA NIM error (${upstream.status}): ${errText.slice(0, 240) || upstream.statusText}`
        );
        if (upstream.status === 401 || upstream.status === 403) {
          throw lastError;
        }
        continue;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            const delta = parsed.choices?.[0]?.delta?.content;
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
        res.write(`data: ${JSON.stringify({ done: true, sources: [] })}\n\n`);
        res.end();
        return;
      }

      // Stream completed with zero visible text tokens -> try next candidate model
      lastError = new Error(`NVIDIA model ${model} returned an empty stream.`);
    } catch (err) {
      if (emittedAnyText) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes("(401)") || lastError.message.includes("(403)")) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error("No NVIDIA NIM chat model returned an answer.");
}

async function callNvidiaJson<T>(
  systemInstruction: string,
  userPrompt: string,
  schemaDescription: string
): Promise<T> {
  const content = await callNvidiaChat(
    [
      {
        role: "system",
        content: `${systemInstruction} Return ONLY valid JSON matching this schema with no markdown fences or commentary:\n${schemaDescription}`,
      },
      { role: "user", content: userPrompt },
    ],
    "fast",
    { temperature: 0.2, maxTokens: 2048 }
  );
  return parseJsonFromText<T>(content);
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
      `Your job is to listen carefully and answer anything ${ownerName} asks — daily planning, practical problem-solving, Math/Science help, drafting messages, research, technology, finance basics, family scheduling, or helping check their sons' and daughter's schoolwork.`,
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
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>-]{1,3}/g, " ")
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

  // Configured server-side AI providers (booleans only, never exposes keys)
  app.get("/api/providers", (_req, res) => {
    res.json({
      geminiConfigured: hasGeminiKey(),
      nvidiaConfigured: hasNvidiaKey(),
      nvidiaModel: getNvidiaModel("fast"),
      nvidiaMathModel: getNvidiaModel("detailed"),
    });
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
    } = req.body as {
      messages: IncomingMessage[];
      profile?: ProfilePayload;
      subject?: string;
      useSearch?: boolean;
      language?: string;
      speedMode?: "fast" | "detailed";
      stream?: boolean;
      engine?: "auto" | "gemini" | "nvidia";
    };

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Please provide a message to Jogi Jarvis." });
    }

    const safeEngine: "auto" | "gemini" | "nvidia" =
      engine === "gemini" || engine === "nvidia" ? engine : "auto";
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

    const systemInstruction = buildSystemInstruction(
      profile,
      subject,
      "chat",
      language
    );
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

    const respondWithNvidia = async () => {
      const nvidiaMessages = buildNvidiaHistory();
      if (stream) {
        await streamNvidiaChat(nvidiaMessages, safeSpeedMode, res);
        return;
      }
      const reply =
        (await callNvidiaChat(nvidiaMessages, safeSpeedMode)) ||
        "I heard you, but I could not form a response. Please try asking again.";
      res.json({ reply, sources: [], provider: "nvidia" });
    };

    try {
      // Explicit NVIDIA NIM selection
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
        await respondWithNvidia();
        return;
      }

      // Auto mode when Gemini key is absent but NVIDIA key is configured (text-only)
      if (safeEngine === "auto" && !hasGeminiKey() && hasNvidiaKey() && !hasImage) {
        await respondWithNvidia();
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

      const geminiModels: Array<{
        name: string;
        config: Record<string, unknown>;
      }> = [
        {
          name: "gemini-4-hydrogen",
          config: {
            systemInstruction,
            thinkingConfig: { thinkingLevel },
            ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
          },
        },
        {
          name: "gemini-3.1-flash-lite",
          config: {
            systemInstruction,
            ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
          },
        },
      ];

      if (stream) {
        let lastGeminiErr: unknown = null;
        for (const candidate of geminiModels) {
          let emittedAnyText = false;
          try {
            const streamResponse = await withRetry(() =>
              ai.models.generateContentStream({
                model: candidate.name,
                contents,
                config: candidate.config,
              })
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
                `data: ${JSON.stringify({ done: true, sources: uniqueSources })}\n\n`
              );
              return res.end();
            }

            lastGeminiErr = new Error(
              `Gemini model ${candidate.name} returned an empty stream.`
            );
          } catch (geminiErr) {
            if (emittedAnyText) {
              throw geminiErr;
            }
            lastGeminiErr = geminiErr;
          }
        }

        if (safeEngine === "auto" && hasNvidiaKey() && !hasImage) {
          await respondWithNvidia();
          return;
        }
        throw lastGeminiErr || new Error("Gemini could not generate a response.");
      }

      let lastGeminiErr: unknown = null;
      for (const candidate of geminiModels) {
        try {
          const response = await withRetry(() =>
            ai.models.generateContent({
              model: candidate.name,
              contents,
              config: candidate.config,
            })
          );

          const reply = response.text?.trim() || "";
          if (reply) {
            const uniqueSources = extractSources(
              response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? []
            );
            return res.json({ reply, sources: uniqueSources, provider: "gemini" });
          }

          lastGeminiErr = new Error(
            `Gemini model ${candidate.name} returned an empty response.`
          );
        } catch (geminiErr) {
          lastGeminiErr = geminiErr;
        }
      }

      if (safeEngine === "auto" && hasNvidiaKey() && !hasImage) {
        await respondWithNvidia();
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
      } = req.body as {
        text?: string;
        voiceName?: string;
        role?: "parent" | "student";
        language?: string;
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

      const style =
        role === "student"
          ? `Warm, patient, encouraging personal teacher${langCue}`
          : `Calm, articulate, helpful personal assistant${langCue}`;

      const ai = getAiClient();
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
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

      const audioBase64 =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!audioBase64) {
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

      if (!hasGeminiKey() && hasNvidiaKey()) {
        const parsed = await callNvidiaJson(
          noteSystemInstruction,
          prompt,
          noteJsonSchemaHint
        );
        return res.json({ note: parsed });
      }

      try {
        const ai = getAiClient();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: prompt,
            config: {
              systemInstruction: noteSystemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: "application/json",
              responseSchema: {
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
              },
            },
          })
        );

        const parsed = JSON.parse((response.text || "{}").trim());
        return res.json({ note: parsed });
      } catch (geminiErr) {
        if (hasNvidiaKey()) {
          const parsed = await callNvidiaJson(
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

      if (!hasGeminiKey() && hasNvidiaKey()) {
        const parsed = await callNvidiaJson(
          summarySystemInstruction,
          prompt,
          summaryJsonSchemaHint
        );
        return res.json({ note: parsed });
      }

      try {
        const ai = getAiClient();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: prompt,
            config: {
              systemInstruction: summarySystemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: "application/json",
              responseSchema: {
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
              },
            },
          })
        );

        const parsed = JSON.parse((response.text || "{}").trim());
        return res.json({ note: parsed });
      } catch (geminiErr) {
        if (hasNvidiaKey()) {
          const parsed = await callNvidiaJson(
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

      if (!hasGeminiKey() && hasNvidiaKey()) {
        const translated = await callNvidiaJson(
          translateSystemInstruction,
          prompt,
          translateJsonSchemaHint
        );
        return res.json({ note: translated });
      }

      try {
        const ai = getAiClient();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: prompt,
            config: {
              systemInstruction: translateSystemInstruction,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              responseMimeType: "application/json",
              responseSchema: {
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
              },
            },
          })
        );

        const translated = JSON.parse((response.text || "{}").trim());
        return res.json({ note: translated });
      } catch (geminiErr) {
        if (hasNvidiaKey()) {
          const translated = await callNvidiaJson(
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

      if (!hasGeminiKey() && hasNvidiaKey()) {
        const result = await callNvidiaJson(
          quizSystemInstruction,
          quizPrompt,
          quizSchemaHint
        );
        return res.json(result);
      }

      try {
        const ai = getAiClient();
        const response = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents: quizPrompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
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
              },
            },
          })
        );

        const result = JSON.parse((response.text || "{}").trim());
        return res.json(result);
      } catch (geminiErr) {
        if (hasNvidiaKey()) {
          const result = await callNvidiaJson(
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
          audio?: string;
          text?: string;
          profile?: ProfilePayload;
          subject?: string;
          voiceName?: string;
          language?: string;
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

          const systemInstruction = buildSystemInstruction(
            msg.profile,
            msg.subject,
            "live",
            msg.language
          );

          liveSession = await ai.live.connect({
            model: "gemini-3.8-live",
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
            },
            callbacks: {
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
            },
          });

          // Session is now assigned and setupComplete has finished
          sendSafe({ type: "ready", voiceName: safeVoice });
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
