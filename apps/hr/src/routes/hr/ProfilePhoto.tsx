import { useRef, useState } from "react";
import { HR_EMPLOYEE_PHOTO_FILE_ERRORS, HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS, HR_EMPLOYEE_PHOTO_TYPES } from "@rueisiang/db/hr-profile-fields";
import { useImageFilePreview } from "@rueisiang/ui";
import { API_BASE_URL } from "../../config.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, ConfirmDialog, Panel } from "../../ui/index.js";
import { useHrWrite, type Profile } from "./api.js";

export function selfPhotoUrl(photo: Profile["photo"]) {
  return photo ? `${API_BASE_URL}/hr/me/photo?v=${encodeURIComponent(photo.id)}` : "";
}
export function HrProfileAvatar({ name, photo }: { name: string; photo: Profile["photo"] }) {
  const [failed, setFailed] = useState("");
  const src = selfPhotoUrl(photo);
  return <span className="hr-profile-avatar">{src && failed !== src ? <img src={src} crossOrigin="use-credentials" alt={`${name}的大頭貼`} onError={() => setFailed(src)} /> : <span aria-hidden="true">{Array.from(name)[0] ?? "員"}</span>}</span>;
}

export function HrProfilePhoto({ profile }: { profile: Profile }) {
  const input = useRef<HTMLInputElement>(null);
  const closeRemove = useRef<((afterClose?: () => void) => void) | null>(null);
  const photoFile = useImageFilePreview(HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS);
  const [expectedRevision, setExpectedRevision] = useState(profile.employee.revision);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failed, setFailed] = useState("");
  const [feedback, setFeedback] = useState("");
  const upload = useHrWrite();
  const remove = useHrWrite();
  const pending = upload.isPending || remove.isPending;
  const canWrite = profile.employee.employmentStatus === "active" && profile.employee.userStatus === "active";
  const name = profile.employee.legalName || profile.employee.displayName || "員工";
  const savedSrc = selfPhotoUrl(profile.photo);
  const src = photoFile.file ? photoFile.preview : savedSrc && failed !== savedSrc ? savedSrc : "";
  const fileError = photoFile.error ? HR_EMPLOYEE_PHOTO_FILE_ERRORS[photoFile.error] : "";
  function cancel() { photoFile.clear(); upload.reset(); if (input.current) input.current.value = ""; }
  return <Panel className="hr-profile-panel hr-self-photo-panel" title={<><Icon name="person" /><span>我的大頭貼</span></>} description="與 HR 管理端共用同一張照片，只有你本人與全平台 HR 管理者可查看。">
    <div className="hr-self-photo">
      <div className="hr-self-photo-preview">{src ? <img src={src} crossOrigin={photoFile.file ? undefined : "use-credentials"} alt={`${name}的大頭貼${photoFile.file ? "預覽" : ""}`} onError={() => { if (photoFile.file) photoFile.failPreview(); else setFailed(savedSrc); }} /> : <Icon name="person" />}</div>
      <div className="hr-self-photo-content">
        <p>{photoFile.file ? photoFile.status === "checking" ? "正在檢查照片…" : photoFile.status === "invalid" ? "所選照片無法使用，請重新選擇。" : "預覽照片，儲存後才會更新。" : profile.photo ? failed === savedSrc ? "照片載入失敗，請重新整理或重新上傳。" : "目前的員工大頭貼" : "尚未上傳大頭貼"}</p>
        <p className="muted">JPEG、PNG 或 WebP 靜態照片，最大 5 MB、800 萬像素、單邊 8192 px；不支援 MPF／MPO 多影像 JPEG。</p>
        {canWrite ? <>
          <input ref={input} type="file" accept={HR_EMPLOYEE_PHOTO_TYPES.join(",")} aria-label="選擇我的大頭貼" hidden disabled={pending} onChange={(event) => {
            if (photoFile.choose(event.target.files?.[0])) { setExpectedRevision(profile.employee.revision); setFeedback(""); upload.reset(); }
            else event.target.value = "";
          }} />
          <div className="hr-self-photo-actions">
            <Button variant="secondary" className="hr-action-update" icon="edit" disabled={pending} onClick={() => input.current?.click()}>{photoFile.file ? "重選照片" : profile.photo ? "更換大頭貼" : "上傳大頭貼"}</Button>
            {photoFile.file ? <>
              <Button variant="secondary" disabled={pending} onClick={cancel}>取消</Button>
              <Button className="hr-action-update" icon="check" loading={upload.isPending} disabled={remove.isPending || !photoFile.canSave} onClick={() => {
                const formData = new FormData(); formData.set("file", photoFile.file!); formData.set("revision", String(expectedRevision));
                upload.mutate({ path: "/me/photo", method: "POST", formData }, { onSuccess: () => { cancel(); setFeedback("大頭貼已更新"); } });
              }}>儲存大頭貼</Button>
            </> : profile.photo ? <Button variant="secondary" disabled={pending} onClick={() => { setExpectedRevision(profile.employee.revision); remove.reset(); setFeedback(""); setConfirmRemove(true); }}>移除大頭貼</Button> : null}
          </div>
        </> : <p className="muted">目前無法更新大頭貼，請聯絡管理者。</p>}
        {fileError || upload.error ? <Alert tone="danger">{fileError || `${upload.error?.message} 所選照片仍保留；請取消並重新整理後再試。`}</Alert> : null}
        {feedback ? <p role="status" className="hr-self-photo-feedback">{feedback}</p> : null}
      </div>
    </div>
    {confirmRemove ? <ConfirmDialog title="移除我的大頭貼？" confirmLabel="移除大頭貼" pending={remove.isPending} closeRequestRef={closeRemove} onCancel={() => setConfirmRemove(false)} onConfirm={() => remove.mutate({ path: "/me/photo", method: "DELETE", values: { revision: expectedRevision } }, { onSuccess: () => { (closeRemove.current ?? ((afterClose?: () => void) => { setConfirmRemove(false); afterClose?.(); }))(() => setFeedback("大頭貼已移除")); } })}><p>移除目前的照片，不影響其他員工資料。</p>{remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}</ConfirmDialog> : null}
  </Panel>;
}
