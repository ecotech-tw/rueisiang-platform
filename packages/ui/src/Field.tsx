import type { ChangeEventHandler, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { DropdownSelect, type DropdownSelectMultipleChangeEvent } from "./DropdownSelect.js";

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
    // data-field 是輸入框外觀還沒搬進元件前的掛鉤，那幾條規則在 components.css。
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

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className">, FieldLayoutProps {
  inputClassName?: string;
}

export function TextField({ label, required, hint, error, className, gap, stackedLabel, inputClassName = "", ...inputProps }: TextFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} gap={gap} stackedLabel={stackedLabel}>
      <input {...inputProps} required={required} className={inputClassName} />
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
