import assert from "node:assert/strict";
import test from "node:test";
import { cyberbizLoginProbeValidationReason } from "./request-validation.mjs";

const validProbe = {
  kind: "cyberbiz-login-probe",
  requestId: "cf-123e4567-e89b-12d3-a456-426614174000",
  storeName: "中和環球",
  credentials: { cyberbizUsername: "test-user", cyberbizPassword: "test-password" },
};

test("accepts only the fixed test-store probe request shape", () => {
  assert.equal(cyberbizLoginProbeValidationReason(validProbe), null);
});

test("returns safe validation reasons without exposing credential values", () => {
  const cases = [
    [{ ...validProbe, requestId: "bad" }, "invalid_request_id"],
    [{ ...validProbe, credentials: undefined }, "missing_credentials"],
    [{ ...validProbe, credentials: { cyberbizPassword: "test-password" } }, "missing_username"],
    [{ ...validProbe, credentials: { cyberbizUsername: "test-user" } }, "missing_password"],
    [{ ...validProbe, storeName: "other-store" }, "unsupported_store"],
  ];

  for (const [payload, reason] of cases) {
    assert.equal(cyberbizLoginProbeValidationReason(payload), reason);
  }
});
