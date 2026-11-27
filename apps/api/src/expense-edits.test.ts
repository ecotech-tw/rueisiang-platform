import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, formatTaipeiDate, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, hrWorkerAccountLinks, userPermissionGrants, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "expense-edits-test-secret-accounting-x";
const ORIGIN = "https://hr.rueisiang.com";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: ORIGIN, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
const today = () => formatTaipeiDate(new Date());

function form(values: Record<string, string | string[]>, photos: number) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) for (const item of value) data.append(key, item);
    else data.set(key, value);
  }
  for (let index = 0; index < photos; index += 1) data.append("receipts", new Blob([Uint8Array.from(png).buffer], { type: "image/png" }), "receipt.png");
  return data;
}

async function self(route: string, actor: string, init: { method?: string; body?: FormData | string } = {}) {
  return app.fetch(new Request(`https://test.local/api/hr/me${route}`, {
    method: init.method ?? "GET",
    headers: { Origin: ORIGIN, Cookie: cookies[actor]!, ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}) },
    ...(init.body ? { body: init.body } : {}),
  }), env() as never);
}
async function accounting(route: string, actor: string, method = "GET", values?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api/accounting${route}`, {
    method,
    headers: { ...(values ? { "Content-Type": "application/json" } : {}), Cookie: cookies[actor]! },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}

const base = () => ({ categoryId: "expense-category-supplies", spentOn: today(), amountDollars: "350", invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品" });
async function submit(actor: string, overrides: Record<string, string> = {}, photos = 1) {
  const response = await self("/expenses", actor, { method: "POST", body: form({ clientRequestId: crypto.randomUUID(), ...base(), ...overrides }, photos) });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}
async function editMine(actor: string, id: string, values: Record<string, string | string[]>, photos = 0) {
  return self(`/expenses/${id}/edit`, actor, { method: "POST", body: form({ ...base(), ...values }, photos) });
}
const row = (id: string) => d1.sqlite.prepare("SELECT * FROM accounting_expenses WHERE id = ?").get(id) as Record<string, unknown>;
const receipts = (id: string) => d1.sqlite.prepare("SELECT id, object_key, sort_order FROM accounting_expense_receipts WHERE expense_id = ? ORDER BY sort_order").all(id) as Array<{ id: string; object_key: string; sort_order: number }>;
type History = { history: Array<{ editor: string; actorName: string; changes: Array<{ field: string; label: string; from: string; to: string }> }> };

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "expense-edits-"));
  uploads = createLocalR2(directory);
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "colleague", "accountant", "auditor", "worker-user"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([
    { id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" },
    { id: "employment-colleague", employeeUserId: "colleague", employeeNumber: "E002", legalName: "李同事" },
    { id: "employment-accountant", employeeUserId: "accountant", employeeNumber: "E003", legalName: "陳會計" },
    { id: "employment-worker", personKind: "worker", employeeNumber: "W001", legalName: "支援小陳" },
  ]);
  await db().insert(hrWorkerAccountLinks).values({ workerId: "employment-worker", userId: "worker-user", linkedBy: "employee" });
  await db().insert(userPermissionGrants).values([
    ...(["accounting:expense:read", "accounting:expense:review"] as const).map((permission) => ({ userId: "accountant", permission })),
    { userId: "auditor", permission: "accounting:expense:read" },
  ]);
});
afterEach(() => { d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("報帳：送件人修改待審核的單", () => {
  it("改欄位、版本加一、留下前後差異；沒有任何變動就不寫", async () => {
    const id = await submit("employee");
    const response = await editMine("employee", id, { revision: "1", amountDollars: "300", description: "門市清潔用品（拖把）" });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ id, changed: true });
    expect(row(id)).toMatchObject({ amount_minor: 30000, description: "門市清潔用品（拖把）", revision: 2, status: "pending" });
    const { history } = await (await self(`/expenses/${id}/history`, "employee")).json() as History;
    expect(history).toEqual([{ id: expect.any(String), at: expect.any(String), editor: "submitter", actorName: "employee", changes: [
      { field: "amount", label: "金額", from: "NT$ 350", to: "NT$ 300" },
      { field: "description", label: "用途", from: "門市清潔用品", to: "門市清潔用品（拖把）" },
    ] }]);
    expect(await (await editMine("employee", id, { revision: "2", amountDollars: "300", description: "門市清潔用品（拖把）" })).json()).toEqual({ id, changed: false });
    expect(row(id)).toMatchObject({ revision: 2 });
    // 送件人自己改不發通知。
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM hr_notifications").get()).toEqual({ n: 0 });
  });

  it("可以加照片、移除照片；沒有發票號碼時至少要留一張；移除的照片檔也刪掉", async () => {
    const id = await submit("employee");
    const [first] = receipts(id);
    expect((await editMine("employee", id, { revision: "1", removeReceiptIds: [first!.id] })).status).toBe(400);
    expect(receipts(id)).toHaveLength(1);
    const response = await editMine("employee", id, { revision: "1", removeReceiptIds: [first!.id] }, 2);
    expect(response.status, await response.clone().text()).toBe(200);
    const after = receipts(id);
    expect(after.map((receipt) => receipt.id)).not.toContain(first!.id);
    expect(after.map((receipt) => receipt.sort_order)).toEqual([1, 2]);
    expect(await uploads.get(first!.object_key)).toBeNull();
    const { history } = await (await self(`/expenses/${id}/history`, "employee")).json() as History;
    expect(history[0]!.changes).toEqual([{ field: "receipts", label: "單據照片", from: "1 張", to: "2 張" }]);
    // 有發票號碼的話照片可以全部移除。
    expect((await editMine("employee", id, { revision: "2", invoiceNumber: "AB12345678", removeReceiptIds: after.map((receipt) => receipt.id) })).status).toBe(200);
    expect(receipts(id)).toEqual([]);
    expect((await editMine("employee", id, { revision: "3", removeReceiptIds: ["not-mine"], invoiceNumber: "AB12345678" })).status).toBe(400);
  });

  it("非待審核、別人的單、版本過期都不能改", async () => {
    const id = await submit("employee");
    expect((await editMine("colleague", id, { revision: "1", amountDollars: "1" })).status).toBe(404);
    expect((await editMine("employee", id, { revision: "9", amountDollars: "300" })).status).toBe(409);
    await accounting(`/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    const blocked = await editMine("employee", id, { revision: "2", amountDollars: "300" });
    expect(blocked.status).toBe(409);
    expect(row(id)).toMatchObject({ amount_minor: 35000, status: "approved" });
    expect((await self(`/expenses/${id}/history`, "colleague")).status).toBe(404);
  });

  it("發票號碼跟別張重複時要確認才存", async () => {
    await submit("colleague", { invoiceNumber: "AB12345678" });
    const id = await submit("employee");
    const duplicate = await editMine("employee", id, { revision: "1", invoiceNumber: "AB12345678" });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "duplicate_invoice" });
    expect((await editMine("employee", id, { revision: "1", invoiceNumber: "AB12345678", confirmDuplicate: "true" })).status).toBe(200);
  });

  it("支援人員也能改自己的報帳、看修改紀錄", async () => {
    const id = await submit("worker-user");
    expect((await editMine("worker-user", id, { revision: "1", amountDollars: "200" })).status).toBe(200);
    expect((await self(`/expenses/${id}/history`, "worker-user")).status).toBe(200);
  });
});

