import type { Permission } from "@rueisiang/auth/permissions";
import { useMemo, useState } from "react";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import {
  useCatalog,
  useCreateRole,
  useDeleteRole,
  useUpdateRole,
  type RoleInfo,
} from "./api.js";

/**
 * 角色管理。
 *
 * 這一頁只管自訂角色。系統角色（管理者、主管、一般同仁、檢視者）的權限寫在
 * packages/auth 的 SYSTEM_ROLES 裡，每次「重新同步」都會被程式碼整組重寫——
 * 開放在這裡編輯只會得到一個下次同步就消失的設定，比不給改更難查。所以系統
 * 角色在這裡是唯讀的，要客製就用「複製一份」再調整。
 */

/** 權限鍵值是 <模組>:<資源>:<動作>，第一段就是分組依據。 */
const MODULE_LABELS: Record<string, string> = {
  crm: "客戶關係管理",
  wms: "倉儲管理系統",
  tools: "營運工具",
  admin: "系統管理",
};

function moduleOf(permission: string): string {
  return permission.split(":")[0] ?? "";
}

/** 依模組分組，模組順序照 MODULE_LABELS 的宣告順序，不是字母序。 */
function groupByModule(permissions: Record<string, string>) {
  const order = Object.keys(MODULE_LABELS);
  const groups = new Map<string, { key: Permission; label: string }[]>();

  for (const [key, label] of Object.entries(permissions)) {
    const module = moduleOf(key);
    const list = groups.get(module) ?? [];
    list.push({ key: key as Permission, label });
    groups.set(module, list);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([module, items]) => ({
      module,
      label: MODULE_LABELS[module] ?? module,
      items,
    }));
}

interface EditorState {
  /** 沒有 key 就是新增。 */
  key: string | null;
  name: string;
  description: string;
  permissions: Set<Permission>;
  readOnly: boolean;
}

function blankEditor(): EditorState {
  return { key: null, name: "", description: "", permissions: new Set(), readOnly: false };
}

function editorFor(role: RoleInfo, options: { copy?: boolean } = {}): EditorState {
  return {
    // 複製時 key 留空，送出後會是一個全新的角色。
    key: options.copy ? null : role.key,
    name: options.copy ? `${role.name}（複製）` : role.name,
    description: role.description,
    permissions: new Set(role.permissions),
    readOnly: role.isSystem && !options.copy,
  };
}

