import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import {
  CATEGORY_COLORS,
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
  useWarehouse,
  type ProductCategory,
} from "./api.js";

/**
 * 一排色票。
 *
 * 用 radio 而不是自己做一組 div：鍵盤的左右鍵本來就會在同一組 radio 之間移動，
 * 而且螢幕閱讀器會念出「10 個裡的第 3 個」。自己刻的話這些都要重寫一遍。
 */
function ColorPicker({
  value,
  name,
  onChange,
}: {
  value: string;
  /** 同一頁上可能同時有好幾組（新增一組、每一列編輯時各一組），name 不能撞。 */
  name: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="分類顏色">
      {CATEGORY_COLORS.map((color) => (
        <label key={color} className={`color-swatch tone-${color}${value === color ? " selected" : ""}`}>
          <input
            type="radio"
            name={name}
            value={color}
            checked={value === color}
            onChange={() => onChange(color)}
          />
          {/* 顏色本身對看不到顏色的人沒有意義，用名字補上。 */}
          <span className="sr-only">{color}</span>
        </label>
      ))}
    </div>
  );
}

export function Categories() {
  usePageTitle("分類管理");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(CATEGORY_COLORS[0]);
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  const [deleting, setDeleting] = useState<ProductCategory | null>(null);

  const query = useWarehouse();
  const create = useCreateCategory();
  const update = useUpdateCategory();
  const remove = useDeleteCategory();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:category:write");

  const categories = query.data?.categories ?? [];
  const items = query.data?.items ?? [];

  /** 每個分類有幾項商品。刪除前要知道，改名時也想看得到影響範圍。 */
  const usage = new Map<string, number>();
  for (const item of items) usage.set(item.category, (usage.get(item.category) ?? 0) + 1);

  const error = create.error ?? update.error ?? remove.error ?? query.error;

  return (
    <div className="page fills">
      <header className="page-head">
        <h1>分類管理</h1>
        <p className="muted">
          商品分類與它們的顏色。分類的名字會直接存在商品身上，所以改名時所有用到的
          商品會一起更新；還有商品在用的分類不能刪。
        </p>
      </header>

      <section className="panel grows">
        {canWrite ? (
          <form
            className="admin-form toolbar category-form"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                { name: newName.trim(), color: newColor },
                {
                  onSuccess: () => {
                    toast.show(`已新增「${newName.trim()}」`);
                    setNewName("");
                  },
                },
              );
            }}
          >
            <input
              aria-label="新分類名稱"
              placeholder="新增一個分類"
              maxLength={40}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
            <ColorPicker value={newColor} name="new-category-color" onChange={setNewColor} />
            <button type="submit" className="primary-button" disabled={!newName.trim() || create.isPending}>
              {create.isPending ? "新增中…" : "新增分類"}
            </button>
          </form>
        ) : null}

        {error ? <p className="form-error" role="alert">{error.message}</p> : null}

        <div className="table-scroll">
          <table className="data-table category-table">
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
                const isEditing = editing?.id === category.id;

                return (
                  <tr key={category.id}>
                    <td data-label="分類">
                      {isEditing ? (
                        <form
                          className="admin-form inline category-edit"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const name = editing.name.trim();
                            if (!name) return;
                            update.mutate(
                              { id: category.id, name, color: editing.color },
                              {
                                onSuccess: () => {
                                  toast.show(
                                    name === category.name
                                      ? `已更新「${name}」的顏色`
                                      : `已改名為「${name}」${count ? `，同時更新 ${count} 項商品` : ""}`,
                                  );
                                  setEditing(null);
                                },
                              },
                            );
                          }}
                        >
                          <input
                            aria-label="新的分類名稱"
                            autoFocus
                            maxLength={40}
                            value={editing.name}
                            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                          />
                          <ColorPicker
                            value={editing.color}
                            name={`category-color-${category.id}`}
                            onChange={(color) => setEditing({ ...editing, color })}
                          />
                          <button type="submit" className="primary-button" disabled={update.isPending}>
                            儲存
                          </button>
                          <button type="button" className="link-button" onClick={() => setEditing(null)}>
                            取消
                          </button>
                        </form>
                      ) : (
                        <span className={`status status-tone-${category.color}`}>{category.name}</span>
                      )}
                    </td>
                    <td data-label="使用中的商品" className="numeric">{count}</td>
                    {canWrite ? (
                      <td data-label="操作">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            disabled={update.isPending || remove.isPending}
                            onClick={() =>
                              setEditing({ id: category.id, name: category.name, color: category.color })
                            }
                            title={
                              count
                                ? `修改，改名會一起更新 ${count} 項商品`
                                : "修改（目前沒有商品在用）"
                            }
                            aria-label={`修改分類 ${category.name}`}
                          >
                            <Icon name="edit" />
                          </button>
                          <button
                            type="button"
                            className="icon-button danger"
                            /*
                              * 還有商品在用就直接把按鈕停掉，不要等使用者按下去再吐
                              * 一句 409。旁邊的「使用中的商品」已經寫著幾項了，
                              * 為什麼不能刪是看得出來的。
                              */
                            disabled={count > 0 || remove.isPending}
                            onClick={() => setDeleting(category)}
                            title={
                              count
                                ? `還有 ${count} 項商品是這個分類，請先改成別的分類`
                                : "刪除這個分類"
                            }
                            aria-label={`刪除分類 ${category.name}`}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}

        {query.data && categories.length === 0 ? (
          <p className="muted table-note">
            還沒有任何分類。先在上面建一個，才能開始新增商品——商品一定要屬於某個分類。
          </p>
        ) : null}
      </section>

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
    </div>
  );
}
