import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router";
import { useSession } from "./auth/session.js";
import { Roles } from "./routes/admin/Roles.js";
import { AdminUsers } from "./routes/admin/Users.js";
import { Activity } from "./routes/crm/Activity.js";
import { Customers } from "./routes/crm/Customers.js";
import { Tags } from "./routes/crm/Tags.js";
import { Sync } from "./routes/crm/Sync.js";
import { Invite } from "./routes/Invite.js";
import { Login } from "./routes/Login.js";
import { Profile } from "./routes/me/Profile.js";
import { Payout } from "./routes/tools/Payout.js";
import { Categories } from "./routes/wms/Categories.js";
import { WarehouseMap } from "./routes/wms/Map.js";
import { Inventory } from "./routes/wms/Inventory.js";
import { PayoutSettings } from "./routes/tools/PayoutSettings.js";
import { Placeholder } from "./routes/Placeholder.js";
import { AppShell } from "./shell/AppShell.js";

const WMS = "warehouse-inventory";

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

        <Route path="wms">
          <Route path="map" element={<WarehouseMap />} />
          <Route path="inventory" element={<Inventory />} />
          <Route path="cyberbiz" element={<Placeholder title="CYBERBIZ 庫存" phase="Phase 4" from={`${WMS}/lib/cyberbiz-inventory.ts`} />} />
          <Route path="categories" element={<Categories />} />
          <Route path="activity" element={<Placeholder title="倉儲操作紀錄" phase="Phase 4" from={`${WMS}/app/warehouse-app.tsx`} />} />
        </Route>

        <Route path="tools">
          <Route path="payout" element={<Payout />} />
          <Route path="payout/settings" element={<PayoutSettings />} />
        </Route>

        <Route path="admin">
          <Route path="users" element={<AdminUsers />} />
          <Route path="roles" element={<Roles />} />
        </Route>

        <Route path="me" element={<Profile />} />

        <Route path="*" element={<Placeholder title="找不到頁面" phase="—" from="—" />} />
      </Route>
    </Routes>
  );
}
