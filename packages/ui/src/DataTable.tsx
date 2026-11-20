import { createContext, useContext, type ReactNode, type TableHTMLAttributes } from "react";
import { defaultUnless } from "./class-defaults.js";

/**
 * 表格的捲動外框：桌機橫向捲；手機變成卡片、不必橫捲，讓整頁照常往下滑。
 * 外框裡還要放別的東西、不能用 DataTable 的外框時，自己的 div 帶 data-table-scroll 與這組 class。
 */
export const TABLE_SCROLL = "overflow-x-auto max-[760px]:overflow-x-visible";

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
 * 這樣呼叫端在 className 寫 `[&_td]:align-top` 就蓋得過一般格子，不必靠 Tailwind 的產生順序。
 * 有些預設值權重比較高，要用同一層級的寫法才蓋得掉：
 * - 首欄、末欄、第一列多一個偽類：寫 `[&_td:first-child]:pl-0`。
 * - 手機卡片照欄位名稱的慣例（見 MOBILE_CARD）是 `tr>td[data-label=…]`：寫
 *   `[&_tbody_tr>td[data-label=狀態]]:…`，只寫 `[&_td]:` 在手機上會輸。
 *
 * 寬度未滿 760px 的表格會變成一列一張卡片（MOBILE_CARD），所以格子的高度、內距、
 * 分隔線與 hover 只在桌機生效，兩邊不會互相蓋。
 */
const TABLE_BASE = [
  "min-[760px]:w-full",
  "[&_:where(th)]:h-14 [&_:where(th)]:px-4 [&_:where(th)]:text-left [&_:where(th)]:align-middle [&_:where(th)]:text-[14px] [&_:where(th)]:font-medium [&_:where(th)]:whitespace-nowrap [&_:where(th)]:text-muted",
  "[&_:where(th):first-child]:pl-6 [&_:where(th):last-child]:pr-6",
  "min-[760px]:[&_:where(td)]:text-[14px] min-[760px]:[&_:where(td)]:h-[52px] min-[760px]:[&_:where(td)]:px-4 min-[760px]:[&_:where(td)]:py-3.5 min-[760px]:[&_:where(td)]:border-t min-[760px]:[&_:where(td)]:border-soft-line min-[760px]:[&_:where(td)]:align-middle",
  "min-[760px]:[&_:where(td):first-child]:pl-6 min-[760px]:[&_:where(td):last-child]:pr-6",
  "min-[760px]:[&_:where(tbody_tr):first-child_:where(td)]:border-t-0",
  "[&_:where(tbody_tr)]:transition-[background-color] [&_:where(tbody_tr)]:duration-120 [&_:where(tbody_tr)]:ease-out motion-reduce:[&_:where(tbody_tr)]:transition-none",
  "min-[760px]:[&_:where(tbody_tr):hover]:bg-brand/4",
  // 數字欄要贏過 th 的靠左，所以不包 :where()。
  "[&_.numeric]:tabular-nums min-[760px]:[&_.numeric]:text-right",
  // 表頭只有放在捲動外框裡才釘住；對話框裡沒有外框的表跟著對話框捲。
  "[[data-table-scroll]>&_:where(thead_th)]:sticky [[data-table-scroll]>&_:where(thead_th)]:top-0 [[data-table-scroll]>&_:where(thead_th)]:z-2",
].join(" ");

/*
 * 手機：一列一張卡片，每一格是「標籤＋值」兩欄，標籤取自 td 的 data-label，所以 markup 只有一份。
 * 表格在 400px 寬的螢幕上沒救：七個欄位擠不下，橫向捲的話看得到第一欄就看不到狀態。
 *
 * 權重分三層，後面的蓋前面的：
 * 1. 每一格的預設（:where，跟桌機一樣最輕）。
 * 2. 首欄、末欄、沒有標籤的格子（多一個偽類）。
 * 3. 照欄位名稱的慣例（`tr>td[data-label=…]`）。欄位名稱比位置優先：
 *    分類管理頁第一格叫「分類」，所以「分類」那條另外排除了第一格。
 */
