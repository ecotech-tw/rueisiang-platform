import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type Profile, type ScheduleWorkerRecord } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";

interface EmployeeListResponse { employees: Employee[] }
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function taipeiToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function currentVersion<T extends { validFrom: string; validTo: string | null }>(versions: T[]): T | undefined {
  const today = taipeiToday();
  return versions.find((version) => version.validFrom <= today && (version.validTo === null || today < version.validTo))
    ?? versions.filter((version) => version.validFrom <= today).sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
}

function currentEmployment(employments: Employment[]): Employment | undefined {
  const today = taipeiToday();
  return employments.find((employment) => employment.hiredOn <= today && (employment.endedOn === null || today < employment.endedOn)) ?? employments[0];
}

function CompensationEditor({ employment, current, onClose }: { employment: Employment; current?: CompensationVersion; onClose: () => void }) {
  const [validFrom, setValidFrom] = useState(() => {
    const today = taipeiToday();
    return employment.hiredOn > today ? employment.hiredOn : today;
  });
  const [validTo, setValidTo] = useState("");
  const [payBasis, setPayBasis] = useState<CompensationVersion["payBasis"]>(current?.payBasis ?? "monthly");
  const [amount, setAmount] = useState(current ? String(current.baseAmountMinor / 100) : "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();

  return <Dialog title="新增敘薪版本" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) { setMessage("請輸入非負整數的薪資金額（元）。"); return; }
    setMessage(null);
    save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: { validFrom, validTo: validTo || null, payBasis, baseAmountMinor: numericAmount * 100, note } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>保存敘薪</Button>}>
    <p>敘薪採版本保存；新增版本的生效期間不能覆蓋既有薪資版本。</p>
    <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <SelectField label="薪資計算方式" value={payBasis} options={[{ value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }]} onChange={(event) => setPayBasis(event.target.value as CompensationVersion["payBasis"])} />
    <TextField label="金額（元）" type="number" min="0" step="1" value={amount} required onChange={(event) => setAmount(event.target.value)} />
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

function WorkerCompensationEditor({ worker, onClose }: { worker: ScheduleWorkerRecord; onClose: () => void }) {
  const current = currentVersion(worker.compensation);
  const [validFrom, setValidFrom] = useState(taipeiToday());
  const [validTo, setValidTo] = useState("");
  const [amount, setAmount] = useState(current ? String(current.baseAmountMinor / 100) : "");
  const [note, setNote] = useState("");
  const save = useHrWrite();
  return <Dialog title={`設定 ${worker.displayName} 的敘薪`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) return;
    save.mutate({ path: `/schedule-workers/${worker.id}/compensation`, method: "POST", values: { validFrom, validTo: validTo || null, payBasis: "daily", baseAmountMinor: numericAmount * 100, note } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>保存日薪</Button>}>
    <p>支援人員目前以日薪計算；不套用員工獎金 policy。敘薪版本不覆蓋歷史。</p>
    <TextField label="生效日" type="date" required value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <TextField label="日薪（元）" type="number" min="0" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} />
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function EmployeeCompensationRow({ employee, canWrite }: { employee: Employee; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const current = currentVersion(profile.data?.compensation ?? []);
  if (profile.isLoading) return <tr><td>{employee.displayName}</td><td colSpan={5}>載入敘薪資料…</td></tr>;
  return <>
    <tr>
      <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
      <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
      <td>{current ? PAY_BASIS_LABEL[current.payBasis] : "尚未設定"}</td>
      <td className="numeric">{current ? money(current.baseAmountMinor) : "—"}</td>
      <td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td>
      <td>{canWrite && employment ? <Button variant="secondary" onClick={() => setEditing(true)}>新增版本</Button> : null}</td>
    </tr>
    {editing && employment ? <CompensationEditor employment={employment} current={current} onClose={() => setEditing(false)} /> : null}
  </>;
}

function WorkerCompensationRow({ worker, canWrite, onEdit }: { worker: ScheduleWorkerRecord; canWrite: boolean; onEdit: () => void }) {
  const current = currentVersion(worker.compensation);
  return <tr><td><strong>{worker.displayName}</strong><br /><span className="muted">排班支援人員</span></td><td>日薪</td><td className="numeric">{current ? money(current.baseAmountMinor) : "尚未設定"}</td><td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td><td>{canWrite ? <Button variant="secondary" onClick={onEdit}>新增版本</Button> : null}</td></tr>;
}

export function HrCompensationManagement() {
  usePageTitle("敘薪管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canWrite = isHrAdministrator && permissions.has("hr:employee:write");
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc", canRead && permissions.has("hr:employee:read"));
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers", canRead && permissions.has("hr:schedule:read"));
  const [editingWorker, setEditingWorker] = useState<ScheduleWorkerRecord | null>(null);
  if (!canRead) return <Alert tone="danger">敘薪明細僅限全平台 HR 管理者查看。</Alert>;
  return <div className="page">
    <PageHeader title="敘薪管理" description="設定每位員工的薪資計算方式與生效版本；薪資變更不覆蓋歷史，薪資結算會讀取指定月份有效的敘薪版本。" />
    <Alert tone="info">先在這裡完成員工敘薪，再到「獎金管理」套用業績 policy；最後於「薪資結算」直接計算指定月份薪資。</Alert>
    {!canWrite ? <Alert tone="info">目前帳號只有敘薪檢視權限，無法新增薪資版本。</Alert> : null}
    <Panel>
      <div className="panel-head"><div><h2>員工敘薪</h2><p>月薪、日薪與時薪都以版本保存；目前有效版本會顯示在列表。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>方式</th><th className="numeric">金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <EmployeeCompensationRow key={employee.userId} employee={employee} canWrite={canWrite} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">尚無啟用中的員工。</p> : null}
    </Panel>
    {permissions.has("hr:schedule:read") ? <Panel><div className="panel-head"><div><h2>排班支援人員</h2><p>沒有平台帳號的支援人員只可從月曆排班加入，薪資結算依已發布排班日數計算，不參與獎金。</p></div></div>{workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}<div className="table-scroll"><table className="data-table"><thead><tr><th>人員</th><th>方式</th><th className="numeric">目前金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>{(workers.data?.workers ?? []).map((worker) => <WorkerCompensationRow key={worker.id} worker={worker} canWrite={canWrite} onEdit={() => setEditingWorker(worker)} />)}</tbody></table></div>{!workers.error && !workers.data?.workers.length ? <p className="empty-state">尚無排班支援人員。</p> : null}</Panel> : null}
    {editingWorker ? <WorkerCompensationEditor worker={editingWorker} onClose={() => setEditingWorker(null)} /> : null}
  </div>;
}
