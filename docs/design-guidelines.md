# Rueisiang 平台 UI Design Guideline

> 文件類型：系統現況與共同規格。程式碼是實作的唯一來源；本文件定義共用邊界、視覺契約與新增 UI 時的判斷規則。

## 適用範圍

這份規格適用於：

- `apps/portal`：平台管理站，包含 `/hr` HRIS 管理介面。
- `apps/hr`：員工 HR 站，包含打卡、申請與個人資訊。
- 其他沿用平台 Material 3 視覺的前端頁面。

所有涉及 UI 的 agent，在新增或修改頁面、元件、CSS 前先讀本文件與 `better-ui` skill。若既有元件能承載需求，不得在 route 裡另做一份外觀相同的 markup 或 CSS。

樣式寫在哪裡（元件內的 Tailwind utility、不從外面覆寫、CSS 檔只留 utility 寫不到的東西）以 [`CLAUDE.md`](../CLAUDE.md) 的「CSS 怎麼分工」為準；資料表的尺寸、tooltip 的規格也寫在那裡，本文件不重複。

## 盤點結論

### 跨 app 應共用的 primitive

| 類別 | 共用來源 | app 端做法 |
|---|---|---|
| UI primitive | `packages/ui/src/` | `apps/portal/src/ui/`、`apps/hr/src/ui/` 對共用元件只 re-export，不放第二份實作；只有該 app 用到的元件（例如 portal 的 `FieldGrid`、`TableNote`、`RowActions`、`Stat`、`Tag`）直接寫在該 app 的 `ui/` |
| 對話框 context | `packages/ui/src/dialog-context.ts` | 兩個 app 只 re-export type／context |
| icon registry | `packages/ui/src/icons.tsx` | 兩個 app 的 `shell/icons.tsx` 只 re-export；portal 原有 icon 名稱全部保留 |
| HRIS composite | `SegmentedControl`、`FilterToolbar`、`EmptyState`、`DataTable` | HR route 直接從 app 的 `ui/index.ts` 組合，實作仍只有一份 |
| token | `packages/ui/theme.css` | 兩個 app 的 styles 入口只 import 這份 |
| primitive 外觀 | `packages/ui/src/*.tsx` | table、status、alert、empty、dialog、panel、field、filter、pager、sortable header、tooltip、button、chip 的外觀用 Tailwind utility 寫在各自的元件裡，沒有共用的 CSS 檔；app 的 `styles/components.css` 只放 `@keyframes` 與第三方元件（地圖）的 DOM |

`packages/ui` 匯出的 primitive 包含 `Button`、`ButtonLink`、`Chip`、`Dialog`、`ConfirmDialog`、`DropdownSelect`、`SearchCombobox`、`FilterInput`、`FilterSelect`、`SearchFilterInput`、`FilterToolbar`、`Pager`、`SortableHeader`、`Alert`、`StatusBadge`、`Field`、`TextField`、`SelectField`、`Page`、`Panel`、`PageHeader`、`SegmentedControl`、`Tooltip`。`Dialog` 預設 portal 到 `body`；需要保留在沉浸式全頁容器內的例外，明確使用 `portal={false}`（打卡頁的確認框）。

app `ui/*.tsx` 裡 re-export 共用元件的檔案是刻意保留的相容性入口，**不要在那裡重新加入共用元件的實作**。新的元件只要兩個 app 都會用，就先放 `packages/ui`，再由兩個 app re-export。

### HRIS composite 的規範

| 元件 | 用途 | 規範 |
|---|---|---|
| `SegmentedControl` | 特休、申請類型、勞健保狀態、級距種類等分段切換 | 用 `options`、`value`、`onChange`、`aria-label` 表達；selected／`aria-pressed` 不可由每頁自行拼 class |
| `FilterToolbar` | 面板頂端的搜尋／篩選列 | 保留表單語意；搜尋、篩選、清除動作與 responsive 排列集中管理，不要自己拼工具列 |
| `StatusBadge` | 所有狀態呈現 | domain status 的 label／tone mapping 留在 route 或 domain module；外觀一律交給 `StatusBadge`，不要在 `<span>` 上自己寫狀態色 |
| `EmptyState` | 列表沒有資料 | 表格上下的單行狀態說明用 `TableNote`；載入中用 skeleton／loading；錯誤用 `Alert`，三者不要混成一個狀態 |
| `EmployeeFilterBar` | 敘薪與勞健保頁的員工搜尋、帳號狀態篩選與分頁 query 組合（`apps/portal/src/routes/hr/EmployeeFilterBar.tsx`） | 兩頁的業務資料不同，但篩選 UI 與 query state 共用；共用元件不得承擔薪資或保險規則 |
| `DataTable` | 一般資料表的外框、格子與手機卡片 | `DataTable` 不負責欄位、排序、分頁或資料渲染；不要為不同欄位做一個過度通用的資料渲染器，只有排序、分頁、選取等行為穩定重複時才抽小元件（例如 `SortableHeader`、`TableBulkActionMenu`） |

