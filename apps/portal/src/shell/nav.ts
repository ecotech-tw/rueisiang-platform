import type { Permission } from "@rueisiang/auth/permissions";
import type { IconName } from "./icons.js";

export interface NavItem {
  label: string;
  to: string;
  /** 沒有這個權限的人看不到這一項。純外觀——真正的把關在 API。 */
  permission: Permission;
  /** 側邊選單收合成窄欄時只剩圖示，所以每一項都要有。 */
  icon: IconName;
  /**
   * 從屬於這一項的子頁面。目前沒有人用——CRM 與 WMS 搬進來之後才會出現，
   * 例如倉位地圖底下的個別倉區。留著渲染與樣式，等有真的子頁面再掛上去，
   * 不要為了展示階層而把平行的功能硬塞成從屬關係。
   */
  children?: NavItem[];
}

export interface NavSection {
  key: string;
  label: string;
  /** 大項自己也有圖示——收合成窄欄之後，那是唯一還看得到的線索。 */
  icon: IconName;
  items: NavItem[];
}

/**
 * Sidebar 的大項。前三塊是整合的目的——讓三套系統出現在同一個選單、共用一次登入；
 * 系統管理跟它們一樣由權限決定看不看得到，所以排在同一個清單裡而不是另外做一區。
 */
/*
 * 「新增客人」不在這裡：它是客戶列表上的一個動作，不是一個要導覽過去的地方。
 * 放進側邊選單會讓人以為那是另一個畫面，實際上只是同一頁開一個對話框。
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    key: "crm",
    label: "客戶關係管理",
    icon: "people",
    items: [
      { label: "客戶列表", to: "/crm/customers", permission: "crm:customer:read", icon: "list" },
      { label: "標籤管理", to: "/crm/tags", permission: "crm:tag:read", icon: "tag" },
      { label: "操作紀錄", to: "/crm/activity", permission: "crm:activity:read", icon: "history" },
      { label: "CYBERBIZ 同步", to: "/crm/sync", permission: "crm:sync:read", icon: "sync" },
    ],
  },
  {
    key: "wms",
    label: "倉儲管理系統",
    icon: "warehouse",
    items: [
      { label: "倉位地圖", to: "/wms/map", permission: "wms:map:read", icon: "grid" },
      { label: "商品庫存", to: "/wms/inventory", permission: "wms:inventory:read", icon: "box" },
      { label: "CYBERBIZ 庫存", to: "/wms/cyberbiz", permission: "wms:inventory:read", icon: "cloudSync" },
      { label: "分類管理", to: "/wms/categories", permission: "wms:category:write", icon: "category" },
      { label: "操作紀錄", to: "/wms/activity", permission: "wms:activity:read", icon: "history" },
    ],
  },
  {
    key: "tools",
    label: "營運工具",
    icon: "widgets",
    items: [
      { label: "出金表執行", to: "/tools/payout", permission: "tools:payout:run", icon: "payments" },
      { label: "店別設定", to: "/tools/payout/settings", permission: "tools:payout:config", icon: "storefront" },
    ],
  },
  {
    key: "admin",
    label: "系統管理",
    icon: "tune",
    items: [
      { label: "權限管理", to: "/admin/users", permission: "admin:user:read", icon: "shieldPerson" },
      { label: "角色管理", to: "/admin/roles", permission: "admin:role:write", icon: "tune" },
    ],
  },
];

/** 這個路徑是否落在某一項（或它的子項）底下，用來決定要不要自動展開。 */
export function containsPath(item: NavItem, pathname: string): boolean {
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return true;
  return (item.children ?? []).some((child) => containsPath(child, pathname));
}

export function sectionContainsPath(section: NavSection, pathname: string): boolean {
  return section.items.some((item) => containsPath(item, pathname));
}
