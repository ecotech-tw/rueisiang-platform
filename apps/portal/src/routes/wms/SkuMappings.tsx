import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import {
  Alert,
  Button,
  FilterInput,
  FilterSelect,
  PageHeader,
  Panel,
} from "../../ui/index.js";
import {
  useDeleteProductSkuMapping,
  useProductSkuMappings,
  productSkuChannelLabel,
  type ProductSkuMapping,
} from "./api.js";
import { SkuMappingDialog } from "./SkuMappingDialog.js";

function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function matches(mapping: ProductSkuMapping, search: string): boolean {
  if (!search) return true;
  return [
    mapping.channel,
    mapping.externalName,
    mapping.externalSku,
    ...mapping.components.flatMap((component) => [component.sku, component.name, component.category]),
  ]
    .some((value) => value.toLocaleLowerCase("zh-TW").includes(search));
}

export function SkuMappings() {
  usePageTitle("SKU 對應");
  const query = useProductSkuMappings();
  const remove = useDeleteProductSkuMapping();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:inventory:write");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [mappingDialog, setMappingDialog] = useState<ProductSkuMapping | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProductSkuMapping | null>(null);

  const data = query.data;
  const mappings = data?.mappings ?? [];
  const items = data?.items ?? [];
  const channels = useMemo(
    () => [...new Set(mappings.map((mapping) => mapping.channel))].sort((a, b) => productSkuChannelLabel(a).localeCompare(productSkuChannelLabel(b), "zh-TW")),
    [mappings],
  );
  const categories = data?.categories ?? [];
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-TW");
    return mappings.filter((mapping) =>
      (channelFilter === "all" || mapping.channel === channelFilter)
      && (category === "all" || mapping.components.some((component) => component.category === category))
      && matches(mapping, term),
    );
  }, [category, channelFilter, mappings, search]);
  return (
    <div className="page fills">
      <PageHeader
        title="SKU 對應"
        description={<>把通路商品對應到一個以上的組合用料。用料可以是 WMS 商品，也可以是不入庫的自訂 SKU——不同通路指到同一個自訂 SKU，報表就會統計成同一個商品。</>}
      />

      {canWrite ? (
        <Panel title="新增對應" description="填寫通路商品資料，再設定至少一個組合用料；一對一商品的用料數量填 1。">
          <Button icon="plus" onClick={() => setMappingDialog("new")}>
            新增對應
          </Button>
        </Panel>
      ) : null}

      <Panel
        className="grows"
        title="目前對應"
        description={`共 ${visible.length.toLocaleString("zh-TW")} 筆${visible.length !== mappings.length ? `（全部 ${mappings.length.toLocaleString("zh-TW")} 筆）` : ""}`}
      >
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput
            label="搜尋"
            className="search-input"
            type="search"
            placeholder="搜尋通路商品、外部 SKU、WMS SKU 或分類"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <FilterSelect
            label="通路"
            value={channelFilter}
            onChange={(event) => setChannelFilter(event.target.value)}
            options={[{ value: "all", label: "全部通路" }, ...channels.map((value) => ({ value, label: productSkuChannelLabel(value) }))]}
          />
          <FilterSelect
            label="分類"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            options={[{ value: "all", label: "全部分類" }, ...categories.map((value) => ({ value, label: value }))]}
          />
          {search || channelFilter !== "all" || category !== "all" ? (
            <Button variant="link" onClick={() => { setSearch(""); setChannelFilter("all"); setCategory("all"); }}>
              清除篩選
            </Button>
          ) : null}
        </form>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>通路</th>
                <th>通路商品</th>
                <th>外部 SKU</th>
                <th>組合用料</th>
                <th>分類</th>
                <th>建立時間</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((mapping) => (
                <tr key={mapping.id}>
                  <td data-label="通路"><span className="status status-tone-slate">{productSkuChannelLabel(mapping.channel)}</span></td>
                  <td data-label="通路商品">
                    <div className="cell-strong">{mapping.externalName || "未設定通路商品名稱"}</div>
                  </td>
                  <td data-label="外部 SKU"><span className="cell-strong">{mapping.externalSku}</span></td>
                  <td data-label="組合用料">
                    {mapping.components.map((component) => (
                      <div className="cell-sub" key={component.customProductId ?? component.inventoryItemId ?? component.sku}>
                        {component.sku} × {component.quantity}
                        {component.source === "custom" ? <span className="status status-tone-slate">自訂</span> : null}
                      </div>
                    ))}
                  </td>
                  <td data-label="分類">
                    {[...new Set(mapping.components.map((component) => component.category))].map((name) => (
                      <span className="status status-tone-slate" key={name}>{name}</span>
                    ))}
                  </td>
                  <td data-label="建立時間" className="cell-sub whitespace-nowrap">{formatTime(mapping.createdAt)}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button
                          variant="icon"
                          icon="edit"
                          title={`編輯外部 SKU ${mapping.externalSku}`}
                          aria-label={`編輯外部 SKU ${mapping.externalSku}`}
                          disabled={remove.isPending}
                          onClick={() => setMappingDialog(mapping)}
                        />
                        <Button
                          variant="icon"
                          className="danger"
                          icon="trash"
                          title={`移除外部 SKU ${mapping.externalSku}`}
                          aria-label={`移除外部 SKU ${mapping.externalSku}`}
                          disabled={remove.isPending}
                          onClick={() => setDeleting(mapping)}
                        />
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}
        {query.data && visible.length === 0 ? (
          <p className="muted table-note">
            {mappings.length === 0 ? "還沒有任何外部 SKU 對應。" : "沒有符合條件的對應，請調整搜尋或篩選。"}
          </p>
        ) : null}
      </Panel>

      {mappingDialog ? (
        <SkuMappingDialog
          categories={categories}
          key={mappingDialog === "new" ? "new" : mappingDialog.id}
          mapping={mappingDialog === "new" ? undefined : mappingDialog}
          items={items}
          onClose={() => setMappingDialog(null)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="移除這筆 SKU 對應？"
          confirmLabel="移除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            remove.mutate(
              { mappingId: deleting.id },
              {
                onSuccess: () => {
                  toast.show(`已移除${productSkuChannelLabel(deleting.channel)} SKU「${deleting.externalSku}」`);
                  setDeleting(null);
                },
              },
            )
          }
        >
          <p>
            {productSkuChannelLabel(deleting.channel)} 商品 <strong>{deleting.externalName || deleting.externalSku}</strong> 將不再對應到任何組合用料。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
