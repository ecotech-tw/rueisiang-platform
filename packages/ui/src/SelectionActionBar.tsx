import type { ReactNode } from "react";

export type SelectionActionBarProps = {
  count: number;
  children: ReactNode;
  countLabel?: string;
  className?: string;
};

/*
 * 桌機浮在表格區右下角（表格自己捲）。手機上整頁捲，改成黏在畫面底部、跟著列表走；
 * 放不下時按鈕換到下一行，不要把「已選取…」擠成一字一行。
 */
export function SelectionActionBar({ count, children, countLabel = "項", className = "" }: SelectionActionBarProps) {
  return (
    <div
      className={`absolute right-4 bottom-4 z-3 flex items-center justify-end gap-3 rounded-[12px] border border-line bg-paper py-2.5 pr-3 pl-4 shadow-panel max-[760px]:sticky max-[760px]:right-auto max-[760px]:bottom-3.5 max-[760px]:mt-3 max-[760px]:flex-wrap max-[760px]:gap-y-2 max-[760px]:py-2 max-[760px]:pr-2.5 max-[760px]:pl-3.5 [&>button]:flex-none ${className}`.trim()}
      role="status"
      aria-live="polite"
    >
      <span className="mr-auto text-muted max-[760px]:shrink-0">已選取 {count} {countLabel}</span>
      {children}
    </div>
  );
}
