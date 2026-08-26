import type { Permission } from "@rueisiang/auth/permissions";
import { useState } from "react";
import { useSession } from "../../auth/session.js";
import {
  useAssignRole,
  useCatalog,
  useDeleteUser,
  useGrantPermission,
  useInvite,
  useResendInvite,
  useRevokePermission,
  useRevokeRole,
  useSetStatus,
  useSyncRoles,
  useUsers,
  type AdminUser,
  type Catalog,
} from "./api.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";

const STATUS_LABEL: Record<AdminUser["status"], string> = {
  invited: "已邀請",
  active: "啟用中",
  disabled: "已停用",
};

/**
 * 列表上要顯示的名字。
 *
 * 「（尚未登入過）」原本是用「名字是空的」推出來的，但那兩件事不是同一回事：
 * 走邀請連結設密碼的人可能沒填顯示名稱，卻天天在用。改成看 lastLoginAt——
 * 那才是「有沒有登入過」的真正答案。
 */
function displayNameOf(user: AdminUser): string {
  if (user.name) return user.name;
  return user.lastLoginAt ? "（未設定名稱）" : "（尚未登入過）";
}

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
        <Button
          variant="secondary"
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
        </Button>
        <Button variant="secondary" onClick={onDismiss}>知道了</Button>
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
      <TextField
        label="電子信箱"
        type="email"
        required
        placeholder="要邀請的信箱"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      <SelectField
        label="角色"
        value={roleKey}
        onChange={(event) => setRoleKey(event.target.value)}
        options={[
          { label: "先不指定角色", value: "" },
          ...catalog.roles.map((role) => ({ label: role.name, value: role.key })),
        ]}
      />

      <Button type="submit" loading={invite.isPending} loadingLabel="邀請中…">
        邀請
      </Button>

      {invite.error ? <Alert tone="danger">{invite.error.message}</Alert> : null}
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
  direct,
  isSelf,
  onClose,
}: {
  user: AdminUser;
  catalog: Catalog;
  direct: Permission[];
  isSelf: boolean;
  onClose: () => void;
}) {
  const assign = useAssignRole();
  const revoke = useRevokeRole();
  const setStatus = useSetStatus();
  const remove = useDeleteUser();
  const grant = useGrantPermission();
  const revokeDirect = useRevokePermission();
  const toast = useToast();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const held = new Set(user.assignments.map((assignment) => assignment.roleKey));
  const pending =
    assign.isPending ||
    revoke.isPending ||
    setStatus.isPending ||
    remove.isPending ||
    grant.isPending ||
    revokeDirect.isPending;
  const error =
    assign.error ?? revoke.error ?? setStatus.error ?? remove.error ?? grant.error ?? revokeDirect.error;

  // 自己的角色與權限一律不能改。後端也擋——這裡只是不要讓人白按一次。
  const locked = pending || isSelf;
  const directSet = new Set(direct);

  /*
   * 這個人實際上能做什麼＝手上所有角色的權限聯集。管理者最常問的其實是這句話，
   * 但原本的畫面只給角色名稱，要自己去角色管理頁一個一個點開對照。
   */
  const fromRoles = new Set(
    user.assignments.flatMap(
      (assignment) => catalog.roles.find((role) => role.key === assignment.roleKey)?.permissions ?? [],
    ),
  );
  const effective = new Set([...fromRoles, ...direct]);

  return (
    <>
      <Dialog
      title={displayNameOf(user)}
      titleMeta={user.email}
      className="wide"
      onClose={onClose}
      closeDisabled={pending}
      actions={
        <>
          {/*
            * 刪除只在已停用時出現。「先停用再刪」是刻意的兩步：停用可逆、
            * 刪除不可逆，中間那一步就是確認。靠左放，跟右邊的「關閉」拉開距離，
            * 免得想關掉的人手滑按到。
            */}
          {/* 啟用中的要先停用才能刪；已停用與還沒登入過的都可以直接清掉。 */}
          {user.status !== "active" ? (
            <Button
              variant="secondary"
              className="danger delete-action"
              disabled={pending}
              onClick={() => setConfirmingDelete(true)}
            >
              刪除帳號
            </Button>
          ) : null}
          <Button variant="secondary" type="button" onClick={onClose} disabled={pending}>關閉</Button>
        </>
      }
    >
          {error ? <Alert tone="danger">{error.message}</Alert> : null}
          {isSelf ? (
            <p className="muted perm-hint">
              這是你自己的帳號。角色與權限不能自己調整——否則「能改權限」就等於「是管理者」，
              分層就沒有意義了。需要調整請由另一位管理者操作。
            </p>
          ) : null}

          <div className="field">
            <span>狀態</span>
            <div className="admin-form row">
              <span className={`status status-${user.status}`}>{STATUS_LABEL[user.status]}</span>
              {user.status === "disabled" ? (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    setStatus.mutate(
                      { id: user.id, status: "active" },
                      { onSuccess: () => toast.show(`已重新啟用 ${user.email}`) },
                    )
                  }
                >
                  重新啟用
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className="danger"
                  disabled={pending || user.status === "invited"}
                  title={user.status === "invited" ? "還沒登入過的帳號不需要停用" : undefined}
                  onClick={() =>
                    setStatus.mutate(
                      { id: user.id, status: "disabled" },
                      { onSuccess: () => toast.show(`已停用 ${user.email}`) },
                    )
                  }
                >
                  停用
                </Button>
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
                    disabled={locked}
                    onChange={(event) => {
                      /*
                       * 勾＝指派、取消＝收回。兩個端點本來就存在，這裡只是換一個操作方式。
                       *
                       * 點擊當下就把值抓成常數。onSuccess 是等 API 回來才跑的，那時候
                       * 資料已經重抓、checkbox 也重繪了——在回呼裡讀 event.target.checked
                       * 拿到的是新狀態，訊息會剛好講反。
                       */
                      const adding = event.target.checked;
                      const done = {
                        onSuccess: () => toast.show(`${adding ? "已指派" : "已收回"}「${role.name}」`),
                      };
                      if (adding) assign.mutate({ id: user.id, roleKey: role.key }, done);
                      else revoke.mutate({ id: user.id, roleKey: role.key }, done);
                    }}
                  />
                  <span>{role.name}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/*
            * 額外授予：繞過角色、只給這一個人的權限。
            *
            * 已經被角色涵蓋的項目畫成打勾但不可點——單獨再給一次不會有任何效果，
            * 讓人按得下去只會製造「我明明給了為什麼收不回來」的困惑。
            */}
          <fieldset className="perm-group">
            <legend>
              額外授予的權限
              <span className="perm-count">{direct.length}</span>
            </legend>
            <p className="muted perm-hint">
              角色以外的例外。適合「這個月幫忙跑出金表」這種一個人的特例，
              不必為了一個人開一個新角色。只加不減，收不掉角色本來就有的權限。
            </p>
            <div className="perm-grid">
              {Object.entries(catalog.permissions).map(([key, label]) => {
                const permission = key as Permission;
                const byRole = fromRoles.has(permission);
                return (
                  <label
                    className="perm-item"
                    key={key}
                    title={byRole ? `已由角色提供：${key}` : key}
                  >
                    <input
                      type="checkbox"
                      checked={byRole || directSet.has(permission)}
                      disabled={locked || byRole}
                      onChange={(event) => {
                        // 同上：回呼裡讀 event.target.checked 會拿到重繪後的新狀態。
                        const adding = event.target.checked;
                        const done = {
                          onSuccess: () => toast.show(`${adding ? "已授予" : "已收回"}「${label}」`),
                        };
                        if (adding) grant.mutate({ id: user.id, permission }, done);
                        else revokeDirect.mutate({ id: user.id, permission }, done);
                      }}
                    />
                    <span>
                      {label}
                      {byRole ? <small>來自角色</small> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="field">
            <span>
              這個人實際能做什麼
              <span className="perm-count">{effective.size}</span>
            </span>
            <small>角色帶來的 ＋ 額外授予的，取聯集。</small>
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
      </Dialog>

      {confirmingDelete ? (
        <ConfirmDialog
          title={`刪除「${user.email}」？`}
          confirmLabel="刪除帳號"
          pending={remove.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() =>
            remove.mutate(user.id, {
              onSuccess: () => {
                toast.show(`已刪除 ${user.email}`);
                onClose();
              },
            })
          }
        >
          <p>這個動作<strong>無法復原</strong>。</p>
          <p className="muted">
            他的角色指派與額外授予的權限會一起消失。操作紀錄與出金表執行紀錄會留著——
            那些存的是當時的信箱，不是帳號連結，所以「這筆是誰做的」仍然答得出來。
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}

function UserRow({
  user,
  catalog,
  isSelf,
  direct,
  onInviteUrl,
}: {
  user: AdminUser;
  catalog: Catalog;
  isSelf: boolean;
  /** 單獨授予這個人的權限（不含角色帶來的）。 */
  direct: Permission[];
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
          <div className="cell-strong">{displayNameOf(user)}</div>
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
          <Button
            variant="icon"
            icon="edit"
            onClick={() => setEditing(true)}
            title="編輯角色與狀態"
            aria-label={`編輯 ${user.email}`}
          />
          {/*
            * 還沒啟用的帳號才給重發。已啟用的人按這個會拿到一條能設新密碼的連結，
            * 那等於一個不必驗證就能改密碼的後門——後端也擋了，這裡不畫出來而已。
            */}
          {user.status === "invited" ? (
            <Button
              variant="secondary"
              loading={resend.isPending}
              loadingLabel="產生中…"
              onClick={() =>
                resend.mutate(user.id, {
                  onSuccess: (result) => onInviteUrl(user.email, result.inviteUrl),
                })
              }
            >
              重發連結
            </Button>
          ) : null}
          </div>
        </td>
      </tr>

      {error ? (
        <tr>
          <td colSpan={5}>
            <Alert tone="danger">{error.message}</Alert>
          </td>
        </tr>
      ) : null}

      {editing ? (
        <UserEditor
          user={user}
          catalog={catalog}
          direct={direct}
          isSelf={isSelf}
          onClose={() => setEditing(false)}
        />
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
        <PageHeader title="權限管理" />
        <Alert tone="danger">{(users.error ?? catalog.error)?.message}</Alert>
      </div>
    );
  }

  const catalogData = catalog.data;
  const list = users.data?.users ?? [];
  const directByUser = users.data?.directPermissions ?? {};

  return (
    <div className="page fills">
      <PageHeader
        title="權限管理"
        description={
          <>
          邀請制：帳號要先出現在這份名單，對方才能用 Google 登入。停用或調整角色會在對方的下一個請求立即生效。
          </>
        }
        actions={
          <Button
            variant="secondary"
            loading={syncRoles.isPending}
            loadingLabel="同步中…"
            onClick={() => syncRoles.mutate()}
          >
            重新同步角色
          </Button>
        }
      />

      {syncRoles.error ? <Alert tone="danger">{syncRoles.error.message}</Alert> : null}

      <Panel title="邀請新帳號">
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
      </Panel>

      <Panel title={`帳號（${list.length}）`} className="grows">
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
                  direct={directByUser[row.id] ?? []}
                  onInviteUrl={(email, url) => setInviteLink({ email, url })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

    </div>
  );
}
