import { useEffect, useState } from "react";
import { Alert, Button, Dialog, Field, SelectField, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type Employment, type InsuranceBracketTable } from "./api.js";

const INSURANCE_LABEL: Record<"labor" | "health", string> = { labor: "勞保", health: "健保" };

function taipeiToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function InsuranceEditor({ employment, scheme, defaultSalary, onClose }: { employment: Employment; scheme: "labor" | "health"; defaultSalary?: number; onClose: () => void }) {
  const [year, setYear] = useState(taipeiToday().slice(0, 4));
  const [status, setStatus] = useState<"enrolled" | "withdrawn">("enrolled");
  const [validFrom, setValidFrom] = useState(employment.hiredOn);
  const [validTo, setValidTo] = useState("");
  const [salary, setSalary] = useState(defaultSalary === undefined ? "" : String(defaultSalary));
  const [manual, setManual] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [level, setLevel] = useState("");
  const [dependents, setDependents] = useState("0");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const table = useHrQuery<{ tables: InsuranceBracketTable[] }>(`/insurance-brackets?year=${encodeURIComponent(year)}`, !manual);
  const save = useHrWrite();
  const selectedTable = table.data?.tables.find((item) => item.scheme === scheme);
  const selected = selectedTable?.brackets.find((bracket) => bracket.level === Number(level)) ?? selectedTable?.brackets.find((bracket) => {
    const value = Number(salary);
    return Number.isSafeInteger(value) && value >= bracket.lowerSalary && (bracket.upperSalary === null || value <= bracket.upperSalary);
  });
  useEffect(() => {
    if (!manual && selected) setLevel(String(selected.level));
  }, [manual, selected]);
  const sourceUrl = selectedTable?.sourceUrl ?? "";
  const amount = status === "withdrawn" ? 0 : manual ? Number(manualAmount) : (selected?.insuredAmount ?? 0);

  return <Dialog title={`${INSURANCE_LABEL[scheme]}加退保`} onClose={onClose} closeDisabled={save.isPending} formProps={{ onSubmit: (event) => {
    event.preventDefault();
    if (status === "enrolled" && (!Number.isSafeInteger(amount) || amount <= 0)) { setMessage(manual ? "請輸入人工覆寫的投保金額。" : "請輸入實際薪資並選擇官方級距。"); return; }
    const rateYear = Number(year);
    if (!Number.isSafeInteger(rateYear) || rateYear < 1900 || rateYear > 9999) { setMessage("年度不正確。"); return; }
    setMessage("");
    save.mutate({ path: `/employments/${employment.id}/insurance`, method: "POST", values: {
      scheme, status, validFrom, validTo: validTo || null, insuredAmountMinor: amount * 100,
      dependentCount: scheme === "health" ? Number(dependents) : 0, rateYear, sourceKind: manual ? "manual" : "official", sourceUrl, note,
    } }, { onSuccess: onClose });
  } }} actions={<Button type="submit" loading={save.isPending}>儲存</Button>}>
    <p>官方級距由勞動部／健保署開放資料即時取得；法定資料無法取得時不自行推測。</p>
    <SelectField label="狀態" value={status} options={[{ value: "enrolled", label: "加保／變更級距" }, { value: "withdrawn", label: "退保" }]} onChange={(event) => setStatus(event.target.value as "enrolled" | "withdrawn")} />
    <TextField label="生效日" type="date" value={validFrom} required onChange={(event) => setValidFrom(event.target.value)} />
    <TextField label="迄日（不含，可留空）" type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
    <TextField label="級距年度" type="number" min="1900" max="9999" value={year} required onChange={(event) => setYear(event.target.value)} />
    {status === "enrolled" ? <>
      <TextField label="實際月薪（元）" type="number" min="0" step="1" value={salary} required={!manual} onChange={(event) => setSalary(event.target.value)} hint="系統會依官方實際薪資範圍帶入投保金額。" />
      <SelectField label="官方投保級距" value={String(selected?.level ?? "")} disabled={manual || !selectedTable} options={[{ value: "", label: selectedTable ? "請先輸入月薪" : "官方資料載入中" }, ...(selectedTable?.brackets ?? []).map((bracket) => ({ value: String(bracket.level), label: `第 ${bracket.level} 級／NT$ ${bracket.insuredAmount.toLocaleString("zh-TW")}` }))]} onChange={(event) => setLevel(event.target.value)} />
      <Field label="人工覆寫" hint="人工覆寫會在歷史紀錄標示來源，請確認主管機關資料後再使用。"><span className="checkbox-field"><input type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} />改用人工投保金額</span></Field>
      {manual ? <TextField label="人工投保金額（元）" type="number" min="0" step="1" value={manualAmount} required onChange={(event) => setManualAmount(event.target.value)} /> : null}
      {scheme === "health" ? <TextField label="眷屬人數（0～3）" type="number" min="0" max="3" step="1" value={dependents} onChange={(event) => setDependents(event.target.value)} /> : null}
      <p className="muted">本次投保金額：{amount > 0 ? `NT$ ${amount.toLocaleString("zh-TW")}` : "尚未決定"}{selectedTable ? `；來源：官方資料（${selectedTable.fetchedAt}）` : ""}</p>
    </> : null}
    <TextField label="備註" value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
    {table.error ? <Alert tone="danger">{table.error.message}；仍可勾選人工覆寫並填入金額。</Alert> : null}
    {message || save.error ? <Alert tone="danger">{message || save.error?.message}</Alert> : null}
  </Dialog>;
}
