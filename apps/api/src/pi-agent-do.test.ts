import { compareDbTimestamp, createDatabase, sameDbTimestamp } from "@rueisiang/db";
import { describe, expect, it } from "vitest";
import { generationChange, lazyCyberbizReportService } from "./pi-agent-do.js";
import { createLocalD1 } from "./local-d1/d1.js";

describe("lazy CYBERBIZ report service", () => {
  it("建立通用報表工具 context 不需要 NAS 設定", () => {
    const d1 = createLocalD1();
    expect(() => lazyCyberbizReportService(createDatabase(d1 as never))).not.toThrow();
  });
});

describe("對話 generation 的新舊判斷", () => {
  it("同一個重置時間換了格式仍然是同一個 generation，不會被當成舊的而略過", () => {
    expect(generationChange("2026-11-25 03:00:00.000", "2026-11-25T03:00:00.000Z")).toBe("same");
    expect(generationChange("2026-11-25 03:00:00", "2026-11-25T03:00:00.000Z")).toBe("same");
  });

  // 部署前在 ISO 重置過、部署後同一天又重置：新的字串反而比較「小」，逐字比會被當成舊的。
  it("同一天裡部署後的重置比部署前的 ISO 重置新", () => {
    expect(generationChange("2026-11-25 05:00:00.000", "2026-11-25T03:00:00.000Z")).toBe("newer");
    expect(generationChange("2026-11-25T03:00:00.000Z", "2026-11-25 05:00:00.000")).toBe("stale");
  });

  it("從來沒重置過（空字串）比任何重置都舊", () => {
    expect(generationChange("", "")).toBe("same");
    expect(generationChange("2026-11-25 05:00:00.000", "")).toBe("newer");
    expect(generationChange("", "2026-11-25 05:00:00.000")).toBe("stale");
  });

  it("compareDbTimestamp 與 sameDbTimestamp 對兩種格式一致", () => {
    expect(compareDbTimestamp("2026-11-25 05:00:00", "2026-11-25T03:00:00Z")).toBe(1);
    expect(compareDbTimestamp(null, undefined)).toBe(0);
    expect(sameDbTimestamp("", "")).toBe(true);
  });
});
