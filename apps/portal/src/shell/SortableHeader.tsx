import { Icon } from "./icons.js";

/**
 * 可排序的表頭。
 *
 * 取代原本工具列上那兩個下拉（「排序依據」＋「由新到舊／由舊到新」）。那組下拉
 * 有兩個問題：一是「由新到舊」套在姓名上讀不通（姓名沒有新舊），二是排序狀態
 * 顯示在離資料很遠的地方，看著表格的人不會知道現在是照什麼排的。
 *
 * 點一下換欄位（預設遞增），再點一下換方向——跟所有人用過的試算表一樣。
 */
export function SortableHeader({
  label,
  field,
  active,
  direction,
  onSort,
  className,
}: {
  label: string;
  field: string;
  /** 目前正在排序的欄位。 */
  active: string;
  direction: "asc" | "desc";
  onSort: (field: string, direction: "asc" | "desc") => void;
  className?: string;
}) {
  const isActive = active === field;

  return (
    <th className={className} aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`sort-header${isActive ? " active" : ""}`}
        onClick={() => {
          // 換欄位時從遞增開始；同一欄再點就翻轉。
          if (!isActive) onSort(field, "asc");
          else onSort(field, direction === "asc" ? "desc" : "asc");
        }}
      >
        {label}
        {/*
          * 沒在排序的欄位不畫箭頭，只留 hover 時的淡箭頭當提示——每一欄都掛一個
          * 灰箭頭的話，「現在照哪一欄排」反而看不出來。
          */}
        <Icon name={isActive && direction === "desc" ? "chevronDown" : "chevronUp"} />
      </button>
    </th>
  );
}
