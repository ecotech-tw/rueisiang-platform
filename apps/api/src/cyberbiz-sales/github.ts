import type { Env } from "../env.js";

const GITHUB_API = "https://api.github.com";

export interface CyberbizSalesGithub {
  dispatch(input: {
    store: string;
    stores: RunnerStore[];
    start: string;
    end: string;
    requestId: string;
  }): Promise<void>;
  listRuns(requestId?: string): Promise<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>;
}

/** 傳給 runner 的一家店。scopeId 從 D1 帶過去，runner 不再從店名算。 */
interface RunnerStore {
  scopeId: string;
  name: string;
  driveFolderUrl: string;
  driveFolderName: string;
}

interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  title: string;
}

interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export class CyberbizSalesGithubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CyberbizSalesGithubError";
  }
}

/**
 * 商品銷售報表與出金表共用 runner，但 workflow 分開，避免前端一次操作時互相覆蓋輸入。
 * repo 未另設時沿用 PAYOUT_GITHUB_REPO，方便既有部署只增加 workflow secret/config。
 */
export function cyberbizSalesGithub(env: Env): CyberbizSalesGithub | undefined {
  const token = env.GITHUB_TOKEN;
  const repo = env.CYBERBIZ_SALES_GITHUB_REPO ?? env.PAYOUT_GITHUB_REPO;
  const workflow = env.CYBERBIZ_SALES_WORKFLOW_FILE;
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
      throw new CyberbizSalesGithubError(
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
          ref: env.CYBERBIZ_SALES_GITHUB_REF ?? env.PAYOUT_GITHUB_REF ?? "main",
          inputs: {
            store: input.store,
            // 見 payout/github.ts：資料夾與 scopeId 跟著這一次執行走。
            stores_json: JSON.stringify(input.stores),
            start: input.start,
            end: input.end,
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
