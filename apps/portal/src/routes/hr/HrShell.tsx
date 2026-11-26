import type { ComponentProps, CSSProperties, FocusEventHandler, ReactNode, Ref } from "react";
import { GLASS_BLUR, GLASS_BRAND_CHIP, GLASS_CHIP_LAYERS, GlassDefs, glassCircleButtonClass } from "../../shell/glass.js";

/*
 * HRIS 頁首的玻璃外殼。HrLayout 與樣式指南的 Liquid Glass 範例共用同一組元件，
 * 範例只是 compact：塞在一張卡片裡，所以內距小、導覽格子固定寬，也不跟著視窗捲。
 * 玻璃的三層材質（模糊、光澤、內緣光暈）在 shell/glass.tsx，其他模組的手機上方列也用它。
 */
const DROPDOWN_LAYERS = "before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-dropdown-sheen)] before:[filter:url(#hr-liquid-glass-menu)] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-chip-glow)]";
const DROPDOWN = "absolute isolate top-[calc(100%+10px)] z-30 grid w-max max-w-[min(360px,calc(100vw-32px))] gap-[3px] rounded-[18px] border border-transparent bg-paper/84 p-2 [box-shadow:var(--shadow-glass-dropdown)] [-webkit-backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] [backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] transition-[opacity,transform,visibility] duration-150 ease-out";
const DROPDOWN_CLOSED = "pointer-events-none invisible opacity-0";
const DROPDOWN_OPEN = "pointer-events-auto visible opacity-100";

/** 頁首與內容區疊在同一個 grid 裡：頁首固定高度，內容區吃掉剩下的高度並自己捲。 */
export const HR_SHELL = "grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] content-stretch gap-0";

/** 玻璃光澤用的 SVG 扭曲，跟其他模組的手機上方列共用（shell/glass.tsx）。 */
export const HrGlassDefs = GlassDefs;

export function HrHeader({ compact = false, ref, onBlur, children }: { compact?: boolean; ref?: Ref<HTMLElement>; onBlur?: FocusEventHandler<HTMLElement>; children: ReactNode }) {
  return (
    <header ref={ref} onBlur={onBlur} className={`top-0 z-18 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[18px] bg-transparent ${compact ? "max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:items-start max-[900px]:gap-3" : "max-[900px]:grid-cols-[minmax(0,1fr)_auto_auto] max-[900px]:gap-2.5"} ${compact ? "relative px-[18px] pt-4 pb-3" : "sticky px-9 pt-4 pb-3 max-[900px]:px-4 max-[900px]:pt-3 max-[900px]:pb-3.5"}`}>
      {children}
    </header>
  );
}

/*
 * 進出 HRIS 的 View Transition 只在轉場那一刻掛上 view-transition-name（:root[data-hr-transition]）：
 * 常駐的話，之後任何一次 View Transition 都會把頁首拆成獨立圖層。動畫本身在 hr.css。
 */
/*
 * 手機上頁面不顯示 h1（見 HrSkins 的 MobilePageTitle），改由這裡寫出目前在哪一頁：logo 縮小、
 * 「HRIS」字樣讓位給頁名。桌機照舊是「HRIS ＋ 所在大項」。
 */
/** system 是系統名稱：HRIS 與會計共用這套頁首，只換名字。 */
export function HrBrand({ current, page, compact = false, system = "HRIS" }: { current: string; page?: string; compact?: boolean; system?: string }) {
  return (
    <div className={`${GLASS_BRAND_CHIP} max-[900px]:col-[1] [:root[data-hr-transition]_&]:[view-transition-name:hr-brand]`}>
      <img className={`h-auto flex-none object-contain ${compact ? "w-[min(142px,25vw)]" : "w-[142px] max-[760px]:w-[92px]"}`} src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={150} height={38} />
      <span className={`inline-grid min-h-[30px] place-items-center border-l border-l-ink/6 pr-[11px] pl-[13px] text-[15px] font-black tracking-[.12em] text-brand-dark ${compact || !page ? "" : "max-[760px]:hidden"}`.trim()}>{system}</span>
      <strong className={`truncate text-[12px] font-extrabold text-muted ${compact ? "max-[720px]:hidden" : "max-[760px]:hidden"}`}>{current}</strong>
      {page && !compact ? <strong className="hidden min-w-0 truncate border-l border-l-ink/6 pl-3 text-[15px] font-black text-ink max-[760px]:block">{page}</strong> : null}
    </div>
  );
}

/*
 * 選中那一格底下滑動的玻璃膠囊（參考 Liquid Glass Switcher）。位置與寬度由呼叫端量好寫進
 * --hr-thumb-x / --hr-thumb-w；nav 帶 data-thumb 才顯示，data-thumb-ready 之前不開 transition，
 * 第一次載入才不會從最左邊滑進來。手機改成分欄排列，選中那格自己帶玻璃底，thumb 就不需要了。
 */
