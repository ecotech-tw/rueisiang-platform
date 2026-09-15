import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  buildAuthorizeUrl,
  clearCookie,
  createPkce,
  exchangeCode,
  fetchGoogleAvatar,
  newSessionClaims,
  permissionsOf,
  randomToken,
  readCookie,
  serializeCookie,
  signPayload,
  signSession,
  validatePassword,
  verifyIdToken,
  verifyPayload,
  type AuthUser,
  type Expiring,
} from "@rueisiang/auth";
import {
  acceptInvitation,
  authenticateWithPassword,
  findInvitation,
  loadAuthUser,
  isHrEmployee,
  isHrAdministrator,
  recordLogin,
  updateProfile,
  type Database,
} from "@rueisiang/db";
import { assistantErrorDetails, assistantLog } from "@rueisiang/assistant";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requireAuth } from "../middleware/auth.js";
import { body } from "../request.js";

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

/** returnTo 只接受已設定的 app origin 或站內路徑，避免被拿來做開放轉址。 */
function configuredAppOrigins(raw: string | undefined): string[] {
  const configured = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  return configured.length ? configured : [
    "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
    "http://localhost:5176", "http://localhost:5177", "http://localhost:5178", "http://localhost:5182",
    "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175",
    "http://127.0.0.1:5176", "http://127.0.0.1:5177", "http://127.0.0.1:5178", "http://127.0.0.1:5182",
  ];
}

function safeReturnTo(value: string | undefined, configuredOrigins: string[]): string {
  if (!value) return "/";
  if (value.startsWith("/")) {
    try {
      // Parsing against a base also rejects backslash variants such as /\\evil,
      // which browsers normalize into an external //evil redirect.
      const base = new URL("https://rueisiang-return.invalid");
      const target = new URL(value, base);
      if (target.origin !== base.origin) return "/";
      return `${target.pathname}${target.search}${target.hash}`;
    } catch {
      return "/";
    }
  }
  try {
    const target = new URL(value);
    return configuredOrigins.includes(target.origin) ? target.toString() : "/";
  } catch {
    return "/";
  }
}

function loginFailureUrl(returnTo: string | undefined, requestUrl: string, reason: string): string {
  const target = returnTo?.startsWith("http") ? new URL("/login", returnTo) : new URL("/login", requestUrl);
  target.searchParams.set("error", reason);
  if (returnTo && returnTo !== "/") target.searchParams.set("returnTo", returnTo);
  return target.toString();
}

/**
 * 發 session cookie。三條登入路（Google、帳密、走邀請連結設完密碼）共用，
 * 免得 maxAge 或 cookie 名稱在其中一條被寫得不一樣。
 *
 * claims 裡的 name 與 pictureUrl 只是給畫面用的快取；真正的權限判定在
 * requireAuth，每次請求都回 DB 重讀。
 */
async function issueSession(
  c: { env: { AUTH_SESSION_SECRET: string; AUTH_COOKIE_DOMAIN?: string }; header: (name: string, value: string, options?: { append?: boolean }) => void },
  user: { id: string; email: string; name?: string; pictureUrl?: string },
): Promise<void> {
  const session = await signSession(
    newSessionClaims({
      id: user.id,
      email: user.email,
      name: user.name ?? "",
      pictureUrl: user.pictureUrl ?? "",
    }),
    c.env.AUTH_SESSION_SECRET,
  );
  c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS, domain: c.env.AUTH_COOKIE_DOMAIN }), {
    append: true,
  });
}

