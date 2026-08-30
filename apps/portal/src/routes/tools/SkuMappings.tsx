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
  SelectField,
  TextField,
} from "../../ui/index.js";
import {
  useAddReportSkuIgnore,
  useDeleteProductSkuMapping,
  useDeleteReportSkuIgnore,
  useProductSkuMappings,
  useReportSkuIgnores,
  productSkuChannelLabel,
  PRODUCT_SKU_CHANNEL_OPTIONS,
  type ProductSkuMapping,
} from "./sku-mapping-api.js";
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
  const canWrite = permissions.has("tools:sku-mapping:write");

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [mappingDialog, setMappingDialog] = useState<ProductSkuMapping | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProductSkuMapping | null>(null);
  const ignoresQuery = useReportSkuIgnores();
  const addIgnore = useAddReportSkuIgnore();
  const removeIgnore = useDeleteReportSkuIgnore();
  const [ignoreChannel, setIgnoreChannel] = useState("cyberbiz");
  const [ignoreSku, setIgnoreSku] = useState("");
  const [ignoreReason, setIgnoreReason] = useState("");
  const ignores = ignoresQuery.data?.ignores ?? [];

  const data = query.data;
  const mappings = data?.mappings ?? [];
  const channels = useMemo(
    () => [...new Set(mappings.map((mapping) => mapping.channel))].sort((a, b) => productSkuChannelLabel(a).localeCompare(productSkuChannelLabel(b), "zh-TW")),
    [mappings],
  );
  /*
   * 沒填分類的自訂用料存成「未分類」，但那不一定是分類主檔裡的一列（全新資料庫沒有）。
   * 不補進來的話那些對應在分類篩選裡選不到。
   */
  const categories = useMemo(() => {
    const names = new Set(data?.categories ?? []);
    for (const mapping of data?.mappings ?? []) {
      for (const component of mapping.components) names.add(component.category);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "zh-TW"));
  }, [data]);
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
        description="把通路商品對應到組合用料；不同通路指到同一個用料，報表就會統計成同一個商品。"
        actions={canWrite ? (
          <Button
            icon="plus"
            className="add-action"
            onClick={() => setMappingDialog("new")}
            aria-label="新增對應"
          >
            {/* 手機上文字會被 CSS 藏起來，只剩一顆圓形的 ＋。aria-label 補回名稱。 */}
            <span>新增對應</span>
          </Button>
        ) : null}
      />

      {/*
        * 忽略清單收合起來。
        *
        * 它是設定型的東西，一年動不到幾次，展開卻會把列表擠掉半個畫面——這一頁的主體
        * 是那幾十筆對應，版面要留給它。
        */}
      {canWrite ? (
        <details className="sku-ignore-details">
          <summary>
            不納入報表的外部 SKU
            <span className="cell-sub">{ignores.length ? `已標記 ${ignores.length} 筆` : "尚未標記"}</span>
          </summary>
          <div className="sku-ignore-body">
            <p className="cell-sub">補寄、已下架這類永遠不該進統計的通路 SKU。標記之後匯入會照樣略過，但不再列進「未對應」的提醒。</p>
        <div className="admin-form toolbar">
          <SelectField
            label="通路"
            value={ignoreChannel}
            onChange={(event) => setIgnoreChannel(event.target.value)}
            options={PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
          />
          <TextField
            label="外部 SKU"
            placeholder="例如 51210161926_224686824526"
            value={ignoreSku}
            onChange={(event) => setIgnoreSku(event.target.value)}
          />
          <TextField
            label="原因"
            placeholder="例如 補寄用"
            value={ignoreReason}
            onChange={(event) => setIgnoreReason(event.target.value)}
          />
          <Button
            icon="plus"
            disabled={!ignoreSku.trim() || addIgnore.isPending}
            loading={addIgnore.isPending}
            loadingLabel="加入中…"
            onClick={() => addIgnore.mutate(
              { channel: ignoreChannel, externalSku: ignoreSku.trim(), reason: ignoreReason.trim() },
              {
                onSuccess: (result) => {
                  setIgnoreSku("");
                  setIgnoreReason("");
                  toast.show(`已標記${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」不納入報表`);
                },
              },
            )}
          >
            加入
          </Button>
        </div>
        {addIgnore.error ? <Alert tone="danger">{addIgnore.error.message}</Alert> : null}
        {ignores.length ? (
          <div className="row-actions">
            {ignores.map((ignore) => (
              <span className="status status-tone-slate" key={ignore.id}>
                {productSkuChannelLabel(ignore.channel)} · {ignore.externalSku}
                {ignore.reason ? `（${ignore.reason}）` : ""}
                <button
                  type="button"
                  className="link-button"
                  aria-label={`取消忽略 ${ignore.externalSku}`}
                  disabled={removeIgnore.isPending}
                  onClick={() => removeIgnore.mutate(ignore.id, {
                    onSuccess: () => toast.show(`已取消忽略「${ignore.externalSku}」`),
                  })}
                >
                  取消
                </button>
              </span>
            ))}
          </div>
        ) : <p className="cell-sub">目前沒有標記任何 SKU。</p>}
          </div>
        </details>
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
