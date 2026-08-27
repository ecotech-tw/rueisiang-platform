#!/usr/bin/env node
/**
 * 一次性設定。四個子指令彼此獨立，可分開跑：
 *
 *   node setup.mjs auth [client_secret.json]   # Drive/Sheets 授權（存放出金表的帳號）
 *   node setup.mjs mail [client_secret.json]   # Gmail 唯讀授權（收 2FA 與報表附件的信箱）
 *   node setup.mjs folder <Drive 資料夾連結>     # 設定通路銷售紀錄根資料夾
 *   node setup.mjs stores                      # 列出後台 POS 商店，勾選並對應 Drive 資料夾
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import readline from "node:readline/promises";
import {
  driveFolderIdFromUrl,
  driveFolderUrlFromId,
  loadConfig,
  loadEnv,
  log,
  saveConfig,
  saveEnv,
  skillPath,
} from "./lib/common.mjs";
import { newPage, openBrowser } from "./lib/browser.mjs";
import { listStores, login } from "./lib/cyberbiz.mjs";
import { accessToken, getFile, SCOPES } from "./lib/drive.mjs";
import { GMAIL_SCOPES, whoAmI } from "./lib/gmail-api.mjs";

const REDIRECT_PORT = 8765;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

function openInDefaultBrowser(url) {
  if (process.platform === "win32") {
    // 不能用 `cmd /c start`：授權網址裡的 & 會被 cmd 當成命令分隔符，
    // 網址被截斷後 Google 會回 400 invalid_request（缺 response_type）。
    // rundll32 直接把整串交給預設瀏覽器，不經過 cmd 解析。
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

/**
 * 找可用的 client_secret JSON。Downloads 裡常常不只一份（例如 CRM 用的 web 用戶端），
 * 所以優先挑「桌面應用程式」型（JSON 裡的 installed 區塊），同型再挑最新下載的那份。
 */
async function findClientSecret(explicit) {
  if (explicit) return explicit;
  const downloads = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? ".",
    "Downloads",
  );
  const entries = await fs.readdir(downloads).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith("client_secret_") || !name.endsWith(".json")) continue;
    const file = path.join(downloads, name);
    try {
      const json = JSON.parse(await fs.readFile(file, "utf8"));
      const stat = await fs.stat(file);
      candidates.push({ file, desktop: Boolean(json.installed), mtime: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.desktop - a.desktop || b.mtime - a.mtime);
  const chosen = candidates[0];
  if (!chosen) {
    throw new Error(
      "找不到 client_secret_*.json。請到 Google Cloud Console 建立 OAuth 用戶端" +
        "（應用程式類型：桌面應用程式），下載 JSON 後放進 Downloads 或把路徑當參數傳進來。",
    );
  }
  if (!chosen.desktop) {
    log(
      `注意：${path.basename(chosen.file)} 是 web 類型用戶端，` +
        `授權會失敗，除非它的重新導向 URI 有 ${REDIRECT_URI}。`,
    );
  }
  return chosen.file;
}

async function authorize({ clientSecretPath, scopes, tokenKey, accountHint, loginHint }) {
  const file = await findClientSecret(clientSecretPath);
  log(`使用 OAuth 用戶端：${file}`);
  const json = JSON.parse(await fs.readFile(file, "utf8"));
  const client = json.installed ?? json.web;
  if (!client?.client_id) throw new Error("client_secret JSON 格式不認得。");

  // prompt 一定要含 select_account：瀏覽器若已登入別的 Google 帳號，
  // Google 會直接沿用那個帳號而不問，授權就綁錯信箱了。
  const params = {
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
  };
  if (loginHint) params.login_hint = loginHint;
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams(params);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, `http://localhost:${REDIRECT_PORT}`);
      const received = url.searchParams.get("code");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        received
          ? "<h2>授權完成，可以關掉這個分頁。</h2>"
          : `<h2>授權失敗：${url.searchParams.get("error") ?? "未取得授權碼"}</h2>`,
      );
      server.close();
      received ? resolve(received) : reject(new Error("使用者未完成授權。"));
    });
    server.listen(REDIRECT_PORT, () => {
      log(`會用系統預設瀏覽器開啟 Google 授權頁，請用${accountHint}登入並同意。`);
      log(`若沒自動開啟，手動貼到瀏覽器：\n${authUrl}\n`);
      // 一定要用使用者平常的瀏覽器：Playwright 開的 Chrome 帶自動化旗標，
      // Google 會擋在「This browser or app may not be secure」而無法登入。
      openInDefaultBrowser(String(authUrl));
    });
    setTimeout(() => {
      server.close();
      reject(new Error("等待授權逾時（5 分鐘）。"));
    }, 300000).unref();
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });
  const token = await response.json();
  if (!token.refresh_token) {
    throw new Error(`沒拿到 refresh_token：${JSON.stringify(token).slice(0, 300)}`);
  }
  await saveEnv({
    GOOGLE_CLIENT_ID: client.client_id,
    GOOGLE_CLIENT_SECRET: client.client_secret,
    [tokenKey]: token.refresh_token,
  });
  log(`已把 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / ${tokenKey} 寫入 .env。`);
  return { clientId: client.client_id, clientSecret: client.client_secret, refreshToken: token.refresh_token };
}

