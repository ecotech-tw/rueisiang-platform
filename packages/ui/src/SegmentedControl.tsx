import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

type SegmentedControlSkin = "glass" | "tabs" | "outlined";

export interface SegmentedControlOption {
  value: string;
  label: ReactNode;
  icon?: IconName;
  /** 標籤旁的小計數（例如「3 筆」）；只有 `skin="tabs"` 會畫成膠囊。 */
  badge?: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps {
  options: readonly SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  disabled?: boolean;
  /** `glass` 用於玻璃面板；`tabs` 用於員工站分頁；`outlined` 是工具列的連接式描邊切換。 */
  skin?: SegmentedControlSkin;
  /** 圖示模式仍保留文字作為可存取名稱。 */
  iconOnly?: boolean;
  size?: "md" | "lg";
  /** 選項多、字又長的那種（加班時數的快速選擇）：窄螢幕把左右內距收掉並禁止換行。 */
  dense?: boolean;
  className?: string;
}

// box-shadow 與 backdrop-filter 用任意屬性寫，不用 shadow-*／backdrop-* utility：
// 那兩組 utility 會跟 ring、其他濾鏡的變數疊成一串，算出來的值跟原本的規則對不起來。
const TRACK_CLASS = {
  outlined: "",
  glass: "bg-paper/34 [box-shadow:0_1px_0_--alpha(var(--color-paper)/58%)_inset,0_0_0_1px_--alpha(var(--color-paper)/18%)_inset]",
  tabs: "border border-soft-line bg-paper/82 [box-shadow:0_8px_18px_--alpha(var(--color-ink)/9%),0_1px_0_--alpha(var(--color-paper)/68%)_inset]",
} as const;

const ITEM_CLASS = {
  outlined: "inline-flex items-center justify-center gap-1.5 rounded-none first:rounded-l-full last:rounded-r-full border-0 [&+button]:border-l [&+button]:border-line disabled:cursor-not-allowed disabled:opacity-45",
  glass: "border-none",
  tabs: "inline-flex items-center justify-center gap-1.5 border border-transparent",
} as const;

const SELECTED_CLASS = {
  outlined: "bg-brand-soft text-brand-dark",
  glass: "bg-paper/56 text-brand-dark [box-shadow:0_1px_0_--alpha(var(--color-paper)/62%)_inset,0_8px_18px_--alpha(var(--color-ink)/8%)]",
  tabs: "bg-brand-soft text-brand-dark [box-shadow:0_4px_12px_--alpha(var(--color-brand)/14%),0_0_0_1px_--alpha(var(--color-brand)/20%)_inset]",
} as const;

const HEIGHT_CLASS = {
  md: "min-h-[38px]",
  lg: "min-h-10",
} as const;

// 左右內距四種組合各寫一組，避免同一個斷點上有兩個 px-* 互相蓋。
function paddingClass(skin: SegmentedControlSkin, dense: boolean): string {
  if (skin === "outlined") return "px-3";
  if (skin === "tabs") return dense ? "px-3.5 max-[760px]:px-1 max-[620px]:whitespace-nowrap" : "px-3.5 max-[760px]:px-2";
  return dense ? "px-3.5 max-[620px]:px-1 max-[620px]:whitespace-nowrap" : "px-3.5";
}

/** 共用的互斥選項控制；選取語意與 aria-pressed 不由各頁自行拼接。 */
export function SegmentedControl({ options, value, onChange, "aria-label": ariaLabel, disabled = false, skin = "glass", iconOnly = false, size = "md", dense = false, className = "" }: SegmentedControlProps) {
  return (
    <div
      className={`inline-flex ${skin === "outlined" ? "w-auto gap-0 rounded-full border border-line bg-paper" : "w-full gap-1 rounded-[999px] p-[5px] [-webkit-backdrop-filter:blur(8px)_saturate(155%)] [backdrop-filter:blur(8px)_saturate(155%)]"} ${TRACK_CLASS[skin]} ${className}`.trim()}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={[
              `flex-1 cursor-pointer py-0 text-[13px] font-extrabold ${skin === "outlined" ? "" : "rounded-[999px]"}`,
              "[transition-property:background-color,color,scale,box-shadow] duration-150 ease-[ease-out] motion-reduce:[transition:none]",
              "active:[scale:.96] motion-reduce:active:[scale:1]",
              `focus-visible:relative focus-visible:z-1 focus-visible:outline-2 ${skin === "outlined" ? "focus-visible:-outline-offset-2" : "focus-visible:outline-offset-2"} focus-visible:outline-secondary`,
              ITEM_CLASS[skin],
              HEIGHT_CLASS[size],
              skin === "tabs" ? "max-[760px]:min-h-[42px]" : "",
              paddingClass(skin, dense),
              selected ? SELECTED_CLASS[skin] : "bg-transparent text-muted hover:bg-brand/8 hover:text-brand-dark",
            ].filter(Boolean).join(" ")}
            aria-pressed={selected}
            aria-label={iconOnly && typeof option.label === "string" ? option.label : undefined}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <Icon name={option.icon} className="size-[18px] shrink-0" /> : null}
            {iconOnly ? <span className="sr-only">{option.label}</span> : option.badge === undefined ? option.label : <>
              <span>{option.label}</span>
              <small className={`text-[11px] tabular-nums ${selected && skin === "tabs" ? "min-w-[22px] rounded-[999px] bg-brand px-[5px] py-px whitespace-nowrap text-paper" : "min-w-[18px] text-muted"}`}>{option.badge}</small>
            </>}
          </button>
        );
      })}
    </div>
  );
}
