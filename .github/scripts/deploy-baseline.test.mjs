import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { deploymentSucceeded as checkDeploymentSucceeded, findDeploymentBaseline } from "./deploy-baseline.mjs";

const deploymentSucceeded = (results) => checkDeploymentSucceeded({ attempt: "1", ...results });

const oldSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const run = (id, patch = {}) => ({ id, status: "completed", conclusion: "success", head_sha: targetSha, run_attempt: 1, updated_at: new Date(Date.UTC(2026, 9, 9, 12, 0, id)).toISOString(), ...patch });
const marker = (sha, patch = {}) => ({ name: `deployed-commit-${sha}-attempt-1`, expired: false, ...patch });

function fixture(runs, artifactsByRun = {}, jobsByRun = {}) {
  const calls = [];
  return {
    calls,
    options: {
      apiUrl: "https://api.github.test",
      repository: "owner/repo",
      token: "test-token",
      currentRunId: 99,
      fetchImpl: async (url) => {
        calls.push(url);
        const artifactRun = /\/runs\/(\d+)\/artifacts/.exec(url)?.[1];
        const jobRun = /\/runs\/(\d+)\/attempts\/\d+\/jobs/.exec(url)?.[1];
        return { ok: true, json: async () => artifactRun
          ? { artifacts: artifactsByRun[artifactRun] ?? [] }
          : jobRun ? { jobs: jobsByRun[jobRun] ?? [] } : { workflow_runs: runs.slice((Number(new URL(url).searchParams.get("page")) - 1) * 100, Number(new URL(url).searchParams.get("page")) * 100), total_count: runs.length } };
      },
    },
  };
}

test("跳過成功但未部署的 run，保留先前真正部署的基準", async () => {
  const { options } = fixture([run(3), run(2), run(1)], {
    3: [],
    2: [{ name: "deploy-portal-dist", expired: false }],
    1: [marker(oldSha)],
  });
  assert.equal(await findDeploymentBaseline(options), oldSha);
});

test("採標記的實際部署 SHA，不採 workflow_run 的 head_sha", async () => {
  const { options } = fixture([run(1, { head_sha: targetSha })], { 1: [marker(oldSha)] });
  assert.equal(await findDeploymentBaseline(options), oldSha);
});

test("不採本次 run、未執行部署的失敗／取消或尚未完成的 run", async () => {
  const { options, calls } = fixture([
    run(99), run(4, { conclusion: "failure" }), run(3, { conclusion: "cancelled" }),
    run(2, { status: "in_progress" }), run(1),
  ], { 1: [marker(oldSha)] });
  assert.equal(await findDeploymentBaseline(options), oldSha);
  assert.equal(calls.length, 6);
});

test("過期、格式錯誤或多個標記不推進基準", async () => {
  const { options } = fixture([run(4), run(3), run(2), run(1)], {
    4: [marker(targetSha, { expired: true })],
    3: [marker("bad-sha")],
    2: [marker(oldSha), marker(targetSha)],
    1: [marker(oldSha)],
  });
  assert.equal(await findDeploymentBaseline(options), oldSha);
});

test("沒有標記的舊 workflow 或歷史超過查詢範圍時交給完整 tree 回退", async () => {
  assert.equal(await findDeploymentBaseline(fixture([run(1)]).options), "");
  assert.equal(await findDeploymentBaseline(fixture([]).options), "");
});

test("較舊 run 晚完成的重跑／回滾依完成時間排序，保守回退完整 tree", async () => {
  const { options } = fixture([run(2), run(1, { updated_at: "2026-10-09T13:00:00Z", run_attempt: 2 })], {
    2: [marker(targetSha)],
    1: [marker(oldSha, { name: `deployed-commit-${oldSha}-attempt-2` })],
  });
  assert.equal(await findDeploymentBaseline(options), "");
});

test("重跑全 skipped 仍不能抹除前一次 attempt 遠端異動，回退完整 tree", async () => {
  const { options } = fixture([run(2, { run_attempt: 2 }), run(1)], {
    2: [marker(targetSha)],
    1: [marker(oldSha)],
  });
  assert.equal(await findDeploymentBaseline(options), "");
});

for (const status of ["queued", "pending", "in_progress"]) {
  test(`歷史 ${status} 重跑不能隱藏前次 attempt 的部署副作用`, async () => {
    const { options, calls } = fixture([run(2, { status, conclusion: null, run_attempt: 2 }), run(1)], { 1: [marker(oldSha)] });
    assert.equal(await findDeploymentBaseline(options), "");
    assert.equal(calls.length, 1);
  });

  test(`本次 ${status} 重跑仍應排除，不影響歷史有效基準`, async () => {
    const { options } = fixture([run(99, { status, conclusion: null, run_attempt: 2 }), run(1)], { 1: [marker(oldSha)] });
    assert.equal(await findDeploymentBaseline(options), oldSha);
  });

  test(`歷史首次 ${status} 尚無部署副作用，仍可採有效基準`, async () => {
    const { options } = fixture([run(2, { status, conclusion: null }), run(1)], { 1: [marker(oldSha)] });
    assert.equal(await findDeploymentBaseline(options), oldSha);
  });
}

test("非 main 的手動回滾也屬於真實部署基準", async () => {
  const { options, calls } = fixture([run(1, { head_branch: "rollback-tag" })], { 1: [marker(oldSha)] });
  assert.equal(await findDeploymentBaseline(options), oldSha);
  assert.equal(calls[0].includes("branch="), false);
  assert.equal(calls[0].includes("status="), false);
});

