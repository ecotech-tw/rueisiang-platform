import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
  /** `compact` 給已經在卡片裡的短註記：不再多一圈內距。 */
  size?: "default" | "compact";
  className?: string;
}

const SIZE_CLASS = {
  default: "p-[18px]",
  compact: "px-0 py-2",
} as const;

/** 列表沒有資料時的靜態訊息；不要拿 loading 或 Alert 代替。 */
export function EmptyState({ children, size = "default", className = "" }: EmptyStateProps) {
  return <p className={`rounded-[10px] border border-dashed border-line text-center text-muted ${SIZE_CLASS[size]} ${className}`.trim()}>{children}</p>;
}
