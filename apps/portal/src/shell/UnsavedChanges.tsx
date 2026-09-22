import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate, useResolvedPath, type NavLinkProps } from "react-router";
import { Button, Dialog } from "../ui/index.js";

/**
 * 「有未儲存的變更就先問一聲」。
 *
 * 為什麼不是 react-router 的 useBlocker：它第一行就要 data router
 * （`useDataRouterContext("useBlocker")`），而 portal 用的是 `<BrowserRouter>`，直接用會拋。
 * 換成 data router 要把 App.tsx 那七十幾條 `<Route>` 全部改寫成路由物件——為了一個提示
 * 去動路由地基不划算。
 *
 * 改成攔在導覽的入口：shell 的 NavLink／Link 換成 GuardedNavLink，自己處理點擊的
 * （進出 HRIS、登出）改用 useGuardedClick／useGuardedAction，頁面內會換掉草稿的操作
 * （切月、切年）自己呼叫 confirmLeave。
 *
 * **擋不住瀏覽器的上一頁／下一頁。** 那走的是 popstate，react-router 直接重繪，
 * document 沒有 unload 所以 beforeunload 也不會觸發。要擋得住只能換 data router。
 * 這是已知限制，不要在註解或 PR 裡宣稱涵蓋到它。
 */
interface Pending {
  resolve: (allow: boolean) => void;
  /** 開啟當下的訊息快照。不在 render 期間讀 ref：那在 concurrent 下不安全，而且開啟後就不會更新。 */
  message: string;
}

interface UnsavedChangesValue {
  isDirty: () => boolean;
  setDirty: (key: string, message: string | null) => void;
  /** 想離開時呼叫；回傳 true 代表可以走。沒有未儲存的變更就直接放行，不彈視窗。 */
  confirmLeave: () => Promise<boolean>;
  /** 使用者已經確認要走了：接下來那一次 document unload 不要再攔。 */
  beginLeaving: () => void;
}

