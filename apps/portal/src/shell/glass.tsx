/*
 * 平台頁首共用的玻璃零件：HRIS 的頁首與其他模組的手機上方列用同一組，長得才會一樣。
 *
 * 每一塊玻璃都是三層：本體的 backdrop-filter、::before 的光澤（再疊 SVG 扭曲，濾鏡定義在
 * GlassDefs）、::after 的內緣光暈。數值都是 theme.css 的 token。
 */
export const GLASS_BLUR = "[-webkit-backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)] [backdrop-filter:blur(7px)_saturate(150%)_contrast(102%)]";
export const GLASS_CHIP_LAYERS = "before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-chip-sheen)] before:[filter:url(#hr-liquid-glass-soft)] after:pointer-events-none after:absolute after:inset-0 after:-z-1 after:rounded-[inherit] after:[box-shadow:var(--shadow-glass-chip-glow)]";

/** 品牌膠囊：logo 加上「HRIS」或頁名。46px 高，跟右邊的圓形按鈕對齊。 */
export const GLASS_BRAND_CHIP = `relative isolate inline-flex min-h-[46px] min-w-0 items-center gap-3 overflow-hidden rounded-full border border-transparent bg-paper/22 px-3.5 py-1.5 [box-shadow:var(--shadow-glass-rim)] ${GLASS_BLUR} ${GLASS_CHIP_LAYERS}`;

/** 46px 的圓形玻璃按鈕（選單鈕、帳號頭像），對齊左邊品牌膠囊的高度；頭像 36px ＋ 4px 玻璃邊，內外圓角同心。 */
export function glassCircleButtonClass(open: boolean) {
  return `relative isolate grid size-[46px] cursor-pointer place-items-center rounded-full border-0 p-0 [box-shadow:var(--shadow-glass-rim)] transition-[background-color,scale] duration-150 ease-out hover:bg-brand/7 active:scale-96 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${GLASS_BLUR} ${GLASS_CHIP_LAYERS} ${open ? "bg-brand/7" : "bg-paper/22"}`;
}

/** 玻璃光澤用的 SVG 扭曲。一頁只要一份，id 被 ::before 的 filter: url(#…) 指著。 */
export function GlassDefs() {
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
