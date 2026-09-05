import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Combobox } from "@base-ui/react/combobox";
import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, TextField } from "../../ui/index.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Icon } from "../../shell/icons.js";
import { ItemForm } from "../wms/ItemForm.js";
import type { CyberbizCatalogProduct, ProductCategory, Zone } from "../wms/api.js";

interface ItemCatalogItem {
  id: string;
  sku: string;
  name: string;
  source: "cyberbiz" | "custom" | "wms";
  category: string;
  categoryId: string | null;
  categoryColor: string;
  inWarehouse: boolean;
  quantity: number | null;
  unit: string;
  minStock: number | null;
  notes: string;
  cyberbiz: boolean;
}

interface ItemCatalogData {
  items: ItemCatalogItem[];
  categories: ProductCategory[];
  cyberbizProducts: CyberbizCatalogProduct[];
  zones: Zone[];
}

class ItemCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemCatalogError";
  }
}

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  throw new ItemCatalogError(body?.message ?? body?.error ?? `操作失敗（${response.status}）。`);
}

async function loadItemCatalog(): Promise<ItemCatalogData> {
  const response = await fetch("/api/items/catalog", { credentials: "same-origin" });
  if (!response.ok) {
    await readError(response);
  }
  return (await response.json()) as ItemCatalogData;
}

function arrangeCategories(categories: ProductCategory[]): ProductCategory[] {
  return categories.flatMap((category) => category.parentId ? [] : [category, ...categories.filter((child) => child.parentId === category.id)]);
}

function categoryLabel(category: ProductCategory): string {
  return category.depth === 1 ? `　${category.name}` : category.name;
}

function categoryPath(category: ProductCategory, categories: ProductCategory[]): string {
  if (!category.parentId) return category.name;
  const parent = categories.find((candidate) => candidate.id === category.parentId);
  return parent ? `${parent.name} / ${category.name}` : category.name;
}

function categoryScope(categoryId: string, categories: ProductCategory[]): Set<string> {
  const ids = new Set([categoryId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const category of categories) {
      if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        expanded = true;
      }
    }
  }
  return ids;
}

function sourceLabel(item: ItemCatalogItem): string {
  if (item.source === "cyberbiz") return item.notes.includes("尚未建立") ? "CYBERBIZ 待建立品項" : "CYBERBIZ";
  if (item.source === "wms") return "WMS 過渡品項";
  return "自建品項";
}

const ALL_CATEGORY: ProductCategory = { id: "all", name: "全部分類", color: "slate", parentId: null, depth: 0 };

interface ItemCatalogGroup {
  id: string;
  label: string;
  color: string;
  items: ItemCatalogItem[];
}

function arrangeCatalogGroups(items: ItemCatalogItem[], categories: ProductCategory[]): ItemCatalogGroup[] {
  const groups: ItemCatalogGroup[] = [];
  const ordered = arrangeCategories(categories);
  for (const category of ordered) {
    const members = items.filter((item) => item.categoryId === category.id);
    if (!members.length) continue;
    groups.push({ id: category.id, label: categoryPath(category, categories), color: category.color, items: members });
  }
  const unclassified = items.filter((item) => !item.categoryId || !categories.some((category) => category.id === item.categoryId));
  if (unclassified.length) groups.push({ id: "__unclassified__", label: "未分類", color: "slate", items: unclassified });
  return groups;
}

