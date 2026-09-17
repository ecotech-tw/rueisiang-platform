import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, DropdownSelect, FilterInput, PageHeader, Panel, SelectField, Tooltip } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceLocation, type Employee, type Employment, type Profile } from "./api.js";
import { HrPageSkeleton, HrSkeletonTableRow } from "./HrSkeleton.js";

interface EmployeeListResponse { employees: Employee[] }
type LocationEdit = { kind: "scope"; profile: Profile };

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
  return employments.find((employment) => employment.hiredOn <= date && (employment.endedOn === null || date < employment.endedOn));
}

function AttendanceScopeDialog({ profile, locations, onClose }: { profile: Profile; locations: AttendanceLocation[]; onClose: () => void }) {
  const initialEmployment = currentEmployment(profile.employments);
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>(() => (profile.attendanceAssignments ?? []).filter((assignment) => assignment.employmentId === initialEmployment?.id && !assignment.validTo).map((assignment) => assignment.locationId));
  const [mode, setMode] = useState<"general" | "scheduled">(initialEmployment?.attendanceMode ?? "general");
  const [message, setMessage] = useState("");
  const saveAssignment = useHrWrite();
  const saveMode = useHrWrite();
  const employment = initialEmployment;
  const locationOptions = locations.map((location) => ({ value: location.id, label: `${location.name}${location.scopeName ? `（${location.scopeName}）` : ""}` }));
  const addLocation = () => { const next = locationOptions.find((option) => !selectedLocationIds.includes(option.value)); if (next) setSelectedLocationIds((current) => [...current, next.value]); };
  return <Dialog title={`編輯 ${profile.employee.displayName} 的出勤範圍`} onClose={onClose} closeDisabled={saveAssignment.isPending || saveMode.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (!employment) { setMessage("請選擇任職。"); return; }
    setMessage("");
    const currentAssignments = (profile.attendanceAssignments ?? []).filter((assignment) => assignment.employmentId === employment.id && !assignment.validTo);
    const currentByLocation = new Map(currentAssignments.map((assignment) => [assignment.locationId, assignment]));
    const toAdd = selectedLocationIds.filter((locationId) => !currentByLocation.has(locationId));
    const toEnd = currentAssignments.filter((assignment) => !selectedLocationIds.includes(assignment.locationId));
    const endDate = nextDate(today());
    Promise.all([
      saveMode.mutateAsync({ path: `/employments/${employment.id}/attendance-mode`, method: "PATCH", values: { attendanceMode: mode, revision: employment.revision } }),
      ...toAdd.map((locationId) => saveAssignment.mutateAsync({ path: `/employments/${employment.id}/attendance-location`, method: "POST", values: { locationId, validFrom: today(), validTo: null } })),
      ...toEnd.map((assignment) => saveAssignment.mutateAsync({ path: `/attendance-location-assignments/${assignment.id}/end`, method: "PATCH", values: { validTo: endDate, revision: assignment.revision } })),
    ]).then(onClose).catch(() => undefined);
  } }} actions={<Button type="submit" icon="check" disabled={!employment} loading={saveAssignment.isPending || saveMode.isPending}>儲存</Button>}>
    <p>出勤範圍決定員工可在哪些辦公位置打卡；排班不會限制員工只能在當日排班位置打卡。</p>
    {!employment ? <Alert tone="danger">目前沒有有效任職，無法設定出勤範圍。</Alert> : null}
    <SelectField label="出勤方式" value={mode} required options={[{ value: "general", label: "一般辦公" }, { value: "scheduled", label: "排班" }]} onChange={(event) => setMode(event.target.value as "general" | "scheduled")} />
    <div className="field hr-attendance-scope-field"><span>可打卡辦公位置</span><div className="hr-bonus-picker-list">{selectedLocationIds.map((locationId, index) => <div key={`${locationId}-${index}`} className="hr-bonus-picker-row"><DropdownSelect value={locationId} aria-label="選擇辦公位置" options={locationOptions.map((option) => ({ ...option, disabled: selectedLocationIds.includes(option.value) && option.value !== locationId }))} onChange={(event) => setSelectedLocationIds((current) => current.map((id, currentIndex) => currentIndex === index ? event.target.value : id))} /><Button type="button" variant="icon" icon="trash" aria-label="移除辦公位置" title="移除辦公位置" onClick={() => setSelectedLocationIds((current) => current.filter((_, currentIndex) => currentIndex !== index))} /></div>)}{!selectedLocationIds.length ? <p className="muted hr-bonus-picker-empty">尚未設定可打卡辦公位置。</p> : null}<Button type="button" variant="chip-action" icon="plus" onClick={addLocation} disabled={selectedLocationIds.length >= locationOptions.length}>{selectedLocationIds.length ? "新增辦公位置" : "新增第一個辦公位置"}</Button></div></div>
    {message || saveAssignment.error || saveMode.error ? <Alert tone="danger">{message || saveAssignment.error?.message || saveMode.error?.message}</Alert> : null}
  </Dialog>;
}

