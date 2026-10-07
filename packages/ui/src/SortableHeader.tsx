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
        className={`sort-header${isActive ? " active" : ""}`}
        onClick={() => {
          if (!isActive) onSort(field, "asc");
          else onSort(field, direction === "asc" ? "desc" : "asc");
        }}
      >
        {label}
        <Icon name={isActive && direction === "desc" ? "chevronDown" : "chevronUp"} />
      </button>
    </th>
  );
}
