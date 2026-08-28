import { useState, type FormEvent } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateProductSkuMapping,
  useUpdateProductSkuMapping,
  productSkuChannelLabel,
  PRODUCT_SKU_CHANNEL_OPTIONS,
  type ProductSkuMapping,
  type ProductSkuMappingItemOption,
} from "./api.js";

interface ComponentDraft {
  inventoryItemId: string;
  quantity: string;
}

export function SkuMappingDialog({
  mapping,
  items,
  onClose,
}: {
  mapping?: ProductSkuMapping;
  items: ProductSkuMappingItemOption[];
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
  const [components, setComponents] = useState<ComponentDraft[]>(
    () => {
      if (!mapping) return [];
      const existingComponents = mapping.components.length
        ? mapping.components
        : [{ inventoryItemId: mapping.inventoryItemId, quantity: 1 }];
      return existingComponents.map((component) => ({
        inventoryItemId: component.inventoryItemId,
        quantity: String(component.quantity),
      }));
    },
  );
  const [validationError, setValidationError] = useState("");
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const itemOptions = items
    .filter((item) => item.sku)
    .map((item) => ({ label: `${item.sku} · ${item.name}`, value: item.id }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = externalSku.trim();
    const normalizedChannel = channel.trim();
    const normalizedName = externalName.trim();
    if (!normalizedName || !normalizedChannel || !value || pending) return;

    const parsedComponents = components.map((component) => ({
      inventoryItemId: component.inventoryItemId,
      quantity: Number(component.quantity),
    }));
    if (parsedComponents.some((component) =>
      !component.inventoryItemId
      || !Number.isSafeInteger(component.quantity)
      || component.quantity <= 0
    )) {
      setValidationError("請完整填寫組合用料，數量必須是大於 0 的整數。 ");
      return;
    }
    if (new Set(parsedComponents.map((component) => component.inventoryItemId)).size !== parsedComponents.length) {
      setValidationError("組合用料不可重複選擇同一個 WMS 商品。 ");
      return;
    }
    if (!parsedComponents.length) {
      setValidationError("至少要設定一個組合用料；一般一對一商品請新增一個用料並填 1。 ");
      return;
    }
    setValidationError("");

    const input = {
      channel: normalizedChannel,
      externalName: normalizedName,
      externalSku: value,
      components: parsedComponents,
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
      titleMeta="填寫通路商品資料，再設定一個以上對應的 WMS 用料；一般一對一商品的數量填 1。"
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
          <Button type="submit" loading={pending} loadingLabel="儲存中…" disabled={!externalName.trim() || !channel.trim() || !externalSku.trim() || !components.length}>
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
              <span className="cell-sub">至少一項；一般一對一商品請填一個用料、數量 1</span>
            </div>
            <Button
              type="button"
              variant="secondary"
              icon="plus"
              onClick={() => setComponents((current) => [...current, { inventoryItemId: "", quantity: "1" }])}
              disabled={pending}
            >
              新增用料
            </Button>
          </div>
          {components.map((component, index) => (
            <div className="sku-mapping-component-row" key={index}>
              <SelectField
                label={`用料 ${index + 1}`}
                value={component.inventoryItemId}
                onChange={(event) => {
                  const value = event.target.value;
                  setComponents((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, inventoryItemId: value } : item));
                }}
                options={[{ label: "請選擇 WMS 商品", value: "" }, ...itemOptions]}
              />
              <TextField
                label="每組數量"
                type="number"
                min="1"
                step="1"
                value={component.quantity}
                onChange={(event) => {
                  const value = event.target.value;
                  setComponents((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, quantity: value } : item));
                }}
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
          ))}
        </div>
        {validationError ? <Alert tone="danger">{validationError}</Alert> : null}
        {error ? <Alert tone="danger">{error.message}</Alert> : null}
      </div>
    </Dialog>
  );
}
