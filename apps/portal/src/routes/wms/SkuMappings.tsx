import { useMemo, useState, type FormEvent } from "react";
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
  SelectField,
  TextField,
} from "../../ui/index.js";
import {
  useAddProductSkuMapping,
  useDeleteProductSkuMapping,
  useProductSkuMappings,
  productSkuChannelLabel,
  type ProductSkuMapping,
} from "./api.js";

function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function matches(mapping: ProductSkuMapping, search: string): boolean {
  if (!search) return true;
  return [mapping.channel, mapping.externalSku, mapping.itemSku ?? "", mapping.itemName, mapping.itemCategory]
    .some((value) => value.toLocaleLowerCase("zh-TW").includes(search));
}

export function SkuMappings() {
  usePageTitle("SKU 對應");
  const query = useProductSkuMappings();
  const add = useAddProductSkuMapping();
  const remove = useDeleteProductSkuMapping();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:inventory:write");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [itemId, setItemId] = useState("");
  const [channel, setChannel] = useState("cyberbiz");
  const [externalSku, setExternalSku] = useState("");
  const [deleting, setDeleting] = useState<ProductSkuMapping | null>(null);

  const data = query.data;
  const mappings = data?.mappings ?? [];
  const items = data?.items ?? [];
  const channels = useMemo(
    () => [...new Set(mappings.map((mapping) => mapping.channel))].sort((a, b) => productSkuChannelLabel(a).localeCompare(productSkuChannelLabel(b), "zh-TW")),
    [mappings],
  );
  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "zh-TW")),
    [items],
  );
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-TW");
    return mappings.filter((mapping) =>
      (channelFilter === "all" || mapping.channel === channelFilter)
      && (category === "all" || mapping.itemCategory === category)
      && matches(mapping, term),
    );
  }, [category, channelFilter, mappings, search]);
  const itemOptions = useMemo(
    () => items
      .filter((item) => item.sku)
      .map((item) => ({ label: `${item.sku} · ${item.name}`, value: item.id })),
    [items],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = externalSku.trim();
    if (!itemId || !value || add.isPending) return;

    add.mutate(
      { id: itemId, channel, externalSku: value },
      {
        onSuccess: (result) => {
          setExternalSku("");
          toast.show(`已新增${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」`);
        },
      },
    );
  }

  return (
    <div className="page fills">
      <PageHeader
        title="SKU 對應"
        description={<>把蝦皮、CYBERBIZ 或其他通路的 SKU 對應到 WMS 商品，報表匯入後就能使用同一份商品名稱、正式 SKU 與分類。</>}
      />

      {canWrite ? (
        <Panel title="新增對應" description="同一個通路的外部 SKU 只能對應一個 WMS 商品。">
          <form className="admin-form row" onSubmit={submit}>
            <TextField
              label="通路"
              required
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
            <TextField
              label="外部 SKU"
              required
              placeholder="例如蝦皮 Product ID"
              value={externalSku}
              onChange={(event) => setExternalSku(event.target.value)}
            />
            <Button type="submit" loading={add.isPending} loadingLabel="新增中…" disabled={!itemId || !externalSku.trim()}>
              新增對應
            </Button>
          </form>
          {add.error ? <Alert tone="danger">{add.error.message}</Alert> : null}
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
            placeholder="搜尋外部 SKU、WMS SKU、商品或分類"
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
                <th>外部 SKU</th>
                <th>WMS 商品</th>
                <th>分類</th>
                <th>建立時間</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((mapping) => (
                <tr key={mapping.id}>
                  <td data-label="通路"><span className="status status-tone-slate">{productSkuChannelLabel(mapping.channel)}</span></td>
                  <td data-label="外部 SKU"><span className="cell-strong">{mapping.externalSku}</span></td>
                  <td data-label="WMS 商品">
                    <div className="cell-strong">{mapping.itemName}</div>
                    <div className="cell-sub">{mapping.itemSku ?? "未設定正式 SKU"}</div>
                  </td>
                  <td data-label="分類"><span className={`status status-tone-${mapping.itemCategoryColor ?? "slate"}`}>{mapping.itemCategory}</span></td>
                  <td data-label="建立時間" className="cell-sub whitespace-nowrap">{formatTime(mapping.createdAt)}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      <div className="row-actions">
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

      {deleting ? (
        <ConfirmDialog
          title="移除這筆 SKU 對應？"
          confirmLabel="移除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            remove.mutate(
              { itemId: deleting.inventoryItemId, mappingId: deleting.id },
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
            {productSkuChannelLabel(deleting.channel)} SKU <strong>{deleting.externalSku}</strong> 將不再對應到 WMS 商品「{deleting.itemName}」。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
