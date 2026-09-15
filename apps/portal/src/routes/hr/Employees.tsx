import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceAssignment, type Candidate, type CompensationVersion, type Employee, type Employment, type InsuranceVersion, type LeaveRequest, type NamedOption, type Profile } from "./api.js";

interface FieldDefinition { key: string; label: string; type?: "date" | "email"; optional?: boolean; options?: NamedOption[]; maxLength?: number }
interface Editor { title: string; path: string; method: string; fields: FieldDefinition[]; initial?: Record<string, unknown>; description?: string }

const PAGE_SIZES = [10, 25, 50, 100] as const;
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const INSURANCE_LABEL: Record<InsuranceVersion["scheme"], string> = { labor: "勞保", health: "健保" };
const INSURANCE_STATUS_LABEL: Record<InsuranceVersion["status"], string> = { enrolled: "加保", withdrawn: "退保" };
const LEAVE_STATUS_LABEL: Record<LeaveRequest["status"], string> = { draft: "草稿", pending: "待審核", approved: "已核准", rejected: "已駁回", cancelled: "已取消" };

function statusLabel(status: Employee["userStatus"]): string {
  return status === "active" ? "啟用中" : status === "invited" ? "待啟用" : "已停用";
}
function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}
function dateTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
}

function EditorDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(editor.initial ?? {});
  const save = useHrWrite();
  return <Dialog title={editor.title} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const payload = { ...values };
    for (const field of editor.fields) if (field.optional && !payload[field.key]) payload[field.key] = null;
    save.mutate({ path: editor.path, method: editor.method, values: payload }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存</Button>}>
    {editor.description ? <p>{editor.description}</p> : null}
    {editor.fields.map((field) => field.options ? <SelectField key={field.key} label={field.label} value={String(values[field.key] ?? "")} options={[{ value: "", label: field.optional ? "未指定" : "請選擇" }, ...field.options.map((option) => ({ value: option.id, label: option.name }))]} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} required={!field.optional} /> :
      <TextField key={field.key} label={field.label} type={field.type ?? "text"} value={String(values[field.key] ?? "")} maxLength={field.maxLength} required={!field.optional} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />)}
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className={`hr-profile-section${open ? " open" : ""}`}>
    <button type="button" className="hr-profile-section-toggle" aria-expanded={open} onClick={onToggle}><span>{title}</span><span aria-hidden="true">{open ? "−" : "+"}</span></button>
    {open ? <div className="hr-profile-section-content">{children}</div> : null}
  </section>;
}

function BasicSection({ profile }: { profile: Profile }) {
  return <>
    <p className="muted">帳號：{profile.employee.email}；登入狀態：{statusLabel(profile.employee.userStatus)}</p>
    <p className="muted">期間結束日不含當日；停用帳號不會刪除任職歷史。</p>
    <p className="hr-employee-supervisor">主管：<strong>{profile.employee.supervisorName ?? "尚未設定"}</strong></p>
  </>;
}

function EmploymentTable({ employments }: { employments: Employment[] }) {
  return <>
    <table className="data-table"><thead><tr><th>到職日</th><th>不再任職首日</th><th>年資認列日</th><th>出勤方式</th></tr></thead>
      <tbody>{employments.map((job) => <tr key={job.id}><td>{job.hiredOn}</td><td>{job.endedOn ?? "未設定"}</td><td>{job.seniorityStartOn}</td><td>{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</td></tr>)}</tbody></table>
    {!employments.length ? <p>尚無任職紀錄。</p> : null}
  </>;
}

function CompensationTable({ rows, heading = true }: { rows: CompensationVersion[]; heading?: boolean }) {
  return <>
    {heading ? <h3>職務／薪資歷史</h3> : null}
    <table className="data-table"><thead><tr><th>生效期間</th><th>計算方式</th><th className="numeric">金額</th><th>備註</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{row.validFrom}～{row.validTo ?? "目前"}</td><td>{PAY_BASIS_LABEL[row.payBasis]}</td><td className="numeric">{money(row.baseAmountMinor)}</td><td>{row.note || "—"}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無薪資版本資料。</p> : null}
  </>;
}

function AssignmentTable({ assignments, heading = true }: { assignments: AttendanceAssignment[]; heading?: boolean }) {
  return <>
    {heading ? <h3>辦公位置摘要（唯讀）</h3> : null}
    <table className="data-table"><thead><tr><th>辦公位置</th><th>主要位置</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.locationName}</td><td>{assignment.isPrimary ? "主要" : "其他"}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!assignments.length ? <p>尚未指派辦公位置。</p> : null}
  </>;
}

