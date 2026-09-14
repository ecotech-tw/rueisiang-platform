import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { DropdownSelect } from "./DropdownSelect.js";

interface FieldProps {
  label?: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

 
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

interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children">, Omit<FieldProps, "children" | "className"> {
  options: readonly { label: string; value: string }[];
  selectClassName?: string;
}

export function SelectField({
  label,
  required,
  hint,
  error,
  options,
  selectClassName = "",
  value,
  defaultValue,
  disabled,
  name,
  id,
  onChange,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: SelectFieldProps) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <DropdownSelect
        options={options}
        value={value as string | undefined}
        defaultValue={defaultValue as string | undefined}
        disabled={disabled}
        required={required}
        name={name}
        id={id}
        className={selectClassName}
        onChange={onChange}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
      />
    </Field>
  );
}
