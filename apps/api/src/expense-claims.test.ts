import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, formatTaipeiDate, syncSystemRoles } from "@rueisiang/db";
import { hrEmployments, hrWorkerAccountLinks, scopes, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "expense-claims-test-secret-expense";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
const today = () => formatTaipeiDate(new Date());

async function requestSelf(route: string, method = "GET", body?: BodyInit, actor = "employee") {
  return app.fetch(new Request(`https://test.local/api/hr/me${route}`, {
    method,
    headers: { Origin: "https://hr.rueisiang.com", ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body }),
  }), env() as never);
}

function expenseForm(overrides: Record<string, string> = {}, files: Array<{ bytes: Uint8Array; type: string }> = [{ bytes: png, type: "image/png" }]) {
  const form = new FormData();
  const values = { clientRequestId: crypto.randomUUID(), categoryId: "expense-category-supplies", spentOn: today(), amountDollars: "350", invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品", ...overrides };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  for (const file of files) form.append("receipts", new Blob([Uint8Array.from(file.bytes).buffer], { type: file.type }), "receipt.png");
  return form;
}

const submit = (form: FormData, actor = "employee") => requestSelf("/expenses", "POST", form, actor);
const storedObjects = () => {
  const root = path.join(directory, "accounting");
  try { return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.endsWith(".json")).length; }
  catch { return 0; }
};
const expenseRows = () => d1.sqlite.prepare("SELECT * FROM accounting_expenses ORDER BY created_at").all() as Array<Record<string, unknown>>;

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "expense-claims-"));
  uploads = createLocalR2(directory);
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "colleague", "worker-user", "outsider"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([
    { id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" },
    { id: "employment-colleague", employeeUserId: "colleague", employeeNumber: "E002", legalName: "李小華" },
    { id: "employment-worker", personKind: "worker", employeeNumber: "W001", legalName: "支援小陳" },
  ]);
  await db().insert(hrWorkerAccountLinks).values({ workerId: "employment-worker", userId: "worker-user", linkedBy: "employee" });
  await db().insert(scopes).values({ id: "scope-ximen", sourceType: "manual", scopeKind: "store", name: "西門店", normalizedName: "西門店" });
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("報公帳：員工送件", () => {
  it("表單選項只帶預設類別，不帶店別", async () => {
    const response = await requestSelf("/expense-options");
    expect(response.status).toBe(200);
    const options = await response.json() as { categories: Array<{ name: string }>; scopes?: unknown };
    expect(options.categories.map((category) => category.name)).toEqual(["通路進貨", "日常備品", "交通運輸", "餐費", "郵寄物流", "其他"]);
    expect(options.scopes).toBeUndefined();
  });

  it("送出後金額存分、發票號碼統一格式，照片只有本人讀得到，列表不暴露儲存 key", async () => {
    const response = await submit(expenseForm({ scopeId: "scope-ximen", invoiceNumber: "ab-1234 5678", sellerTaxId: "12345678" }, [{ bytes: png, type: "image/png" }, { bytes: png, type: "image/png" }]));
    expect(response.status, await response.clone().text()).toBe(201);
    const { id } = await response.json() as { id: string };
    const [row] = expenseRows();
    expect(row).toMatchObject({ id, payer_kind: "employee_advance", status: "pending", employment_id: "employment-employee", amount_minor: 35000, invoice_number: "AB12345678", scope_id: "scope-ximen" });

    const listText = await (await requestSelf("/expenses")).text();
    const { expenses } = JSON.parse(listText) as { expenses: Array<{ id: string; receiptIds: string[]; categoryName: string; scopeName: string }> };
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ id, categoryName: "日常備品", scopeName: "西門店" });
    expect(expenses[0]!.receiptIds).toHaveLength(2);
    expect(listText).not.toContain("accounting/expense-receipts");

    const receipt = await requestSelf(`/expenses/${id}/receipts/${expenses[0]!.receiptIds[0]}`);
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await receipt.arrayBuffer())).toEqual(png);
    expect((await requestSelf(`/expenses/${id}/receipts/${expenses[0]!.receiptIds[0]}`, "GET", undefined, "colleague")).status).toBe(404);
    expect(JSON.parse(await (await requestSelf("/expenses", "GET", undefined, "colleague")).text())).toEqual({ expenses: [] });
  });

  it("同一個送件識別碼連送兩次只有一張、照片只寫一次", async () => {
    const clientRequestId = crypto.randomUUID();
    const first = await submit(expenseForm({ clientRequestId }));
    expect(first.status).toBe(201);
    const second = await submit(expenseForm({ clientRequestId }));
    expect(second.status).toBe(200);
    expect((await second.json() as { id: string }).id).toBe((await first.json() as { id: string }).id);
    expect(expenseRows()).toHaveLength(1);
    expect(storedObjects()).toBe(1);
  });

  it.each([
    ["未來的日期", { spentOn: "2999-01-01" }],
    ["不存在的日期", { spentOn: "2026-02-30" }],
    ["一年以前的日期", { spentOn: "2016-01-01" }],
    ["金額不是整數", { amountDollars: "12.5" }],
    ["金額為零", { amountDollars: "0" }],
    ["發票號碼格式錯", { invoiceNumber: "A1234567" }],
    ["統編格式錯", { sellerTaxId: "1234" }],
    ["沒有用途", { description: "   " }],
    ["停用或不存在的類別", { categoryId: "missing" }],
    ["不是門市的店別", { scopeId: "missing" }],
  ])("拒絕%s，不寫資料也不寫照片", async (_label, overrides) => {
    expect((await submit(expenseForm(overrides))).status).toBe(400);
    expect(expenseRows()).toHaveLength(0);
    expect(storedObjects()).toBe(0);
  });

  it("收據（沒有發票號碼）一定要附照片", async () => {
    const response = await submit(expenseForm({ invoiceNumber: "" }, []));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "沒有發票號碼時，請附上收據照片。" });
    expect(expenseRows()).toHaveLength(0);
  });

  it("有發票號碼時照片是選填的補充資料：沒有照片也能送出", async () => {
    const response = await submit(expenseForm({ invoiceNumber: "EF12345678" }, []));
    expect(response.status, await response.clone().text()).toBe(201);
    expect(expenseRows()).toHaveLength(1);
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM accounting_expense_receipts").get()).toEqual({ n: 0 });
    const { expenses } = await (await requestSelf("/expenses")).json() as { expenses: Array<{ receiptIds: string[] }> };
    expect(expenses[0]!.receiptIds).toEqual([]);
    expect(storedObjects()).toBe(0);
  });

  it("照片超過五張、或照片不是有效圖片都擋下", async () => {
    expect((await submit(expenseForm({}, Array.from({ length: 6 }, () => ({ bytes: png, type: "image/png" }))))).status).toBe(400);
    expect((await submit(expenseForm({}, [{ bytes: Buffer.from("<svg onload=alert(1) />"), type: "image/svg+xml" }]))).status).toBe(400);
    expect((await submit(expenseForm({}, [{ bytes: Buffer.from("<html>fake</html>"), type: "image/png" }]))).status).toBe(400);
    expect(expenseRows()).toHaveLength(0);
    expect(storedObjects()).toBe(0);
  });

  it("發票號碼已經有人報過時先擋下，確認後可以再送", async () => {
    expect((await submit(expenseForm({ invoiceNumber: "AB12345678" }), "colleague")).status).toBe(201);
    const blocked = await submit(expenseForm({ invoiceNumber: "AB12345678" }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: "duplicate_invoice" });
    expect((await submit(expenseForm({ invoiceNumber: "AB12345678", confirmDuplicate: "true" }))).status).toBe(201);
    expect(expenseRows()).toHaveLength(2);
  });

  it("撤回的單不算重複發票", async () => {
    const response = await submit(expenseForm({ invoiceNumber: "CD12345678" }), "colleague");
    const { id } = await response.json() as { id: string };
    expect((await requestSelf(`/expenses/${id}/cancel`, "POST", JSON.stringify({ revision: 1 }), "colleague")).status).toBe(200);
    expect((await submit(expenseForm({ invoiceNumber: "CD12345678" }))).status).toBe(201);
  });

  it("只有待審核的本人報帳單可以撤回，版本過期也擋", async () => {
    const { id } = await (await submit(expenseForm())).json() as { id: string };
    expect((await requestSelf(`/expenses/${id}/cancel`, "POST", JSON.stringify({ revision: 1 }), "colleague")).status).toBe(404);
    expect((await requestSelf(`/expenses/${id}/cancel`, "POST", JSON.stringify({ revision: 9 }))).status).toBe(409);
    expect((await requestSelf(`/expenses/${id}/cancel`, "POST", JSON.stringify({ revision: 1 }))).status).toBe(200);
    expect(expenseRows()[0]).toMatchObject({ status: "cancelled", revision: 2 });
    expect((await requestSelf(`/expenses/${id}/cancel`, "POST", JSON.stringify({ revision: 2 }))).status).toBe(409);
  });

  it("照片寫到一半失敗時，已寫進去的照片會刪掉", async () => {
    const put = uploads.put.bind(uploads);
    vi.spyOn(uploads, "put").mockImplementationOnce(put).mockRejectedValueOnce(new Error("R2 unavailable"));
    expect((await submit(expenseForm({}, [{ bytes: png, type: "image/png" }, { bytes: png, type: "image/png" }]))).status).toBe(500);
    expect(expenseRows()).toHaveLength(0);
    expect(storedObjects()).toBe(0);
  });

  it("沒有設定儲存空間時回 503", async () => {
    const response = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { method: "POST", headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.employee! }, body: expenseForm() }), { ...env(), UPLOADS: undefined } as never);
    expect(response.status).toBe(503);
  });
});

