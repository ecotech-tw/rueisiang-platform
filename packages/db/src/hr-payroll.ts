import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.js";
import { HrError, writeHrMutation, type HrActor } from "./hr-people.js";
import { hrCompensationVersions, hrInsuranceContributionRules, hrInsuranceRateTables, hrInsuranceVersions } from "./schema/hr-payroll.js";

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
    health: "https://info.nhi.gov.tw/api/iode0000s01/Dataset?rId=A21030000I-B1000A-00B",
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
  items?: Array<{ itemName: string; amountMinor: number; itemKind: "fixed" | "variable"; amountBasis: "monthly" | "daily" | "hourly"; includeOvertime: boolean; includeInsurance: boolean; includeTax: boolean }>;
}

function validateCompensationInput(input: HrCompensationInput) {
  if (!isDateOnly(input.validFrom) || (input.validTo !== null && (!isDateOnly(input.validTo) || input.validTo <= input.validFrom))) throw new HrError(400, "敘薪生效／迄日不正確。 ");
  if (!Number.isSafeInteger(input.baseAmountMinor) || input.baseAmountMinor < 0 || input.note.length > 1000) throw new HrError(400, "敘薪資料不正確。 ");
  if (input.items && (input.items.length > 50 || input.items.some((item) => !item.itemName.trim() || item.itemName.length > 100 || !Number.isSafeInteger(item.amountMinor) || item.amountMinor < 0 || (item.itemKind !== "fixed" && item.itemKind !== "variable") || !["monthly", "daily", "hourly"].includes(item.amountBasis) || typeof item.includeOvertime !== "boolean" || typeof item.includeInsurance !== "boolean" || typeof item.includeTax !== "boolean"))) throw new HrError(400, "薪資項目不正確。 ");
  if (input.items) {
    const itemNames = input.items.map((item) => item.itemName.trim());
    if (new Set(itemNames).size !== itemNames.length) throw new HrError(400, "同一敘薪版本不可有重複的薪資項目名稱。 ");
  }
}

function compensationItemStatements(versionId: string, items: HrCompensationInput["items"], actor: HrActor) {
  return (items ?? []).map((item) => {
    const itemId = crypto.randomUUID();
    return sql`INSERT INTO hr_compensation_items (id, compensation_version_id, item_name, amount_minor, item_kind, amount_basis, include_overtime, include_insurance, include_tax, created_by)
      VALUES (${itemId}, ${versionId}, ${item.itemName.trim()}, ${item.amountMinor}, ${item.itemKind}, ${item.amountBasis}, ${item.includeOvertime ? 1 : 0}, ${item.includeInsurance ? 1 : 0}, ${item.includeTax ? 1 : 0}, ${actor.id}) RETURNING id`;
  });
}

export async function createHrCompensationVersion(db: Database, input: HrCompensationInput, actor: HrActor) {
  validateCompensationInput(input);
  const [latest] = await db.select({ id: hrCompensationVersions.id, validFrom: hrCompensationVersions.validFrom, validTo: hrCompensationVersions.validTo, versionNumber: hrCompensationVersions.versionNumber }).from(hrCompensationVersions)
    .where(and(eq(hrCompensationVersions.employmentId, input.employmentId), sql`${hrCompensationVersions.voidedAt} IS NULL`))
    .orderBy(desc(hrCompensationVersions.validFrom), desc(hrCompensationVersions.versionNumber)).limit(1);
  const expectedValidFrom = latest ? nextDate(latest.validFrom) : null;
  if (expectedValidFrom !== null && input.validFrom !== expectedValidFrom) throw new HrError(400, `敘薪更新的生效日必須是 ${expectedValidFrom}；若要修正上一筆，請先解除最新敘薪。 `);
  const current = latest && latest.validTo === null ? latest : undefined;
  const id = crypto.randomUUID();
  const closePrevious = current && current.validFrom < input.validFrom
    ? [sql`UPDATE hr_compensation_versions SET valid_to=${input.validFrom}
      WHERE id=${current.id} AND valid_to IS NULL AND voided_at IS NULL AND valid_from < ${input.validFrom} RETURNING id`]
    : [];
  const insert = sql`INSERT INTO hr_compensation_versions
    (id, employment_id, version_number, valid_from, valid_to, pay_basis, base_amount_minor, note, created_by)
    SELECT ${id}, ${input.employmentId}, coalesce((SELECT max(version_number) + 1 FROM hr_compensation_versions WHERE employment_id=${input.employmentId}), 1),
      ${input.validFrom}, ${input.validTo}, ${input.payBasis}, ${input.baseAmountMinor}, ${input.note}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId}
      AND hired_on <= ${input.validFrom} AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
      AND NOT EXISTS (SELECT 1 FROM hr_compensation_versions WHERE employment_id=${input.employmentId} AND voided_at IS NULL
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`;
  return writeHrMutation(db, [...closePrevious, insert, ...compensationItemStatements(id, input.items, actor)], id, actor, "compensation_version_created", "任職不存在、敘薪更新日期不連續、薪資期間重疊或資料不合法，請重新整理。 ");
}

