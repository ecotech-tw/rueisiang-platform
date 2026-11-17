import type { ReactNode } from "react";

export { FilterInput, FilterSelect, SEARCH_INPUT_WIDTH } from "@rueisiang/ui";
export type { FilterInputProps, FilterSelectOption, FilterSelectProps } from "@rueisiang/ui";

/** 篩選列最前面的短標籤（「報表月份」「對帳區間」），說明後面那個欄位在篩什麼。 */
export function FilterLabel({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-muted">{children}</span>;
}

/** 「篩選」按鈕上生效中的條件數。按鈕上有數字，收起來也知道自己在篩；沒有條件就不顯示。 */
export function FilterCount({ count }: { count: number }) {
  if (!count) return null;
  return <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-brand px-[5px] text-[11px] font-bold text-white tabular-nums">{count}</span>;
}

/**
 * 收得起來的篩選下拉，開關由「篩選」按鈕的 state 傳進來。
 *
 * 桌機：下拉直接參與工具列的排版（display: contents 讓這層容器消失），「篩選」那顆按鈕
 * 根本不出現——多一顆按鈕加一整列，只是把兩次點擊塞在本來就看得到的東西前面。
 *
 * 手機：收起來，展開時每個下拉各佔一整行，比擠成兩欄好按。要 flex-basis: 100% 才會換到
 * 新的一行；只寫 width: 100% 在 flex 子項上不夠，flex-basis 預設是 auto，寬度仍然由內容
 * 決定，量出來只有 96px，下拉就擠成細細一條。
 */
export function FilterFields({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className={open ? "contents max-[760px]:flex max-[760px]:basis-full max-[760px]:flex-wrap max-[760px]:gap-2 max-[760px]:pt-1" : "contents max-[760px]:hidden"}>{children}</div>;
}
