import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrAnnualLeaveEntitlement, type HrAnnualLeaveEntitlementDetail, type HrAnnualLeaveLedgerEntry, type HrAnnualLeaveResponse } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function dateMinusOne(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function today() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function taipeiDateTime(value: string) {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const parsed = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const parts = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(parsed);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function hours(halfHours: number) {
  return `${(halfHours / 2).toFixed(1)} 小時`;
}

function signedHours(halfHours: number) {
  return `${halfHours > 0 ? "+" : ""}${(halfHours / 2).toFixed(1)} 小時`;
}

function ledgerKindLabel(entryKind: HrAnnualLeaveLedgerEntry["entryKind"]) {
  return {
    grant: "政策發放",
    leave_request: "核准請假扣除",
    manual_adjustment: "人工調整",
    settlement: "未休折現結算",
    settlement_reversal: "反向返還",
  }[entryKind];
}

function annualGrantNote(entitlement: HrAnnualLeaveEntitlementDetail) {
  return `週年制特休自動給予（${entitlement.periodStart}～${dateMinusOne(entitlement.periodEnd)}）`;
}

function ledgerDisplayNote(entry: HrAnnualLeaveLedgerEntry, entitlement: HrAnnualLeaveEntitlementDetail) {
  return entry.entryKind === "grant" ? annualGrantNote(entitlement) : entry.note || "—";
}

function balancePercent(row: HrAnnualLeaveEntitlement) {
  if (row.entitledHalfHours <= 0) return 0;
  return Math.max(0, Math.min(100, row.balanceHalfHours / row.entitledHalfHours * 100));
}

function currentRows(rows: HrAnnualLeaveEntitlement[], asOfDate: string) {
  const byEmployee = new Map<string, HrAnnualLeaveEntitlement[]>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeUserId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeUserId, list);
  }
  return [...byEmployee.values()]
    .map((employeeRows) => {
      const sorted = [...employeeRows].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
      return sorted.find((row) => row.periodStart <= asOfDate && asOfDate < row.periodEnd)
        ?? sorted.find((row) => row.periodStart > asOfDate)
        ?? sorted.at(-1);
    })
    .filter((row): row is HrAnnualLeaveEntitlement => Boolean(row))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, "zh-Hant") || a.employeeNumber.localeCompare(b.employeeNumber));
}

