# 蝦皮銷售報表整理工具

這個工具只處理使用者已從蝦皮下載的 `.xlsx` 報表，不會登入蝦皮。Portal 接收檔案後會將它暫存到平台 R2，再由 GitHub Actions runner 下載、解密、整理並上傳 Google Drive。

## CLI

完整月份執行時，同一份報表會依 F 欄日期產生每日 payout 資料，並將「商品 ID＋規格 ID」數量彙總成 sales 月資料；scope 固定為 `shopee:store:default`（蝦皮）。

sales 的外部 SKU 使用報表 Z 欄商品 ID 與 AB 欄規格 ID 組成的 `商品ID_規格ID`。若該 mapping 有組合用料，平台匯入 D1 時會依每組用料數量展開成各 WMS SKU；蝦皮報表的 salesAmount 維持 0，不會把同一筆商品金額複製到每個用料。

蝦皮報表的 `G` 是訂單金額欄，可能因同一訂單有多個商品而重複出現；因此目前不將它分攤到商品 sales，蝦皮 sales 的 `salesAmount` 保留為 0，商品數量以 AH、退貨數量以 AI 為準。業績則只對 A 欄訂單編號去重後計算 `G - S - U`。

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
