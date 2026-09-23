import { describe, expect, it } from "vitest";
import { currentSalary, insuranceForEmployment } from "./InsuranceManagement.js";
import type { Employment, InsuranceVersion, Profile } from "./api.js";

const employment: Employment = {
  id: "employment-1",
  employeeUserId: "user-1",
  employeeNumber: "E001",
  position: "一般職員",
  supervisorUserId: null,
  archivedAt: null,
  revision: 1,
};

const profile = {
  compensation: [{
    id: "compensation-1",
    employmentId: employment.id,
    versionNumber: 1,
    validFrom: "2026-01-01",
    validTo: null,
    payBasis: "monthly",
    baseAmountMinor: 3_600_000,
    note: "",
    items: [
      { id: "item-1", compensationVersionId: "compensation-1", itemName: "職務津貼", amountMinor: 200_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: 1, includeInsurance: 1, includeTax: 1 },
      { id: "item-2", compensationVersionId: "compensation-1", itemName: "全勤獎金", amountMinor: 200_000, itemKind: "fixed", amountBasis: "monthly", includeOvertime: 1, includeInsurance: 1, includeTax: 1 },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "admin",
  }],
} as Profile;

describe("勞健保預設實際月薪", () => {
  it("以有效敘薪的本薪與所有津貼合計", () => {
    expect(currentSalary(profile, employment, "2026-02-01")).toBe(4_000_000);
  });
});

describe("勞健保任職範圍", () => {
  it("只把目前任職的版本交給管理頁，不混入封存任職", () => {
    const version = (id: string, employmentId: string): InsuranceVersion => ({
      id, employmentId, scheme: "labor", versionNumber: 1, status: "enrolled", validFrom: "2026-01-01", validTo: null,
      insuredAmountMinor: 3_000_000, dependentCount: 0, rateYear: 2026, sourceKind: "manual", sourceUrl: "", note: "",
      createdAt: "2026-01-01T00:00:00.000Z", createdBy: "admin",
    });
    const versions = [version("current", employment.id), version("archived", "employment-archived")];

    expect(insuranceForEmployment(versions, employment.id)).toEqual([versions[0]]);
    expect(insuranceForEmployment(versions, undefined)).toEqual([]);
  });
});
