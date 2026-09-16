import { useId, type FormHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.js";

interface DialogProps {
  title: ReactNode;
  titleMeta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  backdropClassName?: string;
  bodyClassName?: string;
  onClose?: () => void;
  closeDisabled?: boolean;
  showClose?: boolean;
  closeLabel?: string;
  role?: "dialog" | "alertdialog";
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className">;
}

/**
 * 共用對話框外框。
 *
 * page 只提供標題、內容與 actions；遮罩、標題列、關閉按鈕、ARIA 語意與
 * form body 的結構集中在這裡，避免每個 dialog 各自複製一套容易漏改的 markup。
 */
export function Dialog({
  title,
  titleMeta,
  children,
  actions,
  className = "",
  backdropClassName = "",
  bodyClassName = "",
  onClose,
  closeDisabled = false,
  showClose = true,
  closeLabel = "關閉",
  role = "dialog",
  formProps,
}: DialogProps) {
  const titleId = `dialog-title-${useId().replace(/:/g, "")}`;
  const cardClassName = ["modal-card", className].filter(Boolean).join(" ");
  /*
   * 遮罩是 position: fixed，但只要祖先有 transform、filter 或 backdrop-filter，
   * 那個祖先就會變成 fixed 的定位基準，對話框會被關進頁面容器裡（HRIS 的玻璃效果與
   * 頁面轉場都會造成這件事）。掛到 body 底下就不受版面結構影響。
   *
   * HRIS 的樣式是用 .hr-system 開頭寫的，移出去之後會全部失效；所以在 HRIS 頁面開啟時
   * 用一層 display: contents 的殼把 hr-system 補回來。不能直接加在遮罩上——.hr-system
   * 自己帶著 grid-template-rows 與 align-content: stretch，會把遮罩的垂直置中蓋掉。
   */
  const inHrSystem = typeof document !== "undefined" && Boolean(document.querySelector(".hr-system"));
  const backdropClassNameValue = ["modal-backdrop", backdropClassName].filter(Boolean).join(" ");
  const bodyClassNameValue = ["modal-body", bodyClassName].filter(Boolean).join(" ");
  const actionFooter = actions ? <div className="modal-actions">{actions}</div> : null;

  const dialog = (
    <div
      className={backdropClassNameValue}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onClose && !closeDisabled) onClose();
      }}
    >
      <div className={inHrSystem ? "modal-scope hr-system" : "modal-scope"}>
      <div className={cardClassName} role={role} aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          {titleMeta ? (
            <div>
              <h2 id={titleId}>{title}</h2>
              <p className="muted">{titleMeta}</p>
            </div>
          ) : (
            <h2 id={titleId}>{title}</h2>
          )}
          {showClose && onClose ? (
            <Button
              variant="icon"
              icon="close"
              onClick={onClose}
              disabled={closeDisabled}
              title={closeLabel}
              aria-label={closeLabel}
            />
          ) : null}
        </div>

        {formProps ? (
          <form {...formProps} className="modal-form">
            <div className={bodyClassNameValue}>{children}</div>
            {actionFooter}
          </form>
        ) : (
          <div className={bodyClassNameValue}>{children}</div>
        )}
        {!formProps ? actionFooter : null}
      </div>
      </div>
    </div>
  );

  // 測試用 renderToStaticMarkup 時沒有 document，直接回傳原本的結構。
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
