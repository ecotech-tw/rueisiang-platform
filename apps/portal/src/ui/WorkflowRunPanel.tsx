import type { ReactNode } from "react";
import { TableNote } from "./DataTable.js";
import { Panel } from "./Panel.js";
import { Alert, StatusBadge } from "./Feedback.js";

interface WorkflowRunSummary {
  status: string;
  conclusion: string | null;
  url?: string;
  reportMarkdown?: string;
  error?: string;
}

interface WorkflowStepSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

interface WorkflowRunPanelProps {
  tracking: boolean;
  latest?: WorkflowRunSummary;
  steps: readonly WorkflowStepSummary[];
  queuedLabel?: ReactNode;
  runningLabel?: ReactNode;
  successLabel?: ReactNode;
  failureLabel?: ReactNode;
  waitingLabel?: ReactNode;
  artifactNote?: ReactNode;
}

const STEP_MARK: Record<string, string> = { completed: "✓", in_progress: "▶", skipped: "—" };

// 做完的淡掉，正在跑的用品牌色標出來。
function stepClass(step: WorkflowStepSummary): string {
  const base = "flex gap-2.5 py-[5px] text-[13px]";
  if (step.conclusion === "failure") return `${base} font-medium text-brand`;
  if (step.status === "in_progress") return `${base} font-medium text-brand-dark`;
  return `${base} text-muted`;
}

/** 背景報表工作的共用狀態呈現，讓不同營運工具的追蹤體驗保持一致。 */
export function WorkflowRunPanel({
  tracking,
  latest,
  steps,
  queuedLabel = "排隊中",
  runningLabel = "執行中",
  successLabel = "完成",
  failureLabel = "未完成",
  waitingLabel = "等待執行環境建立工作…",
  artifactNote,
}: WorkflowRunPanelProps) {
  const completed = latest?.status === "completed";
  const tone = !latest
    ? "info"
    : !completed
      ? "info"
      : latest.conclusion === "success"
        ? "success"
        : "danger";
  const label = !latest
    ? waitingLabel
    : !completed
      ? latest.status === "queued" ? queuedLabel : runningLabel
      : latest.conclusion === "success" ? successLabel : failureLabel;

  return (
    <Panel
      title={tracking ? "這次執行" : "上一次執行"}
      actions={<StatusBadge tone={tone}>{label}</StatusBadge>}
    >
      {steps.length ? (
        <ol className="m-0 grid list-none gap-0.5 p-0">
          {steps.map((step, index) => (
            <li className={stepClass(step)} key={`${step.name}-${index}`}>
              <span className="w-4 text-center">{STEP_MARK[step.status] ?? "·"}</span>
              {step.name}
            </li>
          ))}
        </ol>
      ) : null}

      {latest?.error ? <Alert className="mt-3" tone="danger">{latest.error}</Alert> : null}

      {latest?.reportMarkdown ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium">查看執行摘要</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-field bg-canvas p-3 text-[12px]">{latest.reportMarkdown}</pre>
        </details>
      ) : null}

      {latest && (latest.url || artifactNote) ? (
        <TableNote>
          {latest.url ? <a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a> : null}
          {artifactNote ? <>{latest.url ? "　" : null}{artifactNote}</> : null}
        </TableNote>
      ) : null}
    </Panel>
  );
}
