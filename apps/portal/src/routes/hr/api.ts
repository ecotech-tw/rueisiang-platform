import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Employee { id: string; employeeNumber: string; displayName: string; userId: string | null; userEmail?: string | null; revision: number }
export interface Employment { id: string; employerName: string; hiredOn: string; endedOn: string | null; seniorityStartOn: string; revision: number }
export interface Assignment { id: string; employmentId: string; scopeName: string; validFrom: string; validTo: string | null; revision: number }
export interface Profile { employee: Employee; employments: Employment[]; assignments: Assignment[] }
export interface NamedOption { id: string; name: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/hr${path}`, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json" } });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `操作失敗（${response.status}）`);
  return result;
}
export function useHrQuery<T>(path: string, enabled: boolean) {
  return useQuery({ queryKey: ["hr", path], queryFn: () => request<T>(path), enabled, retry: false });
}
export function useHrWrite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> }) => request<{ id: string }>(input.path, { method: input.method, body: JSON.stringify(input.values) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["hr"] }); },
  });
}
