import type { ReactNode } from "react";

export type SelectionActionBarProps = {
  count: number;
  children: ReactNode;
  countLabel?: string;
  className?: string;
};

export function SelectionActionBar({ count, children, countLabel = "項", className = "" }: SelectionActionBarProps) {
  return (
    <div className={`selection-action-bar ${className}`.trim()} role="status" aria-live="polite">
      <span className="selection-action-bar__count">已選取 {count} {countLabel}</span>
      {children}
    </div>
  );
}
