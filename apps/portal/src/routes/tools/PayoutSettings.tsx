import { useEffect, useRef, useState } from "react";
import {
  useDeletePayoutStore,
  usePayoutStores,
  useSavePayoutStore,
  useSaveShopeeSalesSettings,
  useShopeeSalesSettings,
  type PayoutStoreDraft,
} from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Switch } from "../../shell/Switch.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, PageHeader, Panel, TextField } from "../../ui/index.js";

type Draft = PayoutStoreDraft & { clientKey: string };

/**
 * 營運工具的店別與報表設定。
 *
 * 店名與 Drive 設定在欄位離開後自動同步平台與 runner；顯示開關只更新平台，
 * 因為它決定的是兩個執行頁要不要顯示這家店。
 */
export function PayoutSettings() {
  usePageTitle("店別與報表設定");
  const query = usePayoutStores();
  const saveStore = useSavePayoutStore();
  const deleteStore = useDeletePayoutStore();
  const shopeeQuery = useShopeeSalesSettings();
  const saveShopee = useSaveShopeeSalesSettings();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const draftsRef = useRef<Draft[]>([]);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const [queuedWrites, setQueuedWrites] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [shopeeUrl, setShopeeUrl] = useState("");
  const [shopeeName, setShopeeName] = useState("");
  const [shopeeLoaded, setShopeeLoaded] = useState(false);
  const [deleting, setDeleting] = useState<{ draft: Draft; index: number } | null>(null);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    if (!query.data || loaded) return;
    setDrafts(query.data.stores.map((store) => ({ ...store, clientKey: store.id })));
    setLoaded(true);
  }, [query.data, loaded]);

  useEffect(() => {
    if (!shopeeQuery.data || shopeeLoaded) return;
    setShopeeUrl(shopeeQuery.data.settings.driveFolderUrl);
    setShopeeName(shopeeQuery.data.settings.driveFolderName);
    setShopeeLoaded(true);
  }, [shopeeQuery.data, shopeeLoaded]);

  function update(index: number, patch: Partial<Draft>) {
    setDrafts((current) => current.map((store, i) => (i === index ? { ...store, ...patch } : store)));
  }

  function enqueueStoreWrite(task: () => Promise<unknown>) {
    setQueuedWrites((current) => current + 1);
    const next = writeQueue.current.then(task, task);
    writeQueue.current = next.then(
      () => setQueuedWrites((current) => current - 1),
      () => setQueuedWrites((current) => current - 1),
    );
  }

  function toggleEnabled(index: number, enabled: boolean) {
    const store = drafts[index];
    if (!store) return;
    const previous = store.enabled;
    update(index, { enabled });
    // 新增但尚未自動儲存的店別還沒有資料庫 id，先改草稿，欄位儲存時再一起建立。
    if (!store.id) return;
    enqueueStoreWrite(async () => {
      try {
        await saveStore.mutateAsync({ id: store.id, enabled });
      } catch (error) {
        setDrafts((current) => current.map((candidate) => candidate.clientKey === store.clientKey
          ? { ...candidate, enabled: previous }
          : candidate));
        throw error;
      }
    });
  }

  function saveDraft(index: number) {
    const draft = drafts[index];
    if (!draft || !draft.name.trim()) return;

    enqueueStoreWrite(async () => {
      const latest = draftsRef.current.find((candidate) => candidate.clientKey === draft.clientKey);
      if (!latest || !latest.name.trim()) return;

      const { clientKey: _clientKey, ...store } = latest;
      const data = await saveStore.mutateAsync(store);
      setDrafts((current) => current.map((candidate) => candidate.clientKey === latest.clientKey
        ? { ...candidate, id: candidate.id ?? data.store.id }
        : candidate));
    });
  }

  function removeStore(target: { draft: Draft; index: number }) {
    const { draft, index } = target;
    setDrafts((current) => current.filter((candidate) => candidate.clientKey !== draft.clientKey));
    if (!draft.id) return;

    enqueueStoreWrite(async () => {
      try {
        await deleteStore.mutateAsync(draft.id!);
      } catch (error) {
        setDrafts((current) => {
          const restored = [...current];
          restored.splice(Math.min(index, restored.length), 0, draft);
          return restored;
        });
        throw error;
      }
    });
  }

  const storeBusy = queuedWrites > 0 || saveStore.isPending || deleteStore.isPending;

  if (query.isPending || shopeeQuery.isPending) return <div className="boot">載入中…</div>;
  if (query.error || shopeeQuery.error) {
    return <div className="page"><Alert tone="danger">{query.error?.message ?? shopeeQuery.error?.message}</Alert></div>;
  }

  return (
    <div className="page">
      <PageHeader
        title="店別與報表設定"
        description={
          <>
          這裡決定出金表與 CYBERBIZ 商品銷售報表執行頁看得到哪幾家店，以及檔案要上傳到哪個 Drive 資料夾。
          <b>店名必須與 CYBERBIZ 後台的 POS 商店完全一致</b>，driver 靠它找店。
          「顯示於執行頁」切換後立即生效；店名與 Drive 設定在離開欄位時自動儲存，並一併同步帳務 repo 的 <code>stores.json</code>。
          </>
        }
      />

      <Panel>
        <div className="admin-form toolbar">
          <Button
            variant="secondary"
            disabled={storeBusy}
            onClick={() =>
              setDrafts((current) => [...current, {
                name: "",
                driveFolderUrl: "",
                driveFolderName: "",
                enabled: true,
                clientKey: crypto.randomUUID(),
              }])
            }
          >
            ＋ 新增一家
          </Button>
          {storeBusy ? <span className="form-hint">自動儲存中…</span> : null}
          {!storeBusy && (saveStore.isSuccess || deleteStore.isSuccess) ? (
            <span className="form-hint">已自動儲存。</span>
          ) : null}
        </div>

        {saveStore.error ? <Alert tone="danger">{saveStore.error.message}</Alert> : null}
        {deleteStore.error ? <Alert tone="danger">{deleteStore.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>店名（與後台一致）</th>
                <th>Drive 資料夾連結</th>
                <th>資料夾顯示名稱</th>
                <th>顯示於執行頁</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((store, index) => (
                <tr key={store.clientKey}>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的店名`}
                      className="cell-input"
                      value={store.name}
                      onChange={(event) => update(index, { name: event.target.value })}
                      onBlur={() => saveDraft(index)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的 Drive 連結`}
                      className="cell-input wide"
                      placeholder="https://drive.google.com/drive/folders/…"
                      value={store.driveFolderUrl}
                      onChange={(event) => update(index, { driveFolderUrl: event.target.value })}
                      onBlur={() => saveDraft(index)}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`第 ${index + 1} 家店的資料夾顯示名稱`}
                      className="cell-input"
                      value={store.driveFolderName}
                      onChange={(event) => update(index, { driveFolderName: event.target.value })}
                      onBlur={() => saveDraft(index)}
                    />
                  </td>
                  <td data-label="顯示於執行頁">
                    <div className="report-store-toggle">
                      <Switch
                        checked={store.enabled}
                        busy={storeBusy}
                        onChange={(enabled) => toggleEnabled(index, enabled)}
                        label={`${store.name || `第 ${index + 1} 家店`}顯示於出金表與商品銷售報表執行頁`}
                      />
                      <span>{store.enabled ? "顯示" : "隱藏"}</span>
                    </div>
                  </td>
                  <td>
                    <div className="row-actions">
                      <Button
                        variant="icon"
                        className="danger"
                        icon="trash"
                        disabled={storeBusy}
                        onClick={() => setDeleting({ draft: store, index })}
                        title={`移除 ${store.name || "這一列"}，刪除後執行頁就看不到`}
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

      {deleting ? (
        <ConfirmDialog
          title={`刪除「${deleting.draft.name || "這家店"}」？`}
          confirmLabel="刪除店別"
          pending={deleteStore.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            removeStore(target);
          }}
        >
          <p><strong>{deleting.draft.name || "這家店"}</strong> 的店別設定會從平台移除，兩個報表執行頁也不再顯示。</p>
          <p className="muted">已經匯入報表的歷史資料不會被刪除。</p>
        </ConfirmDialog>
      ) : null}

      <Panel>
        <h2>蝦皮報表設定</h2>
        <p className="muted">
          設定蝦皮銷售報表整理後要上傳的 Google Drive 資料夾。使用者上傳 Excel 後，GitHub Actions 會把新檔放到這裡。
        </p>
        <form
          className="admin-form shopee-settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            saveShopee.mutate({ driveFolderUrl: shopeeUrl, driveFolderName: shopeeName });
          }}
        >
          <TextField
            label="Google Drive 資料夾連結"
            inputClassName="cell-input wide"
            value={shopeeUrl}
            onChange={(event) => setShopeeUrl(event.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
          />
          <TextField
            label="顯示名稱"
            inputClassName="cell-input"
            value={shopeeName}
            onChange={(event) => setShopeeName(event.target.value)}
            placeholder="蝦皮銷售報表"
          />
          <div className="form-actions shopee-settings-actions">
            <Button type="submit" loading={saveShopee.isPending} loadingLabel="儲存中…">儲存蝦皮設定</Button>
            {saveShopee.isSuccess ? <span className="form-hint">已儲存。</span> : null}
          </div>
          {saveShopee.error ? <Alert tone="danger">{saveShopee.error.message}</Alert> : null}
        </form>
      </Panel>
    </div>
  );
}
