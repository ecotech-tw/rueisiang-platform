import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../../shell/Toast.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, Dialog, Field, SelectField, TextField } from "../../ui/index.js";
import { useHrInsuranceEstimate, useHrQuery, useHrWrite, type Employment, type InsuranceBracket, type InsuranceContributionEstimate, type InsuranceEstimateRequest, type InsuranceRateTableRecord, type InsuranceVersion } from "./api.js";

const INSURANCE_LABEL: Record<"labor" | "health", string> = { labor: "勞保", health: "健保" };
const SCHEMES = ["labor", "health"] as const;
const ESTIMATE_DEBOUNCE_MS = 180;
const AUTO_BRACKET = "__auto__";

type InsuranceScheme = typeof SCHEMES[number];

function latestVersion(versions: InsuranceVersion[], scheme: InsuranceScheme) {
  return versions.filter((version) => version.scheme === scheme).sort((left, right) => right.versionNumber - left.versionNumber || right.validFrom.localeCompare(left.validFrom))[0];
}

export function insuranceVersionDateSummary(versions: InsuranceVersion[]) {
  const activeVersions = versions.filter((version) => !version.voidedAt);
  return SCHEMES.map((scheme) => latestVersion(activeVersions, scheme))
    .filter((version): version is InsuranceVersion => Boolean(version))
    .map((version) => `${INSURANCE_LABEL[version.scheme]} ${version.validFrom}`);
}

function taipeiToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function bracketForSalary(brackets: InsuranceBracket[] | undefined, salary: string) {
  // Number("") 是 0，會落在第 1 級；還沒填月薪時要顯示「請輸入月薪」，不能先帶出最低級距。
  if (!salary.trim()) return undefined;
  const value = Number(salary);
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return brackets?.find((bracket) => value >= bracket.lowerSalary && (bracket.upperSalary === null || value <= bracket.upperSalary));
}

function amountLabel(amount: number | undefined) {
  return amount === undefined ? "尚未決定" : `NT$ ${amount.toLocaleString("zh-TW")}`;
}

function premiumLabel(amountMinor: number) {
  return `-NT$ ${Math.round(amountMinor / 100).toLocaleString("zh-TW")}`;
}
function componentLabel(component: InsuranceContributionEstimate["components"][number]["component"]) {
  if (component === "ordinary_accident") return "普通事故";
  if (component === "employment") return "就業保險";
  return "本人";
}
function estimateRateLabel(estimate: InsuranceContributionEstimate | undefined, includeDependents: boolean, dependentCount: number) {
  if (!estimate || estimate.employeeRatePpm === null) return "—";
  const components = estimate.components?.length ? estimate.components : [{ component: null, employeeRatePpm: estimate.employeeRatePpm, totalRatePpm: undefined, employeeSharePpm: undefined }];
  const rates = components.map((component) => component.totalRatePpm !== undefined && component.employeeSharePpm !== undefined
    ? `${componentLabel(component.component)} ${(component.totalRatePpm / 10_000).toFixed(2)}% × ${(component.employeeSharePpm / 10_000).toFixed(0)}%`
    : `${componentLabel(component.component)} ${(component.employeeRatePpm / 10_000).toFixed(2)}%`);
  return `${rates.join(" ＋ ")}${includeDependents && dependentCount > 0 ? `・含 ${dependentCount} 位眷屬` : ""}`;
}

/**
 * 生效日只提供預設值，儲存時仍以表單目前的值為準：初次加保沿用服務年資起算日，
 * 一般新版本從今天起算；撤回後沿用被撤回版本的生效日，才能直接建立修正版。
 */
