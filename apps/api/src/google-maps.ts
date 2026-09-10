export class GoogleMapsSearchError extends Error {}

export interface GoogleMapPlace {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface GooglePlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
}

/**
 * Places API 只在後端呼叫，避免把可計費的金鑰放進 Portal bundle；前端只收到選點所需的最小資料。
 */
export async function searchGooglePlaces(query: string, apiKey: string): Promise<GoogleMapPlace[]> {
  let response: Response;
  try {
    response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: query, pageSize: 5, languageCode: "zh-TW", regionCode: "TW" }),
    });
  } catch {
    throw new GoogleMapsSearchError("Google Maps 搜尋服務目前無法連線，請稍後再試。");
  }

  if (!response.ok) throw new GoogleMapsSearchError("Google Maps 搜尋服務目前無法使用，請稍後再試。");
  const result = await response.json() as GooglePlacesResponse;
  return (result.places ?? []).flatMap((place, index) => {
    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;
    if (!place.id || !place.displayName?.text || !place.formattedAddress || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      id: place.id || `place-${index}`,
      name: place.displayName.text,
      address: place.formattedAddress,
      latitude: latitude as number,
      longitude: longitude as number,
    }];
  });
}
