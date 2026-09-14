import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, FilterInput, FilterSelect, PageHeader, Panel, SelectField, TextField } from "../../ui/index.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { useHrQuery, useHrWrite, type AttendanceLocation, type AttendanceLocationDetail, type AttendanceLocationSchedule, type GoogleMapPlace, type NamedOption } from "./api.js";

interface LocationDraft {
  name: string;
  scopeId: string | null;
  geolocationRequired: boolean;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: string;
  revision?: number;
}

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
function defaultSchedules(locationId = ""): AttendanceLocationSchedule[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => ({ id: null, locationId, dayOfWeek, isRestDay: dayOfWeek === 0, startMinute: dayOfWeek === 0 ? null : 540, endMinute: dayOfWeek === 0 ? null : 1080, standardMinutes: dayOfWeek === 0 ? 0 : 480, toleranceMinutes: 10, revision: 0 }));
}
function timeValue(minutes: number | null) { return minutes === null ? "" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; }
function timeMinutes(value: string) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null; return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)); }

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

function LocationDialog({ location, onClose }: { location?: AttendanceLocation; onClose: () => void }) {
  const detail = useHrQuery<{ location: AttendanceLocationDetail }>(location ? `/attendance-settings/locations/${location.id}` : "/attendance-settings/locations/new", Boolean(location));
  const scheduleQuery = useHrQuery<{ schedules: AttendanceLocationSchedule[] }>(location ? `/attendance-settings/locations/${location.id}/schedules` : "/attendance-settings/locations/new/schedules", Boolean(location));
  const source = detail.data?.location;
  const [draft, setDraft] = useState(() => draftOf(source));
  const scopes = useHrQuery<{ scopes: NamedOption[] }>("/scopes");
  const [mapQuery, setMapQuery] = useState(location?.name ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<GoogleMapPlace | null>(() => savedPlace(source));
  const [weeklySchedules, setWeeklySchedules] = useState<AttendanceLocationSchedule[]>(() => defaultSchedules(location?.id ?? ""));
  const places = useHrQuery<{ places: GoogleMapPlace[] }>(`/attendance-settings/places?query=${encodeURIComponent(searchQuery)}`, Boolean(searchQuery));
  const save = useHrWrite<{ id?: string }>();
  const saveSchedule = useHrWrite();
  const editing = Boolean(location);
  const path = editing ? `/attendance-settings/locations/${location?.id}` : "/attendance-settings/locations";

  useEffect(() => {
    if (source) {
      setDraft(draftOf(source));
      setMapQuery(source.name);
      setSelectedPlace(savedPlace(source));
    }
  }, [source]);
  useEffect(() => {
    if (scheduleQuery.data?.schedules) setWeeklySchedules(scheduleQuery.data.schedules);
  }, [scheduleQuery.data]);

  if (editing && detail.isPending) {
    return <Dialog title="編輯辦公位置" onClose={onClose}><p className="muted">載入位置設定…</p></Dialog>;
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
      radiusMeters: Number(draft.radiusMeters),
    };
    if (draft.revision !== undefined) values.revision = draft.revision;
    save.mutate({ path, method: editing ? "PATCH" : "POST", values }, { onSuccess: (result) => {
      const locationId = editing ? location?.id : (result as { id?: string }).id;
      if (!locationId) { onClose(); return; }
      saveSchedule.mutate({ path: `/attendance-settings/locations/${locationId}/schedules`, method: "PUT", values: { schedules: weeklySchedules } }, { onSuccess: onClose });
    } });
  }

  function updateSchedule(dayOfWeek: number, patch: Partial<AttendanceLocationSchedule>) {
    setWeeklySchedules((current) => current.map((schedule) => schedule.dayOfWeek === dayOfWeek ? { ...schedule, ...patch } : schedule));
  }
  const coordinateQuery = draft.latitude !== null && draft.longitude !== null ? `${draft.latitude}, ${draft.longitude}` : "";
  return (
    <Dialog
      title={editing ? "編輯辦公位置" : "新增辦公位置"}
      onClose={onClose}
      closeDisabled={save.isPending || saveSchedule.isPending}
      formProps={{ onSubmit: submit }}
      actions={<Button type="submit" loading={save.isPending || saveSchedule.isPending}>儲存</Button>}
    >
      <SelectField label="營運據點" value={draft.scopeId ?? ""} options={[{ value: "", label: "請選擇營運據點" }, ...(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => setDraft({ ...draft, scopeId: event.target.value || null })} />
      <TextField
        label="辦公位置名稱"
        required
        maxLength={100}
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        hint="例如：台北辦公室。名稱不可重複。"
      />
      <div className="hr-location-map-search">
        <TextField
          label="Google Maps 搜尋地點"
          value={mapQuery}
          onChange={(event) => setMapQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              searchPlaces();
            }
          }}
          hint="輸入地址或地標，從搜尋結果選取後會自動帶入座標。"
        />
        <Button type="button" variant="secondary" disabled={!mapQuery.trim() || places.isFetching} onClick={searchPlaces}>搜尋</Button>
      </div>
      {places.isFetching ? <p className="form-hint">搜尋 Google Maps 地點…</p> : null}
      {places.error ? <Alert tone="danger">{places.error.message}</Alert> : null}
      {searchQuery && places.data && !places.data.places.length ? <p className="muted">找不到地點，請換個關鍵字。</p> : null}
      {places.data?.places.length ? (
        <div className="hr-location-place-results" aria-label="Google Maps 搜尋結果">
          <p className="form-hint">搜尋結果（{places.data.places.length} 筆），請選取正確的辦公位置：</p>
          {places.data.places.map((place) => (
            <button type="button" className="hr-location-place-result" key={place.id} onClick={() => selectPlace(place)}>
              <strong>{place.name}</strong>
              <small>{place.address}</small>
            </button>
          ))}
        </div>
      ) : null}
      <Field label="已選辦公位置" required={draft.geolocationRequired} hint={draft.geolocationRequired ? "請先從 Google Maps 搜尋結果選取辦公位置。" : "關閉定位判斷時可不選位置座標。"}>
        {selectedPlace ? (
          <div className="hr-location-selected-place">
            <strong>{selectedPlace.name}</strong>
            <small>{selectedPlace.address}</small>
          </div>
        ) : <p className="field-static">尚未選取辦公位置</p>}
      </Field>
      <Field label="定位判斷" hint="開啟時，正式出勤流程會以伺服器重新計算距離；拒絕定位不可完成出勤。">
        <div className="hr-location-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={draft.geolocationRequired}
            aria-label="定位判斷"
            onChange={(event) => setDraft({ ...draft, geolocationRequired: event.target.checked })}
          />
          <span className="hr-location-toggle-track" aria-hidden="true"><span /></span>
          <strong>{draft.geolocationRequired ? "啟用" : "關閉"}</strong>
        </div>
      </Field>
      {coordinateQuery ? <a className="hr-location-map-link" href={mapsSearch(coordinateQuery)} target="_blank" rel="noreferrer">在 Google Maps 檢視已選辦公位置</a> : null}
      <Field label="每週工作時段" hint="排班制員工會使用當日排班；未排班時仍可依有效辦公位置打卡。跨午夜時段請由排班資料指定。">
        <div className="hr-weekly-schedule-editor">{WEEKDAYS.map((label, dayOfWeek) => {
          const schedule = weeklySchedules.find((item) => item.dayOfWeek === dayOfWeek) ?? defaultSchedules().find((item) => item.dayOfWeek === dayOfWeek)!;
          const restDay = Boolean(schedule.isRestDay);
          return <div className="hr-weekly-schedule-row" key={dayOfWeek}><strong>{label}</strong><label className="checkbox-field"><input type="checkbox" checked={restDay} onChange={(event) => updateSchedule(dayOfWeek, { isRestDay: event.target.checked, startMinute: event.target.checked ? null : (schedule.startMinute ?? 540), endMinute: event.target.checked ? null : (schedule.endMinute ?? 1080), standardMinutes: event.target.checked ? 0 : (schedule.standardMinutes || 480) })} /> 休息日</label><TextField label="開始" type="time" value={timeValue(schedule.startMinute)} disabled={restDay} onChange={(event) => updateSchedule(dayOfWeek, { startMinute: timeMinutes(event.target.value) })} /><TextField label="結束" type="time" value={timeValue(schedule.endMinute)} disabled={restDay} onChange={(event) => updateSchedule(dayOfWeek, { endMinute: timeMinutes(event.target.value) })} /><TextField label="標準分鐘" type="number" min="0" max="1440" step="1" value={schedule.standardMinutes} disabled={restDay} onChange={(event) => updateSchedule(dayOfWeek, { standardMinutes: Number(event.target.value) })} /><TextField label="寬限分鐘" type="number" min="0" max="180" step="1" value={schedule.toleranceMinutes} onChange={(event) => updateSchedule(dayOfWeek, { toleranceMinutes: Number(event.target.value) })} /></div>;
        })}</div>
      </Field>
      <TextField
        label="出勤判斷半徑（公尺）"
        required
        type="number"
        min="1"
        max="10000"
        step="1"
        value={draft.radiusMeters}
        onChange={(event) => setDraft({ ...draft, radiusMeters: event.target.value })}
        hint="例如 50 代表距離辦公位置中心 50 公尺內。定位關閉時不會使用此值。"
      />
      {save.error ? <Alert tone="danger">{save.error.message}</Alert> : null}
      {saveSchedule.error ? <Alert tone="danger">{saveSchedule.error.message}</Alert> : null}
    </Dialog>
  );
}

