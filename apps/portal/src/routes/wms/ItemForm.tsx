import { useState } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateItem,
  useAddProductSkuMapping,
  useDeleteProductSkuMapping,
  useLinkCyberbiz,
  useUnlinkCyberbiz,
  useUpdateItem,
  type InventoryItem,
  type ProductCategory,
  type Zone,
} from "./api.js";

/** 這一欄有兩種格式：D1 的 CURRENT_TIMESTAMP 沒有時區，同步寫進來的是帶 Z 的 ISO。 */
function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

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
  /*
   * 已連結的話，數量與安全庫存的真相來源都是官網（見 packages/db 的 wms-sync.ts）。
   * 數量本來就不在這張表單裡改（走盤點），安全庫存也要比照。
   */
  const linkedToCyberbiz = Boolean(item?.cyberbiz);

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
  const addProductSkuMapping = useAddProductSkuMapping();
  const deleteProductSkuMapping = useDeleteProductSkuMapping();
  const link = useLinkCyberbiz();
  const unlink = useUnlinkCyberbiz();
  const toast = useToast();
  const [externalSku, setExternalSku] = useState("");
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const mappingError = addProductSkuMapping.error ?? deleteProductSkuMapping.error;

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
    if (!item) {
      create.mutate(payload, { onSuccess: onClose });
      return;
    }

    /*
     * 已連結就不送安全庫存——後端收不到這個欄位時是「不要動」。
     *
     * 送的話會壞在一個很難查的地方：fields 是**開啟表單那一刻**的快照，而這張
     * 表單開著的時候 item 會被重新讀進來（Inventory 會從刷新後的清單找回那一筆）。
     * 所以官網同步把安全庫存從 5 改成 99 之後，表單手上還是 5，接下來連改個名字
     * 都會送出 5，被後端判成「要改成不同的值」而回 409——這項商品就完全編輯不動
     * 了，而錯誤訊息完全沒提到這件事。
     */
    const { minStock, ...rest } = payload;
    update.mutate(
      { ...rest, ...(linkedToCyberbiz ? {} : { minStock }), id: item.id },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      title={item ? "編輯商品" : "新增商品"}
      onClose={onClose}
      closeDisabled={pending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="submit" loading={pending} loadingLabel="儲存中…" disabled={!valid}>
            {item ? "儲存" : "新增商品"}
          </Button>
        </>
      }
    >
          <TextField
            label="商品名稱"
            required
            autoFocus
            value={fields.name}
            onChange={(event) => set({ name: event.target.value })}
          />

          <div className="field-grid">
            <TextField
              label="SKU"
              placeholder="例如 BOX-M"
              value={fields.sku}
              onChange={(event) => set({ sku: event.target.value })}
              hint="會自動轉成大寫。要連結 CYBERBIZ 時才是必填。"
            />
            <SelectField
              label="分類"
              required
              value={fields.category}
              onChange={(event) => set({ category: event.target.value })}
              hint={categories.length === 0 ? "還沒有任何分類，請先去分類管理建立一個。" : undefined}
              options={[
                { label: "請選擇分類", value: "" },
                ...categories.map((category) => ({ label: category.name, value: category.name })),
              ]}
            />
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
              <TextField
                label="初始數量"
                type="number"
                min={0}
                inputMode="numeric"
                value={fields.quantity}
                onChange={(event) => set({ quantity: event.target.value })}
              />
            )}
            <TextField
              label="單位"
              placeholder="件"
              value={fields.unit}
              onChange={(event) => set({ unit: event.target.value })}
            />
            {/*
              * 已連結的商品，安全庫存以官網為準，這裡鎖起來。
              *
              * 不鎖的話會很難解釋：改了不會推上官網，而且下次同步就被官網的值蓋
              * 回去——使用者看到的是自己的修改安靜地消失。與其之後才發現，不如
              * 一開始就說清楚要去哪裡改。
              */}
            <TextField
              label="安全庫存"
              type="number"
              min={0}
              inputMode="numeric"
              // 已連結時顯示這一刻的值，不是開表單那一刻的——同步隨時會改它。
              value={linkedToCyberbiz ? String(item?.minStock ?? "") : fields.minStock}
              disabled={linkedToCyberbiz}
              onChange={(event) => set({ minStock: event.target.value })}
              hint={linkedToCyberbiz
                ? "已連結 CYBERBIZ，安全庫存以官網為準，請到官網修改。"
                : "低於這個數量會被標成需要補貨。"}
            />
          </div>

          <div className="address-fields">
            <div className="field-grid">
              <SelectField
                label="倉位"
                value={fields.zoneId}
                onChange={(event) => {
                  // 換倉位時清掉層——舊的層不屬於新的倉位。
                  set({ zoneId: event.target.value, shelfLevel: "" });
                }}
                options={[
                  { label: "未指定倉位", value: "" },
                  ...zones.map((candidate) => ({
                    label: `${candidate.code} ${candidate.name}`,
                    value: candidate.id,
                  })),
                ]}
              />
              <SelectField
                label="層架"
                value={fields.shelfLevel}
                disabled={!zone}
                onChange={(event) => set({ shelfLevel: event.target.value })}
                options={[
                  { label: zone ? "不指定層架" : "請先選擇倉位", value: "" },
                  ...(zone?.shelfLevels ?? []).map((level) => ({ label: level.name, value: level.id })),
                ]}
              />
            </div>
          </div>

          <TextField label="備註" value={fields.notes} onChange={(event) => set({ notes: event.target.value })} />

          {item ? (
            <div className="field">
              <span>外部通路 SKU</span>
              <div className="field-grid">
                <TextField
                  label="新增外部 SKU"
                  placeholder="例如蝦皮 Product ID 或其他通路 SKU"
                  value={externalSku}
                  onChange={(event) => setExternalSku(event.target.value)}
                  hint="報表匯入時會用這些值找到正式 WMS SKU。"
                />
                <Button
                  variant="secondary"
                  type="button"
                  disabled={!externalSku.trim() || addProductSkuMapping.isPending}
                  loading={addProductSkuMapping.isPending}
                  loadingLabel="新增中…"
                  onClick={() => addProductSkuMapping.mutate(
                    { id: item.id, externalSku: externalSku.trim() },
                    {
                      onSuccess: (result) => {
                        setExternalSku("");
                        toast.show(`已新增外部 SKU「${result.externalSku}」`);
                      },
                    },
                  )}
                >
                  新增對應
                </Button>
              </div>
              {item.externalSkus.length ? (
                <div className="link-panel linked">
                  <div className="row-actions">
                    {item.externalSkus.map((mapping) => (
                      <span className="status status-sync-synced" key={mapping.id}>
                        {mapping.externalSku}
                        <button
                          type="button"
                          className="link-button"
                          aria-label={`移除外部 SKU ${mapping.externalSku}`}
                          onClick={() => deleteProductSkuMapping.mutate({ itemId: item.id, mappingId: mapping.id })}
                          disabled={deleteProductSkuMapping.isPending}
                        >
                          移除
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
              {mappingError ? <small className="ui-field-error">{mappingError.message}</small> : null}
            </div>
          ) : null}

          {/*
            * CYBERBIZ 連結只在編輯既有商品時出現。
            *
            * 新增時不給連結：要連結得先去官網用 SKU 找到對應的款式，而那個請求
            * 可能失敗（找不到、或有重複的 SKU）——那時候商品都還沒建起來，
            * 使用者會停在一個「到底建了沒」的狀態。分成兩步比較清楚。
            */}
          {item ? (
            <div className="field">
              <span>CYBERBIZ 連結</span>
              {item.cyberbiz ? (
                <div className="link-panel linked">
                  <div>
                    <div className="cell-strong">已連結款式 {item.cyberbiz.cyberbizVariantId}</div>
                    <div className="cell-sub">
                      SKU {item.cyberbiz.sku}
                      {item.cyberbiz.lastSyncedAt ? `・上次同步 ${formatTime(item.cyberbiz.lastSyncedAt)}` : ""}
                    </div>
                    {item.cyberbiz.lastError ? (
                      <div className="cell-error">{item.cyberbiz.lastError}</div>
                    ) : null}
                  </div>
                  <Button
                    variant="secondary"
                    className="danger"
                    loading={unlink.isPending}
                    loadingLabel="解除中…"
                    onClick={() =>
                      unlink.mutate(item.id, { onSuccess: () => toast.show("已解除連結，庫存數量保留") })
                    }
                  >
                    解除連結
                  </Button>
                </div>
              ) : (
                <div className="link-panel">
                  <div>
                    <div className="cell-sub">
                      連結之後，盤點會把數量推回官網，官網的異動也同步得回來。
                    </div>
                    {!fields.sku.trim() ? (
                      <div className="cell-sub">要先填 SKU——連結是用 SKU 去官網找的。</div>
                    ) : null}
                  </div>
                  <Button
                    variant="secondary"
                    loading={link.isPending}
                    loadingLabel="查詢官網中…"
                    disabled={!fields.sku.trim()}
                    onClick={() =>
                      link.mutate(
                        { id: item.id, sku: fields.sku.trim() },
                        {
                          onSuccess: (result) =>
                            toast.show(`已連結「${result.remote.productName}」，官網庫存 ${result.remote.quantity}`),
                        },
                      )
                    }
                  >
                    用 SKU 連結
                  </Button>
                </div>
              )}
              {link.error ? <small className="ui-field-error">{link.error.message}</small> : null}
              {unlink.error ? <small className="ui-field-error">{unlink.error.message}</small> : null}
            </div>
          ) : null}

          {error ? <Alert tone="danger">{error.message}</Alert> : null}

    </Dialog>
  );
}
