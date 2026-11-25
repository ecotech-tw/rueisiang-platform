import { parseDbDate } from "@rueisiang/db/db-timestamp";
import { useState } from "react";
import { isMediaImageSortField, type MediaImageSortField } from "@rueisiang/db/media-cdn-fields";
import { Icon } from "../../shell/icons.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { Button, DataTable, StatusBadge, Tooltip } from "../../ui/index.js";
import type { MediaImage } from "./api.js";

export const MEDIA_SORT_OPTIONS = [
  { value: "updatedAt", label: "更新時間" },
  { value: "createdAt", label: "上傳時間" },
  { value: "name", label: "圖片名稱" },
  { value: "contentType", label: "圖片格式" },
  { value: "pixels", label: "圖片尺寸" },
  { value: "size", label: "檔案大小" },
  { value: "status", label: "同步狀態" },
] as const satisfies readonly { value: MediaImageSortField; label: string }[];
export type MediaViewMode = "grid" | "list";
export interface MediaSort { field: MediaImageSortField; direction: "asc" | "desc" }
export const imageLook = "h-full w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10";
export function sizeLabel(size: number) { return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
export function dateLabel(value: string) { const date = parseDbDate(value); return date ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei" }).format(date) : value; }

export function ImagePreview({ image, compact = false }: { image: MediaImage; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed || image.deletedAt) {
    const label = image.deletedAt ? "圖片已刪除" : "無法載入預覽";
    return <div role="img" aria-label={label} className="grid h-full w-full place-content-center justify-items-center gap-2 text-muted">
      <Icon name={image.deletedAt ? "archive" : "camera"} className="size-5 shrink-0" />
      {!compact ? <span className="text-xs">{label}</span> : null}
    </div>;
  }
  return <img src={image.previewUrl} alt={image.name} className={imageLook} loading="lazy" onError={() => setFailed(true)} />;
}

export function SyncBadge({ image, local }: { image: MediaImage; local: boolean }) {
  return <StatusBadge tone={image.purgePending ? "warning" : image.deletedAt ? "neutral" : "success"}>{image.purgePending ? "待同步 CDN" : image.deletedAt ? "已刪除" : local ? "本機圖片" : "已同步 CDN"}</StatusBadge>;
}

interface ImageViewProps {
  images: MediaImage[];
  local: boolean;
  onDetails: (image: MediaImage) => void;
  onCopy: (image: MediaImage) => void;
}

export function ImageGrid({ images, local, onDetails, onCopy }: ImageViewProps) {
  return <div className="grid grid-cols-1 gap-4 min-[520px]:grid-cols-2 min-[1000px]:grid-cols-3 min-[1320px]:grid-cols-4">
    {images.map((image) => <article key={image.id} className="overflow-hidden rounded-card bg-paper shadow-panel">
      <button type="button" aria-label={`檢視 ${image.name}`} onClick={() => onDetails(image)} className="block h-40 w-full cursor-pointer overflow-hidden border-0 bg-canvas p-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary">
        <ImagePreview key={image.revision} image={image} />
      </button>
      <div className="grid gap-2.5 p-3">
        <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{image.name}</h2><p className="mt-1 text-xs tabular-nums text-muted">{image.width} × {image.height} px · {sizeLabel(image.size)}</p></div>
        <div className="flex items-center justify-between gap-2"><SyncBadge image={image} local={local} /><span className="text-[11px] text-muted">{image.contentType.replace("image/", "").toUpperCase()}</span></div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-soft-line pt-2.5">
          {!image.deletedAt ? <Button variant="secondary" icon="copy" onClick={() => onCopy(image)}>複製連結</Button> : <span className="text-[11px] text-muted">公開連結已失效</span>}
          <Button variant="secondary" tone="info" icon="eye" onClick={() => onDetails(image)}>圖片資訊</Button>
        </div>
      </div>
    </article>)}
  </div>;
}

export function ImageTable({ images, local, onDetails, onCopy, sort, onSort }: ImageViewProps & { sort: MediaSort; onSort: (field: MediaImageSortField, direction: "asc" | "desc") => void }) {
  const header = (label: string, field: MediaImageSortField, numeric = false) => <SortableHeader label={label} field={field} active={sort.field} direction={sort.direction} onSort={(field, direction) => { if (isMediaImageSortField(field)) onSort(field, direction); }} className={numeric ? "numeric" : undefined} />;
  return <DataTable aria-label="圖片列表" containerClassName="min-h-0 flex-1 overflow-auto max-[760px]:p-4" className="min-[760px]:[&_td]:py-1.5 [&_td[data-label=操作]]:whitespace-nowrap [&_td[data-label=更新時間]]:whitespace-nowrap">
    <thead><tr>{header("圖片名稱", "name")}{header("格式", "contentType")}{header("尺寸", "pixels", true)}{header("檔案大小", "size", true)}{header("更新時間", "updatedAt")}{header("狀態", "status")}<th><span className="sr-only">操作</span></th></tr></thead>
    <tbody>{images.map((image) => <tr key={image.id}>
      <td data-label="圖片"><div className="flex items-center gap-3"><div className="h-10 w-14 shrink-0 overflow-hidden rounded-field bg-canvas"><ImagePreview key={image.revision} image={image} compact /></div><div className="min-w-0 max-w-64"><button type="button" onClick={() => onDetails(image)} className="block w-full cursor-pointer truncate border-0 bg-transparent p-0 text-left font-medium text-ink transition-colors duration-120 hover:text-info focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary" aria-label={`檢視 ${image.name}`}>{image.name}</button><p className="mt-0.5 truncate text-[11px] text-muted">{image.filename}</p></div></div></td>
      <td data-label="格式">{image.contentType.replace("image/", "").toUpperCase()}</td>
      <td data-label="尺寸" className="numeric">{image.width} × {image.height}</td>
      <td data-label="檔案大小" className="numeric">{sizeLabel(image.size)}</td>
      <td data-label="更新時間">{dateLabel(image.updatedAt)}</td>
      <td data-label="狀態"><SyncBadge image={image} local={local} /></td>
      <td data-label="操作"><div className="flex items-center justify-end gap-1">{!image.deletedAt ? <Tooltip label="複製圖片連結" focusable={false}><Button variant="icon" icon="copy" aria-label={`複製 ${image.name} 的連結`} onClick={() => onCopy(image)} /></Tooltip> : null}<Tooltip label="圖片資訊" focusable={false}><Button variant="icon" tone="info" icon="eye" aria-label={`${image.name} 的圖片資訊`} onClick={() => onDetails(image)} /></Tooltip></div></td>
    </tr>)}</tbody>
  </DataTable>;
}
