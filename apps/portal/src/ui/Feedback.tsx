import type { ReactNode } from "react";
import { defaultUnless } from "@rueisiang/ui";

export { Alert, StatusBadge, type StatusTone } from "@rueisiang/ui";

/**
 * 表單或工具列旁的一句提示：已儲存、執行中、更新中，或欄位的補充規則。
 *
 * 預設的上距要自己寫：preflight 把 <p> 的邊距清成 0，少了它提示會直接貼在輸入框或按鈕的下緣，
 * 看起來像同一個元件的一部分而不是註解。className 只給版面用；給了上下 margin 就整組取代
 * 預設的上距，不靠 utility 的產生順序決定誰贏。
 */
export function FormHint({ as: Tag = "p", className = "", children }: { as?: "p" | "span"; className?: string; children: ReactNode }) {
  return <Tag className={`${defaultUnless(className, "-?m[ty]?-", "mt-2.5")} text-[13px] font-bold text-ok ${className}`.trim()}>{children}</Tag>;
}
