import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type PayrollLine, type PayrollRecordDetail } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" };
const PERSON_KIND_LABEL = { employee: "正式員工", worker: "支援人員" } as const;
const LINE_LABELS: Record<string, string> = {
  base_salary: "本薪",
  overtime: "核准付薪加班",
  unpaid_leave: "無薪假扣款",
  booth_bonus: "櫃點獎金",
  labor_insurance: "勞保員工負擔",
  health_insurance: "健保員工負擔",
  special_workday: "特殊上班日薪資",
  annual_leave_settlement: "未休特休折現",
};

function previousMonth(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return "";
  const [year, month] = value.split("-").map(Number);
  const previous = new Date(Date.UTC(year!, month! - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}
function money(minor: number): string {
  return `NT$ ${Math.round(minor / 100).toLocaleString("zh-TW")}`;
}
function deductionMoney(minor: number): string {
  return `-NT$ ${Math.abs(Math.round(minor / 100)).toLocaleString("zh-TW")}`;
}
function periodLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return match ? `${match[1]} 年 ${Number(match[2])} 月` : value;
}
function lineLabel(line: PayrollLine): string {
  if (line.lineKey.startsWith("bonus_")) return "業績獎金";
  if (line.lineKey.startsWith("salary_item_")) return "薪資項目";
  if (line.lineKey.startsWith("special_allowance_")) return "特殊上班日補貼";
  return LINE_LABELS[line.lineKey] ?? line.lineKey;
}
function lineFormula(line: PayrollLine): string {
  const explanation = line.explanation;
  const detail = explanation.formulaDetail ?? explanation.formula;
  return typeof detail === "string" && detail ? detail : "依保存的薪資規則計算";
}
function payBasisOf(detail: PayrollRecordDetail) {
  return detail.record.payBasis ? PAY_BASIS_LABEL[detail.record.payBasis] ?? detail.record.payBasis : "—";
}

interface PayrollRecordItemDialogProps {
  detail: PayrollRecordDetail;
  onClose: () => void;
  onSuccess: () => void;
}
function PayrollRecordItemDialog({ detail, onClose, onSuccess }: PayrollRecordItemDialogProps) {
  const [sourcePeriodKey, setSourcePeriodKey] = useState(previousMonth(detail.record.periodKey));
  const [direction, setDirection] = useState<"earning" | "deduction">("deduction");
  const [itemName, setItemName] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const createItem = useHrWrite();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountYuan = Number(amount);
    if (!sourcePeriodKey || sourcePeriodKey === detail.record.periodKey) { setValidationError("請選擇與生效月份不同、且已結帳的原薪資月份。"); return; }
    if (!itemName.trim()) { setValidationError("請填寫加扣項名稱。"); return; }
    if (!Number.isSafeInteger(amountYuan) || amountYuan <= 0) { setValidationError("金額必須是正整數元。"); return; }
    if (!reason.trim()) { setValidationError("請填寫加扣項原因。"); return; }
    setValidationError(null);
    createItem.mutate({
      path: "/payroll/records/items",
      method: "POST",
      values: { runId: detail.record.runId, personKind: detail.record.personKind, personId: detail.record.personId, sourcePeriodKey, direction, itemName: itemName.trim(), amountMinor: amountYuan * 100, reason: reason.trim() },
    }, { onSuccess: () => { onSuccess(); } });
  }

  return <Dialog
    className="hr-payroll-item-dialog"
    title="薪資加扣項"
    titleMeta={`${detail.record.personName}・${periodLabel(detail.record.periodKey)}`}
    onClose={onClose}
    closeDisabled={createItem.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button variant="secondary" onClick={onClose} disabled={createItem.isPending}>取消</Button><Button type="submit" icon="check" loading={createItem.isPending}>保存加扣項</Button></>}
  >
    <Alert tone="info">原薪資月份必須已結帳。加扣項會直接附加到這筆尚未結算的發放紀錄，不會改寫原始試算明細。</Alert>
    <div className="form-grid two">
      <TextField label="原薪資月份" type="month" value={sourcePeriodKey} required onChange={(event) => setSourcePeriodKey(event.target.value)} />
      <SelectField label="項目類型" value={direction} options={[{ value: "deduction", label: "扣款" }, { value: "earning", label: "補發" }]} onChange={(event) => setDirection(event.target.value as "earning" | "deduction")} />
    </div>
    <div className="form-grid two">
      <TextField label="項目名稱" value={itemName} maxLength={100} required placeholder="例如：勞保差額" onChange={(event) => setItemName(event.target.value)} />
      <TextField label="金額（元）" type="number" min="1" step="1" value={amount} required onChange={(event) => setAmount(event.target.value)} />
    </div>
    <TextField label="原因" value={reason} maxLength={1000} required placeholder="說明這筆加扣項的依據" onChange={(event) => setReason(event.target.value)} />
    {validationError || createItem.error ? <Alert tone="danger">{validationError ?? createItem.error?.message}</Alert> : null}
  </Dialog>;
}

