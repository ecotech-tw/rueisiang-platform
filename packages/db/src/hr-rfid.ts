import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { HR_RFID_PROTOCOL_CODE, hrEmployeeRfidCards, hrRfidEnrollmentSessions } from "./schema/hr-rfid.js";
import { hrEmployments } from "./schema/hr-people.js";

export class HrRfidError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

export interface HrRfidCard {
  id: string;
  employmentId: string;
  cardCode: string;
  protocolCode: string;
  linkedAt: string;
}

export interface HrRfidEnrollment {
  id: string;
  employmentId: string;
  status: "listening" | "captured" | "confirmed" | "cancelled" | "expired";
  candidateCardCode: string | null;
  candidateProtocolCode: string | null;
  deviceId: string | null;
  startedAt: string;
  expiresAt: string;
  scannedAt: string | null;
  finishedAt: string | null;
}

export function parseHrRfidPacket(rawPacket: string) {
  const match = /^([0-9A-Fa-f]{4}) ([0-9A-Fa-f]{8})\r?\n?$/.exec(rawPacket);
  if (!match || match[1]!.toUpperCase() !== HR_RFID_PROTOCOL_CODE) return null;
  return { protocolCode: HR_RFID_PROTOCOL_CODE, cardCode: match[2]!.toUpperCase() };
}

async function activeEmployment(db: Database, employmentId: string) {
  const [employment] = await db.select({ id: hrEmployments.id, personKind: hrEmployments.personKind, archivedAt: hrEmployments.archivedAt })
    .from(hrEmployments).where(eq(hrEmployments.id, employmentId)).limit(1);
  if (!employment || employment.personKind !== "employee") throw new HrRfidError(404, "找不到正式員工任職資料。");
  if (employment.archivedAt !== null) throw new HrRfidError(409, "未在職員工不能開通 RFID 卡片。");
  return employment;
}

export async function getHrRfidCard(db: Database, employmentId: string): Promise<HrRfidCard | null> {
  const [employment] = await db.select({ id: hrEmployments.id, personKind: hrEmployments.personKind }).from(hrEmployments).where(eq(hrEmployments.id, employmentId)).limit(1);
  if (!employment || employment.personKind !== "employee") throw new HrRfidError(404, "找不到正式員工任職資料。");
  const [row] = await db.select({ id: hrEmployeeRfidCards.id, employmentId: hrEmployeeRfidCards.employmentId, cardCode: hrEmployeeRfidCards.cardCode, protocolCode: hrEmployeeRfidCards.protocolCode, linkedAt: hrEmployeeRfidCards.linkedAt })
    .from(hrEmployeeRfidCards).innerJoin(hrEmployments, eq(hrEmployments.id, hrEmployeeRfidCards.employmentId))
    .where(and(eq(hrEmployeeRfidCards.employmentId, employmentId), isNull(hrEmployeeRfidCards.revokedAt), eq(hrEmployments.personKind, "employee"))).limit(1);
  return row ?? null;
}

export async function beginHrRfidEnrollment(db: Database, employmentId: string, actor: HrActor) {
  await activeEmployment(db, employmentId);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 120_000).toISOString().slice(0, 19).replace("T", " ");
  try {
    await writeHrMutation(db, [
      sql`UPDATE hr_rfid_enrollment_sessions SET status='expired', finished_at=CURRENT_TIMESTAMP WHERE status='listening' AND expires_at <= CURRENT_TIMESTAMP`,
      sql`INSERT INTO hr_rfid_enrollment_sessions (id, employment_id, status, started_by, expires_at)
        SELECT ${sessionId}, ${employmentId}, 'listening', ${actor.id}, ${expiresAt}
        WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${employmentId} AND person_kind='employee' AND archived_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM hr_rfid_enrollment_sessions WHERE status='listening')
        RETURNING id`,
    ], employmentId, actor, "employee_rfid_enrollment_started", "已有其他員工正在感應綁卡，請先完成或取消該操作。", {
      allowEmptyMutationIndexes: new Set([0]),
      activity: { summary: "開始 RFID 卡片綁定" },
    });
  } catch (error) {
    if (error instanceof HrError) throw new HrRfidError(error.status, error.message);
    throw error;
  }
  return { sessionId, expiresAt };
}

export async function getHrRfidEnrollment(db: Database, employmentId: string, sessionId: string): Promise<HrRfidEnrollment> {
  const [row] = await db.select({
    id: hrRfidEnrollmentSessions.id,
    employmentId: hrRfidEnrollmentSessions.employmentId,
    status: hrRfidEnrollmentSessions.status,
    candidateCardCode: hrRfidEnrollmentSessions.candidateCardCode,
    candidateProtocolCode: hrRfidEnrollmentSessions.candidateProtocolCode,
    deviceId: hrRfidEnrollmentSessions.deviceId,
    startedAt: hrRfidEnrollmentSessions.startedAt,
    expiresAt: hrRfidEnrollmentSessions.expiresAt,
    scannedAt: hrRfidEnrollmentSessions.scannedAt,
    finishedAt: hrRfidEnrollmentSessions.finishedAt,
  }).from(hrRfidEnrollmentSessions)
    .where(and(eq(hrRfidEnrollmentSessions.id, sessionId), eq(hrRfidEnrollmentSessions.employmentId, employmentId))).limit(1);
  if (!row) throw new HrRfidError(404, "找不到 RFID 綁定操作。");
  if ((row.status === "listening" || row.status === "captured") && row.expiresAt <= new Date().toISOString().slice(0, 19).replace("T", " ")) {
    await db.update(hrRfidEnrollmentSessions).set({ status: "expired", finishedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(hrRfidEnrollmentSessions.id, sessionId), sql`${hrRfidEnrollmentSessions.status} IN ('listening', 'captured')`));
    return { ...row, status: "expired", finishedAt: new Date().toISOString().slice(0, 19).replace("T", " ") };
  }
  return row;
}