/** 參數可以是 client_secret 路徑或 email（含 @ 就當成指定帳號）。 */
function splitArgs(args) {
  const email = args.find((value) => value?.includes("@"));
  const file = args.find((value) => value && !value.includes("@"));
  return { loginHint: email, clientSecretPath: file };
}

async function commandAuth(...args) {
  const { loginHint, clientSecretPath } = splitArgs(args);
  await authorize({
    clientSecretPath,
    loginHint,
    scopes: SCOPES,
    tokenKey: "GOOGLE_REFRESH_TOKEN",
    accountHint: "「要存放出金表的那個 Google 帳號」",
  });
}

async function commandMail(...args) {
  const { loginHint, clientSecretPath } = splitArgs(args);
  const config = await loadConfig();
  const expected = loginHint ?? config.recipientEmail;
  const result = await authorize({
    clientSecretPath,
    loginHint: expected,
    scopes: GMAIL_SCOPES,
    tokenKey: "GMAIL_REFRESH_TOKEN",
    accountHint: `「收 CYBERBIZ 2FA 驗證信與報表附件的信箱」${expected ? `（${expected}）` : ""}`,
  });
  const token = await accessToken({
    GOOGLE_CLIENT_ID: result.clientId,
    GOOGLE_CLIENT_SECRET: result.clientSecret,
    GOOGLE_REFRESH_TOKEN: result.refreshToken,
  });
  const profile = await whoAmI(token);
  log(`Gmail 授權帳號：${profile.emailAddress}（共 ${profile.messagesTotal} 封信）`);
  if (expected && profile.emailAddress.toLowerCase() !== expected.toLowerCase()) {
    log(
      `\n注意：授權到的是 ${profile.emailAddress}，但預期是 ${expected}。` +
        `\n重跑 node setup.mjs mail ${expected} 並在帳號選擇畫面挑正確的帳號。`,
    );
    process.exitCode = 1;
  }
}

async function listChannelFolders(token, parentId) {
  const query = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files?q=" +
    encodeURIComponent(query) +
    "&fields=files(id,name,webViewLink)&pageSize=100&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!response.ok) throw new Error(`讀取通路資料夾失敗：${JSON.stringify(json).slice(0, 200)}`);
  return json.files ?? [];
}

/**
 * CYBERBIZ 商店名與 Drive 資料夾名不完全一樣（「宏匯廣場1F」對「宏匯」、
 * 「誠品3F」對「誠品西門」），用最長共同字元數猜一個預設值讓人確認。
 */
