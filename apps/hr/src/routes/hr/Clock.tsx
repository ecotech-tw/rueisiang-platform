import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, PageHeader, Panel } from "../../ui/index.js";
import { API_BASE_URL } from "../../config.js";
import { useHrQuery, useHrWrite, type ClockCalendar, type ClockCalendarDay, type ClockLocationCheck, type ClockMapLocation, type ClockStatus } from "./api.js";

const MAP_STYLE_URL = import.meta.env.VITE_MAPLIBRE_STYLE_URL?.trim() || "https://tiles.openfreemap.org/styles/positron";

function formatTaipei(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNowTaipei(value: Date) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(value);
}

function formatDateTaipei(value: Date) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "long" }).format(value);
}

function browserLocationError(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) return "請在瀏覽器中允許此網站使用定位後再試。";
  return "請開啟瀏覽器與裝置定位後再試。";
}

function eventLabel(index: number, total: number) {
  if (total === 1) return "打卡";
  if (index === 0) return "上班";
  if (index === total - 1) return "下班";
  return "-";
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return { year: Number(parts.find((part) => part.type === "year")?.value), month: Number(parts.find((part) => part.type === "month")?.value) };
}

function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "long" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function shiftMonth(year: number, month: number, offset: number) {
  const next = new Date(Date.UTC(year, month - 1 + offset, 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
}

type StaticMapPointer = { x: number; y: number };
type StaticMapDrag = { pointerId: number; startX: number; startY: number; originX: number; originY: number };

function pointerDistance(first: StaticMapPointer, second: StaticMapPointer) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function StaticClockMap({ cacheKey, onError }: { cacheKey: string; onError: () => void }) {
  const drag = useRef<StaticMapDrag | null>(null);
  const pointers = useRef(new Map<number, StaticMapPointer>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  function setMapZoom(value: number) {
    setZoom(Math.min(2.5, Math.max(1, value)));
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const [first, second] = Array.from(pointers.current.values());
      if (first && second) pinch.current = { distance: pointerDistance(first, second), zoom };
      drag.current = null;
      return;
    }
    drag.current = { pointerId: event.pointerId, startX: point.x, startY: point.y, originX: offset.x, originY: offset.y };
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    const activePinch = pinch.current;
    if (activePinch && pointers.current.size >= 2) {
      const [first, second] = Array.from(pointers.current.values());
      if (first && second) {
        event.preventDefault();
        setMapZoom(activePinch.zoom * pointerDistance(first, second) / Math.max(activePinch.distance, 1));
      }
      return;
    }
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    setOffset({ x: current.originX + event.clientX - current.startX, y: current.originY + event.clientY - current.startY });
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 1) {
      const [pointerId, point] = Array.from(pointers.current.entries())[0]!;
      drag.current = { pointerId, startX: point.x, startY: point.y, originX: offset.x, originY: offset.y };
    } else {
      drag.current = null;
    }
  }

  return <div
    className="hr-clock-static-map"
    onPointerDown={startDrag}
    onPointerMove={moveDrag}
    onPointerUp={endDrag}
    onPointerCancel={endDrag}
    onWheel={(event) => { event.preventDefault(); setMapZoom(zoom + (event.deltaY < 0 ? 0.15 : -0.15)); }}
    aria-label="辦公位置地圖，可拖曳與縮放"
  >
    <img
      className="hr-clock-map-background"
      crossOrigin="use-credentials"
      src={`${API_BASE_URL}/hr/me/attendance-map?v=${encodeURIComponent(cacheKey)}`}
      alt=""
      aria-hidden="true"
      onError={onError}
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})` }}
    />
  </div>;
}

function applyRueisiangMapStyle(map: maplibregl.Map) {
  for (const layer of map.getStyle().layers ?? []) {
    const { id } = layer;
    if (layer.type === "background") {
      map.setPaintProperty(id, "background-color", "#fff8f6");
    } else if (layer.type === "fill") {
      if (id.startsWith("water")) map.setPaintProperty(id, "fill-color", "#d8eef0");
      else if (id.startsWith("park") || id.startsWith("landcover")) map.setPaintProperty(id, "fill-color", "#dff3e7");
      else if (id.startsWith("landuse")) map.setPaintProperty(id, "fill-color", "#f8efeb");
      else if (id.startsWith("building")) map.setPaintProperty(id, "fill-color", "#f7e8e3");
    } else if (layer.type === "line" && /^(road|bridge|tunnel)/.test(id)) {
      const color = /motorway|trunk|primary/.test(id) ? "#f1cbc1" : /secondary|tertiary/.test(id) ? "#f8e3dc" : "#fffefd";
      map.setPaintProperty(id, "line-color", color);
    } else if (layer.type === "symbol" && /^(poi|highway-name|water_name|airport|label_)/.test(id)) {
      map.setLayoutProperty(id, "visibility", "none");
    }
  }
}

function MapLibreClockMap({ locations, onError }: { locations: ClockMapLocation[]; onError: () => void }) {
  const mapElement = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!mapElement.current || !locations.length) return;
    let loaded = false;
    const map = new maplibregl.Map({
      container: mapElement.current,
      style: MAP_STYLE_URL,
      center: [locations[0]!.longitude, locations[0]!.latitude],
      zoom: locations.length === 1 ? 16 : 12,
      attributionControl: { compact: true, customAttribution: "© OpenFreeMap © OpenStreetMap contributors" },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    const markers: maplibregl.Marker[] = [];
    const handleLoad = () => {
      loaded = true;
      applyRueisiangMapStyle(map);
      for (const location of locations) markers.push(new maplibregl.Marker({ color: "#d5383b" }).setLngLat([location.longitude, location.latitude]).addTo(map));
      if (locations.length > 1) {
        const bounds = new maplibregl.LngLatBounds();
        for (const location of locations) bounds.extend([location.longitude, location.latitude]);
        map.fitBounds(bounds, { padding: { top: 72, right: 72, bottom: 190, left: 72 }, maxZoom: 16 });
      } else {
        map.easeTo({ center: [locations[0]!.longitude, locations[0]!.latitude], padding: { top: 0, right: 0, bottom: 170, left: 0 }, duration: 0 });
      }
    };
    const handleError = () => {
      if (!loaded) onErrorRef.current();
    };
    map.once("load", handleLoad);
    map.on("error", handleError);
    return () => {
      markers.forEach((marker) => marker.remove());
      map.remove();
    };
  }, [locations]);

  return <div ref={mapElement} className="hr-clock-interactive-map" aria-label="辦公位置地圖" />;
}

function ClockMapBackground() {
  const mapLocations = useHrQuery<{ locations: ClockMapLocation[] }>("/me/attendance-map/locations");
  const [mapFailed, setMapFailed] = useState(false);
  const [staticMapFailed, setStaticMapFailed] = useState(false);
  const locations = mapLocations.data?.locations ?? [];
  const locationSignature = JSON.stringify(locations);

  if (!locations.length) return null;
  if (!mapFailed) return <MapLibreClockMap locations={locations} onError={() => setMapFailed(true)} />;
  return staticMapFailed ? null : <StaticClockMap cacheKey={locationSignature} onError={() => setStaticMapFailed(true)} />;
}

function CalendarGrid({ data, selectedDate, onSelect, slideClass = "" }: { data: ClockCalendar; selectedDate: string | null; onSelect: (date: string) => void; slideClass?: string }) {
  const firstWeekday = new Date(Date.UTC(data.year, data.month - 1, 1)).getUTCDay();
  const cells: (ClockCalendarDay | string)[] = [...Array.from({ length: firstWeekday }, (_, index) => `empty-${index}`), ...data.days];
  return <div className={`hr-clock-calendar-main ${slideClass}`.trim()}>
    <div className="hr-clock-calendar-weekdays" aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
    <div className="hr-clock-calendar-grid" aria-label={`${data.year} 年 ${data.month} 月出勤日曆`}>
      {cells.map((day) => typeof day === "string" ? <span className="hr-clock-calendar-empty" key={day} /> : <button
        key={day.date}
        type="button"
        className={`hr-clock-calendar-day ${day.status}${day.date === data.today ? " today" : ""}${day.date === selectedDate ? " selected" : ""}${day.anomaly ? " has-anomaly" : ""}`}
        onClick={() => onSelect(day.date)}
        aria-pressed={day.date === selectedDate}
        aria-label={`${day.date}${day.anomaly ? "，有出勤異常" : day.status === "leave" ? "，已核准請假" : day.eventCount ? `，已有 ${day.eventCount} 筆打卡` : "，沒有打卡紀錄"}`}
      >
        <strong>{Number(day.date.slice(-2))}</strong>
        {day.anomaly ? <i aria-hidden="true" /> : null}
      </button>)}
    </div>
    <div className="hr-clock-calendar-legend"><span><i className="present" />已完成</span><span><i className="anomaly" />需確認</span><span><i className="today" />今天</span></div>
  </div>;
}

function CalendarDayDetails({ day, onCorrection, onLeave }: { day: ClockCalendarDay; onCorrection: (date: string, kind: "clock_in" | "clock_out") => void; onLeave: (date: string) => void }) {
  const correctionKind = day.events.at(-1)?.eventKind === "clock_in" ? "clock_out" : "clock_in";
  const dayLabel = `${Number(day.date.slice(5, 7))} 月 ${Number(day.date.slice(-2))} 日`;
  const anomalyTitle = day.anomaly === "missing" ? "尚未完成打卡" : day.anomaly === "short-duration" ? "出勤時數異常" : day.anomaly === "late-arrival" ? "上班打卡較晚" : day.anomaly === "early-leave" ? "下班打卡較早" : day.anomaly === "unscheduled" ? "非排班日打卡" : "打卡紀錄順序異常";
  return <section className={`hr-clock-calendar-details${day.anomaly ? " has-anomaly" : ""}`} aria-live="polite">
    <div className="hr-clock-calendar-details-head"><strong>{dayLabel}</strong><span>{["日", "一", "二", "三", "四", "五", "六"][day.weekday]}曜日</span></div>
    {day.status === "leave" ? <p className="hr-clock-calendar-empty-detail">已核准請假，這天沒有預期出勤。</p> : day.events.length ? <ul className="hr-clock-calendar-events">
      {day.events.map((event) => <li key={event.id}><span>{event.eventKind === "clock_in" ? "上班" : "下班"}</span><strong>{formatTaipei(event.occurredAt)}</strong><small>{event.locationName ?? "未指定辦公位置"}</small></li>)}
    </ul> : day.anomaly ? null : <p className="hr-clock-calendar-empty-detail">{day.status === "rest" ? "休息日，沒有預期出勤。" : day.status === "future" ? "尚未到這一天。" : day.status === "not-employed" ? "目前不是活動員工。" : "這天尚未有打卡紀錄。"}</p>}
    {day.anomaly ? <div className="hr-clock-calendar-anomaly"><strong>{anomalyTitle}</strong><span>{day.anomalyMessage ?? "請確認當日出勤紀錄。"}</span><div className="hr-clock-calendar-actions"><Button onClick={() => onCorrection(day.date, correctionKind)}>申請忘刷</Button><Button variant="secondary" onClick={() => onLeave(day.date)}>請假申請</Button></div></div> : null}
  </section>;
}

function ClockOfficeCard({ status, check }: { status?: ClockStatus; check?: ClockLocationCheck }) {
  const officeName = check?.locationName ?? status?.locationName ?? status?.locationNames?.[0] ?? "尚未設定辦公位置";
  const detail = check?.withinRadius
    ? `已定位・距離約 ${check.distanceMeters ?? 0} 公尺`
    : check?.message ?? (status?.locationNames?.length ? `可打卡位置：${status.locationNames.join("、")}` : "等待定位結果");
  return <section className="hr-clock-office-card" aria-label="定位到的辦公室">
    <span className={`hr-clock-office-pin${check?.withinRadius === false ? " outside" : check?.withinRadius ? " verified" : ""}`}><Icon name="storefront" /></span>
    <div>
      <span>定位辦公室</span>
      <strong>{officeName}</strong>
      <small>{detail}</small>
    </div>
  </section>;
}

function ClockTimeline({ status }: { status?: ClockStatus }) {
  const chronologicalEvents = status ? [...status.events].reverse() : [];
  return chronologicalEvents.length ? <ol className="hr-clock-timeline">
    {chronologicalEvents.map((event, index) => <li key={event.id} className={index === 0 ? "first" : index === chronologicalEvents.length - 1 ? "last" : "middle"}>
      <span className="hr-clock-event-label">{eventLabel(index, chronologicalEvents.length)}</span>
      <div className="hr-clock-event-copy"><strong>{formatTaipei(event.occurredAt)}</strong><small>{event.locationName ?? "未指定辦公位置"}{event.distanceMeters === null ? "" : `・距離 ${event.distanceMeters} 公尺`}</small></div>
    </li>)}
  </ol> : <p className="muted">今天尚未打卡。</p>;
}

export function HrClock() {
  usePageTitle("打卡日曆");
  const query = useHrQuery<ClockStatus>("/me/clock-events");
  const routeLocation = useLocation();
  const clock = useHrWrite();
  const locationCheck = useHrWrite<ClockLocationCheck>();
  const [now, setNow] = useState(() => new Date());
  const [locationRequested, setLocationRequested] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const status = query.data;
  const demoLocationFailed = new URLSearchParams(routeLocation.search).get("demoLocation") === "failed";
  const demoCheck: ClockLocationCheck | undefined = demoLocationFailed ? { available: true, withinRadius: false, locationName: "示範台北辦公室", locationNames: ["示範台北辦公室"], distanceMeters: 860, radiusMeters: 100, geolocationRequired: true, message: "示意：目前位置不在可打卡範圍內。" } : undefined;
  const visibleLocationCheck = demoCheck ?? locationCheck.data;
  const visibleLocationError = demoLocationFailed ? "示意：定位失敗或不在可打卡範圍內，請確認瀏覽器定位權限後重新定位。" : locationError;
  const outsideOffice = visibleLocationCheck?.withinRadius === false;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  function position() {
    return new Promise<GeolocationPosition>((resolve, reject) => {
      if (!window.isSecureContext) {
        reject(new Error("請使用 HTTPS 或 localhost 開啟頁面後再試。"));
        return;
      }
      if (!navigator.geolocation) {
        reject(new Error("請開啟瀏覽器與裝置定位後再試。"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, maximumAge: 10_000, timeout: 15_000 });
    });
  }

  async function verifyLocation() {
    if (!status?.canClock || !status.geolocationRequired || locating) return null;
    locationCheck.reset();
    setLocating(true);
    setLocationError("");
    try {
      const current = await position();
      const check = await locationCheck.mutateAsync({ path: "/me/attendance-location/check", method: "POST", values: { latitude: current.coords.latitude, longitude: current.coords.longitude } });
      if (!check.withinRadius && check.message) setLocationError(check.message);
      return { check, current };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const locationError = error as GeolocationPositionError;
        console.warn("[HR clock] geolocation failed", { code: locationError.code, message: locationError.message });
      }
      const message = typeof error === "object" && error !== null && "code" in error
        ? browserLocationError(error as GeolocationPositionError)
        : error instanceof Error ? error.message : "無法取得目前位置，請稍後再試。";
      setLocationError(message);
      return null;
    } finally {
      setLocating(false);
    }
  }

  useEffect(() => {
    if (!status?.canClock || !status.geolocationRequired || locationRequested) return;
    setLocationRequested(true);
    void verifyLocation();
  }, [locationRequested, status?.canClock, status?.geolocationRequired]);

  async function clockInOrOut() {
    if (!status?.canClock || clock.isPending || locating) return;
    clock.reset();
    setSuccessMessage("");
    setLocationError("");
    if (!status.geolocationRequired) {
      await clock.mutateAsync({ path: "/me/clock-events", method: "POST", values: { idempotencyKey: crypto.randomUUID() } });
      setSuccessMessage("打卡成功，已更新今天的紀錄。");
      return;
    }
    const located = await verifyLocation();
    if (!located?.check.withinRadius) return;
    await clock.mutateAsync({ path: "/me/clock-events", method: "POST", values: { idempotencyKey: crypto.randomUUID(), latitude: located.current.coords.latitude, longitude: located.current.coords.longitude } });
    setSuccessMessage("打卡成功，已更新今天的紀錄。");
  }

  async function confirmClock() {
    setConfirmOpen(false);
    await clockInOrOut();
  }

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(""), 3_200);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const actionLabel = status?.nextEventKind === "clock_out" ? "下班" : "上班";
  const clockDisabled = demoLocationFailed || !status?.canClock || query.isPending || Boolean(query.error) || (status?.geolocationRequired === true && locationCheck.data?.withinRadius !== true) || locationCheck.isPending;
  const lastEvent = status?.events[0];
  return <div className="page hr-clock-page hr-clock-full-page">
    <section className="hr-clock-map-stage">
      <ClockMapBackground />
      <div className="hr-clock-hero" aria-label="今日打卡狀態">
        <Icon name="person" className="hr-clock-hero-person" />
        <p className="hr-clock-now">{formatNowTaipei(now)}</p>
        <p className="hr-clock-date">{formatDateTaipei(now)}</p>
      </div>
      <div className="hr-clock-action-panel">
        <button className="hr-clock-main-action" type="button" disabled={clockDisabled} aria-label="打卡" aria-busy={clock.isPending || locating || undefined} onClick={() => setConfirmOpen(true)}>
          {clock.isPending || locating ? <span className="hr-clock-action-loading">…</span> : <Icon name="clock" />}
        </button>
        <ClockOfficeCard status={status} check={visibleLocationCheck} />
        <nav className="hr-clock-deep-links" aria-label="打卡詳細資料">
          <NavLink to="/clock/calendar" aria-label="出勤日曆"><Icon name="calendar" /><span>出勤日曆</span></NavLink>
          <NavLink to="/clock/logs" aria-label="打卡紀錄"><Icon name="history" /><span>打卡紀錄</span></NavLink>
        </nav>
        {lastEvent ? <p className="hr-clock-last-event">最近一次：{lastEvent.eventKind === "clock_out" ? "下班" : "上班"}・{formatTaipei(lastEvent.occurredAt)}</p> : <p className="hr-clock-last-event">今天尚未打卡。</p>}
        {(demoLocationFailed || status?.geolocationRequired) && (visibleLocationError || outsideOffice) ? <Button className="hr-clock-retry-action" variant="secondary" disabled={!status?.canClock || locating} onClick={() => { void verifyLocation(); }}>重新定位</Button> : null}
      </div>
      {successMessage || status?.message || query.error || visibleLocationError || clock.error ? <div className="hr-clock-feedback-corner">
        {successMessage ? <Alert tone="success">{successMessage}</Alert> : null}
        {status?.message ? <p className="hr-clock-blocked">{status.message}</p> : null}
        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {visibleLocationError ? <Alert tone="danger">{visibleLocationError}</Alert> : null}
        {clock.error ? <Alert tone="danger">{clock.error.message}</Alert> : null}
      </div> : null}
    </section>
    {confirmOpen ? <Dialog title="確認打卡" role="alertdialog" onClose={() => setConfirmOpen(false)} actions={<><Button variant="secondary" onClick={() => setConfirmOpen(false)}>取消</Button><Button onClick={() => { void confirmClock(); }}>確認{actionLabel}打卡</Button></>}>
      <p>確定要{actionLabel}打卡嗎？</p>
    </Dialog> : null}
  </div>;
}

export function HrClockCalendar() {
  usePageTitle("出勤日曆");
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(currentMonth);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [monthSlide, setMonthSlide] = useState("");
  const touchStartX = useRef<number | null>(null);
  const calendar = useHrQuery<ClockCalendar>(`/me/attendance-calendar?year=${calendarMonth.year}&month=${calendarMonth.month}`);
  const selectedDay = calendar.data?.days.find((day) => day.date === selectedDate) ?? null;

  useEffect(() => {
    if (!calendar.data) return;
    const currentMonthDay = calendar.data.days.find((day) => day.date === calendar.data?.today);
    setSelectedDate((current) => current && calendar.data?.days.some((day) => day.date === current) ? current : currentMonthDay?.date ?? calendar.data?.days[0]?.date ?? null);
  }, [calendar.data]);

  function changeMonth(offset: number) {
    setMonthSlide(offset > 0 ? "slide-next" : "slide-prev");
    setCalendarMonth((current) => shiftMonth(current.year, current.month, offset));
    window.setTimeout(() => setMonthSlide(""), 260);
  }
  function handleTouchStart(event: React.TouchEvent<HTMLElement>) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }
  function handleTouchEnd(event: React.TouchEvent<HTMLElement>) {
    const start = touchStartX.current;
    const end = event.changedTouches[0]?.clientX;
    touchStartX.current = null;
    if (start === null || end === undefined || Math.abs(end - start) < 48) return;
    changeMonth(end < start ? 1 : -1);
  }
  function openCorrection(date: string, kind: "clock_in" | "clock_out") {
    navigate(`/forms/new?date=${encodeURIComponent(date)}&kind=${kind}`);
  }
  function openLeave(date: string) {
    navigate(`/forms?type=leave&date=${encodeURIComponent(date)}`);
  }
  function closeSubpage() {
    setClosing(true);
    window.setTimeout(() => navigate("/clock"), 220);
  }
  return <div className={`page hr-clock-page hr-clock-subpage${closing ? " closing" : ""}`}>
    <button className="hr-clock-back-link" type="button" onClick={closeSubpage}><Icon name="chevronLeft" />返回打卡</button>
    <PageHeader title="出勤日曆" description="左右滑動切換月份，點擊日期查看打卡紀錄。" />
    {calendar.error ? <Alert tone="danger">{calendar.error.message}</Alert> : null}
    <section className="panel hr-clock-calendar hr-clock-calendar-open" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="hr-clock-calendar-toolbar">
        <Button variant="icon" icon="chevronLeft" aria-label="上一個月" onClick={() => changeMonth(-1)} />
        <strong>{monthLabel(calendarMonth.year, calendarMonth.month)}</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下一個月" onClick={() => changeMonth(1)} />
      </div>
      {calendar.isPending ? <p className="muted">載入日曆…</p> : calendar.data ? <>
        <CalendarGrid key={`${calendarMonth.year}-${calendarMonth.month}`} data={calendar.data} selectedDate={selectedDate} onSelect={setSelectedDate} slideClass={monthSlide} />
        {selectedDay ? <CalendarDayDetails day={selectedDay} onCorrection={openCorrection} onLeave={openLeave} /> : null}
      </> : null}
    </section>
  </div>;
}

export function HrClockLogs() {
  usePageTitle("打卡紀錄");
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const status = useHrQuery<ClockStatus>("/me/clock-events");
  function closeSubpage() {
    setClosing(true);
    window.setTimeout(() => navigate("/clock"), 220);
  }
  return <div className={`page hr-clock-page hr-clock-subpage${closing ? " closing" : ""}`}>
    <button className="hr-clock-back-link" type="button" onClick={closeSubpage}><Icon name="chevronLeft" />返回打卡</button>
    <PageHeader title="打卡紀錄" description="今天每次操作都會保留；第一筆視為上班，最後一筆視為下班。" />
    <Panel className="hr-clock-history-panel">
      <ClockTimeline status={status.data} />
      {status.error ? <Alert tone="danger">{status.error.message}</Alert> : null}
    </Panel>
  </div>;
}
