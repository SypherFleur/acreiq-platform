import type { EarthPoint } from "./earth-sites";
import { loadGoogleMaps, type GoogleGeocoderResult, type GoogleMapsApi, type MapBounds, type MapPosition, type MapViewport } from "./google-maps";

/** A transient map focus suggestion, never a saved or measured site location. */
export type AddressMatch = {
  id: string;
  label: string;
  point: EarthPoint;
  viewport?: MapViewport;
  partial: boolean;
  approximate: boolean;
};

export const MAX_ADDRESS_LENGTH = 300;
export const ADDRESS_LOOKUP_TIMEOUT_MS = 15000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u;
const ERROR_MESSAGES = {
  INVALID_QUERY: `Enter an address of 1 to ${MAX_ADDRESS_LENGTH} characters without control characters.`,
  NOT_CONFIGURED: "Address search needs a Google Maps browser key.",
  ABORTED: "Address search was canceled.",
  TIMEOUT: "Address search timed out. Check your connection and submit again.",
  REQUEST_DENIED: "Address search was denied. Enable the Geocoding API and check the browser key's API permissions, allowed websites, and billing.",
  OVER_QUERY_LIMIT: "Address search has reached its Google request limit. Check the Geocoding API quota or try again later.",
  UNAVAILABLE: "Address search is unavailable. Check your connection and Google Maps configuration, then submit again.",
  INVALID_RESPONSE: "Address search returned no usable locations. Try a more specific address.",
} as const;

export type AddressSearchErrorCode = keyof typeof ERROR_MESSAGES;
export class AddressSearchError extends Error {
  constructor(readonly code: AddressSearchErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AddressSearchError";
  }
}

export function normalizeAddressQuery(address: string): string {
  if (typeof address !== "string" || address.length > MAX_ADDRESS_LENGTH || CONTROL_CHARACTERS.test(address)) {
    throw new AddressSearchError("INVALID_QUERY");
  }
  const query = address.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!query) throw new AddressSearchError("INVALID_QUERY");
  return query;
}

function readPoint(position: MapPosition | undefined): EarthPoint | undefined {
  try {
    const lat = position?.lat(), lng = position?.lng();
    if (typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90
      && typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180) return { lat, lng };
  } catch { /* A malformed SDK value must not expose provider details. */ }
}

function readViewport(bounds: MapBounds | undefined): MapViewport | undefined {
  try {
    const ne = readPoint(bounds?.getNorthEast()), sw = readPoint(bounds?.getSouthWest());
    // West may exceed east when the recommended viewport crosses the antimeridian.
    if (ne && sw && ne.lat >= sw.lat) return { north: ne.lat, south: sw.lat, east: ne.lng, west: sw.lng };
  } catch { /* A valid location remains useful without a malformed viewport. */ }
}

function normalizeMatches(results: GoogleGeocoderResult[] | null): AddressMatch[] {
  if (!Array.isArray(results)) throw new AddressSearchError("INVALID_RESPONSE");
  const matches: AddressMatch[] = [], seen = new Set<string>();
  for (const result of results) {
    const point = readPoint(result?.geometry?.location);
    const id = typeof result?.place_id === "string" ? result.place_id.trim() : "";
    const label = typeof result?.formatted_address === "string"
      ? result.formatted_address.normalize("NFC").trim().replace(/\s+/gu, " ") : "";
    if (!point || !id || id.length > 512 || CONTROL_CHARACTERS.test(id) || !label || label.length > 500
      || CONTROL_CHARACTERS.test(label) || seen.has(id)) continue;
    const viewport = readViewport(result.geometry.viewport);
    matches.push({ id, label, point, ...(viewport ? { viewport } : {}), partial: result.partial_match === true,
      approximate: result.geometry.location_type !== "ROOFTOP" });
    seen.add(id);
    if (matches.length === 6) break;
  }
  if (!matches.length) throw new AddressSearchError("INVALID_RESPONSE");
  return matches;
}

type MapsLoader = (apiKey: string) => Promise<Pick<GoogleMapsApi, "importLibrary">>;

/** Dependency injection keeps cancellation and provider failures testable without network access. */
export function createAddressLookup(loadMaps: MapsLoader, timeoutMs = ADDRESS_LOOKUP_TIMEOUT_MS) {
  return async (apiKey: string, address: string, signal: AbortSignal): Promise<AddressMatch[]> => {
    if (signal.aborted) throw new AddressSearchError("ABORTED");
    const query = normalizeAddressQuery(address);
    if (!apiKey.trim()) throw new AddressSearchError("NOT_CONFIGURED");

    return new Promise<AddressMatch[]>((resolve, reject) => {
      let settled = false;
      const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, ADDRESS_LOOKUP_TIMEOUT_MS)) : ADDRESS_LOOKUP_TIMEOUT_MS;
      const deadline = performance.now() + duration;
      const timer = setTimeout(() => fail("TIMEOUT"), duration);
      function finish(matches?: AddressMatch[], code?: AddressSearchErrorCode) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code) reject(new AddressSearchError(code));
        else resolve(matches!);
      }
      function fail(code: AddressSearchErrorCode) { finish(undefined, code); }
      function onAbort() { fail("ABORTED"); }
      function stopped(): boolean {
        if (settled) return true;
        if (signal.aborted) fail("ABORTED");
        else if (performance.now() >= deadline) fail("TIMEOUT");
        return settled;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      async function run() {
        try {
          if (stopped()) return;
          const maps = await loadMaps(apiKey);
          if (stopped()) return;
          const { Geocoder } = await maps.importLibrary("geocoding");
          if (stopped()) return;
          const geocoder = new Geocoder();
          if (stopped()) return;
          // One forward lookup per submit. The SDK cannot cancel an in-flight request.
          const response = geocoder.geocode({ address: query }, (results, status) => {
            if (stopped()) return;
            if (status === "ZERO_RESULTS") return finish([]);
            if (status === "REQUEST_DENIED" || status === "OVER_QUERY_LIMIT") return fail(status);
            if (status === "INVALID_REQUEST") return fail("INVALID_QUERY");
            if (status !== "OK") return fail("UNAVAILABLE");
            try { finish(normalizeMatches(results)); }
            catch { fail("INVALID_RESPONSE"); }
          });
          // Callback status is authoritative; also consume SDK promise rejections.
          void response?.catch(() => { if (!stopped()) fail("UNAVAILABLE"); });
        } catch {
          if (!stopped()) fail("UNAVAILABLE");
        }
      }
      void run();
    });
  };
}

export const geocodeAddress = createAddressLookup(loadGoogleMaps);
