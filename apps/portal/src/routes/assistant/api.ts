import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface AssistantModel {
  id: string;
  label: string;
  category: string;
  quota: { rpm: number; tpm: number; rpd: number; usedRpm?: number; usedTpm?: number; usedRpd?: number };
  supported: boolean;
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
  status: "enabled" | "development" | "disabled";
}

export interface SandboxConfig {
  assistantKey: string;
  configured: boolean;
  defaultModel: string;
  activeModel: string;
  activeModelUpdatedAt: string | null;
  models: AssistantModel[];
  tools: AssistantTool[];
  activePrompt: PromptRevision | null;
  revisions: PromptRevision[];
}

export interface SandboxResult {
  runId: string;
  sessionId: string | null;
  text: string;
  thoughts: string;
  model: string;
  promptRevision: number;
  usage: { promptTokens: number; candidateTokens: number; totalTokens: number };
  toolCalls: Array<{ toolKey: string; status: "success" | "failed"; durationMs: number; errorMessage?: string }>;
  durationMs: number;
}

export interface SandboxSessionMessage {
  id: string;
  role: "user" | "model";
  text: string;
  model: string;
  thoughts: string;
  toolCalls: Array<{ toolKey: string; status: "success" | "failed"; durationMs: number; errorMessage?: string }>;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
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

export interface AssistantLineGroup {
  id: string;
  lineGroupId: string;
  displayName: string;
  enabled: boolean;
  discoveredAt: string;
  updatedAt: string;
}

export interface AssistantLineConfig {
  channel: {
    assistantKey: string;
    channelId: string;
    displayName: string;
    enabled: boolean;
    updatedAt: string;
  };
  credentials: {
    channelSecretConfigured: boolean;
    accessTokenConfigured: boolean;
  };
  webhookUrl: string;
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
    mutationFn: (input: { lineGroupId: string; displayName: string }) =>
      request<{ group: AssistantLineGroup }>("/api/assistant/line/groups", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "line", "config"] }),
  });
}

export function useSaveAssistantLineGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; displayName: string; enabled: boolean }) =>
      request<{ group: AssistantLineGroup }>(`/api/assistant/line/groups/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: input.displayName, enabled: input.enabled }),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["assistant", "line", "config"] }),
  });
}

export function useRunSandbox() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { model: string; promptRevisionId: string; toolKeys: string[]; input: string; sessionId?: string }) =>
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
