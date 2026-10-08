import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { hrEmployeeLabel, isHrFormalEmployee, useHrEmployeeRoster, useHrQuery, useHrWrite, type CompensationVersion, type Employee, type Employment, type HrFormalEmployee, type Profile, type ScheduleWorkerRecord, type InsuranceContributionComponent, type InsuranceContributionRule, type SupportWorkerPayBasis } from "./api.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { EmployeeFilterBar } from "./EmployeeFilterBar.js";
import { HrPageSkeleton, HrSkeletonTableRow } from "./HrSkeleton.js";

interface EmployeePageResponse { employees: Employee[]; total: number; page: number; pageSize: number; hasMore: boolean }
const EMPLOYEE_PAGE_SIZES = [10, 25, 50, 100] as const;
const PAY_BASIS_LABEL: Record<CompensationVersion["payBasis"], string> = { monthly: "月薪", daily: "日薪", hourly: "時薪" };
const PAY_BASIS_UNIT: Record<CompensationVersion["payBasis"], string> = { monthly: "月", daily: "日", hourly: "時" };
const WORKER_PAY_BASIS_LABEL: Record<SupportWorkerPayBasis, string> = { daily: "日薪", hourly: "時薪" };
const WORKER_PAY_BASIS_OPTIONS = Object.entries(WORKER_PAY_BASIS_LABEL).map(([value, label]) => ({ value: value as SupportWorkerPayBasis, label }));
type WorkerOvertimeMode = "none" | "rate" | "amount";
const WORKER_OVERTIME_OPTIONS = [{ value: "none", label: "不適用（沿用制度倍率）" }, { value: "rate", label: "固定加班倍率" }, { value: "amount", label: "固定加班金額／時" }];

export function buildWorkerCompensationSubmission(input: {
  employmentId: string;
  validFrom: string;
  validTo: string;
  payBasis: SupportWorkerPayBasis;
  amount: string;
  overtimeMode: WorkerOvertimeMode;
  overtimeValue: string;
  note: string;
}) {
  const basisLabel = WORKER_PAY_BASIS_LABEL[input.payBasis];
  const numericAmount = Number(input.amount);
  if (!Number.isSafeInteger(numericAmount) || numericAmount < 0) return { ok: false as const, message: `${basisLabel}請填非負整數的金額（元）。` };
  const numericOvertime = input.overtimeValue === "" ? NaN : Number(input.overtimeValue);
  if (input.overtimeMode !== "none" && (!Number.isFinite(numericOvertime) || numericOvertime <= 0)) {
    return { ok: false as const, message: input.overtimeMode === "rate" ? "固定加班倍率請填大於 0 的數字。" : "固定加班金額請填大於 0 的整數元。" };
  }
  if (input.overtimeMode === "amount" && !Number.isSafeInteger(numericOvertime)) return { ok: false as const, message: "固定加班金額請填大於 0 的整數元。" };
  return {
    ok: true as const,
    request: {
      path: `/employments/${encodeURIComponent(input.employmentId)}/worker-compensation`,
      method: "POST",
      values: {
        validFrom: input.validFrom,
        validTo: input.validTo || null,
        payBasis: input.payBasis,
        baseAmountMinor: numericAmount * 100,
        overtimeRatePpm: input.overtimeMode === "rate" ? Math.round(numericOvertime * 1_000_000) : null,
        overtimeHourlyMinor: input.overtimeMode === "amount" ? numericOvertime * 100 : null,
        note: input.note,
      },
    },
  };
}
function workerOvertimeLabel(version: { overtimeRatePpm?: number | null; overtimeHourlyMinor?: number | null } | null | undefined) {
  if (version?.overtimeRatePpm != null) return `固定 ${(version.overtimeRatePpm / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} 倍`;
  if (version?.overtimeHourlyMinor != null) return `固定 ${money(version.overtimeHourlyMinor)}／時`;
  return "制度倍率";
}
/** 常見的薪資項目；選「其他」那一列會換成自由輸入，名稱仍由 HR 決定。 */
const ITEM_PRESETS = ["職務加給", "職務津貼", "伙食費", "全勤獎金", "交通津貼", "主管加給", "證照津貼", "輪班津貼"];
const CUSTOM_ITEM = "__custom__";
/** 每筆項目自己的計算單位；月給的津貼不會因為員工是日薪就被乘上出勤天數。 */
const ITEM_BASIS_OPTIONS = [{ value: "monthly", label: "月" }, { value: "daily", label: "日" }, { value: "hourly", label: "時" }] as const;
type ContributionTarget = "labor:ordinary_accident" | "labor:employment" | "health";
const CONTRIBUTION_TARGETS: Array<{ value: ContributionTarget; label: string; scheme: "labor" | "health"; component: InsuranceContributionComponent | null }> = [
  { value: "labor:ordinary_accident", label: "勞保普通事故保險", scheme: "labor", component: "ordinary_accident" },
  { value: "labor:employment", label: "就業保險", scheme: "labor", component: "employment" },
  { value: "health", label: "健保", scheme: "health", component: null },
];
function getContributionTarget(target: ContributionTarget) { return CONTRIBUTION_TARGETS.find((item) => item.value === target) ?? CONTRIBUTION_TARGETS[0]!; }
function contributionLabel(rule: InsuranceContributionRule) {
  if (rule.scheme === "health") return "健保";
  if (rule.component === "ordinary_accident") return "勞保普通事故保險";
  if (rule.component === "employment") return "就業保險";
  return "勞保（舊版合併規則）";
}
function contributionPercent(value: number | undefined) { return value === undefined ? "—" : `${(value / 10_000).toFixed(4)}%`; }

