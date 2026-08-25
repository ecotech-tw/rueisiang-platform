import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AssistantModel {
  id: string;
  label: string;
  category: string;
  quota: { rpm: number; tpm: number; rpd: number; usedRpm?: number; usedTpm?: number; usedRpd?: number };
  provider: "openai-codex" | "google";
  supported: boolean;
  configured: boolean;
  supportsVision: boolean;
  note?: string;
}

export interface PromptRevision {
  id: string;
  assistantKey: string;
  revision: number;
  systemPrompt: string;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
}

export interface AssistantTool {
  key: string;
  label: string;
  description: string;
  surfaces: Array<"sandbox" | "line" | "mcp">;
  requiredPermissions: string[];
  status: "enabled" | "development" | "disabled";
}

export interface SandboxConfig {
  assistantKey: string;
  configured: boolean;
  providers: { codex: boolean; gemini: boolean };
  defaultModel: string;
  activeModel: string;
  activeModelUpdatedAt: string | null;
  models: AssistantModel[];
  tools: AssistantTool[];
  activePrompt: PromptRevision | null;
  revisions: PromptRevision[];
}

export interface SandboxToolCall {
  toolKey: string;
  status: "success" | "failed";
  args?: Record<string, unknown>;
  durationMs: number;
  errorMessage?: string;
}

export interface SandboxAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  expiresAt?: string | null;
}

export interface SandboxResult {
  runId: string;
  sessionId: string | null;
  text: string;
  thoughts: string;
  attachments: SandboxAttachment[];
  model: string;
  promptRevision: number;
  usage: { promptTokens: number; candidateTokens: number; totalTokens: number };
  toolCalls: SandboxToolCall[];
  durationMs: number;
}

export interface SandboxSessionMessage {
  id: string;
  role: "user" | "model";
  text: string;
  model: string;
  thoughts: string;
  toolCalls: SandboxToolCall[];
  attachments: SandboxAttachment[];
  durationMs: number;
  createdAt: string;
}

export interface SandboxSessionSummary {
  id: string;
  model: string;
  promptRevisionId: string;
  status: "open" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface SandboxSession extends SandboxSessionSummary {
  contextSummaryMessageCount: number;
  messages: SandboxSessionMessage[];
}

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new AssistantApiError(body?.error ?? `操作失敗（${response.status}）`);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      runId?: unknown;
      toolCalls?: unknown;
    } | null;
    const toolCalls = Array.isArray(body?.toolCalls)
      ? body.toolCalls.filter((value): value is SandboxToolCall => {
        if (!value || typeof value !== "object") return false;
        const call = value as Record<string, unknown>;
        return typeof call.toolKey === "string"
          && (call.status === "success" || call.status === "failed")
          && typeof call.durationMs === "number";
      })
      : [];
    throw new AssistantApiError(body?.error ?? `操作失敗（${response.status}）`, {
      runId: typeof body?.runId === "string" ? body.runId : undefined,
      toolCalls,
    });
  }
  return (await response.json()) as T;
}

export class AssistantApiError extends Error {
  readonly runId?: string;
  readonly toolCalls: SandboxToolCall[];

  constructor(message: string, details: { runId?: string; toolCalls?: SandboxToolCall[] } = {}) {
    super(message);
    this.name = "AssistantApiError";
    this.runId = details.runId;
    this.toolCalls = details.toolCalls ?? [];
  }
}

export function useSandboxConfig() {
  return useQuery({
    queryKey: ["assistant", "sandbox", "config"],
    queryFn: () => request<SandboxConfig>("/api/assistant/sandbox/config"),
  });
}

export function useSavePrompt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (systemPrompt: string) =>
      request<{ revision: PromptRevision }>("/api/assistant/prompts", {
        method: "POST",
        body: JSON.stringify({ systemPrompt }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "config"] }),
  });
}

export function useSandboxSessions() {
  return useQuery({
    queryKey: ["assistant", "sandbox", "sessions"],
    queryFn: () => request<{ sessions: SandboxSessionSummary[] }>("/api/assistant/sandbox/sessions"),
  });
}

