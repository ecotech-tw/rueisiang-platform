import Skeleton from "react-loading-skeleton";
import type { ReactNode } from "react";
import { Page } from "../../ui/index.js";

export type HrSkeletonVariant = "dashboard" | "table" | "calendar" | "detail";

const SKELETON_BASE_COLOR = "rgba(213, 56, 59, 0.15)";
const SKELETON_HIGHLIGHT_COLOR = "rgba(255, 255, 255, 0.92)";

/*
 * 這裡只寫外框的寬度、外距與色塊的高度。react-loading-skeleton 的 skeleton.css 沒有掛 layer，
 * 它設的 display、border-radius 一定贏過任何 utility，在色塊上寫圓角不會生效。
 * 減少動態效果也由它自己的 @media (prefers-reduced-motion) 關掉閃爍。
 */
function SkeletonBlock({ width = "w-full", height = "h-3.5" }: { width?: string; height?: string }) {
  return <Skeleton
    inline
    className={height}
    containerClassName={`block max-w-full leading-none ${width}`}
    baseColor={SKELETON_BASE_COLOR}
    highlightColor={SKELETON_HIGHLIGHT_COLOR}
    duration={1.4}
  />;
}

/* 表格的欄寬比例：首欄最長、末欄最短，看起來才像一列真的資料。 */
function columnWidth(index: number, columns: number) {
  return index === 0 ? "w-[90%]" : index === columns - 1 ? "w-[48%]" : "w-[72%]";
}

export function HrSkeletonTableRow({ columns = 5 }: { columns?: number }) {
  return <tr className="[&>td]:py-3" aria-hidden="true">
    {Array.from({ length: columns }, (_, index) => <td key={index}><SkeletonBlock width={columnWidth(index, columns)} /></td>)}
  </tr>;
}

const TABLE_LINE = "grid min-w-[620px] grid-cols-5 items-center gap-4 border-b border-b-line/65 px-1";

function SkeletonTable({ columns = 5, rows = 7 }: { columns?: number; rows?: number }) {
  return <div className="grid w-full min-w-0 gap-0 overflow-x-auto" aria-hidden="true">
    <div className={`${TABLE_LINE} min-h-14`}>{Array.from({ length: columns }, (_, index) => <SkeletonBlock key={index} width={index === 0 ? "w-[90%]" : "w-[72%]"} />)}</div>
    {Array.from({ length: rows }, (_, row) => <div className={`${TABLE_LINE} min-h-[52px]`} key={row}>{Array.from({ length: columns }, (_, index) => <SkeletonBlock key={index} width={columnWidth(index, columns)} />)}</div>)}
  </div>;
}

const PANEL = "grid w-full min-w-0 rounded-[18px] border border-transparent bg-paper/28 [-webkit-backdrop-filter:blur(7px)_saturate(150%)] [backdrop-filter:blur(7px)_saturate(150%)]";
const PANEL_SHADOW = "[box-shadow:0_1px_0_--alpha(var(--color-paper)/62%)_inset,0_0_0_1px_--alpha(var(--color-paper)/20%)_inset,0_16px_38px_--alpha(var(--color-ink)/8%)]";
const PANEL_TONE = {
  page: `gap-[18px] p-5 ${PANEL_SHADOW}`,
  card: `min-h-[190px] content-start gap-[18px] p-5 ${PANEL_SHADOW}`,
  "calendar-day": "min-h-[104px] gap-3 p-2.5 [box-shadow:0_1px_0_--alpha(var(--color-paper)/54%)_inset]",
};

function SkeletonPanel({ tone = "page", children }: { tone?: keyof typeof PANEL_TONE; children: ReactNode }) {
  return <section className={`${PANEL} ${PANEL_TONE[tone]}`}>{children}</section>;
}

