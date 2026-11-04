import { useDeferredValue, useRef, useState } from "react";
import { useImageFilePreview } from "@rueisiang/ui";
import { MEDIA_IMAGE_MAX_BYTES, MEDIA_IMAGE_MAX_PIXELS, MEDIA_IMAGE_MAX_SIDE, MEDIA_IMAGE_RULE, MEDIA_IMAGE_TYPES, isMediaImageSortField, type MediaImageSortField } from "@rueisiang/db/media-cdn-fields";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, ButtonLink, Dialog, EmptyState, Field, FilterInput, FilterSelect, PageHeader, SegmentedControl, StatusBadge, TextField } from "../../ui/index.js";
import { removeMediaImage, renameMediaImage, retryMediaPurge, uploadMediaImage, useMediaImages, useMediaMutation, type MediaImage } from "./api.js";

import { ImageGrid, ImagePreview, ImageTable, MEDIA_SORT_OPTIONS, SyncBadge, dateLabel, imageLook, sizeLabel, type MediaSort, type MediaViewMode } from "./ImageViews.js";

function readViewMode(): MediaViewMode {
  try { return typeof window !== "undefined" && window.localStorage.getItem("media:image-view") === "list" ? "list" : "grid"; }
  catch { return "grid"; }
}
const VIEW_OPTIONS = [{ value: "list", label: "列表檢視", icon: "list" }, { value: "grid", label: "縮圖檢視", icon: "grid" }] as const;

function UploadDialog({ target, onClose, onSaved }: { target?: MediaImage; onClose: () => void; onSaved: (image: MediaImage) => void }) {
  const preview = useImageFilePreview({ types: MEDIA_IMAGE_TYPES, maxBytes: MEDIA_IMAGE_MAX_BYTES, maxPixels: MEDIA_IMAGE_MAX_PIXELS, maxSide: MEDIA_IMAGE_MAX_SIDE });
  const [name, setName] = useState(target?.name ?? "");
  const [dragging, setDragging] = useState(false);
  const [selectionError, setSelectionError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const mutation = useMediaMutation(uploadMediaImage);
  function choose(files: FileList | null) {
    if (mutation.isPending || !files?.length) return;
    if (files.length !== 1) { setSelectionError("請一次選擇一張圖片。"); return; }
    setSelectionError(""); mutation.reset();
    const file = files[0]!;
    if (preview.choose(file) && !target && !name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 120));
  }
  const fileError = selectionError || (preview.error === "resolution_exceeded" ? "圖片尺寸超出限制，請縮小後再上傳。" : preview.error ? "無法使用此圖片，請確認格式、檔案大小與檔案內容。" : "");
  return <Dialog manageFocus title={target ? "修改圖片" : "上傳圖片"} width={560} onClose={onClose} closeDisabled={mutation.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (preview.canSave && preview.file && name.trim()) mutation.mutate({ file: preview.file, name: name.trim(), target }, { onSuccess: ({ image }) => onSaved(image) });
  } }} actions={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>取消</Button><Button type="submit" tone={target ? "info" : "success"} icon={target ? "edit" : "cloudSync"} loading={mutation.isPending} loadingLabel="儲存並同步中…" disabled={!preview.canSave || !name.trim() || Boolean(selectionError)}>{target ? "儲存並同步 CDN" : "上傳圖片"}</Button></>}>
    {target ? <Alert>網址不會改變。儲存新圖片後，所有使用此連結的頁面都會顯示新圖片。</Alert> : <p className="text-sm text-muted">上傳後即可複製固定連結，放到 CYBERBIZ 官網或其他公開頁面。</p>}
    <div className={`relative grid min-h-56 place-items-center rounded-card border-2 border-dashed p-6 ${dragging ? "border-brand bg-brand-soft" : "border-line bg-canvas"}`} onDragOver={(event) => { event.preventDefault(); if (!mutation.isPending) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}>
      {preview.preview ? <img src={preview.preview} alt="待上傳圖片預覽" className={`${imageLook} max-h-64`} onError={preview.failPreview} /> : <div className="grid justify-items-center gap-3 text-muted"><Icon name="cloudSync" className="size-9" /><p>將圖片拖曳到這裡</p></div>}
      <div className="mt-4"><Button variant="secondary" icon="attachment" onClick={() => input.current?.click()} disabled={mutation.isPending}>{preview.file ? "重新選擇圖片" : "選擇圖片"}</Button></div>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} accept={MEDIA_IMAGE_TYPES.join(",")} aria-label="選擇圖片檔案" disabled={mutation.isPending} onChange={(event) => { choose(event.currentTarget.files); event.currentTarget.value = ""; }} />
    </div>
    <p className="text-xs leading-relaxed text-muted">{MEDIA_IMAGE_RULE}</p>
    {preview.status === "checking" ? <p role="status" className="text-sm text-muted">檢查圖片中…</p> : null}
    {fileError ? <Alert tone="danger">{fileError}</Alert> : null}
    {preview.file ? <p className="break-all text-xs text-muted">{preview.file.name} · {sizeLabel(preview.file.size)}</p> : null}
    {!target ? <TextField label="圖片名稱" required value={name} maxLength={120} disabled={mutation.isPending} onChange={(event) => setName(event.target.value)} placeholder="例如：官網首頁主視覺" /> : null}
    {mutation.error ? <Alert tone="danger">{mutation.error.message}</Alert> : null}
  </Dialog>;
}

