# HR 員工設定 PRD

本文件描述員工主檔與內頁的資料契約；實際欄位與驗證以程式碼為準。

## 1. 目的與資料模型

HR 員工是既有平台使用者（`users`）的人事延伸；帳號狀態與員工在職狀態分開管理。

```text
users 1 ─── 0..1 hr_employments 1 ─── 0..1 hr_employment_service_periods
```

`hr_employments` 是唯一的員工主檔，也是目前職位的唯一來源；服務年資起算日另存於 `hr_employment_service_periods.service_start_on`，設為未在職／恢復在職沿用同一筆資料：

| 欄位 | 語意 |
|---|---|
| `employee_user_id` | 對應 `users.id`；Google 帳號名稱、Email 與帳號狀態仍以 `users` 為準 |
| `legal_name` | 身分證上的正式姓名，由 HR 維護；與 Google 帳號名稱分開使用 |
| `employee_number` | 員工編號；活動員工不可重複 |
| `position` | 目前職位；升遷／調職直接更新此欄位 |
| `supervisor_user_id` | 目前主管，可為 NULL |
| `archived_at` | NULL 表示在職；非 NULL 表示未在職（底層保留封存時間） |
| `id` | 穩定的 `employmentId`，供薪資、出勤、保險、假勤、排班與稽核歷史使用 |
| `revision` | 一般員工資料異動的競態控制版本 |

服務年資起算日是薪資計算在職日的起點，也是不早於此日的特休起算下限；特休仍只適用有有效月薪敘薪版本的員工，實際特休起算日取第一筆月薪 `validFrom` 與服務年資起算日的較晚者。不用服務年資日期推導目前是否在職；在職條件仍只看 `hr_employments.archived_at IS NULL`。升遷、調職不建立任職版本；`hr_compensation_versions` 仍保留自己的敘薪版本控制。設為未在職不物理刪除列，也不刪除任何下游資料。

## 2. 核心決策

1. `users.status` 與 `hr_employments.archived_at` 是兩個獨立狀態。
2. `active` 員工的判斷唯一為 `archived_at IS NULL`，不使用到職日、離職日或帳號狀態推導。
3. `active` 或 `invited` 的 User 可以指派；`disabled` 帳號不能新指派。
4. 指派時同一個原子操作建立員工主檔與 `hr_employment_attendance_settings`，預設出勤方式為一般辦公。
5. 正式姓名、員工編號、職位與主管直接保存於同一筆 `hr_employments`；Google 帳號名稱留在 `users`。
6. 設為未在職只改變業務欄位 `archived_at`；`revision` 僅前進作為競態控制，不改寫正式姓名、員工編號、職位、主管、`employmentId` 或下游歷史。
7. 恢復在職沿用同一個 `employmentId`，清除 `archived_at` 並由資料庫唯一索引檢查在職員工編號與 User 的唯一性。
8. 帳號停用不等於員工未在職；員工未在職也不會停用帳號。

## 3. 範圍

### 包含

- 從既有 User 候選清單指派員工。
- 編輯身分證正式姓名、員工編號與目前職位。
- 修正服務年資起算日（影響薪資試算，並作為月薪員工特休起算下限）。
- 設定或清除目前主管。
- 查看、搜尋、排序與分頁員工。
- 將員工設為未在職與恢復在職。
- 查看出勤設定、工作範圍與下游歷史入口。
- 將穩定 `employmentId` 傳給薪資、出勤、保險、請假、加班、排班、獎金與稽核模組。

### 不包含

員工基本資料頁不直接編輯：

- 薪資與勞健保版本
- 營運據點／出勤位置指派
- 排班與班別
- 獎金、請假與加班

這些資料由各自的 HR 管理頁維護；它們保留自己的歷史與版本規則。

## 4. 頁面與欄位

```text
HRIS
└─ 員工管理
   ├─ 員工列表
   └─ 員工內頁
```

### 員工列表

- 主要操作為「新增員工」與點擊整列開啟員工內頁，沒有重複的操作欄；整列支援滑鼠、Enter 與 Space。在職狀態操作放在內頁，以「設為未在職／恢復在職」呈現。
- 搜尋正式姓名、Email、員工編號與職位。
- 員工狀態分為「在職」與「未在職」；判斷只看 `archived_at`。
- 帳號狀態另看 `users.status`，至少顯示全部、啟用中、待啟用與已停用。
- 欄位包含員工編號、正式姓名、職位、Email、帳號狀態、主管與員工狀態。
- 支援排序、分頁與在職／未在職計數；Google 帳號名稱與 Email 不複製到 HR 任職主檔。

### 指派 Dialog／內頁恢復在職表單

