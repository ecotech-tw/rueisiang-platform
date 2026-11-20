import type { ComponentProps, CSSProperties, ReactNode, Ref } from "react";

/*
 * HRIS 頁首的玻璃外殼。HrLayout 與樣式指南的 Liquid Glass 範例共用同一組元件，
 * 範例只是 compact：塞在一張卡片裡，所以內距小、導覽格子固定寬，也不跟著視窗捲。
 *
 * 每一塊玻璃都是三層：本體的 backdrop-filter、::before 的光澤（再疊 SVG 扭曲，濾鏡定義在
 * HrGlassDefs）、::after 的內緣光暈。數值都是 theme.css 的 token。
 */
const BLUR = "[-webkit-backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)]";
const CHIP_LAYERS = "before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-chip-sheen)] before:[filter:url(#hr-liquid-glass-soft)] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-chip-glow)]";
const DROPDOWN_LAYERS = "before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-dropdown-sheen)] before:[filter:url(#hr-liquid-glass-menu)] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-chip-glow)]";
const DROPDOWN = "absolute isolate top-[calc(100%+10px)] z-30 grid w-max max-w-[min(360px,calc(100vw-32px))] gap-[3px] rounded-[18px] border border-transparent bg-paper/84 p-2 [box-shadow:var(--shadow-glass-dropdown)] [-webkit-backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] [backdrop-filter:blur(28px)_saturate(205%)_contrast(110%)] transition-[opacity,transform,visibility] duration-150 ease-out";
const DROPDOWN_CLOSED = "pointer-events-none invisible opacity-0";
const DROPDOWN_OPEN = "pointer-events-auto visible opacity-100";

/** 頁首與內容區疊在同一個 grid 裡：頁首固定高度，內容區吃掉剩下的高度並自己捲。 */
export const HR_SHELL = "grid h-full min-h-0 w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] content-stretch gap-0";

