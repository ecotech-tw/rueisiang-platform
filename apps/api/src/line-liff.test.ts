import { describe, expect, it } from "vitest";
import {
  clearLineLinkIntentCookie,
  createLineLinkIntentCookie,
  LINE_LIFF_INTENT_PATH,
  LINE_LIFF_INTENT_TTL_SECONDS,
  readLineLinkIntent,
  verifyLineIdToken,
} from "./line-liff.js";

const CHANNEL_ID = "1234567890";
const nowSeconds = Math.floor(Date.now() / 1000);
const claims = { iss: "https://access.line.me", sub: "U-line-subject", aud: CHANNEL_ID, exp: nowSeconds + 300 };

function lineResponse(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

describe("LINE LIFF 身分驗證", () => {
  it("以 LINE verify endpoint 驗證 ID token、audience、issuer 與 subject", async () => {
    let requestBody = "";
    const identity = await verifyLineIdToken("opaque-id-token", CHANNEL_ID, async (_input, init) => {
      requestBody = String(init?.body);
      return lineResponse(200, claims);
    });

    expect(identity).toEqual({ channelId: CHANNEL_ID, lineUserId: "U-line-subject" });
    expect(new URLSearchParams(requestBody).get("id_token")).toBe("opaque-id-token");
    expect(new URLSearchParams(requestBody).get("client_id")).toBe(CHANNEL_ID);
  });

  it.each([
    ["wrong issuer", { ...claims, iss: "https://attacker.example" }],
    ["wrong audience", { ...claims, aud: "different-channel" }],
    ["expired token", { ...claims, exp: nowSeconds - 1 }],
    ["missing subject", { ...claims, sub: "" }],
  ])("rejects %s", async (_label, responseBody) => {
    await expect(verifyLineIdToken("opaque-id-token", CHANNEL_ID, async () => lineResponse(200, responseBody)))
      .rejects.toMatchObject({ status: 401 });
  });

  it("treats invalid token and provider availability failures differently", async () => {
    await expect(verifyLineIdToken("bad-token", CHANNEL_ID, async () => lineResponse(400, {})))
      .rejects.toMatchObject({ status: 401 });
    await expect(verifyLineIdToken("opaque-id-token", CHANNEL_ID, async () => lineResponse(503, {})))
      .rejects.toMatchObject({ status: 503 });
    await expect(verifyLineIdToken("opaque-id-token", CHANNEL_ID, async () => { throw new Error("network down"); }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("issues a short-lived HttpOnly intent cookie and rejects tampering, expiry, or channel mismatch", async () => {
    const issuedAt = Date.UTC(2026, 9, 10);
    const cookie = await createLineLinkIntentCookie({ channelId: CHANNEL_ID, lineUserId: "U-line-subject" }, "test-secret", issuedAt);
    const value = cookie.slice(cookie.indexOf("=") + 1).split(";")[0]!;
    expect(cookie).toContain(`Path=${LINE_LIFF_INTENT_PATH};`);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${LINE_LIFF_INTENT_TTL_SECONDS}`);
    const expiresAt = issuedAt + LINE_LIFF_INTENT_TTL_SECONDS * 1000;
    expect(await readLineLinkIntent(value, "test-secret", CHANNEL_ID, expiresAt - 1)).toEqual({ channelId: CHANNEL_ID, lineUserId: "U-line-subject" });
    expect(await readLineLinkIntent(value, "test-secret", CHANNEL_ID, expiresAt)).toBeNull();
    expect(await readLineLinkIntent(value, "test-secret", CHANNEL_ID, expiresAt + 1)).toBeNull();
    expect(await readLineLinkIntent(value, "wrong-secret", CHANNEL_ID, issuedAt)).toBeNull();
    expect(await readLineLinkIntent(value, "test-secret", "other-channel", issuedAt)).toBeNull();
    expect(await readLineLinkIntent(`${value}tampered`, "test-secret", CHANNEL_ID, issuedAt)).toBeNull();
    expect(clearLineLinkIntentCookie()).toContain("Max-Age=0");
  });
});
