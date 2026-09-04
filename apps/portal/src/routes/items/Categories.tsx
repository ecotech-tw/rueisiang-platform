import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, FilterInput, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
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

function EditDialog({ category, categories, onClose }: { category: ItemCategory; categories: ItemCategory[]; onClose: () => void }) {
  const [name, setName] = useState(category.name);
  const [parentId, setParentId] = useState(category.parentId ?? "");
  const [color, setColor] = useState(category.color);
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
          if (trimmed) update.mutate({ id: category.id, name: trimmed, color, parentId }, { onSuccess: onClose });
        },
      }}
      actions={<><Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>取消</Button><Button type="submit" loading={update.isPending} disabled={!trimmed}>儲存</Button></>}
    >
      <TextField label="名稱" required autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} />
      <SelectField label="上層分類" value={parentId} onChange={(event) => setParentId(event.target.value)} options={[{ label: "大分類（無上層）", value: "" }, ...categories.filter((candidate) => candidate.depth === 0 && candidate.id !== category.id).map((candidate) => ({ label: candidate.name, value: candidate.id }))]} />
      <div className="field"><span>顏色</span><ColorPicker value={color} onChange={setColor} /></div>
      {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}

export function ItemCategories() {
  usePageTitle("品項分類管理");
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [editing, setEditing] = useState<ItemCategory | null>(null);
  const [deleting, setDeleting] = useState<ItemCategory | null>(null);
  const query = useItemCategories();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:category:write");
  const categories = query.data?.categories ?? [];
  const [orderedCategories, setOrderedCategories] = useState<ItemCategory[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  useEffect(() => { setOrderedCategories(categories); }, [categories]);
  const reorder = useCategoryMutation((ids: string[]) => write("/api/items/categories/reorder", "POST", { ids }));
  const create = useCategoryMutation((input: { name: string; color: string; parentId: string }) => write("/api/items/categories", "POST", input));
  const remove = useCategoryMutation((id: string) => write(`/api/items/categories/${id}`, "DELETE"));
  const error = create.error ?? remove.error ?? reorder.error ?? query.error;
  function moveCategory(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    const next = [...orderedCategories];
    const from = next.findIndex((category) => category.id === draggingId);
    const to = next.findIndex((category) => category.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setOrderedCategories(next);
    reorder.mutate(next.map((category) => category.id));
  }

  return (
    <div className="page fills">
      <PageHeader title="品項分類管理" description="這裡管理 item_categories；它是報表與品項主檔分類，不再與倉儲分類同步。" />

      <Panel className="grows">
        <Alert tone="info">品項分類已改接 item_categories。倉儲庫存頁的分類仍是 WMS 作業分類，兩者不會互相改名或同步。</Alert>

        {canWrite ? (
          <form className="admin-form toolbar category-form" onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (!name) return;
            create.mutate({ name, color: nextColor(categories), parentId: newParentId }, { onSuccess: () => { toast.show(`已新增「${name}」`); setNewName(""); setNewParentId(""); } });
          }}>
            <FilterInput label="新分類名稱" placeholder="新增一個品項分類" maxLength={40} value={newName} onChange={(event) => setNewName(event.target.value)} />
            <SelectField label="上層分類" value={newParentId} onChange={(event) => setNewParentId(event.target.value)} options={[{ label: "建立大分類", value: "" }, ...categories.filter((category) => category.depth === 0).map((category) => ({ label: category.name, value: category.id }))]} />
            <Button type="submit" loading={create.isPending} loadingLabel="新增中…" disabled={!newName.trim()}>新增分類</Button>
          </form>
        ) : null}

        {error ? <Alert tone="danger">{error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table category-table">
            <thead><tr><th>分類</th><th className="numeric">使用中的品項</th>{canWrite ? <th /> : null}</tr></thead>
            <tbody>
              {orderedCategories.map((category) => (
                <tr key={category.id} draggable={canWrite} onDragStart={() => setDraggingId(category.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => { moveCategory(category.id); setDraggingId(null); }} onDragEnd={() => setDraggingId(null)} className={draggingId === category.id ? "dragging" : undefined}>
                  <td data-label="分類"><span className="category-drag-handle" aria-label="拖曳調整排序" title="拖曳調整排序"><Icon name="dragHandle" /></span><span className={`status status-tone-${category.color}`}>{category.depth === 1 ? `↳ ${category.name}` : category.name}</span>{category.depth === 1 ? <div className="cell-sub">上層：{categories.find((parent) => parent.id === category.parentId)?.name ?? "—"}</div> : null}</td>
                  <td data-label="使用中的品項" className="numeric">{category.usageCount}</td>
                  {canWrite ? <td data-label="操作"><div className="row-actions"><Button variant="icon" icon="edit" disabled={remove.isPending} onClick={() => setEditing(category)} title="編輯名稱與顏色" aria-label={`編輯分類 ${category.name}`} /><Button variant="icon" className="danger" icon="trash" disabled={category.usageCount > 0 || remove.isPending} onClick={() => setDeleting(category)} title={category.usageCount ? `還有 ${category.usageCount} 個品項使用這個分類` : "刪除這個分類"} aria-label={`刪除分類 ${category.name}`} /></div></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}
        {query.data && categories.length === 0 ? <p className="muted table-note">還沒有任何品項分類。這不會影響 WMS 分類。</p> : null}
      </Panel>

      {editing ? <EditDialog category={editing} categories={categories} onClose={() => setEditing(null)} /> : null}
      {deleting ? <ConfirmDialog title="刪除這個分類？" confirmLabel="刪除" pending={remove.isPending} onCancel={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => { toast.show(`已刪除「${deleting.name}」`); setDeleting(null); } })}><p><strong>{deleting.name}</strong> 會被移除。目前沒有品項在用它。</p></ConfirmDialog> : null}
    </div>
  );
}
