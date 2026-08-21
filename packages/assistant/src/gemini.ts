import { AssistantError, type AssistantConversationMessage, type AssistantRunResult, type AssistantToolCall, type AssistantToolDefinition, type AssistantUsage } from "./types.js";

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  [key: string]: unknown;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface GeminiRequest {
  system_instruction: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  generationConfig?: {
    thinkingConfig?: {
      includeThoughts?: boolean;
      thinkingLevel?: "minimal" | "low" | "medium" | "high";
    };
  };
  tools?: Array<{ functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: AssistantToolDefinition["parameters"];
  }> }>;
}

function safeApiError(status: number): string {
  if (status === 400) return "Gemini 請求格式錯誤，請換一個模型或檢查工具設定。";
  if (status === 401 || status === 403) return "Gemini API key 無效或沒有使用這個模型的權限。";
  if (status === 404) return "目前模型無法使用，請換一個支援的模型。";
  if (status === 429) return "Gemini 配額或速率限制已達上限，請稍後再試。";
  return `Gemini 暫時無法回應（HTTP ${status}）。`;
}

async function generateContent(apiKey: string, model: string, request: GeminiRequest): Promise<GeminiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      console.error("Gemini API 錯誤", response.status, details.slice(0, 500));
      throw new AssistantError(safeApiError(response.status));
    }
    return (await response.json()) as GeminiResponse;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError("Gemini 連線逾時或暫時無法連線。", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function emptyUsage(): AssistantUsage {
  return { promptTokens: 0, candidateTokens: 0, totalTokens: 0 };
}

function addUsage(total: AssistantUsage, current: GeminiResponse["usageMetadata"]): void {
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

function readToolCalls(parts: GeminiPart[]): Array<{ name: string; args: unknown }> {
  return parts.flatMap((part) => {
    const name = part.functionCall?.name?.trim();
    return name ? [{ name, args: part.functionCall?.args ?? {} }] : [];
  });
}

function readText(parts: GeminiPart[]): string {
  return parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function readThoughts(parts: GeminiPart[]): string {
  return parts
    .filter((part) => part.thought === true)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

function modelId(value: string): string {
  return value.replace(/^models\//, "");
}

function generationConfigFor(model: string): GeminiRequest["generationConfig"] {
  // Keep thought summaries available to the caller. Sandbox collapses them;
  // LINE writes them to the Worker log but only sends the final answer.
  if (model.startsWith("gemma-4-")) {
    return { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } };
  }
  return { thinkingConfig: { includeThoughts: true } };
}

export async function runGemini(input: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userText: string;
  conversation?: AssistantConversationMessage[];
  tools: AssistantToolDefinition[];
  maxToolRounds?: number;
}): Promise<AssistantRunResult> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.key, tool]));
  const contents: GeminiContent[] = [
    ...(input.conversation ?? []).map((message) => ({ role: message.role, parts: [{ text: message.text }] })),
    { role: "user", parts: [{ text: input.userText }] },
  ];
  const usage = emptyUsage();
  const thoughts: string[] = [];
  const toolCalls: AssistantToolCall[] = [];
  const declarations = input.tools.map((tool) => ({
    name: tool.key,
    description: tool.description,
    parameters: tool.parameters,
  }));
  const requestBase = {
    system_instruction: { parts: [{ text: input.systemPrompt }] },
    generationConfig: generationConfigFor(modelId(input.model)),
    tools: declarations.length ? [{ functionDeclarations: declarations }] : undefined,
  };
  const maxToolRounds = input.maxToolRounds ?? 3;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const response = await generateContent(input.apiKey, modelId(input.model), {
      ...requestBase,
      contents,
    });
    addUsage(usage, response.usageMetadata);
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const thoughtText = readThoughts(parts);
    if (thoughtText) thoughts.push(thoughtText);
    const calls = readToolCalls(parts);
    if (!calls.length) {
      const text = readText(parts);
      if (text) return { text, thoughts: thoughts.join("\n\n"), toolCalls, usage };
      throw new AssistantError("模型沒有產生可顯示的文字回答。");
    }
    if (round === maxToolRounds) throw new AssistantError("工具呼叫次數已達上限，請縮小問題範圍後再試。" );

    // 把模型原始 part（包含 thinking model 可能需要的簽章欄位）原樣放回歷史。
    contents.push({ role: "model", parts });
    const functionResponses: GeminiPart[] = [];
    for (const call of calls) {
      const tool = toolsByName.get(call.name);
      const started = Date.now();
      if (!tool) {
        const errorMessage = `模型要求未授權的工具：${call.name}`;
        toolCalls.push({ toolKey: call.name, status: "failed", durationMs: Date.now() - started, errorMessage });
        functionResponses.push({ functionResponse: { name: call.name, response: { error: errorMessage } } });
        continue;
      }
      try {
        const result = await tool.execute(call.args);
        toolCalls.push({ toolKey: tool.key, status: "success", durationMs: Date.now() - started });
        functionResponses.push({ functionResponse: { name: tool.key, response: { result: responseObject(result) } } });
      } catch (error) {
        const errorMessage = error instanceof AssistantError ? error.message : "工具執行失敗。";
        console.error("AI tool 執行失敗", tool.key, error);
        toolCalls.push({ toolKey: tool.key, status: "failed", durationMs: Date.now() - started, errorMessage });
        functionResponses.push({ functionResponse: { name: tool.key, response: { error: errorMessage } } });
      }
    }
    contents.push({ role: "user", parts: functionResponses });
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
