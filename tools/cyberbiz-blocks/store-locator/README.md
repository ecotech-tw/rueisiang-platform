# 官網據點列表 block

- Cyberbiz 匯入檔：`block.html`
- 公開資料 API：`GET https://platform.rueisiang.com/api/public/store-locator`
- 管理入口：平台「通路管理」→ 櫃點 →「官網據點資料」

API 只公開 `scope_kind = store`、營業中、未封存，且已填地址、縣市、類型與台灣 SVG 圖釘 X/Y 的通路。列表依 SVG 的 Y 值由北到南排序；地圖位置是此 block 的 viewBox 座標（X 475–840、Y 245–960），不是經緯度。

官網圖片可選媒體庫 image ID（公開網址由既有 `cdn.rueisiang.com` 圖片 CDN 提供）或公開可讀取的 HTTPS 圖片網址。地址、營業時間、電話、樓層位置、分類與文案由通路資料提供；列表標題由「縣市＋通路名稱」組成，地圖標籤使用通路名稱。Google Maps 選取地點時會自動帶入地址。

據點 JSON 不另存 CDN 作為第二份資料來源。API 是 D1 的唯讀投影，回應允許客戶端快取 60 秒；對這種小型、低頻變更的清單，不值得再維護一份 CDN JSON。媒體圖片則繼續由現有 CDN 分發。

通路管理可用 Google Maps 搜尋地點，預覽經緯度及 SVG X/Y 試算值；選擇「帶入 X/Y 欄位」後仍可手動調整，儲存時只保存 SVG X/Y，不保存經緯度。試算採用本島估算範圍（經度 120–122.1、緯度 21.9–25.3）。
