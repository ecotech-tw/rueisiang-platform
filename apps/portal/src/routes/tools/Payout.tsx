import { useEffect, useState } from "react";
import { DateRangePicker } from "../../shell/DateRangePicker.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel, WorkflowRunPanel } from "../../ui/index.js";
import {

  usePayoutState,
  usePayoutStatus,
  useRunPayout,
} from "./api.js";
import { useStoreSelection } from "./store-selection.js";

/**
 * 出金表執行頁。
 *
 * 真正的流程跑在帳務 repo 的 GitHub Actions 上：開 Chrome、登 CYBERBIZ、從 Gmail
 * 取回報表、寫欄位、上傳 Drive。這一頁只做兩件事——送出，然後把狀態問回來。
 * 送出之後可以直接關掉分頁，工作在 GitHub 那邊照樣跑完。
 */

export function Payout() {
  usePageTitle("出金表執行");
  const state = usePayoutState();
  const run = useRunPayout();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  /**
   * 正在追蹤的那一次執行。
   *
   * 初始值來自後端最近一筆紀錄，不是空的——離開網頁再回來、或直接重新整理時，
   * 畫面要自己接回去問狀態。不然人會看到一片空白，不知道上次到底跑完了沒，
   * 只好再按一次；出金表按第二次是會真的再跑一輪的。
   */
  const [tracking, setTracking] = useState<string | null>(null);
  const status = usePayoutStatus(tracking ?? state.data?.latestRequestId ?? null);

  // 預設區間由後端算（上個月，Asia/Taipei），但人改過之後不要被覆蓋回去。
  useEffect(() => {
    if (!state.data) return;
    setStart((current) => current || state.data.defaultStart);
    setEnd((current) => current || state.data.defaultEnd);
  }, [state.data]);

  const stores = state.data?.stores ?? [];
  const { selectedNames, allSelected, toggle, toggleAll } = useStoreSelection(stores);
  const latest = status.data?.runs[0];
  const followed = tracking ?? state.data?.latestRequestId ?? null;
  const running = Boolean(latest) && latest!.status !== "completed";
  const rangeError = start && end && start > end ? "起日不能晚於迄日。" : "";
  const blocked = running || run.isPending || !start || !end || Boolean(rangeError) || !state.data?.configured;

  function start_(names: string[]) {
    run.mutate(
      { stores: names, start, end },
      { onSuccess: (result) => setTracking(result.requestId) },
    );
  }

  if (state.isPending) return <div className="boot">載入中…</div>;

  return (
    <div className="page fills">
      <PageHeader
        title="出金表執行"

      />

      {!state.data?.configured ? (
        <Alert tone="danger">平台還沒設定 GITHUB_TOKEN，目前無法觸發執行。</Alert>
      ) : null}

      <Panel className="grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <span className="inline-label">對帳區間</span>
          <DateRangePicker
            start={start}
            end={end}
            disabled={run.isPending}
            onChange={(range) => {
              setStart(range.start);
              setEnd(range.end);
            }}
          />
          <Button
            icon="payments"
            loading={run.isPending}
            disabled={blocked || !selectedNames.length}
            onClick={() => start_(selectedNames)}
          >
            {allSelected ? "全部執行" : `執行選取的 ${selectedNames.length} 家`}
          </Button>
          <span className="form-hint">已選 {selectedNames.length} / {stores.length} 家</span>
          {running ? <span className="form-hint">執行中…可以關掉這一頁</span> : null}
        </form>

        {rangeError ? <Alert tone="danger">{rangeError}</Alert> : null}
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
                      <a
                        className="link-external"
                        href={store.folderUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {store.folder || store.name}
                        <Icon name="external" />
                      </a>
                    ) : (
                      "未設定資料夾"
                    )}
                  </td>
                  <td data-label="操作">
                    <div className="row-actions">
                      <Button
                        variant="secondary"
                        disabled={blocked}
                        onClick={() => start_([store.name])}
                      >
                        執行
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {stores.length === 0 ? (
          <p className="muted table-note">還沒有任何店別，先到「店別與報表設定」加一家。</p>
        ) : null}
      </Panel>

      {followed ? (
        <WorkflowRunPanel
          tracking={Boolean(tracking)}
          latest={latest}
          steps={status.data?.steps ?? []}
          failureLabel="有項目未完成"
          artifactNote="執行完的 xlsx 與報告放在該次工作的 Artifacts（保留 30 天）。"
        />
      ) : null}

    </div>
  );
}
