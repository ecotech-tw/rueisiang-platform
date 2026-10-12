import { Navigate, Outlet, Route, Routes, useLocation, useSearchParams } from "react-router";
import { useSession } from "./auth/session.js";
import { LiffAccountLinkPage } from "./auth/LiffAccountLinkPage.js";
import { useHrQuery } from "./routes/hr/api.js";
import { Login } from "./routes/Login.js";
import { HrProfile } from "./routes/Profile.js";
import { HrClock, HrClockCalendar, HrClockLogs } from "./routes/hr/Clock.js";
import { HrClockCorrectionForm, HrForms, HrLeaveForm, HrOvertimeForm } from "./routes/hr/Forms.js";
import { HrLeaveSummary } from "./routes/hr/Leave.js";
import { HrNotifications } from "./routes/hr/Notifications.js";
import { HrPayrollHistory, HrPayslipDetail } from "./routes/hr/Payroll.js";
import { HrScheduling } from "./routes/hr/Scheduling.js";
import { HrWork } from "./routes/hr/Work.js";
import { HrLayout } from "./routes/hr/HrLayout.js";

function RequireSession({ children }: { children: React.ReactNode }) {
  const { user, loading, error, reload } = useSession();
  const location = useLocation();
  const checkLineLink = Boolean(user?.lineLinkRequired && !user.lineLiffAuthenticated);
  const lineLink = useHrQuery<{ linked: boolean; pending: boolean; replaceRequired: boolean }>("/liff/link", checkLineLink);
  if (loading) return <div className="boot">載入中…</div>;
  if (error) return <div className="boot" role="alert"><p>{error instanceof Error ? error.message : "讀取登入狀態失敗。"}</p><button type="button" onClick={() => void reload()}>重新嘗試</button></div>;
  if (!user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  if (checkLineLink && lineLink.isPending) return <div className="boot">確認 LINE 綁定狀態…</div>;
  if (checkLineLink && lineLink.error) return <div className="boot" role="alert"><p>{lineLink.error instanceof Error ? lineLink.error.message : "讀取 LINE 綁定狀態失敗。"}</p><button type="button" onClick={() => void lineLink.refetch()}>重新嘗試</button></div>;
  if (checkLineLink) return <LiffAccountLinkPage replaceExisting={Boolean(lineLink.data?.replaceRequired)} intentExpired={!lineLink.data?.pending} />;
  return <>{children}</>;
}

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

function HrShell() {
  return <div className="shell hr-app-shell"><main className="content"><Outlet /></main></div>;
}

export function App() {
  return <Routes>
    <Route path="/login" element={<RedirectIfSignedIn><Login /></RedirectIfSignedIn>} />
    <Route element={<RequireSession><HrShell /></RequireSession>}>
      <Route element={<HrLayout />}>
        <Route index element={<Navigate to="/clock" replace />} />
        <Route path="clock" element={<HrClock />} />
        <Route path="clock/calendar" element={<HrClockCalendar />} />
        <Route path="clock/logs" element={<HrClockLogs />} />
        <Route path="work" element={<HrWork />} />
        <Route path="forms" element={<HrForms />} />
        <Route path="payroll" element={<HrPayrollHistory />} />
        <Route path="payroll/:runId/:employmentId" element={<HrPayslipDetail />} />
        <Route path="notifications" element={<HrNotifications />} />
        <Route path="forms/new" element={<HrClockCorrectionForm />} />
        <Route path="forms/overtime" element={<HrOvertimeForm />} />
        <Route path="forms/leave" element={<HrLeaveForm />} />
        <Route path="scheduling" element={<HrScheduling />} />
        <Route path="profile" element={<HrProfile />} />
        <Route path="profile/leave" element={<HrLeaveSummary />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
