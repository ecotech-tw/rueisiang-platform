import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeBase64Url, encodeTextBase64Url, utf8 } from "./base64url.js";
import { buildAuthorizeUrl, createPkce, resetJwksCache, verifyIdToken } from "./google-oauth.js";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const NONCE = "nonce-12345";
const KID = "test-kid";

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;
const realFetch = globalThis.fetch;

/** 用自己的私鑰簽一個長得像 Google 發的 ID token。 */
async function signIdToken(payload: Record<string, unknown>, kid = KID): Promise<string> {
  const header = encodeTextBase64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = encodeTextBase64Url(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    utf8(`${header}.${body}`),
  );
  return `${header}.${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "google-subject-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: NONCE,
    email: "Eli-Lin@ecotech.tw",
    email_verified: true,
    name: "林先生",
    picture: "https://example.test/a.png",
    ...overrides,
  };
}

beforeEach(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // workers-types 的 exportKey 回傳 ArrayBuffer | JsonWebKey，"jwk" 這個格式一定是後者。
  publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;

  resetJwksCache();
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: KID }] }), {
      headers: { "content-type": "application/json", "cache-control": "max-age=600" },
    })) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetJwksCache();
});

describe("verifyIdToken", () => {
  it("正常的 token 驗得過，email 會轉小寫", async () => {
    const identity = await verifyIdToken(await signIdToken(validPayload()), { clientId: CLIENT_ID, nonce: NONCE });
    expect(identity).toEqual({
      subject: "google-subject-1",
      email: "eli-lin@ecotech.tw",
      name: "林先生",
      pictureUrl: "https://example.test/a.png",
    });
  });

  it("換一把金鑰簽的擋下來", async () => {
    const attacker = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const header = encodeTextBase64Url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
    const body = encodeTextBase64Url(JSON.stringify(validPayload()));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", attacker.privateKey, utf8(`${header}.${body}`));
    const forged = `${header}.${body}.${encodeBase64Url(new Uint8Array(signature))}`;

    await expect(verifyIdToken(forged, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("簽章驗證失敗");
  });

  it("aud 不是我們就擋下來——別的網站的 token 不能拿來登入", async () => {
    const token = await signIdToken(validPayload({ aud: "someone-else.apps.googleusercontent.com" }));
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("不是發給這個應用程式");
  });

  it("nonce 對不上就擋下來——擋重放", async () => {
    const token = await signIdToken(validPayload({ nonce: "上一次登入的 nonce" }));
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("nonce 對不上");
  });

  it("過期的擋下來", async () => {
    const token = await signIdToken(validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }));
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("已過期");
  });

  it("簽發者不對就擋下來", async () => {
    const token = await signIdToken(validPayload({ iss: "https://evil.test" }));
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("簽發者不正確");
  });

  it("email 沒驗證過的帳號不給登入", async () => {
    const token = await signIdToken(validPayload({ email_verified: false }));
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("尚未驗證");
  });

  it("alg=none 這種經典手法擋下來", async () => {
    const header = encodeTextBase64Url(JSON.stringify({ alg: "none", kid: KID, typ: "JWT" }));
    const body = encodeTextBase64Url(JSON.stringify(validPayload()));
    await expect(
      verifyIdToken(`${header}.${body}.`, { clientId: CLIENT_ID, nonce: NONCE }),
    ).rejects.toThrow("不支援的簽章演算法");
  });

  it("找不到對應 kid 的公鑰就擋下來", async () => {
    const token = await signIdToken(validPayload(), "不存在的-kid");
    await expect(verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE })).rejects.toThrow("找不到對應的 Google 公鑰");
  });
});

describe("PKCE 與授權網址", () => {
  it("每次產生的 verifier 都不同，challenge 是它的 SHA-256", async () => {
    const first = await createPkce();
    const second = await createPkce();
    expect(first.verifier).not.toBe(second.verifier);

    const digest = await crypto.subtle.digest("SHA-256", utf8(first.verifier));
    expect(first.challenge).toBe(encodeBase64Url(new Uint8Array(digest)));
  });

  it("授權網址帶齊必要參數", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: "https://platform.rueisiang.com/api/auth/google/callback",
        state: "state-1",
        nonce: NONCE,
        codeChallenge: "challenge-1",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
  });
});
