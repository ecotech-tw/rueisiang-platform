import { Icon } from "./icons.js";

export interface SortableHeaderProps {
  label: string;
  field: string;
  /** 目前正在排序的欄位。 */
  active: string;
  direction: "asc" | "desc";
  onSort: (field: string, direction: "asc" | "desc") => void;
  className?: string;
}

/**
 * 可排序的表頭。
 *
 * 排序狀態放在資料表頭旁邊，使用者不必在離資料很遠的工具列尋找目前的排序方式。
 * 點一下換欄位（預設遞增），再點一下換方向——跟試算表一樣。
 */
export function SortableHeader({
  label,
  field,
  active,
  direction,
  onSort,
  className,
}: SortableHeaderProps) {
  const isActive = active === field;

  return (
    <th className={className} aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={`group inline-flex items-center gap-1 border-none bg-transparent p-0 focus-visible:rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary ${isActive ? "text-brand-dark" : "text-inherit"}`}
        onClick={() => {
          if (!isActive) onSort(field, "asc");
          else onSort(field, direction === "asc" ? "desc" : "asc");
        }}
      >
        {label}
        {/* 箭頭只在 hover 或排序中才顯示，避免每欄都有灰箭頭而看不出目前是哪一欄。 */}
        <Icon
          name={isActive && direction === "desc" ? "chevronDown" : "chevronUp"}
          className={`size-4 transition-opacity duration-[120ms] ease-[ease-out] ${isActive ? "text-brand opacity-100" : "opacity-0 group-hover:opacity-35"}`}
        />
      </button>
    </th>
  );
}
