import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import {
  useCreateElement,
  useDeleteElement,
  useDeleteZone,
  useUpdateElement,
  useUpdateZone,
  useWarehouse,
  type InventoryItem,
  type LayoutElement,
  type Zone,
} from "./api.js";
import { useDragBox, type Box } from "./useDragBox.js";
import { ZoneDialog } from "./ZoneDialog.js";

/**
 * 倉位地圖。
 *
 * 用絕對定位的 DOM 而不是 canvas（舊系統那邊是 canvas）：方塊只有幾十個，DOM
 * 完全撐得住，而文字換行、hover、鍵盤焦點、螢幕閱讀器這些在 canvas 上全都要
 * 自己重寫一遍。舊系統的 canvas 是為了「匯出成 PNG」才存在的，那是另一件事。
 *
 * 座標是百分比，所以畫布本身只要維持比例就好，實際像素多少不影響資料。
 */

/** 一個倉位裡有什麼。地圖上每個方塊都要，所以先分好組再畫。 */
function groupItems(items: InventoryItem[]): Map<string, InventoryItem[]> {
  const grouped = new Map<string, InventoryItem[]>();
  for (const item of items) {
    if (!item.zoneId) continue;
    const list = grouped.get(item.zoneId);
    if (list) list.push(item);
    else grouped.set(item.zoneId, [item]);
  }
  return grouped;
}

function boxStyle(box: Box): React.CSSProperties {
  return { left: `${box.x}%`, top: `${box.y}%`, width: `${box.width}%`, height: `${box.height}%` };
}

