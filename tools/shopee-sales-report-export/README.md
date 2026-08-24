# 蝦皮銷售報表整理工具

這個工具只處理使用者已從蝦皮下載的 `.xlsx` 報表，不會登入蝦皮。Portal 接收檔案後會將它暫存到平台 R2，再由 GitHub Actions runner 下載、解密、整理並上傳 Google Drive。

## CLI

```bash
node driver.mjs --input "Order.completed.20250201_20250228.xlsx" --password 042213 --drive-folder-url "https://drive.google.com/drive/folders/..."
```

只產出整理後的新檔、不上傳 Drive：

```bash
node driver.mjs --input "Order.completed.20250201_20250228.xlsx" --password 042213 --skip-upload
```

工具會解密報表、依 A 欄訂單去重後計算 `G - S - U`，並將 `Z + AA` 商品組合依 AH 數量彙總成新的工作表。

加密報表在 Linux/GitHub Actions 上需要安裝 `msoffcrypto-tool`；Windows 本機若有 Microsoft Excel，也可以由工具使用 Excel COM 解密。

蝦皮登入與 OTP 不在目前流程中。若未來能以 Email OTP 搭配 Gmail API 穩定完成驗證，再另行增加自動匯出流程。
