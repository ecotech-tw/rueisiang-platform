import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Alert, Button, DataTable, Dialog, Field, FilterInput, FilterSelect, FilterToolbar, Page, PageHeader, Panel, RowActions, SEARCH_INPUT_WIDTH, SearchCombobox, SelectField, Stat, StatRow, StatusBadge, TableNote, TextField } from "../../ui/index.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useToast } from "../../shell/Toast.js";
import { Pager } from "../../shell/Pager.js";
import { ItemForm } from "../wms/ItemForm.js";
import type { ProductCategory, Zone } from "../wms/api.js";

interface ItemCatalogItem {
  id: string;
  sku: string;
  name: string;
  source: "cyberbiz" | "custom";
  kind: "sellable" | "supply";
  active: number;
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
  zones: Zone[];
}

const UNCLASSIFIED_CATEGORY_ID = "__unclassified__";

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

function kindLabel(item: ItemCatalogItem): string {
  return item.kind === "supply" ? "包材／半成品" : "可販售";
}

function sourceLabel(item: ItemCatalogItem): string {
  if (item.source === "cyberbiz") return "CYBERBIZ";
  return "自訂品項";
}

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
  const [sku, setSku] = useState(item.sku ?? "");
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [kind, setKind] = useState(item.kind);
  const toast = useToast();
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/items/catalog/${item.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(item.source === "custom" ? { sku: sku.trim() } : {}),
          kind,
          categoryId: categoryId || null,
        }),
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
  const valid = name.trim() !== "" && (item.source !== "custom" || sku.trim() !== "");
  return (
    <Dialog manageFocus
      title="編輯品項"
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{ onSubmit: (event) => { event.preventDefault(); if (valid) update.mutate(); } }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>取消</Button><Button type="submit" loading={update.isPending} disabled={!valid}>儲存</Button></>}
    >
      <TextField label="品項名稱" required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      <TextField
        label="SKU"
        value={item.source === "custom" ? sku : item.sku}
        disabled={item.source !== "custom"}
        onChange={item.source === "custom" ? (event) => setSku(event.target.value) : undefined}
        hint={item.source === "custom" ? "會自動轉成大寫；SKU 必須是全平台唯一。" : "CYBERBIZ 品項的 SKU 必須與官網連結一致，請到官網修改。"}
      />
      <SelectField
        label="用途"
        value={kind}
        onChange={(event) => setKind(event.target.value === "supply" ? "supply" : "sellable")}
        options={[{ label: "可販售", value: "sellable" }, { label: "包材／半成品", value: "supply" }]}
        hint="0076 搬移時只憑「有沒有 SKU」分過一輪，分錯的請改回來。"
      />
      <Field as="div" label="品項分類">
        <SearchCombobox
          items={arrangeCategories(categories)}
          value={categories.find((category) => category.id === categoryId) ?? null}
          onValueChange={(category) => setCategoryId(category?.id ?? "")}
          itemToStringLabel={(category) => category ? categoryPath(category, categories) : ""}
          itemKey={(category) => category.id}
          renderItem={(category) => <span>{category.parentId ? <>{category.name}<small className="text-[12px] font-normal text-muted opacity-72"> · {categoryPath(category, categories).split(" / ")[0]}</small></> : category.name}</span>}
          label="分類"
          placeholder="搜尋或選擇分類"
          emptyLabel="找不到分類"
        />
      </Field>
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function Items() {
  usePageTitle("品項列表");
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [categoryId, setCategoryId] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [editing, setEditing] = useState<"new" | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCatalogItem | null>(null);
  const [deleting, setDeleting] = useState<ItemCatalogItem | null>(null);
  const query = useQuery({ queryKey: ["items", "catalog"], queryFn: loadItemCatalog, staleTime: 30_000 });
  const queryClient = useQueryClient();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/items/catalog/${id}`, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return response.json() as Promise<{ ok: true }>;
    },
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ["items", "catalog"] });
      toast.show(`已刪除自訂品項「${items.find((item) => item.id === id)?.name ?? ""}」`);
      setDeleting(null);
    },
  });
  const { permissions } = useSession();
  const canWrite = permissions.has("items:item:write");

  const items = query.data?.items ?? [];
  const categories = query.data?.categories ?? [];
  const zones = query.data?.zones ?? [];
  const selectedCategoryIds = useMemo(
    () => categoryId === "all" || categoryId === UNCLASSIFIED_CATEGORY_ID
      ? null
      : categoryScope(categoryId, categories),
    [categoryId, categories],
  );
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((item) => {
      if (sourceFilter !== "all" && item.source !== sourceFilter) return false;
      if (categoryId === UNCLASSIFIED_CATEGORY_ID) {
        if (item.categoryId && categories.some((category) => category.id === item.categoryId)) return false;
      } else if (selectedCategoryIds && !selectedCategoryIds.has(item.categoryId ?? "")) return false;
      if (!term) return true;
      return [item.name, item.sku ?? "", item.category, item.notes].some((value) => String(value ?? "").toLowerCase().includes(term));
    });
  }, [categories, categoryId, items, search, sourceFilter, selectedCategoryIds]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedItems = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const groups = useMemo(() => arrangeCatalogGroups(pagedItems, categories), [categories, pagedItems]);
  const inWarehouseCount = items.filter((item) => item.inWarehouse).length;
  const cyberbizCount = items.filter((item) => item.source === "cyberbiz").length;
  const pendingWarehouseCount = items.length - inWarehouseCount;

  return (
    <Page layout="fills">
      <PageHeader
        title="品項列表"
        description="集中維護可被倉儲、SKU 對應與報表共用的品項；庫存盤點仍留在倉儲頁處理。"
        fab={canWrite ? <Button icon="plus" mobileIconOnly onClick={() => setEditing("new")}>新增自訂品項</Button> : null}
      />

      <StatRow aria-label="品項列表摘要">
        <Stat label="品項總數" value={items.length.toLocaleString("zh-TW")} />
        <Stat label="已納入倉儲" value={inWarehouseCount.toLocaleString("zh-TW")} />
        <Stat label="待納入倉儲" value={pendingWarehouseCount.toLocaleString("zh-TW")} />
        <Stat label="CYBERBIZ 鏡像" value={cyberbizCount.toLocaleString("zh-TW")} />
      </StatRow>

      <Panel grows>
        <FilterToolbar>
          <FilterInput
            label="搜尋"
            className={SEARCH_INPUT_WIDTH}
            type="search"
            placeholder="搜尋品名、SKU、分類或備註"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
          <FilterSelect
            label="來源"
            value={sourceFilter}
            onChange={(event) => { setSourceFilter(event.target.value); setPage(1); }}
            options={[{ value: "all", label: "全部來源" }, { value: "cyberbiz", label: "CYBERBIZ" }, { value: "custom", label: "自訂品項" }]}
          />
          <FilterSelect
            label="分類"
            value={categoryId}
            onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}
            options={[
              { value: "all", label: "全部分類" },
              { value: UNCLASSIFIED_CATEGORY_ID, label: "未分類" },
              ...arrangeCategories(categories).map((category) => ({ value: category.id, label: category.parentId ? categoryPath(category, categories) : category.name })),
            ]}
          />
        </FilterToolbar>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}

        <DataTable>
            <thead>
              <tr>
                <th>品項</th>
                <th>來源</th>
                <th>用途</th>
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
                    <div className="font-bold">{item.name}</div>
                    <div className="text-[12px] text-muted">{item.sku || "沒有 SKU"}</div>
                  </td>
                  <td data-label="來源"><StatusBadge quiet>{sourceLabel(item)}</StatusBadge></td>
                  <td data-label="用途"><StatusBadge quiet>{kindLabel(item)}</StatusBadge></td>
                  <td data-label="分類"><StatusBadge palette={group.color}>{group.label}</StatusBadge></td>
                  <td data-label="倉儲庫存" className="numeric">{item.inWarehouse && item.quantity !== null ? item.quantity.toLocaleString("zh-TW") : "—"} <span className="text-[12px] text-muted">{item.unit}</span></td>
                  <td data-label="安全庫存" className="numeric text-muted">{item.inWarehouse && item.minStock !== null ? item.minStock.toLocaleString("zh-TW") : "—"}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      <RowActions>
                        <Button variant="icon" icon="edit" title="編輯品項" aria-label={`編輯 ${item.name}`} onClick={() => setEditingItem(item)} />
                        {item.source === "custom" ? (
                          <Button
                            variant="icon"
                            tone="danger"
                            icon="trash"
                            title={item.inWarehouse ? "請先從倉儲移除後再刪除" : "刪除自訂品項"}
                            aria-label={`刪除自訂品項 ${item.name}`}
                            disabled={remove.isPending || item.inWarehouse}
                            onClick={() => setDeleting(item)}
                          />
                        ) : null}
                      </RowActions>
                    </td>
                  ) : null}
                </tr>
              )))}
            </tbody>
          </DataTable>

        {query.isPending ? <TableNote>載入中…</TableNote> : null}
        {query.data && visible.length === 0 ? <TableNote>沒有符合條件的品項。</TableNote> : null}
        {visible.length > 0 ? (
          <Pager
            className="mt-4 shrink-0"
            page={currentPage}
            pageSize={pageSize}
            pageSizes={[10, 25, 50, 100]}
            totalPages={totalPages}
            totalLabel={`共 ${visible.length.toLocaleString("zh-TW")} 項`}
            onPage={setPage}
            onPageSize={(next) => { setPageSize(next); setPage(1); }}
          />
        ) : null}
      </Panel>

      {editingItem ? <EditItemDialog item={editingItem} categories={categories} onClose={() => setEditingItem(null)} /> : null}
      {editing ? (
        <ItemForm
          zones={zones}
          categories={categories}
          catalogOnly
          onClose={() => setEditing(null)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="刪除這個自訂品項？"
          confirmLabel="刪除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        >
          <p>
            <strong>{deleting.name}</strong>{deleting.sku ? `（${deleting.sku}）` : ""} 將從品項主檔移除。
          </p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
