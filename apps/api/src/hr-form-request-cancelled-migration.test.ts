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

/**
 * createTargetOnlyD1() 已經跑完 0209，直接再套一次測不到升級。
 * 先把表退回 0209 之前的樣子（CHECK 沒有 cancelled），再套 0209，才是正式環境會走的那一步。
 */
function restoreSchemaBeforeMigration() {
  d1!.sqlite.exec(`
    ALTER TABLE hr_form_requests RENAME TO __current_hr_form_requests;
    DROP INDEX idx_hr_form_requests_employee_created;
    DROP INDEX idx_hr_form_requests_approver_status;
    DROP INDEX idx_hr_form_requests_corrected_event;
    CREATE TABLE hr_form_requests (
      id text PRIMARY KEY NOT NULL,
      employee_user_id text NOT NULL,
      employment_id text NOT NULL,
      form_kind text DEFAULT 'clock_correction' NOT NULL,
      status text DEFAULT 'draft' NOT NULL,
      correction_date text NOT NULL,
      requested_event_kind text NOT NULL,
      requested_at text NOT NULL,
      reason text NOT NULL,
      approver_user_id text,
      submitted_at text,
      reviewed_at text,
      review_comment text,
      corrected_clock_event_id text,
      created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
      FOREIGN KEY (employee_user_id) REFERENCES users(id) ON UPDATE no action ON DELETE restrict,
      FOREIGN KEY (employment_id) REFERENCES hr_employments(id) ON UPDATE no action ON DELETE restrict,
      FOREIGN KEY (approver_user_id) REFERENCES users(id) ON UPDATE no action ON DELETE restrict,
      CONSTRAINT "ck_hr_form_requests_kind" CHECK(form_kind = 'clock_correction'),
      CONSTRAINT "ck_hr_form_requests_status" CHECK(status IN ('draft', 'pending', 'approved', 'rejected')),
      CONSTRAINT "ck_hr_form_requests_event_kind" CHECK(requested_event_kind IN ('clock_in', 'clock_out')),
      CONSTRAINT "ck_hr_form_requests_date" CHECK(length(correction_date) = 10),
      CONSTRAINT "ck_hr_form_requests_reason" CHECK(length(trim(reason)) BETWEEN 1 AND 1000)
    );
    DROP TABLE __current_hr_form_requests;
    CREATE INDEX idx_hr_form_requests_employee_created ON hr_form_requests (employee_user_id, created_at);
    CREATE INDEX idx_hr_form_requests_approver_status ON hr_form_requests (approver_user_id, status);
    CREATE INDEX idx_hr_form_requests_corrected_event ON hr_form_requests (corrected_clock_event_id);
  `);
}

afterEach(() => {
  d1?.sqlite.close();
  d1 = undefined;
});

describe("補打卡申請新增 cancelled 狀態的 migration", () => {
  it("從舊的 CHECK 升級時保留既有申請與核准產生的打卡事件", () => {
    d1 = createTargetOnlyD1();
    restoreSchemaBeforeMigration();
    d1.sqlite.exec(`
      INSERT INTO users (id, email, display_name, status) VALUES ('form-user', 'form@example.test', '申請人', 'active'), ('form-approver', 'approver@example.test', '審核者', 'active');
      INSERT INTO hr_employments (id, employee_user_id, employee_number, position) VALUES ('form-employment', 'form-user', 'FORM-1', '一般職員');
      INSERT INTO hr_form_requests (id, employee_user_id, employment_id, status, correction_date, requested_event_kind, requested_at, reason, approver_user_id, submitted_at, reviewed_at, review_comment, corrected_clock_event_id)
        VALUES ('form-approved', 'form-user', 'form-employment', 'approved', '2026-01-02', 'clock_in', '2026-01-02 01:00:00', '保留資料', 'form-approver', '2026-01-02 02:00:00', '2026-01-02 03:00:00', '同意', 'form-event');
      INSERT INTO hr_form_requests (id, employee_user_id, employment_id, status, correction_date, requested_event_kind, requested_at, reason, approver_user_id, submitted_at)
        VALUES ('form-pending', 'form-user', 'form-employment', 'pending', '2026-01-03', 'clock_out', '2026-01-03 10:00:00', '審核中', 'form-approver', '2026-01-03 11:00:00');
      INSERT INTO hr_clock_events (id, employee_user_id, employment_id, source_kind, idempotency_key, correction_request_id, event_kind, recorded_by, manual_reason, occurred_at, received_at)
        VALUES ('form-event', 'form-user', 'form-employment', 'manual', 'form-correction:form-approved', 'form-approved', 'clock_in', 'form-approver', '保留資料', '2026-01-02 01:00:00', '2026-01-02 03:00:00');
    `);
    expect(() => d1!.sqlite.exec("UPDATE hr_form_requests SET status='cancelled' WHERE id='form-pending'")).toThrow(/CHECK/);
    const before = d1.sqlite.prepare("SELECT * FROM hr_form_requests ORDER BY id").all();

    applyMigration("0209_wealthy_kinsey_walden.sql");

    expect(d1.sqlite.prepare("SELECT * FROM hr_form_requests ORDER BY id").all()).toEqual(before);
    expect(d1.sqlite.prepare("SELECT correction_request_id FROM hr_clock_events WHERE id='form-event'").get()).toEqual({ correction_request_id: "form-approved" });
    expect(d1.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(d1.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='hr_form_requests' AND name LIKE 'idx_%' ORDER BY name").all()).toEqual([
      { name: "idx_hr_form_requests_approver_status" }, { name: "idx_hr_form_requests_corrected_event" }, { name: "idx_hr_form_requests_employee_created" },
    ]);
    d1.sqlite.exec("UPDATE hr_form_requests SET status='cancelled' WHERE id='form-pending'");
    expect(() => d1!.sqlite.exec("UPDATE hr_form_requests SET status='withdrawn' WHERE id='form-pending'")).toThrow(/CHECK/);
  });
});
