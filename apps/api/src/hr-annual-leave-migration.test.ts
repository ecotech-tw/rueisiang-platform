import fs from "node:fs";
import { createDatabase } from "@rueisiang/db";
import { users } from "@rueisiang/db/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createTargetOnlyD1, type LocalD1 } from "./local-d1/d1.js";

let d1: LocalD1;

function applyMigration(name: string) {
  const sql = migration(name);
  d1.sqlite.exec("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) d1.sqlite.exec(trimmed);
    }
    d1.sqlite.exec("COMMIT");
  } catch (error) {
    d1.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function migration(name: string) {
  return fs.readFileSync(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), "utf8");
}

afterEach(() => d1?.sqlite.close());

describe("既有特休資料回填 migration", () => {
  it("會把既有特休名稱、週年額度與已核准 usage 一起冪等回填", async () => {
    d1 = createTargetOnlyD1();
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "legacy-user", email: "legacy@example.test", displayName: "既有員工", status: "active" });
    d1.sqlite.prepare("INSERT INTO hr_employees(user_id, employee_number) VALUES (?, ?)").run("legacy-user", "LEGACY-1");
    d1.sqlite.prepare("INSERT INTO hr_employments(id, employee_user_id, hired_on, seniority_start_on) VALUES (?, ?, ?, ?)").run("legacy-employment", "legacy-user", "2024-02-29", "2024-02-29");
    d1.sqlite.prepare("INSERT INTO hr_leave_types(id, name, leave_kind, created_by) VALUES (?, ?, ?, ?)").run("legacy-leave-type", "特休　", "other", "legacy-user");
    d1.sqlite.prepare(`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-leave-request", "legacy-employment", null, "特休", "approved", "2025-02-28", "2025-03-01", 30, 1_000_000, "既有核准特休", "legacy-user");

    applyMigration("0175_backfill_hr_leave_request_times.sql");
    expect(d1.sqlite.prepare("SELECT starts_at, ends_at FROM hr_leave_requests WHERE id=?").get("legacy-leave-request")).toEqual({
      starts_at: "2025-02-27 16:00:00", ends_at: "2025-02-28 16:00:00",
    });
    applyMigration("0172_seed_annual_leave_policy.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");
    applyMigration("0172_seed_annual_leave_policy.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");

    expect(d1.sqlite.prepare("SELECT leave_kind FROM hr_leave_types WHERE id=?").get("legacy-leave-type")).toEqual({ leave_kind: "annual" });
    expect(d1.sqlite.prepare(`SELECT service_months, period_start, period_end, entitled_half_hours
      FROM hr_annual_leave_entitlements WHERE employment_id=? AND period_start=?`)
      .get("legacy-employment", "2025-02-28")).toMatchObject({ service_months: 12, period_start: "2025-02-28", period_end: "2026-02-28", entitled_half_hours: 112 });
    expect(d1.sqlite.prepare(`SELECT entry_kind, delta_half_hours, source_key
      FROM hr_annual_leave_ledger WHERE leave_request_id=?`).all("legacy-leave-request")).toEqual([
      { entry_kind: "leave_request", delta_half_hours: -1, source_key: "leave-request:legacy-leave-request" },
    ]);
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_annual_leave_ledger WHERE source_key=?").get("annual-grant:legacy-employment:2025-02-28")).toEqual({ count: 1 });
  });

  it("同一期別同批多筆使用會累計檢查，避免回填後餘額變成負數", async () => {
    d1 = createTargetOnlyD1();
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "batch-user", email: "batch@example.test", displayName: "同批員工", status: "active" });
    d1.sqlite.prepare("INSERT INTO hr_employees(user_id, employee_number) VALUES (?, ?)").run("batch-user", "LEGACY-BATCH");
    d1.sqlite.prepare("INSERT INTO hr_employments(id, employee_user_id, hired_on, seniority_start_on) VALUES (?, ?, ?, ?)").run("batch-employment", "batch-user", "2024-02-29", "2024-02-29");
    d1.sqlite.prepare("INSERT INTO hr_leave_types(id, name, leave_kind, created_by) VALUES (?, ?, ?, ?)").run("batch-leave-type", "特休", "annual", "batch-user");
    d1.sqlite.prepare(`INSERT INTO hr_annual_leave_entitlements
      (id, employment_id, policy_version_id, bracket_id, service_months, period_start, period_end, entitled_half_hours, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "batch-entitlement",
      "batch-employment",
      "annual-leave-policy-2017-v1",
      "annual-leave-bracket-1y",
      12,
      "2025-02-28",
      "2026-02-28",
      2,
      "open",
      "batch-user",
    );
    for (const [id, startsOn, endsOn] of [
      ["batch-leave-request-1", "2025-04-01", "2025-04-02"],
      ["batch-leave-request-2", "2025-04-02", "2025-04-03"],
    ] as const) {
      d1.sqlite.prepare(`INSERT INTO hr_leave_requests
        (id, employment_id, leave_type_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, "batch-employment", "batch-leave-type", "特休", "approved", startsOn, endsOn, 60, 1_000_000, "同批核准特休", "batch-user");
    }

    applyMigration("0172_seed_annual_leave_policy.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");

    expect(d1.sqlite.prepare("SELECT sum(delta_half_hours) AS balance FROM hr_annual_leave_ledger WHERE entitlement_id=?").get("batch-entitlement")).toEqual({ balance: 0 });
    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_annual_leave_ledger WHERE entitlement_id=? AND entry_kind='leave_request'").get("batch-entitlement")).toEqual({ count: 1 });
    expect(d1.sqlite.prepare("SELECT error FROM activity_events WHERE id=?").get("annual-leave-backfill-issue:batch-leave-request-2")).toEqual({ error: "insufficient_balance" });
  });

  it("無法安全分配到單一期別的既有使用會留下稽核問題且不製造負餘額", async () => {
    d1 = createTargetOnlyD1();
    const db = createDatabase(d1 as never);
    await db.insert(users).values({ id: "cross-user", email: "cross@example.test", displayName: "跨期員工", status: "active" });
    d1.sqlite.prepare("INSERT INTO hr_employees(user_id, employee_number) VALUES (?, ?)").run("cross-user", "LEGACY-CROSS");
    d1.sqlite.prepare("INSERT INTO hr_employments(id, employee_user_id, hired_on, seniority_start_on) VALUES (?, ?, ?, ?)").run("cross-employment", "cross-user", "2024-02-29", "2024-02-29");
    d1.sqlite.prepare("INSERT INTO hr_leave_types(id, name, leave_kind, created_by) VALUES (?, ?, ?, ?)").run("cross-leave-type", "特休", "other", "cross-user");
    d1.sqlite.prepare(`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("cross-leave-request", "cross-employment", null, "特休", "approved", "2026-02-27", "2026-03-02", 30, 1_000_000, "跨週期既有核准特休", "cross-user");

    applyMigration("0172_seed_annual_leave_policy.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");
    applyMigration("0173_backfill_annual_leave_entitlements.sql");

    expect(d1.sqlite.prepare("SELECT count(*) AS count FROM hr_annual_leave_ledger WHERE leave_request_id=?").get("cross-leave-request")).toEqual({ count: 0 });
    expect(d1.sqlite.prepare("SELECT event_type, status, error FROM activity_events WHERE id=?").get("annual-leave-backfill-issue:cross-leave-request")).toEqual({
      event_type: "annual_leave_backfill_unmatched",
      status: "failed",
      error: "cross_period_or_missing_entitlement",
    });
  });
});
