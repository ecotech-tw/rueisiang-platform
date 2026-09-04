import { useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { useToast } from "../../shell/Toast.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateCatalogItem,
  useCreateItem,
  useLinkCyberbiz,
  useUnlinkCyberbiz,
  useUpdateItem,
  type CyberbizCatalogProduct,
  type InventoryItem,
  type ProductCategory,
  type Zone,
} from "./api.js";

/** 分類下拉先排母分類，再排它的子分類，避免所有子分類集中在列表底部。 */
function arrangeCategories(categories: ProductCategory[]): ProductCategory[] {
  return categories.flatMap((category) => category.parentId ? [] : [category, ...categories.filter((child) => child.parentId === category.id)]);
}

/** 這一欄有兩種格式：D1 的 CURRENT_TIMESTAMP 沒有時區，同步寫進來的是帶 Z 的 ISO。 */
function categoryLabel(category: ProductCategory): string {
  if (category.depth !== 1 || !category.parentId) return category.name;
  return `　${category.name}`;
}

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
  cyberbizProducts = [],
  catalogOnly = false,
  initialCyberbizSku = "",
  onClose,
}: {
  item?: InventoryItem;
  zones: Zone[];
  categories: ProductCategory[];
  cyberbizProducts?: CyberbizCatalogProduct[];
  /** 品項主檔模式只建立 items，不處理 wms_items 的庫存、倉位與安全庫存。 */
  catalogOnly?: boolean;
  /** 從 CYBERBIZ 未入主檔列表建立品項時，先選好那筆商品。 */
  initialCyberbizSku?: string;
  onClose: () => void;
}) {
  /*
   * 已連結的話，數量與安全庫存的真相來源都是官網（見 packages/db 的 wms-sync.ts）。
   * 數量本來就不在這張表單裡改（走盤點），安全庫存也要比照。
   */
  const linkedToCyberbiz = Boolean(item?.cyberbiz);
  const initialCyberbiz = cyberbizProducts.find((product) => product.sku === initialCyberbizSku);

  const [selectedCyberbizSku, setSelectedCyberbizSku] = useState(initialCyberbiz?.sku ?? "");
  const [fields, setFields] = useState({
    sku: item?.sku ?? initialCyberbiz?.sku ?? "",
    name: item?.name ?? (initialCyberbiz ? `${initialCyberbiz.productName}${initialCyberbiz.variantName ? `（${initialCyberbiz.variantName}）` : ""}` : ""),
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
  const createCatalog = useCreateCatalogItem();
  const update = useUpdateItem();
  const link = useLinkCyberbiz();
  const unlink = useUnlinkCyberbiz();
  const toast = useToast();
  const pending = create.isPending || createCatalog.isPending || update.isPending;
  const error = create.error ?? createCatalog.error ?? update.error;

  /** 選了倉位才有層可選，而且只能選那個倉位自己的層。 */
  const zone = zones.find((candidate) => candidate.id === fields.zoneId);

  function set(patch: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  const selectedCyberbiz = cyberbizProducts.find((product) => product.sku === selectedCyberbizSku);
  const canPickCyberbiz = !item && cyberbizProducts.length > 0;
  const valid = (fields.name.trim() !== "" || Boolean(selectedCyberbiz)) && fields.category !== "";

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
      const createPayload = selectedCyberbiz ? { ...payload, cyberbizSku: selectedCyberbiz.sku } : payload;
      const mutation = canPickCyberbiz ? createCatalog : create;
      mutation.mutate(createPayload, { onSuccess: onClose });
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
      { onSuccess: () => { toast.show("商品資料已更新"); onClose(); } },
    );
  }

  return (
    <Dialog
      title={item ? "編輯商品" : catalogOnly ? "新增品項" : "新增商品"}
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
            {item ? "儲存" : catalogOnly ? "新增品項" : "新增商品"}
          </Button>
        </>
      }
    >
          {canPickCyberbiz ? (
            <div className="field">
              <span>CYBERBIZ 商品</span>
              <Combobox.Root
                items={cyberbizProducts}
                value={selectedCyberbiz ?? null}
                onValueChange={(product) => {
                  if (!product) { setSelectedCyberbizSku(""); return; }
                  setSelectedCyberbizSku(product.sku);
                  set({ sku: product.sku, name: `${product.productName}${product.variantName ? `（${product.variantName}）` : ""}` });
                }}
                onInputValueChange={(value) => { const product = cyberbizProducts.find((candidate) => candidate.sku === value.trim().toUpperCase()); setSelectedCyberbizSku(product?.sku ?? ""); }}
                itemToStringLabel={(product) => product ? `${product.sku}　${product.productName}${product.variantName ? `（${product.variantName}）` : ""}` : ""}
                autoHighlight
              >
                <Combobox.InputGroup className="combobox-group">
                  <Combobox.Input className="combobox-input" placeholder="搜尋 SKU、商品名稱或規格" />
                  <Combobox.Trigger className="combobox-trigger" aria-label="開啟商品選單"><Icon name="chevronDown" /></Combobox.Trigger>
                </Combobox.InputGroup>
                <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到符合的 CYBERBIZ 商品</Combobox.Empty><Combobox.List>{(product: CyberbizCatalogProduct) => <Combobox.Item key={product.sku} value={product} className="combobox-item"><strong>{product.sku}</strong><span>{product.productName}{product.variantName ? `（${product.variantName}）` : ""}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
              </Combobox.Root>
              <small>{selectedCyberbiz ? `會自動連結 ${selectedCyberbiz.productId} / ${selectedCyberbiz.variantId}` : "選到 CYBERBIZ 商品時會自動帶 SKU 與名稱，儲存後直接建立連結。"}</small>
            </div>
          ) : null}

          <TextField
            label="商品名稱"
            required={!selectedCyberbiz}
            autoFocus={!canPickCyberbiz}
            value={fields.name}
            disabled={Boolean(selectedCyberbiz)}
            onChange={(event) => set({ name: event.target.value })}
          />

          <div className="field-grid">
            <TextField
              label="SKU"
              placeholder="例如 BOX-M"
              value={fields.sku}
              onChange={(event) => set({ sku: event.target.value })}
              disabled={Boolean(selectedCyberbiz)}
              hint={selectedCyberbiz ? "已由 CYBERBIZ 商品帶入。" : "會自動轉成大寫。要連結 CYBERBIZ 時才是必填。"}
            />
            <SelectField
              label="分類"
              required
              value={fields.category}
              onChange={(event) => set({ category: event.target.value })}
              hint={categories.length === 0 ? (catalogOnly ? "還沒有任何品項分類，請先去「品項分類」建立一個。" : "還沒有任何倉儲分類，請先去「倉儲分類管理」建立一個。") : undefined}
              options={[
                { label: "請選擇分類", value: "" },
                ...arrangeCategories(categories).map((category) => ({ label: categoryLabel(category), value: category.name })),
              ]}
            />
          </div>

          {!catalogOnly ? (
            <>
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
                <TextField
                  label="安全庫存"
                  type="number"
                  min={0}
                  inputMode="numeric"
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
            </>
          ) : null}

          <TextField label="備註" value={fields.notes} onChange={(event) => set({ notes: event.target.value })} />

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
