import type { ReactNode } from "react";

export type SelectionActionBarProps = {
  count: number;
  children: ReactNode;
  countLabel?: string;
  className?: string;
};

export function SelectionActionBar({ count, children, countLabel = "項", className = "" }: SelectionActionBarProps) {
  return (
    <div
      className={`absolute right-4 bottom-4 z-3 flex items-center justify-end gap-3 rounded-[12px] border border-line bg-paper py-2.5 pr-3 pl-4 shadow-panel max-[760px]:right-3.5 max-[760px]:bottom-3.5 max-[760px]:left-3.5 max-[760px]:py-2 max-[760px]:pr-2.5 max-[760px]:pl-3.5 [&>button]:flex-none ${className}`.trim()}
      role="status"
      aria-live="polite"
    >
      <span className="mr-auto text-muted">已選取 {count} {countLabel}</span>
      {children}
    </div>
  );
}