function InsuranceTable({ rows, heading = true }: { rows: InsuranceVersion[]; heading?: boolean }) {
  return <>
    {heading ? <h3>勞健保加退保與異動歷史</h3> : null}
    <table className="data-table"><thead><tr><th>種類</th><th>狀態</th><th>生效期間</th><th className="numeric">投保金額</th><th>眷屬</th><th>級距來源</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{INSURANCE_LABEL[row.scheme]}</td><td>{INSURANCE_STATUS_LABEL[row.status]}</td><td>{row.validFrom}～{row.validTo ?? "目前"}</td><td className="numeric">{money(row.insuredAmountMinor)}</td><td>{row.scheme === "health" ? row.dependentCount : "—"}</td><td>{row.sourceKind === "official" ? `官方 ${row.rateYear}` : `人工 ${row.rateYear}`}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無勞健保資料。</p> : null}
  </>;
}

function AttendanceEventsTable({ profile }: { profile: Profile }) {
  const events = profile.attendanceEvents;
  if (!events) return <p className="muted">打卡明細僅限全平台 HR 管理者查看。</p>;
  return <>
    <table className="data-table"><thead><tr><th>時間</th><th>事件</th><th>辦公位置</th><th className="numeric">距離（公尺）</th></tr></thead><tbody>
      {events.map((event) => <tr key={event.id}><td>{dateTime(event.occurredAt)}</td><td>{event.eventKind === "clock_in" ? "上班" : "下班"}</td><td>{event.locationName ?? "—"}</td><td className="numeric">{event.distanceMeters ?? "—"}</td></tr>)}
    </tbody></table>
    {!events.length ? <p>尚無打卡紀錄。</p> : null}
  </>;
}

function LeaveTable({ rows }: { rows: LeaveRequest[] }) {
  return <>
    <h3>請假紀錄</h3>
    <table className="data-table"><thead><tr><th>假別</th><th>狀態</th><th>期間</th><th>時數</th><th>原因</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{row.leaveType}</td><td>{LEAVE_STATUS_LABEL[row.status]}</td><td>{row.startsOn}～{row.endsOn}</td><td>{Math.floor(row.durationMinutes / 60)} 小時 {row.durationMinutes % 60 ? `${row.durationMinutes % 60} 分` : ""}</td><td>{row.reason || "—"}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無請假紀錄。</p> : null}
  </>;
}

/** 員工內頁只呈現單一員工的完整脈絡；所有資料異動從各自的管理頁進入。 */
export function HrProfileDetails({ profile, collapsible = false }: { profile: Profile; collapsible?: boolean }) {
  const [open, setOpen] = useState("basic");
  const toggle = (name: string) => () => setOpen((current) => current === name ? "" : name);
  if (collapsible) return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <Section title="基本資料" open={open === "basic"} onToggle={toggle("basic")}><BasicSection profile={profile} /></Section>
    <Section title="任職" open={open === "employment"} onToggle={toggle("employment")}><EmploymentTable employments={profile.employments} /></Section>
    <Section title="薪資" open={open === "compensation"} onToggle={toggle("compensation")}>
      {profile.compensation ? <CompensationTable rows={profile.compensation} heading={false} /> : <p className="muted">薪資明細僅限全平台 HR 管理者查看。</p>}
    </Section>
    <Section title="勞健保" open={open === "insurance"} onToggle={toggle("insurance")}>
      {profile.insurance ? <InsuranceTable rows={profile.insurance} heading={false} /> : <p className="muted">勞健保明細僅限全平台 HR 管理者查看。</p>}
    </Section>
    <Section title="辦公位置摘要" open={open === "locations"} onToggle={toggle("locations")}><AssignmentTable assignments={profile.attendanceAssignments ?? []} heading={false} /></Section>
    <Section title="打卡紀錄" open={open === "events"} onToggle={toggle("events")}><AttendanceEventsTable profile={profile} /></Section>
    <Section title="請假" open={open === "leave"} onToggle={toggle("leave")}>
      {profile.leave ? <LeaveTable rows={profile.leave} /> : <p className="muted">請假明細僅限全平台 HR 管理者查看。</p>}
    </Section>
  </>;
  return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <BasicSection profile={profile} />
    <EmploymentTable employments={profile.employments} />
    <h3>營運櫃點歸屬</h3>
    <table className="data-table"><thead><tr><th>櫃點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {profile.assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.scopeName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!profile.assignments.length ? <p>尚無營運櫃點歸屬。</p> : null}
    <AssignmentTable assignments={profile.attendanceAssignments ?? []} />
    {profile.compensation ? <CompensationTable rows={profile.compensation} /> : null}
    {profile.insurance ? <InsuranceTable rows={profile.insurance} /> : null}
    {profile.leave ? <LeaveTable rows={profile.leave} /> : null}
    {profile.attendanceEvents ? <>
      <h3>打卡紀錄</h3>
      <AttendanceEventsTable profile={profile} />
    </> : null}
  </>;
}

