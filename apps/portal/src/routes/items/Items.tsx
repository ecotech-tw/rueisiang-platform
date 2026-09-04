import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Combobox } from "@base-ui/react/combobox";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { Alert, Button, Dialog, FilterInput, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
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
  if (item.source === "cyberbiz") return item.notes.includes("尚未建立") ? "CYBERBIZ 未入主檔" : "CYBERBIZ";
  if (item.source === "wms") return "WMS 過渡品項";
  return "自建品項";
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
      <SelectField label="倉儲分類" value={wmsCategoryId} onChange={(event) => setWmsCategoryId(event.target.value)} options={[{ label: "未分類", value: "" }, ...categories.map((category) => ({ label: category.name, value: category.id }))]} />
      <div className="field-grid">
        <SelectField label="倉位" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setShelfLevel(""); }} options={[{ label: "未指定倉位", value: "" }, ...zones.map((zone) => ({ label: `${zone.code} ${zone.name}`, value: zone.id }))]} />
        <SelectField label="層架" value={shelfLevel} disabled={!selectedZone} onChange={(event) => setShelfLevel(event.target.value)} options={[{ label: selectedZone ? "不指定層架" : "請先選擇倉位", value: "" }, ...(selectedZone?.shelfLevels ?? []).map((shelf) => ({ label: shelf.name, value: shelf.id }))]} />
      </div>
      <div className="field-grid trio">
        <TextField label="初始數量" type="number" min={0} value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        <TextField label="單位" value={unit} onChange={(event) => setUnit(event.target.value)} />
        <TextField label="安全庫存" type="number" min={0} value={minStock} onChange={(event) => setMinStock(event.target.value)} />
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
      toast.show("品項主檔已更新");
      onClose();
    },
  });
  const valid = name.trim() !== "";
  return (
    <Dialog
      title="編輯品項主檔"
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
          <Combobox.Portal><Combobox.Positioner className="combobox-positioner"><Combobox.Popup className="combobox-popup"><Combobox.Empty>找不到分類</Combobox.Empty><Combobox.List>{(category: ProductCategory) => <Combobox.Item key={category.id} value={category} className="combobox-item"><span className="combobox-category-label">{category.parentId ? <><small>{categoryPath(category, categories).split(" / ")[0]} / </small>{category.name}</> : category.name}</span><Combobox.ItemIndicator>✓</Combobox.ItemIndicator></Combobox.Item>}</Combobox.List></Combobox.Popup></Combobox.Positioner></Combobox.Portal>
        </Combobox.Root>
      </div>
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function Items() {
  usePageTitle("品項管理");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<"new" | { cyberbizSku: string } | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCatalogItem | null>(null);
  const navigate = useNavigate();
  const query = useQuery({ queryKey: ["items", "catalog"], queryFn: loadItemCatalog, staleTime: 30_000 });
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:inventory:write");

  const items = query.data?.items ?? [];
  const categories = query.data?.categories ?? [];
  const zones = query.data?.zones ?? [];
  const cyberbizProducts = query.data?.cyberbizProducts ?? [];

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!term) return true;
      return [item.name, item.sku ?? "", item.category, item.notes].some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [items, search, category]);

  return (
    <div className="page fills">
      <PageHeader
        title="品項管理"
        description="集中維護可被倉儲、SKU 對應與報表共用的品項主檔；庫存盤點仍留在倉儲頁處理。"
        actions={canWrite ? <Button icon="plus" onClick={() => setEditing("new")}>新增品項</Button> : null}
      />

      <Panel className="grows">
        <Alert tone="info">
          管理方式：先到「品項分類」建立分類，再在這裡新增品項；要調整數量請到「倉儲管理系統 → 商品庫存」執行盤點，避免主檔編輯誤改庫存。
        </Alert>

        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput
            label="搜尋"
            className="search-input"
            type="search"
            placeholder="搜尋品名、SKU、分類或備註"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <FilterSelect
            label="分類"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            options={[
              { value: "all", label: "全部分類" },
              ...categories.map((item) => ({ value: item.name, label: categoryLabel(item) })),
            ]}
          />
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
              {visible.map((item) => (
                <tr key={item.id}>
                  <td data-label="品項">
                    <div className="cell-strong">{item.name}</div>
                    <div className="cell-sub">{item.sku || "沒有 SKU"}</div>
                  </td>
                  <td data-label="來源"><span className="status quiet">{sourceLabel(item)}</span></td>
                  <td data-label="分類">{item.category}</td>
                  <td data-label="倉儲庫存" className="numeric">{item.inWarehouse && item.quantity !== null ? item.quantity.toLocaleString("zh-TW") : "—"} <span className="cell-sub">{item.unit}</span></td>
                  <td data-label="安全庫存" className="numeric cell-sub">{item.inWarehouse && item.minStock !== null ? item.minStock.toLocaleString("zh-TW") : "—"}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      {item.source === "cyberbiz" && item.notes.includes("尚未建立") ? (
                        <Button variant="secondary" onClick={() => setEditing({ cyberbizSku: item.sku })}>建立主檔</Button>
                      ) : !item.inWarehouse ? (
                        <div className="row-actions">
                          <Button variant="secondary" onClick={() => navigate("/wms/inventory")}>前往 WMS 納入倉儲</Button>
                          <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                        </div>
                      ) : (
                        <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
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
