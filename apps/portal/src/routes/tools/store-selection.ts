import { useEffect, useRef, useState } from "react";

/*
 * 店別表的手機卡片：勾選框單獨放在最前面，店名當標題並讓開右上角。
 * 店名那一格的欄位名叫「通路」，所以要蓋過「通路」排成膠囊那條慣例。
 */
export const STORE_TABLE = "max-[760px]:[&_tbody_tr>td.store-selection-cell]:order-0 max-[760px]:[&_tbody_tr>td.store-selection-cell]:block max-[760px]:[&_tbody_tr>td.store-selection-cell]:w-auto max-[760px]:[&_tbody_tr>td.store-selection-cell]:p-0 max-[760px]:[&_tbody_tr>td.store-selection-cell]:m-0 max-[760px]:[&_tbody_tr>td.store-selection-cell]:border-0 max-[760px]:[&_tbody_tr>td.store-selection-cell]:before:hidden max-[760px]:[&_tbody_tr>td.store-name-cell]:order-1 max-[760px]:[&_tbody_tr>td.store-name-cell]:block max-[760px]:[&_tbody_tr>td.store-name-cell]:w-full max-[760px]:[&_tbody_tr>td.store-name-cell]:pt-0 max-[760px]:[&_tbody_tr>td.store-name-cell]:pr-[84px] max-[760px]:[&_tbody_tr>td.store-name-cell]:pb-2 max-[760px]:[&_tbody_tr>td.store-name-cell]:pl-0 max-[760px]:[&_tbody_tr>td.store-name-cell]:mb-1.5 max-[760px]:[&_tbody_tr>td.store-name-cell]:border-b max-[760px]:[&_tbody_tr>td.store-name-cell]:border-soft-line max-[760px]:[&_tbody_tr>td.store-name-cell]:before:hidden";

interface StoreOption {
  name: string;
}

/** 兩個報表執行頁共用的店別勾選狀態；店別清單變動時會移除已不存在的選項。 */
export function useStoreSelection(stores: readonly StoreOption[]) {
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const previousNames = useRef<string[]>([]);
  const names = stores.map((store) => store.name);
  const namesKey = names.join("\u0000");

  useEffect(() => {
    const previous = previousNames.current;
    previousNames.current = names;
    setSelectedNames((current) => previous.length ? current.filter((name) => names.includes(name)) : names);
  }, [namesKey]);

  const allSelected = names.length > 0 && selectedNames.length === names.length;

  function toggle(name: string, checked: boolean) {
    setSelectedNames((current) => {
      if (checked) return current.includes(name) ? current : [...current, name];
      return current.filter((item) => item !== name);
    });
  }

  function toggleAll() {
    setSelectedNames(allSelected ? [] : names);
  }

  return { selectedNames, allSelected, toggle, toggleAll };
}
