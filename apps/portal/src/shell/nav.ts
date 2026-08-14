import type { Permission } from "@rueisiang/auth/permissions";

export interface NavItem {
  label: string;
  to: string;
  /** 沒有這個權限的人看不到這一項。純外觀——真正的把關在 API。 */
  permission: Permission;
}

export interface NavSection {
  key: string;
  label: string;
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
    items: [
      { label: "客戶列表", to: "/crm/customers", permission: "crm:customer:read" },
      { label: "新增客人", to: "/crm/customers/new", permission: "crm:customer:write" },
      { label: "標籤管理", to: "/crm/tags", permission: "crm:tag:read" },
      { label: "操作紀錄", to: "/crm/activity", permission: "crm:activity:read" },
      { label: "CYBERBIZ 同步", to: "/crm/sync", permission: "crm:sync:read" },
    ],
  },
  {
    key: "wms",
    label: "倉儲管理系統",
    items: [
      { label: "倉位地圖", to: "/wms/map", permission: "wms:map:read" },
      { label: "商品庫存", to: "/wms/inventory", permission: "wms:inventory:read" },
      { label: "CYBERBIZ 庫存", to: "/wms/cyberbiz", permission: "wms:inventory:read" },
      { label: "分類管理", to: "/wms/categories", permission: "wms:category:write" },
      { label: "操作紀錄", to: "/wms/activity", permission: "wms:activity:read" },
    ],
  },
  {
    key: "tools",
    label: "營運工具",
    items: [
      { label: "出金表執行", to: "/tools/payout", permission: "tools:payout:run" },
      { label: "店別設定", to: "/tools/payout/settings", permission: "tools:payout:config" },
    ],
  },
];

/** 系統管理獨立於三大項之外，放在 sidebar 底部。 */
export const ADMIN_SECTION: NavSection = {
  key: "admin",
  label: "系統管理",
  items: [
    { label: "權限管理", to: "/admin/users", permission: "admin:user:read" },
  ],
};
