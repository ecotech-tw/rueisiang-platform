import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(LIB_DIR, "..");

export function toolPath(...parts) {
  return path.join(TOOL_DIR, ...parts);
}

export async function loadEnv(file = toolPath(".env")) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#")) continue;
    const index = value.indexOf("=");
    if (index < 1) continue;
    const key = value.slice(0, index).trim();
    let content = value.slice(index + 1).trim();
    if ((content.startsWith('"') && content.endsWith('"')) || (content.startsWith("'") && content.endsWith("'"))) {
      content = content.slice(1, -1);
    }
    env[key] = content;
  }
  return env;
}

export async function loadConfig(file = toolPath("config.json")) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export function driveFolderIdFromUrl(value = "") {
  const input = String(value ?? "").trim();
  const pathMatch = /\/folders\/([A-Za-z0-9_-]+)/.exec(input);
  if (pathMatch) return pathMatch[1];
  const queryMatch = /(?:^|[?&])id=([A-Za-z0-9_-]+)/.exec(input);
  if (queryMatch) return queryMatch[1];
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : "";
}

export function monthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month ?? ""));
  if (!match) throw new Error(`月份格式必須是 YYYY-MM，收到：${month}`);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new Error(`月份超出範圍：${month}`);
  const lastDay = new Date(Date.UTC(Number(match[1]), monthNumber, 0)).getUTCDate();
  return { label: `${match[1]}-${match[2]}`, start: `${match[1]}-${match[2]}-01`, end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}` };
}

export function dateRange(start, end) {
  const from = isoDate(start, "起日");
  const to = isoDate(end, "迄日");
  if (from > to) throw new Error(`起日不能晚於迄日：${from} ~ ${to}`);
  const whole = monthRange(from.slice(0, 7));
  return { label: whole.start === from && whole.end === to ? whole.label : `${from}~${to}`, start: from, end: to };
}

export function previousMonth(now = new Date()) {
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth();
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  return monthRange(`${year}-${String(month).padStart(2, "0")}`);
}

function isoDate(value, label) {
  const text = String(value ?? "").trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label}格式必須是 YYYY-MM-DD，收到：${value ?? ""}`);
  }
  return text;
}

export function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`.env 缺少：${missing.join("、")}`);
}

export function redact(text, env = {}) {
  let output = String(text ?? "");
  for (const key of ["SHOPEE_PASSWORD", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (env[key] && env[key].length > 3) output = output.split(env[key]).join(`«${key}»`);
  }
  return output.replace(/\b\d{6}\b/g, "«otp»");
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