for (const conclusion of ["failure", "cancelled", "success"]) {
  test(`有遠端異動但無有效標記（${conclusion}）時回退完整 tree，不採舊基準`, async () => {
    const { options } = fixture([run(2, { conclusion }), run(1)], { 1: [marker(oldSha)] }, {
      2: [{ name: "deploy-platform", conclusion: "success" }, { name: "deploy-hr", conclusion: "failure" }],
    });
    assert.equal(await findDeploymentBaseline(options), "");
  });
}

test("標記過期但 deployment 成功不能退到更舊 marker", async () => {
  const { options } = fixture([run(2), run(1)], { 2: [marker(targetSha, { expired: true })], 1: [marker(oldSha)] }, {
    2: [{ name: "deploy-platform", conclusion: "success" }],
  });
  assert.equal(await findDeploymentBaseline(options), "");
});

test("超過第一頁的舊 run 晚重跑不能被窗內新 marker 隱藏", async () => {
  const runs = Array.from({ length: 100 }, (_, index) => run(200 - index));
  runs.push(run(1, { run_attempt: 2, updated_at: "2026-10-09T14:00:00Z" }));
  const { options, calls } = fixture(runs, { 200: [marker(targetSha)] });
  assert.equal(await findDeploymentBaseline(options), "");
  assert.ok(calls.some((url) => url.includes("page=2")));
});

test("超過 10 頁未讀歷史時不得提前採第一頁 marker", async () => {
  const runs = Array.from({ length: 1001 }, (_, index) => run(2000 - index));
  const { options, calls } = fixture(runs, { 2000: [marker(targetSha)] });
  assert.equal(await findDeploymentBaseline(options), "");
  assert.equal(calls.length, 10);
});

test("failed-jobs 跨 attempt 的舊成功 needs 不得產生 marker", () => {
  assert.equal(deploymentSucceeded({ current: "true", prepare: "success", platform: "success", hr: "success", attempt: "2" }), false);
  assert.equal(deploymentSucceeded({ current: "true", prepare: "success", platform: "success", hr: "success", attempt: undefined }), false);
});

test("workflow 各部署 job 必須拒絕沿用舊 detect attempt", () => {
  const yaml = readFileSync(new URL("../workflows/deploy.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(yaml, /attempt: \$\{\{ steps\.current\.outputs\.attempt \}\}/);
  assert.match(yaml, /echo "attempt=\$RUN_ATTEMPT" >> "\$GITHUB_OUTPUT"/);
  for (const job of ["prepare", "deploy-platform", "deploy-hr", "record-deployment"]) {
    const block = yaml.split(`\n  ${job}:\n`)[1]?.split(/\n  [a-z-]+:\n/)[0];
    assert.ok(block, job);
    assert.match(block, /needs\.detect\.outputs\.attempt == format\('\{0\}', github\.run_attempt\)/, job);
  }
});

test("API 或 JSON 格式錯誤不能產生基準", async () => {
  const { options } = fixture([run(1)]);
  await assert.rejects(findDeploymentBaseline({ ...options, fetchImpl: async () => ({ ok: false, status: 403 }) }), /HTTP 403/);
  await assert.rejects(findDeploymentBaseline({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /格式錯誤/);
  await assert.rejects(findDeploymentBaseline({ ...options, fetchImpl: async () => { throw new Error("timeout"); } }), /timeout/);
});

const results = ["success", "skipped", "failure", "cancelled"];
for (const platform of results) {
  for (const hr of results) {
    test(`部署標記門檻：platform=${platform}、hr=${hr}`, () => {
      const expected = (platform === "success" || platform === "skipped")
        && (hr === "success" || hr === "skipped")
        && (platform === "success" || hr === "success");
      assert.equal(deploymentSucceeded({ current: "true", prepare: "success", platform, hr }), expected);
    });
  }
}

test("CLI 僅在完整部署成功時輸出實際 SHA 與標記檔案", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-baseline-"));
  try {
    const output = join(dir, "output");
    const script = fileURLToPath(new URL("./deploy-baseline.mjs", import.meta.url));
    const env = { ...process.env, GITHUB_OUTPUT: output, CURRENT_RUN: "true", RUN_ATTEMPT: "1", PREPARE_RESULT: "success", PLATFORM_RESULT: "success", HR_RESULT: "skipped", TARGET_SHA: oldSha };
    const rejected = spawnSync(process.execPath, [script, "record"], { cwd: dir, env: { ...env, PLATFORM_RESULT: "skipped" }, encoding: "utf8" });
    assert.equal(rejected.status, 0);
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(join(dir, "deployment-commit.txt")), false);
    const accepted = spawnSync(process.execPath, [script, "record"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(output, "utf8"), `sha=${oldSha}\n`);
    assert.equal(readFileSync(join(dir, "deployment-commit.txt"), "utf8"), `${oldSha}\n`);
    const invalid = spawnSync(process.execPath, [script, "record"], { cwd: dir, env: { ...env, TARGET_SHA: "invalid" }, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 查詢失敗時只寫 warning、不輸出假的基準，讓 workflow 使用完整 tree", () => {
  const script = fileURLToPath(new URL("./deploy-baseline.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    env: { ...process.env, API_URL: "http://127.0.0.1:1", REPOSITORY: "owner/repo", GH_TOKEN: "test-token" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /::warning::/);
});

test("過期與 prepare 未成功的部署不寫標記", () => {
  for (const current of ["false", undefined]) {
    assert.equal(deploymentSucceeded({ current, prepare: "success", platform: "success", hr: "success" }), false);
  }
  for (const prepare of ["skipped", "failure", "cancelled", undefined]) {
    assert.equal(deploymentSucceeded({ current: "true", prepare, platform: "success", hr: "success" }), false);
  }
});
