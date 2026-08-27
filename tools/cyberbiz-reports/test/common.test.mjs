import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PLATFORM_API_URL, reportPublishConfig } from "../lib/common.mjs";

test("manifest 後處理缺少 NAS 或 ingest 設定時會停用，但保留預設 Worker URL", () => {
  const config = reportPublishConfig({ NAS_STORAGE_URL: "", NAS_STORAGE_TOKEN: "" });

  assert.equal(config.enabled, false);
  assert.deepEqual(config.missing, [
    "NAS_STORAGE_URL",
    "NAS_STORAGE_TOKEN",
    "CYBERBIZ_REPORT_INGEST_TOKEN",
  ]);
  assert.equal(config.apiUrl, DEFAULT_PLATFORM_API_URL);
});

test("manifest 後處理設定齊全時啟用，且使用自訂 Worker URL", () => {
  const config = reportPublishConfig({
    NAS_STORAGE_URL: "https://storage.example.com",
    NAS_STORAGE_TOKEN: "token",
    CYBERBIZ_REPORT_INGEST_TOKEN: "ingest-token",
    PLATFORM_API_URL: "https://worker.example.com/",
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.missing, []);
  assert.equal(config.apiUrl, "https://worker.example.com/");
});

test("manifest 後處理會忽略空白設定值", () => {
  const config = reportPublishConfig({
    NAS_STORAGE_URL: " https://storage.example.com ",
    NAS_STORAGE_TOKEN: "   ",
    CYBERBIZ_REPORT_INGEST_TOKEN: " ingest-token ",
  });

  assert.equal(config.enabled, false);
  assert.deepEqual(config.missing, ["NAS_STORAGE_TOKEN"]);
});
