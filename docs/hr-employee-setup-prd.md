# HR 員工設定 PRD

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

服務年資起算日是薪資計算在職日與週年制特休年資的起點，不用來推導目前是否在職；在職條件仍只看 `hr_employments.archived_at IS NULL`。升遷、調職不建立任職版本；`hr_compensation_versions` 仍保留自己的敘薪版本控制。設為未在職不物理刪除列，也不刪除任何下游資料。

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
- 修正服務年資起算日（影響薪資試算與週年制特休）。
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

- 主要操作為「新增員工」與開啟「員工資料」；在職狀態操作以「設為未在職／恢復在職」呈現。
- 搜尋正式姓名、Email、員工編號與職位。
- 員工狀態分為「在職」與「未在職」；判斷只看 `archived_at`。
- 帳號狀態另看 `users.status`，至少顯示全部、啟用中、待啟用與已停用。
- 欄位包含員工編號、正式姓名、職位、Email、帳號狀態、主管與員工狀態。
- 支援排序、分頁與在職／未在職計數；Google 帳號名稱與 Email 不複製到 HR 任職主檔。

### 指派／恢復在職 Dialog

| 欄位 | 必填 | 規則 |
|---|---:|---|
| 使用者 | 是 | 只能選尚未有活動 `hr_employments` 的 `active`／`invited` User |
| 正式姓名（身分證） | 是 | 1～100 字；不改變 Google 帳號名稱 |
| 員工編號 | 是 | 1～40 字元；活動員工全平台唯一 |
| 職位 | 是 | 1～100 字元 |
| 服務年資起算日 | 指派時是 | `YYYY-MM-DD`；薪資月份與此日期有交集才計算薪資 |
| 出勤方式 | — | 員工資料 Dialog 不維護；新員工預設為 `general`，排班與月休在出勤設定維護 |

恢復未在職員工時沿用原列、原 `employmentId` 與原服務年資起算日，只清除未在職狀態並套用新的員工編號／職位；既有列必須帶目前 `revision`，避免無版本的舊請求覆寫恢復資料。

### 員工資料 Dialog 與內頁

- 正式姓名、員工編號、職位、主管與 `employmentId` 來自同一筆 `hr_employments`；Google 帳號名稱、Email、帳號狀態來自 `users`，內頁分開顯示兩種姓名。
- 員工資料 Dialog 直接編輯正式姓名、員工編號、職位、主管與服務年資起算日；不把任職另拆成第二層操作。
- 辦公位置在員工資料 Dialog 只顯示唯讀摘要，新增、變更與結束一律在出勤範圍管理處理。
- 顯示未在職時間與目前出勤設定；未在職員工仍可查閱下游歷史。
- 服務年資起算日是薪資試算與週年制特休的在職起算下限，敘薪生效日不會自動改寫它。
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

HR 可在目前任職的 revision 保護下修正 `hr_employment_service_periods.service_start_on`。這只更新服務年資資料並前進 `hr_employments.revision`，不改寫敘薪版本；薪資試算會以修正後的日期判定該月份是否有在職區間。若敘薪生效日早於服務年資起算日，敘薪頁必須明確提示兩者差異。已有特休週期的任職不可直接修改，避免既有額度與台帳產生重疊；這類更正須依特休／薪資調整流程處理。

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
| 薪資、保險與敏感歷史 | 依各模組的獨立權限 |

本人入口只依 session User 查詢在職員工，不接受 query string 覆寫身分；未在職員工不再視為 HRIS 活動員工。

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

沿用 Material 3 與既有元件：列表使用 `.page.fills`／`.panel.grows`、`.data-table` sticky header、compact toolbar 與既有 Dialog。主要操作靠右、危險操作使用 archive 語意；表格列只提供入口，完整編輯在 Dialog 或各自的 HR 管理頁。鍵盤焦點、可及性名稱、錯誤訊息與 Tooltip 必須遵守共用元件規格。
