import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "./icons.js";
import { DialogContext } from "./dialog-context.js";

type ButtonVariant = "primary" | "secondary" | "danger" | "icon" | "link" | "text";
type ButtonTone = "brand" | "success" | "info" | "danger";
type ButtonSize = "md" | "lg";
type ButtonSkinName = "solid" | "glass";

const ButtonSkinContext = createContext<ButtonSkinName>("solid");

/**
 * 這個範圍裡的按鈕換一層皮膚。glass 是 HRIS 管理介面的半透明玻璃樣式。
 * 用 context 而不是祖先選擇器：皮膚的每一條樣式仍然寫在 Button 裡，portal 出去的對話框也跟得到。
 */
export function ButtonSkin({ skin, children }: { skin: ButtonSkinName; children: ReactNode }) {
  return <ButtonSkinContext value={skin}>{children}</ButtonSkinContext>;
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /** danger 等同 primary 加上 tone="danger"。 */
  variant?: ButtonVariant;
  /** 動作的語意色：success 給新增／送出／核准，info 給編輯／更新／檢視，danger 給刪除／停用。 */
  tone?: ButtonTone;
  /** lg 是 44px 的觸控高度，給手機上的主要動作列，以及跟輸入框排在同一列的按鈕。 */
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
  /** loading 時的動作文案；未提供時使用共用的「處理中…」。 */
  loadingLabel?: ReactNode;
  /** secondary 的開啟／選取狀態（篩選面板開著、編輯模式中）。只管外觀，aria 由呼叫端給。 */
  active?: boolean;
  /** 手機寬度時收成只有圖示的 44px 圓鈕，給頁首的新增鈕。要同時給 icon 與 aria-label。 */
  mobileIconOnly?: boolean;
  /** 停用按下縮放；適合會被連續操作或需要保持穩定的控制項。 */
  static?: boolean;
  /** 只給版面用（寬度、外距、在 flex／grid 裡的位置）；顏色、尺寸、圓角用上面的 prop。 */
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

const MOTION = "transition-[background-color,border-color,color,box-shadow,scale] duration-120 ease-out motion-reduce:transition-none disabled:cursor-not-allowed";
const PRESS = "enabled:active:scale-[.96] motion-reduce:enabled:active:scale-100";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary";
const WITH_ICON = "inline-flex items-center gap-2 [&_svg]:size-[18px]";
const MOBILE_ICON_ONLY = "whitespace-nowrap max-[760px]:size-11 max-[760px]:flex-none max-[760px]:justify-center max-[760px]:rounded-[50%] max-[760px]:p-0";

const FILLED = "rounded-field border-0 px-3.5 py-[7px] text-[13px] font-bold disabled:opacity-55";
const OUTLINED = "rounded-field border px-3 py-1.5 text-[12px] whitespace-nowrap disabled:opacity-45";
const OUTLINED_ACTIVE = "border-secondary bg-brand-soft text-brand-dark";
const ICON_ONLY = "grid size-10 place-items-center rounded-[50%] border-0 p-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary [&_svg]:size-5";

const FILLED_TONE: Record<ButtonTone, string> = {
  brand: "bg-brand text-white enabled:hover:bg-brand-dark",
  success: "bg-ok text-paper enabled:hover:bg-[color-mix(in_srgb,var(--color-ok)_86%,var(--color-ink))]",
  info: "bg-info text-paper enabled:hover:bg-[color-mix(in_srgb,var(--color-info)_86%,var(--color-ink))]",
  danger: "bg-brand-dark text-white enabled:hover:bg-[color-mix(in_srgb,var(--color-brand-dark)_86%,var(--color-ink))]",
};
const OUTLINED_TONE: Record<ButtonTone, string> = {
  brand: "border-line bg-transparent text-ink enabled:hover:border-secondary",
  success: "border-ok bg-ok-soft text-ok enabled:hover:bg-[color-mix(in_srgb,var(--color-ok-soft)_86%,var(--color-ok))]",
  info: "border-info bg-info-soft text-info enabled:hover:bg-[color-mix(in_srgb,var(--color-info-soft)_86%,var(--color-info))]",
  danger: "border-line bg-transparent text-brand-dark enabled:hover:border-secondary",
};
const ICON_TONE: Record<ButtonTone, string> = {
  brand: "bg-transparent text-muted enabled:hover:bg-brand/8 enabled:hover:text-brand",
  success: "bg-transparent text-ok enabled:hover:bg-ok-soft",
  info: "bg-transparent text-info enabled:hover:bg-info-soft",
  danger: "bg-transparent text-muted enabled:hover:bg-brand-soft enabled:hover:text-brand-dark",
};

const GLASS = "[backdrop-filter:blur(6px)_saturate(145%)]";
const GLASS_FILLED_TONE: Record<ButtonTone, string> = {
  brand: "bg-info/74 text-paper [box-shadow:var(--shadow-glass-info)] enabled:hover:bg-info/92",
  success: "bg-ok/78 text-paper [box-shadow:var(--shadow-glass-ok)] enabled:hover:bg-ok/92",
  info: "bg-info/74 text-paper [box-shadow:var(--shadow-glass-info)] enabled:hover:bg-info/92",
  danger: "bg-brand-dark/86 text-paper [box-shadow:var(--shadow-glass-danger)] enabled:hover:bg-brand-dark",
};
const GLASS_OUTLINED_TONE: Record<ButtonTone, string> = {
  brand: "border-transparent bg-paper/22 text-ink [box-shadow:var(--shadow-glass)] enabled:hover:border-secondary enabled:hover:bg-brand/10",
  success: "border-transparent bg-ok/12 text-ok [box-shadow:var(--shadow-glass-tint-ok)] enabled:hover:bg-ok-soft",
  info: "border-transparent bg-info/12 text-info [box-shadow:var(--shadow-glass-tint-info)] enabled:hover:border-secondary enabled:hover:bg-info-soft",
  danger: "border-transparent bg-paper/22 text-brand-dark [box-shadow:var(--shadow-glass)] enabled:hover:border-secondary enabled:hover:bg-brand/10",
};
const GLASS_ICON_TONE: Record<ButtonTone, string> = {
  brand: "bg-paper/22 text-muted [box-shadow:var(--shadow-glass)] enabled:hover:bg-brand/10 enabled:hover:text-brand",
  success: "bg-paper/22 text-ok [box-shadow:var(--shadow-glass)] enabled:hover:bg-ok-soft",
  info: "bg-paper/22 text-info [box-shadow:var(--shadow-glass)] enabled:hover:bg-info-soft",
  danger: "bg-paper/22 text-brand-dark [box-shadow:var(--shadow-glass)] enabled:hover:bg-brand-soft",
};

function appearance(variant: ButtonVariant, tone: ButtonTone, size: ButtonSize, hasIcon: boolean, active: boolean, glass: boolean) {
  const touch = size === "lg" ? "min-h-11" : "";
  if (variant === "icon") return glass ? [ICON_ONLY, GLASS, GLASS_ICON_TONE[tone]] : [ICON_ONLY, ICON_TONE[tone]];
  if (variant === "link") return ["border-0 bg-transparent p-0 text-[12px] text-brand underline disabled:opacity-45", FOCUS, hasIcon ? "inline-flex items-center gap-1.5 [&_svg]:size-[18px] [&_svg]:flex-none" : ""];
  if (variant === "text") return ["inline-flex min-h-11 items-center gap-1 border-0 bg-transparent px-0 py-1 text-[13px] font-bold text-brand disabled:opacity-45 [&_svg]:size-[18px] [&_svg]:flex-none", FOCUS];
  if (variant === "secondary") {
    // 玻璃皮膚的開啟狀態只換文字色，底與邊框維持玻璃，跟原本 .hr-system 蓋過 .active 的結果一致。
    const look = glass ? [GLASS, GLASS_OUTLINED_TONE[active ? "danger" : tone]] : [active ? OUTLINED_ACTIVE : OUTLINED_TONE[tone]];
    return [OUTLINED, ...look, FOCUS, touch, hasIcon ? WITH_ICON : ""];
  }
  const fillTone = variant === "danger" ? "danger" : tone;
  return [FILLED, ...(glass ? [GLASS, GLASS_FILLED_TONE[fillTone]] : [FILLED_TONE[fillTone]]), FOCUS, touch, hasIcon ? WITH_ICON : ""];
}

/**
 * 平台共用的按鈕。外觀全部寫在這裡，頁面只選 variant／tone／size，不從外面覆寫。
 *
 * 需要新的樣子就加 prop，不要在頁面的 CSS 裡寫「某容器裡的 button」——
 * 那種規則就是同一顆按鈕在不同頁面長得不一樣的來源。
 */
export function Button({
  variant = "primary",
  tone = "brand",
  size = "md",
  icon,
  loading = false,
  loadingLabel,
  active = false,
  mobileIconOnly = false,
  static: isStatic = false,
  className = "",
  disabled = false,
  type = "button",
  ref,
  children,
  ...props
}: ButtonProps) {
  const glass = useContext(ButtonSkinContext) === "glass";
  const classes = [
    MOTION,
    isStatic ? "" : PRESS,
    ...appearance(variant, tone, size, Boolean(icon), active, glass),
    mobileIconOnly ? MOBILE_ICON_ONLY : "",
    className,
  ].filter(Boolean).join(" ");
  // Dialog 的取消／關閉 action 常直接重用 onClose；集中改走退場流程，避免各頁重複維護 closing state。
  const dialog = useContext(DialogContext);
  const resolvedOnClick = dialog?.onClose && props.onClick === dialog.onClose
    ? dialog.requestClose
    : props.onClick;
  const label = loading ? loadingLabel ?? "處理中…" : children;

  return (
    <button
      {...props}
      onClick={resolvedOnClick}
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {mobileIconOnly ? <span className="max-[760px]:hidden">{label}</span> : label}
    </button>
  );
}