/** 解除最新敘薪但不刪除資料；重複呼叫可依序撤回到第一版，且不影響既有薪資快照。 */
export async function voidHrCompensationVersion(db: Database, employmentId: string, versionId: string, actor: HrActor) {
  const [version] = await db.select({ id: hrCompensationVersions.id, versionNumber: hrCompensationVersions.versionNumber, validFrom: hrCompensationVersions.validFrom, voidedAt: hrCompensationVersions.voidedAt }).from(hrCompensationVersions)
    .where(and(eq(hrCompensationVersions.id, versionId), eq(hrCompensationVersions.employmentId, employmentId))).limit(1);
  if (!version) throw new HrError(404, "找不到這個敘薪版本。 ");
  if (version.voidedAt !== null) throw new HrError(409, "這個敘薪版本已經解除。 ");
  const [latest] = await db.select({ id: hrCompensationVersions.id }).from(hrCompensationVersions)
    .where(and(eq(hrCompensationVersions.employmentId, employmentId), sql`${hrCompensationVersions.voidedAt} IS NULL`)).orderBy(desc(hrCompensationVersions.validFrom), desc(hrCompensationVersions.versionNumber)).limit(1);
  if (latest?.id !== version.id) throw new HrError(409, "只能解除最新的敘薪版本；歷史薪資請保留不變。請先依序解除較新的版本。 ");
  await writeHrMutation(db, sql`UPDATE hr_compensation_versions SET voided_at=CURRENT_TIMESTAMP, voided_by=${actor.id}
    WHERE id=${versionId} AND employment_id=${employmentId} AND voided_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM hr_compensation_versions AS newer
        WHERE newer.employment_id=${employmentId} AND newer.voided_at IS NULL
          AND (newer.valid_from > ${version.validFrom} OR (newer.valid_from = ${version.validFrom} AND newer.version_number > ${version.versionNumber})))
    RETURNING id`, versionId, actor, "compensation_version_voided", "敘薪版本已被其他人變更，請重新整理。 ");
  return { id: versionId, status: "voided" as const };
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
export interface HrInsuranceContributionInput {
  scheme: HrInsuranceScheme; validFrom: string; validTo: string | null; employeeRatePpm: number; employerRatePpm: number; dependentRatePpm: number; sourceKind: "official" | "manual"; note: string;
}
export interface HrInsuranceContributionRuleRecord {
  id: string; scheme: HrInsuranceScheme; validFrom: string; validTo: string | null; employeeRatePpm: number; employerRatePpm: number; dependentRatePpm: number; sourceKind: "official" | "manual"; note: string;
  createdBy?: string; createdAt?: string; sourceUrl?: string; isSystemDefault?: boolean;
}

/*
 * 一般受僱者的法定分攤比例由系統提供，不需要每家公司重新輸入。
 * 115 年（2026）標準：勞保普通事故 11.5%＋就業保險 1%，勞工負擔 20%；
 * 健保 5.17%，受僱者負擔 30%，眷屬按本人保費 100% 計。職災保險與特殊身分
 * 不在這個一般受僱者預設內；若公司適用特殊規則，仍可在制度設定建立覆核版本。
 */
const SYSTEM_INSURANCE_CONTRIBUTION_RULES: HrInsuranceContributionRuleRecord[] = [
  {
    id: "system-insurance-contribution-labor-2026", scheme: "labor", validFrom: "2026-01-01", validTo: null,
    employeeRatePpm: 25_000, employerRatePpm: 87_500, dependentRatePpm: 0, sourceKind: "official",
    sourceUrl: "https://www.bli.gov.tw/0102422.html", note: "系統預設／一般受僱者：勞保普通事故 11.5%＋就業保險 1%，勞工負擔 20%；職災保險另計。", isSystemDefault: true,
  },
  {
    id: "system-insurance-contribution-health-2026", scheme: "health", validFrom: "2026-01-01", validTo: null,
    employeeRatePpm: 15_510, employerRatePpm: 31_020, dependentRatePpm: 1_000_000, sourceKind: "official",
    sourceUrl: "https://www.nhi.gov.tw/ch/cp-19418-9eefb-2576-1.html", note: "系統預設／一般受僱者：健保費率 5.17%，受僱者負擔 30%，眷屬按本人保費 100% 計。", isSystemDefault: true,
  },
];

export interface HrInsuranceEstimateVersionInput {
  scheme: HrInsuranceScheme; status: "enrolled" | "withdrawn"; insuredAmountMinor: number; dependentCount: number;
}
export interface HrInsuranceContributionEstimate {
  scheme: HrInsuranceScheme; status: "enrolled" | "withdrawn"; insuredAmountMinor: number; dependentCount: number; employeeAmountMinor: number | null;
  ruleId: string | null; employeeRatePpm: number | null; dependentRatePpm: number | null;
}
/**
 * 勞健保員工負擔以整數元計算：先將本人負擔四捨五入到元，再套用健保眷屬倍率。
 * 例如 42,000 × 1.551% = 651.42 元，1 位眷屬應為 651 × 2 = 1,302 元。
 */
export function calculateHrInsuranceEmployeeAmount(input: { scheme: HrInsuranceScheme; insuredAmountMinor: number; employeeRatePpm: number; dependentRatePpm: number; dependentCount: number }): number {
  const employeeAmountMinor = Math.floor(input.insuredAmountMinor * input.employeeRatePpm / 1_000_000);
  const employeeAmountYuan = Math.round(employeeAmountMinor / 100);
  const dependentMultiplier = input.scheme === "health" ? 1 + input.dependentCount * input.dependentRatePpm / 1_000_000 : 1;
  return Math.round(employeeAmountYuan * dependentMultiplier) * 100;
}
export async function listHrInsuranceContributionRules(db: Database, validOn?: string): Promise<HrInsuranceContributionRuleRecord[]> {
  const rows = await db.select().from(hrInsuranceContributionRules).orderBy(desc(hrInsuranceContributionRules.validFrom), hrInsuranceContributionRules.scheme);
  const stored = rows.filter((row) => validOn === undefined || (row.validFrom <= validOn && (row.validTo === null || validOn < row.validTo)))
    .map((row) => ({ ...row, isSystemDefault: false }));
  const system = SYSTEM_INSURANCE_CONTRIBUTION_RULES.filter((rule) => validOn === undefined || (rule.validFrom <= validOn && (rule.validTo === null || validOn < rule.validTo)));
  return [...stored, ...system];
}
export async function estimateHrInsuranceContributions(db: Database, input: { validFrom: string; versions: HrInsuranceEstimateVersionInput[] }): Promise<HrInsuranceContributionEstimate[]> {
  if (!isDateOnly(input.validFrom)) throw new HrError(400, "試算生效日不正確。 ");
  if (!input.versions.length || input.versions.length > 2 || new Set(input.versions.map((version) => version.scheme)).size !== input.versions.length) throw new HrError(400, "試算投保版本格式不正確。 ");
  for (const version of input.versions) {
    if (!Number.isSafeInteger(version.insuredAmountMinor) || version.insuredAmountMinor < 0 || !Number.isSafeInteger(version.dependentCount) || version.dependentCount < 0 || version.dependentCount > 3) throw new HrError(400, "試算投保資料不正確。 ");
  }
  const rules = await listHrInsuranceContributionRules(db, input.validFrom);
  return input.versions.map((version) => {
    if (version.status === "withdrawn") return { ...version, employeeAmountMinor: 0, ruleId: null, employeeRatePpm: null, dependentRatePpm: null };
    const rule = rules.find((item) => item.scheme === version.scheme && item.validFrom <= input.validFrom && (item.validTo === null || input.validFrom < item.validTo));
    if (!rule) return { ...version, employeeAmountMinor: null, ruleId: null, employeeRatePpm: null, dependentRatePpm: null };
    return { ...version, employeeAmountMinor: calculateHrInsuranceEmployeeAmount({ scheme: version.scheme, insuredAmountMinor: version.insuredAmountMinor, employeeRatePpm: rule.employeeRatePpm, dependentRatePpm: rule.dependentRatePpm, dependentCount: version.dependentCount }), ruleId: rule.id, employeeRatePpm: rule.employeeRatePpm, dependentRatePpm: rule.dependentRatePpm };
  });
}
export async function createHrInsuranceContributionRule(db: Database, input: HrInsuranceContributionInput, actor: HrActor) {
  if (!isDateOnly(input.validFrom) || (input.validTo !== null && (!isDateOnly(input.validTo) || input.validTo <= input.validFrom))) throw new HrError(400, "費率生效／迄日不正確。 ");
  if (![input.employeeRatePpm, input.employerRatePpm, input.dependentRatePpm].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)) throw new HrError(400, "保險負擔費率必須是 0～100% 的整數 ppm。 ");
  if (input.note.length > 1000 || (input.sourceKind !== "official" && input.sourceKind !== "manual")) throw new HrError(400, "保險負擔規則資料不正確。 ");
  if (input.sourceKind === "manual" && !input.note.trim()) throw new HrError(400, "人工保險負擔規則必須留下覆核備註。 ");
  const id = crypto.randomUUID();
  return writeHrMutation(db, sql`INSERT INTO hr_insurance_contribution_rules
    (id, scheme, valid_from, valid_to, employee_rate_ppm, employer_rate_ppm, dependent_rate_ppm, source_kind, note, created_by)
    SELECT ${id}, ${input.scheme}, ${input.validFrom}, ${input.validTo}, ${input.employeeRatePpm}, ${input.employerRatePpm}, ${input.dependentRatePpm}, ${input.sourceKind}, ${input.note}, ${actor.id}
    WHERE NOT EXISTS (SELECT 1 FROM hr_insurance_contribution_rules WHERE scheme=${input.scheme}
      AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`, id, actor, "insurance_contribution_rule_created", "保險負擔規則已變更或期間重疊，請重新整理。 ");
}

