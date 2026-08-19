# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

專案語言是繁體中文（zh-TW）。README、程式碼註解、UI 文案、commit message 都用中文，新寫的也照做。

## 開發原則：先盤點 scope 與 impact，再動手

**每個功能開工之前先 research 一輪，把範圍與影響盤出來。** 這是做產品跟寫程式的差別：
沒盤點就開工，寫出來的東西會漫無目的、雜亂無章——漏掉相依的部分，或做出跟系統其他
地方打架的設計，而且通常要等到上線才發現。

盤點至少要回答三件事：

1. **這個功能合理嗎？** 它解決的問題是什麼、現在的系統為什麼解不了。
2. **它跟既有的什麼相依？** 誰會被它改到、它又依賴誰。
3. **有哪些狀態必須處理？** 特別是「已經處於某個狀態的人再進來一次會怎樣」。

以登入為例，該一起想到的是：session 怎麼發、多久過期、**已登入的人再打開登入頁會怎樣**、
權限從哪裡讀、停權多久生效、有幾條登入路、它們之間會不會互相繞過、走到一半失敗時
使用者卡在哪。只想著「畫一張表單送 email 跟密碼」的話，上面每一項都會變成之後才被
發現的洞。

盤點的產出常常會改變作法。實際遇過的兩種：

- **自訂角色**：以為要改 schema，盤完發現 `roles.isSystem` 與 `role_permissions`
  早就撐得住，只缺 CRUD 與畫面——不用 migration。
- **帳密登入**：以為只是多一張表單，盤完發現它是唯一不經過 Google 就能拿到 session
  的入口，牽動整條授權路徑，每個「應該擋下來」都要釘測試。

這個差別要在寫第一行程式之前就知道，不是寫完才補。

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
tools/       **刻意不在 pnpm workspace 裡**（pnpm-workspace.yaml 只 glob apps/* 與 packages/*）
  cyberbiz-monthly-payout/   出金表的 driver，純 JS ＋ npm 自己的 lockfile
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

**出金表的 driver 放在 `tools/`，不進 pnpm workspace。** 它相依 Playwright，拉進
workspace 會讓每個開發者的 `pnpm install` 都扛一份只有 GitHub Actions 用得到的
瀏覽器函式庫。它跑在 runner 上（開 Chrome、登 CYBERBIZ、讀 Gmail、寫 Drive），
用 `npm ci` 自己安裝，CI 另外跑一步 `node selftest.mjs`。

平台這一端只負責「有哪些店」「誰按了執行」，憑證一個都不碰——那些是本 repo 的
Actions secrets。設定頁存檔時會把店別寫回 `tools/cyberbiz-monthly-payout/stores.json`，
driver 的 `loadConfig` 讀到它就以它為準（沒有這個檔案時照 `config.json` 走）。

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

## 設計語彙：Material Design 3

UI 一律照 Material 3 的規格做，不要自己發明一套。既有的元件已經照這份做過一輪，
新增畫面沿用同樣的規則，不要在旁邊長出第二種風格。

品牌色套進 Material 的角色：`--color-brand` 當 primary，`--color-brand-soft` 當
primary-container，`--color-muted` 當 on-surface-variant。

### CSS 怎麼分工：Tailwind v4 ＋ 語意化元件 class

**token 只有一份，寫在 `apps/portal/src/styles.css` 的 `@theme` 裡。**
Tailwind v4 沒有 `tailwind.config.js`，設定就是 CSS。`@theme` 裡的每個值同時是
CSS 變數（`var(--color-brand)`）與 utility（`bg-brand`、`text-muted`），所以
不會有「CSS 改了但 config 沒改」這種漂移。要加顏色、圓角、陰影就加在那裡，
不要在元件裡寫死色碼。

**元件樣式在 `apps/portal/src/styles/components.css`，用 `layer(components)` 匯入。**
掛在 layer 裡的理由：utility 一定贏。沒有 layer 的話「`.panel` 的 padding」跟
「`p-6`」誰贏要看誰寫在後面，那是最難查的一種 bug。

分工原則：

- **會重複出現的東西寫成語意化 class**（`.panel`、`.data-table`、`.nav-item`）。
  一個 `.panel` 比一串 `rounded-card border border-line bg-paper p-5 shadow-panel`
  好讀，而且改規格時只改一個地方。這一套就是上面那份 Material 3 規格的實作。
- **一次性的版面微調用 utility**（`whitespace-nowrap`、`mt-4`）。為了一個地方
  發明一個 class 名字不划算。
- Tailwind 已經有的東西不要再自己寫一個同義的 class。
- 半透明的品牌色用 `--alpha(var(--color-brand) / 7%)`，不要手寫 `rgba(213, 56, 59, .07)`——
  色碼改了那些 rgba 不會跟著改。

**preflight 會重置掉瀏覽器預設樣式**，所以標題字重、清單的項目符號這類東西要自己寫回來
（`styles.css` 的 `@layer base` 已經處理了 `h1`–`h3`）。新加標籤時記得確認。

### 通則

- **選中狀態用「色調容器」**：淡底＋深字（`--color-brand-soft` ＋ `--color-brand-dark`），
  不要高彩度的填滿或漸層。Material 的選中是安靜地成立，不是跳出來搶視線。
- **hover 是 state layer**：在原本的底色上疊一層 4–8% 的品牌色
  （`--alpha(var(--color-brand) / 4%)` ～ `7%`），不是換一個顏色。
- **圓角**：可點的列與按鈕用全圓角膠囊（`border-radius: 999px`），
  卡片 14px，輸入框與小元件 9–12px。
- **圖示** 24px、線性、`currentColor`，不加外框。見 `shell/icons.tsx`，
  不要引入圖示字型。
- **焦點** 一律有 `:focus-visible` 外框，鍵盤操作看得到自己在哪裡。

### 資料表

| 項目 | 規格 |
|---|---|
| 表頭列高 | 56px，14px、字重 500、`--color-muted` |
| 內文列高 | 52px，14px、`--color-ink` |
| 欄距 | 16px，最外側 24px |
| 分隔線 | 只有列與列之間（`--color-soft-line`），欄之間沒有 |
| hover | 4% 的品牌色 state layer |
| 數字欄 | 靠右並用 `tabular-nums`（加 `.numeric`） |

表格上方的工具列（搜尋、篩選）要有自己的下緣分隔線，跟表頭分成兩個區塊——
沒有那條線的話兩排東西會黏在一起。

長列表用 `.page.fills` ＋ `.panel.grows`：整頁不捲，只有表格自己捲，表頭 sticky。

### 導覽

側邊選單是 Material 的 navigation drawer：膠囊列、24px 圖示、大項可收合、
收合成窄欄時只剩圖示。細節見 `shell/Sidebar.tsx` 與 `styles.css` 的導覽段落。

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
