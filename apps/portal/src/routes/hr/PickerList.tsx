import type { ReactNode } from "react";

// 獎金的通路／員工清單與出勤範圍的辦公位置清單是同一種「逐列挑選」框，兩頁共用這份外觀。
export function PickerList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 rounded-[12px] border border-line bg-paper p-3">{children}</div>;
}

export function PickerRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-2">{children}</div>;
}

export function PickerEmpty({ children }: { children: ReactNode }) {
  return <p className="muted m-0 px-0.5 py-1.5">{children}</p>;
}

/** 試算人員與特殊上班日套用人員共用的選人標題列：左邊標題與說明，右邊放全選與已選人數。 */
export function PeoplePickerHeading({ title, description, count, children }: { title: string; description: string; count: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3">
    <div className="grid min-w-0 gap-0.5"><strong className="text-[14px]">{title}</strong><small className="text-[12px] text-muted">{description}</small></div>
    <span className="flex flex-none items-center gap-2">{children}<span className="flex-none rounded-full bg-brand-soft px-2.5 py-[5px] text-[12px] font-bold text-brand-dark tabular-nums">{count}</span></span>
  </div>;
}

/**
 * 選人區塊的空狀態與載入中。
 * 特殊上班日的「載入中」要畫成輸入框的樣子，圓角由 .special-workday-target-loading 給，
 * 所以那裡傳 rounded={false} 與那個 class；搬 .special-workday* 時改成 prop。
 */
export function PeoplePickerEmpty({ children, rounded = true, className = "" }: { children: ReactNode; rounded?: boolean; className?: string }) {
  return <p className={`muted m-0 bg-canvas px-3.5 py-3 ${ rounded ? "rounded-field" : "" } ${ className }`.trim()}>{children}</p>;
}
