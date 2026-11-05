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

/*
 * 一張提示是一塊玻璃卡：底色、內緣、圖示、操作鍵都跟著 --toast-tint 走，換語氣只換這一個變數。
 * 動畫的 keyframes（toast-in）在 components.css。
 */
const TINT: Record<ToastTone, string> = {
  success: "[--toast-tint:var(--color-ok)]",
  info: "[--toast-tint:var(--color-info)]",
  danger: "[--toast-tint:var(--color-brand-dark)]",
};
const TOAST = "pointer-events-auto relative isolate flex max-w-[min(400px,calc(100vw-32px))] items-center gap-2.5 overflow-hidden rounded-[18px] border border-paper/56 py-3 pr-3 pl-3.5 text-[13.5px] text-(--toast-tint) [background:linear-gradient(135deg,--alpha(var(--toast-tint)/16%),transparent_42%),--alpha(var(--color-paper)/58%)] [box-shadow:0_1px_0_--alpha(var(--color-paper)/72%)_inset,0_0_0_1px_--alpha(var(--color-paper)/18%)_inset,0_-12px_28px_--alpha(var(--toast-tint)/7%)_inset,0_18px_46px_--alpha(var(--color-ink)/20%)] [-webkit-backdrop-filter:blur(18px)_saturate(180%)_contrast(106%)] [backdrop-filter:blur(18px)_saturate(180%)_contrast(106%)] animate-[toast-in_220ms_cubic-bezier(0.2,0,0,1)_both] motion-reduce:animate-none before:absolute before:inset-0 before:-z-1 before:[background:radial-gradient(circle_at_16px_0,--alpha(var(--color-paper)/68%),transparent_38%)] max-[760px]:max-w-none";
const TOAST_BUTTON = "flex-none border-0 [font:inherit] transition-[background-color,color,scale] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary active:scale-96";

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
        *
        * 桌機釘右下角，手機改成從上方滑下來——手機的右下角是拇指區，浮一張卡片在那裡會擋住正要按的東西。
        * z-70 要比對話框（60）高：很多提示就是從對話框裡的操作發出來的，同層的話後出現的 backdrop
        * 會蓋住它，變成「按了沒有任何回饋」。
        */}
      <div className="pointer-events-none fixed right-6 bottom-6 z-70 grid justify-items-end gap-2.5 max-[760px]:top-3 max-[760px]:right-3 max-[760px]:bottom-auto max-[760px]:left-3 max-[760px]:justify-items-stretch" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`${TOAST} ${TINT[toast.tone]}`} key={toast.id}>
            <Icon
              name={toast.tone === "success" ? "check" : toast.tone === "danger" ? "block" : "info"}
              className="size-7 flex-none rounded-full bg-(--toast-tint)/12 p-[5px] text-(--toast-tint) [box-shadow:inset_0_1px_0_--alpha(var(--color-paper)/50%)]"
            />
            <span className="min-w-0 flex-1 font-bold text-ink">{toast.message}</span>
            {toast.action ? <button type="button" className={`${TOAST_BUTTON} rounded-full bg-(--toast-tint)/10 px-2.5 py-1.5 text-(--toast-tint) hover:bg-(--toast-tint)/18`} onClick={() => { toast.action?.onClick(); dismiss(toast.id); }}>{toast.action.label}</button> : null}
            <button type="button" className={`${TOAST_BUTTON} grid size-[26px] place-items-center rounded-[50%] bg-transparent p-0 text-muted hover:bg-(--toast-tint)/10 hover:text-(--toast-tint)`} onClick={() => dismiss(toast.id)} aria-label="關閉提示">
              <Icon name="close" className="size-3.5" />
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
