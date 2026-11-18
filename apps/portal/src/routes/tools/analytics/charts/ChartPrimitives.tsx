import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../../../shell/icons.js";
import { Button, Dialog, Panel, TABLE_SCROLL, Tooltip } from "../../../../ui/index.js";

export interface ChartTooltipEntry {
  name?: string;
  value?: unknown;
  color?: string;
  dataKey?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: readonly ChartTooltipEntry[];
  /** 同一張圖可能混用不同單位的系列（銷量／金額），所以格式化要看得到 entry。 */
  valueFormatter: (value: number, entry: ChartTooltipEntry) => string;
  valueMeta?: (entry: ChartTooltipEntry) => ReactNode;
}

const LEGEND_DOT = "inline-block size-2 rounded-[50%]";

/** 圖表的 hover 卡是 Material 的 rich tooltip：多列數值、淺底、卡片圓角，刻意跟 ui/Tooltip 的 plain tooltip 不同。 */
export function AnalyticsTooltip({ active, label, payload, valueFormatter, valueMeta }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter((entry) => entry.value !== undefined && entry.value !== null);
  if (!entries.length) return null;
  return (
    <div className="min-w-[148px] rounded-card border border-line bg-paper px-3 py-[11px] text-[12px] text-ink [box-shadow:var(--shadow-panel)]">
      <strong className="mb-[7px] block text-[12px]">{String(label ?? "")}</strong>
      {entries.map((entry) => (
        <div className="flex items-center justify-between gap-[18px] pt-1" key={`${entry.dataKey ?? entry.name ?? "value"}`}>
          <span className="inline-flex items-center gap-1.5 text-muted">
            <i className={LEGEND_DOT} style={{ background: entry.color ?? "var(--color-brand)" }} />
            {entry.name ?? "數值"}
          </span>
          <b className="inline-flex items-baseline gap-1.5 tabular-nums">
            {valueFormatter(Number(entry.value), entry)}
            {valueMeta?.(entry) ? <span className="text-[11px] font-bold text-brand-dark">{valueMeta(entry)}</span> : null}
          </b>
        </div>
      ))}
    </div>
  );
}

export interface ChartLegendEntry {
  value?: string;
  color?: string;
  dataKey?: string;
}

export interface AnalyticsLegendProps {
  payload?: readonly ChartLegendEntry[];
  formatValue?: (value: string, entry: ChartLegendEntry) => ReactNode;
}

export function AnalyticsLegend({ payload, formatValue }: AnalyticsLegendProps): ReactNode {
  if (!payload?.length) return null;
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 pt-[5px] text-[11px] text-muted">
      {payload.map((entry, index) => (
        // 不換行，才不會在標籤擠不下時被逐字折成直的；擠不下就整個項目換到下一列。
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap" key={`${entry.dataKey ?? entry.value ?? "series"}-${entry.value ?? ""}-${index}`}>
          <i className={LEGEND_DOT} style={{ background: entry.color ?? "var(--color-brand)" }} />
          {formatValue?.(entry.value ?? entry.dataKey ?? "", entry) ?? entry.value ?? entry.dataKey}
        </span>
      ))}
    </div>
  );
}

/** 出金與商品銷售兩個分頁共用的圖表版面。 */
export const ANALYTICS_CHART_GRID = "grid grid-cols-[minmax(0,1fr)_minmax(340px,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[1fr]";
export const ANALYTICS_CHART_COLUMN = "grid min-w-0 content-start gap-3.5";
// 面板之間的距離交給 grid 的 gap；m-0 擋掉共用樣式替相鄰面板加的 20px 上外距。
export const ANALYTICS_CHART_PANEL = "m-0 min-w-0 px-[18px] pt-[17px] pb-[14px] max-[760px]:px-[13px]";
export const ANALYTICS_CHART = "h-[300px] min-h-[240px] w-full";
export const ANALYTICS_CHART_EMPTY = "m-0 grid h-[260px] place-items-center text-[13px] text-muted";

