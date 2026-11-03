import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import { GLASS_FIELD, useInputSkin, type InputSkinName } from "./InputSkin.js";

/*
 * 下拉（Select）與下拉搜尋（Combobox）共用的外觀。寫成完整的 class 字串，Tailwind 才掃得到；
 * 同一個屬性只留一個 utility，皮膚之間整組替換，不靠產生順序決勝負。
 */

export const SELECT_TRIGGER_SIZE = {
  md: "min-h-(--size-field) py-2.5 pr-[52px] pl-3",
  // 工具列的篩選比表單欄位密，跟旁邊的膠囊按鈕同高。
  sm: "min-h-[34px] py-[7px] pr-[38px] pl-2.5",
} as const;

const SELECT_TRIGGER_SKIN: Record<InputSkinName, string> = {
  // 下拉的焦點是品牌色外框加一圈淡暈，跟輸入框的 outline 不同：整塊是可點的按鈕，不是打字的地方。
  solid: "border-line bg-canvas disabled:bg-soft-line focus-visible:border-brand focus-visible:outline-0 focus-visible:[box-shadow:0_0_0_3px_color-mix(in_oklab,var(--color-brand)_14%,transparent)]",
  glass: GLASS_FIELD,
};

export function selectTriggerClass(skin: InputSkinName, size: keyof typeof SELECT_TRIGGER_SIZE, className: string) {
  // 呼叫端給了最小寬度就整組取代預設的 min-w-0；兩個 min-w 同時出現時誰贏要看產生順序。
  const minWidth = /(^|s)min-w-/.test(className) ? "" : "min-w-0";
  return `relative flex w-full ${minWidth} cursor-pointer appearance-none items-center rounded-[10px] border text-left text-ink disabled:cursor-not-allowed disabled:text-muted ${SELECT_TRIGGER_SIZE[size]} ${SELECT_TRIGGER_SKIN[skin]} ${className}`.trim();
}

export const SELECT_TRIGGER_VALUE = "min-w-0 truncate";
export const SELECT_TRIGGER_ICON = "absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center text-muted [&_svg]:size-5";

const POPUP_SKIN: Record<InputSkinName, string> = {
  solid: "rounded-xl border border-line bg-canvas [box-shadow:var(--shadow-panel)]",
  glass: "relative isolate rounded-[18px] border border-transparent bg-paper/34 outline-0 [box-shadow:var(--shadow-glass-menu)] [-webkit-backdrop-filter:blur(20px)_saturate(180%)_contrast(104%)] [backdrop-filter:blur(20px)_saturate(180%)_contrast(104%)] before:pointer-events-none before:absolute before:inset-px before:-z-1 before:rounded-[inherit] before:[background:var(--glass-menu-sheen)] before:[filter:url(#hr-liquid-glass-menu)]",
};

export const SELECT_POSITIONER = "pointer-events-none z-100";

export function selectPopupClass(skin: InputSkinName) {
  return `pointer-events-auto z-100 max-h-80 w-max min-w-(--anchor-width) max-w-[min(520px,calc(100vw-24px))] overflow-auto p-1.5 ${POPUP_SKIN[skin]}`;
}

export function comboboxPopupClass(skin: InputSkinName) {
  return `z-100 max-h-80 w-(--anchor-width) overflow-auto p-1.5 ${POPUP_SKIN[skin]}`;
}

// 玻璃選單的選項沿用導覽子選單：hover 是淡層、選中是固定的色調容器。
const OPTION_SKIN: Record<InputSkinName, string> = {
  solid: "rounded-lg text-ink data-highlighted:bg-brand/8",
  glass: "rounded-xl font-extrabold text-muted transition-[background-color,color,box-shadow] duration-150 ease-out not-data-selected:hover:bg-brand/7 not-data-selected:hover:text-brand-dark not-data-selected:data-highlighted:bg-brand/7 not-data-selected:data-highlighted:text-brand-dark data-selected:bg-brand/16 data-selected:text-brand-dark data-selected:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,var(--color-brand)_18%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-info",
};

export function selectItemClass(skin: InputSkinName) {
  return `flex w-max min-w-full max-w-full min-h-11 cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left ${skin === "solid" ? `${OPTION_SKIN.solid} data-selected:bg-brand/8` : OPTION_SKIN.glass}`;
}

export const SELECT_ITEM_TEXT = "w-max min-w-0 max-w-[460px] flex-[0_1_auto] truncate";

export function selectItemIndicatorClass(skin: InputSkinName) {
  return `ml-1 flex-none ${skin === "glass" ? "text-brand" : "text-secondary"}`;
}

/*
 * 選項裡的文字一律淡色、單行截斷（第一段 <strong> 是主要識別，跟著選項的字色）。
 * 勾選記號不縮，其他段落可以縮。
 */
