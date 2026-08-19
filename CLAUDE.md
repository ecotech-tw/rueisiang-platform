# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

專案語言是繁體中文（zh-TW）。README、程式碼註解、UI 文案、commit message 都用中文，新寫的也照做。

## 專案架構

pnpm workspace + turborepo，部署成 Cloudflare 上的**單一 Worker**：API 與前端靜態檔同一個網域。

```
apps/
  portal/    Vite + React SPA。純前端，沒有任何伺服器邏輯。
    src/routes/   每個頁面一個資料夾，另含該頁的 api.ts（呼叫後端）
    src/shell/    Sidebar、AppShell、導覽定義（nav.ts）
    src/auth/     讀登入狀態的 useSession
  api/       Hono Worker，所有路由掛在 /api 底下。
    src/routes/       每個模組一個檔（auth、admin、crm、webhooks、health）
    src/middleware/   requireAuth / requirePermission，唯一的把關點
    src/dev/          本機 dev server 與假資料，永遠不會進 Worker 打包
    src/local-d1/     用 node:sqlite 實作 D1 介面，測試與 dev 共用
packages/
  auth/      權限目錄、RBAC 判定、session 簽章、Google OAuth
  db/        drizzle schema、migrations，以及所有查詢與同步邏輯
  cyberbiz/  CYBERBIZ API client 與 webhook 驗證
  config/    共用 tsconfig
docs/        deployment-setup.md（首次開通）、migration-plan.md（各 Phase 範圍）
```

**業務邏輯放在 `packages/db`**，不放路由。路由只做參數解析、權限檢查、回應格式；查詢與同步寫在 `packages/db/src/*.ts` 再從 `src/index.ts` 具名 export。要改行為先找那裡。

`apps/api/wrangler.toml` 的 `[assets]` 指向 `../portal/dist`，`run_worker_first = ["/api/*"]`：`/api/*` 進 Worker，其餘走 Static Assets。所以 portal 必須先 build，api 才部署得起來。

## 技術決策

**單一 Worker + D1，不用 Next.js、不用 Postgres。** 四套舊系統是同一個模板的四份拷貝，共用檔案已經各自漂移。合併成一個 monorepo，一份 schema、一套權限、一次登入。

**權限鍵值寫在程式碼，不寫在資料表。** `packages/auth/src/permissions.ts` 的 `PERMISSIONS` 是唯一來源，DB 只存「哪個角色有哪些鍵值」。放進 DB 只會讓「系統有哪些權限」跟「程式實際檢查哪些權限」兩邊漂移。改完 `permissions.ts` 之後在權限管理頁按「重新同步」（`syncSystemRoles`）寫進 DB。

**授權每次請求都回 DB 重讀，不採信 cookie。** 停權與權限調整才會即時生效，不用等 session 過期。

**本機開發不用 `wrangler dev`。** 開發機是 Windows on ARM，沒有 workerd 執行檔。改成 `apps/api/src/dev/server.ts`：Worker 進入點本來就只是一個 fetch handler，接上 `node:http`，再用 `src/local-d1/d1.ts`（`node:sqlite` 包成 D1 介面）當資料庫。跑的是真正的路由、真正的 SQL、真正的 migration，不是 mock。測試用同一個 `createLocalD1()`，不給檔名就是記憶體庫。

**package 之間直接 export `.ts` 原始碼**（`"exports": { ".": "./src/index.ts" }`），沒有中間建置步驟，改完立刻生效。

**CYBERBIZ 同步分批做。** Worker 有執行時間上限，全量拉一次可能拉不完，所以每次最多 `MAX_PAGES_PER_RUN` 頁，回報還有沒有下一頁。cron（每 15 分）只補跑失敗的 webhook，不做全量同步。

## 命名慣例與 Coding Style

照現代 TypeScript / ESM 標準，沒有額外的 linter（見「禁止事項」）。

