import { useCallback, useContext, useEffect, useId, useRef, useState, type FormHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.js";
import { DialogContext, DialogScopeContext, type DialogCloseRef } from "./dialog-context.js";

interface DialogProps {
  title: ReactNode;
  titleMeta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  /** 卡片寬度（px）；手機上一律縮成可用寬度。 */
  width?: DialogWidth;
  /** 只放版面用途；寬度用 width。 */
  className?: string;
  /**
   * 內容區的版面，整組取代預設的 `grid gap-4 px-6 pb-2`，所以 display、間距、左右與下方內距要自己寫齊。
   * 不是疊加：同一個屬性有兩個 utility 時，誰贏看 Tailwind 的產生順序。
   */
  bodyLayout?: string;
  /** 邊距收窄，把高度留給內容；給內容自己會捲的大表格預覽用。 */
  compact?: boolean;
  onClose?: () => void;
  /** 非 actions 的非同步 callback 要關閉 Dialog 時，也必須走同一個退場流程。 */
  closeRequestRef?: DialogCloseRef;
  closeDisabled?: boolean;
  showClose?: boolean;
  closeLabel?: string;
  role?: "dialog" | "alertdialog";
  /**
   * 需要保留在全頁容器內的沉浸式頁面可關閉 portal；一般 dialog 應維持 portal。
   * 關掉時遮罩是 absolute inset-0，蓋住最近一個有定位的祖先，所以外層容器要自己有定位。
   */
  portal?: boolean;
  formProps?: Omit<FormHTMLAttributes<HTMLFormElement>, "children" | "className">;
}

const DIALOG_EXIT_DURATION_MS = 180;

// 寬度寫成完整的 class 字串，Tailwind 才掃得到；同一個屬性只留一個 utility，不靠產生順序決勝負。
const DIALOG_WIDTH = {
  420: "w-[min(420px,100%)]",
  560: "w-[min(560px,100%)]",
  680: "w-[min(680px,100%)]",
  720: "w-[min(720px,100%)]",
  760: "w-[min(760px,100%)]",
  780: "w-[min(780px,100%)]",
  820: "w-[min(820px,100%)]",
  860: "w-[min(860px,100%)]",
  900: "w-[min(900px,100%)]",
  980: "w-[min(980px,100%)]",
} as const;

export type DialogWidth = keyof typeof DIALOG_WIDTH;

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
  width = 560,
  className = "",
  bodyLayout = "grid gap-4 px-6 pb-2",
  compact = false,
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

  /*
   * 遮罩是 position: fixed，但只要祖先有 transform、filter 或 backdrop-filter，
   * 那個祖先就會變成 fixed 的定位基準，對話框會被關進頁面容器裡（HRIS 的玻璃效果與
   * 頁面轉場都會造成這件事）。掛到 body 底下就不受版面結構影響。
   *
   * 站台的語意色與玻璃效果是寫在範圍 class 底下的（管理介面 .hr-system、員工 HR 站
   * .hr-module-self），移出去之後會全部失效——核准會落回品牌紅，跟旁邊的駁回分不出來。
   * 所以用一層 contents 的殼把範圍補回來，範圍由站台透過 DialogScope 提供。
   * 不能直接加在遮罩上——.hr-system 自己帶著 grid-template-rows 與 align-content: stretch，
   * 會把遮罩的垂直置中蓋掉。
   */
  const scopeClass = useContext(DialogScopeContext);
  /*
   * footer 是 card 或 form 的最後一層，不跟著內容捲走，也用實色底，捲動的內容不會透到按鈕下面。
   * compact 的內容不會捲到 footer 底下，footer 就不建立疊層，陰影壓在內容後面。
   */
  const actionFooter = actions ? (
    <div className={`mt-2 flex flex-none justify-end gap-2 border-t border-t-soft-line bg-paper px-6 pt-4 pb-5 shadow-dialog-footer ${compact ? "static max-[620px]:px-4" : "relative z-1"}`}>
      {actions}
    </div>
  ) : null;
  const body = <div className={`min-h-0 min-w-0 flex-auto overflow-x-hidden overflow-y-auto *:min-w-0 ${bodyLayout}`}>{children}</div>;

  const dialog = (
    <DialogContext.Provider value={{ onClose, requestClose: () => requestClose() }}>
      <div
        // 不 portal 時留在全頁容器裡，只蓋住那個容器，並疊在容器裡其他浮層之上。
        className={`${portal ? "fixed z-60" : "absolute z-100"} inset-0 grid place-items-center ${compact ? "p-4 max-[620px]:p-2" : "p-6"} [transition-property:background-color] duration-180 ease-[ease-out] motion-reduce:animate-none motion-reduce:[transition:none] ${closing ? "pointer-events-none animate-none bg-ink/0" : "animate-dialog-backdrop-enter bg-ink/42"}`}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) requestClose();
        }}
      >
        <div className={scopeClass ? `contents ${scopeClass}` : "contents"}>
        <div
          className={`flex origin-center flex-col overflow-hidden rounded-[28px] bg-paper shadow-dialog ${DIALOG_WIDTH[width]} ${compact ? "max-h-[calc(100dvh-32px)] max-[620px]:max-h-[calc(100dvh-16px)]" : "max-h-[calc(100vh-48px)]"} [transition-property:opacity,filter,transform] duration-180 ease-[ease-out] motion-reduce:animate-none motion-reduce:[transition:none] ${closing ? "animate-none opacity-0 [filter:blur(4px)] [transform:translateY(8px)_scale(.98)]" : "animate-dialog-card-enter opacity-100 [filter:blur(0)] [transform:translateY(0)_scale(1)]"} ${className}`.trim()}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
        >
        <div className="flex items-center justify-between gap-3 px-6 pt-[22px] pb-3.5">
          {titleMeta ? (
            <div>
              <h2 id={titleId} className="m-0 text-[20px]">{title}</h2>
              <p className="muted">{titleMeta}</p>
            </div>
          ) : (
            <h2 id={titleId} className="m-0 text-[20px]">{title}</h2>
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
          <form {...formProps} className="flex min-h-0 min-w-0 flex-auto flex-col">
            {body}
            {actionFooter}
          </form>
        ) : (
          body
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