/** 結果區最上面那一列：左邊是範圍名稱，右邊是資料截止日與計算範圍。 */
export function AnalyticsResultHeading({ eyebrow, title, asOf, children }: { eyebrow: string; title: string; asOf: string | null; children?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-[7px]">
      <div>
        <p className="mx-0 mt-0 mb-[3px] text-[11px] font-extrabold tracking-[.12em] text-brand">{eyebrow}</p>
        <h2 className="m-0 text-[18px]">{title}</h2>
        {children}
      </div>
      <div className="flex flex-wrap justify-end gap-x-2.5 gap-y-1.5 text-right text-[12px] text-muted max-[760px]:justify-start max-[760px]:text-left">
        {asOf ? <span className="rounded-full bg-warn-soft px-[9px] py-[3px] font-bold text-warn">{asOf}</span> : null}
        <span>僅計入啟用中的店別</span>
      </div>
    </div>
  );
}

const KPI_COLUMNS = {
  payout: { period: "grid-cols-[minmax(180px,1.35fr)_repeat(4,minmax(140px,1fr))]", annual: "grid-cols-[minmax(180px,1.35fr)_repeat(3,minmax(140px,1fr))]" },
  sales: { period: "grid-cols-[minmax(180px,1.35fr)_repeat(5,minmax(125px,1fr))]", annual: "grid-cols-[minmax(180px,1.35fr)_repeat(4,minmax(125px,1fr))]" },
} as const;

/** 年度報表沒有 MoM，少一張卡；斷點變窄後不分卡數，一律三欄、兩欄。 */
export function AnalyticsKpiGrid({ tab, annual, children }: { tab: keyof typeof KPI_COLUMNS; annual: boolean; children: ReactNode }) {
  return (
    <div className={`grid gap-2.5 max-[1180px]:grid-cols-[repeat(3,minmax(150px,1fr))] max-[760px]:grid-cols-2 max-[760px]:gap-2 ${KPI_COLUMNS[tab][annual ? "annual" : "period"]}`}>
      {children}
    </div>
  );
}

export function AnalyticsRefreshing() {
  return <p className="mx-0 -mt-1 mb-0 text-[12px] text-muted" role="status">正在更新統計…</p>;
}

interface AnalyticsEmptyPanelProps {
  icon: IconName;
  title: string;
  message: string;
  note?: string;
  /** 訊息下方的按鈕。 */
  children?: ReactNode;
}

export function AnalyticsEmptyPanel({ icon, title, message, note, children }: AnalyticsEmptyPanelProps) {
  return (
    <Panel className="grid justify-items-start gap-2.5 p-[30px] max-[760px]:px-5 max-[760px]:py-6">
      <span className="grid size-[38px] flex-none place-items-center rounded-[12px] bg-brand-soft text-brand-dark"><Icon name={icon} className="size-[21px]" /></span>
      <h2 className="m-0 text-[18px]">{title}</h2>
      <p className="m-0 text-muted">{message}</p>
      {note ? <p className="text-muted">{note}</p> : null}
      {children}
    </Panel>
  );
}

interface AnalyticsKpiProps {
  label: string;
  value: string;
  /** 本期主數字：品牌色調容器，斷點變窄時獨占一整列。 */
  primary?: boolean;
  /** 成長率說明這種比欄寬長的句子，截斷後完整內容放進 tooltip。 */
  hint?: string;
  /** 不需要 tooltip 的短說明；有 hint 時不顯示。 */
  children?: ReactNode;
}

/*
 * 數字與說明寬度都固定不下來（NT$ 加七位數在窄欄一定超出），只能截斷成「NT$3,011…」，
 * 所以完整值放進 tooltip。截斷要穿過 tooltip 錨點那一層，所以 block 與 min-w-0 寫在裡面的元素上。
 * 錨點是共用的 Tooltip、不帶字型，所以字重直接寫在數字與說明上。
 */
