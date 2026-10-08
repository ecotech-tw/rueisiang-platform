import { NavLink, Outlet, useLocation } from "react-router";
import { Icon, type IconName } from "../../shell/icons.js";
import { useHrQuery, type HrNotificationsResponse } from "./api.js";

const personalLinks: { to: string; label: string; icon: IconName; center?: boolean }[] = [
  { to: "/forms", label: "表單申請", icon: "report" },
  { to: "/payroll", label: "薪資袋", icon: "payments" },
  { to: "/clock", label: "打卡", icon: "calendar", center: true },
  { to: "/notifications", label: "通知", icon: "notifications" },
  { to: "/profile", label: "個人中心", icon: "person" },
];

function PersonalNav({ className }: { className: string }) {
  const notifications = useHrQuery<HrNotificationsResponse>("/me/notifications");
  return <nav className={className} aria-label="本人 HR 功能">
    {personalLinks.map((link) => <NavLink
      key={link.to}
      to={link.to}
      end={link.to === "/clock"}
      className={({ isActive }) => `${link.center ? "hr-personal-bottom-link center" : "hr-personal-bottom-link"}${isActive ? " active" : ""}`}
    >
      <span className="hr-personal-nav-icon"><Icon name={link.icon} />{link.to === "/notifications" && notifications.data?.unreadCount ? <small className="hr-personal-nav-badge">{notifications.data.unreadCount > 99 ? "99+" : notifications.data.unreadCount}</small> : null}</span>
      <span className="hr-personal-nav-label">{link.label}</span>
    </NavLink>)}
  </nav>;
}

 
export function HrLayout() {
  const pathname = useLocation().pathname;
  const isClockHome = pathname === "/clock";
  const current = pathname.startsWith("/forms") ? "表單申請" : pathname.startsWith("/payroll") ? "薪資袋" : pathname.startsWith("/notifications") ? "通知" : pathname.startsWith("/profile") ? "個人中心" : "打卡";

  return <div className="hr-module hr-module-self">
    {isClockHome ? <PersonalNav className="hr-personal-nav hr-clock-personal-nav" /> : <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <PersonalNav className="hr-personal-nav hr-personal-top-nav" />
    </header>}
    <PersonalNav className="hr-personal-bottom-nav" />
    <Outlet />
  </div>;
}
