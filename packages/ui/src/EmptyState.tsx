import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
  className?: string;
}

/** 列表沒有資料時的靜態訊息；不要拿 loading 或 Alert 代替。 */
export function EmptyState({ children, className = "" }: EmptyStateProps) {
  return <p className={`empty-state ${className}`.trim()}>{children}</p>;
}
