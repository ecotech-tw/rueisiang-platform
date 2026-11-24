import type { ReactNode } from "react";
import { MobilePageTitle, PageDescriptions } from "../ui/index.js";

/*
 * HRIS 自己的頁面規則：「頁首不顯示說明」與「手機上不顯示 h1」（頁名改寫在 HrBrand）。HrLayout 用它包住整個 HRIS。
 * 玻璃皮膚由 AppShell 的 GlassSkins 統一給，這裡不再包。
 */
export function HrSkins({ children }: { children: ReactNode }) {
  return <PageDescriptions visible={false}><MobilePageTitle visible={false}>{children}</MobilePageTitle></PageDescriptions>;
}
