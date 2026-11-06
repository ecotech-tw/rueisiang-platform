import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Field, Input, Page, PageHeader, Panel, SelectField, TextField, WorkflowRunPanel } from "../../ui/index.js";
import { useRunShopeeSales, useShopeeSalesState, useShopeeSalesStatus } from "./api.js";

export function ShopeeSales({ embedded = false }: { embedded?: boolean } = {}) {
  usePageTitle("蝦皮商品銷售");
  const state = useShopeeSalesState();
  const run = useRunShopeeSales();
  const [file, setFile] = useState<File | null>(null);
  const [scopeId, setScopeId] = useState("");
  const [password, setPassword] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useShopeeSalesStatus(tracking ?? state.data?.latestRequestId ?? null);

  if (state.isPending) return <div className="boot">載入中…</div>;
  if (!state.data) return <div className="boot"><Alert tone="danger">{state.error?.message ?? "無法載入蝦皮通路設定。"}</Alert></div>;
  const scopes = state.data.scopes;
  const selectedScopeId = scopes.some((scope) => scope.id === scopeId) ? scopeId : scopes[0]?.id ?? "";
  const selectedScope = scopes.find((scope) => scope.id === selectedScopeId);
  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  const running = latest ? latest.status !== "completed" : false;
  const blocked = running || run.isPending || !file || !password || !selectedScopeId || !selectedScope?.driveFolderUrl || !state.data.configured;

  const content = (
    <>
      {embedded ? null : <PageHeader title="蝦皮商品銷售" />}

      {!state.data?.configured ? <Alert tone="danger">平台還沒設定 GITHUB_TOKEN，現在無法處理報表。</Alert> : null}
      {!scopes.length ? <Alert tone="warning">尚未建立啟用中的蝦皮通路。請先到通路管理新增「種類：通路、平台：蝦皮」。</Alert> : null}
      {selectedScope && !selectedScope.driveFolderUrl ? <Alert tone="danger">「{selectedScope.name}」尚未設定 Google Drive 資料夾，請由有權限的人前往通路管理設定。</Alert> : null}
      <Panel
        title={embedded ? "蝦皮商品銷售" : undefined}
        description="選擇通路與報表檔案並輸入密碼，啟動背景整理；蝦皮檔案會在背景解密、解析與匯入，完成後可查看執行紀錄。"
      >
        <form className="admin-form row" onSubmit={(event) => {
          event.preventDefault();
          if (!file || !selectedScopeId) return;
          run.mutate({ file, password, scopeId: selectedScopeId }, { onSuccess: (result) => { setTracking(result.requestId); setFile(null); setPassword(""); } });
        }}>
          <SelectField className="min-w-[180px] flex-[1_1_190px]" label="通路" required value={selectedScopeId} onChange={(event) => setScopeId(event.target.value)} options={scopes.map((scope) => ({ value: scope.id, label: scope.name }))} placeholder="請選擇通路" />
          <Field className="min-w-[260px] flex-[1.6_1_280px]" label="報表檔案（.xlsx）" required><Input className="w-full" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></Field>
          <TextField className="min-w-[180px] flex-[1_1_190px]" label="報表密碼" required type="password" inputClassName="w-full" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="請輸入報表密碼" autoComplete="off" />
          <Button className="shrink-0" type="submit" size="lg" icon="analytics" loading={run.isPending} loadingLabel="送出中…" disabled={blocked}>上傳並開始整理</Button>
          {running ? <span className="form-hint">GitHub Actions 處理中…可以關閉這一頁</span> : null}
        </form>
        {file ? <p className="muted table-note">已選擇：{file.name}</p> : null}
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
        {selectedScope?.driveFolderUrl ? <p className="muted table-note">上傳位置：<a className="link-external" href={selectedScope.driveFolderUrl} target="_blank" rel="noopener noreferrer">{selectedScope.driveFolderName || "Google Drive 資料夾"}<Icon name="external" /></a></p> : null}
      </Panel>

      {followed ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
        />
      ) : null}
    </>
  );
  return embedded ? content : <Page>{content}</Page>;
}
