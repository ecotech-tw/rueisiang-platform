import { Select } from "@base-ui/react/select";
import type { ChangeEventHandler } from "react";
import { useLocation } from "react-router";
import { Icon } from "../shell/icons.js";

interface DropdownSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface DropdownSelectProps {
  options: readonly DropdownSelectOption[];
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
}

function changeEvent(value: string): Parameters<ChangeEventHandler<HTMLSelectElement>>[0] {
  return { target: { value }, currentTarget: { value } } as unknown as Parameters<ChangeEventHandler<HTMLSelectElement>>[0];
}

function sameOption(left: DropdownSelectOption, right: DropdownSelectOption): boolean {
  return left.value === right.value;
}

/**
 * 只選擇、不輸入的下拉選單。
 *
 * 使用 Base UI Select 而不是原生 select，讓選項 popup 可以和 autocomplete 共用
 * Material 3 的列表外觀；Select 本身沒有可輸入的文字框，所以仍然維持 dropdown 互動。
 */
export function DropdownSelect({
  options,
  value,
  defaultValue,
  disabled,
  required,
  name,
  id,
  className = "",
  onChange,
  ...ariaProps
}: DropdownSelectProps) {
  const { pathname } = useLocation();
  const isHrSystem = pathname === "/hr" || pathname.startsWith("/hr/");
  const selectedValue = value === undefined ? undefined : String(value);
  const initialValue = defaultValue === undefined ? undefined : String(defaultValue);
  const selectedOption = options.find((option) => option.value === selectedValue);
  const initialOption = options.find((option) => option.value === initialValue);

  return (
    <Select.Root
      items={options}
      value={selectedOption}
      defaultValue={initialOption}
      onValueChange={(nextValue) => onChange?.(changeEvent(nextValue?.value ?? ""))}
      isItemEqualToValue={sameOption}
      disabled={disabled}
      modal={false}
      required={required}
      name={name}
      id={id}
      itemToStringLabel={(option) => option?.label ?? ""}
    >
      <Select.Trigger className={`dropdown-control select-trigger ${className}`.trim()} {...ariaProps}>
        <Select.Value className="select-trigger-value" placeholder={options[0]?.label ?? "請選擇"} />
        <Select.Icon className="select-trigger-icon"><Icon name="chevronDown" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className={`select-positioner${isHrSystem ? " hr-select-positioner" : ""}`}>
          <Select.Popup className={`select-popup${isHrSystem ? " hr-liquid-select-popup" : ""}`}>
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option.value} value={option} disabled={option.disabled} className="select-item">
                  <Select.ItemText className="select-item-text">{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="select-item-indicator">✓</Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

