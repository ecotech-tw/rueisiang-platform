import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { useSession, useSignOut } from "../../auth/session.js";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Icon } from "../../shell/icons.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, Dialog, Page, PageHeader, PANEL_SURFACE } from "../../ui/index.js";
import { API_BASE_URL } from "../../config.js";
import { PeriodToolbar } from "./PeriodToolbar.js";
import { useHrQuery, useHrWrite, type ClockCalendar, type ClockCalendarDay, type ClockLocationCheck, type ClockMapLocation, type ClockStatus } from "./api.js";

const MAP_STYLE_URL = import.meta.env.VITE_MAPLIBRE_STYLE_URL?.trim() || "https://tiles.openfreemap.org/styles/positron";

function formatTaipei(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatTaipeiTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value.slice(11, 16);
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
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

function formatWorkedMinutes(minutes: number) {
  if (minutes <= 0) return "0 小時";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分` : `${hours} 小時`;
}

function calendarStatusLabel(status: ClockCalendarDay["status"]) {
  return status === "present" ? "已有打卡" : status === "missing" ? "待確認缺卡" : status === "leave" ? "已核准請假" : status === "rest" ? "休息日" : status === "future" ? "尚未到班" : status === "open" ? "今日進行中" : status === "not-employed" ? "非任職日" : "出勤狀態";
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

type MonthSlide = "next" | "prev" | "";

const MONTH_SLIDE_CLASS: Record<MonthSlide, string> = {
  next: "animate-[hr-calendar-slide-next_.24s_cubic-bezier(.05,.7,.1,1)] motion-reduce:animate-none",
  prev: "animate-[hr-calendar-slide-prev_.24s_cubic-bezier(.05,.7,.1,1)] motion-reduce:animate-none",
  "": "",
};

const CALENDAR_COLUMNS = "grid grid-cols-7 gap-1.5 max-[760px]:gap-[3px]";
const MUTED_DAY_STATUSES = new Set<ClockCalendarDay["status"]>(["rest", "future", "leave", "not-employed"]);
const LEGEND_ITEM = "inline-flex items-center gap-[5px]";
const LEGEND_DOT = "size-[7px] rounded-full";

// 狀態色蓋過選中色：選中只換框線與光暈，已完成、缺卡與淡化的日子仍維持各自的字色；只有沒有狀態色的進行中日才換成選中的色調容器。
function calendarDayClass(day: ClockCalendarDay, today: boolean, selected: boolean) {
  const typhoon = day.specialKind === "typhoon_stop" && !selected;
  const muted = MUTED_DAY_STATUSES.has(day.status);
  const border = today && selected ? "border-brand" : day.status === "missing" ? "border-transparent" : today ? "border-secondary" : selected ? "border-brand" : "border-transparent";
  const tone = typhoon ? "bg-secondary/10 text-ink"
    : day.status === "present" ? "text-ok hover:bg-brand/7"
    : day.status === "missing" ? "text-ink hover:bg-brand/7"
    : muted ? "text-muted opacity-52 hover:bg-brand/7"
    : selected ? "bg-brand-soft text-brand-dark hover:bg-brand/7"
    : "text-ink hover:bg-brand/7";
  return `relative grid min-h-0 content-center justify-items-center gap-[3px] rounded-[12px] border px-0.5 py-1 tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary max-[760px]:rounded-[9px] ${border} ${tone} ${selected ? "[box-shadow:0_0_0_2px_--alpha(var(--color-brand)/18%)]" : ""}`;
}

function CalendarGrid({ data, selectedDate, onSelect, slide = "" }: { data: ClockCalendar; selectedDate: string | null; onSelect: (date: string) => void; slide?: MonthSlide }) {
  const firstWeekday = new Date(Date.UTC(data.year, data.month - 1, 1)).getUTCDay();
  const cells: (ClockCalendarDay | string)[] = [...Array.from({ length: firstWeekday }, (_, index) => `empty-${index}`), ...data.days];
  // 日曆格的高度跟著視窗高度縮放，手機矮螢幕再固定成一個能放下下方明細的高度。
  return <div className={`grid min-h-0 grid-rows-[auto_clamp(260px,42vh,320px)_auto] max-[760px]:grid-rows-[auto_clamp(216px,40vh,276px)_auto] max-[760px]:[@media(max-height:720px)]:grid-rows-[auto_228px_auto] ${MONTH_SLIDE_CLASS[slide]}`}>
    <div className={`${CALENDAR_COLUMNS} pt-2.5 pb-1 text-center text-[12px] font-bold text-muted max-[760px]:pt-[7px]`} aria-hidden="true">{["日", "一", "二", "三", "四", "五", "六"].map((weekday) => <span key={weekday}>{weekday}</span>)}</div>
    <div className={`${CALENDAR_COLUMNS} h-full min-h-0 grid-rows-6`} aria-label={`${data.year} 年 ${data.month} 月出勤日曆`}>
      {cells.map((day) => typeof day === "string" ? <span className="min-h-[52px]" key={day} /> : <button
        key={day.date}
        type="button"
        className={calendarDayClass(day, day.date === data.today, day.date === selectedDate)}
        onClick={() => onSelect(day.date)}
        aria-pressed={day.date === selectedDate}
        aria-label={`${day.date}，${calendarStatusLabel(day.status)}${day.workedMinutes ? `，實際 ${formatWorkedMinutes(day.workedMinutes)}` : ""}${day.specialKind === "typhoon_stop" ? "，災防停班" : ""}${day.anomaly ? "，有出勤異常" : day.eventCount ? `，已有 ${day.eventCount} 筆打卡` : "，沒有打卡紀錄"}`}
      >
        <strong className={`text-[14px] ${day.date === data.today ? "font-extrabold" : "font-bold"}`}>{Number(day.date.slice(-2))}</strong>
        {day.anomaly ? <i className="size-[5px] rounded-full bg-brand" aria-hidden="true" /> : null}
      </button>)}
    </div>
    <div className="flex flex-wrap gap-x-3.5 gap-y-2 pt-2 text-[11px] text-muted max-[760px]:gap-x-2.5 max-[760px]:gap-y-1.5 max-[760px]:pt-1.5">
      <span className={LEGEND_ITEM}><i className={`${LEGEND_DOT} bg-ok`} />已完成</span>
      <span className={LEGEND_ITEM}><i className={`${LEGEND_DOT} bg-brand`} />需確認</span>
      <span className={LEGEND_ITEM}><i className={`${LEGEND_DOT} border border-secondary`} />今天</span>
    </div>
  </div>;
}

const CALENDAR_EMPTY_DETAIL = "m-0 text-[12px] text-muted";
const CALENDAR_ANOMALY_NOTE = "min-w-0 overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-muted max-[760px]:col-start-2";

function CalendarDayDetails({ day, onCorrection, onLeave }: { day: ClockCalendarDay; onCorrection: (date: string, kind: "clock_in" | "clock_out") => void; onLeave: (date: string) => void }) {
  const { user } = useSession();
  const canApply = user?.hrSelfServiceKind !== "worker";
  const correctionKind = day.events.at(-1)?.eventKind === "clock_in" ? "clock_out" : "clock_in";
  const dayLabel = `${Number(day.date.slice(5, 7))} 月 ${Number(day.date.slice(-2))} 日`;
  const anomalyTitle = day.anomaly === "missing" ? "尚未完成打卡" : day.anomaly === "short-duration" ? "出勤時數異常" : day.anomaly === "late-arrival" ? "上班打卡較晚" : day.anomaly === "early-leave" ? "下班打卡較早" : day.anomaly === "unscheduled" ? "非排班日打卡" : "打卡紀錄順序異常";
  /*
   * 明細放不下時在自己裡面捲，不能 overflow-hidden：一天有好幾筆打卡時，最下面的「申請忘刷／請假申請」
   * 會被裁掉，手機上整天的補卡入口就不見了。異常與按鈕那一塊釘在底部，捲的只有上面的紀錄。
   */
  return <section className="grid min-h-0 gap-2 overflow-y-auto overscroll-contain rounded-[12px] border-t border-t-soft-line bg-canvas px-3 py-2.5 max-[760px]:gap-1.5 max-[760px]:px-2.5 max-[760px]:py-2" aria-live="polite">
    <div className="flex items-baseline justify-between gap-2"><strong className="text-[14px]">{dayLabel}</strong><span className="text-[12px] text-muted">{["日", "一", "二", "三", "四", "五", "六"][day.weekday]}曜日</span></div>
    {day.specialKind === "typhoon_stop" ? <p className="m-0 rounded-[8px] bg-secondary/12 px-2 py-1.5 text-[12px] text-ink">災防停班：原排班保留，適用範圍內未打卡不列為缺勤。</p> : null}
    {day.expectedStartAt || day.expectedEndAt || day.workedMinutes > 0 ? <div className="flex items-baseline justify-between gap-2 rounded-[8px] bg-paper px-[9px] py-[7px] text-[11px] text-muted"><span>預期 {day.expectedStartAt ? formatTaipeiTime(day.expectedStartAt) : "—"}～{day.expectedEndAt ? formatTaipeiTime(day.expectedEndAt) : "—"}</span><strong className="text-[12px] text-ink tabular-nums">實際 {formatWorkedMinutes(day.workedMinutes)}</strong></div> : null}
    {day.status === "leave" ? <p className={CALENDAR_EMPTY_DETAIL}>已核准請假，這天沒有預期出勤。</p> : day.events.length ? <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0 max-[760px]:gap-1">
      {day.events.map((event) => <li key={event.id} className="grid min-w-0 grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1 rounded-[8px] bg-paper px-2 py-1.5 max-[760px]:px-1.5 max-[760px]:py-[5px]"><span className="text-[11px] text-muted">{event.eventKind === "clock_in" ? "上班" : "下班"}</span><strong className="text-[12px] tabular-nums">{formatTaipei(event.occurredAt)}</strong><small className="col-span-full overflow-hidden text-[10px] text-ellipsis whitespace-nowrap text-muted">{event.locationName ?? "未指定辦公位置"}</small></li>)}
    </ul> : day.anomaly ? null : <p className={CALENDAR_EMPTY_DETAIL}>{day.status === "rest" ? "休息日，沒有預期出勤。" : day.status === "future" ? "尚未到這一天。" : day.status === "not-employed" ? "目前不是活動員工。" : "這天尚未有打卡紀錄。"}</p>}
    {day.anomaly ? <div className="sticky bottom-0 z-1 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 bg-canvas before:size-1.5 before:rounded-full before:bg-brand before:content-[''] max-[760px]:grid-cols-[auto_minmax(0,1fr)]"><strong className="text-[12px] text-brand-dark">{anomalyTitle}</strong><span className={CALENDAR_ANOMALY_NOTE}>{day.anomalyMessage ?? "請確認當日出勤紀錄。"}</span>{canApply ? <div className="flex gap-1.5 max-[760px]:col-span-full max-[760px]:justify-stretch"><Button size="lg" tone="success" className="max-[760px]:flex-1" onClick={() => onCorrection(day.date, correctionKind)}>申請忘刷</Button><Button size="lg" variant="secondary" tone="success" className="max-[760px]:flex-1" onClick={() => onLeave(day.date)}>請假申請</Button></div> : <span className={CALENDAR_ANOMALY_NOTE}>如需更正紀錄，請聯絡管理者。</span>}</div> : null}
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

export function HrClock() {
  usePageTitle("打卡日曆");
  const { user } = useSession();
  const lineLiffAuthenticated = Boolean(user?.lineLiffAuthenticated);
  const query = useHrQuery<ClockStatus>("/me/clock-events");
  const routeLocation = useLocation();
  const clock = useHrWrite();
  const unlink = useHrWrite<{ unlinked: boolean }>();
  const signOut = useSignOut();
  const locationCheck = useHrWrite<ClockLocationCheck>();
  const [now, setNow] = useState(() => new Date());
  const [locationRequested, setLocationRequested] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState("");
  const confirmCloseRef = useRef<(() => void) | null>(null);
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

  function closeConfirm() {
    setConfirmOpen(false);
  }

  async function confirmClock() {
    // 關閉交給 Dialog 的退場流程；這裡只執行打卡，避免成功操作直接卸載 Dialog。
    await clockInOrOut();
  }

  async function confirmUnlinkLine() {
    setUnlinkError("");
    try {
      await unlink.mutateAsync({ path: "/me/liff-link", method: "DELETE", values: {} });
      await signOut();
    } catch (error) {
      setUnlinkError(error instanceof Error ? error.message : "解除 LINE 綁定失敗，請稍後再試。");
      setUnlinkConfirmOpen(false);
    }
  }

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(""), 3_200);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  const actionLabel = status?.nextEventKind === "clock_out" ? "下班" : "上班";
  const clockDisabled = demoLocationFailed || !status?.canClock || query.isPending || Boolean(query.error) || (status?.geolocationRequired === true && locationCheck.data?.withinRadius !== true) || locationCheck.isPending;
  const lastEvent = status?.events[0];
  return <Page className="hr-clock-page hr-clock-full-page">
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
        {(demoLocationFailed || status?.geolocationRequired) && (visibleLocationError || outsideOffice) ? <Button tone="info" size="lg" className="max-[760px]:w-full" variant="secondary" disabled={!status?.canClock || locating} onClick={() => { void verifyLocation(); }}>重新定位</Button> : null}
        {user?.hrSelfServiceKind === "worker" ? <Button variant="link" onClick={() => { void signOut().catch((error: unknown) => setUnlinkError(error instanceof Error ? error.message : "登出失敗，請稍後再試。")); }}>登出</Button> : null}
        {lineLiffAuthenticated ? <Button variant="link" disabled={unlink.isPending} onClick={() => setUnlinkConfirmOpen(true)}>解除 LINE 綁定</Button> : null}
      </div>
      {successMessage || status?.message || query.error || visibleLocationError || clock.error || unlinkError ? <div className="hr-clock-feedback-corner">
        {successMessage ? <Alert size="compact" tone="success">{successMessage}</Alert> : null}
        {unlinkError ? <Alert size="compact" tone="danger">{unlinkError}</Alert> : null}
        {status?.message ? <p className="hr-clock-blocked">{status.message}</p> : null}
        {query.error ? <Alert size="compact" tone="danger">{query.error.message}</Alert> : null}
        {visibleLocationError ? <Alert size="compact" tone="danger">{visibleLocationError}</Alert> : null}
        {clock.error ? <Alert size="compact" tone="danger">{clock.error.message}</Alert> : null}
      </div> : null}
    </section>
    {confirmOpen ? <Dialog title="確認打卡" role="alertdialog" portal={false} onClose={closeConfirm} closeRequestRef={confirmCloseRef} actions={<><Button variant="secondary" onClick={closeConfirm}>取消</Button><Button onClick={() => { (confirmCloseRef.current ?? closeConfirm)(); void confirmClock(); }}>確認{actionLabel}打卡</Button></>}>
      <p>確定要{actionLabel}打卡嗎？</p>
    </Dialog> : null}
    {unlinkConfirmOpen ? <Dialog title="解除 LINE 打卡綁定？" role="alertdialog" portal={false} onClose={() => setUnlinkConfirmOpen(false)} actions={<><Button variant="secondary" onClick={() => setUnlinkConfirmOpen(false)}>取消</Button><Button variant="danger" disabled={unlink.isPending} onClick={() => void confirmUnlinkLine()}>{unlink.isPending ? "解除中…" : "解除並登出"}</Button></>}>
      <p>解除後會撤銷 LINE 打卡登入。下次使用時需重新以公司帳號登入並綁定 LINE。</p>
    </Dialog> : null}
  </Page>;
}

export function HrClockCalendar() {
  usePageTitle("出勤日曆");
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(currentMonth);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [monthSlide, setMonthSlide] = useState<MonthSlide>("");
  const touchStartX = useRef<number | null>(null);
  const calendar = useHrQuery<ClockCalendar>(`/me/attendance-calendar?year=${calendarMonth.year}&month=${calendarMonth.month}`);
  const selectedDay = calendar.data?.days.find((day) => day.date === selectedDate) ?? null;

  useEffect(() => {
    if (!calendar.data) return;
    const currentMonthDay = calendar.data.days.find((day) => day.date === calendar.data?.today);
    setSelectedDate((current) => current && calendar.data?.days.some((day) => day.date === current) ? current : currentMonthDay?.date ?? calendar.data?.days[0]?.date ?? null);
  }, [calendar.data]);

  function changeMonth(offset: number) {
    setMonthSlide(offset > 0 ? "next" : "prev");
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
    navigate(`/forms/leave?date=${encodeURIComponent(date)}`);
  }
  function closeSubpage() {
    setClosing(true);
    window.setTimeout(() => navigate("/clock"), 220);
  }
  return <Page className={`hr-clock-page hr-clock-subpage [&>*+*]:mt-0 ${closing ? "closing" : ""}`}>
    <button className="hr-clock-back-link" type="button" onClick={closeSubpage}><Icon name="chevronLeft" />返回打卡</button>
    <PageHeader title="出勤日曆" description="左右滑動切換月份，點擊日期查看打卡紀錄。" className="max-[760px]:mb-0 max-[760px]:[&_h1]:text-[18px] max-[760px]:[&_p]:hidden" />
    {calendar.error ? <Alert tone="danger">{calendar.error.message}</Alert> : null}
    <section data-panel="" className={`${PANEL_SURFACE} [&>:last-child]:mb-0 mx-auto grid min-h-0 w-full max-w-[760px] touch-pan-y grid-rows-[auto_auto_auto] content-start overflow-hidden max-[760px]:px-3 max-[760px]:py-2.5`} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className="flex items-center justify-between border-y border-y-soft-line py-2.5 max-[760px]:pt-1 max-[760px]:pb-2">
        <Button variant="icon" icon="chevronLeft" aria-label="上一個月" onClick={() => changeMonth(-1)} />
        <strong className="text-[16px]">{monthLabel(calendarMonth.year, calendarMonth.month)}</strong>
        <Button variant="icon" icon="chevronRight" aria-label="下一個月" onClick={() => changeMonth(1)} />
      </div>
      {calendar.isPending ? <p className="muted">載入日曆…</p> : calendar.data ? <>
        <CalendarGrid key={`${calendarMonth.year}-${calendarMonth.month}`} data={calendar.data} selectedDate={selectedDate} onSelect={setSelectedDate} slide={monthSlide} />
        {selectedDay ? <CalendarDayDetails day={selectedDay} onCorrection={openCorrection} onLeave={openLeave} /> : null}
      </> : null}
    </section>
  </Page>;
}

function ClockHistoryDay({ day }: { day: ClockCalendarDay }) {
  const dayLabel = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${day.date}T00:00:00Z`));
  return <article className={`grid gap-2 rounded-[14px] border p-[13px] max-[760px]:p-[11px] ${day.anomaly ? "border-brand/42 bg-brand-soft/42" : "border-line bg-paper"}`}>
    <div className="flex items-baseline justify-between gap-3"><div className="flex min-w-0 items-baseline gap-2"><strong className="text-[15px] tabular-nums">{dayLabel}</strong><span className="text-[12px] text-muted">{calendarStatusLabel(day.status)}</span></div><strong className="text-[15px] tabular-nums">{day.workedMinutes ? formatWorkedMinutes(day.workedMinutes) : "—"}</strong></div>
    {day.expectedStartAt || day.expectedEndAt ? <p className="text-[12px] text-muted">預期 {formatTaipeiTime(day.expectedStartAt)}～{formatTaipeiTime(day.expectedEndAt)}</p> : null}
    {day.events.length ? <ol className="grid gap-1.5">{day.events.map((event, index) => <li key={event.id} className="grid grid-cols-[46px_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-[9px] bg-canvas px-[9px] py-[7px]"><span className="row-[span_2] self-center text-[11px] text-muted">{eventLabel(index, day.events.length)}</span><strong className="text-[12px] tabular-nums">{formatTaipei(event.occurredAt)}</strong><small className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted">{event.locationName ?? "未指定辦公位置"}</small></li>)}</ol> : day.anomaly ? null : <p className="text-[12px] text-muted">{day.anomalyMessage ?? (day.status === "missing" ? "這天尚未有打卡紀錄。" : "沒有打卡事件。")}</p>}
    {day.anomaly ? <p className="text-[12px] font-bold text-brand-dark">{day.anomalyMessage ?? (day.status === "missing" ? "這天尚未有打卡紀錄。" : "請確認出勤紀錄。")}</p> : null}
  </article>;
}

export function HrClockLogs() {
  usePageTitle("打卡紀錄");
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(currentMonth);
  const calendar = useHrQuery<ClockCalendar>(`/me/attendance-calendar?year=${calendarMonth.year}&month=${calendarMonth.month}`);
  const days = calendar.data?.days.filter((day) => day.eventCount > 0 || day.anomaly || day.status === "missing") ?? [];
  const totalWorkedMinutes = calendar.data?.days.reduce((total, day) => total + day.workedMinutes, 0) ?? 0;
  const anomalyCount = calendar.data?.days.filter((day) => day.anomaly).length ?? 0;
  const recordedCount = calendar.data?.days.filter((day) => day.eventCount > 0).length ?? 0;
  const summaryReady = !calendar.isPending && Boolean(calendar.data);
  function closeSubpage() {
    setClosing(true);
    window.setTimeout(() => navigate("/clock"), 220);
  }
  function changeMonth(offset: number) {
    setCalendarMonth((current) => shiftMonth(current.year, current.month, offset));
  }
  return <Page className={`hr-clock-page hr-clock-subpage [&>*+*]:mt-0 ${closing ? "closing" : ""}`}>
    <button className="hr-clock-back-link" type="button" onClick={closeSubpage}><Icon name="chevronLeft" />返回打卡</button>
    <PageHeader title="打卡紀錄" description="按月份查看實際工時、預期班別與出勤異常。" className="max-[760px]:mb-0 max-[760px]:[&_h1]:text-[18px] max-[760px]:[&_p]:hidden" />
    {/* 沒有外框：手機上那一圈 padding 很貴。上半部是 auto 列、只有清單那一列吃剩下的高度，
        所以內容再少也不會被拉高。 */}
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
      {/* 月份與統計放在捲動區外面，而且載入中也照樣畫（數字先用「—」）：
          這樣換月份時上半部的高度不會跳，往下捲時它也一直留在上方。 */}
      <div className="grid gap-3">
        <PeriodToolbar label={monthLabel(calendarMonth.year, calendarMonth.month)} previous={{ label: "上個月", onClick: () => changeMonth(-1) }} next={{ label: "下個月", onClick: () => changeMonth(1) }} />
        <div className="grid grid-cols-3 gap-2 max-[760px]:gap-1.5">{[
          ["實際工時", formatWorkedMinutes(totalWorkedMinutes)],
          ["有打卡日", `${recordedCount} 天`],
          ["待確認", `${anomalyCount} 天`],
        ].map(([label, value]) => <div key={label} className="grid min-w-0 gap-1 rounded-[12px] border border-line bg-paper px-3 py-[11px] max-[760px]:px-2 max-[760px]:py-[9px]"><span className="text-[11px] font-bold text-muted">{label}</span><strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[15px] text-ink tabular-nums max-[760px]:text-[13px]">{summaryReady ? value : "—"}</strong></div>)}</div>
      </div>
      {/* 清單裡沒有任何可聚焦的東西，不給 tabIndex 的話 Safari 的鍵盤使用者捲不到下面。 */}
      {/* 焦點外框往內收：這一塊貼著 .hr-clock-subpage 的 overflow: hidden，往外畫會被裁掉。 */}
      <div className="min-h-0 overflow-y-auto overscroll-contain [&>*+*]:mt-2.5 focus-visible:rounded-[14px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-secondary" role="region" aria-label="每日打卡紀錄" tabIndex={0}>
        {calendar.error ? <Alert tone="danger">{calendar.error.message}</Alert> : null}
        {calendar.isPending ? <p className="muted">載入月度紀錄…</p> : calendar.data ? days.length ? <div className="grid gap-2.5">{days.map((day) => <ClockHistoryDay key={day.date} day={day} />)}</div> : <div className="hr-form-empty-state"><strong>本月沒有需要顯示的紀錄</strong><p className="muted">有打卡或出勤異常的日期會列在這裡。</p></div> : null}
      </div>
    </section>
  </Page>;
}
