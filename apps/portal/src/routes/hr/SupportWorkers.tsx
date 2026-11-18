import { useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, FilterSelect, FilterToolbar, FormHint, Page, PageHeader, Panel, SearchFilterInput, SelectField, StatusBadge, TableNote, TextField } from "../../ui/index.js";
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

function overtimeLabel(version: { overtimeRatePpm?: number | null; overtimeHourlyMinor?: number | null }) {
  if (version.overtimeRatePpm != null) return `加班固定 ${(version.overtimeRatePpm / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} 倍`;
  if (version.overtimeHourlyMinor != null) return `加班固定 ${money(version.overtimeHourlyMinor)}／時`;
  return "加班沿用制度倍率";
}

function currentCompensation(worker: ScheduleWorkerRecord) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  return worker.compensation.find((version) => version.validFrom <= today && (!version.validTo || today < version.validTo)) ?? null;
}

function WorkerDialog({ worker, onClose }: { worker: ScheduleWorkerRecord | null; onClose: () => void }) {
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const [displayName, setDisplayName] = useState(worker?.displayName ?? "");
  const [active, setActive] = useState(worker ? isActive(worker) : true);
  const isEditing = Boolean(worker);
  return <Dialog title={worker ? `編輯支援人員 · ${worker.displayName}` : "新增支援人員"} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    save.mutate({
      path: worker ? `/schedule-workers/${encodeURIComponent(worker.id)}` : "/schedule-workers",
      method: worker ? "PATCH" : "POST",
      values: worker ? { displayName, active, revision: worker.revision } : { displayName },
    }, { onSuccess: () => { (closeRequestRef.current ?? onClose)(); } });
  } }} actions={<Button type="submit" tone={isEditing ? "info" : "success"} loading={save.isPending}>儲存</Button>}>
    <TextField label="姓名" value={displayName} maxLength={100} required onChange={(event) => setDisplayName(event.target.value)} />
    {isEditing ? <SelectField label="狀態" value={active ? "active" : "inactive"} options={[{ value: "active", label: "啟用中" }, { value: "inactive", label: "已停用" }]} onChange={(event) => setActive(event.target.value === "active")} /> : null}
    <FormHint>支援人員可另外連結平台帳號，使用打卡與薪資袋。停用會停止後續排班與本人功能，歷史排班、打卡及薪資資料仍會保留。</FormHint>
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function WorkerAccountDialog({ worker, onClose }: { worker: ScheduleWorkerRecord; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  return <Dialog title="連結支援人員帳號" titleMeta={worker.displayName} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending}
    formProps={{ onSubmit: (event) => {
      event.preventDefault();
      save.mutate({ path: `/schedule-workers/${encodeURIComponent(worker.employmentId ?? worker.id)}/account`, method: "POST", values: { email } }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
    } }} actions={<Button type="submit" loading={save.isPending}>確認連結</Button>}>
    <p>請先在「權限管理」邀請此 Email，再連結至這位支援人員。帳號只能連結一位人員，請確認姓名與 Email 相符。</p>
    <TextField label="登入 Email" type="email" required maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
    <FormHint>連結後可用 Email 登入並綁定小香，只開放打卡與已發放薪資袋。請另外至「出勤範圍管理」指派可打卡位置。</FormHint>
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

export function HrSupportWorkers() {
  usePageTitle("支援人員");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator) && permissions.has("hr:schedule:read");
  const canWrite = permissions.has("hr:schedule:write");
  const canLinkAccount = permissions.has("hr:employee:write");
  const [linking, setLinking] = useState<ScheduleWorkerRecord | null>(null);
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 25, search: "", status: "all", sortField: "name", sortDirection: "asc" });
  const [editing, setEditing] = useState<ScheduleWorkerRecord | null | undefined>(undefined);
  const path = `/schedule-workers/management?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`;
  const workers = useHrQuery<ScheduleWorkerPageResponse>(path, canRead);
  if (!canRead) return <Alert tone="danger">支援人員資料僅限全平台 HR 管理者查看。</Alert>;
  if (workers.isPending) return <HrPageSkeleton variant="table" />;
  const data = workers.data;
  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return <Page layout="fills">
    <PageHeader title="支援人員" description="管理可排班、可計薪但不屬於平台員工的外部人力；停用取代刪除，以保留歷史排班與薪資快照。" actions={canWrite ? <Button icon="plus" tone="success" mobileIconOnly onClick={() => setEditing(null)}>新增支援人員</Button> : null} />
    <Panel grows>
      <FilterToolbar>
        <SearchFilterInput label="搜尋" placeholder="搜尋支援人員姓名" value={filters.search} onSearch={(search) => update({ search })} />
        <FilterSelect label="狀態" value={filters.status} onChange={(event) => update({ status: event.target.value })} options={STATUS_OPTIONS} />
      </FilterToolbar>
      {workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}
      <DataTable><thead><tr>
        <SortableHeader label="姓名" field="name" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="狀態" field="status" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <th>登入帳號</th><th>目前薪資</th><th>生效日</th>{canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data?.workers.map((worker) => {
          const compensation = currentCompensation(worker);
          return <tr key={worker.id}>
            <td data-label="姓名"><span className="font-bold">{worker.displayName}</span></td>
            <td data-label="狀態"><StatusBadge tone={isActive(worker) ? "success" : "danger"}>{isActive(worker) ? "啟用中" : "已停用"}</StatusBadge></td>
            <td data-label="登入帳號">{worker.account ? <div className="grid justify-items-start gap-1"><span>{worker.account.email}</span><StatusBadge tone={worker.account.status === "active" ? "success" : worker.account.status === "invited" ? "info" : "danger"}>{worker.account.status === "active" ? "已啟用" : worker.account.status === "invited" ? "待啟用" : "帳號已停用"}</StatusBadge></div> : <div className="flex flex-wrap items-center gap-2"><span className="text-muted">尚未連結</span>{canLinkAccount && isActive(worker) ? <Button variant="secondary" onClick={() => setLinking(worker)}>連結帳號</Button> : null}</div>}</td>
            <td data-label="目前薪資" className="numeric">{compensation ? <>{PAY_BASIS_LABEL[compensation.payBasis]} · {money(compensation.baseAmountMinor)}<br /><span className="text-muted">{overtimeLabel(compensation)}</span></> : <span className="text-muted">尚未設定</span>}</td>
            <td data-label="生效日">{compensation?.validFrom ?? "—"}</td>
            {canWrite ? <td data-label="操作"><Button variant="secondary" tone="info" onClick={() => setEditing(worker)}>管理</Button></td> : null}
          </tr>;
        })}
      </tbody></DataTable>
      {workers.isFetching ? <TableNote>載入中…</TableNote> : null}
      {data && !data.workers.length ? <TableNote>{data.total ? "沒有符合條件的支援人員，調整一下搜尋或篩選看看。" : "尚無支援人員，請先新增一位可排班的外部人力。"}</TableNote> : null}
      {data && data.total > 0 ? <Pager className="mt-4 shrink-0" page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {linking ? <WorkerAccountDialog worker={linking} onClose={() => { setLinking(null); void workers.refetch(); }} /> : null}
    {editing !== undefined ? <WorkerDialog worker={editing} onClose={() => { setEditing(undefined); void workers.refetch(); }} /> : null}
  </Page>;
}
