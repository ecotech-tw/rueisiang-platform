import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Panel, PageHeader, SelectField, TextField } from "../../ui/index.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type Employee, type Profile, type ScheduleWorkerRecord, type SpecialWorkdayRule, type SpecialWorkdayAssignment } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface EmployeeListResponse { employees: Employee[] }
interface AllowanceDraft { itemName: string; amount: string }
export interface OvertimeRuleDraft { fromHours: string; toHours: string; rateKind: "fixed_hourly" | "multiplier"; amount: string }
function today() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function money(minor: number) { return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`; }
function parseHours(value: string, minimumHours: number) {
  if (!value.trim()) return null;
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= minimumHours && Number.isSafeInteger(hours * 2) ? hours * 2 : null;
}
export function parseFromHours(value: string) {
  const halfHours = parseHours(value, 0);
  return halfHours === null ? null : halfHours + 1;
}
export function parseToHours(value: string) { return parseHours(value, 0.5); }
export function fromHoursText(halfHours: number) { return ((halfHours - 1) / 2).toFixed(1); }
export function toHoursText(halfHours: number) { return (halfHours / 2).toFixed(1); }
export function nextOvertimeRule(rules: OvertimeRuleDraft[]): OvertimeRuleDraft {
  const last = rules.at(-1);
  const nextStart = last?.toHours.trim() && Number.isFinite(Number(last.toHours)) ? Number(last.toHours).toFixed(1) : "0.0";
  return { fromHours: nextStart, toHours: "", rateKind: "multiplier", amount: "133.33" };
}

function RuleDialog({ rule, onClose }: { rule?: SpecialWorkdayRule; onClose: () => void }) {
  const current = rule?.versions.at(-1);
  const [name, setName] = useState(rule?.rule.name ?? "");
  const [validFrom, setValidFrom] = useState(current?.validFrom ?? today());
  const [validTo, setValidTo] = useState(current?.validTo ?? "");
  const [wageKind, setWageKind] = useState<"fixed_hourly" | "multiplier">(current?.wageKind ?? "fixed_hourly");
  const [amount, setAmount] = useState(current ? String((current.fixedAmountMinor ?? 0) / 100) : "");
  const [multiplier, setMultiplier] = useState(current ? String((current.multiplierPpm ?? 1_000_000) / 10_000) : "100");
  const [overtimeRules, setOvertimeRules] = useState<OvertimeRuleDraft[]>(() => (current?.overtimeRules ?? []).map((overtimeRule) => ({ fromHours: fromHoursText(overtimeRule.fromHalfHours), toHours: overtimeRule.toHalfHours === null ? "" : toHoursText(overtimeRule.toHalfHours), rateKind: overtimeRule.rateKind, amount: overtimeRule.rateKind === "fixed_hourly" ? String((overtimeRule.fixedAmountMinor ?? 0) / 100) : String((overtimeRule.multiplierPpm ?? 1_000_000) / 10_000) })));
  const [allowances, setAllowances] = useState<AllowanceDraft[]>(() => (current?.allowances ?? []).map((allowance) => ({ itemName: allowance.itemName, amount: String(allowance.unitAmountMinor / 100) })));
  const [note, setNote] = useState(current?.note ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const updateOvertimeRule = (index: number, patch: Partial<OvertimeRuleDraft>) => setOvertimeRules((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const updateAllowance = (index: number, patch: Partial<AllowanceDraft>) => setAllowances((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const filledOvertimeRules = overtimeRules.filter((overtimeRule) => overtimeRule.fromHours.trim() || overtimeRule.toHours.trim() || overtimeRule.amount.trim());
    const parsedOvertimeRules = [] as Array<{ fromHalfHours: number; toHalfHours: number | null; rateKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null }>;
    for (const [index, overtimeRule] of filledOvertimeRules.entries()) {
      const fromHalfHours = parseFromHours(overtimeRule.fromHours);
      const toHalfHours = overtimeRule.toHours.trim() ? parseToHours(overtimeRule.toHours) : null;
      const amount = Number(overtimeRule.amount);
      if (fromHalfHours === null || overtimeRule.toHours.trim() && toHalfHours === null || toHalfHours !== null && toHalfHours < fromHalfHours) { setMessage(`第 ${index + 1} 筆加班級距的時數範圍不正確，請以 0.5 小時為單位填寫。`); return; }
      if (!Number.isFinite(amount) || amount < 0 || overtimeRule.rateKind === "fixed_hourly" && (!Number.isSafeInteger(amount) || !Number.isSafeInteger(amount * 100)) || overtimeRule.rateKind === "multiplier" && !Number.isSafeInteger(Math.round(amount * 10_000))) { setMessage(`第 ${index + 1} 筆加班規則的金額或倍率不正確。`); return; }
      parsedOvertimeRules.push({ fromHalfHours, toHalfHours, rateKind: overtimeRule.rateKind, fixedAmountMinor: overtimeRule.rateKind === "fixed_hourly" ? amount * 100 : null, multiplierPpm: overtimeRule.rateKind === "multiplier" ? Math.round(amount * 10_000) : null });
    }
    const sortedOvertimeRules = parsedOvertimeRules.slice().sort((left, right) => left.fromHalfHours - right.fromHalfHours);
    if (sortedOvertimeRules.length && sortedOvertimeRules[0]!.fromHalfHours !== 1) { setMessage("特殊日加班級距要從 0.0 小時起算。若不需要特殊加班規則，請不要新增級距。"); return; }
    for (let index = 1; index < sortedOvertimeRules.length; index += 1) {
      const previous = sortedOvertimeRules[index - 1]!;
      if (previous.toHalfHours === null || sortedOvertimeRules[index]!.fromHalfHours !== previous.toHalfHours + 1) { setMessage("特殊日加班級距不可重疊或留空段，請調整起訖時數。 "); return; }
    }
    const filledAllowances = allowances.filter((allowance) => allowance.itemName.trim() || allowance.amount.trim());
    const parsedAllowances = [] as Array<{ itemName: string; unitAmountMinor: number }>;
    for (const [index, allowance] of filledAllowances.entries()) {
      const amount = Number(allowance.amount);
      if (!allowance.itemName.trim() || !Number.isSafeInteger(amount) || amount < 0) { setMessage(`第 ${index + 1} 筆補貼請填寫名稱與非負整數金額。`); return; }
      parsedAllowances.push({ itemName: allowance.itemName.trim(), unitAmountMinor: amount * 100 });
    }
    setMessage(null);
    const values = { name, validFrom, validTo: validTo || null, wageKind, fixedAmountMinor: wageKind === "fixed_hourly" ? Math.round(Number(amount) * 100) : null, multiplierPpm: wageKind === "multiplier" ? Math.round(Number(multiplier) * 10_000) : null, overtimeRules: sortedOvertimeRules, note: note.trim(), allowances: parsedAllowances };
    save.mutate({ path: rule ? `/special-workdays/rules/${rule.rule.id}/versions` : "/special-workdays/rules", method: "POST", values }, { onSuccess: onClose });
  };
  return <Dialog title={rule ? `建立「${rule.rule.name}」新版本` : "新增特殊上班日規則"} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: submit }} actions={<Button type="submit" loading={save.isPending}>保存規則</Button>}>
    {!rule ? <TextField label="規則名稱" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /> : <p>規則名稱：<strong>{rule.rule.name}</strong>（歷史版本不覆寫）</p>}
    <div className="form-grid two"><TextField label="生效日" type="date" required value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /><TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} /></div>
    <div className="form-grid two"><SelectField label="薪資方式" value={wageKind} options={[{ value: "fixed_hourly", label: "固定每小時金額" }, { value: "multiplier", label: "依底薪總倍率" }]} onChange={(event) => setWageKind(event.target.value as "fixed_hourly" | "multiplier")} />{wageKind === "fixed_hourly" ? <TextField label="固定每小時（元）" type="number" min="0" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} /> : <TextField label="總倍率（%）" type="number" min="0" step="0.01" required value={multiplier} onChange={(event) => setMultiplier(event.target.value)} />}</div>
    <div className="salary-items special-overtime-items">
      <span className="salary-items-label">特殊日加班費規則</span>
      <p className="form-hint">以累計加班時數設定半開區間：起始含、迄止不含；第一段從 0.0 小時起算，例如 0.0～2.0、2.0～不限。</p>
      {overtimeRules.map((overtimeRule, index) => <div className="special-overtime-item-row" key={`overtime-rule-${index}`}>
        <TextField label="起始（含，小時）" aria-label={`第 ${index + 1} 筆加班規則起始時數`} type="number" min="0" step="0.5" value={overtimeRule.fromHours} onChange={(event) => updateOvertimeRule(index, { fromHours: event.target.value })} />
        <TextField label="迄止（不含，可留空）" aria-label={`第 ${index + 1} 筆加班規則迄止時數`} type="number" min="0.5" step="0.5" value={overtimeRule.toHours} onChange={(event) => updateOvertimeRule(index, { toHours: event.target.value })} />
        <SelectField label="計算方式" aria-label={`第 ${index + 1} 筆加班規則計算方式`} value={overtimeRule.rateKind} options={[{ value: "multiplier", label: "依底薪總倍率" }, { value: "fixed_hourly", label: "固定每小時" }]} onChange={(event) => updateOvertimeRule(index, { rateKind: event.target.value as OvertimeRuleDraft["rateKind"], amount: "" })} />
        <TextField label="總倍率／每小時（元）" aria-label={`第 ${index + 1} 筆加班規則${overtimeRule.rateKind === "multiplier" ? "總倍率" : "每小時金額"}`} type="number" min="0" step={overtimeRule.rateKind === "multiplier" ? "0.01" : "1"} value={overtimeRule.amount} onChange={(event) => updateOvertimeRule(index, { amount: event.target.value })} />
        <Button variant="icon" icon="trash" aria-label={`刪除第 ${index + 1} 筆特殊日加班規則`} onClick={() => setOvertimeRules((items) => items.filter((_, itemIndex) => itemIndex !== index))} />
      </div>)}
      {!overtimeRules.length ? <p className="muted special-overtime-items-empty">尚未設定特殊日加班費，會沿用一般加班規則。</p> : null}
      <div className="salary-items-foot"><Button type="button" variant="secondary" icon="plus" disabled={overtimeRules.length >= 50 || overtimeRules.some((rule) => !rule.toHours.trim())} onClick={() => setOvertimeRules((items) => [...items, nextOvertimeRule(items)])}>新增規則</Button></div>
    </div>
    <div className="salary-items special-allowance-items">
      <span className="salary-items-label">補貼項目</span>
      <div className="salary-items-head"><span>項目</span><span>補貼單價（元）</span><span className="salary-item-spacer" aria-hidden="true" /></div>
      {allowances.map((allowance, index) => <div className="salary-item-row" key={`allowance-${index}`}>
        <TextField aria-label={`補貼項目 ${index + 1}`} value={allowance.itemName} onChange={(event) => updateAllowance(index, { itemName: event.target.value })} />
        <TextField aria-label={`${allowance.itemName.trim() || "補貼項目"}單價（元）`} type="number" min="0" step="1" value={allowance.amount} onChange={(event) => updateAllowance(index, { amount: event.target.value })} />
        <Button variant="icon" icon="trash" aria-label={`刪除${allowance.itemName.trim() || `第 ${index + 1} 筆補貼`}`} onClick={() => setAllowances((items) => items.filter((_, itemIndex) => itemIndex !== index))} />
      </div>)}
      {!allowances.length ? <p className="muted special-allowance-items-empty">尚未設定補貼。</p> : null}
      <div className="salary-items-foot"><Button type="button" variant="secondary" icon="plus" disabled={allowances.length >= 50} onClick={() => setAllowances((items) => [...items, { itemName: "", amount: "" }])}>新增補貼</Button></div>
    </div>
    <TextField label="備註（選填）" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

function AssignDialog({ rules, onClose }: { rules: SpecialWorkdayRule[]; onClose: () => void }) {
  const [versionId, setVersionId] = useState(rules[0]?.versions.at(-1)?.id ?? "");
  const [employeeUserId, setEmployeeUserId] = useState("");
  const [workerId, setWorkerId] = useState("");
  const [workDate, setWorkDate] = useState(today());
  const [quantity, setQuantity] = useState("0");
  const employees = useHrQuery<EmployeeListResponse>(HR_ROSTER_PATH);
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers");
  const profile = useHrQuery<Profile>(employeeUserId ? `/employees/${encodeURIComponent(employeeUserId)}` : "/employees/__none__", Boolean(employeeUserId), { keepPreviousData: false });
  const save = useHrWrite();
  const employmentId = profile.data?.employments.find((item) => !item.endedOn || item.endedOn > workDate)?.id;
  const versionOptions = rules.flatMap((item) => item.versions.map((version) => ({ value: version.id, label: `${item.rule.name} v${version.versionNumber}` })));
  return <Dialog title="套用特殊上班日" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => { event.preventDefault(); save.mutate({ path: "/special-workdays/assignments", method: "POST", values: { ruleVersionId: versionId, assignments: [{ employmentId: workerId ? undefined : employmentId, workerId: workerId || undefined, workDate, allowanceQuantity: Number(quantity) }] } }, { onSuccess: onClose }); } }} actions={<Button type="submit" loading={save.isPending} disabled={!versionId || (!employmentId && !workerId)}>套用日期</Button>}>
    <SelectField label="規則版本" value={versionId} options={versionOptions} onChange={(event) => setVersionId(event.target.value)} /><div className="form-grid two"><SelectField label="員工" value={employeeUserId} options={[{ value: "", label: "不指定員工" }, ...(employees.data?.employees ?? []).map((item) => ({ value: item.userId, label: `${item.displayName}（${item.employeeNumber}）` }))]} onChange={(event) => { setEmployeeUserId(event.target.value); setWorkerId(""); }} /><SelectField label="支援人員" value={workerId} options={[{ value: "", label: "不指定支援人員" }, ...(workers.data?.workers ?? []).filter((item) => item.active).map((item) => ({ value: item.id, label: item.displayName }))]} onChange={(event) => { setWorkerId(event.target.value); setEmployeeUserId(""); }} /></div><div className="form-grid two"><TextField label="日期" type="date" required value={workDate} onChange={(event) => setWorkDate(event.target.value)} /><TextField label="補貼數量" type="number" min="0" step="1" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></div><p className="form-hint">同一人員同一天只能套用一個規則；套用時會保存規則與補貼快照。</p>{save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}</Dialog>;
}

export function HrSpecialWorkdays() {
  usePageTitle("特殊上班日");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read"); const canWrite = permissions.has("hr:office:write");
  const rules = useHrQuery<{ rules: SpecialWorkdayRule[] }>("/special-workdays/rules", canRead);
  const assignments = useHrQuery<{ assignments: SpecialWorkdayAssignment[] }>("/special-workdays/assignments", canRead);
  const toggleRule = useHrWrite();
  const [editor, setEditor] = useState<"new" | SpecialWorkdayRule | "assign" | null>(null);
  const rows = useMemo(() => rules.data?.rules ?? [], [rules.data]);
  if (!canRead) return <Alert tone="danger">你沒有檢視特殊上班日規則的權限。</Alert>;
  if (rules.isPending || assignments.isPending) return <HrPageSkeleton variant="table" />;
  return <div className="page fills"><PageHeader title="特殊上班日" description="先建立可重複使用的規則，再按需要套用到員工或支援人員日期；套用不等於打卡，也不等於加班核准。" actions={canWrite ? <div className="button-row"><Button variant="secondary" onClick={() => setEditor("assign")} disabled={!rows.length}>套用到員工日期</Button><Button icon="plus" onClick={() => setEditor("new")}>新增規則</Button></div> : undefined} />
    {rules.error || assignments.error || toggleRule.error ? <Alert tone="danger">{rules.error?.message ?? assignments.error?.message ?? toggleRule.error?.message}</Alert> : null}<Alert tone="info">固定特殊薪資取代當日底薪；特殊上班日缺少月度工時資料時，薪資試算會列異常而不自行補 0。加班仍須另行申請與核准，核准後依特殊日級距或一般加班規則計算。</Alert>
    <Panel><div className="panel-head"><div><h2>規則主檔</h2><p className="muted">建立新版本不覆寫歷史；停用後不可新增日期套用。</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>規則</th><th>版本／期間</th><th>薪資方式</th><th>特殊日加班</th><th>狀態</th><th>操作</th></tr></thead><tbody>{rows.map((item) => { const version = item.versions.at(-1)!; return <tr key={item.rule.id}><td><strong>{item.rule.name}</strong></td><td>v{version.versionNumber}・{version.validFrom}～{version.validTo ?? "目前"}</td><td>{version.wageKind === "fixed_hourly" ? `每小時 ${money(version.fixedAmountMinor ?? 0)}` : `總倍率 ${((version.multiplierPpm ?? 0) / 10_000).toFixed(2)}%`}</td><td>{version.overtimeRules.length ? `${version.overtimeRules.length} 個級距` : "沿用一般規則"}</td><td>{item.rule.active ? "啟用" : "停用"}</td><td>{canWrite ? <div className="row-actions"><Button variant="secondary" onClick={() => setEditor(item)}>新增版本</Button><Button variant="secondary" onClick={() => toggleRule.mutate({ path: `/special-workdays/rules/${item.rule.id}/status`, method: "POST", values: { active: !item.rule.active } }, { onSuccess: () => void rules.refetch() })}>{item.rule.active ? "停用" : "啟用"}</Button></div> : null}</td></tr>; })}</tbody></table></div>{!rows.length ? <p className="empty-state">尚未建立特殊上班日規則。</p> : null}</Panel>
    <Panel className="grows"><div className="panel-head"><div><h2>日期套用紀錄</h2><p className="muted">套用時保存規則名稱、薪資設定與補貼數量快照。</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>人員</th><th>日期</th><th>規則</th><th>薪資方式</th><th>補貼數量</th><th>套用時間</th></tr></thead><tbody>{(assignments.data?.assignments ?? []).map((item) => <tr key={item.assignment.id}><td>{item.employeeName ?? item.workerName ?? "—"}</td><td>{item.assignment.workDate}</td><td>{item.assignment.ruleNameSnapshot}</td><td>{item.assignment.wageKindSnapshot}</td><td>{item.assignment.allowanceQuantity}</td><td>{item.assignment.appliedAt}</td></tr>)}</tbody></table></div>{!assignments.data?.assignments.length ? <p className="empty-state">尚未有日期套用紀錄。</p> : null}</Panel>
    {editor === "new" ? <RuleDialog onClose={() => { setEditor(null); void rules.refetch(); }} /> : null}{editor && editor !== "new" && editor !== "assign" ? <RuleDialog rule={editor} onClose={() => { setEditor(null); void rules.refetch(); }} /> : null}{editor === "assign" ? <AssignDialog rules={rows} onClose={() => { setEditor(null); void assignments.refetch(); }} /> : null}
  </div>;
}
