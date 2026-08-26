import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";

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
    payloadJson: string;
  }[];
}

interface SyncRun {
  received: number;
  written: number;
  skipped: number;
  fromPage: number;
  toPage: number;
  nextPage: number;
  totalPages: number;
  hasMore: boolean;
  /** 某一頁失敗時停在那裡，前面的成果仍然算數。 */
  error?: string;
}

interface SyncProgress {
  page: number;
  totalPages: number;
  received: number;
  written: number;
  skipped: number;
  done: boolean;
  stopped: boolean;
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
  usePageTitle("CYBERBIZ 同步");
  const client = useQueryClient();
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const stopRequested = useRef(false);

  const status = useQuery({
    queryKey: ["crm", "sync", "status"],
    queryFn: () => call<SyncStatus>("/api/crm/sync/status"),
    // webhook 是隨時會進來的，這一頁開著就讓它自己更新。
    refetchInterval: 30_000,
  });

  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["crm"] });
  };

  /**
   * 一路拉到完。
   *
   * 官網目前有兩百多頁會員，一輪只能拉 10 頁（Worker 有執行時間上限），
   * 讓人按二十幾次不合理。所以由前端連續呼叫，每一輪都是一個獨立、
   * 有界的請求——中間斷掉也只是停在某一頁，重按會從那裡接下去。
   */
  async function runFullSync(startPage: number) {
    setRunning(true);
    setError("");
    stopRequested.current = false;

    const totals = { received: 0, written: 0, skipped: 0 };
    let page = startPage;

    try {
      for (;;) {
        const result = await call<SyncRun>(`/api/crm/sync?page=${page}`, { method: "POST" });
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];

        const stopped = stopRequested.current;
        setProgress({
          ...totals,
          page: result.toPage,
          totalPages: result.totalPages,
          done: !result.hasMore,
          stopped: stopped && result.hasMore,
        });

        if (result.error) {
          // 停在失敗的那一頁，但保留進度：按「從第 N 頁接著跑」就能重來。
          setError(`第 ${result.nextPage} 頁失敗：${result.error}`);
          break;
        }
        if (!result.hasMore || stopped) break;
        page = result.nextPage;
      }
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "同步失敗");
      refresh();
    } finally {
      setRunning(false);
    }
  }

  const cleanup = useMutation({
    mutationFn: () => call<{ deleted: number }>("/api/crm/sync/cleanup-empty", { method: "POST" }),
    onSuccess: refresh,
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
        <PageHeader title="CYBERBIZ 同步" />
        <Alert tone="danger">{status.error.message}</Alert>
      </div>
    );
  }

  const data = status.data!;

  return (
    <div className="page fills">
      <PageHeader title="CYBERBIZ 同步" description="官網的會員異動會透過 webhook 即時進來；這一頁可以看狀態，也可以手動補拉。" />

      {!data.configured ? (
        <Alert tone="danger">尚未設定 CYBERBIZ_API_TOKEN，手動同步無法執行。請在 Cloudflare 的 Worker 設定裡加入。</Alert>
      ) : null}
      {!data.webhookConfigured ? (
        <Alert tone="danger">尚未設定 CYBERBIZ_WEBHOOK_SECRET，webhook 會一律被擋下。</Alert>
      ) : null}

      <div className="stat-row">
        <div className="stat"><span>客戶總數</span><strong>{data.customers.total}</strong></div>
        <div className="stat"><span>已與官網同步</span><strong>{data.customers.synced}</strong></div>
        <div className="stat"><span>僅存在本地</span><strong>{data.customers.localOnly}</strong></div>
        <div className="stat"><span>同步失敗</span><strong>{data.customers.failed}</strong></div>
      </div>

      <Panel
        title="手動同步"
        actions={<div className="pager-buttons">
            {running ? (
              <Button variant="secondary" onClick={() => { stopRequested.current = true; }}>
                跑完這一輪就停
              </Button>
            ) : null}
            <Button
              icon="sync"
              disabled={!data.configured || running}
              onClick={() => runFullSync(1)}
              title="從第 1 頁開始，一路拉到官網的最後一頁"
            >
              {running ? "同步中…" : "全部重新同步"}
            </Button>
            {!running && progress && !progress.done ? (
              <Button
                variant="secondary"
                onClick={() => runFullSync(progress.page + 1)}
              >
                從第 {progress.page + 1} 頁接著跑
              </Button>
            ) : null}
          </div>}
      >

        <p className="muted">
          會一路拉到最後一頁為止。每一輪送一個獨立的請求（10 頁、500 筆），
          中途斷掉也只是停在某一頁，重按會從那裡接下去。
          最後一次同步：{formatTime(data.lastSyncedAt)}
        </p>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        {progress ? (
          <>
            <div className="progress-bar" role="progressbar" aria-valuenow={progress.page} aria-valuemin={0} aria-valuemax={progress.totalPages}>
              <span style={{ width: `${Math.min(100, (progress.page / Math.max(1, progress.totalPages)) * 100)}%` }} />
            </div>
            <p className="muted form-foot">
              第 {progress.page}／{progress.totalPages} 頁：收到 {progress.received} 筆，
              寫入 {progress.written}
              {progress.skipped ? `、略過 ${progress.skipped}（沒有會員 ID）` : ""}。
              {progress.done ? "已經拉完。" : progress.stopped ? "已停在這裡。" : ""}
            </p>
          </>
        ) : null}
      </Panel>

      <Panel
        className="grows"
        title="Webhook"
        actions={<div className="pager-buttons">
            <Button
              variant="secondary"
              icon="trash"
              loading={cleanup.isPending}
              loadingLabel="清理中…"
              onClick={() => cleanup.mutate()}
              title="刪掉只有 CYBERBIZ ID、姓名電話地址全空的客戶，以及被誤寫成客戶的商品"
            >
              {cleanup.data ? `已清掉 ${cleanup.data.deleted} 筆空白客戶` : "清理空白客戶"}
            </Button>
            <Button
              variant="secondary"
              loading={retry.isPending}
              loadingLabel="補跑中…"
              disabled={data.webhooks.failed === 0}
              onClick={() => retry.mutate()}
            >
              補跑失敗的（{data.webhooks.failed}）
            </Button>
          </div>}
      >

        <p className="muted">
          已處理 {data.webhooks.processed}、略過 {data.webhooks.ignored}、
          失敗 {data.webhooks.failed}。最後收到：{formatTime(data.webhooks.lastReceivedAt)}。
          失敗的每 15 分鐘會自動補跑一次，這顆按鈕是催它立刻跑。
        </p>

        {retry.error ? <Alert tone="danger">{retry.error.message}</Alert> : null}
        {cleanup.error ? <Alert tone="danger">{cleanup.error.message}</Alert> : null}

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
                  <td className="cell-sub whitespace-nowrap">{formatTime(event.receivedAt)}</td>
                  <td className="whitespace-nowrap">{event.topic}</td>
                  <td>
                    <span className={`status status-webhook-${event.status}`}>
                      {STATUS_LABEL[event.status] ?? event.status}
                    </span>
                  </td>
                  <td className="cell-sub">{event.cyberbizCustomerId ?? "—"}</td>
                  <td className="cell-sub">
                    {event.lastError ?? "—"}
                    {/* 原始內容：查「這個 ID 到底是什麼」時，沒有它就只能猜。 */}
                    <details className="payload-peek">
                      <summary>原始內容</summary>
                      <pre>{event.payloadJson}</pre>
                    </details>
                  </td>
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
      </Panel>
    </div>
  );
}
