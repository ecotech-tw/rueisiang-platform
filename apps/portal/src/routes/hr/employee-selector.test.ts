import { describe, expect, it } from "vitest";
import { hrEmployeeLabel, sortHrEmployees } from "./api.js";

const employees = [
  { employeeNumber: "E10", legalName: "十號" },
  { employeeNumber: "E2", legalName: "二號" },
  { employeeNumber: "E01", legalName: "一號" },
];

describe("HR 員工選擇器資料", () => {
  it("依員工編號自然排序，搜尋標籤同時包含編號與姓名", () => {
    expect(sortHrEmployees(employees).map((employee) => employee.employeeNumber)).toEqual(["E01", "E2", "E10"]);
    expect(hrEmployeeLabel(employees[1]!)).toBe("E2・二號");
  });
});