function EntitlementAdjustmentDialog({ row, onClose }: { row: HrAnnualLeaveEntitlement; onClose: () => void }) {
  const [deltaHours, setDeltaHours] = useState("");
  const [reason, setReason] = useState("");
  const save = useHrWrite();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(deltaHours);
    if (!Number.isFinite(parsed) || parsed === 0 || Math.round(parsed * 2) !== parsed * 2) return;
    if (!reason.trim()) return;
    save.mutate({
      path: "/annual-leave/adjustments",
      method: "POST",
      values: { entitlementId: row.id, deltaHalfHours: Math.round(parsed * 2), reason: reason.trim() },
    }, { onSuccess: onClose });
  }

  return <Dialog
    title="人工調整特休額度"
    onClose={onClose}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" loading={save.isPending}>保存調整</Button></>}
  >
    <Alert tone="info">{row.employeeName}／{row.periodStart}～{dateMinusOne(row.periodEnd)}，目前可用 {hours(row.balanceHalfHours)}。正數增加、負數扣除；每次以 0.5 小時為單位並留下原因。</Alert>
    <TextField label="調整時數（小時）" type="number" step="0.5" placeholder="例如：0.5 或 -1" required value={deltaHours} onChange={(event) => setDeltaHours(event.target.value)} />
    <TextField label="調整原因" required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function EntitlementDetailDialog({ row, onClose }: { row: HrAnnualLeaveEntitlement; onClose: () => void }) {
  const detail = useHrQuery<{ entitlement: HrAnnualLeaveEntitlementDetail }>(`/annual-leave/entitlements/${encodeURIComponent(row.id)}`, true, { keepPreviousData: false });
  if (detail.isPending) return <Dialog title={`特休額度明細 · ${row.employeeName}`} onClose={onClose} className="hr-annual-detail-dialog"><p className="muted">載入額度依據與台帳明細…</p></Dialog>;
  if (detail.error || !detail.data) return <Dialog title={`特休額度明細 · ${row.employeeName}`} onClose={onClose} className="hr-annual-detail-dialog"><Alert tone="danger">{detail.error?.message ?? "額度明細載入失敗。"}</Alert></Dialog>;

  const entitlement = detail.data.entitlement;
  const grant = entitlement.ledger.find((entry) => entry.entryKind === "grant");
  const dailyHours = entitlement.policyDailyMinutes / 60;
  const bracketRange = entitlement.bracketMaxServiceMonths === null
    ? `${entitlement.bracketMinServiceMonths} 個月以上`
    : `${entitlement.bracketMinServiceMonths}～未滿 ${entitlement.bracketMaxServiceMonths} 個月`;
  return <Dialog
    title={`特休額度明細 · ${entitlement.employeeName}`}
    titleMeta={`${entitlement.employeeNumber} · ${entitlement.periodStart}～${dateMinusOne(entitlement.periodEnd)}`}
    onClose={onClose}
    className="hr-annual-detail-dialog"
  >
    <Alert tone="info">這一期的額度不是人工輸入：系統以服務年資起算日、取得時的政策版本與年資級距建立額度；後續核准請假、人工調整與折現都只追加台帳紀錄。</Alert>
    <div className="hr-annual-detail-overview">
      <div><span>服務年資起算日</span><strong>{entitlement.serviceStartOn}</strong></div>
      <div><span>本期額度</span><strong>{hours(entitlement.entitledHalfHours)}</strong></div>
      <div><span>目前可用</span><strong>{hours(entitlement.balanceHalfHours)}</strong></div>
    </div>
    <section className="hr-annual-detail-section">
      <h3>為什麼是這個額度</h3>
      <p>本期於 {entitlement.periodStart} 依公司特休政策 v{entitlement.policyVersionNumber} 的「{entitlement.bracketLabel || bracketRange}」級距發放：{entitlement.bracketEntitledDays} 日 × {dailyHours} 小時／日 = {hours(entitlement.entitledHalfHours)}。</p>
      <dl className="hr-annual-detail-list">
        <div><dt>適用政策期間</dt><dd>{entitlement.policyValidFrom}～{entitlement.policyValidTo ? dateMinusOne(entitlement.policyValidTo) : "目前"}</dd></div>
        <div><dt>年資級距</dt><dd>{bracketRange}</dd></div>
        <div><dt>最小單位</dt><dd>{entitlement.policyMinimumUnitMinutes} 分鐘</dd></div>
        <div><dt>未休遞延</dt><dd>{entitlement.policyCarryoverAllowed ? "允許" : "不遞延，週期終結折現"}</dd></div>
      </dl>
    </section>
    <section className="hr-annual-detail-section">
      <h3>什麼時候發放</h3>
      <dl className="hr-annual-detail-list">
        <div><dt>額度生效日</dt><dd>{entitlement.periodStart}</dd></div>
        <div><dt>台帳發放時間</dt><dd>{grant ? `${taipeiDateTime(grant.createdAt)}（台北）` : "—"}</dd></div>
        <div><dt>發放紀錄</dt><dd>{grant ? annualGrantNote(entitlement) : "找不到政策發放紀錄"}</dd></div>
      </dl>
      <p className="form-hint">「額度生效日」代表員工取得這期特休的法律／政策日期；「台帳發放時間」是系統實際寫入 grant 紀錄的時間，回溯補建時兩者可能不同。</p>
    </section>
    <section className="hr-annual-detail-section">
      <h3>額度台帳</h3>
      <div className="table-scroll"><table className="data-table compact hr-annual-ledger-table"><thead><tr><th>寫入時間</th><th>類型</th><th className="numeric">變化</th><th>說明</th></tr></thead><tbody>
        {entitlement.ledger.map((entry) => <tr key={entry.id}><td>{taipeiDateTime(entry.createdAt)}<small>台北時間</small></td><td>{ledgerKindLabel(entry.entryKind)}</td><td className="numeric">{signedHours(entry.deltaHalfHours)}</td><td>{ledgerDisplayNote(entry, entitlement)}</td></tr>)}
        {!entitlement.ledger.length ? <tr><td colSpan={4}><p className="empty-state">目前沒有台帳紀錄。</p></td></tr> : null}
      </tbody></table></div>
    </section>
  </Dialog>;
}