export type HrInsuranceRateTableSourceKind = "official" | "manual";
export interface HrInsuranceRateTableRecord {
  id: string; scheme: HrInsuranceScheme; year: number; status: "draft" | "active" | "archived"; sourceKind: HrInsuranceRateTableSourceKind; sourceUrl: string; fetchedAt: string; contentHash: string; note: string; brackets: HrInsuranceBracket[]; activatedAt: string | null;
}

type HrInsuranceRateTableData = { sourceKind: HrInsuranceRateTableSourceKind; note: string; brackets: HrInsuranceBracket[] };
const MANUAL_SOURCE_URL = "manual";

function rateTableData(dataJson: string): HrInsuranceRateTableData {
  const raw = JSON.parse(dataJson) as { sourceKind?: unknown; note?: unknown; brackets?: unknown };
  return {
    sourceKind: raw.sourceKind === "manual" ? "manual" : "official",
    note: typeof raw.note === "string" ? raw.note : "",
    brackets: Array.isArray(raw.brackets) ? raw.brackets as HrInsuranceBracket[] : [],
  };
}

function normalizeInsuranceBrackets(brackets: HrInsuranceBracket[]): HrInsuranceBracket[] {
  if (!Array.isArray(brackets) || brackets.length > 500) throw new HrError(400, "級距資料不正確。 ");
  const levels = new Set<number>();
  for (const bracket of brackets) {
    if (!Number.isSafeInteger(bracket.level) || bracket.level < 1 || levels.has(bracket.level)
      || !Number.isSafeInteger(bracket.lowerSalary) || bracket.lowerSalary < 0
      || (bracket.upperSalary !== null && (!Number.isSafeInteger(bracket.upperSalary) || bracket.upperSalary < bracket.lowerSalary))
      || !Number.isSafeInteger(bracket.insuredAmount) || bracket.insuredAmount <= 0) {
      throw new HrError(400, "級距資料不正確。 ");
    }
    levels.add(bracket.level);
  }
  const bySalary = [...brackets].sort((left, right) => left.lowerSalary - right.lowerSalary || left.level - right.level);
  for (let index = 1; index < bySalary.length; index += 1) {
    const previous = bySalary[index - 1]!;
    const current = bySalary[index]!;
    if (previous.upperSalary === null || previous.upperSalary >= current.lowerSalary) throw new HrError(400, "級距薪資範圍不可重疊。 ");
  }
  return [...brackets].sort((left, right) => left.level - right.level);
}

