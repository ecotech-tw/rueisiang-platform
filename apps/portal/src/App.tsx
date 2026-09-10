import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { useSession } from "./auth/session.js";
import { Roles } from "./routes/admin/Roles.js";
import { AdminUsers } from "./routes/admin/Users.js";
import { Sandbox } from "./routes/assistant/Sandbox.js";
import { AssistantSettings } from "./routes/assistant/Settings.js";
import { LineSettings } from "./routes/assistant/LineSettings.js";
import { Activity } from "./routes/crm/Activity.js";
import { Customers } from "./routes/crm/Customers.js";
import { Tags } from "./routes/crm/Tags.js";
import { Sync } from "./routes/crm/Sync.js";
import { Invite } from "./routes/Invite.js";
import { Login } from "./routes/Login.js";
import { Profile } from "./routes/me/Profile.js";
import { HrAudit } from "./routes/hr/Audit.js";
import { HrEmployeeDetail, HrEmployees } from "./routes/hr/Employees.js";
import { HrLanding, HrLayout } from "./routes/hr/HrLayout.js";
import { HrManagementScopes } from "./routes/hr/ManagementScopes.js";
import { HrAttendanceSettings } from "./routes/hr/AttendanceSettings.js";
import { ItemCategories } from "./routes/items/Categories.js";
import { Items } from "./routes/items/Items.js";
import { Payout } from "./routes/tools/Payout.js";
import { Categories } from "./routes/wms/Categories.js";
import { WarehouseMap } from "./routes/wms/Map.js";
import { Activity as WmsActivity } from "./routes/wms/Activity.js";
import { Inventory } from "./routes/wms/Inventory.js";
import { SkuMappings } from "./routes/tools/SkuMappings.js";
import { Scopes } from "./routes/tools/Scopes.js";
import { CyberbizSales } from "./routes/tools/CyberbizSales.js";
import { ManualReports } from "./routes/tools/ManualReports.js";
import { ShopeeSales } from "./routes/tools/ShopeeSales.js";
import { Placeholder } from "./routes/Placeholder.js";
import { StyleGuide } from "./routes/StyleGuide.js";
import { AppShell } from "./shell/AppShell.js";

const Analytics = lazy(() => import("./routes/tools/analytics/Analytics.js").then((module) => ({ default: module.Analytics })));

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

/**
 * 已經登入的人不該再看到登入頁。
 *
 * 少了這個，按上一頁、或把 /login 存成書籤的人會看到一張登入表單，
 * 填一次才發現自己本來就登入著——最容易讓人以為「是不是被登出了」。
 *
 * returnTo 只接受站內路徑：讓 ?returnTo=https://evil.example 生效等於做出一個
 * 掛在公司網域上的開放轉址。
 */
function RedirectIfSignedIn({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const [params] = useSearchParams();

  if (loading) return <div className="boot">載入中…</div>;
  if (user) {
    const returnTo = params.get("returnTo");
    const safe = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
    return <Navigate to={safe} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <Login />
          </RedirectIfSignedIn>
        }
      />
      {/*
        * 設密碼頁在登入之前，跟 /login 一樣不套 AppShell。
        * 但這一頁不做「已登入就轉走」：拿到邀請連結的人可能正用別人的瀏覽器，
        * 或自己已經登入了另一個帳號——把他轉去首頁只會讓那條連結看起來壞掉。
        */}
      <Route path="/invite/:token" element={<Invite />} />

      <Route
        element={
          <RequireSession>
            <AppShell />
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/crm/customers" replace />} />

        <Route path="crm">
          <Route path="customers" element={<Customers />} />
          <Route path="tags" element={<Tags />} />
          <Route path="activity" element={<Activity />} />
          <Route path="sync" element={<Sync />} />
        </Route>

        <Route path="items">
          <Route path="catalog" element={<Items />} />
          <Route path="categories" element={<ItemCategories />} />
          <Route path="sku-mappings" element={<SkuMappings />} />
        </Route>

        <Route path="wms">
          <Route path="map" element={<WarehouseMap />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="sku-mappings" element={<Navigate to="/items/sku-mappings" replace />} />
          <Route path="categories" element={<Categories />} />
          <Route path="activity" element={<WmsActivity />} />
        </Route>

        <Route path="tools">
          <Route path="payout" element={<Payout />} />
          <Route path="analytics" element={<Suspense fallback={<div className="boot">載入統計頁…</div>}><Analytics /></Suspense>} />
          <Route path="scopes" element={<Scopes />} />
          <Route path="payout/settings" element={<Navigate to="/tools/scopes" replace />} />
          <Route path="manual-reports" element={<ManualReports />} />
          <Route path="cyberbiz-sales" element={<CyberbizSales />} />
          <Route path="shopee-sales" element={<ShopeeSales />} />
          <Route path="shopee-sales/settings" element={<Navigate to="/tools/scopes" replace />} />
          <Route path="sku-mappings" element={<Navigate to="/items/sku-mappings" replace />} />
          <Route path="product-categories" element={<Navigate to="/items/categories" replace />} />
          <Route path="external-products" element={<Navigate to="/items/sku-mappings" replace />} />
        </Route>

        <Route path="assistant">
          <Route path="sandbox" element={<Sandbox />} />
          <Route path="settings" element={<AssistantSettings />} />
          <Route path="line" element={<LineSettings />} />
        </Route>

        <Route path="hr" element={<HrLayout />}>
          <Route index element={<HrLanding />} />
          <Route path="employees" element={<HrEmployees />} />
          <Route path="employees/:id" element={<HrEmployeeDetail />} />
          <Route path="management-scopes" element={<HrManagementScopes />} />
          <Route path="audit" element={<HrAudit />} />
          <Route path="attendance-settings" element={<HrAttendanceSettings />} />
        </Route>

        <Route path="admin">
          <Route path="users" element={<AdminUsers />} />
          <Route path="roles" element={<Roles />} />
        </Route>

        <Route path="me" element={<Profile />} />
        <Route path="style-guide" element={<StyleGuide />} />

        <Route path="*" element={<Placeholder title="找不到頁面" phase="—" from="—" />} />
      </Route>
    </Routes>
  );
}
