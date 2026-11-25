import { parseDbDate } from "@rueisiang/db/db-timestamp";
import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, FormHint, Page, PageHeader, Panel, SegmentedControl, StatusBadge, TextField } from "../../ui/index.js";
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
  const parsed = parseDbDate(value);
  if (!parsed) return value;
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
    .sort((a, b) => a.employeeNumber.localeCompare(b.employeeNumber, "zh-Hant", { numeric: true }) || a.employeeName.localeCompare(b.employeeName, "zh-Hant"));
}

// 台帳沒有資料時的 EmptyState 也是 <p>，段落樣式寫成後代選擇器才會一併套上。
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="grid gap-2.5 [&_p]:m-0 [&_p]:leading-[1.7]">
    <h3 className="m-0 text-[15px]">{title}</h3>
    {children}
  </section>;
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1 rounded-[14px] bg-brand/7 px-3.5 py-[13px]"><span className="text-[12px] text-muted">{label}</span><strong className="text-[15px] tabular-nums">{value}</strong></div>;
}

function DetailList({ children }: { children: React.ReactNode }) {
  return <dl className="m-0 grid gap-2">{children}</dl>;
}

function DetailRow({ term, children }: { term: string; children: React.ReactNode }) {
  return <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-b border-b-ink/8 pb-2 max-[620px]:grid-cols-[minmax(100px,0.35fr)_minmax(0,1fr)]"><dt className="text-[13px] text-muted">{term}</dt><dd className="m-0 wrap-anywhere">{children}</dd></div>;
}

function EntitlementAdjustmentDialog({ row, onClose }: { row: HrAnnualLeaveEntitlement; onClose: () => void }) {
  const [deltaHours, setDeltaHours] = useState("");
  const [reason, setReason] = useState("");
  const save = useHrWrite();
  const closeRequestRef = useRef<(() => void) | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = Number(deltaHours);
    if (!Number.isFinite(parsed) || parsed === 0 || Math.round(parsed * 2) !== parsed * 2) return;
    if (!reason.trim()) return;
    save.mutate({
      path: "/annual-leave/adjustments",
      method: "POST",
      values: { entitlementId: row.id, deltaHalfHours: Math.round(parsed * 2), reason: reason.trim() },
    }, { onSuccess: () => { (closeRequestRef.current ?? onClose)(); } });
  }

  return <Dialog
    title="人工調整特休額度"
    onClose={onClose}
    closeRequestRef={closeRequestRef}
    closeDisabled={save.isPending}
    formProps={{ onSubmit: submit }}
    actions={<><Button type="button" variant="secondary" onClick={onClose}>取消</Button><Button type="submit" tone="info" loading={save.isPending}>保存調整</Button></>}
  >
    <Alert tone="info">{row.employeeName}／{row.periodStart}～{dateMinusOne(row.periodEnd)}，目前可用 {hours(row.balanceHalfHours)}。正數增加、負數扣除；每次以 0.5 小時為單位並留下原因。</Alert>
    <TextField label="調整時數（小時）" type="number" step="0.5" placeholder="例如：0.5 或 -1" required value={deltaHours} onChange={(event) => setDeltaHours(event.target.value)} />
    <TextField label="調整原因" required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
    {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
  </Dialog>;
}