const COMBOBOX_ITEM_PARTS = "[&_span]:truncate [&_span]:text-muted [&>*:not([data-checked])]:min-w-0 [&>*:not([data-checked])]:flex-[0_1_auto] [&_[data-checked]]:ml-1 [&_[data-checked]]:flex-none [&_[data-checked]]:text-brand";

export function comboboxItemClass(skin: InputSkinName) {
  return `flex min-h-11 w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 py-2.5 text-left ${COMBOBOX_ITEM_PARTS} ${skin === "solid" ? `${OPTION_SKIN.solid} hover:bg-brand/8` : OPTION_SKIN.glass}`;
}

// 外框與焦點由外層這一圈負責，裡面的輸入框不另外畫，才不會變成框中框。對齊方式由單選（置中）／多選（撐滿）各自加。
export const COMBOBOX_GROUP = "relative flex w-full min-w-0 min-h-(--size-field) rounded-[10px] border border-line bg-canvas focus-within:border-brand focus-within:[box-shadow:0_0_0_3px_color-mix(in_oklab,var(--color-brand)_14%,transparent)]";

/*
 * 單選的輸入框佔滿整個控制項，底色跟一般輸入框一樣是白的。高度扣掉外框的 2px，整塊才是 44px。
 * 右側 64px 留給清除與展開按鈕，見下面兩顆的說明。
 */
export const COMBOBOX_INPUT = "min-h-[calc(var(--size-field)-2px)] min-w-0 flex-1 rounded-[10px] border-0 bg-paper py-2.5 pr-16 pl-3 text-ink outline-0 disabled:cursor-not-allowed disabled:bg-soft-line disabled:text-muted";

/*
 * 清除與展開兩顆的可點範圍要剛好相鄰、不能重疊：展開是 38px 寬（左 4 + 圖示 20 + 右 14），所以清除從 right: 38px 開始。
 * 兩顆合起來佔 62px；輸入框的右側留白與多選 chip 區的右側外距都是 64px，改這裡的尺寸時那兩處要一起改。
 * 重疊的話展開排在後面會蓋住清除，按清除的中央其實是按到展開——只會打開清單，清不掉。
 */
export const COMBOBOX_CLEAR = "absolute right-[38px] inline-flex cursor-pointer items-center justify-center border-0 bg-transparent px-1 py-2 text-muted [&_svg]:size-4";
export const COMBOBOX_TRIGGER = "absolute right-0 inline-flex cursor-pointer items-center justify-center border-0 bg-transparent py-2.5 pr-3.5 pl-1 text-muted [&_svg]:size-5";

export interface SearchComboboxProps<T> {
  items: readonly T[];
  value: T | null;
  onValueChange: (item: T | null) => void;
  /** 輸入框顯示的文字，也是搜尋比對的對象。 */
  itemToStringLabel: (item: T | null) => string;
  /** 選項的 React key；預設用 itemToStringLabel。 */
  itemKey?: (item: T) => string;
  /** 選項內容。預設只放文字；要第二段說明時放 <strong> 主要識別加 <span> 說明。 */
  renderItem?: (item: T) => ReactNode;
  /** 清除與展開按鈕的名稱會用到，例如「清除分類」「開啟分類選單」。 */
  label?: string;
  placeholder: string;
  emptyLabel: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** 只放版面用途（寬度、伸縮、grid 位置）。 */
  className?: string;
}

/** 可搜尋的單選下拉，選項是任意物件。只有字串選項時用 DropdownSelect searchable。 */
export function SearchCombobox<T>({ items, value, onValueChange, itemToStringLabel, itemKey = itemToStringLabel, renderItem, label, placeholder, emptyLabel, disabled = false, autoFocus, className = "" }: SearchComboboxProps<T>) {
  const skin = useInputSkin();
  return (
    <Combobox.Root items={items} value={value} onValueChange={onValueChange} itemToStringLabel={itemToStringLabel} autoHighlight disabled={disabled}>
      <Combobox.InputGroup className={`${COMBOBOX_GROUP} items-center ${className}`.trim()}>
        <Combobox.Input className={COMBOBOX_INPUT} placeholder={placeholder} autoFocus={autoFocus} />
        <Combobox.Clear className={COMBOBOX_CLEAR} aria-label={label ? `清除${label}` : "清除選擇"}><Icon name="close" /></Combobox.Clear>
        <Combobox.Trigger className={COMBOBOX_TRIGGER} aria-label={label ? `開啟${label}選單` : "開啟選單"}><Icon name="chevronDown" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-100">
          <Combobox.Popup className={comboboxPopupClass(skin)}>
            <Combobox.Empty>{emptyLabel}</Combobox.Empty>
            <Combobox.List>
              {(item: T) => (
                <Combobox.Item key={itemKey(item)} value={item} className={comboboxItemClass(skin)}>
                  {renderItem ? renderItem(item) : <span>{itemToStringLabel(item)}</span>}
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
