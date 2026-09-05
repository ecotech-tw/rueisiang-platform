import type { InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { DropdownSelect } from "./DropdownSelect.js";

export interface FilterInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label"> {
  label: string;
}

/** 工具列用的精簡搜尋欄位：保留 compact layout，但把可存取名稱集中管理。 */
export function FilterInput({ label, ...inputProps }: FilterInputProps) {
  return (
    <label className="filter-control">
      <span className="sr-only">{label}</span>
      <input {...inputProps} aria-label={label} />
    </label>
  );
}

export interface FilterSelectOption {
  label: string;
  value: string;
}

export interface FilterSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "aria-label" | "children"> {
  label: string;
  options: readonly FilterSelectOption[];
}

/** 工具列用的精簡下拉欄位：options 與 aria label 都由元件統一輸出。 */
export function FilterSelect({ label, options, className = "", ...selectProps }: FilterSelectProps) {
  return (
    <label className="filter-control">
      <span className="sr-only">{label}</span>
      <DropdownSelect {...selectProps} options={options} aria-label={label} className={className} />
    </label>
  );
}
