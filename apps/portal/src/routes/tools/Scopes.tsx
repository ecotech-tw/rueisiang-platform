import { useMemo, useState } from "react";
import { REPORT_PLATFORM_OPTIONS, reportPlatformLabel } from "@rueisiang/db/report-platforms";
import { useArchiveScope, useSaveScope, useScopes, useSearchScopePlaces, type GoogleMapPlace, type ManagementScope } from "./api.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { useSession } from "../../auth/session.js";
import { Switch } from "../../shell/Switch.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { useToast } from "../../shell/Toast.js";
import { useMediaImages } from "../media/api.js";
import { Alert, Button, ButtonLink, DataTable, Dialog, FieldGrid, FilterInput, FilterSelect, FilterToolbar, Page, PageHeader, PageStatus, Panel, RowActions, SEARCH_INPUT_WIDTH, SelectField, StatusBadge, TableNote, TextField } from "../../ui/index.js";

/**
 * 通路管理。
 *
 * 取代原本的「店別與報表設定」與「報表管理 → 管理據點」。那兩頁管的是同一張
 * scopes 表、寫同一個 active 欄位，但篩選條件與刪除行為都不一樣——在其中一邊
 * 關掉一家店，另一邊的執行頁也會跟著消失，而沒有人預期那件事。
 *
 * 叫「通路」不叫「店別」：實體櫃點、蝦皮賣場與之後的其他來源都掛在同一張表，
 * 它們都有自己的銷售明細與金額，差別只在顆粒度與資料怎麼進來。
 */

const STORE_CATEGORY_OPTIONS = ["百貨公司", "觀光據點", "國道服務區"] as const;
const TAIWAN_COUNTIES = [
  "臺北市", "新北市", "桃園市", "臺中市", "臺南市", "高雄市", "基隆市", "新竹市", "嘉義市",
  "新竹縣", "苗栗縣", "彰化縣", "南投縣", "雲林縣", "嘉義縣", "屏東縣", "宜蘭縣", "花蓮縣",
  "臺東縣", "澎湖縣", "金門縣", "連江縣",
] as const;

const KIND_OPTIONS = [
  { value: "store", label: "櫃點" },
  { value: "channel", label: "通路" },
  { value: "company", label: "彙總" },
] as const;

const KIND_LABELS: Record<ManagementScope["scopeKind"], string> = {
  store: "櫃點",
  channel: "通路",
  company: "彙總",
};

function platformOf(sourceType: string): string {
  return sourceType === "manual" ? "cyberbiz" : sourceType;
}

function sourceLabel(sourceType: string): string {
  return reportPlatformLabel(platformOf(sourceType));
}

function googleMapsSearchUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address.trim())}`;
}

function storeCategoryValue(value: string): string {
  const aliases: Record<string, string> = { "百貨櫃位": "百貨公司", "觀光景點": "觀光據點" };
  const normalized = aliases[value] ?? value;
  return STORE_CATEGORY_OPTIONS.includes(normalized as typeof STORE_CATEGORY_OPTIONS[number]) ? normalized : "";
}

function storeCountyValue(value: string): string {
  const aliases: Record<string, string> = { "台北市": "臺北市", "台中市": "臺中市", "台南市": "臺南市", "台東縣": "臺東縣" };
  const normalized = aliases[value] ?? value;
  return TAIWAN_COUNTIES.includes(normalized as typeof TAIWAN_COUNTIES[number]) ? normalized : "";
}

function validImageUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const STORE_LOCATOR_GEO_BOUNDS = { lonMin: 120, lonMax: 122.1, latMin: 21.9, latMax: 25.3 };

function calculateStoreLocatorPin(longitude: number, latitude: number) {
  const { lonMin, lonMax, latMin, latMax } = STORE_LOCATOR_GEO_BOUNDS;
  if (longitude < lonMin || longitude > lonMax || latitude < latMin || latitude > latMax) return null;
  return {
    x: 475 + ((longitude - lonMin) / (lonMax - lonMin)) * 365,
    y: 245 + ((latMax - latitude) / (latMax - latMin)) * 715,
  };
}

function ScopeDialog({
  scope,
  canConfigure,
  canReadMedia,
  onClose,
}: {
  scope: ManagementScope | null;
  canConfigure: boolean;
  canReadMedia: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(scope?.name ?? "");
  const [externalName, setExternalName] = useState(scope?.externalName ?? "");
  const initialSourceType = platformOf(scope?.sourceType ?? "cyberbiz");
  const [sourceType, setSourceType] = useState(initialSourceType);
  const [scopeKind, setScopeKind] = useState<ManagementScope["scopeKind"]>(scope?.scopeKind ?? (initialSourceType === "shopee" || initialSourceType === "momo" ? "channel" : "store"));
  const [driveFolderUrl, setDriveFolderUrl] = useState(scope?.driveFolderUrl ?? "");
  const [driveFolderName, setDriveFolderName] = useState(scope?.driveFolderName ?? "");
  const [storeDetails, setStoreDetails] = useState({
    category: storeCategoryValue(scope?.storeLocatorCategory ?? ""),
    county: storeCountyValue(scope?.storeLocatorCounty ?? ""),
    address: scope?.storeLocatorAddress ?? "",
    floorNote: scope?.storeLocatorFloorNote ?? "",
    hours: scope?.storeLocatorHours ?? "",
    phone: scope?.storeLocatorPhone ?? "",
    highlight: scope?.storeLocatorHighlight ?? "",
    imageId: scope?.storeLocatorImageId ?? "",
    imageUrl: scope?.storeLocatorImageUrl ?? "",
    pinX: scope?.storeLocatorPinX == null ? "" : String(scope.storeLocatorPinX),
    pinY: scope?.storeLocatorPinY == null ? "" : String(scope.storeLocatorPinY),
  });
  const [imageSource, setImageSource] = useState<"media" | "url">(scope?.storeLocatorImageUrl ? "url" : scope?.storeLocatorImageId || canReadMedia ? "media" : "url");
  const [placeQuery, setPlaceQuery] = useState(scope?.storeLocatorAddress ?? "");
  const [selectedPlace, setSelectedPlace] = useState<GoogleMapPlace | null>(null);
  const placesSearch = useSearchScopePlaces();
  const [mediaSearch, setMediaSearch] = useState("");
  const [mediaPage, setMediaPage] = useState(1);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const mediaImages = useMediaImages({ search: mediaSearch, type: "", page: mediaPage, deleted: false, sort: "name", direction: "asc" }, canReadMedia);
  const save = useSaveScope();
  const toast = useToast();
  const selectedImage = mediaImages.data?.images.find((image) => image.id === storeDetails.imageId);
  const selectedPin = selectedPlace ? calculateStoreLocatorPin(selectedPlace.longitude, selectedPlace.latitude) : null;
  const imageUrlIsValid = imageSource !== "url" || validImageUrl(storeDetails.imageUrl);
  const valid = name.trim() !== "" && imageUrlIsValid;
  const sourceOptions = REPORT_PLATFORM_OPTIONS.some((option) => option.value === sourceType)
    ? REPORT_PLATFORM_OPTIONS.map((option) => ({ label: option.label, value: option.value }))
    : [{ label: sourceLabel(sourceType), value: sourceType }, ...REPORT_PLATFORM_OPTIONS.map((option) => ({ label: option.label, value: option.value }))];
  const imageSourceOptions = [
    ...(canReadMedia || storeDetails.imageId ? [{ value: "media", label: "CDN 媒體庫" }] : []),
    { value: "url", label: "圖片網址" },
  ];

  function searchPlaces() {
    const query = placeQuery.trim();
    if (!query) return;
    setSelectedPlace(null);
    placesSearch.mutate(query);
  }

  function selectPlace(place: GoogleMapPlace) {
    setSelectedPlace(place);
    setPlaceQuery(place.name);
    setStoreDetails((current) => ({ ...current, address: place.address }));
    placesSearch.reset();
  }

  return (
    <Dialog manageFocus
      title={scope ? "編輯通路" : "新增通路"}
      onClose={onClose}
      closeDisabled={save.isPending}
      formProps={{
        onSubmit: (event) => {
          event.preventDefault();
          if (!valid) return;
          save.reset();
          save.mutate({
            ...(scope ? { id: scope.id } : {}),
            name: name.trim(),
            // 外部店名只有 CYBERBIZ 用得到；換了平台就把它清掉，不要留一個
            // 沒有人會再讀、卻看起來還有效的值。
            // 沒有 config 權限的人送這幾個欄位會被 API 擋成 403，所以乾脆不送。
            ...(canConfigure ? {
              ...(!scope ? { sourceType } : {}),
              scopeKind,
              driveFolderUrl,
              driveFolderName,
              // 外部店名只有 CYBERBIZ 用得到；換了來源就清掉，不要留一個沒有人
              // 會再讀、卻看起來還有效的值。
              externalName: sourceType === "cyberbiz" ? externalName.trim() : "",
            } : {}),
            ...(scopeKind === "store" ? {
              storeLocatorCategory: storeDetails.category.trim(),
              storeLocatorCounty: storeDetails.county.trim(),
              storeLocatorAddress: storeDetails.address.trim(),
              storeLocatorFloorNote: storeDetails.floorNote.trim(),
              storeLocatorHours: storeDetails.hours.trim(),
              storeLocatorPhone: storeDetails.phone.trim(),
              storeLocatorHighlight: storeDetails.highlight.trim(),
              storeLocatorImageId: imageSource === "media" ? storeDetails.imageId || null : null,
              storeLocatorImageUrl: imageSource === "url" ? storeDetails.imageUrl.trim() : "",
              storeLocatorMapUrl: storeDetails.address.trim() ? googleMapsSearchUrl(storeDetails.address) : "",
              storeLocatorPinX: storeDetails.pinX === "" ? null : Number(storeDetails.pinX),
              storeLocatorPinY: storeDetails.pinY === "" ? null : Number(storeDetails.pinY),
            } : {}),
          }, {
            onSuccess: () => {
              toast.show(scope ? `已更新「${name.trim()}」` : `已新增通路「${name.trim()}」`);
              onClose();
            },
          });
        },
      }}
      actions={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={save.isPending}>取消</Button>
          <Button type="submit" loading={save.isPending} disabled={!valid}>儲存</Button>
        </>
      }
    >
      {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
      <TextField
        label="通路名稱"
        required
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint="平台上顯示的名字，隨時可以改。報表資料綁的是 ID，改名不會拆散歷史。"
      />
      {canConfigure ? (
        <SelectField
          label="種類"
          value={scopeKind}
          onChange={(event) => setScopeKind(event.target.value as ManagementScope["scopeKind"])}
          options={KIND_OPTIONS.map((kind) => ({ label: kind.label, value: kind.value }))}
        />
      ) : null}
      {canConfigure ? (
        <SelectField
          label="平台"
          value={sourceType}
          onChange={(event) => {
            const nextSourceType = event.target.value;
            setSourceType(nextSourceType);
            if (!scope) setScopeKind(nextSourceType === "shopee" || nextSourceType === "momo" ? "channel" : "store");
          }}
          options={sourceOptions}
          disabled={Boolean(scope)}
          hint={scope ? "平台建立後不可變更，避免歷史報表與 SKU 對應改掛到其他平台。" : "SKU 對應會依此平台共用；人工補登也請選商品實際所屬的平台。"}
        />
      ) : null}
      {canConfigure && sourceType === "cyberbiz" ? (
        <TextField
          label="外部店名"
          value={externalName}
          onChange={(event) => setExternalName(event.target.value)}
          hint="CYBERBIZ 後台的店名，runner 拿它找店。跟平台名稱不一樣時才要填。"
        />
      ) : null}
      {canConfigure && sourceType !== "momo" ? (
        <TextField
          label="Google Drive 資料夾連結"
          value={driveFolderUrl}
          onChange={(event) => setDriveFolderUrl(event.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          hint="報表整理完會放到這個資料夾。"
        />
      ) : null}
      {canConfigure && sourceType !== "momo" ? (
        <TextField
          label="資料夾顯示名稱"
          value={driveFolderName}
          onChange={(event) => setDriveFolderName(event.target.value)}
        />
      ) : null}
      {scopeKind === "store" ? (
        <section className="mt-5 grid gap-4 border-t border-subtle pt-4" aria-label="官網據點資料">
          <div>
            <h3 className="m-0 text-sm font-semibold text-ink">官網據點資料</h3>
            <p className="mt-1 text-xs text-muted">櫃點且營業中、地址與地圖位置完整時才會公開。圖釘位置是台灣 SVG 的 X/Y，非經緯度。</p>
          </div>
          <div className="grid gap-3">
            <div>
              <p className="m-0 text-sm font-medium text-ink">Google Maps 地點搜尋</p>
              <p className="m-0 mt-1 text-xs text-muted">選取搜尋結果後可預覽經緯度與 X/Y 試算值；確認後再帶入欄位，儲存前仍可手動調整。</p>
            </div>
            <div className="flex min-w-0 items-end gap-2.5 max-[760px]:flex-col max-[760px]:items-stretch">
              <TextField
                className="min-w-0 flex-auto"
                label="Google Maps 搜尋地點"
                value={placeQuery}
                onChange={(event) => { setPlaceQuery(event.target.value); placesSearch.reset(); setSelectedPlace(null); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    searchPlaces();
                  }
                }}
                hint="輸入櫃點名稱或地址，選擇符合的搜尋結果以查看座標。"
              />
              <Button size="lg" className="min-w-[86px] flex-none max-[760px]:w-full" type="button" variant="primary" icon="search" disabled={!placeQuery.trim() || placesSearch.isPending} onClick={searchPlaces}>搜尋</Button>
            </div>
            {placesSearch.isPending ? <p role="status" className="m-0 text-sm text-muted">搜尋 Google Maps 地點…</p> : null}
            {placesSearch.error ? <Alert tone="danger">{placesSearch.error.message}</Alert> : null}
            {placesSearch.data && !placesSearch.data.places.length ? <p className="m-0 text-sm text-muted">找不到地點，請換個關鍵字。</p> : null}
            {placesSearch.data && placesSearch.data.places.length > 0 ? (
              <div className="grid max-h-60 flex-none gap-1.5 overflow-y-auto" role="listbox" aria-label="Google Maps 搜尋結果">
                <p className="m-0 text-xs text-muted">搜尋結果（{placesSearch.data.places.length} 筆），選取正確地點以查看座標：</p>
                {placesSearch.data.places.map((place) => (
                  <button type="button" role="option" aria-selected={selectedPlace?.id === place.id} className="grid min-h-14 w-full cursor-pointer gap-[3px] rounded-field border border-line bg-paper px-3 py-2.5 text-left text-ink transition-[background-color,border-color,scale] duration-120 ease-out hover:border-secondary hover:bg-brand/7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary active:scale-[.99] motion-reduce:transition-none [&_small]:text-muted" key={place.id} onClick={() => selectPlace(place)}>
                    <strong>{place.name}</strong>
                    <small>{place.address}</small>
                  </button>
                ))}
              </div>
            ) : null}
            {selectedPlace ? (
              <div className="grid gap-2 rounded-card border border-line bg-canvas p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="m-0 text-xs font-medium text-muted">Google Maps</p><Button type="button" variant="secondary" icon="close" onClick={() => setSelectedPlace(null)}>清除座標顯示</Button></div>
                <div><p className="m-0 text-sm font-semibold text-ink">{selectedPlace.name}</p><p className="m-0 mt-1 text-xs text-muted">{selectedPlace.address}</p></div>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums"><dt className="text-muted">緯度（lat）</dt><dd className="m-0">{selectedPlace.latitude.toFixed(6)}</dd><dt className="text-muted">經度（lon）</dt><dd className="m-0">{selectedPlace.longitude.toFixed(6)}</dd></dl>
                {selectedPin ? (
                  <div className="flex flex-wrap items-center gap-3 border-t border-soft-line pt-2">
                    <output role="status" className="text-xs tabular-nums text-muted">X/Y 試算：X {selectedPin.x.toFixed(1)} · Y {selectedPin.y.toFixed(1)}</output>
                    <Button type="button" variant="secondary" onClick={() => setStoreDetails((current) => ({ ...current, pinX: selectedPin.x.toFixed(1), pinY: selectedPin.y.toFixed(1) }))}>帶入 X/Y 欄位</Button>
                  </div>
                ) : <p className="m-0 text-xs text-muted">此座標超出台灣圖示的試算範圍，請手動設定 X/Y。</p>}
                <p className="m-0 text-[11px] text-muted">試算範圍：經度 120–122.1、緯度 21.9–25.3；帶入後仍可編輯，按儲存才會保存。</p>
              </div>
            ) : null}
            {storeDetails.address.trim() ? <ButtonLink variant="secondary" icon="external" href={googleMapsSearchUrl(storeDetails.address)} target="_blank" rel="noopener noreferrer">在 Google Maps 搜尋已填地址</ButtonLink> : null}
            <p className="m-0 text-xs text-muted">前台導航連結會以已填地址建立 Google Maps 搜尋連結。</p>
          </div>
          <FieldGrid columns={2}>
            <SelectField
              label="類型"
              value={storeDetails.category}
              onChange={(event) => setStoreDetails((current) => ({ ...current, category: event.target.value }))}
              options={[{ value: "", label: "請選擇類型" }, ...STORE_CATEGORY_OPTIONS.map((value) => ({ value, label: value }))]}
            />
            <SelectField
              label="縣市"
              value={storeDetails.county}
              onChange={(event) => setStoreDetails((current) => ({ ...current, county: event.target.value }))}
              options={[{ value: "", label: "請選擇縣市" }, ...TAIWAN_COUNTIES.map((value) => ({ value, label: value }))]}
            />
          </FieldGrid>
          <TextField label="地址" required value={storeDetails.address} onChange={(event) => { const address = event.target.value; setStoreDetails((current) => ({ ...current, address })); if (selectedPlace && address !== selectedPlace.address) setSelectedPlace(null); }} />
          <TextField label="樓層／位置補充" value={storeDetails.floorNote} onChange={(event) => setStoreDetails((current) => ({ ...current, floorNote: event.target.value }))} placeholder="例如：B1 美食街" />
          <FieldGrid columns={2}>
            <TextField label="營業時間" value={storeDetails.hours} onChange={(event) => setStoreDetails((current) => ({ ...current, hours: event.target.value }))} placeholder="週一至週日 11:00–22:00" />
            <TextField label="電話" value={storeDetails.phone} onChange={(event) => setStoreDetails((current) => ({ ...current, phone: event.target.value }))} />
          </FieldGrid>
          <TextField label="文案" value={storeDetails.highlight} onChange={(event) => setStoreDetails((current) => ({ ...current, highlight: event.target.value }))} />
          <SelectField
            label="圖片來源"
            value={imageSource}
            onChange={(event) => {
              const next = event.target.value === "url" ? "url" : "media";
              setImageSource(next);
              setStoreDetails((current) => next === "url" ? { ...current, imageId: "" } : { ...current, imageUrl: "" });
            }}
            options={imageSourceOptions}
          />
          {imageSource === "media" ? (canReadMedia ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" icon="grid" aria-expanded={mediaPickerOpen} onClick={() => setMediaPickerOpen((open) => !open)}>
                  {mediaPickerOpen ? "收起圖片庫" : "瀏覽多媒體圖片"}
                </Button>
                {storeDetails.imageId ? <Button variant="secondary" icon="close" onClick={() => setStoreDetails((current) => ({ ...current, imageId: "" }))}>清除圖片</Button> : null}
              </div>
              {selectedImage ? (
                <div className="flex items-center gap-3 rounded-card bg-canvas p-2">
                  <img src={selectedImage.previewUrl} alt="" className="size-16 shrink-0 rounded-field object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />
                  <div className="min-w-0"><p className="m-0 truncate text-sm font-medium">{selectedImage.name}</p><p className="m-0 mt-1 text-xs text-muted">目前選取的官網據點圖片</p></div>
                </div>
              ) : storeDetails.imageId ? <p className="m-0 text-xs text-muted">已保留目前圖片；可瀏覽圖片庫更換，或清除圖片設定。</p> : <p className="m-0 text-xs text-muted">尚未選取圖片。圖片由多媒體管理維護，公開頁面使用 CDN 圖片網址。</p>}
              {mediaPickerOpen ? (
                <div className="grid gap-3 rounded-card border border-line bg-canvas p-3">
                  <TextField label="搜尋圖片" value={mediaSearch} onChange={(event) => { setMediaSearch(event.target.value); setMediaPage(1); }} placeholder="輸入圖片名稱或檔名" />
                  {mediaImages.error ? <Alert tone="danger">媒體庫載入失敗：{mediaImages.error.message}</Alert> : null}
                  {mediaImages.isFetching ? <p role="status" className="m-0 text-sm text-muted">載入圖片中…</p> : null}
                  {mediaImages.data && mediaImages.data.images.length === 0 && !mediaImages.isFetching ? <p className="m-0 py-4 text-center text-sm text-muted">找不到圖片，請調整搜尋條件。</p> : null}
                  {mediaImages.data && mediaImages.data.images.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-3">
                      {mediaImages.data.images.map((image) => {
                        const selected = storeDetails.imageId === image.id;
                        return (
                          <button
                            key={image.id}
                            type="button"
                            aria-pressed={selected}
                            aria-label={`${selected ? "已選取" : "選取"}圖片：${image.name}`}
                            onClick={() => setStoreDetails((current) => ({ ...current, imageId: image.id }))}
                            className={`grid min-w-0 gap-2 rounded-card border p-2 text-left transition-colors duration-150 active:scale-[0.96] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary ${selected ? "border-brand bg-brand-soft text-brand-dark" : "border-line bg-paper text-ink hover:bg-brand/4"}`}
                          >
                            <img src={image.previewUrl} alt="" loading="lazy" className="h-20 w-full rounded-field object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" />
                            <span className="truncate text-xs font-medium">{image.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {mediaImages.data && mediaImages.data.total > mediaImages.data.pageSize ? (
                    <div className="flex items-center justify-between gap-2 border-t border-soft-line pt-2">
                      <span className="text-xs tabular-nums text-muted">第 {mediaImages.data.page} 頁，共 {Math.ceil(mediaImages.data.total / mediaImages.data.pageSize)} 頁</span>
                      <div className="flex gap-2">
                        <Button variant="secondary" icon="chevronLeft" disabled={mediaPage <= 1 || mediaImages.isFetching} onClick={() => setMediaPage((current) => current - 1)}>上一頁</Button>
                        <Button variant="secondary" icon="chevronRight" disabled={mediaPage * mediaImages.data.pageSize >= mediaImages.data.total || mediaImages.isFetching} onClick={() => setMediaPage((current) => current + 1)}>下一頁</Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : <p className="m-0 text-xs text-muted">選取 CDN 媒體庫圖片需要「媒體圖片檢視」權限；目前已選圖片會保留。</p>) : (
            <div className="grid gap-3">
              <TextField label="圖片網址" type="url" value={storeDetails.imageUrl} onChange={(event) => setStoreDetails((current) => ({ ...current, imageUrl: event.target.value }))} placeholder="https://example.com/store.jpg" hint="選填，請使用公開可讀取的 HTTPS 圖片網址。" />
              {!imageUrlIsValid ? <Alert tone="danger">圖片網址需為有效的 HTTPS 網址，且不能包含帳號密碼。</Alert> : null}
              {storeDetails.imageUrl.trim() && imageUrlIsValid ? <img src={storeDetails.imageUrl.trim()} alt="官網據點圖片預覽" className="h-36 w-full rounded-card object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10" /> : null}
            </div>
          )}
          <FieldGrid columns={2}>
            <TextField label="台灣地圖 X" type="number" min="475" max="840" step="0.1" value={storeDetails.pinX} onChange={(event) => setStoreDetails((current) => ({ ...current, pinX: event.target.value }))} hint="SVG viewBox X：475–840" />
            <TextField label="台灣地圖 Y" type="number" min="245" max="960" step="0.1" value={storeDetails.pinY} onChange={(event) => setStoreDetails((current) => ({ ...current, pinY: event.target.value }))} hint="SVG viewBox Y：245–960" />
          </FieldGrid>

        </section>
      ) : null}
    </Dialog>
  );
}

export function Scopes() {
  usePageTitle("通路管理");
  // 來源、種類與 Drive 設定只有管理者能改，API 也擋著；這裡只是不要畫出改不動的欄位。
  const permissions = useSession().permissions;
  const canConfigure = permissions.has("tools:payout:config");
  const canReadMedia = permissions.has("media:image:read");
  const query = useScopes();
  const archiveScope = useArchiveScope();
  const saveScope = useSaveScope();
  const toast = useToast();

  const [editing, setEditing] = useState<{ scope: ManagementScope | null } | null>(null);
  const [archiving, setArchiving] = useState<ManagementScope | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [kindFilter, setKindFilter] = useState("all");
  const [sortField, setSortField] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const scopes = useMemo(() => query.data?.scopes ?? [], [query.data]);

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const filtered = scopes.filter((scope) => {
      if (statusFilter === "open" && (scope.archivedAt || !scope.active)) return false;
      if (statusFilter === "closed" && (scope.archivedAt || scope.active)) return false;
      if (statusFilter === "archived" && !scope.archivedAt) return false;
      if (kindFilter !== "all" && scope.scopeKind !== kindFilter) return false;
      if (!keyword) return true;
      return [scope.name, scope.externalName, sourceLabel(scope.sourceType), scope.sourceType]
        .some((value) => value.toLowerCase().includes(keyword));
    });
    const direction = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((left, right) => {
      if (sortField === "kind") return direction * KIND_LABELS[left.scopeKind].localeCompare(KIND_LABELS[right.scopeKind], "zh-Hant");
      if (sortField === "source") return direction * sourceLabel(left.sourceType).localeCompare(sourceLabel(right.sourceType), "zh-Hant");
      return direction * left.name.localeCompare(right.name, "zh-Hant");
    });
  }, [scopes, search, statusFilter, kindFilter, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rows = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function sort(field: string, direction: "asc" | "desc") {
    setSortField(field);
    setSortDirection(direction);
    setPage(1);
  }

  /**
   * 這個開關寫的是「這個通路還在營業」。
   *
   * 成功才跳 toast；失敗留在面板上緣的 Alert，那是 Toast.tsx 檔頭的決定——失敗
   * 是要人讀完處理的東西，不能做成會自己消失的浮動提示。
   *
   * 關掉之後它不再出現在出金表／商品銷售報表的執行頁，也不能再補登資料；已經
   * 匯入的數字照樣算進營運統計——報表是歷史，不會因為關掉開關就變少。
   */
  function toggleActive(scope: ManagementScope, active: boolean) {
    saveScope.mutate({ id: scope.id, name: scope.name, active }, {
      onSuccess: () => toast.show(active
        ? `「${scope.name}」恢復營業，會重新出現在報表執行頁`
        : `「${scope.name}」已停業，歷史數字仍算進營運統計`),
    });
  }

  /** 還原＝解除封存並恢復營業；API 的 active: true 會一併把 archived_at 清掉。 */
  function restore(scope: ManagementScope) {
    saveScope.mutate({ id: scope.id, name: scope.name, active: true }, {
      onSuccess: () => toast.show(`已還原「${scope.name}」`),
    });
  }

  if (query.isPending) return <PageStatus>載入中…</PageStatus>;
  if (query.error) return <Page><Alert tone="danger">{query.error.message}</Alert></Page>;

  return (
    <Page layout="fills">
      <PageHeader
        title="通路管理"
        description="出金表、商品銷售報表與營運統計都掛在通路底下。停業與封存都不會刪掉已經匯入的歷史資料。"
        actions={<Button icon="plus" onClick={() => setEditing({ scope: null })}>新增通路</Button>}
      />

      <Panel grows>
        <FilterToolbar>
          <FilterInput
            label="搜尋"
            className={SEARCH_INPUT_WIDTH}
            type="search"
            placeholder="搜尋通路名稱、外部店名或平台"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          />
          <FilterSelect
            label="狀態"
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}
            options={[
              { value: "open", label: "營業中" },
              { value: "closed", label: "已停業" },
              { value: "archived", label: "已封存" },
              { value: "all", label: "全部" },
            ]}
          />
          <FilterSelect
            label="種類"
            value={kindFilter}
            onChange={(event) => { setKindFilter(event.target.value); setPage(1); }}
            options={[{ value: "all", label: "全部種類" }, ...KIND_OPTIONS.map((kind) => ({ value: kind.value, label: kind.label }))]}
          />
        </FilterToolbar>

        {saveScope.error ? <Alert tone="danger">{saveScope.error.message}</Alert> : null}
        {archiveScope.error ? <Alert tone="danger">{archiveScope.error.message}</Alert> : null}

        <DataTable>
            <thead>
              <tr>
                <SortableHeader label="通路" field="name" active={sortField} direction={sortDirection} onSort={sort} />
                <SortableHeader label="種類" field="kind" active={sortField} direction={sortDirection} onSort={sort} />
                <SortableHeader label="平台" field="source" active={sortField} direction={sortDirection} onSort={sort} />
                {canConfigure ? <th>Drive 資料夾</th> : null}
                <th>還在營業</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((scope) => (
                  <tr key={scope.id}>
                    <td data-label="通路">
                      {/*
                        * 開關本身就說得出營業中與已停業，所以那兩個狀態不另開一欄重複。
                        * 只有「已封存」是開關表達不出來的——它會被 disable，但畫面上看
                        * 不出為什麼，所以標在名稱旁邊。
                        */}
                      <div className="font-bold flex items-center gap-2">
                        {scope.name}
                        {scope.archivedAt ? <StatusBadge>已封存</StatusBadge> : null}
                      </div>
                      <div className="text-[12px] text-muted">
                        {scope.externalName && scope.externalName !== scope.name ? `後台店名：${scope.externalName}` : scope.id}
                      </div>
                    </td>
                    <td data-label="種類"><StatusBadge>{KIND_LABELS[scope.scopeKind]}</StatusBadge></td>
                    <td data-label="平台"><StatusBadge>{sourceLabel(scope.sourceType)}</StatusBadge></td>
                    {canConfigure ? (
                      <td data-label="Drive 資料夾">
                        {scope.driveFolderUrl
                          ? <a href={scope.driveFolderUrl} target="_blank" rel="noreferrer">{scope.driveFolderName || "開啟資料夾"}</a>
                          : <span className="text-[12px] text-muted">—</span>}
                      </td>
                    ) : null}
                    <td data-label="還在營業">
                      <Switch
                        checked={scope.active}
                        busy={saveScope.isPending}
                        disabled={Boolean(scope.archivedAt)}
                        onChange={(active) => toggleActive(scope, active)}
                        label={`${scope.name}還在營業——關掉就不再出現在報表執行頁與補登選單，歷史數字不受影響`}
                      />
                    </td>
                    <td data-label="操作">
                      <RowActions>
                        <Button
                          variant="icon"
                          icon="edit"
                          title="編輯通路"
                          aria-label={`編輯 ${scope.name}`}
                          onClick={() => setEditing({ scope })}
                        />
                        {scope.archivedAt ? (
                          <Button
                            variant="icon"
                            icon="history"
                            title="還原通路"
                            aria-label={`還原 ${scope.name}`}
                            disabled={saveScope.isPending}
                            onClick={() => restore(scope)}
                          />
                        ) : (
                          <Button
                            variant="icon"
                            icon="archive"
                            title="封存通路"
                            aria-label={`封存 ${scope.name}`}
                            disabled={archiveScope.isPending}
                            onClick={() => setArchiving(scope)}
                          />
                        )}
                      </RowActions>
                    </td>
                  </tr>
              ))}
            </tbody>
          </DataTable>

        {visible.length === 0 ? <TableNote>沒有符合條件的通路。</TableNote> : null}
        {visible.length > 0 ? (
          <Pager
            className="mt-4 shrink-0"
            page={currentPage}
            pageSize={pageSize}
            pageSizes={[10, 25, 50, 100]}
            totalPages={totalPages}
            totalLabel={`共 ${visible.length.toLocaleString("zh-TW")} 個通路`}
            onPage={setPage}
            onPageSize={(next) => { setPageSize(next); setPage(1); }}
          />
        ) : null}
      </Panel>

      {editing ? (
        <ScopeDialog scope={editing.scope} canConfigure={canConfigure} canReadMedia={canReadMedia} onClose={() => setEditing(null)} />
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title={`封存「${archiving.name}」？`}
          confirmLabel="封存"
          pending={archiveScope.isPending}
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            const target = archiving;
            setArchiving(null);
            archiveScope.mutate(target.id, {
              onSuccess: () => toast.show(`已封存「${target.name}」`),
            });
          }}
        >
          <p><strong>{archiving.name}</strong> 會從報表執行頁、補登選單與這張清單的預設檢視收起來。</p>
          <p className="text-muted">已匯入的出金與商品銷售不會被刪除，營運統計仍然算得到它；狀態篩選選「已封存」就找得回來。</p>
        </ConfirmDialog>
      ) : null}
    </Page>
  );
}
