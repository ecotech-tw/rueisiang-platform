import { useMemo, useState } from "react";
import { Pager } from "../../../shell/Pager.js";
import { SortableHeader } from "../../../shell/SortableHeader.js";
import { usePageTitle } from "../../../shell/usePageTitle.js";
import { Alert, FilterSelect, Panel, SearchFilterInput } from "../../../ui/index.js";
import { useReportRuns, type ReportRunKind, type ReportRunListRow } from "../api.js";
import { useReportTabs } from "./ReportsLayout.js";

const KIND_LABELS: Record<ReportRunKind, string> = {
  "cyberbiz-payout": "出金表",
  "cyberbiz-sales": "商品銷售",
  "cyberbiz-shop": "官網對帳單",
  shopee: "蝦皮",
};

const PAGE_SIZES = [10, 25, 50] as const;
type SortField = "createdAt" | "kind" | "startDate";

function formatTime(value: string): string {
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

/** 官網是半月一期，用月份表示比起訖日好讀；其他報表照原本的起訖日顯示。 */
function formatRange(row: Pick<ReportRunListRow, "kind" | "startDate" | "endDate">): string {
  if (row.kind !== "cyberbiz-shop") return `${row.startDate} ~ ${row.endDate}`;
  const start = row.startDate.slice(0, 7);
  const end = row.endDate.slice(0, 7);
  return start === end ? start : `${start} ~ ${end}`;
}

/**
 * 四種報表的共用執行紀錄。
 *
 * 以前每個執行頁各自有一個「最近執行」面板，條件各不相同，還要靠 request_id 前綴
 * 互相排擠才不會把別種報表的紀錄撈進來。它們本來就寫在同一張 report_runs。
 *
 * 篩選、排序與分頁都在前端做：API 一次最多回 50 筆，本來就在一頁的量級，為了這個
 * 再往 D1 多跑幾趟不划算。之後真的長到要翻很多頁時再往後端搬。
 */
export function RunLog() {
  usePageTitle("報表執行紀錄");
  const [kind, setKind] = useState<ReportRunKind | "">("");
  const [search, setSearch] = useState("");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // 種類篩選只列有權限的那幾種：API 也只會回那幾種，下拉出現選不到東西的選項
  // 只會讓人以為「沒跑過」。
  const { runTabs } = useReportTabs();
  const query = useReportRuns();
  const runs = useMemo(() => query.data?.runs ?? [], [query.data]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const rows = runs.filter((run) => {
      if (kind && run.kind !== kind) return false;
      if (!keyword) return true;
      return [KIND_LABELS[run.kind], ...run.scopeNames, run.actorEmail, formatRange(run)]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      if (sortField === "kind") return KIND_LABELS[left.kind].localeCompare(KIND_LABELS[right.kind], "zh-Hant") * direction;
      if (sortField === "startDate") return left.startDate.localeCompare(right.startDate) * direction;
      return left.createdAt.localeCompare(right.createdAt) * direction;
    });
  }, [kind, runs, search, sortDirection, sortField]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, totalPages);
  const rows = filtered.slice((current - 1) * pageSize, current * pageSize);

  function sort(field: string, direction: "asc" | "desc") {
    const next = field as SortField;
    if (next === sortField) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(next);
    setSortDirection(direction);
    setPage(1);
  }

  return (
    <div className="page fills">
      <Panel className="grows">
      <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
        <SearchFilterInput
          label="搜尋"
          placeholder="搜尋報表、通路、區間或執行的人"
          value={search}
          onSearch={(value) => { setSearch(value); setPage(1); }}
        />
        <FilterSelect
          label="報表種類"
          value={kind}
          onChange={(event) => { setKind(event.target.value as ReportRunKind | ""); setPage(1); }}
          options={[
            { value: "", label: "全部種類" },
            ...runTabs.map((tab) => ({ value: tab.kind, label: KIND_LABELS[tab.kind] })),
          ]}
        />
      </form>

      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <SortableHeader label="時間" field="createdAt" active={sortField} direction={sortDirection} onSort={sort} />
              <SortableHeader label="報表" field="kind" active={sortField} direction={sortDirection} onSort={sort} />
              <th>通路</th>
              <SortableHeader label="區間" field="startDate" active={sortField} direction={sortDirection} onSort={sort} />
              <th>執行的人</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((run) => {
              return (
                <tr key={run.id}>
                  <td data-label="時間" className="whitespace-nowrap">{formatTime(run.createdAt)}</td>
                  <td data-label="報表" className="cell-strong">{KIND_LABELS[run.kind]}</td>
                  <td data-label="通路">{run.scopeNames.length > 1 ? `${run.scopeNames.length} 個通路` : run.scopeNames[0] ?? "—"}</td>
                  <td data-label="區間" className="whitespace-nowrap">{formatRange(run)}</td>
                  <td data-label="執行的人">{run.actorEmail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {query.isPending ? <p className="muted table-note">載入中…</p> : null}
      {!query.isPending && !filtered.length ? <p className="muted table-note">沒有符合的執行紀錄。</p> : null}

      <Pager
        page={current}
        pageSize={pageSize}
        pageSizes={[...PAGE_SIZES]}
        totalPages={totalPages}
        totalLabel={`共 ${filtered.length} 筆`}
        onPage={setPage}
        onPageSize={(size) => { setPageSize(size); setPage(1); }}
      />
      </Panel>
    </div>
  );
}
