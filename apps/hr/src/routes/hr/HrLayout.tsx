import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { DialogScope } from "../../ui/index.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { useHrQuery, type HrNotificationsResponse } from "./api.js";
import { pageDirection, type SlideDirection } from "./page-direction.js";

const personalLinks: { to: string; label: string; shortLabel: string; icon: IconName; center?: boolean }[] = [
  { to: "/work", label: "工作", shortLabel: "工作", icon: "report" },
  { to: "/payroll", label: "薪資袋", shortLabel: "薪資", icon: "payments" },
  { to: "/clock", label: "打卡", shortLabel: "打卡", icon: "clock", center: true },
  { to: "/notifications", label: "通知", shortLabel: "通知", icon: "notifications" },
  { to: "/profile", label: "個人中心", shortLabel: "個人", icon: "person" },
];

function navigationPath(pathname: string) {
  const path = pathname.toLowerCase();
  return ["/forms", "/scheduling"].some((section) => path === section || path.startsWith(`${section}/`)) ? `/work${path}` : path;
}

function PersonalNav({ className }: { className: string }) {
  const pathname = navigationPath(useLocation().pathname);
  const notifications = useHrQuery<HrNotificationsResponse>("/me/notifications");
  return <nav className={className} aria-label="本人 HR 功能">
    {personalLinks.map((link) => {
      const active = pathname === link.to || (!link.center && pathname.startsWith(`${link.to}/`));
      return <Link
      key={link.to}
      to={link.to}
      aria-label={link.label}
      aria-current={active ? "page" : undefined}
      className={`${link.center ? "hr-personal-bottom-link center" : "hr-personal-bottom-link"}${active ? " active" : ""}`}
    >
      <span className="hr-personal-nav-icon"><Icon name={link.icon} />{link.to === "/notifications" && notifications.data?.unreadCount ? <small className="hr-personal-nav-badge">{notifications.data.unreadCount > 99 ? "99+" : notifications.data.unreadCount}</small> : null}</span>
      <span className="hr-personal-nav-label"><span className="max-[760px]:hidden">{link.label}</span><span className="min-[761px]:hidden">{link.shortLabel}</span></span>
    </Link>; })}
  </nav>;
}

 
const personalSections = personalLinks.map((link) => link.to);

export function HrLayout() {
  const pathname = useLocation().pathname.toLowerCase();
  // render 期間就要算出方向：新頁面是在同一次 commit 掛上去的，等 effect 才更新的話
  // 它已經照舊方向開始滑了。
  const [slide, setSlide] = useState<{ pathname: string; direction: SlideDirection }>({ pathname, direction: "forward" });
  const direction = slide.pathname === pathname ? slide.direction : pageDirection(personalSections, navigationPath(slide.pathname), navigationPath(pathname)) ?? slide.direction;
  if (slide.pathname !== pathname) setSlide({ pathname, direction });
  const isClockHome = pathname === "/clock";
  const current = pathname === "/work" ? "工作" : pathname.startsWith("/scheduling") ? "據點排班" : pathname.startsWith("/forms") ? "表單申請" : pathname.startsWith("/payroll") ? "薪資袋" : pathname.startsWith("/notifications") ? "通知" : pathname.startsWith("/profile") ? "個人中心" : "打卡";

  return <DialogScope className="hr-module-self"><div className={`hr-module hr-module-self${pathname.startsWith("/scheduling") ? " max-[760px]:pb-[calc(var(--hr-safe-bottom)+52px)]" : ""}`} data-page-direction={direction}>
    {isClockHome ? <PersonalNav className="hr-personal-nav hr-clock-personal-nav" /> : <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <PersonalNav className="hr-personal-nav hr-personal-top-nav" />
    </header>}
    <PersonalNav className="hr-personal-bottom-nav" />
    <Outlet />
  </div></DialogScope>;
}
