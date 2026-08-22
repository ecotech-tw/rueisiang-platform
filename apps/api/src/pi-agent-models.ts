import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { streamSimple as streamOpenAICodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { Api, Context, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

export const PI_CODEX_PROVIDER_ID = "openai-codex";

export type PiCodexAccessTokenResolver = (signal: AbortSignal | undefined) => Promise<string>;

export function piCodexModel(modelId: string): Model<Api> {
  const model = Object.values(OPENAI_CODEX_MODELS).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Pi openai-codex 不支援模型 ${modelId}。`);
  return model;
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
