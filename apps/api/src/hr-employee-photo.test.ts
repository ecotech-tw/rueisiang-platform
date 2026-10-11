import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEVICE_SESSION_COOKIE, SESSION_COOKIE, newSessionClaims, serializeDeviceToken, signSession } from "@rueisiang/auth";
import { createDatabase, createDeviceSession, syncSystemRoles } from "@rueisiang/db";
import { userPermissionGrants, userRoleAssignments, users } from "@rueisiang/db/schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";
import { createLocalR2 } from "./local-d1/r2.js";

const SECRET = "photo-test-secret-photo-test-secret";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4AWJSdk3/D8JMDFAAAAAA///PlZhwAAAABklEQVQDAC5MA6EF8wd6AAAAAElFTkSuQmCC", "base64");
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQAaEP/2Q==", "base64");
const webp = Buffer.from("UklGRhYCAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggKAAAAJABAJ0BKgIAAgABQCYliAJ0ugADmAD+9uYH2psVU87v0KNlEvmAAAA=", "base64");
let d1: LocalD1;
let uploads: ReturnType<typeof createLocalR2>;
let directory: string;
let cookies: Record<string, string>;
let employmentId: string;
const env = () => ({ DB: d1, UPLOADS: uploads, AUTH_SESSION_SECRET: SECRET, AUTH_APP_ORIGINS: "https://hr.rueisiang.com", GOOGLE_OAUTH_CLIENT_ID: "test", GOOGLE_OAUTH_CLIENT_SECRET: "test" });
const currentRevision = () => Number((d1.sqlite.prepare("SELECT revision FROM hr_employments WHERE id=?").get(employmentId) as { revision: number }).revision);
const photoRow = () => d1.sqlite.prepare("SELECT id, object_key FROM hr_employee_photos WHERE employment_id=?").get(employmentId) as { id: string; object_key: string } | undefined;
async function request(route: string, method = "GET", body?: BodyInit, actor = "admin", environment = env()) {
  return app.fetch(new Request(`https://test.local/api/hr${route}`, { method, headers: { ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) }, ...(body === undefined ? {} : { body }) }), environment as never);
}
async function requestSelf(route: string, method = "GET", body?: BodyInit, actor = "employee") {
  const identity = actor === "device" ? "employee-device" : actor;
  return app.fetch(new Request(`https://test.local/api/hr/me${route}`, { method, headers: { Origin: "https://hr.rueisiang.com", ...(cookies[identity] ? { Cookie: cookies[identity] } : {}), ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) }, ...(body === undefined ? {} : { body }) }), env() as never);
}
async function uploadSelf(expectedRevision = currentRevision(), content: Uint8Array = png, type = "image/png", actor = "employee") {
  const body = new FormData(); body.set("file", new Blob([Uint8Array.from(content).buffer], { type }), "portrait.png"); body.set("revision", String(expectedRevision));
  return requestSelf("/photo", "POST", body, actor);
}
async function upload(expectedRevision = currentRevision(), content: Uint8Array = png, type = "image/png", actor = "admin") {
  const body = new FormData(); body.set("file", new Blob([Uint8Array.from(content).buffer], { type }), "portrait.png"); body.set("revision", String(expectedRevision));
  return request(`/employees/${employmentId}/photo`, "POST", body, actor);
}
async function remove(expectedRevision = currentRevision(), actor = "admin") { return request(`/employees/${employmentId}/photo`, "DELETE", JSON.stringify({ revision: expectedRevision }), actor); }