| 欄位 | 必填 | 規則 |
|---|---:|---|
| 使用者 | 是 | 只能選尚未有活動 `hr_employments` 的 `active`／`invited` User |
| 正式姓名（身分證） | 是 | 1～100 字；不改變 Google 帳號名稱 |
| 員工編號 | 是 | 1～40 字元；活動員工全平台唯一 |
| 職位 | 是 | 1～100 字元 |
| 服務年資起算日 | 指派時是 | `YYYY-MM-DD`；薪資月份與此日期有交集才計算薪資，並作為特休起算下限 |
| 出勤方式 | — | 員工資料 Dialog 不維護；新員工預設為 `general`，排班與月休在出勤設定維護 |

恢復未在職員工時沿用原列、原 `employmentId` 與原服務年資起算日，只清除未在職狀態並套用新的員工編號／職位；既有列必須帶目前 `revision`，避免無版本的舊請求覆寫恢復資料。

### 員工內頁

- 正式姓名、員工編號、職位、主管與 `employmentId` 來自同一筆 `hr_employments`；Google 帳號名稱、Email、帳號狀態來自 `users`，內頁分開顯示兩種姓名。
- 依序顯示大頭貼、基本資料、聯絡資料、公司／任職資料、敘薪、保險、出勤；頂部浮動導覽可跳到存在的區塊，隨捲動標示目前位置。
- 「基本資料」維護正式姓名、員工編號與個資；「聯絡資料」維護電話、地址與緊急聯絡人；「公司／任職資料」維護職位、主管、服務年資與在職狀態。三區在內頁切換檢視與填寫，不另開員工資料 Dialog；編輯沿用 HR 修改操作的藍色語意。
- 大頭貼支援選檔預覽、儲存、更換與確認移除，接受 5 MB、800 萬像素、單邊 8192 px 以內的 JPEG、PNG、WebP 靜態照片（不支援 MPF／MPO 多影像 JPEG）。前端先確認可解碼，檢查中或預覽失敗不可儲存；API 先查 metadata 影像數、拒絕 JPEG header 中的 MPF APP2，再使用純 JS codec 完整解碼，不只檢查檔頭，解碼資料上限 32 MB、最多一幀，畸形圖片不改參照或 revision。
- 檔案沿用私有 `UPLOADS` R2 binding，`hr_employee_photos` 僅保存目前版本的參照，與任職 revision 同批次更新；確定的 revision 衝突清理新檔，成功替換後清理舊檔。D1 回應遺失時核對目前照片 ID，確認已提交則回報成功；無法確認（含讀取失敗、尚未提交）保留新檔並記錄 `hr.employee_photo_write_unconfirmed`，不將未知錯誤視為回滾。這可能留下未參照檔案，後續清理必須核對資料庫狀態，不以單次讀取不存在即刪檔。管理端檔案讀取每次檢查 HR 權限並禁止快取；封存保留照片、禁止異動，復職沿用。照片編輯與其他分區編輯互斥，失敗保留選檔預覽。
- 個資與聯絡資料存於 `hr_employee_personal_data`，以 `employmentId` 關聯並沿用任職 revision，在同一 batch 更新。欄位目錄為 `packages/db/src/hr-profile-fields.ts`；省略欄位保留既有值，空字串明確清空。
- 敘薪、保險與出勤使用獨立區塊呈現；長打卡與請假歷史可收合。辦公位置新增、變更與結束仍在出勤範圍管理處理。
- 顯示未在職時間與目前出勤設定；未在職員工仍可查閱下游歷史。
- 服務年資起算日是薪資試算的在職起算日與特休起算下限；特休只看第一筆有效月薪敘薪的生效日，不會自動改寫服務年資日期。
- 薪資、保險、假勤、打卡、工作範圍與排班使用相同 `employmentId` 查詢。

## 5. 狀態與異動規則

### 指派

指派須在同一個資料庫 batch 內完成：

1. 建立或恢復在職 `hr_employments`。
2. 建立或更新 `hr_employment_attendance_settings`。
3. 寫入 HR activity event。

任一步失敗都不得留下半套員工資料。唯一索引與 mutation guard 同時防止重複指派及競態寫入。

### 正式姓名

HR 指派、編輯或恢復在職員工時必須維護 1～100 字的身分證正式姓名。姓名異動只更新 `hr_employments.legal_name`，不改寫 `users.display_name`、`users.google_name` 或登入帳號；下游 HR 查詢以正式姓名為主，既有帳號名稱只作回填與缺值 fallback。

### 升遷／調職

編輯目前職位只更新 `hr_employments.position`；不新增任職列、不改 `employmentId`，也不自動建立敘薪版本。需要薪資變更時，由敘薪頁建立對應的 `hr_compensation_versions`。

### 修正服務年資起算日

HR 可在目前任職的 revision 保護下修正 `hr_employment_service_periods.service_start_on`。這只更新服務年資資料並前進 `hr_employments.revision`，不改寫敘薪版本；薪資試算會以修正後的日期判定該月份是否有在職區間，特休則以服務年資日期與第一筆月薪敘薪生效日的較晚者為起算日。若敘薪生效日早於服務年資起算日，敘薪頁必須明確提示兩者差異。已有特休週期的任職不可直接修改，避免既有額度與台帳產生重疊；這類更正須依特休／薪資調整流程處理。

