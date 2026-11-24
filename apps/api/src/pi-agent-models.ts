import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createAssistantMessageEventStream, normalizeContext } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  FetchFunction,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export const PI_CODEX_PROVIDER_ID = "openai-codex";
const PI_GEMINI_PROVIDER_ID = "google";

type PiCodexAccessTokenResolver = (signal: AbortSignal | undefined) => Promise<string>;

const CODEX_UPSTREAM_HOST = "chatgpt.com";
const CODEX_UPSTREAM_PATH = "/backend-api/codex/responses";

export function createPiCodexVPCFetch(fetchImpl: FetchFunction): FetchFunction {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== CODEX_UPSTREAM_HOST) {
      throw new Error("Codex VPC egress 只允許連線至 chatgpt.com。 ");
    }
    if (url.pathname !== CODEX_UPSTREAM_PATH) {
      throw new Error(`Codex VPC egress 不支援上游 path：${url.pathname}`);
    }
    return fetchImpl(request);
  };
}

export function piCodexModels(): Model<Api>[] {
  return Object.values(OPENAI_CODEX_MODELS);
}

export function isPiCodexModel(modelId: string | undefined | null): modelId is string {
  return typeof modelId === "string"
    && Object.values(OPENAI_CODEX_MODELS).some((model) => model.id === modelId);
}

export function piGeminiModels(): Model<Api>[] {
  // catalog 也包含圖片、Live、研究與 computer-use 專用模型；一般小香工具迴圈不使用這些協定。
  return Object.values(GOOGLE_MODELS).filter((model) => model.api === "google-generative-ai"
    && model.input.includes("text")
    && /^(gemini|gemma)-/.test(model.id)
    && !/(?:^|-)(?:image|live|audio|tts|computer-use)(?:-|$)/.test(model.id));
}

export function isPiGeminiModel(modelId: string | undefined | null): modelId is string {
  return typeof modelId === "string"
    && piGeminiModels().some((model) => model.id === modelId);
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
  const model = piGeminiModels().find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Pi Google provider 不支援模型 ${modelId}。`);
  return model;
}

export function piAssistantModel(modelId: string): Model<Api> {
  if (isPiCodexModel(modelId)) return piCodexModel(modelId);
  return piGeminiModel(modelId);
}

/** Worker-safe Codex transport：不載入 Pi 給 CLI 使用的 Node OAuth login flow。 */
function streamPiCodex(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  resolveAccessToken: PiCodexAccessTokenResolver,
  fetchImpl?: FetchFunction,
) {
  return lazyStream(model, async () => {
    options.signal?.throwIfAborted();
    const apiKey = await resolveAccessToken(options.signal);
    options.signal?.throwIfAborted();
    if (model.api !== "openai-codex-responses") throw new Error(`不支援的 Pi API：${model.api}`);
    return streamOpenAICodex(model as Model<"openai-codex-responses">, normalizeContext(context), {
      ...options,
      apiKey,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  });
}

/** Gemini API key 仍由 Cloudflare secret 注入；Pi 只負責 provider adapter 與 agent loop。 */
function streamPiGemini(
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
    return streamGoogle(model as Model<"google-generative-ai">, normalizeContext(context), { ...options, apiKey: credential });
  });
}

export interface PiAssistantModelCredentials {
  resolveCodexAccessToken: PiCodexAccessTokenResolver;
  codexFetch?: FetchFunction;
  geminiApiKey?: string;
}

function streamPiAssistantModel(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  credentials: PiAssistantModelCredentials,
) {
  if (model.provider === PI_CODEX_PROVIDER_ID) {
    return streamPiCodex(model, context, options, credentials.resolveCodexAccessToken, credentials.codexFetch);
  }
  if (model.provider === PI_GEMINI_PROVIDER_ID) {
    return streamPiGemini(model, context, options, credentials.geminiApiKey ?? "");
  }
  throw new Error(`不支援的 Pi provider：${model.provider}`);
}

interface BufferedAssistantStream {
  events: AssistantMessageEvent[];
  result: AssistantMessage;
}

async function bufferAssistantStream(stream: AssistantMessageEventStream): Promise<BufferedAssistantStream> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

function replayAssistantStream(buffered: BufferedAssistantStream): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void Promise.resolve().then(() => {
    for (const event of buffered.events) stream.push(event);
    if (!buffered.events.some((event) => event.type === "done" || event.type === "error")) {
      stream.end(buffered.result);
    }
  });
  return stream;
}

/**
 * 以完整 provider response 判斷是否切換 fallback，避免 primary 已吐出半段訊息後又把同一輪重播一次。
 * 有設定 fallback 時會先暫存 primary 的事件；目前 agent API 本身等完整 response 後才回傳，因此不影響外部串流契約。
 */
export function streamPiAssistantModelWithFallback(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  credentials: PiAssistantModelCredentials,
  fallbackModel?: Model<Api>,
  fallbackOptions: ModelsSimpleStreamOptions = options,
  onFallback?: (primary: AssistantMessage) => void,
) {
  if (!fallbackModel || fallbackModel.id === model.id) {
    return streamPiAssistantModel(model, context, options, credentials);
  }

  return lazyStream(model, async () => {
    const primary = await bufferAssistantStream(streamPiAssistantModel(model, context, options, credentials));
    if (primary.result.stopReason !== "error") return replayAssistantStream(primary);
    onFallback?.(primary.result);
    return streamPiAssistantModel(fallbackModel, context, fallbackOptions, credentials);
  });
}
