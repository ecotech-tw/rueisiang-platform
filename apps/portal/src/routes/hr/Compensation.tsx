import { useEffect, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { HR_ROSTER_PATH, useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type Profile, type ScheduleWorkerRecord, type InsuranceRateTableRecord, type InsuranceContributionRule } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";

interface EmployeeListResponse { employees: Employee[] }
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const PAY_BASIS_UNIT: Record<CompensationVersion["payBasis"], string> = { monthly: "月", daily: "日", hourly: "時" };
/** 常見的薪資項目；選「其他」那一列會換成自由輸入，名稱仍由 HR 決定。 */
const ITEM_PRESETS = ["職務加給", "職務津貼", "伙食費", "全勤獎金", "交通津貼", "主管加給", "證照津貼", "輪班津貼"];
const CUSTOM_ITEM = "__custom__";
/** 每筆項目自己的計算單位；月給的津貼不會因為員工是日薪就被乘上出勤天數。 */
const ITEM_BASIS_OPTIONS = [{ value: "monthly", label: "月" }, { value: "daily", label: "日" }, { value: "hourly", label: "時" }] as const;

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

function latestVersion<T extends { validFrom: string }>(versions: T[]): T | undefined {
  return versions.slice().sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function currentEmployment(employments: Employment[]): Employment | undefined {
  const today = taipeiToday();
  return employments.find((employment) => employment.hiredOn <= today && (employment.endedOn === null || today < employment.endedOn)) ?? employments[0];
}

/**
 * 不同單位的金額不能相加：日薪 1,800／日 與職務加給 3,000／月 是兩件事，
 * 加起來的 4,800 不對應任何一筆實付金額。改成各單位各自小計後並列。
 */
function totalsByBasis(entries: Array<{ basis: CompensationVersion["payBasis"]; amountMinor: number }>) {
  return (["monthly", "daily", "hourly"] as const)
    .map((basis) => ({ basis, amountMinor: entries.filter((entry) => entry.basis === basis).reduce((sum, entry) => sum + entry.amountMinor, 0) }))
    .filter((row) => row.amountMinor > 0);
}

function totalsText(totals: ReturnType<typeof totalsByBasis>): string {
  return totals.length ? totals.map((row) => `${money(row.amountMinor)}／${PAY_BASIS_UNIT[row.basis]}`).join("　＋　") : money(0);
}

function versionTotals(version: CompensationVersion) {
  return totalsByBasis([
    { basis: version.payBasis, amountMinor: version.baseAmountMinor },
    ...(version.items ?? []).map((item) => ({ basis: item.amountBasis ?? "monthly", amountMinor: item.amountMinor })),
  ]);
}

interface SalaryItemDraft { key: string; name: string; amount: string; custom: boolean; basis: CompensationVersion["payBasis"] }

function draftAmountMinor(amount: string): number | null {
  const value = Number(amount);
  return amount.trim() && Number.isSafeInteger(value) && value >= 0 ? value * 100 : null;
}

/**
 * 敘薪 Dialog 自己選員工：從上方「新增敘薪」進來時還沒選人，從列上的按鈕進來時預選那一位。
 *
 * 這個元件掛在頁面層，不掛在 <tr> 裡——對話框的 <div> 放進 <tbody> 是不合法的 HTML。
 */
function CompensationEditor({ employees, initialUserId, onClose }: { employees: Employee[]; initialUserId: string | null; onClose: () => void }) {
  const [userId, setUserId] = useState(initialUserId ?? "");
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(userId)}`, Boolean(userId));
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const employmentVersions = useMemo(() => (profile.data?.compensation ?? []).filter((version) => version.employmentId === employment?.id), [profile.data?.compensation, employment?.id]);
  const current = useMemo(() => currentVersion(employmentVersions), [employmentVersions]);
  // 新增版本不覆寫歷史；若已有未來版本，下一次更新要沿用最新版本，避免把已修正的資料帶回舊版本。
  const latest = useMemo(() => latestVersion(employmentVersions), [employmentVersions]);

  const [validFrom, setValidFrom] = useState(taipeiToday());
  const [validTo, setValidTo] = useState("");
  const [payBasis, setPayBasis] = useState<CompensationVersion["payBasis"]>("monthly");
  const [baseAmount, setBaseAmount] = useState("");
  const [items, setItems] = useState<SalaryItemDraft[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();

  // 換一位員工就重新帶入那個人目前的敘薪當預設值，不沿用上一個人的金額與項目。
  useEffect(() => {
    const today = taipeiToday();
    // 任職已結束的人，今天已經落在任職期間外；後端要求版本整段都在任職期間內，
    // 所以改從到職日起算，並把任職結束日帶成迄日，否則一定存不進去。
    const endedOn = employment?.endedOn ?? null;
    const start = !employment ? today : employment.hiredOn > today || (endedOn && today >= endedOn) ? employment.hiredOn : today;
    /*
     * 今天已經有一版時，再從今天起算一定期間重疊、存不進去（後端只會回一句籠統的錯誤）。
     * 直接跳到最後一版的隔天，讓預設值就是可以存的日期。
     */
    const latestStart = employmentVersions.reduce<string | null>((latest, version) => !latest || version.validFrom > latest ? version.validFrom : latest, null);
    setValidFrom(latestStart && latestStart >= start ? nextDay(latestStart) : start);
    setValidTo(endedOn ?? "");
    setPayBasis(latest?.payBasis ?? "monthly");
    setBaseAmount(latest ? String(latest.baseAmountMinor / 100) : "");
    setItems((latest?.items ?? []).map((item, index) => ({ key: `${item.id}-${index}`, name: item.itemName, amount: String(item.amountMinor / 100), custom: !ITEM_PRESETS.includes(item.itemName), basis: item.amountBasis ?? "monthly" })));
    setNote("");
    setMessage(null);
  }, [current, employment, employmentVersions, latest]);

  const selected = employees.find((employee) => employee.userId === userId);
  const baseMinor = draftAmountMinor(baseAmount) ?? 0;
  const draftTotals = totalsByBasis([
    { basis: payBasis, amountMinor: baseMinor },
    ...items.map((item) => ({ basis: item.basis, amountMinor: draftAmountMinor(item.amount) ?? 0 })),
  ]);
  const updateItem = (key: string, patch: Partial<SalaryItemDraft>) => setItems((list) => list.map((item) => item.key === key ? { ...item, ...patch } : item));

  return <Dialog
    title={current ? "更新敘薪" : "新增敘薪"}
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
      /*
       * 後端會自動把「還沒結束、而且比新版本早開始」的那一版收尾，所以只有這兩種情況才是真的撞期。
       * 不先擋的話使用者只會看到一句「任職不存在、薪資期間重疊或資料不合法」，不知道要改哪裡。
       */
      const newEnd = validTo || "9999-12-31";
      const overlapping = employmentVersions.find((version) => {
        // 後端會在同一批次收尾較早開始的開放版本，這種銜接不是重疊。
        if (version.validTo === null && version.validFrom < validFrom) return false;
        return version.validFrom < newEnd && (version.validTo === null || version.validTo > validFrom);
      });
      if (overlapping) {
        const nextAvailableDate = overlapping.validTo ?? nextDay(overlapping.validFrom);
        setMessage(`${overlapping.validFrom}～${overlapping.validTo ?? "目前"} 已經有一個敘薪版本（${PAY_BASIS_LABEL[overlapping.payBasis]} ${totalsText(versionTotals(overlapping))}）。歷史版本不可覆寫，請把生效日改到 ${nextAvailableDate} 或之後。`);
        return;
      }
      if (draftAmountMinor(baseAmount) === null) { setMessage("基本薪資請填非負整數的金額（元）。"); return; }
      const seenNames = new Set<string>();
      for (const item of items) {
        const name = item.name.trim();
        if (!name) { setMessage("每個薪資項目都要有名稱，不需要的請按刪除。"); return; }
        if (draftAmountMinor(item.amount) === null) { setMessage(`「${name}」的金額請填非負整數（元）。`); return; }
        // 同名項目分成兩列時，薪資單會出現兩筆一樣的名稱，看不出誰是誰；要嘛合併金額、要嘛改名。
        if (seenNames.has(name)) { setMessage(`「${name}」重複了，請合併成一列或改成不同名稱。`); return; }
        seenNames.add(name);
      }
      setMessage(null);
      save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: {
        validFrom, validTo: validTo || null, payBasis, baseAmountMinor: draftAmountMinor(baseAmount), note,
        // 型態與三個納入與否不再讓人逐項設定：一律是固定項目，並納入加班基礎、投保級距與應稅所得。
        items: items.map((item) => ({ itemName: item.name.trim(), amountMinor: draftAmountMinor(item.amount), itemKind: "fixed", amountBasis: item.basis, includeOvertime: true, includeInsurance: true, includeTax: true })),
      } }, { onSuccess: onClose });
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
    {employment ? <p className="form-hint">任職期間 {employment.hiredOn}～{employment.endedOn ?? "目前"}；目前敘薪 {current ? `${PAY_BASIS_LABEL[current.payBasis]} ${totalsText(versionTotals(current))}` : "尚未設定"}。</p> : null}
    <div className="field-grid">
      <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
      <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    </div>
    <div className="salary-items">
      <span className="salary-items-label">薪資項目</span>
      <div className="salary-items-head"><span>項目</span><span>計算單位</span><span>金額（元）</span><span className="salary-item-spacer" aria-hidden="true" /></div>
      <div className="salary-item-row">
        <span className="salary-item-name">基本薪資</span>
        {/* 基本薪資的單位就是這份敘薪的計薪方式（月薪／日薪／時薪），不另外開一個欄位重複設定。 */}
        <SelectField aria-label="基本薪資的計算單位（即計薪方式）" value={payBasis} options={ITEM_BASIS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} onChange={(event) => setPayBasis(event.target.value as CompensationVersion["payBasis"])} />
        <TextField aria-label="基本薪資金額（元）" type="number" min="0" step="1" value={baseAmount} required onChange={(event) => setBaseAmount(event.target.value)} />
        <span className="salary-item-spacer" aria-hidden="true" />
      </div>
      {items.map((item) => <div className="salary-item-row" key={item.key}>
        {item.custom
          ? <TextField aria-label="薪資項目名稱" value={item.name} placeholder="自行輸入項目名稱" onChange={(event) => updateItem(item.key, { name: event.target.value })} />
          : <SelectField
            aria-label="薪資項目"
            value={item.name}
            options={[{ value: "", label: "請選擇項目" }, ...ITEM_PRESETS.filter((name) => name === item.name || !items.some((other) => other.key !== item.key && other.name.trim() === name)).map((name) => ({ value: name, label: name })), { value: CUSTOM_ITEM, label: "其他（自行輸入）" }]}
            onChange={(event) => updateItem(item.key, event.target.value === CUSTOM_ITEM ? { custom: true, name: "" } : { name: event.target.value })}
          />}
        <SelectField
          aria-label={`${item.name.trim() || "項目"}的計算單位`}
          value={item.basis}
          options={ITEM_BASIS_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(event) => updateItem(item.key, { basis: event.target.value as CompensationVersion["payBasis"] })}
        />
        <TextField aria-label={`${item.name.trim() || "項目"}金額（元）`} type="number" min="0" step="1" value={item.amount} onChange={(event) => updateItem(item.key, { amount: event.target.value })} />
        <Button variant="icon" icon="trash" title={`刪除${item.name.trim() || "這個項目"}`} aria-label={`刪除${item.name.trim() || "這個項目"}`} onClick={() => setItems((list) => list.filter((row) => row.key !== item.key))} />
      </div>)}
      <div className="salary-items-foot">
        <Button variant="secondary" icon="plus" onClick={() => setItems((list) => [...list, { key: `item-${Date.now()}-${list.length}`, name: "", amount: "", custom: false, basis: "monthly" }])}>新增項目</Button>
        <p className="salary-items-total">合計：<strong>{totalsText(draftTotals)}</strong></p>
      </div>
    </div>

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
  const employmentVersions = useMemo(() => (profile.data?.compensation ?? []).filter((version) => version.employmentId === employment?.id), [profile.data?.compensation, employment?.id]);
  const current = useMemo(() => currentVersion(employmentVersions), [employmentVersions]);
  if (profile.isLoading) return <tr><td>{employee.displayName}</td><td colSpan={5}>載入敘薪資料…</td></tr>;
  return <tr>
    <td><strong>{employee.displayName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.hiredOn}～${employment.endedOn ?? "目前"}` : "尚無任職"}</td>
    <td>{current ? PAY_BASIS_LABEL[current.payBasis] : "尚未設定"}</td>
    <td className="numeric">{current ? totalsText(versionTotals(current)) : "—"}</td>
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
  return <div className="page">
    <PageHeader
      title={settingsOnly ? "制度設定" : "敘薪管理"}
      description={settingsOnly ? "管理官方勞健保級距與公司採用的負擔規則；薪資結算只使用已保存的設定。" : "設定每位員工的薪資組成與生效版本；薪資變更不覆蓋歷史，薪資結算會讀取指定月份有效的敘薪版本。"}
      actions={!settingsOnly && canWrite ? <Button icon="plus" onClick={() => setEditing({ userId: null })}>新增敘薪</Button> : null}
    />
    {settingsOnly ? <>
      <Panel><div className="panel-head"><div><h2>官方勞健保級距</h2><p className="muted">同步後先以草稿保存，HR 審閱來源與級距後再啟用；不直接覆蓋目前採用版本。</p></div>{canWrite ? <Button icon="sync" loading={syncRates.isPending} onClick={() => syncRates.mutate({ path: "/insurance-rates/sync", method: "POST", values: { year: currentYear } }, { onSuccess: () => void rates.refetch() })}>同步本年度官方資料</Button> : null}</div>{rates.error || syncRates.error ? <Alert tone="danger">{rates.error?.message ?? syncRates.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>年度</th><th>狀態</th><th>級距筆數</th><th>抓取時間</th><th>操作</th></tr></thead><tbody>{(rates.data?.tables ?? []).map((table) => <tr key={table.id}><td>{table.scheme === "labor" ? "勞保" : "健保"}</td><td>{table.year}</td><td>{table.status === "draft" ? "待審閱" : table.status === "active" ? "目前啟用" : "封存"}</td><td>{table.brackets.length}</td><td>{table.fetchedAt}</td><td>{canWrite && table.status === "draft" ? <Button variant="secondary" loading={activateRate.isPending} onClick={() => activateRate.mutate({ path: `/insurance-rates/${table.id}/activate`, method: "POST", values: {} }, { onSuccess: () => void rates.refetch() })}>審閱後啟用</Button> : null}</td></tr>)}</tbody></table></div></Panel>
      <Panel><div className="panel-head"><div><h2>公司負擔規則</h2><p className="muted">費率與眷屬計算方式必須由公司確認後輸入；薪資只使用生效日涵蓋結算月份的規則。</p></div></div><div className="admin-form toolbar"><SelectField label="種類" value={contributionScheme} options={[{ value: "labor", label: "勞保" }, { value: "health", label: "健保" }]} onChange={(event) => setContributionScheme(event.target.value as "labor" | "health")} /><TextField label="生效日" type="date" value={contributionFrom} onChange={(event) => setContributionFrom(event.target.value)} /><TextField label="員工負擔（%）" type="number" min="0" max="100" step="0.0001" value={employeeRate} onChange={(event) => setEmployeeRate(event.target.value)} /><TextField label="雇主負擔（%）" type="number" min="0" max="100" step="0.0001" value={employerRate} onChange={(event) => setEmployerRate(event.target.value)} />{contributionScheme === "health" ? <TextField label="眷屬倍率（%）" type="number" min="0" max="100" step="0.0001" value={dependentRate} onChange={(event) => setDependentRate(event.target.value)} /> : null}{canWrite ? <Button icon="plus" loading={createContribution.isPending} disabled={!employeeRate || !employerRate} onClick={() => createContribution.mutate({ path: "/insurance-contribution-rules", method: "POST", values: { scheme: contributionScheme, validFrom: contributionFrom, validTo: null, employeeRatePpm: Math.round(Number(employeeRate) * 10_000), employerRatePpm: Math.round(Number(employerRate) * 10_000), dependentRatePpm: Math.round(Number(dependentRate || "100") * 10_000), sourceKind: "manual", note: "公司確認規則" } }, { onSuccess: () => { setEmployeeRate(""); setEmployerRate(""); void contributionRules.refetch(); } })}>保存負擔規則</Button> : null}</div>{contributionRules.error || createContribution.error ? <Alert tone="danger">{contributionRules.error?.message ?? createContribution.error?.message}</Alert> : null}<div className="table-scroll"><table className="data-table compact"><thead><tr><th>種類</th><th>生效日</th><th>員工</th><th>雇主</th><th>眷屬倍率</th></tr></thead><tbody>{(contributionRules.data?.rules ?? []).map((rule) => <tr key={rule.id}><td>{rule.scheme === "labor" ? "勞保" : "健保"}</td><td>{rule.validFrom}</td><td>{(rule.employeeRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.employerRatePpm / 10_000).toFixed(4)}%</td><td>{(rule.dependentRatePpm / 10_000).toFixed(4)}%</td></tr>)}</tbody></table></div></Panel>
    </> : <>
      <Alert tone="info">先在這裡完成員工敘薪，再到「勞健保管理」建立投保版本與「獎金管理」套用業績 policy；最後於「薪資結算」直接計算指定月份薪資。</Alert>
      {!canWrite ? <Alert tone="info">目前帳號只有敘薪檢視權限，無法新增薪資版本。</Alert> : null}
      <Panel>
      <div className="panel-head"><div><h2>員工敘薪</h2><p>月薪、日薪與時薪都以版本保存；金額依計算單位分開列出，月給與日給不相加。勞健保版本請到「勞健保管理」建立。</p></div></div>
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>目前任職</th><th>方式</th><th className="numeric">總計薪資</th><th>生效期間</th><th>操作</th></tr></thead><tbody>
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
