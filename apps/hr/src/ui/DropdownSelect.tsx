import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import { useState, type ChangeEventHandler } from "react";
import { useLocation } from "react-router";
import { Icon } from "../shell/icons.js";

export interface DropdownSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface DropdownSelectMultipleChangeEvent {
  target: { value: readonly string[] };
  currentTarget: { value: readonly string[] };
}

interface DropdownSelectCommonProps {
  options: readonly DropdownSelectOption[];
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  placeholder?: string;
  searchable?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export interface DropdownSelectSingleProps extends DropdownSelectCommonProps {
  multiple?: false;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  onValueChange?: (value: string) => void;
}

export interface DropdownSelectMultipleProps extends DropdownSelectCommonProps {
  multiple: true;
  value?: readonly string[];
  defaultValue?: readonly string[];
  onChange?: (event: DropdownSelectMultipleChangeEvent) => void;
  onValueChange?: (value: string[]) => void;
}

/** 動態切換模式時保留寬鬆的布林型別；使用 literal true/false 時仍能得到精確 callback 型別。 */
export interface DropdownSelectConfigurableProps extends DropdownSelectCommonProps {
  multiple: boolean;
  value?: string | number | readonly string[];
  defaultValue?: string | number | readonly string[];
  onChange?: ChangeEventHandler<HTMLSelectElement> | ((event: DropdownSelectMultipleChangeEvent) => void);
  onValueChange?: ((value: string) => void) | ((value: string[]) => void);
}

export type DropdownSelectProps = DropdownSelectSingleProps | DropdownSelectMultipleProps | DropdownSelectConfigurableProps;

type SingleDropdownProps = DropdownSelectSingleProps & { isHrSystem: boolean };
type MultipleDropdownProps = DropdownSelectMultipleProps & { isHrSystem: boolean };

function changeEvent(value: string): Parameters<ChangeEventHandler<HTMLSelectElement>>[0] {
  return { target: { value }, currentTarget: { value } } as unknown as Parameters<ChangeEventHandler<HTMLSelectElement>>[0];
}

function multipleChangeEvent(value: readonly string[]): DropdownSelectMultipleChangeEvent {
  return { target: { value }, currentTarget: { value } };
}

function sameOption(left: DropdownSelectOption, right: DropdownSelectOption): boolean {
  return left.value === right.value;
}

function optionForValue(options: readonly DropdownSelectOption[], value: string | number | undefined) {
  if (value === undefined) return undefined;
  return options.find((option) => option.value === String(value));
}

function optionsForValues(options: readonly DropdownSelectOption[], values: readonly string[] | undefined) {
  if (!values) return undefined;
  return values.flatMap((value) => {
    const option = options.find((candidate) => candidate.value === value);
    return option ? [option] : [];
  });
}

function popupClass(isHrSystem: boolean) {
  return `combobox-popup${isHrSystem ? " hr-liquid-select-popup" : ""}`;
}

function emitSingle(props: DropdownSelectSingleProps, nextValue: DropdownSelectOption | null | undefined) {
  const value = nextValue?.value ?? "";
  props.onValueChange?.(value);
  props.onChange?.(changeEvent(value));
}

function emitMultiple(props: DropdownSelectMultipleProps, nextValues: readonly DropdownSelectOption[]) {
  const values = nextValues.map((option) => option.value);
  props.onValueChange?.(values);
  props.onChange?.(multipleChangeEvent(values));
}

function SelectSingleDropdown({ isHrSystem, ...props }: SingleDropdownProps) {
  const {
    options,
    value,
    defaultValue,
    disabled,
    required,
    name,
    id,
    className = "",
    placeholder = options[0]?.label ?? "請選擇",
    onChange: _onChange,
    onValueChange: _onValueChange,
    searchable: _searchable,
    multiple: _multiple,
    ...ariaProps
  } = props;
  const selectedOption = optionForValue(options, value);
  const initialOption = optionForValue(options, defaultValue);

  return (
    <Select.Root<DropdownSelectOption>
      items={options}
      value={selectedOption}
      defaultValue={initialOption}
      onValueChange={(nextValue) => emitSingle(props, nextValue)}
      isItemEqualToValue={sameOption}
      disabled={disabled}
      modal={false}
      required={required}
      name={name}
      id={id}
      itemToStringLabel={(option) => option?.label ?? ""}
    >
      <Select.Trigger className={`dropdown-control select-trigger ${className}`.trim()} {...ariaProps}>
        <Select.Value className="select-trigger-value" placeholder={placeholder} />
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

function SelectMultipleDropdown({ isHrSystem, ...props }: MultipleDropdownProps) {
  const {
    options,
    value,
    defaultValue,
    disabled,
    required,
    name,
    id,
    className = "",
    placeholder = "請選擇",
    onChange: _onChange,
    onValueChange: _onValueChange,
    searchable: _searchable,
    multiple: _multiple,
    ...ariaProps
  } = props;
  const selectedOptions = optionsForValues(options, value);
  const initialOptions = optionsForValues(options, defaultValue);

  return (
    <Select.Root<DropdownSelectOption, true>
      multiple
      items={options}
      value={selectedOptions}
      defaultValue={initialOptions}
      onValueChange={(nextValue) => emitMultiple(props, nextValue)}
      isItemEqualToValue={sameOption}
      disabled={disabled}
      modal={false}
      required={required}
      name={name}
      id={id}
    >
      <Select.Trigger className={`dropdown-control select-trigger ${className}`.trim()} {...ariaProps}>
        <Select.Value className="select-trigger-value" placeholder={placeholder}>
          {(selectedValue: DropdownSelectOption[] | null) => selectedValue?.length ? `已選 ${selectedValue.length} 項` : placeholder}
        </Select.Value>
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

function SearchableSingleDropdown({ isHrSystem, ...props }: SingleDropdownProps) {
  const {
    options,
    value,
    defaultValue,
    disabled,
    required,
    name,
    id,
    className = "",
    placeholder = options[0]?.label ?? "搜尋或選擇",
    onChange: _onChange,
    onValueChange: _onValueChange,
    searchable: _searchable,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledby,
    "aria-describedby": ariaDescribedby,
  } = props;
  const selectedOption = optionForValue(options, value) ?? null;
  const initialOption = optionForValue(options, defaultValue) ?? null;

  return (
    <Combobox.Root<DropdownSelectOption>
      items={options}
      value={selectedOption}
      defaultValue={initialOption}
      onValueChange={(nextValue) => emitSingle(props, nextValue)}
      isItemEqualToValue={sameOption}
      itemToStringLabel={(option) => option?.label ?? ""}
      disabled={disabled}
      required={required}
      name={name}
      autoHighlight
    >
      <Combobox.InputGroup className={`combobox-group dropdown-combobox ${className}`.trim()}>
        <Combobox.Input
          id={id}
          className="combobox-input"
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
        />
        <Combobox.Clear className="combobox-clear" aria-label="清除選擇"><Icon name="close" /></Combobox.Clear>
        <Combobox.Trigger className="combobox-trigger" aria-label={ariaLabel ? `開啟${ariaLabel}選單` : "開啟選單"}><Icon name="chevronDown" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="combobox-positioner">
          <Combobox.Popup className={popupClass(isHrSystem)}>
            <Combobox.Empty>找不到符合條件的選項</Combobox.Empty>
            <Combobox.List>
              {(option: DropdownSelectOption) => (
                <Combobox.Item key={option.value} value={option} disabled={option.disabled} className="combobox-item">
                  <span>{option.label}</span>
                  <Combobox.ItemIndicator>✓</Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

function SearchableMultipleDropdown({ isHrSystem, ...props }: MultipleDropdownProps) {
  const {
    options,
    value,
    defaultValue,
    disabled,
    required,
    name,
    id,
    className = "",
    placeholder = "搜尋或選擇",
    onChange: _onChange,
    onValueChange: _onValueChange,
    searchable: _searchable,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledby,
    "aria-describedby": ariaDescribedby,
  } = props;
  /*
   * 沒有傳 value 的呼叫端也由這裡自己記住選了誰，不交給 Combobox 的 defaultValue：
   * 下面要靠「目前選了誰」把已選的從清單拿掉，兩種用法的行為才會一樣。
   */
  const [uncontrolledValue, setUncontrolledValue] = useState<readonly string[]>(defaultValue ?? []);
  const currentValue = value ?? uncontrolledValue;
  const selectedOptions = optionsForValues(options, currentValue) ?? [];
  // 已選的已經是輸入框裡的 chip，清單只留還能加的；留著只會讓人在長名單裡重複找同一個人。
  const remainingOptions = options.filter((option) => !currentValue.includes(option.value));

  return (
    <Combobox.Root<DropdownSelectOption, true>
      multiple
      items={remainingOptions}
      value={selectedOptions}
      onValueChange={(nextValue) => {
        if (value === undefined) setUncontrolledValue(nextValue.map((option) => option.value));
        emitMultiple(props, nextValue);
      }}
      isItemEqualToValue={sameOption}
      itemToStringLabel={(option) => option?.label ?? ""}
      disabled={disabled}
      required={required}
      name={name}
      autoHighlight
    >
      <Combobox.InputGroup className={`combobox-group dropdown-combobox dropdown-combobox-multiple ${className}`.trim()}>
        <Combobox.Value>
          {(selectedValue: DropdownSelectOption[]) => {
            const selected = selectedValue ?? [];
            return (
              <Combobox.Chips aria-label={ariaLabel ?? "已選項目"} className="dropdown-combobox-chips">
                {selected.map((option) => (
                  <Combobox.Chip key={option.value} className="dropdown-combobox-chip" aria-description="按 Backspace 或 Delete 移除">
                    <span>{option.label}</span>
                    <Combobox.ChipRemove aria-label={`移除${option.label}`} className="dropdown-combobox-chip-remove"><Icon name="close" /></Combobox.ChipRemove>
                  </Combobox.Chip>
                ))}
                <Combobox.Input
                  id={id}
                  className="combobox-input"
                  placeholder={selected.length ? "" : placeholder}
                  aria-label={ariaLabel}
                  aria-labelledby={ariaLabelledby}
                  aria-describedby={ariaDescribedby}
                  aria-description={selected.length ? `已選 ${selected.length} 項。可使用方向鍵移動到已選項目。` : undefined}
                />
              </Combobox.Chips>
            );
          }}
        </Combobox.Value>
        <Combobox.Clear className="combobox-clear" aria-label="清除全部選擇"><Icon name="close" /></Combobox.Clear>
        <Combobox.Trigger className="combobox-trigger" aria-label={ariaLabel ? `開啟${ariaLabel}選單` : "開啟選單"}><Icon name="chevronDown" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="combobox-positioner">
          <Combobox.Popup className={popupClass(isHrSystem)}>
            <Combobox.Empty>{options.length && !remainingOptions.length ? "已經全部選取" : "找不到符合條件的選項"}</Combobox.Empty>
            <Combobox.List>
              {(option: DropdownSelectOption) => (
                <Combobox.Item key={option.value} value={option} disabled={option.disabled} className="combobox-item">
                  <span>{option.label}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function DropdownSelect(props: DropdownSelectProps) {
  const { pathname } = useLocation();
  const isHrSystem = pathname === "/hr" || pathname.startsWith("/hr/");

  if (props.multiple) {
    const multipleProps = props as DropdownSelectMultipleProps;
    return props.searchable
      ? <SearchableMultipleDropdown {...multipleProps} isHrSystem={isHrSystem} />
      : <SelectMultipleDropdown {...multipleProps} isHrSystem={isHrSystem} />;
  }
  const singleProps = props as DropdownSelectSingleProps;
  if (props.searchable) return <SearchableSingleDropdown {...singleProps} isHrSystem={isHrSystem} />;
  return <SelectSingleDropdown {...singleProps} isHrSystem={isHrSystem} />;
}