const MOBILE_CARD = [
  "max-[760px]:block max-[760px]:[&_:where(thead)]:hidden max-[760px]:[&_:where(tbody)]:block",
  /*
   * 卡片用 flex-wrap 再以 order 重排欄位：markup 的順序是為了桌機表格，照那個順序疊在手機上，
   * 兩個標記膠囊會被地址隔開、各佔一列。
   */
  "max-[760px]:[&_:where(tbody_tr)]:relative max-[760px]:[&_:where(tbody_tr)]:flex max-[760px]:[&_:where(tbody_tr)]:flex-wrap max-[760px]:[&_:where(tbody_tr)]:items-center max-[760px]:[&_:where(tbody_tr)]:gap-x-2 max-[760px]:[&_:where(tbody_tr)]:gap-y-0 max-[760px]:[&_:where(tbody_tr)]:mb-2.5 max-[760px]:[&_:where(tbody_tr)]:px-3.5 max-[760px]:[&_:where(tbody_tr)]:pt-3 max-[760px]:[&_:where(tbody_tr)]:pb-2.5 max-[760px]:[&_:where(tbody_tr)]:border max-[760px]:[&_:where(tbody_tr)]:border-line max-[760px]:[&_:where(tbody_tr)]:rounded-(--radius-card) max-[760px]:[&_:where(tbody_tr)]:bg-paper",
  /*
   * 每一格都要有 order，而且預設值要大於標題那一格：沒有 order 的格子會落在 0、排到標題前面，
   * 整張卡片從第二個欄位開始讀。分類管理頁踩過。
   */
  "max-[760px]:[&_:where(td)]:grid max-[760px]:[&_:where(td)]:grid-cols-[76px_minmax(0,1fr)] max-[760px]:[&_:where(td)]:items-start max-[760px]:[&_:where(td)]:gap-3 max-[760px]:[&_:where(td)]:px-0 max-[760px]:[&_:where(td)]:py-[5px] max-[760px]:[&_:where(td)]:border-0 max-[760px]:[&_:where(td)]:text-[14px] max-[760px]:[&_:where(td)]:order-10",
  "max-[760px]:[&_:where(td)]:before:content-[attr(data-label)] max-[760px]:[&_:where(td)]:before:text-[12px] max-[760px]:[&_:where(td)]:before:leading-[1.6] max-[760px]:[&_:where(td)]:before:text-muted",
  // 沒有標籤的格子（例如純操作欄）不要留一格空白。
  "max-[760px]:[&_:where(td):not([data-label])]:grid-cols-[minmax(0,1fr)] max-[760px]:[&_:where(td):not([data-label])]:before:hidden",
  "max-[760px]:[&_:where(td):last-child]:pr-6",
  // 第一格是「這是誰」，獨占一行當卡片標題，右邊讓開釘在右上角的操作鈕。
  "max-[760px]:[&_:where(td):first-child]:order-1 max-[760px]:[&_:where(td):first-child]:block max-[760px]:[&_:where(td):first-child]:w-full max-[760px]:[&_:where(td):first-child]:pt-0 max-[760px]:[&_:where(td):first-child]:pb-2 max-[760px]:[&_:where(td):first-child]:pr-[84px] max-[760px]:[&_:where(td):first-child]:mb-1.5 max-[760px]:[&_:where(td):first-child]:border-b max-[760px]:[&_:where(td):first-child]:border-soft-line max-[760px]:[&_:where(td):first-child]:before:hidden",
  /*
   * 不必解釋的欄位拿掉標籤、各佔一整行：看到一串數字就知道是電話，看到地址就知道是地址。
   * 卡片原本每個欄位一列標籤＋值，一張 287px，一個螢幕只看得到 1.4 張。
   */
  "max-[760px]:[&_tr>td[data-label=電話]]:order-2 max-[760px]:[&_tr>td[data-label=地址]]:order-3 max-[760px]:[&_tr>td[data-label=最近更新]]:order-6",
  "max-[760px]:[&_tr>td[data-label=電話]]:w-full max-[760px]:[&_tr>td[data-label=地址]]:w-full max-[760px]:[&_tr>td[data-label=最近更新]]:w-full",
  "max-[760px]:[&_tr>td[data-label=電話]]:grid-cols-[minmax(0,1fr)] max-[760px]:[&_tr>td[data-label=地址]]:grid-cols-[minmax(0,1fr)] max-[760px]:[&_tr>td[data-label=最近更新]]:grid-cols-[minmax(0,1fr)]",
  "max-[760px]:[&_tr>td[data-label=電話]]:py-0.5 max-[760px]:[&_tr>td[data-label=地址]]:py-0.5 max-[760px]:[&_tr>td[data-label=最近更新]]:py-0.5",
  "max-[760px]:[&_tr>td[data-label=電話]]:before:hidden max-[760px]:[&_tr>td[data-label=地址]]:before:hidden max-[760px]:[&_tr>td[data-label=最近更新]]:before:hidden",
  "max-[760px]:[&_tr>td[data-label=最近更新]]:text-[12px] max-[760px]:[&_tr>td[data-label=最近更新]]:text-muted",
  "max-[760px]:[&_tr>td[data-label=位置]]:order-2 max-[760px]:[&_tr>td[data-label=數量]]:order-3 max-[760px]:[&_tr>td[data-label=安全庫存]]:order-4",
  "max-[760px]:[&_tr>td[data-label=位置]]:w-full max-[760px]:[&_tr>td[data-label=數量]]:w-full max-[760px]:[&_tr>td[data-label=安全庫存]]:w-full",
  // 通路、狀態、分類都是膠囊，在最後排成同一行；各佔一列的話兩個小膠囊就吃掉 64px。
  "max-[760px]:[&_tr>td[data-label=通路]]:order-4 max-[760px]:[&_tr>td[data-label=狀態]]:order-5 max-[760px]:[&_tr>td[data-label=分類]:not(:first-child)]:order-5",
  "max-[760px]:[&_tr>td[data-label=通路]]:block max-[760px]:[&_tr>td[data-label=狀態]]:block max-[760px]:[&_tr>td[data-label=分類]:not(:first-child)]:block",
  "max-[760px]:[&_tr>td[data-label=通路]]:w-auto max-[760px]:[&_tr>td[data-label=狀態]]:w-auto max-[760px]:[&_tr>td[data-label=分類]:not(:first-child)]:w-auto",
  "max-[760px]:[&_tr>td[data-label=通路]]:py-1 max-[760px]:[&_tr>td[data-label=狀態]]:py-1 max-[760px]:[&_tr>td[data-label=分類]:not(:first-child)]:py-1",
  "max-[760px]:[&_tr>td[data-label=通路]]:before:hidden max-[760px]:[&_tr>td[data-label=狀態]]:before:hidden max-[760px]:[&_tr>td[data-label=分類]:not(:first-child)]:before:hidden",
  // 操作鈕釘在卡片右上角，不要自己佔一列（那一列量出來 50px）。
  "max-[760px]:[&_tr>td[data-label=操作]]:absolute max-[760px]:[&_tr>td[data-label=操作]]:top-2 max-[760px]:[&_tr>td[data-label=操作]]:right-2 max-[760px]:[&_tr>td[data-label=操作]]:block max-[760px]:[&_tr>td[data-label=操作]]:p-0 max-[760px]:[&_tr>td[data-label=操作]]:before:hidden",
  // 值那一欄是 grid item，預設會被拉滿整格；膠囊撐成一整條就不像標記了。
  "max-[760px]:[&_td>[data-tag-list]]:justify-self-start",
].join(" ");

