import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Icon } from "../../shell/icons.js";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { WAREHOUSE_CATEGORY_COLORS, type ProductCategory } from "../wms/api.js";

interface ItemCategory extends ProductCategory {
  usageCount: number;
  parentId: string | null;
  depth: number;
}

const KEY = ["items", "categories"] as const;

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  throw new Error(body?.message ?? body?.error ?? `操作失敗（${response.status}）`);
}

async function write<T>(path: string, method: "POST" | "PATCH" | "DELETE", payload?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as T;
}

function useItemCategories() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const response = await fetch("/api/items/categories", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as { categories: ItemCategory[] };
    },
  });
}

function useCategoryMutation<TInput>(fn: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KEY }),
        queryClient.invalidateQueries({ queryKey: ["items", "catalog"] }),
      ]);
    },
  });
}

function nextColor(taken: ItemCategory[]): string {
  const used = new Set(taken.map((category) => category.color));
  return WAREHOUSE_CATEGORY_COLORS.find((color) => !used.has(color)) ?? WAREHOUSE_CATEGORY_COLORS[taken.length % WAREHOUSE_CATEGORY_COLORS.length]!;
}

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="分類顏色">
      {WAREHOUSE_CATEGORY_COLORS.map((color) => (
        <label key={color} className={`color-swatch tone-${color}${value === color ? " selected" : ""}`}>
          <input type="radio" name="item-category-color" value={color} checked={value === color} onChange={() => onChange(color)} />
          <span className="sr-only">{color}</span>
        </label>
      ))}
    </div>
  );
}