export function HrNav({ label, ref, thumbRef, style, id, mobileOpen, children }: { label: string; ref?: Ref<HTMLElement>; thumbRef?: Ref<HTMLSpanElement>; style?: CSSProperties; id?: string; mobileOpen?: boolean; children: ReactNode }) {
  /*
   * 手機上六個大項排成三列會一直佔掉四分之一個螢幕，展開子選單還會撐成一顆大圓。
   * 給了 mobileOpen 的導覽在手機上改成收起來的面板，由頁首的選單鈕開關；樣式指南的範例不給，維持原樣。
   */
  const mobile = mobileOpen === undefined
    ? "max-[900px]:col-[1/-1] max-[900px]:flex-wrap max-[900px]:content-start max-[900px]:justify-self-stretch"
    : `max-[900px]:absolute max-[900px]:inset-x-4 max-[900px]:justify-self-stretch max-[900px]:top-[calc(100%-2px)] max-[900px]:z-30 max-[900px]:max-h-[calc(100dvh-96px)] max-[900px]:flex-col max-[900px]:gap-0.5 max-[900px]:overflow-y-auto max-[900px]:overscroll-contain max-[900px]:rounded-[22px] max-[900px]:bg-paper/84 max-[900px]:p-2 max-[900px]:[box-shadow:var(--shadow-glass-dropdown)] max-[900px]:[-webkit-backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] max-[900px]:[backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] ${mobileOpen ? "" : "max-[900px]:hidden"}`;
  return (
    <nav
      ref={ref}
      id={id}
      aria-label={label}
      style={style}
      className={`relative isolate inline-flex min-w-0 max-w-full justify-self-center gap-1 overflow-visible rounded-full border border-transparent bg-paper/20 p-1.5 [box-shadow:var(--shadow-glass-rim)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${GLASS_BLUR} ${GLASS_CHIP_LAYERS} ${mobile} [:root[data-hr-transition]_&]:[view-transition-name:hr-nav]`}
    >
      <span
        ref={thumbRef}
        aria-hidden="true"
        className="pointer-events-none absolute top-1.5 bottom-1.5 left-0 z-0 w-[var(--hr-thumb-w,0px)] rounded-full bg-paper/30 opacity-0 [box-shadow:var(--shadow-glass-thumb)] [translate:var(--hr-thumb-x,0px)_0] [-webkit-backdrop-filter:blur(6px)_saturate(145%)] [backdrop-filter:blur(6px)_saturate(145%)] [[data-thumb]>&]:opacity-100 [[data-thumb-ready]>&]:transition-[translate,width,opacity] [[data-thumb-ready]>&]:duration-400 [[data-thumb-ready]>&]:ease-[cubic-bezier(1,0,0.4,1)] max-[900px]:hidden"
      />
      {children}
    </nav>
  );
}

// 版面由這裡決定，不收 className：收了也會被下面寫死的 className 蓋掉，等於靜靜吞掉。
type NavItemProps = Omit<ComponentProps<"div">, "className"> & { active: boolean; open?: boolean; compact?: boolean };

/** 一格導覽。底下多一條 10px 的透明橋，滑鼠從大項移到子選單的途中不會掉出 hover。 */
export function HrNavItem({ active, open = false, compact = false, children, ...rest }: NavItemProps) {
  // 手機不靠 hover：面板裡一項一列，子選單放回流程裡、接在大項底下。
  const layout = compact
    ? "flex-none max-[900px]:min-w-0 max-[720px]:flex-[1_1_calc(50%-4px)]"
    : "max-[900px]:w-full max-[900px]:min-w-0";
  return (
    <div {...rest} data-active={active ? "" : undefined} className={`relative z-1 after:absolute after:inset-x-0 after:top-full after:h-2.5 ${layout}`}>
      {children}
    </div>
  );
}

export function hrNavLinkClass({ active, open = false, compact = false }: { active: boolean; open?: boolean; compact?: boolean }) {
  // 選中那一格已經有 thumb 當底，不再疊 hover 的 state layer，否則玻璃會被染成一塊色。
  const tone = active
    ? "bg-transparent text-brand-dark max-[900px]:bg-paper/30 max-[900px]:[box-shadow:var(--shadow-glass-thumb)]"
    : open ? "bg-brand/7 text-brand-dark" : "bg-transparent text-muted hover:bg-brand/7 hover:text-brand-dark";
  const size = compact ? "w-[84px] justify-center px-2 max-[720px]:w-full" : "px-[15px] max-[900px]:min-h-11 max-[900px]:w-full max-[900px]:justify-start max-[900px]:px-3.5 max-[900px]:text-[14px]";
  return `group/link relative inline-flex min-h-[38px] cursor-pointer items-center gap-2 overflow-hidden rounded-full border-0 text-[13px] font-extrabold whitespace-nowrap no-underline [text-align:inherit] transition-[background-color,color,scale,box-shadow] duration-150 ease-out active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${tone} ${size}`;
}

