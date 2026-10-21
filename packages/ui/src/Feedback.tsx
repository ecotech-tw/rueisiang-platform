import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

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

const ALERT_TONE: Record<StatusTone, string> = {
  success: "bg-ok-soft text-ok",
  info: "bg-info-soft text-info",
  warning: "bg-warn-soft text-warn",
  danger: "bg-brand-soft text-brand-dark",
  neutral: "bg-soft-line text-muted",
};

export function Alert({ tone = "info", size = "normal", children, className = "" }: {
  tone?: StatusTone;
  /** compact 給擠在角落的回饋訊息用，字小一級。 */
  size?: "normal" | "compact";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // flex-none 加 w-full：在橫排、會換行的容器裡自己佔一整行；在 .page.fills 這種固定高度的直排容器裡，
      // 不會被 flex-basis 撐成跟容器一樣高，也不會被壓扁。
      className={`flex w-full flex-none items-start gap-2.5 rounded-[10px] border border-current px-3 py-2.5 ${size === "compact" ? "text-[12px]" : "text-[13px]"} ${ALERT_TONE[tone]} ${className}`.trim()}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon name={ALERT_ICON[tone]} className="mt-px size-[19px] flex-none" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
