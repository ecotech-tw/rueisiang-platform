---
name: pre-pr-check
description: 開 PR 之前、以及請人 merge 之前，重新對一次 origin/main，檢查平行進行的 PR 有沒有先搶走全域唯一的資源（migration 編號與 journal idx、新檔名、新的具名 export、新的權限鍵值、新的索引名）。用於「要開 PR 了」「幫我建 PR」「可以 merge 了嗎」「CI 綠的但合進去就紅了」「migration 撞號」「兩支 PR 一起爆掉」，以及任何新增 migration、新增檔案或新增全域識別字的變更。分支上的 CI 是綠的不代表合併後是綠的——這支 skill 就是在補那個缺口。
---

# 開 PR 前與請人 merge 前先對一次 main

**這是操作步驟，不是流程說明。** 完整的開工步驟、worktree 規則與 PR 規則在
[`docs/development-workflow.md`](../../../docs/development-workflow.md)，這裡只補那份文件沒有涵蓋的一件事：
**離開 main 之後，main 又前進了。**

這支 skill 只做檢查與整理證據；merge 永遠由人類確認後執行。

## 為什麼需要這一步

CI 只跑你的分支。你的分支裡**沒有**別人那支 PR 的檔案，所以任何「全域唯一」的東西——
編號、檔名、識別字——在分支上永遠測不出衝突。**兩支 PR 各自綠燈，合起來紅燈**，
而且是紅在 main 上，擋住所有人的部署。

分支切出去的那一刻，你對 main 的認知就凍結了。做得越久，凍結得越久。

## 什麼時候做

兩個時間點，都要做：

1. **`gh pr create` 之前**——分支從切出去到現在，main 可能已經走了好幾步。
2. **請人 merge 之前**——CI 跑完之後又有別的 PR 合進去了，綠燈是舊的。

同時有兩支以上的 PR 開著、或分支活過一天以上時，這一步最容易救到你。

## 步驟

### 1. 先確認自己站在哪裡

```powershell
git rev-parse --show-toplevel
git status --short --branch
```

如果不是自己的 worktree 或工作區不乾淨，先停下來說明狀態。不要替另一個 agent rebase、stash、reset 或清檔。

### 2. 重新讀 main

```powershell
git fetch origin main --prune
git log --oneline HEAD..origin/main
```

第二行是空的，代表 main 沒有比你現在的 HEAD 新；仍然要做第 3 步，因為分支自己新增的全域資源
也要列出來給 reviewer 看。第二行有東西，代表你在看舊的 main——先讀那幾筆 commit 在動什麼，
再決定要不要 rebase。

只有同時滿足三件事才 rebase：

1. 這是自己的 branch。
2. 工作區乾淨。
3. 讀完 `HEAD..origin/main` 後確認要把 main 的變更納進來。

```powershell
git rebase origin/main
```

### 3. 列出自己新增或改名的全域資源

**只看 git conflict 不夠。** 衝突的形狀常常是「兩邊各自加了一個同名的東西」，git 不會標成
conflict，它會兩個都留下來。

先列分支相對於 main 的變更：

```powershell
git diff --name-status origin/main...HEAD
```

接著依本次 diff 類型檢查下表；沒有碰到的類型可以略過，但 PR 說明要寫「未新增 migration／權限／export」之類的證據。

| 資源 | 怎麼查 | 撞到會怎樣 |
|---|---|---|
| migration 檔名編號 | `git ls-tree origin/main --name-only packages/db/migrations/ \| Select-Object -Last 10`，再對照自己的新增檔 | `pnpm generate` 編出撞號的檔名，或兩支 PR 都叫同一個編號 |
| journal 的 `idx` | `git show origin/main:packages/db/migrations/meta/_journal.json \| Select-String '"idx"' \| Select-Object -Last 10` | D1 migration journal 有重複 idx，測試或部署紅在 main |
| 新增的資料表、索引、view、trigger 名稱 | `git diff origin/main...HEAD -- packages/db/migrations packages/db/src/schema` | migration 在正式站炸掉，或更糟——改到別人的表 |
| `packages/db/src/index.ts` 的具名 export | `git diff origin/main...HEAD -- packages/db/src/index.ts` | 重複 export 或漏 export，typecheck 紅 |
| `packages/auth/src/permissions.ts` 的權限鍵值 | `git diff origin/main...HEAD -- packages/auth/src/permissions.ts` | 兩個功能共用一個鍵，權限判定互相污染 |
| 新增的 route、元件、測試檔路徑 | `git diff --name-status origin/main...HEAD` | 兩份實作並存，只有一份被用到 |

> 在 bash 裡把 `Select-Object` 換成 `tail -n 10`，把 `Select-String` 換成 `grep`。

### 4. rebase 或修撞號後重跑驗證

只要做過 rebase、改過 migration 編號、調整 export／權限鍵值，就要重跑與變更相稱的驗證：

```powershell
pnpm typecheck
pnpm test
```

可以加跑更小的測試，但不能用小測試取代必要的整體檢查。**rebase 完一定要重跑。** 合併後的
程式碼是一份**沒有任何人跑過**的組合——你的 CI 跑的是你的分支，別人的 CI 跑的是別人的分支。

不要在這台機器跑任何 wrangler 指令；設定檔與部署行為交給 CI。

### 5. 整理 PR 或 merge 前留言

開 PR 或請人 merge 前，把檢查結果寫清楚：

- 對到的 `origin/main` commit。
- `HEAD..origin/main` 有沒有內容；如果有，是否 rebase。
- 本次是否新增 migration、權限鍵值、具名 export、新檔名。
- 跑過哪些驗證，結果是什麼。
- 還有哪些風險需要人類 merge 前再看一次。

這時候才開 PR：

```powershell
gh pr create --base main --head <branch> --title "..." --body "..."
```

## 這條規則怎麼來的

2026-09-06，`#206` 新增 `0099_rename_payout_daily.sql`。分支是從 `origin/main` 切的，
`git fetch` 也跑了——但 `#204` 早已經帶進一支 `0099_permission_grants_fk.sql`，而**我沒有
去看最大的編號是多少**。

兩支 PR 的 CI 都是綠的。合進 main 之後，journal 有兩筆 `idx: 99`，Deploy 直接紅，
需要 `#208` 才修好。

值得記住的兩件事：

- **fetch 跟「檢查」不是同一件事。** 我做了前者，以為就等於後者。
- **抓到它的是測試，只是太晚。** `#205` 加的「idx 不能重複」在 main 上才第一次同時看到
  兩支 0099——這正是它要擋的情況，也正說明為什麼那種檢查一定要有人在開 PR 前先用眼睛看
  一次：測試看得到的世界，跟 main 的世界，是在合併那一刻才第一次重合的。

## 合併之後如果 Deploy 紅了

Deploy 紅了先看**是哪一步**紅的。`.github/workflows/deploy.yml` 的順序是：

```text
pnpm typecheck → pnpm test → pnpm build → wrangler d1 migrations apply → 部署 Worker
```

紅在 `pnpm test`，代表 **migration 沒有跑到正式庫、Worker 也沒有部署**——程式與資料兩邊
都停在上一版，是一致的，改編號重推就好，不必補救資料。紅在 `migrations apply` 之後才需要
先確認正式庫的狀態。這個判斷會決定你是「改個編號」還是「處理正式資料」，先看清楚再動手。
