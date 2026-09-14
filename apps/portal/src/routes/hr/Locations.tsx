import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceAssignment, type AttendanceLocation, type Employee, type Employment, type Profile } from "./api.js";

interface EmployeeListResponse { employees: Employee[] }
type LocationEdit = { kind: "assignment" | "attendance-mode" | "end"; profile: Profile; assignment?: AttendanceAssignment };

function today(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function currentEmployment(employments: Employment[]): Employment | undefined {
  const date = today();
  return employments.find((employment) => employment.hiredOn <= date && (employment.endedOn === null || date < employment.endedOn)) ?? employments[0];
}

function LocationAssignmentDialog({ profile, locations, onClose }: { profile: Profile; locations: AttendanceLocation[]; onClose: () => void }) {
  const initialEmployment = currentEmployment(profile.employments);
  const [employmentId, setEmploymentId] = useState(initialEmployment?.id ?? "");
  const [locationId, setLocationId] = useState("");
  const [validFrom, setValidFrom] = useState(initialEmployment?.hiredOn ?? today());
  const [validTo, setValidTo] = useState("");
  const [message, setMessage] = useState("");
  const save = useHrWrite();
  const employment = profile.employments.find((item) => item.id === employmentId);
  return <Dialog title={`新增 ${profile.employee.displayName} 的辦公位置指派`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!employmentId || !locationId) { setMessage("請選擇任職與辦公位置。"); return; }
    if (employment && (validFrom < employment.hiredOn || (employment.endedOn !== null && (validTo === "" || validTo > employment.endedOn)))) { setMessage("指派期間必須落在任職期間內。"); return; }
    setMessage("");
    save.mutate({ path: `/employments/${employmentId}/attendance-location`, method: "POST", values: { locationId, validFrom, validTo: validTo || null } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存指派</Button>}>
    <p>辦公位置指派保存生效期間；歷史打卡、排班與薪資不會被後續異動覆寫。</p>
    <SelectField label="任職" value={employmentId} required options={profile.employments.map((item) => ({ value: item.id, label: `${item.hiredOn}～${item.endedOn ?? "目前"}` }))} onChange={(event) => { const selected = profile.employments.find((item) => item.id === event.target.value); setEmploymentId(event.target.value); if (selected) setValidFrom(selected.hiredOn); }} />
    <SelectField label="辦公位置" value={locationId} required options={[{ value: "", label: "請選擇辦公位置" }, ...locations.map((location) => ({ value: location.id, label: `${location.name}${location.scopeName ? `（${location.scopeName}）` : ""}` }))]} onChange={(event) => setLocationId(event.target.value)} />
    <div className="form-grid two"><TextField label="生效日" type="date" required value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /><TextField label="失效日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} /></div>
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

function AttendanceModeDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const initialEmployment = currentEmployment(profile.employments);
  const [employmentId, setEmploymentId] = useState(initialEmployment?.id ?? "");
  const employment = profile.employments.find((item) => item.id === employmentId);
  const [mode, setMode] = useState<"general" | "scheduled">(employment?.attendanceMode ?? "general");
  const save = useHrWrite();
  return <Dialog title={`設定 ${profile.employee.displayName} 的出勤方式`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!employment) return;
    save.mutate({ path: `/employments/${employment.id}/attendance-mode`, method: "PATCH", values: { attendanceMode: mode, revision: employment.revision } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending} disabled={!employment}>儲存出勤方式</Button>}>
    <p>出勤方式屬於任職設定；排班制員工的月曆安排請另外在排班管理維護。</p>
    <SelectField label="任職" value={employmentId} required options={profile.employments.map((item) => ({ value: item.id, label: `${item.hiredOn}～${item.endedOn ?? "目前"}` }))} onChange={(event) => { const selected = profile.employments.find((item) => item.id === event.target.value); setEmploymentId(event.target.value); setMode(selected?.attendanceMode ?? "general"); }} />
    <SelectField label="出勤方式" value={mode} required options={[{ value: "general", label: "一般辦公" }, { value: "scheduled", label: "排班" }]} onChange={(event) => setMode(event.target.value as "general" | "scheduled")} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function EndLocationAssignmentDialog({ assignment, onClose }: { assignment: AttendanceAssignment; onClose: () => void }) {
  const minimum = nextDate(assignment.validFrom);
  const [validTo, setValidTo] = useState(today() > assignment.validFrom ? today() : minimum);
  const [message, setMessage] = useState("");
  const save = useHrWrite();
  return <Dialog title={`結束 ${assignment.locationName} 指派`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (validTo <= assignment.validFrom) { setMessage("失效日必須晚於生效日。"); return; }
    setMessage("");
    save.mutate({ path: `/attendance-location-assignments/${assignment.id}/end`, method: "PATCH", values: { validTo, revision: assignment.revision } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>結束指派</Button>}>
    <p>只新增失效日，不刪除歷史指派。</p>
    <TextField label="失效日（不含）" type="date" required min={minimum} value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

function EmployeeLocationRow({ employee, locations, canWrite, onEdit }: { employee: Employee; locations: AttendanceLocation[]; canWrite: boolean; onEdit: (edit: LocationEdit) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  const primary = useHrWrite();
  if (profile.isPending) return <tr><td>{employee.displayName}</td><td colSpan={5}>載入辦公位置資料…</td></tr>;
  if (profile.error || !profile.data) return <tr><td>{employee.displayName}</td><td colSpan={5}><span className="muted">{profile.error?.message ?? "資料載入失敗"}</span></td></tr>;
  const data = profile.data;
  const employment = currentEmployment(data.employments);
  const assignments = (data.attendanceAssignments ?? []).filter((assignment) => !assignment.validTo);
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{employment?.attendanceMode === "scheduled" ? "排班" : employment ? "一般辦公" : "—"}</td>
    <td><div className="hr-location-assignment-list">{assignments.length ? assignments.map((assignment) => <span className="hr-location-assignment" key={assignment.id}><span>{assignment.locationName}{assignment.isPrimary ? "（主要）" : ""}</span>{canWrite ? <><Button variant="link" onClick={() => onEdit({ kind: "end", profile: data, assignment })}>結束</Button>{!assignment.isPrimary ? <Button variant="link" loading={primary.isPending} onClick={() => primary.mutate({ path: `/attendance-location-assignments/${assignment.id}/primary`, method: "POST", values: {} })}>設為主要</Button> : null}</> : null}</span>) : <span className="muted">尚未指派</span>}</div></td>
    <td>{canWrite ? <div className="row-actions"><Button variant="secondary" disabled={!data.employments.length || !locations.length} onClick={() => onEdit({ kind: "assignment", profile: data })}>新增指派</Button><Button variant="secondary" disabled={!data.employments.length} onClick={() => onEdit({ kind: "attendance-mode", profile: data })}>設定出勤方式</Button></div> : null}</td>
  </tr>;
}

export function HrLocationAssignments() {
  usePageTitle("辦公地點指派");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read");
  const canWrite = permissions.has("hr:office:write");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<LocationEdit | null>(null);
  const employees = useHrQuery<EmployeeListResponse>(`/employees?page=1&pageSize=100&status=all&search=${encodeURIComponent(search)}&sortField=name&sortDirection=asc`, canRead);
  const locations = useHrQuery<{ locations: AttendanceLocation[] }>("/attendance-settings/locations", canRead);
  if (!canRead) return <Alert tone="danger">你沒有檢視辦公地點指派的權限。</Alert>;
  return <div className="page fills">
    <PageHeader title="辦公地點指派" description="以員工為操作主體管理有效辦公位置、主要位置與任職出勤方式；地點名稱與週期工時請到出勤設定維護。" />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}><FilterInput label="搜尋員工" type="search" className="search-input" placeholder="姓名、員工編號或 Email" value={search} onChange={(event) => setSearch(event.target.value)} /></form>
      {employees.error || locations.error ? <Alert tone="danger">{employees.error?.message ?? locations.error?.message}</Alert> : null}
      {employees.isFetching || locations.isFetching ? <p className="form-hint">更新中…</p> : null}
      <div className="table-scroll"><table className="data-table hr-location-assignment-table"><thead><tr><th>員工</th><th>目前任職</th><th>出勤方式</th><th>有效辦公位置</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <EmployeeLocationRow key={employee.userId} employee={employee} locations={locations.data?.locations ?? []} canWrite={canWrite} onEdit={setEditing} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">沒有符合條件的員工。</p> : null}
    </Panel>
    {editing?.kind === "assignment" ? <LocationAssignmentDialog profile={editing.profile} locations={locations.data?.locations ?? []} onClose={() => setEditing(null)} /> : null}
    {editing?.kind === "attendance-mode" ? <AttendanceModeDialog profile={editing.profile} onClose={() => setEditing(null)} /> : null}
    {editing?.kind === "end" && editing.assignment ? <EndLocationAssignmentDialog assignment={editing.assignment} onClose={() => setEditing(null)} /> : null}
  </div>;
}
