# 蝦皮銷售報表整理工具

這個工具只處理使用者已從蝦皮下載的 `.xlsx` 報表，不會登入蝦皮。Portal 接收檔案後會將它暫存到平台 R2，再由 GitHub Actions runner 下載、解密、整理並上傳 Google Drive。

## CLI

完整月份執行時，同一份報表會依 F 欄日期產生每日 payout 資料，並將 Product ID 數量彙總成 sales 月資料；scope 固定為 `shopee:store:default`（蝦皮）。

蝦皮報表的 `G` 是訂單金額欄，可能因同一訂單有多個商品而重複出現；因此目前不將它分攤到商品 sales，蝦皮 sales 的 `salesAmount` 保留為 0，商品數量以 AH、退貨數量以 AI 為準。業績則只對 A 欄訂單編號去重後計算 `G - S - U`。

```bash
node driver.mjs --input "Order.completed.20250201_20250228.xlsx" --password 042213 --drive-folder-url "https://drive.google.com/drive/folders/..."
```

只產出整理後的新檔、不上傳 Drive：

```bash
node driver.mjs --input "Order.completed.20250201_20250228.xlsx" --password 042213 --skip-upload
```

工具會解密報表、依 A 欄訂單去重後計算 `G - S - U`，並將 `Z + AA` 商品組合依 AH 數量彙總成新的工作表。

## Open API 報表 fixture

Open API 的報表輸入會先整理成既有 `orders` 工作表，再沿用同一套業績、商品統計、Drive
與 D1 流程。POC 階段可用 fixture 驗證 JSON 到三張工作表的完整流程，不需要蝦皮憑證：

```bash
node driver.mjs --api-fixture test/fixtures/shopee-open-api.json --start 2026-07-01 --end 2026-07-31 --skip-upload
```

這條路徑目前只接受已明確整理的 `product_amount`，避免把含運費或已扣費用的金額誤當成商品總價；
實際 Open API 的授權、token 續期與欄位反推另依 POC 的階段二處理。既有業績規則仍是 `G - S - U`，
T 欄其他服務費先保留在 `orders`，不改動現行計算基準。

加密報表在 Linux/GitHub Actions 上需要安裝 `msoffcrypto-tool`；Windows 本機若有 Microsoft Excel，也可以由工具使用 Excel COM 解密。

蝦皮登入與 OTP 不在目前流程中。若未來能以 Email OTP 搭配 Gmail API 穩定完成驗證，再另行增加自動匯出流程。
