import type { ChangeEventHandler, InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { DropdownSelect, type DropdownSelectMultipleChangeEvent } from "./DropdownSelect.js";
import { defaultUnless } from "./class-defaults.js";
import { GLASS_FIELD, useInputSkin } from "./InputSkin.js";

const GLASS_TYPES = new Set(["date", "month", "datetime-local"]);

const INPUT_BASE = "border text-ink disabled:cursor-not-allowed disabled:text-muted focus-visible:outline-2 focus-visible:outline-secondary";

// sm 是工具列與行內編輯用的精簡尺寸，高度跟 size="sm" 的下拉一致。
const INPUT_SIZE = {
  md: "min-h-(--size-field) rounded-[10px] px-3 py-2.5",
  sm: "rounded-[9px] px-2.5 py-[7px]",
} as const;

const INPUT_SKIN = {
  solid: "border-line bg-paper disabled:bg-soft-line focus-visible:outline-offset-1",
  glass: `${GLASS_FIELD} [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:rounded-full [&::-webkit-calendar-picker-indicator]:bg-brand/12`,
} as const;

// 日曆圖示的內距會把日期欄撐高；精簡尺寸要縮小它，才會跟同一列的搜尋框、下拉一樣高。
const GLASS_PICKER_PADDING = {
  md: "[&::-webkit-calendar-picker-indicator]:p-1.5",
  sm: "[&::-webkit-calendar-picker-indicator]:p-0.5",
} as const;

export type InputSize = keyof typeof INPUT_SIZE;

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  ref?: Ref<HTMLInputElement>;
  size?: InputSize;
  /** 只放版面用途（寬度、伸縮、右側留給圖示的空間）。給了 min-w-* 就取代預設的 min-w-0。 */
  className?: string;
}

/** 單行輸入框。勾選框與單選鈕不要用它，它們沒有外框與內距。 */
export function Input({ className = "", type, size = "md", ...props }: InputProps) {
  const skin = useInputSkin();
  const look = skin === "glass" && type && GLASS_TYPES.has(type) ? `${INPUT_SKIN.glass} ${GLASS_PICKER_PADDING[size]}` : INPUT_SKIN.solid;
  return <input {...props} type={type} className={`${INPUT_BASE} ${defaultUnless(className, "min-w-", "min-w-0")} ${INPUT_SIZE[size]} ${look} ${className}`.trim()} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
  /** 只放版面用途（高度上下限、底部留給按鈕的空間）。給了 min-h-* 就取代預設的 96px。 */
  className?: string;
}

/** 多行輸入框。滑鼠點進去也顯示外框：打字的地方比較大，看不出焦點在哪一格。 */
export function Textarea({ className = "", ...props }: TextareaProps) {
  return <textarea {...props} className={`${defaultUnless(className, "min-h-", "min-h-24")} w-full resize-y rounded-(--radius-field) border border-line bg-paper px-3 py-2.5 text-ink focus:outline-2 focus:outline-offset-1 focus:outline-secondary ${className}`.trim()} />;
}

// 寫成完整的 class 字串，Tailwind 才掃得到；同一個屬性只留一個 utility，不靠產生順序決勝負。
const FIELD_GAP = {
  4: "gap-1",
  6: "gap-1.5",
  8: "gap-2",
} as const;

// 不指名的 @container 查的是最近一個容器，所以 Field 不必知道外層的容器叫什麼。
const STACKED_LABEL = {
  viewport: "hidden max-[640px]:block",
  container: "hidden @max-[640px]:block",
} as const;

interface FieldProps {
  label?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** 只放版面用途（寬度、伸縮、grid 位置）。 */
  className?: string;
  /** 裡面不只一個控制項（色票、日期區間、清單）時用 div；label 會把點擊轉給第一個控制項。 */
  as?: "label" | "div";
  /** 標籤與輸入框之間的距離（px）。 */
  gap?: keyof typeof FIELD_GAP;
  /**
   * 排成一列、上方已經有欄位標題時用：標籤平常藏起來，寬度不到 640px、改成上下疊時才顯示成小字。
   * viewport 看螢幕寬度，container 看最近一個容器的寬度。
   */
  stackedLabel?: keyof typeof STACKED_LABEL;
  children: ReactNode;
}

/** 統一 label、說明與錯誤文字的欄位包裝器。 */
export function Field({ label, required, hint, error, className = "", as: Tag = "label", gap = 6, stackedLabel, children }: FieldProps) {
  return (
    // data-field 讓外層的版面規則認得出 Field（.admin-form 與 FilterToolbar 的底部對齊、格線子元素的 min-width）。
    <Tag data-field="" className={`grid content-start ${FIELD_GAP[gap]} ${className}`.trim()}>
      {label ? (
        <span className={stackedLabel ? `${STACKED_LABEL[stackedLabel]} mb-1.5 text-[12px] font-semibold text-muted` : "text-[13px] font-bold"}>
          {label}{required ? <b aria-hidden="true" className="ml-1.5 text-[11px] text-brand">必填</b> : null}
        </span>
      ) : null}
      {children}
      {error ? <FieldHint tone="danger">{error}</FieldHint> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </Tag>
  );
}

/** 欄位底下的說明或錯誤。一般用 Field 的 hint／error；要好幾行、或要放在控制項上方時才直接用。 */
export function FieldHint({ tone = "muted", children }: { tone?: "muted" | "danger"; children: ReactNode }) {
  return <small className={`text-[12px] ${tone === "danger" ? "text-brand-dark" : "text-muted"}`}>{children}</small>;
}

type FieldLayoutProps = Pick<FieldProps, "label" | "required" | "hint" | "error" | "className" | "gap" | "stackedLabel">;

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "size">, FieldLayoutProps {
  inputClassName?: string;
}

export function TextField({ label, required, hint, error, className, gap, stackedLabel, inputClassName = "", ...inputProps }: TextFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} gap={gap} stackedLabel={stackedLabel}>
      <Input {...inputProps} required={required} className={inputClassName} />
    </Field>
  );
}

type SelectFieldCommonProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children" | "value" | "defaultValue" | "multiple" | "onChange"> & FieldLayoutProps & {
  options: readonly { label: string; value: string }[];
  selectClassName?: string;
  searchable?: boolean;
  placeholder?: string;
};

type SelectFieldProps = SelectFieldCommonProps & ({
  multiple?: false;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  onValueChange?: (value: string) => void;
} | {
  multiple: true;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (event: DropdownSelectMultipleChangeEvent) => void;
  onValueChange?: (value: string[]) => void;
} | {
  multiple: boolean;
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  onChange?: ChangeEventHandler<HTMLSelectElement> | ((event: DropdownSelectMultipleChangeEvent) => void);
  onValueChange?: ((value: string) => void) | ((value: string[]) => void);
});

export function SelectField({
  label,
  required,
  hint,
  error,
  className,
  gap,
  stackedLabel,
  options,
  selectClassName = "",
  placeholder,
  searchable = false,
  multiple = false,
  value,
  defaultValue,
  disabled,
  name,
  id,
  onChange,
  onValueChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: SelectFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} gap={gap} stackedLabel={stackedLabel}>
      <DropdownSelect
        options={options}
        multiple={multiple}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        required={required}
        name={name}
        id={id}
        className={selectClassName}
        placeholder={placeholder}
        searchable={searchable}
        onChange={onChange}
        onValueChange={onValueChange}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
      />
    </Field>
  );
}
