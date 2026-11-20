import type { ReactNode } from "react";
import { ButtonSkin, InputSkin, PageDescriptions, PanelSkin, TableSkin } from "../ui/index.js";

/*
 * HRIS 的玻璃皮膚與「頁首不顯示說明」。HrLayout 用它包住整個 HRIS；掛在路由外面、
 * 卻會在 HRIS 頁面上跳出來的東西（未儲存變更的確認視窗）也要包一層，不然拿到的是預設的實色皮膚。
 */
export function HrSkins({ children }: { children: ReactNode }) {
  return <ButtonSkin skin="glass"><InputSkin skin="glass"><TableSkin skin="glass"><PanelSkin skin="glass"><PageDescriptions visible={false}>{children}</PageDescriptions></PanelSkin></TableSkin></InputSkin></ButtonSkin>;
}
