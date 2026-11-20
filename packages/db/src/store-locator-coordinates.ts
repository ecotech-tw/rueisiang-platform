export const STORE_LOCATOR_PIN_BOUNDS = {
  x: { min: 475, max: 880 },
  y: { min: 245, max: 960 },
} as const;

const GEO_BOUNDS = { lonMin: 120, lonMax: 122.1, latMin: 21.9, latMax: 25.3 };

// 與 block 的 22 個縣市 path 相符的原圖校準資料；viewBox 是裁切範圍，不是經緯度範圍。
// https://simplemaps.com/static/svg/country/tw/admin1/mapinfo.js
const CALIBRATION_POINTS = [
  { x: 182.2, y: 909.8, latitude: 22.12348, longitude: 118.465843 },
  { x: 535.3, y: 549.3, latitude: 23.874448, longitude: 120.328758 },
  { x: 817.8, y: 91.7, latitude: 26.063159, longitude: 121.81909 },
] as const;

function mercatorY(latitude: number): number {
  return Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360));
}

function fitAxis(points: readonly { value: number; coordinate: number }[]) {
  const meanValue = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const meanCoordinate = points.reduce((sum, point) => sum + point.coordinate, 0) / points.length;
  const scale = points.reduce((sum, point) => sum + (point.value - meanValue) * (point.coordinate - meanCoordinate), 0)
    / points.reduce((sum, point) => sum + (point.value - meanValue) ** 2, 0);
  return { scale, offset: meanCoordinate - scale * meanValue };
}

const X_AXIS = fitAxis(CALIBRATION_POINTS.map((point) => ({ value: point.longitude, coordinate: point.x })));
const Y_AXIS = fitAxis(CALIBRATION_POINTS.map((point) => ({ value: mercatorY(point.latitude), coordinate: point.y })));

export function projectStoreLocatorPin(longitude: number, latitude: number): { x: number; y: number } | null {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude < GEO_BOUNDS.lonMin || longitude > GEO_BOUNDS.lonMax
    || latitude < GEO_BOUNDS.latMin || latitude > GEO_BOUNDS.latMax) return null;
  const x = X_AXIS.scale * longitude + X_AXIS.offset;
  const y = Y_AXIS.scale * mercatorY(latitude) + Y_AXIS.offset;
  if (x < STORE_LOCATOR_PIN_BOUNDS.x.min || x > STORE_LOCATOR_PIN_BOUNDS.x.max
    || y < STORE_LOCATOR_PIN_BOUNDS.y.min || y > STORE_LOCATOR_PIN_BOUNDS.y.max) return null;
  return { x, y };
}
