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
  useCyberbizProducts,
  type ProductBundleComponentInput,
  type ProductSkuMapping,
  type ProductSkuMappingItemOption,
  type UnmappedProductOption,
} from "./sku-mapping-api.js";

interface ComponentDraft {
  source: "item" | "cyberbiz" | "custom";
  value: string;
  customName: string;
  customCategory: string;
  quantity: string;
}

function emptyDraft(): ComponentDraft {
  return { source: "cyberbiz", value: "", customName: "", customCategory: "", quantity: "1" };
}

function itemLabel(item: ProductSkuMappingItemOption): string {
  return `${item.sku}　${item.name}`;
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

function CategoryPicker({ value, categories, onChange, disabled }: { value: string; categories: string[]; onChange: (value: string) => void; disabled: boolean }) {
  const options = [{ id: "", name: "未分類" }, ...categories.map((name) => ({ id: name, name }))];
  const selected = options.find((option) => option.id === value) ?? null;
  return (
    <Combo
      items={options}
      value={selected}
      onChange={(option) => onChange(option?.id ?? "")}
      label="商品分類"
      placeholder="搜尋或選擇分類"
      emptyLabel="找不到分類"
      disabled={disabled}
      itemToStringLabel={(option) => option?.name ?? ""}
      renderItem={(option) => <span>{option.name}</span>}
    />
  );
}

function ExternalProductPicker({ options, value, onChange, disabled }: { options: UnmappedProductOption[]; value: UnmappedProductOption | null; onChange: (value: UnmappedProductOption | null) => void; disabled: boolean }) {
  return (
    <Combo
      items={options}
      value={value}
      onChange={onChange}
      label="待處理外部商品"
      placeholder="搜尋外部 SKU 或商品名稱"
      emptyLabel="目前沒有待處理的外部商品"
      disabled={disabled}
      itemToStringLabel={(option) => option ? `${option.externalSku} ${option.externalName}` : ""}
      renderItem={(option) => <><strong>{option.externalSku}</strong><span>{option.externalName || "尚未提供商品名稱"} · {productSkuChannelLabel(option.channel)}</span></>}
    />
  );
}

export function SkuMappingDialog({
  mapping,
  categories,
  items,
  unmappedProducts,
  initialExternalProduct,
  onClose,
}: {
  mapping?: ProductSkuMapping;
  categories: string[];
  items: ProductSkuMappingItemOption[];
  unmappedProducts: UnmappedProductOption[];
  initialExternalProduct?: UnmappedProductOption;
  onClose: () => void;
}) {
  const add = useCreateProductSkuMapping();
  const update = useUpdateProductSkuMapping();
  const toast = useToast();
  const initialExternal = !mapping ? initialExternalProduct ?? unmappedProducts[0] ?? null : null;
  const [entryMode, setEntryMode] = useState<"unmapped" | "manual">(mapping || !initialExternal ? "manual" : "unmapped");
  const [externalProduct, setExternalProduct] = useState<UnmappedProductOption | null>(initialExternal);
  const [channel, setChannel] = useState(mapping?.channel ?? initialExternal?.channel ?? "cyberbiz");
  const [externalName, setExternalName] = useState(mapping?.externalName ?? initialExternal?.externalName ?? "");
  const [externalSku, setExternalSku] = useState(mapping?.externalSku ?? initialExternal?.externalSku ?? "");
  const [components, setComponents] = useState<ComponentDraft[]>(() => {
    if (!mapping?.components.length) return [emptyDraft()];
    return mapping.components.map((component) => ({
      source: component.source,
      value: component.source === "item" ? component.inventoryItemId ?? "" : component.source === "cyberbiz" ? component.cyberbizSku ?? component.sku : component.sku,
      customName: component.source === "custom" ? component.name : "",
      customCategory: component.source === "custom" ? component.category : "",
      quantity: String(component.quantity),
    }));
  });
  const [validationError, setValidationError] = useState("");
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  const cyberbizProducts = useCyberbizProducts().data?.products ?? [];
  const cyberbizBySku = new Map(cyberbizProducts.map((product) => [product.sku, product]));
  const usedCategories = components.map((component) => component.customCategory).filter((name) => name && !categories.includes(name));
  const categoryOptions = [...new Set([...categories, ...usedCategories])];
  const channelOptions = PRODUCT_SKU_CHANNEL_OPTIONS.some((option) => option.value === channel)
    ? PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    : [{ label: productSkuChannelLabel(channel), value: channel }, ...PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))];

  function patchComponent(index: number, patch: Partial<ComponentDraft>) {
    setComponents((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function selectExternalProduct(product: UnmappedProductOption | null) {
    setExternalProduct(product);
    if (!product) return;
    setChannel(product.channel);
    setExternalSku(product.externalSku);
    setExternalName(product.externalName || product.externalSku);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const normalizedName = externalName.trim();
    const normalizedSku = externalSku.trim();
    if (!channel.trim() || !normalizedName || !normalizedSku) return;
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
        if (!component.value) { setValidationError("請選擇 WMS 品項。"); return; }
        parsed.push({ inventoryItemId: component.value, quantity });
      } else if (component.source === "cyberbiz") {
        if (!component.value) { setValidationError("請選擇 CYBERBIZ 商品。"); return; }
        parsed.push({ cyberbizSku: component.value, quantity });
      } else {
        const customSku = component.value.trim();
        const customName = component.customName.trim();
        if (!customSku || !customName) { setValidationError("自訂商品要填寫 SKU 與商品名稱。"); return; }
        parsed.push({ customSku, customName, customCategory: component.customCategory || null, quantity });
      }
    }
    const keys = parsed.map((component) => component.inventoryItemId ?? component.cyberbizSku ?? component.customSku ?? "").map((value) => value.toUpperCase());
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
      titleMeta="通路商品先對應到 WMS 品項；沒有入庫管理的材料才使用自訂商品。"
      className="sku-mapping-dialog"
      bodyClassName="sku-mapping-dialog-body"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{ onSubmit: submit }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button><Button type="submit" loading={pending} loadingLabel="儲存中…" disabled={!externalName.trim() || !externalSku.trim() || !channel.trim() || !components.length}>{mapping ? "儲存變更" : "新增對應"}</Button></>}
    >
      <div className="admin-form sku-mapping-form">
        {!mapping ? (
          <>
            <SelectField
              label="建立方式"
              value={entryMode}
              onChange={(event) => setEntryMode(event.target.value === "unmapped" ? "unmapped" : "manual")}
              options={[
                ...(unmappedProducts.length ? [{ label: "從待處理外部商品選擇", value: "unmapped" }] : []),
                { label: "手動建立預先對應", value: "manual" },
              ]}
              disabled={pending}
            />
            {entryMode === "unmapped" ? <ExternalProductPicker options={unmappedProducts} value={externalProduct} onChange={selectExternalProduct} disabled={pending} /> : null}
          </>
        ) : null}
        <div className="field-grid">
          <SelectField label="通路" required value={channel} onChange={(event) => setChannel(event.target.value)} options={channelOptions} disabled={pending} />
          <TextField label="外部 SKU" required value={externalSku} onChange={(event) => setExternalSku(event.target.value)} readOnly={!mapping && entryMode === "unmapped"} disabled={pending} />
        </div>
        <TextField label="通路商品名稱" required value={externalName} onChange={(event) => setExternalName(event.target.value)} readOnly={!mapping && entryMode === "unmapped"} disabled={pending} />

        <div className="sku-mapping-components">
          <div className="sku-mapping-components-head">
            <div><strong>對應到 WMS 品項</strong><span className="cell-sub">WMS 品項會隨報表銷售量展開扣料；自訂商品不會建立庫存。</span></div>
            <Button type="button" variant="secondary" icon="plus" onClick={() => setComponents((current) => [...current, emptyDraft()])} disabled={pending}>新增用料</Button>
          </div>
          {components.map((component, index) => {
            const selectedItem = items.find((item) => item.id === component.value) ?? null;
            const selectedCyberbiz = cyberbizBySku.get(component.value) ?? null;
            return (
              <div className="sku-mapping-component" key={index}>
                <div className="sku-mapping-component-row">
                  <SelectField
                    label=""
                    aria-label={`用料 ${index + 1} 來源`}
                    value={component.source}
                    onChange={(event) => patchComponent(index, { source: event.target.value as ComponentDraft["source"], value: "", customName: "", customCategory: "" })}
                    options={[{ label: "WMS 品項", value: "item" }, { label: "CYBERBIZ 商品", value: "cyberbiz" }, { label: "自訂商品（不入庫）", value: "custom" }]}
                    disabled={pending}
                  />
                  {component.source === "item" ? (
                    <Combo
                      items={items}
                      value={selectedItem}
                      onChange={(item) => patchComponent(index, { value: item?.id ?? "" })}
                      label=""
                      placeholder="搜尋 WMS SKU 或品名"
                      emptyLabel="找不到 WMS 品項"
                      disabled={pending}
                      itemToStringLabel={(item) => item ? itemLabel(item) : ""}
                      renderItem={(item) => <><strong>{item.sku}</strong><span>{item.name} · {item.category}</span></>}
                    />
                  ) : component.source === "cyberbiz" ? (
                    <Combo
                      items={cyberbizProducts}
                      value={selectedCyberbiz}
                      onChange={(product) => patchComponent(index, { value: product?.sku ?? "" })}
                      label=""
                      placeholder="搜尋 CYBERBIZ SKU 或商品"
                      emptyLabel="找不到 CYBERBIZ 商品"
                      disabled={pending}
                      itemToStringLabel={(product) => product ? `${product.sku} ${product.name}` : ""}
                      renderItem={(product) => <><strong>{product.sku}</strong><span>{product.name}{product.published ? "" : "（已下架）"}</span></>}
                    />
                  ) : (
                    <TextField label="" aria-label={`自訂 SKU ${index + 1}`} placeholder="例如 GIFT-BOX" value={component.value} onChange={(event) => patchComponent(index, { value: event.target.value })} disabled={pending} />
                  )}
                  <TextField label="" aria-label={`每組數量 ${index + 1}`} placeholder="數量" type="number" min="1" step="1" value={component.quantity} onChange={(event) => patchComponent(index, { quantity: event.target.value })} disabled={pending} />
                  <Button type="button" variant="icon" icon="close" title={`移除用料 ${index + 1}`} aria-label={`移除用料 ${index + 1}`} onClick={() => setComponents((current) => current.filter((_item, itemIndex) => itemIndex !== index))} disabled={pending} />
                </div>
                {component.source === "custom" ? (
                  <div className="sku-mapping-component-row is-custom-detail">
                    <TextField label="" aria-label={`自訂商品名稱 ${index + 1}`} placeholder="報表顯示的商品名稱" value={component.customName} onChange={(event) => patchComponent(index, { customName: event.target.value })} disabled={pending} />
                    <CategoryPicker value={component.customCategory} categories={categoryOptions} onChange={(value) => patchComponent(index, { customCategory: value })} disabled={pending} />
                  </div>
                ) : null}
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
