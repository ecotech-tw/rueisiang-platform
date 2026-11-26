import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnv, redact } from "../lib/common.mjs";

test("runner environment overrides .env values", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-env-test-"));
  const file = path.join(directory, ".env");
  const key = "CYBERBIZ_REPORT_RUNNER_TEST_VALUE";
  const previous = process.env[key];
  const previousClientId = process.env.GOOGLE_CLIENT_ID;
  t.after(async () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  });

  await writeFile(file, `${key}=from-file\nGOOGLE_CLIENT_ID=file-client\n`, "utf8");
  process.env[key] = "from-runtime";
  process.env.GOOGLE_CLIENT_ID = "runtime-client";
  t.after(() => {
    if (previousClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousClientId;
  });

  const values = await loadEnv(file);
  assert.equal(values[key], "from-runtime");
  assert.equal(values.GOOGLE_CLIENT_ID, "runtime-client");
});

test("uses injected runner secrets when the local .env file is absent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-no-env-test-"));
  const key = "CYBERBIZ_REPORT_RUNNER_NO_FILE_TEST";
  const previous = process.env[key];
  t.after(async () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  });
  process.env[key] = "injected-secret";

  assert.equal((await loadEnv(path.join(directory, ".env")))[key], "injected-secret");
});

test("redacts both legacy and Cloudflare report credential names", () => {
  const output = redact("user cy-user drive drive-token mail mail-token ingest ingest-token", {
    CYBERBIZ_USERNAME: "cy-user",
    GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN: "drive-token",
    GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN: "mail-token",
    CYBERBIZ_REPORT_INGEST_TOKEN: "ingest-token",
  });
  assert.equal(output, "user «CYBERBIZ_USERNAME» drive «GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN» mail «GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN» ingest «CYBERBIZ_REPORT_INGEST_TOKEN»");
});
