import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../../auth/session.js";

interface TagRow {
  name: string;
  inCatalog: boolean;
  customerCount: number;
  linkedCount: number;
}

interface TagChangeResult {
  processed: number;
  linked: number;
  hasMore: boolean;
  failures: { customerId: string; error: string }[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
}

export function Tags() {
  const client = useQueryClient();
  const { permissions } = useSession();
  const canWrite = permissions.has("crm:tag:write");

  const [newTag, setNewTag] = useState("");
  const [editing, setEditing] = useState<{ name: string; next: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const tags = useQuery({
    queryKey: ["crm", "tags"],
    queryFn: () => call<{ tags: TagRow[] }>("/api/crm/tags"),
  });

  const refresh = () => client.invalidateQueries({ queryKey: ["crm"] });

  const create = useMutation({
    mutationFn: (name: string) => call("/api/crm/tags", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setNewTag("");
      void refresh();
    },
  });

  /**
   * 改名與刪除都要動到客戶身上的標籤，每位有連到官網的都要打一次 API，
   * 所以後端一輪只處理一批。這裡一直呼叫到 hasMore 是 false 為止，
   * 中間顯示處理到幾筆。
   */
  async function applyChange(name: string, nextName: string | null) {
    const label = nextName ? `改名為「${nextName}」` : "移除";
    setBusy(`${label}中…`);
    setError("");

    let processed = 0;
    let linked = 0;
    const failures: TagChangeResult["failures"] = [];

    try {
      for (let round = 0; ; round += 1) {
        const result = await call<TagChangeResult>(
          `/api/crm/tags/${encodeURIComponent(name)}${round > 0 ? "?continue=1" : ""}`,
          { method: "PATCH", body: JSON.stringify({ name: nextName }) },
        );
        processed += result.processed;
        linked += result.linked;
        failures.push(...result.failures);
        setBusy(`${label}中…已處理 ${processed} 位客戶`);

        // 全部失敗又還有下一批的話會無限跑下去，停在這裡讓人看錯誤。
        if (!result.hasMore || (result.processed === 0 && result.failures.length === 0)) break;
      }

      setBusy("");
      setEditing(null);
      if (failures.length) {
        setError(`${failures.length} 位客戶沒有更新成功：${failures[0]?.error ?? ""}`);
      }
      void refresh();
    } catch (caught) {
      setBusy("");
      setError(caught instanceof Error ? caught.message : "操作失敗");
      void refresh();
    }
  }

  if (tags.isPending) return <div className="boot">載入中…</div>;

  const rows = tags.data?.tags ?? [];

  return (
    <div className="page fills">
      <header className="page-head">
        <h1>標籤管理</h1>
        <p className="muted">
          標籤有兩個來源：這裡建立的，以及從 CYBERBIZ 同步進來、掛在客戶身上的。
          改名或移除會一併更新客戶，並推回官網。
        </p>
      </header>

      <section className="panel grows">
        {canWrite ? (
          <form
            className="admin-form toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(newTag);
            }}
          >
            <input
              aria-label="新標籤名稱"
              placeholder="新增一個標籤"
              maxLength={40}
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
            />
            <button type="submit" className="primary-button" disabled={!newTag.trim() || create.isPending}>
              {create.isPending ? "新增中…" : "新增標籤"}
            </button>
            {busy ? <span className="form-hint">{busy}</span> : null}
          </form>
        ) : null}

        {create.error ? <p className="form-error" role="alert">{create.error.message}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>標籤</th>
                <th className="numeric">使用中的客戶</th>
                <th className="numeric">其中已連到官網</th>
                <th>來源</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((tag) => (
                <tr key={tag.name}>
                  <td>
                    {editing?.name === tag.name ? (
                      <form
                        className="admin-form inline"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (editing.next.trim()) void applyChange(tag.name, editing.next.trim());
                        }}
                      >
                        <input
                          aria-label="新的標籤名稱"
                          autoFocus
                          maxLength={40}
                          value={editing.next}
                          onChange={(event) => setEditing({ name: tag.name, next: event.target.value })}
                        />
                        <button type="submit" className="primary-button" disabled={Boolean(busy)}>
                          儲存
                        </button>
                        <button type="button" className="link-button" onClick={() => setEditing(null)}>
                          取消
                        </button>
                      </form>
                    ) : (
                      <span className="chip">{tag.name}</span>
                    )}
                  </td>
                  <td className="numeric">{tag.customerCount}</td>
                  <td className="numeric">{tag.linkedCount}</td>
                  <td>
                    <span className={`status ${tag.inCatalog ? "status-source-crm" : "status-source-cyberbiz_sync"}`}>
                      {tag.inCatalog ? "本系統建立" : "來自 CYBERBIZ"}
                    </span>
                  </td>
                  {canWrite ? (
                    <td>
                      <div className="pager-buttons">
                        <button
                          type="button"
                          className="ghost-button"
                          disabled={Boolean(busy)}
                          onClick={() => setEditing({ name: tag.name, next: tag.name })}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          className="ghost-button danger"
                          disabled={Boolean(busy)}
                          onClick={() => void applyChange(tag.name, null)}
                          title={
                            tag.customerCount
                              ? `會從 ${tag.customerCount} 位客戶身上移除這個標籤`
                              : "字典裡沒有人在用，直接移除"
                          }
                        >
                          移除
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {rows.length === 0 ? (
          <p className="muted table-note">
            還沒有任何標籤。可以在這裡先建立，或等 CYBERBIZ 同步把官網的標籤帶進來。
          </p>
        ) : null}
      </section>
    </div>
  );
}
