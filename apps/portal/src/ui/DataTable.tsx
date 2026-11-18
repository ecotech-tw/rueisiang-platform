import type { ReactNode } from "react";

export { DataTable, TABLE_SCROLL, TableSkin, type TableSkinName } from "@rueisiang/ui";

/** 格子裡的錯誤訊息，接在摘要與類型下面。 */
export function CellError({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-[12px] text-brand-dark">{children}</div>;
}

/**
 * 「操作」欄裡的一排按鈕：桌機貼齊欄尾，手機卡片改從左邊排起。
 *
 * HRIS 的玻璃按鈕有自己的外框，2px 會黏成一條，所以那邊用 `spacing="wide"`（8px）。
 * className 只給版面用（例如 `items-start`）。
 */
export function RowActions({ spacing = "tight", className = "", children }: { spacing?: "tight" | "wide"; className?: string; children: ReactNode }) {
  return <div className={`flex justify-end ${spacing === "wide" ? "gap-2" : "gap-0.5"} max-[760px]:justify-start ${className}`.trim()}>{children}</div>;
}

/**
 * 表格上下的一行狀態說明：載入中、沒有資料、上傳位置。
 *
 * flex-none：放在 fills 版面的 grows Panel 裡時，Panel 是直欄 flex，不加會被表格壓扁；
 * 父層不是 flex 時這個 class 不起作用。
 */
export function TableNote({ children }: { children: ReactNode }) {
  return <p className="mx-1 mt-4 flex-none text-muted">{children}</p>;
}
