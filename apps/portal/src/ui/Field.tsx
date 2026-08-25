import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export interface FieldProps {
  label: ReactNode;
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
      <span>{label}{required ? <b aria-hidden="true">必填</b> : null}</span>
      {children}
      {error ? <small className="ui-field-error">{error}</small> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className">, Omit<FieldProps, "children" | "className"> {
  inputClassName?: string;
}

export function TextField({ label, required, hint, error, inputClassName = "", ...inputProps }: TextFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <input {...inputProps} required={required} className={inputClassName} />
    </Field>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children">, Omit<FieldProps, "children" | "className"> {
  options: readonly { label: string; value: string }[];
  selectClassName?: string;
}

export function SelectField({ label, required, hint, error, options, selectClassName = "", ...selectProps }: SelectFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <select {...selectProps} required={required} className={selectClassName}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
}
