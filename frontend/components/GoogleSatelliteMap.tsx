"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapPin } from "lucide-react";
import { loadGoogleMaps, MAPS_AUTH_EVENT, MapsLoadError, type GoogleMapsApi, type SatelliteMap } from "../lib/google-maps";
import type { EarthPoint } from "../lib/earth-sites";
import type { AddressMatch } from "../lib/earth-address";

type Pin = { id: string; point: EarthPoint; label: string };
function LocationPin({ api, map, pin, selected, onSelect }: { api: GoogleMapsApi; map: SatelliteMap; pin: Pin; selected: boolean; onSelect: () => void }) {
  const [element] = useState(() => document.createElement("div"));
  useEffect(() => {
    const overlay = new api.OverlayView();
    element.className = "earth-pin-anchor";
    overlay.onAdd = () => { overlay.getPanes()?.overlayMouseTarget.append(element); api.OverlayView.preventMapHitsAndGesturesFrom(element); };
    overlay.draw = () => {
      const pixel = overlay.getProjection().fromLatLngToDivPixel(new api.LatLng(pin.point.lat, pin.point.lng));
      if (pixel) { element.style.left = `${pixel.x}px`; element.style.top = `${pixel.y}px`; }
    };
    overlay.onRemove = () => element.remove();
    overlay.setMap(map);
    return () => overlay.setMap(null);
  }, [api, map, element, pin.point.lat, pin.point.lng]);
  return createPortal(<button type="button" className={`earth-pin ${selected ? "selected" : ""}`} title={pin.label} aria-label={pin.label} onClick={onSelect}><MapPin size={30} fill="currentColor" stroke="var(--background)" /></button>, element);
}

export default function GoogleSatelliteMap({ apiKey, visible, layer, point, focus, pins, onPoint, onPin, onStatus }: {
  apiKey: string; visible: boolean; layer: "satellite" | "hybrid"; point: EarthPoint | null; pins: Pin[];
  focus?: AddressMatch | null;
  onPoint: (point: EarthPoint) => void; onPin: (id: string) => void; onStatus: (status: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPoint, onPin, onStatus });
  callbacks.current = { onPoint, onPin, onStatus };
  const [runtime, setRuntime] = useState<{ api: GoogleMapsApi; map: SatelliteMap } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const initial = useRef({ point, layer });
  useEffect(() => {
    let disposed = false;
    let failed = false;
    let api: GoogleMapsApi | undefined;
    let map: SatelliteMap | undefined;
    const authFailure = () => { if (!disposed) { failed = true; setError("Google Maps authorization failed. Check the dedicated browser key, website/API restrictions and authorized billing. Coordinates and site links remain available."); callbacks.current.onStatus("Maps authorization failed"); } };
    window.addEventListener(MAPS_AUTH_EVENT, authFailure);
    callbacks.current.onStatus("Loading Google imagery");
    void loadGoogleMaps(apiKey).then(loaded => {
      if (disposed || failed || !container.current) return;
      api = loaded;
      map = new api.Map(container.current, {
        center: initial.current.point ?? { lat: 20, lng: 0 }, zoom: initial.current.point ? 17 : 2,
        mapTypeId: initial.current.layer, mapTypeControl: false, streetViewControl: false,
        fullscreenControl: false, rotateControl: false, cameraControl: false, zoomControl: true,
        scaleControl: true, clickableIcons: false, gestureHandling: "cooperative", tilt: 0, heading: 0,
        minZoom: 2, maxZoom: 22, keyboardShortcuts: true,
      });
      map.addListener("click", event => {
        if (event.latLng) callbacks.current.onPoint({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      });
      map.addListener("tilesloaded", () => { if (!disposed && !failed) callbacks.current.onStatus("Google imagery loaded"); });
      setRuntime({ api, map });
    }).catch(cause => {
      if (!disposed && !failed) { failed = true; setError(cause instanceof MapsLoadError ? cause.message : "Google Maps could not initialize. Coordinates and site links remain available. Reload to retry."); callbacks.current.onStatus("Google imagery unavailable"); }
    });
    return () => {
      disposed = true; window.removeEventListener(MAPS_AUTH_EVENT, authFailure);
      if (api && map) api.event.clearInstanceListeners(map);
    };
  }, [apiKey]);
  useEffect(() => { runtime?.map.setMapTypeId(layer); }, [runtime, layer]);
  useEffect(() => {
    if (!runtime || !point) return;
    runtime.map.panTo(point);
    if ((runtime.map.getZoom() ?? 2) < 15) runtime.map.setZoom(17);
  }, [runtime, point]);
  useEffect(() => {
    if (!runtime || !focus) return;
    if (focus.viewport) runtime.map.fitBounds(focus.viewport, 32);
    else { runtime.map.panTo(focus.point); runtime.map.setZoom(focus.approximate ? 12 : 17); }
  }, [runtime, focus]);
  useEffect(() => { if (runtime && visible) runtime.api.event.trigger(runtime.map, "resize"); }, [runtime, visible]);
  return <>
    <div ref={container} className="earth-google-map" aria-label="Google satellite imagery" hidden={!!error} />
    {error && <div className="earth-map-message" role="alert"><h3>Imagery unavailable</h3><p>{error}</p><p>Reload the page to retry Google imagery.</p></div>}
    {runtime && !error && <>{pins.map(pin => <LocationPin key={pin.id} {...runtime} pin={pin} selected={false} onSelect={() => callbacks.current.onPin(pin.id)} />)}
      {point && <LocationPin {...runtime} pin={{ id: "selection", point, label: "Selected location pin" }} selected onSelect={() => callbacks.current.onPoint(point)} />}</>}
  </>;
}
