import type { ReactNode } from "react";

// 獎金的通路／員工清單與出勤範圍的辦公位置清單是同一種「逐列挑選」框，兩頁共用這份外觀。
export function PickerList({ children }: { children: ReactNode }) {
  return <div className="grid gap-2 rounded-[12px] border border-line bg-paper p-3">{children}</div>;
}

export function PickerRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[minmax(0,1fr)_44px] items-center gap-2">{children}</div>;
}

export function PickerEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted m-0 px-0.5 py-1.5">{children}</p>;
}

/** 試算人員與特殊上班日套用人員共用的選人標題列：左邊標題與說明，右邊放全選與已選人數。 */
export function PeoplePickerHeading({ title, description, count, children }: { title: string; description: string; count: ReactNode; children: ReactNode }) {
  return <div className="flex items-center justify-between gap-3">
    <div className="grid min-w-0 gap-0.5"><strong className="text-[14px]">{title}</strong><small className="text-[12px] text-muted">{description}</small></div>
    <span className="flex flex-none items-center gap-2">{children}<span className="flex-none rounded-full bg-brand-soft px-2.5 py-[5px] text-[12px] font-bold text-brand-dark tabular-nums">{count}</span></span>
  </div>;
}

/*
 * field：載入中的提示佔的是下拉的位置，給它同樣的外框與高度（輸入框 + chip 區上下留白 + 外框），換成下拉時版面才不會跳。
 * 「沒有可套用的人員」這種不會再變的狀態用 plain——畫成輸入框會讓人以為可以點。
 */
const PEOPLE_PICKER_EMPTY_VARIANT = {
  plain: "rounded-field",
  field: "flex min-h-[calc(var(--size-field)+8px)] items-center rounded-[10px] border border-line",
} as const;

/** 選人區塊的空狀態與載入中。 */
export function PeoplePickerEmpty({ children, variant = "plain" }: { children: ReactNode; variant?: keyof typeof PEOPLE_PICKER_EMPTY_VARIANT }) {
  return <p className={`text-muted m-0 bg-canvas px-3.5 py-3 ${ PEOPLE_PICKER_EMPTY_VARIANT[variant] }`}>{children}</p>;
}
