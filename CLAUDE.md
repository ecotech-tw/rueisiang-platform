# CLAUDE.md — Rueisiang Platform 開發規範

這份文件是本 repo 的開發規範，也是 Codex、Claude 與人類共同遵守的單一來源。

專案語言是繁體中文（zh-TW）。README、程式碼註解、UI 文案、commit message 都用中文，新寫的也照做。

## 開發流程

每個新需求都依序經過「同步基準、盤點、最小實作、驗證、PR review」。不要跳過前面的盤點直接寫程式。

### 開工前

1. 先跑 `git rev-parse --show-toplevel` 確認自己在哪個 worktree，再確認 branch 與未提交修改。
   跑錯目錄不會有錯誤訊息，通常要到 push 才發現整輪做在別人的分支上。不要碰另一個 agent 的 worktree。
2. 依照 [`docs/development-workflow.md`](./docs/development-workflow.md) 的開工步驟執行 `git fetch origin main --prune`，確認本地使用的是最新的 `origin/main`。
3. 新需求一律從最新的 `origin/main` 建立 feature branch。既有 feature branch 只有在它屬於自己、工作區乾淨時才可 rebase；不要替另一個 agent 切 branch、rebase 或清除修改。
4. 先研究既有實作、設計文件、測試與下游 consumers，再決定要新增、修改或移除什麼。

### 實作與交付

1. 先選擇現有的 module、service 或 abstraction；只有既有結構無法合理承載時才新增層次。
2. 完成與需求相稱的測試，並執行相關 typecheck、test、build。設定檔與部署行為要交給 CI 驗證。
3. 在自己的 feature branch commit、push 並建立或更新 PR；review 意見要回覆在 PR。merge 永遠由人類確認。

## 需求盤點：先確認 scope 與 impact

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

研究結果要在寫第一行程式前能說清楚：要改哪些模組、會影響哪些 consumers、哪些狀態與失敗路徑必須測試，以及為什麼不沿用既有作法。

## 程式品質：簡潔、相依與 DRY

- **先重用、後抽象**：先找現有的 module、service、schema 與 UI 元件；只有既有結構無法合理承載時才新增 abstraction。
- **保持最小變更**：只加入需求需要的 code、dependency、設定與測試。沒有明確價值不要引入 framework、package 或額外層次。
- **遵守 DRY**：同一份業務規則、資料格式、權限定義與設定只能有一個來源。修正行為時要確認所有 consumers 都使用同一份來源。
- **不要過早抽象**：只有語意與變更方向穩定一致時才合併共用邏輯；不要為了消除表面相似就建立難以理解的通用層。
- **控制 software entropy**：完成變更後移除同一範圍內已失效的 dead code、過時註解與不再使用的設定，避免新舊兩套路徑並存。
- **保留有價值的測試**：測試應保護實際行為與失敗路徑，不可為了讓 CI 通過而刪除測試；不必要的測試才應一併清理。

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
  cyberbiz-reports/          CYBERBIZ 出金表與商品銷售報表 driver，純 JS ＋ npm 自己的 lockfile
packages/
  auth/      權限目錄、RBAC 判定、session 簽章、Google OAuth
  db/        drizzle schema、migrations，以及所有查詢與同步邏輯
  cyberbiz/  CYBERBIZ API client 與 webhook 驗證
  config/    共用 tsconfig
docs/        系統現況與還沒做的設計。**不放操作步驟，也不放 TODO**
.claude/skills/  要照著做的操作步驟。platform-deploy（開通與部署）、
                 cyberbiz-reports（出金表、商品銷售報表與報表查詢）
