import { and, eq, isNull, ne, notExists, sql, type SQL } from "drizzle-orm";
import type { Database } from "./client.js";
import { authDeviceSessions, authLineAccountLinks } from "./schema/auth.js";

export interface LineAccountIdentity {
  channelId: string;
  lineUserId: string;
}

export async function findUserByLineIdentity(db: Database, identity: LineAccountIdentity): Promise<string | null> {
  const [link] = await db.select({ userId: authLineAccountLinks.userId })
    .from(authLineAccountLinks)
    .where(and(
      eq(authLineAccountLinks.channelId, identity.channelId),
      eq(authLineAccountLinks.lineUserId, identity.lineUserId),
    ))
    .limit(1);
  return link?.userId ?? null;
}

export async function getLineAccountLink(db: Database, userId: string) {
  const [link] = await db.select({ channelId: authLineAccountLinks.channelId, linkedAt: authLineAccountLinks.linkedAt })
    .from(authLineAccountLinks)
    .where(eq(authLineAccountLinks.userId, userId))
    .limit(1);
  return link ?? null;
}

/** 資料庫唯一索引仲裁並行綁定；同一帳號重送相同 identity 視為成功。 */
export async function linkLineAccount(db: Database, userId: string, identity: LineAccountIdentity): Promise<"created" | "existing" | "conflict"> {
  const inserted = await db.insert(authLineAccountLinks).values({
    userId,
    channelId: identity.channelId,
    lineUserId: identity.lineUserId,
  }).onConflictDoNothing().returning({ userId: authLineAccountLinks.userId });
  if (inserted.length) return "created";

  const [current] = await db.select({ channelId: authLineAccountLinks.channelId, lineUserId: authLineAccountLinks.lineUserId })
    .from(authLineAccountLinks)
    .where(eq(authLineAccountLinks.userId, userId))
    .limit(1);
  return current?.channelId === identity.channelId && current.lineUserId === identity.lineUserId ? "existing" : "conflict";
}

function lineSessionRevocation(db: Database, userId: string, guard?: SQL) {
  return db.update(authDeviceSessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(
      eq(authDeviceSessions.userId, userId),
      eq(authDeviceSessions.authMethod, "line_liff"),
      isNull(authDeviceSessions.revokedAt),
      guard,
    ));
}

/** 關聯替換與撤銷須不可分割；綁定衝突時兩者都不變更。 */
export async function replaceLineAccount(db: Database, userId: string, identity: LineAccountIdentity): Promise<"created" | "replaced" | "existing" | "conflict"> {
  const [current] = await db.select({ channelId: authLineAccountLinks.channelId, lineUserId: authLineAccountLinks.lineUserId })
    .from(authLineAccountLinks)
    .where(eq(authLineAccountLinks.userId, userId))
    .limit(1);
  if (!current) return linkLineAccount(db, userId, identity);
  if (current.channelId === identity.channelId && current.lineUserId === identity.lineUserId) return "existing";

  const conflictingIdentity = db.select({ userId: authLineAccountLinks.userId })
    .from(authLineAccountLinks)
    .where(and(
      eq(authLineAccountLinks.channelId, identity.channelId),
      eq(authLineAccountLinks.lineUserId, identity.lineUserId),
      ne(authLineAccountLinks.userId, userId),
    ));
  const [updated] = await db.batch([
    db.update(authLineAccountLinks)
      .set({ channelId: identity.channelId, lineUserId: identity.lineUserId, linkedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(authLineAccountLinks.userId, userId), notExists(conflictingIdentity)))
      .returning({ userId: authLineAccountLinks.userId }),
    lineSessionRevocation(db, userId, sql`changes() = 1`),
  ]);
  return updated.length ? "replaced" : "conflict";
}

export async function unlinkLineAccount(db: Database, userId: string): Promise<boolean> {
  const [rows] = await db.batch([
    db.delete(authLineAccountLinks)
      .where(eq(authLineAccountLinks.userId, userId))
      .returning({ userId: authLineAccountLinks.userId }),
    lineSessionRevocation(db, userId),
  ]);
  return rows.length > 0;
}
