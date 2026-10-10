import {
  DEVICE_SESSION_IDLE_SECONDS,
  DEVICE_SESSION_REUSE_GRACE_SECONDS,
  DEVICE_SESSION_ROTATE_SECONDS,
  hashDeviceSecret,
  newDeviceToken,
  parseDeviceToken,
  type DeviceToken,
} from "@rueisiang/auth";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import type { LineAccountIdentity } from "./line-liff.js";
import { authDeviceSessions } from "./schema/auth.js";

const USER_AGENT_MAX_LENGTH = 200;

export type DeviceSessionAuthMethod = "device" | "line_liff";

function secondsLater(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

/** 發一台新裝置。回傳的 token 只有這一次拿得到明文，資料庫只留雜湊。 */
export async function createDeviceSession(
  db: Database,
  userId: string,
  userAgent: string,
  options: { now?: Date } = {},
): Promise<DeviceToken> {
  const now = options.now ?? new Date();
  const token = newDeviceToken();
  await db.insert(authDeviceSessions).values({
    id: token.id,
    userId,
    tokenHash: await hashDeviceSecret(token.secret),
    userAgent: userAgent.slice(0, USER_AGENT_MAX_LENGTH),
    authMethod: "device",
    rotatedAt: now.toISOString(),
    expiresAt: secondsLater(now, DEVICE_SESSION_IDLE_SECONDS),
  });
  return token;
}

/** 發證與目前 LINE 關聯在同一 SQL 判定，避免解除／替換完成後舊請求補發憑證。 */
export async function createLineLiffSession(
  db: Database,
  userId: string,
  userAgent: string,
  identity: LineAccountIdentity,
  now = new Date(),
): Promise<DeviceToken | null> {
  const token = newDeviceToken();
  const tokenHash = await hashDeviceSecret(token.secret);
  const rows = await db.all<{ id: string }>(sql`INSERT INTO auth_device_sessions
    (id, user_id, token_hash, user_agent, auth_method, rotated_at, expires_at)
    SELECT ${token.id}, ${userId}, ${tokenHash}, ${userAgent.slice(0, USER_AGENT_MAX_LENGTH)}, 'line_liff',
      ${now.toISOString()}, ${secondsLater(now, DEVICE_SESSION_IDLE_SECONDS)}
    WHERE EXISTS (SELECT 1 FROM auth_line_account_links
      WHERE user_id = ${userId} AND channel_id = ${identity.channelId} AND line_user_id = ${identity.lineUserId})
    RETURNING id`);
  return rows.length ? token : null;
}

export interface DeviceSessionUse {
  userId: string;
  authMethod: DeviceSessionAuthMethod;
  /** 這次換了新的 secret 時才有值，呼叫端要把它寫回 cookie。 */
  renewed: DeviceToken | null;
}

async function revokeById(db: Database, id: string, now: Date): Promise<void> {
  await db
    .update(authDeviceSessions)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(authDeviceSessions.id, id), isNull(authDeviceSessions.revokedAt)));
}

/**
 * 驗證裝置 token，必要時順便換新的 secret（同時把閒置期限往後推）。
 *
 * 這裡**不檢查帳號狀態**：跟 session 一樣，停權與權限由 requireAuth 每次回 DB 讀。
 */
export async function useDeviceSession(
  db: Database,
  raw: string | undefined,
  now = new Date(),
): Promise<DeviceSessionUse | null> {
  const token = parseDeviceToken(raw);
  if (!token) return null;

  const [row] = await db.select().from(authDeviceSessions).where(eq(authDeviceSessions.id, token.id)).limit(1);
  if (!row || row.revokedAt || Date.parse(row.expiresAt) <= now.getTime()) return null;

  const hash = await hashDeviceSecret(token.secret);
  const sinceRotation = (now.getTime() - Date.parse(row.rotatedAt)) / 1000;

  if (hash === row.tokenHash) {
    if (sinceRotation < DEVICE_SESSION_ROTATE_SECONDS) return { userId: row.userId, authMethod: row.authMethod, renewed: null };

    const renewed = newDeviceToken();
    /*
     * 條件裡帶著舊的 tokenHash：同一頁同時發的幾個請求都會走到這裡，
     * 只有第一個換得成功。其他幾個不寫 cookie，瀏覽器會留下第一個換到的值；
     * 否則資料庫跟 cookie 可能各留一個不同的新值，下一個請求就被踢掉。
     */
    const updated = await db
      .update(authDeviceSessions)
      .set({
        tokenHash: await hashDeviceSecret(renewed.secret),
        previousTokenHash: hash,
        rotatedAt: now.toISOString(),
        expiresAt: secondsLater(now, DEVICE_SESSION_IDLE_SECONDS),
      })
      .where(and(eq(authDeviceSessions.id, row.id), eq(authDeviceSessions.tokenHash, hash)))
      .returning({ id: authDeviceSessions.id });
    return { userId: row.userId, authMethod: row.authMethod, renewed: updated.length ? { id: row.id, secret: renewed.secret } : null };
  }

  if (hash === row.previousTokenHash && sinceRotation <= DEVICE_SESSION_REUSE_GRACE_SECONDS) {
    return { userId: row.userId, authMethod: row.authMethod, renewed: null };
  }

  // 過了緩衝還拿舊值來，代表有兩個地方持有同一台裝置的憑證：整台撤銷，逼真正的主人重新登入。
  await revokeById(db, row.id, now);
  return null;
}

/** 登出這台裝置。token 無效時什麼都不做，登出不應該因為 cookie 壞了而失敗。 */
export async function revokeDeviceSession(db: Database, raw: string | undefined, now = new Date()): Promise<void> {
  const token = parseDeviceToken(raw);
  if (token) await revokeById(db, token.id, now);
}

/** 撤銷某人所有記住的裝置。停權時呼叫，免得重新啟用時舊手機跟著復活。 */
export async function revokeUserDeviceSessions(db: Database, userId: string, now = new Date()): Promise<void> {
  await db
    .update(authDeviceSessions)
    .set({ revokedAt: now.toISOString() })
    .where(and(eq(authDeviceSessions.userId, userId), isNull(authDeviceSessions.revokedAt)));
}
