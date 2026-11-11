import type { ReactNode } from "react";

export { EmptyState } from "@rueisiang/ui";

/**
 * 整頁清單沒有資料時的空狀態：粗體標題＋一句提示。
 * 共用的 `EmptyState` 是一行灰字，給卡片裡的短註記；這個是清單本身空掉、要告訴使用者下一步的地方。
 */
export function EmptyRecords({ title, hint }: { title: ReactNode; hint: ReactNode }) {
  return <div className="grid justify-items-center gap-[5px] rounded-[14px] border border-dashed border-line px-4 pt-[34px] pb-6 text-center text-ink">
    <strong>{title}</strong>
    <p className="m-0 text-[13px] text-muted">{hint}</p>
  </div>;
}
