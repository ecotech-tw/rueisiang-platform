import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type Profile, type ScheduleWorkerRecord, type InsuranceRateTableRecord, type InsuranceContributionRule } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { HrPageSkeleton, HrSkeletonTableRow } from "./HrSkeleton.js";

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

/**
 * 敘薪 Dialog 自己選員工：從上方「新增敘薪」進來時還沒選人，從列上的按鈕進來時預選那一位。
 *
 * 這個元件掛在頁面層，不掛在 <tr> 裡——對話框的 <div> 放進 <tbody> 是不合法的 HTML，
 * 瀏覽器會把它搬走，遮罩與定位就整個跑掉。
 */
function CompensationEditor({ employees, initialUserId, onClose }: { employees: Employee[]; initialUserId: string | null; onClose: () => void }) {
  const [userId, setUserId] = useState(initialUserId ?? "");
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(userId)}`, Boolean(userId));
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const current = useMemo(() => employment
    ? currentVersion((profile.data?.compensation ?? []).filter((version) => version.employmentId === employment.id))
    : undefined, [profile.data?.compensation, employment?.id]);

  const [validFrom, setValidFrom] = useState(taipeiToday());
  const [validTo, setValidTo] = useState("");
  const [payBasis, setPayBasis] = useState<CompensationVersion["payBasis"]>("monthly");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemAmount, setItemAmount] = useState("");
  const [itemKind, setItemKind] = useState<"fixed" | "variable">("fixed");
  const [includeOvertime, setIncludeOvertime] = useState(false);
  const [includeInsurance, setIncludeInsurance] = useState(false);
  const [includeTax, setIncludeTax] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();

  // 換一位員工就重新帶入那個人目前的敘薪當預設值，不沿用上一個人的金額。
  useEffect(() => {
    const today = taipeiToday();
    const item = current?.items?.[0];
    // 任職已結束的人，今天已經落在任職期間外；後端要求版本整段都在任職期間內，
    // 所以改從到職日起算，並把任職結束日帶成迄日，否則一定存不進去。
    const endedOn = employment?.endedOn ?? null;
    setValidFrom(!employment ? today : employment.hiredOn > today || (endedOn && today >= endedOn) ? employment.hiredOn : today);
    setValidTo(endedOn ?? "");
    setPayBasis(current?.payBasis ?? "monthly");
    setAmount(current ? String(current.baseAmountMinor / 100) : "");
    setItemName(item?.itemName ?? "");
    setItemAmount(item ? String(item.amountMinor / 100) : "");
    setItemKind(item?.itemKind ?? "fixed");
    setIncludeOvertime(Boolean(item?.includeOvertime));
    setIncludeInsurance(Boolean(item?.includeInsurance));
    setIncludeTax(item ? Boolean(item.includeTax) : true);
    setNote(current?.note ?? "");
    setMessage(null);
  }, [current, employment]);

  const selected = employees.find((employee) => employee.userId === userId);

  return <Dialog
    title="新增敘薪"
    titleMeta={selected ? `${selected.displayName}／${selected.employeeNumber}` : "選一位員工後填寫薪資組成"}
    onClose={onClose}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: (event) => {
      event.preventDefault();
      if (!employment) { setMessage(userId ? "這位員工沒有任職紀錄，請先在員工列表建立任職。" : "請先選擇員工。"); return; }
      // 期間不合法時後端只回一句籠統的 409；先在這裡講清楚是哪一段超出任職期間。
      if (validFrom < employment.hiredOn) { setMessage(`生效日不能早於到職日 ${employment.hiredOn}。`); return; }
      if (employment.endedOn && (!validTo || validTo > employment.endedOn)) { setMessage(`任職已於 ${employment.endedOn} 結束，迄日要填到 ${employment.endedOn}（含）之前。`); return; }
      if (validTo && validTo <= validFrom) { setMessage("迄日必須晚於生效日。"); return; }
      const numericAmount = Number(amount);
      if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) { setMessage("請輸入非負整數的薪資金額（元）。"); return; }
      const itemValue = Number(itemAmount);
      if (itemName.trim() && (!Number.isSafeInteger(itemValue) || itemValue < 0)) { setMessage("薪資項目金額必須是非負整數元。"); return; }
      setMessage(null);
      save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: { validFrom, validTo: validTo || null, payBasis, baseAmountMinor: numericAmount * 100, note, items: itemName.trim() ? [{ itemName: itemName.trim(), amountMinor: itemValue * 100, itemKind, includeOvertime, includeInsurance, includeTax }] : [] } }, { onSuccess: onClose });
    } }}
    actions={<Button type="submit" loading={save.isPending} disabled={!employment}>保存敘薪</Button>}
  >
    <p>敘薪採版本保存；新增版本的生效期間不能覆蓋既有薪資版本。勞健保費率與投保級距由系統依已啟用的設定套用，不在這裡填。</p>
    <SelectField
      label="員工"
      value={userId}
      required
      options={[{ value: "", label: "請選擇員工" }, ...employees.map((employee) => ({ value: employee.userId, label: `${employee.displayName}／${employee.employeeNumber}` }))]}
      onChange={(event) => setUserId(event.target.value)}
    />
    {userId && profile.isPending ? <p className="muted">載入目前敘薪…</p> : null}
    {userId && !profile.isPending && !employment ? <Alert tone="warning">這位員工沒有任職紀錄，請先在員工列表建立任職。</Alert> : null}
    {employment ? <p className="form-hint">任職期間 {employment.hiredOn}～{employment.endedOn ?? "目前"}；目前敘薪 {current ? `${PAY_BASIS_LABEL[current.payBasis]} ${money(current.baseAmountMinor)}` : "尚未設定"}。</p> : null}
    <div className="form-grid two">
      <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
      <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    </div>
    <div className="form-grid two">
      <SelectField label="薪資計算方式" value={payBasis} options={[{ value: "monthly", label: "月薪" }, { value: "daily", label: "日薪" }, { value: "hourly", label: "時薪" }]} onChange={(event) => setPayBasis(event.target.value as CompensationVersion["payBasis"])} />
      <TextField label="金額（元）" type="number" min="0" step="1" value={amount} required onChange={(event) => setAmount(event.target.value)} />
    </div>
    <div className="form-grid two"><TextField label="薪資項目（可留空）" value={itemName} onChange={(event) => setItemName(event.target.value)} /><TextField label="項目金額（元）" type="number" min="0" step="1" value={itemAmount} onChange={(event) => setItemAmount(event.target.value)} /></div>
    <div className="form-grid two"><SelectField label="項目型態" value={itemKind} options={[{ value: "fixed", label: "固定" }, { value: "variable", label: "變動（需 HR 覆核）" }]} onChange={(event) => setItemKind(event.target.value as "fixed" | "variable")} /><label className="checkbox-field"><input type="checkbox" checked={includeOvertime} onChange={(event) => setIncludeOvertime(event.target.checked)} /> 納入加班費基礎</label></div>
    <div className="button-row"><label className="checkbox-field"><input type="checkbox" checked={includeInsurance} onChange={(event) => setIncludeInsurance(event.target.checked)} /> 納入勞健保基礎</label><label className="checkbox-field"><input type="checkbox" checked={includeTax} onChange={(event) => setIncludeTax(event.target.checked)} /> 計入應稅所得</label></div>
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error || profile.error ? <Alert tone="danger">{message || save.error?.message || profile.error?.message}</Alert> : null}
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

function EmployeeCompensationRow({ employee, canWrite, onEdit }: { employee: Employee; canWrite: boolean; onEdit: (userId: string) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`);
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const current = useMemo(() => employment
    ? currentVersion((profile.data?.compensation ?? []).filter((version) => version.employmentId === employment.id))
    : undefined, [profile.data?.compensation, employment?.id]);
  if (profile.isLoading) return <HrSkeletonTableRow columns={6} />;
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{current ? PAY_BASIS_LABEL[current.payBasis] : "尚未設定"}</td>
    <td className="numeric">{current ? money(current.baseAmountMinor) : "—"}</td>
    <td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td>
    <td>{canWrite && employment ? <Button variant="secondary" onClick={() => onEdit(employee.userId)}>{current ? "更新敘薪" : "新增敘薪"}</Button> : null}</td>
  </tr>;
}