function rateTableJson(brackets: HrInsuranceBracket[], sourceKind: HrInsuranceRateTableSourceKind, note: string) {
  return JSON.stringify({ sourceKind, note, brackets });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bracketsHash(brackets: HrInsuranceBracket[]) {
  return sha256(JSON.stringify({ brackets }));
}
async function manualRateHash(dataJson: string) {
  // 人工版本的備註與來源也是可追溯內容；納入 hash 才能偵測只改備註的並行編輯。
  return sha256(dataJson);
}

export async function listHrInsuranceRateTables(db: Database, year?: number): Promise<HrInsuranceRateTableRecord[]> {
  const rows = await db.select().from(hrInsuranceRateTables).where(year === undefined ? undefined : eq(hrInsuranceRateTables.year, year)).orderBy(desc(hrInsuranceRateTables.year), desc(hrInsuranceRateTables.fetchedAt));
  return rows.map((row) => {
    const data = rateTableData(row.dataJson);
    return { id: row.id, scheme: row.scheme, year: row.year, status: row.status, sourceKind: data.sourceKind, sourceUrl: row.sourceUrl, fetchedAt: row.fetchedAt, contentHash: row.contentHash, note: data.note, activatedAt: row.activatedAt, brackets: data.brackets };
  });
}

export async function syncHrInsuranceRateTables(db: Database, year: number, actor: HrActor, fetcher: typeof fetch = fetch) {
  const tables = await fetchHrInsuranceBrackets(year, fetcher);
  const existingRows = await db.select({ scheme: hrInsuranceRateTables.scheme, status: hrInsuranceRateTables.status, contentHash: hrInsuranceRateTables.contentHash, dataJson: hrInsuranceRateTables.dataJson }).from(hrInsuranceRateTables).where(eq(hrInsuranceRateTables.year, year));
  const existing = existingRows.map((row) => ({ ...row, sourceKind: rateTableData(row.dataJson).sourceKind }));
  const statements = [];
  for (const table of tables) {
    const dataJson = rateTableJson(table.brackets, "official", "");
    const contentHash = await bracketsHash(table.brackets);
    // 同一年度、同一份官方內容不重建版本；人工草稿不可被官方同步默默覆蓋。
    if (existing.some((row) => row.scheme === table.scheme && row.status === "draft" && row.sourceKind === "manual")) continue;
    if (existing.some((row) => row.scheme === table.scheme && row.sourceKind === "official" && row.contentHash === contentHash)) continue;
    const id = crypto.randomUUID();
    const activityId = `insurance-rate-sync-${year}-${table.scheme}-${contentHash}`;
    statements.push(sql`UPDATE hr_insurance_rate_tables
      SET status='archived'
      WHERE scheme=${table.scheme} AND year=${year} AND status='draft'
        AND NOT EXISTS (SELECT 1 FROM hr_insurance_rate_tables WHERE scheme=${table.scheme} AND year=${year} AND content_hash=${contentHash}
          AND COALESCE(json_extract(data_json, '$.sourceKind'), 'official') = 'official')`);
    statements.push(sql`INSERT INTO hr_insurance_rate_tables
      (id, scheme, year, status, source_url, fetched_at, data_json, content_hash, created_by)
      SELECT ${id}, ${table.scheme}, ${year}, 'draft', ${table.sourceUrl}, ${table.fetchedAt}, ${dataJson}, ${contentHash}, ${actor.id}
      WHERE NOT EXISTS (SELECT 1 FROM hr_insurance_rate_tables WHERE scheme=${table.scheme} AND year=${year} AND content_hash=${contentHash}
        AND COALESCE(json_extract(data_json, '$.sourceKind'), 'official') = 'official')`);
    statements.push(sql`INSERT OR IGNORE INTO activity_events
      (id, entity_type, entity_id, entity_label, event_type, summary, field, old_value, new_value, payload_json, actor_type, actor_id, actor_email, source, status, error)
      VALUES (${activityId}, 'hr_payroll', ${`insurance-rates-${year}`}, '', 'insurance_rate_tables_synced', '官方勞健保級距已同步待審閱', '', NULL, NULL,
        ${JSON.stringify({ year, schemes: [table.scheme], contentHash })}, 'user', ${actor.id}, ${actor.email}, 'hr', 'succeeded', NULL)`);
  }
  if (statements.length) {
    const dialect = new SQLiteAsyncDialect({ casing: "snake_case" });
    const prepared = statements.map((query) => {
      const compiled = dialect.sqlToQuery(query);
      return db.$client.prepare(compiled.sql).bind(...compiled.params);
    });
    try { await db.$client.batch(prepared); }
    catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed/.test(error.message)) throw new HrError(409, "官方級距同步版本已變更，請重新整理後再試。 ");
      throw error;
    }
  }
  return listHrInsuranceRateTables(db, year);
}
export interface HrManualInsuranceRateTableInput {
  scheme: HrInsuranceScheme;
  year: number;
  sourceUrl: string;
  note: string;
  brackets: HrInsuranceBracket[];
}
export interface HrInsuranceRateTableUpdateInput {
  sourceUrl: string;
  note: string;
  brackets: HrInsuranceBracket[];
  expectedContentHash?: string;
}

