import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useRunShopeeSales, useShopeeSalesState, useShopeeSalesStatus } from "./api.js";

const STEP_MARK: Record<string, string> = { completed: "✓", in_progress: "▶" };

function stepClass(step: { status: string; conclusion: string | null }): string {
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
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useShopeeSalesStatus(tracking);

  if (state.isPending) return <div className="boot">載入中…</div>;
  const latest = status.data?.runs[0];
  const running = latest ? latest.status !== "completed" : false;
  const blocked = running || run.isPending || !file || !password || !state.data?.settings.driveFolderUrl || !state.data.configured;

  return (
    <div className="page">
      <header className="page-head">
        <h1>蝦皮銷售報表</h1>
        <p className="muted">直接上傳從蝦皮下載的加密 Excel，系統會依原始檔名處理報表，再上傳到設定好的 Google Drive。</p>
      </header>

      {!state.data?.configured ? <p className="form-error" role="alert">平台還沒設定 SHOPEE_GITHUB_TOKEN，現在無法處理報表。</p> : null}
      {!state.data?.settings.driveFolderUrl ? <p className="form-error" role="alert">尚未設定 Google Drive 資料夾，請由有權限的人前往「蝦皮報表設定」。</p> : null}

      <section className="panel">
        <form className="admin-form" onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          run.mutate({ file, password }, { onSuccess: (result) => { setTracking(result.requestId); setFile(null); setPassword(""); } });
        }}>
          <label>蝦皮報表（.xlsx）<input className="cell-input wide" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <label>報表密碼<input className="cell-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="請輸入報表密碼" autoComplete="off" /></label>
          <button type="submit" className="primary-button with-icon" disabled={blocked}><Icon name="analytics" />{run.isPending ? "送出中…" : "上傳並整理"}</button>
          {running ? <span className="form-hint">GitHub Actions 處理中…可以關閉這一頁</span> : null}
        </form>
        {file ? <p className="muted table-note">已選擇：{file.name}</p> : null}
        {run.error ? <p className="form-error" role="alert">{run.error.message}</p> : null}
        {status.error ? <p className="form-error" role="alert">{status.error.message}</p> : null}
        {state.data?.settings.driveFolderUrl ? <p className="muted table-note">上傳位置：<a className="link-external" href={state.data.settings.driveFolderUrl} target="_blank" rel="noopener noreferrer">{state.data.settings.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p> : null}
      </section>

      {tracking ? <section className="panel">
        <h2 className="panel-title">這次執行 {latest ? <span className={`status ${latest.status === "completed" ? (latest.conclusion === "success" ? "status-sync-synced" : "status-sync-failed") : "status-webhook-processing"}`}>{latest.status !== "completed" ? "執行中" : latest.conclusion === "success" ? "完成" : "未完成"}</span> : <span className="status status-webhook-processing">等待 GitHub 建立工作…</span>}</h2>
        {status.data?.steps.length ? <ol className="step-list">{status.data.steps.map((step, index) => <li className={stepClass(step)} key={`${step.name}-${index}`}><span className="step-mark">{STEP_MARK[step.status] ?? "·"}</span>{step.name}</li>)}</ol> : null}
        {latest?.url ? <p className="muted table-note"><a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a></p> : null}
      </section> : null}

      <section className="panel">
        <h2 className="panel-title">最近上傳</h2>
        <div className="table-scroll"><table className="data-table"><thead><tr><th>時間</th><th>區間</th><th>Drive 資料夾</th><th>執行的人</th></tr></thead><tbody>
          {(state.data?.runs ?? []).map((record) => <tr key={record.id}><td className="cell-sub whitespace-nowrap">{formatDate(record.createdAt)}</td><td className="cell-sub whitespace-nowrap">{record.startDate} ~ {record.endDate}</td><td><a className="link-external" href={record.driveFolderUrl} target="_blank" rel="noopener noreferrer">開啟資料夾<Icon name="external" /></a></td><td className="cell-sub">{record.actorEmail}</td></tr>)}
        </tbody></table></div>
        {(state.data?.runs.length ?? 0) === 0 ? <p className="muted table-note">還沒有上傳過報表。</p> : null}
      </section>
    </div>
  );
}