export function useSandboxSession(id: string) {
  return useQuery({
    queryKey: ["assistant", "sandbox", "session", id],
    queryFn: () => request<{ session: SandboxSession }>(`/api/assistant/sandbox/sessions/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateSandboxSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; promptRevisionId: string }) =>
      request<{ session: SandboxSession }>("/api/assistant/sandbox/sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "sessions"] }),
  });
}

export function useCloseSandboxSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<{ session: SandboxSession }>(`/api/assistant/sandbox/sessions/${id}/close`, { method: "POST" }),
    onSuccess: (data) => {
      client.setQueryData(["assistant", "sandbox", "session", data.session.id], data);
      void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "sessions"] });
    },
  });
}

export type AssistantGroupToolMode = "inherit" | "custom";
export type AssistantLineSourceType = "group" | "room" | "user";

export interface AssistantLineGroup {
  id: string;
  lineGroupId: string;
  sourceType: AssistantLineSourceType;
  displayName: string;
  /** LINE 對話對方的大頭貼。網址會過期，只當顯示用；沒有大頭貼時是空字串。 */
  pictureUrl: string;
  enabled: boolean;
  /** inherit：用 channel 給的全部；custom：只用 tools 這一份。 */
  toolMode: AssistantGroupToolMode;
  /** 只有 custom 模式有值；inherit 的時候後端回空陣列。 */
  tools: string[];
  discoveredAt: string;
  updatedAt: string;
}

export interface AssistantLineConfig {
  channel: {
    channelKey: string;
    assistantKey: string;
    channelId: string;
    displayName: string;
    enabled: boolean;
    updatedAt: string;
  };
  credentials: {
    channelSecretConfigured: boolean;
    accessTokenConfigured: boolean;
    channelSecretDecryptionFailed: boolean;
    accessTokenDecryptionFailed: boolean;
  };
  webhookUrl: string;
  /** 支援 LINE 的工具目錄。由這支端點自己供應，畫面不必再去打 /sandbox/config。 */
  tools: AssistantTool[];
  /** 這個 channel 被授權的工具鍵值——LINE 這條路的授權上限。 */
  channelTools: string[];
  groups: AssistantLineGroup[];
}

export function useSaveAssistantModel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (model: string) =>
      request<{ activeModel: string; updatedAt: string }>("/api/assistant/config", {
        method: "PATCH",
        body: JSON.stringify({ model }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "config"] }),
  });
}

export function useSaveAssistantToolStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string; status: AssistantTool["status"] }) =>
      request<{ key: string; status: AssistantTool["status"]; updatedAt: string }>(`/api/assistant/tools/${input.key}`, {
        method: "PATCH",
        body: JSON.stringify({ status: input.status }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "config"] }),
  });
}

export function useAssistantLineConfig() {
  return useQuery({
    queryKey: ["assistant", "line", "config"],
    queryFn: () => request<AssistantLineConfig>("/api/assistant/line/config"),
  });
}

export function useSaveAssistantLineConfig() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { channelId: string; channelSecret: string; accessToken: string; displayName: string; enabled: boolean }) =>
      request<AssistantLineConfig>("/api/assistant/line/config", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => client.setQueryData(["assistant", "line", "config"], data),
  });
}

export function useAddAssistantLineGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { lineGroupId: string; sourceType: AssistantLineSourceType; displayName: string }) =>
      request<{ group: AssistantLineGroup }>("/api/assistant/line/groups", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "line", "config"] }),
  });
}

/**
 * 更新對話。`displayName` 省略時後端維持原值。
 *
 * 開關要用省略的形式：新發現的對話名稱預設是空字串，把它一起送出去會被後端的
 * 「請填寫對話顯示名稱」擋下來——切個開關卻被要求先命名，是沒有道理的。
 */
export function useSaveAssistantLineGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; displayName?: string; enabled: boolean }) =>
      request<{ group: AssistantLineGroup }>(`/api/assistant/line/groups/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(
          input.displayName === undefined
            ? { enabled: input.enabled }
            : { displayName: input.displayName, enabled: input.enabled },
        ),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "line", "config"] }),
  });
}

/** 設定 channel 的工具白名單。回傳整份設定，直接換掉快取免得多打一次。 */
export function useSaveAssistantChannelTools() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (toolKeys: string[]) =>
      request<AssistantLineConfig>("/api/assistant/line/tools", {
        method: "PUT",
        body: JSON.stringify({ toolKeys }),
      }),
    onSuccess: (data) => client.setQueryData(["assistant", "line", "config"], data),
  });
}

/** 設定單一對話的模式與工具。inherit 時不必送 toolKeys。 */
export function useSaveAssistantGroupTools() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; toolMode: AssistantGroupToolMode; toolKeys?: string[] }) =>
      request<AssistantLineConfig>(`/api/assistant/line/groups/${input.id}/tools`, {
        method: "PUT",
        body: JSON.stringify(
          input.toolMode === "custom"
            ? { toolMode: input.toolMode, toolKeys: input.toolKeys ?? [] }
            : { toolMode: input.toolMode },
        ),
      }),
    onSuccess: (data) => client.setQueryData(["assistant", "line", "config"], data),
  });
}

export function useRunSandbox() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; promptRevisionId: string; toolKeys: string[]; input: string; attachments: SandboxAttachment[]; sessionId?: string }) =>
      request<SandboxResult>("/api/assistant/sandbox/run", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onMutate: async (input) => {
      if (!input.sessionId) return undefined;
      const queryKey = ["assistant", "sandbox", "session", input.sessionId] as const;
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<{ session: SandboxSession }>(queryKey);
      if (!previous) return { queryKey, previous };
      const createdAt = new Date().toISOString();
      client.setQueryData<{ session: SandboxSession }>(queryKey, {
        session: {
          ...previous.session,
          updatedAt: createdAt,
          messages: [...previous.session.messages, {
            id: `optimistic-${crypto.randomUUID()}`,
            role: "user",
            text: input.input,
            model: "",
            thoughts: "",
            toolCalls: [],
            attachments: input.attachments,
            durationMs: 0,
            createdAt,
          }],
        },
      });
      return { queryKey, previous };
    },
    onError: (_error, _input, context) => {
      if (context?.queryKey) void client.invalidateQueries({ queryKey: context.queryKey });
    },
    onSuccess: (data) => {
      if (data.sessionId) void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "session", data.sessionId] });
      void client.invalidateQueries({ queryKey: ["assistant", "sandbox", "sessions"] });
    },
  });
}

export function useUploadSandboxAttachment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/assistant/sandbox/attachments", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      if (!response.ok) await readError(response);
      return (await response.json()) as { attachment: SandboxAttachment };
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["assistant", "sandbox"] });
    },
  });
}
