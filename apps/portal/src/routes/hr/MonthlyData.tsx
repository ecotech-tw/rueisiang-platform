import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type Profile } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface EmployeeListResponse { employees: Employee[] }
interface LeaveType { id: string; name: string; defaultPayRatePpm: number }
interface MonthlyLeave { id: string; employmentId: string; employeeNumber: string; employeeName: string; leaveTypeId: string; leaveTypeName: string; leaveDate: string; hoursHalfUnits: number; hours: number; payRatePpm: number; deductionAmount: number; note: string; revision: number }
interface MonthlyHourly { id: string; employmentId: string; employeeNumber: string; employeeName: string; workDate: string; hoursHalfUnits: number; hours: number; noWork: number; note: string; revision: number }
interface MonthlyResponse { periodKey: string; leaveTypes: LeaveType[]; leaves: MonthlyLeave[]; hourly: MonthlyHourly[] }

function deductionYuan(value: number) { return `-NT$ ${Math.abs(value).toLocaleString("zh-TW")}`; }
function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function taipeiMonth() { return taipeiToday().slice(0, 7); }

export function HrMonthlyData() {
  usePageTitle("月度資料登記");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canWrite = isHrAdministrator && permissions.has("hr:payroll:calculate");
  const [periodKey, setPeriodKey] = useState(taipeiMonth);
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [mode, setMode] = useState<"leave" | "hourly">("leave");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [leaveDate, setLeaveDate] = useState(() => `${taipeiMonth()}-01`);
  const [leaveHours, setLeaveHours] = useState("8");
  const [payRate, setPayRate] = useState("100");
  const [deduction, setDeduction] = useState("0");
  const [workDate, setWorkDate] = useState(() => `${taipeiMonth()}-01`);
  const [workHours, setWorkHours] = useState("8");
  const [noWork, setNoWork] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, canRead);
  const profile = useHrQuery<{ employee: Employee; employments: Profile["employments"] }>(employeeUserId ? `/employees/${encodeURIComponent(employeeUserId)}` : "/employees/__none__", canRead && Boolean(employeeUserId), { keepPreviousData: false });
  const data = useHrQuery<MonthlyResponse>(`/payroll/monthly-data?periodKey=${encodeURIComponent(periodKey)}${employeeUserId ? `&employeeUserId=${encodeURIComponent(employeeUserId)}` : ""}`, canRead && Boolean(periodKey), { keepPreviousData: false });
  const write = useHrWrite();
  const selectedEmployment = profile.data?.employments.find((employment) => !employment.archivedAt);
  const employeeOptions = useMemo(() => [{ label: "請選擇員工", value: "" }, ...(employees.data?.employees ?? []).map((employee) => ({ label: `${employee.displayName}（${employee.employeeNumber}）`, value: employee.userId }))], [employees.data]);
  const leaveTypeOptions = [{ label: "請選擇假別", value: "" }, ...(data.data?.leaveTypes ?? []).map((leaveType) => ({ label: leaveType.name, value: leaveType.id }))];

  if (!canRead) return <Alert tone="danger">月度資料僅限全平台 HR 管理者查看。</Alert>;
  if (employees.isPending || (Boolean(periodKey) && data.isPending)) return <HrPageSkeleton variant="table" />;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedEmployment) { setError("請先指派為目前有效的員工。"); return; }
    setError(null);
    const values = mode === "leave"
      ? { employmentId: selectedEmployment.id, leaveTypeId, leaveDate, hoursHalfUnits: Math.round(Number(leaveHours) * 2), payRatePpm: Math.round(Number(payRate) * 10_000), deductionAmount: Number(deduction), note }
      : { employmentId: selectedEmployment.id, workDate, hoursHalfUnits: noWork ? 0 : Math.round(Number(workHours) * 2), noWork, note };
    write.mutate({ path: mode === "leave" ? "/payroll/monthly-data/leave" : "/payroll/monthly-data/hourly", method: "POST", values }, { onSuccess: () => { setNote(""); void data.refetch(); }, onError: (cause) => setError(cause.message) });
  }

  return <div className="page fills">
    <PageHeader title="月度資料登記" description="薪資結算前集中登記時薪工時與假勤扣款；這裡不提供請假申請或主管簽核流程。" actions={<Button variant="secondary" onClick={() => { window.location.href = "/hr/payroll-settlement"; }}>返回薪資結算</Button>} />
    <Alert tone="info">假勤扣款由 HR 依當月人工核定結果輸入，保存單位為整數元；時薪工時以 0.5 小時為單位。</Alert>
    {error ? <Alert tone="danger">{error}</Alert> : null}
    <Panel>
      <div className="admin-form toolbar"><TextField label="薪資月份" type="month" value={periodKey} onChange={(event) => { setPeriodKey(event.target.value); setLeaveDate(`${event.target.value}-01`); setWorkDate(`${event.target.value}-01`); }} /><SelectField label="員工" value={employeeUserId} options={employeeOptions} onChange={(event) => setEmployeeUserId(event.target.value)} /><SelectField label="資料類型" value={mode} options={[{ value: "leave", label: "假勤紀錄" }, { value: "hourly", label: "時薪工時" }]} onChange={(event) => setMode(event.target.value as "leave" | "hourly")} /></div>
      <form className="admin-form" onSubmit={submit}>
        {!selectedEmployment && employeeUserId ? <p className="form-hint">此員工目前沒有活動員工資料。</p> : null}
        {mode === "leave" ? <><SelectField label="假別" value={leaveTypeId} options={leaveTypeOptions} required onChange={(event) => setLeaveTypeId(event.target.value)} /><TextField label="日期" type="date" value={leaveDate} required onChange={(event) => setLeaveDate(event.target.value)} /><TextField label="時數" type="number" min="0.5" step="0.5" value={leaveHours} required onChange={(event) => setLeaveHours(event.target.value)} /><TextField label="給薪比例（%）" type="number" min="0" max="100" step="0.01" value={payRate} required onChange={(event) => setPayRate(event.target.value)} /><TextField label="扣款金額（元）" type="number" min="0" step="1" value={deduction} required onChange={(event) => setDeduction(event.target.value)} /></> : <><TextField label="工作日期" type="date" value={workDate} required onChange={(event) => setWorkDate(event.target.value)} /><TextField label="工時" type="number" min="0.5" step="0.5" value={workHours} disabled={noWork} required={!noWork} onChange={(event) => setWorkHours(event.target.value)} /><label className="field"><span>本期無工時</span><span className="checkbox-field"><input type="checkbox" checked={noWork} onChange={(event) => setNoWork(event.target.checked)} /> 明確標記本期無工時</span></label></>}
        <TextField label="備註" value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
        {canWrite ? <Button type="submit" icon="plus" loading={write.isPending} disabled={!selectedEmployment}>新增登記</Button> : null}
      </form>
    </Panel>
    <Panel className="grows" title={mode === "leave" ? "本月假勤紀錄" : "本月時薪工時"}>
      {data.error ? <Alert tone="danger">{data.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead>{mode === "leave" ? <tr><th>日期</th><th>員工任職</th><th>假別</th><th>時數</th><th>給薪比例</th><th className="numeric">扣款</th><th>備註</th></tr> : <tr><th>日期</th><th>員工任職</th><th>工時</th><th>狀態</th><th>備註</th></tr>}</thead><tbody>{mode === "leave" ? (data.data?.leaves ?? []).map((entry) => <tr key={entry.id}><td data-label="日期">{entry.leaveDate}</td><td data-label="員工任職">{entry.employeeName}（{entry.employeeNumber}）</td><td data-label="假別">{entry.leaveTypeName}</td><td data-label="時數">{entry.hours.toFixed(1)} 小時</td><td data-label="給薪比例">{(entry.payRatePpm / 10_000).toFixed(2)}%</td><td data-label="扣款" className="numeric">{deductionYuan(entry.deductionAmount)}</td><td data-label="備註">{entry.note || "—"}</td></tr>) : (data.data?.hourly ?? []).map((entry) => <tr key={entry.id}><td data-label="日期">{entry.workDate}</td><td data-label="員工任職">{entry.employeeName}（{entry.employeeNumber}）</td><td data-label="工時">{entry.noWork ? "—" : `${entry.hours.toFixed(1)} 小時`}</td><td data-label="狀態">{entry.noWork ? "本期無工時" : "已登記"}</td><td data-label="備註">{entry.note || "—"}</td></tr>)}</tbody></table></div>
      {mode === "leave" && !data.data?.leaves.length ? <p className="empty-state">本月尚未登記假勤。</p> : null}
      {mode === "hourly" && !data.data?.hourly.length ? <p className="empty-state">本月尚未登記時薪工時。</p> : null}
    </Panel>
  </div>;
}
