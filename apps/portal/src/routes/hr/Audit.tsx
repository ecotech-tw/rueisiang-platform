import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, FilterInput, PageHeader, Panel } from "../../ui/index.js";
import { useHrQuery } from "./api.js";

interface HrAuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  summary: string;
  actorType: string;
  actorEmail: string | null;
  status: string;
  error: string | null;
  createdAt: string;
}
interface HrAuditResult { events: HrAuditEvent[]; page: number; pageSize: number; hasMore: boolean }

function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function HrAudit() {
  usePageTitle("HR 稽核紀錄");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:audit:read");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = useHrQuery<HrAuditResult>(`/audit?search=${encodeURIComponent(search)}&page=${page}&pageSize=25`, canRead);

  if (!canRead) return <Alert tone="danger">你沒有檢視 HR 稽核紀錄的權限。</Alert>;
  const data = query.data;
  return <div className="page fills">
    <PageHeader title="HR 稽核紀錄" description="只顯示人事操作的摘要與操作者，不回傳敏感欄位明細或原始 payload。" />
    <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => { event.preventDefault(); setPage(1); }}>
        <FilterInput label="搜尋" type="search" placeholder="搜尋摘要、事件或操作者" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
      </form>
      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
      <div className="table-scroll"><table className="data-table"><thead><tr><th>時間</th><th>操作</th><th>資料識別</th><th>操作者</th><th>結果</th></tr></thead><tbody>
        {(data?.events ?? []).map((event) => <tr key={event.id}>
          <td className="cell-sub whitespace-nowrap">{formatTime(event.createdAt)}</td>
          <td><div className="cell-strong">{event.summary}</div><div className="cell-sub">{event.eventType}</div></td>
          <td className="cell-sub">{event.entityType} · {event.entityId}</td>
          <td className="cell-sub">{event.actorType === "system" ? "系統" : event.actorEmail ?? "—"}</td>
          <td>{event.status === "succeeded" ? "成功" : <><span className="cell-error">失敗</span>{event.error ? <div className="cell-error">{event.error}</div> : null}</>}</td>
        </tr>)}
      </tbody></table></div>
      {query.isPending ? <p className="muted table-note">載入中…</p> : null}
      {data && !data.events.length ? <p className="muted table-note">{search ? "沒有符合條件的紀錄。" : "還沒有 HR 稽核紀錄。"}</p> : null}
      {data && (data.hasMore || data.page > 1) ? <footer className="pager"><span className="cell-sub">第 {data.page} 頁</span><div className="pager-buttons"><Button variant="secondary" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>上一頁</Button><Button variant="secondary" disabled={!data.hasMore} onClick={() => setPage(data.page + 1)}>下一頁</Button></div></footer> : null}
    </Panel>
  </div>;
}
