import { describe, expect, it } from "vitest";
import { emptyRecordsMessage, notificationTarget } from "./notification-link.js";

describe("通知導頁", () => {
  it("送出通知帶審核者去待審清單：單筆用 review，整批用 reviewBatch", () => {
    expect(notificationTarget({ kind: "request_submitted", entityKind: "leave", entityScope: "request", entityId: "leave-1" })).toBe("/forms?tab=leave&review=leave-1");
    expect(notificationTarget({ kind: "request_submitted", entityKind: "overtime", entityScope: "batch", entityId: "batch-1" })).toBe("/forms?tab=overtime&reviewBatch=batch-1");
  });

  it("審核結果通知帶申請人去自己的紀錄，只列那一筆或那一批，而且不把 ID 放進搜尋", () => {
    const single = notificationTarget({ kind: "request_reviewed", entityKind: "clock_correction", entityScope: "request", entityId: "fix-1" });
    expect(single).toBe("/forms?tab=clock_correction&status=all&focus=fix-1");
    const batch = notificationTarget({ kind: "request_reviewed", entityKind: "overtime", entityScope: "batch", entityId: "batch-1" });
    expect(batch).toBe("/forms?tab=overtime&status=all&batch=batch-1");
    for (const target of [single, batch]) expect(new URL(target, "https://hr.test").searchParams.has("search")).toBe(false);
  });
});

describe("申請紀錄的空狀態", () => {
  it("通知提到的申請真的不在了才說它不在，單筆與整批用各自的說法", () => {
    expect(emptyRecordsMessage({ target: "request", targetExists: false, narrowed: false }).title).toBe("這筆申請已經不在紀錄裡");
    expect(emptyRecordsMessage({ target: "batch", targetExists: false, narrowed: false }).title).toBe("這批加班申請已經不在紀錄裡");
  });

  it("申請還在、只是被搜尋或狀態篩掉時，不能說它可能已被取消", () => {
    expect(emptyRecordsMessage({ target: "request", targetExists: true, narrowed: true })).toEqual({ title: "找不到符合條件的申請", hint: "請調整搜尋文字或狀態篩選。" });
    expect(emptyRecordsMessage({ target: "batch", targetExists: true, narrowed: true }).title).toBe("找不到符合條件的申請");
  });

  it("沒有通知篩選時維持原本的兩種說法", () => {
    expect(emptyRecordsMessage({ target: null, targetExists: false, narrowed: true }).title).toBe("找不到符合條件的申請");
    expect(emptyRecordsMessage({ target: null, targetExists: false, narrowed: false }).title).toBe("目前沒有申請紀錄");
  });
});
