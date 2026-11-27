import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, formatTaipeiDate, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, hrPayrollPeriods, userPermissionGrants, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "accounting-petty-cash-test-secret-accounting";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
const month = () => formatTaipeiDate(new Date()).slice(0, 7);

async function api(route: string, actor: string, method = "GET", values?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${route}`, {
    method,
    headers: { ...(values ? { "Content-Type": "application/json" } : {}), Cookie: cookies[actor]! },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}

async function submit(actor: string, amountDollars = "350") {
  const form = new FormData();
  const values = { clientRequestId: crypto.randomUUID(), categoryId: "expense-category-supplies", spentOn: formatTaipeiDate(new Date()), amountDollars, invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品" };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  form.append("receipts", new Blob([Uint8Array.from(png).buffer], { type: "image/png" }), "receipt.png");
  const response = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { method: "POST", headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies[actor]! }, body: form }), env() as never);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function addCash(amountDollars: number, note = "", actor = "accountant") {
  return api("/accounting/petty-cash", actor, "POST", { amountDollars, note });
}
async function topUp(dollars: number) {
  const response = await addCash(dollars);
  expect(response.status, await response.clone().text()).toBe(201);
}
async function approve(id: string, revision = 1, actor = "accountant") {
  const response = await api(`/accounting/expenses/${id}/approve`, actor, "POST", { revision, payoutMethod: "direct" });
  return { status: response.status, body: await response.json() as { status?: string; pettyCashShort?: boolean; error?: string } };
}
const row = (id: string) => d1.sqlite.prepare("SELECT * FROM accounting_expenses WHERE id = ?").get(id) as Record<string, unknown>;
const balance = () => (d1.sqlite.prepare("SELECT coalesce(sum(amount_minor), 0) AS n FROM accounting_petty_cash_entries").get() as { n: number }).n;
const entries = (expenseId: string) => d1.sqlite.prepare("SELECT kind, amount_minor FROM accounting_petty_cash_entries WHERE expense_id = ? ORDER BY rowid").all(expenseId);
const notifications = () => (d1.sqlite.prepare("SELECT title FROM hr_notifications WHERE user_id = 'employee' ORDER BY created_at, rowid").all() as Array<{ title: string }>).map((item) => item.title);

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "accounting-petty-cash-"));
  uploads = createLocalR2(directory);
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "accountant", "reviewer", "auditor", "outsider"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([
    { id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" },
    { id: "employment-accountant", employeeUserId: "accountant", employeeNumber: "E002", legalName: "陳會計" },
  ]);
  await db().insert(userPermissionGrants).values([
    ...(["accounting:expense:read", "accounting:expense:review", "accounting:petty-cash:write"] as const).map((permission) => ({ userId: "accountant", permission })),
    ...(["accounting:expense:read", "accounting:expense:review"] as const).map((permission) => ({ userId: "reviewer", permission })),
    { userId: "auditor", permission: "accounting:expense:read" },
  ]);
});
afterEach(() => { d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("零用金：增加", () => {
  it("每次增加都留紀錄，每一筆帶當下餘額；金額要是正整數；沒有手動減少", async () => {
    await topUp(5000);
    expect((await addCash(300, "週轉金")).status).toBe(201);
    expect((await addCash(0)).status).toBe(400);
    expect((await addCash(-300)).status).toBe(400);
    const body = await (await api("/accounting/petty-cash", "accountant")).json() as { balanceMinor: number; entries: Array<{ kind: string; amountMinor: number; balanceAfterMinor: number; note: string; actorName: string }> };
    expect(body.balanceMinor).toBe(530000);
    expect(body.entries).toMatchObject([
      { kind: "top_up", amountMinor: 30000, balanceAfterMinor: 530000, note: "週轉金", actorName: "accountant" },
      { kind: "top_up", amountMinor: 500000, balanceAfterMinor: 500000 },
    ]);
    expect(() => d1.sqlite.prepare("INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, actor_user_id) VALUES ('r', 'reduce', -100, 'accountant')").run()).toThrow(/CHECK/);
  });

  it("打錯的增加可以更正很多次：每次輸入正確金額記一筆差額；清單把更正合進那筆增加；要寫原因；只能更正增加；錢被用掉就不能扣成負數", async () => {
    await topUp(10000);
    await topUp(500);
    type Listed = { id: string; kind: string; amountMinor: number; balanceAfterMinor: number; corrections: Array<{ amountMinor: number; note: string }>; note: string };
    const list = async () => (await (await api("/accounting/petty-cash", "accountant")).json() as { balanceMinor: number; entries: Listed[] });
    const correct = (id: string, values: Record<string, unknown>, actor = "accountant") => api(`/accounting/petty-cash/${id}/correct`, actor, "POST", values);
    const wrong = (await list()).entries.find((entry) => entry.amountMinor === 1000000)!;
    expect((await correct(wrong.id, { amountDollars: 1000, note: " " })).status).toBe(400);
    expect((await correct(wrong.id, { amountDollars: 10000, note: "沒變" })).status).toBe(400);
    expect((await correct(wrong.id, { amountDollars: -1, note: "負的" })).status).toBe(400);
    expect((await correct(wrong.id, { amountDollars: 1000, note: "多打一個 0" }, "reviewer")).status).toBe(403);
    expect((await correct(wrong.id, { amountDollars: 1000, note: "多打一個 0" })).status).toBe(201);
    // 更正打錯了再更正一次，跟上一次的結果（1,000）比。
    expect((await correct(wrong.id, { amountDollars: 1000, note: "一樣" })).status).toBe(400);
    expect((await correct(wrong.id, { amountDollars: 1500, note: "少算零錢" })).status).toBe(201);

    const after = await list();
    expect(after.balanceMinor).toBe(200000);
    expect(after.entries.map((entry) => entry.kind)).toEqual(["top_up", "top_up"]);
    expect(after.entries.find((entry) => entry.id === wrong.id)).toMatchObject({
      amountMinor: 150000,
      balanceAfterMinor: 150000,
      corrections: [{ amountMinor: -900000, note: "多打一個 0" }, { amountMinor: 50000, note: "少算零錢" }],
    });
    expect(after.entries[0]).toMatchObject({ amountMinor: 50000, balanceAfterMinor: 200000, corrections: [] });
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM accounting_petty_cash_entries WHERE kind = 'correction'").get()).toEqual({ n: 2 });

    // 撥款不能更正。
    const claim = await submit("employee", "1900");
    expect((await approve(claim)).body).toMatchObject({ status: "paid" });
    const payout = (await list()).entries.find((entry) => entry.kind === "payout")!;
    expect((await correct(payout.id, { amountDollars: 0, note: "不行" })).status).toBe(404);

    // 錢被報帳用掉後（餘額剩 100），500 那筆改成 0 會扣成負數，擋下來。
    const small = after.entries[0]!;
    expect((await correct(small.id, { amountDollars: 0, note: "不該加" })).status).toBe(409);
    expect(balance()).toBe(10000);
  });

  it("權限：增加要 petty-cash:write；只能看的人看得到餘額", async () => {
    expect((await addCash(100, "", "reviewer")).status).toBe(403);
    expect((await api("/accounting/petty-cash", "auditor")).status).toBe(200);
    expect((await api("/accounting/petty-cash", "outsider")).status).toBe(403);
  });

  it("紀錄不能改、不能刪；直接寫成負餘額也會被擋（0264 的 trigger）", async () => {
    await topUp(100);
    expect(() => d1.sqlite.prepare("UPDATE accounting_petty_cash_entries SET amount_minor = 1").run()).toThrow(/append_only/);
    expect(() => d1.sqlite.prepare("DELETE FROM accounting_petty_cash_entries").run()).toThrow(/append_only/);
    const expense = await submit("employee");
    expect(() => d1.sqlite.prepare("INSERT INTO accounting_petty_cash_entries (id, kind, amount_minor, expense_id, actor_user_id) VALUES ('x', 'payout', -20000, ?, 'accountant')").run(expense)).toThrow(/balance_negative/);
    expect(balance()).toBe(10000);
  });
});

describe("零用金：直接撥款", () => {
  it("零用金夠：核准就直接已付款並扣一筆，通知寫已撥款", async () => {
    await topUp(1000);
    const id = await submit("employee");
    expect(await approve(id)).toEqual({ status: 200, body: { id, status: "paid", pettyCashShort: false } });
    expect(row(id)).toMatchObject({ status: "paid", payout_method: "direct", revision: 2 });
    expect(entries(id)).toEqual([{ kind: "payout", amount_minor: -35000 }]);
    expect(balance()).toBe(65000);
    expect(notifications()).toEqual(["報帳已撥款"]);
  });

  it("零用金不夠：停在待撥款並回報不足；標記撥款也擋，增加後才能撥", async () => {
    await topUp(100);
    const id = await submit("employee");
    expect(await approve(id)).toEqual({ status: 200, body: { id, status: "approved", pettyCashShort: true } });
    expect(entries(id)).toEqual([]);
    const blocked = await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 2 });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as { error: string }).error).toContain("零用金餘額不足");
    expect(row(id)).toMatchObject({ status: "approved", revision: 2 });
    await topUp(1000);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 2 })).status).toBe(200);
    expect(entries(id)).toEqual([{ kind: "payout", amount_minor: -35000 }]);
    expect(balance()).toBe(75000);
  });

  it("餘額只夠一張時，兩張只有一張直接付掉，餘額不會變負", async () => {
    await topUp(500);
    const first = await submit("employee");
    const second = await submit("employee");
    const results = await Promise.all([approve(first), approve(second)]);
    expect(results.map((result) => result.body.status).sort()).toEqual(["approved", "paid"]);
    expect(balance()).toBe(15000);
  });
});

describe("狀態退回", () => {
  it("已付款退回待撥款會把錢退回零用金，不通知；再撥一次會再扣", async () => {
    await topUp(1000);
    const id = await submit("employee");
    await approve(id);
    expect((await api(`/accounting/expenses/${id}/revert-payment`, "accountant", "POST", { revision: 2 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "approved", paid_at: null, revision: 3 });
    expect(entries(id)).toEqual([{ kind: "payout", amount_minor: -35000 }, { kind: "refund", amount_minor: 35000 }]);
    expect(balance()).toBe(100000);
    expect(notifications()).toEqual(["報帳已撥款"]);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 3 })).status).toBe(200);
    expect(balance()).toBe(65000);
    expect(notifications()).toEqual(["報帳已撥款", "報帳已撥款"]);
  });

  it("報帳清單標出有沒有從零用金付；餘額可以單獨讀", async () => {
    await topUp(1000);
    const claim = await submit("employee");
    await approve(claim);
    const listed = await (await api("/accounting/expenses?status=paid", "accountant")).json() as { expenses: Array<{ id: string; paidFromPettyCash: boolean }> };
    expect(listed.expenses.find((expense) => expense.id === claim)).toMatchObject({ paidFromPettyCash: true });
    expect(await (await api("/accounting/petty-cash/balance", "auditor")).json()).toEqual({ balanceMinor: 65000 });
    expect((await api("/accounting/petty-cash/balance", "outsider")).status).toBe(403);
    await api(`/accounting/expenses/${claim}/revert-payment`, "accountant", "POST", { revision: 2 });
    const reverted = await (await api("/accounting/expenses?status=approved", "accountant")).json() as { expenses: Array<{ id: string; paidFromPettyCash: boolean }> };
    expect(reverted.expenses.find((expense) => expense.id === claim)).toMatchObject({ paidFromPettyCash: false });
  });

  it("零用金上線前就付掉的單，退回只改狀態、不退錢", async () => {
    const id = await submit("employee");
    d1.sqlite.prepare("UPDATE accounting_expenses SET status = 'paid', payout_method = 'direct', paid_at = '2026-01-01 00:00:00', revision = 3 WHERE id = ?").run(id);
    expect((await api(`/accounting/expenses/${id}/revert-payment`, "accountant", "POST", { revision: 3 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "approved" });
    expect(entries(id)).toEqual([]);
  });

  it("取消核准回到待審核，核准的結果清掉；再核准有第二次通知", async () => {
    const id = await submit("employee");
    await approve(id);
    expect((await api(`/accounting/expenses/${id}/unapprove`, "accountant", "POST", { revision: 2 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "pending", payout_method: null, reviewer_user_id: null, reviewed_at: null, revision: 3 });
    expect(notifications()).toEqual(["報帳已核准"]);
    await approve(id, 3);
    expect(notifications()).toEqual(["報帳已核准", "報帳已核准"]);
  });

  it("併入月薪的取消核准會拿掉加扣項；那個月結帳後不能取消、也不能退回", async () => {
    const first = await submit("employee");
    await api(`/accounting/expenses/${first}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: month() });
    expect((await api(`/accounting/expenses/${first}/unapprove`, "accountant", "POST", { revision: 2 })).status).toBe(200);
    expect(row(first)).toMatchObject({ status: "pending", payroll_adjustment_id: null });
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM hr_payroll_adjustments").get()).toEqual({ n: 0 });

    const second = await submit("employee");
    await api(`/accounting/expenses/${second}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: month() });
    await db().insert(hrPayrollPeriods).values({ id: "period-now", periodKey: month(), attendanceStart: `${month()}-01`, attendanceEnd: `${month()}-28`, status: "closed", createdBy: "accountant" });
    const unapprove = await api(`/accounting/expenses/${second}/unapprove`, "accountant", "POST", { revision: 2 });
    expect(unapprove.status).toBe(409);
    const revert = await api(`/accounting/expenses/${second}/revert-payment`, "accountant", "POST", { revision: 2 });
    expect(revert.status).toBe(409);
    expect((await revert.json() as { error: string }).error).toContain("隨月薪");
    expect(row(second)).toMatchObject({ status: "approved", revision: 2 });
  });

  it("自己的單不能退回；沒有審核權限也不行", async () => {
    await topUp(1000);
    const own = await submit("accountant");
    await approve(own, 1, "reviewer");
    expect((await api(`/accounting/expenses/${own}/revert-payment`, "accountant", "POST", { revision: 2 })).status).toBe(403);
    expect((await api(`/accounting/expenses/${own}/revert-payment`, "auditor", "POST", { revision: 2 })).status).toBe(403);
    expect((await api(`/accounting/expenses/${own}/revert-payment`, "reviewer", "POST", { revision: 2 })).status).toBe(200);
    expect((await api(`/accounting/expenses/${own}/unapprove`, "accountant", "POST", { revision: 3 })).status).toBe(403);
  });
});