function DeleteDialog({ image, onClose, onSaved }: { image: MediaImage; onClose: () => void; onSaved: (image: MediaImage) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const remove = useMediaMutation(removeMediaImage);
  return <Dialog manageFocus title="刪除這張圖片？" width={560} role="alertdialog" onClose={onClose} closeDisabled={remove.isPending} actions={<><Button autoFocus variant="secondary" onClick={onClose} disabled={remove.isPending}>取消</Button><Button variant="danger" icon="trash" disabled={!confirmed} loading={remove.isPending} onClick={() => remove.mutate(image, { onSuccess: ({ image: result }) => onSaved(result) })}>永久刪除圖片</Button></>}>
    <Alert tone="warning">這個動作無法復原。使用此網址的官網與其他頁面將無法顯示圖片，平台不會自動替你修改官網。</Alert>
    <p className="font-semibold">{image.name}</p><p className="break-all text-xs text-muted">{image.url}</p>
    <label className="flex items-start gap-3 rounded-field border border-line p-3 text-sm"><input type="checkbox" className="mt-1 size-4 accent-brand focus-visible:outline-2 focus-visible:outline-secondary" checked={confirmed} disabled={remove.isPending} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已確認官網及其他頁面不再使用此連結，並了解刪除後圖片將無法存取。</span></label>
    {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
  </Dialog>;
}

function ImageDetails({ image, local, canWrite, canDelete, onClose, onReplace, onDelete, onUpdated, onCopy }: { image: MediaImage; local: boolean; canWrite: boolean; canDelete: boolean; onClose: () => void; onReplace: () => void; onDelete: () => void; onUpdated: (image: MediaImage) => void; onCopy: (image: MediaImage) => void }) {
  const [name, setName] = useState(image.name);
  const rename = useMediaMutation(renameMediaImage);
  const retry = useMediaMutation(retryMediaPurge);
  const pending = rename.isPending || retry.isPending;
  return <Dialog manageFocus title="圖片資訊" width={760} onClose={onClose} closeDisabled={pending} actions={<><Button variant="secondary" onClick={onClose} disabled={pending}>關閉</Button>{canDelete && !image.deletedAt ? <Button variant="secondary" tone="danger" icon="trash" disabled={pending} onClick={onDelete}>刪除</Button> : null}{canWrite && !image.deletedAt ? <Button tone="info" icon="edit" disabled={pending} onClick={onReplace}>修改圖片</Button> : null}</>}>
    <div className="h-72 overflow-hidden rounded-field bg-canvas"><ImagePreview key={image.revision} image={image} /></div>
    <div className="flex flex-wrap items-center justify-between gap-2"><SyncBadge image={image} local={local} /><span className="text-xs text-muted">{image.width} × {image.height} px · {sizeLabel(image.size)} · {image.contentType.replace("image/", "").toUpperCase()}</span></div>
    <div className="flex items-end gap-2"><TextField className="flex-1" label="圖片名稱" value={name} maxLength={120} readOnly={!canWrite || Boolean(image.deletedAt)} disabled={pending} onChange={(event) => setName(event.target.value)} />{canWrite && !image.deletedAt ? <Button variant="secondary" tone="info" icon="save" size="lg" disabled={!name.trim() || name.trim() === image.name || pending} loading={rename.isPending} onClick={() => rename.mutate({ image, name: name.trim() }, { onSuccess: ({ image: result }) => onUpdated(result) })}>儲存名稱</Button> : null}</div>
    <Field label="固定公開連結" hint="修改圖片或名稱，都不會改變這個網址。"><div className="break-all rounded-field bg-canvas px-3 py-3 text-xs">{image.url}</div></Field>
    {!image.deletedAt ? <div className="flex flex-wrap gap-2"><Button variant="secondary" icon="copy" onClick={() => onCopy(image)}>複製連結</Button><ButtonLink variant="secondary" icon="external" href={image.url} target="_blank" rel="noopener noreferrer">開啟原圖</ButtonLink></div> : null}
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-xs"><dt className="text-muted">原始檔名</dt><dd className="break-all">{image.filename}</dd><dt className="text-muted">上傳時間</dt><dd>{dateLabel(image.createdAt)}</dd><dt className="text-muted">更新時間</dt><dd>{dateLabel(image.updatedAt)} · 第 {image.revision} 版</dd></dl>
    {image.purgePending ? <Alert tone="warning"><p>{image.purgeError ?? "圖片變更已儲存，CDN 快取仍待同步。"}</p>{canWrite ? <div className="mt-2"><Button variant="secondary" icon="sync" loading={retry.isPending} onClick={() => retry.mutate(image, { onSuccess: ({ image: result }) => onUpdated(result) })}>重試 CDN 同步</Button></div> : null}</Alert> : null}
    {rename.error || retry.error ? <Alert tone="danger">{(rename.error ?? retry.error)?.message}</Alert> : null}
  </Dialog>;
}

export function MediaImages() {
  usePageTitle("圖片素材庫");
  const { permissions } = useSession();
  const canRead = permissions.has("media:image:read");
  const canWrite = permissions.has("media:image:write");
  const canDelete = permissions.has("media:image:delete");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [type, setType] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<MediaViewMode>(readViewMode);
  const [sort, setSort] = useState<MediaSort>({ field: "updatedAt", direction: "desc" });
  const [upload, setUpload] = useState<{ target?: MediaImage } | null>(null);
  const [detail, setDetail] = useState<MediaImage | null>(null);
  const [deleting, setDeleting] = useState<MediaImage | null>(null);
  const query = useMediaImages({ search: deferredSearch, type, deleted, page, sort: sort.field, direction: sort.direction }, canRead);
  function changeSort(field: MediaImageSortField, direction: "asc" | "desc") { setSort({ field, direction }); setPage(1); }
  function changeView(value: string) {
    if (value !== "grid" && value !== "list") return;
    setView(value);
    try { window.localStorage.setItem("media:image-view", value); } catch { /* 儲存偏好失敗不影響切換。 */ }
  }
  const toast = useToast();
  const [notice, setNotice] = useState("");
  const current = query.data?.images.find((image) => image.id === detail?.id) ?? detail;
  async function copy(image: MediaImage) {
    try { await navigator.clipboard.writeText(image.url); toast.show("已複製圖片連結"); }
    catch { setDetail(image); setNotice("無法自動複製，請在圖片資訊中手動選取公開連結。"); }
  }
  function saved(image: MediaImage, action: string) {
    if (image.purgePending) setNotice(`${action}，但 CDN 快取尚未同步。請在圖片資訊中重試。`);
    else { setNotice(""); toast.show(query.data?.local ? `${action}（本機預覽）` : `${action}，CDN 已同步`); }
  }
  if (!canRead) return <div className="page"><PageHeader title="圖片素材庫" /><Alert tone="warning">你沒有檢視多媒體圖片的權限，請聯絡管理者。</Alert></div>;
  return <div className="page fills">
    <PageHeader title="圖片素材庫" actions={canWrite ? <Button icon="plus" tone="success" disabled={!query.data?.configured} onClick={() => setUpload({})}>上傳圖片</Button> : null} />
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted"><span className="inline-flex items-center gap-2"><Icon name="cloudSync" className="size-[18px]" />Cloudflare R2 · media</span><span className="inline-flex items-center gap-2"><Icon name="globe" className="size-[18px]" />{query.data?.cdnOrigin ?? "讀取 CDN 設定中…"}</span>{query.data?.local ? <StatusBadge tone="neutral">本機預覽 · 不連線正式 CDN</StatusBadge> : null}</div>
    {query.error ? <Alert tone="danger">{query.error.message}<div className="mt-2"><Button variant="secondary" onClick={() => void query.refetch()}>重新載入</Button></div></Alert> : null}
    {query.data && !query.data.configured ? <Alert tone="warning">尚未完成 R2 或 CDN 快取清除設定，目前僅能瀏覽圖片。請聯絡管理者完成設定後再上傳或變更。</Alert> : null}
    {notice ? <Alert tone="warning">{notice}</Alert> : null}
    <section aria-label="圖片素材" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card bg-paper shadow-panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-soft-line px-5 py-4">
        <FilterInput label="搜尋圖片" placeholder="搜尋圖片名稱或檔名" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="min-w-[160px] flex-1" />
        <FilterSelect label="圖片格式" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }} options={[{ label: "所有格式", value: "" }, { label: "JPEG", value: "image/jpeg" }, { label: "PNG", value: "image/png" }, { label: "WebP", value: "image/webp" }]} />
        <label className="inline-flex min-h-10 items-center gap-2 text-xs text-muted"><input type="checkbox" checked={deleted} className="size-4 accent-brand focus-visible:outline-2 focus-visible:outline-secondary" onChange={(event) => { setDeleted(event.target.checked); setPage(1); }} />包含已刪除</label>
        <div className="inline-flex items-center gap-2"><FilterSelect label="排序欄位" options={MEDIA_SORT_OPTIONS} value={sort.field} onChange={(event) => { if (isMediaImageSortField(event.target.value)) changeSort(event.target.value, sort.direction); }} /><Button variant="secondary" static icon={sort.direction === "desc" ? "chevronDown" : "chevronUp"} aria-label={sort.direction === "desc" ? "目前遞減排序，切換為遞增" : "目前遞增排序，切換為遞減"} onClick={() => changeSort(sort.field, sort.direction === "asc" ? "desc" : "asc")}>{sort.direction === "desc" ? "遞減" : "遞增"}</Button></div>
        <SegmentedControl aria-label="圖片檢視方式" skin="outlined" iconOnly options={VIEW_OPTIONS} value={view} onChange={changeView} className="ml-auto shrink-0" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col" aria-busy={query.isFetching}>
        {query.isPending ? <p role="status" className="py-16 text-center text-sm text-muted">載入圖片中…</p> : null}
        {query.data?.images.length === 0 ? <div className="grid justify-items-center gap-4 py-12"><Icon name="camera" className="size-10 text-muted" /><EmptyState>{search || type ? "找不到符合條件的圖片，試試其他名稱或格式。" : "還沒有圖片。上傳第一張素材，建立可重複使用的公開連結。"}</EmptyState>{search || type ? <Button variant="secondary" onClick={() => { setSearch(""); setType(""); setPage(1); }}>清除搜尋與篩選</Button> : null}</div> : null}
        {query.data && query.data.images.length > 0 ? view === "grid" ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><ImageGrid images={query.data.images} local={query.data.local} onDetails={setDetail} onCopy={(image) => void copy(image)} /></div> : <ImageTable images={query.data.images} local={query.data.local} sort={sort} onSort={changeSort} onDetails={setDetail} onCopy={(image) => void copy(image)} /> : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-soft-line px-5 py-3"><span className="text-xs tabular-nums text-muted">共 {query.data?.total ?? 0} 張圖片 · 第 {page} 頁</span><div className="flex gap-2"><Button variant="secondary" icon="chevronLeft" disabled={page <= 1 || query.isFetching} onClick={() => setPage((value) => value - 1)}>上一頁</Button><Button variant="secondary" icon="chevronRight" disabled={!query.data || page * query.data.pageSize >= query.data.total || query.isFetching} onClick={() => setPage((value) => value + 1)}>下一頁</Button></div></div>
    </section>
    {upload ? <UploadDialog target={upload.target} onClose={() => setUpload(null)} onSaved={(image) => { saved(image, upload.target ? "圖片已修改" : "圖片已上傳"); setUpload(null); setDetail(image); }} /> : null}
    {current && !upload && !deleting ? <ImageDetails key={current.id} image={current} local={Boolean(query.data?.local)} canWrite={canWrite && Boolean(query.data?.configured)} canDelete={canDelete && Boolean(query.data?.configured)} onClose={() => setDetail(null)} onReplace={() => setUpload({ target: current })} onDelete={() => setDeleting(current)} onUpdated={(image) => { setDetail(image); saved(image, "圖片資訊已更新"); }} onCopy={(image) => void copy(image)} /> : null}
    {deleting ? <DeleteDialog image={deleting} onClose={() => setDeleting(null)} onSaved={(image) => { saved(image, "圖片已刪除"); setDeleting(null); setDetail(null); }} /> : null}
  </div>;
}
