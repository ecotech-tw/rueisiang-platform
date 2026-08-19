import { useSearchParams } from "react-router";
import { usePageTitle } from "../shell/usePageTitle.js";

export function Login() {
  usePageTitle("登入");
  const [params] = useSearchParams();
  const error = params.get("error");
  const returnTo = params.get("returnTo") ?? "/";

  return (
    <div className="login-page">
      <div className="login-card">
        <img className="login-logo" src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={168} height={45} />
        <h1>內部系統</h1>
        <p className="muted">請使用公司的 Google 帳號登入。</p>

        {error ? <p className="login-error" role="alert">{error}</p> : null}

        <a className="login-button" href={`/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`}>
          使用 Google 帳號登入
        </a>

        <p className="muted login-note">
          帳號需要先由管理者邀請才能登入。找不到人開通時請聯絡資訊窗口。
        </p>
      </div>
    </div>
  );
}
