import { FilterSelect, FilterToolbar, SearchFilterInput } from "../../ui/index.js";

const EMPLOYEE_STATUS_OPTIONS = [
  { value: "all", label: "全部狀態" },
  { value: "employable", label: "可任職" },
  { value: "disabled", label: "已停用帳號" },
] as const;

interface EmployeeFilterBarProps {
  search: string;
  status: string;
  onSearch: (search: string) => void;
  onStatusChange: (status: string) => void;
}

/** 敘薪與勞健保共用員工查詢 UI；分頁與 domain query 仍由呼叫端管理。 */
export function EmployeeFilterBar({ search, status, onSearch, onStatusChange }: EmployeeFilterBarProps) {
  return (
    <FilterToolbar>
      <SearchFilterInput label="搜尋" placeholder="搜尋員工編號、姓名或 Email" value={search} onSearch={onSearch} />
      <FilterSelect label="狀態" value={status} options={EMPLOYEE_STATUS_OPTIONS} onChange={(event) => onStatusChange(event.target.value)} />
    </FilterToolbar>
  );
}
