import { useRef, useState } from "react";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, EmptyState, Page, PageHeader, Panel, StatusBadge, TextField } from "../../ui/index.js";
import { useAccountingQuery, useAccountingWrite, type ExpenseCategory } from "./api.js";

/*
 * 支出類別是會計維護的清單，不是科目表。不能刪：舊的報帳單指著它。不用的就停用，
 * 員工送件時選不到，紀錄裡照樣看得到名稱。
 */

type Editing = { id: string | null; name: string; sortOrder: string; archived: boolean };
type CloseRef = { current: ((afterClose?: () => void) => void) | null };

function CategoryDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const closeRef: CloseRef = useRef(null);
  const write = useAccountingWrite();
  const [name, setName] = useState(editing.name);
  const [sortOrder, setSortOrder] = useState(editing.sortOrder);
  const close = () => (closeRef.current ?? ((after?: () => void) => after?.()))(onClose);
  const save = (archived: boolean) => {
    const values = { name, sortOrder: Number(sortOrder || 0), archived };
    write.mutate(
      editing.id ? { path: `/categories/${encodeURIComponent(editing.id)}`, method: "PATCH", values } : { path: "/categories", method: "POST", values },
      { onSuccess: close },
    );
  };
  return <Dialog
    title={editing.id ? "編輯支出類別" : "新增支出類別"}
    onClose={onClose}
    closeRequestRef={closeRef}
    closeDisabled={write.isPending}
    actions={<>
      {editing.id ? <Button variant="secondary" disabled={write.isPending} onClick={() => save(!editing.archived)}>{editing.archived ? "重新啟用" : "停用"}</Button> : null}
      <Button variant="secondary" disabled={write.isPending} onClick={close}>取消</Button>
      <Button tone="success" loading={write.isPending} disabled={!name.trim()} onClick={() => save(editing.archived)}>儲存</Button>
    </>}
  >
    <TextField label="名稱" required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} />
    <TextField label="排序" inputMode="numeric" value={sortOrder} hint="數字小的排前面，員工送件時照這個順序列出。" onChange={(event) => setSortOrder(event.target.value.replace(/[^\d]/g, "").slice(0, 4))} />
    {write.error ? <Alert tone="danger">{write.error.message}</Alert> : null}
  </Dialog>;
}

export function AccountingCategories() {
  usePageTitle("支出類別");
  const query = useAccountingQuery<{ categories: ExpenseCategory[] }>("/categories");
  const [editing, setEditing] = useState<Editing | null>(null);
  const categories = query.data?.categories ?? [];
  const nextSort = categories.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 10;
  return <Page>
    <PageHeader title="支出類別" actions={<Button tone="success" icon="plus" onClick={() => setEditing({ id: null, name: "", sortOrder: String(nextSort), archived: false })}>新增類別</Button>} />
    {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
    <Panel>
      {query.isPending ? <p className="text-muted">載入類別…</p>
        : categories.length === 0 ? <EmptyState>還沒有支出類別。</EmptyState>
        : <DataTable>
          <thead>
            <tr>
              <th>名稱</th>
              <th className="numeric">排序</th>
              <th className="numeric">報帳數</th>
              <th>狀態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {categories.map((category) => <tr key={category.id}>
              <td data-label="名稱" className="font-semibold">{category.name}</td>
              <td data-label="排序" className="numeric">{category.sortOrder}</td>
              <td data-label="報帳數" className="numeric">{category.expenseCount}</td>
              <td data-label="狀態">{category.archived ? <StatusBadge>已停用</StatusBadge> : <StatusBadge tone="success">使用中</StatusBadge>}</td>
              <td data-label="操作"><Button variant="secondary" onClick={() => setEditing({ id: category.id, name: category.name, sortOrder: String(category.sortOrder), archived: category.archived })}>編輯</Button></td>
            </tr>)}
          </tbody>
        </DataTable>}
    </Panel>
    {editing ? <CategoryDialog editing={editing} onClose={() => setEditing(null)} /> : null}
  </Page>;
}
