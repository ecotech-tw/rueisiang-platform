import { Combobox } from "@base-ui/react/combobox";
import { useMemo, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";
import {
  useExternalProductItems,
  useIgnoreReportExternalProduct,
  useReportExternalProducts,
  useResolveReportExternalProduct,
  useUnignoreReportExternalProduct,
  type ExternalProductItem,
  type ReportExternalProduct,
} from "./external-products-api.js";

function productLabel(product: ReportExternalProduct): string {
  const key = product.externalVariantKey ? `${product.externalKey} / ${product.externalVariantKey}` : product.externalKey;
  return product.externalName ? `${product.externalName}（${key}）` : key;
}

function itemLabel(item: ExternalProductItem): string {
  return `${item.sku || "無 SKU"}　${item.name}`;
}

function ItemPicker({
  items,
  value,
  onChange,
  disabled,
}: {
  items: ExternalProductItem[];
  value: ExternalProductItem | null;
  onChange: (item: ExternalProductItem | null) => void;
  disabled: boolean;
}) {
  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={onChange}
      itemToStringLabel={(item) => item ? itemLabel(item) : ""}
      autoHighlight
    >
      <Combobox.InputGroup className="combobox-group">
        <Combobox.Input className="combobox-input" placeholder="搜尋品項 SKU 或名稱" disabled={disabled} />
        <Combobox.Clear className="combobox-clear" aria-label="清除品項"><Icon name="close" /></Combobox.Clear>
        <Combobox.Trigger className="combobox-trigger" aria-label="開啟品項選單"><Icon name="chevronDown" /></Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="combobox-positioner">
          <Combobox.Popup className="combobox-popup">
            <Combobox.Empty>找不到符合的品項</Combobox.Empty>
            <Combobox.List>
              {(item: ExternalProductItem) => (
                <Combobox.Item key={item.id} value={item} className="combobox-item">
                  <strong>{item.sku || "無 SKU"}</strong><span>{item.name}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export function ExternalProducts() {
  usePageTitle("外部商品解析");
  const toast = useToast();
  const productsQuery = useReportExternalProducts();
  const itemsQuery = useExternalProductItems();
  const resolve = useResolveReportExternalProduct();
  const ignore = useIgnoreReportExternalProduct();
  const unignore = useUnignoreReportExternalProduct();
  const [selectedItems, setSelectedItems] = useState<Record<string, ExternalProductItem | null>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const products = productsQuery.data?.products ?? [];
  const items = useMemo(() => (itemsQuery.data?.items ?? []).filter((item) => item.source !== "wms"), [itemsQuery.data]);
  const pending = resolve.isPending || ignore.isPending || unignore.isPending;

  if (productsQuery.isPending) return <div className="boot">載入外部商品中…</div>;

  return (
    <div className="page fills">
      <PageHeader
        title="外部商品解析"
        description="管理報表匯入辨識到的 CYBERBIZ 外部商品；解析結果會連到共用品項主檔。"
      />
      {productsQuery.error ? <Alert tone="danger">{productsQuery.error.message}</Alert> : null}
      {itemsQuery.error ? <Alert tone="danger">品項清單載入失敗：{itemsQuery.error.message}</Alert> : null}
      <Panel
        className="grows"
        title="CYBERBIZ 外部商品"
        description={products.length ? `共 ${products.length.toLocaleString("zh-TW")} 筆已建立解析紀錄` : "目前沒有待管理的外部商品紀錄"}
      >
        {products.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>外部商品</th><th>狀態</th><th>解析到品項</th><th>忽略原因</th><th>操作</th></tr></thead>
              <tbody>
                {products.map((product) => {
                  const selected = selectedItems[product.id] ?? null;
                  const selectedItem = product.itemId ? items.find((item) => item.id === product.itemId) ?? null : selected;
                  return (
                    <tr key={product.id}>
                      <td data-label="外部商品"><span className="cell-strong">{productLabel(product)}</span></td>
                      <td data-label="狀態"><span className={`status ${product.resolution === "mapped" ? "status-tone-mint" : "status-tone-slate"}`}>{product.resolution === "mapped" ? "已解析" : "已忽略"}</span></td>
                      <td data-label="解析到品項">
                        {product.resolution === "mapped" ? <span className="cell-sub">{selectedItem ? itemLabel(selectedItem) : product.itemId}</span> : (
                          <ItemPicker items={items} value={selected} onChange={(item) => setSelectedItems((current) => ({ ...current, [product.id]: item }))} disabled={pending} />
                        )}
                      </td>
                      <td data-label="忽略原因">
                        {product.resolution === "ignored" ? (
                          <input className="text-input" value={reasons[product.id] ?? product.ignoredReason} onChange={(event) => setReasons((current) => ({ ...current, [product.id]: event.target.value }))} placeholder="可填寫原因" disabled={pending} />
                        ) : <span className="cell-sub">—</span>}
                      </td>
                      <td data-label="操作" className="row-actions">
                        {product.resolution === "mapped" ? null : (
                          <Button disabled={!selected || pending} loading={resolve.isPending} onClick={() => selected && resolve.mutate({ id: product.id, itemId: selected.id }, { onSuccess: () => toast.show(`已解析 ${productLabel(product)}`) })}>解析</Button>
                        )}
                        {product.resolution === "ignored" ? (
                          <>
                            <Button variant="secondary" disabled={pending} loading={ignore.isPending} onClick={() => ignore.mutate({ id: product.id, reason: reasons[product.id] ?? product.ignoredReason }, { onSuccess: () => toast.show("已更新忽略設定") })}>更新原因</Button>
                            <Button variant="link" disabled={pending} loading={unignore.isPending} onClick={() => unignore.mutate({ id: product.id }, { onSuccess: () => toast.show("已取消忽略") })}>取消忽略</Button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-card"><Icon name="link" /><strong>目前沒有外部商品紀錄</strong><p className="muted">報表匯入後，無法自動解析的商品會出現在這裡。</p></div>
        )}
      </Panel>
    </div>
  );
}
