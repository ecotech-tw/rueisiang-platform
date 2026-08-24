import { desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { shopeeSalesRuns, shopeeSalesSettings } from "./schema/tools.js";

const SETTINGS_ID = "default";

export interface ShopeeSalesSettingsInput {
  driveFolderUrl: string;
  driveFolderName: string;
}

export async function getShopeeSalesSettings(db: Database) {
  const [row] = await db
    .select()
    .from(shopeeSalesSettings)
    .where(eq(shopeeSalesSettings.id, SETTINGS_ID))
    .limit(1);
  return row ?? {
    id: SETTINGS_ID,
    driveFolderUrl: "",
    driveFolderName: "",
    updatedAt: "",
  };
}

export async function saveShopeeSalesSettings(
  db: Database,
  input: ShopeeSalesSettingsInput,
): Promise<void> {
  await db
    .insert(shopeeSalesSettings)
    .values({ id: SETTINGS_ID, ...input })
    .onConflictDoUpdate({
      target: shopeeSalesSettings.id,
      set: { ...input, updatedAt: new Date().toISOString() },
    });
}

export async function recordShopeeSalesRun(
  db: Database,
  input: {
    requestId: string;
    startDate: string;
    endDate: string;
    driveFolderUrl: string;
    actor: { id: string; email: string };
  },
): Promise<void> {
  await db.insert(shopeeSalesRuns).values({
    id: crypto.randomUUID(),
    requestId: input.requestId,
    startDate: input.startDate,
    endDate: input.endDate,
    driveFolderUrl: input.driveFolderUrl,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
  });
}

export async function listShopeeSalesRuns(db: Database, limit = 10) {
  return db.select().from(shopeeSalesRuns).orderBy(desc(shopeeSalesRuns.createdAt)).limit(limit);
}
