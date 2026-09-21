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
    d1.sqlite.prepare("INSERT INTO hr_leave_types(id, name, leave_kind, created_by) VALUES (?, ?, ?, ?)").run("legacy-leave-type", "特休", "other", "legacy-user");
    d1.sqlite.prepare(`INSERT INTO hr_leave_requests
      (id, employment_id, leave_type_id, leave_type, status, starts_on, ends_on, duration_minutes, pay_rate_ppm, reason, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-leave-request", "legacy-employment", null, "特休", "approved", "2025-02-28", "2025-03-01", 30, 1_000_000, "既有核准特休", "legacy-user");

    applyMigration("0171_seed_annual_leave_policy.sql");
    applyMigration("0172_backfill_annual_leave_entitlements.sql");
    applyMigration("0171_seed_annual_leave_policy.sql");
    applyMigration("0172_backfill_annual_leave_entitlements.sql");

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
});
