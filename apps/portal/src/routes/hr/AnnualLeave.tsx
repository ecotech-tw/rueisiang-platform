import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type HrAnnualLeaveEntitlement, type HrAnnualLeavePolicy, type HrAnnualLeaveBracket, type HrAnnualLeaveResponse } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

function dateMinusOne(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function hours(halfHours: number) {
  return `${(halfHours / 2).toFixed(1)} 小時`;
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

function PolicySummary({ policy, brackets }: { policy: HrAnnualLeavePolicy; brackets: HrAnnualLeaveBracket[] }) {
  return <Panel title="目前公司共用政策" description={`版本 ${policy.versionNumber}，自 ${policy.validFrom} 起生效；政策版本只新增、不覆寫歷史額度。`}>
    <div className="summary-grid">
      <div><span>給薪日工時</span><strong>{(policy.dailyMinutes / 60).toFixed(1)} 小時</strong></div>
      <div><span>最小儲存單位</span><strong>{(policy.minimumUnitMinutes / 60).toFixed(1)} 小時</strong></div>
      <div><span>週期基準</span><strong>依 seniorityStartOn 週年</strong></div>
      <div><span>未休處理</span><strong>{policy.carryoverAllowed ? "依政策遞延" : "不自動遞延"}</strong></div>
    </div>
    <div className="hr-annual-brackets" aria-label="特休年資級距">
      {brackets.map((bracket) => <span key={bracket.id}>{bracket.label}：{bracket.entitledDays} 日</span>)}
    </div>
  </Panel>;
}

export function HrAnnualLeave() {
  usePageTitle("特休額度");
  const { permissions, user } = useSession();
  const canRead = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:read"));
  const canWrite = Boolean(user?.isHrAdministrator && permissions.has("hr:payroll:calculate"));
  const policy = useHrQuery<{ policy: HrAnnualLeavePolicy; brackets: HrAnnualLeaveBracket[] }>("/annual-leave/policy", canRead, { keepPreviousData: false });
  const entitlements = useHrQuery<HrAnnualLeaveResponse>("/annual-leave/entitlements", canRead, { keepPreviousData: false });
  const backfill = useHrWrite();
  const [adjustment, setAdjustment] = useState<HrAnnualLeaveEntitlement | null>(null);
  const rows = entitlements.data?.entitlements ?? [];

  if (!canRead) return <Alert tone="danger">特休額度僅限全平台 HR 管理者查看。</Alert>;
  if (policy.isPending || entitlements.isPending) return <HrPageSkeleton variant="table" />;

  return <div className="page fills hr-annual-leave-page">
    <PageHeader
      title="特休額度"
      description="依每位員工的 seniorityStartOn 建立週年制額度；每個週期獨立使用，未休不自動遞延。"
      actions={canWrite ? <Button icon="sync" loading={backfill.isPending} onClick={() => backfill.mutate({ path: "/annual-leave/backfill", method: "POST", values: {} }, { onSuccess: () => { void entitlements.refetch(); } })}>回溯／補建額度</Button> : undefined}
    />
    {policy.error || entitlements.error || backfill.error ? <Alert tone="danger">{policy.error?.message ?? entitlements.error?.message ?? backfill.error?.message}</Alert> : null}
    {policy.data ? <PolicySummary policy={policy.data.policy} brackets={policy.data.brackets} /> : null}
    <Panel className="grows" title="員工特休週期" description="期間結束日為半開區間的次日；核准請假才會扣除台帳，人工修正會另留一筆紀錄。">
      <div className="table-scroll"><table className="data-table"><thead><tr><th>員工</th><th>週期</th><th>給予</th><th>已使用</th><th>可用</th><th>狀態</th><th>操作</th></tr></thead><tbody>
        {rows.map((row) => <tr key={row.id}>
          <td data-label="員工"><strong>{row.employeeName}</strong><small>{row.employeeNumber}</small></td>
          <td data-label="週期">{row.periodStart}～{dateMinusOne(row.periodEnd)}<small>滿 {row.serviceMonths} 個月</small></td>
          <td data-label="給予">{hours(row.entitledHalfHours)}</td>
          <td data-label="已使用">{hours(row.usedHalfHours)}</td>
          <td data-label="可用"><strong>{hours(row.balanceHalfHours)}</strong></td>
          <td data-label="狀態"><StatusBadge tone={row.status === "open" ? "success" : "neutral"}>{row.status === "open" ? "可使用" : "已結算"}</StatusBadge></td>
          <td data-label="操作">{canWrite && row.status === "open" ? <Button variant="secondary" icon="edit" onClick={() => setAdjustment(row)}>人工調整</Button> : null}</td>
        </tr>)}
      </tbody></table></div>
      {!rows.length ? <p className="empty-state">目前沒有可建立的特休週期；請確認員工已設定 seniorityStartOn，或執行回溯／補建額度。</p> : null}
    </Panel>
    {adjustment ? <EntitlementAdjustmentDialog row={adjustment} onClose={() => { setAdjustment(null); void entitlements.refetch(); }} /> : null}
  </div>;
}