## 元件使用契約

### 元件來源

| 需求 | 必須使用 |
|---|---|
| 一般動作、危險動作、圖示動作、文字動作、loading | `packages/ui` 的 `Button`：`variant` 選種類、`tone` 選語意色（`brand`／`success`／`info`／`danger`）、`size="lg"` 是 44px 高度（手機動作列、跟輸入框同列）、`active` 是 secondary 的開啟狀態、`mobileIconOnly` 讓頁首新增鈕在手機收成圓形圖示鈕；外觀寫在元件內，`className` 只給版面用 |
| portal 的玻璃樣式按鈕 | 同一個 `Button`，由外層的 `<ButtonSkin skin="glass">` 決定皮膚（`AppShell` 用 `shell/GlassSkins` 替所有模組包好）；頁面不必也不可以自己指定。皮膚用 context 傳，portal 出去的對話框也跟得到。輸入框、表格、面板同理，用 `InputSkin`、`TableSkin`、`PanelSkin` |
| 按鈕放在有底色的區塊或圖片上 | 外層包 `<ButtonSkin skin="paper">`，透明底的 secondary／icon 會改成紙色底 |
| 浮在地圖這類內容上的按鈕 | 外層包 `<ButtonSkin skin="floating">`，紙色底再加陰影 |
| 長得像按鈕、但會換頁的連結 | `ButtonLink`（輸出 `<a>`），不要在 `<a>` 上寫按鈕的 class |
| 篩選膠囊、虛線框的「新增一個」、名稱＋刪除的分段膠囊 | `Chip`（`variant`：`filter`／`action`／`label`／`remove`）與 `ChipGroup`；它表達的是狀態或一個項目，不是動作，所以不併進 `Button` |
| 只出現一次、外觀完全客製的按鈕（員工站表單頁的浮動新增鈕、頭像相機鈕、薪資試算進度分頁） | 直接寫 `<button>`，樣式用 Tailwind utility 寫在那個元素上；不要為它在 `Button` 加 prop |
| 對話框、確認、編輯表單 | `packages/ui` 的 `Dialog`；不要在 route 自己寫 backdrop、`role="dialog"` 或關閉動畫 |
| 單選、多選、搜尋選單 | `packages/ui` 的 `DropdownSelect`、`SearchCombobox` 或 `SelectField` |
| 搜尋與篩選 toolbar | `FilterToolbar` 搭配 `FilterInput`、`FilterSelect`、`SearchFilterInput` |
| 分頁導覽與每頁筆數 | `Pager`；頁碼、筆數與 query state 仍由 route 管理 |
| 表格排序 | `SortableHeader`；排序欄位、方向與 query state 仍由 route 管理 |
| 欄位 label、必填、hint、error | `Field`、`TextField`、`SelectField` |
| 成功／資訊／警告／錯誤 | `StatusBadge` 或 `Alert` |
| 頁面標題、卡片 surface | `PageHeader`、`Panel`；面板標題列用 `Panel` 的 `title`／`description`／`actions`，不要在 `Panel` 裡自己寫 `data-panel-head` 那一層；props 真的表達不了時才用匯出的 `PANEL_HEAD`。`PageHeader` 的 `description` 在 portal 不顯示（`AppShell` 用 `PageDescriptions` 統一關掉），會跟著資料變、或使用者必須知道的資訊要寫在頁面上 |
| 補充提示 | `Tooltip`；不要使用原生 `title` |
| icon | `packages/ui/src/icons.tsx` 的共用 `Icon` registry，SVG 使用 `currentColor`；不要引入 icon font 或單頁 SVG 資產 |
| table wrapper | `DataTable`；欄位與 domain row 仍由 route 負責。不要在 route 自己寫 `<table>`；格子的預設值寫在 `className`，外框的版面寫在 `containerClassName`；外框裡還要放別的東西時才用 `scroll={false}` 自己包 `data-table-scroll` ＋ `TABLE_SCROLL`，保留可讀的 domain markup |

`packages/ui` 是共用元件的唯一實作來源，不可只在其中一個 app 複製修正。

### Button

