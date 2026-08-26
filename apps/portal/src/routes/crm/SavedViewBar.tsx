import { useState } from "react";
import { Alert, Button } from "../../ui/index.js";
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
        <Button
          type="button"
          variant="chip"
          selected={!active && isDefault}
          icon={!active && isDefault ? "check" : undefined}
          onClick={() => onApply(DEFAULT_FILTERS)}
          title="回到預設條件"
        >
          全部客戶
        </Button>

        {rows.map((view) => (
          <span className={`filter-chip${active?.id === view.id ? " selected" : ""}`} key={view.id}>
            <Button
              type="button"
              variant="chip-label"
              selected={active?.id === view.id}
              icon={active?.id === view.id ? "check" : undefined}
              onClick={() => onApply(view)}
              title={`${describe(view)}${view.createdByEmail ? `　—　${view.createdByEmail} 建立` : ""}`}
            >
              {view.name}
            </Button>
            {canManage ? (
              <Button
                type="button"
                variant="chip-remove"
                icon="close"
                onClick={() => remove.mutate(view.id)}
                disabled={remove.isPending}
                title={`刪除視圖「${view.name}」，所有人都會看不到`}
                aria-label={`刪除視圖 ${view.name}`}
              />
            ) : null}
          </span>
        ))}

        {canManage && name === null ? (
          <Button
            type="button"
            variant="chip-action"
            icon="bookmark"
            onClick={() => setName("")}
            disabled={saved}
            title={
              saved
                ? "目前的條件已經是一個視圖了"
                : "把現在的搜尋、篩選與排序存成一個視圖，所有人都看得到"
            }
          >儲存為視圖</Button>
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
            <Button type="submit" loading={create.isPending} loadingLabel="儲存中…" disabled={!name.trim()}>
              儲存
            </Button>
            <Button variant="link" type="button" onClick={() => setName(null)}>
              取消
            </Button>
          </form>
        ) : null}
      </div>

      {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
      {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
    </>
  );
}
