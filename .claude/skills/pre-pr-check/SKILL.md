---
name: pre-pr-check
description: 開 PR 之前、以及請人 merge 之前，重新對一次 origin/main，檢查平行進行的 PR 有沒有先搶走全域唯一的資源（migration 編號與 journal idx、新檔名、新的具名 export、新的權限鍵值、新的索引名）。用於「要開 PR 了」「幫我建 PR」「可以 merge 了嗎」「CI 綠的但合進去就紅了」「migration 撞號」「兩支 PR 一起爆掉」，以及任何新增 migration、新增檔案或新增全域識別字的變更。分支上的 CI 是綠的不代表合併後是綠的——這支 skill 就是在補那個缺口。
---

# 開 PR 前先對一次 main

**這是操作步驟，不是流程說明。** 完整的開工步驟、worktree 規則與 PR 規則在
[`docs/development-workflow.md`](../../../docs/development-workflow.md)，這裡只補那份文件沒有涵蓋的一件事：
**離開 main 之後，main 又前進了。**

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

### 1. 重新對 main

```powershell
git rev-parse --show-toplevel        # 先確認自己在哪個 worktree
git fetch origin main --prune
git log --oneline HEAD..origin/main  # main 前進了什麼
```

第三行是空的就沒事，跳到第 3 步。有東西就代表你在看舊的 main——先讀那幾筆
commit 在動什麼，再決定要不要 rebase（工作區乾淨、而且是自己的 branch 才可以）。

### 2. 檢查搶得到的資源

**只看 diff 不夠。** 衝突的形狀是「兩邊各自加了一個同名的東西」，git 不會標成
conflict，它會兩個都留下來。

```powershell
# migration 編號：最大的那支是誰？
git ls-tree origin/main --name-only packages/db/migrations/ | Select-Object -Last 5

# journal 的 idx 有沒有重複（`pnpm generate` 會拿它算下一支的編號）
git show origin/main:packages/db/migrations/meta/_journal.json | Select-String '"idx"' | Select-Object -Last 5
```

要對照的清單——凡是**全域唯一**的都算：

| 資源 | 撞到會怎樣 |
|---|---|
| migration 檔名編號、journal 的 `idx` | `pnpm generate` 編出撞號的檔名，把別人那支蓋掉 |
| 新增的資料表、索引、view 名稱 | migration 在正式站炸掉，或更糟——改到別人的表 |
| `packages/db/src/index.ts` 的具名 export | 重複 export，typecheck 紅 |
| `permissions.ts` 的權限鍵值 | 兩個功能共用一個鍵，權限判定互相污染 |
| 新增的檔案路徑（測試、route、元件） | 兩份實作並存，只有一份被用到 |

### 3. rebase 之後重跑

```powershell
git rebase origin/main
pnpm typecheck
pnpm test
```

**rebase 完一定要重跑。** 合併後的程式碼是一份**沒有任何人跑過**的組合——你的 CI 跑的是
你的分支，別人的 CI 跑的是別人的分支。

### 4. 這時候才開 PR

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

## 合併之後

Deploy 紅了先看**是哪一步**紅的。`.github/workflows/deploy.yml` 的順序是：

```
pnpm typecheck → pnpm test → pnpm build → wrangler d1 migrations apply → 部署 Worker
```

紅在 `pnpm test`，代表 **migration 沒有跑到正式庫、Worker 也沒有部署**——程式與資料兩邊
都停在上一版，是一致的，改編號重推就好，不必補救資料。紅在 `migrations apply` 之後才需要
先確認正式庫的狀態。這個判斷會決定你是「改個編號」還是「處理正式資料」，先看清楚再動手。
