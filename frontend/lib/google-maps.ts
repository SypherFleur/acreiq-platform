import type { EarthPoint } from "./earth-sites";

export type MapListener = { remove(): void };
export type MapPosition = { lat(): number; lng(): number };
export type MapViewport = { north: number; south: number; east: number; west: number };
export type MapBounds = { getNorthEast(): MapPosition; getSouthWest(): MapPosition };
export type GoogleGeocoderResult = {
  place_id: string;
  formatted_address: string;
  partial_match?: boolean;
  geometry: { location: MapPosition; location_type: string; viewport?: MapBounds };
};
export type GoogleGeocoder = {
  geocode(
    request: { address: string },
    callback: (results: GoogleGeocoderResult[] | null, status: string) => void,
  ): Promise<{ results: GoogleGeocoderResult[] }> | void;
};
export type GeocodingLibrary = { Geocoder: new () => GoogleGeocoder };
export type SatelliteMap = {
  addListener(name: string, callback: (event: { latLng?: MapPosition }) => void): MapListener;
  panTo(point: EarthPoint): void;
  fitBounds(viewport: MapViewport, padding?: number): void;
  getZoom(): number | undefined;
  setZoom(zoom: number): void;
  setMapTypeId(type: "satellite" | "hybrid"): void;
};
type MapOverlay = {
  onAdd(): void; draw(): void; onRemove(): void;
  setMap(map: SatelliteMap | null): void;
  getPanes(): { overlayMouseTarget: HTMLElement } | null;
  getProjection(): { fromLatLngToDivPixel(position: MapPosition): { x: number; y: number } | null };
};
export type GoogleMapsApi = {
  importLibrary(name: "geocoding"): Promise<GeocodingLibrary>;
  Map: new (element: HTMLElement, options: Record<string, unknown>) => SatelliteMap;
  LatLng: new (latitude: number, longitude: number) => MapPosition;
  OverlayView: (new () => MapOverlay) & { preventMapHitsAndGesturesFrom(element: HTMLElement): void };
  event: { clearInstanceListeners(instance: unknown): void; trigger(instance: unknown, event: string): void };
};
type MapsWindow = Window & {
  google?: { maps?: GoogleMapsApi };
  acreiqMapsReady?: () => void;
  gm_authFailure?: () => void;
};
export const MAPS_AUTH_EVENT = "acreiq:maps-authorization-failed";
export class MapsLoadError extends Error {}
let pending: Promise<GoogleMapsApi> | undefined;

export function loadGoogleMaps(apiKey: string): Promise<GoogleMapsApi> {
  if (!apiKey.trim()) return Promise.reject(new MapsLoadError("Maps browser key is not configured."));
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const host = window as MapsWindow;
    const script = document.createElement("script");
    const timeout = setTimeout(() => fail("Google Maps timed out. Check connectivity, then reload the page to retry."), 15000);
    function fail(message: string) { clearTimeout(timeout); reject(new MapsLoadError(message)); }
    host.gm_authFailure = () => {
      fail("Google Maps authorization failed. Check the separate browser key, allowed website, API restrictions and billing authorization.");
      window.dispatchEvent(new Event(MAPS_AUTH_EVENT));
    };
    host.acreiqMapsReady = () => {
      clearTimeout(timeout);
      const maps = host.google?.maps;
      if (!maps?.Map || !maps.OverlayView) return fail("Google Maps did not initialize. Reload the page to retry.");
      resolve(maps);
    };
    const parameters = new URLSearchParams({ key: apiKey, loading: "async", callback: "acreiqMapsReady", v: "quarterly" });
    script.src = `https://maps.googleapis.com/maps/api/js?${parameters}`;
    script.async = true;
    script.dataset.acreiqMaps = "true";
    script.onerror = () => fail("Google Maps could not load. Check connectivity or content blocking, then reload the page to retry.");
    document.head.append(script);
  });
  return pending;
}
