import { describe, expect, it } from "vitest";
import { decodeTextBase64Url, encodeTextBase64Url } from "./base64url.js";
import { readCookie, serializeCookie } from "./cookies.js";
import { newSessionClaims, signSession, verifySession, type SessionClaims } from "./session.js";

const SECRET = "test-secret-請勿用於正式環境";
const USER = { id: "u1", email: "a@ecotech.tw", name: "測試", pictureUrl: "" };

describe("session 簽章", () => {
  it("簽出來的 token 驗得回原本的 claims", async () => {
    const claims = newSessionClaims(USER);
    const token = await signSession(claims, SECRET);
    expect(await verifySession(token, SECRET)).toEqual(claims);
  });

  it("換一把 secret 就驗不過", async () => {
    const token = await signSession(newSessionClaims(USER), SECRET);
    expect(await verifySession(token, "另一把 secret")).toBeNull();
  });

  it("竄改 payload 會被擋下", async () => {
    const token = await signSession(newSessionClaims(USER), SECRET);
    const signature = token.slice(token.lastIndexOf(".") + 1);
    const claims = JSON.parse(decodeTextBase64Url(token.slice(0, token.lastIndexOf(".")))) as SessionClaims;

    claims.userId = "someone-else";
    const forged = encodeTextBase64Url(JSON.stringify(claims));

    expect(await verifySession(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("延長效期也要重簽才算數", async () => {
    const token = await signSession(newSessionClaims(USER), SECRET);
    const signature = token.slice(token.lastIndexOf(".") + 1);
    const claims = JSON.parse(decodeTextBase64Url(token.slice(0, token.lastIndexOf(".")))) as SessionClaims;

    claims.expiresAt += 365 * 24 * 60 * 60;
    const forged = encodeTextBase64Url(JSON.stringify(claims));

    expect(await verifySession(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it("過期的 session 不算數", async () => {
    const claims = newSessionClaims(USER);
    const token = await signSession(claims, SECRET);
    const afterExpiry = claims.expiresAt * 1000 + 1;
    expect(await verifySession(token, SECRET, afterExpiry)).toBeNull();
  });

  it("格式不對或空的都回 null，不拋例外", async () => {
    expect(await verifySession(undefined, SECRET)).toBeNull();
    expect(await verifySession("", SECRET)).toBeNull();
    expect(await verifySession("沒有分隔點", SECRET)).toBeNull();
    expect(await verifySession(".只有簽章", SECRET)).toBeNull();
  });

  it("session 裡不放角色——授權一律以資料庫當下狀態為準", async () => {
    const claims = newSessionClaims(USER);
    expect(Object.keys(claims)).not.toContain("role");
    expect(Object.keys(claims)).not.toContain("permissions");
  });
});

describe("cookie", () => {
  it("一定帶 HttpOnly / Secure / SameSite", () => {
    const cookie = serializeCookie("x", "v", { maxAge: 60 });
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("跨子網域時可以指定 cookie domain", () => {
    expect(serializeCookie("x", "v", { maxAge: 60, domain: ".rueisiang.com" })).toContain("Domain=.rueisiang.com");
  });

  it("讀得回自己寫的值，含中文與分號", () => {
    const value = "誠品西門店3F; drop table";
    const header = serializeCookie("rueisiang_session", value, { maxAge: 60 }).split(";")[0]!;
    expect(readCookie(header, "rueisiang_session")).toBe(value);
  });

  it("只認完全相符的名稱，不會被前綴相同的 cookie 騙到", () => {
    expect(readCookie("rueisiang_session_other=bad; rueisiang_session=good", "rueisiang_session")).toBe("good");
  });

  it("沒有 header 或找不到就回 undefined", () => {
    expect(readCookie(null, "x")).toBeUndefined();
    expect(readCookie("a=1; b=2", "x")).toBeUndefined();
  });
});
