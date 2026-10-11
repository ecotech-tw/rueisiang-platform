import { useEffect, useRef, useState } from "react";
import { HR_EMPLOYEE_PHOTO_FILE_ERRORS, HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS, HR_EMPLOYEE_PHOTO_TYPES } from "@rueisiang/db/hr-profile-fields";
import { useImageFilePreview } from "@rueisiang/ui";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button } from "../../ui/index.js";
import { useHrWrite } from "./api.js";

export function EmployeePhoto({ employmentId, revision, name, photo, canWrite, disabled, onBusyChange, onSaved }: { employmentId: string; revision: number; name: string; photo?: { id: string } | null; canWrite: boolean; disabled: boolean; onBusyChange: (busy: boolean) => void; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const closeRemove = useRef<((afterClose?: () => void) => void) | null>(null);
  const photoFile = useImageFilePreview(HR_EMPLOYEE_PHOTO_PREVIEW_LIMITS);
  const { file, preview, status: previewStatus } = photoFile;
  const validationError = photoFile.error ? HR_EMPLOYEE_PHOTO_FILE_ERRORS[photoFile.error] : "";
  const [expectedRevision, setExpectedRevision] = useState(revision);
  const [failedPhotoId, setFailedPhotoId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const upload = useHrWrite();
  const remove = useHrWrite();
  const toast = useToast();
  const pending = upload.isPending || remove.isPending;
  useEffect(() => { onBusyChange(pending || Boolean(file) || confirmRemove); }, [pending, file, confirmRemove, onBusyChange]);
  const cancel = () => { photoFile.clear(); upload.reset(); if (input.current) input.current.value = ""; };
  const choose = (selected?: File) => {
    if (photoFile.choose(selected)) { setExpectedRevision(revision); upload.reset(); }
    else if (input.current) input.current.value = "";
  };
  const src = file ? previewStatus === "valid" ? preview : "" : (photo && failedPhotoId !== photo.id ? `/api/hr/employees/${encodeURIComponent(employmentId)}/photo?v=${encodeURIComponent(photo.id)}` : "");
  return <div className="hr-employee-photo-block">
    <div className="hr-employee-photo-preview">{src ? <img src={src} alt={`${name}的大頭貼${file ? "預覽" : ""}`} onError={() => { if (file) photoFile.failPreview(); else if (photo) setFailedPhotoId(photo.id); }} /> : <Icon name="person" />}</div>
    <div className="hr-employee-photo-content">
      <p>{file ? previewStatus === "checking" ? "正在檢查照片…" : previewStatus === "invalid" ? "所選照片無法使用，請重新選擇。" : "預覽照片，儲存後才會更新員工檔案。" : photo ? failedPhotoId === photo.id ? "照片載入失敗，請重新整理或重新上傳。" : "員工檔案照片" : "尚未上傳大頭貼"}</p>
      <p className="muted">JPEG、PNG 或 WebP 靜態照片，最大 5 MB、800 萬像素、單邊 8192 px；照片僅供本人與全平台 HR 管理者查看。</p>
      {canWrite ? <>
        <input ref={input} type="file" accept={HR_EMPLOYEE_PHOTO_TYPES.join(",")} aria-label="選擇員工大頭貼" hidden disabled={disabled || pending} onChange={(event) => choose(event.target.files?.[0])} />
        <div className="hr-employee-photo-actions">
          <Button variant="secondary" className="hr-action-update" icon="edit" disabled={disabled || pending} onClick={() => input.current?.click()}>{file ? "重選照片" : photo ? "更換大頭貼" : "上傳大頭貼"}</Button>
          {file ? <><Button variant="secondary" disabled={disabled || pending} onClick={cancel}>取消</Button><Button className="hr-action-update" icon="check" loading={upload.isPending} disabled={disabled || remove.isPending || !photoFile.canSave} onClick={() => {
            const formData = new FormData(); formData.set("file", file); formData.set("revision", String(expectedRevision));
            upload.mutate({ path: `/employees/${encodeURIComponent(employmentId)}/photo`, method: "POST", formData }, { onSuccess: () => { cancel(); toast.show("大頭貼已更新"); onSaved(); } });
          }}>儲存大頭貼</Button></> : photo ? <Button variant="secondary" disabled={disabled || pending} onClick={() => { remove.reset(); setExpectedRevision(revision); setConfirmRemove(true); }}>移除大頭貼</Button> : null}
        </div>
        {disabled && !pending ? <p className="muted">請先儲存或取消其他資料的編輯，再更新大頭貼。</p> : null}
      </> : null}
      {validationError || upload.error ? <Alert tone="danger">{validationError || `${upload.error?.message} 所選照片仍保留，請取消並重新整理後再試。`}</Alert> : null}
    </div>
    {confirmRemove ? <ConfirmDialog title="移除員工大頭貼？" confirmLabel="移除大頭貼" pending={remove.isPending} closeRequestRef={closeRemove} onCancel={() => setConfirmRemove(false)} onConfirm={() => remove.mutate({ path: `/employees/${encodeURIComponent(employmentId)}/photo`, method: "DELETE", values: { revision: expectedRevision } }, { onSuccess: () => { (closeRemove.current ?? ((afterClose?: () => void) => { setConfirmRemove(false); afterClose?.(); }))(onSaved); toast.show("大頭貼已移除"); } })}><p>移除 {name} 的目前照片，不影響其他員工資料。</p>{remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}</ConfirmDialog> : null}
  </div>;
}
