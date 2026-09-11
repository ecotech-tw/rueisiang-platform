import type { Env } from "../env.js";

const GITHUB_API = "https://api.github.com";

/**
 * 官網對帳單的 workflow 觸發與狀態查詢。
 *
 * 跟出金表、商品銷售共用同一個 runner 與 repo，但 workflow 分開，而且**輸入的形狀
 * 不一樣**：那兩支收起訖日，這支收月份範圍——對帳單的區間是 CYBERBIZ 每半個月自己
 * 切的（1–15、16–月底），我們只能挑「要哪幾個月」。
 */
export interface ShopReportGithub {
  dispatch(input: { startMonth: string; endMonth: string; requestId: string }): Promise<void>;
  listRuns(requestId?: string): Promise<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  title: string;
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export class ShopReportGithubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ShopReportGithubError";
  }
}

export function shopReportGithub(env: Env): ShopReportGithub | undefined {
  const token = env.GITHUB_TOKEN;
  const repo = env.CYBERBIZ_SHOP_GITHUB_REPO ?? env.CYBERBIZ_SALES_GITHUB_REPO ?? env.PAYOUT_GITHUB_REPO;
  const workflow = env.CYBERBIZ_SHOP_WORKFLOW_FILE;
  if (!token || !repo || !workflow) return undefined;

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "rueisiang-platform",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ShopReportGithubError(
        response.status === 401 || response.status === 403
          ? "平台的 GitHub 憑證有問題，請確認 GITHUB_TOKEN 還有效。"
          : `GitHub 回應 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ""}`,
        response.status,
      );
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    async dispatch(input) {
      await call(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: "POST",
        body: JSON.stringify({
          ref: env.CYBERBIZ_SHOP_GITHUB_REF ?? env.CYBERBIZ_SALES_GITHUB_REF ?? env.PAYOUT_GITHUB_REF ?? "main",
          inputs: {
            start_month: input.startMonth,
            end_month: input.endMonth,
            request_id: input.requestId,
          },
        }),
      });
    },

    async listRuns(requestId) {
      const body = (await call(`/repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`)) as { workflow_runs?: RawRun[] } | null;
      let runs = (body?.workflow_runs ?? []).map((run): WorkflowRun => ({
        id: run.id,
        status: run.status,
        conclusion: run.conclusion ?? null,
        createdAt: run.created_at,
        url: run.html_url,
        title: run.display_title ?? "",
      }));
      if (requestId) runs = runs.filter((run) => run.title.includes(requestId));
      const latest = runs[0];
      if (!latest || latest.status === "completed") return { runs, steps: [] };

      const jobs = (await call(`/repos/${repo}/actions/runs/${latest.id}/jobs`)) as { jobs?: { steps?: RawStep[] }[] } | null;
      return {
        runs,
        steps: (jobs?.jobs?.[0]?.steps ?? []).map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion ?? null,
        })),
      };
    },
  };
}

interface RawRun {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
  display_title?: string;
}

interface RawStep {
  name: string;
  status: string;
  conclusion: string | null;
}