// 叫 WarehouseMap 而不是 Map：後者會把全域的 Map 建構子遮蔽掉，而這個檔案
// 自己就用到 new Map()。
export function WarehouseMap() {
  usePageTitle("倉位地圖");
  const [selected, setSelected] = useState<string | null>(null);
  const [editingZone, setEditingZone] = useState<Zone | "new" | null>(null);
  const [deletingZone, setDeletingZone] = useState<Zone | null>(null);
  const [editingElement, setEditingElement] = useState<LayoutElement | null>(null);

  const query = useWarehouse();
  const updateZone = useUpdateZone();
  const deleteZone = useDeleteZone();
  const createElement = useCreateElement();
  const updateElement = useUpdateElement();
  const deleteElement = useDeleteElement();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:map:write");
  const canReadItems = permissions.has("wms:inventory:read");

  const settings = query.data?.settings;
  const zones = query.data?.zones ?? [];
  const elements = query.data?.layoutElements ?? [];
  const itemsByZone = groupItems(query.data?.items ?? []);

  /*
   * 倉位與標示各自一個 hook：兩者打的是不同的 API，而且同一時間只可能拖其中
   * 一個，分開之後就不必在 commit 時再判斷「這個 id 是誰的」。
   */
  const zoneDrag = useDragBox((id, box) => {
    updateZone.mutate({ id, ...box });
  });
  const elementDrag = useDragBox((id, box) => {
    updateElement.mutate({ id, ...box });
  });

  const selectedZone = zones.find((zone) => zone.id === selected) ?? null;
  const selectedItems = selectedZone ? itemsByZone.get(selectedZone.id) ?? [] : [];
  const error = query.error ?? updateZone.error ?? deleteZone.error ?? createElement.error ?? updateElement.error ?? deleteElement.error;

  return (
    <div className="page fills">
      <header className="page-head">
        <div className="page-head-row">
          <div>
            <h1>倉位地圖</h1>
            <p className="muted">
              倉庫的平面配置。點一個倉位看裡面有什麼
              {canWrite ? "，拖曳可以移動，右下角可以調整大小" : ""}。
            </p>
          </div>
          {canWrite ? (
            <div className="head-actions">
              <button
                type="button"
                className="ghost-button with-icon"
                onClick={() =>
                  createElement.mutate(
                    { label: "新標示", color: "slate" },
                    { onSuccess: () => toast.show("已新增地圖標示，拖到定位後再改名") },
                  )
                }
                disabled={createElement.isPending}
              >
                <Icon name="plus" />
                <span>地圖標示</span>
              </button>
              <button
                type="button"
                className="primary-button with-icon add-action"
                onClick={() => setEditingZone("new")}
                aria-label="新增倉位"
              >
                <Icon name="plus" />
                <span>新增倉位</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {error ? <p className="form-error" role="alert">{error.message}</p> : null}

      <section className="panel grows map-panel">
        {/*
          * 畫布用 aspect-ratio 維持比例，寬度隨面板走。倉位的座標是百分比，
          * 所以畫布實際多少像素都不影響它們的相對位置——縮視窗時整張圖等比例縮。
          */}
        <div
          className="map-canvas"
          style={{ aspectRatio: `${settings?.canvasWidth ?? 1600} / ${settings?.canvasHeight ?? 900}` }}
          onPointerDown={(event) => {
            // 點在空白處就取消選取，跟點掉一個對話框的背景是同一個直覺。
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          {elements.map((element) => {
            const box = elementDrag.boxOf(element.id, element);
            return (
              <div
                key={element.id}
                className={`map-element tone-${element.color}${canWrite ? " editable" : ""}`}
                style={boxStyle(box)}
                onPointerDown={(event) => canWrite && elementDrag.start(event, element.id, element, "move")}
                onPointerMove={elementDrag.move}
                onPointerUp={(event) => {
                  const dragged = elementDrag.end(event);
                  if (!dragged && canWrite) setEditingElement(element);
                }}
              >
                <span>{element.label}</span>
                {canWrite ? (
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
            const items = itemsByZone.get(zone.id) ?? [];
            const total = items.reduce((sum, item) => sum + item.quantity, 0);
            const low = items.some((item) => item.quantity < item.minStock);

            return (
              <div
                key={zone.id}
                className={[
                  "map-zone",
                  `tone-${zone.color}`,
                  canWrite ? "editable" : "",
                  selected === zone.id ? "selected" : "",
                  zoneDrag.draggingId === zone.id ? "dragging" : "",
                ].filter(Boolean).join(" ")}
                style={boxStyle(box)}
                role="button"
                tabIndex={0}
                aria-pressed={selected === zone.id}
                onPointerDown={(event) => canWrite && zoneDrag.start(event, zone.id, zone, "move")}
                onPointerMove={zoneDrag.move}
                onPointerUp={(event) => {
                  // 拖過就不算點擊，不然放開手的瞬間會順便打開明細。
                  if (!zoneDrag.end(event)) setSelected(zone.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelected(zone.id);
                  }
                }}
              >
                <div className="map-zone-head">
                  <strong>{zone.code}</strong>
                  {/* 補貨提示只用一個點，方塊可能只有 80px 寬，塞不下一句話。 */}
                  {low ? <span className="map-zone-alert" title="有商品低於安全庫存">!</span> : null}
                </div>
                <div className="map-zone-name">{zone.name}</div>
                {canReadItems ? (
                  <div className="map-zone-meta">
                    {items.length ? `${items.length} 項・${total.toLocaleString("zh-TW")} 件` : "空的"}
                  </div>
                ) : null}
                {canWrite ? (
                  <button
                    type="button"
                    className="map-resize"
                    aria-label={`調整 ${zone.code} 的大小`}
                    onPointerDown={(event) => {
                      // 不擋的話會同時觸發外層的「移動」，方塊會一邊變大一邊跑。
                      event.stopPropagation();
                      zoneDrag.start(event, zone.id, zone, "resize");
                    }}
                    onPointerMove={zoneDrag.move}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      zoneDrag.end(event);
                    }}
                  />
                ) : null}
              </div>
            );
          })}

          {query.data && zones.length === 0 && elements.length === 0 ? (
            <p className="map-empty muted">
              還沒有任何倉位。{canWrite ? "按右上角的「新增倉位」開始畫。" : ""}
            </p>
          ) : null}
        </div>
      </section>

      {/*
        * 選中的倉位開一張明細。做成對話框而不是側邊欄：手機上側邊欄會把地圖
        * 擠成一條，而看明細的時候本來就不需要同時看地圖。
        */}
      {selectedZone ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="zone-detail-title">
            <div className="modal-head">
              <h2 id="zone-detail-title">
                <span className={`status status-tone-${selectedZone.color}`}>{selectedZone.code}</span>
                {selectedZone.name}
              </h2>
              <button type="button" className="icon-button" onClick={() => setSelected(null)} aria-label="關閉">
                <Icon name="close" />
              </button>
            </div>

            <div className="modal-body">
              <p className="muted">
                {selectedZone.category}
                {selectedZone.notes ? `・${selectedZone.notes}` : ""}
              </p>

              {canReadItems ? (
                selectedItems.length ? (
                  <table className="data-table zone-items">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>層架</th>
                        <th className="numeric">數量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedItems.map((item) => {
                        const level = selectedZone.shelfLevels.find((candidate) => candidate.id === item.shelfLevel);
                        return (
                          <tr key={item.id}>
                            <td data-label="商品">
                              <div className="cell-strong">{item.name}</div>
                              <div className="cell-sub">{item.sku || "沒有 SKU"}</div>
                            </td>
                            <td data-label="層架" className="cell-sub">{level?.name ?? "未指定"}</td>
                            <td data-label="數量" className="numeric">
                              <span className={item.quantity < item.minStock ? "stock-low" : undefined}>
                                {item.quantity.toLocaleString("zh-TW")}
                                <span className="cell-sub"> {item.unit}</span>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <p className="muted">這個倉位還沒有放東西。</p>
                )
              ) : null}

              {canWrite ? (
                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button danger"
                    onClick={() => {
                      setDeletingZone(selectedZone);
                      setSelected(null);
                    }}
                  >
                    刪除倉位
                  </button>
                  <button type="button" className="primary-button" onClick={() => setEditingZone(selectedZone)}>
                    編輯倉位
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {editingZone ? (
        <ZoneDialog
          zone={editingZone === "new" ? undefined : editingZone}
          onClose={() => {
            setEditingZone(null);
            setSelected(null);
          }}
        />
      ) : null}

      {/* 標示只有一個名字跟顏色，用不著一整張表單。 */}
      {editingElement ? (
        <ConfirmDialog
          title="地圖標示"
          confirmLabel="刪除"
          cancelLabel="關閉"
          pending={deleteElement.isPending}
          onCancel={() => setEditingElement(null)}
          onConfirm={() =>
            deleteElement.mutate(editingElement.id, {
              onSuccess: () => {
                toast.show(`已刪除「${editingElement.label}」`);
                setEditingElement(null);
              },
            })
          }
        >
          <label className="field">
            <span>標示文字</span>
            <input
              autoFocus
              maxLength={40}
              defaultValue={editingElement.label}
              onBlur={(event) => {
                const label = event.target.value.trim();
                if (label && label !== editingElement.label) {
                  updateElement.mutate({ id: editingElement.id, label });
                }
              }}
            />
            <small>離開輸入框就會存起來。</small>
          </label>
        </ConfirmDialog>
      ) : null}

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
              },
            })
          }
        >
          <p>
            <strong>{deletingZone.code} {deletingZone.name}</strong> 會從地圖上移除。
          </p>
          <p className="muted">裡面還有商品的話刪不掉，要先把它們移到別的倉位。</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