describe("報公帳：誰可以送", () => {
  it("支援人員可以報帳，支出單記他的任職資料；其他申請仍然不開放", async () => {
    const response = await submit(expenseForm(), "worker-user");
    expect(response.status, await response.clone().text()).toBe(201);
    expect(expenseRows()[0]).toMatchObject({ employment_id: "employment-worker", submitter_user_id: "worker-user" });
    const { expenses } = await (await requestSelf("/expenses", "GET", undefined, "worker-user")).json() as { expenses: Array<{ id: string; receiptIds: string[] }> };
    expect(expenses).toHaveLength(1);
    expect((await requestSelf(`/expenses/${expenses[0]!.id}/receipts/${expenses[0]!.receiptIds[0]}`, "GET", undefined, "worker-user")).status).toBe(200);
    expect((await requestSelf(`/expenses/${expenses[0]!.id}/cancel`, "POST", JSON.stringify({ revision: 1 }), "worker-user")).status).toBe(200);
    expect((await requestSelf("/leave-requests", "GET", undefined, "worker-user")).status).toBe(403);
  });

  it("支援人員讀得到報帳通知、可以標成已讀，其他種類的通知不給", async () => {
    const insert = d1.sqlite.prepare("INSERT INTO hr_notifications (id, user_id, source_key, kind, entity_kind, entity_id, title, body) VALUES (?, ?, ?, 'request_reviewed', ?, 'x', ?, '內文')");
    insert.run("n-expense", "worker-user", "k-expense", "expense", "報帳已核准");
    insert.run("n-leave", "worker-user", "k-leave", "leave", "請假已核准");
    const response = await requestSelf("/notifications", "GET", undefined, "worker-user");
    expect(response.status).toBe(200);
    const body = await response.json() as { notifications: Array<{ id: string }>; unreadCount: number };
    expect(body.notifications.map((notification) => notification.id)).toEqual(["n-expense"]);
    expect(body.unreadCount).toBe(1);
    expect((await requestSelf("/notifications/n-expense/read", "POST", JSON.stringify({}), "worker-user")).status).toBe(200);
    expect((await requestSelf("/notifications/read-all", "POST", JSON.stringify({}), "worker-user")).status).toBe(200);
  });

  it("停用的支援人員與沒有任職資料的人不能送", async () => {
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at = CURRENT_TIMESTAMP WHERE id = 'employment-worker'").run();
    expect((await submit(expenseForm(), "worker-user")).status).toBe(403);
    expect((await submit(expenseForm(), "outsider")).status).toBe(403);
    expect((await requestSelf("/expense-options", "GET", undefined, "outsider")).status).toBe(403);
    expect(expenseRows()).toHaveLength(0);
    expect(storedObjects()).toBe(0);
  });

  it("離職員工看得到自己送過的單，但不能再送新的", async () => {
    expect((await submit(expenseForm())).status).toBe(201);
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at = CURRENT_TIMESTAMP WHERE id = 'employment-employee'").run();
    expect((await submit(expenseForm())).status).toBe(403);
    const { expenses } = await (await requestSelf("/expenses")).json() as { expenses: unknown[] };
    expect(expenses).toHaveLength(1);
  });
});
