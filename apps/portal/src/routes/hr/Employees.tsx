import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceLocation, type Candidate, type Employee, type NamedOption, type Profile } from "./api.js";

interface Field { key: string; label: string; type?: "date" | "email"; optional?: boolean; options?: NamedOption[]; maxLength?: number }
interface Editor { title: string; path: string; method: string; fields: Field[]; initial?: Record<string, unknown>; description?: string }

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

export function HrProfileDetails({ profile }: { profile: Profile }) {
  return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <p className="muted">帳號：{profile.employee.email}；登入狀態：{profile.employee.userStatus === "active" ? "啟用中" : profile.employee.userStatus === "invited" ? "待啟用" : "已停用"}</p>
    <p className="muted">期間結束日不含當日；停用帳號不會刪除任職歷史。</p>
    <p className="hr-employee-supervisor">主管：<strong>{profile.employee.supervisorName ?? "尚未設定"}</strong></p>
    <table className="data-table"><thead><tr><th>到職日</th><th>不再任職首日</th><th>年資認列日</th></tr></thead>
      <tbody>{profile.employments.map((job) => <tr key={job.id}><td>{job.hiredOn}</td><td>{job.endedOn ?? "未設定"}</td><td>{job.seniorityStartOn}</td></tr>)}</tbody></table>
    {!profile.employments.length ? <p>尚無任職紀錄。</p> : null}
    <h3>營運櫃點歸屬</h3>
    <table className="data-table"><thead><tr><th>櫃點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {profile.assignments.map((assignment) => <tr key={assignment.id}><td>{assignment.scopeName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!profile.assignments.length ? <p>尚無營運櫃點歸屬。</p> : null}
    <h3>辦公位置指派</h3>
    <table className="data-table"><thead><tr><th>辦公位置</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {(profile.attendanceAssignments ?? []).map((assignment) => <tr key={assignment.id}><td>{assignment.locationName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!(profile.attendanceAssignments ?? []).length ? <p>尚未指派辦公位置。</p> : null}
  </>;
}

export function HrEmployees() {
  usePageTitle("員工管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const canOfficeWrite = permissions.has("hr:office:read") && permissions.has("hr:office:write");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; hasMore: boolean }>(`/employees?page=${page}`, canRead);
  const candidates = useHrQuery<{ users: Candidate[] }>("/candidates", canWrite);
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes", canRead);
  const officeLocations = useHrQuery<{ locations: AttendanceLocation[] }>("/attendance-settings/locations", canOfficeWrite);
  const supervisors = useHrQuery<{ users: NamedOption[] }>(`/supervisor-candidates?exclude=${encodeURIComponent(selected)}`, canWrite && Boolean(selected));
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(selected)}`, canRead && Boolean(selected));
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  const profile = detail.data;
  const activeEmployment = profile?.employments.find((job) => !job.endedOn);
  const candidateOptions: NamedOption[] = (candidates.data?.users ?? []).map((user) => ({ id: user.userId, name: `${user.displayName}（${user.email}）` }));
  return <div className="page">
    <PageHeader title="員工管理" description="從現有使用者指派員工；姓名與登入帳號共用平台 users，不另建雇主或帳號綁定資料。" />
    <section className="panel p-6">
      <div className="flex flex-wrap gap-3">
        {canWrite ? <Button disabled={!candidateOptions.length} onClick={() => setEditor({ title: "指派使用者為員工", path: "/employees", method: "POST", description: "員工必須先存在於平台使用者名單。指派後即可從「我的人事資料」查看自己的任職資料。", fields: [
          { key: "userId", label: "使用者", options: candidateOptions }, { key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" },
        ] })}>指派為員工</Button> : null}
        <Button variant="secondary" onClick={() => { void employees.refetch(); void candidates.refetch(); void scopes.refetch(); if (canOfficeWrite) void officeLocations.refetch(); if (selected) { void supervisors.refetch(); void detail.refetch(); } }}>重新整理</Button>
      </div>
      {employees.isPending ? <p>載入中…</p> : null}
      {[employees.error, candidates.error, scopes.error, officeLocations.error, supervisors.error, detail.error].map((error, index) => error ? <Alert key={index} tone="danger">{error.message}</Alert> : null)}
      <table className="data-table"><thead><tr><th>員工編號</th><th>姓名</th><th>帳號</th><th>狀態</th><th>操作</th></tr></thead><tbody>
        {employees.data?.employees.map((employee) => <tr key={employee.userId}><td>{employee.employeeNumber}</td><td>{employee.displayName}</td><td>{employee.email}</td><td>{employee.userStatus === "active" ? "啟用中" : employee.userStatus === "invited" ? "待啟用" : "已停用"}</td><td><Button variant="secondary" onClick={() => setSelected(employee.userId)}>查看</Button></td></tr>)}
      </tbody></table>
      {employees.data && !employees.data.employees.length ? <p>尚無員工資料，請先在帳號管理邀請使用者，再指派為員工。</p> : null}
      <div className="flex items-center gap-3"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>上一頁</Button><span>第 {page} 頁</span><Button variant="secondary" disabled={!employees.data?.hasMore} onClick={() => setPage(page + 1)}>下一頁</Button></div>
    </section>
    {selected && detail.isPending ? <p>載入員工資料…</p> : null}
    {profile ? <section className="panel p-6">
      <HrProfileDetails profile={profile} />
      {canWrite ? <>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setEditor({ title: "編輯員工編號", path: `/employees/${profile.employee.userId}`, method: "PATCH", fields: [{ key: "employeeNumber", label: "員工編號", maxLength: 40 }], initial: { employeeNumber: profile.employee.employeeNumber, revision: profile.employee.revision } })}>編輯員工編號</Button>
          <Button variant="secondary" disabled={!supervisors.data?.users.length} onClick={() => setEditor({ title: "設定員工主管", path: `/employees/${profile.employee.userId}/supervisor`, method: "PATCH", description: "申請單預設會送給這位主管審核；未指定時，員工仍可在申請單中選擇其他啟用中的員工。", fields: [{ key: "supervisorUserId", label: "主管", options: supervisors.data?.users ?? [], optional: true }], initial: { supervisorUserId: profile.employee.supervisorUserId ?? "", revision: profile.employee.revision } })}>設定主管</Button>
          <Button disabled={!activeEmployment || !scopes.data?.scopes.length} onClick={() => setEditor({ title: "新增櫃點歸屬", path: "/assignments", method: "POST", initial: { employmentId: activeEmployment?.id, validFrom: activeEmployment?.hiredOn }, description: "營運櫃點歸屬期間需在任職期間內；這不會授予平台管理權限。", fields: [{ key: "scopeId", label: "櫃點", options: scopes.data?.scopes ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增櫃點歸屬</Button>
          {canOfficeWrite ? <Button disabled={!activeEmployment || !officeLocations.data?.locations.length} onClick={() => setEditor({ title: "新增辦公位置指派", path: `/employments/${activeEmployment?.id}/attendance-location`, method: "POST", initial: { validFrom: activeEmployment?.hiredOn }, description: "辦公位置指派期間需在任職期間內；同一段任職可同時指派多個辦公位置，打卡時符合任一範圍即可。", fields: [{ key: "locationId", label: "辦公位置", options: officeLocations.data?.locations.map((location) => ({ id: location.id, name: location.name })) ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增辦公位置指派</Button> : null}
        </div>
        {profile.employments.map((job) => <div key={job.id} className="mt-4">
          <h3>任職：{job.hiredOn}{job.endedOn ? `～${job.endedOn}` : "～目前"}</h3>
          <div className="flex flex-wrap gap-3">
            {!job.endedOn ? <Button variant="secondary" onClick={() => setEditor({ title: "結束任職", path: `/employments/${job.id}/end`, method: "PATCH", initial: { revision: job.revision }, description: "請先結束所有超過離職日期的櫃點與辦公位置指派。結束後仍保留歷史紀錄。", fields: [{ key: "endedOn", label: "不再任職首日", type: "date" }] })}>結束任職</Button> : null}
            {profile.assignments.filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => setEditor({ title: `結束 ${assignment.scopeName} 歸屬`, path: `/assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.scopeName} 歸屬</Button>)}
            {(profile.attendanceAssignments ?? []).filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => setEditor({ title: `結束 ${assignment.locationName} 辦公位置指派`, path: `/attendance-location-assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.locationName} 指派</Button>)}
          </div>
        </div>)}
        <Button className="mt-4" onClick={() => setEditor({ title: "新增任職／復職紀錄", path: "/employments", method: "POST", initial: { userId: profile.employee.userId }, description: "同一使用者的任職期間不可重疊；復職新增紀錄，不修改舊任職。", fields: [
          { key: "userId", label: "使用者", options: [{ id: profile.employee.userId, name: `${profile.employee.displayName}（${profile.employee.email}）` }] }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "endedOn", label: "不再任職首日（可留空）", type: "date", optional: true },
        ] })}>新增任職／復職</Button>
      </> : null}
    </section> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => { setEditor(null); void employees.refetch(); void candidates.refetch(); if (canOfficeWrite) void officeLocations.refetch(); if (selected) void detail.refetch(); }} /> : null}
  </div>;
}