function validateManualRateTableMetadata(input: { year: number; sourceUrl: string; note: string }) {
  if (!Number.isSafeInteger(input.year) || input.year < 1900 || input.year > 9999 || input.sourceUrl.length > 500 || input.note.length > 1000) {
    throw new HrError(400, "人工級距資料不正確。 ");
  }
  if (!input.note.trim()) throw new HrError(400, "人工級距必須留下來源或覆核備註。 ");
}

async function getDraftRateTable(db: Database, id: string) {
  const [table] = await db.select().from(hrInsuranceRateTables).where(eq(hrInsuranceRateTables.id, id)).limit(1);
  if (!table) throw new HrError(404, "找不到級距版本。 ");
  if (table.status !== "draft") throw new HrError(409, "已啟用或封存的級距版本不可直接修改，請建立新的人工版本。 ");
  return table;
}

export async function createHrManualInsuranceRateTable(db: Database, input: HrManualInsuranceRateTableInput, actor: HrActor) {
  validateManualRateTableMetadata(input);
  const brackets = normalizeInsuranceBrackets(input.brackets);
  if (!brackets.length) throw new HrError(400, "至少要有一筆級距。 ");
  const id = crypto.randomUUID();
  const sourceUrl = input.sourceUrl.trim() || MANUAL_SOURCE_URL;
  const dataJson = rateTableJson(brackets, "manual", input.note);
  const contentHash = await manualRateHash(dataJson);
  return writeHrMutation(db, sql`INSERT INTO hr_insurance_rate_tables
    (id, scheme, year, status, source_url, fetched_at, data_json, content_hash, created_by)
    VALUES (${id}, ${input.scheme}, ${input.year}, 'draft', ${sourceUrl}, ${new Date().toISOString()}, ${dataJson}, ${contentHash}, ${actor.id})
    RETURNING id`, id, actor, "insurance_rate_table_created", "該年度已有待審閱級距版本，請重新整理後再試。 ");
}

