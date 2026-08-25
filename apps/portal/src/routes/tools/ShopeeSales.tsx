import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Field, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
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
  const status = useShopeeSalesStatus(tracking ?? state.data?.latestRequestId ?? null);

  if (state.isPending) return <div className="boot">載入中…</div>;
  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  const running = latest ? latest.status !== "completed" : false;
  const blocked = running || run.isPending || !file || !password || !state.data?.settings.driveFolderUrl || !state.data.configured;

  return (
    <div className="page">
      <PageHeader
        title="蝦皮銷售報表"
        description="直接上傳從蝦皮下載的加密 Excel，系統會依原始檔名處理報表，再上傳到設定好的 Google Drive。"
      />

      {!state.data?.configured ? <Alert tone="danger">平台還沒設定 GITHUB_TOKEN，現在無法處理報表。</Alert> : null}
      {!state.data?.settings.driveFolderUrl ? <Alert tone="danger">尚未設定 Google Drive 資料夾，請由有權限的人前往「蝦皮報表設定」。</Alert> : null}

      <Panel>
        <form className="admin-form" onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          run.mutate({ file, password }, { onSuccess: (result) => { setTracking(result.requestId); setFile(null); setPassword(""); } });
        }}>
          <Field label="蝦皮報表（.xlsx）"><input className="cell-input wide" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
          <TextField label="報表密碼" type="password" inputClassName="cell-input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="請輸入報表密碼" autoComplete="off" />
          <Button type="submit" icon="analytics" disabled={blocked}>{run.isPending ? "送出中…" : "上傳並整理"}</Button>
          {running ? <span className="form-hint">GitHub Actions 處理中…可以關閉這一頁</span> : null}
        </form>
        {file ? <p className="muted table-note">已選擇：{file.name}</p> : null}
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
        {state.data?.settings.driveFolderUrl ? <p className="muted table-note">上傳位置：<a className="link-external" href={state.data.settings.driveFolderUrl} target="_blank" rel="noopener noreferrer">{state.data.settings.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p> : null}
      </Panel>

      {followed ? <Panel
        title={tracking ? "這次執行" : "上一次執行"}
        actions={latest ? <StatusBadge tone={latest.status !== "completed" ? "info" : latest.conclusion === "success" ? "success" : "danger"}>{latest.status !== "completed" ? "執行中" : latest.conclusion === "success" ? "完成" : "未完成"}</StatusBadge> : <StatusBadge tone="info">等待 GitHub 建立工作…</StatusBadge>}
      >
        {status.data?.steps.length ? <ol className="step-list">{status.data.steps.map((step, index) => <li className={stepClass(step)} key={`${step.name}-${index}`}><span className="step-mark">{STEP_MARK[step.status] ?? "·"}</span>{step.name}</li>)}</ol> : null}
        {latest?.url ? <p className="muted table-note"><a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a></p> : null}
      </Panel> : null}

      <Panel title="最近上傳">
        <div className="table-scroll"><table className="data-table"><thead><tr><th>時間</th><th>區間</th><th>Drive 資料夾</th><th>執行的人</th></tr></thead><tbody>
          {(state.data?.runs ?? []).map((record) => <tr key={record.id}><td className="cell-sub whitespace-nowrap">{formatDate(record.createdAt)}</td><td className="cell-sub whitespace-nowrap">{record.startDate} ~ {record.endDate}</td><td><a className="link-external" href={record.driveFolderUrl} target="_blank" rel="noopener noreferrer">開啟資料夾<Icon name="external" /></a></td><td className="cell-sub">{record.actorEmail}</td></tr>)}
        </tbody></table></div>
        {(state.data?.runs.length ?? 0) === 0 ? <p className="muted table-note">還沒有上傳過報表。</p> : null}
      </Panel>
    </div>
  );
}
