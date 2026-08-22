import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
  type Schema,
  type ThinkingConfig,
  ThinkingLevel,
  Type,
} from "@google/genai/web";
import { assistantErrorDetails, assistantLog } from "./logging.js";
import { AssistantError, type AssistantConversationMessage, type AssistantRunResult, type AssistantToolCall, type AssistantToolContext, type AssistantToolDefinition, type AssistantUsage, type JsonSchema } from "./types.js";
import { runtimeContextInstruction, type AssistantRuntimeContext } from "./runtime.js";

interface GeminiRequest {
  contents: Content[];
  config: GenerateContentConfig;
}

interface GeminiToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

function toGeminiSchema(schema: JsonSchema): Schema {
  return {
    type: Type.OBJECT,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([key, property]) => [key, {
      ...property,
      type: property.type.toUpperCase() as Type,
    }])),
    ...(schema.required ? { required: schema.required } : {}),
  };
}

function safeApiError(status: number): string {
  if (status === 400) return "Gemini 請求格式錯誤，請換一個模型或檢查工具設定。";
  if (status === 401 || status === 403) return "Gemini API key 無效或沒有使用這個模型的權限。";
  if (status === 404) return "目前模型無法使用，請換一個支援的模型。";
  if (status === 429) return "Gemini 配額或速率限制已達上限，請稍後再試。";
  return `Gemini 暫時無法回應（HTTP ${status}）。`;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

async function generateContent(
  apiKey: string,
  model: string,
  request: GeminiRequest,
  trace: { runId: string; round: number },
): Promise<GenerateContentResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const started = Date.now();
  assistantLog("info", "gemini.request", {
    runId: trace.runId,
    round: trace.round,
    model,
    contentCount: request.contents.length,
    hasTools: Boolean(request.config.tools?.length),
  });
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: request.contents,
      config: {
        ...request.config,
        abortSignal: controller.signal,
        httpOptions: {
          timeout: 60_000,
          // Tool call 的每一輪由本身的 assistant loop 控制，不讓 SDK 在背景重試放大延遲。
          retryOptions: { attempts: 1 },
        },
      },
    });
    assistantLog("info", "gemini.response", {
      runId: trace.runId,
      round: trace.round,
      model,
      durationMs: Date.now() - started,
      candidateCount: response.candidates?.length ?? 0,
      partCount: response.candidates?.[0]?.content?.parts?.length ?? 0,
      finishReason: response.candidates?.[0]?.finishReason ?? null,
      usage: response.usageMetadata ?? null,
    });
    return response;
  } catch (error) {
    const status = errorStatus(error);
    assistantLog("error", "gemini.error", {
      runId: trace.runId,
      round: trace.round,
      model,
      durationMs: Date.now() - started,
      httpStatus: status ?? null,
      error: assistantErrorDetails(error),
    });
    if (status !== undefined) {
      throw new AssistantError(safeApiError(status), { cause: error });
    }
    throw new AssistantError("Gemini 連線逾時或暫時無法連線。", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function emptyUsage(): AssistantUsage {
  return { promptTokens: 0, candidateTokens: 0, totalTokens: 0 };
}

function addUsage(total: AssistantUsage, current: GenerateContentResponse["usageMetadata"]): void {
  total.promptTokens += current?.promptTokenCount ?? 0;
  total.candidateTokens += current?.candidatesTokenCount ?? 0;
  total.totalTokens += current?.totalTokenCount ?? 0;
}

function responseObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: value };
  }
}

function readToolCalls(parts: Part[]): GeminiToolCall[] {
  return parts.flatMap((part) => {
    const call: FunctionCall | undefined = part.functionCall;
    const name = call?.name?.trim();
    return name ? [{ id: call?.id, name, args: call?.args ?? {} }] : [];
  });
}

