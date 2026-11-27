import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, submitLineExpense, syncSystemRoles } from "@rueisiang/db";
import { assistantLineMessages, authLineAccountLinks, hrEmployments, userPermissionGrants, users } from "@rueisiang/db/schema";
import { PLATFORM_TOOL_MAP, LINE_EXPENSE_TOOL_KEY } from "@rueisiang/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineExpenseSubmitter } from "./assistant-line-expense.js";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import type { PiLineAgentRunRequest } from "./pi-agent-contract.js";

const SECRET = "line-expense-test-secret-line-expense-test";
let d1: LocalD1;
let cookies: Record<string, string>;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test", LINE_LIFF_CHANNEL_ID: "login-channel", LINE_CHANNEL_ACCESS_TOKEN: "bot-token" });

async function api(route: string, actor: string, method = "GET", values?: Record<string, unknown>) {
  return app.fetch(new Request(`https://test.local/api${route}`, {
    method,
    headers: { ...(values ? { "Content-Type": "application/json" } : {}), Cookie: cookies[actor]!, Origin: "https://hr.rueisiang.com" },
    ...(values ? { body: JSON.stringify(values) } : {}),
  }), env() as never);
}
const row = (id: string) => d1.sqlite.prepare("SELECT * FROM accounting_expenses WHERE id = ?").get(id) as Record<string, unknown>;
const notifications = () => (d1.sqlite.prepare("SELECT count(*) AS n FROM hr_notifications").get() as { n: number }).n;

function submit(overrides: Partial<Parameters<typeof submitLineExpense>[1]> = {}) {
  return submitLineExpense(db(), {
    clientRequestId: `line-${crypto.randomUUID()}`,
    lineUserId: "U-guest",
    lineDisplayName: "小美",
    boundUserId: null,
    spentOn: null,
    amountDollars: 120,
    description: "買封箱膠帶",
    ...overrides,
  });
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  await syncSystemRoles(db());
  cookies = {};
  for (const id of ["employee", "accountant", "manager"]) {
    await db().insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db().insert(hrEmployments).values([{ id: "employment-employee", employeeUserId: "employee", employeeNumber: "E001", legalName: "王小明" }]);
  await db().insert(userPermissionGrants).values((["accounting:expense:read", "accounting:expense:review", "accounting:petty-cash:write"] as const).map((permission) => ({ userId: "accountant", permission })));
});
afterEach(() => { d1.sqlite.close(); vi.unstubAllGlobals(); });

describe("LINE 報帳：送件", () => {
  it("有綁定的在職員工：是他本人的單，類別放「其他」、不用照片，HR 的我的報帳看得到；同一筆重送只有一張", async () => {
    const clientRequestId = "line-event0001-abc";
    const first = await submit({ clientRequestId, boundUserId: "employee", lineUserId: "U-employee" });
    expect(first).toMatchObject({ duplicate: false, bound: true, submitterName: "王小明", amountMinor: 12000, categoryName: "其他" });
    expect(row(first.id)).toMatchObject({ source: "line", submitter_user_id: "employee", employment_id: "employment-employee", line_user_id: "U-employee", status: "pending", category_id: "expense-category-other" });
    expect(await submit({ clientRequestId, boundUserId: "employee", lineUserId: "U-employee" })).toMatchObject({ id: first.id, duplicate: true });
    const mine = await (await api("/hr/me/expenses", "employee")).json() as { expenses: Array<{ id: string }> };
    expect(mine.expenses.map((expense) => expense.id)).toEqual([first.id]);
  });

  it("沒綁定：照樣收件，申請人是 LINE 名稱；會計看得到、只能直接撥款；核准後沒有人可以通知也不會失敗", async () => {
    const guest = await submit();
    expect(guest).toMatchObject({ bound: false, submitterName: "小美" });
    expect(row(guest.id)).toMatchObject({ submitter_user_id: null, employment_id: null, line_display_name: "小美" });
    const listed = await (await api("/accounting/expenses", "accountant")).json() as { expenses: Array<{ id: string; submitterName: string; submitterUserId: string | null; source: string; payrollOption: string | null }> };
    expect(listed.expenses.find((expense) => expense.id === guest.id)).toMatchObject({ submitterName: "小美", submitterUserId: null, source: "line", payrollOption: null });

    // 會計可以修改沒照片的 LINE 單，不會被「收據要附照片」擋下。
    const edit = await api(`/accounting/expenses/${guest.id}`, "accountant", "PATCH", { categoryId: "expense-category-supplies", spentOn: row(guest.id).spent_on, amountDollars: 150, invoiceNumber: "", sellerTaxId: "", description: "買封箱膠帶", revision: 1 });
    expect(edit.status, await edit.clone().text()).toBe(200);
    expect((await api(`/accounting/expenses/${guest.id}/approve`, "accountant", "POST", { revision: 2, payoutMethod: "payroll", payrollPeriodKey: "2026-12" })).status).toBe(409);
    await api("/accounting/petty-cash", "accountant", "POST", { amountDollars: 1000, note: "" });
    const approved = await api(`/accounting/expenses/${guest.id}/approve`, "accountant", "POST", { revision: 2, payoutMethod: "direct" });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(row(guest.id)).toMatchObject({ status: "paid", payout_method: "direct" });
    expect(notifications()).toBe(0);
    const ledger = await (await api(`/accounting/ledger?month=${String(row(guest.id).spent_on).slice(0, 7)}`, "accountant")).json() as { entries: Array<{ id: string; personName: string }> };
    expect(ledger.entries.find((entry) => entry.id === guest.id)).toMatchObject({ personName: "小美" });
  });

  it("綁定了但不能報帳（不是員工）就當成沒綁定；欄位規則照常", async () => {
    expect(await submit({ boundUserId: "manager", lineDisplayName: "主管" })).toMatchObject({ bound: false, submitterName: "主管" });
    await expect(submit({ amountDollars: 0 })).rejects.toThrow("金額");
    await expect(submit({ spentOn: "2999-01-01" })).rejects.toThrow("消費日期");
    await expect(submit({ lineDisplayName: " " })).rejects.toThrow("認不出");
  });
});

