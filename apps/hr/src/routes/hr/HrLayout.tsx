import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
import { DialogScope } from "../../ui/index.js";
import { Icon, type IconName } from "../../shell/icons.js";
import { useHrQuery, type HrNotificationsResponse } from "./api.js";
import { pageDirection, type SlideDirection } from "./page-direction.js";

const personalLinks: { to: string; label: string; icon: IconName; center?: boolean }[] = [
  { to: "/work", label: "工作", icon: "report" },
  { to: "/payroll", label: "薪資袋", icon: "payments" },
  { to: "/clock", label: "打卡", icon: "clock", center: true },
  { to: "/notifications", label: "通知", icon: "notifications" },
  { to: "/profile", label: "個人中心", icon: "person" },
];

function navigationPath(pathname: string) {
  const path = pathname.toLowerCase();
  return ["/forms", "/scheduling"].some((section) => path === section || path.startsWith(`${section}/`)) ? `/work${path}` : path;
}

function PersonalNav({ className }: { className: string }) {
  const pathname = navigationPath(useLocation().pathname);
  const { user } = useSession();
  const worker = user?.hrSelfServiceKind === "worker";
  const notifications = useHrQuery<HrNotificationsResponse>("/me/notifications", !worker);
  const links = worker ? personalLinks.filter((link) => ["/clock", "/payroll"].includes(link.to)).map((link) => ({ ...link, center: false })) : personalLinks;
  return <nav className={className} style={worker ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } : undefined} aria-label="本人 HR 功能">
    {links.map((link) => {
      const active = pathname === link.to || (!link.center && pathname.startsWith(`${link.to}/`));
      return <Link
      key={link.to}
      to={link.to}
      aria-label={link.label}
      aria-current={active ? "page" : undefined}
      className={`${link.center ? "hr-personal-bottom-link center" : "hr-personal-bottom-link"} font-semibold${active ? " active" : ""}`}
    >
      <span className="hr-personal-nav-icon"><Icon name={link.icon} weight="semibold" className="size-6" />{link.to === "/notifications" && notifications.data?.unreadCount ? <small className="hr-personal-nav-badge">{notifications.data.unreadCount > 99 ? "99+" : notifications.data.unreadCount}</small> : null}</span>
      <span className="hr-personal-nav-label max-[760px]:hidden">{link.label}</span>
    </Link>; })}
  </nav>;
}


const personalSections = personalLinks.map((link) => link.to);

// 打卡首頁與子頁有自己的進出動畫（子頁從下方滑上來），不跟著左右換頁滑動。
const PAGE_SWIPE: Record<SlideDirection, string> = {
  forward: "motion-safe:[&>[data-page]:not([data-clock-page])]:animate-[hr-page-swipe-in_.24s_cubic-bezier(.05,.7,.1,1)]",
  back: "motion-safe:[&>[data-page]:not([data-clock-page])]:animate-[hr-page-swipe-in-back_.24s_cubic-bezier(.05,.7,.1,1)]",
};

export function HrLayout() {
  const pathname = useLocation().pathname.toLowerCase();
  // render 期間就要算出方向：新頁面是在同一次 commit 掛上去的，等 effect 才更新的話
  // 它已經照舊方向開始滑了。
  const [slide, setSlide] = useState<{ pathname: string; direction: SlideDirection }>({ pathname, direction: "forward" });
  const direction = slide.pathname === pathname ? slide.direction : pageDirection(personalSections, navigationPath(slide.pathname), navigationPath(pathname)) ?? slide.direction;
  if (slide.pathname !== pathname) setSlide({ pathname, direction });
  const isClockHome = pathname === "/clock";
  const current = pathname === "/work" ? "工作" : pathname.startsWith("/scheduling") ? "據點排班" : pathname.startsWith("/forms") ? "表單申請" : pathname.startsWith("/payroll") ? "薪資袋" : pathname.startsWith("/notifications") ? "通知" : pathname.startsWith("/profile") ? "個人中心" : "打卡";

  return <DialogScope className="hr-module-self"><div className={`hr-module hr-module-self has-[[data-clock-page=full]]:relative has-[[data-clock-page=full]]:block has-[[data-clock-page=full]]:min-h-full ${PAGE_SWIPE[direction]}${pathname.startsWith("/scheduling") ? " max-[760px]:pb-[calc(var(--hr-safe-bottom)+52px)]" : ""}`}>
    {isClockHome ? <PersonalNav className="hr-personal-nav fixed top-6 right-9 z-5 rounded-full border border-ink/10 bg-paper/84 p-1 [box-shadow:0_8px_24px_--alpha(var(--color-ink)/10%)] [backdrop-filter:blur(14px)] [&_a]:px-[13px] max-[760px]:hidden" /> : <header className="hr-module-header">
      <div className="hr-module-title"><span className="hr-module-current">{current}</span></div>
      <PersonalNav className="hr-personal-nav hr-personal-top-nav" />
    </header>}
    <PersonalNav className="hr-personal-bottom-nav" />
    <Outlet />
  </div></DialogScope>;
}