export function HrEmployeeDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(id)}`, canRead && Boolean(id));
  usePageTitle(detail.data ? `${detail.data.employee.employeeNumber} ${detail.data.employee.displayName}` : "員工內頁");
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (detail.isPending) return <div className="page"><p>載入員工資料…</p></div>;
  if (detail.error || !detail.data) return <div className="page"><Alert tone="danger">{detail.error?.message ?? "找不到員工資料。"}</Alert><Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回員工列表</Button></div>;
  const profile = detail.data;
  return <div className="page">
    <PageHeader title={`${profile.employee.employeeNumber} · ${profile.employee.displayName}`} description="員工內頁只供查看單一員工的完整人事脈絡；資料異動請從各 HRIS 管理頁進入。" actions={<Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回列表</Button>} />
    <Panel><HrProfileDetails profile={profile} collapsible /></Panel>
  </div>;
}

function EmployeeManagementDialog({ employee, onClose, onEdit }: { employee: Employee; onClose: () => void; onEdit: (editor: Editor) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  const supervisors = useHrQuery<{ users: NamedOption[] }>(`/supervisor-candidates?exclude=${encodeURIComponent(employee.userId)}`);
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes");
  if (profile.isPending) return <Dialog title={`管理 ${employee.displayName}`} onClose={onClose}><p className="muted">載入員工管理資料…</p></Dialog>;
  if (profile.error || !profile.data) return <Dialog title={`管理 ${employee.displayName}`} onClose={onClose}><Alert tone="danger">{profile.error?.message ?? "員工資料載入失敗。"}</Alert></Dialog>;
  const data = profile.data;
  const activeEmployment = data.employments.find((job) => !job.endedOn);
  const openEditor = (editor: Editor) => { onClose(); onEdit(editor); };
  return <Dialog title={`管理 ${employee.employeeNumber} · ${employee.displayName}`} onClose={onClose} className="hr-employee-management-dialog">
    <p className="muted">員工內頁只供查看；員工編號、主管、任職與櫃點異動集中在這個管理入口。</p>
    <div className="hr-management-group">
      <h3>員工資料</h3>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => openEditor({ title: "編輯員工編號", path: `/employees/${data.employee.userId}`, method: "PATCH", fields: [{ key: "employeeNumber", label: "員工編號", maxLength: 40 }], initial: { employeeNumber: data.employee.employeeNumber, revision: data.employee.revision } })}>編輯員工編號</Button>
        <Button variant="secondary" disabled={supervisors.isPending} onClick={() => openEditor({ title: "設定員工主管", path: `/employees/${data.employee.userId}/supervisor`, method: "PATCH", description: "申請單預設會送給這位主管審核。", fields: [{ key: "supervisorUserId", label: "主管", options: supervisors.data?.users ?? [], optional: true }], initial: { supervisorUserId: data.employee.supervisorUserId ?? "", revision: data.employee.revision } })}>設定主管</Button>
      </div>
      {supervisors.error ? <p className="form-hint">主管候選人載入失敗：{supervisors.error.message}</p> : null}
    </div>
    <div className="hr-management-group">
      <h3>任職與櫃點</h3>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" disabled={!activeEmployment || !scopes.data?.scopes.length} onClick={() => openEditor({ title: "新增櫃點歸屬", path: "/assignments", method: "POST", initial: { employmentId: activeEmployment?.id, validFrom: activeEmployment?.hiredOn }, description: "營運櫃點歸屬期間需在任職期間內。", fields: [{ key: "scopeId", label: "櫃點", options: scopes.data?.scopes ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增櫃點歸屬</Button>
        <Button onClick={() => openEditor({ title: "新增任職／復職紀錄", path: "/employments", method: "POST", initial: { userId: data.employee.userId }, description: "同一使用者的任職期間不可重疊；復職新增紀錄，不修改舊任職。", fields: [{ key: "userId", label: "使用者", options: [{ id: data.employee.userId, name: `${data.employee.displayName}（${data.employee.email}）` }] }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "endedOn", label: "不再任職首日（可留空）", type: "date", optional: true }, { key: "attendanceMode", label: "出勤方式", options: [{ id: "general", name: "一般辦公" }, { id: "scheduled", name: "排班" }] }] })}>新增任職／復職</Button>
      </div>
      {!data.employments.length ? <p className="muted">尚無任職紀錄。</p> : data.employments.map((job) => <div className="hr-management-job" key={job.id}>
        <p><strong>{job.hiredOn}{job.endedOn ? `～${job.endedOn}` : "～目前"}</strong> · {job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</p>
        <div className="flex flex-wrap gap-3">
          {!job.endedOn ? <Button variant="secondary" onClick={() => openEditor({ title: "結束任職", path: `/employments/${job.id}/end`, method: "PATCH", initial: { revision: job.revision }, description: "請先在排班管理結束超過離職日期的辦公位置指派，再結束任職。", fields: [{ key: "endedOn", label: "不再任職首日", type: "date" }] })}>結束任職</Button> : null}
          {data.assignments.filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => openEditor({ title: `結束 ${assignment.scopeName} 歸屬`, path: `/assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.scopeName} 歸屬</Button>)}
        </div>
      </div>)}
      {scopes.error ? <p className="form-hint">櫃點清單載入失敗：{scopes.error.message}</p> : null}
    </div>
    <p className="form-hint">辦公位置與出勤方式請到「排班管理／辦公地點指派」；薪資與勞健保請到各自的管理頁。</p>
  </Dialog>;
}

