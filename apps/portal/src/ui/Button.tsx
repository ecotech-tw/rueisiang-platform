import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "../shell/icons.js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "icon";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Portal 的唯一按鈕入口。
 *
 * variant 決定語意，不讓 page 自己拼 primary-button、ghost-button 與 danger class；
 * 這樣 Material 3 的尺寸、焦點與 disabled 狀態只需要在 CSS 維護一份。
 */
export function Button({
  variant = "primary",
  icon,
  loading = false,
  className = "",
  disabled = false,
  type = "button",
  children,
  ...props
}: ButtonProps) {
  const baseClass = variant === "icon" ? "icon-button" : variant === "primary" || variant === "danger" ? "primary-button" : "ghost-button";
  const classes = [
    baseClass,
    variant === "danger" ? "danger" : "",
    icon && variant !== "icon" ? "with-icon" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      {...props}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {loading ? "處理中…" : children}
    </button>
  );
}
