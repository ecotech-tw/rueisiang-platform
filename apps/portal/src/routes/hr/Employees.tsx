import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, FilterSelect, PageHeader, Panel, SearchFilterInput, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceAssignment, type AttendanceLocation, type Candidate, type CompensationVersion, type Employee, type Employment, type InsuranceBracketTable, type InsuranceVersion, type LeaveRequest, type NamedOption, type Profile } from "./api.js";

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
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
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

function CompensationTable({ rows }: { rows: CompensationVersion[] }) {
  return <>
    <h3>職務／薪資歷史</h3>
    <table className="data-table"><thead><tr><th>生效期間</th><th>計算方式</th><th className="numeric">金額</th><th>備註</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{row.validFrom}～{row.validTo ?? "目前"}</td><td>{PAY_BASIS_LABEL[row.payBasis]}</td><td className="numeric">{money(row.baseAmountMinor)}</td><td>{row.note || "—"}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無薪資版本資料。</p> : null}
  </>;
}

function AssignmentTable({ assignments, onSetPrimary }: { assignments: AttendanceAssignment[]; onSetPrimary?: (id: string) => void }) {
  return <>
    <h3>辦公位置指派</h3>
    <table className="data-table"><thead><tr><th>辦公位置</th><th>主要位置</th><th>起日</th><th>迄日（不含）</th><th>設定</th></tr></thead><tbody>
      {assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.locationName}</td><td>{assignment.isPrimary ? "主要" : "其他"}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td><td>{onSetPrimary && !assignment.isPrimary && !assignment.validTo ? <Button variant="secondary" onClick={() => onSetPrimary(assignment.id)}>設為主要</Button> : null}</td></tr>)}
    </tbody></table>
    {!assignments.length ? <p>尚未指派辦公位置。</p> : null}
  </>;
}

function AttendanceSection({ profile, onSetPrimary }: { profile: Profile; onSetPrimary?: (id: string) => void }) {
  return <>
    <AssignmentTable assignments={profile.attendanceAssignments ?? []} onSetPrimary={onSetPrimary} />
    <h3>打卡紀錄</h3>
    <table className="data-table"><thead><tr><th>時間</th><th>事件</th><th>辦公位置</th><th className="numeric">距離（公尺）</th></tr></thead><tbody>
      {(profile.attendanceEvents ?? []).map((event) => <tr key={event.id}><td>{dateTime(event.occurredAt)}</td><td>{event.eventKind === "clock_in" ? "上班" : "下班"}</td><td>{event.locationName ?? "—"}</td><td className="numeric">{event.distanceMeters ?? "—"}</td></tr>)}
    </tbody></table>
    {profile.attendanceEvents && !profile.attendanceEvents.length ? <p>尚無打卡紀錄。</p> : null}
    {profile.attendanceEvents === undefined ? <p className="muted">打卡明細僅限全平台 HR 管理者查看。</p> : null}
  </>;
}

