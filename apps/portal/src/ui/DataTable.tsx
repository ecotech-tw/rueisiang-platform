import type { ReactNode } from "react";

export { DataTable, TABLE_SCROLL, TableSkin, type TableSkinName } from "@rueisiang/ui";

/** 格子裡的錯誤訊息，接在摘要與類型下面。 */
export function CellError({ children }: { children: ReactNode }) {
  return <div className="mt-0.5 text-[12px] text-brand-dark">{children}</div>;
}
