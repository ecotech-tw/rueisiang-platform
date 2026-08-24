import { useEffect, useState } from "react";
import { DateRangePicker } from "../../shell/DateRangePicker.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useRunShopeeSales, useShopeeSalesState, useShopeeSalesStatus, type WorkflowStep } from "./api.js";

const STEP_MARK: Record<string, string> = { completed: "✓", in_progress: "▶" };

function stepClass(step: WorkflowStep): string {
  if (step.conclusion === "failure") return "step fail";
  if (step.status === "completed") return "step done";
  if (step.status === "in_progress") return "step doing";
  return "step";
}

function formatDate(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function ShopeeSales() {
  usePageTitle("蝦皮銷售報表");
  const state = useShopeeSalesState();
  const run = useRunShopeeSales();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useShopeeSalesStatus(tracking ?? state.data?.latestRequestId ?? null);

  useEffect(() => {
    if (!state.data) return;
    setStart((current) => current || state.data.start);
    setEnd((current) => current || state.data.end);
  }, [state.data]);

  if (state.isPending) return <div className="boot">載入中…</div>;
  const latest = status.data?.runs[0];
  const running = latest ? latest.status !== "completed" : false;
  const rangeError = start && end && start > end ? "起日不能晚於迄日。" : "";
  const blocked = running || run.isPending || !start || !end || Boolean(rangeError) || !state.data?.settings.driveFolderUrl || !state.data.configured;

  return (
    <div className="page">
      <header className="page-head">
        <h1>蝦皮銷售報表</h1>
        <p className="muted">匯出指定期間的蝦皮訂單報表，整理業績與商品銷售數後，上傳到設定的 Google Drive 資料夾。</p>
      </header>

      {!state.data?.configured ? <p className="form-error" role="alert">平台還沒設定 SHOPEE_GITHUB_TOKEN，目前無法觸發執行。</p> : null}
      {!state.data?.settings.driveFolderUrl ? (
        <p className="form-error" role="alert">尚未設定 Google Drive 資料夾，請由有權限的人前往「蝦皮報表設定」。</p>
      ) : null}

      <section className="panel">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <span className="inline-label">報表區間</span>
          <DateRangePicker start={start} end={end} disabled={run.isPending} onChange={(range) => { setStart(range.start); setEnd(range.end); }} />
          <button type="button" className="primary-button with-icon" disabled={blocked} onClick={() => run.mutate({ start, end }, { onSuccess: (result) => setTracking(result.requestId) })}>
            <Icon name="analytics" />
            {run.isPending ? "送出中…" : "匯出並上傳"}
          </button>
          {running ? <span className="form-hint">執行中…可以關掉這一頁</span> : null}
        </form>
        {rangeError ? <p className="form-error" role="alert">{rangeError}</p> : null}
        {run.error ? <p className="form-error" role="alert">{run.error.message}</p> : null}
        {status.error ? <p className="form-error" role="alert">{status.error.message}</p> : null}
        {state.data?.settings.driveFolderUrl ? (
          <p className="muted table-note">上傳位置：<a className="link-external" href={state.data.settings.driveFolderUrl} target="_blank" rel="noopener noreferrer">{state.data.settings.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p>
        ) : null}
      </section>

      {tracking || state.data?.latestRequestId ? (
        <section className="panel">
          <h2 className="panel-title">{tracking ? "這次執行" : "上一次執行"}{latest ? <span className={`status ${latest.status === "completed" ? (latest.conclusion === "success" ? "status-sync-synced" : "status-sync-failed") : "status-webhook-processing"}`}>{latest.status !== "completed" ? "執行中" : latest.conclusion === "success" ? "完成" : "未完成"}</span> : <span className="status status-webhook-processing">等 GitHub 建立工作…</span>}</h2>
          {status.data?.steps.length ? <ol className="step-list">{status.data.steps.map((step, index) => <li className={stepClass(step)} key={`${step.name}-${index}`}><span className="step-mark">{STEP_MARK[step.status] ?? "·"}</span>{step.name}</li>)}</ol> : null}
          {latest?.url ? <p className="muted table-note"><a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a>　完成的 xlsx 與報告會放在該次工作的 Artifacts。</p> : null}
        </section>
      ) : null}

      <section className="panel">
        <h2 className="panel-title">最近執行</h2>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>時間</th><th>區間</th><th>Drive 資料夾</th><th>執行的人</th></tr></thead><tbody>
          {(state.data?.runs ?? []).map((record) => <tr key={record.id}><td className="cell-sub whitespace-nowrap">{formatDate(record.createdAt)}</td><td className="cell-sub whitespace-nowrap">{record.startDate} ~ {record.endDate}</td><td><a className="link-external" href={record.driveFolderUrl} target="_blank" rel="noopener noreferrer">開啟資料夾<Icon name="external" /></a></td><td className="cell-sub">{record.actorEmail}</td></tr>)}
        </tbody></table></div>
        {(state.data?.runs.length ?? 0) === 0 ? <p className="muted table-note">還沒有人從這裡執行過。</p> : null}
      </section>
    </div>
  );
}
