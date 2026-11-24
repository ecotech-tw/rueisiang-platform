import type { ReactNode } from "react";
import { ButtonSkin, InputSkin, PanelSkin, TableSkin } from "../ui/index.js";

/*
 * 平台內容區的玻璃皮膚：按鈕、輸入框、表格、面板一起換。AppShell 用它包住所有模組的頁面；
 * 掛在路由外面、卻會在頁面上跳出來的東西（未儲存變更的確認視窗）也要包一層，不然拿到的是預設的實色皮膚。
 * 皮膚是 React context，會穿過 portal，對話框與浮動新增鈕照樣拿得到。
 */
export function GlassSkins({ children }: { children: ReactNode }) {
  return <ButtonSkin skin="glass"><InputSkin skin="glass"><TableSkin skin="glass"><PanelSkin skin="glass">{children}</PanelSkin></TableSkin></InputSkin></ButtonSkin>;
}
