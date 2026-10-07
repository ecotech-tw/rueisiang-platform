import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1 | undefined;

// 照 D1 的方式跑：整支 migration 包在一個 transaction 裡，PRAGMA foreign_keys 在裡面是 no-op。
function applyMigration(name: string) {
  const sql = fs.readFileSync(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), "utf8");
  d1!.sqlite.exec("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) d1!.sqlite.exec(trimmed);
    }
    d1!.sqlite.exec("COMMIT");
  } catch (error) {
    d1!.sqlite.exec("ROLLBACK");
    throw error;
  }
}

afterEach(() => {
  d1?.sqlite.close();
  d1 = undefined;
});

describe("補打卡申請新增 cancelled 狀態的 migration", () => {
  it("重建 hr_form_requests 時保留既有申請與核准產生的打卡事件", () => {
    d1 = createTargetOnlyD1();
    d1.sqlite.exec(`
      INSERT INTO users (id, email, display_name, status) VALUES ('form-user', 'form@example.test', '申請人', 'active'), ('form-approver', 'approver@example.test', '審核者', 'active');
      INSERT INTO hr_employments (id, employee_user_id, employee_number, position) VALUES ('form-employment', 'form-user', 'FORM-1', '一般職員');
      INSERT INTO hr_form_requests (id, employee_user_id, employment_id, status, correction_date, requested_event_kind, requested_at, reason, approver_user_id, submitted_at, reviewed_at, review_comment, corrected_clock_event_id)
        VALUES ('form-approved', 'form-user', 'form-employment', 'approved', '2026-01-02', 'clock_in', '2026-01-02 01:00:00', '保留資料', 'form-approver', '2026-01-02 02:00:00', '2026-01-02 03:00:00', '同意', 'form-event');
      INSERT INTO hr_clock_events (id, employee_user_id, employment_id, source_kind, idempotency_key, correction_request_id, event_kind, recorded_by, manual_reason, occurred_at, received_at)
        VALUES ('form-event', 'form-user', 'form-employment', 'manual', 'form-correction:form-approved', 'form-approved', 'clock_in', 'form-approver', '保留資料', '2026-01-02 01:00:00', '2026-01-02 03:00:00');
    `);
    const before = d1.sqlite.prepare("SELECT * FROM hr_form_requests WHERE id='form-approved'").get();

    applyMigration("0208_brainy_morlun.sql");

    expect(d1.sqlite.prepare("SELECT * FROM hr_form_requests WHERE id='form-approved'").get()).toEqual(before);
    expect(d1.sqlite.prepare("SELECT correction_request_id FROM hr_clock_events WHERE id='form-event'").get()).toEqual({ correction_request_id: "form-approved" });
    expect(d1.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='hr_form_requests' AND name LIKE 'idx_%' ORDER BY name").all()).toEqual([
      { name: "idx_hr_form_requests_approver_status" }, { name: "idx_hr_form_requests_corrected_event" }, { name: "idx_hr_form_requests_employee_created" },
    ]);
    d1.sqlite.exec("UPDATE hr_form_requests SET status='cancelled' WHERE id='form-approved'");
    expect(() => d1!.sqlite.exec("UPDATE hr_form_requests SET status='withdrawn' WHERE id='form-approved'")).toThrow(/CHECK/);
  });
});