/** 大項的圖示：滑過時微微放大，選中那一格維持原尺寸。 */
export function hrNavIconClass(active: boolean) {
  return `size-[19px] flex-none transition-[scale] duration-200 ease-[cubic-bezier(0.5,0,0,1)] ${active ? "" : "group-hover/link:[scale:1.2]"}`;
}

export function hrNavChevronClass(open: boolean) {
  return `size-[15px] flex-none text-muted transition-[transform] duration-150 ease-out max-[900px]:ml-auto ${open ? "[transform:rotate(180deg)]" : ""}`;
}

export function hrSubmenuClass(open: boolean) {
  return `${DROPDOWN} ${DROPDOWN_LAYERS} left-1/2 min-w-[190px] max-[900px]:left-0 max-[900px]:w-full max-[900px]:max-w-full max-[900px]:min-w-0 ${open
    ? `${DROPDOWN_OPEN} [transform:translate(-50%,0)] max-[900px]:static max-[900px]:mt-0.5 max-[900px]:mb-1 max-[900px]:bg-transparent max-[900px]:py-0 max-[900px]:pr-0 max-[900px]:pl-6 max-[900px]:shadow-none max-[900px]:[backdrop-filter:none] max-[900px]:before:hidden max-[900px]:after:hidden max-[900px]:[transform:translate(0,0)]`
    : `${DROPDOWN_CLOSED} [transform:translate(-50%,-6px)] max-[900px]:hidden`}`;
}

export function hrUserDropdownClass(open: boolean) {
  return `${DROPDOWN} ${DROPDOWN_LAYERS} right-0 min-w-[220px] ${open ? `${DROPDOWN_OPEN} [transform:translateY(0)]` : `${DROPDOWN_CLOSED} [transform:translateY(-6px)]`}`;
}

/** 子選單與帳號選單的一列。Focus 是鍵盤所在的位置，不改寫 active 底色，只用另一種顏色的外圈區分。 */
export function hrMenuItemClass({ active = false, danger = false, button = false }: { active?: boolean; danger?: boolean; button?: boolean }) {
  const tone = active
    ? "bg-brand/16 text-brand-dark [box-shadow:inset_0_0_0_1px_--alpha(var(--color-brand)/18%)]"
    : `hover:bg-brand/7 hover:text-brand-dark ${danger ? "text-brand-dark" : "text-muted"} ${button ? "bg-transparent" : ""}`;
  return `grid min-h-10 w-full min-w-0 grid-cols-[20px_minmax(0,1fr)] items-center gap-2.5 rounded-xl px-3 text-[13px] font-extrabold whitespace-nowrap no-underline transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-info [&>svg]:size-[19px] [&>span]:min-w-0 [&>span]:truncate ${button ? "cursor-pointer border-0 text-left" : ""} ${tone}`;
}

/** 右上角帳號選單的外框；手機上跟品牌、選單鈕排同一列、靠右。 */
export const HR_USER_MENU = "relative justify-self-end max-[900px]:col-[-2] max-[900px]:row-[1] [:root[data-hr-transition]_&]:[view-transition-name:hr-user]";

/** 46px 的圓形玻璃按鈕，跟其他模組的手機選單鈕共用（shell/glass.tsx）。 */
export const hrUserTriggerClass = glassCircleButtonClass;

/** 頁首底下的內容區。桌機上 fills 的頁面只讓表格自己捲，內容區就不捲、高度吃滿；手機上照常整頁捲（見 AppShell）。 */
export function HrMain({ compact = false, children }: { compact?: boolean; children: ReactNode }) {
  return (
    <div
      data-hr-main=""
      className={`grid w-full min-w-0 min-h-0 grid-cols-[minmax(0,1fr)] gap-5 overscroll-y-contain [scrollbar-gutter:stable] ${compact
        ? "overflow-visible px-[18px] pt-3 pb-[18px]"
        // 手機的右內距留給頁首按鈕 24px 的外陰影，否則會被內容區切掉。
        : "overflow-y-auto max-[760px]:overflow-x-hidden px-9 pt-7 pb-9 min-[760px]:has-[[data-page=fills]]:h-full min-[760px]:has-[[data-page=fills]]:overflow-hidden max-[900px]:px-6 max-[900px]:pt-5 max-[900px]:pb-7 max-[760px]:[--page-gutter:24px] max-[760px]:[--page-pad-top:20px] max-[760px]:[--page-pad-bottom:28px] max-[760px]:has-[[data-grows]_[data-pager]]:pb-0 max-[760px]:has-[[data-grows]_[data-pager]]:[--page-pad-bottom:0px]"}`}
    >
      {children}
    </div>
  );
}