- `primary`：完成、建立、送出等主要動作。**預設 `tone="brand"` 的 `primary` 顏色隨皮膚不同**：portal（`glass` 皮膚）是資訊藍，員工 HR 站（`solid`）是品牌紅。portal 的新增鈕用 `tone="success"`（綠）。品牌紅與 `danger` 的深紅只差一點深淺，所以 `solid` 皮膚底下不可以把預設 tone 的 `primary` 跟 `danger` 並排——給 `primary` 一個語意 tone。
- `secondary`：取消、返回、次要導覽或不具破壞性的輔助動作。
- `danger`：刪除、撤回、停用等不可逆或高風險動作。等同 `primary` 加 `tone="danger"`。
- `icon`：表格列操作或純圖示控制；一定要有 `aria-label`，需要說明時包 `Tooltip`。
- 新增／建立／加入動作用 `tone="success"`；修改／更新、查看／資訊用 `tone="info"`。刪除、撤回、停用仍使用 `danger`，不要用綠色或藍色取代危險語意。
- 審核的「核准／通過」用 `tone="success"`，與 `StatusBadge tone="success"` 的「已核准」同色；「駁回」使用 `danger`。兩個結果相反的動作並排時必須是不同色相，不能只差深淺。兩個站都照這條，不要各自挑色。

| 動作 | 寫法 | 顏色 | token |
|---|---|---|---|
| 新增、建立、加入、送出新申請 | `tone="success"` | 綠 | `--color-ok` |
| 核准、通過 | `tone="success"`（`primary`） | 綠 | `--color-ok` |
| 修改、更新、重新送出 | `tone="info"` | 藍 | `--color-info` |
| 查看、進入審核 | `tone="info"` | 藍 | `--color-info` |
| 刪除、駁回、撤回、停用 | `variant="danger"` | 深紅 | `--color-brand-dark` |
| 取消、返回、保留 | `variant="secondary"` | 中性 | — |

語意色與皮膚都是 `Button` 自己的 prop 與 context，不靠祖先選擇器，所以 portal 到 `body` 的對話框裡顏色一樣正確。**不要寫掛在站台範圍 class 底下的樣式**（例如 `.某站 .某按鈕`）：對話框 portal 出去就會脫離那個範圍。React context 會穿過 portal，所以對話框在皮膚 provider（`ButtonSkin` 等）底下開，就拿得到頁面的皮膚；掛在 shell 層、不在任何版面底下的對話框（例如未儲存變更的確認框）拿到的是預設的 `solid` 皮膚。

- `loading` 時由元件負責 disabled 與 `aria-busy`；不要在 route 另做一顆「處理中」按鈕。
- filter chip 用 `selected`，不要在頁面手寫 `aria-pressed` 與 selected class 的同步邏輯。
- 除非連續操作會被縮放干擾，保留按下 `scale: .96`；停用時才使用 `static`。

### Dialog

- `Dialog` 只接受標題、內容與 actions；遮罩、ARIA、focus／close 行為與退場流程集中在元件。
- 有表單時使用 `formProps`，actions 放在 `actions`；不要讓 footer 跟著可捲動 body 一起捲走。
- 非同步成功後關閉使用 `closeRequestRef`，不要直接卸載造成退場動畫被截斷。
- `role="alertdialog"` 只用於需要使用者確認的高風險動作。

### Form

- label、hint、error 一律由 `Field` contract 提供。
- 一般控制項高度使用 `--size-field`（44px）；並排欄位使用 portal 的 `<FieldGrid>`，一列欄位加按鈕使用 `<FormRow>`。
- textarea 也要放在 `Field` 內；不能只用 placeholder 代替 label 或錯誤訊息。
- 搜尋、篩選是 toolbar 的控制項，不要把頁面資料編輯欄位與篩選欄位混成同一種 layout。

### Status、loading、empty、error

- 狀態顏色是語意，不是頁面自行挑色：`success`、`info`、`warning`、`danger`、`neutral`。
- 同一個 domain status 的 label／tone mapping 放在 domain module 的單一函式或 map；視覺套用由 `StatusBadge` 完成。
- `Alert tone="danger"` 用於錯誤或需要立即注意的訊息；成功回饋不得只靠動畫或顏色。
- 表格無資料使用 `EmptyState`；查詢仍在進行使用 `HrSkeleton` 或明確的 loading state；不要在空資料時顯示錯誤訊息。

### Table

所有一般資料表遵守同一個外框：

```tsx
<DataTable className="[&_td]:align-top" containerClassName="mt-4">
  {/* thead / tbody；欄位與 row 由 route 負責 */}
</DataTable>
```