/** 玻璃光澤用的 SVG 扭曲。一頁只要一份，id 被 ::before 的 filter: url(#…) 指著。 */
export function HrGlassDefs() {
  return (
    <svg className="pointer-events-none absolute size-0 overflow-hidden" aria-hidden="true" focusable="false">
      <filter id="hr-liquid-glass-soft" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves="2" seed="7" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
      </filter>
      <filter id="hr-liquid-glass-menu" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.014 0.02" numOctaves="2" seed="11" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

export function HrHeader({ compact = false, children }: { compact?: boolean; children: ReactNode }) {
  return (
    <header className={`top-0 z-18 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[18px] bg-transparent max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:items-start max-[900px]:gap-3 ${compact ? "relative px-[18px] pt-4 pb-3" : "sticky px-9 pt-4 pb-3 max-[900px]:px-4 max-[900px]:pt-3 max-[900px]:pb-3.5"}`}>
      {children}
    </header>
  );
}

/*
 * 進出 HRIS 的 View Transition 只在轉場那一刻掛上 view-transition-name（:root[data-hr-transition]）：
 * 常駐的話，之後任何一次 View Transition 都會把頁首拆成獨立圖層。動畫本身在 hr.css。
 */
export function HrBrand({ current, compact = false }: { current: string; compact?: boolean }) {
  return (
    <div className={`relative isolate inline-flex min-h-[46px] min-w-0 items-center gap-3 overflow-hidden rounded-full border border-transparent bg-paper/22 px-3.5 py-1.5 [box-shadow:var(--shadow-glass-rim)] ${BLUR} ${CHIP_LAYERS} max-[900px]:col-[1] [:root[data-hr-transition]_&]:[view-transition-name:hr-brand]`}>
      <img className={`h-auto flex-none object-contain ${compact ? "w-[min(142px,25vw)]" : "w-[142px]"}`} src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={150} height={38} />
      <span className="inline-grid min-h-[30px] place-items-center border-l border-l-ink/6 pr-[11px] pl-[13px] text-[15px] font-black tracking-[.12em] text-brand-dark">HRIS</span>
      <strong className={`truncate text-[12px] font-extrabold text-muted ${compact ? "max-[720px]:hidden" : ""}`}>{current}</strong>
    </div>
  );
}

/*
 * 選中那一格底下滑動的玻璃膠囊（參考 Liquid Glass Switcher）。位置與寬度由呼叫端量好寫進
 * --hr-thumb-x / --hr-thumb-w；nav 帶 data-thumb 才顯示，data-thumb-ready 之前不開 transition，
 * 第一次載入才不會從最左邊滑進來。手機改成分欄排列，選中那格自己帶玻璃底，thumb 就不需要了。
 */
export function HrNav({ label, ref, thumbRef, style, children }: { label: string; ref?: Ref<HTMLElement>; thumbRef?: Ref<HTMLSpanElement>; style?: CSSProperties; children: ReactNode }) {
  return (
    <nav
      ref={ref}
      aria-label={label}
      style={style}
      className={`relative isolate inline-flex min-w-0 max-w-full justify-self-center gap-1 overflow-visible rounded-full border border-transparent bg-paper/20 p-1.5 [box-shadow:var(--shadow-glass-rim)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${BLUR} ${CHIP_LAYERS} max-[900px]:col-[1/-1] max-[900px]:flex-wrap max-[900px]:content-start max-[900px]:justify-self-stretch [:root[data-hr-transition]_&]:[view-transition-name:hr-nav]`}
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
  // 手機不靠 hover：大項兩兩一列，展開的那一格佔滿整列，子選單放回流程裡。
  const layout = compact
    ? "flex-none max-[900px]:min-w-0 max-[720px]:flex-[1_1_calc(50%-4px)]"
    : open ? "max-[900px]:min-w-0 max-[900px]:flex-[1_1_100%]" : "max-[900px]:min-w-0 max-[900px]:flex-[1_1_calc(50%-4px)]";
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
  const size = compact ? "w-[84px] justify-center px-2 max-[720px]:w-full" : "px-[15px] max-[900px]:w-full max-[900px]:justify-center max-[900px]:px-3";
  return `group/link relative inline-flex min-h-[38px] cursor-pointer items-center gap-2 overflow-hidden rounded-full border-0 text-[13px] font-extrabold whitespace-nowrap no-underline [text-align:inherit] transition-[background-color,color,scale,box-shadow] duration-150 ease-out active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${tone} ${size}`;
}

/** 大項的圖示：滑過時微微放大，選中那一格維持原尺寸。 */
export function hrNavIconClass(active: boolean) {
  return `size-[19px] flex-none transition-[scale] duration-200 ease-[cubic-bezier(0.5,0,0,1)] ${active ? "" : "group-hover/link:[scale:1.2]"}`;
}

export function hrNavChevronClass(open: boolean) {
  return `size-[15px] flex-none text-muted transition-[transform] duration-150 ease-out ${open ? "[transform:rotate(180deg)]" : ""}`;
}

export function hrSubmenuClass(open: boolean) {
  return `${DROPDOWN} ${DROPDOWN_LAYERS} left-1/2 min-w-[190px] max-[900px]:left-0 max-[900px]:w-full max-[900px]:max-w-full max-[900px]:min-w-0 ${open
    ? `${DROPDOWN_OPEN} [transform:translate(-50%,0)] max-[900px]:static max-[900px]:mt-1 max-[900px]:[transform:translate(0,0)]`
    : `${DROPDOWN_CLOSED} [transform:translate(-50%,-6px)] max-[900px]:[transform:translate(0,-6px)]`}`;
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

/** 右上角帳號選單的外框；手機上跟品牌排同一列、靠右。 */
export const HR_USER_MENU = "relative justify-self-end max-[900px]:col-[2] max-[900px]:row-[1] [:root[data-hr-transition]_&]:[view-transition-name:hr-user]";

/** 46px 對齊左邊品牌膠囊的高度；頭像 36px ＋ 4px 玻璃邊，內外圓角同心。 */
export function hrUserTriggerClass(open: boolean) {
  return `relative isolate grid size-[46px] cursor-pointer place-items-center rounded-full border-0 p-0 [box-shadow:var(--shadow-glass-rim)] transition-[background-color,scale] duration-150 ease-out hover:bg-brand/7 active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${BLUR} ${CHIP_LAYERS} ${open ? "bg-brand/7" : "bg-paper/22"}`;
}

/** 頁首底下的內容區。桌機上 fills 的頁面只讓表格自己捲，內容區就不捲、高度吃滿；手機上照常整頁捲（見 AppShell）。 */
export function HrMain({ compact = false, children }: { compact?: boolean; children: ReactNode }) {
  return (
    <div
      data-hr-main=""
      className={`grid w-full min-w-0 min-h-0 grid-cols-[minmax(0,1fr)] gap-5 overscroll-y-contain [scrollbar-gutter:stable] ${compact
        ? "overflow-visible px-[18px] pt-3 pb-[18px]"
        // 手機的右內距留給頁首按鈕 24px 的外陰影，否則會被內容區切掉。
        : "overflow-y-auto px-9 pt-7 pb-9 min-[760px]:has-[[data-page=fills]]:h-full min-[760px]:has-[[data-page=fills]]:overflow-hidden max-[900px]:px-6 max-[900px]:pt-5 max-[900px]:pb-7"}`}
    >
      {children}
    </div>
  );
}