export function AnalyticsKpi({ label, value, primary = false, hint, children }: AnalyticsKpiProps) {
  return (
    <article className={`grid min-h-[106px] min-w-0 content-start gap-1 rounded-card border px-[15px] py-[14px] [box-shadow:var(--shadow-panel)] max-[760px]:min-h-[92px] max-[760px]:px-3 max-[760px]:py-[11px] ${primary ? "border-secondary bg-brand-soft max-[1180px]:col-span-3 max-[760px]:col-span-2" : "border-line bg-paper"}`}>
      <span className={`text-[12px] font-bold ${primary ? "text-brand-dark" : "text-muted"}`}>{label}</span>
      <Tooltip block label={value} className="cursor-help">
        <strong className={`block min-w-0 truncate text-[length:clamp(19px,2.1vw,27px)] leading-[1.2] font-black tabular-nums max-[760px]:text-[20px] ${primary ? "text-brand-dark" : "text-ink"}`}>{value}</strong>
      </Tooltip>
      {hint ? (
        <Tooltip block label={hint} className="cursor-help">
          <small className="block min-w-0 truncate text-[11px] leading-[1.45] font-bold text-muted">{hint}</small>
        </Tooltip>
      ) : (
        <small className="truncate text-[11px] leading-[1.45] text-muted">{children}</small>
      )}
    </article>
  );
}

/** 資料視窗裡的表：數字一律不換行，左右留白配合對話框的內距（手機上再窄一點）。 */
export const ANALYTICS_TABLE = "[&_th]:whitespace-nowrap [&_td]:whitespace-nowrap [&_th:first-child]:pl-[18px] [&_td:first-child]:pl-[18px] [&_th:last-child]:pr-[18px] [&_td:last-child]:pr-[18px] max-[760px]:[&_th:first-child]:pl-[13px] max-[760px]:[&_td:first-child]:pl-[13px] max-[760px]:[&_th:last-child]:pr-[13px] max-[760px]:[&_td:last-child]:pr-[13px]";

export interface AnalyticsDataDialogProps {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  disabled?: boolean;
}

/** 圖表的明細表統一收進 dialog，避免表格高度把瀑布流卡片撐出大片空白。 */
export function AnalyticsDataDialog({ title, description, children, disabled = false }: AnalyticsDataDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="secondary"
        icon="list"
       
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        查看資料表
      </Button>
      {open ? (
        <Dialog manageFocus
          title={title}
          titleMeta={description}
          width={760}
          onClose={() => setOpen(false)}
        >
          <div data-table-scroll="" className={`${TABLE_SCROLL} max-h-[calc(100vh-170px)] overflow-auto`}>{children}</div>
        </Dialog>
      ) : null}
    </>
  );
}

export function buildBucketKeys(start: string, end: string, granularity: "day" | "month" | "year"): string[] {
  if (start > end) return [];
  const keys: string[] = [];
  if (granularity === "day") {
    const date = new Date(`${start}T00:00:00Z`);
    const last = new Date(`${end}T00:00:00Z`);
    while (date <= last) {
      keys.push(date.toISOString().slice(0, 10));
      date.setUTCDate(date.getUTCDate() + 1);
    }
    return keys;
  }
  const [startYear = 0, startMonth = 1] = start.split("-").map(Number);
  const [endYear = 0, endMonth = 1] = end.split("-").map(Number);
  if (granularity === "year") {
    for (let year = startYear; year <= endYear; year += 1) keys.push(String(year));
    return keys;
  }
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

export function formatBucketLabel(key: string, granularity: "day" | "month" | "year"): string {
  if (granularity === "day") return key.slice(5).replace("-", "/");
  if (granularity === "month") return key.replace("-", "/");
  return key;
}

export function formatCompactValue(value: number): string {
  return value.toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}

/** 金額軸改用「萬」，七位數的完整數字會把刻度撐得比圖還寬。 */
export function formatCompactAmount(value: number): string {
  if (Math.abs(value) < 10000) return formatCompactValue(value);
  return `${(value / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}萬`;
}
