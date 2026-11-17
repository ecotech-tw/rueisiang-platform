import { useState } from "react";
import { useSearchParams } from "react-router";
import { isSignedOutEntry, useSession } from "../auth/session.js";
import { isLiffClient } from "../auth/liff.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { Button, LoginButton, LoginCard, LoginDivider, LoginError, LoginForm, LoginNote, TextField } from "../ui/index.js";
import { API_BASE_URL } from "../config.js";

function safeReturnTo(value: string | null): string {
  if (!value) return "/";
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname.replace(/\/$/, "") === "/login") return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export function Login() {
  usePageTitle("登入");
  const [params] = useSearchParams();
  const { error: sessionError } = useSession();
  const returnTo = safeReturnTo(params.get("returnTo"));
  const googleReturnTo = `${window.location.origin}${returnTo}`;
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
    <LoginCard title="內部系統">
        <p className="muted">用公司的 Google 帳號，或邀請信裡設定的密碼登入。</p>

        {error || sessionError ? <LoginError>{error ?? (sessionError instanceof Error ? sessionError.message : "讀取登入狀態失敗，請重新載入。")}</LoginError> : null}

        {isSignedOutEntry() && isLiffClient() ? <>
          <p className="muted">已登出此裝置，LINE 綁定仍保留。可重新登入，或關閉後再從 LINE 開啟 HR。</p>
          <LoginButton href={returnTo}>使用 LINE 重新登入</LoginButton>
        </> : null}

        <LoginButton href={`${API_BASE_URL}/auth/google/start?returnTo=${encodeURIComponent(googleReturnTo)}`}>
          使用 Google 帳號登入
        </LoginButton>

        <LoginDivider>或使用帳號密碼登入</LoginDivider>

        <LoginForm onSubmit={submit}>
          <TextField inputClassName="w-full" label="Email" required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
          <TextField inputClassName="w-full" label="密碼" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <Button type="submit" size="lg" className="w-full" disabled={pending}>
            {pending ? "登入中…" : "登入"}
          </Button>
        </LoginForm>

        <LoginNote>
          帳號需要先由管理者邀請才能登入。找不到人開通時請聯絡資訊窗口。
        </LoginNote>
    </LoginCard>
  );
}
