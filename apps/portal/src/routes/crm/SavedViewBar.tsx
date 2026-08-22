import { useState } from "react";
import { Icon } from "../../shell/icons.js";
import {
  DEFAULT_FILTERS,
  matchesView,
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
  type CustomerFilters,
  type SavedViewFilters,
} from "./api.js";

interface Props {
  filters: CustomerFilters;
  onApply: (view: SavedViewFilters) => void;
  /** 有 crm:view:write 才看得到儲存與刪除。視圖是共用的，不是個人設定。 */
  canManage: boolean;
}

const CHANNEL_TEXT: Record<string, string> = { cyberbiz: "CYBERBIZ", manual: "人工建立" };
const STATUS_TEXT: Record<string, string> = { active: "正常", blocked: "已封鎖" };
const SORT_TEXT: Record<string, string> = {
  updatedAt: "最近更新",
  createdAt: "建立時間",
  name: "姓名",
  phone: "電話",
};

/** 把條件寫成一句話當 tooltip——點下去會看到什麼，要在點之前就知道。 */
function describe(view: SavedViewFilters): string {
  const parts = [
    view.search ? `搜尋「${view.search}」` : "",
    CHANNEL_TEXT[view.channel] ?? "",
    STATUS_TEXT[view.status] ?? "",
    view.tag !== "all" ? `標籤 ${view.tag}` : "",
    `${SORT_TEXT[view.sortField] ?? view.sortField}（${view.sortDirection === "asc" ? "舊到新" : "新到舊"}）`,
    `每頁 ${view.pageSize} 筆`,
  ].filter(Boolean);
  return parts.join("・");
}

export function SavedViewBar({ filters, onApply, canManage }: Props) {
  const views = useSavedViews();
  const create = useCreateSavedView();
  const remove = useDeleteSavedView();
  // null 代表沒有在命名；空字串代表輸入框開著但還沒打字。
  const [name, setName] = useState<string | null>(null);

  const rows = views.data ?? [];
  const active = rows.find((view) => matchesView(filters, view));
  const isDefault = matchesView(filters, DEFAULT_FILTERS);
  const saved = Boolean(active) || isDefault;

  if (!rows.length && !canManage) return null;

  return (
    <>
      <div className="view-bar">
        <button
          type="button"
          className={`filter-chip${!active && isDefault ? " selected" : ""}`}
          onClick={() => onApply(DEFAULT_FILTERS)}
          title="回到預設條件"
        >
          {!active && isDefault ? <Icon name="check" /> : null}
          全部客戶
        </button>

        {rows.map((view) => (
          <span className={`filter-chip${active?.id === view.id ? " selected" : ""}`} key={view.id}>
            <button
              type="button"
              className="filter-chip-label"
              onClick={() => onApply(view)}
              title={`${describe(view)}${view.createdByEmail ? `　—　${view.createdByEmail} 建立` : ""}`}
            >
              {active?.id === view.id ? <Icon name="check" /> : null}
              {view.name}
            </button>
            {canManage ? (
              <button
                type="button"
                className="filter-chip-remove"
                onClick={() => remove.mutate(view.id)}
                disabled={remove.isPending}
                title={`刪除視圖「${view.name}」，所有人都會看不到`}
                aria-label={`刪除視圖 ${view.name}`}
              >
                <Icon name="close" />
              </button>
            ) : null}
          </span>
        ))}

        {canManage && name === null ? (
          <button
            type="button"
            className="chip-action"
            onClick={() => setName("")}
            disabled={saved}
            title={
              saved
                ? "目前的條件已經是一個視圖了"
                : "把現在的搜尋、篩選與排序存成一個視圖，所有人都看得到"
            }
          >
            <Icon name="bookmark" />
            儲存為視圖
          </button>
        ) : null}

        {canManage && name !== null ? (
          <form
            className="admin-form row"
            onSubmit={(event) => {
              event.preventDefault();
              const { page: _page, ...rest } = filters;
              create.mutate(
                { ...rest, name: name.trim() },
                { onSuccess: () => setName(null) },
              );
            }}
          >
            <input
              autoFocus
              aria-label="視圖名稱"
              placeholder="例如：待補地址的客人"
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" className="primary-button" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "儲存中…" : "儲存"}
            </button>
            <button type="button" className="link-button" onClick={() => setName(null)}>
              取消
            </button>
          </form>
        ) : null}
      </div>

      {create.error ? <p className="form-error" role="alert">{create.error.message}</p> : null}
      {remove.error ? <p className="form-error" role="alert">{remove.error.message}</p> : null}
    </>
  );
}