function EntitlementDetailDialog({ row, onClose }: { row: HrAnnualLeaveEntitlement; onClose: () => void }) {
  const detail = useHrQuery<{ entitlement: HrAnnualLeaveEntitlementDetail }>(`/annual-leave/entitlements/${encodeURIComponent(row.id)}`, true, { keepPreviousData: false });
  if (detail.isPending) return <Dialog title={`特休額度明細 · ${row.employeeName}`} onClose={onClose} width={760} bodyLayout="grid gap-[18px] px-6 pb-2"><p className="text-muted">載入額度依據與台帳明細…</p></Dialog>;
  if (detail.error || !detail.data) return <Dialog title={`特休額度明細 · ${row.employeeName}`} onClose={onClose} width={760} bodyLayout="grid gap-[18px] px-6 pb-2"><Alert tone="danger">{detail.error?.message ?? "額度明細載入失敗。"}</Alert></Dialog>;

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
    width={760} bodyLayout="grid gap-[18px] px-6 pb-2"
  >
    <Alert tone="info">這一期的額度不是人工輸入：只有月薪制員工會取得特休，系統以實際服務起算日與第一筆有效月薪敘薪生效日的較晚者作為特休起算日，再套用取得時的政策版本與年資級距；後續核准請假、人工調整與折現都只追加台帳紀錄。</Alert>
    <div className="grid grid-cols-4 gap-2.5 max-[620px]:grid-cols-2">
      <DetailStat label="實際服務起算日" value={entitlement.serviceStartOn} />
      <DetailStat label="特休起算日" value={entitlement.annualLeaveStartOn} />
      <DetailStat label="本期額度" value={hours(entitlement.entitledHalfHours)} />
      <DetailStat label="目前可用" value={hours(entitlement.balanceHalfHours)} />
    </div>
    <DetailSection title="為什麼是這個額度">
      <p>本期於 {entitlement.periodStart} 依公司特休政策 v{entitlement.policyVersionNumber} 的「{entitlement.bracketLabel || bracketRange}」級距發放：{entitlement.bracketEntitledDays} 日 × {dailyHours} 小時／日 = {hours(entitlement.entitledHalfHours)}。</p>
      <DetailList>
        <DetailRow term="適用政策期間">{entitlement.policyValidFrom}～{entitlement.policyValidTo ? dateMinusOne(entitlement.policyValidTo) : "目前"}</DetailRow>
        <DetailRow term="年資級距">{bracketRange}</DetailRow>
        <DetailRow term="最小單位">{entitlement.policyMinimumUnitMinutes} 分鐘</DetailRow>
        <DetailRow term="未休遞延">{entitlement.policyCarryoverAllowed ? "允許" : "不遞延，週期終結折現"}</DetailRow>
      </DetailList>
    </DetailSection>
    <DetailSection title="什麼時候發放">
      <DetailList>
        <DetailRow term="額度生效日">{entitlement.periodStart}</DetailRow>
        <DetailRow term="台帳發放時間">{grant ? `${taipeiDateTime(grant.createdAt)}（台北）` : "—"}</DetailRow>
        <DetailRow term="發放紀錄">{grant ? annualGrantNote(entitlement) : "找不到政策發放紀錄"}</DetailRow>
      </DetailList>
      <FormHint>「額度生效日」代表員工取得這期特休的法律／政策日期；「台帳發放時間」是系統實際寫入 grant 紀錄的時間，回溯補建時兩者可能不同。</FormHint>
    </DetailSection>
    <DetailSection title="額度台帳">
      <DataTable className="compact [&_td]:whitespace-nowrap [&_td:last-child]:min-w-[220px] [&_td:last-child]:whitespace-normal [&_td.numeric]:text-right"><thead><tr><th>寫入時間</th><th>類型</th><th className="numeric">變化</th><th>說明</th></tr></thead><tbody>
        {entitlement.ledger.map((entry) => <tr key={entry.id}><td>{taipeiDateTime(entry.createdAt)}<small>台北時間</small></td><td>{ledgerKindLabel(entry.entryKind)}</td><td className="numeric">{signedHours(entry.deltaHalfHours)}</td><td>{ledgerDisplayNote(entry, entitlement)}</td></tr>)}
        {!entitlement.ledger.length ? <tr><td colSpan={4}><EmptyState>目前沒有台帳紀錄。</EmptyState></td></tr> : null}
      </tbody></DataTable>
    </DetailSection>
  </Dialog>;
}

