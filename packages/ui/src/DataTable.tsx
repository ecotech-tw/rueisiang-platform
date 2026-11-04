import { createContext, useContext, type ReactNode, type TableHTMLAttributes } from "react";
import { defaultUnless } from "./class-defaults.js";

export type TableSkinName = "solid" | "glass";

const TableSkinContext = createContext<TableSkinName>("solid");

/** 釘住的表頭要用哪一種底，跟 ButtonSkin、InputSkin 一樣由外層決定。HRIS 用 glass。 */
export function TableSkin({ skin, children }: { skin: TableSkinName; children: ReactNode }) {
  return <TableSkinContext value={skin}>{children}</TableSkinContext>;
}

/*
 * 格子的預設外觀寫在 table 上，用後代選擇器套到每一格。
 *
 * 後代那一段一律包在 :where() 裡，讓預設值的權重壓到最低（只剩這個 class 本身）。
 * 這樣呼叫端在 className 寫 `[&_td]:align-top` 一定贏，不必靠 Tailwind 的產生順序。
 * 首欄、末欄、第一列這些例外多一個偽類，權重高一級；要改它們就寫
 * `[&_td:first-child]:pl-0` 這種同樣帶偽類的寫法。
 *
 * 寬度 760px 以下的表格會變成一列一張卡片，那一段還在 components.css（.data-table），
 * 所以格子的高度、內距、分隔線與 hover 只在桌機生效，不要跟卡片的規則打架。
 */
const TABLE_BASE = [
  "data-table min-[761px]:w-full",
  "[&_:where(th)]:h-14 [&_:where(th)]:px-4 [&_:where(th)]:text-left [&_:where(th)]:align-middle [&_:where(th)]:text-[14px] [&_:where(th)]:font-medium [&_:where(th)]:whitespace-nowrap [&_:where(th)]:text-muted",
  "[&_:where(th):first-child]:pl-6 [&_:where(th):last-child]:pr-6",
  "min-[761px]:[&_:where(td)]:text-[14px] min-[761px]:[&_:where(td)]:h-[52px] min-[761px]:[&_:where(td)]:px-4 min-[761px]:[&_:where(td)]:py-3.5 min-[761px]:[&_:where(td)]:border-t min-[761px]:[&_:where(td)]:border-soft-line min-[761px]:[&_:where(td)]:align-middle",
  "min-[761px]:[&_:where(td):first-child]:pl-6 min-[761px]:[&_:where(td):last-child]:pr-6",
  "min-[761px]:[&_:where(tbody_tr):first-child_:where(td)]:border-t-0",
  "[&_:where(tbody_tr)]:transition-[background-color] [&_:where(tbody_tr)]:duration-120 [&_:where(tbody_tr)]:ease-out motion-reduce:[&_:where(tbody_tr)]:transition-none",
  "min-[761px]:[&_:where(tbody_tr):hover]:bg-brand/4",
  // 數字欄要贏過 th 的靠左，所以不包 :where()。
  "[&_.numeric]:tabular-nums min-[761px]:[&_.numeric]:text-right",
  // 表頭只有放在捲動外框裡才釘住；對話框裡沒有外框的表跟著對話框捲。
  "[.table-scroll>&_:where(thead_th)]:sticky [.table-scroll>&_:where(thead_th)]:top-0 [.table-scroll>&_:where(thead_th)]:z-2",
].join(" ");

const STICKY_HEADER_SKIN: Record<TableSkinName, string> = {
  solid: "[.table-scroll>&_:where(thead_th)]:bg-paper [.table-scroll>&_:where(thead_th)]:[box-shadow:inset_0_-1px_0_var(--color-line)]",
  /*
   * 玻璃表頭：資料從底下捲過去時要看得出是浮在上面的一層。兩端圓角，但表格直接貼在
   * 面板裡時面板本身已經有圓角與邊界，表頭就不再自己圓。
   */
  glass: "[.table-scroll>&_:where(thead_th)]:bg-paper/82 [.table-scroll>&_:where(thead_th)]:[-webkit-backdrop-filter:blur(14px)_saturate(165%)] [.table-scroll>&_:where(thead_th)]:[backdrop-filter:blur(14px)_saturate(165%)] [.table-scroll>&_:where(thead_th)]:[box-shadow:var(--shadow-glass-table-head)] [.table-scroll>&_:where(thead_th):first-child]:rounded-tl-xl [.table-scroll>&_:where(thead_th):last-child]:rounded-tr-xl [.panel>.table-scroll>&_:where(thead_th):first-child]:rounded-tl-none [.panel>.table-scroll>&_:where(thead_th):last-child]:rounded-tr-none",
};

interface DataTableProps extends Omit<TableHTMLAttributes<HTMLTableElement>, "children" | "className"> {
  children: ReactNode;
  /** 改格子預設值用 `[&_td]:…`；整張表的寬度、版面也放這裡。 */
  className?: string;
  containerClassName?: string;
  /**
   * false：不包捲動外框，只輸出 table。用在對話框這種外層已經在捲的地方，
   * 或外框裡還要放別的東西（手機版的全選列）時，由呼叫端自己包 `.table-scroll`。
   */
  scroll?: boolean;
  /** 只有這張表要跟外層 TableSkin 不一樣時才給。 */
  skin?: TableSkinName;
}

/** 資料表：捲動外框、表頭、格子與數字欄的外觀；欄位與排序行為由各頁負責。 */
export function DataTable({ children, className = "", containerClassName = "", scroll = true, skin, ...tableProps }: DataTableProps) {
  const contextSkin = useContext(TableSkinContext);
  const table = (
    <table {...tableProps} className={`${defaultUnless(className, "border-separate", "border-collapse")} ${TABLE_BASE} ${STICKY_HEADER_SKIN[skin ?? contextSkin]} ${className}`.trim()}>
      {children}
    </table>
  );
  if (!scroll) return table;
  return <div className={`table-scroll ${containerClassName}`.trim()}>{table}</div>;
}
