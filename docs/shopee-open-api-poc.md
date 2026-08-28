# 蝦皮 Open API POC：把銷售報表從半自動變成全自動

## 為什麼要做

蝦皮銷售報表目前是半自動：人要登入賣家中心、匯出訂單 xlsx、上傳到 Portal，之後
才由 GitHub Actions 整理、上傳 Drive、匯入 D1。

卡住的是登入那一段。模擬人登入賣家中心每次都會遇到簡訊 OTP，繞不過去也不該繞
（見 `tools/shopee-sales-report-export/README.md` 末段）。

蝦皮 Open Platform 是另一條路：一次性瀏覽器授權換到 refresh token，之後由程式續期，
不再需要驗證碼。這份 POC 要證明那條路走得通，走得通就能把人從流程裡拿掉。

## 必須先講清楚的前提

**Open API 不會給你 xlsx。** 賣家中心「匯出訂單」產生的
`Order.completed.<start>_<end>.xlsx` 是網頁功能，沒有對應的下載 API；
`generate_income_report` 拿到的是財務收入報表，一列是一筆撥款，沒有商品明細，
**不是同一份東西**。

API 給的是 JSON，工作表要我們自己組。這對我們反而更好：不必等蝦皮產檔、不必解密、
不必處理密碼，而且拿得到 xlsx 沒有的退貨與物流狀態。

## 前置條件（人類要做，POC 無法自己完成）

1. 到 Shopee Open Platform 申請開發者帳號，取得 `partner_id` 與 `partner_key`。
2. 由店主在瀏覽器完成一次賣場授權，換到 `access_token`（4 小時）與 `refresh_token`（30 天）。

沒有這兩項，下面的階段二完全跑不動。階段一刻意設計成不需要憑證也能做完。

## 範圍

要做：

- 用 Open API 取得指定月份的訂單、商品明細與金流拆解。
- 把它整理成跟現在完全一樣的三張工作表（`orders` / `業績計算` / `商品銷售統計`）。
- 上傳 Google Drive、匯入 D1，兩者都沿用既有實作。

不要做（另案）：

- 訂單 webhook 推播與 WMS 扣庫存。
- 把庫存推回蝦皮（`update_stock`）。
- 動到 CYBERBIZ 那一側的任何流程。

## 架構：換掉輸入，其他重用

現在的流程是「解密 xlsx → 整理 → 上傳 → 匯入」。POC 只換掉第一段：

```
現在：使用者下載的 xlsx ──prepareWorkbook──┐
                                          ├─→ transformShopeeWorkbook ─→ Drive ─→ D1
新增：Open API（JSON）──→ 組成 orders 列 ──┘
```

`transformShopeeWorkbook`、`lib/drive.mjs` 與 `report-ingest.mjs` 都不改。新的取數模組
只負責產出「跟 xlsx `orders` 工作表同樣形狀的二維陣列」，交給既有函式往下走。

這樣做的理由是驗收：同一個月用兩條路各跑一次，數字必須一模一樣；輸出端共用同一份程式，
差異就只可能來自取數，好查。

新增檔案集中在 `tools/shopee-sales-report-export/lib/` 底下，不進 pnpm workspace，
理由同既有工具。

## 資料轉換對照

現有腳本實際用到的欄位（其餘欄位補空字串即可，`transformShopeeWorkbook` 不讀它們）：

| xlsx 欄 | 標題 | Open API 來源 |
|---|---|---|
| A | 訂單編號 | `get_order_list` → `order_sn` |
| B | 訂單狀態 | `get_order_detail` → `order_status` |
| F | 訂單成立日期 | `create_time`（Unix 秒，要轉成 `YYYY-MM-DD HH:mm`） |
| G | 商品總價 | `get_escrow_detail` 的商品金額 |
| S | 成交手續費 | `get_escrow_detail` → `commission_fee` |
| T | 其他服務費 | `get_escrow_detail` → `service_fee` |
| U | 金流與系統處理費 | `get_escrow_detail` → `transaction_fee` |
| Y | 商品名稱 | `get_order_detail` → `item_name` |
| Z | 商品ID | `item_id` |
| AA | 商品選項名稱 | `model_name` |
| AH | 數量 | `model_quantity_purchased` |
| AI | 退貨數量 | Returns API |

