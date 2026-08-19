import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";

interface EventRow {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  eventType: string;
  summary: string;
  actorType: string;
  actorEmail: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
}

interface EventList {
  events: EventRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface Filters {
  search: string;
  source: string;
  page: number;
  pageSize: number;
}

const DEFAULTS: Filters = { search: "", source: "all", page: 1, pageSize: 25 };

const SOURCE_LABEL: Record<string, string> = {
  crm: "本系統",
  cyberbiz_webhook: "CYBERBIZ 事件",
  cyberbiz_sync: "CYBERBIZ 同步",
};

function formatTime(value: string): string {
  if (!value) return "—";
  // 這一欄有兩種格式：D1 的 CURRENT_TIMESTAMP 沒有時區，同步寫進來的是帶 Z 的 ISO。
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function Activity() {
  usePageTitle("操作紀錄");
  const [filters, setFilters] = useState<Filters>(DEFAULTS);

  const query = useQuery({
    queryKey: ["crm", "events", filters],
    queryFn: async () => {
      const params = new URLSearchParams({
        search: filters.search,
        source: filters.source,
        page: String(filters.page),
        pageSize: String(filters.pageSize),
      });
      const response = await fetch(`/api/crm/events?${params}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `讀取失敗（${response.status}）`);
      }
      return (await response.json()) as EventList;
    },
    placeholderData: keepPreviousData,
  });

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const data = query.data;

  return (
    <div className="page fills">
      <header className="page-head">
        <h1>操作紀錄</h1>
        <p className="muted">
          誰在什麼時候動了哪個客戶。CYBERBIZ 送來的異動也會記在這裡；
          全量同步不寫紀錄，否則一次匯入上萬筆會把這一頁灌成雜訊。
        </p>
      </header>

      <section className="panel grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <input
            aria-label="搜尋"
            type="search"
            placeholder="搜尋客戶、摘要或操作者"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <select
            aria-label="來源"
            value={filters.source}
            onChange={(event) => update({ source: event.target.value })}
          >
            <option value="all">全部來源</option>
            <option value="crm">本系統</option>
            <option value="cyberbiz_webhook">CYBERBIZ 事件</option>
            <option value="cyberbiz_sync">CYBERBIZ 同步</option>
          </select>
          <select
            aria-label="每頁筆數"
            value={String(filters.pageSize)}
            onChange={(event) => update({ pageSize: Number(event.target.value) })}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>每頁 {size} 筆</option>
            ))}
          </select>
        </form>

        {query.error ? <p className="form-error" role="alert">{query.error.message}</p> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>客戶</th>
                <th>發生什麼事</th>
                <th>操作者</th>
                <th>來源</th>
              </tr>
            </thead>
            <tbody>
              {data?.events.map((event) => (
                <tr key={event.id}>
                  <td className="cell-sub whitespace-nowrap">{formatTime(event.createdAt)}</td>
                  <td>
                    <div className="cell-strong">{event.customerName || "未填姓名"}</div>
                    <div className="cell-sub">{event.customerPhone || "未填電話"}</div>
                  </td>
                  <td>
                    <div>{event.summary}</div>
                    <div className="cell-sub">{event.eventType}</div>
                    {event.error ? <div className="cell-error">{event.error}</div> : null}
                  </td>
                  <td className="cell-sub">
                    {event.actorType === "system" ? "系統" : (event.actorEmail ?? "—")}
                  </td>
                  <td>
                    <span className={`status status-source-${event.source}`}>
                      {SOURCE_LABEL[event.source] ?? event.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}

        {data && data.events.length === 0 ? (
          <p className="muted table-note">
            {filters.search || filters.source !== "all"
              ? "沒有符合條件的紀錄。"
              : "還沒有任何紀錄。有人編輯客戶、或 CYBERBIZ 送來異動之後就會出現。"}
          </p>
        ) : null}

        {data && (data.hasMore || data.page > 1) ? (
          <footer className="pager">
            <span className="cell-sub">第 {data.page} 頁</span>
            <div className="pager-buttons">
              <button
                type="button"
                className="ghost-button"
                disabled={data.page <= 1}
                onClick={() => update({ page: data.page - 1 })}
              >
                上一頁
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={!data.hasMore}
                onClick={() => update({ page: data.page + 1 })}
              >
                下一頁
              </button>
            </div>
          </footer>
        ) : null}
      </section>
    </div>
  );
}
