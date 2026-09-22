import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Assignment, type AttendanceAssignment, type Candidate, type CompensationVersion, type Employee, type Employment, type InsuranceVersion, type LeaveRequest, type NamedOption, type Profile } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface FieldDefinition { key: string; label: string; type?: "date" | "email"; optional?: boolean; options?: NamedOption[]; maxLength?: number }
interface Editor { title: string; path: string; method: string; fields: FieldDefinition[]; initial?: Record<string, unknown>; description?: string; undoable?: boolean; successMessage?: string; submitLabel?: string; submitVariant?: "primary" | "secondary" | "danger" }

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

function EditorDialog({ editor, onClose, onSuccess }: { editor: Editor; onClose: () => void; onSuccess?: (result: { id: string; operationId?: string }) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(editor.initial ?? {});
  const save = useHrWrite<{ id: string; operationId?: string }>();
  return <Dialog title={editor.title} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const payload = { ...values };
    for (const field of editor.fields) if (field.optional && !payload[field.key]) payload[field.key] = null;
    save.mutate({ path: editor.path, method: editor.method, values: payload }, { onSuccess: (result) => { onSuccess?.(result); onClose(); } });
  } }} actions={<Button type="submit" variant={editor.submitVariant} loading={save.isPending}>{editor.submitLabel ?? "儲存"}</Button>}>
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
      <tbody>{employments.map((job) => <tr key={job.id}><td>{job.hiredOn}</td><td>{job.revokedAt ? <span className="status status-disabled">已撤銷</span> : job.endedOn ?? "未設定"}</td><td>{job.seniorityStartOn}</td><td>{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</td></tr>)}</tbody></table>
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
    <table className="data-table"><thead><tr><th>辦公位置</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.locationName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
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
    <h3>營運據點歸屬</h3>
    <table className="data-table"><thead><tr><th>營運據點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {(profile.assignments ?? []).map((assignment) => <tr key={assignment.id}><td>{assignment.scopeName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!profile.assignments?.length ? <p>尚無營運據點歸屬。</p> : null}
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
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(id)}`, canRead && Boolean(id), { keepPreviousData: false });
  usePageTitle(detail.data ? `${detail.data.employee.employeeNumber} ${detail.data.employee.displayName}` : "員工內頁");
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (detail.isPending) return <HrPageSkeleton variant="detail" />;
  if (detail.error || !detail.data) return <div className="page"><Alert tone="danger">{detail.error?.message ?? "找不到員工資料。"}</Alert><Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回員工列表</Button></div>;
  const profile = detail.data;
  return <div className="page">
    <PageHeader title={`${profile.employee.employeeNumber} · ${profile.employee.displayName}`} description="員工內頁只供查看單一員工的完整人事脈絡；資料異動請從各 HRIS 管理頁進入。" actions={<Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回列表</Button>} />
    <Panel><HrProfileDetails profile={profile} collapsible /></Panel>
  </div>;
}

function employmentActionLabel(actionKind: NonNullable<Profile["lastEmploymentAction"]>["actionKind"]): string {
  return actionKind === "employee_assigned" ? "指派員工" : actionKind === "employment_created" ? "新增任職" : "結束任職";
}

function assignmentNeedsEnd(validTo: string | null, employmentEndedOn: string | null): boolean {
  return validTo === null || (employmentEndedOn !== null && validTo > employmentEndedOn);
}

function EmployeeManagementDialog({ employee, onClose, onEdit, onUndo, canOfficeWrite }: { employee: Employee; onClose: () => void; onEdit: (editor: Editor) => void; onUndo: (operationId: string) => void; canOfficeWrite: boolean }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`, true, { keepPreviousData: false });
  if (profile.isPending) return <Dialog title={`管理 ${employee.displayName}`} onClose={onClose}><p className="muted">載入任職資料…</p></Dialog>;
  if (profile.error || !profile.data) return <Dialog title={`管理 ${employee.displayName}`} onClose={onClose}><Alert tone="danger">{profile.error?.message ?? "員工資料載入失敗。"}</Alert></Dialog>;
  const data = profile.data;
  const activeEmployment = data.employee.employmentStatus === "active" ? [...data.employments].reverse().find((job) => !job.endedOn && !job.revokedAt) : undefined;
  const hasRevokedEmployment = data.employments.some((job) => Boolean(job.revokedAt));
  const openEditor = (editor: Editor) => { onClose(); onEdit(editor); };
  const endDateFor = (validTo: string | null, endedOn: string | null) => endedOn && (validTo === null || validTo > endedOn) ? endedOn : "";
  const endScopeAssignment = (assignment: Assignment, job: Employment) => openEditor({
    title: `結束 ${assignment.scopeName} 的營運據點歸屬`, path: `/assignments/${assignment.id}/end`, method: "PATCH",
    initial: { revision: assignment.revision, validTo: endDateFor(assignment.validTo, job.endedOn) },
    description: "這不是刪除資料；填寫該據點不再歸屬的第一天，系統會保留歷史。若要結束這段任職，通常填與離職生效日相同的日期。",
    fields: [{ key: "validTo", label: "歸屬結束日（不含當日）", type: "date" }],
  });
  const endLocationAssignment = (assignment: AttendanceAssignment, job: Employment) => openEditor({
    title: `結束 ${assignment.locationName} 的辦公位置指派`, path: `/attendance-location-assignments/${assignment.id}/end`, method: "PATCH",
    initial: { revision: assignment.revision, validTo: endDateFor(assignment.validTo, job.endedOn) },
    description: "這不是刪除資料；填寫該辦公位置不再可打卡的第一天，系統會保留歷史。若要結束這段任職，通常填與離職生效日相同的日期。",
    fields: [{ key: "validTo", label: "指派結束日（不含當日）", type: "date" }],
  });
  const editEmploymentDates = (job: Employment) => openEditor({
    title: "編輯任職日期", path: `/employments/${job.id}`, method: "PATCH",
    successMessage: `已更新 ${data.employee.displayName} 的任職日期`,
    initial: { hiredOn: job.hiredOn, seniorityStartOn: job.seniorityStartOn, revision: job.revision },
    description: "可修正到職日與年資認列日；不再任職首日請使用「結束任職」。新的到職日必須涵蓋既有指派、出勤與薪資歷史，不能把任職起點改到既有資料之後。",
    fields: [{ key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }],
  });
  const endEmployment = (job: Employment) => openEditor({
    title: "結束任職", path: `/employments/${job.id}/end`, method: "PATCH", undoable: true,
    successMessage: `已結束 ${data.employee.displayName} 的任職`, initial: { revision: job.revision },
    description: "離職生效日是不再任職的第一天；系統會自動把仍有效的營運據點歸屬與辦公位置指派結束在同一天，並保留任職與相關歷史。若只是任職中途調整據點或辦公位置，才需要在任職歷史下方個別結束。",
    fields: [{ key: "endedOn", label: "離職生效日（不含當日）", type: "date" }],
  });
  const createEmployment = () => openEditor({
    title: hasRevokedEmployment ? "重新指派員工" : data.employments.length ? "新增復職任職" : "新增任職", path: "/employments", method: "POST", undoable: true,
    successMessage: hasRevokedEmployment ? `已重新指派 ${data.employee.displayName}` : `已新增 ${data.employee.displayName} 的任職`,
    initial: { userId: data.employee.userId },
    description: hasRevokedEmployment ? "這會建立一段全新的任職，沿用原員工帳號與編號；原本已撤銷的任職、據點與其他下游歷史不會被改寫。這和敘薪解除後建立修正版相同，請填寫新的到職日。" : "復職會建立新的任職期間，不會修改既有歷史；到職後可再從此處結束任職。",
    fields: [{ key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }],
  });
  const revokeEmployment = (job: Employment) => openEditor({
    title: "撤銷錯誤任職", path: `/employments/${job.id}/revoke`, method: "POST", submitLabel: "確認撤銷", submitVariant: "danger",
    successMessage: `已撤銷 ${data.employee.displayName} 的錯誤任職`, initial: { revision: job.revision },
    description: "撤銷會保留任職列、employmentId 與所有下游歷史，不會 cascade 刪除或改寫資料。這段任職撤銷後不再視為在職，也不能再新增指派、薪資或其他關聯；若要重新加入，請到未在職列表按「重新指派」。若只是正常離職，請使用「結束任職」。",
    fields: [],
  });
  return <Dialog title={`管理任職｜${data.employee.employeeNumber} · ${data.employee.displayName}`} onClose={onClose} className="hr-employee-management-dialog" actions={activeEmployment ? <Button variant="danger" onClick={() => endEmployment(activeEmployment)}>結束任職</Button> : <Button onClick={createEmployment}>{hasRevokedEmployment ? "重新指派" : data.employments.length ? "新增復職任職" : "新增任職"}</Button>}>
    <div className="hr-management-identity">
      <div><strong>{data.employee.displayName}</strong><span>{data.employee.email}</span></div>
      <span className={`status ${data.employee.employmentStatus === "active" ? "status-active" : "status-invited"}`}>{data.employee.employmentStatus === "active" ? "在職" : "未在職"}</span>
    </div>
    <p className="hr-management-description">這裡管理任職期間，也可以在任職中途結束營運據點歸屬與辦公位置指派；結束任職時，仍有效的兩種指派會自動在離職生效日結束並保留歷史。薪資、員工編號、主管與出勤方式請到各自的 HR 管理頁維護。</p>
    {activeEmployment ? <div className="hr-management-current">
      <div><span className="eyebrow">目前任職</span><strong>{activeEmployment.hiredOn}～目前</strong><span>年資認列日：{activeEmployment.seniorityStartOn}</span></div>
    </div> : <div className="hr-management-current is-empty">
      <div><span className="eyebrow">目前任職</span><strong>{hasRevokedEmployment ? "任職已撤銷，可重新指派" : "目前沒有有效任職"}</strong><span>{hasRevokedEmployment ? "建立新的任職版本；原撤銷任職與下游歷史會保留不變。" : "請從下方操作列新增任職或建立復職紀錄。"}</span></div>
    </div>}
    <div className="hr-management-group">
      <h3>任職歷史</h3>
      {!data.employments.length ? <p className="muted">尚無任職紀錄。</p> : <div className="hr-management-history">{data.employments.map((job) => {
        const scopeAssignments = (data.assignments ?? []).filter((assignment) => !job.revokedAt && assignment.employmentId === job.id && assignmentNeedsEnd(assignment.validTo, job.endedOn));
        const locationAssignments = (data.attendanceAssignments ?? []).filter((assignment) => !job.revokedAt && assignment.employmentId === job.id && assignmentNeedsEnd(assignment.validTo, job.endedOn));
        return <div className="hr-management-job" key={job.id}>
          <div><strong>{job.revokedAt ? `${job.hiredOn}～已撤銷` : `${job.hiredOn}${job.endedOn ? `～${job.endedOn}` : "～目前／待到職"}`}</strong><span>{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"} · 年資認列日 {job.seniorityStartOn}</span>
            {scopeAssignments.length || locationAssignments.length ? <div className="hr-management-assignment-actions">
              {scopeAssignments.map((assignment) => <div className="hr-management-assignment" key={assignment.id}><span>營運據點：{assignment.scopeName}</span><Button variant="secondary" onClick={() => endScopeAssignment(assignment, job)}>結束歸屬</Button></div>)}
              {locationAssignments.map((assignment) => <div className="hr-management-assignment" key={assignment.id}><span>辦公位置：{assignment.locationName}</span>{canOfficeWrite ? <Button variant="secondary" onClick={() => endLocationAssignment(assignment, job)}>結束指派</Button> : <span className="muted">請到出勤範圍管理處理</span>}</div>)}
            </div> : null}
          </div>
          <div className="hr-management-job-actions">
            {!job.revokedAt ? <>
              <Button variant="secondary" onClick={() => editEmploymentDates(job)}>編輯任職日期</Button>
              <Button variant="secondary" onClick={() => revokeEmployment(job)}>撤銷這段任職</Button>
            </> : <span className="status status-disabled">已撤銷</span>}
          </div>
        </div>;
      })}</div>}
    </div>
    {data.lastEmploymentAction ? <div className="hr-management-undo">
      <div><span className="eyebrow">最近異動</span><strong>{employmentActionLabel(data.lastEmploymentAction.actionKind)}</strong><span>{dateTime(data.lastEmploymentAction.createdAt)}</span></div>
      <Button variant="secondary" onClick={() => onUndo(data.lastEmploymentAction!.id)}>復原上一動</Button>
    </div> : null}
  </Dialog>;
}

export function HrEmployees() {
  usePageTitle("員工列表");
  const navigate = useNavigate();
  const toast = useToast();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", employmentStatus: "active" as "active" | "inactive", sortField: "employeeNumber", sortDirection: "asc" });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [manageEmployee, setManageEmployee] = useState<Employee | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean; counts: { active: number; inactive: number } }>(`/employees?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&employmentStatus=${filters.employmentStatus}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`, canRead);
  const candidates = useHrQuery<{ users: Candidate[] }>("/candidates", canWrite);
  const undo = useHrWrite();
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (employees.isPending) return <HrPageSkeleton variant="table" />;
  const data = employees.data;
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((candidate) => ({ id: candidate.userId, name: `${candidate.displayName}（${candidate.email}）` }));
  const undoEmployment = (operationId: string) => undo.mutate({ path: `/employment-actions/${operationId}/undo`, method: "POST", values: {} }, { onSuccess: () => { setManageEmployee(null); toast.show("已復原上一動。", "success"); void employees.refetch(); } });
  const showUndo = (message: string, operationId: string) => toast.show(message, "success", { label: "復原", onClick: () => undoEmployment(operationId) });
  return <div className="page fills">
    <PageHeader title="員工列表" description="搜尋、篩選與排序員工；任職異動直接在本頁處理，點選整列可查看完整人事脈絡。" actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => setEditor({ title: "指派新員工", path: "/employees", method: "POST", undoable: true, successMessage: "已指派新員工", description: "員工必須先存在於平台使用者名單；這會同時建立員工關聯與第一段任職。", fields: [{ key: "userId", label: "使用者", options: candidateOptions }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }] })}>指派新員工</Button> : null} />
    <Panel className="grows">
      <div className="hr-employment-tabs" role="tablist" aria-label="任職狀態">
        <button type="button" role="tab" aria-selected={filters.employmentStatus === "active"} className={filters.employmentStatus === "active" ? "active" : ""} onClick={() => update({ employmentStatus: "active" })}>在職 <span>{data?.counts.active ?? "—"}</span></button>
        <button type="button" role="tab" aria-selected={filters.employmentStatus === "inactive"} className={filters.employmentStatus === "inactive" ? "active" : ""} onClick={() => update({ employmentStatus: "inactive" })}>未在職 <span>{data?.counts.inactive ?? "—"}</span></button>
      </div>
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput label="搜尋" placeholder="搜尋員工編號、姓名或 Email" value={filters.search} onSearch={(search) => update({ search })} />
        <FilterSelect label="帳號狀態" value={filters.status} onChange={(event) => update({ status: event.target.value })} options={[{ value: "all", label: "全部帳號" }, { value: "active", label: "啟用中" }, { value: "invited", label: "待啟用" }, { value: "disabled", label: "已停用" }]} />
      </form>
      {employees.error ? <Alert tone="danger">{employees.error.message}</Alert> : null}
      {candidates.error ? <Alert tone="danger">{candidates.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr>
        <SortableHeader label="員工編號" field="employeeNumber" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="姓名" field="name" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="帳號" field="email" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <SortableHeader label="帳號狀態" field="status" active={filters.sortField} direction={filters.sortDirection as "asc" | "desc"} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
        <th>任職狀態</th>
        {canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data?.employees.map((employee) => <tr key={employee.userId} className="clickable-row" role="link" tabIndex={0} onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`); } }}><td data-label="員工編號"><span className="cell-strong">{employee.employeeNumber}</span></td><td data-label="姓名">{employee.displayName}</td><td data-label="帳號" className="cell-sub">{employee.email}</td><td data-label="帳號狀態"><span className={`status ${employee.userStatus === "active" ? "status-active" : employee.userStatus === "invited" ? "status-invited" : "status-disabled"}`}>{statusLabel(employee.userStatus)}</span></td><td data-label="任職狀態"><span className={`status ${employee.employmentStatus === "active" ? "status-active" : "status-invited"}`}>{employee.employmentStatus === "active" ? "在職" : "未在職"}</span></td>{canWrite ? <td data-label="操作"><Button variant="secondary" onClick={(event) => { event.stopPropagation(); setManageEmployee(employee); }}>管理任職</Button></td> : null}</tr>)}
      </tbody></table></div>
      {employees.isPlaceholderData ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.employees.length ? <p className="muted table-note">{data.total ? "沒有符合條件的員工，調整一下搜尋或篩選看看。" : filters.employmentStatus === "active" ? "目前沒有在職員工。" : "目前沒有未在職員工。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {manageEmployee ? <EmployeeManagementDialog employee={manageEmployee} onClose={() => setManageEmployee(null)} onEdit={(nextEditor) => { setManageEmployee(null); setEditor(nextEditor); }} onUndo={undoEmployment} canOfficeWrite={permissions.has("hr:office:write")} /> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); if (canWrite) void candidates.refetch(); }} onSuccess={(result) => { if (editor.undoable && result.operationId) showUndo(editor.successMessage ?? "任職異動已完成", result.operationId); else if (editor.successMessage) toast.show(editor.successMessage, "success"); }} /> : null}
  </div>;
}
