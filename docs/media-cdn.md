# 多媒體 CDN

本文件說明系統架構與設定契約；程式碼是行為的唯一來源。部署通用步驟沿用 `platform-deploy` skill。

## 公開與私有邊界

平台管理頁為 `/media/images`，API 為 `/api/media/images`。管理頁提供固定 160px 縮圖與列表兩種檢視，
檢視偏好保存在本機瀏覽器。排序由 D1 在分頁前套用，支援名稱、格式、總像素、檔案大小、建立／更新時間及狀態；
相同值以 ID 穩定排序，縮圖與列表共用搜尋、篩選與排序。檢視、寫入、刪除分別檢查
`media:image:read`、`media:image:write`、`media:image:delete`；既有角色不自動獲得新權限，
管理者仍經權限目錄同步取得完整授權。

CDN origin 的 `/images/<id>` 不需登入，只提供 D1 仍有效的公開圖片。其他 CDN 路徑不會進入
平台 API 或 SPA。公開 URL 不含檔名與版本；改名、格式改變與取代檔案都不改變 URL。
目前接受 JPEG、PNG、WebP 靜態圖片；限制由 `media-cdn-fields.ts` 共用，完整解碼沿用人事照片
的驗證器，但不放寬人事照片的原有限制。

`MEDIA` 綁定 R2 `media` bucket，bucket 保持私有，不掛 R2 public custom domain、不啟用 r2.dev。
CDN hostname 掛在平台同一個 Worker；這讓刪除後的舊檔與其他 bucket 內容不會因為知道 key 而被讀出。
既有 NAS、LINE、WMS 與員工照片不搬移、不共用公開清單。

## 版本與快取

每次上傳先登記一個獨立的 R2 blob，完整寫入後才由 D1 原子切換目前參照。取代與刪除使用
revision 防止並行覆蓋；未知寫入結果不立即刪 R2，以免誤刪已提交的檔案。

更新、改名與刪除會先把 `purge_pending` 寫入 D1，再呼叫 Cloudflare zone purge API 清除該圖片的
`media-image-<id>` cache tag。標籤隨 Cache API 的 response 一起儲存，不使用無法全域清除的
`cache.delete()`。上游明確回 `success: true` 才清掉 pending；逾時、429、非 JSON 與其他失敗均保留
狀態。管理頁可手動重試，既有每 15 分鐘的 cron 也會補跑，包含已刪除的圖片。

CDN cache 使用固定的 canonical URL，忽略 query string，避免同一張圖衍生無法清除的版本。
每次公開請求仍查 D1，比對 cache entry 的 ETag 與目前 revision；purge 失敗或舊請求晚回填快取時，
不會把舊 entry 當成目前版本。這個一致性選擇會增加 D1 讀取，不能把圖片流量估算成完全不經 Worker／D1。

Edge cache 保留一天，回給瀏覽器的標頭另設 `public, no-cache, must-revalidate`，支援 ETag／304。
因此後續請求會核對版本；已經顯示在開啟頁面裡的 `<img>` 不會被主動推送換圖，需重新載入／重新請求。
若 CYBERBIZ 將外部圖片重新抓取到自己的儲存空間，此機制無法清除 CYBERBIZ 的副本，必須以實際官網頁面驗收。

舊版本與未完成上傳的 blob 超過一天、且沒有目前圖片參照時由 cron 清理；刪除失敗會保留登記供下次重試。
刪除的圖片 metadata 保留，供查看失效連結與重試 purge，不代表可復原。刪除前必須明確確認官網已停用連結，
平台不爬取官網，也不自動修改 Cyberbiz。

## 部署設定與回滾邊界

| 設定 | 契約 |
| --- | --- |
| `MEDIA` | R2 binding，bucket 名稱 `media`；必須存在且保持私有 |
| `MEDIA_CDN_URL` | 與管理站不同的 HTTPS origin，預設 `https://cdn.rueisiang.com` |
| CDN custom domain | 同一 Worker 的 custom domain，不能同時綁 R2 domain，也不能有衝突 DNS 記錄 |
| `MEDIA_CDN_ZONE_ID` | CDN 所屬 `rueisiang.com` 的 32 位 zone ID，可存 Worker vars |
| `MEDIA_CDN_PURGE_TOKEN` | 僅該 zone 的 Cache Purge token，存 Worker secret，不使用部署 token |
| migration | 新增 `media_cdn_images` 與 `media_cdn_blobs`；不搬移舊圖片、不修改既有資料表 |

設定缺漏時，寫入與刪除回 503，而不是略過 CDN purge 後宣稱成功。本機 adapter 用 worktree 自己的
`local-uploads/media`，以 loopback HTTP origin 提供預覽，不呼叫 Cloudflare API，UI 明確顯示本機模式。

此功能依賴新的圖片路由；正式 URL 開始被官網引用後，直接回滾到沒有 CDN handler 的 Worker 版本會讓圖片失效。
回滾需保留公開讀取 handler 與 R2／D1 資料，先停用管理入口或新權限，再以修正版本處理；不可移除 bucket 或
逆向刪除資料表。一般平台部署仍由同一次 main workflow 發佈 Worker 與 Portal assets。

Cloudflare 參考：[Cache API 的全域 purge](https://developers.cloudflare.com/workers/reference/how-the-cache-works/#purge-assets-stored-with-the-cache-api)、
[Cache tags](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-tags/)。
