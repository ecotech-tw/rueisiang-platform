import { parseDbDate } from "@rueisiang/db/db-timestamp";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, CellError, DataTable, FilterInput, FilterSelect, FilterToolbar, Page, PageHeader, Panel, SEARCH_INPUT_WIDTH, StatusBadge, type StatusTone, TableNote } from "../../ui/index.js";
import { OrderRestockDetails } from "./OrderRestockDetails.js";

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
  orderRestockId: string | null;
}

interface ActivityList {
  events: ActivityRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

const ENTITY_LABEL: Record<string, string> = {
  cyberbiz_order_restock: "官網訂單回補",
  wms_zone: "倉位",
  item: "商品",
  product_category: "舊版分類",
  wms_category: "倉儲分類",
  item_category: "商品分類",
  product_sku_mapping: "外部 SKU 對應",
  cyberbiz_product_category: "CYBERBIZ 商品分類",
  layout_element: "地圖標示",
  warehouse: "倉庫設定",
};

const SOURCE_TONE: Record<string, StatusTone> = {
  cyberbiz_webhook: "info",
  cyberbiz_sync: "success",
};

const SOURCE_LABEL: Record<string, string> = {
  wms: "本系統",
  cyberbiz_webhook: "CYBERBIZ 事件",
  cyberbiz_sync: "CYBERBIZ 同步",
};

/** 欄位名是給程式看的，畫面上要講人話。 */
const FIELD_LABEL: Record<string, string> = {
  quantity: "數量",
  cyberbiz_variant_id: "CYBERBIZ 款式",
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
  const parsed = parseDbDate(value);
  return parsed ? parsed.toLocaleString("zh-TW", { hour12: false }) : value;
}

/** 欄位級的變更。兩邊都不是可讀的值（例如整包 JSON 快照）就整格留白。 */
function renderChange(event: ActivityRow) {
  const before = readable(event.oldValue);
  const after = readable(event.newValue);
  if (before === null && after === null) return null;

  return (
    <div className="grid gap-0.5">
      {event.field ? <small className="text-[11px] text-muted">{FIELD_LABEL[event.field] ?? event.field}</small> : null}
      <span className="flex items-center gap-1.5 text-[13px]">
        <b className="font-bold tabular-nums">{before ?? "—"}</b>
        <i className="text-muted not-italic" aria-hidden="true">→</i>
        <b className="font-bold tabular-nums">{after ?? "—"}</b>
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
    // 稽核頁不能沿用全站 30 秒 stale window；webhook／cron 在另一個 Worker
    // instance 寫入時，前端不會收到 mutation invalidation。
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    // 換頁時先留著上一批，畫面不會整個閃成空白再長回來。
    placeholderData: keepPreviousData,
  });

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const data = query.data;

  return (
    <Page layout="fills">
      <PageHeader
        title="操作紀錄"
        description={
          <>
          查閱倉儲異動與官網訂單回補，可搜尋訂單編號或 SKU。
          回補明細包含模式、調整前後庫存、WMS 目標、處理次數及待確認原因。
          </>
        }
      />

      <Panel grows>
        <FilterToolbar>
          <FilterInput
            label="搜尋"
            className={SEARCH_INPUT_WIDTH}
            type="search"
            placeholder="搜尋訂單、SKU、商品或操作者"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <FilterSelect
            label="資料類型"
            value={filters.entityType}
            onChange={(event) => update({ entityType: event.target.value })}
            options={[
              { value: "all", label: "全部類型" },
              ...Object.entries(ENTITY_LABEL).map(([value, label]) => ({ value, label })),
            ]}
          />
          <FilterSelect
            label="每頁筆數"
            value={String(filters.pageSize)}
            onChange={(event) => update({ pageSize: Number(event.target.value) })}
            options={[25, 50, 100].map((size) => ({ value: String(size), label: `每頁 ${size} 筆` }))}
          />
          <Button variant="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>
            {query.isFetching ? "更新中…" : "重新整理"}
          </Button>
        </FilterToolbar>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}

        {/*
          * 欄寬：不指定的話瀏覽器會把寬度分給內容最長的摘要欄，「B-01 包材區」就被壓成
          * 一欄三行、逐字折行。時間與對象是固定長度的東西，給它們一個下限。
          * 第一格在手機卡片上是滿版標題（DataTable 的 w-full），所以它的寬度只在卡片斷點以上給。
          */}
        <DataTable className="[&_th:nth-child(1)]:w-[150px] min-[760px]:[&_td:nth-child(1)]:w-[150px] [&_th:nth-child(2)]:w-[180px] [&_td:nth-child(2)]:w-[180px] [&_th:nth-child(5)]:w-[190px] [&_td:nth-child(5)]:w-[190px]">
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
                  <td data-label="時間" className="text-muted whitespace-nowrap">{formatTime(event.createdAt)}</td>
                  <td data-label="對象">
                    <div className="font-bold">{event.entityLabel || "（已刪除）"}</div>
                    <div className="text-[12px] text-muted">{ENTITY_LABEL[event.entityType] ?? event.entityType}</div>
                  </td>
                  <td data-label="發生什麼事">
                    <div>{event.summary}</div>
                    <div className="text-[12px] text-muted">{event.eventType}</div>
                    {event.error ? <CellError>{event.error}</CellError> : null}
                    {event.orderRestockId ? <OrderRestockDetails id={event.orderRestockId} /> : null}
                  </td>
                  {/*
                    * 欄位級的變更。倉儲的紀錄大多是這種——「數量 48 → 50」比
                    * 「修改了商品」有用得多。沒有 oldValue 的（新增、刪除）就留白，
                    * 硬要塞一個「—」只是製造噪音。
                    */}
                  <td data-label="變更">{renderChange(event)}</td>
                  <td data-label="操作者" className="text-muted">
                    <div>{event.actorType === "system" ? "系統" : (event.actorEmail ?? "—")}</div>
                    {event.source !== "wms" ? (
                      <StatusBadge tone={SOURCE_TONE[event.source]}>
                        {SOURCE_LABEL[event.source] ?? event.source}
                      </StatusBadge>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

        {query.isPending ? <TableNote>載入中…</TableNote> : null}

        {data && data.events.length === 0 ? (
          <TableNote>
            {filters.search || filters.entityType !== "all"
              ? "沒有符合條件的紀錄。"
              : "還沒有任何紀錄。有人動到倉位、商品或分類之後就會出現。"}
          </TableNote>
        ) : null}

        {data && (data.hasMore || data.page > 1) ? (
          <footer className="mt-4 flex shrink-0 items-center justify-between gap-3 border-t border-t-soft-line pt-3.5 max-[760px]:flex-col max-[760px]:items-stretch max-[760px]:gap-2.5">
            <span className="text-[12px] text-muted">第 {data.page} 頁</span>
            <div className="flex gap-2">
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
    </Page>
  );
}
