import type { ReactNode, TableHTMLAttributes } from "react";

interface DataTableProps extends Omit<TableHTMLAttributes<HTMLTableElement>, "children" | "className"> {
  children: ReactNode;
  className?: string;
  containerClassName?: string;
}

/** 統一資料表的捲動外框與 base class；欄位與排序行為仍由 domain route 負責。 */
export function DataTable({ children, className = "", containerClassName = "", ...tableProps }: DataTableProps) {
  return (
    <div className={`table-scroll ${containerClassName}`.trim()}>
      <table {...tableProps} className={`data-table ${className}`.trim()}>
        {children}
      </table>
    </div>
  );
}
