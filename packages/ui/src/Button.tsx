import { useContext, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "./icons.js";
import { DialogContext } from "./dialog-context.js";

type ButtonVariant = "primary" | "secondary" | "danger" | "icon" | "link" | "text";
type ButtonTone = "brand" | "success" | "info";
type ButtonSize = "md" | "lg";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  /** 動作的語意色：success 給新增／送出／核准，info 給編輯／更新／檢視。danger 不吃 tone。 */
  tone?: ButtonTone;
  /** lg 是 44px 的觸控高度，給手機上的主要動作列。 */
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
  /** loading 時的動作文案；未提供時使用共用的「處理中…」。 */
  loadingLabel?: ReactNode;
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

const FILLED = "rounded-field border-0 px-3.5 py-[7px] text-[13px] font-bold disabled:opacity-55";
const OUTLINED = "rounded-field border px-3 py-1.5 text-[12px] whitespace-nowrap disabled:opacity-45";
const ICON_ONLY = "grid size-10 place-items-center rounded-full border-0 bg-transparent p-0 disabled:opacity-40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary [&_svg]:size-5";

const FILLED_TONE: Record<ButtonTone, string> = {
  brand: "bg-brand text-white enabled:hover:bg-brand-dark",
  success: "bg-ok text-paper enabled:hover:bg-[color-mix(in_srgb,var(--color-ok)_86%,var(--color-ink))]",
  info: "bg-info text-paper enabled:hover:bg-[color-mix(in_srgb,var(--color-info)_86%,var(--color-ink))]",
};
const OUTLINED_TONE: Record<ButtonTone, string> = {
  brand: "border-line bg-transparent text-ink enabled:hover:border-secondary",
  success: "border-ok bg-ok-soft text-ok enabled:hover:bg-[color-mix(in_srgb,var(--color-ok-soft)_86%,var(--color-ok))]",
  info: "border-info bg-info-soft text-info enabled:hover:bg-[color-mix(in_srgb,var(--color-info-soft)_86%,var(--color-info))]",
};
const ICON_TONE: Record<ButtonTone, string> = {
  brand: "text-muted enabled:hover:bg-brand/8 enabled:hover:text-brand",
  success: "text-ok enabled:hover:bg-ok-soft",
  info: "text-info enabled:hover:bg-info-soft",
};

function appearance(variant: ButtonVariant, tone: ButtonTone, size: ButtonSize, hasIcon: boolean) {
  const touch = size === "lg" ? "min-h-11" : "";
  if (variant === "icon") return [ICON_ONLY, ICON_TONE[tone]];
  if (variant === "link") return ["border-0 bg-transparent p-0 text-[12px] text-brand underline disabled:opacity-45", FOCUS, hasIcon ? "inline-flex items-center gap-1.5 [&_svg]:size-[18px] [&_svg]:flex-none" : ""];
  if (variant === "text") return ["inline-flex min-h-11 items-center gap-1 border-0 bg-transparent px-0 py-1 text-[13px] font-bold text-brand disabled:opacity-45 [&_svg]:size-[18px] [&_svg]:flex-none", FOCUS];
  if (variant === "secondary") return [OUTLINED, OUTLINED_TONE[tone], FOCUS, touch, hasIcon ? WITH_ICON : ""];
  const fill = variant === "danger"
    ? "bg-brand-dark text-white enabled:hover:bg-[color-mix(in_srgb,var(--color-brand-dark)_86%,var(--color-ink))]"
    : FILLED_TONE[tone];
  return [FILLED, fill, FOCUS, touch, hasIcon ? WITH_ICON : ""];
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
  static: isStatic = false,
  className = "",
  disabled = false,
  type = "button",
  ref,
  children,
  ...props
}: ButtonProps) {
  const classes = [
    MOTION,
    isStatic ? "" : PRESS,
    ...appearance(variant, tone, size, Boolean(icon)),
    className,
  ].filter(Boolean).join(" ");
  // Dialog 的取消／關閉 action 常直接重用 onClose；集中改走退場流程，避免各頁重複維護 closing state。
  const dialog = useContext(DialogContext);
  const resolvedOnClick = dialog?.onClose && props.onClick === dialog.onClose
    ? dialog.requestClose
    : props.onClick;

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
      {loading ? loadingLabel ?? "處理中…" : children}
    </button>
  );
}
