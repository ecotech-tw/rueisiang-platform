import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MediaCdnImage } from "@rueisiang/db/schema";
import type { MediaImageSortField } from "@rueisiang/db/media-cdn-fields";

export type MediaImage = Omit<MediaCdnImage, "objectKey"> & { url: string; previewUrl: string };
export interface MediaImagePage { images: MediaImage[]; total: number; page: number; pageSize: number; configured: boolean; local: boolean; cdnOrigin: string }
const key = ["media", "images"] as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/media${path}`, { credentials: "same-origin", ...init });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `操作失敗（${response.status}）`);
  return body;
}

export function useMediaImages(query: { search: string; type: string; page: number; deleted: boolean; sort: MediaImageSortField; direction: "asc" | "desc" }, enabled: boolean) {
  return useQuery({ queryKey: [...key, query], enabled, placeholderData: keepPreviousData, queryFn: ({ signal }) => request<MediaImagePage>(`/images?${new URLSearchParams({ ...query, page: String(query.page), deleted: String(query.deleted) })}`, { signal }) });
}

export function useMediaMutation<T>(fn: (input: T) => Promise<{ image: MediaImage }>) {
  const client = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: async () => { await client.invalidateQueries({ queryKey: key }); } });
}

export function uploadMediaImage(input: { file: File; name: string; target?: MediaImage }) {
  const form = new FormData();
  form.set("file", input.file); form.set("name", input.name);
  if (input.target) form.set("revision", String(input.target.revision));
  return request<{ image: MediaImage }>(input.target ? `/images/${input.target.id}` : "/images", { method: input.target ? "PUT" : "POST", body: form });
}
export function renameMediaImage(input: { image: MediaImage; name: string }) {
  return request<{ image: MediaImage }>(`/images/${input.image.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.name, revision: input.image.revision }) });
}
export function removeMediaImage(image: MediaImage) {
  return request<{ image: MediaImage }>(`/images/${image.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: image.revision, confirmedUnused: true }) });
}
export function retryMediaPurge(image: MediaImage) {
  return request<{ image: MediaImage }>(`/images/${image.id}/purge`, { method: "POST" });
}
