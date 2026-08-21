# 多 agent 開發流程（v1）

## 目的

Codex 與 Claude 不共用同一個 working directory。兩個 agent 即使同時開發，也不會因為其中一方切 branch 而讓另一方的檔案突然改變。

## Worktree 配置

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
git -C .\rueisiang-platform fetch origin
git -C .\rueisiang-platform worktree add -b feat/<需求名稱>-codex .\rueisiang-platform-codex origin/main
git -C .\rueisiang-platform worktree add -b feat/<需求名稱>-claude .\rueisiang-platform-claude origin/main
git -C .\rueisiang-platform worktree list
```

`<需求名稱>` 由當次需求決定；不要讓兩個 worktree 使用同一個 branch。

常駐 worktree 建立後，每個 agent 只在自己的路徑切換到下一個需求 branch；review 別人的 branch 時使用 detached review worktree，不要把同一個 branch 同時掛到兩個 worktree。

## Agent 規則

1. 啟動後先確認目前路徑與 branch。
2. 只修改自己擁有的 worktree。
3. 不替另一個 agent 切 branch、rebase 或清除未提交修改。
4. 完成後在自己的 branch commit，push 後建立或更新 PR。
5. Review 透過 PR 留言與 review；不要直接改 reviewer 的工作檔。
6. Merge 永遠由人類確認後執行。
7. `CLAUDE.md` 是唯一規格來源，`AGENTS.md` 不複製內容。

## 本機 port

預設 worktree：Portal `5173`、API `8787`。

Codex worktree：Portal `5174`、API `8788`。

Claude worktree：Portal `5175`、API `8789`。

```powershell
$env:API_PORT = "8788"
$env:PORTAL_PORT = "5174"
pnpm dev
```

Portal 的 Vite proxy 會使用同一個 `API_PORT`，所以不會把 Codex 的請求送到另一個 worktree。

Claude worktree 使用 `API_PORT=8789` 與 `PORTAL_PORT=5175`。

## 本機資料與 secrets

- 每個 worktree 有自己的 `apps/api/local.sqlite`。
- 每個 worktree 的 `apps/api/.dev.vars` 都要自行準備，不提交到 Git。
- 外部服務若要共用，先確認測試資料與憑證不會互相污染；app server 必須使用不同 port。
- 看到別的 worktree 有未提交修改時，不要替對方整理、reset 或刪除。
