import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";

/**
 * 倉儲的操作紀錄。
 *
 * 跟 CRM 那一頁看的是同一張 activity_events，差別在篩的東西不同：這裡是倉位、
 * 商品、分類、地圖標示、倉庫設定這五種。**篩的是「哪幾種東西」而不是「哪個模組
 * 寫的」**——CYBERBIZ 同步改到庫存時 source 是 cyberbiz_sync，但那當然也該出現
 * 在倉儲的紀錄裡。
 *
 * 倉儲的紀錄跟 CRM 的形狀也不同：它常常是欄位級的（「數量 48 → 50」），所以
 * 這一頁要把 field/oldValue/newValue 畫出來，CRM 那一頁沒有這一欄。
 */

interface ActivityRow {
  id: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  eventType: string;
  summary: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actorType: string;
  actorEmail: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
}

interface ActivityList {
  events: ActivityRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const ENTITY_LABEL: Record<string, string> = {
  zone: "倉位",
  inventory_item: "商品",
  product_category: "商品分類",
  layout_element: "地圖標示",
  warehouse: "倉庫設定",
};

const SOURCE_LABEL: Record<string, string> = {
  wms: "本系統",
  cyberbiz_webhook: "CYBERBIZ 事件",
  cyberbiz_sync: "CYBERBIZ 同步",
};

/** 欄位名是給程式看的，畫面上要講人話。 */
const FIELD_LABEL: Record<string, string> = {
  quantity: "數量",
  position: "位置",
  size: "大小",
  placement: "存放位置",
  details: "資料",
  canvas: "畫布",
  image: "照片",
  name: "名稱",
  color: "顏色",
};

interface Filters {
  search: string;
  entityType: string;
  page: number;
  pageSize: number;
}

const DEFAULTS: Filters = { search: "", entityType: "all", page: 1, pageSize: 25 };

/**
 * 這個值適合直接印在表格裡嗎？
 *
 * 新增與刪除存的是整個物件的快照（JSON.stringify(zone)），那對稽核有用，但直接
 * 印出來就是一整行 {"id":"d881e3d5-…","color":"mint",…} 把版面撐爆，而且沒有人
 * 讀得下去。欄位級的變更才適合顯示——「48 → 50」正是這一欄存在的理由。
 *
 * 完整內容沒有消失，仍然在資料庫裡；要查的時候查得到。
 */
function readable(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  // 再長就不是一個「值」了，是一段文字。
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

function formatTime(value: string): string {
  if (!value) return "—";
  // D1 的 CURRENT_TIMESTAMP 沒有時區；同步寫進來的是帶 Z 的 ISO。
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

/** 欄位級的變更。兩邊都不是可讀的值（例如整包 JSON 快照）就整格留白。 */
function renderChange(event: ActivityRow) {
  const before = readable(event.oldValue);
  const after = readable(event.newValue);
  if (before === null && after === null) return null;

  return (
    <div className="change">
      {event.field ? <small>{FIELD_LABEL[event.field] ?? event.field}</small> : null}
      <span className="change-values">
        <b>{before ?? "—"}</b>
        <i aria-hidden="true">→</i>
        <b>{after ?? "—"}</b>
      </span>
    </div>
  );
}

export function Activity() {
  usePageTitle("倉儲操作紀錄");
  const [filters, setFilters] = useState<Filters>(DEFAULTS);

  const query = useQuery({
    queryKey: ["wms", "activity", filters],
    queryFn: async () => {
      const params = new URLSearchParams({
        search: filters.search,
        entityType: filters.entityType,
        page: String(filters.page),
        pageSize: String(filters.pageSize),
      });
      const response = await fetch(`/api/wms/activity?${params}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `讀取失敗（${response.status}）`);
      }
      return (await response.json()) as ActivityList;
    },
    // 換頁時先留著上一批，畫面不會整個閃成空白再長回來。
    placeholderData: keepPreviousData,
  });

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const data = query.data;

  return (
    <div className="page fills">
      <PageHeader
        title="操作紀錄"
        description={
          <>
          誰在什麼時候動了倉位、商品或分類。盤點即使數量沒變也會留一筆——
          「今天數過、結果沒變」跟「今天沒數」是兩件事。
          </>
        }
      />

      <Panel className="grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <input
            className="search-input"
            aria-label="搜尋"
            type="search"
            placeholder="搜尋倉位、商品、摘要或操作者"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <select
            aria-label="資料類型"
            value={filters.entityType}
            onChange={(event) => update({ entityType: event.target.value })}
          >
            <option value="all">全部類型</option>
            {Object.entries(ENTITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
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

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table activity-table">
            <thead>
              <tr>
                <th>時間</th>
                <th>對象</th>
                <th>發生什麼事</th>
                <th>變更</th>
                <th>操作者</th>
              </tr>
            </thead>
            <tbody>
              {data?.events.map((event) => (
                <tr key={event.id}>
                  <td data-label="時間" className="cell-sub whitespace-nowrap">{formatTime(event.createdAt)}</td>
                  <td data-label="對象">
                    <div className="cell-strong">{event.entityLabel || "（已刪除）"}</div>
                    <div className="cell-sub">{ENTITY_LABEL[event.entityType] ?? event.entityType}</div>
                  </td>
                  <td data-label="發生什麼事">
                    <div>{event.summary}</div>
                    <div className="cell-sub">{event.eventType}</div>
                    {event.error ? <div className="cell-error">{event.error}</div> : null}
                  </td>
                  {/*
                    * 欄位級的變更。倉儲的紀錄大多是這種——「數量 48 → 50」比
                    * 「修改了商品」有用得多。沒有 oldValue 的（新增、刪除）就留白，
                    * 硬要塞一個「—」只是製造噪音。
                    */}
                  <td data-label="變更">{renderChange(event)}</td>
                  <td data-label="操作者" className="cell-sub">
                    <div>{event.actorType === "system" ? "系統" : (event.actorEmail ?? "—")}</div>
                    {event.source !== "wms" ? (
                      <span className={`status status-source-${event.source}`}>
                        {SOURCE_LABEL[event.source] ?? event.source}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}

        {data && data.events.length === 0 ? (
          <p className="muted table-note">
            {filters.search || filters.entityType !== "all"
              ? "沒有符合條件的紀錄。"
              : "還沒有任何紀錄。有人動到倉位、商品或分類之後就會出現。"}
          </p>
        ) : null}

        {data && (data.hasMore || data.page > 1) ? (
          <footer className="pager">
            <span className="cell-sub">第 {data.page} 頁</span>
            <div className="pager-buttons">
              <Button
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => update({ page: data.page - 1 })}
              >
                上一頁
              </Button>
              <Button
                variant="secondary"
                disabled={!data.hasMore}
                onClick={() => update({ page: data.page + 1 })}
              >
                下一頁
              </Button>
            </div>
          </footer>
        ) : null}
      </Panel>
    </div>
  );
}
