import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employee, type NamedOption, type Profile } from "./api.js";

interface Field { key: string; label: string; type?: "date" | "email"; optional?: boolean; options?: NamedOption[]; maxLength?: number }
interface Editor { title: string; path: string; method: string; fields: Field[]; initial?: Record<string, unknown>; description?: string }
const personFields: Field[] = [{ key: "employeeNumber", label: "員工編號", maxLength: 40 }, { key: "displayName", label: "姓名", maxLength: 100 }];

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
    {editor.fields.map((field) => field.options ? <SelectField key={field.key} label={field.label} value={String(values[field.key] ?? "")} options={[{ value: "", label: "請選擇" }, ...field.options.map((option) => ({ value: option.id, label: option.name }))]} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} required /> :
      <TextField key={field.key} label={field.label} type={field.type ?? "text"} value={String(values[field.key] ?? "")} maxLength={field.maxLength} required={!field.optional} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />)}
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

export function HrProfileDetails({ profile }: { profile: Profile }) {
  return <>
    <h2>{profile.employee.employeeNumber} · {profile.employee.displayName}</h2>
    <p className="muted">登入帳號：{profile.employee.userEmail ?? "未綁定"}</p>
    <p className="muted">期間結束日不含當日；離職不會自動停用登入帳號。</p>
    <table className="data-table"><thead><tr><th>雇主</th><th>到職日</th><th>不再任職首日</th><th>年資認列日</th></tr></thead>
      <tbody>{profile.employments.map((job) => <tr key={job.id}><td>{job.employerName}</td><td>{job.hiredOn}</td><td>{job.endedOn ?? "未設定"}</td><td>{job.seniorityStartOn}</td></tr>)}</tbody></table>
    {!profile.employments.length ? <p>尚無任職紀錄。</p> : null}
    <h3>櫃點指派</h3>
    <table className="data-table"><thead><tr><th>雇主</th><th>櫃點</th><th>起日</th><th>迄日（不含）</th></tr></thead><tbody>
      {profile.assignments.map((assignment) => <tr key={assignment.id}><td>{profile.employments.find((job) => job.id === assignment.employmentId)?.employerName}</td><td>{assignment.scopeName}</td><td>{assignment.validFrom}</td><td>{assignment.validTo ?? "未設定"}</td></tr>)}
    </tbody></table>
    {!profile.assignments.length ? <p>尚無櫃點指派。</p> : null}
  </>;
}

