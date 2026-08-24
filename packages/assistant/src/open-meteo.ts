import { AssistantError, type AssistantToolDefinition } from "./types.js";

// Gemini function name 只使用英數與底線；分類資訊未來另存於 tool registry。
export const OPEN_METEO_TOOL_KEY = "weather_open_meteo";

interface GeocodingResult {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  admin1?: string;
}

interface WeatherResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
}

async function getJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new AssistantError(`Open-Meteo 回應 ${response.status}。`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError("目前無法取得天氣資料。", { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

function weatherDescription(code: number | undefined): string {
  if (code === 0) return "晴朗";
  if (code === 1 || code === 2) return "大致晴朗或局部多雲";
  if (code === 3) return "陰天";
  if ([45, 48].includes(code ?? -1)) return "有霧";
  if ([51, 53, 55, 56, 57].includes(code ?? -1)) return "細雨";
  if ([61, 63, 65, 66, 67].includes(code ?? -1)) return "下雨";
  if ([71, 73, 75, 77].includes(code ?? -1)) return "下雪";
  if ([80, 81, 82].includes(code ?? -1)) return "陣雨";
  if ([85, 86].includes(code ?? -1)) return "陣雪";
  if ([95, 96, 99].includes(code ?? -1)) return "雷雨";
  return "天氣狀況未知";
}

export const openMeteoTool: AssistantToolDefinition = {
  key: OPEN_METEO_TOOL_KEY,
  label: "Open-Meteo 天氣查詢",
  description: "使用免費 Open-Meteo API，依地點查詢目前天氣、體感溫度、濕度與風速。",
  defaultStatus: "enabled",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string", description: "城市或地區名稱，例如台北、台南、Tokyo。" },
    },
    required: ["location"],
  },
  async execute(input) {
    const location = typeof input === "object" && input !== null && "location" in input
      ? String((input as { location?: unknown }).location ?? "").trim()
      : "";
    if (!location) throw new AssistantError("天氣查詢缺少地點。", {});
    if (location.length > 80) throw new AssistantError("天氣查詢的地點太長。", {});

    const geocoding = await getJson<{ results?: GeocodingResult[] }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`,
    );
    const place = geocoding.results?.[0];
    if (place?.latitude === undefined || place.longitude === undefined) {
      return JSON.stringify({ found: false, message: `找不到「${location}」的地點。` });
    }

    const weather = await getJson<WeatherResponse>(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Asia%2FTaipei`,
    );
    const current = weather.current ?? {};
    return JSON.stringify({
      found: true,
      location: [place.country, place.admin1, place.name].filter(Boolean).join(" "),
      temperatureC: current.temperature_2m,
      apparentTemperatureC: current.apparent_temperature,
      humidityPercent: current.relative_humidity_2m,
      precipitationMm: current.precipitation,
      windSpeedKmh: current.wind_speed_10m,
      description: weatherDescription(current.weather_code),
    });
  },
};
