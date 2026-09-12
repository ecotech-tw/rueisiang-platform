import { useEffect, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, WorkflowRunPanel } from "../../ui/index.js";
import { useRunShopReport, useShopReportState, useShopReportStatus } from "./api.js";

function isValidMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/**
 * 官網對帳單執行。
 *
 * 這一頁沒有店別勾選表，跟旁邊兩頁不一樣：官網是整個帳戶一份對帳單，沒有櫃點可以挑。
 * 能選的只有月份——期間是 CYBERBIZ 每半個月自己出的（1–15、16–月底），
 * driver 會把那個月的兩期都抓下來，還沒結帳的那一期自動跳過。
 *
 * API 與 workflow 收的是月份範圍（driver 支援一次跑好幾個月），但畫面只給一個月：
 * 一次跑一個月比較好對帳，出錯時也只要重跑那一個月。要補一整年就從 GitHub 直接
 * dispatch，那條路本來就在。
 */
export function ShopReport() {
  usePageTitle("官網報表執行");
  const state = useShopReportState();
  const run = useRunShopReport();
  const [month, setMonth] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useShopReportStatus(tracking ?? state.data?.latestRequestId ?? null);

  useEffect(() => {
    if (!state.data) return;
    setMonth((current) => current || state.data.defaultStartMonth);
  }, [state.data]);

  if (state.isPending) return <div className="boot">載入中…</div>;

  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  // workflow_dispatch 回 204 後，GitHub 建立 run 會有幾秒延遲；這段時間不能再送第二次。
  const awaitingRegistration = Boolean(tracking && !status.data?.runs.length);
  const running = awaitingRegistration || (Boolean(latest) && latest!.status !== "completed");
  const monthValid = isValidMonth(month);
  const blocked = running || run.isPending || !state.data?.configured;

  return (
    <div className="page fills">
      <PageHeader
        title="官網報表執行"

      />

      {!state.data?.githubConfigured ? (
        <Alert tone="danger">平台還沒設定官網對帳單的 GitHub workflow，現在無法執行。</Alert>
      ) : null}
      {state.data?.githubConfigured && !state.data.driveFolderUrl ? (
        <Alert tone="danger">請先在通路管理設定官網的 Google Drive 資料夾，現在無法執行。</Alert>
      ) : null}
      {state.data?.driveFolderUrl ? (
        <p className="muted table-note">上傳位置：<a className="link-external" href={state.data.driveFolderUrl} target="_blank" rel="noopener noreferrer">{state.data.driveFolderName || "Google Drive 資料夾"}</a></p>
      ) : null}

      <Panel className="grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <span className="inline-label">報表月份</span>
          <input
            className="text-input"
            type="month"
            value={month}
            disabled={blocked}
            onChange={(event) => setMonth(event.target.value)}
            aria-label="報表月份"
          />
          <Button
            icon="analytics"
            loading={run.isPending}
            loadingLabel="執行中…"
            disabled={blocked || !monthValid}
            onClick={() => run.mutate(
              // 一次跑一個月：那個月的兩期（1–15、16–月底）都會抓。
              { startMonth: month, endMonth: month },
              { onSuccess: (result) => setTracking(result.requestId) },
            )}
          >
            執行
          </Button>
          {running ? <span className="form-hint">執行中…可以關閉這一頁</span> : null}
        </form>


        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
      </Panel>

      {followed ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
          failureLabel="有期間未完成"
          artifactNote="下載到的對帳單 xlsx 與失敗截圖會保留在這次 GitHub Actions 的 Artifacts。"
        />
      ) : null}

    </div>
  );
}
