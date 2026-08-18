import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  buildAuthorizeUrl,
  clearCookie,
  createPkce,
  exchangeCode,
  newSessionClaims,
  permissionsOf,
  randomToken,
  readCookie,
  serializeCookie,
  signPayload,
  signSession,
  verifyIdToken,
  verifyPayload,
  type Expiring,
} from "@rueisiang/auth";
import { loadAuthUser, recordLogin, updateProfile } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth } from "../middleware/auth.js";

/** 授權流程進行中的暫存狀態，用簽章 cookie 帶著走，不佔伺服器狀態。 */
const TRANSACTION_COOKIE = "rueisiang_oauth";
const TRANSACTION_TTL_SECONDS = 10 * 60;
const CALLBACK_PATH = "/api/auth/google/callback";

interface OAuthTransaction extends Expiring {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

function callbackUrl(requestUrl: string): string {
  return new URL(CALLBACK_PATH, requestUrl).toString();
}

/** returnTo 只接受站內路徑，避免被拿來做開放轉址。 */
function safeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export const auth = new Hono<AppEnv>()
  .get("/google/start", async (c) => {
    const { verifier, challenge } = await createPkce();
    const transaction: OAuthTransaction = {
      state: randomToken(),
      nonce: randomToken(),
      verifier,
      returnTo: safeReturnTo(c.req.query("returnTo")),
      expiresAt: Math.floor(Date.now() / 1000) + TRANSACTION_TTL_SECONDS,
    };

    const token = await signPayload(transaction, c.env.AUTH_SESSION_SECRET);

    c.header(
      "Set-Cookie",
      serializeCookie(TRANSACTION_COOKIE, token, {
        maxAge: TRANSACTION_TTL_SECONDS,
        path: CALLBACK_PATH,
      }),
    );

    return c.redirect(
      buildAuthorizeUrl({
        clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
        redirectUri: callbackUrl(c.req.url),
        state: transaction.state,
        nonce: transaction.nonce,
        codeChallenge: challenge,
      }),
    );
  })

  .get("/google/callback", async (c) => {
    const failure = (reason: string) =>
      c.redirect(`/login?error=${encodeURIComponent(reason)}`);

    const stored = readCookie(c.req.header("Cookie"), TRANSACTION_COOKIE);
    const transaction = await verifyPayload<OAuthTransaction>(stored, c.env.AUTH_SESSION_SECRET);

    // 不論成敗都先把一次性的交易 cookie 清掉。
    c.header("Set-Cookie", clearCookie(TRANSACTION_COOKIE, CALLBACK_PATH), { append: true });

    if (!transaction) return failure("登入流程已逾時，請重新登入。");
    if (c.req.query("state") !== transaction.state) return failure("登入驗證失敗，請重新登入。");

    const code = c.req.query("code");
    if (!code) return failure("Google 沒有回傳授權碼。");

    let identity;
    try {
      const { idToken } = await exchangeCode({
        code,
        clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
        clientSecret: c.env.GOOGLE_OAUTH_CLIENT_SECRET,
        redirectUri: callbackUrl(c.req.url),
        codeVerifier: transaction.verifier,
      });
      identity = await verifyIdToken(idToken, {
        clientId: c.env.GOOGLE_OAUTH_CLIENT_ID,
        nonce: transaction.nonce,
      });
    } catch (error) {
      console.error("Google 登入失敗", error);
      return failure("Google 登入失敗，請再試一次。");
    }

    // 邀請制：沒有這個 email 的帳號就不給進，不自動建立。
    const user = await loadAuthUser(c.get("db"), { email: identity.email });
    if (!user) return failure("這個 Google 帳號尚未被邀請使用本系統。");
    if (user.status === "disabled") return failure("這個帳號已停用。");

    await recordLogin(c.get("db"), user.id, {
      googleSubject: identity.subject,
      name: identity.name,
      pictureUrl: identity.pictureUrl,
    });

    const session = await signSession(
      newSessionClaims({
        id: user.id,
        email: user.email,
        name: identity.name,
        pictureUrl: identity.pictureUrl,
      }),
      c.env.AUTH_SESSION_SECRET,
    );
    c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS }), {
      append: true,
    });

    return c.redirect(transaction.returnTo);
  })

  .post("/logout", (c) => {
    c.header("Set-Cookie", clearCookie(SESSION_COOKIE));
    return c.json({ ok: true });
  })

  /**
   * 更新自己的個人資料。只開放顯示名稱——email 是身分本身，授權判定與往後的
   * 操作紀錄都認它，讓人自己改等於讓人改掉自己在紀錄裡是誰。
   *
   * 不需要額外權限：這條只動 requireAuth 認出來的那個人自己的那一列。
   */
  .patch("/profile", requireAuth, async (c) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "請求內容不是有效的 JSON。" });
    }

    const value = (input as { displayName?: unknown } | null)?.displayName;
    if (typeof value !== "string") {
      throw new HTTPException(400, { message: "顯示名稱格式不正確。" });
    }
    const displayName = value.trim();
    if (displayName.length > 40) {
      throw new HTTPException(400, { message: "顯示名稱不能超過 40 個字。" });
    }

    await updateProfile(c.get("db"), c.get("user").id, { displayName });
    return c.json({ displayName });
  })

  /** 前端啟動時呼叫這一條決定 sidebar 顯示什麼。權限仍以每個 API 自己的檢查為準。 */
  .get("/me", requireAuth, (c) => {
    const user = c.get("user");
    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
      googleName: user.googleName,
      pictureUrl: user.pictureUrl,
      permissions: permissionsOf(user),
      roles: user.assignments.map((assignment) => ({
        role: assignment.roleKey,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      })),
    });
  });
