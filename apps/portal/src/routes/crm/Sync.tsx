import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface SyncStatus {
  configured: boolean;
  webhookConfigured: boolean;
  customers: { total: number; synced: number; localOnly: number; failed: number };
  lastSyncedAt: string | null;
  webhooks: { processed: number; failed: number; ignored: number; lastReceivedAt: string | null };
  recent: {
    id: string;
    topic: string;
    status: string;
    cyberbizCustomerId: string | null;
    lastError: string | null;
    receivedAt: string;
  }[];
}

interface SyncRun {
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  ignored: number;
  fromPage: number;
  toPage: number;
  totalPages: number;
  hasMore: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  processed: "已處理",
  ignored: "略過",
  failed: "失敗",
  processing: "處理中",
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function Sync() {
  const client = useQueryClient();
  const [lastRun, setLastRun] = useState<SyncRun | null>(null);

  const status = useQuery({
    queryKey: ["crm", "sync", "status"],
    queryFn: () => call<SyncStatus>("/api/crm/sync/status"),
    // webhook 是隨時會進來的，這一頁開著就讓它自己更新。
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["crm"] });
  };

  const runSync = useMutation({
    mutationFn: (page: number) => call<SyncRun>(`/api/crm/sync?page=${page}`, { method: "POST" }),
    onSuccess: (result) => {
      setLastRun(result);
      refresh();
    },
  });

  const retry = useMutation({
    mutationFn: () =>
      call<{ attempted: number; recovered: number }>("/api/crm/sync/retry", { method: "POST" }),
    onSuccess: refresh,
  });

  if (status.isPending) return <div className="boot">載入中…</div>;
  if (status.error) {
    return (
      <div className="page">
        <header className="page-head"><h1>CYBERBIZ 同步</h1></header>
        <p className="form-error" role="alert">{status.error.message}</p>
      </div>
    );
  }

  const data = status.data!;

  return (
    <div className="page">
      <header className="page-head">
        <h1>CYBERBIZ 同步</h1>
        <p className="muted">
          官網的會員異動會透過 webhook 即時進來；這一頁可以看狀態，也可以手動補拉。
        </p>
      </header>

      {!data.configured ? (
        <p className="form-error" role="alert">
          尚未設定 CYBERBIZ_API_TOKEN，手動同步無法執行。請在 Cloudflare 的 Worker 設定裡加入。
        </p>
      ) : null}
      {!data.webhookConfigured ? (
        <p className="form-error" role="alert">
          尚未設定 CYBERBIZ_WEBHOOK_SECRET，webhook 會一律被擋下。
        </p>
      ) : null}

      <div className="stat-row">
        <div className="stat"><span>客戶總數</span><strong>{data.customers.total}</strong></div>
        <div className="stat"><span>已與官網同步</span><strong>{data.customers.synced}</strong></div>
        <div className="stat"><span>僅存在本地</span><strong>{data.customers.localOnly}</strong></div>
        <div className="stat"><span>同步失敗</span><strong>{data.customers.failed}</strong></div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">手動同步</h2>
          <div className="pager-buttons">
            <button
              type="button"
              className="primary-button"
              disabled={!data.configured || runSync.isPending}
              onClick={() => runSync.mutate(1)}
            >
              {runSync.isPending ? "同步中…" : "從第 1 頁開始"}
            </button>
            {lastRun?.hasMore ? (
              <button
                type="button"
                className="ghost-button"
                disabled={runSync.isPending}
                onClick={() => runSync.mutate(lastRun.toPage + 1)}
              >
                繼續拉第 {lastRun.toPage + 1} 頁
              </button>
            ) : null}
          </div>
        </div>

        <p className="muted">
          一次最多拉 10 頁（每頁 50 筆）。Worker 有執行時間上限，拉不完會回報還有下一頁，
          按「繼續」接著拉。最後一次同步：{formatTime(data.lastSyncedAt)}
        </p>

        {runSync.error ? <p className="form-error" role="alert">{runSync.error.message}</p> : null}

        {lastRun ? (
          <p className="muted form-foot">
            第 {lastRun.fromPage}–{lastRun.toPage} 頁（共 {lastRun.totalPages} 頁）：
            收到 {lastRun.received} 筆，新增 {lastRun.created}、更新 {lastRun.updated}、
            無變化 {lastRun.unchanged}、略過 {lastRun.ignored}。
            {lastRun.hasMore ? "後面還有。" : "已經拉到最後一頁。"}
          </p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Webhook</h2>
          <button
            type="button"
            className="ghost-button"
            disabled={retry.isPending || data.webhooks.failed === 0}
            onClick={() => retry.mutate()}
          >
            {retry.isPending ? "補跑中…" : `補跑失敗的（${data.webhooks.failed}）`}
          </button>
        </div>

        <p className="muted">
          已處理 {data.webhooks.processed}、略過 {data.webhooks.ignored}、
          失敗 {data.webhooks.failed}。最後收到：{formatTime(data.webhooks.lastReceivedAt)}。
          失敗的每 15 分鐘會自動補跑一次，這顆按鈕是催它立刻跑。
        </p>

        {retry.error ? <p className="form-error" role="alert">{retry.error.message}</p> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>收到時間</th>
                <th>事件</th>
                <th>狀態</th>
                <th>會員 ID</th>
                <th>錯誤</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((event) => (
                <tr key={event.id}>
                  <td className="cell-sub nowrap">{formatTime(event.receivedAt)}</td>
                  <td className="nowrap">{event.topic}</td>
                  <td>
                    <span className={`status status-webhook-${event.status}`}>
                      {STATUS_LABEL[event.status] ?? event.status}
                    </span>
                  </td>
                  <td className="cell-sub">{event.cyberbizCustomerId ?? "—"}</td>
                  <td className="cell-sub">{event.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.recent.length === 0 ? (
          <p className="muted table-note">
            還沒有收到任何 webhook。CYBERBIZ 後台的 webhook 網址設好之後，會員異動就會出現在這裡。
          </p>
        ) : null}
      </section>
    </div>
  );
}
