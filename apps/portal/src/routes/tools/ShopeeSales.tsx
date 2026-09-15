import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Field, PageHeader, Panel, TextField, WorkflowRunPanel } from "../../ui/index.js";
import { useRunShopeeSales, useShopeeSalesState, useShopeeSalesStatus } from "./api.js";

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
      <PageHeader title="蝦皮銷售報表" />

      {!state.data?.configured ? <Alert tone="danger">平台還沒設定 GITHUB_TOKEN，現在無法處理報表。</Alert> : null}
      {!state.data?.settings.driveFolderUrl ? <Alert tone="danger">尚未設定 Google Drive 資料夾，請由有權限的人前往「店別與報表設定」。</Alert> : null}

      <Panel>
        <form className="admin-form" onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          run.mutate({ file, password }, { onSuccess: (result) => { setTracking(result.requestId); setFile(null); setPassword(""); } });
        }}>
          <Field label="蝦皮報表（.xlsx）"><input className="cell-input wide" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
          <TextField label="報表密碼" type="password" inputClassName="cell-input" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="請輸入報表密碼" autoComplete="off" />
          <Button type="submit" icon="analytics" loading={run.isPending} loadingLabel="送出中…" disabled={blocked}>上傳並整理</Button>
          {running ? <span className="form-hint">GitHub Actions 處理中…可以關閉這一頁</span> : null}
        </form>
        {file ? <p className="muted table-note">已選擇：{file.name}</p> : null}
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
        {state.data?.settings.driveFolderUrl ? <p className="muted table-note">上傳位置：<a className="link-external" href={state.data.settings.driveFolderUrl} target="_blank" rel="noopener noreferrer">{state.data.settings.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p> : null}
      </Panel>

      {followed ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
        />
      ) : null}
    </div>
  );
}
