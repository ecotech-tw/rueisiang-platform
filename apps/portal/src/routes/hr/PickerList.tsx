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
