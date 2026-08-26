import type { ReactNode } from "react";
import { Panel } from "./Panel.js";
import { StatusBadge } from "./Feedback.js";

export interface WorkflowRunSummary {
  status: string;
  conclusion: string | null;
  url?: string;
}

export interface WorkflowStepSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface WorkflowRunPanelProps {
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

function stepClass(step: WorkflowStepSummary): string {
  if (step.conclusion === "failure") return "step fail";
  if (step.status === "completed") return "step done";
  if (step.status === "in_progress") return "step doing";
  return "step";
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
        <ol className="step-list">
          {steps.map((step, index) => (
            <li className={stepClass(step)} key={`${step.name}-${index}`}>
              <span className="step-mark">{STEP_MARK[step.status] ?? "·"}</span>
              {step.name}
            </li>
          ))}
        </ol>
      ) : null}

      {latest?.url ? (
        <p className="muted table-note">
          <a href={latest.url} target="_blank" rel="noopener noreferrer">在 GitHub 看完整紀錄</a>
          {artifactNote ? <>　{artifactNote}</> : null}
        </p>
      ) : null}
    </Panel>
  );
}
