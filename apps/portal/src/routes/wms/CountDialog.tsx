import { useState } from "react";
import { Alert, Button, Dialog } from "../../ui/index.js";
import { useCountItem, type InventoryItem } from "./api.js";

/**
 * 盤點對話框。
 *
 * 獨立於「編輯商品」，因為它是獨立的權限（wms:inventory:count）與獨立的 API。
 * 倉庫的人要能數數量，但不該能改 SKU、改分類、把東西搬到別的倉位——兩件事
 * 合在同一張表單裡的話，這個界線在畫面上就不存在了。
 *
 * 輸入的是**盤點後的實際數量**，不是增減。現場的人手上有的是「架上有 37 個」
 * 這個事實，不是「比系統少 5 個」——要他自己算差額只會多一個算錯的機會。
 */
export function CountDialog({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const [value, setValue] = useState(String(item.quantity));
  const [note, setNote] = useState("");
  const count = useCountItem();

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
  const difference = valid ? Math.round(parsed) - item.quantity : 0;

  function submit() {
    if (!valid) return;
    count.mutate(
      { id: item.id, quantity: Math.round(parsed), note: note.trim() || undefined },
      { onSuccess: onClose },
    );
  }

  return (
    <Dialog
      title="盤點"
      onClose={onClose}
      closeDisabled={count.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={count.isPending}>
            取消
          </Button>
          <Button type="submit" disabled={!valid || count.isPending}>
            {count.isPending ? "儲存中…" : "儲存盤點"}
          </Button>
        </>
      }
    >
          <div className="count-subject">
            <div className="cell-strong">{item.name}</div>
            <div className="cell-sub">
              {item.sku ? `${item.sku}・` : ""}
              系統現有 {item.quantity.toLocaleString("zh-TW")} {item.unit}
            </div>
          </div>

          <label className="field">
            <span>實際數量<b>必填</b></span>
            <input
              autoFocus
              type="number"
              min={0}
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
            <small>直接填架上數出來的數量，不用自己算差額。</small>
          </label>

          {/*
            * 差額即時算給人看。現場的人數完之後最想確認的是「跟系統差多少」——
            * 差太多通常代表數錯了或漏記了一批進出，這時候他會想再數一次，
            * 而不是就這樣存下去。
            */}
          {valid && difference !== 0 ? (
            <p className={`count-diff${difference < 0 ? " short" : ""}`}>
              {difference > 0 ? "比系統多" : "比系統少"} {Math.abs(difference).toLocaleString("zh-TW")} {item.unit}
            </p>
          ) : null}

          {valid && Math.round(parsed) < item.minStock ? (
            <p className="count-diff warn">
              低於安全庫存（{item.minStock.toLocaleString("zh-TW")} {item.unit}），存檔後要補貨。
            </p>
          ) : null}

          <label className="field">
            <span>備註</span>
            <input
              placeholder="例如：破損 2 件已丟棄"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <small>會寫進操作紀錄。數量對不上時，這裡是唯一說得清原因的地方。</small>
          </label>

          {count.error ? <Alert tone="danger">{count.error.message}</Alert> : null}
    </Dialog>
  );
}