function readText(parts: Part[]): string {
  return parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function readThoughts(parts: Part[]): string {
  return parts
    .filter((part) => part.thought === true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function safeToolError(error: unknown): string {
  if (error instanceof AssistantError) return error.message;
  if (error instanceof Error && error.message.startsWith("CYBERBIZ API ")) {
    return error.message.slice(0, 300);
  }
  return "工具執行失敗。";
}

function modelId(value: string): string {
  return value.replace(/^models\//, "");
}

function thinkingConfigFor(model: string): ThinkingConfig {
  // Keep thought summaries available to the caller. Sandbox collapses them;
  // LINE writes them to the Worker log but only sends the final answer.
  if (model.startsWith("gemma-4-")) {
    return { thinkingLevel: ThinkingLevel.HIGH, includeThoughts: true };
  }
  return { includeThoughts: true };
}

function systemInstructionFor(input: { systemPrompt: string; runtimeContext?: AssistantRuntimeContext }): Content {
  return {
    parts: [
      { text: input.systemPrompt },
      ...(input.runtimeContext ? [{ text: runtimeContextInstruction(input.runtimeContext) }] : []),
    ],
  };
}

export async function runGemini(input: {
  apiKey: string;
  model: string;
  runId?: string;
  systemPrompt: string;
  runtimeContext?: AssistantRuntimeContext;
  userText: string;
  conversation?: AssistantConversationMessage[];
  tools: AssistantToolDefinition[];
  toolContext?: AssistantToolContext;
  maxToolRounds?: number;
}): Promise<AssistantRunResult> {
  const runId = input.runId ?? crypto.randomUUID();
  const normalizedModel = modelId(input.model);
  const surface = input.toolContext?.surface ?? "unknown";
  const runStarted = Date.now();
  assistantLog("info", "run.started", {
    runId,
    surface,
    model: normalizedModel,
    conversationMessageCount: input.conversation?.length ?? 0,
    userTextChars: input.userText.length,
    toolKeys: input.tools.map((tool) => tool.key),
  });
  const finish = (result: AssistantRunResult, status: "success" | "partial_failure"): AssistantRunResult => {
    assistantLog(status === "success" ? "info" : "warn", "run.completed", {
      runId,
      surface,
      model: normalizedModel,
      status,
      durationMs: Date.now() - runStarted,
      toolCallCount: result.toolCalls.length,
      usage: result.usage,
    });
    return result;
  };
  const toolsByName = new Map(input.tools.map((tool) => [tool.key, tool]));
  const contents: Content[] = [
    ...(input.conversation ?? []).map((message) => ({ role: message.role, parts: [{ text: message.text }] })),
    { role: "user", parts: [{ text: input.userText }] },
  ];
  const usage = emptyUsage();
  const thoughts: string[] = [];
  const toolCalls: AssistantToolCall[] = [];
  const declarations = input.tools.map((tool) => ({
    name: tool.key,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  }));
  const requestBase: Omit<GeminiRequest, "contents"> = {
    config: {
      systemInstruction: systemInstructionFor(input),
      thinkingConfig: thinkingConfigFor(normalizedModel),
      tools: declarations.length ? [{ functionDeclarations: declarations }] : undefined,
    },
  };
  const maxToolRounds = input.maxToolRounds ?? 3;

  try {
    for (let round = 0; round <= maxToolRounds; round += 1) {
      const response = await generateContent(input.apiKey, normalizedModel, {
        ...requestBase,
        contents,
      }, { runId, round });
      addUsage(usage, response.usageMetadata);
      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const thoughtText = readThoughts(parts);
      if (thoughtText) thoughts.push(thoughtText);
      const calls = readToolCalls(parts);
      if (!calls.length) {
        const text = readText(parts);
        if (text) {
          const status = toolCalls.some((toolCall) => toolCall.status === "failed") ? "partial_failure" : "success";
          return finish({ text, thoughts: thoughts.join("\n\n"), toolCalls, usage }, status);
        }
        throw new AssistantError("模型沒有產生可顯示的文字回答。");
      }
      if (round === maxToolRounds) throw new AssistantError("工具呼叫次數已達上限，請縮小問題範圍後再試。");

      // 將模型原始 part（包含 thinking model 可能需要的 thought signature）原樣放回歷史。
      contents.push({ role: "model", parts });
      const functionResponses: Part[] = [];
      for (const call of calls) {
        const tool = toolsByName.get(call.name);
        const started = Date.now();
        if (!tool) {
          const errorMessage = `模型要求未授權的工具：${call.name}`;
          assistantLog("error", "tool.unknown", { runId, round, toolKey: call.name });
          toolCalls.push({ toolKey: call.name, status: "failed", args: call.args, durationMs: Date.now() - started, errorMessage });
          functionResponses.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: { error: errorMessage },
            },
          });
          continue;
        }
        assistantLog("info", "tool.started", { runId, round, toolKey: tool.key });
        try {
          const result = await tool.execute(call.args, input.toolContext);
          const durationMs = Date.now() - started;
          assistantLog("info", "tool.completed", { runId, round, toolKey: tool.key, status: "success", durationMs });
          toolCalls.push({ toolKey: tool.key, status: "success", args: call.args, durationMs });
          functionResponses.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: tool.key,
              response: { result: responseObject(result) },
            },
          });
        } catch (error) {
          const errorMessage = safeToolError(error);
          const durationMs = Date.now() - started;
          assistantLog("error", "tool.failed", {
            runId,
            round,
            toolKey: tool.key,
            durationMs,
            error: assistantErrorDetails(error),
          });
          toolCalls.push({ toolKey: tool.key, status: "failed", args: call.args, durationMs, errorMessage });
          functionResponses.push({
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: tool.key,
              response: { error: errorMessage },
            },
          });
        }
      }
      // 成功與失敗都要把 function response 餵回模型，讓模型決定如何向使用者說明。
      // 失敗資訊只放在這一輪的 model context，不直接把內部錯誤當成最終回答噴給使用者。
      contents.push({ role: "user", parts: functionResponses });
    }
  } catch (error) {
    if (error instanceof AssistantError) error.toolCalls = [...toolCalls];
    assistantLog("error", "run.failed", {
      runId,
      surface,
      model: normalizedModel,
      durationMs: Date.now() - runStarted,
      toolCallCount: toolCalls.length,
      usage,
      error: assistantErrorDetails(error),
    });
    throw error;
  }

  throw new AssistantError("AI assistant did not complete the response.");
}

/**
 * Create a compact, durable memory for a long Sandbox conversation.
 * The source conversation stays in D1; this result is only used as model context.
 */
export async function summarizeAssistantConversation(input: {
  apiKey: string;
  model: string;
  existingSummary?: string;
  messages: AssistantConversationMessage[];
}): Promise<AssistantRunResult> {
  const source = [
    input.existingSummary?.trim() ? `Existing summary:\n${input.existingSummary.trim()}` : "",
    ...input.messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`),
  ].filter(Boolean).join("\n\n").slice(-48_000);

  return runGemini({
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: [
      "You maintain memory for an internal company assistant.",
      "Summarize the supplied conversation in Traditional Chinese.",
      "Keep confirmed facts, user intent, decisions, constraints, unresolved questions, and useful tool results.",
      "Remove greetings, repetition, hidden reasoning, and unsupported assumptions.",
      "Output only the summary. Do not output JSON, headings about your process, API keys, or chain-of-thought.",
    ].join("\n"),
    userText: source || "目前沒有可摘要的對話。",
    tools: [],
    maxToolRounds: 0,
  });
}
