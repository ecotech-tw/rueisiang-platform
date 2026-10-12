import { useContext, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { Icon, type IconName } from "./icons.js";
import { DialogContext } from "./dialog-context.js";

type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "icon"
  | "link"
  | "chip"
  | "chip-label"
  | "chip-remove"
  | "chip-action";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  /** loading 時的動作文案；未提供時使用共用的「處理中…」。 */
  loadingLabel?: ReactNode;
  /** filter chip 的選取狀態；會同步套用 selected class 與 aria-pressed。 */
  selected?: boolean;
  /** 停用按下縮放；適合會被連續操作或需要保持穩定的控制項。 */
  static?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

/**
 * 外觀靠 components.css 的 class 的舊按鈕。平台管理站還有一批從外面覆寫這些 class 的規則，
 * 在它們搬完之前留著；新程式一律用 Button。
 */
export function LegacyButton({
  variant = "primary",
  icon,
  loading = false,
  loadingLabel,
  selected = false,
  static: isStatic = false,
  className = "",
  disabled = false,
  type = "button",
  ref,
  children,
  ...props
}: ButtonProps) {
  const baseClass = variant === "icon"
    ? "icon-button"
    : variant === "link"
      ? "link-button"
      : variant === "chip"
        ? "filter-chip"
        : variant === "chip-label"
          ? "filter-chip-label"
          : variant === "chip-remove"
            ? "filter-chip-remove"
            : variant === "chip-action"
              ? "chip-action"
              : variant === "primary" || variant === "danger"
                ? "primary-button"
                : "ghost-button";
  const selectable = variant === "chip" || variant === "chip-label";
  const classes = [
    baseClass,
    variant === "danger" ? "danger" : "",
    selectable && selected ? "selected" : "",
    isStatic ? "button-static" : "",
    icon && variant !== "icon" ? "with-icon" : "",
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
      aria-pressed={selectable ? selected : undefined}
      aria-busy={loading || undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {loading ? loadingLabel ?? "處理中…" : children}
    </button>
  );
}
