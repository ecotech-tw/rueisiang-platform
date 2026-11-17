import { SESSION_COOKIE, newSessionClaims, signSession } from "@rueisiang/auth";
import { createDatabase, parseHrRfidPacket, syncSystemRoles } from "@rueisiang/db";
import { hrAttendanceLocations, hrClockEvents, userRoleAssignments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

const SESSION_SECRET = "hr-rfid-test-session-secret-0123456789";
const GATEWAY_TOKEN = "hr-rfid-gateway-test-token-0123456789";
let d1: LocalD1;
let cookies: Record<string, string>;
let firstEmploymentId: string;
let secondEmploymentId: string;
const db = () => createDatabase(d1 as never);
const env = () => ({ DB: d1, AUTH_SESSION_SECRET: SESSION_SECRET, RFID_GATEWAY_TOKEN: GATEWAY_TOKEN, GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });

async function request(path: string, method = "GET", payload?: Record<string, unknown>, actor = "admin", token = GATEWAY_TOKEN) {
  const internal = path.startsWith("/internal/");
  return app.fetch(new Request(`https://test.local/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookies[actor] ? { Cookie: cookies[actor] } : {}),
      ...(internal && token ? { "X-RFID-Gateway-Token": token } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }), env() as never);
}

async function enroll(employmentId: string) {
  const response = await request(`/hr/employments/${employmentId}/rfid-enrollments`, "POST", {});
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json() as { sessionId: string; expiresAt: string };
}
async function scan(rawPacket: string, token = GATEWAY_TOKEN, scanId = crypto.randomUUID()) {
  return request("/internal/rfid/scans", "POST", { deviceId: "office-entrance", scanId, attendanceLocationName: "瑞香雲林總部", rawPacket }, "gateway", token);
}
async function scanLegacy(rawPacket: string) {
  return request("/internal/rfid/scans", "POST", { deviceId: "office-entrance", rawPacket }, "gateway");
}
async function assignReaderLocation(employmentId: string) {
  const profile = await (await request(`/hr/employees/${employmentId}`)).json() as { employments: Array<{ revision: number }> };
  return request(`/hr/employments/${employmentId}/attendance-scope`, "PATCH", {
    attendanceMode: "scheduled", monthlyRestDays: 0, revision: profile.employments[0]!.revision,
    locationIds: ["rfid-location"], assignmentsToEnd: [],
  });
}

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  cookies = {};
  for (const id of ["admin", "reader", "employee-a", "employee-b"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SESSION_SECRET))}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  const assign = async (userId: string, employeeNumber: string) => {
    const response = await request("/hr/employees", "POST", { userId, legalName: `正式${userId}`, employeeNumber, position: "一般職員" });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json() as { employmentId: string }).employmentId;
  };
  firstEmploymentId = await assign("employee-a", "E001");
  secondEmploymentId = await assign("employee-b", "E002");
  await db.insert(hrAttendanceLocations).values({ id: "rfid-location", name: "瑞香雲林總部", latitudeE7: 250000000, longitudeE7: 1215000000, radiusMeters: 80, geolocationRequired: 1 });
});

afterEach(() => d1.sqlite.close());

describe("HR RFID 卡片綁定", () => {
  it("依實際封包格式辨識卡片碼，保留大小寫正規化與嚴格框架", () => {
    expect(parseHrRfidPacket("0002 15A9AC63\r\n")).toEqual({ protocolCode: "0002", cardCode: "15A9AC63" });
    expect(parseHrRfidPacket("0002 f1b7e886\n")).toEqual({ protocolCode: "0002", cardCode: "F1B7E886" });
    expect(parseHrRfidPacket("0003 15A9AC63\r\n")).toBeNull();
    expect(parseHrRfidPacket("0002 15A9AC6\r\n")).toBeNull();
    expect(parseHrRfidPacket("0002 15A9AC63\r\n0002 F1B7E886\r\n")).toBeNull();
  });

  it("同一時間只允許一個員工進入讀卡狀態", async () => {
    const first = await enroll(firstEmploymentId);
    const blocked = await request(`/hr/employments/${secondEmploymentId}/rfid-enrollments`, "POST", {});
    expect(blocked.status).toBe(409);
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${first.sessionId}/cancel`, "POST", {})).status).toBe(200);
    expect((await enroll(secondEmploymentId)).sessionId).toBeTruthy();
  });

  it("管理員開始感應，Gateway 只把一筆掃描交給一個確認流程", async () => {
    const enrollment = await enroll(firstEmploymentId);
    const captured = await scanLegacy("0002 15A9AC63\r\n");
    expect(captured.status).toBe(200);
    expect(await captured.json()).toMatchObject({ captured: true, sessionId: enrollment.sessionId });
    const poll = await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${enrollment.sessionId}`);
    expect(await poll.json()).toMatchObject({ enrollment: { status: "captured", candidateCardCode: "15A9AC63", candidateProtocolCode: "0002", deviceId: "office-entrance" } });
    expect(await (await scanLegacy("0002 F1B7E886\r\n")).json()).toMatchObject({ captured: false, sessionId: enrollment.sessionId, clocked: false });
  });

  it("確認綁定、替換與解除保留綁定歷史", async () => {
    const initial = await enroll(firstEmploymentId);
    await scan("0002 15A9AC63\r\n");
    const bound = await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${initial.sessionId}/confirm`, "POST", {});
    expect(bound.status).toBe(200);
    expect(await bound.json()).toMatchObject({ idempotent: false, card: { cardCode: "15A9AC63", protocolCode: "0002" } });
    const duplicateConfirm = await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${initial.sessionId}/confirm`, "POST", {});
    expect(await duplicateConfirm.json()).toMatchObject({ idempotent: true, card: { cardCode: "15A9AC63" } });

    const replacement = await enroll(firstEmploymentId);
    await scan("0002 F1B7E886\r\n");
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${replacement.sessionId}/confirm`, "POST", {})).status).toBe(200);
    expect(d1.sqlite.prepare("SELECT card_code, revoked_at FROM hr_employee_rfid_cards ORDER BY linked_at, rowid").all()).toHaveLength(2);
    expect((await (await request(`/hr/employments/${firstEmploymentId}/rfid-card`)).json() as { card: { cardCode: string } | null }).card).toMatchObject({ cardCode: "F1B7E886" });
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-card`, "DELETE")).status).toBe(200);
    expect((await (await request(`/hr/employments/${firstEmploymentId}/rfid-card`)).json() as { card: { cardCode: string } | null }).card).toBeNull();
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_employee_rfid_cards WHERE revoked_at IS NOT NULL").get()).toEqual({ count: 2 });
  });

  it("避免同一張卡同時綁到不同員工，衝突時原綁定不受影響", async () => {
    const first = await enroll(firstEmploymentId);
    await scan("0002 15A9AC63\r\n");
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${first.sessionId}/confirm`, "POST", {})).status).toBe(200);

    const second = await enroll(secondEmploymentId);
    await scan("0002 15A9AC63\r\n");
    const conflict = await request(`/hr/employments/${secondEmploymentId}/rfid-enrollments/${second.sessionId}/confirm`, "POST", {});
    expect(conflict.status).toBe(409);
    expect((await (await request(`/hr/employments/${firstEmploymentId}/rfid-card`)).json() as { card: { cardCode: string } | null }).card).toMatchObject({ cardCode: "15A9AC63" });
    expect((await (await request(`/hr/employments/${secondEmploymentId}/rfid-card`)).json() as { card: { cardCode: string } | null }).card).toBeNull();
  });

  it("已綁定卡只替在職且已指派 Reader 據點的員工打卡，沿用上下班切換與重試冪等", async () => {
    const enrollment = await enroll(firstEmploymentId);
    await scan("0002 15A9AC63\r\n");
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${enrollment.sessionId}/confirm`, "POST", {})).status).toBe(200);

    expect((await scan("0002 F1B7E886\r\n")).status).toBe(202);
    expect((await db().select().from(hrClockEvents))).toHaveLength(0);
    expect((await scan("0002 15A9AC63\r\n")).status).toBe(400);
    expect((await db().select().from(hrClockEvents))).toHaveLength(0);
    expect((await assignReaderLocation(firstEmploymentId)).status).toBe(200);

    const scanId = crypto.randomUUID();
    const clockIn = await scan("0002 15A9AC63\r\n", GATEWAY_TOKEN, scanId);
    expect(clockIn.status, await clockIn.clone().text()).toBe(201);
    expect(await clockIn.json()).toMatchObject({ clocked: true, idempotent: false, event: { eventKind: "clock_in", locationName: "瑞香雲林總部" } });
    const retry = await scan("0002 15A9AC63\r\n", GATEWAY_TOKEN, scanId);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ clocked: true, idempotent: true, event: { eventKind: "clock_in" } });

    const clockOut = await scan("0002 15A9AC63\r\n");
    expect(await clockOut.json()).toMatchObject({ clocked: true, event: { eventKind: "clock_out" } });
    const events = await db().select().from(hrClockEvents);
    expect(events).toHaveLength(2);
    expect(events.map((event) => [event.sourceKind, event.latitudeE7, event.longitudeE7, event.attendanceLocationId, event.recordedBy])).toEqual([
      ["rfid", null, null, "rfid-location", "employee-a"], ["rfid", null, null, "rfid-location", "employee-a"],
    ]);
    d1.sqlite.prepare("UPDATE hr_employments SET archived_at=CURRENT_TIMESTAMP WHERE id=?").run(firstEmploymentId);
    expect((await scan("0002 15A9AC63\r\n")).status).toBe(202);
    expect(await db().select().from(hrClockEvents)).toHaveLength(2);
  });

  it("未授權 Gateway、沒有綁卡權限與格式錯誤都不能建立綁定", async () => {
    const noToken = await scan("0002 15A9AC63\r\n", "wrong-token");
    expect(noToken.status).toBe(401);
    expect((await request("/internal/rfid/scans", "POST", { deviceId: "office-entrance", scanId: crypto.randomUUID(), attendanceLocationName: "瑞香雲林總部", rawPacket: "0002 15A9AC63\r\n" }, "gateway", "")).status).toBe(401);

    const enrollment = await enroll(firstEmploymentId);
    expect((await scan("0003 15A9AC63\r\n")).status).toBe(400);
    expect((await (await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments/${enrollment.sessionId}`)).json() as { enrollment: { status: string } }).enrollment.status).toBe("listening");
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-enrollments`, "POST", {}, "reader")).status).toBe(403);
    expect((await request(`/hr/employments/${firstEmploymentId}/rfid-card`, "GET", undefined, "reader")).status).toBe(403);
  });
});
