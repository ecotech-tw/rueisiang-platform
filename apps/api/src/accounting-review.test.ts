import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, deleteHrPayrollAdjustment, formatTaipeiDate, listHrPayrollAdjustments, syncSystemRoles, updateHrPayrollAdjustment } from "@rueisiang/db";
import { hrEmployments, hrPayrollPeriods, userPermissionGrants, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "accounting-review-test-secret-accounting";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });

async function api(route: string, actor: string, method = "GET", values?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${route}`, {
    method,
    headers: { ...(values ? { "Content-Type": "application/json" } : {}), Cookie: cookies[actor]! },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}

async function submit(actor: string, overrides: Record<string, string> = {}) {
  const form = new FormData();
  const values = { clientRequestId: crypto.randomUUID(), categoryId: "expense-category-supplies", spentOn: formatTaipeiDate(new Date()), amountDollars: "350", invoiceNumber: "", sellerTaxId: "", description: "門市清潔用品", ...overrides };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  form.append("receipts", new Blob([Uint8Array.from(png).buffer], { type: "image/png" }), "receipt.png");
  const response = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { method: "POST", headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies[actor]! }, body: form }), env() as never);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

type ReviewRow = { id: string; status: string; revision: number; submitterName: string; employeeNumber: string; receiptIds: string[]; duplicateInvoiceCount: number; reviewNote: string; payoutMethod: string | null; payrollPeriodKey: string | null; payrollOption: string | null; reviewerName: string | null; paidAt: string | null };
async function list(actor: string, status = "pending") {
  const response = await api(`/accounting/expenses?status=${status}`, actor);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json() as { expenses: ReviewRow[] }).expenses;
}
const row = (id: string) => d1.sqlite.prepare("SELECT * FROM accounting_expenses WHERE id = ?").get(id) as Record<string, unknown>;
/** 標記已撥款一律從零用金扣，先放錢進去。 */
async function topUp(dollars: number) {
  const response = await api("/accounting/petty-cash", "accountant", "POST", { kind: "top_up", amountDollars: dollars, note: "" });
  expect(response.status, await response.clone().text()).toBe(201);
}
/** 台北的這個月與下個月 YYYY-MM。 */
function months() {
  const [year, month] = formatTaipeiDate(new Date()).split("-").map(Number) as [number, number];
  const key = (offset: number) => new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
  return { current: key(0), next: key(1) };
}
async function closePeriod(periodKey: string) {
  await db().insert(hrPayrollPeriods).values({ id: `period-${periodKey}`, periodKey, attendanceStart: `${periodKey}-01`, attendanceEnd: `${periodKey}-28`, status: "closed", createdBy: "accountant" });
}
const adjustments = () => d1.sqlite.prepare("SELECT a.id, a.employment_id, a.effective_period_key, a.reason, i.item_name, i.amount_minor FROM hr_payroll_adjustments a JOIN hr_payroll_adjustment_items i ON i.adjustment_id = a.id").all();

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "accounting-review-"));
  uploads = createLocalR2(directory);
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "accountant", "accountant2", "auditor", "outsider"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([
    { id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" },
    { id: "employment-accountant", employeeUserId: "accountant", employeeNumber: "E002", legalName: "陳會計" },
  ]);
  const reviewer = ["accounting:expense:read", "accounting:expense:review", "accounting:category:write", "accounting:petty-cash:write"] as const;
  await db().insert(userPermissionGrants).values([
    ...reviewer.map((permission) => ({ userId: "accountant", permission })),
    ...reviewer.map((permission) => ({ userId: "accountant2", permission })),
    { userId: "auditor", permission: "accounting:expense:read" },
  ]);
});
afterEach(() => { d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("報公帳：會計審核", () => {
  it("待審清單帶送件人、員工編號、單據與重複發票提示；會計讀得到單據照片", async () => {
    const first = await submit("employee", { invoiceNumber: "AB12345678" });
    await submit("accountant", { invoiceNumber: "AB12345678", confirmDuplicate: "true" });
    const pending = await list("accountant");
    expect(pending.map((expense) => expense.id)[0]).toBe(first);
    expect(pending[0]).toMatchObject({ submitterName: "王小明", employeeNumber: "E001", duplicateInvoiceCount: 1 });
    expect(pending[0]!.receiptIds).toHaveLength(1);
    const receipt = await api(`/accounting/expenses/${first}/receipts/${pending[0]!.receiptIds[0]}`, "accountant");
    expect(receipt.status).toBe(200);
    expect(Buffer.from(await receipt.arrayBuffer())).toEqual(png);
  });

  it("核准後是直接撥款、記下審核者並寫操作紀錄；員工看得到已核准", async () => {
    const id = await submit("employee");
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "approved", payout_method: "direct", reviewer_user_id: "accountant", revision: 2 });
    expect(d1.sqlite.prepare("SELECT event_type, actor_id FROM activity_events WHERE entity_type = 'accounting_expense' AND entity_id = ?").all(id)).toEqual([{ event_type: "expense_approved", actor_id: "accountant" }]);
    const mine = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.employee! } }), env() as never);
    expect((await mine.json() as { expenses: Array<{ status: string }> }).expenses[0]!.status).toBe("approved");
  });

  it("不能審核或標記自己的報帳單，另一位會計可以", async () => {
    const id = await submit("accountant");
    const self = await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    expect(self.status).toBe(403);
    expect(row(id)).toMatchObject({ status: "pending", revision: 1 });
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE entity_type = 'accounting_expense'").get()).toEqual({ n: 0 });
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant2", "POST", { revision: 1 })).status).toBe(200);
    await topUp(1000);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 2 })).status).toBe(403);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant2", "POST", { revision: 2 })).status).toBe(200);
  });

  it("退回一定要寫原因，員工看得到原因", async () => {
    const id = await submit("employee");
    expect((await api(`/accounting/expenses/${id}/reject`, "accountant", "POST", { revision: 1, note: "  " })).status).toBe(400);
    expect((await api(`/accounting/expenses/${id}/reject`, "accountant", "POST", { revision: 1, note: "發票抬頭不是公司" })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "rejected", review_note: "發票抬頭不是公司" });
    expect((await list("accountant", "rejected"))[0]).toMatchObject({ id, reviewNote: "發票抬頭不是公司", reviewerName: "accountant" });
  });

  it("狀態與版本不對都擋：重複核准、版本過期、沒核准就撥款、撥款後再撥一次", async () => {
    const id = await submit("employee");
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 1 })).status).toBe(409);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 9 })).status).toBe(409);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 })).status).toBe(200);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant2", "POST", { revision: 1 })).status).toBe(409);
    await topUp(1000);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 2 })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "paid", revision: 3 });
    expect(row(id).paid_at).toEqual(expect.any(String));
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 3 })).status).toBe(409);
    expect((await api("/accounting/expenses/missing/approve", "accountant", "POST", { revision: 1 })).status).toBe(404);
  });

  it("發放方式只收直接撥款或併入月薪；併入月薪要帶月份", async () => {
    const id = await submit("employee");
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "cash" })).status).toBe(400);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll" })).status).toBe(400);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: "2020-01" })).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "pending" });
    expect(adjustments()).toEqual([]);
  });

  it("權限：沒有會計權限看不到也不能審；只有檢視權限可以看、不能審", async () => {
    const id = await submit("employee");
    expect((await api("/accounting/expenses", "outsider")).status).toBe(403);
    expect((await api("/accounting/expenses", "employee")).status).toBe(403);
    expect((await api(`/accounting/expenses/${id}/approve`, "outsider", "POST", { revision: 1 })).status).toBe(403);
    expect((await list("auditor")).map((expense) => expense.id)).toEqual([id]);
    expect((await api(`/accounting/expenses/${id}/approve`, "auditor", "POST", { revision: 1 })).status).toBe(403);
    expect((await api("/accounting/categories", "auditor", "POST", { name: "雜支" })).status).toBe(403);
  });
});

describe("報公帳：審核結果通知送件人", () => {
  const notifications = (userId: string) => d1.sqlite.prepare("SELECT kind, entity_kind, entity_id, title, body FROM hr_notifications WHERE user_id = ? ORDER BY created_at, rowid").all(userId) as Array<{ kind: string; entity_kind: string; entity_id: string; title: string; body: string }>;

  it("核准、撥款各通知一次，內文帶金額與用途", async () => {
    const id = await submit("employee", { amountDollars: "1250" });
    await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    await topUp(2000);
    await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 2 });
    const rows = notifications("employee");
    expect(rows.map((row) => row.title)).toEqual(["報帳已核准", "報帳已撥款"]);
    expect(rows[0]).toMatchObject({ kind: "request_reviewed", entity_kind: "expense", entity_id: id });
    expect(rows[0]!.body).toContain("NT$ 1,250・門市清潔用品");
    expect(notifications("accountant")).toEqual([]);
  });

  it("退回的通知寫出原因", async () => {
    const id = await submit("employee");
    await api(`/accounting/expenses/${id}/reject`, "accountant", "POST", { revision: 1, note: "請附上發票" });
    expect(notifications("employee")).toEqual([expect.objectContaining({ title: "報帳已駁回", body: expect.stringContaining("駁回原因：請附上發票") })]);
  });

  it("被擋下的動作不發通知", async () => {
    const own = await submit("accountant");
    expect((await api(`/accounting/expenses/${own}/approve`, "accountant", "POST", { revision: 1 })).status).toBe(403);
    const id = await submit("employee");
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 9 })).status).toBe(409);
    expect((await api(`/accounting/expenses/${id}/paid`, "accountant", "POST", { revision: 1 })).status).toBe(409);
    expect(notifications("employee")).toEqual([]);
    expect(notifications("accountant")).toEqual([]);
  });

  it("員工從本人通知 API 讀得到", async () => {
    const id = await submit("employee");
    await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    const response = await app.fetch(new Request("https://test.local/api/hr/me/notifications", { headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.employee! } }), env() as never);
    const body = await response.json() as { notifications: Array<{ entityKind: string; entityId: string }>; unreadCount: number };
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0]).toMatchObject({ entityKind: "expense", entityId: id });
  });
});

describe("報公帳：併入月薪", () => {
  it("核准時同一批產生「代墊款」加扣項；HRIS 唯讀；員工與會計都看得到月份", async () => {
    const { current } = months();
    const id = await submit("employee", { description: "門市拖把" });
    expect((await list("accountant"))[0]).toMatchObject({ id, payrollOption: current });
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current })).status).toBe(200);
    const linked = row(id);
    expect(linked).toMatchObject({ status: "approved", payout_method: "payroll", revision: 2 });
    expect(adjustments()).toEqual([{ id: linked.payroll_adjustment_id, employment_id: "employment-employee", effective_period_key: current, reason: "報帳代墊款：門市拖把", item_name: "代墊款", amount_minor: 35000 }]);
    expect((await list("accountant", "approved"))[0]).toMatchObject({ id, payrollPeriodKey: current, payrollOption: null });
    const mine = await app.fetch(new Request("https://test.local/api/hr/me/expenses", { headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.employee! } }), env() as never);
    expect((await mine.json() as { expenses: Array<{ status: string; payrollPeriodKey: string | null }> }).expenses[0]).toMatchObject({ status: "approved", payrollPeriodKey: current });
    expect(d1.sqlite.prepare("SELECT body FROM hr_notifications WHERE entity_id = ?").get(id)).toMatchObject({ body: expect.stringContaining("的薪資一起發") });

    const adjustmentId = String(linked.payroll_adjustment_id);
    const [hris] = await listHrPayrollAdjustments(db(), current);
    expect(hris).toMatchObject({ fromExpense: true, canEdit: false });
    const actor = { id: "accountant", email: "accountant@example.test" };
    await expect(updateHrPayrollAdjustment(db(), adjustmentId, { employmentId: "employment-employee", effectivePeriodKey: current, reason: "改金額", items: [{ itemName: "代墊款", amountMinor: 99900 }], revision: 1 }, actor)).rejects.toThrow("來自報帳");
    await expect(deleteHrPayrollAdjustment(db(), adjustmentId, 1, actor)).rejects.toThrow("來自報帳");
    expect(adjustments()).toHaveLength(1);
    expect(d1.sqlite.prepare("SELECT event_type, source, actor_id FROM activity_events WHERE entity_type = 'hr_personnel' AND entity_id = ?").all(adjustmentId))
      .toEqual([{ event_type: "payroll_adjustment_created", source: "accounting", actor_id: "accountant" }]);
  });

  it("這個月結帳了就掛下個月；會計看到的月份過期時不偷偷改月，兩邊都不寫", async () => {
    const { current, next } = months();
    const id = await submit("employee");
    await closePeriod(current);
    expect((await list("accountant"))[0]).toMatchObject({ payrollOption: next });
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current })).status).toBe(409);
    expect(row(id)).toMatchObject({ status: "pending", payroll_adjustment_id: null });
    expect(adjustments()).toEqual([]);
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM activity_events WHERE entity_type = 'hr_personnel'").get()).toEqual({ n: 0 });
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: next })).status).toBe(200);
    expect(adjustments()).toMatchObject([{ effective_period_key: next }]);
  });

  it("任職資料封存的人只能直接撥款", async () => {
    const { current } = months();
    const id = await submit("employee");
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at = '2026-01-01 00:00:00' WHERE id = 'employment-employee'").run();
    expect((await list("accountant"))[0]).toMatchObject({ payrollOption: null });
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current })).status).toBe(409);
    expect(adjustments()).toEqual([]);
    expect((await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "direct" })).status).toBe(200);
  });

  it("不能把自己的報帳併入月薪", async () => {
    const { current } = months();
    const own = await submit("accountant");
    expect((await api(`/accounting/expenses/${own}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current })).status).toBe(403);
    expect(adjustments()).toEqual([]);
  });

  it("結帳前退回會一起拿掉加扣項；結帳後算已付款、不能退回", async () => {
    const { current } = months();
    const first = await submit("employee");
    await api(`/accounting/expenses/${first}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current });
    expect((await api(`/accounting/expenses/${first}/reject`, "accountant", "POST", { revision: 2, note: "金額打錯，請重送" })).status).toBe(200);
    expect(row(first)).toMatchObject({ status: "rejected", payroll_adjustment_id: null, review_note: "金額打錯，請重送", revision: 3 });
    expect(adjustments()).toEqual([]);
    expect(d1.sqlite.prepare("SELECT event_type FROM activity_events WHERE entity_type = 'hr_personnel' ORDER BY rowid").all())
      .toEqual([{ event_type: "payroll_adjustment_created" }, { event_type: "payroll_adjustment_deleted" }]);

    const second = await submit("employee");
    await api(`/accounting/expenses/${second}/approve`, "accountant", "POST", { revision: 1, payoutMethod: "payroll", payrollPeriodKey: current });
    await closePeriod(current);
    expect((await list("accountant", "paid")).map((expense) => expense.id)).toEqual([second]);
    expect(await list("accountant", "approved")).toEqual([]);
    const reject = await api(`/accounting/expenses/${second}/reject`, "accountant", "POST", { revision: 2, note: "退回" });
    expect(reject.status).toBe(409);
    expect((await reject.json() as { error: string }).error).toContain("結帳");
    expect(row(second)).toMatchObject({ status: "approved" });
    expect(adjustments()).toHaveLength(1);
    expect((await api(`/accounting/expenses/${second}/paid`, "accountant", "POST", { revision: 2 })).status).toBe(409);
  });

  it("直接撥款核准後、還沒撥款前也能退回", async () => {
    const id = await submit("employee");
    await api(`/accounting/expenses/${id}/approve`, "accountant", "POST", { revision: 1 });
    expect((await api(`/accounting/expenses/${id}/reject`, "accountant", "POST", { revision: 2, note: "核准錯了" })).status).toBe(200);
    expect(row(id)).toMatchObject({ status: "rejected", revision: 3 });
  });
});

describe("報公帳：支出類別", () => {
  it("新增、改名排序、停用；同名擋下；停用的員工選不到但歷史還在", async () => {
    const created = await api("/accounting/categories", "accountant", "POST", { name: "清潔用品", sortOrder: 25 });
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    expect((await api("/accounting/categories", "accountant", "POST", { name: "清潔用品" })).status).toBe(409);
    expect((await api(`/accounting/categories/${id}`, "accountant", "PATCH", { name: "日常備品" })).status).toBe(409);
    expect((await api(`/accounting/categories/${id}`, "accountant", "PATCH", { name: "清潔耗材", sortOrder: 15 })).status).toBe(200);
    await submit("employee", { categoryId: id });
    expect((await api(`/accounting/categories/${id}`, "accountant", "PATCH", { name: "清潔耗材", sortOrder: 15, archived: true })).status).toBe(200);
    const categories = (await (await api("/accounting/categories", "accountant")).json() as { categories: Array<{ id: string; name: string; archived: boolean; expenseCount: number }> }).categories;
    expect(categories.find((category) => category.id === id)).toMatchObject({ name: "清潔耗材", archived: true, expenseCount: 1 });
    const options = await app.fetch(new Request("https://test.local/api/hr/me/expense-options", { headers: { Origin: "https://hr.rueisiang.com", Cookie: cookies.employee! } }), env() as never);
    expect((await options.json() as { categories: Array<{ id: string }> }).categories.map((category) => category.id)).not.toContain(id);
    expect((await list("accountant"))[0]).toMatchObject({ status: "pending" });
  });

  it("類別名稱要 1～50 字，找不到的類別回 404", async () => {
    expect((await api("/accounting/categories", "accountant", "POST", { name: " " })).status).toBe(400);
    expect((await api("/accounting/categories", "accountant", "POST", { name: "字".repeat(51) })).status).toBe(400);
    expect((await api("/accounting/categories/missing", "accountant", "PATCH", { name: "雜支" })).status).toBe(404);
  });
});
