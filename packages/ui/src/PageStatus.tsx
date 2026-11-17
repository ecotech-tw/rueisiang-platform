import type { HTMLAttributes } from "react";

/** 整頁只有一行字的狀態：載入中、讀取失敗。放在頁面內容的位置，不另外做骨架。 */
export function PageStatus({ children, ...props }: Omit<HTMLAttributes<HTMLDivElement>, "className">) {
  return <div className="p-12 text-muted" {...props}>{children}</div>;
}
