import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { streamSimple as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { Api, Context, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

export const PI_CODEX_PROVIDER_ID = "openai-codex";
export const PI_GEMINI_PROVIDER_ID = "google";

export type PiCodexAccessTokenResolver = (signal: AbortSignal | undefined) => Promise<string>;

export function piCodexModels(): Model<Api>[] {
  return Object.values(OPENAI_CODEX_MODELS);
}

export function hasPiGeminiModel(modelId: string): boolean {
  return Object.values(GOOGLE_MODELS).some((candidate) => candidate.id === modelId);
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
  const codex = Object.values(OPENAI_CODEX_MODELS).find((candidate) => candidate.id === modelId);
  if (codex) return codex;
  return piGeminiModel(modelId);
}

/** Worker-safe Codex transport：不載入 Pi 給 CLI 使用的 Node OAuth login flow。 */
export function streamPiCodex(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  resolveAccessToken: PiCodexAccessTokenResolver,
) {
  return lazyStream(model, async () => {
    options.signal?.throwIfAborted();
    const apiKey = await resolveAccessToken(options.signal);
    options.signal?.throwIfAborted();
    if (model.api !== "openai-codex-responses") throw new Error(`不支援的 Pi API：${model.api}`);
    return streamOpenAICodex(model as Model<"openai-codex-responses">, context, { ...options, apiKey });
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
  geminiApiKey?: string;
}

export function streamPiAssistantModel(
  model: Model<Api>,
  context: Context,
  options: ModelsSimpleStreamOptions,
  credentials: PiAssistantModelCredentials,
) {
  if (model.provider === PI_CODEX_PROVIDER_ID) {
    return streamPiCodex(model, context, options, credentials.resolveCodexAccessToken);
  }
  if (model.provider === PI_GEMINI_PROVIDER_ID) {
    return streamPiGemini(model, context, options, credentials.geminiApiKey ?? "");
  }
  throw new Error(`不支援的 Pi provider：${model.provider}`);
}

/** Pi compaction 只需要 completeSimple；這個 facade 也能讓後續 Sandbox 沿用相同 provider。 */
export function piCodexModelsFacade(
  resolveAccessToken: PiCodexAccessTokenResolver,
  defaults: ModelsSimpleStreamOptions,
): Models {
  return {
    completeSimple: async (model, context, options) => streamPiCodex(
      model,
      context,
      { ...defaults, ...options },
      resolveAccessToken,
    ).result(),
  } as Models;
}
