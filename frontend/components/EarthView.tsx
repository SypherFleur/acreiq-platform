"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Crosshair, Earth, Link2, LoaderCircle, MapPin, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { EARTH_STORAGE_KEY, emptyEarthStore, parseEarthCoordinates, readEarthStore, removeSiteLocation, setSiteLocation, writeEarthStore, type EarthPoint, type EarthSite } from "../lib/earth-sites";
import GoogleSatelliteMap from "./GoogleSatelliteMap";
import EarthAddressSearch from "./EarthAddressSearch";
import type { AddressMatch } from "../lib/earth-address";
import EarthComparisonSummary from "./EarthComparisonSummary";

export default function EarthView({ visible, sites, onOpenComparison, onSitePlans, opening, openError, onCreateSite, onOpenPlans, onSelectSite, onSelectComparison }: {
  visible: boolean; sites: EarthSite[] | null;
  onOpenComparison: (siteId: string, comparisonId: string) => void; onSitePlans: () => void;
  opening: boolean; openError: string | null;
  onCreateSite: (name: string, point: EarthPoint) => void;
  onOpenPlans: (siteId: string, createPlan: boolean) => void;
  onSelectSite: (siteId: string) => void;
  onSelectComparison: (siteId: string, comparisonId: string) => void;
}) {
  const [store, setStore] = useState(emptyEarthStore);
  const raw = useRef<string | null>(null);
  const writable = useRef(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [siteId, setSiteId] = useState("");
  const [comparisonId, setComparisonId] = useState("");
  const [newSiteName, setNewSiteName] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [point, setPoint] = useState<EarthPoint | null>(null);
  const [addressFocus, setAddressFocus] = useState<AddressMatch | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [coordinateError, setCoordinateError] = useState<string | null>(null);
  const [layer, setLayer] = useState<"satellite" | "hybrid">("satellite");
  const [configuration, setConfiguration] = useState<{ status: "checking" | "ready" | "failed"; apiKey: string | null }>({ status: "checking", apiKey: null });
  const [enabled, setEnabled] = useState(false);
  const [mapStatus, setMapStatus] = useState("Google imagery not loaded");
  const selectedSite = sites?.find(site => site.id === siteId) ?? sites?.find(site => site.selected) ?? sites?.[0];
  const association = store.associations.find(item => item.siteId === selectedSite?.id);
  const matchesAssociation = !!point && association?.point.lat === point.lat && association?.point.lng === point.lng;
  const comparison = selectedSite?.comparisons.find(item => item.id === comparisonId) ?? selectedSite?.comparisons[0];
  const pins = store.associations.flatMap(item => {
    const site = sites?.find(site => site.id === item.siteId);
    return site ? [{ id: site.id, point: item.point, label: `Location for ${site.name}` }] : [];
  });

  function readStorage() {
    try {
      const saved = readEarthStore(localStorage); raw.current = saved.raw; writable.current = saved.ok;
      if (saved.ok) { setStore(saved.store); setStorageError(null); }
      else setStorageError(saved.message);
    } catch { writable.current = false; setStorageError("Location storage is unavailable. Existing data has not been overwritten."); }
    setReady(true);
  }
  useEffect(() => {
    readStorage();
    const changed = (event: StorageEvent) => { if (event.key === EARTH_STORAGE_KEY || event.key === null) readStorage(); };
    window.addEventListener("storage", changed);
    window.addEventListener("acreiq-earth-locations-changed", readStorage);
    return () => { window.removeEventListener("storage", changed); window.removeEventListener("acreiq-earth-locations-changed", readStorage); };
  }, []);
  useEffect(() => {
    const active = sites?.find(site => site.selected);
    if (!active) return;
    setSiteId(active.id); setComparisonId(active.selectedComparisonId ?? "");
  }, [sites]);
  useEffect(() => {
    if (!visible || configuration.status !== "checking") return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 10000);
    void fetch("/api/earth/maps-config", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("apiKey" in data) || (data.apiKey !== null && typeof data.apiKey !== "string")) throw new Error();
      if (!controller.signal.aborted) setConfiguration({ status: "ready", apiKey: typeof data.apiKey === "string" ? data.apiKey.trim() || null : null });
    }).catch(() => { if (!disposed) setConfiguration({ status: "failed", apiKey: null }); })
      .finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [visible, configuration.status]);
  function selectPoint(next: EarthPoint) {
    try {
      const checked = parseEarthCoordinates(String(next.lat), String(next.lng));
      setAddressFocus(null); setSelectionRevision(value => value + 1);
      setPoint(checked); setLatitude(String(checked.lat)); setLongitude(String(checked.lng)); setCoordinateError(null); setNotice(null);
    } catch (cause) { setCoordinateError(cause instanceof Error ? cause.message : "Check the selected coordinates."); }
  }
  function coordinates(event: React.FormEvent) {
    event.preventDefault();
    try { selectPoint(parseEarthCoordinates(latitude, longitude)); }
    catch (cause) { setCoordinateError(cause instanceof Error ? cause.message : "Check latitude and longitude."); }
  }
  function persist(next: typeof store, message: string) {
    if (!writable.current) { setStorageError("Location changes could not be saved. Reload saved locations before retrying."); return; }
    try {
      const saved = writeEarthStore(localStorage, next, raw.current);
      if (!saved.ok) { writable.current = false; setStorageError(saved.message); return; }
      raw.current = saved.raw; setStore(next); setStorageError(null); setNotice(message);
    } catch { writable.current = false; setStorageError("Location saving failed. Previously saved pins and comparisons are unchanged."); }
  }
  function associate() {
    if (!selectedSite || !point) return;
    try {
      persist(setSiteLocation(store, selectedSite, point, new Date().toISOString()), `Location associated with ${selectedSite.name}. Scenario inputs and results are unchanged.`);
    } catch (cause) { setStorageError(cause instanceof Error ? cause.message : "Location could not be associated."); }
  }
  function selectSite(id: string) { setSiteId(id); setComparisonId(""); setNotice(null); setSelectionRevision(value => value + 1); onSelectSite(id); }
  function clearSelection() { setPoint(null); setLatitude(""); setLongitude(""); setAddressFocus(null); setSelectionRevision(value => value + 1); }
  return <section className="earth-view" aria-label="AcreIQ Earth" hidden={!visible}>
    <EarthAddressSearch apiKey={configuration.apiKey} visible={visible} selectionRevision={selectionRevision}
      onLoad={() => { setEnabled(true); setPoint(null); setLatitude(""); setLongitude(""); setAddressFocus(null); }} onClearFocus={() => setAddressFocus(null)}
      onLocate={match => { setAddressFocus(match); setPoint(null); setLatitude(""); setLongitude(""); setCoordinateError(null); setNotice(null); }} />
    <div className="earth-toolbar">
      <div className="segmented" role="group" aria-label="Google imagery layer">
        <button type="button" className={layer === "satellite" ? "selected" : ""} aria-pressed={layer === "satellite"} onClick={() => setLayer("satellite")}>Satellite</button>
        <button type="button" className={layer === "hybrid" ? "selected" : ""} aria-pressed={layer === "hybrid"} onClick={() => setLayer("hybrid")}>Hybrid</button>
      </div>
      <span className="earth-status" role="status">{enabled ? mapStatus : "Google imagery not loaded"}</span>
    </div>
    <div className="earth-layout">
      <div className="earth-map-surface">
        {enabled && configuration.apiKey ? <GoogleSatelliteMap apiKey={configuration.apiKey} visible={visible} layer={layer} point={point} focus={addressFocus} pins={pins}
          onPoint={selectPoint} onPin={id => { selectSite(id); const saved = store.associations.find(item => item.siteId === id); if (saved) selectPoint(saved.point); }} onStatus={setMapStatus} />
          : <div className="earth-map-message"><Earth size={36} />
            <h2>{configuration.status === "checking" ? "Checking Maps configuration" : configuration.status === "failed" ? "Maps configuration unavailable" : configuration.apiKey ? "Google satellite imagery" : "Satellite imagery not configured"}</h2>
            <p>{configuration.apiKey ? "Loading imagery sends map requests to Google. Provider usage may be billed." : "Coordinate entry and existing site comparisons remain available."}</p>
            {configuration.apiKey && <button className="primary-button" onClick={() => setEnabled(true)}><Earth size={16} />Load Google imagery</button>}
            {configuration.status === "failed" && <button className="secondary-button" onClick={() => setConfiguration({ status: "checking", apiKey: null })}><RefreshCw size={16} />Retry configuration</button>}
          </div>}
      </div>
      <aside className="earth-inspector" aria-label="Earth location and site">
        <div className="earth-location">
          <h3>Location pin</h3>
          {point ? <p className="earth-selected"><MapPin size={14} />{point.lat.toFixed(6)}, {point.lng.toFixed(6)}<span>{matchesAssociation ? "Matches this site's associated location" : "Selected, not yet an associated site location"}</span></p>
            : <p className="earth-address-feedback">{addressFocus ? "Address area located. Site pin not selected." : "No site pin selected."}</p>}
          {point && <button type="button" className="icon-button" aria-label="Clear selected location" title="Clear selected location" onClick={clearSelection}><X size={16} /></button>}
          <details className="earth-precise"><summary>Precise coordinates <small>(optional)</small></summary>
          <form onSubmit={coordinates} className="earth-coordinates">
          <label className="field"><span>Latitude <small>degrees</small></span><input aria-label="Latitude" inputMode="text" value={latitude} placeholder="-90 to 90" onChange={event => { setLatitude(event.target.value); setPoint(null); setAddressFocus(null); setSelectionRevision(value => value + 1); }} /></label>
          <label className="field"><span>Longitude <small>degrees</small></span><input aria-label="Longitude" inputMode="text" value={longitude} placeholder="-180 to 180" onChange={event => { setLongitude(event.target.value); setPoint(null); setAddressFocus(null); setSelectionRevision(value => value + 1); }} /></label>
          <div className="earth-actions"><button type="submit" className="secondary-button"><Crosshair size={16} />Select coordinates</button>
          </div>
          {coordinateError && <p role="alert" className="earth-error">{coordinateError}</p>}
          </form>
          </details>
        </div>
        <div className="earth-site-links">
          <h3>AcreIQ site</h3>
          {sites === null ? <p><LoaderCircle size={15} className="spin" /> Checking existing sites</p> : <>
            <form className="earth-create-site" onSubmit={event => { event.preventDefault(); if (!opening && ready && writable.current && point && newSiteName.trim()) onCreateSite(newSiteName.trim(), point); }}>
              <label className="field"><span>Planning site name</span><input aria-label="Planning site name" value={newSiteName} maxLength={160} placeholder="Farm growing bay" onChange={event => setNewSiteName(event.target.value)} /></label>
              <button type="submit" className="primary-button" disabled={!point || !newSiteName.trim() || opening || !ready || !writable.current}><Plus size={15} />Create planning site here</button>
              {!point && <p>Select a site pin on the map or enter precise coordinates.</p>}
              <p>A named planning record, not a parcel boundary or ownership claim. Measurements start unknown.</p>
            </form>
          {!sites.length ? <p>No existing site records on this browser origin. A new planning site does not require a simulation.</p> : <>
            <label className="field"><span>Connect an existing site</span><select aria-label="Existing AcreIQ site" value={selectedSite?.id ?? ""} disabled={opening} onChange={event => selectSite(event.target.value)}>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            <code className="earth-site-id">{selectedSite?.id}</code>
            {selectedSite?.source === "synthetic_fixture" && <p className="earth-warning">Synthetic site. A location pin does not make its inputs real.</p>}
            <button className="primary-button" disabled={!point || !ready || !writable.current || matchesAssociation || opening} onClick={associate}><Link2 size={15} />{association ? "Replace site location" : "Associate selected location"}</button>
            {association && <div className="earth-associated"><strong><Check size={14} />Associated location</strong><span>{association.point.lat.toFixed(6)}, {association.point.lng.toFixed(6)}</span><small>User selected · pin v{association.version} · site revision {association.siteRevision}</small>
              <div className="earth-actions"><button className="secondary-button" onClick={() => selectPoint(association.point)}><Crosshair size={15} />Go to saved pin</button><button className="icon-button" title="Remove site location" aria-label="Remove site location" onClick={() => persist(removeSiteLocation(store, association.siteId), "Site location removed. Comparisons are unchanged.")}><Trash2 size={16} /></button></div></div>}
            <p>Supported operation: indoor leafy greens in one growing bay. Outdoor acreage is not modeled.</p>
            <button className="secondary-button" disabled={opening} onClick={() => onOpenPlans(selectedSite!.id, !selectedSite?.planCount)}><Plus size={15} />{selectedSite?.planCount ? "Compare plans" : "Create current plan"}</button>
            {comparison ? <><label className="field"><span>Saved comparison</span><select aria-label="Site comparison" value={comparison.id} disabled={opening} onChange={event => { setComparisonId(event.target.value); onSelectComparison(selectedSite!.id, event.target.value); }}>{selectedSite!.comparisons.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.goalMetric.replaceAll("_", " ")} · {item.id.slice(0, 8)}</option>)}</select></label>
              <button className="secondary-button" disabled={opening} onClick={() => onOpenComparison(selectedSite!.id, comparison.id)}>{opening ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}Open site comparison</button></>
              : <p>No saved comparison for this site yet. Its incomplete plans can be saved before evaluation.</p>}
            {visible && comparison?.artifact && <EarthComparisonSummary artifact={comparison.artifact} scenarioId={selectedSite?.selectedComparisonId === comparison.id ? selectedSite.selectedScenarioId : null} />}
          </>}
            <details className="earth-origin-recovery"><summary>Recover existing plans</summary><p>Ports 3004 and 3007 have separate browser storage. In the earlier Phase 2 app at <a href="http://127.0.0.1:3004/" target="_blank" rel="noreferrer">127.0.0.1:3004</a>, export a saved Comparison JSON. Import it here to retain its original site ID and evidence without replacing current plans.</p><button className="secondary-button" onClick={onSitePlans}><Upload size={15} />Import existing comparison</button></details>
          </>}
        </div>
      </aside>
    </div>
    {(storageError || openError) && <div className="error-banner" role="alert"><span>{storageError || openError}</span>{storageError && <button className="secondary-button" onClick={readStorage}><RefreshCw size={15} />Reload saved locations</button>}</div>}
    {notice && <p className="earth-notice" role="status">{notice}</p>}
    <p className="earth-boundary">Location reference only. Imagery and pins are not parcel boundaries, measurements or evidence of operational feasibility. Map location never changes scenario calculations.</p>
    <details className="earth-configuration"><summary>Maps access and location privacy</summary><p>Use a separate website/API-restricted Maps JavaScript API browser key in <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code>. Address search also requires Geocoding API access. Never use a Gemini key. API enablement and billing changes require the account owner&apos;s approval.</p><p>Google receives map requests after imagery loading or address search is requested. Search results stay in memory and do not enter saved comparisons. Only separately selected site pins stay in this browser&apos;s limited, clearable storage. Google attribution and links remain on the map.</p></details>
  </section>;
}