export async function updateHrInsuranceRateTable(db: Database, id: string, input: HrInsuranceRateTableUpdateInput, actor: HrActor) {
  const table = await getDraftRateTable(db, id);
  validateManualRateTableMetadata({ year: table.year, sourceUrl: input.sourceUrl, note: input.note });
  if (input.expectedContentHash && input.expectedContentHash !== table.contentHash) throw new HrError(409, "級距版本已被其他人變更，請重新整理後再試。 ");
  const brackets = normalizeInsuranceBrackets(input.brackets);
  if (!brackets.length) throw new HrError(400, "至少要有一筆級距。 ");
  const sourceUrl = input.sourceUrl.trim() || MANUAL_SOURCE_URL;
  const dataJson = rateTableJson(brackets, "manual", input.note);
  const contentHash = await manualRateHash(dataJson);
  const expected = input.expectedContentHash ? sql` AND content_hash=${input.expectedContentHash}` : sql``;
  return writeHrMutation(db, sql`UPDATE hr_insurance_rate_tables SET source_url=${sourceUrl}, fetched_at=${new Date().toISOString()}, data_json=${dataJson}, content_hash=${contentHash}
    WHERE id=${id} AND status='draft'${expected} RETURNING id`, id, actor, "insurance_rate_table_updated", "級距版本已被其他人變更，請重新整理後再試。 ");
}

export async function deleteHrInsuranceRateTable(db: Database, id: string, actor: HrActor) {
  await getDraftRateTable(db, id);
  return writeHrMutation(db, sql`DELETE FROM hr_insurance_rate_tables WHERE id=${id} AND status='draft' RETURNING id`, id, actor, "insurance_rate_table_deleted", "級距版本已被其他人變更，請重新整理後再試。 ");
}