- **ESM 全開**：所有 package 都是 `"type": "module"`。相對 import **一律帶 `.js` 副檔名**（`from "./env.js"`），即使原始檔是 `.ts`——`verbatimModuleSyntax` 要求這樣。
- **具名 export**，不用 default export。全專案只有三個 default：Worker 進入點與兩個工具設定檔。
- **型別 import 用 inline `type`**：`import { createDatabase, type Database } from "..."`。
- **檔名**：TS 模組 kebab-case（`crm-sync.ts`、`google-oauth.ts`）；React 元件 PascalCase（`AppShell.tsx`、`Login.tsx`）。
- **權限鍵值**：`<模組>:<資源>:<動作>`，例如 `crm:customer:write`。
- **資料庫**：schema 用 camelCase 定義，drizzle 設 `casing: "snake_case"` 自動轉欄位名。所以程式裡寫 `displayName`，SQL 裡是 `display_name`。
- **註解寫「為什麼」，不寫「做什麼」。** 這個 codebase 的註解密度偏高而且都在解釋取捨與踩過的坑，跟著這個調性寫；不要加 `// 設定使用者` 這種複述程式碼的註解。
- TypeScript 嚴格模式全開，含 `noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`。

## 禁止事項

- **不要在這台機器跑任何 wrangler 指令。** Windows on ARM 沒有 workerd，連 `wrangler whoami` 都會失敗。`wrangler dev`、`deploy`、`--dry-run`、`d1` 全部不行。設定檔的實機驗證只在 CI（Linux）上做。
- **不要靠前端擋權限。** sidebar 顯示什麼、按鈕出不出現，純粹是外觀——SPA 的 JavaScript 全在使用者手上。任何會讀寫資料的路由都要自己掛 `requireAuth` / `requirePermission`。
- **不要直接推 main。** 開分支 + `gh pr create`，一行修正也一樣。
- **不要在路由裡長出第二份業務邏輯。** 已經在 `packages/db` 的東西不要複製一份到 `apps/api/src/routes`。
- **不要在 Worker 程式碼裡用 `node:` 內建模組。** `apps/api/tsconfig.json` 的 `types` 只有 `@cloudflare/workers-types`，會被擋下。要用 Node 的只能在 `src/dev/`、`src/local-d1/`、測試檔裡。
- **不要打開 `workerd` 的安裝腳本。** `pnpm-workspace.yaml` 刻意設 `workerd: false`，開著會讓整個 `pnpm install` 在這台機器直接失敗。
- **改 CYBERBIZ 同步前先讀 `packages/db/src/crm-sync.ts` 的檔頭註解。** 那四條不變條件（只用會員 ID 對應、沒 ID 就不寫、manual 客戶不改成 cyberbiz、空值不覆蓋既有資料）是舊系統踩過才學到的。
- **不要手改 `packages/db/migrations/` 裡的 SQL。** 改 schema 再用 `pnpm generate` 產生。

## 常用指令

```bash
pnpm install
pnpm dev          # portal（Vite）5173 + API 8787，同時起
pnpm build        # portal 產 dist；api 只做型別檢查
pnpm typecheck    # Worker 與測試兩份 tsconfig 都跑，兩份都要過
pnpm test
```

單一測試檔或單一測試：

```bash
pnpm --filter @rueisiang/api exec vitest run src/crm-sync.test.ts
pnpm --filter @rueisiang/api exec vitest run src/crm.test.ts -t "封鎖"
```

有測試的三個 workspace：`@rueisiang/api`、`@rueisiang/auth`、`@rueisiang/cyberbiz`。

改完 schema 產 migration：

```bash
cd packages/db && pnpm generate
```

本機開發：打開 <http://localhost:5173/dev> 選身分直接登入（六種帳號涵蓋管理者到已停用），跳過 Google OAuth。資料在 `apps/api/local.sqlite`，想重來就刪檔。需要金鑰的功能（CYBERBIZ）從 `apps/api/.dev.vars` 讀，格式同 wrangler。