export async function captureHrRfidScan(db: Database, input: { deviceId: string; rawPacket: string }) {
  const parsed = parseHrRfidPacket(input.rawPacket);
  if (!parsed) throw new HrRfidError(400, "讀卡資料格式無法辨識，請保留原始資料並確認 Reader 協定。");
  const [captured] = await db.update(hrRfidEnrollmentSessions).set({
    status: "captured",
    candidateCardCode: parsed.cardCode,
    candidateProtocolCode: parsed.protocolCode,
    deviceId: input.deviceId,
    scannedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(hrRfidEnrollmentSessions.status, "listening"),
    sql`${hrRfidEnrollmentSessions.expiresAt} > CURRENT_TIMESTAMP`,
  )).returning({ id: hrRfidEnrollmentSessions.id });
  return { captured: Boolean(captured), sessionId: captured?.id ?? null };
}

export async function cancelHrRfidEnrollment(db: Database, employmentId: string, sessionId: string, actor: HrActor) {
  try {
    await writeHrMutation(db, sql`UPDATE hr_rfid_enrollment_sessions
      SET status='cancelled', finished_at=CURRENT_TIMESTAMP
      WHERE id=${sessionId} AND employment_id=${employmentId} AND status IN ('listening', 'captured')
      RETURNING id`, employmentId, actor, "employee_rfid_enrollment_cancelled", "綁卡操作已結束，請重新整理後再試。", {
      activity: { summary: "取消 RFID 卡片綁定" },
    });
  } catch (error) {
    if (error instanceof HrError) throw new HrRfidError(error.status, error.message);
    throw error;
  }
  return { id: sessionId };
}

export async function confirmHrRfidEnrollment(db: Database, employmentId: string, sessionId: string, actor: HrActor) {
  const session = await getHrRfidEnrollment(db, employmentId, sessionId);
  if (session.status === "confirmed" && session.candidateCardCode) {
    const card = await getHrRfidCard(db, employmentId);
    if (card?.cardCode === session.candidateCardCode) return { card, idempotent: true };
  }
  if (session.status !== "captured" || !session.candidateCardCode || !session.candidateProtocolCode) {
    throw new HrRfidError(409, "尚未收到可確認的卡片感應資料，請重新感應。");
  }
  await activeEmployment(db, employmentId);
  const cardId = crypto.randomUUID();
  try {
    await writeHrMutation(db, [
      sql`UPDATE hr_employee_rfid_cards SET revoked_at=CURRENT_TIMESTAMP, revoked_by=${actor.id}
        WHERE employment_id=${employmentId} AND revoked_at IS NULL`,
      sql`INSERT INTO hr_employee_rfid_cards (id, employment_id, card_code, protocol_code, linked_by)
        SELECT ${cardId}, ${employmentId}, ${session.candidateCardCode}, ${session.candidateProtocolCode}, ${actor.id}
        WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${employmentId} AND person_kind='employee' AND archived_at IS NULL)
          AND EXISTS (SELECT 1 FROM hr_rfid_enrollment_sessions WHERE id=${sessionId} AND employment_id=${employmentId} AND status='captured' AND candidate_card_code=${session.candidateCardCode})
          AND NOT EXISTS (SELECT 1 FROM hr_employee_rfid_cards WHERE card_code=${session.candidateCardCode} AND revoked_at IS NULL AND employment_id<>${employmentId})
        RETURNING id`,
      sql`UPDATE hr_rfid_enrollment_sessions SET status='confirmed', finished_at=CURRENT_TIMESTAMP
        WHERE id=${sessionId} AND employment_id=${employmentId} AND status='captured' AND candidate_card_code=${session.candidateCardCode}
        RETURNING id`,
    ], employmentId, actor, "employee_rfid_card_bound", "卡片已被其他員工使用，或綁定資料已變更，請重新整理後再試。", {
      allowEmptyMutationIndexes: new Set([0]),
      activity: { summary: "綁定員工 RFID 卡片", payload: { action: "bound", cardId } },
    });
  } catch (error) {
    if (error instanceof HrError) throw new HrRfidError(error.status, error.message);
    throw error;
  }
  const card = await getHrRfidCard(db, employmentId);
  if (!card) throw new HrRfidError(409, "卡片綁定未完成，請重新整理後再試。");
  return { card, idempotent: false };
}

export async function revokeHrRfidCard(db: Database, employmentId: string, actor: HrActor) {
  try {
    await writeHrMutation(db, sql`UPDATE hr_employee_rfid_cards SET revoked_at=CURRENT_TIMESTAMP, revoked_by=${actor.id}
      WHERE employment_id=${employmentId} AND revoked_at IS NULL RETURNING id`, employmentId, actor,
    "employee_rfid_card_revoked", "卡片已解除或資料已變更，請重新整理後再試。", {
      activity: { summary: "解除員工 RFID 卡片" },
    });
  } catch (error) {
    if (error instanceof HrError) throw new HrRfidError(error.status, error.message);
    throw error;
  }
  return { id: employmentId };
}
