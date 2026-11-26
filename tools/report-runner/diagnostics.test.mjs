import assert from "node:assert/strict";
import test from "node:test";
import { appendTail, cyberbizFailureMessage, safeErrorMessage } from "./diagnostics.mjs";

test("keeps only the bounded stderr tail", () => {
  assert.equal(appendTail("abcdef", "ghi", 5), "efghi");
});

test("uses sanitized stderr when the driver result and stdout contain no failure", () => {
  assert.equal(cyberbizFailureMessage({ stderrFailure: "Error [ERR_MODULE_NOT_FOUND]: missing module" }), "Error [ERR_MODULE_NOT_FOUND]: missing module");
  assert.equal(cyberbizFailureMessage({}), "報表未完成，請查看執行摘要並重新提交。");
});

test("redacts secrets, cookie headers, tokens, OTPs, and request IDs", () => {
  const error = new Error([
    "refresh=mail-secret",
    "Cookie: sid=cookie-secret",
    "GET https://example.test/?access_token=url-secret&key=query-api-key",
    '{"apiKey":"api-secret","id_token":"identity-token","jwt":"jwt-secret"}',
    '"requestId":"cf-123e4567-e89b-12d3-a456-426614174000" OTP=123456',
  ].join("\n"));

  assert.equal(safeErrorMessage(error, { gmailRefreshToken: "mail-secret" }, {}), [
    "refresh=«gmailRefreshToken»",
    "Cookie=«redacted»",
    "GET https://example.test/?access_token=«redacted»&key=«redacted»",
    "{apiKey=«redacted»,id_token=«redacted»,jwt=«redacted»}",
    "requestId=«request-id» OTP=«otp»",
  ].join("\n"));
});
