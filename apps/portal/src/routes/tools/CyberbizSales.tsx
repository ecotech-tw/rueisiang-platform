import { useEffect, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, WorkflowRunPanel } from "../../ui/index.js";
import {

  useCyberbizSalesState,
  useCyberbizSalesStatus,
  useRunCyberbizSales,
} from "./api.js";
import { useStoreSelection } from "./store-selection.js";

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
    <div className="page fills">
      <PageHeader
        title="商品銷售報表執行"

      />

      {!state.data?.configured ? (
        <Alert tone="danger">平台還沒設定商品銷售報表的 GitHub workflow，現在無法執行。</Alert>
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
            disabled={blocked || !selectedNames.length}
            onClick={() => start_(selectedNames)}
          >
            {allSelected ? "全部執行" : `執行選取的 ${selectedNames.length} 家`}
          </Button>
          <span className="form-hint">已選 {selectedNames.length} / {stores.length} 家</span>
          {running ? <span className="form-hint">執行中…可以關閉這一頁</span> : null}
        </form>


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
                  <td className="cell-strong store-name-cell" data-label="通路">{store.name}</td>
                  <td className="cell-sub" data-label="Drive 資料夾">
                    {store.folderUrl ? (
                      <a className="link-external" href={store.folderUrl} target="_blank" rel="noopener noreferrer">
                        {store.folder || store.name}<Icon name="external" />
                      </a>
                    ) : "未設定資料夾"}
                  </td>
                  <td data-label="操作"><Button variant="secondary" loading={run.isPending} loadingLabel="執行中…" disabled={blocked} onClick={() => start_([store.name])}>執行</Button></td>
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

    </div>
  );
}
