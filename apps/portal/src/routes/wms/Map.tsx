import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Button } from "../../ui/index.js";
import {
  useDeleteElement,
  useDeleteZone,
  useUpdateElement,
  useUpdateZone,
  useWarehouse,
  type InventoryItem,
  type LayoutElement,
  type Zone,
} from "./api.js";
import { CanvasDialog } from "./CanvasDialog.js";
import { downloadMapImage } from "./exportMap.js";
import { ElementDialog } from "./ElementDialog.js";
import { useDragBox, type Box } from "./useDragBox.js";
import { useMapViewport } from "./useMapViewport.js";
import { ZoneDialog } from "./ZoneDialog.js";
import { ZoneDrawer } from "./ZoneDrawer.js";

/**
 * 倉位地圖。
 *
 * **地圖鋪滿整個內容區，控制項浮在上面。** 先前是「標題列 ＋ 面板 ＋ 面板裡的
 * 地圖」，層層內距之後真正給地圖的高度只剩一半多一點。地圖是這一頁唯一的內容，
 * 其他東西都是為了操作它而存在的——那些該讓位，不該跟它平分畫面。
 *
 * 用絕對定位的 DOM 而不是 canvas（舊系統的互動地圖也是 DOM，它那份 canvas 是
 * 給「下載整張圖」用的，見 exportMap.ts）。方塊只有幾十個，DOM 完全撐得住，
 * 而文字換行、hover、鍵盤焦點、螢幕閱讀器在 canvas 上全都要自己重寫一遍。
 *
 * 畫布是**像素**尺寸加上 transform: scale，不是流動寬度。這樣倉位方塊有固定的
 * 像素大小，「這一格放得下幾個層架」才算得出來——用流動寬度的話那個答案會隨
 * 視窗變，每縮一次視窗層架就重排一次。
 */

function groupItems(items: InventoryItem[]): globalThis.Map<string, InventoryItem[]> {
  const grouped = new globalThis.Map<string, InventoryItem[]>();
  for (const item of items) {
    if (!item.zoneId) continue;
    const list = grouped.get(item.zoneId);
    if (list) list.push(item);
    else grouped.set(item.zoneId, [item]);
  }
  return grouped;
}

/**
 * 檢視模式下「點一下」的容差。
 *
 * 檢視模式不會啟動拖曳，所以 useDragBox 的容差幫不上忙——想用手指平移地圖的人
 * 一放開，剛才按著的那一格就會彈出抽屜。這裡自己記按下去的位置，移動超過幾個
 * 像素就當成平移，不是點擊。
 */
const CLICK_SLOP = 4;

