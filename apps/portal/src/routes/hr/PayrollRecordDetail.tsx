import { useMemo, useRef, useState, type FormEvent, type Ref } from "react";
import { useNavigate, useParams } from "react-router";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, PageHeader, Panel, SelectField, StatusBadge, TextField } from "../../ui/index.js";
import { downloadPayslipImage } from "./exportPayslip.js";
import { useHrQuery, useHrWrite, type PayrollLine, type PayrollRecordDetail } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

const PAY_BASIS_LABEL: Record<string, string> = { monthly: "月薪", daily: "日薪", hourly: "時薪", mixed: "混合" };
const PERSON_KIND_LABEL = { employee: "正式員工", worker: "支援人員" } as const;
const LINE_LABELS: Record<string, string> = {
  base_salary: "本薪",
  overtime: "核准付薪加班",
  unpaid_leave: "請假扣款",
  booth_bonus: "櫃點獎金",
  labor_insurance: "勞保員工負擔",
  health_insurance: "健保員工負擔",
  special_workday: "特殊上班日薪資加給",
  annual_leave_settlement: "未休特休折現",
  typhoon_stop_pay: "災防停班給薪",
  worker_pay: "排班薪資",
};

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
function explanationString(line: PayrollLine, key: string): string | null {
  const value = line.explanation[key];
  return typeof value === "string" && value.trim() ? value : null;
}
function leaveHoursOf(line: PayrollLine): Array<{ leaveType: string; hours: number }> {
  const values = line.explanation.leaveHours;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const leaveType = (value as { leaveType?: unknown }).leaveType;
    const hours = (value as { hours?: unknown }).hours;
    return typeof leaveType === "string" && leaveType.trim() && typeof hours === "number" && Number.isFinite(hours) && hours > 0
      ? [{ leaveType: leaveType.trim(), hours }]
      : [];
  });
}
function leaveDeductionLabel(line: PayrollLine): string {
  const summary = leaveHoursOf(line).map(({ leaveType, hours }) => `${leaveType} ${hours.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 小時`);
  return summary.length ? `請假扣款（${summary.join("、")}）` : "請假扣款";
}
function ruleNamesOf(line: PayrollLine): string[] {
  const names = Array.isArray(line.explanation.ruleNames) ? line.explanation.ruleNames.filter((name): name is string => typeof name === "string" && Boolean(name.trim())) : [];
  const singleName = explanationString(line, "ruleName");
  const legacyName = line.lineKey.startsWith("special_allowance_") ? explanationString(line, "rule") : null;
  return [...new Set([...names, ...(singleName ? [singleName] : []), ...(legacyName ? [legacyName] : [])])];
}
function explanationItemNamesOf(line: PayrollLine): string[] {
  const names = [explanationString(line, "itemName")].filter((name): name is string => Boolean(name));
  const quantities = line.explanation.quantities;
  if (Array.isArray(quantities)) {
    for (const value of quantities) {
      if (!value || typeof value !== "object") continue;
      const itemName = (value as { itemName?: unknown }).itemName;
      if (typeof itemName === "string" && itemName.trim()) names.push(itemName);
    }
  }
  return [...new Set(names)];
}
function specialAllowanceLabel(line: PayrollLine): string {
  const ruleName = explanationString(line, "ruleName") ?? explanationString(line, "rule");
  const itemNames = explanationItemNamesOf(line);
  if (ruleName && itemNames.length) return `${ruleName}：${itemNames.join("、")}`;
  if (itemNames.length) return itemNames.join("、");
  return ruleName ? `特殊上班日補貼（${ruleName}）` : "特殊上班日補貼";
}
function specialWorkdayDifferenceLabel(line: PayrollLine): string {
  const names = ruleNamesOf(line);
  if (names.length === 1) return `${names[0]}：薪資加給`;
  if (names.length > 1) return `特殊上班日（${names.join("、")}）薪資加給`;
  return "特殊上班日薪資加給";
}
function lineLabel(line: PayrollLine): string {
  if (line.lineKey === "unpaid_leave") return leaveDeductionLabel(line);
  if (line.lineKey.startsWith("special_allowance_")) return specialAllowanceLabel(line);
  if (line.lineKey === "special_workday") return specialWorkdayDifferenceLabel(line);
  const itemName = explanationString(line, "itemName");
  if (itemName) return itemName;
  if (line.lineKey.startsWith("bonus_")) return "業績獎金";
  if (line.lineKey.startsWith("salary_item_")) return "薪資項目";
  if (line.lineKey.startsWith("adjustment_")) return "薪資加扣項";
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
function payrollLinesOf(detail: PayrollRecordDetail): PayrollLine[] {
  const baseLines = detail.employee?.lines ?? (detail.worker ? [{ lineKey: "worker_pay", direction: "earning" as const, amountMinor: detail.worker.amountMinor, explanation: {} }] : []);
  const legacyLines = detail.items.map((item) => ({
    lineKey: `legacy_adjustment_${item.id}`,
    direction: item.direction,
    amountMinor: item.amountMinor,
    explanation: { itemName: item.itemName, reason: item.reason, formulaDetail: `歷史薪資加扣項（${item.itemName}）：${item.reason}` },
  }));
  return [...baseLines, ...legacyLines];
}

interface PayrollRecordItemDialogProps {
  detail: PayrollRecordDetail;
  onClose: () => void;
  onSuccess: () => void;
}

function PayrollRecordItemDialog({ detail, onClose, onSuccess }: PayrollRecordItemDialogProps) {
  const [direction, setDirection] = useState<"earning" | "deduction">("deduction");
  const [itemName, setItemName] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const createItem = useHrWrite();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountYuan = Number(amount);
    if (!itemName.trim()) { setValidationError("請填寫加扣項名稱。"); return; }
    if (!Number.isSafeInteger(amountYuan) || amountYuan <= 0) { setValidationError("金額必須是正整數元。"); return; }
    if (!reason.trim()) { setValidationError("請填寫加扣項原因。"); return; }
    setValidationError(null);
    createItem.mutate({
      path: "/payroll/records/items",
      method: "POST",
      values: { runId: detail.record.runId, personKind: detail.record.personKind, personId: detail.record.personId, direction, itemName: itemName.trim(), amountMinor: amountYuan * 100, reason: reason.trim() },
    }, { onSuccess });
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
    <Alert tone="info">加扣項會直接附加到這筆尚未結算的發放紀錄，不需要對應原薪資月份。</Alert>
    <div className="form-grid two">
      <SelectField label="項目類型" value={direction} options={[{ value: "deduction", label: "扣款" }, { value: "earning", label: "補發" }]} onChange={(event) => setDirection(event.target.value as "earning" | "deduction")} />
      <TextField label="項目名稱" value={itemName} maxLength={100} required placeholder="例如：一次性獎金" onChange={(event) => setItemName(event.target.value)} />
    </div>
    <TextField label="金額（元）" type="number" min="1" step="1" value={amount} required onChange={(event) => setAmount(event.target.value)} />
    <TextField label="原因" value={reason} maxLength={1000} required placeholder="說明這筆加扣項的依據" onChange={(event) => setReason(event.target.value)} />
    {validationError || createItem.error ? <Alert tone="danger">{validationError ?? createItem.error?.message}</Alert> : null}
  </Dialog>;
}

function PayrollPayslipTable({ title, lines, direction }: { title: string; lines: PayrollLine[]; direction: PayrollLine["direction"] }) {
  const filteredLines = lines.filter((line) => line.direction === direction);
  return <section className="hr-payroll-payslip-section" aria-labelledby={`payroll-payslip-${direction}`}>
    <h2 id={`payroll-payslip-${direction}`}>{title}</h2>
    <DataTable className="hr-payroll-payslip-table" containerClassName="hr-payroll-payslip-table-scroll">
      <thead><tr><th>薪資項目</th><th className="numeric">金額</th></tr></thead>
      <tbody>{filteredLines.length ? filteredLines.map((line) => <tr key={line.lineKey}><td>{lineLabel(line)}</td><td className="numeric">{direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</td></tr>) : <tr><td colSpan={2}>—</td></tr>}</tbody>
    </DataTable>
  </section>;
}

function PayrollPayslip({ detail, elementRef }: { detail: PayrollRecordDetail; elementRef?: Ref<HTMLElement> }) {
  const lines = payrollLinesOf(detail);
  const titleId = "hr-payroll-payslip-preview-title";
  return <section ref={elementRef} className="hr-payroll-payslip hr-payroll-payslip-preview" aria-labelledby={titleId}>
    <header className="hr-payroll-payslip-head">
      <div><p>員工薪資條</p><h1 id={titleId}>{detail.record.personName}</h1></div>
      <strong>{periodLabel(detail.record.periodKey)}</strong>
    </header>
    <dl className="hr-payroll-payslip-meta">
      <div><dt>員工編號</dt><dd>{detail.record.personNumber ?? "—"}</dd></div>
      <div><dt>人員類型</dt><dd>{PERSON_KIND_LABEL[detail.record.personKind]}</dd></div>
      <div><dt>計薪方式</dt><dd>{payBasisOf(detail)}</dd></div>
      <div><dt>發薪日</dt><dd>{detail.record.payDate ?? "—"}</dd></div>
    </dl>
    <PayrollPayslipTable title="應發項目" lines={lines} direction="earning" />
    <PayrollPayslipTable title="扣款項目" lines={lines} direction="deduction" />
    <dl className="hr-payroll-payslip-totals">
      <div><dt>應發合計</dt><dd>{money(detail.record.earningMinor)}</dd></div>
      <div><dt>扣款合計</dt><dd>{detail.record.deductionMinor ? deductionMoney(detail.record.deductionMinor) : "—"}</dd></div>
      <div><dt>實領合計</dt><dd>{money(detail.record.netMinor)}</dd></div>
    </dl>
  </section>;
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
  const [deleteRunOpen, setDeleteRunOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");
  const [withdrawValidationError, setWithdrawValidationError] = useState<string | null>(null);
  const [payslipPreviewOpen, setPayslipPreviewOpen] = useState(false);
  const [payslipDownloading, setPayslipDownloading] = useState(false);
  const payslipPreviewRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const result = useHrQuery<PayrollRecordDetail>(runId && (personKind === "employee" || personKind === "worker") && personId ? `/payroll/records/${encodeURIComponent(runId)}/${personKind}/${encodeURIComponent(personId)}` : "/payroll/records/__none__/employee/__none__", canRead && Boolean(runId && personId), { keepPreviousData: false });
  const approve = useHrWrite<{ approved: number }>();
  const deleteItem = useHrWrite();
  const deleteRun = useHrWrite<{ id: string; deleted: true }>();
  const withdraw = useHrWrite();
  const detail = result.data;
  const itemTotals = useMemo(() => (detail?.items ?? []).reduce((totals, item) => item.direction === "earning"
    ? { earningMinor: totals.earningMinor + item.amountMinor, deductionMinor: totals.deductionMinor }
    : { earningMinor: totals.earningMinor, deductionMinor: totals.deductionMinor + item.amountMinor }, { earningMinor: 0, deductionMinor: 0 }), [detail?.items]);

  if (!canRead) return <Alert tone="danger">薪資資料僅限全平台 HR 管理者查看。</Alert>;
  if (result.isPending) return <HrPageSkeleton variant="detail" />;
  if (result.error || !detail) return <Alert tone="danger">{result.error?.message ?? "找不到這筆薪資發放紀錄。"}</Alert>;
  const detailLines = payrollLinesOf(detail);

  function approveRecord() {
    approve.mutate({ path: "/payroll/records/approve", method: "POST", values: { records: [{ runId: detail!.record.runId, personKind: detail!.record.personKind, personId: detail!.record.personId }] } }, { onSuccess: () => void result.refetch() });
  }
  function removeItem() {
    if (!deleteItemId) return;
    deleteItem.mutate({ path: `/payroll/records/items/${encodeURIComponent(deleteItemId)}`, method: "DELETE", values: {} }, { onSuccess: () => { setDeleteItemId(null); void result.refetch(); } });
  }
  function removeRun() {
    deleteRun.mutate({ path: `/payroll/runs/${encodeURIComponent(detail!.record.runId)}`, method: "DELETE", values: {} }, { onSuccess: () => { setDeleteRunOpen(false); navigate("/hr/payroll-settlement", { replace: true }); } });
  }
  function withdrawRun() {
    const reason = withdrawReason.trim();
    if (!reason) { setWithdrawValidationError("請填寫撤回原因。"); return; }
    setWithdrawValidationError(null);
    withdraw.mutate({ path: `/payroll/runs/${encodeURIComponent(detail!.record.runId)}/withdraw`, method: "POST", values: { reason } }, { onSuccess: () => { setWithdrawOpen(false); void result.refetch(); toast.show("薪資批次已退回尚未結算，可以重新試算。", "success"); } });
  }
  async function downloadPayslip() {
    const element = payslipPreviewRef.current;
    if (!element || payslipDownloading) return;
    setPayslipDownloading(true);
    try {
      await downloadPayslipImage(element, detail!.record.personName, detail!.record.periodKey);
      toast.show("薪資條 PNG 已下載。");
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : "圖片產生失敗，請再試一次。", "danger");
    } finally {
      setPayslipDownloading(false);
    }
  }

  return <div className="page hr-payroll-page hr-payroll-detail-page">
    <PageHeader title={detail.record.personName} description={`${periodLabel(detail.record.periodKey)}・${PERSON_KIND_LABEL[detail.record.personKind]}・${payBasisOf(detail)}`} actions={<div className="hr-payroll-detail-page-actions"><Button variant="secondary" icon="eye" onClick={() => setPayslipPreviewOpen(true)}>預覽薪資條</Button><Button variant="secondary" icon="chevronLeft" onClick={() => navigate("/hr/payroll-settlement")}>返回發放紀錄</Button></div>} />
    <Panel className="hr-payroll-record-detail-panel" title="發放明細" description={`${detail.record.payDate ? `發薪日 ${detail.record.payDate}` : "未設定發薪日"}・試算版本 v${detail.record.versionNumber}`}>
      <div className="hr-payroll-detail-head">
        <div><strong>{detail.record.personNumber ? `${detail.record.personNumber}・` : ""}{PERSON_KIND_LABEL[detail.record.personKind]}</strong><small>建立於 {detail.record.createdAt}</small></div>
        <div className="hr-payroll-detail-actions"><StatusBadge tone={detail.record.status === "closed" ? "success" : "warning"}>{detail.record.status === "closed" ? "已確定發放" : "尚未結算"}</StatusBadge>{canCalculate && detail.record.status === "unsettled" ? <><Button icon="check" loading={approve.isPending} disabled={deleteRun.isPending || withdraw.isPending} onClick={approveRecord}>確定發放</Button><Button variant="secondary" icon="tune" disabled={deleteRun.isPending || withdraw.isPending} onClick={() => setItemDialogOpen(true)}>薪資加扣項</Button>{detail.run.canDelete ? <Button variant="danger" icon="trash" disabled={approve.isPending || withdraw.isPending} onClick={() => { deleteRun.reset(); setDeleteRunOpen(true); }}>刪除整批試算</Button> : null}</> : null}{canCalculate && detail.record.status === "closed" && !detail.run.withdrawal ? <Button variant="danger" icon="history" disabled={approve.isPending || deleteRun.isPending || withdraw.isPending} onClick={() => { withdraw.reset(); setWithdrawReason(""); setWithdrawValidationError(null); setWithdrawOpen(true); }}>撤回整批發放</Button> : null}</div>
      </div>
      <div className="hr-payroll-overview" aria-label="薪資合計">
        <div><span>應發</span><strong>{money(detail.record.earningMinor)}</strong></div>
        <div><span>扣款</span><strong>{detail.record.deductionMinor ? deductionMoney(detail.record.deductionMinor) : "—"}</strong></div>
        <div className="hr-payroll-overview-net"><span>實領</span><strong>{money(detail.record.netMinor)}</strong></div>
      </div>
      {detail.record.status === "closed" ? <Alert tone="info">這筆紀錄已確定發放，以下明細是不可改寫的歷史快照。{detail.run.withdrawal ? <p>本批次曾撤回後重新確定發放；原撤回原因：{detail.run.withdrawal.reason}（{detail.run.withdrawal.withdrawnAt}）</p> : null}</Alert> : detail.run.withdrawal ? <Alert tone="warning"><strong>這筆薪資批次已退回尚未結算。</strong> 原始薪資快照與撤回原因仍保留供稽核，現在可以重新確認發放或重新試算。<p>撤回原因：{detail.run.withdrawal.reason}（{detail.run.withdrawal.withdrawnAt}）</p></Alert> : detail.run.canDelete ? <Alert tone="warning">請確認試算公式與薪資加扣項後，再確定發放。薪資加扣項會以試算時保存的明細快照呈現；若資料有變更，請重新試算。</Alert> : <Alert tone="info">本批次已有其他人員確定發放，不能刪除整批試算；目前紀錄仍可繼續確認。</Alert>}
      {detail.run.warnings.length ? <Alert tone="warning"><strong>試算提醒</strong><ul className="hr-payroll-warning-list">{detail.run.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></Alert> : null}

      {detail.employee ? <div className="hr-payroll-line-list">{detailLines.map((line) => <details className={`hr-payroll-line hr-payroll-line-${line.direction}`} key={line.lineKey}>
        <summary className="hr-payroll-line-summary"><span className="hr-payroll-line-title"><strong>{lineLabel(line)}</strong><span className="hr-payroll-line-direction">{line.direction === "earning" ? "應發" : "扣款"}</span></span><strong className="hr-payroll-line-amount">{line.direction === "deduction" ? deductionMoney(line.amountMinor) : money(line.amountMinor)}</strong></summary>
        <div className="hr-payroll-line-content"><div className="hr-payroll-line-formula"><span>計算公式</span><p>{lineFormula(line)}</p></div></div>
      </details>)}</div> : <div className="hr-payroll-worker-result"><div className="hr-payroll-worker-result-head"><div><strong>{detail.worker?.workerName}</strong><small>排班支援・{detail.worker ? PAY_BASIS_LABEL[detail.worker.payBasis] ?? detail.worker.payBasis : ""}</small></div><strong>{money(detail.worker?.amountMinor ?? 0)}</strong></div><p>依已發布排班與有效敘薪計算；原始試算結果保留在這筆發放紀錄中。</p></div>}

      <section className="hr-payroll-record-items" aria-labelledby="payroll-items-title">
        <div className="hr-payroll-section-head"><div><h3 id="payroll-items-title">薪資加扣項</h3><p>附加在這筆紀錄的補發與扣款。</p></div>{canCalculate && detail.record.status === "unsettled" ? <Button variant="secondary" icon="plus" onClick={() => setItemDialogOpen(true)}>新增加扣項</Button> : null}</div>
        {detail.items.length ? <DataTable className="compact"><thead><tr><th>項目</th><th>原因</th><th className="numeric">金額</th><th>操作</th></tr></thead><tbody>{detail.items.map((item) => <tr key={item.id}><td><strong>{item.itemName}</strong><small className="cell-sub">{item.direction === "earning" ? "補發" : "扣款"}</small></td><td>{item.reason}</td><td className="numeric">{item.direction === "earning" ? money(item.amountMinor) : deductionMoney(item.amountMinor)}</td><td>{canCalculate && detail.record.status === "unsettled" ? <Button variant="danger" onClick={() => setDeleteItemId(item.id)}>刪除</Button> : null}</td></tr>)}</tbody></DataTable> : <EmptyState>尚未加入薪資加扣項。</EmptyState>}
        {detail.items.length ? <p className="form-hint">加扣項合計：補發 {money(itemTotals.earningMinor)}・扣款 {itemTotals.deductionMinor ? deductionMoney(itemTotals.deductionMinor) : "—"}</p> : null}
      </section>
      {approve.error ? <Alert tone="danger">{approve.error.message}</Alert> : null}
    </Panel>
    {itemDialogOpen ? <PayrollRecordItemDialog detail={detail} onClose={() => setItemDialogOpen(false)} onSuccess={() => { setItemDialogOpen(false); void result.refetch(); }} /> : null}
    {deleteItemId ? <ConfirmDialog title="刪除這筆薪資加扣項？" confirmLabel="刪除" pending={deleteItem.isPending} onCancel={() => { if (!deleteItem.isPending) setDeleteItemId(null); }} onConfirm={removeItem}>
      <p>刪除後會立即從這筆尚未結算的發放紀錄移除。</p>
      {deleteItem.error ? <Alert tone="danger">{deleteItem.error.message}</Alert> : null}
    </ConfirmDialog> : null}
    {payslipPreviewOpen ? <Dialog
      className="hr-payroll-preview-dialog"
      bodyClassName="hr-payroll-payslip-preview-body"
      title="薪資條預覽"
      titleMeta={`${detail.record.personName}・${periodLabel(detail.record.periodKey)}`}
      onClose={() => setPayslipPreviewOpen(false)}
      actions={<><Button variant="secondary" onClick={() => setPayslipPreviewOpen(false)}>關閉</Button><Button icon="download" loading={payslipDownloading} loadingLabel="產生圖片…" onClick={() => { void downloadPayslip(); }}>下載薪資條</Button></>}
    ><PayrollPayslip detail={detail} elementRef={payslipPreviewRef} /></Dialog> : null}
    {withdrawOpen ? <ConfirmDialog title="撤回整批薪資發放？" confirmLabel="撤回發放" pending={withdraw.isPending} onCancel={() => { if (!withdraw.isPending) setWithdrawOpen(false); }} onConfirm={withdrawRun}>
      <p><strong>{detail.run.runName}</strong>（{periodLabel(detail.run.periodKey)}）的已確定發放結果會退回「尚未結算」，原始薪資快照與撤回原因仍會保留。</p>
      <p>撤回後該期間會重新開放，可重新確認發放或重新試算；若已產生未休特休折現，系統也會一併恢復額度。</p>
      <TextField label="撤回原因" value={withdrawReason} maxLength={1000} required placeholder="請說明撤回原因" onChange={(event) => setWithdrawReason(event.target.value)} />
      {withdrawValidationError || withdraw.error ? <Alert tone="danger">{withdrawValidationError ?? withdraw.error?.message}</Alert> : null}
    </ConfirmDialog> : null}
    {deleteRunOpen ? <ConfirmDialog title="刪除整批薪資試算？" confirmLabel="刪除試算" pending={deleteRun.isPending} onCancel={() => { if (!deleteRun.isPending) setDeleteRunOpen(false); }} onConfirm={removeRun}>
      <p><strong>{detail.run.runName}</strong>（{periodLabel(detail.run.periodKey)}）會連同本批次所有尚未結算的發放紀錄、試算明細與薪資加扣項一併刪除。</p>
      <p>已確定發放的歷史紀錄不受影響；刪除只適用於尚未有任何人員確定發放的批次。</p>
      {deleteRun.error ? <Alert tone="danger">{deleteRun.error.message}</Alert> : null}
    </ConfirmDialog> : null}
  </div>;
}
