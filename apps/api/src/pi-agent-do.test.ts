import { createDatabase } from "@rueisiang/db";
import { describe, expect, it } from "vitest";
import { lazyCyberbizReportService } from "./pi-agent-do.js";
import { createLocalD1 } from "./local-d1/d1.js";

describe("lazy CYBERBIZ report service", () => {
  it("建立通用報表工具 context 不需要 NAS 設定", () => {
    const d1 = createLocalD1();
    expect(() => lazyCyberbizReportService(createDatabase(d1 as never))).not.toThrow();
  });
});
