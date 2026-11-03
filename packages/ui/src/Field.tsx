import { createContext, useContext, type ChangeEventHandler, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { DropdownSelect, type DropdownSelectMultipleChangeEvent } from "./DropdownSelect.js";

type InputSkinName = "solid" | "glass";

const InputSkinContext = createContext<InputSkinName>("solid");

/**
 * 輸入框的整體風格，跟 ButtonSkin 一樣由外層決定，不靠祖先 class 從外面蓋。
 * - solid：預設的實心白底。
 * - glass：HRIS 管理介面的半透明玻璃；只套在日期類欄位，文字欄位維持實心才讀得清楚。
 */
export function InputSkin({ skin, children }: { skin: InputSkinName; children: ReactNode }) {
  return <InputSkinContext value={skin}>{children}</InputSkinContext>;
}

const GLASS_TYPES = new Set(["date", "month", "datetime-local"]);

const INPUT_BASE = "min-h-(--size-field) min-w-0 rounded-[10px] border px-3 py-2.5 text-ink disabled:cursor-not-allowed disabled:text-muted focus-visible:outline-2 focus-visible:outline-secondary";

const INPUT_SKIN = {
  solid: "border-line bg-paper disabled:bg-soft-line focus-visible:outline-offset-1",
  // 停用時仍是玻璃底，只把字變淡：灰底疊在半透明上會變成一塊髒污。
  glass: "border-transparent bg-paper/38 [box-shadow:var(--shadow-glass-field)] [-webkit-backdrop-filter:blur(8px)_saturate(155%)_contrast(103%)] [backdrop-filter:blur(8px)_saturate(155%)_contrast(103%)] transition-[background-color,box-shadow,border-color] duration-150 ease-out hover:bg-paper/50 focus-visible:outline-offset-2 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:rounded-full [&::-webkit-calendar-picker-indicator]:bg-brand/12 [&::-webkit-calendar-picker-indicator]:p-1.5",
} as const;

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref?: Ref<HTMLInputElement>;
  /** 只放版面用途（寬度、伸縮、右側留給圖示的空間）。 */
  className?: string;
}

/** 單行輸入框。勾選框與單選鈕不要用它，它們沒有外框與內距。 */
export function Input({ className = "", type, ...props }: InputProps) {
  const skin = useContext(InputSkinContext);
  const look = skin === "glass" && type && GLASS_TYPES.has(type) ? INPUT_SKIN.glass : INPUT_SKIN.solid;
  return <input {...props} type={type} className={`${INPUT_BASE} ${look} ${className}`.trim()} />;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
  /** 只放版面用途（高度上下限、底部留給按鈕的空間）。給了 min-h-* 就取代預設的 96px。 */
  className?: string;
}

/** 多行輸入框。滑鼠點進去也顯示外框：打字的地方比較大，看不出焦點在哪一格。 */
export function Textarea({ className = "", ...props }: TextareaProps) {
  // 兩個 min-h 同時出現時誰贏要看產生順序，所以呼叫端的高度要整組取代預設值，不能疊上去。
  // 帶前綴的（sm:min-h-40）不算：Tailwind 一律把有 variant 的排在後面，疊上去本來就是它贏。
  const minHeight = /(^|\s)min-h-/.test(className) ? "" : "min-h-24";
  return <textarea {...props} className={`${minHeight} w-full resize-y rounded-(--radius-field) border border-line bg-paper px-3 py-2.5 text-ink focus:outline-2 focus:outline-offset-1 focus:outline-secondary ${className}`.trim()} />;
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
    // data-field 是下拉外觀還沒搬進元件前的掛鉤，那幾條規則在 components.css。
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
