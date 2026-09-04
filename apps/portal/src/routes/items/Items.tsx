import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Combobox } from "@base-ui/react/combobox";
import { Fragment, useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
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
  warehouseCategories: ProductCategory[];
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

function sourceLabel(item: ItemCatalogItem): string {
  if (item.source === "cyberbiz") return item.notes.includes("尚未建立") ? "CYBERBIZ 待建立品項" : "CYBERBIZ";
  if (item.source === "wms") return "WMS 過渡品項";
  return "自建品項";
}

const ALL_CATEGORY: ProductCategory = { id: "all", name: "全部分類", color: "slate", parentId: null, depth: 0 };

function CategoryPicker({ categories, value, onChange, disabled }: { categories: ProductCategory[]; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const selected = categories.find((category) => category.id === value) ?? null;
  return (
    <div className="field">
      <span>倉儲分類</span>
      <Combobox.Root
        items={categories}
        value={selected}
        onValueChange={(category) => onChange(category?.id ?? "")}
        itemToStringLabel={(category) => category?.name ?? ""}
        autoHighlight
        disabled={disabled}
      >
        <Combobox.InputGroup className="combobox-group">
          <Combobox.Input className="combobox-input" placeholder="搜尋或選擇倉儲分類" />
          <Combobox.Clear className="combobox-clear" aria-label="清除倉儲分類"><Icon name="close" /></Combobox.Clear>
          <Combobox.Trigger className="combobox-trigger" aria-label="開啟倉儲分類選單"><Icon name="chevronDown" /></Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到倉儲分類</Combobox.Empty><Combobox.List>{(category: ProductCategory) => <Combobox.Item key={category.id} value={category} className="combobox-item"><span>{category.name}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}

interface ItemCatalogGroup {
  id: string;
  label: string;
  color: string;
  depth: number;
  items: ItemCatalogItem[];
}

function arrangeCatalogGroups(items: ItemCatalogItem[], categories: ProductCategory[]): ItemCatalogGroup[] {
  const groups: ItemCatalogGroup[] = [];
  const ordered = arrangeCategories(categories);
  for (const category of ordered) {
    const members = items.filter((item) => item.categoryId === category.id);
    if (!members.length) continue;
    groups.push({ id: category.id, label: categoryPath(category, categories), color: category.color, depth: category.depth ?? 0, items: members });
  }
  const unclassified = items.filter((item) => !item.categoryId || !categories.some((category) => category.id === item.categoryId));
  if (unclassified.length) groups.push({ id: "__unclassified__", label: "未分類", color: "slate", depth: 0, items: unclassified });
  return groups;
}

export function WarehouseDialog({ item, categories, zones, onClose }: { item: ItemCatalogItem; categories: ProductCategory[]; zones: Zone[]; onClose: () => void }) {
  const [wmsCategoryId, setWmsCategoryId] = useState(categories[0]?.id ?? "");
  const [zoneId, setZoneId] = useState("");
  const [shelfLevel, setShelfLevel] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [unit, setUnit] = useState("件");
  const [minStock, setMinStock] = useState("5");
  const queryClient = useQueryClient();
  const selectedZone = zones.find((zone) => zone.id === zoneId);
  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/items/catalog/${item.id}/warehouse`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wmsCategoryId: wmsCategoryId || null,
          zoneId: zoneId || null,
          shelfLevel: shelfLevel || null,
          shelfName: selectedZone?.shelfLevels.find((shelf) => shelf.id === shelfLevel)?.name ?? null,
          quantity: Math.max(0, Math.round(Number(quantity) || 0)),
          unit: unit.trim() || "件",
          minStock: Math.max(0, Math.round(Number(minStock) || 0)),
        }),
      });
      if (!response.ok) await readError(response);
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["items", "catalog"] });
      onClose();
    },
  });
  return (
    <Dialog
      title="納入倉儲"
      onClose={onClose}
      closeDisabled={create.isPending}
      formProps={{ onSubmit: (event) => { event.preventDefault(); create.mutate(); } }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={create.isPending}>取消</Button><Button type="submit" loading={create.isPending}>納入倉儲</Button></>}
    >
      <p className="muted">{item.name} 會建立一筆 wms_items。之後庫存盤點仍到倉儲頁操作。</p>
      <CategoryPicker categories={categories} value={wmsCategoryId} onChange={setWmsCategoryId} disabled={create.isPending} />
      <div className="field-grid">
        <SelectField label="倉位" value={zoneId} disabled={create.isPending} onChange={(event) => { setZoneId(event.target.value); setShelfLevel(""); }} options={[{ label: "未指定倉位", value: "" }, ...zones.map((zone) => ({ label: `${zone.code} ${zone.name}`, value: zone.id }))]} />
        <SelectField label="層架" value={shelfLevel} disabled={!selectedZone || create.isPending} onChange={(event) => setShelfLevel(event.target.value)} options={[{ label: selectedZone ? "不指定層架" : "請先選擇倉位", value: "" }, ...(selectedZone?.shelfLevels ?? []).map((shelf) => ({ label: shelf.name, value: shelf.id }))]} />
      </div>
      <div className="field-grid trio">
        <TextField label="初始數量" type="number" min={0} value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={create.isPending} />
        <TextField label="單位" value={unit} onChange={(event) => setUnit(event.target.value)} disabled={create.isPending} />
        <TextField label="安全庫存" type="number" min={0} value={minStock} onChange={(event) => setMinStock(event.target.value)} disabled={create.isPending} />
      </div>
      {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
    </Dialog>
  );
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
  usePageTitle("品項管理");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [editing, setEditing] = useState<"new" | { cyberbizSku: string } | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCatalogItem | null>(null);
  const [warehouseItem, setWarehouseItem] = useState<ItemCatalogItem | null>(null);
  const query = useQuery({ queryKey: ["items", "catalog"], queryFn: loadItemCatalog, staleTime: 30_000 });
  const { permissions } = useSession();
  const canWrite = permissions.has("items:item:write");
  const canEnroll = canWrite && permissions.has("wms:inventory:write");

  const items = query.data?.items ?? [];
  const categories = query.data?.categories ?? [];
  const zones = query.data?.zones ?? [];
  const warehouseCategories = query.data?.warehouseCategories ?? [];
  const cyberbizProducts = query.data?.cyberbizProducts ?? [];

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (categoryId !== "all" && item.categoryId !== categoryId) return false;
      if (!term) return true;
      return [item.name, item.sku ?? "", item.category, item.notes].some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [items, search, categoryId]);
  const groups = useMemo(() => arrangeCatalogGroups(visible, categories), [categories, visible]);
  const inWarehouseCount = items.filter((item) => item.inWarehouse).length;
  const cyberbizCount = items.filter((item) => item.source === "cyberbiz").length;
  const pendingWarehouseCount = items.length - inWarehouseCount;

  return (
    <div className="page fills">
      <PageHeader
        title="品項管理"
        description="集中維護可被倉儲、SKU 對應與報表共用的品項；庫存盤點仍留在倉儲頁處理。"
        actions={canWrite ? <Button icon="plus" onClick={() => setEditing("new")}>新增品項</Button> : null}
      />

      <div className="stat-row catalog-stat-row" aria-label="品項列表摘要">
        <div className="stat"><span>品項總數</span><strong>{items.length.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>已納入倉儲</span><strong>{inWarehouseCount.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>待納入倉儲</span><strong>{pendingWarehouseCount.toLocaleString("zh-TW")}</strong></div>
        <div className="stat"><span>CYBERBIZ 鏡像</span><strong>{cyberbizCount.toLocaleString("zh-TW")}</strong></div>
      </div>

      <Panel className="grows" title="全部品項" description={`目前顯示 ${visible.length.toLocaleString("zh-TW")} / ${items.length.toLocaleString("zh-TW")} 項；依分類階層分組呈現。`}>
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
              {groups.map((group) => (
                <Fragment key={group.id}>
                  <tr className="catalog-group-row">
                    <td colSpan={canWrite ? 6 : 5}>
                      <span className={`status status-tone-${group.color}`}>{group.label}</span>
                      <span className="cell-sub">{group.items.length.toLocaleString("zh-TW")} 項</span>
                    </td>
                  </tr>
                  {group.items.map((item) => (
                    <tr key={item.id}>
                      <td data-label="品項">
                        <div className="cell-strong">{item.name}</div>
                        <div className="cell-sub">{item.sku || "沒有 SKU"}</div>
                      </td>
                      <td data-label="來源"><span className="status quiet">{sourceLabel(item)}</span></td>
                      <td data-label="分類">{categoryPath(categories.find((candidate) => candidate.id === item.categoryId) ?? ({ name: item.category, parentId: null, depth: 0 } as ProductCategory), categories)}</td>
                      <td data-label="倉儲庫存" className="numeric">{item.inWarehouse && item.quantity !== null ? item.quantity.toLocaleString("zh-TW") : "—"} <span className="cell-sub">{item.unit}</span></td>
                      <td data-label="安全庫存" className="numeric cell-sub">{item.inWarehouse && item.minStock !== null ? item.minStock.toLocaleString("zh-TW") : "—"}</td>
                      {canWrite ? (
                        <td data-label="操作">
                          {item.source === "cyberbiz" && item.notes.includes("尚未建立") ? (
                            <Button variant="secondary" onClick={() => setEditing({ cyberbizSku: item.sku })}>建立品項</Button>
                          ) : !item.inWarehouse && canEnroll ? (
                            <div className="row-actions">
                              <Button variant="secondary" onClick={() => setWarehouseItem(item)}>納入倉儲</Button>
                              <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                            </div>
                          ) : (
                            <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                          )}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}
        {query.data && visible.length === 0 ? <p className="muted table-note">沒有符合條件的品項。</p> : null}
      </Panel>

      {editingItem ? <EditItemDialog item={editingItem} categories={categories} onClose={() => setEditingItem(null)} /> : null}
      {warehouseItem ? <WarehouseDialog item={warehouseItem} categories={warehouseCategories} zones={zones} onClose={() => setWarehouseItem(null)} /> : null}
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
