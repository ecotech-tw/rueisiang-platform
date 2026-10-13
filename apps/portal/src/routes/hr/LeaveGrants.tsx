import { useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, FilterSelect, FilterToolbar, PageHeader, Panel, SearchFilterInput, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useHrQuery, useHrWrite, type HrLeaveGrantEmployee, type HrLeaveGrantResponse, type HrLeaveGrantRow, type HrLeaveType } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function todayTaipei() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function hoursLabel(minutes: number) {
  return `${minutes / 60} 小時`;
}

function rowStatus(row: HrLeaveGrantRow, today: string) {
  if (row.status === "revoked") return { label: "已撤銷", tone: "neutral" as const };
  if (row.expiresOn < today) return { label: "已到期", tone: "neutral" as const };
  if (row.issuedOn > today) return { label: "尚未生效", tone: "info" as const };
  if (row.balanceMinutes <= 0) return { label: "已用完", tone: "neutral" as const };
  return { label: "使用中", tone: "success" as const };
}

function IssueGrantDialog({ leaveTypes, employees, onClose }: { leaveTypes: HrLeaveType[]; employees: HrLeaveGrantEmployee[]; onClose: () => void }) {
  const [leaveTypeId, setLeaveTypeId] = useState(leaveTypes[0]?.id ?? "");
  const [employmentIds, setEmploymentIds] = useState<string[]>([]);
  const [issuedOn, setIssuedOn] = useState(todayTaipei());
  const [expiresOn, setExpiresOn] = useState("");
  const [hours, setHours] = useState("1");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const employeeOptions = useMemo(() => employees.map((employee) => ({
    value: employee.employmentId,
    label: `${employee.employeeNumber}　${employee.employeeName}`,
  })), [employees]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const amountHours = Number(hours);
    if (!leaveTypeId) { setMessage("請先選擇額度發放假別。"); return; }
    if (!employmentIds.length) { setMessage("請選擇至少一位發放對象。"); return; }
    if (!Number.isSafeInteger(amountHours) || amountHours < 1 || amountHours > 8760) { setMessage("發放時數必須是 1～8760 的整數小時。"); return; }
    if (!issuedOn || !expiresOn || expiresOn < issuedOn) { setMessage("使用期限不可早於發放日期。"); return; }
    setMessage(null);
    save.mutate({
      path: "/leave-grants",
      method: "POST",
      values: { leaveTypeId, employmentIds, issuedOn, expiresOn, amountMinutes: amountHours * 60, note: note.trim() },
    }, { onSuccess: () => (closeRequestRef.current ?? onClose)() });
  }

  return <Dialog
    className="hr-leave-grant-dialog"
    title="發放假別額度"
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" tone="success" loading={save.isPending}>確認發放</Button></>}
  >
    <div className="hr-leave-grant-fields">
      <SelectField label="假別" required value={leaveTypeId} options={leaveTypes.map((type) => ({ value: type.id, label: type.name }))} onValueChange={setLeaveTypeId} hint="只列出額度規則設為「HR 逐批發放」的啟用假別。" />
      <SelectField label="發放對象" required multiple searchable value={employmentIds} options={employeeOptions} onValueChange={(values: string[]) => setEmploymentIds(values)} hint={`已選 ${employmentIds.length} 位員工；單批上限 100 人。`} />
      <div className="hr-leave-grant-date-row">
        <TextField label="發放日期" type="date" required value={issuedOn} onChange={(event) => setIssuedOn(event.target.value)} />
        <TextField label="使用期限（含當日）" type="date" required min={issuedOn} value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} />
      </div>
      <TextField label="每位員工發放時數" type="number" inputMode="numeric" min="1" max="8760" step="1" required value={hours} onChange={(event) => setHours(event.target.value)} hint="以整數小時發放；每位選定員工都會建立獨立批次台帳。" />
      <TextField label="備註（選填）" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    </div>
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrLeaveGrants() {
  usePageTitle("額度發放");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canWrite = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", leaveTypeId: "all", expiry: "unexpired" as "unexpired" | "expired" | "all" });
  const query = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    search: filters.search,
    leaveTypeId: filters.leaveTypeId,
    expiry: filters.expiry,
  });
  const grants = useHrQuery<HrLeaveGrantResponse>(`/leave-grants?${query}`, canRead);
  const employees = useHrQuery<{ employees: HrLeaveGrantEmployee[] }>("/leave-grants/employees", canRead, { keepPreviousData: false });
  const leaveTypes = useHrQuery<{ leaveTypes: HrLeaveType[] }>("/leave-types", canRead, { keepPreviousData: false });
  const revoke = useHrWrite();
  const [issuing, setIssuing] = useState(false);
  const [revoking, setRevoking] = useState<HrLeaveGrantRow | null>(null);
  const rows = grants.data?.grants ?? [];
  const total = grants.data?.total ?? 0;
  const issueTypes = (leaveTypes.data?.leaveTypes ?? []).filter((type) => type.active && type.leaveKind === "grant");
  const grantLeaveTypes = (leaveTypes.data?.leaveTypes ?? []).filter((type) => type.leaveKind === "grant");
  const today = todayTaipei();
  const updateFilters = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));

  if (!canRead) return <Alert tone="danger">額度發放僅限全平台 HR 管理者查看。</Alert>;
  if (grants.isPending || employees.isPending || leaveTypes.isPending) return <HrPageSkeleton variant="table" />;

  return <div className="page fills hr-leave-grants-page">
    <PageHeader
      title="額度發放"
      description="依假別、有效期間與員工建立可追溯的額度批次；員工申請時會先使用最早到期的額度。"
      actions={canWrite ? <Button icon="plus" tone="success" mobileIconOnly disabled={!issueTypes.length || !employees.data?.employees.length} onClick={() => setIssuing(true)}>發放額度</Button> : undefined}
    />
    {grants.error || employees.error || leaveTypes.error || revoke.error ? <Alert tone="danger">{grants.error?.message ?? employees.error?.message ?? leaveTypes.error?.message ?? revoke.error?.message}</Alert> : null}
    {!issueTypes.length ? <Alert tone="warning">尚無啟用中的額度發放假別；請先至「假別管理」新增或啟用一個額度發放假別。</Alert> : null}
    {!employees.data?.employees.length ? <Alert tone="warning">目前沒有可發放額度的在職員工。</Alert> : null}
    <Panel className="grows" title="發放紀錄">
      <FilterToolbar>
        <SearchFilterInput label="搜尋發放紀錄" placeholder="員工姓名、編號、假別或備註" value={filters.search} onSearch={(search) => updateFilters({ search })} />
        <FilterSelect label="額度假別" value={filters.leaveTypeId} options={[{ value: "all", label: "全部額度假別" }, ...grantLeaveTypes.map((type) => ({ value: type.id, label: type.name }))]} onChange={(event) => updateFilters({ leaveTypeId: event.target.value })} />
        <FilterSelect label="效期" value={filters.expiry} options={[{ value: "unexpired", label: "未過期" }, { value: "expired", label: "已過期" }, { value: "all", label: "全部紀錄" }]} onChange={(event) => updateFilters({ expiry: event.target.value as typeof filters.expiry })} />
      </FilterToolbar>
      {grants.isFetching ? <p className="muted table-note">更新中…</p> : null}
      <DataTable><thead><tr><th>假別／員工</th><th>發放與效期</th><th>額度</th><th>狀態</th><th>備註</th><th>操作</th></tr></thead><tbody>
        {rows.map((row) => {
          const status = rowStatus(row, today);
          return <tr key={row.id}>
            <td data-label="假別／員工"><strong>{row.leaveType}</strong><div>{row.employeeNumber}　{row.employeeName}</div></td>
            <td data-label="發放與效期">發放 {row.issuedOn}<br />期限至 {row.expiresOn}（含當日）</td>
            <td data-label="額度">發放 {hoursLabel(row.amountMinutes)}<br />已核准使用 {hoursLabel(row.usedMinutes)}<br /><strong>餘額 {hoursLabel(Math.max(0, row.balanceMinutes))}</strong></td>
            <td data-label="狀態"><StatusBadge tone={status.tone}>{status.label}</StatusBadge></td>
            <td data-label="備註">{row.note || "—"}</td>
            <td data-label="操作"><div className="row-actions">{canWrite && row.status === "active" && row.balanceMinutes > 0 ? <Button variant="secondary" tone="danger" icon="archive" onClick={() => setRevoking(row)}>撤銷剩餘額度</Button> : null}</div></td>
          </tr>;
        })}
      </tbody></DataTable>
      {!grants.isFetching && !grants.error && !rows.length ? <EmptyState className="mt-[18px]">{filters.search || filters.leaveTypeId !== "all" || filters.expiry !== "unexpired" ? "沒有符合條件的發放紀錄，請調整搜尋或篩選。" : "尚無額度發放紀錄；請先建立額度發放假別，再發放給在職員工。"}</EmptyState> : null}
      {total > 0 ? <Pager page={grants.data?.page ?? filters.page} pageSize={grants.data?.pageSize ?? filters.pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.max(1, Math.ceil(total / filters.pageSize))} totalLabel={`共 ${total.toLocaleString("zh-TW")} 筆`} onPage={(page) => updateFilters({ page })} onPageSize={(pageSize) => updateFilters({ pageSize })} /> : null}
    </Panel>
    {issuing && issueTypes.length && employees.data?.employees.length ? <IssueGrantDialog leaveTypes={issueTypes} employees={employees.data.employees} onClose={() => { setIssuing(false); void grants.refetch(); }} /> : null}
    {revoking ? <ConfirmDialog
      title="撤銷剩餘額度？"
      confirmLabel="撤銷剩餘額度"
      tone="danger"
      pending={revoke.isPending}
      onCancel={() => setRevoking(null)}
      onConfirm={() => revoke.mutate({ path: `/leave-grants/${encodeURIComponent(revoking.id)}/revoke`, method: "POST", values: {} }, { onSuccess: () => setRevoking(null) })}
    >
      將撤銷 {revoking.employeeName}「{revoking.leaveType}」尚未使用的 {hoursLabel(revoking.balanceMinutes)}。已核准請假紀錄不會取消，已扣除的時數不會回復。
    </ConfirmDialog> : null}
  </div>;
}
