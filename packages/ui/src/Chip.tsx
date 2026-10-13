import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./icons.js";

type ChipVariant = "filter" | "action" | "label" | "remove";

interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  /**
   * filter：可切換的篩選膠囊。action：虛線框的「新增一個」。
   * label／remove：放在 ChipGroup 裡，組成「名稱＋刪除」的分段膠囊。
   */
  variant?: ChipVariant;
  /** filter／label 的選取狀態，會同步 aria-pressed；remove 也要傳，叉叉的顏色才會跟著變。 */
  selected?: boolean;
  /** sm 給圖表標題列這類擠的位置。只對 filter 有效。 */
  size?: "md" | "sm";
  /** success 是 action 的「新增」語意色。 */
  tone?: "brand" | "success";
  icon?: IconName;
  /** 只給版面用，規則同 Button。 */
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

const MOTION = "transition-[background-color,border-color,color,box-shadow,scale] duration-120 ease-out motion-reduce:transition-none enabled:active:scale-[.96] motion-reduce:enabled:active:scale-100";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-secondary";
const PILL = "inline-flex h-8 items-center rounded-[999px] border text-[13px]";
const UNSELECTED = "border-line bg-paper text-ink hover:bg-brand/5";
const SELECTED = "border-transparent bg-brand-soft text-brand-dark";

const ACTION_TONE = {
  brand: "border-line bg-transparent text-muted not-disabled:hover:border-brand not-disabled:hover:bg-brand/5 not-disabled:hover:text-brand",
  success: "border-transparent bg-ok/12 text-ok [box-shadow:var(--shadow-glass-tint-ok)] not-disabled:hover:bg-ok-soft",
};

function appearance(variant: ChipVariant, selected: boolean, size: "md" | "sm", tone: "brand" | "success") {
  if (variant === "action") return [PILL, "gap-1.5 border-dashed px-3.5 disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-[18px]", ACTION_TONE[tone]];
  if (variant === "label") return ["inline-flex h-[30px] items-center gap-1.5 rounded-[999px] border-0 bg-transparent py-0 pr-1 pl-3.5 [&_svg]:size-[18px]"];
  if (variant === "remove") return ["inline-flex h-[30px] w-6 items-center justify-center gap-1.5 rounded-[999px] border-0 bg-transparent p-0 not-disabled:hover:bg-ink/7 [&_svg]:size-3.5", selected ? "text-brand-dark" : "text-muted"];
  return [PILL, "font-medium [&_svg]:size-[18px]", size === "sm" ? "px-2.5 text-[11px]" : "px-3.5", selected ? SELECTED : UNSELECTED];
}

/** 膠囊形的小控制項。跟 Button 分開，是因為它表達的是「狀態／一個項目」，不是「一個動作」。 */
export function Chip({ variant = "filter", selected = false, size = "md", tone = "brand", icon, className = "", type = "button", ref, children, ...props }: ChipProps) {
  const pressable = variant === "filter" || variant === "label";
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={[MOTION, FOCUS, ...appearance(variant, selected, size, tone), className].filter(Boolean).join(" ")}
      aria-pressed={pressable ? selected : undefined}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** 分段膠囊的外框：裡面放一顆 label 與一顆 remove。 */
export function ChipGroup({ selected = false, children }: { selected?: boolean; children: ReactNode }) {
  return (
    <span className={`${PILL} pr-1 font-medium transition-[background-color,border-color,color,box-shadow,scale] duration-120 ease-out motion-reduce:transition-none ${selected ? SELECTED : UNSELECTED}`}>
      {children}
    </span>
  );
}
