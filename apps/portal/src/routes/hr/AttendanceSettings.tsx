import { useEffect, useState } from "react";
import { useSession } from "../../auth/session.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Field, PageHeader, Panel, TextField } from "../../ui/index.js";
import { useHrQuery, useHrWrite, type AttendanceLocation, type AttendanceLocationDetail, type GoogleMapPlace } from "./api.js";

interface LocationDraft {
  name: string;
  geolocationRequired: boolean;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: string;
  revision?: number;
}

function draftOf(location?: AttendanceLocationDetail): LocationDraft {
  return {
    name: location?.name ?? "",
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
  const source = detail.data?.location;
  const [draft, setDraft] = useState(() => draftOf(source));
  const [mapQuery, setMapQuery] = useState(location?.name ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<GoogleMapPlace | null>(() => savedPlace(source));
  const places = useHrQuery<{ places: GoogleMapPlace[] }>(`/attendance-settings/places?query=${encodeURIComponent(searchQuery)}`, Boolean(searchQuery));
  const save = useHrWrite();
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
      geolocationRequired: draft.geolocationRequired,
      latitude: draft.latitude,
      longitude: draft.longitude,
      radiusMeters: Number(draft.radiusMeters),
    };
    if (draft.revision !== undefined) values.revision = draft.revision;
    save.mutate({ path, method: editing ? "PATCH" : "POST", values }, { onSuccess: onClose });
  }

  const coordinateQuery = draft.latitude !== null && draft.longitude !== null ? `${draft.latitude}, ${draft.longitude}` : "";
  return (
    <Dialog
      title={editing ? "編輯辦公位置" : "新增辦公位置"}
      onClose={onClose}
      closeDisabled={save.isPending}
      formProps={{ onSubmit: submit }}
      actions={<Button type="submit" loading={save.isPending}>儲存</Button>}
    >
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
    </Dialog>
  );
}

export function HrAttendanceSettings() {
  usePageTitle("出勤設定");
  const { permissions } = useSession();
  const canRead = permissions.has("hr:office:read");
  const canWrite = permissions.has("hr:office:write");
  const locations = useHrQuery<{ locations: AttendanceLocation[] }>("/attendance-settings/locations", canRead);
  const [editor, setEditor] = useState<AttendanceLocation | "new" | null>(null);

  if (!canRead) return <Alert tone="danger">你沒有檢視出勤設定的權限。</Alert>;
  if (locations.isPending) return <div className="boot">載入中…</div>;
  if (locations.error) return <div className="page"><Alert tone="danger">{locations.error.message}</Alert></div>;

  const locationRows = locations.data?.locations ?? [];
  const refresh = () => { void locations.refetch(); };
  return (
    <div className="page">
      <PageHeader
        title="出勤設定"
        description="管理出勤判斷使用的辦公位置；員工的辦公位置請在員工管理中指派。"
        actions={canWrite ? <Button icon="plus" onClick={() => setEditor("new")}>新增辦公位置</Button> : undefined}
      />
      <Panel>
        <div className="panel-head">
          <div><h2>辦公位置</h2><p className="muted">辦公位置是出勤規則的主檔，不等同報表 scope，也不在這裡指派員工。</p></div>
          <Button variant="secondary" onClick={refresh}>重新整理</Button>
        </div>
        {locations.isFetching ? <p className="form-hint">更新中…</p> : null}
        <div className="table-scroll">
          <table className="data-table hr-location-table">
            <thead><tr><th>辦公位置</th><th>定位判斷</th><th>半徑</th>{canWrite ? <th>操作</th> : null}</tr></thead>
            <tbody>
              {locationRows.map((office) => (
                <tr key={office.id}>
                  <td><strong>{office.name}</strong><small className="muted">{office.geolocationRequired ? (office.hasCoordinates ? "座標已設定" : "缺少座標") : "不使用定位座標"}</small></td>
                  <td>{office.geolocationRequired ? "需要" : "不檢查"}</td>
                  <td>{office.geolocationRequired ? `${office.radiusMeters} 公尺` : "—"}</td>
                  {canWrite ? <td><Button variant="icon" icon="edit" title={`編輯 ${office.name}`} aria-label={`編輯 ${office.name}`} onClick={() => setEditor(office)} /></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!locationRows.length ? <p className="muted table-note">尚無辦公位置，請先新增辦公室。</p> : null}
      </Panel>
      {editor ? <LocationDialog location={editor === "new" ? undefined : editor} onClose={() => { setEditor(null); refresh(); }} /> : null}
    </div>
  );
}
