/** 依申請對象保留互斥 ID 欄位，避免把支援人員 ID 誤送成正式員工 userId。 */
export function buildOvertimeSubmission(input: {
  targetKind: "employee" | "worker";
  employeeUserId: string;
  workerId: string;
  mode: "single" | "multiple";
  requestedStart: string;
  requestedEnd: string;
  settlementKind: "pay" | "compensatory";
  reason: string;
  entries: Array<{ requestedStart: string; requestedEnd: string }>;
}) {
  const target = input.targetKind === "worker" ? { workerId: input.workerId } : { employeeUserId: input.employeeUserId };
  const shared = { ...target, settlementKind: input.settlementKind, reason: input.reason };
  return input.mode === "single"
    ? { path: "/requests/overtime", method: "POST" as const, values: { ...shared, requestedStart: input.requestedStart, requestedEnd: input.requestedEnd } }
    : { path: "/requests/overtime/batch", method: "POST" as const, values: { ...shared, entries: input.entries } };
}
