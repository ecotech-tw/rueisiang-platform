import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceAssignment, type Candidate, type CompensationVersion, type Employee, type Employment, type InsuranceVersion, type LeaveRequest, type NamedOption, type Profile } from "./api.js";
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
function todayInTaipei(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function isCurrentAttendanceAssignment(assignment: AttendanceAssignment, date: string): boolean {
  return assignment.validFrom <= date && (assignment.validTo === null || date < assignment.validTo);
}
function leaveDateTime(value: string, fallbackDate: string): string {
  return value ? dateTime(value) : `${fallbackDate} 00:00`;
}

function EditorDialog({ editor, onClose, onSuccess }: { editor: Editor; onClose: () => void; onSuccess?: (result: { id: string; operationId?: string }) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(editor.initial ?? {});
  const save = useHrWrite<{ id: string; operationId?: string }>();
  const closeRequestRef = useRef<(() => void) | null>(null);
  return <Dialog title={editor.title} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const payload = { ...values };
    for (const field of editor.fields) if (field.optional && !payload[field.key]) payload[field.key] = null;
    save.mutate({ path: editor.path, method: editor.method, values: payload }, { onSuccess: (result) => { onSuccess?.(result); (closeRequestRef.current ?? onClose)(); } });
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

function EmploymentHistoryTable({ employments }: { employments: Employment[] }) {
  return <table className="data-table"><thead><tr><th>員工編號</th><th>職位</th><th>主管</th><th>服務年資起算日</th><th>出勤方式</th><th>狀態</th></tr></thead>
    <tbody>{employments.map((job) => <tr key={job.id}><td>{job.employeeNumber}</td><td>{job.position}</td><td>{job.supervisorName ?? job.supervisorUserId ?? "未設定"}</td><td>{job.serviceStartOn ?? "未設定"}</td><td>{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</td><td>{job.archivedAt ? `未在職（${dateTime(job.archivedAt)}）` : "在職"}</td></tr>)}</tbody></table>;
}

function BasicSection({ profile }: { profile: Profile }) {
  const currentEmployment = profile.employments.find((job) => !job.archivedAt) ?? profile.employments[0];
  const isActive = Boolean(currentEmployment && !currentEmployment.archivedAt);
  return <>
    <div className="hr-profile-basic-grid">
      <p><span className="muted">正式姓名</span><strong>{profile.employee.legalName}</strong></p>
      <p><span className="muted">員工編號</span><strong>{currentEmployment?.employeeNumber ?? profile.employee.employeeNumber}</strong></p>
      <p><span className="muted">{isActive ? "目前職位" : "最後職位"}</span><strong>{currentEmployment?.position ?? profile.employee.position}</strong></p>
      <p><span className="muted">主管</span><strong>{currentEmployment?.supervisorName ?? currentEmployment?.supervisorUserId ?? profile.employee.supervisorName ?? "尚未設定"}</strong></p>
      {currentEmployment ? <>
        <p><span className="muted">服務年資起算日</span><strong>{currentEmployment.serviceStartOn ?? "未設定"}</strong></p>
        <p><span className="muted">{isActive ? "出勤方式" : "最後出勤方式"}</span><strong>{currentEmployment.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</strong></p>
        <p><span className="muted">員工狀態</span><strong>{currentEmployment.archivedAt ? `未在職（${dateTime(currentEmployment.archivedAt)}）` : "在職"}</strong></p>
      </> : null}
    </div>
    <p className="muted">Google 帳號名稱：{profile.employee.accountName}；帳號：{profile.employee.email}；登入狀態：{statusLabel(profile.employee.userStatus)}</p>
    <p className="muted">正式姓名、員工編號、職位與主管都是員工基本資料；員工不在職後仍保留資料，供薪資、出勤與稽核歷史追溯。</p>
    {currentEmployment ? null : <p>尚未建立員工資料。</p>}
    {profile.employments.length > 1 ? <>
      <h3>歷史資料</h3>
      <EmploymentHistoryTable employments={profile.employments} />
    </> : null}
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
      {rows.map((row) => <tr key={row.id}><td>{INSURANCE_LABEL[row.scheme]}</td><td>{row.voidedAt ? "已撤回" : INSURANCE_STATUS_LABEL[row.status]}</td><td>{row.validFrom}～{row.validTo ?? "目前"}</td><td className="numeric">{money(row.insuredAmountMinor)}</td><td>{row.scheme === "health" ? row.dependentCount : "—"}</td><td>{row.sourceKind === "official" ? `官方 ${row.rateYear}` : `人工 ${row.rateYear}`}</td></tr>)}
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
      {rows.map((row) => <tr key={row.id}><td>{row.leaveType}</td><td>{LEAVE_STATUS_LABEL[row.status]}</td><td>{leaveDateTime(row.startsAt, row.startsOn)}～{leaveDateTime(row.endsAt, row.endsOn)}</td><td>{Math.floor(row.durationMinutes / 60)} 小時 {row.durationMinutes % 60 ? `${row.durationMinutes % 60} 分` : ""}</td><td>{row.reason || "—"}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無請假紀錄。</p> : null}
  </>;
}

/** 員工內頁只呈現單一員工的完整脈絡；所有資料異動從各自的管理頁進入。 */
export function HrProfileDetails({ profile, collapsible = false }: { profile: Profile; collapsible?: boolean }) {
  const [open, setOpen] = useState("basic");
  const toggle = (name: string) => () => setOpen((current) => current === name ? "" : name);
  if (collapsible) return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.legalName}</h2>
    <Section title="基本資料" open={open === "basic"} onToggle={toggle("basic")}><BasicSection profile={profile} /></Section>
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
    <h2>{profile.employee.employeeNumber} · {profile.employee.legalName}</h2>
    <BasicSection profile={profile} />
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
  usePageTitle(detail.data ? `${detail.data.employee.employeeNumber} ${detail.data.employee.legalName}` : "員工內頁");
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (detail.isPending) return <HrPageSkeleton variant="detail" />;
  if (detail.error || !detail.data) return <div className="page"><Alert tone="danger">{detail.error?.message ?? "找不到員工資料。"}</Alert><Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回員工列表</Button></div>;
  const profile = detail.data;
  return <div className="page">
    <PageHeader title={`${profile.employee.employeeNumber} · ${profile.employee.legalName}`} description="員工內頁只供查看單一員工的完整人事脈絡；資料異動請從各 HRIS 管理頁進入。" actions={<Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回列表</Button>} />
    <Panel><HrProfileDetails profile={profile} collapsible /></Panel>
  </div>;
}

interface EmployeeBasicForm {
  legalName: string;
  employeeNumber: string;
  position: string;
  supervisorUserId: string;
  serviceStartOn: string;
}

function formValuesFor(profile: Profile): EmployeeBasicForm {
  const currentEmployment = profile.employments.find((job) => !job.archivedAt) ?? profile.employments[0];
  return {
    legalName: profile.employee.legalName,
    employeeNumber: profile.employee.employeeNumber,
    position: profile.employee.position,
    supervisorUserId: profile.employee.supervisorUserId ?? "",
    serviceStartOn: currentEmployment?.serviceStartOn ?? "",
  };
}

function EmployeeManagementDialog({ employee, onClose, onEdit, onSaved, onArchived }: { employee: Employee; onClose: () => void; onEdit: (editor: Editor) => void; onSaved: () => void; onArchived: () => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`, true, { keepPreviousData: false });
  const supervisorCandidates = useHrQuery<{ users: NamedOption[] }>(`/supervisor-candidates?exclude=${encodeURIComponent(employee.userId)}`, true, { keepPreviousData: false });
  const [archiveTarget, setArchiveTarget] = useState<Employment | null>(null);
  const [values, setValues] = useState<EmployeeBasicForm>({ legalName: employee.legalName, employeeNumber: employee.employeeNumber, position: employee.position, supervisorUserId: employee.supervisorUserId ?? "", serviceStartOn: "" });
  const saveMutation = useHrWrite();
  const archiveMutation = useHrWrite();
  const closeRequestRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const archiveCloseRequestRef = useRef<((afterClose?: () => void) => void) | null>(null);
  useEffect(() => {
    if (profile.data) setValues(formValuesFor(profile.data));
  }, [profile.data?.employee.revision, profile.data?.employee.userId]);
  if (profile.isPending) return <Dialog title="員工資料" titleMeta={`${employee.employeeNumber}／${employee.legalName}`} onClose={onClose}><p className="muted">載入員工資料…</p></Dialog>;
  if (profile.error || !profile.data) return <Dialog title="員工資料" titleMeta={`${employee.employeeNumber}／${employee.legalName}`} onClose={onClose}><Alert tone="danger">{profile.error?.message ?? "員工資料載入失敗。"}</Alert></Dialog>;
  const data = profile.data;
  const activeEmployment = data.employments.find((job) => !job.archivedAt);
  const savedValues = formValuesFor(data);
  const isDirty = Boolean(activeEmployment && (values.legalName !== savedValues.legalName || values.employeeNumber !== savedValues.employeeNumber || values.position !== savedValues.position || values.supervisorUserId !== savedValues.supervisorUserId || values.serviceStartOn !== savedValues.serviceStartOn));
  const supervisorOptions = supervisorCandidates.data?.users ?? [];
  const currentSupervisor = data.employee.supervisorUserId && !supervisorOptions.some((option) => option.id === data.employee.supervisorUserId)
    ? [{ id: data.employee.supervisorUserId, name: data.employee.supervisorName ?? "目前主管" }]
    : [];
  const currentDate = todayInTaipei();
  const locationAssignments = (data.attendanceAssignments ?? []).filter((assignment) => activeEmployment ? assignment.employmentId === activeEmployment.id && isCurrentAttendanceAssignment(assignment, currentDate) : true);
  const openEditor = (editor: Editor) => {
    if (closeRequestRef.current) closeRequestRef.current(() => onEdit(editor));
    else { onClose(); onEdit(editor); }
  };
  const saveEmployee = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeEmployment) return;
    const supervisorChanged = values.supervisorUserId !== (data.employee.supervisorUserId ?? "");
    saveMutation.mutate({
      path: `/employees/${data.employee.userId}`,
      method: "PATCH",
      values: { legalName: values.legalName, employeeNumber: values.employeeNumber, position: values.position, ...(supervisorChanged ? { supervisorUserId: values.supervisorUserId || null } : {}), ...(values.serviceStartOn ? { serviceStartOn: values.serviceStartOn } : {}), revision: activeEmployment.revision },
    }, { onSuccess: onSaved });
  };
  const requestArchive = (job: Employment) => { archiveMutation.reset(); setArchiveTarget(job); };
  const confirmArchive = () => {
    if (!archiveTarget) return;
    archiveMutation.mutate({ path: `/employments/${archiveTarget.id}/archive`, method: "POST", values: { revision: archiveTarget.revision } }, { onSuccess: () => {
      if (archiveCloseRequestRef.current) archiveCloseRequestRef.current(onArchived);
      else { setArchiveTarget(null); onArchived(); }
    } });
  };
  const reactivateEmployee = () => openEditor({
    title: "恢復在職", path: "/employees", method: "POST", successMessage: `已恢復 ${data.employee.legalName} 的在職狀態`,
    initial: { userId: data.employee.userId, legalName: data.employee.legalName, employeeNumber: data.employee.employeeNumber, position: data.employee.position, attendanceMode: data.employments.find((job) => job.archivedAt)?.attendanceMode ?? "general", revision: data.employee.revision },
    description: "沿用原本的員工資料、出勤方式與服務年資起算日；恢復在職後，辦公位置仍請到出勤範圍管理確認。",
    fields: [{ key: "legalName", label: "正式姓名（身分證）", maxLength: 100 }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "position", label: "職位", maxLength: 100 }],
  });
  return <>
  <Dialog title="員工資料" titleMeta={`${data.employee.employeeNumber}／${data.employee.legalName}`} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={saveMutation.isPending} className="hr-employee-management-dialog" formProps={activeEmployment ? { onSubmit: saveEmployee } : undefined} actions={<>
    {activeEmployment ? <Button variant="danger" icon="archive" className="delete-action" disabled={saveMutation.isPending} onClick={() => requestArchive(activeEmployment)}>設為未在職</Button> : <Button icon="plus" onClick={reactivateEmployee}>恢復在職</Button>}
    {activeEmployment ? <Button type="submit" loading={saveMutation.isPending}>儲存員工資料</Button> : null}
  </>}>
    <div className="hr-management-identity">
      <div><strong>{data.employee.legalName}</strong><span>{data.employee.email}</span></div>
      <span className={`status ${data.employee.employmentStatus === "active" ? "status-active" : "status-invited"}`}>{data.employee.employmentStatus === "active" ? "在職" : "未在職"}</span>
    </div>
    <p className="hr-management-description">這裡只維護員工基本資料：正式姓名、員工編號、職位、主管與服務年資起算日。辦公位置只顯示目前狀態，異動請到出勤範圍管理處理。</p>
    {activeEmployment ? <div className="field-grid hr-management-form-grid">
      <TextField label="正式姓名（身分證）" value={values.legalName} maxLength={100} required onChange={(event) => setValues({ ...values, legalName: event.target.value })} />
      <TextField label="員工編號" value={values.employeeNumber} maxLength={40} required onChange={(event) => setValues({ ...values, employeeNumber: event.target.value })} />
      <TextField label="職位" value={values.position} maxLength={100} required onChange={(event) => setValues({ ...values, position: event.target.value })} />
      <SelectField label="主管" value={values.supervisorUserId} options={[{ value: "", label: "未指定" }, ...currentSupervisor.map((option) => ({ value: option.id, label: option.name })), ...supervisorOptions.map((option) => ({ value: option.id, label: option.name }))]} disabled={supervisorCandidates.isPending} onChange={(event) => setValues({ ...values, supervisorUserId: event.target.value })} />
      <TextField label="服務年資起算日" type="date" value={values.serviceStartOn} hint="影響薪資試算與週年制特休的起算日。" onChange={(event) => setValues({ ...values, serviceStartOn: event.target.value })} />
      <div className="hr-management-readonly-field"><span>出勤方式</span><strong>{activeEmployment.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</strong><small>請到出勤範圍管理調整。</small></div>
    </div> : <div className="hr-management-archived-state"><strong>目前未在職</strong><p>員工資料與歷史紀錄仍保留；恢復在職後可繼續沿用這筆資料。</p></div>}
    {supervisorCandidates.error ? <Alert tone="danger">主管清單載入失敗，請重新整理後再試。</Alert> : null}
    {saveMutation.error ? <Alert tone="danger">{saveMutation.error.message}</Alert> : null}
    <div className="hr-management-group">
      <div className="hr-management-group-heading"><h3>辦公位置</h3><span className="status status-invited">唯讀</span></div>
      {locationAssignments.length ? <div className="hr-management-readonly-list">{locationAssignments.map((assignment) => <div className="hr-management-readonly-row" key={assignment.id}><strong>{assignment.locationName}</strong><span>{assignment.validFrom}～{assignment.validTo ?? "目前"}</span></div>)}</div> : <p className="muted">尚未指派辦公位置。</p>}
      <p className="muted">辦公位置由「出勤／出勤範圍管理」維護，本頁不提供結束或移除操作。</p>
    </div>
  </Dialog>
  {archiveTarget ? <ConfirmDialog title="將員工設為未在職？" confirmLabel="設為未在職" pending={archiveMutation.isPending} closeRequestRef={archiveCloseRequestRef} onCancel={() => { if (!archiveMutation.isPending) setArchiveTarget(null); }} onConfirm={confirmArchive}>
    <p>這會將 <strong>{data.employee.legalName}</strong> 從「在職」名單移到「未在職」，但不會刪除員工資料。</p>
    {isDirty ? <p><strong>目前有尚未儲存的員工資料變更；設為未在職不會一併儲存。</strong></p> : null}
    <p className="muted">薪資、出勤、保險、請假、排班與其他下游歷史都會保留；之後可以從未在職名單恢復。</p>
    {archiveMutation.error ? <Alert tone="danger">{archiveMutation.error.message}</Alert> : null}
  </ConfirmDialog> : null}
  </>;
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
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (employees.isPending) return <HrPageSkeleton variant="table" />;
  const data = employees.data;
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((candidate) => ({ id: candidate.userId, name: `${candidate.displayName}（${candidate.email}）` }));
  return <div className="page fills">
    <PageHeader title="員工列表" description="搜尋、篩選與排序員工；員工資料包含正式姓名、員工編號、職位、主管與服務年資起算日，辦公位置請到出勤範圍管理維護。" actions={canWrite ? <Button icon="plus" className="add-action" onClick={() => setEditor({ title: "指派新員工", path: "/employees", method: "POST", successMessage: "已指派新員工", description: "員工必須先存在於平台使用者名單；正式姓名請依身分證件填寫，服務年資起算日會決定薪資計算在職日的下限。出勤方式與辦公位置由出勤範圍管理維護。", fields: [{ key: "userId", label: "使用者", options: candidateOptions }, { key: "legalName", label: "正式姓名（身分證）", maxLength: 100 }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "position", label: "職位", maxLength: 100 }, { key: "serviceStartOn", label: "服務年資起算日", type: "date" }] })}>新增員工</Button> : null} />
    <Panel className="grows">
      <div className="hr-employee-status-tabs" role="tablist" aria-label="員工狀態">
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
        <th>職位</th><th>主管</th><th>員工狀態</th>
        {canWrite ? <th>操作</th> : null}
      </tr></thead><tbody>
        {data?.employees.map((employee) => <tr key={employee.userId} className="clickable-row" role="link" tabIndex={0} onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`); } }}><td data-label="員工編號"><span className="cell-strong">{employee.employeeNumber}</span></td><td data-label="姓名">{employee.legalName}</td><td data-label="帳號" className="cell-sub">{employee.email}</td><td data-label="帳號狀態"><span className={`status ${employee.userStatus === "active" ? "status-active" : employee.userStatus === "invited" ? "status-invited" : "status-disabled"}`}>{statusLabel(employee.userStatus)}</span></td><td data-label="職位">{employee.position}</td><td data-label="主管">{employee.supervisorName ?? employee.supervisorUserId ?? "未設定"}</td><td data-label="員工狀態"><span className={`status ${employee.employmentStatus === "active" ? "status-active" : "status-invited"}`}>{employee.employmentStatus === "active" ? "在職" : "未在職"}</span></td>{canWrite ? <td data-label="操作"><Button variant="secondary" icon="edit" onClick={(event) => { event.stopPropagation(); setManageEmployee(employee); }}>員工資料</Button></td> : null}</tr>)}
      </tbody></table></div>
      {employees.isPlaceholderData ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.employees.length ? <p className="muted table-note">{data.total ? "沒有符合條件的員工，調整一下搜尋或篩選看看。" : filters.employmentStatus === "active" ? "目前沒有在職員工。" : "目前沒有未在職員工。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {manageEmployee ? <EmployeeManagementDialog employee={manageEmployee} onClose={() => setManageEmployee(null)} onEdit={(nextEditor) => { setManageEmployee(null); setEditor(nextEditor); }} onSaved={() => { toast.show("員工資料已更新。", "success"); void employees.refetch(); }} onArchived={() => { setManageEmployee(null); toast.show("員工已設為未在職。", "success"); void employees.refetch(); }} /> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); if (canWrite) void candidates.refetch(); }} onSuccess={() => { if (editor.successMessage) toast.show(editor.successMessage, "success"); }} /> : null}
  </div>;
}
