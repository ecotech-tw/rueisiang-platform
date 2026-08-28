import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./common.mjs";

const REPORT_CONFIG = {
  payout: {
    title: "CYBERBIZ 出金表",
    fileSuffix: "出金表",
    totalHeader: "出金合計",
    steps: { export: "匯出", fetch: "取檔", verify: "驗證", columns: "加欄位", upload: "上傳", ingest: "匯入 D1" },
    nextSteps: [
      "各通路試算表的 I 欄「櫃位POS」需對照專櫃 POS 金額填入",
      "有差異時在 J 欄「備註」寫原因",
    ],
  },
  sales: {
    title: "CYBERBIZ 商品銷售報表",
    fileSuffix: "商品銷售報表",
    totalHeader: "銷售總計",
    steps: { export: "匯出", fetch: "取檔", verify: "驗證", upload: "上傳", ingest: "匯入 D1" },
    nextSteps: [
      "商品銷售月資料匯入 D1，月份與年份可供 AI 查詢",
      "Google Drive 保留原始 XLSX，供同仁人工查帳",
    ],
  },
};

const MARK = { ok: "✓", fail: "✗", partial: "△", skip: "—", pending: "…" };

/** Markdown 表格的儲存格不能直接帶換行、管線或終端 ANSI 控制碼。 */
function markdownCell(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim();
}

function reportConfig(kind) {
  return REPORT_CONFIG[kind] ?? REPORT_CONFIG.payout;
}

function stepLine(result, steps) {
  return Object.keys(steps)
    .map((key) => `${steps[key]}${MARK[result.steps[key] ?? "pending"]}`)
    .join(" ");
}

function resultMark(result) {
  if (result.status === "partial") return MARK.partial;
  return result.done ? MARK.ok : MARK.fail;
}

function resultLabel(result) {
  if (result.status === "partial") return "部分完成";
  return result.done ? "完成" : "未完成";
}

function formatTotal(value, kind) {
  if (kind === "sales") {
    if (!value || typeof value !== "object") return "—";
    return [
      `毛 ${Number(value.grossQuantity ?? 0).toLocaleString("zh-TW")}`,
      `退 ${Number(value.returnQuantity ?? 0).toLocaleString("zh-TW")}`,
      `淨 ${Number(value.netQuantity ?? 0).toLocaleString("zh-TW")}`,
      `售額 ${Number(value.salesAmount ?? 0).toLocaleString("zh-TW")}`,
    ].join("／");
  }
  return value == null ? "—" : Number(value).toLocaleString("zh-TW");
}

export function terminalSummary(run, { kind = "payout" } = {}) {
  const config = reportConfig(kind);
  const lines = [
    "",
    `${config.title} ${run.label}（${run.start} ~ ${run.end}）`,
    "─".repeat(60),
  ];
  for (const result of run.stores) {
    lines.push(`${resultMark(result)} ${result.store}`);
    lines.push(`    ${stepLine(result, config.steps)}`);
    if (result.total != null) {
      lines.push(`    ${config.totalHeader}：${formatTotal(result.total, kind)}`);
    }
    if (result.sheetUrl) lines.push(`    ${result.sheetUrl}`);
    if (result.note) lines.push(`    備註：${result.note}`);
    if (result.error) lines.push(`    卡住：[${result.error.code}] ${result.error.message}`);
  }
  lines.push("─".repeat(60));
  const done = run.stores.filter((item) => item.done).length;
  lines.push(`完成 ${done}/${run.stores.length} 家`);
  if (run.reportPath) lines.push(`報告：${run.reportPath}`);
  lines.push("");
  return lines.join("\n");
}

export async function writeMarkdown(run, reportsDir, { kind = "payout" } = {}) {
  const config = reportConfig(kind);
  await ensureDir(reportsDir);
  const file = path.join(reportsDir, `${run.label}-${config.fileSuffix}.md`);
  const rows = run.stores.map((result) => {
    const status = Object.keys(config.steps)
      .map((key) => `${config.steps[key]}${MARK[result.steps[key] ?? "pending"]}`)
      .join(" ");
    const link = result.sheetUrl ? `[試算表](${result.sheetUrl})` : "—";
    const note = result.error
      ? `\`${result.error.code}\` ${result.error.message}`
      : (result.note ?? "");
    const total = formatTotal(result.total, kind);
    return `| ${markdownCell(result.store)} | ${resultLabel(result)} | ${markdownCell(status)} | ${markdownCell(total)} | ${markdownCell(link)} | ${markdownCell(note)} |`;
  });

  const content = [
    `# ${config.title} ${run.label}`,
    "",
    `- 對帳區間：${run.start} ~ ${run.end}`,
    `- 執行時間：${run.finishedAt}`,
    `- 完成：${run.stores.filter((item) => item.done).length}/${run.stores.length} 家`,
    run.driveFolderUrl ? `- Drive 資料夾：${run.driveFolderUrl}` : null,
    "",
    `| 通路 | 結果 | 步驟 | ${config.totalHeader} | 連結 | 備註 |`,
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## 待人工處理",
    "",
    ...(run.stores.some((item) => !item.done)
      ? run.stores
          .filter((item) => !item.done)
          .map(
            (item) =>
              `- **${markdownCell(item.store)}**：${item.error ? `[${markdownCell(item.error.code)}] ${markdownCell(item.error.message)}` : "流程未完成"}`,
          )
      : ["- 無"]),
    "",
    "## 下一步（人工）",
    "",
    ...config.nextSteps.map((step) => `- ${step}`),
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await fs.writeFile(file, content, "utf8");
  return file;
}
