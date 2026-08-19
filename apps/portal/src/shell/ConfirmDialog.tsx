import { useEffect, useRef } from "react";

/**
 * 確認對話框。取代 `window.confirm`。
 *
 * 為什麼不用瀏覽器內建的：它長得跟系統警示一樣、擋住整個分頁、文字不能排版，
 * 而且在有些瀏覽器上會顯示網址當標題——看起來像釣魚視窗而不是我們的介面。
 * 真正要人停下來想一秒的動作（刪帳號、刪角色），提示本身要講得清楚後果，
 * 那需要粗體、分段、跟一顆紅色的確認鈕，內建的一個都給不了。
 *
 * 沿用 .modal-* 那一套樣式，跟系統其他對話框長得一樣。
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = "確定",
  cancelLabel = "取消",
  tone = "danger",
  pending = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  /*
   * 焦點落在「取消」而不是「確定」。這個對話框幾乎只用在破壞性動作上，
   * 一個順手的 Enter 不該就把帳號刪了。
   */
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, pending]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        className="modal-card confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div className="modal-head">
          <h2 id="confirm-title">{title}</h2>
        </div>

        <div className="modal-body confirm-body">{children}</div>

        <div className="modal-actions">
          <button
            type="button"
            className="ghost-button"
            ref={cancelRef}
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={tone === "danger" ? "primary-button danger" : "primary-button"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "處理中…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