const UnsavedChangesContext = createContext<UnsavedChangesValue | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  /*
   * 用 ref 存狀態而不是 useState：導覽攔截是在事件處理器裡「當下」讀這個值，
   * 用 state 的話每次髒／乾淨切換都要讓整個側邊欄跟著重繪一次。
   * 彈不彈視窗另外用 pending 這個 state 控制。
   */
  const dirtyRef = useRef<string | null>(null);
  const keysRef = useRef(new Map<string, string>());
  const [pending, setPending] = useState<Pending | null>(null);
  /** 與 pending 同步的 ref，讓「收掉上一個」這件事不必寫在 state updater 裡。 */
  const pendingRef = useRef<Pending | null>(null);
  /*
   * 正在照使用者的意思離開，beforeunload 這一趟要放行。
   *
   * 登出是 await fetch(POST) 之後換 document.location，那一行會再觸發一次我們自己掛的
   * beforeunload。使用者明明已經選過「離開並捨棄」，卻又被瀏覽器問一次——這次按「取消」
   * 的話 POST 早就成功了，結果正是 useGuardedAction 要防的那個狀態：cookie 已死、
   * 草稿還在畫面上、按儲存 401。
   */
  const leavingRef = useRef(false);

  const setDirty = useCallback((key: string, message: string | null) => {
    if (message === null) keysRef.current.delete(key);
    else keysRef.current.set(key, message);
    // 同時有兩個髒頁面是不可能的（一次只開一頁），取第一個就好。
    dirtyRef.current = keysRef.current.values().next().value ?? null;
  }, []);

  const isDirty = useCallback(() => dirtyRef.current !== null, []);
  const beginLeaving = useCallback(() => { leavingRef.current = true; }, []);

  const confirmLeave = useCallback(() => {
    const message = dirtyRef.current;
    if (!message) return Promise.resolve(true);
    /*
     * 已經有一個在等了就先讓它以「不要走」收掉。
     *
     * 直接覆蓋的話前一個 resolve 會遺失，它的 .then 永遠不跑——而 Dialog 沒有
     * focus trap，遮罩只擋指標事件，鍵盤使用者可以在對話框開著時 Tab 到後面的
     * 連結按 Enter，所以這條路真的走得到。
     *
     * 收尾寫在 updater 外面：StrictMode 下 React 會把 updater 呼叫兩次，副作用放進去
     * 現在只是僥倖沒事（resolve 第二次是 no-op），之後多一件不冪等的事就會跑兩次。
     */
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { resolve, message };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  /*
   * 關分頁與重新整理走不到上面的攔截，只能靠 beforeunload；它的提示文字由瀏覽器決定。
   * preventDefault 與 returnValue 兩個都要設：只設前者的話，在仍然只認舊訊號的瀏覽器上
   * 這張補網會安靜地不生效，而那正是它唯一存在的理由。
   */
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (leavingRef.current || !dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  /*
   * 換頁之後還開著的視窗要收掉。
   *
   * Dialog 由 provider 持有、掛在路由外，pathname 變了它不會自己消失。配上「擋不住
   * 瀏覽器上一頁」那條限制就有一條路：跳出視窗 → 按上一頁 → 頁面換了、dirty 也清了，
   * 但視窗還蓋在新頁面上講著舊訊息，按「離開並捨棄」還會把人 navigate 到當初那個連結。
   */
  const location = useLocation();
  useEffect(() => {
    pendingRef.current?.resolve(false);
    pendingRef.current = null;
    setPending(null);
  }, [location.pathname]);

  const answer = (allow: boolean) => {
    pending?.resolve(allow);
    pendingRef.current = null;
    setPending(null);
  };

  return <UnsavedChangesContext.Provider value={{ isDirty, setDirty, confirmLeave, beginLeaving }}>
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
      <p>{pending.message}</p>
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

/**
 * 想離開時先問一聲；沒有未儲存的東西就直接放行。
 *
 * 頁面內會把草稿換掉的操作（切月、切年）也要用它——那些不經過導覽，但結果一樣是
 * 草稿沒了，而且月份箭頭就在月曆正上方，比側邊選單更容易誤觸。
 */
export function useConfirmLeave() {
  return useUnsavedContext().confirmLeave;
}

/** 「現在有沒有未儲存的東西」的同步版本，給需要在事件處理器裡當下判斷的地方用。 */
export function useIsDirty() {
  return useUnsavedContext().isDirty;
}

/**
 * 這一次點擊該不該由我們接手。
 *
 * 修飾鍵與中鍵是開新分頁：原本那一頁還在，沒有任何東西會消失，攔下來反而把使用者
 * 想保住的那份草稿弄丟——他按 Ctrl 就是為了不要離開。
 */
function shouldIntercept(event: MouseEvent<HTMLAnchorElement>, dirty: boolean) {
  return dirty && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0;
}

/**
 * 會先問過再走的 NavLink。shell 裡的導覽一律用這個，不要直接用 NavLink。
 *
 * 乾淨時完全不介入：連 preventDefault 都不做，原本怎麼走就怎麼走。無條件攔下來再自己
 * navigate 的話，進出 HRIS 的 View Transition 會因為 defaultPrevented 而整個不播。
 */
export function GuardedNavLink({ onClick, ...props }: NavLinkProps) {
  const confirmLeave = useConfirmLeave();
  const isDirty = useIsDirty();
  const navigate = useNavigate();
  const location = useLocation();
  const resolved = useResolvedPath(props.to, { relative: props.relative });
  // 點的就是現在這一頁時不必問：沒有東西會卸載，也沒有任何東西被捨棄，問了等於說謊。
  const samePage = resolved.pathname === location.pathname;
  return <NavLink {...props} onClick={(event) => {
    if (samePage || !shouldIntercept(event, isDirty())) {
      onClick?.(event);
      return;
    }
    event.preventDefault();
    void confirmLeave().then((allow) => {
      if (!allow) return;
      onClick?.(event);
      // 走 react-router 自己的導覽，並把呼叫端給的導覽選項一起帶過去。
      void navigate(props.to, { replace: props.replace, state: props.state, relative: props.relative, preventScrollReset: props.preventScrollReset });
    });
  }} />;
}

/**
 * 自己處理點擊的導覽（進出 HRIS 有 View Transition）用這一支包住原本的邏輯。
 *
 * 乾淨時直接跑 run()，行為完全不變；髒的時候先問，確認離開後才跑 run()——
 * run 裡面通常還包含關選單之類的收尾，不跑的話選單會開著疊在對話框底下。
 */
export function useGuardedClick() {
  const confirmLeave = useConfirmLeave();
  const isDirty = useIsDirty();
  const navigate = useNavigate();
  return useCallback((event: MouseEvent<HTMLAnchorElement>, to: string, run: () => void) => {
    if (!shouldIntercept(event, isDirty())) { run(); return; }
    event.preventDefault();
    void confirmLeave().then((allow) => {
      if (!allow) return;
      run();
      void navigate(to);
    });
  }, [confirmLeave, isDirty, navigate]);
}

/**
 * 不是由點擊導覽觸發的離開（登出那顆按鈕）用這一支。
 *
 * 登出特別要在**打 API 之前**問：logout() 是先 POST 再換 document.location，
 * 等到 beforeunload 跳出來時 session 已經被砍掉了，使用者選「留下」只會停在一個
 * cookie 已死的頁面上，草稿還在畫面上但按儲存會 401，而且救不回來。
 */
export function useGuardedAction() {
  const { confirmLeave, beginLeaving } = useUnsavedContext();
  return useCallback(async (run: () => void | Promise<void>) => {
    if (!(await confirmLeave())) return false;
    // 確認過了才標記：這一趟換 document.location 不要再被 beforeunload 攔第二次。
    beginLeaving();
    await run();
    return true;
  }, [confirmLeave, beginLeaving]);
}
