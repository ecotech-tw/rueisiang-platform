import { useState, type FormEvent } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateProductSkuMapping,
  useUpdateProductSkuMapping,
  productSkuChannelLabel,
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
  const [itemId, setItemId] = useState(mapping?.inventoryItemId ?? "");
  const [channel, setChannel] = useState(mapping?.channel ?? "cyberbiz");
  const [externalSku, setExternalSku] = useState(mapping?.externalSku ?? "");
  const [components, setComponents] = useState<ComponentDraft[]>(
    () => mapping?.components.map((component) => ({
      inventoryItemId: component.inventoryItemId,
      quantity: String(component.quantity),
    })) ?? [],
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
    if (!itemId || !normalizedChannel || !value || pending) return;

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
    setValidationError("");

    const input = {
      inventoryItemId: itemId,
      channel: normalizedChannel,
      externalSku: value,
      components: parsedComponents.length ? parsedComponents : undefined,
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
      titleMeta="一般商品直接選 WMS 商品；組合商品可再設定多個用料與每組數量。"
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
          <Button type="submit" loading={pending} loadingLabel="儲存中…" disabled={!itemId || !channel.trim() || !externalSku.trim()}>
            {mapping ? "儲存變更" : "新增對應"}
          </Button>
        </>
      }
    >
      <div className="admin-form sku-mapping-form">
        <div className="field-grid">
          <TextField
            label="通路"
            required
            autoFocus={!mapping}
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            placeholder="例如 cyberbiz、shopee、momo"
          />
          <SelectField
            label="WMS 商品"
            required
            value={itemId}
            onChange={(event) => setItemId(event.target.value)}
            options={[{ label: "請選擇商品", value: "" }, ...itemOptions]}
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
              <span className="cell-sub">可留空；留空就是一對一對應</span>
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
            <div className="sku-mapping-component-row" key={`${index}-${component.inventoryItemId}`}>
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
