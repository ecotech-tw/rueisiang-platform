import { useState } from "react";
import { useToast } from "../../shell/Toast.js";
import { Alert, Button, Dialog } from "../../ui/index.js";
import {
  CATEGORY_COLORS,
  useCreateElement,
  useDeleteElement,
  useUpdateElement,
  type LayoutElement,
} from "./api.js";

/**
 * 地圖標籤——牆、走道、出貨口這種不放東西的方塊。
 *
 * 位置與大小不在這裡改，那是在地圖上拖出來的。新增的標籤會落在左上角附近，
 * 拖到定位就好；把 x/y 做成輸入框沒有人會用。
 */
export function ElementDialog({
  element,
  onClose,
  onDeleted,
}: {
  element?: LayoutElement;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState(element?.label ?? "");
  const [color, setColor] = useState(element?.color ?? "slate");
  const create = useCreateElement();
  const update = useUpdateElement();
  const remove = useDeleteElement();
  const toast = useToast();

  const pending = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;
  const trimmed = label.trim();

  return (
    <Dialog
      title={element ? "編輯標籤" : "新增標籤"}
      className="confirm-card"
      onClose={onClose}
      closeDisabled={pending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!trimmed) return;
          if (element) update.mutate({ id: element.id, label: trimmed, color }, { onSuccess: onClose });
          else {
            create.mutate({ label: trimmed, color }, {
              onSuccess: () => {
                toast.show("標籤已新增，拖到定位即可");
                onClose();
              },
            });
          }
        },
      }}
      actions={
        <>
          {element ? (
            <Button
              variant="secondary"
              className="danger"
              disabled={pending}
              onClick={() =>
                remove.mutate(element.id, {
                  onSuccess: () => {
                    toast.show(`已刪除「${element.label}」`);
                    onDeleted();
                  },
                })
              }
            >
              刪除
            </Button>
          ) : null}
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="submit" disabled={!trimmed || pending}>
            {pending ? "儲存中…" : element ? "儲存" : "新增標籤"}
          </Button>
        </>
      }
    >
          <label className="field">
            <span>標籤文字<b>必填</b></span>
            <input
              autoFocus
              required
              maxLength={40}
              placeholder="例如 走道、出貨口"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            {!element ? <small>新標籤會出現在畫布左上角，拖到定位即可。</small> : null}
          </label>

          <div className="field">
            <span>顏色</span>
            <div className="color-picker" role="radiogroup" aria-label="標籤顏色">
              {CATEGORY_COLORS.map((tone) => (
                <label key={tone} className={`color-swatch tone-${tone}${color === tone ? " selected" : ""}`}>
                  <input
                    type="radio"
                    name="element-color"
                    value={tone}
                    checked={color === tone}
                    onChange={() => setColor(tone)}
                  />
                  <span className="sr-only">{tone}</span>
                </label>
              ))}
            </div>
          </div>

          {error ? <Alert tone="danger">{error.message}</Alert> : null}
    </Dialog>
  );
}
