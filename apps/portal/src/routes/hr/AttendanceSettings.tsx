import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, DataTable, Dialog, Field, FilterInput, FilterSelect, FilterToolbar, FormHint, Page, PageHeader, Panel, SEARCH_INPUT_WIDTH, SelectField, StaticValue, TableNote, TextField } from "../../ui/index.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { useHrQuery, useHrWrite, type AttendanceLocation, type AttendanceLocationDetail, type GoogleMapPlace, type NamedOption } from "./api.js";
import { HrPageSkeleton } from "./HrSkeleton.js";

interface LocationDraft {
  name: string;
  scopeId: string | null;
  geolocationRequired: boolean;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: string;
  revision?: number;
}

/**
 * 送出時的半徑。關閉定位判斷時半徑欄位會被藏起來，但 API 永遠要求 1–10000 的半徑；
 * 使用者若先清空半徑再關閉定位，送出的無效值會讓儲存失敗，而錯的欄位已經看不到、改不了。
 * 所以關閉定位時半徑無效就改用原本存著的值（新增時是預設 50），開著定位時照填的送，讓 API 擋。
 */
export function radiusForSave(draft: Pick<LocationDraft, "geolocationRequired" | "radiusMeters">, savedRadius = 50) {
  const radius = Number(draft.radiusMeters);
  if (draft.geolocationRequired) return radius;
  return draft.radiusMeters.trim() && Number.isInteger(radius) && radius >= 1 && radius <= 10_000 ? radius : savedRadius;
}

function draftOf(location?: AttendanceLocationDetail): LocationDraft {
  return {
    name: location?.name ?? "",
    scopeId: location?.scopeId ?? null,
    geolocationRequired: location?.geolocationRequired ?? true,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    radiusMeters: String(location?.radiusMeters ?? 50),
    ...(location ? { revision: location.revision } : {}),
  };
}

