import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";

const ROLE_LABEL: Record<string, string> = {
  admin: "管理者",
  manager: "主管",
  staff: "一般同仁",
  viewer: "檢視者",
};

/**
 * 個人資料。只有顯示名稱可以改。
 *
 * email 不開放修改：授權判定用它比對邀請名單，往後的操作紀錄也認它，
 * 讓人自己改等於讓人改掉自己在紀錄裡是誰。頭像與 Google 姓名同理，
 * 每次登入都會被 Google 覆寫，放在這裡讓人改只會讓人以為改得掉。
 */
export function Profile() {
  usePageTitle("我的帳號");
  const { user } = useSession();
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState(user?.name ?? "");
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (value: string) => {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: value }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `儲存失敗（${response.status}）`);
      }
      return response.json();
    },
    onSuccess: () => {
      setSaved(true);
      // sidebar 與這一頁都讀同一份 session，改完要重新拉才會同步。
      void client.invalidateQueries({ queryKey: ["session"] });
    },
  });

  if (!user) return <div className="boot">載入中…</div>;

  return (
    <div className="page">
      <header className="page-head">
        <h1>個人資料</h1>
        <p className="muted">這裡只有顯示名稱可以改，其餘欄位由登入方式與權限決定。</p>
      </header>

      <section className="panel">
        <h2 className="panel-title">顯示名稱</h2>
        <form
          className="admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate(displayName);
          }}
        >
          <input
            aria-label="顯示名稱"
            placeholder={user.email}
            maxLength={40}
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              setSaved(false);
            }}
          />
          <button type="submit" className="primary-button" disabled={save.isPending}>
            {save.isPending ? "儲存中…" : "儲存"}
          </button>
          {saved ? <span className="form-hint">已儲存</span> : null}
          {save.error ? <p className="form-error" role="alert">{save.error.message}</p> : null}
        </form>
        <p className="muted form-foot">
          留白就會用回 Google 帳號上的姓名。這個名字只影響畫面顯示，操作紀錄一律以電子信箱為準。
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">帳號</h2>
        <dl className="detail-list">
          <div>
            <dt>電子信箱</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Google 帳號姓名</dt>
            <dd>{user.googleName || "—"}</dd>
          </div>
          <div>
            <dt>角色</dt>
            <dd>
              {user.roles.length === 0
                ? "沒有任何角色"
                : user.roles.map((role) => ROLE_LABEL[role] ?? role).join("、")}
            </dd>
          </div>
        </dl>
        <p className="muted form-foot">
          要調整角色請找管理者，這一頁改不了——不然權限就形同虛設。
        </p>
      </section>
    </div>
  );
}