function WorkerCompensationRow({ worker, canWrite, onEdit }: { worker: ScheduleWorkerRecord; canWrite: boolean; onEdit: () => void }) {
  const current = currentVersion(worker.compensation);
  return <tr><td><strong>{worker.displayName}</strong><br /><span className="muted">排班支援人員</span></td><td>日薪</td><td className="numeric">{current ? money(current.baseAmountMinor) : "尚未設定"}</td><td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td><td>{canWrite ? <Button variant="secondary" onClick={onEdit}>新增版本</Button> : null}</td></tr>;
}

export function HrCompensationManagement({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
  usePageTitle(settingsOnly ? "制度設定" : "敘薪管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canWrite = isHrAdministrator && permissions.has("hr:employee:write");
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH, !settingsOnly && canRead && permissions.has("hr:employee:read"));
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers", !settingsOnly && canRead && permissions.has("hr:schedule:read"));
  const currentYear = Number(taipeiToday().slice(0, 4));
  // 官方級距與公司負擔規則屬於「制度設定」；敘薪管理只處理員工薪資，不在這裡再開一份設定入口。
  const rates = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${currentYear}`, settingsOnly && canRead);
  const contributionRules = useHrQuery<{ rules: InsuranceContributionRule[] }>("/insurance-contribution-rules", settingsOnly && canRead);
  const syncRates = useHrWrite<{ tables: InsuranceRateTableRecord[] }>();
  const createContribution = useHrWrite();
  const [contributionScheme, setContributionScheme] = useState<"labor" | "health">("labor");
  const [contributionFrom, setContributionFrom] = useState(taipeiToday().slice(0, 7) + "-01");
  const [employeeRate, setEmployeeRate] = useState("");
  const [employerRate, setEmployerRate] = useState("");
  const [dependentRate, setDependentRate] = useState("100");
  const activateRate = useHrWrite();
  const [editingWorker, setEditingWorker] = useState<ScheduleWorkerRecord | null>(null);
  // null＝關閉；{ userId: null }＝從上方按鈕開啟、還沒選員工。
  const [editing, setEditing] = useState<{ userId: string | null } | null>(null);
  if (!canRead) return <Alert tone="danger">敘薪明細僅限全平台 HR 管理者查看。</Alert>;
  const pageLoading = settingsOnly
    ? rates.isPending || contributionRules.isPending
    : (permissions.has("hr:employee:read") && employees.isPending) || (permissions.has("hr:schedule:read") && workers.isPending);
  if (pageLoading) return <HrPageSkeleton variant="table" />;
  return <div className="page">
    <PageHeader
      title={settingsOnly ? "制度設定" : "敘薪管理"}
      description={settingsOnly ? "管理官方勞健保級距與公司採用的負擔規則；薪資結算只使用已保存的設定。" : "設定每位員工的薪資計算方式與生效版本；薪資變更不覆蓋歷史，薪資結算會讀取指定月份有效的敘薪版本。"}
      actions={!settingsOnly && canWrite ? <Button icon="plus" onClick={() => setEditing({ userId: null })}>新增敘薪</Button> : null}
    />
    {settingsOnly ? <>
      <Panel><div className="panel-head"><div><h2>官方勞健保級距</h2><p className="muted">同步後先以草稿保存，HR 審閱來源與級距後再啟用；不直接覆蓋目前採用版本。</p></div>{canWrite ? <Button icon="sync" loading={syncRates.isPending} onClick={() => syncRates.mutate({ path: "/insurance-rates/sync", method: "POST", values: { year: currentYear } }, { onSuccess: () => void rates.refetch() })}>同步本年度官方資料</Button> : null}</div>{rates.error || syncRates.error ? <Alert tone="danger">{rates.error?.message ?? syncRates.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>年度</th><th>狀態</th><th>級距筆數</th><th>抓取時間</th><th>操作</th></tr></thead><tbody>{(rates.data?.tables ?? []).map((table) => <tr key={table.id}><td>{table.scheme === "labor" ? "勞保" : "健保"}</td><td>{table.year}</td><td>{table.status === "draft" ? "待審閱" : table.status === "active" ? "目前啟用" : "封存"}</td><td>{table.brackets.length}</td><td>{table.fetchedAt}</td><td>{canWrite && table.status === "draft" ? <Button variant="secondary" loading={activateRate.isPending} onClick={() => activateRate.mutate({ path: `/insurance-rates/${table.id}/activate`, method: "POST", values: {} }, { onSuccess: () => void rates.refetch() })}>審閱後啟用</Button> : null}</td></tr>)}</tbody></table></div></Panel>
      <Panel><div className="panel-head"><div><h2>公司負擔規則</h2><p className="muted">費率與眷屬計算方式必須由公司確認後輸入；薪資只使用生效日涵蓋結算月份的規則。</p></div></div><div className="admin-form toolbar"><SelectField label="種類" value={contributionScheme} options={[{ value: "labor", label: "勞保" }, { value: "health", label: "健保" }]} onChange={(event) => setContributionScheme(event.target.value as "labor" | "health")} /><TextField label="生效日" type="date" value={contributionFrom} onChange={(event) => setContributionFrom(event.target.value)} /><TextField label="員工負擔（%）" type="number" min="0" max="100" step="0.0001" value={employeeRate} onChange={(event) => setEmployeeRate(event.target.value)} /><TextField label="雇主負擔（%）" type="number" min="0" max="100" step="0.0001" value={employerRate} onChange={(event) => setEmployerRate(event.target.value)} />{contributionScheme === "health" ? <TextField label="眷屬倍率（%）" type="number" min="0" max="100" step="0.0001" value={dependentRate} onChange={(event) => setDependentRate(event.target.value)} /> : null}{canWrite ? <Button icon="plus" loading={createContribution.isPending} disabled={!employeeRate || !employerRate} onClick={() => createContribution.mutate({ path: "/insurance-contribution-rules", method: "POST", values: { scheme: contributionScheme, validFrom: contributionFrom, validTo: null, employeeRatePpm: Math.round(Number(employeeRate) * 10_000), employerRatePpm: Math.round(Number(employerRate) * 10_000), dependentRatePpm: Math.round(Number(dependentRate || "100") * 10_000), sourceKind: "manual", note: "公司確認規則" } }, { onSuccess: () => { setEmployeeRate(""); setEmployerRate(""); void contributionRules.refetch(); } })}>保存負擔規則</Button> : null}</div>{contributionRules.error || createContribution.error ? <Alert tone="danger">{contributionRules.error?.message ?? createContribution.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>生效日</th><th>員工</th><th>雇主</th><th>眷屬倍率</th></tr></thead><tbody>{(contributionRules.data?.rules ?? []).map((rule) => <tr key={rule.id}><td>{rule.scheme === "labor" ? "勞保" : "健保"}</td><td>{rule.validFrom}</td><td>{(rule.employeeRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.employerRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.dependentRatePpm / 10_000).toFixed(4)}%</td></tr>)}</tbody></table></div></Panel>
    </> : <>
      <Alert tone="info">先在這裡完成員工敘薪，再到「勞健保管理」建立投保版本與「獎金管理」套用業績 policy；最後於「薪資結算」直接計算指定月份薪資。</Alert>
      {!canWrite ? <Alert tone="info">目前帳號只有敘薪檢視權限，無法新增薪資版本。</Alert> : null}
      <Panel>
      <div className="panel-head"><div><h2>員工敘薪</h2><p>月薪、日薪與時薪都以版本保存；勞健保版本請到「勞健保管理」建立。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>方式</th><th className="numeric">金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>
        {(employees.data?.employees ?? []).map((employee) => <EmployeeCompensationRow key={employee.userId} employee={employee} canWrite={canWrite} onEdit={(userId) => setEditing({ userId })} />)}
      </tbody></table></div>
      {!employees.data?.employees.length ? <p className="empty-state">尚無員工。</p> : null}
    </Panel>
      {permissions.has("hr:schedule:read") ? <Panel><div className="panel-head"><div><h2>排班支援人員</h2><p>沒有平台帳號的支援人員只可從月曆排班加入，薪資結算依已發布排班日數計算，不參與獎金。</p></div></div>{workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}<div className="table-scroll"><table className="data-table"><thead><tr><th>人員</th><th>方式</th><th className="numeric">目前金額</th><th>生效期間</th><th>操作</th></tr></thead><tbody>{(workers.data?.workers ?? []).map((worker) => <WorkerCompensationRow key={worker.id} worker={worker} canWrite={canWrite} onEdit={() => setEditingWorker(worker)} />)}</tbody></table></div>{!workers.error && !workers.data?.workers.length ? <p className="empty-state">尚無排班支援人員。</p> : null}</Panel> : null}
      {editing ? <CompensationEditor employees={employees.data?.employees ?? []} initialUserId={editing.userId} onClose={() => setEditing(null)} /> : null}
      {editingWorker ? <WorkerCompensationEditor worker={editingWorker} onClose={() => setEditingWorker(null)} /> : null}
    </>}
  </div>;
}