function EmployeeLocationRow({ employee, locations, canWrite, onEdit }: { employee: Employee; locations: AttendanceLocation[]; canWrite: boolean; onEdit: (edit: LocationEdit) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  if (profile.isPending) return <HrSkeletonTableRow columns={5} />;
  if (profile.error || !profile.data) return <tr><td>{employee.displayName}</td><td colSpan={5}><span className="muted">{profile.error?.message ?? "資料載入失敗"}</span></td></tr>;
  const data = profile.data;
  const employment = currentEmployment(data.employments);
  const assignments = (data.attendanceAssignments ?? []).filter((assignment) => !assignment.validTo);
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{employment?.attendanceMode === "scheduled" ? "排班" : employment ? "一般辦公" : "—"}</td>
    <td><div className="hr-location-assignment-list">{assignments.length ? assignments.map((assignment) => <span className="hr-location-assignment" key={assignment.id}><span>{assignment.locationName}</span></span>) : <span className="muted">尚未指派</span>}</div></td>
    <td>{canWrite ? <div className="row-actions"><Tooltip label={`編輯 ${employee.displayName} 的出勤範圍`}><Button variant="icon" icon="edit" aria-label={`編輯 ${employee.displayName} 的出勤範圍`} disabled={!data.employments.length || !locations.length} onClick={() => onEdit({ kind: "scope", profile: data })} /></Tooltip></div> : null}</td>
  </tr>;
}

export function HrAttendanceScopeManagement() {
  usePageTitle("出勤範圍管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read");
  const canWrite = permissions.has("hr:office:write");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<LocationEdit | null>(null);
  const employees = useHrQuery<EmployeeListResponse>(`/employees?page=1&pageSize=100&status=all&search=${encodeURIComponent(search)}&sortField=name&sortDirection=asc`, canRead);
  const locations = useHrQuery<{ locations: AttendanceLocation[] }>("/attendance-settings/locations", canRead);
  if (!canRead) return <Alert tone="danger">你沒有檢視出勤範圍管理的權限。</Alert>;
  if (employees.isPending || locations.isPending) return <HrPageSkeleton variant="table" />;
  return <div className="page fills">
    <PageHeader title="出勤範圍管理" description="以員工為操作主體管理可打卡辦公位置與出勤方式；地點名稱與週期工時請到據點管理維護。" />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}><FilterInput label="搜尋員工" type="search" className="search-input" placeholder="姓名、員工編號或 Email" value={search} onChange={(event) => setSearch(event.target.value)} /></form>
      {employees.error || locations.error ? <Alert tone="danger">{employees.error?.message ?? locations.error?.message}</Alert> : null}
      {employees.isFetching || locations.isFetching ? <p className="form-hint">更新中…</p> : null}
      <div className="table-scroll"><table className="data-table hr-location-assignment-table"><thead><tr><th>員工</th><th>目前任職</th><th>出勤方式</th><th>有效辦公位置</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <EmployeeLocationRow key={employee.userId} employee={employee} locations={locations.data?.locations ?? []} canWrite={canWrite} onEdit={setEditing} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">沒有符合條件的員工。</p> : null}
    </Panel>
    {editing?.kind === "scope" ? <AttendanceScopeDialog profile={editing.profile} locations={locations.data?.locations ?? []} onClose={() => setEditing(null)} /> : null}
  </div>;
}