const STICKY_HEADER_SKIN: Record<TableSkinName, string> = {
  solid: "[[data-table-scroll]>&_:where(thead_th)]:bg-paper [[data-table-scroll]>&_:where(thead_th)]:[box-shadow:inset_0_-1px_0_var(--color-line)]",
  /*
   * 玻璃表頭：資料從底下捲過去時要看得出是浮在上面的一層。兩端圓角，但表格直接貼在
   * 面板裡時面板本身已經有圓角與邊界，表頭就不再自己圓。
   */
  glass: "[[data-table-scroll]>&_:where(thead_th)]:bg-paper/82 [[data-table-scroll]>&_:where(thead_th)]:[-webkit-backdrop-filter:blur(14px)_saturate(165%)] [[data-table-scroll]>&_:where(thead_th)]:[backdrop-filter:blur(14px)_saturate(165%)] [[data-table-scroll]>&_:where(thead_th)]:[box-shadow:var(--shadow-glass-table-head)] [[data-table-scroll]>&_:where(thead_th):first-child]:rounded-tl-xl [[data-table-scroll]>&_:where(thead_th):last-child]:rounded-tr-xl [[data-panel]>[data-table-scroll]>&_:where(thead_th):first-child]:rounded-tl-none [[data-panel]>[data-table-scroll]>&_:where(thead_th):last-child]:rounded-tr-none",
};

interface DataTableBaseProps extends Omit<TableHTMLAttributes<HTMLTableElement>, "children" | "className"> {
  children: ReactNode;
  /**
   * 改格子預設值寫在這裡，用 `[&_td]:…`、`[&_.某格]:…`，不要寫在單一格子上：
   * 格子自己的 utility 跟預設值一樣重，誰贏要看產生順序。整張表的寬度、版面也放這裡。
   */
  className?: string;
}

type DataTableProps = DataTableBaseProps & (
  | { scroll?: true; containerClassName?: string }
  /**
   * 不包捲動外框，只輸出 table。用在對話框這種外層已經在捲的地方，
   * 或外框裡還要放別的東西（手機版的全選列）時，由呼叫端自己包一層帶 data-table-scroll 與 TABLE_SCROLL 的外框。
   * 沒有外框可以套，所以不收 containerClassName。
   */
  | { scroll: false; containerClassName?: never }
);

/** 資料表：捲動外框、表頭、格子與數字欄的外觀；欄位與排序行為由各頁負責。 */
export function DataTable({ children, className = "", containerClassName = "", scroll = true, ...tableProps }: DataTableProps) {
  const skin = useContext(TableSkinContext);
  const table = (
    <table {...tableProps} className={`${defaultUnless(className, "border-separate", "border-collapse")} ${TABLE_BASE} ${MOBILE_CARD} ${STICKY_HEADER_SKIN[skin]} ${className}`.trim()}>
      {children}
    </table>
  );
  if (!scroll) return table;
  return <div data-table-scroll="" className={`${TABLE_SCROLL} ${skin === "glass" ? "min-w-0" : ""} ${containerClassName}`.replace(/\s+/g, " ").trim()}>{table}</div>;
}
