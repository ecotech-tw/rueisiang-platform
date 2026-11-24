import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { defaultUnless } from "./class-defaults.js";

export type PanelSkinName = "solid" | "glass";

const PanelSkinContext = createContext<PanelSkinName>("solid");

/** 面板的表面，跟 ButtonSkin、InputSkin、TableSkin 一樣由外層決定。portal 用 glass，員工 HR 站用 solid。 */
export function PanelSkin({ skin, children }: { skin: PanelSkinName; children: ReactNode }) {
  return <PanelSkinContext value={skin}>{children}</PanelSkinContext>;
}

/*
 * 自己拼標題列的面板（標題用一般的 h2、旁邊還有別的東西）用這兩個，
 * 標題列的間距與說明文字才會跟 Panel 的 title／description 一樣。
 */
// 標題列的對齊與下距；Panel 讓 headerClassName 整組取代這兩個值，自己拼的標題列直接用 PANEL_HEAD。
const HEAD_ITEMS = "items-start";
const HEAD_MARGIN = "mb-[22px]";
export const PANEL_HEAD = `flex justify-between gap-4 ${HEAD_ITEMS} ${HEAD_MARGIN}`;
export const PANEL_DESCRIPTION = "mt-1.5 mb-0 text-muted";
/** 實心面板的表面（不含內距）。自己要接觸控事件、不能用 Panel 的區塊才直接用。 */
export const PANEL_SURFACE = "rounded-[14px] border border-line bg-paper [box-shadow:var(--shadow-panel)]";

// 外框顏色另外給（BORDER），強調色才能整組換掉，不跟這裡的顏色比產生順序。
const SURFACE: Record<PanelSkinName, string> = {
  solid: "rounded-[14px] border bg-paper [box-shadow:var(--shadow-panel)]",
  /*
   * 玻璃面板：半透明底加模糊，前後兩層偽元素分別是光澤與內緣的光暈。
   * 表格直接貼在面板裡時，表格要撐到面板兩側（抵掉內距），光澤也拿掉，不然捲動的資料上會蓋一層霧。
   */
  glass: "relative isolate overflow-hidden rounded-[14px] border bg-paper/24 [box-shadow:var(--shadow-glass-panel)] [-webkit-backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-panel-sheen)] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-panel-glow)] after:content-[''] has-[>[data-table-scroll]]:before:content-none has-[>[data-table-scroll]]:after:content-none [&>[data-table-scroll]]:-mx-[22px]",
};

// 標題、說明與表格以外的子元素照內容高度；表格那一格吃掉剩下的高度、自己捲。
const GROWS = "[[data-page=fills]>&]:flex [[data-page=fills]>&]:min-h-0 [[data-page=fills]>&]:min-w-0 [[data-page=fills]>&]:flex-1 [[data-page=fills]>&]:flex-col [[data-page=fills]>&>[data-panel-head]]:flex-none [[data-page=fills]>&>[data-table-scroll]]:min-h-0 [[data-page=fills]>&>[data-table-scroll]]:flex-1 [[data-page=fills]>&>[data-table-scroll]]:overflow-auto";

/*
 * 面板接面板時隔 20px。直接放在 Page 底下的不管：頁面自己排區塊間距（flow 的 mt-5、手機緊湊的 mt-3.5、
 * fills 的 gap），兩邊都寫的話權重同為 0，誰贏要看產生順序。包在 :where() 裡權重是 0，
 * 呼叫端 className 給的 mt-* 一定贏。
 */
const ADJACENT_GAP = "[:where(:not([data-page])>[data-panel]+&)]:mt-5";

/*
 * 手機上列表面板拿掉自己的外框：頁面留邊、面板內距、卡片內距三層疊在一起，卡片只剩畫面的四分之三寬。
 * 面板的內容直接排在頁面上，搜尋列與分頁才能黏在畫面頂端／底端（overflow 不能裁切，sticky 才黏得住）。
 * --bleed 給搜尋列與分頁的背景帶撐到畫面兩側用，等於頁面的左右留邊；--page-pad-top／bottom 是捲動區的上下內距，
 * 黏住時抵掉它才貼齊畫面頂端與底端（三個變數都由 AppShell 的 main 與 HrMain 在手機上設定）。
 */
