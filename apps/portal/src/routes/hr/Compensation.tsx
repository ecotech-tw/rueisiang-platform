import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type Profile, type ScheduleWorkerRecord, type InsuranceVersion, type InsuranceBracketTable, type InsuranceRateTableRecord, type InsuranceContributionRule } from "./api.js";
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
  const [itemName, setItemName] = useState(current?.items?.[0]?.itemName ?? "");
  const [itemAmount, setItemAmount] = useState(current?.items?.[0] ? String(current.items[0].amountMinor / 100) : "");
  const [itemKind, setItemKind] = useState<"fixed" | "variable">(current?.items?.[0]?.itemKind ?? "fixed");
  const [includeOvertime, setIncludeOvertime] = useState(Boolean(current?.items?.[0]?.includeOvertime));
  const [includeInsurance, setIncludeInsurance] = useState(Boolean(current?.items?.[0]?.includeInsurance));
  const [includeTax, setIncludeTax] = useState(current?.items?.[0] ? Boolean(current.items[0].includeTax) : true);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();

  return <Dialog title="新增敘薪版本" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const numericAmount = Number(amount);
    if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) { setMessage("請輸入非負整數的薪資金額（元）。"); return; }
    setMessage(null);
    const itemValue = Number(itemAmount);
    if (itemName.trim() && (!Number.isSafeInteger(itemValue) || itemValue < 0)) { setMessage("薪資項目金額必須是非負整數元。"); return; }
    save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: { validFrom, validTo: validTo || null, payBasis, baseAmountMinor: numericAmount * 100, note, items: itemName.trim() ? [{ itemName: itemName.trim(), amountMinor: itemValue * 100, itemKind, includeOvertime, includeInsurance, includeTax }] : [] } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>保存敘薪</Button>}>
    <p>敘薪採版本保存；新增版本的生效期間不能覆蓋既有薪資版本。</p>
    <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <SelectField label="薪資計算方式" value={payBasis} options={[{ value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }]} onChange={(event) => setPayBasis(event.target.value as CompensationVersion["payBasis"])} />
    <TextField label="金額（元）" type="number" min="0" step="1" value={amount} required onChange={(event) => setAmount(event.target.value)} />
    <div className="form-grid two"><TextField label="薪資項目（可留空）" value={itemName} onChange={(event) => setItemName(event.target.value)} /><TextField label="項目金額（元）" type="number" min="0" step="1" value={itemAmount} onChange={(event) => setItemAmount(event.target.value)} /></div>
    <div className="form-grid two"><SelectField label="項目型態" value={itemKind} options={[{ value: "fixed", label: "固定" }, { value: "variable", label: "變動（需 HR 覆核）" }]} onChange={(event) => setItemKind(event.target.value as "fixed" | "variable")} /><label className="checkbox-field"><input type="checkbox" checked={includeOvertime} onChange={(event) => setIncludeOvertime(event.target.checked)} /> 納入加班費基礎</label></div>
    <div className="button-row"><label className="checkbox-field"><input type="checkbox" checked={includeInsurance} onChange={(event) => setIncludeInsurance(event.target.checked)} /> 納入勞健保基礎</label><label className="checkbox-field"><input type="checkbox" checked={includeTax} onChange={(event) => setIncludeTax(event.target.checked)} /> 計入應稅所得</label></div>
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}