export function Roles() {
  usePageTitle("角色管理");
  const catalog = useCatalog();
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const [editor, setEditor] = useState<EditorState | null>(null);

  const groups = useMemo(
    () => groupByModule(catalog.data?.permissions ?? {}),
    [catalog.data?.permissions],
  );

  const error = catalog.error ?? create.error ?? update.error ?? remove.error;
  const pending = create.isPending || update.isPending || remove.isPending;

  function submit() {
    if (!editor || editor.readOnly) return;
    const draft = {
      name: editor.name.trim(),
      description: editor.description.trim(),
      permissions: [...editor.permissions],
    };
    if (!draft.name) return;

    const done = { onSuccess: () => setEditor(null) };
    if (editor.key) update.mutate({ key: editor.key, ...draft }, done);
    else create.mutate(draft, done);
  }

  function confirmDelete(role: RoleInfo) {
    const holders = catalog.data?.holders[role.key] ?? 0;
    const warning = holders
      ? `「${role.name}」目前有 ${holders} 個人在用，刪掉之後他們會立刻失去這個角色帶來的權限。確定要刪除嗎？`
      : `確定要刪除「${role.name}」嗎？`;
    if (window.confirm(warning)) remove.mutate(role.key);
  }

  return (
    <div className="page">
      <header className="page-head page-head-row">
        <div>
          <h1>角色管理</h1>
          <p className="muted">
            自己組合權限，做出「只能跑出金表」「只看得到客戶資料」這種角色，再指派給同仁。
          </p>
        </div>
        <button type="button" className="primary-button" onClick={() => setEditor(blankEditor())}>
          ＋ 新增角色
        </button>
      </header>

      {error ? <p className="form-error" role="alert">{error.message}</p> : null}

      <section className="panel">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>角色</th>
                <th>類型</th>
                <th className="numeric">權限</th>
                <th className="numeric">使用人數</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(catalog.data?.roles ?? []).map((role) => (
                <tr key={role.key}>
                  <td>
                    <div className="cell-strong">{role.name}</div>
                    {role.description ? <div className="cell-sub">{role.description}</div> : null}
                  </td>
                  <td>
                    <span className={`status ${role.isSystem ? "status-invited" : "status-active"}`}>
                      {role.isSystem ? "系統內建" : "自訂"}
                    </span>
                  </td>
                  <td className="numeric">{role.permissions.length}</td>
                  <td className="numeric">{catalog.data?.holders[role.key] ?? 0}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setEditor(editorFor(role))}
                        title={role.isSystem ? "檢視權限" : "編輯"}
                        aria-label={role.isSystem ? "檢視權限" : "編輯"}
                      >
                        <Icon name={role.isSystem ? "eye" : "edit"} />
                      </button>
                      {/* 系統角色不能改，但可以當成起點複製一份出來調整。 */}
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => setEditor(editorFor(role, { copy: true }))}
                        title="複製成自訂角色"
                        aria-label="複製成自訂角色"
                      >
                        <Icon name="copy" />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => confirmDelete(role)}
                        disabled={role.isSystem || pending}
                        title={role.isSystem ? "系統角色不能刪除" : "刪除"}
                        aria-label="刪除"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {catalog.isPending ? <p className="muted table-note">載入中…</p> : null}
      </section>

      {editor ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) setEditor(null);
          }}
        >
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="role-form-title">
            <div className="modal-head">
              <h2 id="role-form-title">
                {editor.readOnly ? editor.name : editor.key ? "編輯角色" : "新增角色"}
              </h2>
              <button
                type="button"
                className="icon-button"
                onClick={() => setEditor(null)}
                disabled={pending}
                title="關閉"
                aria-label="關閉"
              >
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
              {editor.readOnly ? (
                <p className="muted">
                  這是系統內建角色，權限寫在程式碼裡，每次「重新同步」都會照著重寫，
                  所以不開放在這裡編輯。要客製的話按上一頁的「複製成自訂角色」。
                </p>
              ) : (
                <>
                  <label className="field">
                    <span>角色名稱<b>必填</b></span>
                    <input
                      autoFocus
                      required
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                      placeholder="例如：出金表操作員"
                    />
                  </label>
                  <label className="field">
                    <span>說明</span>
                    <input
                      value={editor.description}
                      onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                      placeholder="這個角色是給誰用的"
                    />
                  </label>
                </>
              )}

              {groups.map((group) => {
                const all = group.items.map((item) => item.key);
                const checkedCount = all.filter((key) => editor.permissions.has(key)).length;

                return (
                  <div className="field" key={group.module}>
                    <span>
                      {group.label}
                      {!editor.readOnly ? (
                        <button
                          type="button"
                          className="link-button"
                          style={{ marginLeft: 8 }}
                          onClick={() => {
                            const next = new Set(editor.permissions);
                            // 已經全勾就整組取消，否則整組勾起來。
                            if (checkedCount === all.length) all.forEach((key) => next.delete(key));
                            else all.forEach((key) => next.add(key));
                            setEditor({ ...editor, permissions: next });
                          }}
                        >
                          {checkedCount === all.length ? "全部取消" : "全選"}
                        </button>
                      ) : null}
                    </span>
                    {group.items.map((item) => (
                      <label className="field checkbox" key={item.key}>
                        <input
                          type="checkbox"
                          checked={editor.permissions.has(item.key)}
                          disabled={editor.readOnly}
                          onChange={(event) => {
                            const next = new Set(editor.permissions);
                            if (event.target.checked) next.add(item.key);
                            else next.delete(item.key);
                            setEditor({ ...editor, permissions: next });
                          }}
                        />
                        <span>
                          {item.label}
                          <small>{item.key}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </form>

            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={() => setEditor(null)} disabled={pending}>
                {editor.readOnly ? "關閉" : "取消"}
              </button>
              {!editor.readOnly ? (
                <button
                  type="button"
                  className="primary-button"
                  onClick={submit}
                  disabled={pending || !editor.name.trim()}
                >
                  {editor.key ? "儲存" : "建立角色"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