D1 那一段完全不用重寫：`transformShopeeWorkbook` 已經產出 `dailySalesRows` 與
`dailyPayoutRows`，`monthlySalesIngestRows` 會把日資料收成月資料，scope 固定
`shopee:store:default`。

既有的業務規則要原封不動搬過來：業績依 A 欄訂單編號去重後計 `G − S − U`；
商品以 `Z + AA` 為鍵、數量取 AH、退貨取 AI；蝦皮 sales 的 `salesAmount` 保留 0
（G 是訂單金額，同一訂單多商品時會重複，不分攤到商品）。

## 兩個階段

### 階段一：不需要憑證

1. 把一次真實 API 回應存成 fixture（沒有憑證時，先手寫一份符合官方欄位的假資料）。
2. 寫「API JSON → orders 列」的轉換，加單元測試。
3. 用 fixture 跑完整條流程到產出 xlsx，`--skip-upload`，確認三張工作表都對。

這一階段可以完全靠測試完成，不碰網路。

### 階段二：需要憑證

4. 實作授權與 token 續期（access token 4 小時、refresh token 30 天；到期前主動換）。
5. 對 2026-07 實跑一次，跟既有結果比對。
6. 通過後才接 Drive 與 D1。

## 驗收條件

用 2026-07 當基準，因為那個月已經有人工跑出來的結果
（`tools/shopee-sales-report-export/reports/2026-07-蝦皮銷售報表.md`）：

| 指標 | 必須等於 |
|---|---|
| 業績合計 | 244,431 |
| 商品銷售數量合計 | 1,342 |
| 不重複訂單 | 306 |
| 商品組合 | 26 |

四個數字全中才算通過。任何一個對不上都要先查清楚原因，不可以調整基準去遷就程式。

另外要驗證：

- Drive 上傳沿用既有的同名檔去重（已存在就不重複上傳）。
- D1 匯入後，報表查詢 API 對 `shopee:store:default`、`2026-07` 查得到同樣的數字。
- token 過期後能自動續期，不需要人介入。

## 待確認（做之前要有答案）

1. **T 欄「其他服務費」要不要計入業績。** 現在的公式是 `G − S − U`，跳過 T。
   2026-07 的 774 列裡，S 與 T 不相等的有 253 列（例如訂單 `260707347UV7A9`：
   S=58、T=43），所以 T 是獨立的費用，不是 S 的複本。若應該扣，現有數字偏高，
   而且會連帶影響上面的驗收基準。**這題沒答案之前不要開工。**
2. **S / T / U 與 escrow 欄位的實際對應。** 上表的對應來自社群 SDK 文件，
   官方文件是 JS 網站抓不到內文，必須拿到開發者帳號後用真實資料反推確認。
3. **退貨數量（AI）的來源。** 訂單 API 不直接給，要從 Returns API 併回來，
   時間邊界（退貨發生在次月）怎麼算要先定義。
4. **蝦皮帳號類型是 local 還是 cross-border。** 部分金流 API 只開放 local shop。

## 參考

- [Shopee Push (Webhook) API 概述](https://apis.io/apis/shopee/push/)
- [[TW][Open API] 開發者帳號申請及賣場授權說明（蝦皮官方 PDF）](https://deo.shopeemobile.com/shopee/seller/seller_cms/851f1bbc9dd4b951ef74692d460f405e/%5BTW%5D%5BOpen%20API%5DAPI%E4%B8%B2%E6%8E%A5%E8%AA%AA%E6%98%8E%E4%BA%8B%E9%A0%85%20(2021_02_20).pdf)
- [shopee-sdk：payment manager（escrow 與 income report）](https://github.com/congminh1254/shopee-sdk/blob/main/docs/managers/payment.md)
- [shopee-sdk：product manager（updateStock 與庫存型別）](https://github.com/congminh1254/shopee-sdk/blob/main/docs/managers/product.md)
- [Shopee Open Platform 整合指南（授權流程與 token 生命週期）](https://developer.inlinex.com.sg/blog/shopee-api-integration-guide-sellers)