function EntitlementTable({ rows, canWrite, onAdjust, onDetail }: { rows: HrAnnualLeaveEntitlement[]; canWrite: boolean; onAdjust: (row: HrAnnualLeaveEntitlement) => void; onDetail: (row: HrAnnualLeaveEntitlement) => void }) {
  return <div className="table-scroll"><table className="data-table hr-annual-entitlement-table"><thead><tr><th>員工</th><th>可用額度</th><th>本期使用</th><th>到期日</th><th>額度週期</th><th>狀態</th><th>操作</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id}>
      <td data-label="員工"><strong>{row.employeeName}</strong><small>{row.employeeNumber}</small></td>
      <td data-label="可用額度"><div className="hr-annual-balance"><strong>{hours(row.balanceHalfHours)}</strong><small>共 {hours(row.entitledHalfHours)}</small><span className="hr-annual-progress" aria-hidden="true"><span style={{ width: `${balancePercent(row)}%` }} /></span></div></td>
      <td data-label="本期使用">{hours(row.usedHalfHours)}<small>{row.debitHalfHours > 0 ? `扣除 ${hours(row.debitHalfHours)}` : "尚未使用"}</small></td>
      <td data-label="到期日"><strong>{dateMinusOne(row.periodEnd)}</strong><small>週期結束日</small></td>
      <td data-label="額度週期">{row.periodStart}～{dateMinusOne(row.periodEnd)}</td>
      <td data-label="狀態"><StatusBadge tone={row.status === "open" ? "success" : "neutral"}>{row.status === "open" ? "可使用" : "已結算"}</StatusBadge></td>
      <td data-label="操作"><div className="hr-annual-row-actions"><Button variant="secondary" icon="info" onClick={() => onDetail(row)}>查看明細</Button>{canWrite && row.status === "open" ? <Button variant="secondary" icon="edit" onClick={() => onAdjust(row)}>人工調整</Button> : null}</div></td>
    </tr>)}
    {!rows.length ? <tr><td colSpan={7}><p className="empty-state">目前沒有可建立的特休週期；請確認員工已設定服務年資起算日，或執行回溯／補建額度。</p></td></tr> : null}
  </tbody></table></div>;
}

export function HrAnnualLeave() {
  usePageTitle("特休額度");
  const navigate = useNavigate();
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canWrite = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const entitlements = useHrQuery<HrAnnualLeaveResponse>("/annual-leave/entitlements", canRead, { keepPreviousData: false });
  const backfill = useHrWrite();
  const [showHistory, setShowHistory] = useState(false);
  const [adjustment, setAdjustment] = useState<HrAnnualLeaveEntitlement | null>(null);
  const [detail, setDetail] = useState<HrAnnualLeaveEntitlement | null>(null);
  const rows = entitlements.data?.entitlements ?? [];
  const asOfDate = today();
  const employeeRows = useMemo(() => currentRows(rows, asOfDate), [rows, asOfDate]);
  const visibleRows = showHistory ? rows : employeeRows;

  if (!canRead) return <Alert tone="danger">特休額度僅限全平台 HR 管理者查看。</Alert>;
  if (entitlements.isPending) return <HrPageSkeleton variant="table" />;

  return <div className="page fills hr-annual-leave-page">
    <PageHeader
      title="特休額度"
      description="查看已取得特休週期的可用額度與到期日；點選查看明細，可追溯政策級距、發放時間與每筆台帳。"
      actions={<div className="hr-annual-header-actions"><Button variant="secondary" icon="tune" onClick={() => navigate("/hr/annual-leave/settings")}>特休政策</Button>{canWrite ? <Button icon="sync" loading={backfill.isPending} onClick={() => backfill.mutate({ path: "/annual-leave/backfill", method: "POST", values: {} }, { onSuccess: () => { void entitlements.refetch(); } })}>回溯／補建額度</Button> : null}</div>}
    />
    {entitlements.error || backfill.error ? <Alert tone="danger">{entitlements.error?.message ?? backfill.error?.message}</Alert> : null}
    <Panel className="grows hr-annual-list-panel" title={showHistory ? "全部額度週期" : "員工目前額度"} description={showHistory ? "包含歷史週期；人工修正與核准使用都保留在各期台帳。" : "每位員工只顯示目前適用的週期；到期日為該週期結束日前一天。"} actions={<div className="segmented-control hr-annual-view-tabs" role="group" aria-label="額度顯示範圍"><button type="button" className={!showHistory ? "selected" : ""} aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>目前週期</button><button type="button" className={showHistory ? "selected" : ""} aria-pressed={showHistory} onClick={() => setShowHistory(true)}>全部週期</button></div>}>
      <EntitlementTable rows={visibleRows} canWrite={canWrite} onAdjust={setAdjustment} onDetail={setDetail} />
    </Panel>
    {adjustment ? <EntitlementAdjustmentDialog row={adjustment} onClose={() => { setAdjustment(null); void entitlements.refetch(); }} /> : null}
    {detail ? <EntitlementDetailDialog row={detail} onClose={() => setDetail(null)} /> : null}
  </div>;
}
