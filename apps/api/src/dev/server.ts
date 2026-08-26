import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import app from "../index.js";
import { createLocalD1 } from "../local-d1/d1.js";
import { createLocalR2 } from "../local-d1/r2.js";
import { AssistantCredentialVault } from "../pi-agent-credentials.js";
import { AssistantChatAgent } from "../pi-agent-do.js";
import { processLineAssistantQueueMessage } from "../routes/webhooks.js";
import { DEV_ACCOUNTS, seedDevData } from "./fixtures.js";
import { LocalDurableObjectNamespace } from "./local-durable-objects.js";

/**
 * 本機開發用的 API 伺服器。
 *
 * 為什麼不是 `wrangler dev`：開發機是 Windows on ARM，沒有 workerd 執行檔，
 * 任何 wrangler 指令都起不來。但 Worker 的進入點本來就只是一個 fetch handler，
 * 接上 node:http 再配 node:sqlite 當 D1，就能在本機跑真正的路由、真正的 SQL、
 * 真正的 migration。
 *
 * 這個檔案永遠不會進 Worker 的打包——只有 `pnpm dev` 會執行它，
 * apps/api/tsconfig.json 也把 src/dev 排除在 Worker 的型別檢查之外。
 * /dev 那兩條假登入的路由是這裡自己接的，不在 Hono app 裡，所以正式環境不存在。
 */
function readPort(raw: string | undefined, fallback: number, label: string): number {
  // Portal dev server uses the same validation in apps/portal/vite.config.ts.
  const value = raw?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} 必須是 1–65535 的整數，目前是「${raw}」。`);
  }
  return port;
}

// API_PORT 讓同一台開發機可以同時跑多個 worktree；PORT 保留給舊的單一 worktree 用法。
const apiPortOverride = process.env.API_PORT?.trim();
const PORT = readPort(apiPortOverride || process.env.PORT?.trim(), 8787, apiPortOverride ? "API_PORT" : "PORT");
const PORTAL_PORT = readPort(process.env.PORTAL_PORT, 5173, "PORTAL_PORT");
const here = path.dirname(fileURLToPath(import.meta.url));
// 可用 DEV_DB_FILE 隔離不同 worktree 的 preview 資料庫，避免沿用舊 schema 的 local.sqlite。
const DB_FILE = path.resolve(process.env.DEV_DB_FILE?.trim() || path.resolve(here, "../../local.sqlite"));

// 本機專用的假密鑰。正式環境是 wrangler secret，兩邊不會共用。
const DEV_SECRET = "local-development-only";

/**
 * 讀 apps/api/.dev.vars——沿用 wrangler 的慣例，格式就是一行一個 KEY=value。
 *
 * 這個檔在 .gitignore 裡，用來放不能進版控又只有本機需要的東西，
 * 目前是 CYBERBIZ_API_TOKEN、Gemini／Codex credential 與可選的 LINE_CHANNEL_ACCESS_TOKEN。
 * 沒有這個檔也能跑，只是碰到 CYBERBIZ、AI Sandbox 或 LINE 回覆的功能會失敗。
 */
function loadDevVars(): Record<string, string> {
  const file = path.resolve(here, "../../.dev.vars");
  if (!fs.existsSync(file)) return {};

  // Node 內建的 .env 解析器，不必為了幾行設定拉一個 dotenv 進來。
  process.loadEnvFile(file);

  const keys = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=")[0]?.trim())
    .filter((key): key is string => Boolean(key));

  const vars: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) vars[key] = value;
  }

  console.log(`.dev.vars 讀到 ${keys.length} 個設定：${keys.join("、")}`);
  return vars;
}

const d1 = createLocalD1(DB_FILE);
// 上傳的檔案跟 local.sqlite 放一起，想重來就把兩個一起刪掉。
const uploads = createLocalR2(path.resolve(here, "../../local-uploads"));
await seedDevData(d1);

const env = {
  DB: d1,
  UPLOADS: uploads,
  AUTH_SESSION_SECRET: DEV_SECRET,
  GOOGLE_OAUTH_CLIENT_ID: "local-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "local-client-secret",
  PUBLIC_APP_URL: `http://localhost:${PORTAL_PORT}`,
  // .dev.vars 放最後，這樣要蓋掉上面任何一個預設值都可以。
  ...loadDevVars(),
};