function InsuranceEditor({ employment, current, onClose }: { employment: Employment; current?: InsuranceVersion; onClose: () => void }) {
  const [scheme, setScheme] = useState<InsuranceVersion["scheme"]>(current?.scheme ?? "labor");
  const [status, setStatus] = useState<InsuranceVersion["status"]>(current?.status ?? "enrolled");
  const [validFrom, setValidFrom] = useState(current?.validFrom ?? (employment.hiredOn > taipeiToday() ? employment.hiredOn : taipeiToday()));
  const [validTo, setValidTo] = useState(current?.validTo ?? "");
  const [insuredAmount, setInsuredAmount] = useState(current ? String(current.insuredAmountMinor / 100) : "");
  const [dependentCount, setDependentCount] = useState(String(current?.dependentCount ?? 0));
  const [rateYear, setRateYear] = useState(String(current?.rateYear ?? Number(taipeiToday().slice(0, 4))));
  const [sourceKind, setSourceKind] = useState<InsuranceVersion["sourceKind"]>(current?.sourceKind ?? "official");
  const [sourceUrl, setSourceUrl] = useState(current?.sourceUrl ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const brackets = useHrQuery<{ tables: InsuranceBracketTable[] }>(`/insurance-brackets?year=${encodeURIComponent(rateYear)}`, sourceKind === "official");
  const save = useHrWrite();
  const table = brackets.data?.tables.find((item) => item.scheme === scheme);
  return <Dialog title={`${scheme === "labor" ? "勞保" : "健保"}版本`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const amount = Number(insuredAmount);
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER / 100) return;
    save.mutate({ path: `/employments/${employment.id}/insurance`, method: "POST", values: { scheme, status, validFrom, validTo: validTo || null, insuredAmountMinor: amount * 100, dependentCount: Number(dependentCount), rateYear: Number(rateYear), sourceKind, sourceUrl, note } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>保存保險版本</Button>}>
    <Alert tone="info">級距只保存官方來源與投保金額；實際員工負擔費率須由公司採用規則另行確認，不以前端常數猜測法定金額。</Alert>
    <div className="form-grid two"><SelectField label="保險種類" value={scheme} options={[{ value: "labor", label: "勞保" }, { value: "health", label: "健保" }]} onChange={(event) => setScheme(event.target.value as InsuranceVersion["scheme"])} /><SelectField label="狀態" value={status} options={[{ value: "enrolled", label: "加保" }, { value: "withdrawn", label: "退保" }]} onChange={(event) => setStatus(event.target.value as InsuranceVersion["status"])} /></div>
    <div className="form-grid two"><TextField label="生效日" type="date" required value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /><TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} /></div>
    <div className="form-grid two"><SelectField label="資料來源" value={sourceKind} options={[{ value: "official", label: "官方級距" }, { value: "manual", label: "人工覆核" }]} onChange={(event) => setSourceKind(event.target.value as InsuranceVersion["sourceKind"])} /><TextField label="費率年度" type="number" min="1900" max="9999" step="1" value={rateYear} onChange={(event) => setRateYear(event.target.value)} /></div>
    {sourceKind === "official" && brackets.error ? <Alert tone="danger">{brackets.error.message}</Alert> : null}
    {sourceKind === "official" && table ? <SelectField label="官方級距" value={insuredAmount} options={[{ value: "", label: "請選擇級距" }, ...table.brackets.map((bracket) => ({ value: String(bracket.insuredAmount), label: `${bracket.lowerSalary.toLocaleString()}～${bracket.upperSalary?.toLocaleString() ?? "以上"}（投保 ${bracket.insuredAmount.toLocaleString()}）` }))]} onChange={(event) => { setInsuredAmount(event.target.value); setSourceUrl(table.sourceUrl); }} /> : null}
    <TextField label="投保金額（元）" type="number" min="0" step="1" required value={insuredAmount} onChange={(event) => setInsuredAmount(event.target.value)} />
    {scheme === "health" ? <TextField label="眷屬人數" type="number" min="0" max="3" step="1" value={dependentCount} onChange={(event) => setDependentCount(event.target.value)} /> : null}
    <TextField label="來源 URL" maxLength={500} value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
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
  const [insuranceEditing, setInsuranceEditing] = useState<InsuranceVersion | null>(null);
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
      <td>{canWrite && employment ? <div className="row-actions"><Button variant="secondary" onClick={() => setEditing(true)}>新增敘薪</Button><Button variant="secondary" onClick={() => setInsuranceEditing({ id: "", employmentId: employment.id, scheme: "labor", status: "enrolled", versionNumber: 0, validFrom: "", validTo: null, insuredAmountMinor: 0, dependentCount: 0, rateYear: Number(taipeiToday().slice(0, 4)), sourceKind: "official", sourceUrl: "", note: "", createdAt: "", createdBy: "" })}>新增保險</Button></div> : null}</td>
    </tr>
    {employment ? <tr className="hr-insurance-summary"><td colSpan={6}><strong>保險：</strong> 勞保 {profile.data?.insurance?.find((item) => item.scheme === "labor" && item.status === "enrolled") ? `${(profile.data.insurance.find((item) => item.scheme === "labor" && item.status === "enrolled")!.insuredAmountMinor / 100).toLocaleString()} 元` : "未設定"} ／ 健保 {profile.data?.insurance?.find((item) => item.scheme === "health" && item.status === "enrolled") ? `${(profile.data.insurance.find((item) => item.scheme === "health" && item.status === "enrolled")!.insuredAmountMinor / 100).toLocaleString()} 元` : "未設定"}{canWrite ? <Button variant="secondary" onClick={() => setInsuranceEditing({ id: "", employmentId: employment.id, scheme: "labor", status: "enrolled", versionNumber: 0, validFrom: "", validTo: null, insuredAmountMinor: 0, dependentCount: 0, rateYear: Number(taipeiToday().slice(0, 4)), sourceKind: "official", sourceUrl: "", note: "", createdAt: "", createdBy: "" })}>管理版本</Button> : null}</td></tr> : null}
    {editing && employment ? <CompensationEditor employment={employment} current={current} onClose={() => setEditing(false)} /> : null}
    {insuranceEditing && employment ? <InsuranceEditor employment={employment} current={insuranceEditing.id ? insuranceEditing : undefined} onClose={() => { setInsuranceEditing(null); void profile.refetch(); }} /> : null}
  </>;
}

function WorkerCompensationRow({ worker, canWrite, onEdit }: { worker: ScheduleWorkerRecord; canWrite: boolean; onEdit: () => void }) {
  const current = currentVersion(worker.compensation);
  return <tr><td><strong>{worker.displayName}</strong><br /><span className="muted">排班支援人員</span></td><td>日薪</td><td className="numeric">{current ? money(current.baseAmountMinor) : "尚未設定"}</td><td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td><td>{canWrite ? <Button variant="secondary" onClick={onEdit}>新增版本</Button> : null}</td></tr>;
}

export function HrCompensationManagement({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
  usePageTitle(settingsOnly ? "制度設定" : "敘薪管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.roles.includes("admin") ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canWrite = isHrAdministrator && permissions.has("hr:employee:write");
  const employees = useHrQuery<EmployeeListResponse>("/employees?page=1&pageSize=100&status=active&sortField=name&sortDirection=asc", !settingsOnly && canRead && permissions.has("hr:employee:read"));
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers", !settingsOnly && canRead && permissions.has("hr:schedule:read"));
  const rates = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${new Date().getFullYear()}`, canRead);
  const contributionRules = useHrQuery<{ rules: InsuranceContributionRule[] }>("/insurance-contribution-rules", canRead);
  const syncRates = useHrWrite<{ tables: InsuranceRateTableRecord[] }>();
  const createContribution = useHrWrite();
  const [contributionScheme, setContributionScheme] = useState<"labor" | "health">("labor");
  const [contributionFrom, setContributionFrom] = useState(taipeiToday().slice(0, 7) + "-01");
  const [employeeRate, setEmployeeRate] = useState("");
  const [employerRate, setEmployerRate] = useState("");
  const [dependentRate, setDependentRate] = useState("100");
  const activateRate = useHrWrite();
  const [editingWorker, setEditingWorker] = useState<ScheduleWorkerRecord | null>(null);
  if (!canRead) return <Alert tone="danger">敘薪明細僅限全平台 HR 管理者查看。</Alert>;
  return <div className="page">
    <PageHeader title={settingsOnly ? "制度設定" : "敘薪管理"} description={settingsOnly ? "管理官方勞健保級距與公司採用的負擔規則；薪資結算只使用已保存的設定。" : "設定每位員工的薪資計算方式與生效版本；薪資變更不覆蓋歷史，薪資結算會讀取指定月份有效的敘薪版本。"} />
    {!settingsOnly ? <Alert tone="info">先在這裡完成員工敘薪與保險生效版本，再到「獎金管理」套用業績 policy；最後於「薪資結算」直接計算指定月份薪資。</Alert> : null}
    <Panel><div className="panel-head"><div><h2>官方勞健保級距</h2><p className="muted">同步後先以草稿保存，HR 審閱來源與級距後再啟用；不直接覆蓋目前採用版本。</p></div>{canWrite ? <Button icon="sync" loading={syncRates.isPending} onClick={() => syncRates.mutate({ path: "/insurance-rates/sync", method: "POST", values: { year: new Date().getFullYear() } }, { onSuccess: () => void rates.refetch() })}>同步本年度官方資料</Button> : null}</div>{rates.error || syncRates.error ? <Alert tone="danger">{rates.error?.message ?? syncRates.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>年度</th><th>狀態</th><th>級距筆數</th><th>抓取時間</th><th>操作</th></tr></thead><tbody>{(rates.data?.tables ?? []).map((table) => <tr key={table.id}><td>{table.scheme === "labor" ? "勞保" : "健保"}</td><td>{table.year}</td><td>{table.status === "draft" ? "待審閱" : table.status === "active" ? "目前啟用" : "封存"}</td><td>{table.brackets.length}</td><td>{table.fetchedAt}</td><td>{canWrite && table.status === "draft" ? <Button variant="secondary" loading={activateRate.isPending} onClick={() => activateRate.mutate({ path: `/insurance-rates/${table.id}/activate`, method: "POST", values: {} }, { onSuccess: () => void rates.refetch() })}>審閱後啟用</Button> : null}</td></tr>)}</tbody></table></div></Panel>
    <Panel><div className="panel-head"><div><h2>公司負擔規則</h2><p className="muted">費率與眷屬計算方式必須由公司確認後輸入；薪資只使用生效日涵蓋結算月份的規則。</p></div></div><div className="admin-form toolbar"><SelectField label="種類" value={contributionScheme} options={[{ value: "labor", label: "勞保" }, { value: "health", label: "健保" }]} onChange={(event) => setContributionScheme(event.target.value as "labor" | "health")} /><TextField label="生效日" type="date" value={contributionFrom} onChange={(event) => setContributionFrom(event.target.value)} /><TextField label="員工負擔（%）" type="number" min="0" max="100" step="0.0001" value={employeeRate} onChange={(event) => setEmployeeRate(event.target.value)} /><TextField label="雇主負擔（%）" type="number" min="0" max="100" step="0.0001" value={employerRate} onChange={(event) => setEmployerRate(event.target.value)} />{contributionScheme === "health" ? <TextField label="眷屬倍率（%）" type="number" min="0" max="100" step="0.0001" value={dependentRate} onChange={(event) => setDependentRate(event.target.value)} /> : null}{canWrite ? <Button icon="plus" loading={createContribution.isPending} disabled={!employeeRate || !employerRate} onClick={() => createContribution.mutate({ path: "/insurance-contribution-rules", method: "POST", values: { scheme: contributionScheme, validFrom: contributionFrom, validTo: null, employeeRatePpm: Math.round(Number(employeeRate) * 10_000), employerRatePpm: Math.round(Number(employerRate) * 10_000), dependentRatePpm: Math.round(Number(dependentRate || "100") * 10_000), sourceKind: "manual", note: "公司確認規則" } }, { onSuccess: () => { setEmployeeRate(""); setEmployerRate(""); void contributionRules.refetch(); } })}>保存負擔規則</Button> : null}</div>{contributionRules.error || createContribution.error ? <Alert tone="danger">{contributionRules.error?.message ?? createContribution.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>生效日</th><th>員工</th><th>雇主</th><th>眷屬倍率</th></tr></thead><tbody>{(contributionRules.data?.rules ?? []).map((rule) => <tr key={rule.id}><td>{rule.scheme === "labor" ? "勞保" : "健保"}</td><td>{rule.validFrom}</td><td>{(rule.employeeRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.employerRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.dependentRatePpm / 10_000).toFixed(4)}%</td></tr>)}</tbody></table></div></Panel>
    {!settingsOnly ? <>
      {!canWrite ? <Alert tone="info">目前帳號只有敘薪檢視權限，無法新增薪資版本。</Alert> : null}
      <Panel>
      <div className="panel-head"><div><h2>員工敘薪</h2><p>月薪、日薪與時薪都以版本保存；勞保與健保也需分別建立生效版本。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>方式</th><th className="numeric">金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <EmployeeCompensationRow key={employee.userId} employee={employee} canWrite={canWrite} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">尚無啟用中的員工。</p> : null}
    </Panel>
      {permissions.has("hr:schedule:read") ? <Panel><div className="panel-head"><div><h2>排班支援人員</h2><p>沒有平台帳號的支援人員只可從月曆排班加入，薪資結算依已發布排班日數計算，不參與獎金。</p></div></div>{workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}<div className="table-scroll"><table className="data-table"><thead><tr><th>人員</th><th>方式</th><th className="numeric">目前金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>{(workers.data?.workers ?? []).map((worker) => <WorkerCompensationRow key={worker.id} worker={worker} canWrite={canWrite} onEdit={() => setEditingWorker(worker)} />)}</tbody></table></div>{!workers.error && !workers.data?.workers.length ? <p className="empty-state">尚無排班支援人員。</p> : null}</Panel> : null}
      {editingWorker ? <WorkerCompensationEditor worker={editingWorker} onClose={() => setEditingWorker(null)} /> : null}
    </> : null}
  </div>;
}