export function HrEmployees() {
  usePageTitle("員工列表");
  const navigate = useNavigate();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", sortField: "employeeNumber", sortDirection: "asc" });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [manageEmployee, setManageEmployee] = useState<Employee | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean }>(`/employees?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`, canRead);
  const candidates = useHrQuery<{ users: Candidate[] }>("/candidates", canWrite);
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  const data = employees.data;
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((candidate) => ({ id: candidate.userId, name: `${candidate.displayName}（${candidate.email}）` }));
  const statusOptions = [{ value: "all", label: "全部狀態" }, { value: "active", label: "啟用中" }, { value: "invited", label: "待啟用" }, { value: "disabled", label: "已停用" }];
  return <div className="page fills">
    <PageHeader title="員工列表" description="搜尋、篩選與排序員工；點選整列查看內頁，使用列上的「管理」入口進行員工與任職異動。" actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => setEditor({ title: "指派員工", path: "/employees", method: "POST", description: "員工必須先存在於平台使用者名單。", fields: [{ key: "userId", label: "使用者", options: candidateOptions }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "attendanceMode", label: "出勤方式", options: [{ id: "general", name: "一般辦公" }, { id: "scheduled", name: "排班" }] }] })}>指派員工</Button> : null} />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋員工編號、姓名或 Email" value={filters.search} onSearch={(search) => update({ search })} />
        <FilterSelect label="狀態" value={filters.status} onChange={(event) => update({ status: event.target.value })} options={statusOptions} />
      </form>
      {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
      {candidates.error ? <Alert tone="danger">{candidates.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <SortableHeader label="員工編號" field="employeeNumber" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="姓名" field="name" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="帳號" field="email" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="狀態" field="status" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        {canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data?.employees.map((employee) => <tr key={employee.userId} className="clickable-row" role="link" tabIndex={0} onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`); } }}><td data-label="員工編號"><span className="cell-strong">{employee.employeeNumber}</span></td><td data-label="姓名">{employee.displayName}</td><td data-label="帳號" className="cell-sub">{employee.email}</td><td data-label="狀態">{statusLabel(employee.userStatus)}</td>{canWrite ? <td data-label="操作"><Button variant="secondary" onClick={(event) => { event.stopPropagation(); setManageEmployee(employee); }}>管理</Button></td> : null}</tr>)}
      </tbody></table></div>
      {employees.isPending ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.employees.length ? <p className="muted table-note">{data.total ? "沒有符合條件的員工，調整一下搜尋或篩選看看。" : "尚無員工資料，請先邀請使用者，再指派員工。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {manageEmployee ? <EmployeeManagementDialog employee={manageEmployee} onClose={() => setManageEmployee(null)} onEdit={(nextEditor) => { setManageEmployee(null); setEditor(nextEditor); }} /> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); if (canWrite) void candidates.refetch(); }} /> : null}
  </div>;
}
