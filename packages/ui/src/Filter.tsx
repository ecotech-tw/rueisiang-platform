import type { ChangeEventHandler, InputHTMLAttributes } from "react";
import { defaultUnless } from "./class-defaults.js";
import { DropdownSelect } from "./DropdownSelect.js";
import { Input } from "./Field.js";

/**
 * 工具列的主搜尋框：桌機最寬 340px，手機跟旁邊的「篩選」鈕共用一行。
 * 手機改成 flex-basis: 0 只吃「剩下的」寬度——寬度還宣告成 min(340px, 100%) 的話，
 * flex 就沒有理由把按鈕留在同一行。
 */
// 手機上跟旁邊的篩選共用一列，但至少留 12rem：旁邊是兩個下拉選單時，縮到 0 的搜尋框只剩一個字寬（額度發放）。放不下就讓選單換行。
export const SEARCH_INPUT_WIDTH = "w-[min(340px,100%)] max-[760px]:w-auto max-[760px]:min-w-[min(100%,12rem)] max-[760px]:flex-[1_1_0]";

export interface FilterInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "aria-label" | "size"> {
  label: string;
  /** 只放版面用途（寬度、伸縮）。主搜尋框用 SEARCH_INPUT_WIDTH。 */
  className?: string;
}

/** 沒有可見標籤的精簡輸入框：工具列的篩選，以及行內的新增／改名。label 變成 aria-label。 */
export function FilterInput({ label, ...inputProps }: FilterInputProps) {
  return <Input {...inputProps} size="sm" aria-label={label} />;
}

export interface FilterSelectOption {
  label: string;
  value: string;
}

export interface FilterSelectProps {
  label: string;
  options: readonly FilterSelectOption[];
  value?: string | number;
  defaultValue?: string | number;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  /** 只放版面用途，套在外層：下拉預設是內容寬度，要伸縮或設最小寬度寫在這裡。 */
  className?: string;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

/** 工具列用的精簡下拉欄位：options 與 aria label 都由元件統一輸出。 */
export function FilterSelect({ label, options, className = "", ...selectProps }: FilterSelectProps) {
  // 外層這一格才是工具列的 flex 子項：下拉的表單值是藏在按鈕旁邊的 input，兩個要包在一起。
  return (
    <span className={`inline-flex w-max max-w-full ${defaultUnless(className, "min-w-", "min-w-0")} ${className}`.trim()}>
      <DropdownSelect {...selectProps} size="sm" options={options} aria-label={label} />
    </span>
  );
}
