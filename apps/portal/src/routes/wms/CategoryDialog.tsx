import { useState } from "react";
import { Alert, Button, Dialog, TextField } from "../../ui/index.js";
import { WAREHOUSE_CATEGORY_COLORS, useUpdateWarehouseCategory, type ProductCategory } from "./api.js";

/**
 * 一排色票。
 *
 * 底層是一組 radio，不是自己刻的 div：鍵盤的左右鍵本來就會在同一組 radio 之間
 * 移動，螢幕閱讀器也會念出「10 個裡的第 3 個」。自己刻的話這些都要重寫一遍。
 */
function ColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="分類顏色">
      {WAREHOUSE_CATEGORY_COLORS.map((color) => (
        <label key={color} className={`color-swatch tone-${color}${value === color ? " selected" : ""}`}>
          <input
            type="radio"
            name="category-color"
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
      className="confirm-card"
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

          <div className="field">
            <span>顏色</span>
            <ColorPicker value={color} onChange={setColor} />
          </div>

          {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}
    </Dialog>
  );
}
