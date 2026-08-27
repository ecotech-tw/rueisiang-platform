import { useEffect, useState } from "react";
import { DateRangePicker } from "../../shell/DateRangePicker.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, WorkflowRunPanel } from "../../ui/index.js";
import {
  parseStores,
  useCyberbizSalesState,
  useCyberbizSalesStatus,
  useRunCyberbizSales,
} from "./api.js";

function formatDate(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function CyberbizSales() {
  usePageTitle("商品銷售報表執行");
  const state = useCyberbizSalesState();
  const run = useRunCyberbizSales();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useCyberbizSalesStatus(tracking ?? state.data?.latestRequestId ?? null);

  useEffect(() => {
    if (!state.data) return;
    setStart((current) => current || state.data.defaultStart);
    setEnd((current) => current || state.data.defaultEnd);
  }, [state.data]);

  if (state.isPending) return <div className="boot">載入中…</div>;

  const stores = state.data?.stores ?? [];
  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  // workflow_dispatch 回 204 後，GitHub 建立 run 會有幾秒延遲；這段時間不能再送第二次。
  const awaitingRegistration = Boolean(tracking && !status.data?.runs.length);
  const running = awaitingRegistration || (Boolean(latest) && latest!.status !== "completed");
  const rangeError = start && end && start > end ? "起日不能晚於迄日。" : "";
  const blocked = running || run.isPending || !start || !end || Boolean(rangeError) || !state.data?.configured;

  function start_(names: string[]) {
    run.mutate({ stores: names, start, end }, { onSuccess: (result) => setTracking(result.requestId) });
  }

  return (
    <div className="page">
      <PageHeader
        title="商品銷售報表執行"
        description="從 CYBERBIZ POS 匯出商品銷售總表，依店別上傳到既有 Google Drive 通路資料夾；完整月份會另外把每日商品資料匯入 D1，供小香查詢。"
      />

      {!state.data?.configured ? (
        <Alert tone="danger">平台還沒設定商品銷售報表的 GitHub workflow，現在無法執行。</Alert>
      ) : null}

      <Panel>
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <span className="inline-label">報表區間</span>
          <DateRangePicker
            start={start}
            end={end}
            disabled={blocked}
            onChange={(range) => { setStart(range.start); setEnd(range.end); }}
          />
          <Button
            icon="analytics"
            loading={run.isPending}
            loadingLabel="執行中…"
            disabled={blocked || !stores.length}
            onClick={() => start_(stores.map((store) => store.name))}
            title="所有店別執行同一段區間"
          >
            全部執行
          </Button>
          {running ? <span className="form-hint">執行中…可以關閉這一頁</span> : null}
        </form>

        <p className="muted table-note">
          完整月份會逐日匯出並把商品銷售日資料匯入 D1；例如 2026-07-14 ~ 2026-07-18 仍會上傳區間原始 XLSX 到 Drive，但不會匯入 D1。原始檔與 D1 查詢資料彼此獨立。
        </p>
        {rangeError ? <Alert tone="danger">{rangeError}</Alert> : null}
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>通路</th><th>Drive 資料夾</th><th /></tr></thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.name}>
                  <td className="cell-strong">{store.name}</td>
                  <td className="cell-sub">
                    {store.folderUrl ? (
                      <a className="link-external" href={store.folderUrl} target="_blank" rel="noopener noreferrer">
                        {store.folder || store.name}<Icon name="external" />
                      </a>
                    ) : "未設定資料夾"}
                  </td>
                  <td><Button variant="secondary" loading={run.isPending} loadingLabel="執行中…" disabled={blocked} onClick={() => start_([store.name])}>執行</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!stores.length ? <p className="muted table-note">還沒有任何店別，請先到「店別與報表設定」新增一家。</p> : null}
      </Panel>

      {followed ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
          failureLabel="未完成"
          artifactNote="執行完成的 xlsx 與報告會保留在這次 GitHub Actions 的 Artifacts。"
        />
      ) : null}

      <Panel title="最近執行">
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>時間</th><th>通路</th><th>區間</th><th>D1 匯入</th><th>執行的人</th></tr></thead>
            <tbody>
              {(state.data?.runs ?? []).map((record) => {
                const names = parseStores(record.storesJson);
                return (
                  <tr key={record.id}>
                    <td className="cell-sub whitespace-nowrap">{formatDate(record.createdAt)}</td>
                    <td>{names.length > 1 ? `全部 ${names.length} 家` : names[0] ?? "—"}</td>
                    <td className="cell-sub whitespace-nowrap">{record.startDate} ~ {record.endDate}</td>
                    <td>{record.periodKind === "month" ? "完整月份可匯入" : "不匯入（Drive only）"}</td>
                    <td className="cell-sub">{record.actorEmail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(state.data?.runs.length ?? 0) === 0 ? <p className="muted table-note">還沒有人從這裡執行過。</p> : null}
      </Panel>
    </div>
  );
}
