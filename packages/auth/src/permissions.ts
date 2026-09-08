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
  "crm:view:write": "管理共用的客戶視圖",
  "crm:activity:read": "檢視操作紀錄",
  "crm:sync:read": "檢視 CYBERBIZ 同步狀態",
  "crm:sync:trigger": "手動觸發 CYBERBIZ 同步",
  "crm:order:read": "檢視客戶訂單與消費紀錄",

  // 品項列表
  "items:item:read": "檢視品項列表",
  "items:item:write": "管理品項列表",
  "items:category:read": "檢視品項分類",
  "items:category:write": "管理品項分類",

  // 倉儲管理系統
  "wms:map:read": "檢視倉位地圖",
  "wms:map:write": "編輯倉位地圖",
  "wms:inventory:read": "檢視庫存",
  "wms:inventory:write": "編輯庫存",
  "wms:inventory:count": "執行盤點",
  "wms:category:write": "管理倉儲分類",
  "wms:mapping:read": "檢視通路 SKU 對應",
  "wms:mapping:write": "管理通路 SKU 對應",
  "wms:activity:read": "檢視倉儲操作紀錄",
  "wms:sync:trigger": "手動觸發庫存同步",

  // 營運工具
  "tools:payout:run": "執行出金表",
  "tools:payout:config": "管理通路（名稱、來源、Drive 設定）",
  "tools:cyberbiz-sales:run": "執行 CYBERBIZ 商品銷售報表",
  "tools:shopee-sales:run": "執行蝦皮銷售報表",
  "reports:cyberbiz:read": "檢視 CYBERBIZ 銷售與出金報表",
  "reports:cyberbiz:write": "新增、修改與刪除報表人工資料",
  "reports:analytics:read": "檢視營運統計",

  // 小香助理
  "assistant:sandbox:read": "檢視 AI 助理 Sandbox",
  "assistant:sandbox:write": "執行 AI 助理 Sandbox 與儲存 prompt",
  "assistant:settings:read": "檢視小香助理設定",
  "assistant:settings:write": "修改小香助理設定",
  "assistant:line:read": "檢視小香 LINE 前台",
  "assistant:line:write": "修改小香 LINE 前台設定",

  // 人事：全平台人事管理權限，不隨既有主管角色授予。
  "hr:self:read": "檢視本人人事資料",
  "hr:employee:read": "檢視全平台員工與任職資料",
  "hr:employee:write": "管理全平台員工與任職資料",
  "hr:employee:bind": "綁定員工登入帳號",

  // 系統
  "admin:user:read": "檢視帳號",
  "admin:user:write": "邀請與停用帳號",
  "admin:role:write": "調整角色與權限",
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** 初始角色模板。只有管理者角色受系統保護，其餘角色都是可維護的自訂角色。 */
export const SYSTEM_ROLES = {
  admin: { name: "管理者", permissions: ALL_PERMISSIONS },
  manager: {
    name: "主管",
    permissions: [
      "crm:customer:read", "crm:customer:write", "crm:customer:block",
      "crm:tag:read", "crm:tag:write", "crm:view:write", "crm:activity:read",
      "crm:sync:read", "crm:sync:trigger",
      "crm:order:read",
      "items:item:read", "items:item:write", "items:category:read", "items:category:write",
      "wms:map:read", "wms:map:write",
      "wms:inventory:read", "wms:inventory:write", "wms:inventory:count",
      "wms:category:write", "wms:mapping:read", "wms:mapping:write", "wms:activity:read", "wms:sync:trigger",
      "tools:payout:run",
      "tools:cyberbiz-sales:run",
      "tools:shopee-sales:run",
      "reports:cyberbiz:read", "reports:cyberbiz:write",
    ],
  },
  staff: {
    name: "一般同仁",
    permissions: [
      "crm:customer:read", "crm:customer:write",
      "crm:tag:read", "crm:view:write", "crm:activity:read",
      "items:item:read", "items:category:read",
      "wms:map:read", "wms:inventory:read", "wms:inventory:count",
    ],
  },
  viewer: {
    name: "檢視者",
    permissions: [
      "crm:customer:read", "crm:tag:read", "crm:activity:read", "crm:sync:read",
      "items:item:read", "items:category:read",
      "wms:map:read", "wms:inventory:read", "wms:activity:read",
    ],
  },
} as const satisfies Record<string, { name: string; permissions: readonly Permission[] }>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