export async function activateHrInsuranceRateTable(db: Database, id: string, actor: HrActor) {
  const [draft] = await db.select().from(hrInsuranceRateTables).where(and(eq(hrInsuranceRateTables.id, id), eq(hrInsuranceRateTables.status, "draft"))).limit(1);
  if (!draft) throw new HrError(404, "找不到待審閱的級距版本。 ");
  const data = rateTableData(draft.dataJson);
  const brackets = normalizeInsuranceBrackets(data.brackets);
  if (!brackets.length) throw new HrError(400, "至少要有一筆級距才能啟用。 ");
  await writeHrMutation(db, [
    sql`UPDATE hr_insurance_rate_tables SET status='archived' WHERE scheme=${draft.scheme} AND year=${draft.year} AND status='active' RETURNING id`,
    sql`UPDATE hr_insurance_rate_tables SET status='active', activated_at=CURRENT_TIMESTAMP, activated_by=${actor.id}
      WHERE id=${id} AND status='draft' RETURNING id`,
  ], id, actor, "insurance_rate_table_activated", "級距版本已被其他人啟用，請重新整理。 ", { allowEmptyMutationIndexes: new Set([0]) });
  return { id, status: "active" as const, sourceKind: data.sourceKind };
}

function isDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function nextDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * 勞保與健保一起存：每個險別的「關閉前一個開放版本＋新版本」全部放進同一個 D1 batch。
 *
 * 分成兩次送的話，勞保成功、健保失敗時勞保已經寫進去；使用者再按一次儲存，勞保會撞上
 * 自己剛建的版本（期間重疊）而失敗，健保就永遠存不進去。
 */
export async function createHrInsuranceVersions(db: Database, inputs: HrInsuranceInput[], actor: HrActor) {
  if (!inputs.length || inputs.length > 2 || new Set(inputs.map((input) => input.scheme)).size !== inputs.length || new Set(inputs.map((input) => input.employmentId)).size !== 1) {
    throw new HrError(400, "一次只能為同一段任職各建立一筆勞保、健保版本。 ");
  }
  const mutations: SQL[] = [];
  // 沒有上一個開放版本時，關閉舊版本這一步不存在是合法情況；新版本 INSERT 仍必須成功。
  const allowEmptyMutationIndexes = new Set<number>();
  const ids: string[] = [];
  for (const input of inputs) {
    const version = await insuranceVersionStatements(db, input, actor);
    if (version.closePrevious) {
      allowEmptyMutationIndexes.add(mutations.length);
      mutations.push(version.closePrevious);
    }
    mutations.push(version.insert);
    ids.push(version.id);
  }
  await writeHrMutation(db, mutations, inputs[0]!.employmentId, actor, "insurance_version_created", "保險版本已變更、期間重疊或資料不合法，請重新整理。 ", { allowEmptyMutationIndexes });
  return { ids };
}

