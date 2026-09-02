import { useState, type FormEvent } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Icon } from "../../shell/icons.js";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog, TextField } from "../../ui/index.js";
import {
  REPORT_CATEGORY_COLORS,
  useCreateReportProductCategory,
  useDeleteReportProductCategory,
  useProductCategoryManagement,
  useUpdateReportProductCategory,
  type ProductCategoryOption,
  type ReportProductCategoryWriteResult,
} from "./product-category-api.js";

function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="商品分類顏色">
      {REPORT_CATEGORY_COLORS.map((color) => (
        <label key={color} className={`color-swatch tone-${color}${value === color ? " selected" : ""}`} title={color}>
          <input
            type="radio"
            name="report-product-category-color"
            value={color}
            checked={value === color}
            onChange={() => onChange(color)}
          />
          <span className="sr-only">{color}</span>
        </label>
      ))}
    </div>
  );
}

function nextColor(categories: ProductCategoryOption[]): string {
  const used = new Set(categories.map((category) => category.color));
  return REPORT_CATEGORY_COLORS.find((color) => !used.has(color))
    ?? REPORT_CATEGORY_COLORS[categories.length % REPORT_CATEGORY_COLORS.length]!;
}

function ProductCategoryDialog({
  category,
  categories,
  onClose,
  onSaved,
}: {
  category: ProductCategoryOption | "new";
  categories: ProductCategoryOption[];
  onClose: () => void;
  onSaved: (result: ReportProductCategoryWriteResult, created: boolean) => void;
}) {
  const isNew = category === "new";
  const create = useCreateReportProductCategory();
  const update = useUpdateReportProductCategory();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const [name, setName] = useState(isNew ? "" : category.name);
  const [color, setColor] = useState(isNew ? nextColor(categories) : category.color);
  const trimmed = name.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || pending) return;
    if (isNew) {
      create.mutate({ name: trimmed, color }, { onSuccess: (result) => onSaved(result, true) });
    } else {
      update.mutate({ id: category.id, name: trimmed, color }, { onSuccess: (result) => onSaved(result, false) });
    }
  }

  return (
    <Dialog
      title={isNew ? "新增商品分類" : "編輯商品分類"}
      titleMeta="這是報表與 CYBERBIZ 商品使用的分類，不會影響 WMS 倉儲分類。"
      className="category-editor-dialog"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{ onSubmit: submit }}
      actions={(
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>取消</Button>
          <Button type="submit" loading={pending} loadingLabel={isNew ? "建立中…" : "儲存中…"} disabled={!trimmed}>
            {isNew ? "建立分類" : "儲存變更"}
          </Button>
        </>
      )}
    >
      <TextField
        label="分類名稱"
        required
        autoFocus
        maxLength={40}
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint="建立報表時會把當下的名稱寫入歷史快照；之後改名不會改寫歷史資料。"
      />
      <div className="field">
        <span>顏色</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      {error ? <Alert tone="danger">{error.message}</Alert> : null}
    </Dialog>
  );
}

export function ProductCategoryManagementDialog({ onClose }: { onClose: () => void }) {
  const { permissions } = useSession();
  const canWrite = permissions.has("tools:product-category:write");
  const query = useProductCategoryManagement();
  const remove = useDeleteReportProductCategory();
  const toast = useToast();
  const [categoryDialog, setCategoryDialog] = useState<ProductCategoryOption | "new" | null>(null);
  const [deleting, setDeleting] = useState<ProductCategoryOption | null>(null);

  if (query.isPending) {
    return (
      <Dialog title="商品分類管理" onClose={onClose} closeDisabled>
        <div className="boot">載入分類中…</div>
      </Dialog>
    );
  }

  const categories = query.data?.categories ?? [];
  const deleteHasUsage = (deleting?.usageCount ?? 0) > 0;

  return (
    <Dialog
      title="商品分類管理"
      titleMeta="報表與 CYBERBIZ 商品分類；不影響 WMS 倉儲分類。"
      className="product-category-management-dialog"
      onClose={onClose}
      closeDisabled={remove.isPending}
    >
      {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}

      <div className="product-category-management-toolbar">
        <p className="muted">分類名稱會寫入報表快照；刪除前請先移除現行商品對應。</p>
        {canWrite ? <Button icon="plus" onClick={() => setCategoryDialog("new")}>新增分類</Button> : null}
      </div>

      <div className="table-scroll product-category-management-scroll">
          <table className="data-table product-category-management-table">
            <thead>
              <tr>
                <th>分類</th>
                <th className="numeric">CYBERBIZ SKU</th>
                <th className="numeric">自訂商品主檔</th>
                <th className="numeric">使用中</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id}>
                  <td data-label="分類">
                    <span className={`status status-tone-${category.color}`}>{category.name}</span>
                  </td>
                  <td data-label="CYBERBIZ SKU" className="numeric">{category.skuCount}</td>
                  <td data-label="自訂商品主檔" className="numeric">{category.customProductCount}</td>
                  <td data-label="使用中" className="numeric">{category.usageCount}</td>
                  {canWrite ? (
                    <td data-label="操作">
                      <div className="row-actions">
                        <Button
                          variant="icon"
                          icon="edit"
                          title={`編輯商品分類 ${category.name}`}
                          aria-label={`編輯商品分類 ${category.name}`}
                          disabled={remove.isPending}
                          onClick={() => setCategoryDialog(category)}
                        />
                        <Button
                          variant="icon"
                          className="danger"
                          icon="trash"
                          title={category.usageCount ? `還有 ${category.usageCount} 項商品使用中，無法刪除` : "刪除商品分類"}
                          aria-label={`刪除商品分類 ${category.name}`}
                          disabled={category.usageCount > 0 || remove.isPending}
                          onClick={() => {
                            remove.reset();
                            setDeleting(category);
                          }}
                        />
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
      </div>

      {categories.length === 0 ? (
        <div className="empty-card">
          <Icon name="category" />
          <strong>還沒有商品分類</strong>
          <p className="muted">建立第一個分類，之後就能在商品分類管理頁指定給 CYBERBIZ SKU。</p>
        </div>
      ) : null}

      {categoryDialog ? (
        <ProductCategoryDialog
          key={categoryDialog === "new" ? "new" : categoryDialog.id}
          category={categoryDialog}
          categories={categories}
          onClose={() => setCategoryDialog(null)}
          onSaved={(result, created) => {
            toast.show(created ? `已新增「${result.name}」` : `已更新「${result.name}」`);
            setCategoryDialog(null);
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title={deleteHasUsage ? "這個分類還不能刪除" : "刪除商品分類？"}
          confirmLabel={deleteHasUsage ? "知道了" : "刪除"}
          tone={deleteHasUsage ? "primary" : "danger"}
          pending={remove.isPending}
          onCancel={() => {
            remove.reset();
            setDeleting(null);
          }}
          onConfirm={() => {
            if (deleteHasUsage) {
              setDeleting(null);
              return;
            }
            remove.mutate(deleting.id, {
              onSuccess: () => {
                toast.show(`已刪除「${deleting.name}」`);
                setDeleting(null);
              },
            });
          }}
        >
          {deleteHasUsage ? (
            <>
              <p><strong>{deleting.name}</strong> 目前還有商品使用中，不能刪除。</p>
              <p className="muted">請先把 {deleting.usageCount} 項商品改到其他分類，再回來刪除。</p>
            </>
          ) : (
            <p><strong>{deleting.name}</strong> 會被永久移除；歷史報表中的分類快照不會被改寫。</p>
          )}
          {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
        </ConfirmDialog>
      ) : null}
    </Dialog>
  );
}
