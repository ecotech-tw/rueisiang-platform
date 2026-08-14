# 瑞香內部系統整合平台

把 CRM、WMS 與營運工具整合成一個入口：一次登入、一個 sidebar、一套權限，部署在 Cloudflare。

目前狀態：**Phase 0（骨架）完成**。登入與各模組尚未搬入，畫面上的項目都是佔位頁。

## 為什麼要做這件事

原本四套系統（CRM、WMS、CYBERBIZ webhook relay、出金表工具）是同一個模板的四份拷貝，會各自演化。同名的共用檔案已經分歧：`auth-session.ts` 差 263 行、`cyberbiz-webhook.ts` 差 238 行、`google-oauth.ts` 差 169 行。CRM 與 WMS 各有一份獨立的 `app_users`，各自實作了一次 `admin|viewer`；CYBERBIZ API client 有三份。

同一個 bug 要修三次，這個數字只會單向成長。

## 架構

```
apps/
  portal/     Vite + React Router SPA（純前端）
  api/        Hono on Cloudflare Workers（同時服務 portal 的靜態檔）
packages/
  auth/       權限目錄、OAuth、session、RBAC
  db/         drizzle schema（D1）＋ migrations
  cyberbiz/   CYBERBIZ API client（合併原本的三份）
  config/     共用 tsconfig
```

**部署成一個 Worker**：`apps/api/wrangler.toml` 的 `[assets]` 指向 `../portal/dist`，`run_worker_first = ["/api/*"]` 讓 API 進 Worker、其餘走 Static Assets，同一個網域。

**安全性全部在 API。** 前端的權限判斷（sidebar 顯示哪些項目、按鈕要不要出現）純粹是外觀——SPA 的 JavaScript 全在使用者手上，藏起來的按鈕不是安全機制。每一條 API 路由都必須自己驗權限。

## 開發

```bash
pnpm install
pnpm dev          # portal 在 5173，/api 轉給 8787
pnpm build
pnpm typecheck
```

資料庫 schema 改動後：

```bash
cd packages/db && pnpm generate    # 產生 migration SQL
```

## 這台開發機的兩個限制

**1. Windows on ARM 跑不了 `workerd`。** `wrangler dev` 與 `wrangler deploy --dry-run` 在本機會失敗（`Unsupported platform: win32 arm64`）。這不是設定問題，是這個平台沒有對應的執行檔。部署與 Worker 的實機驗證都在 CI（Linux）上做。

因此 `pnpm-workspace.yaml` 裡把 `workerd` 的安裝腳本關掉——開著會讓整個 `pnpm install` 直接失敗。CI 若需要那支執行檔，在部署 workflow 裡單獨處理。

**2. migration 的本機驗證用 `node:sqlite`。** D1 就是 SQLite，所以產生的 migration 可以直接用 Node 24 內建的 `node:sqlite` 套用驗證，不需要 workerd，也不必額外裝套件。

## 待辦（依 Phase）

| Phase | 內容 |
|---|---|
| 0 ✅ | monorepo 骨架、portal 外殼與 sidebar、Hono worker、D1 schema 與 migration |
| 1 | Google OAuth 登入、RBAC 判定與權限管理頁、部署到 `tools.rueisiang.com` |
| 2 | CRM 搬入 |
| 3 | 營運工具搬入、webhook relay 收編 |
| 4 | WMS 搬入（含拆掉 1816 行的 `warehouse-app.tsx`） |
| 5 | 舊系統下線、Cloud SQL 關掉 |

完整計畫與去蕪存菁清單見 `docs/migration-plan.md`。
