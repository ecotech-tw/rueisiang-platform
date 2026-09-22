import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.js";

/**
 * 操作完成的提示。
 *
 * 為什麼需要：管理頁的每個動作（指派角色、停用、刪除、存檔）成功之後畫面上
 * 只有資料默默變了一下。改的是自己那一列還看得出來，改別人的、或是在對話框裡
 * 按完就關掉的，等於什麼回饋都沒有——人會不確定到底有沒有成功，於是再按一次。
 *
 * 失敗仍要在表單原地留下可處理的錯誤訊息；浮動提示只負責補一個即時回饋，
 * 讓使用者知道剛剛那次操作已經被系統拒絕，不必猜是不是沒有按到。
 */

export type ToastTone = "success" | "info" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  /** 顯示一則提示。同一句話連續送出時會取代前一則，不會疊成一整排。 */
  show: (message: string, tone?: ToastTone, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** 停留時間。夠讀完一句話，又不會擋著下一個動作。 */
const DISMISS_AFTER_MS = 3200;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = "success", action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((list) => [
        // 同一句話取代前一則：連按三次「儲存」不該疊出三張一模一樣的提示。
        ...list.filter((toast) => toast.message !== message),
        { id, tone, message, action },
      ]);
      setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        * aria-live="polite"：讀螢幕的人也要知道操作成功了，但不要打斷他當下
        * 正在讀的東西。role="status" 讓它被當成狀態而不是警告。
        */}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.tone}`} key={toast.id}>
            <Icon name={toast.tone === "success" ? "check" : toast.tone === "danger" ? "block" : "info"} />
            <span>{toast.message}</span>
            {toast.action ? <button type="button" className="toast-action" onClick={() => { toast.action?.onClick(); dismiss(toast.id); }}>{toast.action.label}</button> : null}
            <button type="button" className="toast-close" onClick={() => dismiss(toast.id)} aria-label="關閉提示">
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * 沒有 Provider 時回一個什麼都不做的實作，而不是丟錯。
 *
 * 登入頁與設定密碼頁不在 AppShell 底下，硬要它們也包一層 Provider 只是為了
 * 讓一個它們根本用不到的功能不炸掉——那不划算。
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { show: () => {} };
}