const GROWS_MOBILE = "max-[760px]:rounded-none max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:p-0 max-[760px]:[box-shadow:none] max-[760px]:[-webkit-backdrop-filter:none] max-[760px]:[backdrop-filter:none] max-[760px]:before:hidden max-[760px]:after:hidden max-[760px]:overflow-visible max-[760px]:[[data-page=fills]>&]:overflow-visible max-[760px]:[&>[data-table-scroll]]:mx-0 max-[760px]:[&>[data-panel-head]]:mb-3 max-[760px]:[--bleed:var(--page-gutter,16px)]";

const BORDER: Record<PanelSkinName, string> = { solid: "border-line", glass: "border-transparent" };

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * 只放版面用途。給了任何一個內距 utility（p-、px-、py-、pt-、pr-、pb-、pl-）就整組取代預設內距，
   * 只想改一邊也要把四邊寫齊。帶斷點的（max-[760px]:px-3）不算，會疊在預設值上面。
   */
  className?: string;
  /** 標題列的版面（對齊、換行、與內容的距離）。 */
  headerClassName?: string;
  /** 標題的字級、與圖示的間距。 */
  titleClassName?: string;
  /** 緊湊控制列與手機月曆減少 surface 內距，保留同一套圓角與深度。 */
  density?: "default" | "compact";
  /** attention：外框換成強調色，標出「這一塊要你處理」（例如待我審核）。 */
  tone?: "default" | "attention";
  /**
   * 放在 layout="fills" 的頁面裡時撐滿剩下的高度，裡面的表格自己捲（表頭跟著釘住）。
   * 頁面不是 fills 時沒有作用。className 給了 overflow- 就取代預設的 overflow-hidden。
   */
  grows?: boolean;
  id?: string;
  "aria-label"?: string;
  children: ReactNode;
}

