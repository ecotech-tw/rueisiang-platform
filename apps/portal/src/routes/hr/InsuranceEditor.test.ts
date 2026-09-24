import { describe, expect, it } from "vitest";
import { currentInsuranceVersionDate, insuranceVersionDateSummary } from "./InsuranceEditor.js";
import type { InsuranceVersion } from "./api.js";

function version(overrides: Partial<InsuranceVersion>): InsuranceVersion {
  return {
    id: "insurance-1", employmentId: "employment-1", scheme: "labor", versionNumber: 1, status: "enrolled",
    validFrom: "2026-08-03", validTo: null, insuredAmountMinor: 4_580_000, dependentCount: 0, rateYear: 2026,
    sourceKind: "manual", sourceUrl: "", note: "", voidedAt: null, createdAt: "2026-08-03T00:00:00.000Z", createdBy: "admin",
    ...overrides,
  };
}

describe("勞健保版本生效日顯示", () => {
  it("以目前仍有效版本中最晚的生效日作為日期欄位預設值", () => {
    expect(currentInsuranceVersionDate([
      version({ id: "labor-current", scheme: "labor", validFrom: "2026-08-03", versionNumber: 2 }),
      version({ id: "health-current", scheme: "health", validFrom: "2026-08-10", versionNumber: 1, dependentCount: 1 }),
    ])).toBe("2026-08-10");
  });

  it("顯示目前仍有效的最新版本，不把已撤回日期誤當成目前日期", () => {
    expect(insuranceVersionDateSummary([
      version({ id: "labor-old", scheme: "labor", validFrom: "2026-01-01", versionNumber: 1, voidedAt: "2026-08-03T00:00:00.000Z" }),
      version({ id: "labor-current", scheme: "labor", validFrom: "2026-08-03", versionNumber: 2 }),
      version({ id: "health-current", scheme: "health", validFrom: "2026-08-03", versionNumber: 1, dependentCount: 1 }),
    ])).toEqual(["勞保 2026-08-03", "健保 2026-08-03"]);
  });
});
