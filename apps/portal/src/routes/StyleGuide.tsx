import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DateRangePicker } from "../shell/DateRangePicker.js";
import { Switch } from "../shell/Switch.js";
import { usePageTitle } from "../shell/usePageTitle.js";
import { PageTabs, WorkflowRunPanel } from "../ui/index.js";
import {
  Alert,
  Button,
  ButtonSkin,
  LegacyButton,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogScope,
  DropdownSelect,
  EmptyState,
  Field,
  FilterInput,
  FilterSelect,
  FilterToolbar,
  Icon,
  PageHeader,
  Pager,
  Panel,
  SearchFilterInput,
  SegmentedControl,
  SelectField,
  SortableHeader,
  StatusBadge,
  TextField,
  Tooltip,
  type IconName,
} from "@rueisiang/ui";

type SortDirection = "asc" | "desc";

const TOKENS = [
  { label: "主要色彩", variable: "--color-brand" },
  { label: "主要色彩容器", variable: "--color-brand-soft" },
  { label: "表面文字", variable: "--color-ink" },
  { label: "次要文字", variable: "--color-muted" },
  { label: "外框線", variable: "--color-line" },
  { label: "表面", variable: "--color-paper" },
  { label: "成功", variable: "--color-ok" },
  { label: "警告", variable: "--color-warn" },
  { label: "資訊", variable: "--color-info" },
];

const ICONS: IconName[] = ["analytics", "people", "payments", "calendar", "search", "edit", "check", "info", "tune", "external"];

const DROPDOWN_OPTIONS = [
  { label: "商品銷售", value: "sales" },
  { label: "出金表", value: "payout" },
  { label: "庫存清單", value: "inventory" },
];

const LIQUID_GLASS_NAV: ReadonlyArray<{ label: string; icon: IconName }> = [
  { label: "儀表板", icon: "analytics" },
  { label: "出勤", icon: "calendar" },
  { label: "薪資", icon: "payments" },
];

function LiquidGlassPreview() {
  const [activeNav, setActiveNav] = useState("出勤");
  const activeIndex = Math.max(0, LIQUID_GLASS_NAV.findIndex((item) => item.label === activeNav));
  const navStyle = {
    "--hr-thumb-x": `${6 + activeIndex * 96}px`,
    "--hr-thumb-w": "84px",
  } as CSSProperties;

  return (
    <div className="style-guide-liquid-preview">
      <ButtonSkin skin="glass"><div className="hr-module hr-system style-guide-liquid-system">
        <svg className="hr-liquid-defs" aria-hidden="true" focusable="false">
          <filter id="hr-liquid-glass-soft" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.018 0.024" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="4" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="hr-liquid-glass-menu" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.014 0.02" numOctaves="2" seed="11" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        <header className="hr-system-header">
          <div className="hr-system-brand">
            <img src="/ruei-siang-logo-dark.png" alt="RUEI SIANG" width={150} height={38} />
            <span>HRIS</span>
            <strong>元件展示</strong>
          </div>
          <nav className="hr-system-nav style-guide-liquid-nav" aria-label="Liquid Glass 範例導覽" style={navStyle}>
            <span className="hr-system-nav-thumb" aria-hidden="true" />
            {LIQUID_GLASS_NAV.map((item) => {
              const active = item.label === activeNav;
              return (
                <div className={`hr-system-nav-item${active ? " active" : ""}`} key={item.label}>
                  <button type="button" className="hr-system-nav-link" aria-pressed={active} onClick={() => setActiveNav(item.label)}>
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                </div>
              );
            })}
          </nav>
          <div className="hr-user-menu">
            <button type="button" className="hr-user-trigger" aria-label="Liquid Glass 帳號選單範例">
              <span className="account-avatar"><span className="account-avatar-initial">R</span></span>
            </button>
          </div>
        </header>
        <div className="hr-system-main style-guide-liquid-main">
          <div className="style-guide-liquid-content">
            <div className="style-guide-liquid-copy">
              <span className="style-guide-eyebrow">HRIS SHELL / LIQUID GLASS</span>
              <h3>透明、分層，但不犧牲可讀性</h3>
              <p className="muted">這裡直接重用 HRIS shell 的玻璃導覽、滑動 thumb 與 panel surface；按導覽項目可查看膠囊位置變化。</p>
            </div>
            <Panel title="共用元件放在玻璃表面上" description="Liquid Glass 是 HRIS shell 的 surface treatment；元件本身仍維持 packages/ui 的語意 API。">
              <div className="style-guide-liquid-metrics">
                <div><span>玻璃層級</span><strong>3 層</strong></div>
                <div><span>背景模糊</span><strong>7px</strong></div>
                <div><span>選取狀態</span><strong>{activeNav}</strong></div>
              </div>
              <div className="style-guide-row">
                <Button icon="check">共用按鈕</Button>
                <StatusBadge tone="info">Glass surface</StatusBadge>
              </div>
            </Panel>
          </div>
        </div>
      </div></ButtonSkin>
    </div>
  );
}

