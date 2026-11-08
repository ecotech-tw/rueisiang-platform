import type { ReactNode } from "react";

// 個人中心與我的假勤共用的資料卡：淡底卡片、標題列，以及標籤／值兩欄的清單。
export const PROFILE_CARD_TITLE = "min-w-0 text-[14px] [overflow-wrap:anywhere]";

export function ProfileCardList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2.5">{children}</div>;
}

export function ProfileDataCard({ head, children }: { head: ReactNode; children: ReactNode }) {
  return <article className="grid min-w-0 gap-[11px] rounded-[12px] border border-soft-line bg-canvas p-[13px] max-[760px]:p-3">
    <header className="flex min-w-0 items-start justify-between gap-2.5">{head}</header>
    {children}
  </article>;
}

// 標題下面帶一行小字的卡片標題；小字沒有值時仍包一層，讓標題列的排法跟有值時一樣。
export function ProfileCardHeading({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return <div className="grid min-w-0 gap-[3px]"><strong className={PROFILE_CARD_TITLE}>{title}</strong>{meta ? <small className="text-[12px] text-muted">{meta}</small> : null}</div>;
}

export function ProfileInfoList({ rows, valueClassName = "" }: { rows: Array<{ key?: string; label: ReactNode; value: ReactNode }>; valueClassName?: string }) {
  return <dl className="grid gap-0">{rows.map((row) => <div key={row.key ?? String(row.label)} className="grid grid-cols-[minmax(94px,.42fr)_minmax(0,1fr)] items-start gap-2.5 border-b border-b-soft-line py-2.5 first:pt-0 last:border-b-0 last:pb-0 max-[760px]:grid-cols-[minmax(88px,.4fr)_minmax(0,1fr)] max-[760px]:gap-2">
    <dt className="text-[12px] font-semibold text-muted">{row.label}</dt>
    <dd className={`min-w-0 text-[14px] text-ink [overflow-wrap:anywhere] ${valueClassName}`.trim()}>{row.value}</dd>
  </div>)}</dl>;
}