function boxStyle(box: Box): React.CSSProperties {
  return { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` };
}

/**
 * 一個倉位方塊裡列得下幾個商品。
 *
 * 每一列大約 17 像素，扣掉方塊自己的內距與上半部的代碼與名稱。放不下全部時
 * 最後一列改成「還有 +N 項」，所以可見的要再少一列。
 *
 * 單欄不分欄：商品名稱長（「童拾手工麻花捲隨手包-黃金芝麻」），分成兩欄之後
 * 每一欄都只剩兩三個字加省略號，等於什麼都沒說。
 */
function itemSlots(pixelHeight: number) {
  const rows = Math.floor((pixelHeight - 46) / 17);
  // 上限 8：再多字就疊成一團，而且方塊本身也放不下那麼多列。
  return Math.max(0, Math.min(8, rows));
}

export function WarehouseMap() {
  usePageTitle("倉位地圖");
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [zoneForm, setZoneForm] = useState<Zone | "new" | null>(null);
  const [elementForm, setElementForm] = useState<LayoutElement | "new" | null>(null);
  const [canvasForm, setCanvasForm] = useState(false);
  const [deletingZone, setDeletingZone] = useState<Zone | null>(null);
  const [exporting, setExporting] = useState(false);
  /** 檢視模式下按在哪裡，用來分辨「點一下」與「平移」。 */
  const pressAt = useRef<{ x: number; y: number } | null>(null);

  const query = useWarehouse();
  const updateZone = useUpdateZone();
  const deleteZone = useDeleteZone();
  const updateElement = useUpdateElement();
  const deleteElement = useDeleteElement();
  const toast = useToast();
  const view = useMapViewport(query.data?.settings.canvasWidth ?? 0);
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:map:write");
  const canReadItems = permissions.has("wms:inventory:read");

  const settings = query.data?.settings ?? { canvasWidth: 1600, canvasHeight: 900 };
  const zones = query.data?.zones ?? [];
  const elements = query.data?.layoutElements ?? [];
  const items = query.data?.items ?? [];
  const itemsByZone = groupItems(items);

  /*
   * 寫入失敗時要把暫存位置丟掉。不然方塊會停在一個伺服器不同意的地方，
   * 而且看起來像存成功了。
   */
  const zoneDrag = useDragBox((id, box) =>
    updateZone.mutate({ id, ...box }, { onError: () => zoneDrag.reset() }),
  );
  const elementDrag = useDragBox((id, box) =>
    updateElement.mutate({ id, ...box }, { onError: () => elementDrag.reset() }),
  );

  /**
   * 搜尋商品或 SKU，符合的倉位亮起來、其他暗下去。
   *
   * 找的是「東西在哪」而不是「有哪些東西」——所以結果不是一份清單，是把地圖上
   * 該去的那幾格標出來。沒放進任何倉位的商品另外算一個數字報出來，不然搜尋
   * 有結果、地圖上卻沒有任何一格亮起來會讓人以為壞了。
   */
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return null;
    const found = items.filter((item) =>
      [item.name, item.sku ?? "", item.category, item.notes].some((value) => value.toLowerCase().includes(term)),
    );
    return {
      items: found.length,
      zoneIds: new Set(found.map((item) => item.zoneId).filter((id): id is string => Boolean(id))),
      unassigned: found.filter((item) => !item.zoneId).length,
    };
  }, [items, search]);

  /*
   * 拖完之後暫存位置要留到伺服器的值追上來為止，這裡負責通知它「資料更新了」。
   *
   * 沒有這一段的話，放開手到清單重新載入之間的那幾十毫秒，方塊會用伺服器上的
   * **舊**座標渲染——也就是使用者看到的「放開之後閃回原位再跳過去」。
   */
  useEffect(() => {
    zoneDrag.settle(zones);
    elementDrag.settle(elements);
  }, [zones, elements, zoneDrag.settle, elementDrag.settle]);

  const selectedZone = zones.find((zone) => zone.id === selected) ?? null;
  const error =
    query.error ?? updateZone.error ?? deleteZone.error ?? updateElement.error ?? deleteElement.error;

  async function exportImage() {
    setExporting(true);
    try {
      await downloadMapImage({ settings, zones, layoutElements: elements, items });
      toast.show("整張配置圖已下載，可以直接列印");
    } catch (failure) {
      toast.show(failure instanceof Error ? failure.message : "圖片產生失敗");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="page bleed" ref={view.rootRef as React.RefObject<HTMLDivElement>}>
      <div
        className="map-scroll"
        ref={view.scrollRef}
        onTouchStart={view.onTouchStart}
        onTouchMove={view.onTouchMove}
        onTouchEnd={view.onTouchEnd}
      >
        {/*
          * stage 佔住縮放後的空間，canvas 用 transform 縮放。只縮 canvas 的話
          * 捲動範圍不會跟著變，放大之後右下角就捲不到。
          */}
        <div
          className="map-stage"
          style={{ width: settings.canvasWidth * view.zoom, height: settings.canvasHeight * view.zoom }}
        >
          <div
            className="map-canvas"
            style={{
              width: settings.canvasWidth,
              height: settings.canvasHeight,
              transform: `scale(${view.zoom})`,
            }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) setSelected(null);
            }}
          >
            {elements.map((element) => {
              const box = elementDrag.boxOf(element.id, element);
              return (
                <div
                  key={element.id}
                  className={`map-element tone-${element.color}${editing ? " editable" : ""}`}
                  style={boxStyle(box)}
                  onPointerDown={(event) => editing && elementDrag.start(event, element.id, element, "move")}
                  onPointerMove={elementDrag.move}
                  onPointerUp={(event) => {
                    if (!elementDrag.end(event) && editing) setElementForm(element);
                  }}
                >
                  <span>{element.label}</span>
                  {editing ? (
                    <button
                      type="button"
                      className="map-resize"
                      aria-label={`調整 ${element.label} 的大小`}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        elementDrag.start(event, element.id, element, "resize");
                      }}
                      onPointerMove={elementDrag.move}
                      onPointerUp={(event) => {
                        event.stopPropagation();
                        elementDrag.end(event);
                      }}
                    />
                  ) : null}
                </div>
              );
            })}

            {zones.map((zone) => {
              const box = zoneDrag.boxOf(zone.id, zone);
              const zoneItems = itemsByZone.get(zone.id) ?? [];
              const low = zoneItems.some((item) => item.quantity < item.minStock);

              /*
               * 依層架順序排，同一層之內照名稱。
               *
               * 地圖是拿來找東西的，所以列出來的順序要對得上架上實際由上而下的
               * 位置。沒有指定層架的排在最後——它們不在任何一層上。
               */
              const shelfOrder = new Map(zone.shelfLevels.map((level, index) => [level.id, index]));
              const listed = [...zoneItems].sort((a, b) => {
                const left = shelfOrder.get(a.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
                const right = shelfOrder.get(b.shelfLevel ?? "") ?? Number.MAX_SAFE_INTEGER;
                return left - right || a.name.localeCompare(b.name, "zh-TW");
              });

              // 用畫布的像素尺寸算，不是螢幕上的——縮放不該改變列得下幾項。
              const slots = itemSlots((settings.canvasHeight * box.height) / 100);
              const overflowing = listed.length > slots;
              const visibleItems = listed.slice(0, overflowing ? Math.max(0, slots - 1) : slots);
              const hidden = listed.length - visibleItems.length;

              return (
                <article
                  key={zone.id}
                  className={[
                    "map-zone",
                    `tone-${zone.color}`,
                    editing ? "editable" : "",
                    selected === zone.id ? "selected" : "",
                    zoneDrag.draggingId === zone.id ? "dragging" : "",
                    matches ? (matches.zoneIds.has(zone.id) ? "search-match" : "search-dimmed") : "",
                  ].filter(Boolean).join(" ")}
                  style={boxStyle(box)}
                  role="button"
                  tabIndex={editing ? -1 : 0}
                  aria-label={`${zone.code} ${zone.name}，放了 ${zoneItems.length} 項商品`}
                  onPointerDown={(event) => {
                    if (editing) zoneDrag.start(event, zone.id, zone, "move");
                    else pressAt.current = { x: event.clientX, y: event.clientY };
                  }}
                  onPointerMove={zoneDrag.move}
                  onPointerUp={(event) => {
                    // 配置模式下點方塊是選它來拖，不是看明細。
                    if (zoneDrag.end(event) || editing) return;
                    const from = pressAt.current;
                    pressAt.current = null;
                    if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) >= CLICK_SLOP) return;
                    setSelected(zone.id);
                  }}
                  onKeyDown={(event) => {
                    if (!editing && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSelected(zone.id);
                    }
                  }}
                >
                  <span className="map-zone-head">
                    <b>{zone.code}</b>
                    {low ? <i title="有商品低於安全庫存">!</i> : null}
                  </span>
                  <span className="map-zone-name">{zone.name}</span>
                  {/*
                    * 放了什麼，不是放了幾件。
                    *
                    * 數量在地圖上沒有用：站在倉庫裡看這張圖的人要找的是「那個東西
                    * 在哪一格」，不是「這一格總共幾件」。要看數量去商品庫存那一頁，
                    * 那裡才排得下也篩得動。方塊太小就整塊不畫——硬擠只會變成一團
                    * 看不懂的字。
                    */}
                  {/*
                    * hidden > 0 也要畫：只放得下一列而裡面有兩項以上時，
                    * visibleItems 會是空的、hidden 是全部——只看 visibleItems
                    * 的話這一格會整個空白，看起來像沒放東西。匯出那邊畫得出來，
                    * 兩邊不能不一致。
                    */}
                  {canReadItems && slots > 0 && (visibleItems.length > 0 || hidden > 0) ? (
                    <span className="map-zone-items">
                      {visibleItems.map((item) => (
                        <em key={item.id} title={item.name}>{item.name}</em>
                      ))}
                      {hidden > 0 ? (
                        <em className="map-zone-more" title={`還有 ${hidden} 項沒列出來`}>
                          還有 {hidden} 項
                        </em>
                      ) : null}
                    </span>
                  ) : null}

                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="map-zone-delete"
                        title={`刪除 ${zone.code}`}
                        aria-label={`刪除 ${zone.code} ${zone.name}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeletingZone(zone);
                        }}
                      >
                        ×
                      </button>
                      <button
                        type="button"
                        className="map-resize"
                        aria-label={`調整 ${zone.code} 的大小`}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          zoneDrag.start(event, zone.id, zone, "resize");
                        }}
                        onPointerMove={zoneDrag.move}
                        onPointerUp={(event) => {
                          event.stopPropagation();
                          zoneDrag.end(event);
                        }}
                      />
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </div>

      {/* 左上：標題與搜尋。搜尋是最常用的，放在最順手的角落。 */}
      <div className="map-float start">
        <h1>倉位地圖</h1>
        <div className="map-search">
          <label>
            <Icon name="search" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋商品或 SKU…"
              aria-label="在地圖上搜尋商品"
            />
          </label>
        </div>
        {matches ? (
          <small aria-live="polite" className="map-note">
            {matches.items
              ? `找到 ${matches.items} 項商品・${matches.zoneIds.size} 個倉位${
                  matches.unassigned ? `・${matches.unassigned} 項未設定倉位` : ""
                }`
              : "找不到符合的商品"}
          </small>
        ) : null}
        {editing ? (
          <small className="map-note editing">
            配置模式：倉位與標籤可拖曳、右下角可縮放，右上角的 × 可刪除，點標籤可改名
          </small>
        ) : null}
        {error ? <small className="map-note failed" role="alert">{error.message}</small> : null}
      </div>

      {/* 右上：所有動作。 */}
      <div className="map-float end">
        {canWrite ? (
          <>
            <Button
              variant="secondary"
              className={editing ? "active" : ""}
              aria-pressed={editing}
              onClick={() => setEditing((on) => !on)}
            >
              {editing ? "✓ 完成配置" : "調整配置"}
            </Button>
            <Button icon="plus" type="button" onClick={() => setZoneForm("new")}>
              <span>新增區塊</span>
            </Button>
            <Button variant="secondary" icon="plus" type="button" onClick={() => setElementForm("new")}>
              <span>新增標籤</span>
            </Button>
            <Button variant="secondary" type="button" onClick={() => setCanvasForm(true)}>
              ▭ 畫布 {settings.canvasWidth} × {settings.canvasHeight}
            </Button>
          </>
        ) : null}

        <Button variant="secondary" type="button" disabled={exporting} onClick={() => void exportImage()}>
          {exporting ? "匯出中…" : "⇩ 下載整張圖"}
        </Button>
      </div>

      {/* 右下：縮放。離內容最遠的角落，最不會擋到東西。 */}
      <div className="map-float corner">
        <div className="zoom-control">
          <button type="button" aria-label="縮小" disabled={!view.canZoomOut} onClick={() => view.zoomTo(view.zoom - 0.1)}>−</button>
          <span>{Math.round(view.zoom * 100)}%</span>
          <button type="button" aria-label="放大" disabled={!view.canZoomIn} onClick={() => view.zoomTo(view.zoom + 0.1)}>＋</button>
        </div>
        <Button
          variant="icon"
          aria-pressed={view.fullscreen}
          title={view.fullscreen ? "退出全螢幕（Esc）" : "全螢幕"}
          aria-label={view.fullscreen ? "退出全螢幕" : "全螢幕"}
          onClick={() => void view.toggleFullscreen()}
        >
          <span aria-hidden="true">{view.fullscreen ? "↙" : "⛶"}</span>
        </Button>
      </div>

      {selectedZone && !editing ? (
        <ZoneDrawer
          zone={selectedZone}
          items={itemsByZone.get(selectedZone.id) ?? []}
          onClose={() => setSelected(null)}
          onEdit={() => setZoneForm(selectedZone)}
        />
      ) : null}

      {zoneForm ? (
        <ZoneDialog zone={zoneForm === "new" ? undefined : zoneForm} onClose={() => setZoneForm(null)} />
      ) : null}

      {elementForm ? (
        <ElementDialog
          element={elementForm === "new" ? undefined : elementForm}
          onClose={() => setElementForm(null)}
          onDeleted={() => setElementForm(null)}
        />
      ) : null}

      {canvasForm ? <CanvasDialog settings={settings} onClose={() => setCanvasForm(false)} /> : null}

      {deletingZone ? (
        <ConfirmDialog
          title="刪除這個倉位？"
          confirmLabel="刪除"
          pending={deleteZone.isPending}
          onCancel={() => setDeletingZone(null)}
          onConfirm={() =>
            deleteZone.mutate(deletingZone.id, {
              onSuccess: () => {
                toast.show(`已刪除「${deletingZone.code} ${deletingZone.name}」`);
                setDeletingZone(null);
                setSelected(null);
              },
            })
          }
        >
          <p><strong>{deletingZone.code} {deletingZone.name}</strong> 會從地圖上移除，現場照片也會一起刪掉。</p>
          <p className="muted">裡面還有商品的話刪不掉，要先把它們移到別的倉位。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
