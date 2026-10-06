import { describe, expect, it } from "vitest";
import { createLocalD1 } from "./local-d1/d1.js";

describe("local D1 test fixture", () => {
  it("每個記憶體資料庫都從獨立的已完成 schema 開始", () => {
    const first = createLocalD1();
    const second = createLocalD1();

    try {
      first.sqlite.exec("CREATE TABLE __local_d1_isolation_probe (id TEXT PRIMARY KEY);");
      expect(() => second.sqlite.prepare("SELECT * FROM __local_d1_isolation_probe").all()).toThrow();
    } finally {
      first.sqlite.close();
      second.sqlite.close();
    }
  });
});
