import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type {
  Api,
  Context,
  FetchFunction,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export const PI_CODEX_PROVIDER_ID = "openai-codex";
export const PI_GEMINI_PROVIDER_ID = "google";

export type PiCodexAccessTokenResolver = (signal: AbortSignal | undefined) => Promise<string>;

export interface PiCodexRelayConfig {
  /** NAS relay 的 HTTPS origin；本機測試可使用 localhost／loopback 的 HTTP。 */
  baseUrl: string;
  /** Worker 與 NAS relay 之間的共享 secret，不會轉送給上游 provider。 */
  token: string;
}

const CODEX_UPSTREAM_HOST = "chatgpt.com";
const CODEX_UPSTREAM_PATH = "/backend-api/codex/responses";
const CODEX_RELAY_PATH = "/codex/responses";
const CODEX_RELAY_TOKEN_HEADER = "x-codex-relay-token";

function normalizeCodexRelayBaseUrl(value: string): URL {
  const raw = value.trim();
  if (!raw) throw new Error("Codex relay URL 不可為空。 ");

  const url = new URL(raw);
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Codex relay URL 必須使用 HTTPS；只有本機 loopback 可以使用 HTTP。 ");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Codex relay URL 不可包含帳密、query 或 fragment。 ");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Codex relay URL 必須是 origin，不可包含 path。 ");
  }
  url.pathname = "";
  return url;
}

/**
 * 將 Pi 的 Codex SSE 請求送到固定的 NAS relay。
 *
 * 這裡刻意驗證上游 URL，避免 relay 設定意外變成任意目的地的 proxy。
 * Pi 目前只會使用 SSE，所以不會改寫 WebSocket transport。
 */
export function createPiCodexRelayFetch(
  config: PiCodexRelayConfig,
  fetchImpl: FetchFunction = globalThis.fetch,
): FetchFunction {
  const relayBaseUrl = normalizeCodexRelayBaseUrl(config.baseUrl);
  const relayToken = config.token.trim();
  if (!relayToken) throw new Error("Codex relay token 不可為空。 ");

  return async (input, init) => {
    const source = new Request(input, init);
    const upstreamUrl = new URL(source.url);
    if (upstreamUrl.protocol !== "https:" || upstreamUrl.hostname !== CODEX_UPSTREAM_HOST) {
      throw new Error("Codex relay 只允許轉送 chatgpt.com 的 HTTPS 請求。 ");
    }
    if (upstreamUrl.pathname !== CODEX_UPSTREAM_PATH) {
      throw new Error(`Codex relay 不支援上游 path：${upstreamUrl.pathname}`);
    }

    const targetUrl = new URL(relayBaseUrl.toString());
    targetUrl.pathname = CODEX_RELAY_PATH;
    targetUrl.search = upstreamUrl.search;

    const headers = new Headers(source.headers);
    headers.set(CODEX_RELAY_TOKEN_HEADER, relayToken);
    const requestInit = {
      method: source.method,
      headers,
      body: source.method === "GET" || source.method === "HEAD" ? undefined : source.body,
      signal: source.signal,
      // Node 的 fetch 將 ReadableStream 當 request body 時需要此欄位；Cloudflare Fetch 會忽略它。
      duplex: "half" as const,
    } as RequestInit;
    return fetchImpl(targetUrl, requestInit);
  };
}

export function piCodexModels(): Model<Api>[] {
  return Object.values(OPENAI_CODEX_MODELS);
}

export function isPiCodexModel(modelId: string | undefined | null): modelId is string {
  return typeof modelId === "string"
    && Object.values(OPENAI_CODEX_MODELS).some((model) => model.id === modelId);
}

export function isPiGeminiModel(modelId: string | undefined | null): modelId is string {
  return typeof modelId === "string"
    && Object.values(GOOGLE_MODELS).some((model) => model.id === modelId);
}

export function isPiAssistantModel(modelId: string | undefined | null): modelId is string {
  return isPiCodexModel(modelId) || isPiGeminiModel(modelId);
}

export function resolvePiAssistantModelId(
  modelId: string | undefined | null,
  fallbackModelId: string,
): string {
  const normalizedModelId = typeof modelId === "string" ? modelId.trim() : modelId;
  return isPiAssistantModel(normalizedModelId) ? normalizedModelId : fallbackModelId;
}

export function piCodexModel(modelId: string): Model<Api> {
  const model = Object.values(OPENAI_CODEX_MODELS).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Pi openai-codex 不支援模型 ${modelId}。`);
  return model;
}

export function piGeminiModel(modelId: string): Model<Api> {
  const model = Object.values(GOOGLE_MODELS).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Pi Google provider 不支援模型 ${modelId}。`);
  return model;
}

export function piAssistantModel(modelId: string): Model<Api> {
  if (isPiCodexModel(modelId)) return piCodexModel(modelId);
  return piGeminiModel(modelId);
}

/** Worker-safe Codex transport：不載入 Pi 給 CLI 使用的 Node OAuth login flow。 */
export function streamPiCodex(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  resolveAccessToken: PiCodexAccessTokenResolver,
  relay?: PiCodexRelayConfig,
) {
  return lazyStream(model, async () => {
    options.signal?.throwIfAborted();
    const apiKey = await resolveAccessToken(options.signal);
    options.signal?.throwIfAborted();
    if (model.api !== "openai-codex-responses") throw new Error(`不支援的 Pi API：${model.api}`);
    return streamOpenAICodex(model as Model<"openai-codex-responses">, context, {
      ...options,
      apiKey,
      ...(relay ? { fetch: createPiCodexRelayFetch(relay) } : {}),
    });
  });
}

/** Gemini API key 仍由 Cloudflare secret 注入；Pi 只負責 provider adapter 與 agent loop。 */
export function streamPiGemini(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  apiKey: string,
) {
  return lazyStream(model, async () => {
    options.signal?.throwIfAborted();
    if (model.api !== "google-generative-ai") throw new Error(`不支援的 Pi API：${model.api}`);
    const credential = apiKey.trim();
    if (!credential) throw new Error("平台尚未設定 GEMINI_API_KEY。");
    return streamGoogle(model as Model<"google-generative-ai">, context, { ...options, apiKey: credential });
  });
}

export interface PiAssistantModelCredentials {
  resolveCodexAccessToken: PiCodexAccessTokenResolver;
  codexRelay?: PiCodexRelayConfig;
  geminiApiKey?: string;
}

export function streamPiAssistantModel(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  credentials: PiAssistantModelCredentials,
) {
  if (model.provider === PI_CODEX_PROVIDER_ID) {
    return streamPiCodex(model, context, options, credentials.resolveCodexAccessToken, credentials.codexRelay);
  }
  if (model.provider === PI_GEMINI_PROVIDER_ID) {
    return streamPiGemini(model, context, options, credentials.geminiApiKey ?? "");
  }
  throw new Error(`不支援的 Pi provider：${model.provider}`);
}
