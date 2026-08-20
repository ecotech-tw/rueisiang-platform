import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import {
  CATEGORY_COLORS,
  useCreateZone,
  useUpdateZone,
  type ShelfLevel,
  type Zone,
} from "./api.js";

/** 新層架的 id。用時間戳而不是流水號：刪掉中間一層再新增時不會撞到舊的。 */
function newLevelId(): string {
  return `level-${Date.now().toString(36)}`;
}

/**
 * 新增／編輯倉位。
 *
 * 位置與大小不在這裡改——那是在地圖上拖出來的。把 x/y/寬/高 做成四個數字輸入框
 * 的話，沒有人會用：要對齊一個走道，用拖的兩秒，填數字要試五次。
 */
export function ZoneDialog({ zone, onClose }: { zone?: Zone; onClose: () => void }) {
  const [fields, setFields] = useState({
    code: zone?.code ?? "",
    name: zone?.name ?? "",
    category: zone?.category ?? "一般備品",
    color: zone?.color ?? "mint",
    notes: zone?.notes ?? "",
  });
  const [levels, setLevels] = useState<ShelfLevel[]>(
    zone?.shelfLevels ?? [
      { id: "top", name: "上層" },
      { id: "middle", name: "中層" },
      { id: "bottom", name: "底層" },
    ],
  );

  const create = useCreateZone();
  const update = useUpdateZone();
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  function set(patch: Partial<typeof fields>) {
    setFields((current) => ({ ...current, ...patch }));
  }

  const valid = fields.code.trim() !== "" && fields.name.trim() !== "" && levels.length > 0;

  function submit() {
    if (!valid) return;
    const payload = {
      code: fields.code.trim(),
      name: fields.name.trim(),
      category: fields.category.trim() || "一般備品",
      color: fields.color,
      notes: fields.notes.trim(),
      // 名字空著的層送過去會被後端補成「第 N 層」，先在這裡濾掉比較不意外。
      shelfLevels: levels.filter((level) => level.name.trim()),
    };
    if (zone) update.mutate({ ...payload, id: zone.id }, { onSuccess: onClose });
    else create.mutate(payload, { onSuccess: onClose });
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="zone-title">
        <div className="modal-head">
          <h2 id="zone-title">{zone ? "編輯倉位" : "新增倉位"}</h2>
          <button type="button" className="icon-button" onClick={onClose} disabled={pending} aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>

        <form
          className="modal-body"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="field-grid">
            <label className="field">
              <span>倉位代碼<b>必填</b></span>
              <input
                autoFocus
                required
                placeholder="例如 A-01"
                value={fields.code}
                onChange={(event) => set({ code: event.target.value })}
              />
              <small>會自動轉成大寫，不能跟其他倉位重複。</small>
            </label>
            <label className="field">
              <span>名稱<b>必填</b></span>
              <input
                required
                placeholder="例如 備品區"
                value={fields.name}
                onChange={(event) => set({ name: event.target.value })}
              />
            </label>
          </div>

          <label className="field">
            <span>用途</span>
            <input
              placeholder="一般備品"
              value={fields.category}
              onChange={(event) => set({ category: event.target.value })}
            />
            <small>只是給人看的說明，跟商品分類是兩回事。</small>
          </label>

          <div className="field">
            <span>顏色</span>
            <div className="color-picker" role="radiogroup" aria-label="倉位顏色">
              {CATEGORY_COLORS.map((color) => (
                <label
                  key={color}
                  className={`color-swatch tone-${color}${fields.color === color ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="zone-color"
                    value={color}
                    checked={fields.color === color}
                    onChange={() => set({ color })}
                  />
                  <span className="sr-only">{color}</span>
                </label>
              ))}
            </div>
          </div>

          {/*
            * 層架。
            *
            * 移除一層之前先看有沒有東西放在上面——後端會擋（回 409），但那時使用者
            * 已經填完整張表單了。這裡沒有商品資料，所以擋不了，只能靠後端；
            * 訊息會照原樣顯示在下面。
            */}
          <div className="field">
            <span>層架</span>
            <div className="shelf-levels">
              {levels.map((level, index) => (
                <div className="shelf-level" key={level.id}>
                  <input
                    aria-label={`第 ${index + 1} 層的名稱`}
                    maxLength={20}
                    value={level.name}
                    onChange={(event) =>
                      setLevels((current) =>
                        current.map((item) =>
                          item.id === level.id ? { ...item, name: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="icon-button danger"
                    // 至少要有一層：一個沒有層的倉位，商品就沒地方放。
                    disabled={levels.length <= 1}
                    onClick={() => setLevels((current) => current.filter((item) => item.id !== level.id))}
                    title={levels.length <= 1 ? "至少要留一層" : "移除這一層"}
                    aria-label={`移除第 ${index + 1} 層`}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="ghost-button with-icon"
              disabled={levels.length >= 12}
              onClick={() =>
                setLevels((current) => [...current, { id: newLevelId(), name: `第 ${current.length + 1} 層` }])
              }
            >
              <Icon name="plus" />
              加一層
            </button>
          </div>

          <label className="field">
            <span>備註</span>
            <input value={fields.notes} onChange={(event) => set({ notes: event.target.value })} />
          </label>

          {error ? <p className="form-error" role="alert">{error.message}</p> : null}

          <div className="modal-actions">
            <button type="button" className="ghost-button" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={!valid || pending}>
              {pending ? "儲存中…" : zone ? "儲存" : "新增倉位"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