```

**業務邏輯放在 `packages/db`**，不放路由。路由只做參數解析、權限檢查、回應格式；查詢與同步寫在 `packages/db/src/*.ts` 再從 `src/index.ts` 具名 export。要改行為先找那裡。

`apps/api/wrangler.toml` 的 `[assets]` 指向 `../portal/dist`，`run_worker_first = ["/api/*"]`：`/api/*` 進 Worker，其餘走 Static Assets。所以 portal 必須先 build，api 才部署得起來。

### 文件寫在哪

**一份檔案只能是一種東西。** 操作步驟寫成 `.claude/skills/<名字>/SKILL.md`；系統現況與
還沒做的設計放 `docs/`；TODO 只寫在 `README.md` 的「下一步」，不要在別處另開一份。
完整的分類表、共同規格檔的改法與功能做完要收的尾，見
[`docs/development-workflow.md`](./docs/development-workflow.md) 第三、四節。

文件只保留對目前決策或下一步有用的內容；不要在 TODO、設計文件或程式註解重述 Git 已經保存的歷史、完成項目或移除原因。**也不要在文件裡寫狀態**（「✅ 已完成」「已經設好了」）——那種句子會過期而且沒有人會回來改。沒有實質內容變更時，不要只為補充說明製造 commit 或 PR 更新。

## 技術決策

**單一 Worker + D1，不用 Next.js、不用 Postgres。** 平台共用一份 schema、一套權限、一次登入。

**權限鍵值寫在程式碼，不寫在資料表。** `packages/auth/src/permissions.ts` 的 `PERMISSIONS` 是唯一來源，DB 只存「哪個角色有哪些鍵值」。放進 DB 只會讓「系統有哪些權限」跟「程式實際檢查哪些權限」兩邊漂移。改完 `permissions.ts` 之後在權限管理頁按「重新同步」（`syncSystemRoles`）寫進 DB。

**授權每次請求都回 DB 重讀，不採信 cookie。** 停權與權限調整才會即時生效，不用等 session 過期。

**本機開發不用 `wrangler dev`。** 開發機是 Windows on ARM，沒有 workerd 執行檔。改成 `apps/api/src/dev/server.ts`：Worker 進入點本來就只是一個 fetch handler，接上 `node:http`，再用 `src/local-d1/d1.ts`（`node:sqlite` 包成 D1 介面）當資料庫。跑的是真正的路由、真正的 SQL、真正的 migration，不是 mock。測試用同一個 `createLocalD1()`，不給檔名就是記憶體庫。

**package 之間直接 export `.ts` 原始碼**（`"exports": { ".": "./src/index.ts" }`），沒有中間建置步驟，改完立刻生效。

**出金表的 driver 放在 `tools/`，不進 pnpm workspace。** 它相依 Playwright，拉進
workspace 會讓每個開發者的 `pnpm install` 都扛一份只有 GitHub Actions 用得到的
瀏覽器函式庫。它跑在 runner 上（開 Chrome、登 CYBERBIZ、讀 Gmail、寫 Drive），
用 `npm ci` 自己安裝，CI 另外跑一步 `node selftest.mjs`。

平台這一端只負責「有哪些店」「誰按了執行」，憑證一個都不碰——那些是本 repo 的
Actions secrets。設定頁存檔時會把店別寫回 `tools/cyberbiz-reports/stores.json`，
driver 的 `loadConfig` 讀到它就以它為準（沒有這個檔案時照 `config.json` 走）。

**CYBERBIZ 同步分批做。** Worker 有執行時間上限，全量拉一次可能拉不完，所以每次最多 `MAX_PAGES_PER_RUN` 頁，回報還有沒有下一頁。cron（每 15 分）只補跑失敗的 webhook，不做全量同步。

## 多 agent 協作：Git worktree（v1）

worktree 的建立指令、目錄配置、port 對照、branch 生命週期與 review 規則集中放在
[`docs/development-workflow.md`](./docs/development-workflow.md)；本節只保留不可違反的邊界。

同一個 working directory 同時只能有一個主人。主資料夾 `rueisiang-platform` 預設是人類的，
人類當次明講之後 agent 也可以借用。交叉 review 唯讀，在自己的 worktree 做，不要進對方的
目錄。具體的目錄配置與 agent 規則請以上面的 workflow 文件為準。

`CLAUDE.md`、`AGENTS.md`、`docs/development-workflow.md` 與 `.claude/skills/` 是三方共用的
規格：**要改就開一個只做這件事的 PR，不可以夾在功能 PR 裡順手改。** 夾在大 diff 裡的一句
規則變更沒有人會看到，但下一個 agent 會照著新的做。

本機 worktree 的啟動方式與 `PORT` 相容規則見 workflow 文件；這些設定只影響 dev server，
不會進 Worker production 設定。

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

### 提示（Tooltip）

**用 `ui/Tooltip.tsx`，不要用瀏覽器原生的 `title`。** 原生的要等一秒多才出現、
字級與圓角完全不歸我們管，而且在觸控裝置上根本不會出現——等於那段文字只有
一部分使用者讀得到。

這一節講的是 Material 的 plain tooltip：純文字、深底淺字、一小塊。
**圖表的 hover 卡（`.analytics-tooltip`）是 rich tooltip，不適用本節**——那是
多列數值、淺底、卡片圓角，刻意長得不一樣，不要拿下面的規格去「修正」它。
要做新的 rich tooltip 再開一個元件，不要把 plain 撐大。

| 項目 | 規格 |
|---|---|
| 出現時機 | hover 或 focus **立刻**，不延遲 |
| 底色與文字 | `--color-ink` 底、`--color-canvas` 字（Material 的 inverse surface） |
| 字級 | 12px、字重 500 |
| 圓角 | 10px，屬於上面「輸入框與小元件 9–12px」那一段 |
| 位置 | 元素正上方 8px、水平置中；放不下時見下方 |
| 內容 | 純文字，`max-width: 280px` 並允許換行 |

出現時機是**刻意偏離 Material**（它的 plain tooltip 有約 500ms 進場延遲）。
理由是這個 tooltip 的主要用途是讀被截斷的數字，等半秒等於沒有。不要「照 M3 改回去」。

**內容不可以 `white-space: nowrap`。** 補充說明常常是一整句中文，nowrap 會把它
拉成比螢幕還寬的一條，`max-width` 也會跟著失效。

**位置一定要 `position: fixed` 加 `getBoundingClientRect`**，不可以用相對定位。
KPI 卡與資料表為了做省略號都有 `overflow: hidden`，相對定位的提示會被裁掉一半，
而且那種 bug 只在內容夠長時才出現，平常測不到。

用 fixed 就必須自己處理三件瀏覽器不會幫忙的事，少一件都會壞：

1. **量到實際尺寸後再定位。** 寬度看內容，寫死的置中做不到夾擠與翻面。
2. **撞到視窗邊界要夾回來，上方放不下要翻到下方。** 最右欄的提示否則會有一半
   在畫面外，而 fixed 不像相對定位那樣捲得回來。
3. **捲動、縮放、Escape 都要關掉。** 座標是進場時算的，捲動後就跟錨點脫節，
   而且指標還停在同一個元素上，不會觸發 mouseleave。長列表是表格自己捲
   （`.page.fills`），所以捲動事件要用 capture 才聽得到內層容器。

**非互動的錨點**（`<span>`、`<td>`）才加 `tabIndex={0}`，而且只加在少數重點欄位——
一張兩百列的表每格都加，鍵盤使用者要按過整張表才離得開。錨點本來就是
`<button>` / `<a>` 時不要再加。兩種情況都要 `aria-describedby`。

**觸控裝置沒有 hover。** 這個元件在手機上不保證顯示得出來，所以下面這條是硬規則，
不是建議：**提示只放「補充」，不放唯一的資訊。** 被截斷的數字、補充的說明句適合
放這裡；操作說明、錯誤原因、必要的欄位規則要寫在畫面上。

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
  唯一的例外是**資料搬移**：drizzle 只會產「建新表」與「刪舊表」，中間那段
  `INSERT INTO 新表 SELECT … FROM 舊表` 沒有人會幫你寫，不寫就是把歷史資料丟掉。
  作法是**額外加一個檔案**（不改 drizzle 產的那幾個），順序切成三步：先讓兩張表
  並存產出「建表」、手寫搬移、最後才移除舊表定義產出「刪表」。例子見
  `0007`→`0008_move_customer_events`→`0009`，測試在 `activity-migration.test.ts`。
- **不要在 migration 裡靠 `PRAGMA foreign_keys=OFF` 保護重建。** 正式環境走
  `wrangler d1 migrations apply`，**整支 migration 包在一個 transaction 裡**，而
  `PRAGMA foreign_keys` 在 transaction 裡是 no-op（SQLite 的規格），`defer_foreign_keys`
  也擋不住 `DROP TABLE` 的連坐刪除。drizzle 產的重建 SQL 預設就長這樣，**照抄會刪資料**。
  所以：**不要 DROP 任何被別的表用 `ON DELETE CASCADE` 指著的表**；要改父表的主鍵就先
  把子表的外鍵挪開，或改用「新增欄位＋回填」而不是重建。
  這個坑真的踩過：`0023` 在 D1 上把 `assistant_line_groups` 全部連坐刪光，本機看不出來
  （本機 runner 一句一句跑，PRAGMA 有效），復原見 `0028_restore_line_groups.sql`。
- **小香相關的新表與欄位一律同時帶 `assistantKey` 與 `channelKey`。** 關聯要指向 channel
  的獨立主鍵，不要指向 `assistantKey`；程式裡不要再新增任何一處寫死 `ASSISTANT_KEY`，
  改成從上層傳進來。現階段只有一個 assistant、一個 channel，兩個 key 的值會一樣——重點是
  **關聯的形狀**現在就對。既有的表當初拿 `assistantKey` 當 channel 用，補救花了五支
  migration，其中一支還在正式環境刪掉資料（上一條）。理由見
  [`docs/assistant-multi-account-design.md`](./docs/assistant-multi-account-design.md)。
- **migration 的測試要用 D1 的方式跑**——每一支包一個 transaction，而不是一句一句 exec。
  不然測試會給出假的信心，就像上面那次。範例見 `line-group-recovery.test.ts`。

## 常用指令

```bash
pnpm install
pnpm dev          # portal（Vite）5173 + API 8787，同時起
# Codex worktree：$env:API_PORT="8788"; $env:PORTAL_PORT="5174"; pnpm dev
# Claude worktree：$env:API_PORT="8789"; $env:PORTAL_PORT="5175"; pnpm dev
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

本機開發：打開 <http://localhost:5173/dev> 選身分直接登入（六種帳號涵蓋管理者到已停用），跳過 Google OAuth。Codex worktree 使用 <http://localhost:5174/dev>，Claude worktree 使用 <http://localhost:5175/dev>。資料在各自 worktree 的 `apps/api/local.sqlite`，想重來就刪檔。需要金鑰的功能（CYBERBIZ）從 `apps/api/.dev.vars` 讀，格式同 wrangler。
