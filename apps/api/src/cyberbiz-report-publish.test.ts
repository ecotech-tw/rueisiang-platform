import { createDatabase, findCyberbizReportManifest, recordCyberbizReportManifest, syncSystemRoles } from "@rueisiang/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "./index.js";
import { createCyberbizReportPublisher } from "./cyberbiz-report-publish.js";
import { createLocalD1, type LocalD1 } from "./local-d1/d1.js";
import type { NasStorageClient } from "./nas-storage.js";

const TOKEN = "report-ingest-secret";
const SALES_SOURCE = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000011.xlsx";
const PAYOUT_SOURCE = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000012.xlsx";
const SALES_JSON = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000013.json";
const PAYOUT_JSON = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000014.json";
const COMBINED = "reports/cyberbiz/store-a/2026/07/00000000-0000-0000-0000-000000000015.xlsx";

let d1: LocalD1;

function db() {
  return createDatabase(d1 as never);
}

function manifest(status: "staged" | "published" = "staged") {
  return {
    reportMonth: "2026-07",
    scopeType: "store" as const,
    scopeId: "store-a",
    scopeName: "測試櫃位",
    coverageStart: "2026-07-01",
    coverageEnd: "2026-07-31",
    salesGranularity: "month" as const,
    payoutGranularity: "day" as const,
    salesSourceObjectKey: SALES_SOURCE,
    payoutSourceObjectKey: PAYOUT_SOURCE,
    salesObjectKey: SALES_JSON,
    payoutObjectKey: PAYOUT_JSON,
    combinedWorkbookObjectKey: COMBINED,
    driveFileId: status === "published" ? "drive-file-1" : null,
    driveUrl: status === "published" ? "https://drive.example.test/file/drive-file-1" : null,
    storeIdsJson: '["store-a"]',
    sourceChecksum: "a".repeat(64),
    parserVersion: "cyberbiz-report-v1",
    status,
  };
}

beforeEach(async () => {
  d1 = createLocalD1();
  await syncSystemRoles(db());
  vi.restoreAllMocks();
});

describe("CYBERBIZ report publish", () => {
  it("先驗證 NAS 物件，再建立 staged，Drive 完成後可升級為 published", async () => {
    const nas = {
      head: async (key: string) => ({
        key,
        size: 10,
        contentType: key.endsWith(".json") ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    } as unknown as NasStorageClient;
    const publisher = createCyberbizReportPublisher(db(), nas);

    const staged = await publisher.publish(manifest("staged"));
    expect(staged.status).toBe("staged");
    const published = await publisher.publish(manifest("published"));
    expect(published.status).toBe("published");

    const retry = await publisher.publish(manifest("staged"));
    expect(retry.status).toBe("published");
    expect((await findCyberbizReportManifest(db(), { reportMonth: "2026-07", scopeType: "store", scopeId: "store-a" }))?.driveFileId).toBe("drive-file-1");
  });

  it("NAS 缺物件時不會寫入 manifest", async () => {
    const nas = { head: async () => null } as unknown as NasStorageClient;
    await expect(createCyberbizReportPublisher(db(), nas).publish(manifest())).rejects.toMatchObject({
      code: "nas_object_missing",
      status: 422,
    });
    expect(await findCyberbizReportManifest(db(), { reportMonth: "2026-07", scopeType: "store", scopeId: "store-a" })).toBeNull();
  });

  it("同一版本的 staged 與 published 競速時，published 不會被 staged 降級", async () => {
    await Promise.all([
      recordCyberbizReportManifest(db(), manifest("staged")),
      recordCyberbizReportManifest(db(), manifest("published")),
    ]);
    const found = await findCyberbizReportManifest(db(), { reportMonth: "2026-07", scopeType: "store", scopeId: "store-a" });
    expect(found?.status).toBe("published");
  });

  it("internal endpoint 需要獨立 ingest token，且不經過使用者 session", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe("/v1/objects");
      expect(init?.method).toBe("HEAD");
      const key = new URL(String(input)).searchParams.get("key") ?? "";
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "10",
          "content-type": key.endsWith(".json") ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const body = { ...manifest("staged"), payoutSourceObjectKey: null, payoutObjectKey: null, combinedWorkbookObjectKey: null };
    const env = {
      DB: d1,
      NAS_STORAGE_URL: "https://storage.example.test",
      NAS_STORAGE_TOKEN: "nas-secret",
      CYBERBIZ_REPORT_INGEST_TOKEN: TOKEN,
    };

    const unauthorized = await app.fetch(new Request("https://platform.example.test/api/internal/cyberbiz-reports/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cyberbiz-report-token": "wrong" },
      body: JSON.stringify(body),
    }), env as never);
    expect(unauthorized.status).toBe(401);

    const response = await app.fetch(new Request("https://platform.example.test/api/internal/cyberbiz-reports/publish", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cyberbiz-report-token": TOKEN },
      body: JSON.stringify(body),
    }), env as never);
    expect(response.status).toBe(200);
    const responseBody = await response.json() as { manifest: { status: string } };
    expect(responseBody.manifest.status).toBe("staged");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
