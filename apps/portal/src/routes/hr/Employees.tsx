import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, DataTable, Dialog, FilterSelect, FilterToolbar, PageHeader, Panel, SearchFilterInput, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceAssignment, type Candidate, type CompensationVersion, type Employee, type Employment, type InsuranceVersion, type LeaveRequest, type NamedOption, type Profile } from "./api.js";
import { EmployeeProfile } from "./EmployeeProfile.js";
import { EmployeeSectionNav } from "./EmployeeSectionNav.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface FieldDefinition { key: string; label: string; type?: "date" | "email"; options?: NamedOption[]; maxLength?: number }
interface Editor { title: string; fields: FieldDefinition[]; description: string }

export function employeeDetailPath(employee: Pick<Employee, "employmentId" | "userId">): string {
  return `/hr/employees/${encodeURIComponent(employee.employmentId ?? employee.userId ?? "")}`;
}

const PAGE_SIZES = [10, 25, 50, 100] as const;
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const INSURANCE_LABEL: Record<InsuranceVersion["scheme"], string> = { labor: "勞保", health: "健保" };
const LEAVE_STATUS_LABEL: Record<LeaveRequest["status"], string> = { draft: "草稿", pending: "待審核", approved: "已核准", rejected: "已駁回", cancelled: "已取消" };

