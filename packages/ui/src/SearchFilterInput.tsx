import { useEffect, useRef, useState } from "react";
import { FilterInput } from "./Filter.js";

/*
 * 搜尋框要延遲送出。這些列表的每一次查詢都要掃過整張表（LIKE '%關鍵字%' 用不到
 * 索引，總筆數也得數完全部），逐字送等於每個字元一次全掃。
 */
const SEARCH_DEBOUNCE_MS = 400;

export interface SearchFilterInputProps {
  label: string;
  placeholder: string;
  /** 已經套用的關鍵字。外部改動（例如「清除篩選」）時輸入框會跟著回到這個值。 */
  value: string;
  onSearch: (search: string) => void;
}

export function SearchFilterInput({ label, placeholder, value, onSearch }: SearchFilterInputProps) {
  const [draft, setDraft] = useState(value);
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  });

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (draft === value) return;
    // 計時器只看 draft 與 value；onSearch 走 ref，父層重繪不會把它重設。
    const timeoutId = window.setTimeout(() => onSearchRef.current(draft), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [draft, value]);

  return (
    <FilterInput
      label={label}
      className="search-input"
      type="search"
      placeholder={placeholder}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}
