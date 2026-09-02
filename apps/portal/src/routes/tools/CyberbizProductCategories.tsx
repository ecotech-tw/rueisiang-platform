import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, SelectField } from "../../ui/index.js";
import {
  useProductCategoryManagement,
  useSetCyberbizProductCategory,
  type CyberbizProductCategoryProduct,
  type ProductCategoryOption,
} from "./product-category-api.js";
import { ProductCategoryManagementDialog } from "./ProductCategoryManagement.js";

function matches(product: CyberbizProductCategoryProduct, term: string): boolean {
  if (!term) return true;
  return [product.sku, product.name, product.categoryName ?? ""]
    .some((value) => value.toLocaleLowerCase("zh-Hant").includes(term));
}

function CategoryEditor({
  product,
  categories,
  pending,
  error,
  onSave,
  onClose,
}: {
  product: CyberbizProductCategoryProduct;
  categories: ProductCategoryOption[];
  pending: boolean;
  error: Error | null;
  onSave: (categoryId: string | null) => void;
  onClose: () => void;
}) {
  const [categoryId, setCategoryId] = useState(product.categoryId ?? "");
  return (
    <Dialog
      title={`設定「${product.name}」的商品分類`}
      titleMeta={`SKU：${product.sku}`}
      onClose={onClose}
      closeDisabled={pending}
      formProps={{ onSubmit: (event) => { event.preventDefault(); onSave(categoryId || null); } }}
      actions={(
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" loading={pending} loadingLabel="儲存中…">儲存分類</Button>
        </>
      )}
    >
      <p className="muted">設定目前分類。建立報表時會把分類名稱寫入當期資料，之後改名不會改寫歷史報表。</p>
      <SelectField
        label="商品分類"
        value={categoryId}
        onChange={(event) => setCategoryId(event.target.value)}
        options={[
          { label: "未分類", value: "" },
          ...categories.map((item) => ({ label: `${item.name}（${item.skuCount} 個 SKU）`, value: item.id })),
        ]}
        disabled={pending}
      />
      {error ? <Alert tone="danger">{error.message}</Alert> : null}
    </Dialog>
  );
}

export function CyberbizProductCategories() {
  usePageTitle("商品分類管理");
  const { permissions } = useSession();
  const canWrite = permissions.has("tools:product-category:write");
  const query = useProductCategoryManagement();
  const setCategory = useSetCyberbizProductCategory();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<CyberbizProductCategoryProduct | null>(null);
  const [categoryManagementOpen, setCategoryManagementOpen] = useState(false);

  const data = query.data;
  const products = data?.products ?? [];
  const categories = data?.categories ?? [];
  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-Hant");
    return products.filter((product) => matches(product, term));
  }, [products, search]);

  if (query.isPending) return <div className="boot">載入商品分類管理中…</div>;

  return (
    <div className="page fills product-category-page">
      <PageHeader
        title="商品分類管理"
        description="把 CYBERBIZ 商品指定到報表分類；分類主檔可從右上角「管理分類」開啟。"
        actions={<Button icon="tune" onClick={() => setCategoryManagementOpen(true)}>管理分類</Button>}
      />

      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}

      <Panel
        className="product-category-summary"
        title="分類清單"
        description="目前可指定給 CYBERBIZ SKU 的分類；建立、改名與刪除請從右上角「管理分類」開啟。"
      >
        {categories.length ? (
          <div className="product-category-chip-list" aria-label="商品分類清單">
            {categories.slice(0, 12).map((category) => (
              <span className={`product-category-chip status-tone-${category.color}`} key={category.id} title={`${category.name}：${category.usageCount} 個使用中`}>
                <span className="product-category-chip-name">{category.name}</span>
                <small>{category.usageCount}</small>
              </span>
            ))}
            {categories.length > 12 ? <span className="product-category-chip product-category-chip-more">＋{categories.length - 12} 個</span> : null}
          </div>
        ) : (
          <div className="empty-card">
            <Icon name="category" />
            <strong>還沒有商品分類</strong>
            <p className="muted">請先從右上角「管理分類」建立第一個分類。</p>
          </div>
        )}
      </Panel>

      <Panel
        className="grows product-category-products"
        title="CYBERBIZ 商品"
        actions={(
          <form className="admin-form toolbar product-category-search" onSubmit={(event) => event.preventDefault()}>
            <FilterInput
              label="搜尋商品"
              className="search-input"
              type="search"
              placeholder="商品名稱、SKU 或分類"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search ? <Button variant="link" onClick={() => setSearch("")}>清除搜尋</Button> : null}
          </form>
        )}
      >
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>商品</th><th>SKU</th><th>狀態</th><th>分類</th>{canWrite ? <th /> : null}</tr></thead>
            <tbody>
              {visible.map((product) => (
                <tr key={product.sku}>
                  <td data-label="商品"><span className="cell-strong">{product.name}</span></td>
                  <td data-label="SKU"><code>{product.sku}</code></td>
                  <td data-label="狀態"><span className={`status ${product.published ? "status-tone-mint" : "status-tone-slate"}`}>{product.published ? "販售中" : "已下架"}</span></td>
                  <td data-label="分類">
                    {product.categoryName ? (
                      <span className={`status status-tone-${product.categoryColor ?? "slate"}`}>{product.categoryName}</span>
                    ) : <span className="cell-sub">未分類</span>}
                  </td>
                  {canWrite ? (
                    <td data-label="操作">
                      <Button
                        variant="icon"
                        icon="edit"
                        title={`設定 ${product.sku} 的商品分類`}
                        aria-label={`設定 ${product.sku} 的商品分類`}
                        disabled={setCategory.isPending}
                        onClick={() => {
                          setCategory.reset();
                          setEditing(product);
                        }}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 ? <p className="muted table-note">沒有符合搜尋條件的 CYBERBIZ 商品。</p> : null}
      </Panel>

      {editing ? (
        <CategoryEditor
          key={editing.sku}
          product={editing}
          categories={categories}
          pending={setCategory.isPending}
          error={setCategory.error}
          onClose={() => setEditing(null)}
          onSave={(categoryId) => setCategory.mutate(
            { sku: editing.sku, categoryId },
            {
              onSuccess: (result) => {
                toast.show(result.categoryName ? `已將 ${result.sku} 分到「${result.categoryName}」` : `已清除 ${result.sku} 的商品分類`);
                setEditing(null);
              },
            },
          )}
        />
      ) : null}

      {categoryManagementOpen ? <ProductCategoryManagementDialog onClose={() => setCategoryManagementOpen(false)} /> : null}

    </div>
  );
}
