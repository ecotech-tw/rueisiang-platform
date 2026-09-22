import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { NavLink, useNavigate, type NavLinkProps } from "react-router";
import { Button, Dialog } from "../ui/index.js";

/**
 * 「有未儲存的變更就先問一聲」。
 *
 * 為什麼不是 react-router 的 useBlocker：它第一行就要 data router
 * （`useDataRouterContext("useBlocker")`），而 portal 用的是 `<BrowserRouter>`，直接用會拋。
 * 換成 data router 要把 App.tsx 那七十幾條 `<Route>` 全部改寫成路由物件——為了一個提示
 * 去動路由地基不划算。
 *
 * 改成攔在導覽的入口。頁面自己不做導覽，能離開的路全部集中在 shell 的那幾個
 * NavLink 與 useNavigate，所以只要那裡換成 GuardedNavLink／useGuardedNavigate 就涵蓋得到。
 * 漏掉的只有「自己改網址列」，而那本來就是刻意要離開。
 */
interface UnsavedChangesValue {
  /** 目前有沒有未儲存的變更。導覽元件用它決定要不要先問。 */
  dirtyRef: { current: string | null };
  setDirty: (key: string, message: string | null) => void;
  /** 想離開時呼叫；回傳 true 代表可以走。沒有未儲存的變更就直接放行，不彈視窗。 */
  confirmLeave: () => Promise<boolean>;
}

const UnsavedChangesContext = createContext<UnsavedChangesValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  /*
   * 用 ref 存狀態而不是 useState：導覽攔截是在事件處理器裡「當下」讀這個值，
   * 用 state 的話 GuardedNavLink 每次髒／乾淨切換都要跟著重繪一次，而它掛在側邊欄，
   * 等於每改一個欄位整個選單重畫。彈不彈視窗另外用 pending 這個 state 控制。
   */
  const dirtyRef = useRef<string | null>(null);
  const keysRef = useRef(new Map<string, string>());
  const [pending, setPending] = useState<((allow: boolean) => void) | null>(null);

  const setDirty = useCallback((key: string, message: string | null) => {
    if (message === null) keysRef.current.delete(key);
    else keysRef.current.set(key, message);
    // 同時有兩個髒頁面是不可能的（一次只開一頁），取第一個就好。
    dirtyRef.current = keysRef.current.values().next().value ?? null;
  }, []);

  const confirmLeave = useCallback(() => {
    if (!dirtyRef.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => { setPending(() => resolve); });
  }, []);

  /*
   * 關分頁、重新整理與瀏覽器的上一頁走不到上面的攔截，只能靠 beforeunload。
   * 它的提示文字由瀏覽器決定，我們給不了自己的句子——所以它是補網，不是主要手段。
   */
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const answer = (allow: boolean) => {
    pending?.(allow);
    setPending(null);
  };

  return <UnsavedChangesContext.Provider value={{ dirtyRef, setDirty, confirmLeave }}>
    {children}
    {pending ? <Dialog
      title="還有未儲存的變更"
      onClose={() => answer(false)}
      closeLabel="留在這一頁"
      actions={<>
        <Button variant="secondary" onClick={() => answer(false)}>留下來</Button>
        <Button className="danger" onClick={() => answer(true)}>離開並捨棄</Button>
      </>}
    >
      {/* 講清楚捨棄的是什麼，不要只說「有未儲存的變更」——那句話沒有幫使用者做決定。 */}
      <p>{dirtyRef.current}</p>
      <p className="muted">離開之後這些變更就找不回來了。</p>
    </Dialog> : null}
  </UnsavedChangesContext.Provider>;
}

function useUnsavedContext() {
  const value = useContext(UnsavedChangesContext);
  if (!value) throw new Error("UnsavedChangesProvider 沒有包住這個元件。");
  return value;
}

/**
 * 頁面用這一支說「我現在有沒有未儲存的東西」。
 *
 * message 會直接顯示在確認視窗裡，所以寫得具體一點（「已排入 20 天尚未儲存」勝過「有變更」）。
 * 元件卸載時自動註銷，不必自己收尾。
 */
export function useUnsavedChanges(dirty: boolean, message: string) {
  const { setDirty } = useUnsavedContext();
  const key = useId();
  useEffect(() => {
    setDirty(key, dirty ? message : null);
    return () => setDirty(key, null);
  }, [dirty, message, key, setDirty]);
}

/** 導覽元件用這一支問「可以走嗎」。 */
export function useConfirmLeave() {
  return useUnsavedContext().confirmLeave;
}

/**
 * 「現在有沒有未儲存的東西」的同步版本。
 *
 * 導覽要先用它判斷該不該介入：沒有未儲存的東西就完全不碰那次點擊，讓原本的行為
 * （NavLink 的預設導覽、進出 HRIS 的 View Transition）照舊跑。無條件 preventDefault
 * 再自己 navigate 的話，轉場會因為 defaultPrevented 而整個不播。
 */
export function useIsDirty() {
  const { dirtyRef } = useUnsavedContext();
  return useCallback(() => dirtyRef.current !== null, [dirtyRef]);
}

/**
 * 會先問過再走的 NavLink。shell 裡的導覽一律用這個，不要直接用 NavLink。
 *
 * 只攔一般的左鍵點擊：Ctrl／Cmd／中鍵是開新分頁，原本那一頁還在，沒有東西會消失。
 */
export function GuardedNavLink({ onClick, ...props }: NavLinkProps) {
  const confirmLeave = useConfirmLeave();
  const isDirty = useIsDirty();
  const navigate = useNavigate();
  return <NavLink {...props} onClick={(event) => {
    // 乾淨的時候完全不介入：連 preventDefault 都不做，原本怎麼走就怎麼走。
    if (!isDirty() || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      onClick?.(event);
      return;
    }
    event.preventDefault();
    void confirmLeave().then((allow) => {
      if (!allow) return;
      onClick?.(event);
      // 走 react-router 自己的導覽；手動動 history 的話 BrowserRouter 不一定收得到。
      void navigate(props.to);
    });
  }} />;
}

/**
 * 自己處理點擊的導覽（進出 HRIS 那兩處有 View Transition）用這一支包住原本的邏輯。
 *
 * 乾淨時直接跑 run()，轉場照舊；髒的時候才擋下來問，確認離開後才補跑導覽——
 * 但那一次沒有轉場，因為 View Transition 必須在使用者手勢的同一個 tick 裡啟動。
 */
export function useGuardedClick() {
  const confirmLeave = useConfirmLeave();
  const isDirty = useIsDirty();
  const navigate = useNavigate();
  return useCallback((event: MouseEvent<HTMLAnchorElement>, to: string, run: () => void) => {
    if (!isDirty()) { run(); return; }
    event.preventDefault();
    void confirmLeave().then((allow) => { if (allow) void navigate(to); });
  }, [confirmLeave, isDirty, navigate]);
}