function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}

function taipeiToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function currentVersion<T extends { validFrom: string; validTo: string | null; voidedAt?: string | null }>(versions: T[]): T | undefined {
  const today = taipeiToday();
  const active = versions.filter((version) => !version.voidedAt);
  return active.find((version) => version.validFrom <= today && (version.validTo === null || today < version.validTo))
    ?? (versions.some((version) => version.voidedAt) ? undefined : active.filter((version) => version.validFrom <= today).sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0]);
}

function latestCompensationVersion<T extends { validFrom: string; versionNumber: number; voidedAt?: string | null }>(versions: T[]): T | undefined {
  return versions.filter((version) => !version.voidedAt).slice().sort((left, right) => right.validFrom.localeCompare(left.validFrom) || right.versionNumber - left.versionNumber)[0];
}

function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function currentEmployment(employments: Employment[]): Employment | undefined {
  return employments.find((employment) => !employment.archivedAt);
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
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(userId)}`, Boolean(userId), { keepPreviousData: false });
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const employmentVersions = useMemo(() => (profile.data?.compensation ?? []).filter((version) => version.employmentId === employment?.id), [profile.data?.compensation, employment?.id]);
  const latestVersion = useMemo(() => latestCompensationVersion(employmentVersions), [employmentVersions]);
  const current = useMemo(() => currentVersion(employmentVersions), [employmentVersions]);
  const allVoided = employmentVersions.length > 0 && !latestVersion;
  const templateVersion = latestVersion ?? current;
  const isEditing = Boolean(initialUserId) || Boolean(latestVersion);
  const suggestedValidFrom = latestVersion
    ? latestVersion.validTo ?? (taipeiToday() > latestVersion.validFrom ? taipeiToday() : nextDay(latestVersion.validFrom))
    : null;

  const [validFrom, setValidFrom] = useState(taipeiToday());
  const [validTo, setValidTo] = useState("");
  const [payBasis, setPayBasis] = useState<CompensationVersion["payBasis"]>("monthly");
  const [baseAmount, setBaseAmount] = useState("");
  const [items, setItems] = useState<SalaryItemDraft[]>([]);
  const [overtimeHourly, setOvertimeHourly] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [voidConfirmation, setVoidConfirmation] = useState(false);
  const save = useHrWrite();
  const voidCompensation = useHrWrite();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const voidCloseRequestRef = useRef<(() => void) | null>(null);

  // 換一位員工就重新帶入那個人目前的敘薪當預設值，不沿用上一個人的金額與項目。
  useEffect(() => {
    const today = taipeiToday();
    const start = today;
    /* 新版本可從實際異動日開始；若上一版尚未結束，後端會以這一天收尾上一版。 */
    setValidFrom(suggestedValidFrom ?? start);
    setValidTo("");
    setPayBasis(templateVersion?.payBasis ?? "monthly");
    setBaseAmount(templateVersion ? String(templateVersion.baseAmountMinor / 100) : "");
    setItems((templateVersion?.items ?? []).map((item, index) => ({ key: `${item.id}-${index}`, name: item.itemName, amount: String(item.amountMinor / 100), custom: !ITEM_PRESETS.includes(item.itemName), basis: item.amountBasis ?? "monthly" })));
    setOvertimeHourly(templateVersion?.overtimeHourlyMinor != null ? String(templateVersion.overtimeHourlyMinor / 100) : "");
    setNote("");
    setMessage(null);
  }, [employment, employmentVersions, suggestedValidFrom, templateVersion]);

  const formalEmployees = employees.filter(isHrFormalEmployee);
  const selected = formalEmployees.find((employee) => employee.userId === userId);
  const baseMinor = draftAmountMinor(baseAmount) ?? 0;
  const draftTotals = totalsByBasis([
    { basis: payBasis, amountMinor: baseMinor },
    ...items.map((item) => ({ basis: item.basis, amountMinor: draftAmountMinor(item.amount) ?? 0 })),
  ]);
  const updateItem = (key: string, patch: Partial<SalaryItemDraft>) => setItems((list) => list.map((item) => item.key === key ? { ...item, ...patch } : item));

  const effectiveVersion = current ?? latestVersion;
  const canVoid = Boolean(latestVersion);
  const voidLatest = () => {
    if (!employment || !latestVersion || latestVersion.voidedAt) return;
    voidCompensation.mutate({ path: `/employments/${employment.id}/compensation/${latestVersion.id}/void`, method: "POST", values: {} }, {
      onSuccess: () => { if (voidCloseRequestRef.current) voidCloseRequestRef.current(); else setVoidConfirmation(false); toast.show("已解除最新敘薪。"); (closeRequestRef.current ?? onClose)(); },
    });
  };

  return <>
    <Dialog
    title={isEditing ? "更新敘薪" : "新增敘薪"}
    titleMeta={selected ? `${selected.legalName}／${selected.employeeNumber}` : "選一位員工後填寫薪資組成"}
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending || voidCompensation.isPending}
    formProps={{ onSubmit: (event) => {
      event.preventDefault();
      if (!employment) { setMessage(userId ? "這位員工沒有任職紀錄，請先在員工列表建立任職。" : "請先選擇員工。"); return; }
      if (validTo && validTo <= validFrom) { setMessage("迄日必須晚於生效日。"); return; }
      /*
       * 後端會自動把「還沒結束、而且比新版本早開始」的那一版收尾，所以只有這兩種情況才是真的撞期。
       * 不先擋的話使用者只會看到一句「員工主檔不存在、薪資期間重疊或資料不合法」，不知道要改哪裡。
       */
      const newEnd = validTo || "9999-12-31";
      const overlapping = employmentVersions.filter((version) => !version.voidedAt).find((version) => {
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
      if (overtimeHourly.trim() && !draftAmountMinor(overtimeHourly)) { setMessage("加班固定時薪請填大於 0 的整數金額（元）；不適用就留空，不要填 0。"); return; }
      setMessage(null);
      save.mutate({ path: `/employments/${employment.id}/compensation`, method: "POST", values: {
        validFrom, validTo: validTo || null, payBasis, baseAmountMinor: draftAmountMinor(baseAmount), note,
        overtimeHourlyMinor: overtimeHourly.trim() ? draftAmountMinor(overtimeHourly) : null,
        // 型態與三個納入與否不再讓人逐項設定：一律是固定項目，並納入加班基礎、勞保／健保級距與應稅所得。
        items: items.map((item) => ({ itemName: item.name.trim(), amountMinor: draftAmountMinor(item.amount), itemKind: "fixed", amountBasis: item.basis, includeOvertime: true, includeInsurance: true, includeTax: true })),
      } }, { onSuccess: () => { toast.show(latestVersion ? "敘薪已更新。" : "敘薪已新增。"); (closeRequestRef.current ?? onClose)(); } });
    } }}
    actions={<>
      {canVoid ? <Button variant="danger" icon="history" disabled={save.isPending || voidCompensation.isPending} onClick={() => setVoidConfirmation(true)}>解除最新敘薪</Button> : null}
      <Button type="submit" className={isEditing ? "hr-action-update" : "add-action"} loading={save.isPending} disabled={!employment || voidCompensation.isPending}>儲存敘薪</Button>
    </>}
  >
    <p>{allVoided ? "所有敘薪版本已撤回；請重新填寫要建立的敘薪版本，生效日可自行指定。" : isEditing ? "更新會建立新的敘薪版本，不會覆寫既有紀錄；生效日請填實際薪資異動日，系統會自動收尾前一個尚未結束的版本。" : "敘薪採版本保存；新增版本的生效期間不能覆蓋既有薪資版本。勞健保費率與勞保／健保級距由系統依已啟用的設定套用，不在這裡填。"}</p>
    <SelectField
      label="員工"
      value={userId}
      required
      options={[{ value: "", label: "請選擇員工" }, ...formalEmployees.map((employee) => ({ value: employee.userId, label: hrEmployeeLabel(employee) }))]}
      searchable
      disabled={isEditing}
      onChange={(event) => setUserId(event.target.value)}
    />
    {isEditing ? <p className="form-hint">更新敘薪時員工欄位已鎖定，避免誤改到其他員工。</p> : null}
    {userId && profile.isPending ? <p className="muted">載入目前敘薪…</p> : null}
    {userId && !profile.isPending && !employment ? <Alert tone="warning">這位員工沒有任職紀錄，請先在員工列表建立任職。</Alert> : null}
    {employment ? <p className="form-hint">目前職位「{employment.position}」；實際服務年資起算日 {employment.serviceStartOn ?? "未設定"}；目前有效敘薪 {effectiveVersion ? `${PAY_BASIS_LABEL[effectiveVersion.payBasis]} ${totalsText(versionTotals(effectiveVersion))}${effectiveVersion.overtimeHourlyMinor != null ? `，加班固定 ${money(effectiveVersion.overtimeHourlyMinor)}／時` : ""}` : allVoided ? "已全部撤回" : "尚未設定"}。</p> : null}
    {employment?.serviceStartOn && validFrom < employment.serviceStartOn ? <Alert tone="warning">這筆敘薪自 {validFrom} 生效，但服務年資起算日是 {employment.serviceStartOn}；該日期前不會被薪資試算視為在職日。若 {employment.serviceStartOn} 填錯，請先到員工管理修正。</Alert> : null}
    <div className="field-grid">
      <TextField label="生效日" type="date" value={validFrom} required hint="日薪轉月薪時，請填實際轉為月薪的第一天；若早於服務年資起算日，特休會以後者為準。" onChange={(event) => setValidFrom(event.target.value)} />
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
        <Button variant="secondary" icon="plus" className="add-action" onClick={() => setItems((list) => [...list, { key: `item-${Date.now()}-${list.length}`, name: "", amount: "", custom: false, basis: "monthly" }])}>新增項目</Button>
        <p className="salary-items-total">合計：<strong>{totalsText(draftTotals)}</strong></p>
      </div>
    </div>

    <TextField label="加班固定時薪（元／小時，可留空）" type="number" min="1" step="1" value={overtimeHourly} hint="留空就照制度倍率從薪資換算；有填的話，加班每小時固定給這個金額。特殊上班日的加班級距有涵蓋到的時數以級距為準，沒涵蓋到的時數才用這個金額。" onChange={(event) => setOvertimeHourly(event.target.value)} />
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error || voidCompensation.error || profile.error ? <Alert tone="danger">{message || save.error?.message || voidCompensation.error?.message || profile.error?.message}</Alert> : null}
    </Dialog>
    {voidConfirmation && latestVersion && employment ? <ConfirmDialog
      title="解除最新敘薪？"
      confirmLabel="解除敘薪"
      pending={voidCompensation.isPending}
      closeRequestRef={voidCloseRequestRef}
      onCancel={() => setVoidConfirmation(false)}
      onConfirm={voidLatest}
    >
      <p>這會解除 <strong>{selected?.legalName ?? "這位員工"}</strong> 的第 {latestVersion.versionNumber} 版敘薪；資料不會刪除，既有月份的薪資快照也不會被改動。</p>
      <p className="muted">解除後會回到上一個仍有效的版本；可重複解除，直到第一版，再建立第一版修正版。</p>
    </ConfirmDialog> : null}
  </>;
}

export function WorkerCompensationEditor({ worker, onClose }: { worker: ScheduleWorkerRecord; onClose: () => void }) {
  const current = currentVersion(worker.compensation);
  const initialPayBasis: SupportWorkerPayBasis = current?.payBasis === "hourly" ? "hourly" : "daily";
  const initialOvertimeMode: WorkerOvertimeMode = current?.overtimeRatePpm != null ? "rate" : current?.overtimeHourlyMinor != null ? "amount" : "none";
  const [validFrom, setValidFrom] = useState(taipeiToday());
  const [validTo, setValidTo] = useState("");
  const [payBasis, setPayBasis] = useState<SupportWorkerPayBasis>(initialPayBasis);
  const [amount, setAmount] = useState(current ? String(current.baseAmountMinor / 100) : "");
  const [overtimeMode, setOvertimeMode] = useState<WorkerOvertimeMode>(initialOvertimeMode);
  const [overtimeValue, setOvertimeValue] = useState(current?.overtimeRatePpm != null ? String(current.overtimeRatePpm / 1_000_000) : current?.overtimeHourlyMinor != null ? String(current.overtimeHourlyMinor / 100) : "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const save = useHrWrite();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const basisLabel = WORKER_PAY_BASIS_LABEL[payBasis];
  return <Dialog title={`設定 ${worker.displayName} 的敘薪`} onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const submission = buildWorkerCompensationSubmission({ employmentId: worker.employmentId ?? worker.id, validFrom, validTo, payBasis, amount, overtimeMode, overtimeValue, note });
    if (!submission.ok) { setMessage(submission.message); return; }
    setMessage(null);
    save.mutate(submission.request, { onSuccess: () => { toast.show("支援人員敘薪已儲存。", "success"); (closeRequestRef.current ?? onClose)(); } });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存{basisLabel}</Button>}>
    <p>支援人員可選日薪或時薪；加班設定可固定倍率或固定金額，留空則沿用制度倍率。敘薪版本不覆蓋歷史，特殊工作日級距優先套用。</p>
    <SelectField label="計薪方式" value={payBasis} options={WORKER_PAY_BASIS_OPTIONS} onChange={(event) => { setPayBasis(event.target.value as SupportWorkerPayBasis); setMessage(null); }} />
    <TextField label="生效日" type="date" required value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <TextField label={`${basisLabel}（元）`} type="number" min="0" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} />
    <SelectField label="加班計算" value={overtimeMode} options={WORKER_OVERTIME_OPTIONS} onChange={(event) => { setOvertimeMode(event.target.value as WorkerOvertimeMode); setMessage(null); }} />
    {overtimeMode !== "none" ? <TextField label={overtimeMode === "rate" ? "固定加班倍率" : "固定加班金額／時（元）"} type="number" min="0" step={overtimeMode === "rate" ? "0.000001" : "1"} value={overtimeValue} onChange={(event) => setOvertimeValue(event.target.value)} hint={overtimeMode === "rate" ? "例如 1.333333；不接受申請人自行指定倍率。" : "特殊工作日級距覆蓋的時數不使用此固定金額。"} /> : null}
    <TextField label="備註" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
    {message || save.error ? <Alert tone="danger">{message ?? save.error?.message}</Alert> : null}
  </Dialog>;
}

function EmployeeCompensationRow({ employee, canWrite, onEdit }: { employee: HrFormalEmployee; canWrite: boolean; onEdit: (userId: string) => void }) {
  const profile = useHrQuery<Profile>(`/employees/${encodeURIComponent(employee.userId)}`, true, { keepPreviousData: false });
  const employment = useMemo(() => currentEmployment(profile.data?.employments ?? []), [profile.data?.employments]);
  const compensationVersions = (profile.data?.compensation ?? []).filter((version) => version.employmentId === employment?.id);
  const current = currentVersion(compensationVersions);
  const latest = latestCompensationVersion(compensationVersions);
  const allVoided = compensationVersions.length > 0 && !latest;
  if (profile.isLoading) return <HrSkeletonTableRow columns={6} />;
  return <tr>
    <td><strong>{employee.legalName}</strong><br /><span className="muted">{employee.employeeNumber}</span></td>
    <td>{employment ? `${employment.employeeNumber} · ${employment.position}` : "尚無任職"}</td>
    <td>{current ? PAY_BASIS_LABEL[current.payBasis] : allVoided ? "已全部撤回" : "尚未設定"}</td>
    <td className="numeric">{current ? totalsText(versionTotals(current)) : "—"}{current?.overtimeHourlyMinor != null ? <><br /><span className="muted">加班固定 {money(current.overtimeHourlyMinor)}／時</span></> : null}</td>
    <td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : allVoided ? "已全部撤回" : "—"}</td>
    <td>{canWrite && employment ? latest
      ? <Button variant="icon" icon="edit" className="compensation-action-update" title="更新敘薪" aria-label="更新敘薪" onClick={() => onEdit(employee.userId)} />
      : allVoided
        ? <Button variant="icon" icon="edit" className="compensation-action-update" title="更新敘薪" aria-label="更新敘薪" onClick={() => onEdit(employee.userId)} />
        : <Button variant="icon" icon="plus" className="compensation-action-add" title="新增敘薪" aria-label="新增敘薪" onClick={() => onEdit(employee.userId)} /> : null}</td>
  </tr>;
}

export function WorkerCompensationRow({ employee, worker, canWrite, onEdit }: { employee: Employee; worker: ScheduleWorkerRecord | undefined; canWrite: boolean; onEdit: () => void }) {
  const current = currentVersion(worker?.compensation ?? []);
  return <tr><td><strong>{employee.legalName}</strong><br /><span className="muted">{employee.employeeNumber}・排班支援人員</span></td><td>支援人員／排班</td><td>{current ? PAY_BASIS_LABEL[current.payBasis] : "—"}</td><td className="numeric">{current ? <>{money(current.baseAmountMinor)}<br /><span className="muted">加班：{workerOvertimeLabel(current)}</span></> : "尚未設定"}</td><td>{current ? `${current.validFrom}～${current.validTo ?? "目前"}` : "—"}</td><td>{canWrite && worker ? <Button variant="icon" icon={current ? "edit" : "plus"} className={current ? "compensation-action-update" : "compensation-action-add"} title={current ? "更新版本" : "新增版本"} aria-label={`為${employee.legalName}${current ? "更新" : "新增"}敘薪版本`} onClick={onEdit} /> : null}</td></tr>;
}

export function HrCompensationManagement({ settingsOnly = false }: { settingsOnly?: boolean } = {}) {
  usePageTitle(settingsOnly ? "制度設定" : "敘薪管理");
  const { permissions, user } = useSession();
  const isHrAdministrator = user?.isHrAdministrator ?? false;
  const canRead = isHrAdministrator && permissions.has("hr:payroll:read");
  const canWrite = isHrAdministrator && permissions.has("hr:employee:write");
  const employees = useHrEmployeeRoster(!settingsOnly && canRead && permissions.has("hr:employee:read"));
  const [employeeFilters, setEmployeeFilters] = useState({ page: 1, pageSize: 25, search: "", status: "all", sortField: "employeeNumber", sortDirection: "asc" as "asc" | "desc" });
  const employeeTablePath = `/employees?page=${employeeFilters.page}&pageSize=${employeeFilters.pageSize}&search=${encodeURIComponent(employeeFilters.search)}&status=${employeeFilters.status}&employmentStatus=active&personKind=all&sortField=${employeeFilters.sortField}&sortDirection=${employeeFilters.sortDirection}`;
  const employeeTable = useHrQuery<EmployeePageResponse>(employeeTablePath, !settingsOnly && canRead && permissions.has("hr:employee:read"));
  const workers = useHrQuery<{ workers: ScheduleWorkerRecord[] }>("/schedule-workers", !settingsOnly && canRead);
  // 勞保／健保級距集中在「勞健保管理」的級距管理 modal；這裡只維護公司負擔規則。
  const contributionRules = useHrQuery<{ rules: InsuranceContributionRule[] }>("/insurance-contribution-rules", settingsOnly && canRead);
  const createContribution = useHrWrite();
  const [contributionTarget, setContributionTarget] = useState<ContributionTarget>("labor:ordinary_accident");
  const [contributionFrom, setContributionFrom] = useState(taipeiToday().slice(0, 7) + "-01");
  const [employeeRate, setEmployeeRate] = useState("");
  const [employerRate, setEmployerRate] = useState("");
  const [dependentRate, setDependentRate] = useState("100");
  const [editingWorker, setEditingWorker] = useState<ScheduleWorkerRecord | null>(null);
  // null＝關閉；{ userId: null }＝從上方按鈕開啟、還沒選員工。
  const [editing, setEditing] = useState<{ userId: string | null } | null>(null);
  if (!canRead) return <Alert tone="danger">敘薪明細僅限全平台 HR 管理者查看。</Alert>;
  const pageLoading = settingsOnly
    ? contributionRules.isPending
    : (permissions.has("hr:employee:read") && (employees.isPending || employeeTable.isPending)) || workers.isPending;
  if (pageLoading) return <HrPageSkeleton variant="table" />;
  const selectedContributionTarget = getContributionTarget(contributionTarget);
  return <div className="page">
    <PageHeader
      title={settingsOnly ? "制度設定" : "敘薪管理"}
      description={settingsOnly ? "管理公司採用的勞健保負擔規則；勞健保級距請從「勞健保管理」的級距管理進入。薪資結算只使用已保存的設定。" : "設定正式員工與排班支援人員的薪資組成與生效版本；薪資變更不覆蓋歷史，薪資結算會讀取指定月份有效的敘薪版本。"}
    />
    {settingsOnly ? <>
      <Panel>
        <div className="panel-head"><div><h2>公司採用負擔規則</h2><p className="muted">勞保總基金費率 12.5%＝普通事故保險 11.5%＋就業保險 1%；兩項都是獨立基金，員工與雇主負擔各自套用。薪資試算會將兩筆員工金額分別四捨五入到元後再加總。若公司適用特殊身分類別，可在此建立覆核版本覆蓋對應項目。</p></div></div>
        <div className="admin-form toolbar"><SelectField label="保險項目" value={contributionTarget} options={CONTRIBUTION_TARGETS.map((item) => ({ value: item.value, label: item.label }))} onChange={(event) => setContributionTarget(event.target.value as ContributionTarget)} /><TextField label="生效日" type="date" value={contributionFrom} onChange={(event) => setContributionFrom(event.target.value)} /><TextField label="員工實際負擔（%）" type="number" min="0" max="100" step="0.0001" value={employeeRate} onChange={(event) => setEmployeeRate(event.target.value)} /><TextField label="雇主實際負擔（%）" type="number" min="0" max="100" step="0.0001" value={employerRate} onChange={(event) => setEmployerRate(event.target.value)} />{selectedContributionTarget.scheme === "health" ? <TextField label="眷屬倍率（%）" type="number" min="0" max="100" step="0.0001" value={dependentRate} onChange={(event) => setDependentRate(event.target.value)} /> : null}{canWrite ? <Button icon="plus" className="add-action" loading={createContribution.isPending} disabled={!employeeRate || !employerRate} onClick={() => createContribution.mutate({ path: "/insurance-contribution-rules", method: "POST", values: { scheme: selectedContributionTarget.scheme, component: selectedContributionTarget.component, validFrom: contributionFrom, validTo: null, employeeRatePpm: Math.round(Number(employeeRate) * 10_000), employerRatePpm: Math.round(Number(employerRate) * 10_000), dependentRatePpm: selectedContributionTarget.scheme === "health" ? Math.round(Number(dependentRate || "100") * 10_000) : 0, sourceKind: "manual", note: `公司確認${selectedContributionTarget.label}規則` } }, { onSuccess: () => { setEmployeeRate(""); setEmployerRate(""); void contributionRules.refetch(); } })}>保存負擔規則</Button> : null}</div>
        {contributionRules.error || createContribution.error ? <Alert tone="danger">{contributionRules.error?.message ?? createContribution.error?.message}</Alert> : null}
        <DataTable className="compact"><thead><tr><th>保險項目</th><th>基金費率</th><th>員工分攤</th><th>雇主分攤</th><th>生效日</th><th>員工實際負擔</th><th>雇主實際負擔</th><th>眷屬倍率</th><th>來源</th></tr></thead><tbody>{(contributionRules.data?.rules ?? []).map((rule) => <tr key={rule.id}><td>{contributionLabel(rule)}</td><td>{contributionPercent(rule.totalRatePpm)}</td><td>{contributionPercent(rule.employeeSharePpm)}</td><td>{contributionPercent(rule.employerSharePpm)}</td><td>{rule.validFrom}</td><td>{contributionPercent(rule.employeeRatePpm)}</td><td>{contributionPercent(rule.employerRatePpm)}</td><td>{rule.scheme === "health" ? contributionPercent(rule.dependentRatePpm) : "—"}</td><td><div className="hr-rate-source"><StatusBadge tone={rule.isSystemDefault ? "success" : "warning"}>{rule.isSystemDefault ? "系統預設" : "公司覆核"}</StatusBadge>{rule.sourceUrl ? <a href={rule.sourceUrl} target="_blank" rel="noreferrer">官方資料</a> : null}</div></td></tr>)}</tbody></DataTable>
      </Panel>
    </> : <>
      {!canWrite ? <Alert tone="info">目前帳號只有敘薪檢視權限，無法新增薪資版本。</Alert> : null}
      <Panel>
      <EmployeeFilterBar
        search={employeeFilters.search}
        status={employeeFilters.status}
        onSearch={(search) => setEmployeeFilters((current) => ({ ...current, search, page: 1 }))}
        onStatusChange={(status) => setEmployeeFilters((current) => ({ ...current, status, page: 1 }))}
      />
      {employeeTable.error ? <Alert tone="danger">{employeeTable.error.message}</Alert> : null}
      <DataTable><thead><tr>
        <SortableHeader label="人員" field="employeeNumber" active={employeeFilters.sortField} direction={employeeFilters.sortDirection} onSort={(sortField, sortDirection) => setEmployeeFilters((current) => ({ ...current, sortField, sortDirection, page: 1 }))} />
        <th>目前任職</th><th>方式</th><th className="numeric">總計薪資</th><th>生效期間</th><th>操作</th>
      </tr></thead><tbody>
        {(employeeTable.data?.employees ?? []).map((employee) => employee.personKind === "worker"
          ? <WorkerCompensationRow key={employee.employmentId ?? employee.userId} employee={employee} worker={(workers.data?.workers ?? []).find((item) => item.id === employee.employmentId)} canWrite={canWrite} onEdit={() => { const worker = (workers.data?.workers ?? []).find((item) => item.id === employee.employmentId); if (worker) setEditingWorker(worker); }} />
          : isHrFormalEmployee(employee) ? <EmployeeCompensationRow key={employee.employmentId ?? employee.userId} employee={employee} canWrite={canWrite} onEdit={(userId) => setEditing({ userId })} /> : null)}
      </tbody></DataTable>
      {!employeeTable.data?.employees.length ? <EmptyState>{employeeTable.data?.total ? "沒有符合條件的人員。" : "尚無人員。"}</EmptyState> : null}
      {employeeTable.data && employeeTable.data.total > 0 ? <Pager page={employeeTable.data.page} pageSize={employeeTable.data.pageSize} pageSizes={EMPLOYEE_PAGE_SIZES} totalPages={Math.max(1, Math.ceil(employeeTable.data.total / employeeTable.data.pageSize))} totalLabel={`共 ${employeeTable.data.total.toLocaleString("zh-TW")} 位`} onPage={(page) => setEmployeeFilters((current) => ({ ...current, page }))} onPageSize={(pageSize) => setEmployeeFilters((current) => ({ ...current, pageSize, page: 1 }))} /> : null}
    </Panel>
      {workers.error ? <Alert tone="danger">{workers.error.message}</Alert> : null}
      {editing ? <CompensationEditor employees={employees.data?.employees ?? []} initialUserId={editing.userId} onClose={() => setEditing(null)} /> : null}
      {editingWorker ? <WorkerCompensationEditor worker={editingWorker} onClose={() => setEditingWorker(null)} /> : null}
    </>}
  </div>;
}