describe("報帳：會計修改待審核的單", () => {
  const edit = { categoryId: "expense-category-supplies", spentOn: "", amountDollars: 280, invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品" };

  it("會計改了留紀錄、通知送件人；送件人與會計看得到同一份紀錄", async () => {
    const id = await submit("employee");
    const response = await accounting(`/expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(row(id)).toMatchObject({ amount_minor: 28000, revision: 2, status: "pending" });
    expect(receipts(id)).toHaveLength(1);
    const notification = d1.sqlite.prepare("SELECT user_id, kind, entity_kind, entity_id, title, body FROM hr_notifications").get() as Record<string, string>;
    expect(notification).toMatchObject({ user_id: "employee", kind: "request_reviewed", entity_kind: "expense", entity_id: id, title: "會計修改了你的報帳" });
    expect(notification.body).toContain("金額 NT$ 350 → NT$ 280");
    const mine = await (await self(`/expenses/${id}/history`, "employee")).json() as History;
    const theirs = await (await accounting(`/expenses/${id}/history`, "auditor")).json() as History;
    expect(mine).toEqual(theirs);
    expect(mine.history[0]).toMatchObject({ editor: "reviewer", actorName: "accountant", changes: [{ field: "amount", from: "NT$ 350", to: "NT$ 280" }] });

    // 第二次修改也要再通知一次（通知的 source_key 帶版本）。
    expect((await accounting(`/expenses/${id}`, "accountant", "PATCH", { ...edit, amountDollars: 250, spentOn: today(), revision: 2 })).status).toBe(200);
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM hr_notifications WHERE entity_id = ?").get(id)).toEqual({ n: 2 });
  });

  it("不能改自己的單、版本過期擋下、只有檢視權限不能改、核准後不能改", async () => {
    const own = await submit("accountant");
    expect((await accounting(`/expenses/${own}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 })).status).toBe(403);
    const id = await submit("employee");
    expect((await accounting(`/expenses/${id}`, "auditor", "PATCH", { ...edit, spentOn: today(), revision: 1 })).status).toBe(403);
    expect((await accounting(`/expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 9 })).status).toBe(409);
    await accounting(`/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    expect((await accounting(`/expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 2 })).status).toBe(409);
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE event_type = 'expense_edited'").get()).toEqual({ n: 0 });
  });

  it("沒有發票號碼又沒照片的情況會計也存不了；會計不動照片", async () => {
    const id = await submit("employee", { invoiceNumber: "AB12345678" }, 0);
    const response = await accounting(`/expenses/${id}`, "accountant", "PATCH", { ...edit, spentOn: today(), revision: 1 });
    expect(response.status).toBe(400);
    expect(row(id)).toMatchObject({ invoice_number: "AB12345678", revision: 1 });
  });
});
