# 蝦皮銷售報表工具

這個工具把蝦皮訂單報表整理成一份新的 xlsx：

- `業績計算`：同一個 A 欄訂單編號只採來源第一筆，業績為 `G - S - U`。
- `商品銷售統計`：以 `Z 商品 ID + AA 商品選項` 為商品鍵，加總 AH 商品數量；AI 退貨數量另列參考。
- 可用 Google Drive 資料夾連結指定上傳位置；同名檔案已存在時不重複上傳。

## 直接整理既有檔案

```powershell
npm ci
node driver.mjs `
  --input "C:\path\Order.completed.20250201_20250228.xlsx" `
  --password "042213" `
  --output "C:\path\Order.completed.20250201_20250228.cleaned.xlsx" `
  --skip-upload
```

加上 `--drive-folder-url "https://drive.google.com/drive/folders/<folder-id>"` 就會上傳；Google OAuth 需要先把 `.env.example` 的欄位填好。Linux/GCP 解密加密 xlsx 時需安裝 `msoffcrypto-tool`；Windows 會先嘗試 Python，失敗時退回已安裝的 Microsoft Excel。

## 從蝦皮匯出

```powershell
node driver.mjs --export --start 2026-07-01 --end 2026-07-31
```

`--export` 會使用 `chrome-profile/` 的持久化 Chrome profile，開啟蝦皮賣家中心並等待下載。第一次登入或蝦皮要求兩步驟驗證時，需在開啟的瀏覽器視窗中由操作者完成；工具不會繞過簡訊驗證。若蝦皮改版，請在 `config.json` 更新 `reportUrl` 或 `selectors`。
