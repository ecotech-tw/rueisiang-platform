import type { ReactNode } from "react";
import { Icon, type IconName } from "../shell/icons.js";

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

const STATUS_CLASS: Record<StatusTone, string> = {
  success: "ui-status-success",
  info: "ui-status-info",
  warning: "ui-status-warning",
  danger: "ui-status-danger",
  neutral: "ui-status-neutral",
};

export function StatusBadge({ tone = "neutral", children, className = "" }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return <span className={`status ${STATUS_CLASS[tone]} ${className}`.trim()}>{children}</span>;
}

const ALERT_ICON: Record<StatusTone, IconName> = {
  success: "check",
  info: "info",
  warning: "info",
  danger: "info",
  neutral: "info",
};

export function Alert({ tone = "info", children, className = "" }: { tone?: StatusTone; children: ReactNode; className?: string }) {
  return (
    <div className={`ui-alert ui-alert-${tone} ${className}`.trim()} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={ALERT_ICON[tone]} />
      <div>{children}</div>
    </div>
  );
}
