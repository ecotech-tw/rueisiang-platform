/**
 * 權限目錄。刻意定義在程式碼而不是資料表——權限鍵值是程式邏輯的一部分，
 * 放進 DB 只會讓「系統有哪些權限」與「程式實際檢查哪些權限」兩邊漂移。
 * 資料庫只存「哪個角色有哪些鍵值」（role_permissions）。
 *
 * 命名：<模組>:<資源>:<動作>
 */
export const PERMISSIONS = {
  // 客戶關係管理
  "crm:customer:read": "檢視客戶",
  "crm:customer:write": "新增與編輯客戶",
  "crm:customer:block": "封鎖客戶",
  "crm:tag:read": "檢視標籤",
  "crm:tag:write": "管理標籤",
  "crm:activity:read": "檢視操作紀錄",
  "crm:sync:read": "檢視 CYBERBIZ 同步狀態",
  "crm:sync:trigger": "手動觸發 CYBERBIZ 同步",

  // 倉儲管理系統
  "wms:map:read": "檢視倉位地圖",
  "wms:map:write": "編輯倉位地圖",
  "wms:inventory:read": "檢視庫存",
  "wms:inventory:write": "編輯庫存",
  "wms:inventory:count": "執行盤點",
  "wms:category:write": "管理商品分類",
  "wms:activity:read": "檢視倉儲操作紀錄",
  "wms:sync:trigger": "手動觸發庫存同步",

  // 營運工具
  "tools:payout:run": "執行出金表",
  "tools:payout:config": "修改出金表店別設定",

  // 系統
  "admin:user:read": "檢視帳號",
  "admin:user:write": "邀請與停用帳號",
  "admin:role:write": "調整角色與權限",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** 系統預設角色。isSystem 的角色不允許從 UI 刪除。 */
export const SYSTEM_ROLES = {
  admin: { name: "管理者", permissions: ALL_PERMISSIONS },
  manager: {
    name: "主管",
    permissions: [
      "crm:customer:read", "crm:customer:write", "crm:customer:block",
      "crm:tag:read", "crm:tag:write", "crm:activity:read",
      "crm:sync:read", "crm:sync:trigger",
      "wms:map:read", "wms:map:write",
      "wms:inventory:read", "wms:inventory:write", "wms:inventory:count",
      "wms:category:write", "wms:activity:read", "wms:sync:trigger",
      "tools:payout:run",
    ],
  },
  staff: {
    name: "一般同仁",
    permissions: [
      "crm:customer:read", "crm:customer:write",
      "crm:tag:read", "crm:activity:read",
      "wms:map:read", "wms:inventory:read", "wms:inventory:count",
    ],
  },
  viewer: {
    name: "檢視者",
    permissions: [
      "crm:customer:read", "crm:tag:read", "crm:activity:read", "crm:sync:read",
      "wms:map:read", "wms:inventory:read", "wms:activity:read",
    ],
  },
} as const satisfies Record<string, { name: string; permissions: readonly Permission[] }>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
