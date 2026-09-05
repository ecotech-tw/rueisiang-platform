import { Combobox } from "@base-ui/react/combobox";
import { useState, type FormEvent } from "react";
import { useToast } from "../../shell/Toast.js";
import { Icon } from "../../shell/icons.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateProductSkuMapping,
  useUpdateProductSkuMapping,
  productSkuChannelLabel,
  PRODUCT_SKU_CHANNEL_OPTIONS,
  type ProductBundleComponentInput,
  type ProductSkuMapping,
  type ProductSkuMappingItemOption,
  type UnmappedProductOption,
} from "./sku-mapping-api.js";

interface ComponentDraft {
  itemId: string;
  quantity: string;
}

function emptyDraft(): ComponentDraft {
  return { itemId: "", quantity: "1" };
}

function itemLabel(item: ProductSkuMappingItemOption): string {
  return `${item.sku}　${item.name}`;
}

function splitShopeeSku(value: string): { productId: string; variantId: string } {
  const [productId = "", variantId = ""] = value.split("_", 2);
  return { productId, variantId };
}

function composeShopeeSku(productId: string, variantId: string): string {
  return [productId.trim(), variantId.trim()].filter(Boolean).join("_");
}

function Combo<T>({
  items,
  value,
  onChange,
  label,
  placeholder,
  emptyLabel,
  disabled = false,
  itemToStringLabel,
  renderItem,
}: {
  items: T[];
  value: T | null;
  onChange: (item: T | null) => void;
  label: string;
  placeholder: string;
  emptyLabel: string;
  disabled?: boolean;
  itemToStringLabel: (item: T | null) => string;
  renderItem: (item: T) => React.ReactNode;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <Combobox.Root
        items={items}
        value={value}
        onValueChange={onChange}
        itemToStringLabel={itemToStringLabel}
        autoHighlight
        disabled={disabled}
      >
        <Combobox.InputGroup className="combobox-group">
          <Combobox.Input className="combobox-input" placeholder={placeholder} />
          <Combobox.Clear className="combobox-clear" aria-label={`清除${label}`}><Icon name="close" /></Combobox.Clear>
          <Combobox.Trigger className="combobox-trigger" aria-label={`開啟${label}選單`}><Icon name="chevronDown" /></Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal>
          <Combobox.Positioner className="combobox-positioner">
            <Combobox.Popup className="combobox-popup">
              <Combobox.Empty>{emptyLabel}</Combobox.Empty>
              <Combobox.List>
                {(item: T) => <Combobox.Item key={itemToStringLabel(item)} value={item} className="combobox-item">{renderItem(item)}<Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

export function SkuMappingDialog({
  mapping,
  items,
  initialExternalProduct,
  onClose,
}: {
  mapping?: ProductSkuMapping;
  items: ProductSkuMappingItemOption[];
  initialExternalProduct?: UnmappedProductOption;
  onClose: () => void;
}) {
  const add = useCreateProductSkuMapping();
  const update = useUpdateProductSkuMapping();
  const toast = useToast();
  const initialExternal = !mapping ? initialExternalProduct ?? null : null;
  const initialChannel = mapping?.channel ?? initialExternal?.channel ?? "cyberbiz";
  const initialExternalSku = mapping?.externalSku ?? initialExternal?.externalSku ?? "";
  const initialShopeeSku = splitShopeeSku(initialExternalSku);
  const [channel, setChannel] = useState(initialChannel);
  const [externalName, setExternalName] = useState(mapping?.externalName ?? initialExternal?.externalName ?? "");
  const [externalSku, setExternalSku] = useState(initialExternalSku);
  const [shopeeProductId, setShopeeProductId] = useState(initialChannel === "shopee" ? initialShopeeSku.productId : "");
  const [shopeeVariantId, setShopeeVariantId] = useState(initialChannel === "shopee" ? initialShopeeSku.variantId : "");
  const [components, setComponents] = useState<ComponentDraft[]>(() => {
    if (!mapping?.components.length) return [emptyDraft()];
    return mapping.components.map((component) => ({
      itemId: component.itemId ?? component.inventoryItemId ?? component.customProductId ?? "",
      quantity: String(component.quantity),
    }));
  });
  const [validationError, setValidationError] = useState("");
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const channelOptions = PRODUCT_SKU_CHANNEL_OPTIONS.some((option) => option.value === channel)
    ? PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    : [{ label: productSkuChannelLabel(channel), value: channel }, ...PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))];

  function patchComponent(index: number, patch: Partial<ComponentDraft>) {
    setComponents((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function changeChannel(nextChannel: string) {
    if (nextChannel === "shopee" && channel !== "shopee") {
      const current = splitShopeeSku(externalSku);
      setShopeeProductId(current.productId);
      setShopeeVariantId(current.variantId);
    }
    setChannel(nextChannel);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalizedName = externalName.trim();
    const normalizedSku = channel === "shopee" ? composeShopeeSku(shopeeProductId, shopeeVariantId) : externalSku.trim();
    if (!channel.trim() || !normalizedName || !normalizedSku) {
      setValidationError(channel === "shopee" && !shopeeProductId.trim() ? "請填寫蝦皮商品 ID。" : "請完整填寫通路商品資料。");
      return;
    }
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
      if (!component.itemId) { setValidationError("請選擇品項。"); return; }
      parsed.push({ itemId: component.itemId, quantity });
    }
    const keys = parsed.map((component) => component.itemId ?? "").map((value) => value.toUpperCase());
    if (new Set(keys).size !== keys.length) { setValidationError("組合用料不可重複設定同一個商品。"); return; }
    setValidationError("");
    const input = { channel: channel.trim(), externalName: normalizedName, externalSku: normalizedSku, components: parsed };
    const done = { onSuccess: (result: { channel: string; externalSku: string }) => { toast.show(`${mapping ? "已更新" : "已新增"}${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」`); onClose(); } };
    if (mapping) update.mutate({ mappingId: mapping.id, ...input }, done);
    else add.mutate(input, done);
  }

  return (
    <Dialog
      title={mapping ? "編輯 SKU 對應" : "新增 SKU 對應"}
      titleMeta="通路商品先對應到品項列表；所有用料都直接對應到品項。"
      className="sku-mapping-dialog"
      bodyClassName="sku-mapping-dialog-body"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{ onSubmit: submit }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button><Button type="submit" loading={pending} loadingLabel="儲存中…" disabled={!externalName.trim() || (channel === "shopee" ? !shopeeProductId.trim() : !externalSku.trim()) || !channel.trim() || !components.length}>{mapping ? "儲存變更" : "新增對應"}</Button></>}
    >
      <div className="admin-form sku-mapping-form">
        <div className="field-grid">
          <SelectField label="通路" required value={channel} onChange={(event) => changeChannel(event.target.value)} options={channelOptions} disabled={pending} />
          {channel === "shopee" ? (
            <>
              <TextField label="蝦皮商品 ID" required hint="報表的商品選項貨號前半段。" value={shopeeProductId} onChange={(event) => setShopeeProductId(event.target.value)} disabled={pending} />
              <TextField label="蝦皮規格 ID" hint="沒有規格的商品留空即可。" value={shopeeVariantId} onChange={(event) => setShopeeVariantId(event.target.value)} disabled={pending} />
            </>
          ) : <TextField label="外部 SKU" required value={externalSku} onChange={(event) => setExternalSku(event.target.value)} disabled={pending} />}
        </div>
        <TextField label="通路商品名稱" required value={externalName} onChange={(event) => setExternalName(event.target.value)} disabled={pending} />

        <div className="sku-mapping-components">
          <div className="sku-mapping-components-head">
            <div><strong>對應到品項</strong><span className="cell-sub">每列直接選擇品項；若品項已納入 WMS，報表銷售時會展開扣料。</span></div>
            <Button type="button" variant="secondary" icon="plus" onClick={() => setComponents((current) => [...current, emptyDraft()])} disabled={pending}>新增用料</Button>
          </div>
          {components.map((component, index) => {
            const selectedItem = items.find((item) => item.id === component.itemId) ?? null;
            return (
              <div className="sku-mapping-component" key={index}>
                <div className="sku-mapping-component-row">
                  <Combo
                    items={items}
                    value={selectedItem}
                    onChange={(item) => patchComponent(index, { itemId: item?.id ?? "" })}
                    label="品項"
                    placeholder="搜尋 SKU 或品名"
                    emptyLabel="找不到可對應的品項"
                    disabled={pending}
                    itemToStringLabel={(item) => item ? itemLabel(item) : ""}
                    renderItem={(item) => <><strong>{item.sku}</strong><span>{item.name} · {item.category}</span></>}
                  />
                  <TextField label="數量" aria-label={`每組數量 ${index + 1}`} placeholder="1" type="number" min="1" step="1" value={component.quantity} onChange={(event) => patchComponent(index, { quantity: event.target.value })} disabled={pending} />
                  <Button type="button" variant="icon" icon="close" title={`移除用料 ${index + 1}`} aria-label={`移除用料 ${index + 1}`} onClick={() => setComponents((current) => current.filter((_item, itemIndex) => itemIndex !== index))} disabled={pending} />
                </div>
              </div>
            );
          })}
        </div>
        {validationError ? <Alert tone="danger">{validationError}</Alert> : null}
        {error ? <Alert tone="danger">{error.message}</Alert> : null}
      </div>
    </Dialog>
  );
}
