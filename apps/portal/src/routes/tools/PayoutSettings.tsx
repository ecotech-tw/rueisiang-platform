import { useEffect, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePayoutStores, useSavePayoutStores, type PayoutStore } from "./api.js";

type Draft = Omit<PayoutStore, "id">;

/**
 * 出金表的店別設定。
 *
 * 舊版把 stores.json 打包進 Worker，改完要下載檔案、commit 回 repo、重新部署，
 * 執行頁才會看到——實務上沒有人會這樣改。現在存在 D1，按儲存就生效。
 *
 * 但有一件事沒有變，而且一定要講清楚：**跑在 GitHub Actions 上的 driver 讀的是
 * 帳務 repo 裡的 stores.json**。這一頁決定「執行頁看得到哪幾家店」，driver 決定
 * 「檔案上傳到哪個 Drive 資料夾」。在這裡新增一家帳務 repo 沒有的店，送出去會
 * 失敗——所以下載按鈕留著。
 */
export function PayoutSettings() {
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

  function download() {
    // 只給店別：系統參數（網址、信箱、欄位公式）留在帳務 repo 的 config.json，
    // 不該被這一頁的產出蓋掉。
    const blob = new Blob([`${JSON.stringify({ stores: drafts }, null, 2)}\n`], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "stores.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  if (query.isPending) return <div className="boot">載入中…</div>;

  return (
    <div className="page">
      <header className="page-head">
        <h1>出金表店別設定</h1>
        <p className="muted">
          這裡決定執行頁看得到哪幾家店。<b>店名必須與 CYBERBIZ 後台的 POS 商店完全一致</b>，
          driver 靠它找店。
        </p>
      </header>

      <p className="notice">
        實際上傳到哪個 Drive 資料夾，是由帳務 repo 裡的 <code>stores.json</code> 決定的。
        在這裡新增一家那邊還沒有的店，執行時會失敗——請下載這份清單、更新
        <code>ecotech-tw/rueisiang-tool-billing</code> 之後再跑。
      </p>

      <section className="panel">
        <div className="admin-form toolbar">
          <button
            type="button"
            className="primary-button"
            disabled={save.isPending || !drafts.length}
            onClick={() => save.mutate(drafts)}
          >
            {save.isPending ? "儲存中…" : "儲存設定"}
          </button>
          <button type="button" className="ghost-button with-icon" onClick={download}>
            <Icon name="storefront" />
            下載 stores.json
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              setDrafts((current) => [...current, { name: "", driveFolderUrl: "", driveFolderName: "" }])
            }
          >
            ＋ 新增一家
          </button>
          {save.isSuccess && !save.isPending ? <span className="form-hint">已儲存。</span> : null}
        </div>

        {save.error ? <p className="form-error" role="alert">{save.error.message}</p> : null}

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
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => setDrafts((current) => current.filter((_, i) => i !== index))}
                        title={`移除 ${store.name || "這一列"}，儲存後執行頁就看不到`}
                        aria-label={`移除 ${store.name || `第 ${index + 1} 列`}`}
                      >
                        <Icon name="trash" />
                      </button>
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
      </section>
    </div>
  );
}
