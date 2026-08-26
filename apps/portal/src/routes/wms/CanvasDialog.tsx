import { useState } from "react";
import { Alert, Button, Dialog } from "../../ui/index.js";
import { useUpdateSettings } from "./api.js";

/**
 * 畫布尺寸。
 *
 * 倉位的座標是百分比，所以放大畫布**不會**把既有的倉位移動或壓扁——它們維持
 * 相同的相對位置與比例，只是整張圖變大、多出可以擺東西的空間。這件事要寫在
 * 畫面上，不然沒有人敢按。
 */
const PRESETS = [
  { label: "標準", width: 1600, height: 900 },
  { label: "寬版", width: 2200, height: 1200 },
  { label: "大型", width: 2800, height: 1600 },
] as const;

export function CanvasDialog({
  settings,
  onClose,
}: {
  settings: { canvasWidth: number; canvasHeight: number };
  onClose: () => void;
}) {
  const [width, setWidth] = useState(String(settings.canvasWidth));
  const [height, setHeight] = useState(String(settings.canvasHeight));
  const update = useUpdateSettings();

  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  const valid =
    Number.isFinite(parsedWidth) && parsedWidth >= 900 && parsedWidth <= 3200 &&
    Number.isFinite(parsedHeight) && parsedHeight >= 550 && parsedHeight <= 2000;

  return (
    <Dialog
      title="畫布大小"
      className="confirm-card"
      onClose={onClose}
      closeDisabled={update.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          update.mutate(
            { canvasWidth: Math.round(parsedWidth), canvasHeight: Math.round(parsedHeight) },
            { onSuccess: onClose },
          );
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={update.isPending}>
            取消
          </Button>
          <Button type="submit" disabled={!valid || update.isPending}>
            {update.isPending ? "儲存中…" : "套用畫布大小"}
          </Button>
        </>
      }
    >
          <p className="muted">
            放大畫布可以容納更多倉位。既有的區塊會維持相對位置與比例，不會跑掉。
          </p>

          <div className="preset-row">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                variant="secondary"
                className={
                  Number(width) === preset.width && Number(height) === preset.height ? " active" : ""
                }
                onClick={() => {
                  setWidth(String(preset.width));
                  setHeight(String(preset.height));
                }}
              >
                {preset.label}
                <small>{preset.width} × {preset.height}</small>
              </Button>
            ))}
          </div>

          <div className="field-grid">
            <label className="field">
              <span>寬度</span>
              <input
                type="number"
                min={900}
                max={3200}
                step={50}
                value={width}
                onChange={(event) => setWidth(event.target.value)}
              />
              <small>900–3200</small>
            </label>
            <label className="field">
              <span>高度</span>
              <input
                type="number"
                min={550}
                max={2000}
                step={50}
                value={height}
                onChange={(event) => setHeight(event.target.value)}
              />
              <small>550–2000</small>
            </label>
          </div>

          {update.error ? <Alert tone="danger">{update.error.message}</Alert> : null}

    </Dialog>
  );
}
