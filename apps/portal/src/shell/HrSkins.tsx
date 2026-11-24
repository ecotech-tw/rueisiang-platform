import type { ReactNode } from "react";
import { MobilePageTitle } from "../ui/index.js";

/*
 * HRIS 自己的頁面規則：手機上一律不顯示 h1，頁名改寫在 HrBrand。HrLayout 用它包住整個 HRIS。
 * 玻璃皮膚與「頁首不顯示說明」由 AppShell 統一給，這裡不再包。
 */
export function HrSkins({ children }: { children: ReactNode }) {
  return <MobilePageTitle visible={false}>{children}</MobilePageTitle>;
}
