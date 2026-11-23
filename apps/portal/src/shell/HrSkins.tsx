import type { ReactNode } from "react";
import { ButtonSkin, InputSkin, MobilePageTitle, PageDescriptions, PanelSkin, TableSkin } from "../ui/index.js";

/*
 * HRIS 的玻璃皮膚、「頁首不顯示說明」與「手機上不顯示 h1」（頁名改寫在 HrBrand）。HrLayout 用它包住整個 HRIS；掛在路由外面、
 * 卻會在 HRIS 頁面上跳出來的東西（未儲存變更的確認視窗）也要包一層，不然拿到的是預設的實色皮膚。
 */
export function HrSkins({ children }: { children: ReactNode }) {
  return <ButtonSkin skin="glass"><InputSkin skin="glass"><TableSkin skin="glass"><PanelSkin skin="glass"><PageDescriptions visible={false}><MobilePageTitle visible={false}>{children}</MobilePageTitle></PageDescriptions></PanelSkin></TableSkin></InputSkin></ButtonSkin>;
}