export function StyleGuide() {
  usePageTitle("UI 元件樣式指南");
  const [enabled, setEnabled] = useState(true);
  const [range, setRange] = useState({ start: "2026-07-01", end: "2026-07-31" });
  const [page, setPage] = useState(3);
  const [pageSize, setPageSize] = useState(20);
  const [message, setMessage] = useState("按下按鈕測試共用元件的互動狀態。");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const [search, setSearch] = useState("王小明");
  const [segment, setSegment] = useState("all");
  const [sort, setSort] = useState<{ field: string; direction: SortDirection }>({ field: "name", direction: "asc" });
  const confirmTimerRef = useRef<number | null>(null);
  const closeDialog = () => setDialogOpen(false);

  useEffect(() => () => {
    if (confirmTimerRef.current !== null) window.clearTimeout(confirmTimerRef.current);
  }, []);

  function handleConfirm() {
    setConfirmPending(true);
    confirmTimerRef.current = window.setTimeout(() => {
      confirmTimerRef.current = null;
      setConfirmPending(false);
      setConfirmOpen(false);
      setMessage("確認動作已完成。");
    }, 600);
  }

  function handleSort(field: string, direction: SortDirection) {
    setSort({ field, direction });
    setMessage(`目前依「${field}」${direction === "asc" ? "遞增" : "遞減"}排序。`);
  }

  return (
    // 這一頁的對話框預覽要跟 HRIS 的玻璃樣式一起看；頁面本身不在 HrLayout 底下，所以自己提供範圍。
    <DialogScope className="hr-system">
    <div className="page style-guide">
      <PageHeader
        title="UI 元件樣式指南"
        description="Portal 的 Material 3 tokens、HRIS 共用元件與互動狀態。這一頁直接使用 packages/ui 的 canonical exports。"
        actions={<Button icon="bookmark" variant="secondary" onClick={() => setMessage("這個頁面本身也是 UI layer 的使用範例。")}>使用規則</Button>}
      />

      <Alert tone="info">目前這一頁只需要登入，不會出現在一般 sidebar；可直接開啟 <code>/style-guide</code> 檢查元件。</Alert>

      <Panel title="HRIS 共用元件索引" description="所有共用元件都從 packages/ui 統一 export；route 只負責資料、狀態與 domain rendering。">
        <div className="style-guide-principles">
          <div><strong>版面與資料</strong><span>PageHeader、Panel、DataTable、Pager、SortableHeader、EmptyState。</span></div>
          <div><strong>表單與篩選</strong><span>Field、TextField、SelectField、DropdownSelect、FilterToolbar 與搜尋控制項。</span></div>
          <div><strong>操作與回饋</strong><span>Button、Dialog、ConfirmDialog、Alert、StatusBadge、SegmentedControl、Tooltip、Icon。</span></div>
        </div>
      </Panel>

      <Panel title="設計原則" description="語意化元件 class 集中在 components.css，色彩與圓角 token 集中在 styles.css。">
        <div className="style-guide-principles">
          <div><strong>先定義 Props</strong><span>Page 傳入 variant、tone、label、disabled 等語意參數。</span></div>
          <div><strong>Material 3</strong><span>primary container、state layer、focus ring 與安靜的圓角層級。</span></div>
          <div><strong>預設可存取</strong><span>保留原生 input、button、switch 的鍵盤與螢幕閱讀器語意。</span></div>
        </div>
      </Panel>

      <Panel title="色彩 tokens" description="不要在 page 寫死色碼；新增顏色先加到 styles.css 的 @theme。">
        <div className="style-guide-token-grid">
          {TOKENS.map((token) => (
            <div className="style-guide-token" key={token.variable}>
              <span className="style-guide-swatch" style={{ background: `var(${token.variable})` }} />
              <span><strong>{token.label}</strong><code>{token.variable}</code></span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="HRIS Liquid Glass shell" description="沿用 /hr 的透明表面、模糊、柔和高光與滑動選取膠囊；這是 shell/domain modifier，不會改寫 packages/ui primitive。">
        <LiquidGlassPreview />
      </Panel>

      <Panel title="字體與表面">
        <div className="style-guide-type-grid">
          <div>
            <p className="style-guide-eyebrow">頁面標題 / 24px</p>
            <h1 className="style-guide-display">營運資料，一眼看懂</h1>
            <p className="muted">說明文字使用 on-surface-variant，讓主要資料保有優先層級。</p>
          </div>
          <div className="style-guide-surface-stack">
            <div className="style-guide-surface-sample"><strong>表面 / paper</strong><span>Panel 14px + shadow-panel</span></div>
            <div className="style-guide-surface-sample muted"><strong>畫布</strong><span>頁面背景與次要區塊</span></div>
          </div>
        </div>
      </Panel>

      <Panel title="按鈕與狀態" description="Button 以 variant 控制視覺與語意；StatusBadge 以 tone 控制狀態色。">
        <div className="style-guide-stack">
          <div className="style-guide-row">
            <Button icon="plus" onClick={() => setMessage("已觸發主要按鈕")}>主要動作</Button>
            <Button variant="secondary" icon="edit">次要動作</Button>
            <Button variant="danger" icon="trash">危險動作</Button>
            <Button variant="link">文字操作</Button>
            <Button variant="icon" icon="search" aria-label="搜尋" />
            <Button disabled>停用</Button>
            <Button loading loadingLabel="同步中…">同步資料</Button>
            <LegacyButton variant="chip" selected icon="check">已選取</LegacyButton>
            <LegacyButton variant="chip-action" icon="bookmark">新增視圖</LegacyButton>
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>預覽 Dialog</Button>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>預覽 ConfirmDialog</Button>
          </div>
          <div className="style-guide-row">
            <StatusBadge tone="success">已完成</StatusBadge>
            <StatusBadge tone="info">同步中</StatusBadge>
            <StatusBadge tone="warning">等待處理</StatusBadge>
            <StatusBadge tone="danger">失敗</StatusBadge>
            <StatusBadge>未設定</StatusBadge>
          </div>
          <p className="form-hint">互動回饋：{message}</p>
        </div>
      </Panel>

      <Panel title="對話框與工作狀態" description="Dialog 與 ConfirmDialog 統一遮罩、焦點、ARIA、Escape、關閉退場與 pending 行為；WorkflowRunPanel 是 Portal domain panel。">
        <WorkflowRunPanel
          tracking
          latest={{ status: "in_progress", conclusion: null }}
          steps={[
            { name: "取得報表", status: "completed", conclusion: "success" },
            { name: "整理並上傳", status: "in_progress", conclusion: null },
            { name: "完成", status: "queued", conclusion: null },
          ]}
        />
      </Panel>

      <Panel title="表單與控制項" description="Field、TextField、SelectField、DropdownSelect 與既有 DateRangePicker / Switch 都可用 props 組合。">
        <div className="field-grid">
          <TextField label="名稱" required defaultValue="Ruei Siang" hint="欄位下方的輔助說明。" />
          <SelectField
            label="狀態"
            defaultValue="active"
            options={[{ label: "啟用", value: "active" }, { label: "停用", value: "disabled" }]}
          />
          <Field label="錯誤狀態" error="請輸入有效的資料。">
            <input defaultValue="格式錯誤" aria-invalid="true" />
          </Field>
          <Field label="報表類型">
            <DropdownSelect aria-label="報表類型" defaultValue="sales" options={DROPDOWN_OPTIONS} />
          </Field>
          <Field label="營運據點">
            <DropdownSelect
              aria-label="營運據點"
              multiple
              defaultValue={["north"]}
              options={[{ label: "北區", value: "north" }, { label: "中區", value: "central" }, { label: "南區", value: "south" }]}
            />
          </Field>
        </div>
        <div className="style-guide-control-row">
          <div className="style-guide-switch-copy"><Switch checked={enabled} onChange={setEnabled} label="即時同步" /><span><strong>即時同步</strong><small>{enabled ? "目前開啟" : "目前關閉"}</small></span></div>
          <div className="field"><span>對帳區間</span><DateRangePicker start={range.start} end={range.end} onChange={setRange} /></div>
        </div>
      </Panel>

      <Panel title="搜尋與篩選" description="FilterToolbar 保留 form 語意；FilterInput、FilterSelect 與 SearchFilterInput 統一 label、compact layout 與 debounce 行為。">
        <FilterToolbar aria-label="元件範例篩選" onSubmit={() => setMessage("已套用篩選條件。")}>
          <FilterInput label="搜尋員工" type="search" placeholder="姓名或員工編號" defaultValue="王小明" />
          <FilterSelect
            label="狀態"
            defaultValue="all"
            options={[{ value: "all", label: "全部狀態" }, { value: "active", label: "在職" }, { value: "disabled", label: "停用" }]}
          />
          <Button type="submit" variant="secondary" icon="filter">套用篩選</Button>
        </FilterToolbar>
        <div className="style-guide-control-row">
          <SearchFilterInput label="延遲搜尋" placeholder="輸入關鍵字，400ms 後送出" value={search} onSearch={(value) => { setSearch(value); setMessage(`搜尋條件已更新為「${value || "（空白）"}」。`); }} />
          <p className="form-hint">目前搜尋值：{search || "（空白）"}</p>
        </div>
      </Panel>

      <Panel title="選擇、提示與圖示" description="SegmentedControl、Tooltip 與 Icon 都保留共用的 ARIA、focus ring 與 currentColor 圖示語意。">
        <div className="style-guide-stack">
          <SegmentedControl
            aria-label="資料檢視模式"
            value={segment}
            onChange={(value) => { setSegment(value); setMessage(`檢視模式切換為「${value}」。`); }}
            options={[{ value: "all", label: "全部" }, { value: "pending", label: "待處理" }, { value: "done", label: "已完成" }]}
          />
          <div className="style-guide-row">
            <Tooltip label="這是補充資訊，不是唯一資訊；滑過或用 Tab 聚焦即可查看。">
              <span>滑過或用 Tab 聚焦這段文字</span>
            </Tooltip>
            <span className="form-hint">Tooltip 會 portal 到 body，避免被表格或面板 overflow 裁切。</span>
          </div>
        </div>
      </Panel>

      <Panel title="表格工具列" description="搜尋與篩選緊貼在面板標題下方，用自己的下緣分隔線跟資料分成兩個區塊。">
        <FilterToolbar aria-label="表格範例工具列">
          <FilterInput label="搜尋" type="search" defaultValue="客戶" placeholder="搜尋關鍵字" />
          <FilterSelect label="狀態" defaultValue="all" options={[{ value: "all", label: "全部狀態" }, { value: "active", label: "正常" }]} />
        </FilterToolbar>
      </Panel>

      <Panel title="回饋" description="錯誤留在原地；成功或資訊可以用 Alert 做明確但不打斷的回饋。">
        <div className="style-guide-stack">
          <Alert tone="success">報表已成功整理並上傳。</Alert>
          <Alert tone="warning">目前仍有一個工作在等待執行。</Alert>
          <Alert tone="danger">無法連線到服務，請稍後再試。</Alert>
        </div>
      </Panel>

      <Panel title="分頁標籤" description="同一個功能底下平行子頁面的切換列；這是 Portal shell 的 domain navigation，不是 HRIS primitive。">
        <PageTabs label="範例分頁" tabs={[
          { label: "出金表", to: "/style-guide", icon: "payments" as const },
          { label: "商品銷售", to: "/style-guide/demo-a", icon: "report" as const },
          { label: "官網對帳單", to: "/style-guide/demo-b", icon: "globe" as const },
        ]} />
      </Panel>

      <Panel title="資料表、排序、分頁與空狀態" description="DataTable 只負責表格外框；欄位、SortableHeader、Pager 與 EmptyState 的內容與 state 仍由 route 組合。">
        <DataTable className="style-guide-sort-table">
          <thead>
            <tr>
              <SortableHeader label="項目" field="name" active={sort.field} direction={sort.direction} onSort={handleSort} />
              <SortableHeader label="狀態" field="status" active={sort.field} direction={sort.direction} onSort={handleSort} />
              <SortableHeader label="數量" field="quantity" active={sort.field} direction={sort.direction} onSort={handleSort} className="numeric" />
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr><td className="cell-strong">蝦皮銷售報表</td><td><StatusBadge tone="success">已完成</StatusBadge></td><td className="numeric">1,558</td><td><Button variant="icon" icon="external" aria-label="開啟報表" /></td></tr>
            <tr><td className="cell-strong">出金表</td><td><StatusBadge tone="warning">處理中</StatusBadge></td><td className="numeric">42</td><td><Button variant="icon" icon="eye" aria-label="查看狀態" /></td></tr>
          </tbody>
        </DataTable>
        <Pager
          page={page}
          pageSize={pageSize}
          pageSizes={[10, 20, 50]}
          totalPages={8}
          totalLabel={`共 158 筆，目前每頁 ${pageSize} 筆`}
          onPage={(nextPage) => { setPage(nextPage); setMessage(`目前在第 ${nextPage} 頁。`); }}
          onPageSize={(size) => { setPageSize(size); setPage(1); setMessage(`每頁筆數改為 ${size}。`); }}
        />
        <EmptyState>沒有資料時使用 EmptyState，保留清楚的下一步說明。</EmptyState>
      </Panel>

      <Panel title="圖示系統" description="沿用 packages/ui 的 24px、currentColor、線性 SVG。">
        <div className="style-guide-icon-grid">
          {ICONS.map((name) => <div className="style-guide-icon" key={name}><Icon name={name} /><code>{name}</code></div>)}
        </div>
      </Panel>

      {dialogOpen ? (
        <Dialog
          title="共用 Dialog 預覽"
          onClose={closeDialog}
          actions={<Button type="button" onClick={closeDialog}>完成</Button>}
        >
          <p>頁面只提供內容與 actions，遮罩、標題列、ARIA 與關閉按鈕由 Dialog 統一處理。</p>
        </Dialog>
      ) : null}

      {confirmOpen ? (
        <ConfirmDialog
          title="要執行這個示範動作嗎？"
          pending={confirmPending}
          onConfirm={handleConfirm}
          onCancel={() => { setConfirmPending(false); setConfirmOpen(false); }}
        >
          <p>這個區塊示範危險動作的取消焦點、Escape 與 pending 狀態。</p>
        </ConfirmDialog>
      ) : null}
    </div>
    </DialogScope>
  );
}
