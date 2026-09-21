import { spawn } from "node:child_process";
import net from "node:net";

/**
 * `pnpm dev` 的入口：先挑好三個 port，再把 turbo dev 叫起來。
 *
 * 為什麼需要這一層：api、portal、hr 是三個各自獨立的行程，各自讀同一組環境變數
 * （API_PORT／PORTAL_PORT／HR_PORT）。portal 與 hr 的 Vite proxy 必須知道 api 停在哪個
 * port，所以「每個行程各自去找一個沒被占用的 port」是行不通的——三邊會挑到不同答案，
 * proxy 就轉到空的地方，或更糟，轉到另一個 worktree 的 API 上。
 *
 * 唯一能同時滿足「自動」與「三邊一致」的作法，就是在啟動之前由單一行程決定，
 * 再透過環境變數傳給子行程（turbo.json 的 passThroughEnv 已經放行這幾個名字）。
 *
 * 這件事以前是靠文件裡的固定對照表分配的（Codex 8788、Claude 8789）。一個 agent
 * 一個 worktree 之後，session 數量不固定，固定表格就失效了。
 */

/** 沒有明確指定時的起點；照舊是第一個 session 會拿到的那一組。 */
const DEFAULTS = {
  API_PORT: 8787,
  PORTAL_PORT: 5173,
  HR_PORT: 5176,
};

/**
 * 真的去 bind 一次，而不是查表或掃描 netstat——只有 bind 得起來才算真的空著。
 *
 * 兩種位址都要試，因為 Windows 讓它們共存：綁在 `0.0.0.0`（純 IPv4）的 server
 * 與綁在 `::`（雙堆疊）的 server 可以同時占著同一個 port 而不衝突。結果就是
 * 任何單一種探測都會漏，而且兩種漏法我們都踩過：
 *
 *   對方是 api dev server（`listen(port)`，雙堆疊）→ 探測用 "0.0.0.0" 會說「空的」
 *   對方是 Vite（`host: "0.0.0.0"`，純 IPv4）      → 探測用不指定位址會說「空的」
 *
 * 所以這裡照著兩個 consumer 各自的綁法各試一次，兩邊都成功才算空。
 * 判錯成忙碌的代價只是跳到下一號；判錯成空的，就是發出一個已經有人用的號碼。
 */
function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}

async function isFree(port) {
  return (await canBind(port, null)) && (await canBind(port, "0.0.0.0"));
}

/**
 * 從 base 往上找第一個空的 port。
 *
 * `taken` 是這一輪已經發出去的號碼：三個 port 是依序決定的，前一個還沒真的 bind 起來，
 * 探測時看起來仍然是空的，不記下來就會把同一個號碼發給兩個 app。
 */
async function pick(base, taken) {
  for (let port = base; port < base + 100; port += 1) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`從 ${base} 往上 100 個 port 都被占用，請先關掉一些 dev server。`);
}

const taken = new Set();
const chosen = {};

for (const [name, base] of Object.entries(DEFAULTS)) {
  // 明確指定的一律尊重，包括 api 那個舊名字 PORT——這支程式只補沒填的欄位。
  const explicit = name === "API_PORT" ? (process.env.API_PORT ?? process.env.PORT) : process.env[name];
  const value = explicit?.trim();
  if (value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      console.error(`${name} 必須是 1–65535 的整數，目前是「${value}」。`);
      process.exit(1);
    }
    chosen[name] = port;
    taken.add(port);
    continue;
  }

  const port = await pick(base, taken);
  chosen[name] = port;
  taken.add(port);
  process.env[name] = String(port);
}

console.log(`API      http://localhost:${chosen.API_PORT}`);
console.log(`Portal   http://localhost:${chosen.PORTAL_PORT}`);
console.log(`HR       http://localhost:${chosen.HR_PORT}`);
console.log(`假登入   http://localhost:${chosen.PORTAL_PORT}/dev`);
console.log("");

// 探測與實際 bind 之間有空隙：兩個 session 同時啟動時，有可能兩邊都探到同一個空 port。
// 三個 app 都設了 strictPort，所以那種情況會直接啟動失敗，不會安靜地接到別人的 API。
const child = spawn(["turbo", "dev", ...process.argv.slice(2)].join(" "), {
  shell: true,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
