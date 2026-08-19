import fs from "node:fs/promises";
import path from "node:path";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * 走 Gmail API 而不是瀏覽器自動化：Google 會擋自動化瀏覽器的登入
 * （This browser or app may not be secure），所以 Gmail 這段不可能穩定地用
 * Playwright 做。API 也比較快，而且不會被 Gmail 改版弄壞。
 */
async function call(token, url, what) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${what} 失敗（HTTP ${response.status}）：${text.slice(0, 300)}`);
    error.code = response.status === 403 ? "GMAIL_FORBIDDEN" : "GMAIL_API_ERROR";
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

export async function whoAmI(token) {
  return call(token, `${GMAIL_API}/profile`, "讀取 Gmail 帳號");
}

export async function search(token, query, maxResults = 10) {
  const json = await call(
    token,
    `${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    "搜尋 Gmail",
  );
  return json.messages ?? [];
}

export async function getMessage(token, id) {
  return call(token, `${GMAIL_API}/messages/${id}?format=full`, "讀取郵件");
}

function decodeBase64Url(data) {
  return Buffer.from(String(data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** 把郵件所有 text/plain 與 text/html 段落串起來，OTP 可能藏在任一種。 */
export function messageText(message) {
  const chunks = [];
  const walk = (part) => {
    if (!part) return;
    if (part.body?.data && /^text\//.test(part.mimeType ?? "")) {
      chunks.push(decodeBase64Url(part.body.data).toString("utf8"));
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  const subject =
    message.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? "";
  return `${subject}\n${chunks.join("\n")}`;
}

function findAttachmentPart(payload, expectedName) {
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    if (part.filename === expectedName && part.body?.attachmentId) return part;
    for (const child of part.parts ?? []) stack.push(child);
  }
  return null;
}

/**
 * 讀 CYBERBIZ 登入用的 2FA 驗證碼。
 * 只接受 notBefore 之後收到的信，避免抓到上一次登入的舊驗證碼。
 */
export async function readTwoFactorCode(token, {
  query,
  codePattern,
  notBefore,
  timeoutMs = 120000,
  pollMs = 5000,
}) {
  const pattern = new RegExp(codePattern ?? "\\b(\\d{6})\\b");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const { id } of await search(token, query, 5)) {
      const message = await getMessage(token, id);
      if (Number(message.internalDate) < notBefore - 60000) continue;
      const match = pattern.exec(messageText(message));
      if (match) return match[1] ?? match[0];
    }
    if (Date.now() + pollMs < deadline) await new Promise((r) => setTimeout(r, pollMs));
  }
  const error = new Error(`等不到 2FA 驗證信（搜尋條件：${query}）。`);
  error.code = "OTP_TIMEOUT";
  throw error;
}

/**
 * 依精確檔名抓 CYBERBIZ 寄來的報表附件。
 * 只認 submittedAt 之後的信，否則會抓到上個月同名的舊報表。
 */
export async function downloadAttachment(token, {
  expectedName,
  sender = "support@cyberbiz.co",
  downloadDir,
  notBefore = 0,
  timeoutMs = 180000,
  pollMs = 10000,
}) {
  const query = `from:${sender} has:attachment filename:"${expectedName}"`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const { id } of await search(token, query, 5)) {
      const message = await getMessage(token, id);
      if (Number(message.internalDate) < notBefore - 60000) continue;
      const part = findAttachmentPart(message.payload, expectedName);
      if (!part) continue;

      const attachment = await call(
        token,
        `${GMAIL_API}/messages/${id}/attachments/${part.body.attachmentId}`,
        "下載附件",
      );
      const bytes = decodeBase64Url(attachment.data);
      if (!bytes.length) {
        const error = new Error(`${expectedName} 附件是空的。`);
        error.code = "ATTACHMENT_EMPTY";
        throw error;
      }
      const target = path.join(downloadDir, expectedName);
      await fs.writeFile(target, bytes);
      return target;
    }
    if (Date.now() + pollMs < deadline) await new Promise((r) => setTimeout(r, pollMs));
  }

  const error = new Error(`等不到附件 ${expectedName}（${Math.round(timeoutMs / 1000)} 秒內）。`);
  error.code = "EMAIL_TIMEOUT";
  throw error;
}