function bestFolderMatch(storeName, folders) {
  let best = null;
  let bestScore = 0;
  for (const folder of folders) {
    let score = 0;
    for (const char of new Set(folder.name)) {
      if (storeName.includes(char)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = folder;
    }
  }
  return bestScore >= 2 ? best : null;
}

async function commandStores() {
  const config = await loadConfig();
  const env = await loadEnv();
  const context = await openBrowser({ headless: false });
  try {
    const page = await newPage(context);
    const gmailToken = env.GMAIL_REFRESH_TOKEN
      ? await accessToken({ ...env, GOOGLE_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN })
      : null;
    if (!gmailToken) log("提醒：還沒跑 setup.mjs mail，若登入需要 2FA 會停在驗證碼畫面。");
    await login(page, {
      origin: config.cyberbizOrigin,
      username: env.CYBERBIZ_USERNAME,
      password: env.CYBERBIZ_PASSWORD,
      gmailToken,
      twoFactor: config.twoFactor,
    });
    const stores = await listStores(page, { origin: config.cyberbizOrigin });
    log(`\n後台共有 ${stores.length} 家 POS 商店：`);
    stores.forEach((store, index) => log(`  ${index + 1}. ${store.name}`));
    const picked = await ask("\n要納入月結的編號（逗號分隔，全部就按 Enter）：");
    const selected = picked
      ? picked
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map((value) => stores[Number(value) - 1])
          .filter(Boolean)
      : stores;
    // 對應 Drive 資料夾：帳務/通路銷售紀錄 底下一個通路一個資料夾
    const token = await accessToken(env);
    const rootId = driveFolderIdFromUrl(config.driveRootFolderUrl || config.driveRootFolderId);
    if (!rootId) throw new Error("config.json 尚未設定 Drive 根資料夾連結，請先跑 node setup.mjs folder <Drive 連結>。");
    const folders = await listChannelFolders(token, rootId);
    log(`\n「${config.driveRootFolderName}」底下的通路資料夾：`);
    folders.forEach((folder, index) => log(`  ${index + 1}. ${folder.name}`));

    config.stores = [];
    for (const store of selected) {
      const guess = bestFolderMatch(store.name, folders);
      const hint = guess ? `，Enter 用「${guess.name}」` : "";
      const answer = await ask(`\n「${store.name}」上傳到哪個資料夾（輸入編號${hint}，跳過填 -）：`);
      let folder = guess;
      if (answer === "-") folder = null;
      else if (answer) folder = folders[Number(answer) - 1] ?? guess;
      config.stores.push({
        name: store.name,
        driveFolderUrl: folder?.webViewLink ?? driveFolderUrlFromId(folder?.id ?? ""),
        driveFolderName: folder?.name ?? "",
      });
    }
    await saveConfig(config);
    log("\n已寫入 config.json：");
    for (const store of config.stores) {
      log(`  ${store.name} → ${store.driveFolderName || "（未設定資料夾）"}`);
    }
  } finally {
    await context.close();
  }
}

async function commandFolder(input) {
  if (!input) throw new Error("請帶 Drive 資料夾連結。");
  const id =
    /\/folders\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ??
    /[?&]id=([A-Za-z0-9_-]+)/.exec(input)?.[1] ??
    input;
  const env = await loadEnv();
  const token = await accessToken(env);
  const folder = await getFile(token, id);
  if (folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new Error(`這個 ID 不是資料夾（${folder.mimeType}）。`);
  }
  const config = await loadConfig();
  config.driveRootFolderUrl = folder.webViewLink ?? driveFolderUrlFromId(folder.id);
  config.driveRootFolderName = folder.name;
  delete config.driveRootFolderId;
  await saveConfig(config);
  log(`Drive 目的地：${folder.name}（${folder.id}）`);
  log(folder.webViewLink);
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  auth: commandAuth,
  mail: commandMail,
  stores: commandStores,
  folder: commandFolder,
};
if (!commands[command]) {
  log("用法：node setup.mjs auth|mail|folder|stores");
  log(`  auth   Drive/Sheets 授權（回呼 ${REDIRECT_URI}）`);
  log("  mail   Gmail 唯讀授權（收 2FA 與報表附件的信箱）");
  log("  folder <Drive 資料夾連結> 設定通路銷售紀錄根資料夾");
  log("  stores 列出後台 POS 商店，勾選並對應各通路資料夾");
  process.exitCode = 1;
} else {
  try {
    await commands[command](...rest);
  } catch (error) {
    log(`設定失敗：${error.message}`);
    process.exitCode = 1;
  }
}
void skillPath;
