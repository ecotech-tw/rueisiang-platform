import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../shell/icons.js";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "icon"
  | "link"
  | "chip"
  | "chip-label"
  | "chip-remove"
  | "chip-action";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
   
  loadingLabel?: ReactNode;
   
  selected?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

 
export function Button({
  variant = "primary",
  icon,
  loading = false,
  loadingLabel,
  selected = false,
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
    icon && variant !== "icon" ? "with-icon" : "",
    className,
  ].filter(Boolean).join(" ");

  return (
    <button
      {...props}
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
