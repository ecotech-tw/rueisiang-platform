import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrCompensationVersions, hrInsuranceVersions } from "./schema/hr-payroll.js";

export type HrInsuranceScheme = "labor" | "health";
export type HrInsuranceBracket = {
  level: number;
  lowerSalary: number;
  upperSalary: number | null;
  insuredAmount: number;
};

export interface HrInsuranceBracketTable {
  scheme: HrInsuranceScheme;
  year: number;
  sourceUrl: string;
  fetchedAt: string;
  brackets: HrInsuranceBracket[];
}

export class HrInsuranceRateError extends Error {}

const OFFICIAL_SOURCES: Record<number, Record<HrInsuranceScheme, string>> = {
  // 115 年資料資源由勞動部與健保署的政府資料開放 API 提供；下一年度發布後只需更新
  // 這個資源索引，不把法定級距複製成另一份容易過期的前端常數。
  2026: {
    labor: "https://apiservice.mol.gov.tw/OdService/download/A17000000J-020014-rpF",
    health: "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-B1000A-00G",
  },
};

function numberValue(value: string): number {
  const parsed = Number(value.replaceAll(",", "").replaceAll("元", "").trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HrInsuranceRateError("官方級距資料格式不正確。");
  return parsed;
}

function salaryRange(value: string): { lowerSalary: number; upperSalary: number | null } {
  const numbers = [...value.matchAll(/\d[\d,]*/g)].map((match) => numberValue(match[0]));
  if (!numbers.length) throw new HrInsuranceRateError("官方級距資料缺少薪資範圍。");
  if (/以下/.test(value)) return { lowerSalary: 0, upperSalary: numbers[0]! };
  if (/以上/.test(value)) return { lowerSalary: numbers[0]!, upperSalary: null };
  if (numbers.length < 2) throw new HrInsuranceRateError("官方級距資料的薪資範圍不完整。");
  return { lowerSalary: numbers[0]!, upperSalary: numbers[1]! };
}

function parseLaborRows(value: unknown, sourceUrl: string, year: number): HrInsuranceBracketTable {
  if (!Array.isArray(value)) throw new HrInsuranceRateError("勞動部級距資料格式不正確。");
  const rows = value.filter((row): row is Record<string, string> => Boolean(row) && typeof row === "object" && (row as Record<string, unknown>)["身分別"] === "一般勞工");
  const brackets = rows.map((row) => ({
    level: numberValue(row["投保薪資等級"] ?? ""),
    ...salaryRange(row["月薪資總額"] ?? ""),
    insuredAmount: numberValue(row["月投保薪資"] ?? ""),
  }));
  if (!brackets.length) throw new HrInsuranceRateError("勞動部級距資料沒有一般勞工級距。");
  return { scheme: "labor", year, sourceUrl, fetchedAt: new Date().toISOString(), brackets };
}

function csvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && value[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((part) => part.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function parseHealthCsv(value: string, sourceUrl: string, year: number): HrInsuranceBracketTable {
  const rows = csvRows(value.replace(/^\uFEFF/, ""));
  const header = rows[0] ?? [];
  const insuredIndex = header.findIndex((part) => part.includes("月投保金額"));
  const salaryIndex = header.findIndex((part) => part.includes("實際薪資月額"));
  const levelIndex = header.findIndex((part) => part.includes("投保等級"));
  if (insuredIndex < 0 || salaryIndex < 0 || levelIndex < 0) throw new HrInsuranceRateError("健保署級距資料欄位不正確。");
  const brackets = rows.slice(1).map((row) => ({
    level: numberValue(row[levelIndex] ?? ""),
    ...salaryRange(row[salaryIndex] ?? ""),
    insuredAmount: numberValue(row[insuredIndex] ?? ""),
  }));
  if (!brackets.length) throw new HrInsuranceRateError("健保署級距資料沒有級距。");
  return { scheme: "health", year, sourceUrl, fetchedAt: new Date().toISOString(), brackets };
}

/** 從官方開放資料即時取得級距；資料失敗時不自行猜測法定金額。 */
export async function fetchHrInsuranceBrackets(year: number, fetcher: typeof fetch = fetch): Promise<HrInsuranceBracketTable[]> {
  const sources = OFFICIAL_SOURCES[year];
  if (!sources) throw new HrInsuranceRateError(`尚未設定民國 ${year - 1911} 年的官方級距資料來源。`);
  const results = await Promise.all((Object.entries(sources) as [HrInsuranceScheme, string][]).map(async ([scheme, url]) => {
    const response = await fetcher(url, { headers: { Accept: "application/json, text/csv" } });
    if (!response.ok) throw new HrInsuranceRateError(`官方${scheme === "labor" ? "勞保" : "健保"}級距服務回應 ${response.status}。`);
    const text = await response.text();
    try {
      return scheme === "labor" ? parseLaborRows(JSON.parse(text) as unknown, url, year) : parseHealthCsv(text, url, year);
    } catch (error) {
      if (error instanceof HrInsuranceRateError) throw error;
      throw new HrInsuranceRateError(`官方${scheme === "labor" ? "勞保" : "健保"}級距資料無法解析。`);
    }
  }));
  return results;
}

export interface HrCompensationInput {
  employmentId: string;
  validFrom: string;
  validTo: string | null;
  payBasis: "monthly" | "daily" | "hourly";
  baseAmountMinor: number;
  note: string;
}

export async function createHrCompensationVersion(db: Database, input: HrCompensationInput, actor: HrActor) {
  const [current] = await db.select({ id: hrCompensationVersions.id, validFrom: hrCompensationVersions.validFrom }).from(hrCompensationVersions)
    .where(and(eq(hrCompensationVersions.employmentId, input.employmentId), sql`${hrCompensationVersions.validTo} IS NULL`))
    .orderBy(desc(hrCompensationVersions.validFrom)).limit(1);
  const id = crypto.randomUUID();
  const closePrevious = current && current.validFrom < input.validFrom
    ? [sql`UPDATE hr_compensation_versions SET valid_to=${input.validFrom}
      WHERE id=${current.id} AND valid_to IS NULL AND valid_from < ${input.validFrom} RETURNING id`]
    : [];
  const insert = sql`INSERT INTO hr_compensation_versions
    (id, employment_id, version_number, valid_from, valid_to, pay_basis, base_amount_minor, note, created_by)
    SELECT ${id}, ${input.employmentId}, coalesce((SELECT max(version_number) + 1 FROM hr_compensation_versions WHERE employment_id=${input.employmentId}), 1),
      ${input.validFrom}, ${input.validTo}, ${input.payBasis}, ${input.baseAmountMinor}, ${input.note}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId}
      AND hired_on <= ${input.validFrom} AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
      AND NOT EXISTS (SELECT 1 FROM hr_compensation_versions WHERE employment_id=${input.employmentId}
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`;
  return writeHrMutation(db, [...closePrevious, insert], id, actor, "compensation_version_created", "任職不存在、薪資期間重疊或資料不合法，請重新整理。");
}

async function applyInsuranceMutation(db: Database, mutations: SQL[], id: string, actor: HrActor) {
  const row = activityRow({ entityType: "hr_personnel", entityId: id, source: "hr", eventType: "insurance_version_created", summary: "人事資料異動", actor });
  const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
  const statements = [...mutations, sql`INSERT INTO activity_events (id, entity_type, entity_id, event_type, summary, source, actor_type, actor_id, actor_email)
    SELECT ${row.id}, ${row.entityType}, ${row.entityId}, ${row.eventType}, ${row.summary}, ${row.source}, ${row.actorType}, ${row.actorId}, ${row.actorEmail}
    WHERE changes() = 1`].map((query) => {
    const compiled = dialect.sqlToQuery(query);
    return db.$client.prepare(compiled.sql).bind(...compiled.params);
  });
  try {
    const results = await db.$client.batch(statements);
    // 最後一個真正 mutation 永遠是 INSERT；關閉上一版沒有資料時是合法的。
    const inserted = results[mutations.length - 1];
    if (!inserted?.results.length) throw new HrError(409, "保險版本已變更、期間重疊或資料不合法，請重新整理。 ");
    return { id };
  } catch (error) {
    if (error instanceof HrError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed/.test(error.message)) {
      throw new HrError(409, "保險版本已變更、期間重疊或資料不合法，請重新整理。");
    }
    throw error;
  }
}

export interface HrInsuranceInput {
  employmentId: string;
  scheme: HrInsuranceScheme;
  status: "enrolled" | "withdrawn";
  validFrom: string;
  validTo: string | null;
  insuredAmountMinor: number;
  dependentCount: number;
  rateYear: number;
  sourceKind: "official" | "manual";
  sourceUrl: string;
  note: string;
}

/** 新狀態與關閉前一個開放版本放在同一個 D1 batch，避免歷史出現半截。 */
export async function createHrInsuranceVersion(db: Database, input: HrInsuranceInput, actor: HrActor) {
  const [current] = await db.select({ id: hrInsuranceVersions.id, validFrom: hrInsuranceVersions.validFrom }).from(hrInsuranceVersions)
    .where(and(eq(hrInsuranceVersions.employmentId, input.employmentId), eq(hrInsuranceVersions.scheme, input.scheme), sql`${hrInsuranceVersions.validTo} IS NULL`))
    .orderBy(desc(hrInsuranceVersions.validFrom)).limit(1);
  const id = crypto.randomUUID();
  const closePrevious = current && current.validFrom < input.validFrom
    ? [sql`UPDATE hr_insurance_versions SET valid_to=${input.validFrom}
      WHERE id=${current.id} AND valid_to IS NULL AND valid_from < ${input.validFrom} RETURNING id`]
    : [];
  const insert = sql`INSERT INTO hr_insurance_versions
    (id, employment_id, scheme, version_number, status, valid_from, valid_to, insured_amount_minor, dependent_count, rate_year, source_kind, source_url, note, created_by)
    SELECT ${id}, ${input.employmentId}, ${input.scheme}, coalesce((SELECT max(version_number) + 1 FROM hr_insurance_versions WHERE employment_id=${input.employmentId} AND scheme=${input.scheme}), 1),
      ${input.status}, ${input.validFrom}, ${input.validTo}, ${input.insuredAmountMinor}, ${input.dependentCount}, ${input.rateYear}, ${input.sourceKind}, ${input.sourceUrl}, ${input.note}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId}
      AND hired_on <= ${input.validFrom} AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
      AND NOT EXISTS (SELECT 1 FROM hr_insurance_versions WHERE employment_id=${input.employmentId} AND scheme=${input.scheme}
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`;
  return applyInsuranceMutation(db, [...closePrevious, insert], id, actor);
}