describe("LINE 報帳：小香的工具", () => {
  const run = (overrides: Partial<PiLineAgentRunRequest> = {}) => ({
    assistantKey: "rueisiang", channelKey: "channel-1", groupRowId: "group-row", lineGroupId: "C-group", sourceType: "group",
    contextGeneration: "", webhookEventId: "evt-0001", runId: "run-1", model: "m", systemPrompt: "", userText: "", toolKeys: [LINE_EXPENSE_TOOL_KEY],
    ...overrides,
  }) as PiLineAgentRunRequest;

  async function seedMessage(lineUserId: string) {
    await db().insert(assistantLineMessages).values({ id: "msg-1", channelKey: "channel-1", lineGroupId: "C-group", sourceType: "group", webhookEventId: "evt-0001", lineUserId, text: "@小香 報帳 膠帶 120" });
  }

  it("申請人從觸發這一輪的訊息找：沒綁定的人用群組成員名稱；有綁定的用後台名稱", async () => {
    const fetchMock = vi.fn(async (url: string) => url.includes("/group/C-group/member/U-guest") ? Response.json({ displayName: "小美" }) : new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await seedMessage("U-guest");
    const tool = PLATFORM_TOOL_MAP.get(LINE_EXPENSE_TOOL_KEY)!;
    const guest = JSON.parse(await tool.execute({ description: "膠帶", amount: 120 }, { surface: "line", lineSourceType: "group", services: { lineExpense: new LineExpenseSubmitter(db(), env() as never, run()) } }));
    expect(guest).toMatchObject({ status: "SUBMITTED", bound: false, submitterName: "小美", amountDollars: 120 });
    expect(fetchMock.mock.calls[0]![0]).toContain("/group/C-group/member/U-guest");

    d1.sqlite.prepare("DELETE FROM assistant_line_messages").run();
    await seedMessage("U-employee");
    await db().insert(authLineAccountLinks).values({ userId: "employee", channelId: "login-channel", lineUserId: "U-employee" });
    const bound = JSON.parse(await tool.execute({ description: "文具", amount: 80 }, { surface: "line", lineSourceType: "group", services: { lineExpense: new LineExpenseSubmitter(db(), env() as never, run()) } }));
    expect(bound).toMatchObject({ status: "SUBMITTED", bound: true, submitterName: "王小明" });
  });

  it("找不到訊息或發話者就不送；模型不能自己指定申請人；不在 LINE 不能用", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const tool = PLATFORM_TOOL_MAP.get(LINE_EXPENSE_TOOL_KEY)!;
    const services = { lineExpense: new LineExpenseSubmitter(db(), env() as never, run()) };
    await expect(tool.execute({ description: "膠帶", amount: 120 }, { surface: "line", lineSourceType: "group", services })).rejects.toThrow("認不出");
    await expect(tool.execute({ description: "膠帶", amount: 120, submitter: "王小明" }, { surface: "line", lineSourceType: "group", services })).rejects.toThrow("只收日期、內容與金額");
    await expect(tool.execute({ description: "膠帶", amount: 1.5 }, { surface: "line", lineSourceType: "group", services })).rejects.toThrow("正整數");
    await expect(tool.execute({ description: "膠帶", amount: 120 }, { surface: "sandbox", services })).rejects.toThrow("LINE");
    expect(tool.defaultStatus).toBe("development");
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM accounting_expenses").get()).toEqual({ n: 0 });
  });

  it("LINE 名稱查不到時記成「LINE 使用者」，會計看得到 LINE userId 再去對", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    await seedMessage("U-guest");
    const result = await new LineExpenseSubmitter(db(), env() as never, run()).submit({ spentOn: null, amountDollars: 50, description: "影印" });
    expect(result).toMatchObject({ bound: false, submitterName: "LINE 使用者" });
    expect(row(result.id)).toMatchObject({ line_user_id: "U-guest" });
  });
});
