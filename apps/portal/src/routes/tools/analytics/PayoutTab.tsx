import { useEffect, useState } from "react";
import { useSession } from "../../../auth/session.js";
import { ConfirmDialog } from "../../../shell/ConfirmDialog.js";
import { Icon } from "../../../shell/icons.js";
import { useToast } from "../../../shell/Toast.js";
import { Alert, Button, Dialog, Panel, TextField } from "../../../ui/index.js";
import { PayoutTrendChart } from "./charts/PayoutTrendChart.js";
import { ScopeBreakdownChart } from "./charts/ScopeBreakdownChart.js";
import {
  ReportApiError,
  useDeletePayoutDaily,
  usePayoutDaily,
  usePayoutSummary,
  useUpdatePayoutDaily,
  type AnalyticsQuery,
  type PayoutDailyPoint,
} from "./api.js";

interface PayoutTabProps {
  query: AnalyticsQuery;
  scopeLabel: string;
  enabled: boolean;
}

function formatCurrency(value: number): string {
  return `NT$${value.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toLocaleString("zh-TW", { maximumFractionDigits: 1 })}%`;
}

function formatDate(value: string): string {
  const [year = "", month = "", day = ""] = value.split("-");
  return `${year}/${month}/${day}`;
}

function growthHint(label: string, value: number | null, comparison: { total: number } | null): string {
  if (comparison === null) return `${label}無資料，無法計算成長率`;
  if (comparison.total === 0) return `${label}為 0，無法作為成長率分母`;
  if (value === null) return `${label}無法計算成長率`;
  return `與${label}相比：${formatPercent(value)}`;
}

