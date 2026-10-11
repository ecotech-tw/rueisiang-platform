import { useRef, useState } from "react";
import { HR_EMPLOYEE_PHOTO_FILE_ERRORS, HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS, HR_EMPLOYEE_PHOTO_TYPES } from "@rueisiang/db/hr-profile-fields";
import { useImageFilePreview } from "@rueisiang/ui";
import { API_BASE_URL } from "../../config.js";
import { Alert, Button, ConfirmDialog } from "../../ui/index.js";
import { useHrWrite, type Profile } from "./api.js";

export function selfPhotoUrl(photo: Profile["photo"]) {
  return photo ? `${API_BASE_URL}/hr/me/photo?v=${encodeURIComponent(photo.id)}` : "";
}
export function HrProfileAvatar({ name, photo, preview, onPreviewError, onPhotoError }: { name: string; photo: Profile["photo"]; preview?: string; onPreviewError?: () => void; onPhotoError?: () => void }) {
  const [failed, setFailed] = useState("");
  const savedSrc = selfPhotoUrl(photo);
  const src = preview ?? savedSrc;
  return <span className="hr-profile-avatar">{src && (preview || failed !== src) ? <img src={src} crossOrigin={preview ? undefined : "use-credentials"} alt={`${name}的大頭貼${preview ? "預覽" : ""}`} onError={() => { if (preview) onPreviewError?.(); else { setFailed(src); onPhotoError?.(); } }} /> : <span aria-hidden="true">{Array.from(name)[0] ?? "員"}</span>}</span>;
}

export function HrProfilePhoto({ profile }: { profile: Profile }) {
  const input = useRef<HTMLInputElement>(null);
  const closeRemove = useRef<((afterClose?: () => void) => void) | null>(null);
  const photoFile = useImageFilePreview(HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS);
  const [expectedRevision, setExpectedRevision] = useState(profile.employee.revision);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failedPhoto, setFailedPhoto] = useState("");
  const [feedback, setFeedback] = useState("");
  const upload = useHrWrite();
  const remove = useHrWrite();
  const pending = upload.isPending || remove.isPending;
  const canWrite = profile.employee.employmentStatus === "active" && profile.employee.userStatus === "active";
  const name = profile.employee.legalName || profile.employee.displayName || "員工";
  const savedSrc = selfPhotoUrl(profile.photo);
  const fileError = photoFile.error ? HR_EMPLOYEE_PHOTO_FILE_ERRORS[photoFile.error] : "";
  function cancel() { photoFile.clear(); upload.reset(); if (input.current) input.current.value = ""; }
  return <div className="hr-profile-photo-control">
    <div className="hr-profile-avatar-wrap">
      <HrProfileAvatar name={name} photo={profile.photo} preview={photoFile.file ? photoFile.preview : undefined} onPreviewError={photoFile.failPreview} onPhotoError={() => setFailedPhoto(savedSrc)} />
      {canWrite ? <>
        <input ref={input} type="file" accept={HR_EMPLOYEE_PHOTO_TYPES.join(",")} aria-label="選擇我的大頭貼" hidden disabled={pending} onChange={(event) => {
          if (photoFile.choose(event.target.files?.[0])) { setExpectedRevision(profile.employee.revision); setFeedback(""); upload.reset(); }
          else event.target.value = "";
        }} />
        <Button variant="icon" className="hr-profile-avatar-action" icon="camera" aria-label={photoFile.file ? "重新選擇大頭貼" : "更新大頭貼"} disabled={pending} onClick={() => input.current?.click()} />
      </> : null}
    </div>
    {photoFile.file ? <div className="hr-profile-photo-edit">
      <p>{photoFile.status === "checking" ? "正在檢查照片…" : photoFile.status === "invalid" ? "所選照片無法使用，請重新選擇。" : "預覽照片，儲存後才會更新。"}</p>
      <p className="muted">JPEG、PNG 或 WebP 靜態照片，最大 5 MB、800 萬像素、單邊 8192 px；不支援多影像 JPEG。</p>
      <div className="hr-profile-photo-actions">
        <Button variant="secondary" disabled={pending} onClick={cancel}>取消</Button>
        <Button icon="check" loading={upload.isPending} disabled={remove.isPending || !photoFile.canSave} onClick={() => {
          const formData = new FormData(); formData.set("file", photoFile.file!); formData.set("revision", String(expectedRevision));
          upload.mutate({ path: "/me/photo", method: "POST", formData }, { onSuccess: () => { cancel(); setFeedback("大頭貼已更新"); } });
        }}>儲存</Button>
      </div>
      {upload.error ? <Alert tone="danger">{`${upload.error.message} 所選照片仍保留；請取消並重新整理後再試。`}</Alert> : null}
    </div> : profile.photo && canWrite ? <Button variant="link" className="hr-profile-photo-remove" icon="trash" disabled={pending} onClick={() => { setExpectedRevision(profile.employee.revision); remove.reset(); setFeedback(""); setConfirmRemove(true); }}>移除大頭貼</Button> : null}
    {fileError ? <Alert tone="danger">{fileError}</Alert> : null}
    {failedPhoto === savedSrc && savedSrc ? <p className="hr-profile-photo-note">照片載入失敗，請重新整理或重新上傳。</p> : null}
    {feedback ? <p role="status" className="hr-profile-photo-feedback">{feedback}</p> : null}
    {!canWrite ? <p className="hr-profile-photo-note">目前無法更新大頭貼，請聯絡管理者。</p> : null}
    {confirmRemove ? <ConfirmDialog title="移除我的大頭貼？" confirmLabel="移除大頭貼" pending={remove.isPending} closeRequestRef={closeRemove} onCancel={() => setConfirmRemove(false)} onConfirm={() => remove.mutate({ path: "/me/photo", method: "DELETE", values: { revision: expectedRevision } }, { onSuccess: () => { (closeRemove.current ?? ((afterClose?: () => void) => { setConfirmRemove(false); afterClose?.(); }))(() => setFeedback("大頭貼已移除")); } })}><p>移除目前的照片，不影響其他員工資料。</p>{remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}</ConfirmDialog> : null}
  </div>;
}
