import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MARKER_PREFIX = "deployed-commit-";
const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function deploymentSucceeded({ current, prepare, platform, hr, attempt }) {
  // rerun-failed-jobs 會沿用舊 attempt 的成功 needs，不能證明遠端為同一份 commit。
  return attempt === "1" && current === "true"
    && prepare === "success"
    && [platform, hr].every((result) => result === "success" || result === "skipped")
    && [platform, hr].includes("success");
}

export async function findDeploymentBaseline({ apiUrl, repository, token, currentRunId, fetchImpl = fetch }) {
  async function getJson(path) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    return response.json();
  }

  const runs = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const { workflow_runs: batch, total_count: total } = await getJson(`/actions/workflows/deploy.yml/runs?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("Deploy run 清單格式錯誤");
    runs.push(...batch);
    if (total === undefined ? batch.length < 100 : runs.length >= total) {
      complete = true;
      break;
    }
  }
  // 清單按建立時間分頁，窗外舊 run 的晚重跑可能是最近部署；歷史不完整時不可採基準。
  if (!complete) return "";
  // 舊 run 重跑（含手動回滾）可能比新建 run 更晚完成，不能只採 API 的建立順序。
  runs.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  for (const run of runs) {
    if (String(run.id) === String(currentRunId) || run.status !== "completed") continue;
    // 最新 attempt 全 skipped 也不能抹掉先前 attempt 可能已改過遠端的事實。
    if (run.run_attempt !== 1) return "";
    const { artifacts } = await getJson(`/actions/runs/${run.id}/artifacts?per_page=100`);
    if (!Array.isArray(artifacts)) throw new Error("部署標記清單格式錯誤");
    const suffix = `-attempt-${run.run_attempt}`;
    const markers = artifacts.filter((artifact) => !artifact.expired && artifact.name?.startsWith(MARKER_PREFIX) && artifact.name.endsWith(suffix));
    if (run.conclusion === "success" && markers.length === 1) {
      const sha = markers[0].name.slice(MARKER_PREFIX.length, -suffix.length);
      // workflow_run 的 head_sha 可能是 workflow 所在的 main，而非觸發 CI 的部署目標。
      if (SHA_PATTERN.test(sha)) return sha;
    }

    const { jobs } = await getJson(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!Array.isArray(jobs)) throw new Error("部署 job 清單格式錯誤");
    // 部分部署或失敗後可能已改過遠端；即使下一個 commit 撤回變更，也必須重建所有服務。
    if (jobs.some((job) => ["deploy-platform", "deploy-hr"].includes(job.name) && job.conclusion !== "skipped")) return "";
  }
  return "";
}

async function main() {
  if (process.argv[2] === "record") {
    const { CURRENT_RUN: current, PREPARE_RESULT: prepare, PLATFORM_RESULT: platform, HR_RESULT: hr, TARGET_SHA: sha, RUN_ATTEMPT: attempt } = process.env;
    if (!deploymentSucceeded({ current, prepare, platform, hr, attempt })) {
      console.log("未完成部署，不推進已部署基準。");
      return;
    }
    if (!SHA_PATTERN.test(sha ?? "")) throw new Error("部署目標 SHA 格式錯誤");
    writeFileSync("deployment-commit.txt", `${sha}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    return;
  }

  try {
    const sha = await findDeploymentBaseline({
      apiUrl: process.env.API_URL,
      repository: process.env.REPOSITORY,
      token: process.env.GH_TOKEN,
      currentRunId: process.env.CURRENT_RUN_ID,
    });
    process.stdout.write(sha);
  } catch (error) {
    // 無法證明基準時採完整 tree；寧可重做部署，不可漏掉累積變更。
    console.error(`::warning::無法讀取已部署標記，改用完整 tree：${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
