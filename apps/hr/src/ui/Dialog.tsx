import { useCallback, useEffect, useId, useRef, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button.js";
import { DialogContext, type DialogCloseRef } from "./dialog-context.js";

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
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className">;
}

const DIALOG_EXIT_DURATION_MS = 180;

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
   * 父層通常用條件 render 控制 Dialog；直接呼叫 onClose 會讓 DOM 在退場樣式生效前卸載。
   * 先保留 180ms，讓遮罩與卡片完成退場，再交回父層移除。
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
  const backdropClassNameValue = ["modal-backdrop", backdropClassName, closing ? "closing" : ""].filter(Boolean).join(" ");
  const bodyClassNameValue = ["modal-body", bodyClassName].filter(Boolean).join(" ");
  const content = (
    <>
      {children}
      {actions ? <div className="modal-actions">{actions}</div> : null}
    </>
  );

  return (
    <DialogContext.Provider value={{ onClose, requestClose: () => requestClose() }}>
      <div
        className={backdropClassNameValue}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
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
            <form {...formProps} className={bodyClassNameValue}>
              {content}
            </form>
          ) : (
            <div className={bodyClassNameValue}>{children}</div>
          )}
          {!formProps && actions ? <div className="modal-actions">{actions}</div> : null}
        </div>
      </div>
    </DialogContext.Provider>
  );
}
