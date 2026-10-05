import { Combobox } from "@base-ui/react/combobox";
import { Select } from "@base-ui/react/select";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEventHandler } from "react";
import { useLocation } from "react-router";
import { Icon } from "../shell/icons.js";
import { Tooltip } from "./Tooltip.js";

export interface DropdownSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
  /** 多選 chip 上的短名。清單要靠編號與職稱分辨人，選完之後只需要認得是誰；完整的 label 放在提示裡。 */
  chipLabel?: string;
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

// 放在模組層：inline 寫在 props 上每輪都是新函式，Base UI 會當成設定變了而重新同步 store。
function optionLabel(option: DropdownSelectOption | null | undefined): string {
  return option?.label ?? "";
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

function sameFields(left: object, right: object): boolean {
  const leftEntries = Object.entries(left);
  return leftEntries.length === Object.keys(right).length && leftEntries.every(([key, fieldValue]) => (right as Record<string, unknown>)[key] === fieldValue);
}

/**
 * 內容沒變就交回上一輪的同一個陣列。
 *
 * 呼叫端幾乎都是 render 時才 map 出 options 與 value，每輪都是新陣列。Combobox 的 layout effect
 * 依賴這些參考，參考一變就同步更新 store；父層只要多重繪幾輪就會疊到 React 的巢狀更新上限、整頁當掉。
 * 在這裡擋，就不必靠每個呼叫端記得 useMemo。
 */
function useStableList<T>(list: readonly T[], sameItem: (left: T, right: T) => boolean): readonly T[] {
  const stable = useRef(list);
  const previous = stable.current;
  if (previous !== list && !(previous.length === list.length && previous.every((item, index) => sameItem(item, list[index]!)))) stable.current = list;
  return stable.current;
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
      itemToStringLabel={optionLabel}
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
  const stableOptions = useStableList(options, sameFields);
  const selectedOption = useMemo(() => optionForValue(stableOptions, value) ?? null, [stableOptions, value]);
  const initialOption = optionForValue(options, defaultValue) ?? null;

  return (
    <Combobox.Root<DropdownSelectOption>
      items={stableOptions}
      value={selectedOption}
      defaultValue={initialOption}
      onValueChange={(nextValue) => emitSingle(props, nextValue)}
      isItemEqualToValue={sameOption}
      itemToStringLabel={optionLabel}
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
  const stableOptions = useStableList(options, sameFields);
  /*
   * 沒有傳 value 時選取交給 Combobox 自己管（表單 reset、初始值都由它處理），這裡只跟著記一份：
   * 下面要靠「目前選了誰」把已選的從清單拿掉，受控與非受控兩種用法的行為才會一樣。
   */
  const [initialOptions] = useState(() => optionsForValues(options, defaultValue) ?? []);
  // 從 Combobox 實際拿到的初始選取記起，不是原始的 defaultValue：對不到 option 的值它沒有選，這裡也不能當成已選而藏起來。
  const [mirroredValue, setMirroredValue] = useState<readonly string[]>(() => initialOptions.map((option) => option.value));
  const currentValue = useStableList(value ?? mirroredValue, Object.is);
  const { selectedOptions, remainingOptions, duplicatedChipLabels } = useMemo(() => {
    const selected = new Set(currentValue);
    const optionByValue = new Map(stableOptions.map((option) => [option.value, option]));
    // 短名撞名時（同名同姓）chip 會分不出誰是誰，那幾位改回完整 label；提示只能是補充，不能是唯一分辨得出來的地方。
    const seenChipLabels = new Set<string>();
    const duplicated = new Set<string>();
    for (const option of stableOptions) {
      if (!option.chipLabel) continue;
      if (seenChipLabels.has(option.chipLabel)) duplicated.add(option.chipLabel);
      seenChipLabels.add(option.chipLabel);
    }
    return {
      // 全體預選時兩邊都可能上千筆，逐一 find 會是平方級。
      selectedOptions: currentValue.flatMap((selectedValue) => {
        const option = optionByValue.get(selectedValue);
        return option ? [option] : [];
      }),
      // 已選的已經是輸入框裡的 chip，清單只留還能加的；留著只會讓人在長名單裡重複找同一個人。
      remainingOptions: stableOptions.filter((option) => !selected.has(option.value)),
      duplicatedChipLabels: duplicated,
    };
  }, [stableOptions, currentValue]);
  /*
   * chip 區超過高度會自己捲，而輸入框排在所有 chip 後面：預選幾十人時它一開始就在捲動範圍外，
   * 欄位看起來像一張不能打字的清單。只在掛載與新增時捲到底；移除時不動，
   * 不然捲到上面連續移除幾個人，每移一個就被拉回底部。
   */
  const chipsRef = useRef<HTMLDivElement>(null);
  // 表單 reset 時 Combobox 會回到初始選取，跟著記的那一份也要回去，不然被記成已選的項目會從清單消失。
  useEffect(() => {
    const form = value === undefined ? chipsRef.current?.closest("form") : null;
    if (!form) return;
    const restore = () => setMirroredValue(initialOptions.map((option) => option.value));
    form.addEventListener("reset", restore);
    return () => form.removeEventListener("reset", restore);
  }, [value === undefined, initialOptions]);
  const previousSelectedCount = useRef(-1);
  useLayoutEffect(() => {
    const chips = chipsRef.current;
    if (chips && selectedOptions.length > previousSelectedCount.current) chips.scrollTop = chips.scrollHeight;
    previousSelectedCount.current = selectedOptions.length;
  }, [selectedOptions.length]);

  return (
    <Combobox.Root<DropdownSelectOption, true>
      multiple
      items={remainingOptions}
      value={value === undefined ? undefined : selectedOptions}
      defaultValue={value === undefined ? initialOptions : undefined}
      onValueChange={(nextValue) => {
        if (value === undefined) setMirroredValue(nextValue.map((option) => option.value));
        emitMultiple(props, nextValue);
      }}
      isItemEqualToValue={sameOption}
      itemToStringLabel={optionLabel}
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
              <Combobox.Chips ref={chipsRef} aria-label={ariaLabel ?? "已選項目"} className="dropdown-combobox-chips">
                {selected.map((option) => {
                  // 空字串也當成沒有短名：沒填法定姓名的員工不能變成一顆只有移除鈕的空白 chip。
                  const shortened = Boolean(option.chipLabel) && !duplicatedChipLabels.has(option.chipLabel!);
                  const chip = (
                    <Combobox.Chip key={option.value} className="dropdown-combobox-chip" aria-description="按 Backspace 或 Delete 移除">
                      {/* 螢幕閱讀器唸完整 label：提示掛在外層，聚焦 chip 時不會被唸到。 */}
                      {shortened ? <><span aria-hidden="true">{option.chipLabel}</span><span className="sr-only">{option.label}</span></> : <span>{option.label}</span>}
                      <Combobox.ChipRemove aria-label={`移除${option.label}`} className="dropdown-combobox-chip-remove"><Icon name="close" /></Combobox.ChipRemove>
                    </Combobox.Chip>
                  );
                  // 提示包在 chip 外面：chip 自己拿得到焦點，focus 冒泡上來，鍵盤與觸控點選也看得到完整 label。
                  return shortened ? <Tooltip key={option.value} label={option.label} focusable={false}>{chip}</Tooltip> : chip;
                })}
                <Combobox.Input
                  id={id}
                  className="combobox-input"
                  placeholder={selected.length ? "" : placeholder}
                  // 連續挑人時多按一下 Enter 不該變成送出整張表單（薪資試算就會直接開跑）。
                  onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }}
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
            <Combobox.Empty>{options.length && !remainingOptions.length ? "已經全部選取" : selectedOptions.length ? "沒有其他符合條件的選項（已選取的不會列在這裡）" : "找不到符合條件的選項"}</Combobox.Empty>
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
