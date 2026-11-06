import { useState } from "react";
import { Alert, Button, Dialog, Field, TextField } from "../../ui/index.js";
import { useUpdateWarehouseCategory, type ProductCategory } from "./api.js";
import { ColorPicker } from "./ColorPicker.js";

/**
 * 改分類的名字與顏色。
 *
 * 用對話框而不是在表格裡就地編輯（標籤管理是那樣做的）：那頁只要改一個名字，
 * 一個輸入框塞得進去；這裡多了一排色票，硬塞進 400px 寬的欄位裡會擠成兩三行。
 * 而且倉儲這幾頁的編輯本來就都是對話框（商品、盤點），這樣才是同一套。
 */
export function CategoryDialog({
  category,
  usageCount,
  onClose,
}: {
  category: ProductCategory;
  /** 有幾項商品用這個分類。改名會一起改到它們，要先講清楚。 */
  usageCount: number;
  onClose: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const update = useUpdateWarehouseCategory();

  const trimmed = name.trim();
  const renaming = trimmed !== category.name;

  return (
    <Dialog
      title="編輯分類"
      width={420}
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!trimmed) return;
          update.mutate({ id: category.id, name: trimmed, color }, { onSuccess: onClose });
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button type="submit" loading={update.isPending} loadingLabel="儲存中…" disabled={!trimmed}>
            儲存
          </Button>
        </>
      }
    >
          <TextField
            label="名稱"
            required
            autoFocus
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint={renaming && usageCount > 0
              ? `${usageCount} 項商品的分類會一起改成「${trimmed || "…"}」。`
              : undefined}
          />

          <Field as="div" label="顏色">
            <ColorPicker label="分類顏色" value={color} onChange={setColor} />
          </Field>

          {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}
