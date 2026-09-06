# 多 agent 開發流程（v1）

## 目的

人類、Codex 與 Claude 三方同時開發同一個 repo。這份文件定的是**邊界**：誰能改什麼、
東西寫在哪、做完要收哪些尾。程式本身的規格（架構、命名、coding style、禁止事項）
以 [`CLAUDE.md`](../CLAUDE.md) 為準，不在這裡重複。

---

## 一、Worktree：一個工作目錄同時只有一個主人

Codex、Claude 與人類不同時共用一個 working directory。兩個 agent 即使同時開發，
也不會因為其中一方切 branch 而讓另一方的檔案突然改變。

```text
Rueisiang/
├─ rueisiang-platform/          # 人類整合或現有工作
├─ rueisiang-platform-codex/    # Codex
└─ rueisiang-platform-claude/   # Claude
```

建立 worktree：

```powershell
# 先切到包含 rueisiang-platform 的父資料夾
cd C:\path\to\Rueisiang
cd .\rueisiang-platform
git fetch origin
git worktree add -b feat/<需求名稱>-codex ..\rueisiang-platform-codex origin/main
git worktree add -b feat/<需求名稱>-claude ..\rueisiang-platform-claude origin/main
git worktree list
```

`<需求名稱>` 由當次需求決定；不要讓兩個 worktree 使用同一個 branch。

`rueisiang-platform` 預設是人類的整合目錄，但不是保留區：**人類在當次對話明講之後，
Codex 或 Claude 也可以在上面作業。** 要守住的不是「這個目錄屬於誰」，而是「一個工作
目錄同時只有一個主人」——真正會出事的是兩個人同時在同一個目錄切 branch，不是誰的名字
掛在資料夾上。

借用的流程是**借了什麼樣子就還什麼樣子**：

```powershell
git rev-parse --abbrev-ref HEAD   # 借用前先記下它原本停在哪個 branch
# …作業…
git switch <原本那個 branch>       # 還之前切回去，並回報自己做了什麼
```

不要一律切回 `main`。主資料夾交出來時可能正停在某個整合或 feature branch 上，切成
`main` 會讓人類下一次進來站在錯的分支；那時若還有未提交的修改，甚至切不回去。工作區
不乾淨就先問，不要自己 stash 或 reset（stash stack 是共用的，見下面）。

常駐 worktree 建立後，每個 agent 只在自己的路徑切換到下一個需求 branch。

**交叉 review 要做**（Codex review Claude 的分支，反之亦然），但**唯讀，而且在自己的
worktree 或 detached review worktree 做，不要進對方的目錄**。看一個分支不需要站到對方
的資料夾裡：

```powershell
git fetch origin --prune
git diff origin/main...origin/feat/<對方的分支>
```

進對方目錄的三個實際代價：切 branch 會動到對方可能還沒提交的工作區；同一個 branch 本來
就不能同時掛在兩個 worktree，想 checkout 也 checkout 不了；stash stack 是共用的，很容易
互相 pop 掉（見下面「Git stash 是共用的」）。

### 每個需求開始前

**第 0 步永遠是確認自己站在哪個 worktree**，然後才看 branch 狀態：

```powershell
git rev-parse --show-toplevel   # 先確認目錄，再做任何事
git status --short --branch
git fetch origin main --prune
git log --oneline --decorate HEAD..origin/main
```

第一行不能省。agent 的 shell 起始路徑不一定等於它以為的 worktree，而跑錯目錄不會有任何
錯誤訊息——整個需求會做在別人的分支上，通常要到 push 或 review 才發現。這一行的成本是
零，擋掉的是整輪重做。

新需求必須從最新的 `origin/main` 建立 branch：

```powershell
git switch -c feat/<需求名稱>-<agent> origin/main
```

若要繼續自己的既有 feature branch，確認工作區乾淨後才可更新：

```powershell
git rebase origin/main
```

不要在有未提交修改時 rebase，也不要替另一個 agent 的 branch 做切換、rebase 或清理。

### 本機 port

| worktree | Portal | API |
|---|---|---|
| 預設（人類） | `5173` | `8787` |
| Codex | `5174` | `8788` |
| Claude | `5175` | `8789` |

```powershell
$env:API_PORT = "8788"
$env:PORTAL_PORT = "5174"
pnpm dev
```

Portal 的 Vite proxy 會使用同一個 `API_PORT`，所以不會把 Codex 的請求送到另一個 worktree。

### 本機資料與 secrets

- 每個 worktree 有自己的 `apps/api/local.sqlite`。
- 每個 worktree 的 `apps/api/.dev.vars` 都要自行準備，不提交到 Git。
- 外部服務若要共用，先確認測試資料與憑證不會互相污染；app server 必須使用不同 port。
- 看到別的 worktree 有未提交修改時，不要替對方整理、reset 或刪除。

### Git stash 是共用的

