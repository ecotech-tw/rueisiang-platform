import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PLATFORM_API_URL, reportIngestConfig } from "../lib/common.mjs";

test("D1 匯入缺少 ingest token 時停用，但保留預設 Worker URL", () => {
  const config = reportIngestConfig({});

  assert.equal(config.enabled, false);
  assert.deepEqual(config.missing, [
    "CYBERBIZ_REPORT_INGEST_TOKEN",
  ]);
  assert.equal(config.apiUrl, DEFAULT_PLATFORM_API_URL);
});

test("D1 匯入設定齊全時啟用，且使用自訂 Worker URL", () => {
  const config = reportIngestConfig({
    CYBERBIZ_REPORT_INGEST_TOKEN: "ingest-token",
    PLATFORM_API_URL: "https://worker.example.com/",
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.missing, []);
  assert.equal(config.apiUrl, "https://worker.example.com/");
});

test("D1 匯入會忽略空白設定值", () => {
  const config = reportIngestConfig({
    CYBERBIZ_REPORT_INGEST_TOKEN: " ingest-token ",
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.missing, []);
});
