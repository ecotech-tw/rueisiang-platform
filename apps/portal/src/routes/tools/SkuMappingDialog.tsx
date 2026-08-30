import { useState, type FormEvent } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, SelectField, TextField } from "../../ui/index.js";
import {
  useCreateProductSkuMapping,
  useUpdateProductSkuMapping,
  productSkuChannelLabel,
  PRODUCT_SKU_CHANNEL_OPTIONS,
  useCyberbizProducts,
  type ProductBundleComponentInput,
  type ProductSkuMapping,
} from "./sku-mapping-api.js";

/**
 * 一列用料的編輯狀態。
 *
 * source 決定要顯示 WMS 商品下拉還是自訂 SKU 欄位；兩邊的值各自留著，使用者切來切去
 * 不會把剛填好的東西弄丟。
 */
/*
 * 用料只有兩種來源：CYBERBIZ 商品與自訂 SKU。
 *
 * 拿掉 WMS 是因為它只會製造分裂：同一個商品在兩邊 SKU 不同時，選 WMS 或選 CYBERBIZ
 * 會讓它在報表裡變成兩行。報表回答的是「我們賣了什麼」，那件事的真相來源是官網；
 * WMS 只管「我們囤什麼」。官網沒有的東西仍然可以用自訂 SKU。
 *
 * 既有的 WMS 用料載入時轉成自訂（SKU 與名稱都沿用該商品的），報表身分完全不變，
 * 下次存檔就自然搬過去——不必為此冒險做一次資料 migration。
 */
interface ComponentDraft {
  source: "cyberbiz" | "custom";
  customSku: string;
  customName: string;
  customCategory: string;
  quantity: string;
}

function emptyDraft(): ComponentDraft {
  return { source: "cyberbiz", customSku: "", customName: "", customCategory: "", quantity: "1" };
}

export function SkuMappingDialog({
  mapping,
  categories,
  onClose,
}: {
  mapping?: ProductSkuMapping;
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
  /*
   * 蝦皮的外部 SKU 是「商品ID_規格ID」，拆成兩格填。
   *
   * 存進去的仍然是接起來的字串（那是報表的鍵，不能改）；規格留空就只有商品 ID——
   * 剛好對上 resolveProductSkus 的舊格式回退。其他通路是單一 SKU，維持一格。
   */
  const isShopee = channel === "shopee";
  const [externalSku, setExternalSku] = useState(mapping?.externalSku ?? "");
  const [shopeeProductId, setShopeeProductId] = useState(
    () => mapping?.externalSku.split("_")[0] ?? "",
  );
  const [shopeeModelId, setShopeeModelId] = useState(
    () => mapping?.externalSku.split("_").slice(1).join("_") ?? "",
  );
  const composedExternalSku = isShopee
    ? [shopeeProductId.trim(), shopeeModelId.trim()].filter(Boolean).join("_")
    : externalSku.trim();
  const [components, setComponents] = useState<ComponentDraft[]>(() => {
    if (!mapping?.components.length) return [emptyDraft()];
    return mapping.components.map((component) => ({
      // 舊的 WMS 用料轉成自訂：SKU 與名稱沿用該商品，報表寫出來的東西一模一樣。
      source: component.source === "cyberbiz" ? "cyberbiz" as const : "custom" as const,
      customSku: component.sku,
      customName: component.source === "cyberbiz" ? "" : component.name,
      customCategory: component.source === "custom" ? component.category : "",
      quantity: String(component.quantity),
    }));
  });
  const [validationError, setValidationError] = useState("");
  const pending = add.isPending || update.isPending;
  const error = add.error ?? update.error;
  /*
   * 官網商品直接從目錄挑，不用自己打 SKU 與名稱。
   *
   * 「CYBERBIZ 有、WMS 沒有」是最常見的一類用料（禮盒、贈品、加購），以前每一個都要
   * 手 key 一次。自訂仍然保留，給兩邊都查不到的東西用。
   */
  const cyberbizProducts = useCyberbizProducts().data?.products ?? [];
  const cyberbizOptions = cyberbizProducts.map((product) => ({
    label: `${product.sku} · ${product.name}${product.published ? "" : "（已下架）"}`,
    value: product.sku,
  }));
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
    const value = composedExternalSku;
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
      if (component.source === "cyberbiz") {
        if (!component.customSku.trim()) {
          setValidationError("請為每一列 CYBERBIZ 用料選擇商品。");
          return;
        }
        // 名稱與分類都由目錄鏡像即時提供，這裡只送 SKU。
        parsed.push({ cyberbizSku: component.customSku.trim(), quantity });
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
    const customSkus = parsed.map((component) => component.customSku?.toUpperCase()).filter(Boolean);
    if (new Set(customSkus).size !== customSkus.length) {
      setValidationError("組合用料不可重複設定同一個自訂 SKU。");
      return;
    }
    const catalogSkus = parsed.map((component) => component.cyberbizSku?.toUpperCase()).filter(Boolean);
    if (new Set(catalogSkus).size !== catalogSkus.length) {
      setValidationError("組合用料不可重複設定同一個 CYBERBIZ 商品。");
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
            disabled={!externalName.trim() || !channel.trim() || !composedExternalSku || !components.length}
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
        {isShopee ? (
          <div className="field-grid">
            <TextField
              label="蝦皮商品 ID"
              required
              placeholder="例如 20865536700"
              hint="報表的「商品選項貨號」前半段。"
              value={shopeeProductId}
              onChange={(event) => setShopeeProductId(event.target.value)}
            />
            <TextField
              label="蝦皮規格 ID"
              placeholder="例如 175221693438"
              hint="沒有規格的商品留空即可。"
              value={shopeeModelId}
              onChange={(event) => setShopeeModelId(event.target.value)}
            />
          </div>
        ) : (
          <TextField
            label="外部 SKU"
            required
            placeholder="例如 ABX30001"
            value={externalSku}
            onChange={(event) => setExternalSku(event.target.value)}
          />
        )}

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
                  onChange={(event) => {
                    const next = event.target.value === "custom" ? "custom" as const : "cyberbiz" as const;
                    // 換來源就清掉值，避免把上一個來源的東西帶著走。
                    patchComponent(index, { source: next, customSku: "", customName: "" });
                  }}
                  options={[
                    { label: "CYBERBIZ 商品", value: "cyberbiz" },
                    { label: "自訂 SKU", value: "custom" },
                  ]}
                />
                {component.source === "cyberbiz" ? (
                  <SelectField
                    label=""
                    aria-label={`CYBERBIZ 商品 ${index + 1}`}
                    value={component.customSku}
                    onChange={(event) => {
                      const sku = event.target.value;
                      const product = cyberbizProducts.find((candidate) => candidate.sku === sku);
                      // 名稱直接跟著官網走，使用者不必也不該自己打。
                      patchComponent(index, { customSku: sku, customName: product?.name ?? "" });
                    }}
                    options={[{ label: "請選擇 CYBERBIZ 商品", value: "" }, ...cyberbizOptions]}
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
