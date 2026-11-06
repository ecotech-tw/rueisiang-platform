import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Pager } from "../../shell/Pager.js";
import {
  Alert,
  Button,
  DataTable,
  FilterInput,
  FilterSelect,
  FilterToolbar,
  Page,
  PageHeader,
  Panel,
  SEARCH_INPUT_WIDTH,
  PageTabControl,
  SelectField,
  StatusBadge,
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
  type ReportSkuIgnore,
  type UnmappedProductOption,
} from "./sku-mapping-api.js";
import { SkuMappingDialog } from "./SkuMappingDialog.js";

type MappingDialogState = ProductSkuMapping | "new" | { kind: "new"; product: UnmappedProductOption };
type SkuTab = "pending" | "mapped" | "ignored";

function formatTime(value: string): string {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function matchesValues(values: string[], search: string): boolean {
  const term = search.trim().toLocaleLowerCase("zh-TW");
  return !term || values.some((value) => value.toLocaleLowerCase("zh-TW").includes(term));
}

function matchesMapping(mapping: ProductSkuMapping, search: string): boolean {
  return matchesValues([
    mapping.channel,
    mapping.externalName,
    mapping.externalSku,
    ...mapping.components.flatMap((component) => [component.sku, component.name]),
  ], search);
}

function matchesIgnore(ignore: ReportSkuIgnore, search: string): boolean {
  return matchesValues([ignore.channel, ignore.externalSku, ignore.reason], search);
}

function matchesUnmapped(product: UnmappedProductOption, search: string): boolean {
  return matchesValues([product.channel, product.externalName, product.externalSku], search);
}

export function SkuMappings() {
  usePageTitle("SKU 對應");
  const query = useProductSkuMappings();
  const remove = useDeleteProductSkuMapping();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:mapping:write");

  const [tab, setTab] = useState<SkuTab>("pending");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [channelFilter, setChannelFilter] = useState("all");
  const [mappingDialog, setMappingDialog] = useState<MappingDialogState | null>(null);
  const [deleting, setDeleting] = useState<ProductSkuMapping | null>(null);
  const ignoresQuery = useReportSkuIgnores();
  const addIgnore = useAddReportSkuIgnore();
  const removeIgnore = useDeleteReportSkuIgnore();
  const [ignoreChannel, setIgnoreChannel] = useState("cyberbiz");
  const [ignoreSku, setIgnoreSku] = useState("");
  const [ignoreReason, setIgnoreReason] = useState("");

  const data = query.data;
  const mappings = data?.mappings ?? [];
  const unmappedProducts = data?.unmappedProducts ?? [];
  const ignores = ignoresQuery.data?.ignores ?? [];
  const channels = useMemo(() => {
    const values = new Set([
      ...PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => option.value),
      ...mappings.map((mapping) => mapping.channel),
      ...unmappedProducts.map((product) => product.channel),
      ...ignores.map((ignore) => ignore.channel),
    ]);
    return [...values].sort((a, b) => productSkuChannelLabel(a).localeCompare(productSkuChannelLabel(b), "zh-TW"));
  }, [ignores, mappings, unmappedProducts]);
  const visibleMappings = mappings.filter((mapping) =>
    (channelFilter === "all" || mapping.channel === channelFilter) && matchesMapping(mapping, search),
  );
  const visibleUnmapped = unmappedProducts.filter((product) =>
    (channelFilter === "all" || product.channel === channelFilter) && matchesUnmapped(product, search),
  );
  const visibleIgnores = ignores.filter((ignore) =>
    (channelFilter === "all" || ignore.channel === channelFilter) && matchesIgnore(ignore, search),
  );
  const visibleCount = tab === "pending" ? visibleUnmapped.length : tab === "mapped" ? visibleMappings.length : visibleIgnores.length;
  const totalPages = Math.max(1, Math.ceil(visibleCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pagedMappings = visibleMappings.slice(start, start + pageSize);
  const pagedUnmapped = visibleUnmapped.slice(start, start + pageSize);
  const pagedIgnores = visibleIgnores.slice(start, start + pageSize);

  function changeTab(next: string) {
    setTab(next as SkuTab);
    setPage(1);
    setSearch("");
    setChannelFilter("all");
  }

  return (
    <Page layout="fills">
      <PageHeader
        title="SKU 對應"
        description="在品項管理集中設定通路商品要扣哪些品項；不同通路指到同一個用料，報表就會統計成同一個商品。"
        actions={canWrite ? (
          <Button icon="plus" mobileIconOnly onClick={() => setMappingDialog("new")} aria-label="新增對應">
            <span>新增對應</span>
          </Button>
        ) : null}
      />

      <PageTabControl
        label="SKU 對應狀態"
        value={tab}
        onChange={changeTab}
        options={[
          { value: "pending", label: "待處理", icon: "clock" },
          { value: "mapped", label: "已對應", icon: "check" },
          { value: "ignored", label: "忽略", icon: "block" },
        ]}
      />

      <Panel grows>
        <FilterToolbar>
          <FilterInput
            label="搜尋"
            className={SEARCH_INPUT_WIDTH}
            type="search"
            placeholder={tab === "ignored" ? "搜尋外部 SKU 或忽略原因" : "搜尋平台商品、外部 SKU 或品項 SKU"}
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
          <FilterSelect
            label="平台"
            value={channelFilter}
            onChange={(event) => { setChannelFilter(event.target.value); setPage(1); }}
            options={[{ value: "all", label: "全部平台" }, ...channels.map((value) => ({ value, label: productSkuChannelLabel(value) }))]}
          />
          {search || channelFilter !== "all" ? (
            <Button variant="link" onClick={() => { setSearch(""); setChannelFilter("all"); setPage(1); }}>
              清除篩選
            </Button>
          ) : null}
        </FilterToolbar>

        {tab !== "ignored" && query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {tab === "ignored" && ignoresQuery.error ? <Alert tone="danger">{ignoresQuery.error.message}</Alert> : null}
        {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}

        {tab === "pending" ? (
          <>
            {pagedUnmapped.length ? (
              <DataTable>
                <thead><tr><th>平台</th><th>外部商品</th><th>最近出現</th><th className="numeric">資料列</th><th /></tr></thead>
                <tbody>
                  {pagedUnmapped.map((product) => (
                    <tr key={`${product.channel}:${product.externalSku}`}>
                      <td data-label="平台"><StatusBadge palette="amber">{productSkuChannelLabel(product.channel)}</StatusBadge></td>
                      <td data-label="外部商品"><span className="cell-strong">{product.externalName || "未提供名稱"}</span><small className="cell-sub"><code>{product.externalSku}</code></small></td>
                      <td data-label="最近出現" className="cell-sub">{formatTime(product.lastSeenAt)}</td>
                      <td data-label="資料列" className="numeric">{product.rowCount.toLocaleString("zh-TW")}</td>
                      <td data-label="操作">{canWrite ? <Button variant="secondary" onClick={() => setMappingDialog({ kind: "new", product })}>建立對應</Button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : <p className="muted table-note">{query.isPending ? "載入中…" : query.error ? "待處理商品載入失敗。" : unmappedProducts.length === 0 ? "目前沒有待建立對應的外部商品。已建立對應或標記忽略的商品不會顯示在這裡。" : "沒有符合條件的外部商品，請調整搜尋或篩選。"}</p>}
          </>
        ) : null}

        {tab === "mapped" ? (
          <>
            {pagedMappings.length ? (
              <DataTable>
                <thead><tr><th>平台</th><th>平台商品</th><th>外部 SKU</th><th>組合用料</th><th>建立時間</th>{canWrite ? <th /> : null}</tr></thead>
                <tbody>
                  {pagedMappings.map((mapping) => (
                    <tr key={mapping.id}>
                      <td data-label="平台"><StatusBadge palette="slate">{productSkuChannelLabel(mapping.channel)}</StatusBadge></td>
                      <td data-label="平台商品"><div className="cell-strong">{mapping.externalName || "未設定通路商品名稱"}</div></td>
                      <td data-label="外部 SKU"><span className="cell-strong">{mapping.externalSku}</span></td>
                      <td data-label="組合用料">{mapping.components.map((component) => (
                        <div className="cell-sub" key={component.itemId}>
                          {component.sku} × {component.quantity}
                          {component.source === "custom" ? <StatusBadge palette="slate">舊自訂</StatusBadge> : null}
                        </div>
                      ))}</td>
                      <td data-label="建立時間" className="cell-sub whitespace-nowrap">{formatTime(mapping.createdAt)}</td>
                      {canWrite ? <td data-label="操作"><div className="row-actions">
                        <Button variant="icon" icon="edit" title={`編輯外部 SKU ${mapping.externalSku}`} aria-label={`編輯外部 SKU ${mapping.externalSku}`} disabled={remove.isPending} onClick={() => setMappingDialog(mapping)} />
                        <Button variant="icon" tone="danger" icon="trash" title={`移除外部 SKU ${mapping.externalSku}`} aria-label={`移除外部 SKU ${mapping.externalSku}`} disabled={remove.isPending} onClick={() => setDeleting(mapping)} />
                      </div></td> : null}
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : <p className="muted table-note">{query.isPending ? "載入中…" : query.error ? "SKU 對應載入失敗。" : mappings.length === 0 ? "還沒有任何外部 SKU 對應。" : "沒有符合條件的對應，請調整搜尋或篩選。"}</p>}
          </>
        ) : null}

        {tab === "ignored" ? (
          <>
            {canWrite ? (
              <div className="flex flex-wrap items-end gap-2.5 border-b border-soft-line pb-4 max-[760px]:gap-2">
                <SelectField label="平台" value={ignoreChannel} onChange={(event) => setIgnoreChannel(event.target.value)} options={PRODUCT_SKU_CHANNEL_OPTIONS.map((option) => ({ label: option.label, value: option.value }))} />
                <TextField label="外部 SKU" placeholder="例如 51210161926_224686824526" value={ignoreSku} onChange={(event) => setIgnoreSku(event.target.value)} />
                <TextField label="原因" placeholder="例如 補寄用" value={ignoreReason} onChange={(event) => setIgnoreReason(event.target.value)} />
                <Button icon="plus" size="lg" disabled={!ignoreSku.trim() || addIgnore.isPending} loading={addIgnore.isPending} loadingLabel="加入中…" onClick={() => addIgnore.mutate(
                  { channel: ignoreChannel, externalSku: ignoreSku.trim(), reason: ignoreReason.trim() },
                  { onSuccess: (result) => { setIgnoreSku(""); setIgnoreReason(""); toast.show(`已標記${productSkuChannelLabel(result.channel)} SKU「${result.externalSku}」不納入報表`); } },
                )}>加入忽略</Button>
              </div>
            ) : null}
            {addIgnore.error ? <Alert tone="danger">{addIgnore.error.message}</Alert> : null}
            {removeIgnore.error ? <Alert tone="danger">{removeIgnore.error.message}</Alert> : null}
            {pagedIgnores.length ? (
              <DataTable>
                <thead><tr><th>平台</th><th>外部 SKU</th><th>原因</th><th>標記時間</th>{canWrite ? <th /> : null}</tr></thead>
                <tbody>{pagedIgnores.map((ignore) => (
                  <tr key={ignore.id}>
                    <td data-label="平台"><StatusBadge palette="slate">{productSkuChannelLabel(ignore.channel)}</StatusBadge></td>
                    <td data-label="外部 SKU"><span className="cell-strong">{ignore.externalSku}</span></td>
                    <td data-label="原因" className="cell-sub">{ignore.reason || "—"}</td>
                    <td data-label="標記時間" className="cell-sub whitespace-nowrap">{formatTime(ignore.createdAt)}</td>
                    {canWrite ? <td data-label="操作"><Button variant="link" disabled={removeIgnore.isPending} onClick={() => removeIgnore.mutate(ignore.id, { onSuccess: () => toast.show(`已取消忽略「${ignore.externalSku}」`) })}>取消忽略</Button></td> : null}
                  </tr>
                ))}</tbody>
              </DataTable>
            ) : <p className="muted table-note">{ignoresQuery.isPending ? "載入中…" : ignoresQuery.error ? "忽略清單載入失敗。" : ignores.length === 0 ? "目前沒有標記忽略的外部 SKU。" : "沒有符合條件的項目，請調整搜尋或篩選。"}</p>}
          </>
        ) : null}

        {visibleCount > 0 ? (
          <Pager
            className="mt-4 shrink-0"
            page={currentPage}
            pageSize={pageSize}
            pageSizes={[10, 25, 50, 100]}
            totalPages={totalPages}
            totalLabel={`共 ${visibleCount.toLocaleString("zh-TW")} 筆`}
            onPage={setPage}
            onPageSize={(next) => { setPageSize(next); setPage(1); }}
          />
        ) : null}
      </Panel>

      {mappingDialog ? (
        <SkuMappingDialog
          items={data?.items ?? []}
          initialExternalProduct={mappingDialog === "new" || "id" in mappingDialog ? undefined : mappingDialog.product}
          key={mappingDialog === "new" ? "new" : "id" in mappingDialog ? mappingDialog.id : `new:${mappingDialog.product.externalSku}`}
          mapping={mappingDialog === "new" || !("id" in mappingDialog) ? undefined : mappingDialog}
          onClose={() => setMappingDialog(null)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="移除這筆 SKU 對應？"
          confirmLabel="移除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(
            { mappingId: deleting.id },
            { onSuccess: () => { toast.show(`已移除${productSkuChannelLabel(deleting.channel)} SKU「${deleting.externalSku}」`); setDeleting(null); } },
          )}
        >
          <p>{productSkuChannelLabel(deleting.channel)} 商品 <strong>{deleting.externalName || deleting.externalSku}</strong> 將不再對應到任何組合用料。</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
