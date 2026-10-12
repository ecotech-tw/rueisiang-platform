import type { ChangeEventHandler, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { DropdownSelect, type DropdownSelectMultipleChangeEvent } from "./DropdownSelect.js";

interface FieldProps {
  label?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** 統一 label、說明與錯誤文字的欄位包裝器。 */
export function Field({ label, required, hint, error, className = "", children }: FieldProps) {
  return (
    <label className={`field ${className}`.trim()}>
      {label ? <span>{label}{required ? <b aria-hidden="true">必填</b> : null}</span> : null}
      {children}
      {error ? <small className="ui-field-error">{error}</small> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className">, Omit<FieldProps, "children" | "className"> {
  inputClassName?: string;
}

export function TextField({ label, required, hint, error, inputClassName = "", ...inputProps }: TextFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <input {...inputProps} required={required} className={inputClassName} />
    </Field>
  );
}

type SelectFieldCommonProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children" | "value" | "defaultValue" | "multiple" | "onChange"> & Omit<FieldProps, "children" | "className"> & {
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
    <Field label={label} required={required} hint={hint} error={error}>
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
