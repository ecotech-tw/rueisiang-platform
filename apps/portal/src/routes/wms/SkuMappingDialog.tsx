import { useState, type FormEvent } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateProductSkuMapping,
  useUpdateProductSkuMapping,
  productSkuChannelLabel,
  PRODUCT_SKU_CHANNEL_OPTIONS,
  type ProductBundleComponentInput,
  type ProductSkuMapping,
  type ProductSkuMappingItemOption,
} from "./api.js";

/**
 * 一列用料的編輯狀態。
 *
 * source 決定要顯示 WMS 商品下拉還是自訂 SKU 欄位；兩邊的值各自留著，使用者切來切去
 * 不會把剛填好的東西弄丟。
 */
interface ComponentDraft {
  source: "item" | "custom";
  inventoryItemId: string;
  customSku: string;
  customName: string;
  customCategory: string;
  quantity: string;
}

function emptyDraft(): ComponentDraft {
  return { source: "item", inventoryItemId: "", customSku: "", customName: "", customCategory: "", quantity: "1" };
}

export function SkuMappingDialog({
  mapping,
  items,
  categories,
  onClose,
}: {
  mapping?: ProductSkuMapping;
  items: ProductSkuMappingItemOption[];
  categories: string[];
  onClose: () => void;
}) {
  const add = useCreateProductSkuMapping();
  const update = useUpdateProductSkuMapping();
  const toast = useToast();
  const [channel, setChannel] = useState(mapping?.channel ?? "cyberbiz");
  /*
   * 通路只能從清單挑，不能自由輸入。
   *
   * resolveProductSkus 只會查 [報表通路, "legacy"]，所以打成「蝦皮」或「shoppe」會存檔成功、
   * 表格也看得到，卻對匯入完全隱形——使用者以為對應好了，報表照樣 unmapped_product。
   * 舊資料的通路（legacy 或已淘汰的值）不在清單裡，編輯時補進去才不會被迫改掉。
   */
  const channelOptions = PRODUCT_SKU_CHANNEL_OPTIONS.some((option) => option.value === channel)
    ? PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    : [
      { label: productSkuChannelLabel(channel), value: channel },
      ...PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value })),
    ];
  const [externalName, setExternalName] = useState(mapping?.externalName ?? "");
  const [externalSku, setExternalSku] = useState(mapping?.externalSku ?? "");
  const [components, setComponents] = useState<ComponentDraft[]>(() => {
    if (!mapping?.components.length) return [emptyDraft()];
    return mapping.components.map((component) => ({
      source: component.source,
      inventoryItemId: component.inventoryItemId ?? "",
      customSku: component.source === "custom" ? component.sku : "",
      customName: component.source === "custom" ? component.name : "",
      customCategory: component.source === "custom" ? component.category : "",
      quantity: String(component.quantity),
    }));
  });
  const [validationError, setValidationError] = useState("");
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const itemOptions = items
    .filter((item) => item.sku)
    .map((item) => ({ label: `${item.sku} · ${item.name}`, value: item.id }));
  /*
   * 編輯既有的自訂用料時，它的分類可能已經不在主檔裡（分類被刪掉，或就是預設的「未分類」）。
   * 不補進選項的話下拉會顯示成空白，一存檔就把原本的分類洗掉。
   */
  const usedCategories = components
    .map((component) => component.customCategory)
    .filter((name) => name && !categories.includes(name));
  const categoryOptions = [
    { label: "未分類", value: "" },
    ...[...new Set([...categories, ...usedCategories])].map((name) => ({ label: name, value: name })),
  ];

  function patchComponent(index: number, patch: Partial<ComponentDraft>) {
    setComponents((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = externalSku.trim();
    const normalizedChannel = channel.trim();
    const normalizedName = externalName.trim();
    if (!normalizedName || !normalizedChannel || !value || pending) return;

    if (!components.length) {
      setValidationError("至少要設定一個組合用料；一對一商品請新增一個用料並填 1。");
      return;
    }
    const parsed: ProductBundleComponentInput[] = [];
    for (const component of components) {
      const quantity = Number(component.quantity);
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        setValidationError("組合用料的數量必須是大於 0 的整數。");
        return;
      }
      if (component.source === "item") {
        if (!component.inventoryItemId) {
          setValidationError("請為每一列 WMS 用料選擇商品。");
          return;
        }
        parsed.push({ inventoryItemId: component.inventoryItemId, quantity });
        continue;
      }
      const customSku = component.customSku.trim();
      const customName = component.customName.trim();
      if (!customSku || !customName) {
        setValidationError("自訂用料要填寫 SKU 與商品名稱。");
        return;
      }
      parsed.push({
        customSku,
        customName,
        customCategory: component.customCategory || null,
        quantity,
      });
    }
    const itemIds = parsed.map((component) => component.inventoryItemId).filter(Boolean);
    if (new Set(itemIds).size !== itemIds.length) {
      setValidationError("組合用料不可重複選擇同一個 WMS 商品。");
      return;
    }
    const customSkus = parsed.map((component) => component.customSku?.toUpperCase()).filter(Boolean);
    if (new Set(customSkus).size !== customSkus.length) {
      setValidationError("組合用料不可重複設定同一個自訂 SKU。");
      return;
    }
    setValidationError("");

    const input = {
      channel: normalizedChannel,
      externalName: normalizedName,
      externalSku: value,
      components: parsed,
    };
    if (mapping) {
      update.mutate(
        { mappingId: mapping.id, ...input },
        {
          onSuccess: (result) => {
            toast.show(`已更新${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」`);
            onClose();
          },
        },
      );
    } else {
      add.mutate(input, {
        onSuccess: (result) => {
          toast.show(`已新增${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」`);
          onClose();
        },
      });
    }
  }

  return (
    <Dialog
      title={mapping ? "編輯 SKU 對應" : "新增 SKU 對應"}
      titleMeta="填寫通路商品資料，再設定一個以上的組合用料；一般一對一商品的數量填 1。"
      className="sku-mapping-dialog"
      bodyClassName="sku-mapping-dialog-body"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{ onSubmit: submit }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            loading={pending}
            loadingLabel="儲存中…"
            disabled={!externalName.trim() || !channel.trim() || !externalSku.trim() || !components.length}
          >
            {mapping ? "儲存變更" : "新增對應"}
          </Button>
        </>
      }
    >
      <div className="admin-form sku-mapping-form">
        <div className="field-grid">
          <TextField
            label="通路商品名稱"
            required
            autoFocus={!mapping}
            value={externalName}
            onChange={(event) => setExternalName(event.target.value)}
            placeholder="例如 買五送二再送一"
          />
          <SelectField
            label="通路"
            required
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            options={channelOptions}
          />
        </div>
        <TextField
          label="外部 SKU"
          required
          placeholder="例如蝦皮 商品ID_規格ID"
          value={externalSku}
          onChange={(event) => setExternalSku(event.target.value)}
        />

        <div className="sku-mapping-components">
          <div className="sku-mapping-components-head">
            <div>
              <strong>組合用料</strong>
              <span className="cell-sub">
                至少一項；一對一商品填一個用料、數量 1。用料可以是 WMS 商品，也可以是不入庫的自訂 SKU——
                不同通路指到同一個自訂 SKU，報表就會統計成同一個商品。
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              icon="plus"
              onClick={() => setComponents((current) => [...current, emptyDraft()])}
              disabled={pending}
            >
              新增用料
            </Button>
          </div>
          {components.map((component, index) => (
            <div className="sku-mapping-component" key={index}>
              <div className="sku-mapping-component-row">
                <SelectField
                  label=""
                  aria-label={`用料 ${index + 1} 來源`}
                  value={component.source}
                  onChange={(event) => patchComponent(index, { source: event.target.value === "custom" ? "custom" : "item" })}
                  options={[
                    { label: "WMS 商品", value: "item" },
                    { label: "自訂 SKU", value: "custom" },
                  ]}
                />
                {component.source === "item" ? (
                  <SelectField
                    label=""
                    aria-label={`組合用料 ${index + 1}`}
                    value={component.inventoryItemId}
                    onChange={(event) => patchComponent(index, { inventoryItemId: event.target.value })}
                    options={[{ label: "請選擇 WMS 商品", value: "" }, ...itemOptions]}
                  />
                ) : (
                  <TextField
                    label=""
                    aria-label={`自訂 SKU ${index + 1}`}
                    placeholder="系統 SKU，例如 ABX30001"
                    value={component.customSku}
                    onChange={(event) => patchComponent(index, { customSku: event.target.value })}
                  />
                )}
                <TextField
                  label=""
                  aria-label={`每組數量 ${index + 1}`}
                  placeholder="每組數量"
                  type="number"
                  min="1"
                  step="1"
                  value={component.quantity}
                  onChange={(event) => patchComponent(index, { quantity: event.target.value })}
                />
                <Button
                  type="button"
                  variant="icon"
                  icon="close"
                  title={`移除用料 ${index + 1}`}
                  aria-label={`移除用料 ${index + 1}`}
                  onClick={() => setComponents((current) => current.filter((_item, itemIndex) => itemIndex !== index))}
                  disabled={pending}
                />
              </div>
              {component.source === "custom" ? (
                <div className="sku-mapping-component-row is-custom-detail">
                  <TextField
                    label=""
                    aria-label={`自訂商品名稱 ${index + 1}`}
                    placeholder="報表顯示的商品名稱"
                    value={component.customName}
                    onChange={(event) => patchComponent(index, { customName: event.target.value })}
                  />
                  <SelectField
                    label=""
                    aria-label={`自訂商品分類 ${index + 1}`}
                    value={component.customCategory}
                    onChange={(event) => patchComponent(index, { customCategory: event.target.value })}
                    options={categoryOptions}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {validationError ? <Alert tone="danger">{validationError}</Alert> : null}
        {error ? <Alert tone="danger">{error.message}</Alert> : null}
      </div>
    </Dialog>
  );
}
