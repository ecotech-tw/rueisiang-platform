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
cd C:\Users\llin8\Documents\Rueisiang
git -C .\rueisiang-platform fetch origin
git -C .\rueisiang-platform worktree add -b feat/<需求名稱>-codex .\rueisiang-platform-codex origin/main
git -C .\rueisiang-platform worktree add -b feat/<需求名稱>-claude .\rueisiang-platform-claude origin/main
git -C .\rueisiang-platform worktree list
```

`<需求名稱>` 由當次需求決定；不要讓兩個 worktree 使用同一個 branch。

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

```powershell
$env:API_PORT = "8788"
$env:PORTAL_PORT = "5174"
pnpm dev
```

Portal 的 Vite proxy 會使用同一個 `API_PORT`，所以不會把 Codex 的請求送到另一個 worktree。

## 本機資料與 secrets

- 每個 worktree 有自己的 `apps/api/local.sqlite`。
- 每個 worktree 的 `apps/api/.dev.vars` 都要自行準備，不提交到 Git。
- Redis 等 Docker 外部服務可以共用，但 app server 必須使用不同 port。
- 看到別的 worktree 有未提交修改時，不要替對方整理、reset 或刪除。
