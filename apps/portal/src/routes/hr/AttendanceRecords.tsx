import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, FilterInput, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery, type AttendanceEvent } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface AttendanceEventRow extends AttendanceEvent {
  employeeUserId: string;
  employeeNumber: string;
  employeeName: string;
  scopeName: string | null;
}
interface AttendanceEventsResponse {
  events: AttendanceEventRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const SOURCE_LABEL: Record<string, string> = { portal: "本人打卡", manual: "手動補登", rfid: "RFID", line: "LINE" };

function dateTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}

export function HrAttendanceRecords() {
  usePageTitle("出勤紀錄");
  const { permissions, user } = useSession();
  const canRead = permissions.has("hr:office:read");
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", eventKind: "all", sourceKind: "all", startDate: "", endDate: "", sortField: "occurredAt", sortDirection: "desc" as "asc" | "desc" });
  const query = `/attendance-events?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&eventKind=${filters.eventKind}&sourceKind=${filters.sourceKind}&startDate=${filters.startDate}&endDate=${filters.endDate}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`;
  const events = useHrQuery<AttendanceEventsResponse>(query, canRead && isHrAdministrator);
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));

  if (!canRead || !isHrAdministrator) return <Alert tone="danger">出勤明細僅限全平台 HR 管理者查看。</Alert>;
  if (events.isPending) return <HrPageSkeleton variant="table" />;
  if (events.error) return <div className="page"><Alert tone="danger">{events.error.message}</Alert></div>;
  const data = events.data;
  const rows = data?.events ?? [];
  const total = data?.total ?? 0;
  return <div className="page fills">
    <PageHeader title="出勤紀錄" description="查看全體員工的打卡明細；時間由伺服器保存，歷史辦公位置與營運據點使用當時快照。" />
    <Panel className="grows">
      <form className="admin-form toolbar attendance-records-toolbar" onSubmit={(event) => event.preventDefault()}>
        <FilterInput label="搜尋員工" type="search" className="search-input" placeholder="姓名、員工編號或 Email" value={filters.search} onChange={(event) => update({ search: event.target.value })} />
        <FilterSelect label="打卡類型" value={filters.eventKind} options={[{ value: "all", label: "全部類型" }, { value: "clock_in", label: "上班" }, { value: "clock_out", label: "下班" }]} onChange={(event) => update({ eventKind: event.target.value })} />
        <FilterSelect label="來源" value={filters.sourceKind} options={[{ value: "all", label: "全部來源" }, { value: "portal", label: "本人打卡" }, { value: "manual", label: "手動補登" }, { value: "rfid", label: "RFID" }, { value: "line", label: "LINE" }]} onChange={(event) => update({ sourceKind: event.target.value })} />
        <FilterInput label="開始日期" type="date" className="attendance-date-filter" value={filters.startDate} onChange={(event) => update({ startDate: event.target.value })} />
        <FilterInput label="結束日期（不含）" type="date" className="attendance-date-filter" value={filters.endDate} onChange={(event) => update({ endDate: event.target.value })} />
      </form>
      {events.isFetching ? <p className="form-hint">更新中…</p> : null}
      <div className="table-scroll"><table className="data-table attendance-event-table"><thead><tr><SortableHeader label="打卡時間" field="occurredAt" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} /><SortableHeader label="員工" field="employee" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} /><SortableHeader label="來源" field="source" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} /><th>類型</th><th>營運據點／辦公位置</th><th className="numeric">距離（公尺）</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td data-label="打卡時間">{dateTime(row.occurredAt)}</td><td data-label="員工"><div className="cell-strong">{row.employeeName}</div><div className="cell-sub">{row.employeeNumber}</div></td><td data-label="來源"><span className="status quiet">{row.sourceKind ? (SOURCE_LABEL[row.sourceKind] ?? row.sourceKind) : "未知來源"}</span></td><td data-label="類型"><span className="status quiet">{row.eventKind === "clock_in" ? "上班" : "下班"}</span></td><td data-label="營運據點／辦公位置"><div>{row.scopeName ?? "—"}</div><div className="cell-sub">{row.locationName ?? "未指定位置"}</div>{row.manualReason ? <div className="cell-sub">原因：{row.manualReason}</div> : null}</td><td data-label="距離（公尺）" className="numeric">{row.distanceMeters ?? "—"}</td></tr>)}</tbody></table></div>
      {!rows.length ? <p className="empty-state">沒有符合條件的打卡紀錄。</p> : null}
      {total > 0 ? <Pager page={data?.page ?? filters.page} pageSize={data?.pageSize ?? filters.pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.ceil(total / filters.pageSize)} totalLabel={`共 ${total.toLocaleString("zh-TW")} 筆`} onPage={(page) => setFilters((current) => ({ ...current, page }))} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
  </div>;
}
