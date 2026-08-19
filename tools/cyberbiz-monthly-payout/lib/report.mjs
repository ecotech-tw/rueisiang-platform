import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./common.mjs";

const STEP_LABELS = {
  export: "匯出",
  fetch: "取檔",
  verify: "驗證",
  columns: "加欄位",
  upload: "上傳",
};

const MARK = { ok: "✓", fail: "✗", skip: "—", pending: "…" };

/** Markdown 表格的儲存格不能直接帶換行、管線或終端 ANSI 控制碼。 */
function markdownCell(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim();
}

function stepLine(result) {
  return Object.keys(STEP_LABELS)
    .map((key) => `${STEP_LABELS[key]}${MARK[result.steps[key] ?? "pending"]}`)
    .join(" ");
}

export function terminalSummary(run) {
  const lines = [
    "",
    `CYBERBIZ 出金表 ${run.label}（${run.start} ~ ${run.end}）`,
    "─".repeat(60),
  ];
  for (const result of run.stores) {
    lines.push(`${result.done ? "✓" : "✗"} ${result.store}`);
    lines.push(`    ${stepLine(result)}`);
    if (result.total != null) {
      lines.push(`    出金合計：${result.total.toLocaleString("zh-TW")}`);
    }
    if (result.sheetUrl) lines.push(`    ${result.sheetUrl}`);
    if (result.error) lines.push(`    卡住：[${result.error.code}] ${result.error.message}`);
  }
  lines.push("─".repeat(60));
  const done = run.stores.filter((item) => item.done).length;
  lines.push(`完成 ${done}/${run.stores.length} 家`);
  if (run.reportPath) lines.push(`報告：${run.reportPath}`);
  lines.push("");
  return lines.join("\n");
}

export async function writeMarkdown(run, reportsDir) {
  await ensureDir(reportsDir);
  const file = path.join(reportsDir, `${run.label}-出金表.md`);
  const rows = run.stores.map((result) => {
    const status = Object.keys(STEP_LABELS)
      .map((key) => `${STEP_LABELS[key]}${MARK[result.steps[key] ?? "pending"]}`)
      .join(" ");
    const link = result.sheetUrl ? `[試算表](${result.sheetUrl})` : "—";
    const note = result.error
      ? `\`${result.error.code}\` ${result.error.message}`
      : (result.note ?? "");
    const total = result.total != null ? result.total.toLocaleString("zh-TW") : "—";
    return `| ${markdownCell(result.store)} | ${result.done ? "完成" : "未完成"} | ${markdownCell(status)} | ${markdownCell(total)} | ${markdownCell(link)} | ${markdownCell(note)} |`;
  });

  const content = [
    `# CYBERBIZ 出金表 ${run.label}`,
    "",
    `- 對帳區間：${run.start} ~ ${run.end}`,
    `- 執行時間：${run.finishedAt}`,
    `- 完成：${run.stores.filter((item) => item.done).length}/${run.stores.length} 家`,
    run.driveFolderUrl ? `- Drive 資料夾：${run.driveFolderUrl}` : null,
    "",
    "| 通路 | 結果 | 步驟 | 出金合計 | 連結 | 備註 |",
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
    "- 各通路試算表的 I 欄「櫃位POS」需對照專櫃 POS 金額填入",
    "- 有差異時在 J 欄「備註」寫原因",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");

  await fs.writeFile(file, content, "utf8");
  return file;
}