function statusLabel(status: Employee["userStatus"]): string {
  return status === "active" ? "啟用中" : status === "invited" ? "待啟用" : "已停用";
}
function money(minor: number): string { return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`; }
function dateTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}
export function HrLineBindingStatus({ employee }: { employee: Pick<Employee, "personKind" | "userId" | "lineLinkedAt"> }) {
  if (employee.personKind === "worker" || employee.userId === null) return <span className="muted">不適用</span>;
  if (employee.lineLinkedAt === undefined) return <span className="muted">狀態未提供</span>;
  return <><StatusBadge tone={employee.lineLinkedAt === null ? "neutral" : "success"}>{employee.lineLinkedAt === null ? "未綁定" : "已綁定"}</StatusBadge>{employee.lineLinkedAt ? <><br /><span className="muted">{dateTime(employee.lineLinkedAt)}</span></> : null}</>;
}

function EditorDialog({ editor, onClose, onSuccess }: { editor: Editor; onClose: () => void; onSuccess: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  return <Dialog title={editor.title} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    save.mutate({ path: "/employees", method: "POST", values }, { onSuccess: () => { onSuccess(); (closeRequestRef.current ?? onClose)(); } });
  } }} actions={<Button type="submit" className="add-action" loading={save.isPending}>儲存</Button>}>
    <p>{editor.description}</p>
    <fieldset disabled={save.isPending} className="hr-employee-detail-fields hr-employee-create-fields">
      {editor.fields.map((field) => field.options ? <SelectField key={field.key} label={field.label} value={values[field.key] ?? ""} options={[{ value: "", label: "請選擇" }, ...field.options.map((option) => ({ value: option.id, label: option.name }))]} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} required /> : <TextField key={field.key} label={field.label} type={field.type ?? "text"} value={values[field.key] ?? ""} maxLength={field.maxLength} required onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />)}
    </fieldset>
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function EmploymentHistoryTable({ employments }: { employments: Employment[] }) {
  return <DataTable><thead><tr><th>員工編號</th><th>職位</th><th>主管</th><th>服務年資起算日</th><th>出勤方式</th><th>狀態</th></tr></thead><tbody>{employments.map((job) => <tr key={job.id}><td data-label="員工編號">{job.employeeNumber}</td><td data-label="職位">{job.position}</td><td data-label="主管">{job.supervisorName ?? "未設定"}</td><td data-label="服務年資起算日">{job.serviceStartOn ?? "未設定"}</td><td data-label="出勤方式">{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</td><td data-label="狀態">{job.archivedAt ? `未在職（${dateTime(job.archivedAt)}）` : "在職"}</td></tr>)}</tbody></DataTable>;
}

function BasicSection({ profile }: { profile: Profile }) {
  const job = profile.employments.find((entry) => !entry.archivedAt) ?? profile.employments[0];
  return <Panel id="employee-basic" title="基本資料"><dl className="hr-employee-profile-grid">
    <div><dt>姓名</dt><dd>{profile.employee.legalName}</dd></div><div><dt>員工編號</dt><dd>{profile.employee.employeeNumber}</dd></div><div><dt>職位</dt><dd>{job?.position ?? profile.employee.position}</dd></div><div><dt>員工狀態</dt><dd>{job?.archivedAt ? `未在職（${dateTime(job.archivedAt)}）` : job ? "在職" : "尚未建立員工資料"}</dd></div>
  </dl><p className="muted">員工不在職後仍保留資料，供薪資、出勤與稽核歷史追溯。</p>{profile.employee.personKind === "worker" ? <p className="muted">支援人員沒有平台帳號；人員與排班異動由支援人員管理維護。</p> : null}</Panel>;
}

function CompensationTable({ rows }: { rows: CompensationVersion[] }) {
  if (!rows.length) return <p className="muted">尚無敘薪資料。</p>;
  return <DataTable><thead><tr><th>生效期間</th><th>狀態</th><th>計算方式</th><th className="numeric">本薪</th><th>加班設定</th><th>薪資項目／備註</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
    <td data-label="生效期間">{row.validFrom}～{row.validTo ?? "未設定迄日"}</td><td data-label="狀態"><StatusBadge tone={row.voidedAt ? "danger" : "neutral"}>{row.voidedAt ? "已撤回" : "有效版本"}</StatusBadge></td><td data-label="計算方式">{PAY_BASIS_LABEL[row.payBasis]}</td><td data-label="本薪" className="numeric">{money(row.baseAmountMinor)}</td><td data-label="加班設定">{row.overtimeRatePpm != null ? `固定 ${row.overtimeRatePpm / 1_000_000} 倍` : row.overtimeHourlyMinor != null ? `固定 ${money(row.overtimeHourlyMinor)}／時` : "制度倍率"}</td><td data-label="薪資項目／備註">{row.items?.map((item) => <div key={item.id}>{item.itemName}：{money(item.amountMinor)}／{PAY_BASIS_LABEL[item.amountBasis]}</div>)}{row.note || (!row.items?.length ? "—" : null)}</td>
  </tr>)}</tbody></DataTable>;
}
function AssignmentTable({ assignments }: { assignments: AttendanceAssignment[] }) {
  if (!assignments.length) return <p className="muted">尚未指派辦公位置。</p>;
  return <DataTable><thead><tr><th>辦公位置</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>{assignments.map((assignment) => <tr key={assignment.id}><td data-label="辦公位置">{assignment.locationName}</td><td data-label="起日">{assignment.validFrom}</td><td data-label="迄日（不含）">{assignment.validTo ?? "未設定"}</td></tr>)}</tbody></DataTable>;
}
function InsuranceTable({ rows }: { rows: InsuranceVersion[] }) {
  if (!rows.length) return <p className="muted">尚無勞健保資料。</p>;
  return <DataTable><thead><tr><th>種類</th><th>狀態</th><th>生效期間</th><th className="numeric">投保金額</th><th>眷屬</th><th>級距來源</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td data-label="種類">{INSURANCE_LABEL[row.scheme]}</td><td data-label="狀態"><StatusBadge tone={row.voidedAt ? "danger" : row.status === "enrolled" ? "success" : "neutral"}>{row.voidedAt ? "已撤回" : row.status === "enrolled" ? "加保" : "退保"}</StatusBadge></td><td data-label="生效期間">{row.validFrom}～{row.validTo ?? "未設定迄日"}</td><td data-label="投保金額" className="numeric">{money(row.insuredAmountMinor)}</td><td data-label="眷屬">{row.scheme === "health" ? row.dependentCount : "—"}</td><td data-label="級距來源">{row.sourceKind === "official" ? "官方" : "人工"} {row.rateYear}</td></tr>)}</tbody></DataTable>;
}
function AttendanceEventsTable({ profile }: { profile: Profile }) {
  if (!profile.attendanceEvents) return <p className="muted">打卡明細僅限全平台 HR 管理者查看。</p>;
  if (!profile.attendanceEvents.length) return <p className="muted">尚無打卡紀錄。</p>;
  return <DataTable><thead><tr><th>時間</th><th>事件</th><th>辦公位置</th><th className="numeric">距離（公尺）</th></tr></thead><tbody>{profile.attendanceEvents.map((event) => <tr key={event.id}><td data-label="時間">{dateTime(event.occurredAt)}</td><td data-label="事件">{event.eventKind === "clock_in" ? "上班" : "下班"}</td><td data-label="辦公位置">{event.locationName ?? "—"}</td><td data-label="距離（公尺）" className="numeric">{event.distanceMeters ?? "—"}</td></tr>)}</tbody></DataTable>;
}
function LeaveTable({ rows }: { rows: LeaveRequest[] }) {
  if (!rows.length) return <p className="muted">尚無請假紀錄。</p>;
  return <DataTable><thead><tr><th>假別</th><th>狀態</th><th>期間</th><th>時數</th><th>原因</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td data-label="假別">{row.leaveType}</td><td data-label="狀態"><StatusBadge tone={row.status === "approved" ? "success" : row.status === "rejected" ? "danger" : row.status === "pending" ? "warning" : "neutral"}>{LEAVE_STATUS_LABEL[row.status]}</StatusBadge></td><td data-label="期間">{row.startsAt ? dateTime(row.startsAt) : row.startsOn}～{row.endsAt ? dateTime(row.endsAt) : row.endsOn}</td><td data-label="時數">{Math.floor(row.durationMinutes / 60)} 小時 {row.durationMinutes % 60 ? `${row.durationMinutes % 60} 分` : ""}</td><td data-label="原因">{row.reason || "—"}</td></tr>)}</tbody></DataTable>;
}

export function HrProfileDetails({ profile, includeBasic = true }: { profile: Profile; includeBasic?: boolean }) {
  const job = profile.employments.find((entry) => !entry.archivedAt) ?? profile.employments[0];
  const isWorker = profile.employee.personKind === "worker";
  return <>
    {includeBasic ? <BasicSection profile={profile} /> : null}
    <Panel id="employee-compensation" title="敘薪資料" description="保留每次異動的生效期間、本薪、加班設定與薪資項目；已撤回版本不參與計算。">
      {profile.compensation ? <CompensationTable rows={profile.compensation} /> : <p className="muted">敘薪明細僅限全平台 HR 管理者查看。</p>}
    </Panel>
    {!isWorker ? <>
      <Panel id="employee-insurance" title="保險資料" description="勞保、健保的加退保、投保級距與眷屬異動歷史。">{profile.insurance ? <InsuranceTable rows={profile.insurance} /> : <p className="muted">勞健保明細僅限全平台 HR 管理者查看。</p>}</Panel>
      <Panel id="employee-attendance" title="出勤資料">
        <dl className="hr-employee-profile-grid"><div><dt>出勤方式</dt><dd>{job?.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</dd></div>{job?.attendanceMode === "scheduled" ? <div><dt>每月約定休假</dt><dd>{job.monthlyRestDays == null ? "未設定" : `${job.monthlyRestDays} 天`}</dd></div> : null}</dl>
        <h3>辦公位置</h3><AssignmentTable assignments={profile.attendanceAssignments ?? []} />
        <h3>營運據點歸屬</h3>
        {profile.assignments === undefined ? <p className="muted">營運據點歸屬未提供。</p> : profile.assignments.length ? <DataTable><thead><tr><th>營運據點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>{profile.assignments.map((assignment) => <tr key={assignment.id}><td data-label="營運據點">{assignment.scopeName}</td><td data-label="起日">{assignment.validFrom}</td><td data-label="迄日（不含）">{assignment.validTo ?? "未設定"}</td></tr>)}</tbody></DataTable> : <p className="muted">尚無營運據點歸屬。</p>}
        <details className="hr-employee-record-details"><summary>打卡紀錄（最近 200 筆）</summary><AttendanceEventsTable profile={profile} /></details>
        <details className="hr-employee-record-details"><summary>請假紀錄</summary>{profile.leave ? <LeaveTable rows={profile.leave} /> : <p className="muted">請假明細僅限全平台 HR 管理者查看。</p>}</details>
      </Panel>
    </> : null}
    {profile.employments.length > 1 ? <Panel id="employee-history" title="歷史任職資料"><EmploymentHistoryTable employments={profile.employments} /></Panel> : null}
  </>;
}

export function HrEmployeeDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(id)}`, canRead && Boolean(id), { keepPreviousData: false });
  usePageTitle(detail.data ? `${detail.data.employee.employeeNumber} ${detail.data.employee.legalName}` : "人員內頁");
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (detail.isPending) return <HrPageSkeleton variant="detail" />;
  if (detail.error || !detail.data) return <div className="page"><Alert tone="danger">{detail.error?.message ?? "找不到員工資料。"}</Alert><Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回員工列表</Button></div>;
  const profile = detail.data;
  const formalEmployee = profile.employee.personKind !== "worker" && profile.employee.userId !== null;
  return <div className="page hr-employee-detail-page">
    <PageHeader title={`${profile.employee.employeeNumber} · ${profile.employee.legalName}`} description={formalEmployee ? "集中維護大頭貼、基本、聯絡與公司資料，查看敘薪、保險與出勤紀錄。" : "支援人員的人員與敘薪紀錄；異動由支援人員管理維護。"} actions={<Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回列表</Button>} />
    <EmployeeSectionNav key={id} profile={profile} />
    {formalEmployee ? <EmployeeProfile key={profile.employee.userId} profile={profile} canWrite={canWrite} onSaved={() => void detail.refetch()} /> : <BasicSection profile={profile} />}
    <HrProfileDetails profile={profile} includeBasic={false} />
  </div>;
}

