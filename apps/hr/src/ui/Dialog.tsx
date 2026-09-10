import { useId, type FormHTMLAttributes, type ReactNode } from "react";
import { Button } from "./Button.js";

export interface DialogProps {
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
  const backdropClassNameValue = ["modal-backdrop", backdropClassName].filter(Boolean).join(" ");
  const bodyClassNameValue = ["modal-body", bodyClassName].filter(Boolean).join(" ");
  const content = (
    <>
      {children}
      {actions ? <div className="modal-actions">{actions}</div> : null}
    </>
  );

  return (
    <div
      className={backdropClassNameValue}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && onClose && !closeDisabled) onClose();
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
              onClick={onClose}
              disabled={closeDisabled}
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
  );
}