beforeEach(async () => {
  d1 = createTargetOnlyD1();
  directory = mkdtempSync(path.join(tmpdir(), "hr-employee-photo-")); uploads = createLocalR2(directory);
  const db = createDatabase(d1 as never); await syncSystemRoles(db); cookies = {};
  for (const id of ["admin", "employee", "staff", "other"]) {
    await db.insert(users).values({ id, email: `${id}@example.test`, displayName: id, status: "active" });
    cookies[id] = `${SESSION_COOKIE}=${encodeURIComponent(await signSession(newSessionClaims({ id, email: `${id}@example.test`, name: id, pictureUrl: "" }), SECRET))}`;
  }
  await db.insert(userRoleAssignments).values({ userId: "admin", roleId: "role-admin" });
  await db.insert(userPermissionGrants).values([{ userId: "employee", permission: "hr:employee:read" }, { userId: "staff", permission: "hr:employee:read" }, { userId: "staff", permission: "hr:employee:write" }]);
  const response = await request("/employees", "POST", JSON.stringify({ userId: "employee", legalName: "測試員工", employeeNumber: "E001", position: "一般職員" }));
  expect(response.status).toBe(201); employmentId = (await response.json() as { employmentId: string }).employmentId;
  const device = await createDeviceSession(createDatabase(d1 as never), "employee", "test device");
  cookies["employee-device"] = `${DEVICE_SESSION_COOKIE}=${encodeURIComponent(serializeDeviceToken(device))}`;
});
afterEach(() => { vi.restoreAllMocks(); d1.sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

describe("員工私有大頭貼", () => {
  it("上傳、替換與移除沿用任職 revision，照片不暴露儲存 key", async () => {
    const before = currentRevision(); expect((await upload()).status).toBe(201);
    const first = photoRow()!; expect(currentRevision()).toBe(before + 1);
    const read = await request(`/employees/employee/photo`);
    expect(read.status).toBe(200); expect(read.headers.get("Cache-Control")).toBe("private, no-store"); expect(read.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(png);
    const detail = await (await request(`/employees/${employmentId}`)).text(); expect(detail).toContain(first.id); expect(detail).not.toContain(first.object_key);
    expect((await upload()).status).toBe(201); const second = photoRow()!; expect(second.id).not.toBe(first.id); expect(await uploads.head(first.object_key)).toBeNull(); expect(await uploads.head(second.object_key)).not.toBeNull();
    expect((await remove()).status).toBe(200); expect(photoRow()).toBeUndefined(); expect(await uploads.head(second.object_key)).toBeNull(); expect(currentRevision()).toBe(before + 3);
    expect((await request(`/employees/${employmentId}/photo`)).status).toBe(404);
    expect(d1.sqlite.prepare("SELECT event_type FROM activity_events WHERE event_type LIKE 'employee_photo_%'").all()).toHaveLength(3);
  });
  it.each([[png, "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]] as const)("完整解碼接受有效照片：%s", async (bytes, type) => {
    expect((await upload(currentRevision(), bytes, type)).status).toBe(201);
    expect((await request(`/employees/${employmentId}/photo`)).headers.get("Content-Type")).toBe(type);
  });

  it.each([
    [png.subarray(0, 8), "image/png"], [png.subarray(0, png.length - 12), "image/png"],
    [Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFh0AAAAASUVORK5CYII=", "base64"), "image/png"],
    [jpeg.subarray(0, 3), "image/jpeg"], [jpeg.subarray(0, jpeg.length - 2), "image/jpeg"],
    [webp.subarray(0, 12), "image/webp"], [webp.subarray(0, webp.length - 4), "image/webp"],
  ] as const)("拒絕只含檔頭／截斷／checksum 錯誤的圖片，保留照片與 revision：%s", async (bytes, type) => {
    expect((await upload()).status).toBe(201); const before = photoRow()!; const revision = currentRevision();
    const put = vi.spyOn(uploads, "put");
    expect((await upload(revision, bytes, type)).status).toBe(400);
    expect(put).not.toHaveBeenCalled(); expect(photoRow()).toEqual(before); expect(currentRevision()).toBe(revision); expect(await uploads.head(before.object_key)).not.toBeNull();
  });

  it.each([[4096, 4096], [9000, 1]])("拒絕宣告超出解碼尺寸限制的照片：%s×%s", async (width, height) => {
    expect((await upload()).status).toBe(201); const before = photoRow(); const revision = currentRevision();
    const oversized = Buffer.from(png); oversized.writeUInt32BE(width, 16); oversized.writeUInt32BE(height, 20);
    let crc = 0xffffffff;
    for (const value of oversized.subarray(12, 29)) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    oversized.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    const response = await upload(revision, oversized); expect(response.status).toBe(400); expect(await response.text()).toContain("解碼限制"); expect(photoRow()).toEqual(before); expect(currentRevision()).toBe(revision);
  });

  it("APP1 內容出現 MPF-like bytes 不誤判成 MPO", async () => {
    const app1 = Buffer.from([0xff, 0xe1, 0, 10, 0xff, 0xe2, 0, 6, 0x4d, 0x50, 0x46, 0]);
    const ordinary = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
    expect((await upload(currentRevision(), ordinary, "image/jpeg")).status).toBe(201);
  });

  it.each([2, 1001])("拒絕包含 %s 張有效 JPEG 的 MPO，不改照片、revision 或 R2", async (count) => {
    // MPF index 與逐張 MPEntry；涵蓋 library metadata 忽略 NumberOfImages > 1000 的情境。
    const app2 = Buffer.alloc(58 + 16 * count); app2[0] = 0xff; app2[1] = 0xe2; app2.writeUInt16BE(app2.length - 2, 2); app2.write("MPF\0", 4); app2.write("MM", 8); app2.writeUInt16BE(42, 10); app2.writeUInt32BE(8, 12); app2.writeUInt16BE(3, 16);
    app2.writeUInt16BE(0xb000, 18); app2.writeUInt16BE(7, 20); app2.writeUInt32BE(4, 22); app2.write("0100", 26);
    app2.writeUInt16BE(0xb001, 30); app2.writeUInt16BE(4, 32); app2.writeUInt32BE(1, 34); app2.writeUInt32BE(count, 38);
    app2.writeUInt16BE(0xb002, 42); app2.writeUInt16BE(7, 44); app2.writeUInt32BE(16 * count, 46); app2.writeUInt32BE(50, 50);
    const primarySize = jpeg.length + app2.length;
    for (let index = 0; index < count; index++) {
      const offset = 58 + index * 16;
      app2.writeUInt32BE(index === 0 ? 0x20000000 : 0, offset); app2.writeUInt32BE(index === 0 ? primarySize : jpeg.length, offset + 4); app2.writeUInt32BE(index === 0 ? 0 : primarySize + (index - 1) * jpeg.length - 10, offset + 8);
    }
    const mpo = Buffer.concat([jpeg.subarray(0, 2), app2, jpeg.subarray(2), ...Array.from({ length: count - 1 }, () => jpeg)]);
    expect((await upload()).status).toBe(201); const before = photoRow(); const revision = currentRevision(); const put = vi.spyOn(uploads, "put");
    expect((await upload(revision, mpo, "image/jpeg")).status).toBe(400); expect(put).not.toHaveBeenCalled(); expect(photoRow()).toEqual(before); expect(currentRevision()).toBe(revision); expect(await uploads.head(before!.object_key)).not.toBeNull();
  });

  it("移除已提交但 D1 回應遺失時核對參照後清理舊檔並回報成功", async () => {
    expect((await upload()).status).toBe(201); const previous = photoRow()!; const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => { await batch(statements); throw new Error("D1 response lost after remove commit"); });
    const reconciled = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await requestSelf("/photo", "DELETE", JSON.stringify({ revision: currentRevision() }))).status).toBe(200);
    expect(photoRow()).toBeUndefined(); expect(await uploads.head(previous.object_key)).toBeNull(); expect(reconciled).toHaveBeenCalledWith(expect.stringContaining("hr.employee_photo_write_reconciled"));
  });

  it("本人端共用照片、revision 與私有讀取，只能操作 session 對應的在職員工", async () => {
    expect((await requestSelf("/photo")).status).toBe(404);
    expect((await uploadSelf(currentRevision(), png, "image/png", "other")).status).toBe(403);
    expect((await uploadSelf()).status).toBe(201);
    const current = photoRow()!; const version = currentRevision();
    const profile = await (await requestSelf("")).text();
    expect(profile).toContain(`"photo":{"id":"${current.id}"}`); expect(profile).not.toContain(current.object_key); expect(profile).not.toContain("personalData");
    const selfPhoto = await requestSelf("/photo"); expect(selfPhoto.status).toBe(200); expect(selfPhoto.headers.get("Cache-Control")).toBe("private, no-store"); expect(selfPhoto.headers.get("Access-Control-Allow-Origin")).toBe("https://hr.rueisiang.com"); expect(selfPhoto.headers.get("Access-Control-Allow-Credentials")).toBe("true"); expect(Buffer.from(await selfPhoto.arrayBuffer())).toEqual(png);
    expect((await uploadSelf(version - 1)).status).toBe(409); expect(photoRow()).toEqual(current);
    expect((await requestSelf("/photo", "DELETE", JSON.stringify({ revision: version }), "device")).status).toBe(200);
    expect(photoRow()).toBeUndefined(); expect(currentRevision()).toBe(version + 1);
    expect((await requestSelf("/photo", "GET", undefined, "device")).status).toBe(404);
    expect((await requestSelf("/photo", "POST", new FormData(), "staff")).status).toBe(403);
    expect((await request(`/employments/${employmentId}/archive`, "POST", JSON.stringify({ revision: currentRevision() }))).status).toBe(200);
    expect((await requestSelf("/photo")).status).toBe(403);
  });

  it("已提交但回應遺失時確認參照並回報成功，不刪除目前照片", async () => {
    expect((await upload()).status).toBe(201); const before = photoRow()!; const revision = currentRevision();
    const batch = d1.batch.bind(d1); const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => { await batch(statements); throw new Error("D1 response lost after commit"); });
    expect((await upload()).status).toBe(201); const current = photoRow()!;
    expect(current.id).not.toBe(before.id); expect(currentRevision()).toBe(revision + 1); expect(await uploads.head(current.object_key)).not.toBeNull(); expect(await uploads.head(before.object_key)).toBeNull(); expect((await request(`/employees/${employmentId}/photo`)).status).toBe(200); expect(log).toHaveBeenCalled();
  });

  it("提交與確認讀取均失敗時保留新檔，不誤刪已提交照片", async () => {
    expect((await upload()).status).toBe(201); const before = photoRow()!; const batch = d1.batch.bind(d1);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => { await batch(statements); vi.spyOn(d1, "prepare").mockImplementationOnce(() => { throw new Error("D1 read unavailable"); }); throw new Error("D1 response lost"); });
    expect((await upload()).status).toBe(500); const current = photoRow()!;
    expect(current.id).not.toBe(before.id); expect(await uploads.head(current.object_key)).not.toBeNull(); expect(await uploads.head(before.object_key)).not.toBeNull(); expect((await request(`/employees/${employmentId}/photo`)).status).toBe(200); expect(log).toHaveBeenCalled();
  });

  it("未知錯誤但尚未提交時即使讀到舊參照仍保留新檔，稍後提交不會破圖", async () => {
    expect((await upload()).status).toBe(201); const before = photoRow()!; const revision = currentRevision(); const batch = d1.batch.bind(d1);
    const put = vi.spyOn(uploads, "put"); let deferred: Parameters<typeof d1.batch>[0] | undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(d1, "batch").mockImplementationOnce(async (statements) => { deferred = statements; throw new Error("D1 outcome unknown"); });
    expect((await upload()).status).toBe(500); expect(photoRow()).toEqual(before); expect(currentRevision()).toBe(revision); expect(await uploads.head(put.mock.calls[0]![0])).not.toBeNull();
    await batch(deferred!); expect(photoRow()?.id).not.toBe(before.id); expect((await request(`/employees/${employmentId}/photo`)).status).toBe(200);
  });

  it("未登入、一般員工與僅有員工寫入權限者不能使用管理入口；列表不含照片、本人僅含版本", async () => {
    expect((await upload()).status).toBe(201);
    for (const actor of ["employee", "staff", "missing"]) {
      const status = actor === "missing" ? 401 : 403;
      expect((await request(`/employees/${employmentId}/photo`, "GET", undefined, actor)).status).toBe(status);
      expect((await upload(currentRevision(), png, "image/png", actor)).status).toBe(status);
      expect((await remove(currentRevision(), actor)).status).toBe(status);
    }
    expect(await (await request(`/employees/${employmentId}`, "GET", undefined, "employee")).text()).not.toContain('"photo"');
    expect(await (await request("/employees?personKind=all")).text()).not.toContain('"photo"');
    const self = await (await request("/me", "GET", undefined, "employee")).text();
    expect(self).toContain(`"photo":{"id":"${photoRow()!.id}"}`); expect(self).not.toContain(photoRow()!.object_key); expect(self).not.toContain("personalData");
  });
  it("驗證檔案格式、大小、空檔與 revision，不改寫既有照片", async () => {
    expect((await upload()).status).toBe(201); const first = photoRow(); const revision = currentRevision();
    for (const [content, type] of [[Buffer.from("<svg onload=alert(1) />"), "image/svg+xml"], [Buffer.from("<html>fake</html>"), "image/png"], [png, "image/jpeg"], [new Uint8Array(), "image/png"]] as const) expect((await upload(revision, content, type)).status).toBe(400);
    expect((await upload(revision, new Uint8Array(5 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await upload(revision, new Uint8Array(6 * 1024 * 1024))).status).toBe(413);
    expect((await upload(0)).status).toBe(400); expect((await upload(revision - 1)).status).toBe(409); expect((await remove(revision - 1)).status).toBe(409);
    expect(photoRow()).toEqual(first); expect(currentRevision()).toBe(revision);
  });
  it("R2 寫入失敗不切換參照；同時更新造成的 revision 衝突只回滾新檔", async () => {
    expect((await upload()).status).toBe(201); const first = photoRow()!; const revision = currentRevision();
    vi.spyOn(uploads, "put").mockRejectedValueOnce(new Error("R2 unavailable")); expect((await upload()).status).toBe(500); expect(photoRow()).toEqual(first); expect(currentRevision()).toBe(revision);
    const put = vi.spyOn(uploads, "put"); put.mockClear(); const batch = d1.batch.bind(d1);
    vi.spyOn(d1, "batch").mockImplementationOnce((statements) => { d1.sqlite.prepare("UPDATE hr_employments SET revision=revision+1 WHERE id=?").run(employmentId); return batch(statements); });
    expect((await upload()).status).toBe(409); expect(photoRow()).toEqual(first); expect(put).toHaveBeenCalledOnce(); expect(await uploads.head(put.mock.calls[0]![0])).toBeNull(); expect(await uploads.head(first.object_key)).not.toBeNull();
    expect(d1.sqlite.prepare("SELECT count(*) AS n FROM hr_mutation_guards").get()).toEqual({ n: 0 });
  });
  it("封存保留照片、禁止更新；復職沿用同一張照片", async () => {
    expect((await upload()).status).toBe(201); const first = photoRow();
    expect((await request(`/employments/${employmentId}/archive`, "POST", JSON.stringify({ revision: currentRevision() }))).status).toBe(200);
    expect((await request(`/employees/${employmentId}/photo`)).status).toBe(200); expect((await upload()).status).toBe(409); expect((await remove()).status).toBe(409);
    expect((await request("/employees", "POST", JSON.stringify({ userId: "employee", legalName: "測試員工", employeeNumber: "E001", position: "一般職員", revision: currentRevision() }))).status).toBe(201); expect(photoRow()).toEqual(first);
  });
  it("照片儲存未設定時顯示 503；舊檔刪除失敗不回復已移除的資料庫參照", async () => {
    expect((await request(`/employees/${employmentId}/photo`, "DELETE", JSON.stringify({ revision: currentRevision() }), "admin", { ...env(), UPLOADS: undefined } as never)).status).toBe(503);
    expect((await upload()).status).toBe(201); vi.spyOn(uploads, "delete").mockRejectedValueOnce(new Error("cleanup failed")); const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await remove()).status).toBe(200); expect(photoRow()).toBeUndefined(); expect(log).toHaveBeenCalled(); expect((await request(`/employees/${employmentId}/photo`)).status).toBe(404);
  });
});