worktree 之間共用同一個 stash stack。不要用裸的 `git stash` / `git stash pop`——會 pop 到
別人的東西。要暫時放下工作就開一個 WIP commit；真的要 stash 就用
`git stash push -u -m "<獨特標籤>"`，用標籤找回自己那筆再 `apply`。

---

## 二、誰能改什麼

1. 啟動後先跑 `git rev-parse --show-toplevel` 確認路徑，再確認 branch。
2. 只修改自己擁有的 worktree；主資料夾要人類當次明講才能借用。
3. 不替另一個 agent 切 branch、rebase 或清除未提交修改。
4. 交叉 review 唯讀，在自己的 worktree 或 detached review worktree 做；意見寫在 PR 上，
   不要進對方的目錄，也不要直接改對方的工作檔。
5. Merge 永遠由人類確認後執行。

### 共同規格檔要單獨開 PR

`CLAUDE.md`、`AGENTS.md`、`docs/development-workflow.md` 與 `.claude/skills/` 是三方共用的
規格。**任何 agent 要改這幾個，都必須開一個只做這件事的 PR**，不可以夾在功能 PR 裡順手改。

理由是這幾份是「其他 agent 下一輪會照著做」的東西。夾在 300 行功能 diff 裡的一句規則變更
沒有人會看到，但下一個 agent 會照著新的做——等於一方單方面改了三方的規則，而另外兩方
不知道。單獨開 PR 的成本是多一次 review，代價很小。

功能 PR 裡發現規格該改，作法是：功能照原規格做完，另外開一個 PR 提規格變更，在功能 PR
裡留言指過去。

---

## 三、東西寫在哪

`docs/` 曾經同時放操作步驟、現況架構、設計草稿與待辦清單，結果是三方讀同一份檔案得出
不同結論——因為「這段是已完成的事實」還是「這段是還沒做的計畫」看不出來。

**一份檔案只能是一種東西，而且要在開頭寫清楚是哪一種。**

| 種類 | 放哪 | 誰是唯一來源 | 例子 |
|---|---|---|---|
| **要照著做的步驟** | `.claude/skills/<名字>/SKILL.md` | skill 本身 | `platform-deploy`、`cyberbiz-reports`、`pre-pr-check` |
| **現在系統長什麼樣** | `docs/*.md` | **程式碼**；文件只解釋「為什麼」 | `line-pi-agent.md`、`assistant-sandbox.md` |
| **還沒做的事** | `README.md` 的「下一步」 | README | — |
| **還沒做的設計** | `docs/*-design.md`，開頭標明「還沒做」 | 該文件 | `assistant-multi-account-design.md` |
| **已完成或交接用的草稿** | 刪掉 | Git | — |

分 skill 與 docs 的理由：**skill 是「要做某件事時才載入」，docs 是「想理解系統時才讀」。**
混在一起，agent 會在不該讀的時候讀進五百行的開通手冊，把 context 燒在無關的東西上。

還有兩條：

- **不要在文件裡寫狀態。** 「✅ 已完成」「已經設好了」這種句子會過期，而且沒有人會回來改。
  要知道什麼開通了就去看 Cloudflare 儀表板、GitHub Secrets 或程式碼——那才是真的。
- **不確定放哪就先問人類，不要自己開新檔。** 多開一份檔案的成本不是那一份，是之後
  每一次「這件事到底寫在哪」的搜尋。

---

## 四、功能做完要收的尾

程式會動不等於做完。開 PR 之前，這三件事跟寫測試一樣是必要條件：

1. **設計文件裡已經實作的段落當場刪掉。** 留著會讓下一個 agent 以為還沒做，然後再做一次。
   要保留的只有「為什麼是這個形狀」，那部分寫進程式註解或濃縮成幾行留在設計文件的
   「已成立」段落。
2. **這次做掉的 TODO 從 `README.md` 的「下一步」移除；做的過程中發現的新 TODO 加進去。**
3. **交叉引用要跟著改。** 改檔名、搬檔案時 `grep` 一次舊名字，把所有連結修好。

反過來也有一條：**沒有實質內容變更時，不要只為了補說明製造 commit 或 PR 更新。**
Git 已經記著的東西（完成項目、移除的理由、過去怎麼修的）不要在文件裡重述一遍。

### 完成的定義

每個階段都要同時具備程式碼、測試、文件與部署／回滾說明。**沒有實機 smoke test 的功能
只能標記為「可合併」，不能標記為「已上線」。**

---

## 五、PR

- **開 PR 前與 merge 前，各對一次 `origin/main`。** 分支上的 CI 沒看過別人那支 PR 的檔案，
  所以 migration 編號、新檔名、具名 export 這類全域唯一的東西在分支上永遠測不出衝突——
  兩支各自綠燈、合起來紅在 main 上。步驟見 `.claude/skills/pre-pr-check/SKILL.md`。
- **不要直接推 main。** 開分支 + `gh pr create`，一行修正也一樣。
- PR 開著的時候可以繼續推，推完要重新 review；合併之後就不要再推那個分支。
- Merge 永遠由人類確認後執行。
