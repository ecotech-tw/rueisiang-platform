import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, formatTaipeiDate, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, scopes, userPermissionGrants, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "accounting-ledger-test-secret-accounting";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
const today = () => formatTaipeiDate(new Date());
const month = () => today().slice(0, 7);

async function api(route: string, actor: string, method = "GET", values?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${route}`, {
    method,
    headers: { ...(values ? { "Content-Type": "application/json" } : {}), Cookie: cookies[actor]! },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}

function form(values: Record<string, string>, photos: number) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  for (let index = 0; index < photos; index += 1) data.append("receipts", new Blob([Uint8Array.from(png).buffer], { type: "image/png" }), "receipt.png");
  return data;
}

async function record(actor: string, overrides: Record<string, string> = {}, photos = 1) {
  const values = { clientRequestId: crypto.randomUUID(), categoryId: "expense-category-supplies", spentOn: today(), amountDollars: "1200", invoiceNumber: "", sellerTaxId: "", description: "門市冷氣保養", ...overrides };
  return app.fetch(new Request("https://test.local/api/accounting/company-expenses", { method: "POST", headers: { Cookie: cookies[actor]! }, body: form(values, photos) }), env() as never);
}
async function recorded(overrides: Record<string, string> = {}, photos = 1) {
  const response = await record("accountant", overrides, photos);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function submit(actor: string, overrides: Record<string, string> = {}) {
  const values = { clientRequestId: crypto.randomUUID(), categoryId: "expense-category-supplies", spentOn: today(), amountDollars: "350", invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品", ...overrides };
  const response = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { method: "POST", headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies[actor]! }, body: form(values, 1) }), env() as never);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

type Entry = { id: string; payerKind: string; status: string; amountMinor: number; personName: string; scopeName: string | null; revision: number; receiptIds: string[] };
async function ledger(query: Record<string, string> = {}, actor = "accountant") {
  const response = await api(`/accounting/ledger?${new URLSearchParams({ month: month(), ...query }).toString()}`, actor);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as { entries: Entry[]; totalMinor: number };
}
const row = (id: string) => d1.sqlite.prepare("SELECT * FROM accounting_expenses WHERE id = ?").get(id) as Record<string, unknown>;

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "accounting-ledger-"));
  uploads = createLocalR2(directory);
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "accountant", "auditor", "reviewer", "outsider"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([
    { id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" },
    { id: "employment-accountant", employeeUserId: "accountant", employeeNumber: "E002", legalName: "陳會計" },
  ]);
  await db().insert(scopes).values([
    { id: "store-a", sourceType: "cyberbiz", scopeKind: "store", name: "台北店", normalizedName: "台北店" },
    { id: "store-b", sourceType: "cyberbiz", scopeKind: "store", name: "台中店", normalizedName: "台中店" },
  ]);
  await db().insert(userPermissionGrants).values([
    ...(["accounting:expense:read", "accounting:expense:review", "accounting:expense:write"] as const).map((permission) => ({ userId: "accountant", permission })),
    ...(["accounting:expense:read", "accounting:expense:review"] as const).map((permission) => ({ userId: "reviewer", permission })),
    { userId: "auditor", permission: "accounting:expense:read" },
  ]);
});
afterEach(() => { d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("會計：登記公司支出", () => {
  it("登記就算已付款；不出現在登記人自己的報帳，也不出現在報帳審核頁", async () => {
    const id = await recorded({ scopeId: "store-a", invoiceNumber: "ab-1234 5678", sellerTaxId: "12345678" });
    expect(row(id)).toMatchObject({ payer_kind: "company", status: "paid", submitter_user_id: "accountant", employment_id: null, scope_id: "store-a", invoice_number: "AB12345678", amount_minor: 120000 });
    expect(row(id).paid_at).toBeTruthy();
    expect(d1.sqlite.prepare("SELECT event_type, actor_id FROM activity_events WHERE entity_id = ?").all(id)).toEqual([{ event_type: "company_expense_recorded", actor_id: "accountant" }]);
    const mine = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.accountant! } }), env() as never);
    expect((await mine.json() as { expenses: unknown[] }).expenses).toEqual([]);
    const review = await api("/accounting/expenses?status=all", "accountant");
    expect((await review.json() as { expenses: unknown[] }).expenses).toEqual([]);
    const [entry] = (await ledger()).entries;
    expect(entry).toMatchObject({ id, payerKind: "company", status: "paid", personName: "accountant", scopeName: "台北店" });
    expect((await api(`/accounting/expenses/${id}/receipts/${entry!.receiptIds[0]}`, "accountant")).status).toBe(200);
  });

  it("欄位規則跟員工報帳一樣：收據要附照片、發票號碼重複要確認；連按兩次只有一筆", async () => {
    expect((await record("accountant", {}, 0)).status).toBe(400);
    expect((await record("accountant", { scopeId: "missing" })).status).toBe(400);
    const first = await recorded({ invoiceNumber: "AB12345678" }, 0);
    const duplicate = await record("accountant", { invoiceNumber: "AB12345678" }, 0);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "duplicate_invoice" });
    const confirmed = await recorded({ invoiceNumber: "AB12345678", confirmDuplicate: "true" }, 0);
    expect(confirmed).not.toBe(first);
    const clientRequestId = crypto.randomUUID();
    const once = await recorded({ clientRequestId, invoiceNumber: "CD12345678" }, 0);
    const twice = await record("accountant", { clientRequestId, invoiceNumber: "CD12345678" }, 0);
    expect(await twice.json()).toEqual({ id: once });
  });

  it("權限：登記要 accounting:expense:write；只能看的人看得到支出帳、不能登記", async () => {
    expect((await record("reviewer")).status).toBe(403);
    expect((await record("auditor")).status).toBe(403);
    expect((await api("/accounting/company-expenses/options", "auditor")).status).toBe(200);
    expect((await api("/accounting/company-expenses/options", "outsider")).status).toBe(403);
    expect((await api(`/accounting/ledger?month=${month()}`, "outsider")).status).toBe(403);
    await recorded();
    expect((await ledger({}, "auditor")).entries).toHaveLength(1);
    const options = await (await api("/accounting/company-expenses/options", "accountant")).json() as { categories: unknown[]; scopes: Array<{ id: string }> };
    expect(options.scopes.map((scope) => scope.id).sort()).toEqual(["store-a", "store-b"]);
    expect(options.categories.length).toBeGreaterThan(0);
  });
});

describe("會計：支出帳", () => {
  it("一個月算數的支出：公司支出加核准過的員工報帳；待審、退回、作廢不算；可以篩付款人、類別、店別", async () => {
    const company = await recorded({ scopeId: "store-a" });
    await recorded({ scopeId: "store-b", amountDollars: "800" });
    const approved = await submit("employee");
    await api(`/accounting/expenses/${approved}/approve`, "accountant", "POST", { revision: 1 });
    await submit("employee", { amountDollars: "999" });
    const rejected = await submit("employee", { amountDollars: "777" });
    await api(`/accounting/expenses/${rejected}/reject`, "accountant", "POST", { revision: 1, note: "不是公司的" });

    const all = await ledger();
    expect(all.entries.map((entry) => entry.amountMinor).sort((a, b) => a - b)).toEqual([35000, 80000, 120000]);
    expect(all.totalMinor).toBe(235000);
    expect(all.entries.find((entry) => entry.id === approved)).toMatchObject({ payerKind: "employee_advance", status: "approved", personName: "王小明", scopeName: null });
    expect((await ledger({ payer: "company" })).entries.map((entry) => entry.payerKind)).toEqual(["company", "company"]);
    expect((await ledger({ payer: "employee_advance" })).entries.map((entry) => entry.id)).toEqual([approved]);
    expect((await ledger({ scopeId: "store-a" })).entries.map((entry) => entry.id)).toEqual([company]);
    expect((await ledger({ categoryId: "expense-category-supplies" })).entries).toHaveLength(3);
    expect((await ledger({ month: "2020-01" })).entries).toEqual([]);
    expect((await api("/accounting/ledger?month=2026-13", "accountant")).status).toBe(400);
    expect((await api(`/accounting/ledger?month=${month()}&payer=friend`, "accountant")).status).toBe(400);
  });
});

describe("會計：修改與作廢公司支出", () => {
  const edit = { categoryId: "expense-category-supplies", scopeId: "store-b", spentOn: "", amountDollars: 1500, invoiceNumber: "", sellerTaxId: "", description: "門市冷氣保養（含零件）" };

  it("改欄位、留紀錄；版本過期擋下；員工報帳不能從這裡改", async () => {
    const id = await recorded();
    const changed = await api(`/accounting/company-expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(row(id)).toMatchObject({ amount_minor: 150000, scope_id: "store-b", description: "門市冷氣保養（含零件）", revision: 2, status: "paid" });
    expect(d1.sqlite.prepare("SELECT event_type FROM activity_events WHERE entity_id = ? ORDER BY rowid").all(id)).toEqual([{ event_type: "company_expense_recorded" }, { event_type: "company_expense_updated" }]);
    expect((await api(`/accounting/company-expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 })).status).toBe(409);
    const claim = await submit("employee");
    expect((await api(`/accounting/company-expenses/${claim}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 })).status).toBe(404);
    expect((await api(`/accounting/company-expenses/${id}`, "reviewer", "PATCH", { ...edit, spentOn: today(), revision: 2 })).status).toBe(403);
  });

  it("有發票號碼、沒照片的那筆，改成沒有發票號碼會擋下", async () => {
    const id = await recorded({ invoiceNumber: "AB12345678" }, 0);
    const response = await api(`/accounting/company-expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 });
    expect(response.status).toBe(400);
    expect(row(id)).toMatchObject({ invoice_number: "AB12345678", revision: 1 });
    expect((await api(`/accounting/company-expenses/${id}`, "accountant", "PATCH", { ...edit, invoiceNumber: "AB12345678", spentOn: today(), revision: 1 })).status).toBe(200);
  });

  it("作廢後不算進支出帳，也不能再改或再作廢", async () => {
    const id = await recorded();
    expect((await api(`/accounting/company-expenses/${id}/void`, "accountant", "POST", { revision: 1 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "cancelled", revision: 2 });
    expect((await ledger()).entries).toEqual([]);
    expect((await api(`/accounting/company-expenses/${id}/void`, "accountant", "POST", { revision: 2 })).status).toBe(409);
    expect((await api(`/accounting/company-expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 2 })).status).toBe(409);
  });
});
