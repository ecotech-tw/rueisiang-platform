const SECRET_ENV_NAMES = [
  "REPORT_RUNNER_TOKEN",
  "CYBERBIZ_USERNAME",
  "CYBERBIZ_PASSWORD",
  "GOOGLE_REPORTS_OAUTH_CLIENT_SECRET",
  "GOOGLE_REPORTS_DRIVE_REFRESH_TOKEN",
  "GOOGLE_REPORTS_GMAIL_REFRESH_TOKEN",
  "CYBERBIZ_REPORT_INGEST_TOKEN",
];

export function appendTail(current, chunk, maxLength) {
  const combined = current + String(chunk ?? "");
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}

export function cyberbizFailureMessage({ errors = [], driverFailure = "", stdoutFailure = "", stderrFailure = "" }) {
  return errors.join("；").slice(0, 2_000)
    || driverFailure
    || stdoutFailure
    || stderrFailure
    || "報表未完成，請查看執行摘要並重新提交。";
}

export function safeErrorMessage(error, additionalSecrets = {}, env = process.env) {
  let message = error instanceof Error ? error.message : "報表處理失敗。";
  const secrets = [
    ...SECRET_ENV_NAMES.map((key) => [key, env[key]]),
    ...Object.entries(additionalSecrets),
  ];
  for (const [key, value] of secrets) {
    if (typeof value === "string" && value.length > 3) message = message.split(value).join(`«${key}»`);
  }
  message = message.replace(/["']?\b(cookie|set-cookie|authorization)["']?\s*[:=]\s*[^\r\n]*/gi, "$1=«redacted»");
  message = message.replace(/["']?\b(access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|api[_ -]?key|client[_ -]?secret|secret|jwt|key|password)["']?\s*[:=]\s*["']?[^"'&\s,;}]+["']?/gi, "$1=«redacted»");
  message = message.replace(/([?&](?:access_token|refresh_token|id_token|token|api_key|key|client_secret|password|code)=)[^&#\s]*/gi, "$1«redacted»");
  message = message.replace(/["']?\b(request[_ -]?id)["']?\s*[:=]\s*["']?[^"'&\s,;]+["']?/gi, "$1=«request-id»");
  message = message.replace(/\b(?:cf-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "«request-id»");
  return message.replace(/\b\d{6}\b/g, "«otp»").slice(0, 2_000);
}
