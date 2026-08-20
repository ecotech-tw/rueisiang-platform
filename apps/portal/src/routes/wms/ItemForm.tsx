import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import {
  useCreateItem,
  useUpdateItem,
  type InventoryItem,
  type ProductCategory,
  type Zone,
} from "./api.js";

/**
 * 新增／編輯商品。
 *
 * 這張表單**沒有數量欄位**（新增時例外，見下）。數量只能透過盤點改，理由寫在
 * CountDialog：那是不同的權限，混在一起等於把界線拿掉。編輯既有商品時看得到
 * 現有數量，但那是唯讀的資訊，不是輸入框。
 */
export function ItemForm({
  item,
  zones,
  categories,
  onClose,
}: {
  item?: InventoryItem;
  zones: Zone[];
  categories: ProductCategory[];
  onClose: () => void;
}) {
  const [fields, setFields] = useState({
    sku: item?.sku ?? "",
    name: item?.name ?? "",
    // 只有一個分類時直接選好——那是絕大多數的情況，少一次點擊。
    category: item?.category ?? (categories.length === 1 ? categories[0]!.name : ""),
    quantity: String(item?.quantity ?? 0),
    unit: item?.unit ?? "件",
    minStock: String(item?.minStock ?? 5),
    zoneId: item?.zoneId ?? "",
    shelfLevel: item?.shelfLevel ?? "",
    notes: item?.notes ?? "",
  });

  const create = useCreateItem();
  const update = useUpdateItem();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  /** 選了倉位才有層可選，而且只能選那個倉位自己的層。 */
  const zone = zones.find((candidate) => candidate.id === fields.zoneId);

  function set(patch: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  const valid = fields.name.trim() !== "" && fields.category !== "";

  function submit() {
    if (!valid) return;
    const payload = {
      sku: fields.sku.trim(),
      name: fields.name.trim(),
      category: fields.category,
      quantity: Math.max(0, Math.round(Number(fields.quantity) || 0)),
      unit: fields.unit.trim() || "件",
      minStock: Math.max(0, Math.round(Number(fields.minStock) || 0)),
      zoneId: fields.zoneId || null,
      shelfLevel: fields.shelfLevel || null,
      notes: fields.notes.trim(),
    };
    if (item) update.mutate({ ...payload, id: item.id }, { onSuccess: onClose });
    else create.mutate(payload, { onSuccess: onClose });
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="item-form-title">
        <div className="modal-head">
          <h2 id="item-form-title">{item ? "編輯商品" : "新增商品"}</h2>
          <button type="button" className="icon-button" onClick={onClose} disabled={pending} aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>

        <form
          className="modal-body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="field">
            <span>商品名稱<b>必填</b></span>
            <input
              autoFocus
              required
              value={fields.name}
              onChange={(event) => set({ name: event.target.value })}
            />
          </label>

          <div className="field-grid">
            <label className="field">
              <span>SKU</span>
              <input
                placeholder="例如 BOX-M"
                value={fields.sku}
                onChange={(event) => set({ sku: event.target.value })}
              />
              <small>會自動轉成大寫。要連結 CYBERBIZ 時才是必填。</small>
            </label>
            <label className="field">
              <span>分類<b>必填</b></span>
              <select
                required
                value={fields.category}
                onChange={(event) => set({ category: event.target.value })}
              >
                <option value="">請選擇分類</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.name}>{category.name}</option>
                ))}
              </select>
              {categories.length === 0 ? (
                <small>還沒有任何分類，請先去分類管理建立一個。</small>
              ) : null}
            </label>
          </div>

          <div className="field-grid trio">
            {/*
              * 數量只有新增時填得動。既有商品要改數量得走盤點——那裡會留下
              * 「誰、什麼時候、從幾改到幾」的紀錄，直接在這裡改就沒有了。
              */}
            {item ? (
              <div className="field">
                <span>目前數量</span>
                <p className="field-static">
                  {item.quantity.toLocaleString("zh-TW")} {item.unit}
                  <small>要改數量請用列表上的「盤點」。</small>
                </p>
              </div>
            ) : (
              <label className="field">
                <span>初始數量</span>
                <input
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={fields.quantity}
                  onChange={(event) => set({ quantity: event.target.value })}
                />
              </label>
            )}
            <label className="field">
              <span>單位</span>
              <input
                placeholder="件"
                value={fields.unit}
                onChange={(event) => set({ unit: event.target.value })}
              />
            </label>
            <label className="field">
              <span>安全庫存</span>
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={fields.minStock}
                onChange={(event) => set({ minStock: event.target.value })}
              />
              <small>低於這個數量會被標成需要補貨。</small>
            </label>
          </div>

          <div className="address-fields">
            <div className="field-grid">
              <label className="field">
                <span>倉位</span>
                <select
                  value={fields.zoneId}
                  onChange={(event) => {
                    // 換倉位時清掉層——舊的層不屬於新的倉位。
                    set({ zoneId: event.target.value, shelfLevel: "" });
                  }}
                >
                  <option value="">未指定倉位</option>
                  {zones.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.code} {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>層架</span>
                <select
                  value={fields.shelfLevel}
                  disabled={!zone}
                  onChange={(event) => set({ shelfLevel: event.target.value })}
                >
                  <option value="">{zone ? "不指定層架" : "請先選擇倉位"}</option>
                  {(zone?.shelfLevels ?? []).map((level) => (
                    <option key={level.id} value={level.id}>{level.name}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <label className="field">
            <span>備註</span>
            <input value={fields.notes} onChange={(event) => set({ notes: event.target.value })} />
          </label>

          {error ? <p className="form-error" role="alert">{error.message}</p> : null}

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!valid || pending}>
              {pending ? "儲存中…" : item ? "儲存" : "新增商品"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
