import type { Permission } from "@rueisiang/auth/permissions";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, TextField } from "../../ui/index.js";
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
 * 管理員是唯一受系統保護的角色；其他角色都是自訂角色，可以在這裡調整權限與說明，
 * 也可以刪除。管理員維持唯讀，避免任何一位管理者把自己鎖在系統外。
 */

/** 權限鍵值是 <模組>:<資源>:<動作>，第一段就是分組依據。 */
const MODULE_LABELS: Record<string, string> = {
  crm: "客戶關係管理",
  items: "品項主檔",
  wms: "倉儲管理系統",
  tools: "營運工具",
  admin: "系統管理",
};
const PROTECTED_ROLE_KEY = "admin";

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
    readOnly: role.key === PROTECTED_ROLE_KEY && !options.copy,
  };
}

export function Roles() {
  usePageTitle("角色管理");
  const catalog = useCatalog();
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ role: RoleInfo; holders: number } | null>(null);

  const groups = useMemo(
    () => groupByModule(catalog.data?.permissions ?? {}),
    [catalog.data?.permissions],
  );

  const error = catalog.error ?? create.error ?? update.error;
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
    remove.reset();
    setDeleteTarget({ role, holders: catalog.data?.holders[role.key] ?? 0 });
  }

  return (
    <div className="page fills">
      <PageHeader
        title="角色管理"
        description={
          <>
            管理員角色受系統保護，其餘角色都能自訂、調整與刪除，再指派給同仁。
          </>
        }
        actions={<Button onClick={() => setEditor(blankEditor())}>
          ＋ 新增角色
        </Button>}
      />

      {error ? <Alert tone="danger">{error.message}</Alert> : null}

      <Panel className="grows">
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
                    <span className={`status ${role.key === PROTECTED_ROLE_KEY ? "status-invited" : "status-active"}`}>
                      {role.key === PROTECTED_ROLE_KEY ? "系統內建" : "自訂"}
                    </span>
                  </td>
                  <td className="numeric">{role.permissions.length}</td>
                  <td className="numeric">{catalog.data?.holders[role.key] ?? 0}</td>
                  <td>
                    <div className="row-actions">
                      <Button
                        variant="icon"
                        icon={role.key === PROTECTED_ROLE_KEY ? "eye" : "edit"}
                        onClick={() => setEditor(editorFor(role))}
                        title={role.key === PROTECTED_ROLE_KEY ? "檢視權限" : "編輯"}
                        aria-label={role.key === PROTECTED_ROLE_KEY ? "檢視權限" : "編輯"}
                      />
                      {/* 管理員仍可複製成自訂角色，其他角色則可直接編輯。 */}
                      <Button
                        variant="icon"
                        icon="copy"
                        onClick={() => setEditor(editorFor(role, { copy: true }))}
                        title="複製成自訂角色"
                        aria-label="複製成自訂角色"
                      />
                      <Button
                        variant="icon"
                        className="danger"
                        icon="trash"
                        onClick={() => confirmDelete(role)}
                        disabled={role.key === PROTECTED_ROLE_KEY || pending}
                        title={role.key === PROTECTED_ROLE_KEY ? "管理員角色不能刪除" : "刪除"}
                        aria-label="刪除"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {catalog.isPending ? <p className="muted table-note">載入中…</p> : null}
      </Panel>

      {editor ? (
        <Dialog
          title={editor.readOnly ? editor.name : editor.key ? "編輯角色" : "新增角色"}
          className="wide"
          onClose={() => setEditor(null)}
          closeDisabled={pending}
          formProps={{
            onSubmit: (event) => {
              event.preventDefault();
              submit();
            },
          }}
          actions={
            <>
              <Button variant="secondary" type="button" onClick={() => setEditor(null)} disabled={pending}>
                {editor.readOnly ? "關閉" : "取消"}
              </Button>
              {!editor.readOnly ? (
                <Button type="submit" loading={pending} disabled={!editor.name.trim()}>
                  {editor.key ? "儲存" : "建立角色"}
                </Button>
              ) : null}
            </>
          }
        >
              {editor.readOnly ? (
                <p className="muted">
                  管理員角色受系統保護，不能在這裡修改或刪除；要建立其他權限組合，
                  請按上一頁的「複製成自訂角色」。
                </p>
              ) : (
                <>
                  <div className="field-grid">
                    <TextField
                      label="角色名稱"
                      required
                      autoFocus
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                      placeholder="例如：出金表操作員"
                    />
                    <TextField
                      label="說明"
                      value={editor.description}
                      onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                      placeholder="這個角色是給誰用的"
                    />
                  </div>
                </>
              )}

              {groups.map((group) => {
                const all = group.items.map((item) => item.key);
                const checkedCount = all.filter((key) => editor.permissions.has(key)).length;

                return (
                  <fieldset className="perm-group" key={group.module}>
                    <legend>
                      {group.label}
                      <span className="perm-count">{checkedCount}/{all.length}</span>
                      {!editor.readOnly ? (
                        <Button
                          variant="link"
                          onClick={() => {
                            const next = new Set(editor.permissions);
                            // 已經全勾就整組取消，否則整組勾起來。
                            if (checkedCount === all.length) all.forEach((key) => next.delete(key));
                            else all.forEach((key) => next.add(key));
                            setEditor({ ...editor, permissions: next });
                          }}
                        >
                          {checkedCount === all.length ? "全部取消" : "全選"}
                        </Button>
                      ) : null}
                    </legend>

                    <div className="perm-grid">
                      {group.items.map((item) => (
                        /*
                         * 權限鍵值放 title 而不是印在標籤下面：它對管理者沒有意義，
                         * 但每一項多一行會讓 22 個權限變成一條要捲兩倍的長清單。
                         * 需要對照鍵值的人（通常是查 bug）滑上去就看得到。
                         */
                        <label className="perm-item" key={item.key} title={item.key}>
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
                          <span>{item.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}
        </Dialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title={`刪除「${deleteTarget.role.name}」？`}
          confirmLabel="刪除角色"
          pending={remove.isPending}
          onCancel={() => {
            remove.reset();
            setDeleteTarget(null);
          }}
          onConfirm={() => {
            remove.mutate(deleteTarget.role.key, {
              onSuccess: () => setDeleteTarget(null),
            });
          }}
        >
          <p><strong>這個動作無法復原。</strong></p>
          {deleteTarget.holders ? (
            <p>
              目前有 {deleteTarget.holders} 個人使用這個角色，刪除後他們會立刻失去這個角色帶來的權限。
            </p>
          ) : (
            <p>目前沒有使用者被指派這個角色。</p>
          )}
          <p className="muted">角色刪除後，相關的角色指派與權限設定也會一起移除。</p>
          {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