function PayoutDailyDialog({
  scopeId,
  row,
  onClose,
}: {
  scopeId: string;
  row: PayoutDailyPoint;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(String(row.payoutAmount));
  const update = useUpdatePayoutDaily();
  const toast = useToast();
  const payoutAmount = Number(amount);
  const valid = amount.trim() !== "" && Number.isSafeInteger(payoutAmount);

  return (
    <Dialog
      title={`編輯 ${row.businessDate} 出金資料`}
      className="confirm-card"
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          update.mutate(
            { scopeId, businessDate: row.businessDate, payoutAmount },
            {
              onSuccess: () => {
                toast.show(`已更新 ${row.businessDate} 出金金額`);
                onClose();
              },
            },
          );
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button type="submit" loading={update.isPending} loadingLabel="儲存中…" disabled={!valid}>
            儲存
          </Button>
        </>
      }
    >
      <TextField label="日期" value={row.businessDate} readOnly inputClassName="cell-input" />
      <TextField
        label="出金金額"
        required
        autoFocus
        type="number"
        step="1"
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        inputClassName="cell-input"
        hint="以元為單位；下次重新匯入同一天資料時，手動修正會被匯入值覆蓋。"
      />
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function PayoutTab({ query, scopeLabel, enabled }: PayoutTabProps) {
  const result = usePayoutSummary(query, enabled);
  const daily = usePayoutDaily(query, enabled && Boolean(query.scopeId));
  const remove = useDeletePayoutDaily();
  const [editing, setEditing] = useState<PayoutDailyPoint | null>(null);
  const [deleting, setDeleting] = useState<PayoutDailyPoint | null>(null);
  const { permissions } = useSession();
  const toast = useToast();
  const canWrite = permissions.has("reports:cyberbiz:write");
  const scopeId = query.scopeId;

  useEffect(() => {
    setEditing(null);
    setDeleting(null);
  }, [query.scopeId, query.period, query.startDate, query.endDate]);

  if (!enabled) return <Alert tone="warning">請先選擇有效的完整日期區間。</Alert>;
  if (result.isPending && !result.data) return <div className="boot">載入統計中…</div>;
  if (result.error) {
    const message = result.error instanceof ReportApiError && result.error.status === 403
      ? "你沒有檢視營運統計的權限。"
      : result.error.message;
    return <Alert tone="danger">{message}</Alert>;
  }
  const summary = result.data;
  if (!summary) return <Alert tone="danger">報表沒有回傳資料。</Alert>;
  if (summary.status === "NO_DATA_FOR_RANGE") {
    return (
      <Panel className="analytics-empty-panel">
        <span className="analytics-empty-icon"><Icon name="report" /></span>
        <h2>{scopeLabel}在這段期間沒有出金資料</h2>
        <p>{summary.message ?? "這段期間沒有已匯入的出金資料。"}</p>
        <a className="primary-button with-icon" href="/tools/payout">
          <Icon name="payments" />
          前往執行出金表
        </a>
      </Panel>
    );
  }

  const asOf = summary.complete || !summary.asOfDate ? null : `截至 ${formatDate(summary.asOfDate)}`;
  const isAnnual = /^\d{4}$/u.test(summary.period);
  const dailyRows = daily.data?.rows ?? [];
  const dailyError = daily.error
    ? daily.error instanceof ReportApiError && daily.error.status === 403
      ? "你沒有檢視逐日出金資料的權限。"
      : daily.error.message
    : null;
  return (
    <div className="analytics-results">
      <div className="analytics-result-heading">
        <div>
          <p className="analytics-eyebrow">出金脈動</p>
          <h2>{scopeLabel}</h2>
        </div>
        <div className="analytics-result-meta">
          {asOf ? <span className="analytics-as-of">{asOf}</span> : null}
          <span>僅計入啟用中的店別</span>
        </div>
      </div>

      <div className={isAnnual ? "analytics-kpi-grid annual" : "analytics-kpi-grid"}>
        <article className="analytics-kpi analytics-kpi-primary">
          <span>本期出金</span>
          <strong>{formatCurrency(summary.current.total)}</strong>
          <small>{summary.current.start} ～ {summary.current.end}</small>
        </article>
        {!isAnnual ? (
          <article className="analytics-kpi">
            <span>MoM</span>
            <strong>{formatPercent(summary.growth.mom)}</strong>
            <small title={growthHint("上期", summary.growth.mom, summary.previous)}>{growthHint("上期", summary.growth.mom, summary.previous)}</small>
          </article>
        ) : null}
        <article className="analytics-kpi">
          <span>YoY</span>
          <strong>{formatPercent(summary.growth.yoy)}</strong>
          <small title={growthHint("去年同期", summary.growth.yoy, summary.lastYear)}>{growthHint("去年同期", summary.growth.yoy, summary.lastYear)}</small>
        </article>
        <article className="analytics-kpi">
          <span>日均出金</span>
          <strong>{summary.dailyAverage === null ? "—" : formatCurrency(summary.dailyAverage)}</strong>
          <small>{summary.dataDays ? `以 ${summary.dataDays} 天有資料日計算` : "沒有可計算的資料日"}</small>
        </article>
        <article className="analytics-kpi">
          <span>最高單日</span>
          <strong>{summary.highestDay ? formatCurrency(summary.highestDay.value) : "—"}</strong>
          <small>{summary.highestDay ? formatDate(summary.highestDay.date) : "沒有可顯示的日期"}</small>
        </article>
      </div>

      {result.isFetching ? <p className="analytics-refreshing" role="status">正在更新統計…</p> : null}

      <div className="analytics-chart-grid">
        <PayoutTrendChart
          current={summary.current}
          lastYear={summary.lastYear}
          granularity={summary.granularity}
          valueFormatter={formatCurrency}
        />
        <ScopeBreakdownChart breakdown={summary.breakdown} valueFormatter={formatCurrency} />
      </div>

      {scopeId ? (
        <Panel
          title="出金逐日預覽"
          description={canWrite
            ? "可修正單日金額或移除整筆日期資料；下次重新匯入可能覆蓋手動修正。"
            : "目前選定店別已匯入的每日出金資料。"}
        >
          {dailyError ? <Alert tone="danger">{dailyError}</Alert> : null}
          {daily.isPending && !daily.data ? <p className="muted table-note">載入逐日資料中…</p> : null}
          {daily.data && dailyRows.length ? (
            <div className="table-scroll">
              <table className="data-table analytics-table">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th className="numeric">出金金額</th>
                    {canWrite ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {dailyRows.map((row) => (
                    <tr key={row.businessDate}>
                      <td data-label="日期" className="whitespace-nowrap">{row.businessDate}</td>
                      <td data-label="出金金額" className="numeric">{formatCurrency(row.payoutAmount)}</td>
                      {canWrite ? (
                        <td data-label="操作">
                          <div className="row-actions">
                            <Button
                              variant="icon"
                              icon="edit"
                              disabled={remove.isPending}
                              onClick={() => setEditing(row)}
                              title={`編輯 ${row.businessDate} 出金金額`}
                              aria-label={`編輯 ${row.businessDate} 出金金額`}
                            />
                            <Button
                              variant="icon"
                              className="danger"
                              icon="trash"
                              disabled={remove.isPending}
                              onClick={() => setDeleting(row)}
                              title={`刪除 ${row.businessDate} 出金資料`}
                              aria-label={`刪除 ${row.businessDate} 出金資料`}
                            />
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {daily.isFetching && daily.data ? <p className="muted table-note" role="status">正在更新逐日資料…</p> : null}
          {!daily.isPending && !dailyError && !dailyRows.length ? (
            <p className="muted table-note">{daily.data?.message ?? "這段期間沒有已匯入的出金日期。"}</p>
          ) : null}
        </Panel>
      ) : null}

      {editing && scopeId ? <PayoutDailyDialog scopeId={scopeId} row={editing} onClose={() => setEditing(null)} /> : null}
      {deleting && scopeId ? (
        <ConfirmDialog
          title="刪除這筆出金資料？"
          confirmLabel="刪除資料"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            remove.mutate(
              { scopeId, businessDate: deleting.businessDate },
              {
                onSuccess: () => {
                  toast.show(`已刪除 ${deleting.businessDate} 出金資料`);
                  setDeleting(null);
                },
              },
            );
          }}
        >
          <p>
            <strong>{deleting.businessDate}</strong> 的出金金額 {formatCurrency(deleting.payoutAmount)} 會從這個店別的統計中移除。
          </p>
          <p className="muted">如果只是金額有誤，請取消後選擇編輯。</p>
          {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
