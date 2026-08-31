import { useEffect, useRef, useState } from "react";

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
