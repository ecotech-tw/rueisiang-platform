import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import { publishCyberbizReport } from "../lib/report-publish.mjs";
import { uploadAndVerifyReportWorkbook } from "../lib/report-drive.mjs";

const scopeId = "store-a";
const month = "2026-07";

test("monthly report publish reuses deterministic upload ids and stages before Drive publish", async () => {
  const calls = [];
  const fileContents = new Map([
    ["sales.json", Buffer.from('{"kind":"cyberbiz_sales_monthly"}')],
    ["payout.json", Buffer.from('{"kind":"cyberbiz_payout_daily"}')],
    ["sales.xlsx", Buffer.from("sales-xlsx")],
    ["payout.xlsx", Buffer.from("payout-xlsx")],
    ["combined.xlsx", Buffer.from("combined-xlsx")],
  ]);
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberbiz-report-publish-"));
  for (const [name, bytes] of fileContents) await fs.writeFile(path.join(temporaryDir, name), bytes);
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/v1/objects") {
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      const extension = url.searchParams.get("scope") === "cyberbiz" && init.headers["content-type"] === "application/json" ? "json" : "xlsx";
      const objectId = url.searchParams.get("objectId");
      return new Response(JSON.stringify({ object: {
        key: `reports/cyberbiz/${scopeId}/2026/07/${objectId}.${extension}`,
        size: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        contentType: init.headers["content-type"],
      } }), { status: 201 });
    }
    assert.equal(url.pathname, "/api/internal/cyberbiz-reports/publish");
    const manifest = JSON.parse(init.body);
    return new Response(JSON.stringify({ manifest: { id: `manifest-${manifest.status}`, ...manifest } }), { status: 200 });
  };
  try {
    const result = await publishCyberbizReport({
      nasUrl: "https://storage.example.test",
      nasToken: "nas-secret",
      apiUrl: "https://platform.example.test",
      ingestToken: "ingest-secret",
      reportMonth: month,
      scopeType: "store",
      scopeId,
      scopeName: "測試櫃位",
      coverageStart: "2026-07-01",
      coverageEnd: "2026-07-31",
      parserVersion: "test-v1",
      salesSourcePath: path.join(temporaryDir, "sales.xlsx"),
      payoutSourcePath: path.join(temporaryDir, "payout.xlsx"),
      salesJsonPath: path.join(temporaryDir, "sales.json"),
      payoutJsonPath: path.join(temporaryDir, "payout.json"),
      combinedWorkbookPath: path.join(temporaryDir, "combined.xlsx"),
      fetcher,
      afterStaged: async () => ({ driveFileId: "drive-1", driveUrl: "https://drive.test/file/drive-1" }),
    });

    assert.equal(result.id, "manifest-published");
    const uploadCalls = calls.filter((call) => call.url.pathname === "/v1/objects");
    assert.equal(uploadCalls.length, 5);
    assert.equal(new Set(uploadCalls.map((call) => call.url.searchParams.get("objectId"))).size, 5);
    const manifestCalls = calls.filter((call) => call.url.pathname.endsWith("/publish"));
    assert.deepEqual(manifestCalls.map((call) => JSON.parse(call.init.body).status), ["staged", "published"]);
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("report Drive upload never reuses an unverified same-name artifact", async () => {
  const uploads = [];
  const verifications = [];
  const upload = async (token, input) => {
    uploads.push({ token, input });
    return { id: `drive-${uploads.length}`, webViewLink: `https://drive.test/${uploads.length}` };
  };
  const verify = async (token, id, input) => {
    verifications.push({ token, id, input });
    return { count: 1, sample: [123] };
  };

  await uploadAndVerifyReportWorkbook({
    token: "drive-secret",
    filePath: "combined.xlsx",
    name: "combined.xlsx",
    folderId: "folder-1",
    firstDataRow: 3,
    upload,
    verify,
  });
  await uploadAndVerifyReportWorkbook({
    token: "drive-secret",
    filePath: "combined.xlsx",
    name: "combined.xlsx",
    folderId: "folder-1",
    firstDataRow: 3,
    upload,
    verify,
  });

  assert.equal(uploads.length, 2);
  assert.deepEqual(verifications.map((item) => item.id), ["drive-1", "drive-2"]);
});
