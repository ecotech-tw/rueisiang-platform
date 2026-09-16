import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type ScheduleWorkerPageResponse, type ScheduleWorkerRecord } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

const PAGE_SIZES = [10, 25, 50, 100] as const;
const STATUS_OPTIONS = [{ value: "all", label: "全部狀態" }, { value: "active", label: "啟用中" }, { value: "inactive", label: "已停用" }];
const PAY_BASIS_LABEL = { monthly: "月薪", daily: "日薪", hourly: "時薪" } as const;

type Filters = { page: number; pageSize: number; search: string; status: string; sortField: string; sortDirection: "asc" | "desc" };

function isActive(worker: ScheduleWorkerRecord) {
  return worker.active === true || worker.active === 1;
}

function money(minor: number) {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function currentCompensation(worker: ScheduleWorkerRecord) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return worker.compensation.find((version) => version.validFrom <= today && (!version.validTo || today < version.validTo)) ?? null;
}

function WorkerDialog({ worker, onClose }: { worker: ScheduleWorkerRecord | null; onClose: () => void }) {
  const save = useHrWrite();
  const [displayName, setDisplayName] = useState(worker?.displayName ?? "");
  const [active, setActive] = useState(worker ? isActive(worker) : true);
  const isEditing = Boolean(worker);
  return <Dialog title={worker ? `編輯支援人員 · ${worker.displayName}` : "新增支援人員"} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    save.mutate({
      path: isEditing ? `/schedule-workers/${encodeURIComponent(worker.id)}` : "/schedule-workers",
      method: isEditing ? "PATCH" : "POST",
      values: isEditing ? { displayName, active, revision: worker.revision } : { displayName },
    }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存</Button>}>
    <TextField label="姓名" value={displayName} maxLength={100} required onChange={(event) => setDisplayName(event.target.value)} />
    {isEditing ? <SelectField label="狀態" value={active ? "active" : "inactive"} options={[{ value: "active", label: "啟用中" }, { value: "inactive", label: "已停用" }]} onChange={(event) => setActive(event.target.value === "active")} /> : null}
    <p className="form-hint">支援人員不是平台使用者，不建立帳號或員工任職關聯；停用只會停止後續排班，歷史資料仍會保留。</p>
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

export function HrSupportWorkers() {
  usePageTitle("支援人員");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator) && permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 25, search: "", status: "all", sortField: "name", sortDirection: "asc" });
  const [editing, setEditing] = useState<ScheduleWorkerRecord | null | undefined>(undefined);
  const path = `/schedule-workers/management?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`;
  const workers = useHrQuery<ScheduleWorkerPageResponse>(path, canRead);
  if (!canRead) return <Alert tone="danger">支援人員資料僅限全平台 HR 管理者查看。</Alert>;
  if (workers.isPending) return <HrPageSkeleton variant="table" />;
  const data = workers.data;
  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <div className="page fills">
    <PageHeader title="支援人員" description="管理可排班、可計薪但不屬於平台員工的外部人力；停用取代刪除，以保留歷史排班與薪資快照。" actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => setEditing(null)}>新增支援人員</Button> : null} />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋支援人員姓名" value={filters.search} onSearch={(search) => update({ search })} />
        <FilterSelect label="狀態" value={filters.status} onChange={(event) => update({ status: event.target.value })} options={STATUS_OPTIONS} />
      </form>
      {workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <SortableHeader label="姓名" field="name" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="狀態" field="status" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <th>目前薪資</th><th>生效日</th>{canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data?.workers.map((worker) => {
          const compensation = currentCompensation(worker);
          return <tr key={worker.id}>
            <td data-label="姓名"><span className="cell-strong">{worker.displayName}</span></td>
            <td data-label="狀態"><span className={`status-badge ${isActive(worker) ? "status-active" : "status-disabled"}`}>{isActive(worker) ? "啟用中" : "已停用"}</span></td>
            <td data-label="目前薪資" className="numeric">{compensation ? `${PAY_BASIS_LABEL[compensation.payBasis]} · ${money(compensation.baseAmountMinor)}` : <span className="muted">尚未設定</span>}</td>
            <td data-label="生效日">{compensation?.validFrom ?? "—"}</td>
            {canWrite ? <td data-label="操作"><Button variant="secondary" onClick={() => setEditing(worker)}>管理</Button></td> : null}
          </tr>;
        })}
      </tbody></table></div>
      {workers.isFetching ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.workers.length ? <p className="muted table-note">{data.total ? "沒有符合條件的支援人員，調整一下搜尋或篩選看看。" : "尚無支援人員，請先新增一位可排班的外部人力。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {editing !== undefined ? <WorkerDialog worker={editing} onClose={() => { setEditing(undefined); void workers.refetch(); }} /> : null}
  </div>;
}
