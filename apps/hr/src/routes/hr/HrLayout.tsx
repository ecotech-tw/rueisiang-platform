import { useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useSession } from "../../auth/session.js";
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

type NavVariant = "pill" | "top" | "bottom";

const NAV: Record<NavVariant, string> = {
  pill: "fixed top-6 right-9 z-5 flex min-w-0 items-center gap-1 overflow-x-auto rounded-full border border-ink/10 bg-paper/84 p-1 [box-shadow:0_8px_24px_--alpha(var(--color-ink)/10%)] [backdrop-filter:blur(14px)] max-[760px]:hidden",
  top: "flex min-w-0 items-center gap-1 overflow-x-auto max-[760px]:hidden",
  // 表單填寫頁有自己釘在底部的送出列，底部導覽要讓開；認的是頁面自己帶的 data-form-page。
  bottom: "fixed right-1/2 bottom-(--hr-safe-bottom) left-auto z-20 hidden min-h-[70px] w-[min(420px,calc(100%-12px))] grid-cols-5 items-center overflow-visible rounded-[22px] border border-paper/62 bg-paper/58 px-2 py-[5px] [box-shadow:0_12px_34px_--alpha(var(--color-ink)/18%)] [-webkit-backdrop-filter:blur(18px)_saturate(170%)] [backdrop-filter:blur(18px)_saturate(170%)] [transform:translateX(50%)] [@supports_not_((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:bg-paper/92 max-[760px]:grid group-has-[[data-form-page]]/hr-module:hidden",
};

function navLinkClass(variant: NavVariant, center: boolean, active: boolean) {
  if (variant !== "bottom") {
    return `rounded-full py-2 text-[13px] font-semibold whitespace-nowrap no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${variant === "pill" ? "px-[13px]" : "px-3.5"} ${active ? "bg-brand-soft text-brand-dark" : "text-muted hover:bg-brand/7 hover:text-brand-dark"}`;
  }
  if (center) return `relative z-1 -mt-3 grid min-h-[66px] w-full place-items-center content-center gap-0.5 self-start rounded-[14px] p-0 text-[10px] font-semibold no-underline ${active ? "text-brand-dark" : "text-muted"}`;
  return `relative z-1 grid min-h-[54px] w-full place-items-center content-center gap-0.5 rounded-[14px] px-0 py-0.5 text-[10px] font-semibold no-underline ${active ? "text-brand-dark after:absolute after:bottom-px after:size-1 after:rounded-full after:bg-brand after:content-['']" : "text-muted"}`;
}

function navIconClass(variant: NavVariant, center: boolean, active: boolean) {
  if (variant !== "bottom") return "relative grid place-items-center";
  if (center) return `absolute top-0 grid size-[58px] place-items-center rounded-full border-4 border-paper text-paper [box-shadow:0_5px_12px_--alpha(var(--color-ink)/20%)] ${active ? "bg-brand-dark" : "bg-brand"}`;
  return `relative grid place-items-center ${active ? "text-brand-dark" : "text-muted"}`;
}

function PersonalNav({ variant }: { variant: NavVariant }) {
  const pathname = navigationPath(useLocation().pathname);
  const { user } = useSession();
  const worker = user?.hrSelfServiceKind === "worker";
  const notifications = useHrQuery<HrNotificationsResponse>("/me/notifications", !worker);
  const links = worker ? personalLinks.filter((link) => ["/clock", "/payroll"].includes(link.to)).map((link) => ({ ...link, center: false })) : personalLinks;
  return <nav className={NAV[variant]} data-nav={variant} style={worker ? { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } : undefined} aria-label="本人 HR 功能">
    {links.map((link) => {
      const center = Boolean(link.center);
      const active = pathname === link.to || (!center && pathname.startsWith(`${link.to}/`));
      return <Link
      key={link.to}
      to={link.to}
      aria-label={link.label}
      aria-current={active ? "page" : undefined}
      data-center={center ? "" : undefined}
      className={navLinkClass(variant, center, active)}
    >
      <span className={navIconClass(variant, center, active)}><Icon name={link.icon} weight="semibold" className="size-6" />{link.to === "/notifications" && notifications.data?.unreadCount ? <small className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-brand px-1 py-px text-center text-[9px] leading-[14px] font-extrabold text-paper">{notifications.data.unreadCount > 99 ? "99+" : notifications.data.unreadCount}</small> : null}</span>
      <span className="max-[760px]:hidden">{link.label}</span>
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

  // fills 頁（我的排班）要一個有界的 grid track，grows 區塊才會在模組內捲，而不是把整頁撐高。
  return <div className={`group/hr-module grid gap-5 has-[>[data-page=fills]]:h-full has-[>[data-page=fills]]:min-h-0 has-[>[data-page=fills]]:grid-rows-[auto_minmax(0,1fr)] max-[760px]:has-[>[data-page=fills]]:grid-rows-[minmax(0,1fr)] has-[[data-clock-page=full]]:relative has-[[data-clock-page=full]]:block has-[[data-clock-page=full]]:min-h-full max-[760px]:gap-3.5 max-[760px]:has-[[data-form-page]]:pb-4 ${pathname.startsWith("/scheduling") ? "max-[760px]:pb-[calc(var(--hr-safe-bottom)+52px)]" : "max-[760px]:pb-[calc(var(--hr-safe-bottom)+72px)] max-[760px]:has-[>[data-page=fills]]:pb-[calc(var(--hr-safe-bottom)+50px)]"} ${PAGE_SWIPE[direction]}`}>
    {isClockHome ? <PersonalNav variant="pill" /> : <header className="flex items-center justify-between gap-[18px] border-b border-b-line pb-2.5 max-[760px]:hidden">
      <div className="flex flex-none items-baseline gap-2.5"><span className="text-[14px] font-bold text-muted">{current}</span></div>
      <PersonalNav variant="top" />
    </header>}
    <PersonalNav variant="bottom" />
    <Outlet />
  </div>;
}