function InsuranceTable({ rows }: { rows: InsuranceVersion[] }) {
  return <>
    <h3>勞健保加退保與異動歷史</h3>
    <table className="data-table"><thead><tr><th>種類</th><th>狀態</th><th>生效期間</th><th className="numeric">投保金額</th><th>眷屬</th><th>級距來源</th></tr></thead><tbody>
      {rows.map((row) => <tr key={row.id}><td>{INSURANCE_LABEL[row.scheme]}</td><td>{INSURANCE_STATUS_LABEL[row.status]}</td><td>{row.validFrom}～{row.validTo ?? "目前"}</td><td className="numeric">{money(row.insuredAmountMinor)}</td><td>{row.scheme === "health" ? row.dependentCount : "—"}</td><td>{row.sourceKind === "official" ? `官方 ${row.rateYear}` : `人工 ${row.rateYear}`}</td></tr>)}
    </tbody></table>
    {!rows.length ? <p>尚無勞健保資料。</p> : null}
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

/** 舊的純呈現測試與其他 consumer 使用非互斥模式；管理內頁傳 collapsible 才啟用單區展開。 */
export function HrProfileDetails({ profile, collapsible = false, onSetPrimary }: { profile: Profile; collapsible?: boolean; onSetPrimary?: (id: string) => void }) {
  const [open, setOpen] = useState("basic");
  const toggle = (name: string) => () => setOpen((current) => current === name ? "" : name);
  if (collapsible) return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <Section title="基本資料" open={open === "basic"} onToggle={toggle("basic")}><BasicSection profile={profile} /></Section>
    <Section title="職務／薪資／勞健保" open={open === "job"} onToggle={toggle("job")}><EmploymentTable employments={profile.employments} />{profile.compensation ? <CompensationTable rows={profile.compensation} /> : null}{profile.insurance ? <InsuranceTable rows={profile.insurance} /> : null}</Section>
    <Section title="打卡／出勤" open={open === "attendance"} onToggle={toggle("attendance")}><AttendanceSection profile={profile} onSetPrimary={onSetPrimary} /></Section>
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
    <AssignmentTable assignments={profile.attendanceAssignments ?? []} onSetPrimary={onSetPrimary} />
    {profile.compensation ? <CompensationTable rows={profile.compensation} /> : null}
    {profile.insurance ? <InsuranceTable rows={profile.insurance} /> : null}
    {profile.leave ? <LeaveTable rows={profile.leave} /> : null}
    {profile.attendanceEvents ? <>
      <h3>打卡紀錄</h3>
      <table className="data-table"><thead><tr><th>時間</th><th>事件</th><th>辦公位置</th><th className="numeric">距離（公尺）</th></tr></thead><tbody>
        {profile.attendanceEvents.map((event) => <tr key={event.id}><td>{dateTime(event.occurredAt)}</td><td>{event.eventKind === "clock_in" ? "上班" : "下班"}</td><td>{event.locationName ?? "—"}</td><td className="numeric">{event.distanceMeters ?? "—"}</td></tr>)}
      </tbody></table>
      {!profile.attendanceEvents.length ? <p>尚無打卡紀錄。</p> : null}
    </> : null}
  </>;
}

function CompensationDialog({ employment, onClose }: { employment: Employment; onClose: () => void }) {
  const [values, setValues] = useState({ validFrom: employment.hiredOn, validTo: "", payBasis: "monthly", amount: "", note: "" });
  const [message, setMessage] = useState("");
  const save = useHrWrite();
  return <Dialog title="新增薪資版本" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const amount = Number(values.amount);
    if (!Number.isSafeInteger(amount) || amount < 0) { setMessage("請輸入有效的整數金額。"); return; }
    setMessage("");
    save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: { validFrom: values.validFrom, validTo: values.validTo || null, payBasis: values.payBasis, baseAmountMinor: amount * 100, note: values.note } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存</Button>}>
    <p>薪資版本只能新增，期間不可與既有版本重疊。</p>
    <TextField label="生效日" type="date" value={values.validFrom} required onChange={(event) => setValues({ ...values, validFrom: event.target.value })} />
    <TextField label="迄日（不含，可留空）" type="date" value={values.validTo} onChange={(event) => setValues({ ...values, validTo: event.target.value })} />
    <SelectField label="計算方式" value={values.payBasis} options={[{ value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }]} onChange={(event) => setValues({ ...values, payBasis: event.target.value })} />
    <TextField label="金額（元）" type="number" min="0" step="1" value={values.amount} required onChange={(event) => setValues({ ...values, amount: event.target.value })} />
    <TextField label="備註" value={values.note} maxLength={1000} onChange={(event) => setValues({ ...values, note: event.target.value })} />
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

function InsuranceDialog({ employment, scheme, defaultSalary, onClose }: { employment: Employment; scheme: "labor" | "health"; defaultSalary?: number; onClose: () => void }) {
  const defaultYear = new Date().getFullYear();
  const [year, setYear] = useState(String(defaultYear));
  const [status, setStatus] = useState<"enrolled" | "withdrawn">("enrolled");
  const [validFrom, setValidFrom] = useState(employment.hiredOn);
  const [validTo, setValidTo] = useState("");
  const [salary, setSalary] = useState(defaultSalary ? String(defaultSalary) : "");
  const [manual, setManual] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [level, setLevel] = useState("");
  const [dependents, setDependents] = useState("0");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const table = useHrQuery<{ tables: InsuranceBracketTable[] }>(`/insurance-brackets?year=${encodeURIComponent(year)}`, true);
  const save = useHrWrite();
  const selectedTable = table.data?.tables.find((item) => item.scheme === scheme);
  const selected = selectedTable?.brackets.find((bracket) => bracket.level === Number(level)) ?? selectedTable?.brackets.find((bracket) => {
    const value = Number(salary);
    return Number.isSafeInteger(value) && value >= bracket.lowerSalary && (bracket.upperSalary === null || value <= bracket.upperSalary);
  });
  useEffect(() => {
    if (!manual && selected) setLevel(String(selected.level));
  }, [manual, selected]);
  const sourceUrl = selectedTable?.sourceUrl ?? "";
  const amount = status === "withdrawn" ? 0 : manual ? Number(manualAmount) : (selected?.insuredAmount ?? 0);
  return <Dialog title={`${INSURANCE_LABEL[scheme]}加退保`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (status === "enrolled" && (!Number.isSafeInteger(amount) || amount <= 0)) { setMessage(manual ? "請輸入人工覆寫的投保金額。" : "請輸入實際薪資並選擇官方級距。"); return; }
    const rateYear = Number(year);
    if (!Number.isSafeInteger(rateYear) || rateYear < 1900 || rateYear > 9999) { setMessage("年度不正確。"); return; }
    setMessage("");
    save.mutate({ path: `/employments/${employment.id}/insurance`, method: "POST", values: {
      scheme, status, validFrom, validTo: validTo || null, insuredAmountMinor: amount * 100,
      dependentCount: scheme === "health" ? Number(dependents) : 0, rateYear, sourceKind: manual ? "manual" : "official", sourceUrl, note,
    } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存</Button>}>
    <p>官方級距由勞動部／健保署開放資料即時取得；法定資料無法取得時不自行推測。</p>
    <SelectField label="狀態" value={status} options={[{ value: "enrolled", label: "加保／變更級距" }, { value: "withdrawn", label: "退保" }]} onChange={(event) => setStatus(event.target.value as "enrolled" | "withdrawn")} />
    <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <TextField label="級距年度" type="number" min="1900" max="9999" value={year} required onChange={(event) => setYear(event.target.value)} />
    {status === "enrolled" ? <>
      <TextField label="實際月薪（元）" type="number" min="0" step="1" value={salary} required={!manual} onChange={(event) => setSalary(event.target.value)} hint="系統會依官方實際薪資範圍帶入投保金額。" />
      <SelectField label="官方投保級距" value={String(selected?.level ?? "")} disabled={manual || !selectedTable} options={[{ value: "", label: selectedTable ? "請先輸入月薪" : "官方資料載入中" }, ...(selectedTable?.brackets ?? []).map((bracket) => ({ value: String(bracket.level), label: `第 ${bracket.level} 級／NT$ ${bracket.insuredAmount.toLocaleString("zh-TW")}` }))]} onChange={(event) => setLevel(event.target.value)} />
      <Field label="人工覆寫" hint="人工覆寫會在歷史紀錄標示來源，請確認主管機關資料後再使用。"><span className="checkbox-field"><input type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} />改用人工投保金額</span></Field>
      {manual ? <TextField label="人工投保金額（元）" type="number" min="0" step="1" value={manualAmount} required onChange={(event) => setManualAmount(event.target.value)} /> : null}
      {scheme === "health" ? <TextField label="眷屬人數（0～3）" type="number" min="0" max="3" step="1" value={dependents} onChange={(event) => setDependents(event.target.value)} /> : null}
      <p className="muted">本次投保金額：{amount > 0 ? `NT$ ${amount.toLocaleString("zh-TW")}` : "尚未決定"}{selectedTable ? `；來源：官方資料（${selectedTable.fetchedAt}）` : ""}</p>
    </> : null}
    <TextField label="備註" value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
    {table.error ? <Alert tone="danger">{table.error.message}；仍可勾選人工覆寫並填入金額。</Alert> : null}
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrEmployeeDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { permissions, user } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const canGlobalWrite = canWrite && Boolean(user?.roles.includes("admin"));
  const canOfficeWrite = permissions.has("hr:office:read") && permissions.has("hr:office:write");
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(id)}`, canRead && Boolean(id));
  const supervisors = useHrQuery<{ users: NamedOption[] }>(`/supervisor-candidates?exclude=${encodeURIComponent(id)}`, canWrite && Boolean(id));
  const officeLocations = useHrQuery<{ locations: AttendanceLocation[] }>("/attendance-settings/locations", canOfficeWrite);
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes", canRead);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [compensationEmployment, setCompensationEmployment] = useState<Employment | null>(null);
  const [insuranceEditor, setInsuranceEditor] = useState<{ employment: Employment; scheme: "labor" | "health" } | null>(null);
  const primary = useHrWrite();
  usePageTitle(detail.data ? `${detail.data.employee.employeeNumber} ${detail.data.employee.displayName}` : "員工內頁");
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  if (detail.isPending) return <div className="page"><p>載入員工資料…</p></div>;
  if (detail.error || !detail.data) return <div className="page"><Alert tone="danger">{detail.error?.message ?? "找不到員工資料。"}</Alert><Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回員工列表</Button></div>;
  const profile = detail.data;
  const activeEmployment = profile.employments.find((job) => !job.endedOn);
  const defaultSalary = activeEmployment ? profile.compensation?.find((row) => row.employmentId === activeEmployment.id && !row.validTo)?.baseAmountMinor : undefined;
  const refresh = () => { void detail.refetch(); void officeLocations.refetch(); void scopes.refetch(); };
  return <div className="page">
    <PageHeader title={`${profile.employee.employeeNumber} · ${profile.employee.displayName}`} description="員工、任職、薪資、勞健保、出勤與假勤集中在同一個內頁；分區一次只展開一區。" actions={<Button variant="secondary" onClick={() => navigate("/hr/employees")}>返回列表</Button>} />
    <Panel>
      <HrProfileDetails profile={profile} collapsible onSetPrimary={(assignmentId) => primary.mutate({ path: `/attendance-location-assignments/${assignmentId}/primary`, method: "POST", values: {} }, { onSuccess: refresh })} />
      {primary.error ? <Alert tone="danger">{primary.error.message}</Alert> : null}
    </Panel>
    {canWrite ? <Panel>
      <h2>資料管理</h2>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setEditor({ title: "編輯員工編號", path: `/employees/${profile.employee.userId}`, method: "PATCH", fields: [{ key: "employeeNumber", label: "員工編號", maxLength: 40 }], initial: { employeeNumber: profile.employee.employeeNumber, revision: profile.employee.revision } })}>編輯員工編號</Button>
        <Button variant="secondary" disabled={!supervisors.data?.users.length} onClick={() => setEditor({ title: "設定員工主管", path: `/employees/${profile.employee.userId}/supervisor`, method: "PATCH", description: "申請單預設會送給這位主管審核。", fields: [{ key: "supervisorUserId", label: "主管", options: supervisors.data?.users ?? [], optional: true }], initial: { supervisorUserId: profile.employee.supervisorUserId ?? "", revision: profile.employee.revision } })}>設定主管</Button>
        <Button disabled={!activeEmployment || !scopes.data?.scopes.length} onClick={() => setEditor({ title: "新增櫃點歸屬", path: "/assignments", method: "POST", initial: { employmentId: activeEmployment?.id, validFrom: activeEmployment?.hiredOn }, description: "營運櫃點歸屬期間需在任職期間內；這不會授予平台管理權限。", fields: [{ key: "scopeId", label: "櫃點", options: scopes.data?.scopes ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增櫃點歸屬</Button>
        {canOfficeWrite ? <Button disabled={!activeEmployment || !officeLocations.data?.locations.length} onClick={() => setEditor({ title: "新增辦公位置指派", path: `/employments/${activeEmployment?.id}/attendance-location`, method: "POST", initial: { validFrom: activeEmployment?.hiredOn }, description: "同一段任職可同時指派多個辦公位置，但必須維持一個主要位置。", fields: [{ key: "locationId", label: "辦公位置", options: officeLocations.data?.locations.map((location) => ({ id: location.id, name: location.name })) ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增辦公位置指派</Button> : null}
      </div>
      {profile.employments.map((job) => <div key={job.id} className="mt-4 hr-job-actions">
        <h3>任職：{job.hiredOn}{job.endedOn ? `～${job.endedOn}` : "～目前"}</h3>
        <p className="muted">出勤方式：{job.attendanceMode === "scheduled" ? "排班" : "一般辦公"}</p>
        <div className="flex flex-wrap gap-3">
          {canGlobalWrite ? <Button variant="secondary" onClick={() => setCompensationEmployment(job)}>新增薪資版本</Button> : null}
          {canGlobalWrite ? <><Button variant="secondary" onClick={() => setInsuranceEditor({ employment: job, scheme: "labor" })}>管理勞保</Button><Button variant="secondary" onClick={() => setInsuranceEditor({ employment: job, scheme: "health" })}>管理健保</Button></> : null}
          {canOfficeWrite ? <Button variant="secondary" onClick={() => setEditor({ title: "設定出勤方式", path: `/employments/${job.id}/attendance-mode`, method: "PATCH", fields: [{ key: "attendanceMode", label: "出勤方式", options: [{ id: "general", name: "一般辦公" }, { id: "scheduled", name: "排班" }] }], initial: { attendanceMode: job.attendanceMode ?? "general", revision: job.revision } })}>設定出勤方式</Button> : null}
          {!job.endedOn ? <Button variant="secondary" onClick={() => setEditor({ title: "結束任職", path: `/employments/${job.id}/end`, method: "PATCH", initial: { revision: job.revision }, description: "請先結束所有超過離職日期的櫃點與辦公位置指派。", fields: [{ key: "endedOn", label: "不再任職首日", type: "date" }] })}>結束任職</Button> : null}
          {profile.assignments.filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => setEditor({ title: `結束 ${assignment.scopeName} 歸屬`, path: `/assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.scopeName} 歸屬</Button>)}
          {canOfficeWrite ? (profile.attendanceAssignments ?? []).filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => setEditor({ title: `結束 ${assignment.locationName} 指派`, path: `/attendance-location-assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.locationName} 指派</Button> ) : null}
        </div>
      </div>)}
      {canGlobalWrite ? <Button className="mt-4" onClick={() => setEditor({ title: "新增任職／復職紀錄", path: "/employments", method: "POST", initial: { userId: profile.employee.userId }, description: "同一使用者的任職期間不可重疊；復職新增紀錄，不修改舊任職。", fields: [{ key: "userId", label: "使用者", options: [{ id: profile.employee.userId, name: `${profile.employee.displayName}（${profile.employee.email}）` }] }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "endedOn", label: "不再任職首日（可留空）", type: "date", optional: true }, { key: "attendanceMode", label: "出勤方式", options: [{ id: "general", name: "一般辦公" }, { id: "scheduled", name: "排班" }] }] })}>新增任職／復職</Button> : null}
    </Panel> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); refresh(); }} /> : null}
    {compensationEmployment ? <CompensationDialog employment={compensationEmployment} onClose={() => { setCompensationEmployment(null); refresh(); }} /> : null}
    {insuranceEditor ? <InsuranceDialog employment={insuranceEditor.employment} scheme={insuranceEditor.scheme} defaultSalary={defaultSalary ? defaultSalary / 100 : undefined} onClose={() => { setInsuranceEditor(null); refresh(); }} /> : null}
  </div>;
}

export function HrEmployees() {
  usePageTitle("員工列表");
  const navigate = useNavigate();
  const { permissions, user } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const canGlobalWrite = canWrite && Boolean(user?.roles.includes("admin"));
  const [filters, setFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", sortField: "employeeNumber", sortDirection: "asc" });
  const [editor, setEditor] = useState<Editor | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean }>(`/employees?page=${filters.page}&pageSize=${filters.pageSize}&search=${encodeURIComponent(filters.search)}&status=${filters.status}&sortField=${filters.sortField}&sortDirection=${filters.sortDirection}`, canRead);
  const candidates = useHrQuery<{ users: Candidate[] }>("/candidates", canGlobalWrite);
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  const data = employees.data;
  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((candidate) => ({ id: candidate.userId, name: `${candidate.displayName}（${candidate.email}）` }));
  const statusOptions = [{ value: "all", label: "全部狀態" }, { value: "active", label: "啟用中" }, { value: "invited", label: "待啟用" }, { value: "disabled", label: "已停用" }];
  return <div className="page fills">
    <PageHeader title="員工列表" description="搜尋、篩選與排序員工；點選整列進入員工內頁。" actions={canGlobalWrite ? <Button icon="plus" className="add-action" onClick={() => setEditor({ title: "指派員工", path: "/employees", method: "POST", description: "員工必須先存在於平台使用者名單。", fields: [{ key: "userId", label: "使用者", options: candidateOptions }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "attendanceMode", label: "出勤方式", options: [{ id: "general", name: "一般辦公" }, { id: "scheduled", name: "排班" }] }] })}>指派員工</Button> : null} />
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
      </tr></thead><tbody>
        {data?.employees.map((employee) => <tr key={employee.userId} className="clickable-row" role="link" tabIndex={0} onClick={() => navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(`/hr/employees/${encodeURIComponent(employee.userId)}`); } }}><td data-label="員工編號"><span className="cell-strong">{employee.employeeNumber}</span></td><td data-label="姓名">{employee.displayName}</td><td data-label="帳號" className="cell-sub">{employee.email}</td><td data-label="狀態">{statusLabel(employee.userStatus)}</td></tr>)}
      </tbody></table></div>
      {employees.isPending ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.employees.length ? <p className="muted table-note">{data.total ? "沒有符合條件的員工，調整一下搜尋或篩選看看。" : "尚無員工資料，請先邀請使用者，再指派員工。"}</p> : null}
      {data && data.total > 0 ? <Pager page={data.page} pageSize={data.pageSize} pageSizes={PAGE_SIZES} totalPages={totalPages} totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => update({ page })} onPageSize={(pageSize) => update({ pageSize })} /> : null}
    </Panel>
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); void candidates.refetch(); }} /> : null}
  </div>;
}