/** 卡片、標題與右側 actions 的共用版型。 */
export function Panel({ title, description, actions, className = "", headerClassName = "", titleClassName = "", density = "default", tone = "default", grows = false, id, "aria-label": ariaLabel, children }: PanelProps) {
  const skin = useContext(PanelSkinContext);
  const hasHeader = title || description || actions;
  const padding = defaultUnless(className, "p[xytrbl]?-", density === "compact" ? "p-2" : "px-[22px] py-5");
  // 最後一個子元素不帶下外距，面板的下內距才是看得到的那一段。
  return (
    // data-panel 讓外層的版面規則認得出 Panel（fills 頁面的捲動、相鄰面板的間距、表格貼齊面板）。
    <section id={id} aria-label={ariaLabel} data-panel="" data-grows={grows ? "" : undefined} className={`${grows ? `${GROWS} ${GROWS_MOBILE} ${defaultUnless(className, "overflow-", "[[data-page=fills]>&]:overflow-hidden")}` : ""} ${SURFACE[skin]} ${tone === "attention" ? "border-secondary" : BORDER[skin]} ${padding} ${ADJACENT_GAP} [&>:last-child]:mb-0 ${className}`.trim()}>
      {hasHeader ? (
        <div data-panel-head="" className={`flex justify-between gap-4 ${defaultUnless(headerClassName, "items-", HEAD_ITEMS)} ${defaultUnless(headerClassName, "mb-", HEAD_MARGIN)} ${headerClassName}`.trim()}>
          <div>
            {title ? <h2 className={`mt-0 mx-0 ${defaultUnless(titleClassName, "mb-", "mb-0")} flex items-center ${defaultUnless(titleClassName, "gap-", "gap-2.5")} ${defaultUnless(titleClassName, "text-\\[", "text-[15px]")} ${titleClassName}`.trim()}>{title}</h2> : null}
            {description ? <p className={PANEL_DESCRIPTION}>{description}</p> : null}
          </div>
          {actions ? <div>{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const PageDescriptionsContext = createContext(true);

/**
 * 頁首要不要顯示說明文字，由 app 決定：portal 的頁首只留標題，說明藏起來（仍在 DOM 裡），AppShell 統一關掉；
 * 會跟著資料變、或使用者必須知道的資訊要寫在頁面上，不能只放在說明裡。
 */
export function PageDescriptions({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <PageDescriptionsContext value={visible}>{children}</PageDescriptionsContext>;
}

const MobilePageTitleContext = createContext(true);

/**
 * 手機上要不要顯示頁首的大標題。HRIS 的頁首已經寫了目前在哪一頁，手機上再一行 h1 只是佔掉內容的高度；
 * 關掉時 h1 只是看不見（sr-only），讀螢幕的人仍然聽得到這頁叫什麼。
 */
export function MobilePageTitle({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <MobilePageTitleContext value={visible}>{children}</MobilePageTitleContext>;
}

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * 這頁的主要新增鈕。桌機排在 actions 後面；手機改成浮在右下角（跟員工 HR 站的申請鈕一樣），
   * 不佔頁首一列，捲到哪裡都按得到。用 portal 掛到 body：頁面轉場的 transform 會讓 fixed 失效。
   */
  fab?: ReactNode;
  /**
   * 只放版面用途。標題與說明的字級用 `[&_h1]:…`、`[&_p]:…` 調整。
   * 下距與對齊的預設值依斷點分開取代：給了 mb-／items- 只換掉桌機的，
   * 給了 max-[760px]:mb-／max-[760px]:items- 只換掉手機的。
   */
  className?: string;
}

/**
 * 頁面層級的標題；有 actions 時切成左右兩欄，放不下就讓動作鈕換到下一行靠右。手機上標題縮小、跟下面隔 12px，
 * 動作鈕與標題垂直置中（標題變一行，置中才不會看起來掉下去）。
 */
export function PageHeader({ title, description, actions, fab, className = "" }: PageHeaderProps) {
  const showDescription = useContext(PageDescriptionsContext);
  const showMobileTitle = useContext(MobilePageTitleContext);
  // portal 只在瀏覽器掛：伺服器端（測試的 renderToStaticMarkup）不支援 portal。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // 同時有 actions 時排成一列並留間距（呼叫端的 actions 不一定自帶容器）；手機上 fab 那格藏起來，只剩 actions。
  const inlineActions = fab ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}<span className="max-[760px]:hidden">{fab}</span></div> : actions;
  // 手機上沒有大標題、說明也不顯示、動作鈕也只有浮動的那顆時，整個頁首只剩讀螢幕用的標題，不佔版面。
  const mobileEmpty = !showMobileTitle && !actions && !(description && showDescription);
  // defaultUnless 只認開頭或空白後面的字，所以 "mb-" 對不到 "max-[760px]:mb-"，兩個斷點各算各的。
  const margin = `${defaultUnless(className, "mb-", "mb-0")} ${defaultUnless(className, "max-\\[760px\\]:mb-", "max-[760px]:mb-3")}`;
  const align = `${defaultUnless(className, "items-", "items-start")} ${defaultUnless(className, "max-\\[760px\\]:items-", "max-[760px]:items-center")}`;
  // 動作鈕不縮，標題最少留 12rem；放不下就讓動作鈕換到標題下一行靠右，不要把標題擠成一字一行（排班月曆有五顆鈕）。
  const row = inlineActions ? `flex flex-wrap justify-between gap-4 max-[760px]:gap-3 ${align} [&>:first-child]:min-w-[min(100%,12rem)] [&>:first-child]:flex-[1_1_0%] [&>:last-child]:ml-auto [&>:last-child]:flex-none` : "";
  return (
    // data-page-head 讓頁面版面認得出頁首（fills 頁裡不伸縮、返回列底下的距離）。
    <header data-page-head="" className={`${margin} ${row} ${mobileEmpty ? "max-[760px]:sr-only" : ""} ${className}`.replace(/\s+/g, " ").trim()}>
      <div>
        <h1 className={`mt-0 mx-0 mb-1 text-[24px] max-[760px]:text-[20px] ${showMobileTitle ? "" : "max-[760px]:sr-only"}`.trim()}>{title}</h1>
        {description ? <p className={`m-0 text-muted ${showDescription ? "" : "hidden"}`.trim()}>{description}</p> : null}
      </div>
      {inlineActions ? <div>{inlineActions}</div> : null}
      {/*
        * 固定在右下角，分頁列在有浮動鈕的頁面右側留出它的位置（Material 的「FAB 嵌在底部列」）：內容短、分頁列
        * 停在中間時也不會跟它疊到。批次選取時底部是「已選取…」的操作列，浮動鈕先收起來；
        * 開著對話框時也收起來，不然會從玻璃對話框後面透出來、疊在按鈕旁邊。
        * 位置照員工 HR 站：右緣與底緣都避開 iPhone 的安全區。
        */}
      {fab && mounted ? createPortal(
        <div data-fab="" className="pointer-events-none fixed inset-0 z-21 hidden max-[760px]:block max-[760px]:[body:has([data-selection-bar])_&]:hidden max-[760px]:[body:has([aria-modal=true])_&]:hidden">
          <div className="pointer-events-auto absolute right-[max(16px,env(safe-area-inset-right))] bottom-[calc(8px+env(safe-area-inset-bottom))]">{fab}</div>
        </div>,
        document.body,
      ) : null}
    </header>
  );
}
