import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import type { DialogCloseRef } from "./dialog-context.js";

export interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  closeRequestRef?: DialogCloseRef;
}

/**
 * 確認對話框。取代 `window.confirm`，讓高風險動作保留清楚的後果說明、焦點順序與退場流程。
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
  closeRequestRef,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const internalCloseRequestRef = useRef<DialogCloseRef["current"]>(null);
  const dialogCloseRequestRef = closeRequestRef ?? internalCloseRequestRef;

  // 破壞性確認預設把焦點放在取消，避免順手按 Enter 就確認動作。
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    /*
     * Escape、Tab 繞圈、關掉後焦點還原都交給 Dialog 的 manageFocus（useModalFocus）。
     * 確認框常疊在另一個對話框上（例如獎金編輯裡的「解除最新版本」），只有最上層會處理按鍵；
     * 處理中（pending）時 closeDisabled 會擋住 Escape。
     */
    <Dialog
      manageFocus
      title={title}
      width={420}
      bodyLayout="grid gap-2 px-6 pb-1 [&_p]:m-0 [&_strong]:text-brand-dark"
      role="alertdialog"
      showClose={false}
      closeDisabled={pending}
      closeRequestRef={dialogCloseRequestRef}
      onClose={onCancel}
      actions={
        <>
          <Button
            variant="secondary"
            ref={cancelRef}
            onClick={onCancel}
            disabled={pending}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "處理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
