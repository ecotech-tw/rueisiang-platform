# AGENTS.md

**這個 repo 的開發規格全部在 [CLAUDE.md](./CLAUDE.md)，動手之前請完整讀過一遍。**

那份文件涵蓋專案架構、每個技術決策背後的理由、命名慣例與 coding style、
Material 3 的設計語彙，以及一份「禁止事項」——那幾條是踩過才學到的，
不是偏好問題。

技能（skill）在 [`.claude/skills/`](./.claude/skills/)，目前只有出金表的操作知識。
資料夾名字沿用 `.claude`，同樣不另外開一份。

## 為什麼是一行指標，不是複製一份

兩份文件一定會漂移。改了其中一份、忘記改另一份的那一刻，這個 repo 就有兩套
互相矛盾的規格，而且沒有人知道哪一份才算數。這跟 CLAUDE.md 裡「權限鍵值寫在
程式碼、不寫在資料表」是同一個道理：**同一件事只能有一個來源。**

理想上這裡應該是一個指向 CLAUDE.md 的 symlink，但開發機是 Windows 而且沒有
建立 symlink 的權限（`core.symlinks` 也是 false），硬做出來的結果是 checkout
之後變成一個內容只有「CLAUDE.md」六個字的純文字檔，比多一次跳轉更糟。
等哪天開發環境換掉再說。
