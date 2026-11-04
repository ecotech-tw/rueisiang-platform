import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

// 標記與提示框共用同一組色調：同一個「失敗」在表格裡跟在提示框裡要是同一個顏色。
const TONE_COLOR: Record<StatusTone, string> = {
  success: "bg-ok-soft text-ok",
  info: "bg-info-soft text-info",
  warning: "bg-warn-soft text-warn",
  danger: "bg-brand-soft text-brand-dark",
  neutral: "bg-soft-line text-muted",
};

/*
 * 分類自己選的色階。主色從 @theme 的 --color-tone-* 來、底色用 12% 推；
 * 寫成完整的 class 字串 Tailwind 才掃得到，加新色階時這裡要跟著補。
 */
const PALETTE_COLOR: Record<string, string> = {
  rose: "bg-tone-rose/12 text-tone-rose",
  sky: "bg-tone-sky/12 text-tone-sky",
  mint: "bg-tone-mint/12 text-tone-mint",
  amber: "bg-tone-amber/12 text-tone-amber",
  violet: "bg-tone-violet/12 text-tone-violet",
  teal: "bg-tone-teal/12 text-tone-teal",
  peach: "bg-tone-peach/12 text-tone-peach",
  slate: "bg-tone-slate/12 text-tone-slate",
  lime: "bg-tone-lime/12 text-tone-lime",
  sand: "bg-tone-sand/12 text-tone-sand",
};

interface StatusBadgeProps {
  tone?: StatusTone;
  /** 分類這類使用者自選的色階（rose、sky…）。給了就取代 tone；不認得的值退回 slate。 */
  palette?: string;
  /**
   * 「正常」這種不需要注意的狀態：中性色、字重降一級。仍然給膠囊而不是裸字——
   * 同一欄一半有底色、一半沒有，看起來像哪一列沒渲染完。
   */
  quiet?: boolean;
  /** 只放版面用途。 */
  className?: string;
  children: ReactNode;
}

/*
 * justify-self-start：手機版表格的 td 是兩欄 grid，膠囊會被拉滿整格，就不像標記了。
 * 同一格兩個標記（「已同步」＋「已封鎖」）在手機上並排，要隔開一點。
 */
const BADGE_BASE = "inline-block shrink-0 justify-self-start rounded-full px-[9px] py-0.5 text-[12px] whitespace-nowrap max-[760px]:[.data-table_td>&+&]:ml-1.5";

export function StatusBadge({ tone = "neutral", palette, quiet = false, className = "", children }: StatusBadgeProps) {
  const color = palette ? (PALETTE_COLOR[palette] ?? PALETTE_COLOR.slate) : TONE_COLOR[quiet ? "neutral" : tone];
  return <span className={`${BADGE_BASE} ${quiet ? "font-medium" : "font-bold"} ${color} ${className}`.trim()}>{children}</span>;
}

const ALERT_ICON: Record<StatusTone, IconName> = {
  success: "check",
  info: "info",
  warning: "info",
  danger: "info",
  neutral: "info",
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
      className={`flex w-full flex-none items-start gap-2.5 rounded-[10px] border border-current px-3 py-2.5 ${size === "compact" ? "text-[12px]" : "text-[13px]"} ${TONE_COLOR[tone]} ${className}`.trim()}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon name={ALERT_ICON[tone]} className="mt-px size-[19px] flex-none" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
