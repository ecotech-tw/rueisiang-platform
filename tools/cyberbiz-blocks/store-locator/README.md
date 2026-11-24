# 官網據點列表 block

- Cyberbiz 匯入檔：`block.html`
- Block 資料來源：`GET https://cdn.rueisiang.com/store-locator/stores.json`
- 相容的即時資料 API：`GET https://platform.rueisiang.com/api/public/store-locator`
- 管理入口：平台「通路管理」→ 櫃點 →「官網據點資料」

API 只公開 `scope_kind = store`、營業中、未封存，且已填地址、縣市、類型與台灣 SVG 圖釘 X/Y 的通路。列表依 SVG 的 Y 值由北到南排序；儲存的圖釘位置使用 SVG 座標（X 475–880、Y 245–960），不是經緯度。Block 直接把每個圖釘的尖端 `(0, 0)` 放在 API 提供的 `(pinX, pinY)`，祖先圖層不額外平移；不需要扣圖釘寬高的一半，hover／選取縮放也維持相同尖端錨點。顯示用 viewBox 為 `475 245 425 715`（右界 900），替最大 X=880 保留右側空間容納圖釘與點擊區域；手機版 SVG 限制在容器寬度內，避免寬度溢出後被裁切。

官網圖片可選媒體庫 image ID（公開網址由既有 `cdn.rueisiang.com` 圖片 CDN 提供）或公開可讀取的 HTTPS 圖片網址。地址、營業時間、電話、樓層位置、分類與文案由通路資料提供；列表標題由「縣市＋通路名稱」組成，地圖標籤使用通路名稱。Google Maps 選取地點時會自動帶入地址與可辨識的縣市。

D1 是唯一資料來源，CDN JSON 是自動產生的公開快照，不手動維護。通路管理的新增、儲存、停用、封存與還原，會在同一個 D1 batch 記錄待發布版本，再重建整份清單、條件式寫入私有 MEDIA R2 bucket 並清除 CDN 快取。API 與快照共用同一份公開投影；JSON 多一個 `revision`，不包含 Drive 等管理資料。

發布失敗不回滾已儲存的據點，也不拿錯誤結果蓋掉最後快照；若連發布狀態的 D1 存取都失敗，通路仍回報儲存成功，發布版號以 `null` 表示未知，不假造已發布狀態；通路管理會顯示待發布狀態並提供手動重試，既有每 15 分鐘排程也會補跑，首次排程會建立既有資料的快照；報表背景匯入若修改通路基本資料，也會記錄待發布並由排程補上。R2 ETag 條件式寫入與 D1 版本核對，避免較慢的舊發布覆蓋新版。強制重發或已結案快照遺失後的重建，會建立新的發布版本；發布錯誤也視為待重試，不能被相同的已發布版號掩蓋。

CDN 路徑不查 D1、不需要 session，支援公開 CORS、ETag 與最長 60 秒快取；清除快取不能撤回瀏覽器已快取的內容，極端競爭下也可能短暫讀到上一版。這仍與 API 共用 Worker，因此隔離的是 D1／API 路由故障，不是整個 Worker 部署故障。發布沿用既有 MEDIA、MEDIA_CDN_URL、MEDIA_CDN_ZONE_ID 與 MEDIA_CDN_PURGE_TOKEN 設定；缺少設定時保留待發布，不能誤報成功。

通路管理可用 Google Maps 搜尋地點，選取後自動帶入 SVG X/Y 並顯示換算結果，仍可在下方手動微調；按儲存才保存 SVG X/Y，不保存經緯度。換算使用與底圖 22 個縣市路徑相符的 [Simplemaps Mercator 校準資料](https://simplemaps.com/static/svg/country/tw/admin1/mapinfo.js)，不是把經緯度線性鋪滿 viewBox；仍限本島範圍（經度 120–122.1、緯度 21.9–25.3）且必須落在允許的 SVG 座標範圍內。超出範圍會清空 X/Y，地址無法辨識縣市時會清空縣市，避免沿用上一個地點的資料。

舊據點只有保存 X/Y，沒有原始經緯度或手動調整紀錄，因此不自動重算既有資料；要套用校準公式，需在通路管理重新選取 Google Maps 地點並儲存。只重新匯入 block 不會修正先前公式產生的舊 X/Y。
