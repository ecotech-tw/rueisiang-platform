import { describe, expect, it } from "vitest";
import {
  hashInviteToken,
  hashPassword,
  inviteExpiryFrom,
  newInviteToken,
  validatePassword,
  verifyPassword,
} from "./password.js";

describe("密碼雜湊", () => {
  it("驗得過自己", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", encoded)).toBe(true);
  });

  it("錯的密碼驗不過", async () => {
    const encoded = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batteryy", encoded)).toBe(false);
    expect(await verifyPassword("", encoded)).toBe(false);
  });

  it("同一個密碼每次的雜湊都不一樣（salt 有在用）", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("雜湊字串帶著演算法與輪數", async () => {
    const encoded = await hashPassword("whatever");
    const [algorithm, iterations] = encoded.split("$");
    expect(algorithm).toBe("pbkdf2-sha256");
    expect(Number(iterations)).toBe(100_000);
  });

  /*
   * 這條測試在 Node 上跑，而 Node 沒有迭代次數上限——所以它抓不到「實際在
   * Worker 上會不會爆」。它能做的是把那個上限寫成一個會失敗的斷言：有人為了
   * 「更安全」把輪數調高時，CI 會先擋下來，而不是等使用者在正式站按下去才 500。
   *
   * Workers 的限制是 100000，超過丟 NotSupportedError。
   * https://github.com/cloudflare/workerd/issues/1346
   */
  it("輪數不能超過 Cloudflare Workers 的 100000 上限", async () => {
    const encoded = await hashPassword("whatever");
    expect(Number(encoded.split("$")[1])).toBeLessThanOrEqual(100_000);
  });

  it.each([
    ["輪數被調低到不安全的值", "pbkdf2-sha256$1$c2FsdA$ZGlnZXN0"],
    ["換成別的演算法", "md5$120000$c2FsdA$ZGlnZXN0"],
    ["欄位不足", "pbkdf2-sha256$120000"],
    ["完全不是雜湊", "hunter2"],
    ["空字串", ""],
  ])("畸形的雜湊字串一律驗不過：%s", async (_label, encoded) => {
    expect(await verifyPassword("hunter2", encoded)).toBe(false);
  });
});

describe("密碼規則", () => {
  it("太短擋下來", () => {
    expect(validatePassword("short")).toContain("8");
  });

  it("太長擋下來——不擋的話等於讓人用一個 10MB 的字串燒 CPU", () => {
    expect(validatePassword("a".repeat(129))).toContain("128");
  });

  it("剛好在邊界上的長度可以用", () => {
    expect(validatePassword("a".repeat(8))).toBeNull();
    expect(validatePassword("a".repeat(128))).toBeNull();
  });
});

describe("邀請 token", () => {
  it("每次都不一樣", () => {
    expect(newInviteToken()).not.toBe(newInviteToken());
  });

  it("雜湊是穩定的，同一個 token 算出同一個值", async () => {
    const token = newInviteToken();
    expect(await hashInviteToken(token)).toBe(await hashInviteToken(token));
  });

  it("不同 token 的雜湊不同", async () => {
    expect(await hashInviteToken(newInviteToken())).not.toBe(await hashInviteToken(newInviteToken()));
  });

  it("雜湊裡看不到原本的 token", async () => {
    const token = newInviteToken();
    expect(await hashInviteToken(token)).not.toContain(token);
  });

  it("到期日是七天後", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    expect(inviteExpiryFrom(now)).toBe("2026-08-26T00:00:00.000Z");
  });
});