const localAgentObjects = new LocalDurableObjectNamespace(
  (state) => new AssistantChatAgent(state, env as never),
);
const localCredentialObjects = new LocalDurableObjectNamespace(
  (state) => new AssistantCredentialVault(state, env as never),
);
(env as Record<string, unknown>).ASSISTANT_CHAT_AGENT = localAgentObjects;
(env as Record<string, unknown>).ASSISTANT_CREDENTIAL_VAULT = localCredentialObjects;

// node:http 沒有 Cloudflare Queue runtime；本機 adapter 仍走正式 consumer 的同一個入口。
(env as Record<string, unknown>).LINE_ASSISTANT_QUEUE = {
  send: async (message: unknown) => processLineAssistantQueueMessage(message, env as never),
};

function devIndex(): string {
  const rows = DEV_ACCOUNTS.map(
    (account) => `<li>
      <a href="/dev/login?as=${encodeURIComponent(account.email)}">${account.name}</a>
      <small>${account.email} — ${account.note}</small>
    </li>`,
  ).join("");

  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>本機開發登入</title>
<style>
  body { font-family: "Noto Sans TC", system-ui, sans-serif; max-width: 560px; margin: 60px auto; padding: 0 20px; color: #351c1d; }
  h1 { font-size: 20px; }
  p { color: #806c69; font-size: 14px; line-height: 1.7; }
  ul { list-style: none; padding: 0; }
  li { padding: 12px 14px; border: 1px solid #ead8d4; border-radius: 12px; margin-bottom: 8px; }
  a { color: #d5383b; font-weight: 700; text-decoration: none; font-size: 15px; }
  small { display: block; color: #806c69; margin-top: 2px; }
</style></head>
<body>
  <h1>本機開發登入</h1>
  <p>選一個身分直接進去，跳過 Google OAuth。這一頁只存在於 <code>pnpm dev</code>，
  正式環境沒有這些路由。資料存在 <code>apps/api/local.sqlite</code>，重開會留著；
  想重來就把那個檔案刪掉。</p>
  <ul>${rows}</ul>
</body></html>`;
}

async function devLogin(url: URL): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const email = url.searchParams.get("as") ?? DEV_ACCOUNTS[0].email;
  const account = DEV_ACCOUNTS.find((item) => item.email === email);
  if (!account) return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "沒有這個帳號" };

  const token = await signSession(
    newSessionClaims({ id: `dev-${account.email}`, email: account.email, name: account.name, pictureUrl: "" }),
    DEV_SECRET,
  );
  return {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    },
    body: "",
  };
}

const server = http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/dev" || url.pathname === "/dev/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(devIndex());
      return;
    }

    if (url.pathname === "/dev/login") {
      const result = await devLogin(url);
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    const response = await app.fetch(
      new Request(url.toString(), {
        method: req.method,
        headers: req.headers as never,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
      env as never,
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

server.on("error", (error) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "EADDRINUSE") {
    console.error(`API port ${PORT} 已被占用，請改用 API_PORT 或停止占用中的程序。`);
  } else {
    console.error("API dev server 啟動失敗", error);
  }
  process.exitCode = 1;
});

server.on("close", () => {
  localAgentObjects.close();
  localCredentialObjects.close();
});

server.listen(PORT, () => {
  console.log(`API      http://localhost:${PORT}`);
  console.log(`假登入   http://localhost:${PORTAL_PORT}/dev  （portal 起來之後）`);
});