export const auth = new Hono<AppEnv>()
  .get("/google/start", async (c) => {
    const { verifier, challenge } = await createPkce();
    const transaction: OAuthTransaction = {
      state: randomToken(),
      nonce: randomToken(),
      verifier,
      returnTo: safeReturnTo(c.req.query("returnTo"), configuredAppOrigins(c.env.AUTH_APP_ORIGINS)),
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
    const stored = readCookie(c.req.header("Cookie"), TRANSACTION_COOKIE);
    const transaction = await verifyPayload<OAuthTransaction>(stored, c.env.AUTH_SESSION_SECRET);
    const failure = (reason: string) => c.redirect(loginFailureUrl(transaction?.returnTo, c.req.url, reason));

    // 不論成敗都先把一次性的交易 cookie 清掉。
    c.header("Set-Cookie", clearCookie(TRANSACTION_COOKIE, CALLBACK_PATH), { append: true });

    if (!transaction) return failure("登入流程已逾時，請重新登入。");
    if (c.req.query("state") !== transaction.state) return failure("登入驗證失敗，請重新登入。");

    const code = c.req.query("code");
    if (!code) return failure("Google 沒有回傳授權碼。");

    let identity;
    try {
      const { idToken, accessToken } = await exchangeCode({
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

      // ID token 不一定帶 picture（Workspace 帳號常常沒有），跟 userinfo 再要一次。
      if (!identity.pictureUrl) {
        identity = { ...identity, pictureUrl: await fetchGoogleAvatar(accessToken) };
      }
    } catch (error) {
      assistantLog("warn", "auth.google_login_failed", {
        error: assistantErrorDetails(error),
      });
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
    c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS, domain: c.env.AUTH_COOKIE_DOMAIN }), {
      append: true,
    });

    return c.redirect(transaction.returnTo);
  })

  .post("/logout", (c) => {
    c.header("Set-Cookie", clearCookie(SESSION_COOKIE, "/", c.env.AUTH_COOKIE_DOMAIN));
    return c.json({ ok: true });
  })

  /**
   * ── 帳密登入 ────────────────────────────────────────────────────────────
   *
   * Google 之外的第二條路。兩條都通向同一列 users，走哪一條由本人決定：
   * 有些同事手上沒有公司 Google 帳號，但邀請發出去的當下沒有人知道。
   *
   * 仍然是邀請制——這條只認名單裡已經設過密碼的帳號，不會建立任何東西。
   */
  .post("/password", async (c) => {
    const input = await body(c);
    const email = typeof input.email === "string" ? input.email : "";
    const password = typeof input.password === "string" ? input.password : "";

    const user = await authenticateWithPassword(c.get("db"), email, password);
    /*
     * 查無此人、還沒設密碼、密碼錯——三種都回同一句。分開講等於送人一支
     * 帳號列舉工具：試一個 email 就知道公司有沒有這個人。
     */
    if (!user) {
      throw new HTTPException(401, { message: "Email 或密碼不正確，或這個帳號還沒完成啟用。" });
    }

    await issueSession(c, user);
    return c.json({ ok: true });
  })

  /**
   * 邀請連結的狀態。設密碼頁載入時先問一次，才能顯示「你正在為 xxx@ 設定密碼」，
   * 而不是讓人填完整張表才被告知連結已經過期。
   */
  .get("/invite/:token", async (c) => {
    const found = await findInvitation(c.get("db"), c.req.param("token"));
    if (found.kind !== "ok") {
      throw new HTTPException(404, { message: "邀請連結無效或已過期，請聯絡管理者重新發送。" });
    }
    return c.json({ email: found.email });
  })

  /** 走邀請連結設密碼。設完直接發 session，不用再叫人回登入頁輸入一次。 */
  .post("/invite/:token", async (c) => {
    const input = await body(c);
    const password = typeof input.password === "string" ? input.password : "";
    const confirm = typeof input.confirmPassword === "string" ? input.confirmPassword : "";

    const invalid = validatePassword(password);
    if (invalid) throw new HTTPException(400, { message: invalid });
    if (password !== confirm) {
      throw new HTTPException(400, { message: "兩次輸入的密碼不一致。" });
    }

    const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (displayName.length > 40) {
      throw new HTTPException(400, { message: "顯示名稱不能超過 40 個字。" });
    }

    const result = await acceptInvitation(c.get("db"), {
      token: c.req.param("token"),
      password,
      ...(displayName ? { displayName } : {}),
    });
    if (result.kind !== "ok") {
      throw new HTTPException(404, { message: "邀請連結無效或已過期，請聯絡管理者重新發送。" });
    }

    await issueSession(c, result);
    return c.json({ email: result.email });
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
  .get("/me", requireAuth, async (c) => c.json(await sessionUserPayload(c.get("db"), c.get("user"))));

/** `/api/auth/me` 與 HR app 的 `/api/hr/me/session` 共用，兩個前端讀同一個形狀。 */
export async function sessionUserPayload(db: Database, user: AuthUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    googleName: user.googleName,
    pictureUrl: user.pictureUrl,
    permissions: permissionsOf(user),
    roles: user.assignments.map((assignment) => assignment.roleKey),
    isEmployee: await isHrEmployee(db, user.id),
    isHrAdministrator: await isHrAdministrator(db, user.id),
  };
}