function EditItemDialog({ item, categories, onClose }: { item: ItemCatalogItem; categories: ProductCategory[]; onClose: () => void }) {
  // 舊資料搬移期間少數商品名稱可能是 null；表單不能把它直接交給 trim，否則整頁會白屏。
  const [name, setName] = useState(item.name ?? "");
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const toast = useToast();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/items/catalog/${item.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), categoryId: categoryId || null }),
      });
      if (!response.ok) await readError(response);
      return response.json() as Promise<{ id: string }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["items", "catalog"] });
      toast.show("品項已更新");
      onClose();
    },
  });
  const valid = name.trim() !== "";
  return (
    <Dialog
      title="編輯品項"
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{ onSubmit: (event) => { event.preventDefault(); if (valid) update.mutate(); } }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>取消</Button><Button type="submit" loading={update.isPending} disabled={!valid}>儲存</Button></>}
    >
      <TextField label="品項名稱" required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      <TextField label="SKU" value={item.sku} disabled hint="SKU 是外部對應鍵，這一輪先不在 UI 直接改。" />
      <div className="field">
        <span>品項分類</span>
        <Combobox.Root
          items={arrangeCategories(categories)}
          value={categories.find((category) => category.id === categoryId) ?? null}
          onValueChange={(category) => setCategoryId(category?.id ?? "")}
          itemToStringLabel={(category) => category ? categoryPath(category, categories) : ""}
          autoHighlight
        >
          <Combobox.InputGroup className="combobox-group">
            <Combobox.Input className="combobox-input" placeholder="搜尋或選擇分類" />
            <Combobox.Clear className="combobox-clear" aria-label="清除分類"><Icon name="close" /></Combobox.Clear><Combobox.Trigger className="combobox-trigger" aria-label="開啟分類選單"><Icon name="chevronDown" /></Combobox.Trigger>
          </Combobox.InputGroup>
          <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到分類</Combobox.Empty><Combobox.List>{(category: ProductCategory) => <Combobox.Item key={category.id} value={category} className="combobox-item"><span className="combobox-category-label">{category.parentId ? <>{category.name}<small> · {categoryPath(category, categories).split(" / ")[0]}</small></> : category.name}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>
      </div>
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function Items() {
  usePageTitle("品項列表");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [editing, setEditing] = useState<"new" | { cyberbizSku: string } | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCatalogItem | null>(null);
  const query = useQuery({ queryKey: ["items", "catalog"], queryFn: loadItemCatalog, staleTime: 30_000 });
  const { permissions } = useSession();
  const canWrite = permissions.has("items:item:write");

  const items = query.data?.items ?? [];
  const categories = query.data?.categories ?? [];
  const zones = query.data?.zones ?? [];
  const cyberbizProducts = query.data?.cyberbizProducts ?? [];

  const selectedCategoryIds = useMemo(
    () => categoryId === "all" ? null : categoryScope(categoryId, categories),
    [categoryId, categories],
  );
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (selectedCategoryIds && !selectedCategoryIds.has(item.categoryId ?? "")) return false;
      if (!term) return true;
      return [item.name, item.sku ?? "", item.category, item.notes].some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [items, search, selectedCategoryIds]);
  const groups = useMemo(() => arrangeCatalogGroups(visible, categories), [categories, visible]);
  const inWarehouseCount = items.filter((item) => item.inWarehouse).length;
  const cyberbizCount = items.filter((item) => item.source === "cyberbiz").length;
  const pendingWarehouseCount = items.length - inWarehouseCount;

  return (
    <div className="page fills">
      <PageHeader
        title="品項列表"
        description="集中維護可被倉儲、SKU 對應與報表共用的品項；庫存盤點仍留在倉儲頁處理。"
        actions={canWrite ? <Button icon="plus" onClick={() => setEditing("new")}>新增品項</Button> : null}
      />

      <div className="stat-row catalog-stat-row" aria-label="品項列表摘要">
        <div className="stat"><span>品項總數</span><strong>{items.length.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>已納入倉儲</span><strong>{inWarehouseCount.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>待納入倉儲</span><strong>{pendingWarehouseCount.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>CYBERBIZ 鏡像</span><strong>{cyberbizCount.toLocaleString("zh-TW")}</strong></div>
      </div>

      <Panel className="grows" title="全部品項" description={`目前顯示 ${visible.length.toLocaleString("zh-TW")} / ${items.length.toLocaleString("zh-TW")} 項；分類標籤直接顯示在每一列。`}>
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput
            label="搜尋"
            className="search-input"
            type="search"
            placeholder="搜尋品名、SKU、分類或備註"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <label className="field catalog-category-filter">
            <span>分類</span>
            <Combobox.Root
              items={[ALL_CATEGORY, ...arrangeCategories(categories)]}
              value={categoryId === "all" ? ALL_CATEGORY : categories.find((item) => item.id === categoryId) ?? null}
              onValueChange={(item) => setCategoryId(item?.id ?? "all")}
              itemToStringLabel={(item) => item?.name ?? ""}
              autoHighlight
            >
              <Combobox.InputGroup className="combobox-group"><Combobox.Input className="combobox-input" placeholder="搜尋或選擇分類" /><Combobox.Clear className="combobox-clear" aria-label="清除分類"><Icon name="close" /></Combobox.Clear><Combobox.Trigger className="combobox-trigger" aria-label="開啟分類選單"><Icon name="chevronDown" /></Combobox.Trigger></Combobox.InputGroup>
              <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到分類</Combobox.Empty><Combobox.List>{(item: ProductCategory) => <Combobox.Item key={item.id} value={item} className="combobox-item"><span>{item.id === "all" ? item.name : categoryLabel(item)}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
            </Combobox.Root>
          </label>
        </form>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}


        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>品項</th>
                <th>來源</th>
                <th>分類</th>
                <th>倉儲庫存</th>
                <th>安全庫存</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => group.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="品項">
                    <div className="cell-strong">{item.name}</div>
                    <div className="cell-sub">{item.sku || "沒有 SKU"}</div>
                  </td>
                  <td data-label="來源"><span className="status quiet">{sourceLabel(item)}</span></td>
                  <td data-label="分類"><span className={`status status-tone-${group.color}`}>{group.label}</span></td>
                  <td data-label="倉儲庫存" className="numeric">{item.inWarehouse && item.quantity !== null ? item.quantity.toLocaleString("zh-TW") : "—"} <span className="cell-sub">{item.unit}</span></td>
                  <td data-label="安全庫存" className="numeric cell-sub">{item.inWarehouse && item.minStock !== null ? item.minStock.toLocaleString("zh-TW") : "—"}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      {item.source === "cyberbiz" && item.notes.includes("尚未建立") ? (
                        <Button variant="secondary" onClick={() => setEditing({ cyberbizSku: item.sku })}>建立品項</Button>
                      ) : (
                        <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                      )}
                    </td>
                  ) : null}
                </tr>
              )))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}
        {query.data && visible.length === 0 ? <p className="muted table-note">沒有符合條件的品項。</p> : null}
      </Panel>

      {editingItem ? <EditItemDialog item={editingItem} categories={categories} onClose={() => setEditingItem(null)} /> : null}
      {editing ? (
        <ItemForm
          zones={zones}
          categories={categories}
          cyberbizProducts={cyberbizProducts}
          catalogOnly
          initialCyberbizSku={editing === "new" ? "" : editing.cyberbizSku}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