function CreateDialog({ categories, onClose }: { categories: ItemCategory[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [color, setColor] = useState(nextColor(categories));
  const toast = useToast();
  const create = useCategoryMutation((input: { name: string; color: string; parentId: string }) => write("/api/items/categories", "POST", input));
  const trimmed = name.trim();
  return <Dialog title="新增品項分類" onClose={onClose} closeDisabled={create.isPending} formProps={{ onSubmit: (event) => { event.preventDefault(); if (trimmed) create.mutate({ name: trimmed, color, parentId }, { onSuccess: () => { toast.show(`已新增「${trimmed}」`); onClose(); } }); } }} actions={<><Button variant="secondary" type="button" onClick={onClose}>取消</Button><Button type="submit" loading={create.isPending} disabled={!trimmed}>新增分類</Button></>}>
    <TextField label="分類名稱" required autoFocus maxLength={40} placeholder="例如：香氛用品" value={name} onChange={(event) => setName(event.target.value)} />
    <SelectField label="上層分類" value={parentId} onChange={(event) => setParentId(event.target.value)} options={[{ label: "無", value: "" }, ...categories.filter((category) => category.depth === 0).map((category) => ({ label: category.name, value: category.id }))]} />
    <div className="field"><span>顏色</span><ColorPicker value={color} onChange={setColor} /></div>
    {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
  </Dialog>;
}

function SortableCategoryRow({ category, categories, canWrite, onEdit, onDelete }: { category: ItemCategory; categories: ItemCategory[]; canWrite: boolean; onEdit: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: category.id });
  return <tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={isDragging ? "dragging" : undefined}>
    <td data-label="分類"><span className="category-drag-handle" {...attributes} {...listeners} aria-label="拖曳調整排序" title="拖曳調整排序"><Icon name="dragHandle" /></span><span className={`status status-tone-${category.color}`}>{category.depth === 1 ? `↳ ${category.name}` : category.name}</span>{category.depth === 1 ? <div className="cell-sub">上層：{categories.find((parent) => parent.id === category.parentId)?.name ?? "—"}</div> : null}</td>
    <td data-label="使用中的品項" className="numeric">{category.usageCount}</td>
    {canWrite ? <td data-label="操作"><div className="row-actions"><Button variant="icon" icon="edit" onClick={onEdit} title="編輯名稱與顏色" aria-label={`編輯分類 ${category.name}`} /><Button variant="icon" className="danger" icon="trash" disabled={category.usageCount > 0} onClick={onDelete} title={category.usageCount ? `還有 ${category.usageCount} 個品項使用這個分類` : "刪除這個分類"} aria-label={`刪除分類 ${category.name}`} /></div></td> : null}
  </tr>;
}

function EditDialog({ category, categories, onClose }: { category: ItemCategory; categories: ItemCategory[]; onClose: () => void }) {
  const [name, setName] = useState(category.name);
  const [parentId, setParentId] = useState(category.parentId ?? "");
  const [color, setColor] = useState(category.color);
  const toast = useToast();
  const update = useCategoryMutation((input: { id: string; name: string; color: string; parentId: string }) =>
    write(`/api/items/categories/${input.id}`, "PATCH", { name: input.name, color: input.color, parentId: input.parentId || null }),
  );
  const trimmed = name.trim();

  return (
    <Dialog
      title="編輯品項分類"
      className="confirm-card"
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (trimmed) update.mutate({ id: category.id, name: trimmed, color, parentId }, { onSuccess: () => { toast.show("品項分類已更新"); onClose(); } });
        },
      }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>取消</Button><Button type="submit" loading={update.isPending} disabled={!trimmed}>儲存</Button></>}
    >
      <TextField label="名稱" required autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
      <SelectField label="上層分類" value={parentId} onChange={(event) => setParentId(event.target.value)} options={[{ label: "無", value: "" }, ...categories.filter((candidate) => candidate.depth === 0 && candidate.id !== category.id).map((candidate) => ({ label: candidate.name, value: candidate.id }))]} />
      <div className="field"><span>顏色</span><ColorPicker value={color} onChange={setColor} /></div>
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function ItemCategories() {
  usePageTitle("品項分類管理");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ItemCategory | null>(null);
  const [deleting, setDeleting] = useState<ItemCategory | null>(null);
  const query = useItemCategories();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:category:write");
  const categories = query.data?.categories ?? [];
  const [orderedCategories, setOrderedCategories] = useState<ItemCategory[]>([]);
  useEffect(() => { setOrderedCategories(categories); }, [categories]);
  const reorder = useCategoryMutation((input: { ids: string[]; parents: Record<string, string | null> }) => write("/api/items/categories/reorder", "POST", input));
  const remove = useCategoryMutation((id: string) => write(`/api/items/categories/${id}`, "DELETE"));
  const error = remove.error ?? reorder.error ?? query.error;
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const from = orderedCategories.findIndex((category) => category.id === active.id);
    const to = orderedCategories.findIndex((category) => category.id === over.id);
    if (from < 0 || to < 0) return;
    const target = orderedCategories[to];
    if (!target || active.id === over.id) return;
    const horizontal = event.delta.x;
    const next = arrayMove(orderedCategories, from, to);
    const activeCategory = next.find((category) => category.id === active.id);
    if (!activeCategory) return;
    let parentId = activeCategory.parentId;
    if (horizontal > 32 && target.depth === 0) parentId = target.id;
    if (horizontal < -32) parentId = null;
    const updated = next.map((category) => category.id === active.id ? { ...category, parentId, depth: parentId ? 1 : 0 } : category);
    setOrderedCategories(updated);
    reorder.mutate({ ids: updated.map((category) => category.id), parents: Object.fromEntries(updated.map((category) => [category.id, category.id === active.id ? parentId : category.parentId])) }, { onSuccess: () => toast.show(parentId !== activeCategory.parentId ? "分類階層與排序已更新" : "分類排序已更新") });
  }

  return (
    <div className="page fills">
      <PageHeader title="品項分類管理" description="這裡管理 item_categories；它是報表與品項主檔分類，不再與倉儲分類同步。" actions={canWrite ? <Button icon="plus" onClick={() => setCreating(true)}>新增分類</Button> : null} />

      <Panel className="grows">
        <Alert tone="info">品項分類已改接 item_categories。倉儲庫存頁的分類仍是 WMS 作業分類，兩者不會互相改名或同步。</Alert>

        {error ? <Alert tone="danger">{error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table category-table">
            <thead><tr><th>分類</th><th className="numeric">使用中的品項</th>{canWrite ? <th /> : null}</tr></thead>
            <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={orderedCategories.map((category) => category.id)} strategy={verticalListSortingStrategy}>
                <tbody>
                  {orderedCategories.map((category) => <SortableCategoryRow key={category.id} category={category} categories={categories} canWrite={canWrite} onEdit={() => setEditing(category)} onDelete={() => setDeleting(category)} />)}
                </tbody>
              </SortableContext>
            </DndContext>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}
        {query.data && categories.length === 0 ? <p className="muted table-note">還沒有任何品項分類。這不會影響 WMS 分類。</p> : null}
      </Panel>

      {creating ? <CreateDialog categories={categories} onClose={() => setCreating(false)} /> : null}
      {editing ? <EditDialog category={editing} categories={categories} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ConfirmDialog title="刪除這個分類？" confirmLabel="刪除" pending={remove.isPending} onCancel={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => { toast.show(`已刪除「${deleting.name}」`); setDeleting(null); } })}><p><strong>{deleting.name}</strong> 會被移除。目前沒有品項在用它。</p></ConfirmDialog> : null}
    </div>
  );
}
