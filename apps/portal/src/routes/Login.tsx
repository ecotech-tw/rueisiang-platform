import { useState } from "react";
import { useSearchParams } from "react-router";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Button, TextField } from "../ui/index.js";

/**
 * 登入頁。兩條路：Google 帳號，或邀請時設好的 email / 密碼。
 *
 * 兩條都直接攤開，不做「點一下才展開」——多一次點擊只是把「我要用哪個」
 * 這個問題往後推一步。帳密那組本來就是給沒有公司 Google 帳號的人用的，
 * 藏起來等於要他先猜到有這條路。crm.rueisiang.com 也是這樣排。
 *
 * 兩條都是邀請制：名單裡沒有的 email 兩邊都進不來。
 */
function safeReturnTo(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value;
  return "/";
}

export function Login() {
  usePageTitle("登入");
  const [params] = useSearchParams();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const googleReturnTo = `${window.location.origin}${returnTo}`;

  // Google 那條失敗時會帶 ?error= 轉回來；帳密那條的錯誤存在自己的 state。
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(params.get("error"));
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "登入失敗，請稍後再試。");
        return;
      }
      /*
       * 用整頁跳轉而不是 react-router 的 navigate：session cookie 剛剛才發下來，
       * 重新載入一次最省事，也保證 /api/auth/me 是拿新的身分去問。
       */
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

        <a className="login-button" href={`/api/auth/google/start?returnTo=${encodeURIComponent(googleReturnTo)}`}>
          使用 Google 帳號登入
        </a>

        {/* 分隔線把兩條路切開，免得下面的表單看起來像 Google 按鈕的附屬欄位。 */}
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
