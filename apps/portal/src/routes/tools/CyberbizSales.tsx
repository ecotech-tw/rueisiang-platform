import { useEffect, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, WorkflowRunPanel } from "../../ui/index.js";
import {
  parseStores,
  useCyberbizSalesState,
  useCyberbizSalesStatus,
  useRunCyberbizSales,
} from "./api.js";
import { useStoreSelection } from "./store-selection.js";

function formatDate(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function monthRange(value: string): { start: string; end: string } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year ?? 0, month ?? 0, 0)).getUTCDate();
  return { start: `${value}-01`, end: `${value}-${String(lastDay).padStart(2, "0")}` };
}

export function CyberbizSales() {
  usePageTitle("商品銷售報表執行");
  const state = useCyberbizSalesState();
  const run = useRunCyberbizSales();
  const [month, setMonth] = useState("");
  const [tracking, setTracking] = useState<string | null>(null);
  const status = useCyberbizSalesStatus(tracking ?? state.data?.latestRequestId ?? null);
  const stores = state.data?.stores ?? [];
  // 查詢尚未完成時也要執行，否則載入完成後 hook 數量會改變。
  const { selectedNames, allSelected, toggle, toggleAll } = useStoreSelection(stores);

  useEffect(() => {
    if (!state.data) return;
    setMonth((current) => current || state.data.defaultStart.slice(0, 7));
  }, [state.data]);

  if (state.isPending) return <div className="boot">載入中…</div>;

  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  // workflow_dispatch 回 204 後，GitHub 建立 run 會有幾秒延遲；這段時間不能再送第二次。
  const awaitingRegistration = Boolean(tracking && !status.data?.runs.length);
  const running = awaitingRegistration || (Boolean(latest) && latest!.status !== "completed");
  const range = monthRange(month);
  const blocked = running || run.isPending || !range || !state.data?.configured;

  function start_(names: string[]) {
    if (!range) return;
    run.mutate({ stores: names, ...range }, { onSuccess: (result) => setTracking(result.requestId) });
  }

  return (
    <div className="page">
      <PageHeader
        title="商品銷售報表執行"
        description="從 CYBERBIZ POS 匯出商品銷售總表，依店別上傳到既有 Google Drive 通路資料夾；每次執行只匯出一份完整月份，並把月資料匯入 D1 供小香查詢。"
      />

      {!state.data?.configured ? (
        <Alert tone="danger">平台還沒設定商品銷售報表的 GitHub workflow，現在無法執行。</Alert>
      ) : null}

      <Panel>
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
            disabled={blocked || !selectedNames.length}
            onClick={() => start_(selectedNames)}
            title={allSelected ? "所有顯示中的店別執行同一段區間" : "執行勾選的店別"}
          >
            {allSelected ? "全部執行" : `執行選取的 ${selectedNames.length} 家`}
          </Button>
          <span className="form-hint">已選 {selectedNames.length} / {stores.length} 家</span>
          {running ? <span className="form-hint">執行中…可以關閉這一頁</span> : null}
        </form>

        <p className="muted table-note">
          每次執行只匯出一份完整月份 XLSX；原始檔上傳 Drive，並把該月份的商品銷售資料匯入 D1。原始檔與 D1 查詢資料彼此獨立。
        </p>
        {run.error ? <Alert tone="danger">{run.error.message}</Alert> : null}
        {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <label className="table-select-all">
                    <span>選取</span>
                    <input
                      className="table-checkbox"
                      type="checkbox"
                      checked={allSelected}
                      disabled={blocked || !stores.length}
                      onChange={toggleAll}
                      aria-label="全選顯示中的店別"
                    />
                  </label>
                </th>
                <th>通路</th>
                <th>Drive 資料夾</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => (
                <tr key={store.name}>
                  <td className="store-selection-cell" data-label="選取">
                    <input
                      className="table-checkbox"
                      type="checkbox"
                      checked={selectedNames.includes(store.name)}
                      disabled={blocked}
                      onChange={(event) => toggle(store.name, event.target.checked)}
                      aria-label={`選取 ${store.name}`}
                    />
                  </td>
                  <td className="cell-strong store-name-cell">{store.name}</td>
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
                    <td>{names.length > 1 ? `選取 ${names.length} 家` : names[0] ?? "—"}</td>
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
