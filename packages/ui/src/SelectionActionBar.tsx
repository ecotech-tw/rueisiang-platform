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
 * sticky 只在「從這裡到捲動區之間沒有 overflow-hidden」時黏得住：`<Panel grows>` 在手機上已經不裁切，
 * 包它的容器要自己加 `max-[760px]:overflow-visible`（見 HR 的薪資與申請頁）；漏了不會壞，只是操作列排在
 * 列表最後、不黏在畫面底部。面板底下有黏住的分頁列時，停在分頁列（手機約 57px 高）上方 12px；
 * sticky 的 bottom 會算進捲動區的下內距，所以扣掉 --page-pad-bottom。
 */
export function SelectionActionBar({ count, children, countLabel = "項", className = "" }: SelectionActionBarProps) {
  return (
    <div
      className={`absolute right-4 bottom-4 z-3 flex items-center justify-end gap-3 rounded-[12px] border border-line bg-paper py-2.5 pr-3 pl-4 shadow-panel max-[760px]:sticky max-[760px]:right-auto max-[760px]:bottom-3.5 max-[760px]:[[data-grows]:has(>[data-pager])_&]:bottom-[calc(69px-var(--page-pad-bottom,0px))] max-[760px]:mt-3 max-[760px]:flex-wrap max-[760px]:gap-y-2 max-[760px]:py-2 max-[760px]:pr-2.5 max-[760px]:pl-3.5 [&>button]:flex-none ${className}`.trim()}
      data-selection-bar=""
      role="status"
      aria-live="polite"
    >
      <span className="mr-auto text-muted max-[760px]:shrink-0">已選取 {count} {countLabel}</span>
      {children}
    </div>
  );
}
