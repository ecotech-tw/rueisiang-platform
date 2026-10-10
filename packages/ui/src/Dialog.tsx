import { useCallback, useContext, useEffect, useId, useRef, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.js";
import { DialogContext, DialogScopeContext, type DialogCloseRef } from "./dialog-context.js";

interface DialogProps {
  title: ReactNode;
  titleMeta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  backdropClassName?: string;
  bodyClassName?: string;
  onClose?: () => void;
  /** 非 actions 的非同步 callback 要關閉 Dialog 時，也必須走同一個退場流程。 */
  closeRequestRef?: DialogCloseRef;
  closeDisabled?: boolean;
  showClose?: boolean;
  closeLabel?: string;
  role?: "dialog" | "alertdialog";
  /** 需要保留在全頁容器內的沉浸式頁面可關閉 portal；一般 dialog 應維持 portal。 */
  portal?: boolean;
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className">;
}

const DIALOG_EXIT_DURATION_MS = 180;

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
  closeRequestRef,
  closeDisabled = false,
  showClose = true,
  closeLabel = "關閉",
  role = "dialog",
  portal = true,
  formProps,
}: DialogProps) {
  const titleId = `dialog-title-${useId().replace(/:/g, "")}`;
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const closeAfterRef = useRef<(() => void) | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * 元件是由 page 的條件 render 控制，直接呼叫 onClose 會讓 DOM 立刻卸載，
   * CSS 還沒來得及播退場就消失。先留在畫面上跑完 180ms，再交回 page 收掉。
   */
  const requestClose = useCallback((force = false, afterClose?: () => void) => {
    const close = onCloseRef.current;
    if (closingRef.current || (!force && closeDisabled) || !close) return;

    closingRef.current = true;
    closeAfterRef.current = afterClose ?? null;
    const reducedMotion = typeof window === "undefined"
      || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reducedMotion) {
      closeAfterRef.current = null;
      close();
      afterClose?.();
      return;
    }

    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      const finish = closeAfterRef.current;
      closeAfterRef.current = null;
      onCloseRef.current?.();
      finish?.();
    }, DIALOG_EXIT_DURATION_MS);
  }, [closeDisabled]);

  // 非同步成功 callback 可能在 mutation 的 isPending 尚未翻成 false 時執行，
  // 所以 ref 是明確的程式關閉路徑，仍播退場但不受手動關閉鎖定影響。
  const forceClose = useCallback((afterClose?: () => void) => requestClose(true, afterClose), [requestClose]);

  useEffect(() => {
    if (!closeRequestRef) return;
    closeRequestRef.current = forceClose;
    return () => {
      if (closeRequestRef.current === forceClose) closeRequestRef.current = null;
    };
  }, [closeRequestRef, forceClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeAfterRef.current = null;
  }, []);

  const cardClassName = ["modal-card", className, closing ? "closing" : ""].filter(Boolean).join(" ");
  /*
   * 遮罩是 position: fixed，但只要祖先有 transform、filter 或 backdrop-filter，
   * 那個祖先就會變成 fixed 的定位基準，對話框會被關進頁面容器裡（HRIS 的玻璃效果與
   * 頁面轉場都會造成這件事）。掛到 body 底下就不受版面結構影響。
   *
   * 站台的語意色與玻璃效果是寫在範圍 class 底下的（管理介面 .hr-system、員工 HR 站
   * .hr-module-self），移出去之後會全部失效——核准會落回品牌紅，跟旁邊的駁回分不出來。
   * 所以用一層 display: contents 的殼把範圍補回來，範圍由站台透過 DialogScope 提供。
   * 不能直接加在遮罩上——.hr-system 自己帶著 grid-template-rows 與 align-content: stretch，
   * 會把遮罩的垂直置中蓋掉。
   */
  const scopeClass = useContext(DialogScopeContext);
  const backdropClassNameValue = ["modal-backdrop", backdropClassName, closing ? "closing" : ""].filter(Boolean).join(" ");
  const bodyClassNameValue = ["modal-body", bodyClassName].filter(Boolean).join(" ");
  const actionFooter = actions ? <div className="modal-actions">{actions}</div> : null;

  const dialog = (
    <DialogContext.Provider value={{ onClose, requestClose: () => requestClose() }}>
      <div
        className={backdropClassNameValue}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        <div className={scopeClass ? `modal-scope ${scopeClass}` : "modal-scope"}>
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
              onClick={() => requestClose()}
              disabled={closeDisabled || closing}
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
    </DialogContext.Provider>
  );

  // 測試用 renderToStaticMarkup 時沒有 document，直接回傳原本的結構。
  return portal && typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}

/** 目前所在的對話框範圍。給「自己不在範圍裡、但要替範圍裡的頁面開對話框」的元件記下來用。 */
export function useDialogScope() {
  return useContext(DialogScopeContext);
}

/** 放在站台版面的根節點：這個範圍裡開的對話框 portal 出去後會帶回 `className`。 */
export function DialogScope({ className, children }: { className: string; children: ReactNode }) {
  return <DialogScopeContext.Provider value={className}>{children}</DialogScopeContext.Provider>;
}
