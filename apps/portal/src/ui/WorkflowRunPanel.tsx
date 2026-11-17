import type { ReactNode } from "react";
import { TableNote } from "./DataTable.js";
import { Panel } from "./Panel.js";
import { StatusBadge } from "./Feedback.js";

interface WorkflowRunSummary {
  status: string;
  conclusion: string | null;
  url?: string;
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

const STEP_MARK: Record<string, string> = { completed: "✓", in_progress: "▶" };

// 做完的淡掉，正在跑的用品牌色標出來。
function stepClass(step: WorkflowStepSummary): string {
  const base = "flex gap-2.5 py-[5px] text-[13px]";
  if (step.conclusion === "failure") return `${base} font-medium text-brand`;
  if (step.status === "in_progress") return `${base} font-medium text-brand-dark`;
  return `${base} text-muted`;
}

/** GitHub Actions 執行狀態的共用呈現，讓不同營運工具的追蹤體驗保持一致。 */
export function WorkflowRunPanel({
  tracking,
  latest,
  steps,
  queuedLabel = "排隊中",
  runningLabel = "執行中",
  successLabel = "完成",
  failureLabel = "未完成",
  waitingLabel = "等待 GitHub 建立工作…",
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

      {latest?.url ? (
        <TableNote>
          <a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a>
          {artifactNote ? <>　{artifactNote}</> : null}
        </TableNote>
      ) : null}
    </Panel>
  );
}
