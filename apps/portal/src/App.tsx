import { ALL_PERMISSIONS, type Permission } from "@rueisiang/auth/permissions";
import { Navigate, Route, Routes } from "react-router";
import { Placeholder } from "./routes/Placeholder.js";
import { AppShell } from "./shell/AppShell.js";

// Phase 0 還沒有登入，先當成全權限以便檢視 sidebar 全貌。
// Phase 1 接上 /api/auth/me 之後改成從伺服器取得。
const DEV_PERMISSIONS: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

const CRM = "rueisiang-crm";
const WMS = "warehouse-inventory";
const TOOLS = "cyberbiz-monthly-payout";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell permissions={DEV_PERMISSIONS} />}>
        <Route index element={<Navigate to="/crm/customers" replace />} />

        <Route path="crm">
          <Route path="customers" element={<Placeholder title="客戶列表" phase="Phase 2" from={`${CRM}/app/crm-app.tsx`} />} />
          <Route path="customers/new" element={<Placeholder title="新增客人" phase="Phase 2" from={`${CRM}/app/customers/new`} />} />
          <Route path="tags" element={<Placeholder title="標籤管理" phase="Phase 2" from={`${CRM}/app/tag-management.tsx`} />} />
          <Route path="activity" element={<Placeholder title="操作紀錄" phase="Phase 2" from={`${CRM}/app/activity-log.tsx`} />} />
          <Route path="sync" element={<Placeholder title="CYBERBIZ 同步" phase="Phase 2" from={`${CRM}/app/cyberbiz-integration.tsx`} />} />
        </Route>

        <Route path="wms">
          <Route path="map" element={<Placeholder title="倉位地圖" phase="Phase 4" from={`${WMS}/app/warehouse-app.tsx`} />} />
          <Route path="inventory" element={<Placeholder title="商品庫存" phase="Phase 4" from={`${WMS}/app/warehouse-app.tsx`} />} />
          <Route path="cyberbiz" element={<Placeholder title="CYBERBIZ 庫存" phase="Phase 4" from={`${WMS}/lib/cyberbiz-inventory.ts`} />} />
          <Route path="categories" element={<Placeholder title="分類管理" phase="Phase 4" from={`${WMS}/app/warehouse-app.tsx`} />} />
          <Route path="activity" element={<Placeholder title="倉儲操作紀錄" phase="Phase 4" from={`${WMS}/app/warehouse-app.tsx`} />} />
        </Route>

        <Route path="tools">
          <Route path="payout" element={<Placeholder title="出金表執行" phase="Phase 3" from={`${TOOLS}/web/src/pages/RunPage.tsx`} />} />
          <Route path="payout/settings" element={<Placeholder title="出金表店別設定" phase="Phase 3" from={`${TOOLS}/web/src/pages/SettingsPage.tsx`} />} />
        </Route>

        <Route path="admin">
          <Route path="users" element={<Placeholder title="權限管理" phase="Phase 1" from="新建（取代兩套各自的 app_users）" />} />
        </Route>

        <Route path="*" element={<Placeholder title="找不到頁面" phase="—" from="—" />} />
      </Route>
    </Routes>
  );
}