function SkeletonPageHead() {
  return <div className="flex items-start justify-between gap-4 max-[620px]:flex-col max-[620px]:items-stretch" aria-hidden="true">
    <div className="grid min-w-0 gap-2.5"><SkeletonBlock width="w-[min(240px,46vw)]" height="h-8" /><SkeletonBlock width="w-[min(560px,70vw)]" height="h-[15px]" /></div>
    <SkeletonBlock width="w-28" height="h-[42px]" />
  </div>;
}

const TOOLBAR = "flex flex-wrap gap-2.5 border-b border-b-line/70 pb-4";
const TOOLBAR_FIELD = { width: "w-[170px]", height: "h-[42px]" };

function TablePageSkeleton() {
  return <SkeletonPanel>
    <div className="grid min-w-0 gap-2.5" aria-hidden="true"><SkeletonBlock width="w-[170px]" height="h-[21px]" /><SkeletonBlock width="w-[min(420px,68vw)]" /></div>
    <div className={TOOLBAR} aria-hidden="true"><SkeletonBlock {...TOOLBAR_FIELD} /><SkeletonBlock {...TOOLBAR_FIELD} /><SkeletonBlock width="w-24" height="h-[42px]" /></div>
    <SkeletonTable />
  </SkeletonPanel>;
}

function DashboardSkeleton() {
  return <div className="min-w-0" aria-hidden="true">
    <div className="grid grid-cols-4 gap-3.5 max-[620px]:grid-cols-[1fr]">{Array.from({ length: 4 }, (_, index) => <SkeletonPanel key={index} tone="card">
      <SkeletonBlock width="w-9" height="h-9" />
      <SkeletonBlock width="mt-4 w-[110px]" height="h-[30px]" />
      <SkeletonBlock width="mt-2.5 w-[86%]" />
      <SkeletonBlock width="mt-auto w-[120px]" />
    </SkeletonPanel>)}</div>
  </div>;
}

function CalendarSkeleton() {
  return <SkeletonPanel>
    <div className={`${TOOLBAR} items-center`} aria-hidden="true">
      <SkeletonBlock width="w-10" height="h-10" />
      <SkeletonBlock width="w-28" height="h-6" />
      <SkeletonBlock width="w-10" height="h-10" />
      <SkeletonBlock {...TOOLBAR_FIELD} />
      <SkeletonBlock width="ml-auto w-[170px] max-[620px]:ml-0" height={TOOLBAR_FIELD.height} />
    </div>
    <div className="grid w-full min-w-0 grid-cols-7 gap-2 overflow-x-auto max-[620px]:grid-cols-[repeat(7,minmax(76px,1fr))]" aria-hidden="true">{Array.from({ length: 35 }, (_, index) => <SkeletonPanel key={index} tone="calendar-day"><SkeletonBlock width="w-[30px]" height="h-[30px]" /><SkeletonBlock height="h-[30px]" /><SkeletonBlock width="w-[72%]" height="h-[30px]" /></SkeletonPanel>)}</div>
  </SkeletonPanel>;
}

function DetailSkeleton() {
  return <SkeletonPanel>
    <SkeletonBlock width="w-[220px]" height="h-6" />
    {Array.from({ length: 6 }, (_, index) => <div className="grid min-h-12 grid-cols-[minmax(100px,22%)_minmax(0,1fr)] items-center gap-[18px] border-b border-b-line/65" key={index}><SkeletonBlock width="w-[80%]" /><SkeletonBlock width="w-[70%]" /></div>)}
  </SkeletonPanel>;
}

export function HrPageSkeleton({ variant = "table" }: { variant?: HrSkeletonVariant }) {
  return <Page className="flex min-h-full w-full min-w-0 flex-col items-stretch gap-5" role="status" aria-label="載入中">
    <SkeletonPageHead />
    {variant === "dashboard" ? <DashboardSkeleton /> : variant === "calendar" ? <CalendarSkeleton /> : variant === "detail" ? <DetailSkeleton /> : <TablePageSkeleton />}
  </Page>;
}