### 設為未在職

「設為未在職」使用 `archived_at = CURRENT_TIMESTAMP`，並寫入 `employment_archived` activity event。這是底層保留歷史的實作名稱；使用者介面與業務語意統一稱為「未在職」。此操作不得物理刪除：

- `hr_employments` 原列與 `employmentId`
- 員工編號、職位、主管與建立／更新時間
- 出勤、打卡、工作範圍、薪資、保險、假勤、加班、排班、獎金與薪資結算
- `hr_employment_actions` 與共用 activity log

恢復在職不是建立新版本；仍使用同一筆主檔。舊 client 的 `/end` 與 `/withdraw` 路由可相容地映射到未在職，但新 UI 使用「設為未在職／恢復在職」語意。

## 6. 主管規則

- 主管必須是另一位 `active` 帳號且有在職的 `hr_employments`。
- 不可指定自己；可清除主管。
- 主管保存於 `hr_employments.supervisor_user_id`，補打卡與其他申請可把它作為預設審核者。

## 7. 權限

| 操作 | 權限 |
|---|---|
| 查看員工列表與基本資料 | `hr:employee:read` |
| 指派、編輯、修正服務年資、設為未在職、恢復在職 | `hr:employee:write` |
| 設定主管 | `hr:employee:write` |
| 出勤方式與位置設定 | `hr:office:write` |
| 管理端大頭貼、個資與聯絡資料 | 全平台 HR 管理者，且具備對應的員工讀取／寫入權限 |
| 本人大頭貼查看、上傳、更換與移除 | 有效的本人 session（含裝置／LINE），啟用帳號且仍在職；不要求管理端權限 |
| 薪資、保險與敏感歷史 | 依各模組的獨立權限 |

個資不出現在員工列表、本人入口或僅有辦公讀取權限的回應中；大頭貼版本僅提供本人與全平台 HR 管理者，不包含物件 key，也不加入列表／辦公回應。稽核記錄異動欄位名稱，不複製證件、生日、電話與地址。

本人入口只依 session User 查詢在職員工，不接受 query string 覆寫身分；未在職員工不再視為 HRIS 活動員工。

### 員工端個人中心

- `hr.rueisiang.com` 個人中心顯示同一張員工大頭貼，無照片或讀取失敗時以姓名首字／人像 fallback。
- `/api/hr/me` 只新增 `photo: { id } | null`，不因此開放個資或聯絡資料。
- `GET /api/hr/me/photo` 私有串流；`POST` 接收 multipart `file` 與 `revision`；`DELETE` 接收 JSON `revision`。目標任職完全由已驗證 session 決定，不採信 query／body 中的其他員工 ID。
- 本人與管理端共用 API 圖片驗證／R2 檔案生命週期與 DB revision guard；帳號停用、非員工、未在職者均不得使用本人入口。裝置 cookie 保持 `/api/hr/me` 路徑限制，管理端權限不變。
- 本人選檔可預覽、取消、儲存、替換及確認移除；檢查中／無法解碼不能儲存。選檔或開啟移除確認時捕捉 revision；背景 refetch 不覆寫，409 保留選檔與錯誤。預覽共用 `@rueisiang/ui` 的 blob／decode hook，取消或換帳號卸載時釋放 URL，舊 decode 結果不回寫。
- 仍只保存目前照片，不新增照片歷史、公開 URL、裁切或個資自助編輯。

## 8. 失敗狀態與驗收

後端必須明確回報：User 不存在或帳號不可指派、在職 User 已存在、員工編號重複、主管無效、員工已是未在職或資料在競態中變更。錯誤不得留下成功 activity event 或半套設定。

驗收重點：

- 同一 User 最多一筆在職 `hr_employments`。
- 同一員工編號最多一筆在職 `hr_employments`。
- 升遷／調職前後 `employmentId` 不變，且不會多出任職列。
- 設為未在職後資料與所有外鍵歷史仍可查，恢復在職沿用原列。
- 停用帳號與員工未在職互不代替。
- 所有活動員工查詢以 `archived_at IS NULL` 為條件。
- 任何下游歷史不得因員工設為未在職而被刪除或改寫。

## 9. UI 要求

沿用 Material 3 與既有元件：列表使用 `.page.fills`／`.panel.grows`、`.data-table` sticky header、compact toolbar 與既有 Dialog。主要操作靠右、危險操作使用 archive 語意；表格列只提供入口，基本、公司與聯絡資料在員工內頁分區編輯；其他領域異動仍使用各自的 HR 管理頁。鍵盤焦點、可及性名稱、錯誤訊息與 Tooltip 必須遵守共用元件規格。