export function InsuranceEditor({ employment, existing, insuranceVersions, defaultSalary, defaultDependentCount, onClose }: { employment: Employment; existing: boolean; insuranceVersions: InsuranceVersion[]; defaultSalary?: number; defaultDependentCount?: number; onClose: () => void }) {
  const latestInsuranceVersions = SCHEMES.map((scheme) => latestVersion(insuranceVersions, scheme)).filter((version): version is InsuranceVersion => Boolean(version));
  const activeInsuranceVersions = insuranceVersions.filter((version) => !version.voidedAt);
  const allVoided = insuranceVersions.length > 0 && activeInsuranceVersions.length === 0;
  const voidableVersions = SCHEMES.map((scheme) => latestVersion(activeInsuranceVersions, scheme)).filter((version): version is InsuranceVersion => Boolean(version));
  const firstInsuranceVersion = insuranceVersions.slice().sort((left, right) => left.validFrom.localeCompare(right.validFrom) || left.versionNumber - right.versionNumber)[0];
  const latestVoidedVersion = latestInsuranceVersions.filter((version) => version.voidedAt).sort((left, right) => right.versionNumber - left.versionNumber || right.validFrom.localeCompare(left.validFrom))[0];
  const currentVersionDateSummary = insuranceVersionDateSummary(insuranceVersions).join("、");
  const isCorrection = allVoided || Boolean(latestVoidedVersion);
  const initialValidFrom = allVoided
    ? firstInsuranceVersion?.validFrom ?? taipeiToday()
    : latestVoidedVersion?.validFrom ?? (!existing ? employment.serviceStartOn ?? taipeiToday() : taipeiToday());
  const validFromLabel = !existing ? "生效日" : isCorrection ? "修正版生效日" : "新版本生效日";
  const currentYear = taipeiToday().slice(0, 4);
  const [status, setStatus] = useState<"enrolled" | "withdrawn">("enrolled");
  const [validFrom, setValidFrom] = useState(initialValidFrom);
  const [salary, setSalary] = useState(defaultSalary === undefined ? "" : String(defaultSalary));
  const [bracketSelections, setBracketSelections] = useState<Record<InsuranceScheme, string>>({ labor: AUTO_BRACKET, health: AUTO_BRACKET });
  const [dependents, setDependents] = useState(String(defaultDependentCount ?? 0));
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [voidConfirmation, setVoidConfirmation] = useState(false);
  const table = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${encodeURIComponent(currentYear)}`);
  const save = useHrWrite<{ ids: string[] }>();
  const voidInsurance = useHrWrite<{ ids: string[] }>();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const activeTables = useMemo(() => new Map(table.data?.tables.filter((item) => item.status === "active").map((item) => [item.scheme, item])), [table.data?.tables]);
  const selected = useMemo(() => ({
    labor: bracketForSalary(activeTables.get("labor")?.brackets, salary),
    health: bracketForSalary(activeTables.get("health")?.brackets, salary),
  }), [activeTables, salary]);

  const selectedBrackets = useMemo(() => ({
    labor: bracketSelections.labor === AUTO_BRACKET ? selected.labor : activeTables.get("labor")?.brackets.find((bracket) => String(bracket.level) === bracketSelections.labor),
    health: bracketSelections.health === AUTO_BRACKET ? selected.health : activeTables.get("health")?.brackets.find((bracket) => String(bracket.level) === bracketSelections.health),
  }), [activeTables, bracketSelections.health, bracketSelections.labor, selected]);

  useEffect(() => { setMessage(""); }, [status, validFrom, salary, bracketSelections, dependents, note]);

  const usesManualSource = (scheme: InsuranceScheme) => activeTables.get(scheme)?.sourceKind === "manual";
  const amount = (scheme: InsuranceScheme) => status === "withdrawn" ? 0 : selectedBrackets[scheme]?.insuredAmount;

  const updateBracketSelection = (scheme: InsuranceScheme, value: string) => setBracketSelections((current) => ({ ...current, [scheme]: value }));
  const dependentCount = Number(dependents);
  const estimateValues = useMemo<InsuranceEstimateRequest>(() => ({
    validFrom,
    versions: SCHEMES.map((scheme) => ({ scheme, status, insuredAmountMinor: (amount(scheme) ?? 0) * 100, dependentCount: scheme === "health" ? dependentCount : 0 })),
  }), [activeTables, bracketSelections, dependentCount, selected, selectedBrackets, status, validFrom]);
  const estimateSignature = JSON.stringify(estimateValues);
  const estimateReady = Boolean(validFrom) && Number.isSafeInteger(dependentCount) && dependentCount >= 0 && dependentCount <= 3 && (status === "withdrawn" || SCHEMES.every((scheme) => {
    const nextAmount = amount(scheme);
    return Number.isSafeInteger(nextAmount) && (nextAmount ?? 0) > 0;
  }));
  const [debouncedEstimateValues, setDebouncedEstimateValues] = useState<InsuranceEstimateRequest | null>(null);
  useEffect(() => {
    if (!estimateReady) { setDebouncedEstimateValues(null); return; }
    const timeout = window.setTimeout(() => setDebouncedEstimateValues(estimateValues), ESTIMATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [estimateReady, estimateSignature, estimateValues]);
  const estimateQuery = useHrInsuranceEstimate(employment.id, debouncedEstimateValues);
  const debouncedEstimateSignature = debouncedEstimateValues ? JSON.stringify(debouncedEstimateValues) : "";
  const estimateIsCurrent = estimateReady && debouncedEstimateSignature === estimateSignature;
  const calculationPending = estimateReady && (!estimateIsCurrent || estimateQuery.isPending || estimateQuery.isFetching);
  const calculationError = estimateIsCurrent ? estimateQuery.error : undefined;
  const calculated = estimateIsCurrent ? estimateQuery.data?.estimates : undefined;
  const laborEstimate = calculated?.find((estimate) => estimate.scheme === "labor");
  const healthEstimate = calculated?.find((estimate) => estimate.scheme === "health");
  const totalPremium = laborEstimate?.employeeAmountMinor !== null && laborEstimate?.employeeAmountMinor !== undefined && healthEstimate?.employeeAmountMinor !== null && healthEstimate?.employeeAmountMinor !== undefined
    ? laborEstimate.employeeAmountMinor + healthEstimate.employeeAmountMinor
    : undefined;
  const voidLatest = () => {
    if (!voidableVersions.length) return;
    voidInsurance.mutate({ path: `/employments/${employment.id}/insurance/void`, method: "POST", values: { versionIds: voidableVersions.map((version) => version.id) } }, {
      onSuccess: () => { setVoidConfirmation(false); toast.show("已撤回最新勞健保版本。"); onClose(); },
    });
  };

  return <>
    <Dialog title={existing ? "建立勞健保新版本" : "新增加保資料"} titleMeta="勞保與健保一起建立版本" className="hr-insurance-dialog" onClose={onClose} closeRequestRef={closeRequestRef} closeDisabled={save.isPending || voidInsurance.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const submittedValidFrom = new FormData(event.currentTarget).get("validFrom");
    if (typeof submittedValidFrom !== "string" || !submittedValidFrom) { setMessage("請填寫生效日。"); return; }
    const healthDependents = Number(dependents);
    if (status === "enrolled") {
      for (const scheme of SCHEMES) {
        const nextAmount = amount(scheme);
        if (!Number.isSafeInteger(nextAmount) || (nextAmount ?? 0) <= 0) { setMessage(`請輸入實際月薪，讓系統依目前啟用的${INSURANCE_LABEL[scheme]}級距帶入投保金額。`); return; }
      }
      if (!Number.isSafeInteger(healthDependents) || healthDependents < 0 || healthDependents > 3) { setMessage("眷屬人數必須介於 0～3。"); return; }
      if (SCHEMES.some(usesManualSource) && !note.trim()) { setMessage("人工來源必須留下覆核備註。"); return; }
    }
    setMessage("");
    const valuesFor = (scheme: InsuranceScheme) => {
      const activeTable = activeTables.get(scheme);
      const manual = usesManualSource(scheme);
      return {
        scheme,
        status,
        validFrom: submittedValidFrom,
        // 員工封存不改寫既有版本；版本自己的有效期間仍由敘薪／投保資料管理。
        validTo: null,
        insuredAmountMinor: (amount(scheme) ?? 0) * 100,
        dependentCount: scheme === "health" ? healthDependents : 0,
        rateYear: Number(currentYear),
        sourceKind: manual ? "manual" : "official",
        sourceUrl: manual ? "" : activeTable?.sourceUrl ?? "",
        note,
      };
    };
    save.mutate({ path: `/employments/${employment.id}/insurance`, method: "POST", values: { versions: SCHEMES.map(valuesFor) } }, { onSuccess: () => { toast.show(existing ? "勞健保新版本已建立" : "加保資料已建立"); (closeRequestRef.current ?? onClose)(); } });
  } }} actions={<>
    {voidableVersions.length ? <Button variant="danger" icon="history" disabled={save.isPending || voidInsurance.isPending} onClick={() => setVoidConfirmation(true)}>撤回最新版本</Button> : null}
    <Button type="submit" loading={save.isPending} disabled={voidInsurance.isPending}>儲存</Button>
  </>}>
    <p>{allVoided ? "所有勞健保版本已撤回；請重新填寫要建立的版本，生效日已帶入最初版本日期。" : existing ? "這裡會建立新的勞健保版本，不會覆寫既有紀錄；若上一筆輸入錯誤，可先撤回最新版本，再以原生效日建立修正版。" : "系統會用目前啟用的官方級距依實際月薪自動帶入勞保與健保投保金額；每年級距調整後，再由系統整理需要調整的人員提醒管理者。"}</p>
    {existing && currentVersionDateSummary ? <Alert tone="info">目前已保存版本的生效日：<strong>{currentVersionDateSummary}</strong>。建立新版本時，請在下方填寫新的生效日。</Alert> : null}
    <Field label="狀態"><div className="segmented-control" role="group" aria-label="勞健保狀態">
      <button type="button" className={status === "enrolled" ? "selected" : ""} onClick={() => setStatus("enrolled")}>加保／變更級距</button>
      <button type="button" className={status === "withdrawn" ? "selected" : ""} onClick={() => setStatus("withdrawn")}>退保</button>
    </div></Field>
    <TextField name="validFrom" label={validFromLabel} type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
    {status === "enrolled" ? <>
      <TextField label="實際月薪（元）" type="number" min="0" step="1" value={salary} required onChange={(event) => setSalary(event.target.value)} hint="勞保／健保級距會依月薪自動帶入，也可以從下拉選單選擇其他級距。" />
      <div className="form-grid two">
        {SCHEMES.map((scheme) => {
          const activeTable = activeTables.get(scheme);
          const selection = bracketSelections[scheme];
          const selectedBracket = selectedBrackets[scheme];
          const bracketOptions = [
            { value: "", label: activeTable ? "請輸入實際月薪" : "尚未有可用級距", disabled: true },
            ...(activeTable?.brackets ?? []).map((bracket) => ({ value: String(bracket.level), label: `第 ${bracket.level} 級／${amountLabel(bracket.insuredAmount)}` })),
          ];
          const displayedSelection = selection === AUTO_BRACKET ? String(selectedBracket?.level ?? "") : selection;
          return <section className="hr-insurance-scheme-card" key={scheme}>
            <SelectField label={`${INSURANCE_LABEL[scheme]}級距`} value={displayedSelection} options={bracketOptions} onChange={(event) => updateBracketSelection(scheme, event.target.value)} />
          </section>;
        })}
      </div>
      <TextField label="健保眷屬人數（0～3）" type="number" min="0" max="3" step="1" value={dependents} onChange={(event) => setDependents(event.target.value)} />
      <div className="hr-insurance-estimate hr-insurance-estimate-summary" aria-live="polite">
        <div className="hr-insurance-estimate-title">員工每月扣款試算</div>
        {calculationPending ? <span className="muted">試算中…</span> : calculationError ? <span className="muted">暫時無法取得試算</span> : calculated ? <>
          <div className="hr-insurance-estimate-breakdown">
            <div className="hr-insurance-estimate-row"><span>勞保<small className="muted">{estimateRateLabel(laborEstimate, false, 0)}</small></span>{laborEstimate?.employeeAmountMinor !== null && laborEstimate?.employeeAmountMinor !== undefined ? <strong>{premiumLabel(laborEstimate.employeeAmountMinor)}</strong> : <span className="muted">尚未設定有效規則</span>}</div>
            <div className="hr-insurance-estimate-row"><span>健保<small className="muted">{estimateRateLabel(healthEstimate, true, dependentCount)}</small></span>{healthEstimate?.employeeAmountMinor !== null && healthEstimate?.employeeAmountMinor !== undefined ? <strong>{premiumLabel(healthEstimate.employeeAmountMinor)}</strong> : <span className="muted">尚未設定有效規則</span>}</div>
          </div>
          {totalPremium !== undefined ? <div className="hr-insurance-estimate-total"><span>合計</span><strong>{premiumLabel(totalPremium)}</strong></div> : null}
        </> : Number.isSafeInteger(dependentCount) && dependentCount >= 0 && dependentCount <= 3 ? <span className="muted">選擇級距後即可計算</span> : <span className="muted">請輸入有效的眷屬人數</span>}
      </div>
    </> : <Alert tone="info">退保會同時建立勞保與健保退保版本，生效日之後不再列入薪資扣款計算。</Alert>}
    <TextField label="備註" required={SCHEMES.some(usesManualSource) && status === "enrolled"} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} hint={SCHEMES.some(usesManualSource) && status === "enrolled" ? "人工來源必須留下覆核備註。" : undefined} />
    {table.error ? <Alert tone="danger">{table.error.message}；請取得並啟用級距後再儲存。</Alert> : null}
    {status === "enrolled" && !table.isPending && SCHEMES.some((scheme) => !activeTables.get(scheme)) ? <Alert tone="warning">目前年度尚未有完整已啟用的級距；請先按「取得級距」並啟用後再儲存。</Alert> : null}
    {message || save.error || voidInsurance.error || calculationError ? <Alert tone="danger">{message || save.error?.message || voidInsurance.error?.message || calculationError?.message}</Alert> : null}
    </Dialog>
    {voidConfirmation ? <ConfirmDialog
      title="撤回最新勞健保版本？"
      confirmLabel="撤回版本"
      pending={voidInsurance.isPending}
      onCancel={() => setVoidConfirmation(false)}
      onConfirm={voidLatest}
    >
      <p>這會撤回 <strong>{voidableVersions.length === 2 ? "最新勞保與健保版本" : "最新勞健保版本"}</strong>；資料不會刪除，既有月份的薪資快照也不會被改動。</p>
      <p className="muted">撤回後會回到上一個仍有效的版本；可重複撤回，直到第一版，再用原生效日建立修正版。</p>
    </ConfirmDialog> : null}
  </>;
}
