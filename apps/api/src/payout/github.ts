import type { Env } from "../env.js";

/**
 * 觸發並查詢出金表的 GitHub Actions 工作。
 *
 * 平台這一端刻意什麼都不做：不開瀏覽器、不碰 CYBERBIZ 帳密、不碰 Google 憑證。
 * 那些只存在帳務 repo 的 Actions secrets 裡，跑在 GitHub 的 runner 上。這裡只有
 * 一個 fine-grained PAT，權限僅限那個 repo 的 Actions。
 *
 * 搬進平台之後唯一的差別是入口：原本是一個誰拿到網址都能按的 Worker，
 * 現在要先登入而且要有 tools:payout:run。
 */

const GITHUB_API = "https://api.github.com";

/**
 * driver 在 runner 上讀的就是這個檔案——它決定每家店的檔案上傳到哪個 Drive
 * 資料夾。平台的 D1 只決定「網頁上看得到哪幾家店」，兩邊不同步的話，執行時會
 * 找不到資料夾而失敗，所以設定頁存檔時要一起把它寫回去。
 */
const STORES_PATH = "tools/cyberbiz-monthly-payout/stores.json";

export interface PayoutGithub {
  dispatch(input: { store: string; start: string; end: string; requestId: string }): Promise<void>;
  listRuns(requestId?: string): Promise<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>;
  /** 把店別清單寫回帳務 repo。內容沒變就不 commit，回傳有沒有真的推上去。 */
  pushStores(input: { stores: unknown; message: string }): Promise<boolean>;
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

export class PayoutGithubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PayoutGithubError";
  }
}

/**
 * btoa 只吃 latin1，中文店名直接丟進去會丟 InvalidCharacterError。
 * 先轉成 UTF-8 位元組再逐 byte 組回字串。
 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 沒設定 token 就回 undefined，讓呼叫端決定要不要報錯——設定頁不需要它也該打得開。 */
export function payoutGithub(env: Env): PayoutGithub | undefined {
  const token = env.GITHUB_TOKEN;
  const repo = env.PAYOUT_GITHUB_REPO;
  const workflow = env.PAYOUT_WORKFLOW_FILE;
  if (!token || !repo || !workflow) return undefined;

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub 沒有 User-Agent 會直接拒絕。
        "User-Agent": "rueisiang-platform",
        ...(init?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new PayoutGithubError(
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
          ref: env.PAYOUT_GITHUB_REF ?? "main",
          inputs: {
            store: input.store,
            start: input.start,
            end: input.end,
            skip_upload: false,
            request_id: input.requestId,
          },
        }),
      });
    },

    async listRuns(requestId) {
      const body = (await call(
        `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`,
      )) as { workflow_runs?: RawRun[] } | null;

      let runs = (body?.workflow_runs ?? []).map(
        (run): WorkflowRun => ({
          id: run.id,
          status: run.status,
          conclusion: run.conclusion ?? null,
          createdAt: run.created_at,
          url: run.html_url,
          title: run.display_title ?? "",
        }),
      );

      /*
       * workflow_dispatch 不回傳 run id，所以認人的方式是把 request id 寫進
       * workflow 的 run-name，再從標題裡找回來。找不到通常代表 GitHub 還沒
       * 把工作建出來（會有幾秒的延遲），不是失敗。
       */
      if (requestId) runs = runs.filter((run) => run.title.includes(requestId));

      const latest = runs[0];
      if (!latest || latest.status === "completed") return { runs, steps: [] };

      // 只有還在跑的時候才多打一次拿步驟；跑完了那份清單也不會再變。
      const jobs = (await call(`/repos/${repo}/actions/runs/${latest.id}/jobs`)) as
        | { jobs?: { steps?: RawStep[] }[] }
        | null;
      const steps = (jobs?.jobs?.[0]?.steps ?? []).map(
        (step): WorkflowStep => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion ?? null,
        }),
      );
      return { runs, steps };
    },

    async pushStores({ stores, message }) {
      const next = `${JSON.stringify({ stores }, null, 2)}
`;

      /*
       * 先讀一次拿 sha。GitHub 的 Contents API 要用它做樂觀鎖：沒帶等於「這是新
       * 檔案」，檔案已經存在時會被拒絕。順便比對內容——沒改到就不要留下一筆
       * 什麼都沒動的 commit。
       */
      const current = (await call(
        `/repos/${repo}/contents/${STORES_PATH}?ref=${encodeURIComponent(env.PAYOUT_GITHUB_REF ?? "main")}`,
      ).catch((error: unknown) => {
        // 檔案還不存在是合理狀態（新 repo），其他錯誤照樣往上丟。
        if (error instanceof PayoutGithubError && error.status === 404) return null;
        throw error;
      })) as { sha?: string; content?: string } | null;

      if (current?.content && fromBase64(current.content) === next) return false;

      await call(`/repos/${repo}/contents/${STORES_PATH}`, {
        method: "PUT",
        body: JSON.stringify({
          branch: env.PAYOUT_GITHUB_REF ?? "main",
          message,
          content: toBase64(next),
          ...(current?.sha ? { sha: current.sha } : {}),
        }),
      });
      return true;
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
