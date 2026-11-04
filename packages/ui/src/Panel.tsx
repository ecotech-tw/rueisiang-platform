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
export const PANEL_HEAD = "flex items-start justify-between gap-4 mb-[22px]";
export const PANEL_DESCRIPTION = "mt-1.5 mb-0 text-muted";
/** 實心面板的表面（不含內距）。自己要接觸控事件、不能用 Panel 的區塊才直接用。 */
export const PANEL_SURFACE = "rounded-[14px] border border-line bg-paper shadow-panel";

// 外框顏色另外給（BORDER），強調色才能整組換掉，不跟這裡的顏色比產生順序。
const SURFACE: Record<PanelSkinName, string> = {
  solid: "rounded-[14px] border bg-paper shadow-panel",
  /*
   * 玻璃面板：半透明底加模糊，前後兩層偽元素分別是光澤與內緣的光暈。
   * 表格直接貼在面板裡時，表格要撐到面板兩側（抵掉內距），光澤也拿掉，不然捲動的資料上會蓋一層霧。
   */
  glass: "relative isolate overflow-hidden rounded-[14px] border bg-paper/24 [box-shadow:var(--shadow-glass-panel)] [-webkit-backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-panel-sheen)] before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-panel-glow)] after:content-[''] has-[>.table-scroll]:before:content-none has-[>.table-scroll]:after:content-none [&>.table-scroll]:-mx-[22px]",
};

const BORDER: Record<PanelSkinName, string> = { solid: "border-line", glass: "border-transparent" };

interface PanelProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 只放版面用途。給了 p-／px-／py- 就整組取代預設內距。 */
  className?: string;
  /** 標題列的版面（對齊、換行、與內容的距離）。 */
  headerClassName?: string;
  /** 標題的字級、與圖示的間距。 */
  titleClassName?: string;
  /** 緊湊控制列與手機月曆減少 surface 內距，保留同一套圓角與深度。 */
  density?: "default" | "compact";
  /** attention：外框換成強調色，標出「這一塊要你處理」（例如待我審核）。 */
  tone?: "default" | "attention";
  id?: string;
  "aria-label"?: string;
  children: ReactNode;
}

/** 卡片、標題與右側 actions 的共用版型。 */
export function Panel({ title, description, actions, className = "", headerClassName = "", titleClassName = "", density = "default", tone = "default", id, "aria-label": ariaLabel, children }: PanelProps) {
  const skin = useContext(PanelSkinContext);
  const hasHeader = title || description || actions;
  const padding = defaultUnless(className, "p[xytrbl]?-", density === "compact" ? "p-2" : "px-[22px] py-5");
  // 最後一個子元素不帶下外距，面板的下內距才是看得到的那一段。
  return (
    // data-panel 讓外層的版面規則認得出 Panel（.page.fills 的捲動、相鄰面板的間距、表格貼齊面板）。
    <section id={id} aria-label={ariaLabel} data-panel="" className={`${SURFACE[skin]} ${tone === "attention" ? "border-secondary" : BORDER[skin]} ${padding} [&>:last-child]:mb-0 ${className}`.trim()}>
      {hasHeader ? (
        <div data-panel-head="" className={`flex justify-between gap-4 ${defaultUnless(headerClassName, "items-", "items-start")} ${defaultUnless(headerClassName, "mb-", "mb-[22px]")} ${headerClassName}`.trim()}>
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

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** 頁面層級的標題；有 actions 時自動切成左右兩欄。 */
export function PageHeader({ title, description, actions, className = "" }: PageHeaderProps) {
  return (
    <header className={`page-head${actions ? " page-head-row" : ""} ${className}`.trim()}>
      <div>
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div>{actions}</div> : null}
    </header>
  );
}