- 尺寸、欄距、分隔線、hover，以及怎麼覆寫格子預設值，見 [`CLAUDE.md`](../CLAUDE.md) 的「資料表」。
- 數字欄的格子加 `numeric`：`DataTable` 用 `[&_.numeric]` 套 tabular numerals，桌機寬度靠右。
- sticky header、手機 `data-label`、可點列的鍵盤操作要由 table contract 一起維護。
- 不要為了單一頁面複製一份表格外框；頁面特殊需求寫成 utility，傳給 `DataTable` 的 `className`／`containerClassName`。
- 具備 mobile select-all 或其他 table 外部工具列的特殊頁面，可以保留 route 的外層 layout；真正的 table 仍使用 `DataTable`。

## Visual tokens

token contract 唯一來源是 `packages/ui/theme.css` 的 `@theme`，兩個 app 的 styles 入口只 import 這份，不得建立 app 專屬色票。新增 token 先確認它不是既有語意的別名。

| 用途 | token／規格 |
|---|---|
| 品牌主色 | `--color-brand`；hover／深色文字用 `--color-brand-dark` |
| 選中容器 | `--color-brand-soft` + `--color-brand-dark`，不用高彩度整塊填滿 |
| 文字層級 | `--color-ink`、`--color-muted` |
| surface | `--color-paper`、`--color-canvas` |
| 結構線 | `--color-line`、`--color-soft-line` |
| 語意色 | `--color-ok`、`--color-info`、`--color-warn` 及各自的 `*-soft` |
| 卡片 | `--radius-card`（14px）、`--shadow-panel` |
| 欄位 | `--radius-field`（9px）、`--size-field`（44px） |
| 圓角 | 可點列／chip／nav 用 `999px`；小元件 9–12px；卡片 14px；Dialog 28px |
| 字型 | `--font-sans`；body 14px、line-height 1.5 |

禁止在 route 或元件裡新增品牌 hex、近似中性色、`rgba` 品牌色或第二份 shadow。半透明品牌層使用 `bg-brand/7`，CSS 檔裡用 `--alpha(var(--color-brand) / n%)`。結構線保留 border；只為製造深度的 border 優先改成透明 layered shadow。

## Motion、icon 與 accessibility

- interactive state 只 transition 會變的 property；不要使用 `transition: all`。
- high-frequency feedback 使用 150ms 以內；共用按鈕按下是 `.96`、120ms ease-out。
- Dialog 退場為 180ms；退場動畫與 `Dialog.tsx` 的 `DIALOG_EXIT_DURATION_MS` 必須同步。
- 進場可分語意區塊、約 100ms stagger；退場使用小幅固定位移，不做整個容器高度動畫。
- 尊重 `prefers-reduced-motion`；動畫不能是唯一狀態訊號。
- icon 預設 24px、線性、`currentColor`；icon stroke 要跟文字權重一致。
- 所有互動元件都有 `:focus-visible`；非互動 tooltip anchor 只在必要欄位加 `tabIndex`。Tooltip 的其他規格見 `CLAUDE.md` 的「提示（Tooltip）」。

### HRIS shell 的例外

HRIS 管理站（portal 的 `routes/hr/HrLayout.tsx`、`HrShell.tsx`）有獨立的 liquid-glass shell、sticky header、頁面轉場與 surface；員工站（`apps/hr` 的 `HrLayout`）有 mobile bottom navigation 與打卡沉浸頁。這些是兩種不同產品 shell，不要為了「看起來都叫 HR」把兩個 `HrLayout`、打卡地圖、管理排班月曆合成一個巨型元件。

共用的是 primitive、token、icon 與 state contract；shell 的版面與領域元件保持各自清楚的責任。

## Agent 開發檢查表

1. 先找 `packages/ui`、app 的 `ui/`、`shell/` 與 token；有既有元件就直接組合，不在 route 重寫 markup。
2. 新增變體先問：是穩定的語意變體，還是單頁一次性的版面？前者替元件加 prop，後者在使用的那一層用 utility 寫版面。
3. 同一個 pattern 出現於兩個 app 或三個以上 route，先提取 contract，再決定是否抽到 `packages/ui`。
4. 不新增第二個 `Button`、`Dialog`、`Field`、`StatusBadge`、`Tooltip`、`SegmentedControl`、`FilterToolbar`、`EmptyState` 或 icon registry；app `ui/` 對共用元件只允許 re-export。
5. 檢查 hover、focus-visible、active、disabled、loading、error、empty、responsive 與 reduced motion；每個狀態都要有非動畫的視覺或文字訊號。
6. UI diff 送 review 時列出使用的共用元件、token、特殊寫法，以及沒有抽象的理由。
7. 送 review 前至少跑兩個 app 的 typecheck／build 與相關 tests；`pnpm lint` 會檢查 HR 路由有沒有繞過 `DataTable` 直接寫 `<table>`。

違反本文件的例外必須在 PR 說明原因；不要以「這頁只用一次」為理由複製已存在的共用 primitive。
