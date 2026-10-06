import type { ReactNode } from "react";

export interface SegmentedControlOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps {
  options: readonly SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  "aria-label": string;
  disabled?: boolean;
  className?: string;
}

/** 共用的互斥選項控制；選取語意與 aria-pressed 不由各頁自行拼接。 */
export function SegmentedControl({ options, value, onChange, "aria-label": ariaLabel, disabled = false, className = "" }: SegmentedControlProps) {
  return (
    <div className={`segmented-control ${className}`.trim()} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={selected ? "selected" : undefined}
            aria-pressed={selected}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
