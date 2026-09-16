import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Dialog, Field, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employment, type InsuranceBracket, type InsuranceRateTableRecord } from "./api.js";

const INSURANCE_LABEL: Record<"labor" | "health", string> = { labor: "勞保", health: "健保" };
const SCHEMES = ["labor", "health"] as const;

type InsuranceScheme = typeof SCHEMES[number];

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

interface InsuranceDraft {
  manual: boolean;
  manualAmount: string;
}

/**
 * existing 決定生效日的預設值：新加保從到職日起算；已經有版本的人，同一個起日一定跟既有版本重疊，
 * 所以改從今天起算，存的時候由後端關閉前一個版本。
 */
export function InsuranceEditor({ employment, existing, defaultSalary, defaultDependentCount, onClose }: { employment: Employment; existing: boolean; defaultSalary?: number; defaultDependentCount?: number; onClose: () => void }) {
  const currentYear = taipeiToday().slice(0, 4);
  const [status, setStatus] = useState<"enrolled" | "withdrawn">("enrolled");
  const [validFrom, setValidFrom] = useState(existing ? taipeiToday() : employment.hiredOn);
  const [salary, setSalary] = useState(defaultSalary === undefined ? "" : String(defaultSalary));
  const [drafts, setDrafts] = useState<Record<InsuranceScheme, InsuranceDraft>>({
    labor: { manual: false, manualAmount: "" },
    health: { manual: false, manualAmount: "" },
  });
  const [dependents, setDependents] = useState(String(defaultDependentCount ?? 0));
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const table = useHrQuery<{ tables: InsuranceRateTableRecord[] }>(`/insurance-rates?year=${encodeURIComponent(currentYear)}`);
  const save = useHrWrite<{ ids: string[] }>();
  const activeTables = useMemo(() => new Map(table.data?.tables.filter((item) => item.status === "active").map((item) => [item.scheme, item])), [table.data?.tables]);
  const selected = useMemo(() => ({
    labor: bracketForSalary(activeTables.get("labor")?.brackets, salary),
    health: bracketForSalary(activeTables.get("health")?.brackets, salary),
  }), [activeTables, salary]);

  useEffect(() => { setMessage(""); }, [status, validFrom, salary, drafts, dependents, note]);

  const amount = (scheme: InsuranceScheme) => {
    if (status === "withdrawn") return 0;
    const draft = drafts[scheme];
    return draft.manual ? Number(draft.manualAmount) : selected[scheme]?.insuredAmount;
  };

  const updateDraft = (scheme: InsuranceScheme, patch: Partial<InsuranceDraft>) => setDrafts((current) => ({ ...current, [scheme]: { ...current[scheme], ...patch } }));

  return <Dialog title={existing ? "編輯勞健保" : "新增加保資料"} titleMeta="勞保與健保一起建立版本" onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    const healthDependents = Number(dependents);
    if (status === "enrolled") {
      for (const scheme of SCHEMES) {
        const nextAmount = amount(scheme);
        if (!Number.isSafeInteger(nextAmount) || (nextAmount ?? 0) <= 0) { setMessage(drafts[scheme].manual ? `請輸入${INSURANCE_LABEL[scheme]}人工投保金額。` : `請輸入實際月薪，讓系統依目前啟用的${INSURANCE_LABEL[scheme]}級距帶入投保金額。`); return; }
      }
      if (!Number.isSafeInteger(healthDependents) || healthDependents < 0 || healthDependents > 3) { setMessage("眷屬人數必須介於 0～3。"); return; }
      if ((drafts.labor.manual || drafts.health.manual) && !note.trim()) { setMessage("人工覆寫必須留下覆核備註。"); return; }
    }
    setMessage("");
    const valuesFor = (scheme: InsuranceScheme) => {
      const draft = drafts[scheme];
      const activeTable = activeTables.get(scheme);
      return {
        scheme,
        status,
        validFrom,
        // 在職的人不設訖日；任職已結束時後端要求版本在結束日前收尾，直接帶任職結束日，不另外讓人填。
        validTo: employment.endedOn ?? null,
        insuredAmountMinor: (amount(scheme) ?? 0) * 100,
        dependentCount: scheme === "health" ? healthDependents : 0,
        rateYear: Number(currentYear),
        sourceKind: draft.manual ? "manual" : "official",
        sourceUrl: draft.manual ? "" : activeTable?.sourceUrl ?? "",
        note,
      };
    };
    save.mutate({ path: `/employments/${employment.id}/insurance`, method: "POST", values: { versions: SCHEMES.map(valuesFor) } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存勞健保</Button>}>
    <p>系統會用目前啟用的官方級距依實際月薪自動帶入勞保與健保投保金額；每年級距調整後，再由系統整理需要調整的人員提醒管理者。</p>
    <Field label="狀態"><div className="segmented-control" role="group" aria-label="勞健保狀態">
      <button type="button" className={status === "enrolled" ? "selected" : ""} onClick={() => setStatus("enrolled")}>加保／變更級距</button>
      <button type="button" className={status === "withdrawn" ? "selected" : ""} onClick={() => setStatus("withdrawn")}>退保</button>
    </div></Field>
    <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} hint={existing ? "從這天起套用新的投保資料，前一個版本會在前一天結束。" : undefined} />
    {status === "enrolled" ? <>
      <TextField label="實際月薪（元）" type="number" min="0" step="1" value={salary} required onChange={(event) => setSalary(event.target.value)} hint="投保級距會依目前啟用的官方級距自動判定，不需手動選年度或級距。" />
      <div className="form-grid two">
        {SCHEMES.map((scheme) => {
          const activeTable = activeTables.get(scheme);
          const draft = drafts[scheme];
          const selectedBracket = selected[scheme];
          const nextAmount = draft.manual ? Number(draft.manualAmount) : selectedBracket?.insuredAmount;
          return <section className="hr-insurance-scheme-card" key={scheme}>
            <div><h3>{INSURANCE_LABEL[scheme]}</h3><p className="muted">目前投保金額：{Number.isSafeInteger(nextAmount) && (nextAmount ?? 0) > 0 ? amountLabel(nextAmount) : "尚未決定"}</p></div>
            {!draft.manual ? <p className="form-hint">{selectedBracket ? `第 ${selectedBracket.level} 級／${amountLabel(selectedBracket.insuredAmount)}；來源：官方資料（${activeTable?.fetchedAt ?? "尚未載入"}）` : activeTable ? "請輸入月薪以自動帶入級距。" : `尚未啟用${INSURANCE_LABEL[scheme]}官方級距。`}</p> : null}
            <Field label="人工覆寫" hint="只在官方資料尚未啟用或主管機關要求人工調整時使用。"><span className="checkbox-field"><input type="checkbox" checked={draft.manual} onChange={(event) => updateDraft(scheme, { manual: event.target.checked })} />改用人工投保金額</span></Field>
            {draft.manual ? <TextField label="人工投保金額（元）" type="number" min="0" step="1" value={draft.manualAmount} required onChange={(event) => updateDraft(scheme, { manualAmount: event.target.value })} /> : null}
          </section>;
        })}
      </div>
      <TextField label="健保眷屬人數（0～3）" type="number" min="0" max="3" step="1" value={dependents} onChange={(event) => setDependents(event.target.value)} />
    </> : <Alert tone="info">退保會同時建立勞保與健保退保版本，生效日之後不再列入薪資扣款計算。</Alert>}
    <TextField label="備註" required={(drafts.labor.manual || drafts.health.manual) && status === "enrolled"} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} hint={(drafts.labor.manual || drafts.health.manual) && status === "enrolled" ? "人工覆寫必須留下覆核備註。" : undefined} />
    {table.error ? <Alert tone="danger">{table.error.message}；仍可勾選人工覆寫並填入金額。</Alert> : null}
    {status === "enrolled" && !table.isPending && SCHEMES.some((scheme) => !activeTables.get(scheme) && !drafts[scheme].manual) ? <Alert tone="warning">目前年度尚未有完整已啟用的官方級距；請先同步並啟用，或針對缺少的險別改用人工覆寫。</Alert> : null}
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}
