import { useState } from "react";
import { useSession } from "../../auth/session.js";
import {
  useAssignRole,
  useCatalog,
  useInvite,
  useRevokeRole,
  useSetStatus,
  useSyncRoles,
  useUsers,
  type AdminUser,
  type Assignment,
  type Catalog,
} from "./api.js";

const STATUS_LABEL: Record<AdminUser["status"], string> = {
  invited: "已邀請",
  active: "啟用中",
  disabled: "已停用",
};

const SCOPE_LABEL: Record<string, string> = {
  store: "店別",
  warehouse: "倉庫",
};

function scopeText(assignment: Assignment): string {
  if (!assignment.scopeType) return "全部資料";
  return `${SCOPE_LABEL[assignment.scopeType] ?? assignment.scopeType}：${assignment.scopeId}`;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  // D1 存的是 UTC 的 CURRENT_TIMESTAMP（YYYY-MM-DD HH:MM:SS），沒有時區標記。
  const parsed = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

/** 角色與資料範圍的一組輸入。邀請表單與逐列指派共用同一個形狀。 */
function ScopeFields({
  catalog,
  roleKey,
  scopeType,
  scopeId,
  onChange,
  allowEmptyRole,
}: {
  catalog: Catalog;
  roleKey: string;
  scopeType: string;
  scopeId: string;
  onChange: (next: { roleKey: string; scopeType: string; scopeId: string }) => void;
  allowEmptyRole?: boolean;
}) {
  return (
    <>
      <select
        aria-label="角色"
        value={roleKey}
        onChange={(event) => onChange({ roleKey: event.target.value, scopeType, scopeId })}
      >
        {allowEmptyRole ? <option value="">先不指定角色</option> : null}
        {catalog.roles.map((role) => (
          <option key={role.key} value={role.key}>
            {role.name}
          </option>
        ))}
      </select>

      <select
        aria-label="資料範圍種類"
        value={scopeType}
        onChange={(event) =>
          onChange({ roleKey, scopeType: event.target.value, scopeId: event.target.value ? scopeId : "" })
        }
      >
        <option value="">全部資料</option>
        {catalog.scopeTypes.map((type) => (
          <option key={type} value={type}>
            {SCOPE_LABEL[type] ?? type}
          </option>
        ))}
      </select>

      {scopeType ? (
        <input
          aria-label="資料範圍名稱"
          placeholder={scopeType === "store" ? "例如 誠品西門店3F" : "例如 三重倉"}
          value={scopeId}
          onChange={(event) => onChange({ roleKey, scopeType, scopeId: event.target.value })}
        />
      ) : null}
    </>
  );
}

function InviteForm({ catalog }: { catalog: Catalog }) {
  const invite = useInvite();
  const [email, setEmail] = useState("");
  const [grant, setGrant] = useState({ roleKey: "", scopeType: "", scopeId: "" });

  return (
    <form
      className="admin-form"
      onSubmit={(event) => {
        event.preventDefault();
        invite.mutate(
          {
            email,
            ...(grant.roleKey ? { roleKey: grant.roleKey } : {}),
            ...(grant.scopeType ? { scopeType: grant.scopeType, scopeId: grant.scopeId } : {}),
          },
          {
            onSuccess: () => {
              setEmail("");
              setGrant({ roleKey: "", scopeType: "", scopeId: "" });
            },
          },
        );
      }}
    >
      <input
        aria-label="電子信箱"
        type="email"
        required
        placeholder="要邀請的 Google 帳號信箱"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <ScopeFields catalog={catalog} {...grant} onChange={setGrant} allowEmptyRole />

      <button type="submit" className="primary-button" disabled={invite.isPending}>
        {invite.isPending ? "邀請中…" : "邀請"}
      </button>

      {invite.error ? <p className="form-error" role="alert">{invite.error.message}</p> : null}
    </form>
  );
}

function AssignRow({ user, catalog, onDone }: { user: AdminUser; catalog: Catalog; onDone: () => void }) {
  const assign = useAssignRole();
  const [grant, setGrant] = useState({
    roleKey: catalog.roles[0]?.key ?? "",
    scopeType: "",
    scopeId: "",
  });

  return (
    <form
      className="admin-form inline"
      onSubmit={(event) => {
        event.preventDefault();
        assign.mutate({ id: user.id, ...grant }, { onSuccess: onDone });
      }}
    >
      <ScopeFields catalog={catalog} {...grant} onChange={setGrant} />
      <button type="submit" className="primary-button" disabled={assign.isPending}>
        指派
      </button>
      <button type="button" className="link-button" onClick={onDone}>
        取消
      </button>
      {assign.error ? <p className="form-error" role="alert">{assign.error.message}</p> : null}
    </form>
  );
}

function UserRow({ user, catalog, isSelf }: { user: AdminUser; catalog: Catalog; isSelf: boolean }) {
  const setStatus = useSetStatus();
  const revoke = useRevokeRole();
  const [assigning, setAssigning] = useState(false);
  const error = setStatus.error ?? revoke.error;

  return (
    <>
      <tr>
        <td>
          <div className="cell-strong">{user.name || "（尚未登入過）"}</div>
          <div className="cell-sub">{user.email}</div>
        </td>

        <td>
          <span className={`status status-${user.status}`}>{STATUS_LABEL[user.status]}</span>
          {isSelf ? <span className="cell-sub">這是你自己</span> : null}
        </td>

        <td>
          <div className="chips">
            {user.assignments.length === 0 ? <span className="cell-sub">沒有任何角色</span> : null}
            {user.assignments.map((assignment) => (
              <span className="chip" key={`${assignment.roleKey}-${assignment.scopeType}-${assignment.scopeId}`}>
                {assignment.roleName}
                <span className="chip-scope">{scopeText(assignment)}</span>
                <button
                  type="button"
                  aria-label={`收回 ${assignment.roleName}`}
                  onClick={() =>
                    revoke.mutate({
                      id: user.id,
                      roleKey: assignment.roleKey,
                      scopeType: assignment.scopeType,
                      scopeId: assignment.scopeId,
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {assigning ? (
            <AssignRow user={user} catalog={catalog} onDone={() => setAssigning(false)} />
          ) : (
            <button type="button" className="link-button" onClick={() => setAssigning(true)}>
              ＋ 指派角色
            </button>
          )}
        </td>

        <td className="cell-sub">{formatTime(user.lastLoginAt)}</td>

        <td>
          {user.status === "disabled" ? (
            <button
              type="button"
              className="ghost-button"
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate({ id: user.id, status: "active" })}
            >
              重新啟用
            </button>
          ) : (
            <button
              type="button"
              className="ghost-button danger"
              disabled={setStatus.isPending || user.status === "invited"}
              title={user.status === "invited" ? "還沒登入過的帳號不需要停用" : undefined}
              onClick={() => setStatus.mutate({ id: user.id, status: "disabled" })}
            >
              停用
            </button>
          )}
        </td>
      </tr>

      {error ? (
        <tr>
          <td colSpan={5}>
            <p className="form-error" role="alert">{error.message}</p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function AdminUsers() {
  const { user } = useSession();
  const users = useUsers();
  const catalog = useCatalog();
  const syncRoles = useSyncRoles();

  if (users.isPending || catalog.isPending) {
    return <div className="boot">載入中…</div>;
  }
  if (users.error || catalog.error) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>權限管理</h1>
        </header>
        <p className="form-error" role="alert">{(users.error ?? catalog.error)?.message}</p>
      </div>
    );
  }

  const catalogData = catalog.data;
  const list = users.data ?? [];

  return (
    <div className="page">
      <header className="page-head">
        <h1>權限管理</h1>
        <p className="muted">
          邀請制：帳號要先出現在這份名單，對方才能用 Google 登入。停用或調整角色會在對方的下一個請求立即生效。
        </p>
      </header>

      <section className="panel">
        <h2 className="panel-title">邀請新帳號</h2>
        <InviteForm catalog={catalogData} />
      </section>

      <section className="panel">
        <h2 className="panel-title">帳號（{list.length}）</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>成員</th>
                <th>狀態</th>
                <th>角色與資料範圍</th>
                <th>最後登入</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <UserRow key={row.id} user={row} catalog={catalogData} isSelf={row.id === user?.id} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">角色各自能做什麼</h2>
          <button
            type="button"
            className="ghost-button"
            disabled={syncRoles.isPending}
            onClick={() => syncRoles.mutate()}
          >
            {syncRoles.isPending ? "同步中…" : "重新同步"}
          </button>
        </div>
        <p className="muted">
          權限清單定義在程式碼（<code>packages/auth/src/permissions.ts</code>），改過並部署之後按一次
          「重新同步」就會寫進資料庫。這一頁改不了角色的內容，只能決定誰拿到哪個角色。
        </p>
        {syncRoles.error ? <p className="form-error" role="alert">{syncRoles.error.message}</p> : null}
        <div className="role-grid">
          {catalogData.roles.map((role) => (
            <div className="role-card" key={role.key}>
              <div className="cell-strong">{role.name}</div>
              <ul>
                {role.permissions.map((permission) => (
                  <li key={permission}>{catalogData.permissions[permission] ?? permission}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
