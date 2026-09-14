import { Navigate, Outlet, Route, Routes, useLocation, useSearchParams } from "react-router";
import { useSession } from "./auth/session.js";
import { Login } from "./routes/Login.js";
import { HrProfile } from "./routes/Profile.js";
import { HrClock, HrClockCalendar, HrClockLogs } from "./routes/hr/Clock.js";
import { HrClockCorrectionForm, HrForms, HrOvertimeForm } from "./routes/hr/Forms.js";
import { HrLayout } from "./routes/hr/HrLayout.js";

function RequireSession({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const location = useLocation();
  if (loading) return <div className="boot">載入中…</div>;
  if (!user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
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
        <Route path="forms" element={<HrForms />} />
        <Route path="forms/new" element={<HrClockCorrectionForm />} />
        <Route path="forms/overtime" element={<HrOvertimeForm />} />
        <Route path="profile" element={<HrProfile />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
