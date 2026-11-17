import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, FilterInput, FilterToolbar, Page, PageHeader, Panel, StatusBadge, TableNote } from "../../ui/index.js";
import {
  WAREHOUSE_CATEGORY_COLORS,
  useCreateWarehouseCategory,
  useDeleteWarehouseCategory,
  useWarehouse,
  type ProductCategory,
} from "./api.js";
import { CategoryDialog } from "./CategoryDialog.js";

/**
 * 新分類的顏色。
 *
 * 建立時不問顏色——顏色是次要屬性，把十顆色票攤在工具列上會比「新增分類」這個
 * 動作本身還搶眼，而九成的情況下沒人在意新分類是什麼顏色。要改的人到那一列
 * 按編輯，那裡有完整的色票。
 *
 * 挑第一個沒人用的：這樣連著建幾個分類時，它們自然是不同顏色，不必有人去分配。
 * 十個用完就從頭循環，重複總比沒有顏色好。
 */
function nextColor(taken: ProductCategory[]): string {
  const used = new Set(taken.map((category) => category.color));
  return WAREHOUSE_CATEGORY_COLORS.find((color) => !used.has(color)) ?? WAREHOUSE_CATEGORY_COLORS[taken.length % WAREHOUSE_CATEGORY_COLORS.length]!;
}

export function Categories() {
  usePageTitle("倉儲分類管理");
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<ProductCategory | null>(null);
  const [deleting, setDeleting] = useState<ProductCategory | null>(null);

  const query = useWarehouse();
  const create = useCreateWarehouseCategory();
  const remove = useDeleteWarehouseCategory();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:category:write");

  const categories = query.data?.categories ?? [];
  const items = query.data?.items ?? [];

  /** 每個分類有幾項商品。刪不刪得掉看它，改名時也要講出影響範圍。 */
  const usage = new Map<string, number>();
  for (const item of items) usage.set(item.category, (usage.get(item.category) ?? 0) + 1);

  const error = create.error ?? remove.error ?? query.error;

  return (
    <Page layout="fills">
      <PageHeader
        title="倉儲分類管理"
        description={
          <>
          WMS 倉儲與庫存作業使用的分類。分類名稱會直接存在庫存品項身上，所以改名時
          所有用到的庫存品項會一起更新；報表商品分類請到「商品分類管理」。
          </>
        }
      />

      <Panel grows>
        {canWrite ? (
          <FilterToolbar
            onSubmit={(event) => {
              event.preventDefault();
              const name = newName.trim();
              create.mutate(
                { name, color: nextColor(categories) },
                {
                  onSuccess: () => {
                    toast.show(`已新增「${name}」`);
                    setNewName("");
                  },
                },
              );
            }}
          >
            {/* 分類名稱最多 40 個字，不必吃掉整條工具列；寬的螢幕上放五個字的長框看起來像壞掉。 */}
            <FilterInput
              label="新分類名稱"
              className="flex-[0_1_280px]"
              placeholder="新增一個分類"
              maxLength={40}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <Button type="submit" loading={create.isPending} loadingLabel="新增中…" disabled={!newName.trim()}>
              新增分類
            </Button>
          </FilterToolbar>
        ) : null}

        {error ? <Alert tone="danger">{error.message}</Alert> : null}

        {/* 只有三欄：後兩欄給固定寬度，讓「分類」吃掉剩下的空間；平均分掉的話個位數的數量會停在畫面正中央，離表頭很遠。 */}
        <DataTable className="[&_th:nth-child(2):not(:last-child)]:w-40 [&_td:nth-child(2):not(:last-child)]:w-40 [&_th:last-child]:w-30 [&_td:last-child]:w-30">
            <thead>
              <tr>
                <th>分類</th>
                <th className="numeric">使用中的商品</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => {
                const count = usage.get(category.name) ?? 0;

                return (
                  <tr key={category.id}>
                    <td data-label="分類">
                      <StatusBadge palette={category.color}>{category.name}</StatusBadge>
                    </td>
                    <td data-label="使用中的商品" className="numeric">{count}</td>
                    {canWrite ? (
                      <td data-label="操作">
                        <div className="row-actions">
                          <Button
                            variant="icon"
                            icon="edit"
                            disabled={remove.isPending}
                            onClick={() => setEditing(category)}
                            title={count ? `編輯，改名會一起更新 ${count} 項商品` : "編輯名稱與顏色"}
                            aria-label={`編輯分類 ${category.name}`}
                          />
                          <Button
                            variant="icon"
                            tone="danger"
                            icon="trash"
                            /*
                              * 還有商品在用就直接停用，不要等按下去再吐一句 409。
                              * 旁邊的「使用中的商品」已經寫著幾項，為什麼不能刪
                              * 是看得出來的。
                              */
                            disabled={count > 0 || remove.isPending}
                            onClick={() => setDeleting(category)}
                            title={
                              count
                                ? `還有 ${count} 項商品是這個分類，請先改成別的分類`
                                : "刪除這個分類"
                            }
                            aria-label={`刪除分類 ${category.name}`}
                          />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

        {query.isPending ? <TableNote>載入中…</TableNote> : null}

        {query.data && categories.length === 0 ? (
          <TableNote>
            還沒有任何分類。先在上面建一個，才能開始新增商品——商品一定要屬於某個分類。
          </TableNote>
        ) : null}
      </Panel>

      {editing ? (
        <CategoryDialog
          category={editing}
          usageCount={usage.get(editing.name) ?? 0}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="刪除這個分類？"
          confirmLabel="刪除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            remove.mutate(deleting.id, {
              onSuccess: () => {
                toast.show(`已刪除「${deleting.name}」`);
                setDeleting(null);
              },
            })
          }
        >
          <p>
            <strong>{deleting.name}</strong> 會被移除。目前沒有商品在用它。
          </p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
