import { Navigate, Route, Routes, useLocation } from "react-router";
import { useSession } from "./auth/session.js";
import { AdminUsers } from "./routes/admin/Users.js";
import { Login } from "./routes/Login.js";
import { Placeholder } from "./routes/Placeholder.js";
import { AppShell } from "./shell/AppShell.js";

const CRM = "rueisiang-crm";
const WMS = "warehouse-inventory";
const TOOLS = "cyberbiz-monthly-payout";

/** 未登入就導去登入頁。這只是體驗上的導引，資料的把關在 API。 */
function RequireSession({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return <div className="boot">載入中…</div>;
  if (!user) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <RequireSession>
            <AppShell />
          </RequireSession>
        }
      >
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
          <Route path="users" element={<AdminUsers />} />
        </Route>

        <Route path="*" element={<Placeholder title="找不到頁面" phase="—" from="—" />} />
      </Route>
    </Routes>
  );
}