export function HrEmployees() {
  usePageTitle("人員列表");
  const navigate = useNavigate();
  const toast = useToast();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", employmentStatus: "active" as "active" | "inactive", sortField: "employeeNumber", sortDirection: "asc" });
  const [editor, setEditor] = useState<Editor | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean; counts: { active: number; inactive: number } }>(`/employees?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&employmentStatus=${filters.employmentStatus}&personKind=all&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`, canRead);
  const candidates = useHrQuery<{ users: Candidate[] }>("/candidates", canWrite);
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (employees.isPending) return <HrPageSkeleton variant="table" />;
  const data = employees.data;
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const sort = (sortField: string, sortDirection: "asc" | "desc") => update({ sortField, sortDirection });
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((candidate) => ({ id: candidate.userId, name: `${candidate.displayName}（${candidate.email}）` }));
  return <div className="page fills">
    <PageHeader title="人員列表" description="點選人員進入內頁，維護基本資料並查看完整人事紀錄。" actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => setEditor({ title: "指派新員工", description: "員工必須先存在於平台使用者名單；正式姓名請依身分證件填寫。出勤方式與辦公位置由出勤範圍管理維護。", fields: [{ key: "userId", label: "使用者", options: candidateOptions }, { key: "legalName", label: "正式姓名（身分證）", maxLength: 100 }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "position", label: "職位", maxLength: 100 }, { key: "serviceStartOn", label: "服務年資起算日", type: "date" }] })}>新增員工</Button> : null} />
    <Panel className="grows">
      <div className="hr-employee-status-tabs" role="tablist" aria-label="人員狀態">
        <button type="button" role="tab" aria-selected={filters.employmentStatus === "active"} className={filters.employmentStatus === "active" ? "active" : ""} onClick={() => update({ employmentStatus: "active" })}>在職 <span>{data?.counts.active ?? "—"}</span></button>
        <button type="button" role="tab" aria-selected={filters.employmentStatus === "inactive"} className={filters.employmentStatus === "inactive" ? "active" : ""} onClick={() => update({ employmentStatus: "inactive" })}>未在職 <span>{data?.counts.inactive ?? "—"}</span></button>
      </div>
      <FilterToolbar><SearchFilterInput label="搜尋" placeholder="搜尋人員編號、姓名或 Email" value={filters.search} onSearch={(search) => update({ search })} /><FilterSelect label="帳號狀態" value={filters.status} onChange={(event) => update({ status: event.target.value })} options={[{ value: "all", label: "全部帳號" }, { value: "active", label: "啟用中" }, { value: "invited", label: "待啟用" }, { value: "disabled", label: "已停用" }]} /></FilterToolbar>
      <p className="muted table-note">LINE 綁定、帳號啟用與在職狀態分開；已綁定不代表可登入或打卡。支援人員沒有平台帳號。</p>
      {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}{candidates.error ? <Alert tone="danger">{candidates.error.message}</Alert> : null}
      <DataTable className="hr-employee-list-table"><colgroup><col className="hr-employee-number-column" /><col className="hr-employee-name-column" /><col className="hr-employee-account-column" /><col className="hr-employee-status-column" /><col className="hr-employee-line-column" /><col className="hr-employee-position-column" /><col className="hr-employee-supervisor-column" /><col className="hr-employee-status-column" /></colgroup><thead><tr>
        <SortableHeader label="員工編號" field="employeeNumber" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={sort} />
        <SortableHeader label="姓名" field="name" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={sort} />
        <SortableHeader label="帳號" field="email" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={sort} />
        <SortableHeader label="帳號狀態" field="status" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={sort} />
        <th>LINE 綁定</th><th>職位</th><th>主管</th><th>員工狀態</th>
      </tr></thead><tbody>{data?.employees.map((employee) => {
        const path = employeeDetailPath(employee);
        return <tr key={employee.employmentId ?? employee.userId} className="clickable-row" role="link" tabIndex={0} onClick={() => navigate(path)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(path); } }}>
          <td data-label="員工編號"><span className="cell-strong">{employee.employeeNumber}</span></td><td data-label="姓名">{employee.legalName}<br /><span className="cell-sub">{employee.personKind === "worker" ? "排班支援人員" : "正式員工"}</span></td><td data-label="帳號" className="cell-sub">{employee.email || "無平台帳號"}</td><td data-label="帳號狀態"><StatusBadge tone={employee.personKind === "worker" ? "neutral" : employee.userStatus === "active" ? "success" : employee.userStatus === "invited" ? "neutral" : "danger"}>{employee.personKind === "worker" ? "無平台帳號" : statusLabel(employee.userStatus)}</StatusBadge></td><td data-label="LINE 綁定"><HrLineBindingStatus employee={employee} /></td><td data-label="職位">{employee.position}</td><td data-label="主管">{employee.supervisorName ?? "未設定"}</td><td data-label="員工狀態"><StatusBadge tone={employee.employmentStatus === "active" ? "success" : "neutral"}>{employee.employmentStatus === "active" ? "在職" : "未在職"}</StatusBadge></td>
        </tr>;
      })}</tbody></DataTable>
      {employees.isPlaceholderData ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.employees.length ? <p className="muted table-note">{data.total ? "沒有符合條件的人員，調整一下搜尋或篩選看看。" : filters.employmentStatus === "active" ? "目前沒有在職人員。" : "目前沒有未在職人員。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); void candidates.refetch(); }} onSuccess={() => toast.show("已指派新員工", "success")} /> : null}
  </div>;
}