export function HrPayrollRecordDetail() {
  usePageTitle("薪資發放明細");
  const navigate = useNavigate();
  const { runId = "", personKind = "", personId = "" } = useParams();
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canCalculate = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const result = useHrQuery<PayrollRecordDetail>(runId && (personKind === "employee" || personKind === "worker") && personId ? `/payroll/records/${encodeURIComponent(runId)}/${personKind}/${encodeURIComponent(personId)}` : "/payroll/records/__none__/employee/__none__", canRead && Boolean(runId && personId), { keepPreviousData: false });
  const approve = useHrWrite<{ approved: number }>();
  const deleteItem = useHrWrite();
  const detail = result.data;
  const baseLines = detail?.employee?.lines ?? [];
  const itemTotals = useMemo(() => (detail?.items ?? []).reduce((totals, item) => item.direction === "earning"
    ? { earningMinor: totals.earningMinor + item.amountMinor, deductionMinor: totals.deductionMinor }
    : { earningMinor: totals.earningMinor, deductionMinor: totals.deductionMinor + item.amountMinor }, { earningMinor: 0, deductionMinor: 0 }), [detail?.items]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (result.isPending) return <HrPageSkeleton variant="detail" />;
  if (result.error || !detail) return <Alert tone="danger">{result.error?.message ?? "找不到這筆薪資發放紀錄。"}</Alert>;

  function approveRecord() {
    approve.mutate({ path: "/payroll/records/approve", method: "POST", values: { records: [{ runId: detail!.record.runId, personKind: detail!.record.personKind, personId: detail!.record.personId }] } }, { onSuccess: () => void result.refetch() });
  }
  function removeItem() {
    if (!deleteItemId) return;
    deleteItem.mutate({ path: `/payroll/records/items/${encodeURIComponent(deleteItemId)}`, method: "DELETE", values: {} }, { onSuccess: () => { setDeleteItemId(null); void result.refetch(); } });
  }

  return <div className="page hr-payroll-page hr-payroll-detail-page">
    <PageHeader title={detail.record.personName} description={`${periodLabel(detail.record.periodKey)}・${PERSON_KIND_LABEL[detail.record.personKind]}・${payBasisOf(detail)}`} actions={<Button variant="secondary" icon="chevronLeft" onClick={() => navigate("/hr/payroll-settlement")}>返回發放紀錄</Button>} />
    <Panel className="hr-payroll-record-detail-panel" title="發放明細" description={`${detail.record.payDate ? `發薪日 ${detail.record.payDate}` : "未設定發薪日"}・試算版本 v${detail.record.versionNumber}`}>
      <div className="hr-payroll-detail-head">
        <div><strong>{detail.record.personNumber ? `${detail.record.personNumber}・` : ""}{PERSON_KIND_LABEL[detail.record.personKind]}</strong><small>建立於 {detail.record.createdAt}</small></div>
        <div className="hr-payroll-detail-actions"><StatusBadge tone={detail.record.status === "closed" ? "success" : "warning"}>{detail.record.status === "closed" ? "已確定發放" : "尚未結算"}</StatusBadge>{canCalculate && detail.record.status === "unsettled" ? <><Button icon="check" loading={approve.isPending} onClick={approveRecord}>確定發放</Button><Button variant="secondary" icon="tune" onClick={() => setItemDialogOpen(true)}>薪資加扣項</Button></> : null}</div>
      </div>
      <div className="hr-payroll-overview" aria-label="薪資合計">
        <div><span>應發</span><strong>{money(detail.record.earningMinor)}</strong></div>
        <div><span>扣款</span><strong>{detail.record.deductionMinor ? deductionMoney(detail.record.deductionMinor) : "—"}</strong></div>
        <div className="hr-payroll-overview-net"><span>實領</span><strong>{money(detail.record.netMinor)}</strong></div>
      </div>
      {detail.record.status === "closed" ? <Alert tone="info">這筆紀錄已確定發放，以下明細是不可改寫的歷史快照。</Alert> : <Alert tone="warning">請確認試算公式與薪資加扣項後，再確定發放。確定後不能再修改。</Alert>}
      {detail.run.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="hr-payroll-warning-list">{detail.run.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}

      {detail.employee ? <div className="hr-payroll-line-list">{baseLines.map((line) => <details className={`hr-payroll-line hr-payroll-line-${line.direction}`} key={line.lineKey}>
        <summary className="hr-payroll-line-summary"><span className="hr-payroll-line-title"><strong>{lineLabel(line)}</strong><span className="hr-payroll-line-direction">{line.direction === "earning" ? "應發" : "扣款"}</span></span><strong className="hr-payroll-line-amount">{line.direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</strong></summary>
        <div className="hr-payroll-line-content"><div className="hr-payroll-line-formula"><span>計算公式</span><p>{lineFormula(line)}</p></div></div>
      </details>)}</div> : <div className="hr-payroll-worker-result"><div className="hr-payroll-worker-result-head"><div><strong>{detail.worker?.workerName}</strong><small>排班支援・{detail.worker ? PAY_BASIS_LABEL[detail.worker.payBasis] ?? detail.worker.payBasis : ""}</small></div><strong>{money(detail.worker?.amountMinor ?? 0)}</strong></div><p>依已發布排班與有效敘薪計算；原始試算結果保留在這筆發放紀錄中。</p></div>}

      <section className="hr-payroll-record-items" aria-labelledby="payroll-items-title">
        <div className="hr-payroll-section-head"><div><h3 id="payroll-items-title">薪資加扣項</h3><p>附加在這筆紀錄的補發與扣款。</p></div>{canCalculate && detail.record.status === "unsettled" ? <Button variant="secondary" icon="plus" onClick={() => setItemDialogOpen(true)}>新增加扣項</Button> : null}</div>
        {detail.items.length ? <div className="table-scroll"><table className="data-table compact"><thead><tr><th>項目</th><th>原薪資月份</th><th>原因</th><th className="numeric">金額</th><th>操作</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.itemName}</strong><small className="cell-sub">{item.direction === "earning" ? "補發" : "扣款"}</small></td><td>{periodLabel(item.sourcePeriodKey)}</td><td>{item.reason}</td><td className="numeric">{item.direction === "earning" ? money(item.amountMinor) : deductionMoney(item.amountMinor)}</td><td>{canCalculate && detail.record.status === "unsettled" ? <Button variant="danger" onClick={() => setDeleteItemId(item.id)}>刪除</Button> : null}</td></tr>)}</tbody></table></div> : <p className="empty-state">尚未加入薪資加扣項。</p>}
        {detail.items.length ? <p className="form-hint">加扣項合計：補發 {money(itemTotals.earningMinor)}・扣款 {itemTotals.deductionMinor ? deductionMoney(itemTotals.deductionMinor) : "—"}</p> : null}
      </section>
      {approve.error ? <Alert tone="danger">{approve.error.message}</Alert> : null}
    </Panel>
    {itemDialogOpen ? <PayrollRecordItemDialog detail={detail} onClose={() => setItemDialogOpen(false)} onSuccess={() => { setItemDialogOpen(false); void result.refetch(); }} /> : null}
    {deleteItemId ? <ConfirmDialog title="刪除這筆薪資加扣項？" confirmLabel="刪除" pending={deleteItem.isPending} onCancel={() => { if (!deleteItem.isPending) setDeleteItemId(null); }} onConfirm={removeItem}>
      <p>刪除後會立即從這筆尚未結算的發放紀錄移除。</p>
      {deleteItem.error ? <Alert tone="danger">{deleteItem.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
