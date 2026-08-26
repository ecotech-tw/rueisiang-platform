import { createDatabase } from "@rueisiang/db";
import { describe, expect, it } from "vitest";
import { lazyCyberbizReportService } from "./pi-agent-do.js";
import { createLocalD1 } from "./local-d1/d1.js";

describe("lazy CYBERBIZ report service", () => {
  it("does not validate a partial NAS configuration while building a generic tool context", () => {
    const d1 = createLocalD1();
    expect(() => lazyCyberbizReportService(createDatabase(d1 as never), {
      DB: d1,
      NAS_STORAGE_URL: "https://storage.example.test",
    } as never)).not.toThrow();
  });
});
