const TEST_STORE_NAME = "中和環球";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{16,80}$/;

export function cyberbizLoginProbeValidationReason(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_payload";
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) return "invalid_request_id";
  if (value.kind !== "cyberbiz-login-probe") return "invalid_job_kind";
  if (!value.credentials || typeof value.credentials !== "object" || Array.isArray(value.credentials)) return "missing_credentials";
  if (typeof value.credentials.cyberbizUsername !== "string" || !value.credentials.cyberbizUsername) return "missing_username";
  if (typeof value.credentials.cyberbizPassword !== "string" || !value.credentials.cyberbizPassword) return "missing_password";
  if (value.storeName !== TEST_STORE_NAME) return "unsupported_store";
  return null;
}
