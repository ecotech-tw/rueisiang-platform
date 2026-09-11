import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type Profile } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";

interface EmployeeListResponse { employees: Employee[] }
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function currentEmployment(employments: Employment[]): Employment | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return employments.find((employment) => employment.hiredOn <= today && (employment.endedOn === null || today < employment.endedOn)) ?? employments[0];
}

function CompensationEditor({ employment, current, onClose }: { employment: Employment; current?: CompensationVersion; onClose: () => void }) {
  const [validFrom, setValidFrom] = useState(employment.hiredOn);
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

function EmployeeCompensationRow({ employee, canWrite }: { employee: Employee; canWrite: boolean }) {
  const [editing, setEditing] = useState(false);
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const current = profile.data?.compensation?.find((version) => version.validTo === null) ?? profile.data?.compensation?.[0];
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

export function HrCompensationManagement() {
  usePageTitle("敘薪管理");
  const { permissions } = useSession();
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc");
  const canWrite = permissions.has("hr:employee:write");
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
  </div>;
}
