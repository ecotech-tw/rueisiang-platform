import type { Permission } from "@rueisiang/auth/permissions";

export interface NavItem {
  label: string;
  to: string;
  /** 沒有這個權限的人看不到這一項。純外觀——真正的把關在 API。 */
  permission: Permission;
  /** 側邊選單收合成窄欄時只剩這個字符，所以每一項都要有。 */
  icon: string;
  /**
   * 從屬於這一項的子頁面。父項自己仍然是可點的連結，子項只是把「這是它底下的東西」
   * 畫出來——舊系統把它們攤平成同一層，項目一多就看不出誰跟誰有關。
   */
  children?: NavItem[];
}

export interface NavSection {
  key: string;
  label: string;
  icon: string;
  items: NavItem[];
}

/**
 * Sidebar 的三大項。整合的目的就是讓這三塊出現在同一個選單、共用一次登入。
 * 項目與舊系統各自的 nav 對齊，方便逐一搬移時比對。
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    key: "crm",
    label: "客戶關係管理",
    icon: "♟",
    items: [
      {
        label: "客戶列表",
        to: "/crm/customers",
        permission: "crm:customer:read",
        icon: "☰",
        children: [
          { label: "新增客人", to: "/crm/customers/new", permission: "crm:customer:write", icon: "＋" },
        ],
      },
      { label: "標籤管理", to: "/crm/tags", permission: "crm:tag:read", icon: "#" },
      { label: "操作紀錄", to: "/crm/activity", permission: "crm:activity:read", icon: "↺" },
      { label: "CYBERBIZ 同步", to: "/crm/sync", permission: "crm:sync:read", icon: "↻" },
    ],
  },
  {
    key: "wms",
    label: "倉儲管理系統",
    icon: "▤",
    items: [
      { label: "倉位地圖", to: "/wms/map", permission: "wms:map:read", icon: "⌂" },
      { label: "商品庫存", to: "/wms/inventory", permission: "wms:inventory:read", icon: "▤" },
      { label: "CYBERBIZ 庫存", to: "/wms/cyberbiz", permission: "wms:inventory:read", icon: "↯" },
      { label: "分類管理", to: "/wms/categories", permission: "wms:category:write", icon: "◇" },
      { label: "操作紀錄", to: "/wms/activity", permission: "wms:activity:read", icon: "↶" },
    ],
  },
  {
    key: "tools",
    label: "營運工具",
    icon: "⚙",
    items: [
      {
        label: "出金表執行",
        to: "/tools/payout",
        permission: "tools:payout:run",
        icon: "$",
        children: [
          { label: "店別設定", to: "/tools/payout/settings", permission: "tools:payout:config", icon: "⚙" },
        ],
      },
    ],
  },
];

/** 系統管理獨立於三大項之外，放在 sidebar 底部。 */
export const ADMIN_SECTION: NavSection = {
  key: "admin",
  label: "系統管理",
  icon: "♦",
  items: [
    { label: "權限管理", to: "/admin/users", permission: "admin:user:read", icon: "♦" },
  ],
};

/** 這個路徑是否落在某一項（或它的子項）底下，用來決定要不要自動展開。 */
export function containsPath(item: NavItem, pathname: string): boolean {
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) return true;
  return (item.children ?? []).some((child) => containsPath(child, pathname));
}

export function sectionContainsPath(section: NavSection, pathname: string): boolean {
  return section.items.some((item) => containsPath(item, pathname));
}
