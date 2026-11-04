import { createContext, useContext, type ReactNode } from "react";
import { defaultUnless } from "./class-defaults.js";

export type PanelSkinName = "solid" | "glass";

const PanelSkinContext = createContext<PanelSkinName>("solid");

/** 面板的表面，跟 ButtonSkin、InputSkin、TableSkin 一樣由外層決定。HRIS 用 glass。 */
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
const GROWS = "[[data-page=fills]>&]:flex [[data-page=fills]>&]:min-h-0 [[data-page=fills]>&]:min-w-0 [[data-page=fills]>&]:flex-1 [[data-page=fills]>&]:flex-col [[data-page=fills]>&>[data-panel-head]]:flex-none [[data-page=fills]>&>.muted]:flex-none [[data-page=fills]>&>.table-note]:flex-none [[data-page=fills]>&>[data-table-scroll]]:min-h-0 [[data-page=fills]>&>[data-table-scroll]]:flex-1 [[data-page=fills]>&>[data-table-scroll]]:overflow-auto";

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
    <section id={id} aria-label={ariaLabel} data-panel="" data-grows={grows ? "" : undefined} className={`${grows ? `${GROWS} ${defaultUnless(className, "overflow-", "[[data-page=fills]>&]:overflow-hidden")}` : ""} ${SURFACE[skin]} ${tone === "attention" ? "border-secondary" : BORDER[skin]} ${padding} [&>:last-child]:mb-0 ${className}`.trim()}>
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
 * 頁首要不要顯示說明文字，由 app 決定：HRIS 管理介面的頁首只留標題，說明藏起來（仍在 DOM 裡）。
 */
export function PageDescriptions({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <PageDescriptionsContext value={visible}>{children}</PageDescriptionsContext>;
}

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * 只放版面用途。標題與說明的字級用 `[&_h1]:…`、`[&_p]:…` 調整。
   * 給了 mb-（含 max-[760px]:mb-）或 items-（含 max-[760px]:items-）就整組取代預設值。
   */
  className?: string;
}

/**
 * 頁面層級的標題；有 actions 時切成左右兩欄。手機上標題縮小、跟下面隔 12px，
 * 動作鈕與標題垂直置中（標題變一行，置中才不會看起來掉下去）。
 */
export function PageHeader({ title, description, actions, className = "" }: PageHeaderProps) {
  const showDescription = useContext(PageDescriptionsContext);
  const margin = defaultUnless(className, "(max-\\[760px\\]:)?mb-", "mb-0 max-[760px]:mb-3");
  const row = actions ? `flex justify-between gap-4 max-[760px]:gap-3 ${defaultUnless(className, "(max-\\[760px\\]:)?items-", "items-start max-[760px]:items-center")} [&>:last-child]:flex-none` : "";
  return (
    // data-page-head 讓頁面版面認得出頁首（fills 頁裡不伸縮、返回列底下的距離）。
    <header data-page-head="" className={`${margin} ${row} ${className}`.replace(/\s+/g, " ").trim()}>
      <div>
        <h1 className="mt-0 mx-0 mb-1 text-[24px] max-[760px]:text-[20px]">{title}</h1>
        {description ? <p className={`m-0 text-muted ${showDescription ? "" : "hidden"}`.trim()}>{description}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