export function HrAttendanceSettings() {
  const pageTitle = "出勤設定";
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

  if (!canRead) return <Alert tone="danger">你沒有檢視出勤設定的權限。</Alert>;
  if (locations.isPending) return <div className="boot">載入中…</div>;
  if (locations.error) return <div className="page"><Alert tone="danger">{locations.error.message}</Alert></div>;
  return (
    <div className="page fills">
      <PageHeader
        title={pageTitle}
        description="管理營運據點對應的辦公位置與定位範圍；排班制員工不需另行指派個別打卡地點。"
        actions={(canWrite || canReviewOvertime) ? <div className="button-row">{canReviewOvertime ? <Button variant="secondary" onClick={() => navigate("/hr/overtime")}>加班審核</Button> : null}{canWrite ? <Button icon="plus" onClick={() => setEditor("new")}>新增辦公位置</Button> : null}</div> : undefined}
      />
      <Panel className="grows">
        <div className="panel-head">
          <div><h2>辦公位置</h2><p className="muted">同一營運據點目前可設定一個主要辦公位置；歷史打卡保留當時名稱快照。</p></div>
        </div>
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput label="搜尋辦公位置或據點" type="search" className="search-input" placeholder="搜尋辦公位置或營運據點" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <FilterSelect label="營運據點" value={scopeId} options={[{ value: "all", label: "全部營運據點" }, ...(scopes.data?.scopes ?? []).map((scope) => ({ value: scope.id, label: scope.name }))]} onChange={(event) => { setScopeId(event.target.value); setPage(1); }} />
        </form>
        {locations.isFetching ? <p className="form-hint">更新中…</p> : null}
        <div className="table-scroll">
          <table className="data-table hr-location-table">
            <thead><tr><SortableHeader label="辦公位置" field="name" active={sortField} direction={sortDirection} onSort={updateSort} /><SortableHeader label="營運據點" field="scope" active={sortField} direction={sortDirection} onSort={updateSort} /><th>定位判斷</th><SortableHeader label="半徑" field="radius" active={sortField} direction={sortDirection} onSort={updateSort} />{canWrite ? <th>操作</th> : null}</tr></thead>
            <tbody>
              {rows.map((office) => (
                <tr key={office.id}>
                  <td><strong>{office.name}</strong><small className="muted">{office.geolocationRequired ? (office.hasCoordinates ? "座標已設定" : "缺少座標") : "不使用定位座標"}</small></td>
                  <td>{office.scopeName ?? "尚未對應"}</td>
                  <td>{office.geolocationRequired ? "需要" : "不檢查"}</td>
                  <td>{office.geolocationRequired ? `${office.radiusMeters} 公尺` : "—"}</td>
                  {canWrite ? <td><Button variant="icon" icon="edit" title={`編輯 ${office.name}`} aria-label={`編輯 ${office.name}`} onClick={() => setEditor(office)} /></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length ? <p className="muted table-note">沒有符合條件的辦公位置。</p> : null}
        <Pager page={page} pageSize={pageSize} pageSizes={[10, 25, 50, 100]} totalPages={Math.ceil(total / pageSize)} totalLabel={`共 ${total.toLocaleString("zh-TW")} 筆`} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
      </Panel>
      {editor ? <LocationDialog location={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} /> : null}
    </div>
  );
}
