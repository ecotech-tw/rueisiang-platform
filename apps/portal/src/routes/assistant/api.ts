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
  models: AssistantModel[];
  tools: AssistantTool[];
  activePrompt: PromptRevision | null;
  revisions: PromptRevision[];
}

export interface SandboxResult {
  runId: string;
  text: string;
  model: string;
  promptRevision: number;
  usage: { promptTokens: number; candidateTokens: number; totalTokens: number };
  toolCalls: Array<{ toolKey: string; status: "success" | "failed"; durationMs: number; errorMessage?: string }>;
  durationMs: number;
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

export function useRunSandbox() {
  return useMutation({
    mutationFn: (input: { model: string; promptRevisionId: string; toolKeys: string[]; input: string }) =>
      request<SandboxResult>("/api/assistant/sandbox/run", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  });
}
