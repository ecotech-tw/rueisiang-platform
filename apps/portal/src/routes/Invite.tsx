import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { usePageTitle } from "../shell/usePageTitle.js";

/**
 * 走邀請連結設定密碼。
 *
 * 這一頁在登入之前，所以不套 AppShell、也不能用任何需要 session 的資料。
 *
 * 載入時先問一次連結有沒有效：讓人填完整張表才被告知「連結已過期」是最容易
 * 讓人放棄的做法。設完密碼直接帶進系統，不用再回登入頁輸入一次。
 */
export function Invite() {
  usePageTitle("設定密碼");
  const { token = "" } = useParams();

  const [email, setEmail] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`);
        const payload = (await response.json().catch(() => null)) as
          | { email?: string; error?: string }
          | null;
        if (cancelled) return;
        if (!response.ok) setError(payload?.error ?? "邀請連結無效或已過期。");
        else setEmail(payload?.email ?? null);
      } catch {
        if (!cancelled) setError("連不上伺服器，請檢查網路後再試。");
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirmPassword, displayName }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "設定失敗，請稍後再試。");
        return;
      }
      // 後端設完密碼就發了 session，直接整頁跳進系統。
      window.location.assign("/");
    } catch {
      setError("連不上伺服器，請檢查網路後再試。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img className="login-logo" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={168} height={45} />
        <h1>設定密碼</h1>

        {checking ? <p className="muted">確認邀請連結…</p> : null}

        {!checking && !email ? (
          <>
            <p className="login-error" role="alert">{error ?? "邀請連結無效或已過期。"}</p>
            <p className="muted login-note">請聯絡管理者重新發送一條連結。</p>
          </>
        ) : null}

        {email ? (
          <>
            <p className="muted">
              正在為 <strong>{email}</strong> 設定密碼。設定完成後就能用這組 Email 與密碼登入，
              也仍然可以改用同一個信箱的 Google 帳號登入。
            </p>

            {error ? <p className="login-error" role="alert">{error}</p> : null}

            <form className="login-form" onSubmit={submit}>
              <label className="field">
                <span>顯示名稱</span>
                <input
                  value={displayName}
                  maxLength={40}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="其他人在系統裡看到的名字"
                />
              </label>
              <label className="field">
                <span>密碼<b>至少 8 個字元</b></span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <label className="field">
                <span>再輸入一次</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <button type="submit" className="primary-button" disabled={pending}>
                {pending ? "設定中…" : "設定密碼並進入系統"}
              </button>
            </form>
          </>
        ) : null}
      </div>
    </div>
  );
}