export function HrEmployees() {
  usePageTitle("員工管理");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:employee:read");
  const canWrite = permissions.has("hr:employee:write");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const employees = useHrQuery<{ employees: Employee[]; hasMore: boolean }>(`/employees?page=${page}`, canRead);
  const employers = useHrQuery<{ employers: NamedOption[] }>("/employers", canRead);
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes", canRead);
  const detail = useHrQuery<Profile>(`/employees/${encodeURIComponent(selected)}`, canRead && Boolean(selected));
  if (!canRead) return <Alert tone="danger">你沒有檢視員工資料的權限。</Alert>;
  const profile = detail.data;
  return <div className="page">
    <PageHeader title="員工管理" description="人事全平台管理；帳號、員工與任職歷史分開保存。本階段尚未提供排班、打卡或薪資計算。" />
    <section className="panel p-6">
      <div className="flex flex-wrap gap-3">
        {canWrite ? <>
          <Button onClick={() => setEditor({ title: "新增雇主", path: "/employers", method: "POST", fields: [{ key: "name", label: "雇主名稱", maxLength: 100 }, { key: "registrationNumber", label: "統編（可留空）", optional: true, maxLength: 8 }] })}>新增雇主</Button>
          <Button onClick={() => setEditor({ title: "新增員工", path: "/employees", method: "POST", fields: personFields })}>新增員工</Button>
        </> : null}
        <Button variant="secondary" onClick={() => { void employees.refetch(); void employers.refetch(); void scopes.refetch(); if (selected) void detail.refetch(); }}>重新整理</Button>
      </div>
      {employees.isPending ? <p>載入中…</p> : null}
      {[employees.error, employers.error, scopes.error, detail.error].map((error, index) => error ? <Alert key={index} tone="danger">{error.message}</Alert> : null)}
      <table className="data-table"><thead><tr><th>編號</th><th>姓名</th><th>登入關聯</th><th>操作</th></tr></thead><tbody>
        {employees.data?.employees.map((employee) => <tr key={employee.id}><td>{employee.employeeNumber}</td><td>{employee.displayName}</td><td>{employee.userId ? "已綁定" : "未綁定"}</td><td><Button variant="secondary" onClick={() => setSelected(employee.id)}>查看</Button></td></tr>)}
      </tbody></table>
      {employees.data && !employees.data.employees.length ? <p>尚無員工資料，請先新增員工與雇主。</p> : null}
      <div className="flex items-center gap-3"><Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>上一頁</Button><span>第 {page} 頁</span><Button variant="secondary" disabled={!employees.data?.hasMore} onClick={() => setPage(page + 1)}>下一頁</Button></div>
    </section>
    {selected && detail.isPending ? <p>載入員工資料…</p> : null}
    {profile ? <section className="panel p-6">
      <HrProfileDetails profile={profile} />
      <div className="flex flex-wrap gap-3">
        {canWrite ? <>
          <Button variant="secondary" onClick={() => setEditor({ title: "編輯員工", path: `/employees/${profile.employee.id}`, method: "PATCH", fields: personFields, initial: { employeeNumber: profile.employee.employeeNumber, displayName: profile.employee.displayName, revision: profile.employee.revision } })}>編輯姓名／編號</Button>
          <Button disabled={!employers.data?.employers.length} onClick={() => setEditor({ title: "新增任職／復職紀錄", path: "/employments", method: "POST", initial: { employeeId: profile.employee.id }, description: "同一員工、雇主的任職期間不可重疊。復職新增紀錄，不修改舊任職。", fields: [
            { key: "employerId", label: "雇主", options: employers.data?.employers ?? [] }, { key: "hiredOn", label: "到職日", type: "date" }, { key: "seniorityStartOn", label: "年資認列日", type: "date" }, { key: "endedOn", label: "不再任職首日（可留空）", type: "date", optional: true },
          ] })}>新增任職／復職</Button>
        </> : null}
        {permissions.has("hr:employee:bind") ? <Button variant="secondary" onClick={() => setEditor({ title: "綁定登入帳號", path: `/employees/${profile.employee.id}/account`, method: "PUT", initial: { revision: profile.employee.revision, userEmail: profile.employee.userEmail ?? "" }, description: "僅可綁定已啟用帳號。填入信箱將取代現有關聯；留空將解除綁定。此操作決定誰能看見本人人事資料，請確認身分。", fields: [{ key: "userEmail", label: "啟用帳號信箱（留空解除）", type: "email", optional: true, maxLength: 254 }] })}>帳號綁定</Button> : null}
      </div>
      {canWrite ? profile.employments.map((job) => <div key={job.id} className="mt-4">
        <h3>{job.employerName} · {job.hiredOn}</h3>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" disabled={!scopes.data?.scopes.length} onClick={() => setEditor({ title: "新增櫃點指派", path: "/assignments", method: "POST", initial: { employmentId: job.id, validFrom: job.hiredOn }, description: "指派期間需在任職期間內；指派不會授予平台管理權限。", fields: [{ key: "scopeId", label: "櫃點", options: scopes.data?.scopes ?? [] }, { key: "validFrom", label: "起日", type: "date" }, { key: "validTo", label: "迄日（不含，可留空）", type: "date", optional: true }] })}>新增櫃點</Button>
          {!job.endedOn ? <Button variant="secondary" onClick={() => setEditor({ title: "結束任職", path: `/employments/${job.id}/end`, method: "PATCH", initial: { revision: job.revision }, description: "請先結束所有超過離職日期的櫃點指派。本階段不提供修改已結束紀錄，請確認日期。", fields: [{ key: "endedOn", label: "不再任職首日", type: "date" }] })}>結束任職</Button> : null}
          {profile.assignments.filter((assignment) => assignment.employmentId === job.id && !assignment.validTo).map((assignment) => <Button key={assignment.id} variant="secondary" onClick={() => setEditor({ title: `結束 ${assignment.scopeName} 指派`, path: `/assignments/${assignment.id}/end`, method: "PATCH", initial: { revision: assignment.revision }, fields: [{ key: "validTo", label: "迄日（不含）", type: "date" }] })}>結束 {assignment.scopeName} 指派</Button>)}
        </div>
      </div>) : null}
    </section> : null}
    {editor ? <EditorDialog editor={editor} onClose={() => setEditor(null)} /> : null}
  </div>;
}

export function HrSelf() {
  usePageTitle("我的人事資料");
  const { permissions } = useSession();
  const allowed = permissions.has("hr:self:read");
  const query = useHrQuery<{ profile: Profile | null }>("/me", allowed);
  if (!allowed) return <Alert tone="danger">你沒有檢視本人人事資料的權限。</Alert>;
  return <div className="page"><PageHeader title="我的人事資料" description="檢視本人的任職與櫃點指派；資料有誤請聯絡人資。" />
    {query.isPending ? <p>載入中…</p> : query.error ? <Alert tone="danger">{query.error.message}</Alert> : query.data?.profile ? <section className="panel p-6"><HrProfileDetails profile={query.data.profile} /></section> : <Alert>尚未綁定員工資料，請聯絡人資。</Alert>}
  </div>;
}
