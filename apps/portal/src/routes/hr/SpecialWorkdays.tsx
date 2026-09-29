import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Panel, PageHeader, SelectField, TextField, Tooltip } from "../../ui/index.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useHrEmployeeRoster, useHrQuery, useHrWrite, type ScheduleWorkerRecord, type SpecialWorkdayRule, type SpecialWorkdayAssignment, type SpecialWorkdayRuleVersion } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface AllowanceDraft { itemName: string; amount: string }
interface AssignmentTarget { key: string; kind: "employee" | "worker"; employmentId?: string; workerId?: string; displayName: string; secondary: string }
export const MAX_SPECIAL_WORKDAY_ASSIGNMENTS = 1000;
export interface OvertimeRuleDraft { fromHours: string; toHours: string; rateKind: "fixed_hourly" | "multiplier"; amount: string }
function today() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function nextDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function datesInRange(startDate: string, endDate: string, maxDates = MAX_SPECIAL_WORKDAY_ASSIGNMENTS + 1) {
  if (!startDate || !endDate || endDate < startDate) return [];
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate && dates.length < maxDates) {
    dates.push(current);
    current = nextDate(current);
  }
  return dates;
}
function money(minor: number) { return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`; }
function allowanceSummary(item: SpecialWorkdayAssignment) {
  try {
    const snapshot = JSON.parse(item.assignment.allowanceSnapshotJson) as unknown;
    if (Array.isArray(snapshot)) {
      const quantities = snapshot.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const allowance = value as { itemName?: unknown; quantity?: unknown };
        return typeof allowance.itemName === "string" && typeof allowance.quantity === "number" && allowance.quantity > 0 ? [`${allowance.itemName} × ${allowance.quantity}`] : [];
      });
      if (quantities.length) return quantities.join("、");
      if (snapshot.length && item.assignment.allowanceQuantity === 0) return "0";
    }
  } catch {
    // 舊資料損壞時仍顯示資料庫保留的共用數量，不讓歷史表整頁失效。
  }
  return item.assignment.allowanceQuantity > 0 ? `${item.assignment.allowanceQuantity} 次（所有補貼）` : "0";
}
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

function latestActiveVersion(rule?: SpecialWorkdayRule): SpecialWorkdayRuleVersion | undefined {
  return rule?.versions.filter((version) => !version.voidedAt).slice().sort((left, right) => right.versionNumber - left.versionNumber)[0];
}
function activeVersionOptions(rules: SpecialWorkdayRule[]) {
  return rules.flatMap((item) => item.rule.active ? item.versions.filter((version) => !version.voidedAt).map((version) => ({ value: version.id, label: `${item.rule.name} v${version.versionNumber}` })) : []);
}
export function defaultActiveVersionId(rules: SpecialWorkdayRule[]) {
  const firstActiveRule = rules.find((item) => item.rule.active);
  return latestActiveVersion(firstActiveRule)?.id ?? activeVersionOptions(rules)[0]?.value ?? "";
}

function RuleDialog({ rule, onClose }: { rule?: SpecialWorkdayRule; onClose: () => void }) {
  const current = latestActiveVersion(rule);
  const [name, setName] = useState(rule?.rule.name ?? "");
  const [validFrom, setValidFrom] = useState(current ? nextDate(current.validFrom) : today());
  const [validTo, setValidTo] = useState("");
  const [wageKind, setWageKind] = useState<"fixed_hourly" | "multiplier">(current?.wageKind ?? "fixed_hourly");
  const [amount, setAmount] = useState(current ? String((current.fixedAmountMinor ?? 0) / 100) : "");
  const [multiplier, setMultiplier] = useState(current ? String((current.multiplierPpm ?? 1_000_000) / 10_000) : "100");
  const [overtimeRules, setOvertimeRules] = useState<OvertimeRuleDraft[]>(() => (current?.overtimeRules ?? []).map((overtimeRule) => ({ fromHours: fromHoursText(overtimeRule.fromHalfHours), toHours: overtimeRule.toHalfHours === null ? "" : toHoursText(overtimeRule.toHalfHours), rateKind: overtimeRule.rateKind, amount: overtimeRule.rateKind === "fixed_hourly" ? String((overtimeRule.fixedAmountMinor ?? 0) / 100) : String((overtimeRule.multiplierPpm ?? 1_000_000) / 10_000) })));
  const [allowances, setAllowances] = useState<AllowanceDraft[]>(() => (current?.allowances ?? []).map((allowance) => ({ itemName: allowance.itemName, amount: String(allowance.unitAmountMinor / 100) })));
  const [note, setNote] = useState(current?.note ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [voidConfirmation, setVoidConfirmation] = useState(false);
  const save = useHrWrite();
  const voidVersion = useHrWrite<{ ruleId: string; versionId: string; previousVersionId: string }>();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const voidCloseRequestRef = useRef<(() => void) | null>(null);
  const canVoid = Boolean(rule && current && current.versionNumber > 1 && rule.rule.active);
  const updateOvertimeRule = (index: number, patch: Partial<OvertimeRuleDraft>) => setOvertimeRules((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const updateAllowance = (index: number, patch: Partial<AllowanceDraft>) => setAllowances((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const close = () => {
    onClose();
  };
  const voidLatest = () => {
    if (!rule || !current || !canVoid) return;
    voidVersion.mutate({ path: `/special-workdays/rules/${rule.rule.id}/versions/${current.id}/void`, method: "POST", values: {} }, {
      onSuccess: () => { if (voidCloseRequestRef.current) voidCloseRequestRef.current(); else setVoidConfirmation(false); (closeRequestRef.current ?? onClose)(); },
    });
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (current && validFrom <= current.validFrom) { setMessage(`新版本生效日必須晚於目前版本的 ${current.validFrom}；若要修正這一版，請先解除最新版本。`); return; }
    if (validTo && validTo <= validFrom) { setMessage("迄日（不含）必須晚於生效日。"); return; }
    const filledOvertimeRules = overtimeRules.filter((overtimeRule) => overtimeRule.fromHours.trim() || overtimeRule.toHours.trim() || overtimeRule.amount.trim());
    const parsedOvertimeRules = [] as Array<{ fromHalfHours: number; toHalfHours: number | null; rateKind: "fixed_hourly" | "multiplier"; fixedAmountMinor: number | null; multiplierPpm: number | null }>;
    for (const [index, overtimeRule] of filledOvertimeRules.entries()) {
      const fromHalfHours = parseFromHours(overtimeRule.fromHours);
      const toHalfHours = overtimeRule.toHours.trim() ? parseToHours(overtimeRule.toHours) : null;
      const ruleAmount = Number(overtimeRule.amount);
      if (fromHalfHours === null || overtimeRule.toHours.trim() && toHalfHours === null || toHalfHours !== null && toHalfHours < fromHalfHours) { setMessage(`第 ${index + 1} 筆加班級距的時數範圍不正確，請以 0.5 小時為單位填寫。`); return; }
      if (!Number.isFinite(ruleAmount) || ruleAmount < 0 || overtimeRule.rateKind === "fixed_hourly" && (!Number.isSafeInteger(ruleAmount) || !Number.isSafeInteger(ruleAmount * 100)) || overtimeRule.rateKind === "multiplier" && !Number.isSafeInteger(Math.round(ruleAmount * 10_000))) { setMessage(`第 ${index + 1} 筆加班規則的金額或倍率不正確。`); return; }
      parsedOvertimeRules.push({ fromHalfHours, toHalfHours, rateKind: overtimeRule.rateKind, fixedAmountMinor: overtimeRule.rateKind === "fixed_hourly" ? ruleAmount * 100 : null, multiplierPpm: overtimeRule.rateKind === "multiplier" ? Math.round(ruleAmount * 10_000) : null });
    }
    const sortedOvertimeRules = parsedOvertimeRules.slice().sort((left, right) => left.fromHalfHours - right.fromHalfHours);
    if (sortedOvertimeRules.length && sortedOvertimeRules[0]!.fromHalfHours !== 1) { setMessage("特殊日加班級距要從 0.0 小時起算。若不需要特殊加班規則，請不要新增級距。"); return; }
    for (let index = 1; index < sortedOvertimeRules.length; index += 1) {
      const previous = sortedOvertimeRules[index - 1]!;
      if (previous.toHalfHours === null || sortedOvertimeRules[index]!.fromHalfHours !== previous.toHalfHours + 1) { setMessage("特殊日加班級距不可重疊或留空段，請調整起訖時數。 "); return; }
    }
    const numericAmount = Number(amount);
    const numericMultiplier = Number(multiplier);
    if (wageKind === "fixed_hourly" && (!Number.isSafeInteger(numericAmount) || numericAmount < 0)) { setMessage("固定每小時金額請填非負整數。"); return; }
    if (wageKind === "multiplier" && (!Number.isFinite(numericMultiplier) || numericMultiplier < 0 || !Number.isSafeInteger(Math.round(numericMultiplier * 10_000)))) { setMessage("薪資倍率請填有效的百分比。"); return; }
    const filledAllowances = allowances.filter((allowance) => allowance.itemName.trim() || allowance.amount.trim());
    const parsedAllowances = [] as Array<{ itemName: string; unitAmountMinor: number }>;
    for (const [index, allowance] of filledAllowances.entries()) {
      const allowanceAmount = Number(allowance.amount);
      if (!allowance.itemName.trim() || !Number.isSafeInteger(allowanceAmount) || allowanceAmount < 0) { setMessage(`第 ${index + 1} 筆補貼請填寫名稱與非負整數金額。`); return; }
      parsedAllowances.push({ itemName: allowance.itemName.trim(), unitAmountMinor: allowanceAmount * 100 });
    }
    setMessage(null);
    const values = { name, validFrom, validTo: validTo || null, wageKind, fixedAmountMinor: wageKind === "fixed_hourly" ? numericAmount * 100 : null, multiplierPpm: wageKind === "multiplier" ? Math.round(numericMultiplier * 10_000) : null, overtimeRules: sortedOvertimeRules, note: note.trim(), allowances: parsedAllowances };
    save.mutate({ path: rule ? `/special-workdays/rules/${rule.rule.id}/versions` : "/special-workdays/rules", method: "POST", values }, { onSuccess: () => { (closeRequestRef.current ?? onClose)(); } });
  };
  return <>
    <Dialog title={rule ? `建立「${rule.rule.name}」新版本` : "新增特殊上班日規則"} titleMeta={rule ? (current ? `目前有效版本 v${current.versionNumber}` : "目前沒有有效版本") : undefined} onClose={close} closeRequestRef={closeRequestRef} closeDisabled={save.isPending || voidVersion.isPending} formProps={{ onSubmit: submit }} actions={<>
      <Button type="button" variant="secondary" onClick={close} disabled={save.isPending || voidVersion.isPending}>取消</Button>
      {canVoid ? <Button type="button" variant="danger" icon="history" disabled={save.isPending || voidVersion.isPending} onClick={() => setVoidConfirmation(true)}>解除最新版本</Button> : null}
      <Button type="submit" loading={save.isPending} disabled={voidVersion.isPending}>{rule ? "建立新版本" : "建立規則"}</Button>
    </>}>
      {!rule ? <TextField label="規則名稱" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /> : <p>規則名稱：<strong>{rule.rule.name}</strong>（歷史版本不覆寫）</p>}
      {rule ? <p className="form-hint">新版本會從指定生效日起套用；要修正目前這一版，請先解除最新版本。已套用日期的規則快照不會被改動。</p> : null}
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
          <Button type="button" variant="icon" icon="trash" aria-label={`刪除第 ${index + 1} 筆特殊日加班規則`} onClick={() => setOvertimeRules((items) => items.filter((_, itemIndex) => itemIndex !== index))} />
        </div>)}
        {!overtimeRules.length ? <p className="muted special-overtime-items-empty">尚未設定特殊日加班費，會沿用一般加班規則。</p> : null}
        <div className="salary-items-foot"><Button type="button" variant="secondary" icon="plus" disabled={overtimeRules.length >= 50 || overtimeRules.some((item) => !item.toHours.trim())} onClick={() => setOvertimeRules((items) => [...items, nextOvertimeRule(items)])}>新增規則</Button></div>
      </div>
      <div className="salary-items special-allowance-items">
        <span className="salary-items-label">補貼項目</span>
        <div className="salary-items-head"><span>項目</span><span>補貼單價（元）</span><span className="salary-item-spacer" aria-hidden="true" /></div>
        {allowances.map((allowance, index) => <div className="salary-item-row" key={`allowance-${index}`}>
          <TextField aria-label={`補貼項目 ${index + 1}`} value={allowance.itemName} onChange={(event) => updateAllowance(index, { itemName: event.target.value })} />
          <TextField aria-label={`${allowance.itemName.trim() || "補貼項目"}單價（元）`} type="number" min="0" step="1" value={allowance.amount} onChange={(event) => updateAllowance(index, { amount: event.target.value })} />
          <Button type="button" variant="icon" icon="trash" aria-label={`刪除${allowance.itemName.trim() || `第 ${index + 1} 筆補貼`}`} onClick={() => setAllowances((items) => items.filter((_, itemIndex) => itemIndex !== index))} />
        </div>)}
        {!allowances.length ? <p className="muted special-allowance-items-empty">尚未設定補貼。</p> : null}
        <div className="salary-items-foot"><Button type="button" variant="secondary" icon="plus" disabled={allowances.length >= 50} onClick={() => setAllowances((items) => [...items, { itemName: "", amount: "" }])}>新增補貼</Button></div>
      </div>
      <TextField label="備註（選填）" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
      {message || save.error || voidVersion.error ? <Alert tone="danger">{message ?? save.error?.message ?? voidVersion.error?.message}</Alert> : null}
    </Dialog>
    {voidConfirmation && rule && current ? <ConfirmDialog title="解除最新特殊上班日版本？" confirmLabel="解除版本" pending={voidVersion.isPending} closeRequestRef={voidCloseRequestRef} onCancel={() => setVoidConfirmation(false)} onConfirm={voidLatest}>
      <p>這會解除「<strong>{rule.rule.name}</strong>」的第 {current.versionNumber} 版；資料不會刪除，已套用日期的規則快照與已結算薪資也不會被改動。</p>
      <p className="muted">解除後規則會回到上一個仍有效的版本；可重複解除，直到只剩第一版。第一版若整份設錯，請停用規則後重新建立。</p>
    </ConfirmDialog> : null}
  </>;
}

function AssignDialog({ rules, onClose }: { rules: SpecialWorkdayRule[]; onClose: () => void }) {
  const versionOptions = activeVersionOptions(rules);
  const [versionId, setVersionId] = useState(() => defaultActiveVersionId(rules));
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<string[]>([]);
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [allowanceQuantities, setAllowanceQuantities] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const employees = useHrEmployeeRoster();
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers");
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const selectedVersion = useMemo(() => rules.flatMap((rule) => rule.versions).find((version) => version.id === versionId && !version.voidedAt), [rules, versionId]);
  const targets = useMemo<AssignmentTarget[]>(() => [
    ...(employees.data?.employees ?? []).flatMap((employee) => employee.employmentId ? [{ key: `employee:${employee.employmentId}`, kind: "employee" as const, employmentId: employee.employmentId, displayName: employee.legalName || employee.displayName, secondary: `${employee.employeeNumber}・${employee.position || "未設定職位"}` }] : []),
    ...(workers.data?.workers ?? []).filter((worker) => Boolean(worker.active)).map((worker) => ({ key: `worker:${worker.id}`, kind: "worker" as const, workerId: worker.id, displayName: worker.displayName, secondary: "支援人員" })),
  ], [employees.data, workers.data]);
  const selectedTargets = useMemo(() => {
    const selected = new Set(selectedTargetKeys);
    return targets.filter((target) => selected.has(target.key));
  }, [selectedTargetKeys, targets]);
  const dateRange = useMemo(() => datesInRange(startDate, endDate), [endDate, startDate]);
  const assignmentCount = selectedTargets.length * dateRange.length;
  const allTargetsSelected = targets.length > 0 && selectedTargets.length === targets.length;
  const dateError = endDate < startDate ? "結束日期必須晚於或等於開始日期。" : "";
  const outsideRuleRange = Boolean(selectedVersion && (startDate < selectedVersion.validFrom || selectedVersion.validTo !== null && endDate >= selectedVersion.validTo));
  const tooManyAssignments = assignmentCount > MAX_SPECIAL_WORKDAY_ASSIGNMENTS;
  useEffect(() => {
    if (!selectedVersion) {
      setAllowanceQuantities({});
      return;
    }
    setAllowanceQuantities(Object.fromEntries(selectedVersion.allowances.map((allowance) => [allowance.id, "0"])));
  }, [selectedVersion?.id]);
  const toggleTarget = (key: string, checked: boolean) => setSelectedTargetKeys((current) => checked ? current.includes(key) ? current : [...current, key] : current.filter((item) => item !== key));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedVersion || !versionId) { setMessage("請先選擇可套用的規則版本。"); return; }
    if (!selectedTargets.length) { setMessage("請至少選擇一位套用人員。"); return; }
    if (dateError) { setMessage(dateError); return; }
    if (outsideRuleRange) { setMessage(`日期區間必須落在規則版本有效期間 ${selectedVersion.validFrom}～${selectedVersion.validTo ?? "目前"} 內。`); return; }
    if (tooManyAssignments) { setMessage(`這次會建立 ${assignmentCount} 筆日期套用，超過單次最多 ${MAX_SPECIAL_WORKDAY_ASSIGNMENTS} 筆的限制；請縮短日期或分批套用。`); return; }
    const parsedAllowanceQuantities = [] as Array<{ allowanceId: string; quantity: number }>;
    for (const allowance of selectedVersion.allowances) {
      const quantity = Number(allowanceQuantities[allowance.id] ?? "0");
      if (!Number.isSafeInteger(quantity) || quantity < 0) { setMessage(`「${allowance.itemName}」的補貼數量請填非負整數。`); return; }
      parsedAllowanceQuantities.push({ allowanceId: allowance.id, quantity });
    }
    const targetByKey = new Map(targets.map((target) => [target.key, target]));
    const assignments = dateRange.flatMap((workDate) => selectedTargetKeys.flatMap((key) => {
      const target = targetByKey.get(key);
      if (!target) return [];
      return [{ ...(target.employmentId ? { employmentId: target.employmentId } : { workerId: target.workerId }), workDate, allowanceQuantities: parsedAllowanceQuantities }];
    }));
    if (!assignments.length) { setMessage("目前沒有可套用的員工或支援人員。"); return; }
    setMessage(null);
    save.mutate({ path: "/special-workdays/assignments", method: "POST", values: { ruleVersionId: versionId, assignments } }, { onSuccess: () => { (closeRequestRef.current ?? onClose)(); } });
  };
  return <Dialog className="special-workday-assign-dialog" title="套用特殊上班日" titleMeta={selectedTargets.length && dateRange.length ? `${selectedTargets.length} 位人員・${dateRange.length} 天` : undefined} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending} formProps={{ onSubmit: submit }} actions={<><Button variant="secondary" onClick={onClose} disabled={save.isPending}>取消</Button><Button type="submit" loading={save.isPending} disabled={!versionId || !selectedTargets.length || Boolean(dateError) || outsideRuleRange || tooManyAssignments}>套用日期</Button></>}>
    {!versionOptions.length ? <Alert tone="warning">目前沒有可套用的有效規則版本，請先建立或啟用規則。</Alert> : null}
    <SelectField label="規則版本" value={versionId} options={versionOptions} disabled={save.isPending} onChange={(event) => setVersionId(event.target.value)} hint={selectedVersion ? `有效期間：${selectedVersion.validFrom}～${selectedVersion.validTo ?? "目前"}` : undefined} />
    <div className="special-workday-target-section">
      <div className="hr-payroll-picker-heading"><div><strong>套用人員</strong><small>可一次複選正式員工與啟用中的支援人員；以下選擇會套用到區間內每一天。</small></div><span className="hr-payroll-picker-count">已選 {selectedTargets.length} 人</span></div>
      <label className={`hr-payroll-employee-option hr-payroll-employee-option-all${allTargetsSelected ? " selected" : ""}`}>
        <input type="checkbox" checked={allTargetsSelected} disabled={!targets.length || save.isPending} onChange={(event) => setSelectedTargetKeys(event.target.checked ? targets.map((target) => target.key) : [])} />
        <span><strong>全部符合資格的人員</strong><small>包含正式員工與啟用中的支援人員</small></span>
      </label>
      <div className="hr-payroll-employee-picker special-workday-target-picker" role="group" aria-label="選擇套用人員">
        {employees.isPending || workers.isPending ? <p className="muted hr-payroll-picker-empty">正在載入人員名單…</p> : targets.length ? targets.map((target) => {
          const checked = selectedTargetKeys.includes(target.key);
          return <label className={`hr-payroll-employee-option${checked ? " selected" : ""}`} key={target.key}>
            <input type="checkbox" checked={checked} disabled={save.isPending} onChange={(event) => toggleTarget(target.key, event.target.checked)} />
            <span><strong>{target.displayName}</strong><small>{target.secondary}{target.kind === "employee" ? "・正式員工" : ""}</small></span>
          </label>;
        }) : <p className="muted hr-payroll-picker-empty">目前沒有可套用的人員。</p>}
      </div>
    </div>
    <div className="form-grid two"><TextField label="開始日期" type="date" required value={startDate} disabled={save.isPending} onChange={(event) => setStartDate(event.target.value)} /><TextField label="結束日期（含）" type="date" min={startDate} required value={endDate} disabled={save.isPending} onChange={(event) => setEndDate(event.target.value)} /></div>
    <div className="special-workday-allowance-quantities">
      <div className="salary-items-label">補貼數量（每人／每天）</div>
      <p className="form-hint">同一個規則的每個補貼可以分別設定數量；這組數量會套用到每位選取人員的每一天。</p>
      {selectedVersion?.allowances.length ? <><div className="special-workday-allowance-head"><span>項目</span><span>補貼單價</span><span>數量</span></div>{selectedVersion.allowances.map((allowance) => <div className="special-workday-allowance-row" key={allowance.id}><span className="salary-item-name">{allowance.itemName}</span><span className="special-workday-allowance-unit">{money(allowance.unitAmountMinor)}</span><TextField aria-label={`${allowance.itemName}補貼數量`} type="number" min="0" step="1" value={allowanceQuantities[allowance.id] ?? "0"} disabled={save.isPending} onChange={(event) => setAllowanceQuantities((current) => ({ ...current, [allowance.id]: event.target.value }))} /></div>)}</> : <p className="muted special-workday-allowance-empty">此規則版本沒有補貼項目，本次只套用特殊日薪資。</p>}
    </div>
    <p className="form-hint">同一人員同一天只能套用一個規則；日期區間含首尾，預計建立 {assignmentCount} 筆日期紀錄。套用時會保存規則與補貼快照，已解除的版本不能再套用。</p>
    {dateError || outsideRuleRange || tooManyAssignments ? <Alert tone="warning">{dateError || (outsideRuleRange ? `日期區間必須落在規則版本有效期間 ${selectedVersion?.validFrom}～${selectedVersion?.validTo ?? "目前"} 內。` : `這次會建立 ${assignmentCount} 筆日期套用，超過單次最多 ${MAX_SPECIAL_WORKDAY_ASSIGNMENTS} 筆的限制。`)}</Alert> : null}
    {employees.error || workers.error ? <Alert tone="danger">人員名單載入失敗：{employees.error?.message ?? workers.error?.message}</Alert> : null}
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrSpecialWorkdays() {
  usePageTitle("特殊上班日");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read"); const canWrite = permissions.has("hr:office:write");
  const rules = useHrQuery<{ rules: SpecialWorkdayRule[] }>("/special-workdays/rules", canRead);
  const assignments = useHrQuery<{ assignments: SpecialWorkdayAssignment[] }>("/special-workdays/assignments", canRead);
  const toggleRule = useHrWrite();
  const deleteRule = useHrWrite<{ id: string; deleted: boolean }>();
  const [editor, setEditor] = useState<"new" | SpecialWorkdayRule | "assign" | null>(null);
  const [deletingRule, setDeletingRule] = useState<SpecialWorkdayRule | null>(null);
  const deleteCloseRequestRef = useRef<((afterClose?: () => void) => void) | null>(null);
  const rows = useMemo(() => rules.data?.rules ?? [], [rules.data]);
  const assignableRules = useMemo(() => rows.filter((item) => item.rule.active && item.versions.some((version) => !version.voidedAt)), [rows]);
  /*
   * 已經被套用過的規則永遠刪不掉（後端擋）。資料前端本來就有，所以直接把鈕停用，
   * 不要讓人按完垃圾桶、再確認一次「永久刪除」，最後才拿到一個紅色的 409。
   */
  const assignedVersionIds = useMemo(() => new Set((assignments.data?.assignments ?? []).map((item) => item.assignment.ruleVersionId)), [assignments.data?.assignments]);
  const confirmDelete = () => {
    if (!deletingRule) return;
    // 帶 revision：中途有人加了新版本就會被擋下來，不會連同對方那一版一起刪掉。
    deleteRule.mutate({ path: `/special-workdays/rules/${deletingRule.rule.id}`, method: "DELETE", values: { revision: deletingRule.rule.revision } }, {
      onSuccess: () => {
        const afterDelete = () => { setDeletingRule(null); void rules.refetch(); };
        if (deleteCloseRequestRef.current) deleteCloseRequestRef.current(afterDelete);
        else afterDelete();
      },
    });
  };
  if (!canRead) return <Alert tone="danger">你沒有檢視特殊上班日規則的權限。</Alert>;
  if (rules.isPending || assignments.isPending) return <HrPageSkeleton variant="table" />;
  return <div className="page fills"><PageHeader title="特殊上班日" description="先建立可重複使用的規則，再一次套用到多位人員的日期區間；套用不等於打卡，也不等於加班核准。" actions={canWrite ? <div className="button-row"><Button variant="secondary" onClick={() => setEditor("assign")} disabled={!assignableRules.length}>套用到人員日期</Button><Button icon="plus" onClick={() => setEditor("new")}>新增規則</Button></div> : undefined} />
    {rules.error || assignments.error || toggleRule.error ? <Alert tone="danger">{rules.error?.message ?? assignments.error?.message ?? toggleRule.error?.message}</Alert> : null}<Alert tone="info">固定特殊薪資取代當日底薪；特殊上班日缺少月度工時資料時，薪資試算會列異常而不自行補 0。加班仍須另行申請與核准，核准後依特殊日級距或一般加班規則計算。</Alert>
    <Panel><div className="panel-head"><div><h2>規則主檔</h2><p className="muted">建立新版本不覆寫歷史；解除最新版本會回到上一版；未套用過的規則可刪除，已有歷史套用時請停用。</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>規則</th><th>版本／期間</th><th>薪資方式</th><th>特殊日加班</th><th>狀態</th><th>操作</th></tr></thead><tbody>{rows.map((item) => {
      const version = latestActiveVersion(item);
      const allVoided = item.versions.length > 0 && !version;
      const hasAssignment = item.versions.some((candidate) => assignedVersionIds.has(candidate.id));
      return <tr key={item.rule.id}><td><strong>{item.rule.name}</strong><br /><span className="muted">{item.versions.length} 個版本</span></td><td>{version ? <>v{version.versionNumber}・{version.validFrom}～{version.validTo ?? "目前"}</> : <span className="status quiet">所有版本已解除</span>}</td><td>{version ? version.wageKind === "fixed_hourly" ? `每小時 ${money(version.fixedAmountMinor ?? 0)}` : `總倍率 ${((version.multiplierPpm ?? 0) / 10_000).toFixed(2)}%` : "—"}</td><td>{version ? version.overtimeRules.length ? `${version.overtimeRules.length} 個級距` : "沿用一般規則" : "—"}</td><td><span className={`status ${item.rule.active ? "status-active" : "status-disabled"}`}>{item.rule.active ? "啟用" : "停用"}</span>{allVoided ? <span className="status quiet">版本已解除</span> : null}</td><td>{canWrite ? <div className="row-actions"><Button variant="icon" icon="edit" className="compensation-action-update" aria-label={`為${item.rule.name}建立新版本`} disabled={!item.rule.active} onClick={() => setEditor(item)} /><Tooltip label={hasAssignment ? `${item.rule.name} 已有日期套用紀錄，只能停用` : `刪除 ${item.rule.name}`} focusable={false}><Button variant="icon" icon="trash" className="danger hr-row-action-delete" aria-label={`刪除${item.rule.name}`} disabled={deleteRule.isPending || hasAssignment} onClick={() => { deleteRule.reset(); setDeletingRule(item); }} /></Tooltip><Button variant="secondary" onClick={() => toggleRule.mutate({ path: `/special-workdays/rules/${item.rule.id}/status`, method: "POST", values: { active: !item.rule.active } }, { onSuccess: () => void rules.refetch() })}>{item.rule.active ? "停用" : "啟用"}</Button></div> : <span className="muted">—</span>}</td></tr>;
    })}</tbody></table></div>{!rows.length ? <p className="empty-state">尚未建立特殊上班日規則。</p> : null}</Panel>
    <Panel className="grows"><div className="panel-head"><div><h2>日期套用紀錄</h2><p className="muted">套用時保存規則名稱、版本、薪資設定與每個補貼的數量快照。</p></div></div><div className="table-scroll"><table className="data-table"><thead><tr><th>人員</th><th>日期</th><th>規則／版本</th><th>薪資方式</th><th>補貼數量</th><th>套用時間</th></tr></thead><tbody>{(assignments.data?.assignments ?? []).map((item) => <tr key={item.assignment.id}><td>{item.employeeName ?? item.workerName ?? "—"}</td><td>{item.assignment.workDate}</td><td>{item.assignment.ruleNameSnapshot}<br /><span className="muted">v{item.ruleVersionNumber}{item.ruleVersionVoidedAt ? "（已解除）" : ""}</span></td><td>{item.assignment.wageKindSnapshot === "fixed_hourly" ? "固定每小時" : "總倍率"}</td><td>{allowanceSummary(item)}</td><td>{item.assignment.appliedAt}</td></tr>)}</tbody></table></div>{!assignments.data?.assignments.length ? <p className="empty-state">尚未有日期套用紀錄。</p> : null}</Panel>
    {editor === "new" ? <RuleDialog onClose={() => { setEditor(null); void rules.refetch(); }} /> : null}{editor && editor !== "new" && editor !== "assign" ? <RuleDialog rule={editor} onClose={() => { setEditor(null); void rules.refetch(); }} /> : null}{editor === "assign" ? <AssignDialog rules={assignableRules} onClose={() => { setEditor(null); void assignments.refetch(); }} /> : null}
    {/* 跟同一頁的「解除版本」用同一個元件：兩個破壞性動作不該一個吃 Escape、一個不吃。 */}
    {deletingRule ? <ConfirmDialog title="刪除特殊上班日規則？" confirmLabel="刪除規則" pending={deleteRule.isPending} closeRequestRef={deleteCloseRequestRef} onCancel={() => { deleteRule.reset(); setDeletingRule(null); }} onConfirm={confirmDelete}>
      <p>「<strong>{deletingRule.rule.name}</strong>」及其尚未套用的規則版本會被永久刪除，這個操作無法復原。</p>
      <p className="muted">已有日期套用紀錄時，為保留歷史快照，刪除會被拒絕；請改用停用。</p>
      {deleteRule.error ? <Alert tone="danger">{deleteRule.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