function EntitlementTable({ rows, canWrite, onAdjust, onDetail }: { rows: HrAnnualLeaveEntitlement[]; canWrite: boolean; onAdjust: (row: HrAnnualLeaveEntitlement) => void; onDetail: (row: HrAnnualLeaveEntitlement) => void }) {
  return <DataTable className="[&_td]:align-middle [&_td:first-child]:min-w-[160px] [&_td:nth-child(2)]:min-w-[145px] [&_td:nth-child(4)]:min-w-[112px] [&_td:nth-child(4)]:whitespace-nowrap [&_td:nth-child(5)]:min-w-[168px] [&_td:nth-child(5)]:whitespace-nowrap [&_small]:mt-[3px] [&_small]:block [&_small]:text-[12px] [&_small]:leading-[1.45] [&_small]:text-muted"><thead><tr><th>員工</th><th>可用額度</th><th>本期使用</th><th>到期日</th><th>額度週期</th><th>狀態</th><th>操作</th></tr></thead><tbody>
    {rows.map((row) => <tr key={row.id}>
      <td data-label="員工"><strong>{row.employeeName}</strong><small>{row.employeeNumber}</small></td>
      <td data-label="可用額度"><div className="grid min-w-[118px] gap-0.5"><strong className="text-[16px] text-brand-dark tabular-nums">{hours(row.balanceHalfHours)}</strong><small>共 {hours(row.entitledHalfHours)}</small><span className="mt-[5px] block h-[5px] w-full overflow-hidden rounded-[999px] bg-ink/10" aria-hidden="true"><span className="block h-full rounded-[inherit] bg-brand" style={{ width: `${balancePercent(row)}%` }} /></span></div></td>
      <td data-label="本期使用">{hours(row.usedHalfHours)}<small>{row.debitHalfHours > 0 ? `扣除 ${hours(row.debitHalfHours)}` : "尚未使用"}</small></td>
      <td data-label="到期日"><strong>{dateMinusOne(row.periodEnd)}</strong><small>週期結束日</small></td>
      <td data-label="額度週期">{row.periodStart}～{dateMinusOne(row.periodEnd)}</td>
      <td data-label="狀態"><StatusBadge tone={row.status === "open" ? "success" : "neutral"}>{row.status === "open" ? "可使用" : "已結算"}</StatusBadge></td>
      <td data-label="操作"><div className="flex min-w-[190px] flex-wrap gap-2"><Button variant="secondary" icon="info" tone="info" onClick={() => onDetail(row)}>查看明細</Button>{canWrite && row.status === "open" ? <Button variant="secondary" icon="edit" tone="info" onClick={() => onAdjust(row)}>人工調整</Button> : null}</div></td>
    </tr>)}
    {!rows.length ? <tr><td colSpan={7}><EmptyState className="mt-[18px]">目前沒有可建立的特休週期；請確認員工已設定月薪敘薪版本，或執行回溯／補建額度。</EmptyState></td></tr> : null}
  </tbody></DataTable>;
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

  return <Page layout="fills">
    <PageHeader
      title="特休額度"
      description="查看已取得特休週期的可用額度與到期日；點選查看明細，可追溯政策級距、發放時間與每筆台帳。"
      actions={<div className="flex flex-wrap justify-end gap-2.5 max-[620px]:justify-start"><Button variant="secondary" icon="tune" tone="info" onClick={() => navigate("/hr/annual-leave/settings")}>特休政策</Button>{canWrite ? <Button icon="sync" tone="success" mobileIconOnly loading={backfill.isPending} onClick={() => backfill.mutate({ path: "/annual-leave/backfill", method: "POST", values: {} }, { onSuccess: () => { void entitlements.refetch(); } })}>回溯／補建額度</Button> : null}</div>}
    />
    {entitlements.error || backfill.error ? <Alert tone="danger">{entitlements.error?.message ?? backfill.error?.message}</Alert> : null}
    <Panel grows headerClassName="items-center max-[620px]:items-stretch max-[620px]:flex-col max-[620px]:gap-3" title={showHistory ? "全部額度週期" : "員工目前額度"} description={showHistory ? "包含歷史週期；人工修正與核准使用都保留在各期台帳。" : "每位員工只顯示目前適用的週期；到期日為該週期結束日前一天。"} actions={<SegmentedControl className="w-[214px] max-[620px]:w-full" aria-label="額度顯示範圍" value={showHistory ? "all" : "current"} options={[{ value: "current", label: "目前週期" }, { value: "all", label: "全部週期" }]} onChange={(value) => setShowHistory(value === "all")} />}>
      <EntitlementTable rows={visibleRows} canWrite={canWrite} onAdjust={setAdjustment} onDetail={setDetail} />
    </Panel>
    {adjustment ? <EntitlementAdjustmentDialog row={adjustment} onClose={() => { setAdjustment(null); void entitlements.refetch(); }} /> : null}
    {detail ? <EntitlementDetailDialog row={detail} onClose={() => setDetail(null)} /> : null}
  </Page>;
}
