import { parseDbDate, parseDbTimestamp } from "@rueisiang/db";
import { describe, expect, it } from "vitest";

const TEN_AM_UTC = Date.UTC(2026, 9, 1, 10, 0, 0);

describe("parseDbTimestamp", () => {
  it("D1 的 CURRENT_TIMESTAMP 與 JS 的 toISOString 指向同一個時間點", () => {
    expect(parseDbTimestamp("2026-10-01 10:00:00")).toBe(TEN_AM_UTC);
    expect(parseDbTimestamp("2026-10-01T10:00:00.000Z")).toBe(TEN_AM_UTC);
    expect(parseDbTimestamp("2026-10-01T10:00:00Z")).toBe(TEN_AM_UTC);
  });

  it("沒有時區標記的一律當 UTC，不跟著執行環境的時區走", () => {
    expect(parseDbTimestamp("2026-10-01T10:00:00")).toBe(TEN_AM_UTC);
    expect(parseDbTimestamp("2026-10-01 10:00")).toBe(TEN_AM_UTC);
    expect(parseDbTimestamp("2026-10-01 10:00:00.250")).toBe(TEN_AM_UTC + 250);
  });

  it("帶時區偏移的照偏移換算", () => {
    expect(parseDbTimestamp("2026-10-01T18:00:00+08:00")).toBe(TEN_AM_UTC);
    expect(parseDbTimestamp("2026-10-01T05:30:00-04:30")).toBe(TEN_AM_UTC);
  });

  it("只有日期的當成 UTC 當天 00:00", () => {
    expect(parseDbTimestamp("2026-10-01")).toBe(Date.UTC(2026, 9, 1));
  });

  it("空值與不存在的日期回 null，不回 NaN", () => {
    for (const value of [null, undefined, "", "not a time", "2026-02-30 00:00:00", "2026-10-01 25:00:00", "2026-10-01 10:61:00", "2026-10-01 10:00:00ZZ", "2026-02-30T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T10:00:00+24:00"]) {
      expect(parseDbTimestamp(value)).toBeNull();
    }
  });

  it("parseDbDate 給 Date，認不得時回 null", () => {
    expect(parseDbDate("2026-10-01 10:00:00")?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(parseDbDate("bad")).toBeNull();
  });
});
