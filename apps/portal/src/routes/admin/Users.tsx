import { useState } from "react";
import { useSession } from "../../auth/session.js";
import {
  useAssignRole,
  useCatalog,
  useInvite,
  useResendInvite,
  useRevokeRole,
  useSetStatus,
  useSyncRoles,
  useUsers,
  type AdminUser,
  type Catalog,
} from "./api.js";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";

const STATUS_LABEL: Record<AdminUser["status"], string> = {
  invited: "已邀請",
  active: "啟用中",
  disabled: "已停用",
};

function formatTime(value: string | null): string {
  if (!value) return "—";
  // D1 存的是 UTC 的 CURRENT_TIMESTAMP（YYYY-MM-DD HH:MM:SS），沒有時區標記。
  const parsed = new Date(value.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

/**
 * 邀請連結。
 *
 * 目前沒有寄信，所以連結要直接顯示出來讓管理者自己傳給對方。
 * 它**只有這一次拿得到**——資料庫只存雜湊，弄丟了只能重發。所以這一塊不會
 * 自動收起來，要按「知道了」才消失。
 */
function InviteLink({ email, url, onDismiss }: { email: string; url: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="invite-link" role="status">
      <div>
        <strong>已邀請 {email}</strong>
        <p className="muted">
          把這條連結傳給對方，他設定密碼之後就能登入。連結七天內有效，
          而且<b>只會出現這一次</b>——關掉之後要重發才拿得到新的。
        </p>
      </div>
      <div className="invite-link-row">
        <input readOnly value={url} onFocus={(event) => event.target.select()} />
        <button
          type="button"
          className="ghost-button"
          onClick={async () => {
            /*
             * clipboard API 在非 HTTPS 或使用者拒絕權限時會丟。連結本來就顯示在
             * 旁邊而且是全選狀態，複製不了自己框起來也行，不要跳一個錯誤嚇人。
             */
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "已複製" : "複製"}
        </button>
        <button type="button" className="ghost-button" onClick={onDismiss}>知道了</button>
      </div>
    </div>
  );
}

function InviteForm({
  catalog,
  onInviteUrl,
}: {
  catalog: Catalog;
  onInviteUrl: (email: string, url: string) => void;
}) {
  const invite = useInvite();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("");

  return (
    <form
      className="admin-form"
      onSubmit={(event) => {
        event.preventDefault();
        invite.mutate(
          { email, ...(roleKey ? { roleKey } : {}) },
          {
            onSuccess: (result) => {
              onInviteUrl(result.email, result.inviteUrl);
              setEmail("");
              setRoleKey("");
            },
          },
        );
      }}
    >
      <input
        aria-label="電子信箱"
        type="email"
        required
        placeholder="要邀請的信箱"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <select aria-label="角色" value={roleKey} onChange={(event) => setRoleKey(event.target.value)}>
        <option value="">先不指定角色</option>
        {catalog.roles.map((role) => (
          <option key={role.key} value={role.key}>{role.name}</option>
        ))}
      </select>

      <button type="submit" className="primary-button" disabled={invite.isPending}>
        {invite.isPending ? "邀請中…" : "邀請"}
      </button>

      {invite.error ? <p className="form-error" role="alert">{invite.error.message}</p> : null}
    </form>
  );
}

/**
 * 帳號的編輯對話框。
 *
 * 原本是在表格列裡直接長出一個下拉選單。問題不只是難看：那一列會突然變高、
 * 把下面的資料往下推，而且角色一多，chips 就把「最後登入」擠到看不見——
 * 每一列的高度都不一樣，整張表讀起來很吃力。
 *
 * 改成對話框之後表格只負責「看」，所有「改」集中在這裡。之後要加「額外授予
 * 單一權限」也是長在這個對話框裡，不用再動表格。
 */
function UserEditor({
  user,
  catalog,
  onClose,
}: {
  user: AdminUser;
  catalog: Catalog;
  onClose: () => void;
}) {
  const assign = useAssignRole();
  const revoke = useRevokeRole();
  const setStatus = useSetStatus();

  const held = new Set(user.assignments.map((assignment) => assignment.roleKey));
  const pending = assign.isPending || revoke.isPending || setStatus.isPending;
  const error = assign.error ?? revoke.error ?? setStatus.error;

  /*
   * 這個人實際上能做什麼＝手上所有角色的權限聯集。管理者最常問的其實是這句話，
   * 但原本的畫面只給角色名稱，要自己去角色管理頁一個一個點開對照。
   */
  const effective = new Set(
    user.assignments.flatMap(
      (assignment) => catalog.roles.find((role) => role.key === assignment.roleKey)?.permissions ?? [],
    ),
  );

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div className="modal-card wide" role="dialog" aria-modal="true" aria-labelledby="user-editor-title">
        <div className="modal-head">
          <div>
            <h2 id="user-editor-title">{user.name || "（尚未登入過）"}</h2>
            <p className="muted">{user.email}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={pending} title="關閉" aria-label="關閉">
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body">
          {error ? <p className="form-error" role="alert">{error.message}</p> : null}

          <div className="field">
            <span>狀態</span>
            <div className="admin-form inline">
              <span className={`status status-${user.status}`}>{STATUS_LABEL[user.status]}</span>
              {user.status === "disabled" ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={pending}
                  onClick={() => setStatus.mutate({ id: user.id, status: "active" })}
                >
                  重新啟用
                </button>
              ) : (
                <button
                  type="button"
                  className="ghost-button danger"
                  disabled={pending || user.status === "invited"}
                  title={user.status === "invited" ? "還沒登入過的帳號不需要停用" : undefined}
                  onClick={() => setStatus.mutate({ id: user.id, status: "disabled" })}
                >
                  停用
                </button>
              )}
            </div>
          </div>

          <fieldset className="perm-group">
            <legend>
              角色
              <span className="perm-count">{held.size}/{catalog.roles.length}</span>
            </legend>
            <div className="perm-grid">
              {catalog.roles.map((role) => (
                <label className="perm-item" key={role.key} title={role.description || undefined}>
                  <input
                    type="checkbox"
                    checked={held.has(role.key)}
                    disabled={pending}
                    onChange={(event) => {
                      // 勾＝指派、取消＝收回。兩個端點本來就存在，這裡只是換一個操作方式。
                      if (event.target.checked) assign.mutate({ id: user.id, roleKey: role.key });
                      else revoke.mutate({ id: user.id, roleKey: role.key });
                    }}
                  />
                  <span>{role.name}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <span>
              這個人實際能做什麼
              <span className="perm-count">{effective.size}</span>
            </span>
            <small>由上面勾選的角色決定，不能單獨調整。</small>
            {effective.size === 0 ? (
              <p className="muted">沒有任何權限，登入後看不到任何頁面。</p>
            ) : (
              <div className="chips tight">
                {[...effective].map((permission) => (
                  <span className="chip subtle" key={permission}>
                    {catalog.permissions[permission] ?? permission}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={pending}>關閉</button>
        </div>
      </div>
    </div>
  );
}

function UserRow({
  user,
  catalog,
  isSelf,
  onInviteUrl,
}: {
  user: AdminUser;
  catalog: Catalog;
  isSelf: boolean;
  /** 重發出來的連結交給上層顯示——它跟邀請當下那條走同一塊 UI。 */
  onInviteUrl: (email: string, url: string) => void;
}) {
  const resend = useResendInvite();
  const [editing, setEditing] = useState(false);
  const error = resend.error;

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

        {/* 表格只負責看，所有的改都在對話框裡——每列高度才會一致。 */}
        <td>
          {user.assignments.length === 0 ? (
            <span className="cell-sub">沒有任何角色</span>
          ) : (
            <div className="chips tight">
              {user.assignments.map((assignment) => (
                <span className="chip subtle" key={assignment.roleKey}>{assignment.roleName}</span>
              ))}
            </div>
          )}
        </td>

        <td className="cell-sub">{formatTime(user.lastLoginAt)}</td>

        <td>
          <div className="row-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setEditing(true)}
            title="編輯角色與狀態"
            aria-label={`編輯 ${user.email}`}
          >
            <Icon name="edit" />
          </button>
          {/*
            * 還沒啟用的帳號才給重發。已啟用的人按這個會拿到一條能設新密碼的連結，
            * 那等於一個不必驗證就能改密碼的後門——後端也擋了，這裡不畫出來而已。
            */}
          {user.status === "invited" ? (
            <button
              type="button"
              className="ghost-button"
              disabled={resend.isPending}
              onClick={() =>
                resend.mutate(user.id, {
                  onSuccess: (result) => onInviteUrl(user.email, result.inviteUrl),
                })
              }
            >
              {resend.isPending ? "產生中…" : "重發連結"}
            </button>
          ) : null}
          </div>
        </td>
      </tr>

      {error ? (
        <tr>
          <td colSpan={5}>
            <p className="form-error" role="alert">{error.message}</p>
          </td>
        </tr>
      ) : null}

      {editing ? (
        <UserEditor user={user} catalog={catalog} onClose={() => setEditing(false)} />
      ) : null}
    </>
  );
}

export function AdminUsers() {
  usePageTitle("權限管理");
  const { user } = useSession();
  const users = useUsers();
  const catalog = useCatalog();
  const syncRoles = useSyncRoles();
  // 邀請與重發都會產出連結，共用同一塊顯示區域。
  const [inviteLink, setInviteLink] = useState<{ email: string; url: string } | null>(null);

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
        <InviteForm catalog={catalogData} onInviteUrl={(email, url) => setInviteLink({ email, url })} />
        {/*
          * 連結放在表單下面而不是跳一個對話框：管理者常常要連續邀好幾個人，
          * 每次都要關掉一個 modal 才能打下一個 email 很煩。
          */}
        {inviteLink ? (
          <InviteLink
            email={inviteLink.email}
            url={inviteLink.url}
            onDismiss={() => setInviteLink(null)}
          />
        ) : null}
      </section>

      <section className="panel">
        <h2 className="panel-title">帳號（{list.length}）</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>成員</th>
                <th>狀態</th>
                <th>角色</th>
                <th>最後登入</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <UserRow
                  key={row.id}
                  user={row}
                  catalog={catalogData}
                  isSelf={row.id === user?.id}
                  onInviteUrl={(email, url) => setInviteLink({ email, url })}
                />
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