function mapsSearch(query: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function savedPlace(location?: AttendanceLocationDetail): GoogleMapPlace | null {
  if (!location || location.latitude === null || location.longitude === null) return null;
  return {
    id: "saved-coordinate",
    name: location.name,
    address: "目前已儲存的辦公位置",
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

/*
 * 開關狀態直接看 draft，不用 peer-checked：滑塊在軌道裡面，要從 input 的兄弟再往下找。
 * input 疊在軌道上但沒有定位座標，點到軌道時靠外層的 <label>（Field）切換。
 */
const TOGGLE_MOTION = "duration-120 ease-out motion-reduce:transition-none";
const SECTION = "grid gap-3";
const SECTION_DIVIDED = "border-t border-t-soft-line pt-5";
const SECTION_HEADING = "flex min-h-[22px] items-center";
const SECTION_TITLE = "m-0 text-[15px] leading-[1.35] text-ink";

function LocationDialog({ location, onClose }: { location?: AttendanceLocation; onClose: () => void }) {
  const detail = useHrQuery<{ location: AttendanceLocationDetail }>(location ? `/attendance-settings/locations/${location.id}` : "/attendance-settings/locations/new", Boolean(location), { keepPreviousData: false });
  const source = detail.data?.location;
  const [draft, setDraft] = useState(() => draftOf(source));
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes");
  const [mapQuery, setMapQuery] = useState(location?.name ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<GoogleMapPlace | null>(() => savedPlace(source));
  const places = useHrQuery<{ places: GoogleMapPlace[] }>(`/attendance-settings/places?query=${encodeURIComponent(searchQuery)}`, Boolean(searchQuery));
  const placeResults = places.data?.places ?? [];
  const save = useHrWrite<{ id?: string }>();
  const toast = useToast();
  const closeRequestRef = useRef<(() => void) | null>(null);
  const editing = Boolean(location);
  const path = editing ? `/attendance-settings/locations/${location?.id}` : "/attendance-settings/locations";

  useEffect(() => {
    if (source) {
      setDraft(draftOf(source));
      setMapQuery(source.name);
      setSelectedPlace(savedPlace(source));
    }
  }, [source]);

  if (editing && detail.isPending) {
    return <Dialog title="編輯辦公位置" onClose={onClose}><p className="text-muted">載入位置設定…</p></Dialog>;
  }
  if (editing && detail.error) {
    return <Dialog title="編輯辦公位置" onClose={onClose}><Alert tone="danger">{detail.error.message}</Alert></Dialog>;
  }

  function searchPlaces() {
    const query = mapQuery.trim();
    if (query) setSearchQuery(query);
  }

  function selectPlace(place: GoogleMapPlace) {
    setSelectedPlace(place);
    setMapQuery(place.name);
    setDraft({ ...draft, name: place.name, latitude: place.latitude, longitude: place.longitude });
    setSearchQuery("");
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values: Record<string, unknown> = {
      name: draft.name.trim(),
      scopeId: draft.scopeId,
      geolocationRequired: draft.geolocationRequired,
      latitude: draft.latitude,
      longitude: draft.longitude,
      radiusMeters: radiusForSave(draft, source?.radiusMeters),
    };
    if (draft.revision !== undefined) values.revision = draft.revision;
    save.mutate({ path, method: editing ? "PATCH" : "POST", values }, { onSuccess: () => { toast.show(editing ? `辦公位置「${draft.name.trim()}」已更新。` : `辦公位置「${draft.name.trim()}」已新增。`); (closeRequestRef.current ?? onClose)(); } });
  }
  const coordinateQuery = draft.latitude !== null && draft.longitude !== null ? `${draft.latitude}, ${draft.longitude}` : "";
  return (
    <Dialog
      title={editing ? "編輯辦公位置" : "新增辦公位置"}
      onClose={onClose}
      closeRequestRef={closeRequestRef}
      closeDisabled={save.isPending}
      bodyLayout="flex flex-col gap-5 px-6 pb-2"
      formProps={{ onSubmit: submit }}
      actions={<Button type="submit" tone={editing ? "info" : "success"} loading={save.isPending}>儲存</Button>}
    >
      <section className={SECTION}>
        <div className={SECTION_HEADING}><h3 className={SECTION_TITLE}>基本資料</h3></div>
        <div className="grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] items-start gap-3.5 max-[760px]:grid-cols-[minmax(0,1fr)]">
          <SelectField className="min-w-0" label="營運據點" value={draft.scopeId ?? ""} options={[{ value: "", label: "請選擇營運據點" }, ...(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => setDraft({ ...draft, scopeId: event.target.value || null })} />
          <TextField
            className="min-w-0"
            label="辦公位置名稱"
            required
            maxLength={100}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </div>
      </section>
      <section className={`${SECTION} ${SECTION_DIVIDED}`}>
        <div className={SECTION_HEADING}><h3 className={SECTION_TITLE}>位置座標</h3></div>
        <div className="flex min-w-0 items-end gap-2.5 max-[760px]:flex-col max-[760px]:items-stretch">
          <TextField
            className="min-w-0 flex-auto"
            label="Google Maps 搜尋地點"
            value={mapQuery}
            onChange={(event) => setMapQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                searchPlaces();
              }
            }}
          />
          <Button size="lg" className="min-w-[86px] flex-none max-[760px]:w-full" type="button" variant="primary" icon="search" disabled={!mapQuery.trim() || places.isFetching} onClick={searchPlaces}>搜尋</Button>
        </div>
        {places.isFetching ? <FormHint>搜尋 Google Maps 地點…</FormHint> : null}
        {places.error ? <Alert tone="danger">{places.error.message}</Alert> : null}
        {searchQuery && places.data && !placeResults.length ? <p className="text-muted">找不到地點，請換個關鍵字。</p> : null}
        {placeResults.length ? (
          <div className="grid max-h-60 flex-none gap-1.5 overflow-y-auto" role="listbox" aria-label="Google Maps 搜尋結果">
            <FormHint>搜尋結果（{placeResults.length} 筆），請選取正確的辦公位置：</FormHint>
            {placeResults.map((place) => (
              <button type="button" role="option" className="grid min-h-14 w-full cursor-pointer gap-[3px] rounded-field border border-line bg-paper px-3 py-2.5 text-left text-ink transition-[background-color,border-color,scale] duration-120 ease-out hover:border-secondary hover:bg-brand/7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary active:scale-[.99] motion-reduce:transition-none [&_small]:text-muted" key={place.id} onClick={() => selectPlace(place)}>
                <strong>{place.name}</strong>
                <small>{place.address}</small>
              </button>
            ))}
          </div>
        ) : null}
        <Field label="已選辦公位置" required={draft.geolocationRequired}>
          {selectedPlace ? (
            <div className="grid gap-1 rounded-field border border-line bg-canvas px-3.5 py-3 text-ink [&_small]:text-muted">
              <strong>{selectedPlace.name}</strong>
              <small>{selectedPlace.address}</small>
            </div>
          ) : <StaticValue>尚未選取辦公位置</StaticValue>}
        </Field>
        {coordinateQuery ? <a className="inline-flex min-h-10 items-center self-start rounded-full px-2.5 text-[13px] font-bold text-brand-dark hover:bg-brand/7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary" href={mapsSearch(coordinateQuery)} target="_blank" rel="noreferrer">在 Google Maps 檢視已選辦公位置</a> : null}
      </section>
      <section className={`${SECTION} ${SECTION_DIVIDED}`}>
        <div className={SECTION_HEADING}><h3 className={SECTION_TITLE}>打卡規則</h3></div>
        <div className="grid gap-3.5 rounded-card border border-line bg-canvas p-3.5">
          <Field label="定位判斷" gap={8}>
            <div className="inline-flex min-h-8 items-center gap-2.5">
              <input
                type="checkbox"
                role="switch"
                className="peer absolute m-0 h-7 w-[42px] cursor-pointer opacity-0"
                checked={draft.geolocationRequired}
                aria-label="定位判斷"
                onChange={(event) => setDraft({ ...draft, geolocationRequired: event.target.checked })}
              />
              <span className={`inline-flex h-[26px] w-[42px] items-center rounded-full p-[3px] transition-[background-color] ${TOGGLE_MOTION} peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-secondary ${draft.geolocationRequired ? "bg-brand" : "bg-line"}`} aria-hidden="true"><span className={`size-5 rounded-[50%] bg-paper [box-shadow:0_1px_3px_rgba(64,30,30,.25)] transition-[transform] ${TOGGLE_MOTION} ${draft.geolocationRequired ? "[transform:translateX(16px)]" : ""}`} /></span>
              <strong className={`text-[13px] ${draft.geolocationRequired ? "text-brand-dark" : "text-muted"}`}>{draft.geolocationRequired ? "啟用" : "關閉"}</strong>
            </div>
          </Field>
          {draft.geolocationRequired ? (
            <div className="w-[min(100%,280px)] max-[760px]:w-full">
              <TextField
                label="出勤判斷半徑（公尺）"
                required
                type="number"
                min="1"
                max="10000"
                step="1"
                value={draft.radiusMeters}
                onChange={(event) => setDraft({ ...draft, radiusMeters: event.target.value })}
                hint="例如 50 代表距離辦公位置中心 50 公尺內。"
              />
            </div>
          ) : null}
        </div>
      </section>
      {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
    </Dialog>
  );
}

export function HrAttendanceSettings() {
  const pageTitle = "據點管理";
  usePageTitle(pageTitle);
  const navigate = useNavigate();
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read");
  const canReviewOvertime = permissions.has("hr:request:review");
  const canWrite = permissions.has("hr:office:write");
  const [editor, setEditor] = useState<AttendanceLocation | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [scopeId, setScopeId] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortField, setSortField] = useState("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const locations = useHrQuery<{ locations: AttendanceLocation[]; total?: number; page?: number; pageSize?: number; hasMore?: boolean }>(`/attendance-settings/locations?page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(search)}&scopeId=${encodeURIComponent(scopeId)}&sortField=${sortField}&sortDirection=${sortDirection}`, canRead);
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes", canRead);
  const rows = locations.data?.locations ?? [];
  const total = locations.data?.total ?? rows.length;
  const updateSort = (field: string, direction: "asc" | "desc") => { setSortField(field); setSortDirection(direction); setPage(1); };

  if (!canRead) return <Alert tone="danger">你沒有檢視據點管理的權限。</Alert>;
  if (locations.isPending) return <HrPageSkeleton variant="table" />;
  if (locations.error) return <Page><Alert tone="danger">{locations.error.message}</Alert></Page>;
  return (
    <Page layout="fills">
      <PageHeader
        title={pageTitle}
        description="管理營運據點對應的辦公位置與定位範圍；員工可打卡地點請到出勤範圍管理設定。"
        actions={(canWrite || canReviewOvertime) ? <div className="flex flex-wrap items-center justify-end gap-2">{canReviewOvertime ? <Button variant="secondary" tone="info" onClick={() => navigate("/hr/requests?type=overtime")}>申請與審核</Button> : null}{canWrite ? <Button icon="plus" tone="success" mobileIconOnly onClick={() => setEditor("new")}>新增辦公位置</Button> : null}</div> : undefined}
      />
      <Panel grows>
        <FilterToolbar>
          <FilterInput label="搜尋辦公位置或據點" type="search" className={SEARCH_INPUT_WIDTH} placeholder="搜尋辦公位置或營運據點" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <FilterSelect label="營運據點" value={scopeId} options={[{ value: "all", label: "全部營運據點" }, ...(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => { setScopeId(event.target.value); setPage(1); }} />
        </FilterToolbar>
        {locations.isFetching ? <FormHint>更新中…</FormHint> : null}
        <DataTable className="[&_td]:align-top">
            <thead><tr><SortableHeader label="辦公位置" field="name" active={sortField} direction={sortDirection} onSort={updateSort} /><SortableHeader label="營運據點" field="scope" active={sortField} direction={sortDirection} onSort={updateSort} /><th>定位判斷</th><SortableHeader label="半徑" field="radius" active={sortField} direction={sortDirection} onSort={updateSort} />{canWrite ? <th>操作</th> : null}</tr></thead>
            <tbody>
              {rows.map((office) => (
                <tr key={office.id}>
                  <td data-label="辦公位置"><strong>{office.name}</strong><small className="text-muted mt-1 block">{office.geolocationRequired ? (office.hasCoordinates ? "座標已設定" : "缺少座標") : "不使用定位座標"}</small></td>
                  <td data-label="營運據點">{office.scopeName ?? "尚未對應"}</td>
                  <td data-label="定位判斷">{office.geolocationRequired ? "需要" : "不檢查"}</td>
                  <td data-label="半徑">{office.geolocationRequired ? `${office.radiusMeters} 公尺` : "—"}</td>
                  {canWrite ? <td data-label="操作"><Button variant="icon" icon="edit" tone="info" title={`編輯 ${office.name}`} aria-label={`編輯 ${office.name}`} onClick={() => setEditor(office)} /></td> : null}
                </tr>
              ))}
            </tbody>
        </DataTable>
        {!rows.length ? <TableNote>沒有符合條件的辦公位置。</TableNote> : null}
        <Pager className="mt-4 shrink-0" page={page} pageSize={pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.ceil(total / pageSize)} totalLabel={`共 ${total.toLocaleString("zh-TW")} 筆`} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
      </Panel>
      {editor ? <LocationDialog location={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} /> : null}
    </Page>
  );
}
