import { useState } from "react";
import { useSearchParams } from "react-router";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Button, TextField } from "../ui/index.js";
import { API_BASE_URL } from "../config.js";

export function Login() {
  usePageTitle("登入");
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo") ?? "/";
  const googleReturnTo = returnTo.startsWith("http") ? returnTo : `${window.location.origin}${returnTo}`;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(params.get("error"));
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/password`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "登入失敗，請稍後再試。");
        return;
      }
      window.location.assign(returnTo);
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
        <h1>內部系統</h1>
        <p className="muted">用公司的 Google 帳號，或邀請信裡設定的密碼登入。</p>

        {error ? <p className="login-error" role="alert">{error}</p> : null}

        <a className="login-button" href={`${API_BASE_URL}/auth/google/start?returnTo=${encodeURIComponent(googleReturnTo)}`}>
          使用 Google 帳號登入
        </a>

        <div className="login-divider"><span>或使用帳號密碼登入</span></div>

        <form className="login-form" onSubmit={submit}>
          <TextField label="Email" required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          <TextField label="密碼" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <Button type="submit" className="login-submit" disabled={pending}>
            {pending ? "登入中…" : "登入"}
          </Button>
        </form>

        <p className="muted login-note">
          帳號需要先由管理者邀請才能登入。找不到人開通時請聯絡資訊窗口。
        </p>
      </div>
    </div>
  );
}