async function insuranceVersionStatements(db: Database, input: HrInsuranceInput, actor: HrActor) {
  if (!isDateOnly(input.validFrom) || (input.validTo !== null && (!isDateOnly(input.validTo) || input.validTo <= input.validFrom))) throw new HrError(400, "保險生效／迄日不正確。 ");
  if (!Number.isSafeInteger(input.insuredAmountMinor) || input.insuredAmountMinor < 0 || !Number.isSafeInteger(input.dependentCount) || input.dependentCount < 0 || input.dependentCount > 3 || !Number.isSafeInteger(input.rateYear) || input.rateYear < 1900 || input.rateYear > 9999) throw new HrError(400, "保險級距資料不正確。 ");
  if (input.status !== "enrolled" && input.status !== "withdrawn") throw new HrError(400, "保險狀態不正確。 ");
  if (input.status === "withdrawn" && input.insuredAmountMinor !== 0) throw new HrError(400, "退保版本的投保金額必須為 0。 ");
  if (input.status === "enrolled" && input.insuredAmountMinor <= 0) throw new HrError(400, "加保版本的投保金額必須大於 0。 ");
  if (input.sourceKind !== "official" && input.sourceKind !== "manual") throw new HrError(400, "保險來源不正確。 ");
  if (input.sourceUrl.length > 500 || input.note.length > 1000) throw new HrError(400, "保險來源或備註過長。 ");
  if (input.sourceKind === "manual" && input.status === "enrolled" && !input.note.trim()) throw new HrError(400, "人工覆寫投保金額必須留下覆核備註。 ");
  if (input.sourceKind === "official" && input.status === "enrolled") {
    if (!input.sourceUrl.trim()) throw new HrError(400, "官方來源版本必須保存官方級距來源網址。 ");
    const officialTables = await db.select({ sourceUrl: hrInsuranceRateTables.sourceUrl, dataJson: hrInsuranceRateTables.dataJson }).from(hrInsuranceRateTables)
      .where(and(eq(hrInsuranceRateTables.scheme, input.scheme), eq(hrInsuranceRateTables.year, input.rateYear), eq(hrInsuranceRateTables.status, "active"), sql`COALESCE(json_extract(${hrInsuranceRateTables.dataJson}, '$.sourceKind'), 'official') = 'official'`));
    const officialTable = officialTables.find((table) => {
      if (table.sourceUrl !== input.sourceUrl) return false;
      try {
        const data = rateTableData(table.dataJson);
        if (data.sourceKind === "manual") return false;
        return data.brackets.some((bracket) => bracket.insuredAmount * 100 === input.insuredAmountMinor);
      } catch { return false; }
    });
    if (!officialTable) throw new HrError(officialTables.length ? 400 : 409, officialTables.length ? "投保金額必須對應已啟用官方級距與來源。 " : "指定年度尚未有已審閱啟用的官方級距，不能標記為官方來源。 ");
  }
  const [current] = await db.select({ id: hrInsuranceVersions.id, validFrom: hrInsuranceVersions.validFrom }).from(hrInsuranceVersions)
    .where(and(eq(hrInsuranceVersions.employmentId, input.employmentId), eq(hrInsuranceVersions.scheme, input.scheme), sql`${hrInsuranceVersions.validTo} IS NULL`))
    .orderBy(desc(hrInsuranceVersions.validFrom)).limit(1);
  const id = crypto.randomUUID();
  const closePrevious = current && current.validFrom < input.validFrom
    ? sql`UPDATE hr_insurance_versions SET valid_to=${input.validFrom}
      WHERE id=${current.id} AND valid_to IS NULL AND valid_from < ${input.validFrom} RETURNING id`
    : null;
  const insert = sql`INSERT INTO hr_insurance_versions
    (id, employment_id, scheme, version_number, status, valid_from, valid_to, insured_amount_minor, dependent_count, rate_year, source_kind, source_url, note, created_by)
    SELECT ${id}, ${input.employmentId}, ${input.scheme}, coalesce((SELECT max(version_number) + 1 FROM hr_insurance_versions WHERE employment_id=${input.employmentId} AND scheme=${input.scheme}), 1),
      ${input.status}, ${input.validFrom}, ${input.validTo}, ${input.insuredAmountMinor}, ${input.dependentCount}, ${input.rateYear}, ${input.sourceKind}, ${input.sourceUrl}, ${input.note}, ${actor.id}
    WHERE EXISTS (SELECT 1 FROM hr_employments WHERE id=${input.employmentId}
      AND hired_on <= ${input.validFrom} AND (ended_on IS NULL OR (${input.validTo} IS NOT NULL AND ${input.validTo} <= ended_on)))
      -- 跟上面的 JS 檢查一致：只有加保要對得上官方級距。退保金額固定是 0，永遠對不上任何一級。
      AND (${input.sourceKind} <> 'official' OR ${input.status} = 'withdrawn' OR EXISTS (
        SELECT 1 FROM hr_insurance_rate_tables AS official_table
        WHERE official_table.scheme=${input.scheme} AND official_table.year=${input.rateYear} AND official_table.status='active'
          AND COALESCE(json_extract(official_table.data_json, '$.sourceKind'), 'official') = 'official'
          AND official_table.source_url=${input.sourceUrl}
          AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(official_table.data_json) THEN json_extract(official_table.data_json, '$.brackets') ELSE '[]' END) AS official_bracket
            WHERE CAST(json_extract(official_bracket.value, '$.insuredAmount') AS INTEGER) * 100 = ${input.insuredAmountMinor})
      ))
      AND NOT EXISTS (SELECT 1 FROM hr_insurance_versions WHERE employment_id=${input.employmentId} AND scheme=${input.scheme}
        AND (${input.validTo} IS NULL OR valid_from < ${input.validTo}) AND (valid_to IS NULL OR valid_to > ${input.validFrom}))
    RETURNING id`;
  return { id, closePrevious, insert };
}
