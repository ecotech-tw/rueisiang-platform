import { useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, Field, FieldGroup, FieldHint, SearchCombobox, SelectField, StaticValue, TextField } from "../../ui/index.js";
import {
  useCreateCatalogItem,
  useLinkCyberbiz,
  usePreviewCyberbizLinkRepair,
  useRepairCyberbizLink,
  useUpdateItem,
  type CyberbizLinkRepairPreview,
  type InventoryItem,
  type ProductCategory,
  type Zone,
} from "./api.js";

// CYBERBIZ 連結區：說明在左、按鈕在右。已連結的用綠色的邊，一眼看得出狀態不同。
const LINK_PANEL = "flex items-center justify-between gap-3 rounded-field border px-3.5 py-3";

/** 分類下拉先排母分類，再排它的子分類，避免所有子分類集中在列表底部。 */
function arrangeCategories(categories: ProductCategory[]): ProductCategory[] {
  return categories.flatMap((category) => category.parentId ? [] : [category, ...categories.filter((child) => child.parentId === category.id)]);
}

function categoryPath(category: ProductCategory, categories: ProductCategory[]): string {
  if (!category.parentId) return category.name;
  const parent = categories.find((candidate) => candidate.id === category.parentId);
  return parent ? `${parent.name} / ${category.name}` : category.name;
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
  catalogOnly = false,
  onClose,
}: {
  item?: InventoryItem;
  zones: Zone[];
  categories: ProductCategory[];
  /** 品項列表模式只建立 items，不處理 wms_items 的庫存、倉位與安全庫存。 */
  catalogOnly?: boolean;
  onClose: () => void;
}) {
  /*
   * 已連結的話，數量與安全庫存的真相來源都是官網（見 packages/db 的 wms-sync.ts）。
   * 數量本來就不在這張表單裡改（走盤點），安全庫存也要比照。
   */
  const linkedToCyberbiz = Boolean(item?.cyberbiz);
  const initialCategory = categories.find((category) => category.name === (item?.category ?? (categories.length === 1 ? categories[0]?.name : "")));

  const [selectedCategoryId, setSelectedCategoryId] = useState(initialCategory?.id ?? "");
  const [confirmCyberbizRepair, setConfirmCyberbizRepair] = useState(false);
  const [repairPreview, setRepairPreview] = useState<CyberbizLinkRepairPreview | null>(null);
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

  const createCatalog = useCreateCatalogItem();
  const update = useUpdateItem();
  const link = useLinkCyberbiz();
  const previewLinkRepair = usePreviewCyberbizLinkRepair();
  const repairLink = useRepairCyberbizLink();
  const toast = useToast();
  const pending = createCatalog.isPending || update.isPending || link.isPending || previewLinkRepair.isPending || repairLink.isPending;
  const error = createCatalog.error ?? update.error ?? link.error;

  /** 選了倉位才有層可選，而且只能選那個倉位自己的層。 */
  const zone = zones.find((candidate) => candidate.id === fields.zoneId);

  function set(patch: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  const isCatalogCreate = catalogOnly && !item;
  // SKU 是選填：包材與半成品（淋膜紙、護髮素軟管這些）本來就沒有 SKU，
  // 後端會自動編一組 WMS- 開頭的號碼並把 kind 設成 supply。
  const valid = fields.category !== "" && fields.name.trim() !== "";

  function submit() {
    if (!valid) return;
    const payload = {
      sku: fields.sku.trim(),
      name: fields.name.trim(),
      category: fields.category,
      ...(catalogOnly ? { categoryId: selectedCategoryId || null } : {}),
      quantity: Math.max(0, Math.round(Number(fields.quantity) || 0)),
      unit: fields.unit.trim() || "件",
      minStock: Math.max(0, Math.round(Number(fields.minStock) || 0)),
      zoneId: fields.zoneId || null,
      shelfLevel: fields.shelfLevel || null,
      notes: fields.notes.trim(),
    };
    if (!item) {
      createCatalog.mutate(payload, { onSuccess: onClose });
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
      { onSuccess: () => { toast.show("品項資料已更新"); onClose(); } },
    );
  }

  return (
    <>
    <Dialog
      manageFocus
      title={item ? "編輯品項" : "新增自訂品項"}
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
            {item ? "儲存" : "新增自訂品項"}
          </Button>
        </>
      }
    >
          <TextField
            label="品項名稱"
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
              disabled={linkedToCyberbiz}
              hint={linkedToCyberbiz
                ? "已連結 CYBERBIZ，SKU 必須與官網連結一致，請到官網修改。"
                : isCatalogCreate ? "會自動轉成大寫。包材或半成品可以留白，系統會自動編號。" : "會自動轉成大寫。要連結 CYBERBIZ 時才是必填。"}
            />
            <Field as="div" label="分類" required>
              <SearchCombobox
                items={arrangeCategories(categories)}
                value={(catalogOnly ? categories.find((category) => category.id === selectedCategoryId) : categories.find((category) => category.name === fields.category)) ?? null}
                onValueChange={(category) => {
                  setSelectedCategoryId(category?.id ?? "");
                  set({ category: category?.name ?? "" });
                }}
                itemToStringLabel={(category) => category ? categoryPath(category, categories) : ""}
                itemKey={(category) => category.id}
                renderItem={(category) => <span>{category.parentId ? <>{category.name}<small className="text-[12px] font-normal text-muted opacity-72"> · {categoryPath(category, categories).split(" / ")[0]}</small></> : category.name}</span>}
                label="分類"
                placeholder="搜尋或選擇分類"
                emptyLabel="找不到分類"
              />
              <FieldHint>{categories.length === 0 ? (catalogOnly ? "還沒有任何品項分類，請先去「品項分類」建立一個。" : "還沒有任何倉儲分類，請先去「倉儲分類管理」建立一個。") : "可搜尋分類名稱或選擇階層分類。"}</FieldHint>
            </Field>
          </div>

          {!catalogOnly ? (
            <>
              <div className="field-grid trio">
                {/*
                  * 數量只有新增時填得動。既有商品要改數量得走盤點——那裡會留下
                  * 「誰、什麼時候、從幾改到幾」的紀錄，直接在這裡改就沒有了。
                  */}
                {item ? (
                  <Field as="div" label="目前數量">
                    <StaticValue note="要改數量請用列表上的「盤點」。">
                      {item.quantity.toLocaleString("zh-TW")} {item.unit}
                    </StaticValue>
                  </Field>
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

              <FieldGroup>
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
          </FieldGroup>
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
            <Field as="div" label="CYBERBIZ 連結">
              {item.cyberbiz ? (
                <div className={`${LINK_PANEL} border-ok bg-ok-soft`}>
                  <div className="min-w-0">
                    <div className="cell-strong">已連結款式 {item.cyberbiz.cyberbizVariantId}</div>
                    <div className="cell-sub">
                      SKU {item.cyberbiz.sku}
                      {item.cyberbiz.syncedAt ? `・目錄同步 ${formatTime(item.cyberbiz.syncedAt)}` : ""}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col items-end gap-2">
                    <div className="cell-sub">商品身分與官網鏡像共用，若要停止庫存同步請移出 WMS。</div>
                    <Button
                      className="flex-none"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => {
                        setRepairPreview(null);
                        previewLinkRepair.reset();
                        repairLink.reset();
                        setConfirmCyberbizRepair(true);
                      }}
                    >
                      檢查並修復連結
                    </Button>
                  </div>
                </div>
              ) : (
                <div className={`${LINK_PANEL} border-line bg-canvas`}>
                  <div className="min-w-0">
                    {item.source === "cyberbiz" ? (
                      <div className="cell-strong">品項主檔已與 cyberbiz_products 同步</div>
                    ) : null}
                    <div className="cell-sub">
                      連結之後，盤點會把數量推回官網，官網的異動也同步得回來。
                    </div>
                    {!fields.sku.trim() ? (
                      <div className="cell-sub">要先填 SKU——連結是用 SKU 去官網找的。</div>
                    ) : null}
                  </div>
                  <Button
                    className="flex-none"
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
              {link.error ? <FieldHint tone="danger">{link.error.message}</FieldHint> : null}
            </Field>
          ) : null}

          {error ? <Alert tone="danger">{error.message}</Alert> : null}

    </Dialog>
    {confirmCyberbizRepair && item?.cyberbiz ? (
      <ConfirmDialog
        title={repairPreview ? "確認 CYBERBIZ 連結修復" : "檢查 CYBERBIZ 連結"}
        confirmLabel={repairPreview ? (repairPreview.changed ? "確認修復連結" : "完成") : "檢查款式"}
        tone="primary"
        pending={previewLinkRepair.isPending || repairLink.isPending}
        onCancel={() => {
          setConfirmCyberbizRepair(false);
          setRepairPreview(null);
        }}
        onConfirm={() => {
          if (!repairPreview) {
            previewLinkRepair.mutate(
              { id: item.id, productId: item.cyberbiz!.cyberbizProductId, variantId: item.cyberbiz!.cyberbizVariantId },
              { onSuccess: setRepairPreview },
            );
            return;
          }
          if (!repairPreview.changed) {
            setConfirmCyberbizRepair(false);
            return;
          }
          repairLink.mutate(
            {
              id: item.id,
              productId: repairPreview.oldProductId,
              variantId: repairPreview.oldVariantId,
              newProductId: repairPreview.newProductId,
              newVariantId: repairPreview.newVariantId,
            },
            {
              onSuccess: (result) => {
                toast.show(`連結已修復：${result.oldVariantId} → ${result.newVariantId}；官網庫存 ${result.remote.quantity}，尚未同步到 WMS`);
                setConfirmCyberbizRepair(false);
                setRepairPreview(null);
                onClose();
              },
            },
          );
        }}
      >
        {repairPreview ? (
          <>
            <p>SKU {repairPreview.sku}・{repairPreview.remote.productName}／{repairPreview.remote.variantName}</p>
            <p>款式 ID：{repairPreview.oldProductId}/{repairPreview.oldVariantId} → {repairPreview.newProductId}/{repairPreview.newVariantId}</p>
            <p>庫存：WMS {repairPreview.wmsQuantity} → 官網 {repairPreview.remote.quantity}；安全庫存：WMS {repairPreview.wmsSafetyQuantity} → 官網 {repairPreview.remote.safetyQuantity}</p>
            <p>確認前請核對款式與數量。修復只更新連結，不會修改庫存或推送數量。</p>
          </>
        ) : (
          <>
            <p>系統會重新載入 CYBERBIZ 公司倉目錄，只有 SKU 唯一且新款式未連到其他品項時才會提供修復預覽。</p>
            <p>檢查階段不會修改連結或庫存。</p>
          </>
        )}
        {previewLinkRepair.error ? <Alert tone="danger">{previewLinkRepair.error.message}</Alert> : null}
        {repairLink.error ? <Alert tone="danger">{repairLink.error.message}</Alert> : null}
      </ConfirmDialog>
    ) : null}
    </>
  );
}
