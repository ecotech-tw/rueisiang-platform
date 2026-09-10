import { NavLink, Outlet, useLocation } from "react-router";
import { Icon, type IconName } from "../../shell/icons.js";

const personalLinks: { to: string; label: string; icon: IconName; center?: boolean }[] = [
  { to: "/forms", label: "表單申請", icon: "report" },
  { to: "/clock", label: "打卡日曆", icon: "calendar", center: true },
  { to: "/profile", label: "個人資訊", icon: "person" },
];

function PersonalNav({ className }: { className: string }) {
  return <nav className={className} aria-label="本人 HR 功能">
    {personalLinks.map((link) => <NavLink
      key={link.to}
      to={link.to}
      end={link.to === "/clock"}
      className={({ isActive }) => `${link.center ? "hr-personal-bottom-link center" : "hr-personal-bottom-link"}${isActive ? " active" : ""}`}
    >
      <span className="hr-personal-nav-icon"><Icon name={link.icon} /></span>
      <span className="hr-personal-nav-label">{link.label}</span>
    </NavLink>)}
  </nav>;
}

 
export function HrLayout() {
  const pathname = useLocation().pathname;
  const isClockHome = pathname === "/clock";
  const current = pathname.startsWith("/forms") ? "表單申請" : pathname.startsWith("/profile") ? "個人資訊" : "打卡日曆";

  return <div className="hr-module hr-module-self">
    {isClockHome ? <PersonalNav className="hr-personal-nav hr-clock-personal-nav" /> : <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <PersonalNav className="hr-personal-nav hr-personal-top-nav" />
    </header>}
    <PersonalNav className="hr-personal-bottom-nav" />
    <Outlet />
  </div>;
}
