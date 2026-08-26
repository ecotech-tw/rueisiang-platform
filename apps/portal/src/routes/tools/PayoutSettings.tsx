import { useEffect, useState } from "react";
import { usePayoutStores, useSavePayoutStores, type PayoutStore } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";

type Draft = Omit<PayoutStore, "id">;

/**
 * 出金表的店別設定。
 *
 * 舊版把 stores.json 打包進 Worker，改完要下載檔案、commit 回 repo、重新部署，
 * 執行頁才會看到——實務上沒有人會這樣改。現在按儲存就做完整件事：先 commit 回
 * 帳務 repo 的 stores.json（driver 在 runner 上讀的就是那一份），成功了才寫本地。
 *
 * 所以這一頁沒有下載按鈕。只有在平台還沒設定 GitHub token 時，才會退回「只存
 * 本地」並提醒 repo 沒更新——那種狀態下兩邊是不一致的，必須講出來。
 */
export function PayoutSettings() {
  usePageTitle("出金表店別設定");
  const query = usePayoutStores();
  const save = useSavePayoutStores();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!query.data || loaded) return;
    setDrafts(query.data.stores.map(({ id: _id, ...rest }) => rest));
    setLoaded(true);
  }, [query.data, loaded]);

  function update(index: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((store, i) => (i === index ? { ...store, ...patch } : store)));
  }

  if (query.isPending) return <div className="boot">載入中…</div>;

  return (
    <div className="page">
      <PageHeader
        title="出金表店別設定"
        description={
          <>
          這裡決定執行頁看得到哪幾家店，以及檔案要上傳到哪個 Drive 資料夾。
          <b>店名必須與 CYBERBIZ 後台的 POS 商店完全一致</b>，driver 靠它找店。
          儲存時會一併 commit 回帳務 repo 的 <code>stores.json</code>。
          </>
        }
      />

      <Panel>
        <div className="admin-form toolbar">
          <Button
            loading={save.isPending}
            disabled={!drafts.length}
            onClick={() => save.mutate(drafts)}
            loadingLabel="儲存中…"
          >
            儲存設定
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              setDrafts((current) => [...current, { name: "", driveFolderUrl: "", driveFolderName: "" }])
            }
          >
            ＋ 新增一家
          </Button>
          {save.isSuccess && !save.isPending ? (
            <span className="form-hint">
              {!save.data.syncedToRepo
                ? "已存在平台，但沒有寫回帳務 repo（未設定 GITHUB_TOKEN）。"
                : save.data.committed
                  ? "已儲存，並更新帳務 repo 的 stores.json。"
                  : "已儲存。內容與帳務 repo 相同，沒有產生新的 commit。"}
            </span>
          ) : null}
        </div>

        {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>店名（與後台一致）</th>
                <th>Drive 資料夾連結</th>
                <th>資料夾顯示名稱</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((store, index) => (
                <tr key={index}>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的店名`}
                      className="cell-input"
                      value={store.name}
                      onChange={(event) => update(index, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的 Drive 連結`}
                      className="cell-input wide"
                      placeholder="https://drive.google.com/drive/folders/…"
                      value={store.driveFolderUrl}
                      onChange={(event) => update(index, { driveFolderUrl: event.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的資料夾顯示名稱`}
                      className="cell-input"
                      value={store.driveFolderName}
                      onChange={(event) => update(index, { driveFolderName: event.target.value })}
                    />
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        variant="icon"
                        className="danger"
                        icon="trash"
                        onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                        title={`移除 ${store.name || "這一列"}，儲存後執行頁就看不到`}
                        aria-label={`移除 ${store.name || `第 ${index + 1} 列`}`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {drafts.length === 0 ? (
          <p className="muted table-note">目前一家店都沒有，執行頁會是空的。</p>
        ) : null}
      </Panel>
    </div>
  );
}
