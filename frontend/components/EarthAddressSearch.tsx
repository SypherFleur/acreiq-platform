"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MapPin, Search, X } from "lucide-react";
import { AddressSearchError, geocodeAddress, MAX_ADDRESS_LENGTH, normalizeAddressQuery, type AddressMatch } from "../lib/earth-address";

export default function EarthAddressSearch({ apiKey, visible, selectionRevision, onLoad, onLocate, onClearFocus }: {
  apiKey: string | null; visible: boolean; selectionRevision: number;
  onLoad: () => void; onLocate: (match: AddressMatch) => void; onClearFocus: () => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [matches, setMatches] = useState<AddressMatch[]>([]);
  const [selected, setSelected] = useState<AddressMatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const request = useRef<AbortController | null>(null);

  function cancel() { request.current?.abort(); request.current = null; setPending(false); }
  useEffect(() => { if (!visible) cancel(); }, [visible]);
  useEffect(() => { cancel(); setMatches([]); setSelected(null); setEmpty(false); setError(null); }, [selectionRevision]);
  useEffect(() => () => request.current?.abort(), []);

  function choose(match: AddressMatch) { setMatches([]); setSelected(match); onLocate(match); }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey || request.current) return;
    let address: string;
    try { address = normalizeAddressQuery(query); }
    catch (cause) { setError(cause instanceof AddressSearchError ? cause.message : "Enter a street address, city or region."); return; }
    const controller = new AbortController(); request.current = controller;
    setPending(true); setMatches([]); setSelected(null); setError(null); setEmpty(false); onLoad();
    try {
      const found = await geocodeAddress(apiKey, address, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (found.length === 1) choose(found[0]);
      else { setMatches(found); setEmpty(found.length === 0); }
    } catch (cause) {
      if (request.current === controller && !controller.signal.aborted) setError(cause instanceof AddressSearchError ? cause.message : "Address search could not complete. Try again, or select a pin on the map.");
    } finally {
      if (request.current === controller) { request.current = null; setPending(false); }
    }
  }
  return <div className="earth-address-search">
    <form className="earth-address-form" onSubmit={submit} aria-label="Find an address">
      <label className="earth-address-input"><Search size={18} aria-hidden="true" />
        <input aria-label="Address" value={query} placeholder="Street address, city or region" maxLength={MAX_ADDRESS_LENGTH} autoComplete="off"
          onChange={event => { cancel(); setQuery(event.target.value); setMatches([]); setSelected(null); setEmpty(false); setError(null); onClearFocus(); }} />
      </label>
      {query && <button type="button" className="icon-button" title={pending ? "Cancel address search" : "Clear address search"} aria-label={pending ? "Cancel address search" : "Clear address search"}
        onClick={() => { cancel(); setQuery(""); setMatches([]); setSelected(null); setEmpty(false); setError(null); onClearFocus(); }}><X size={16} /></button>}
      <button type="submit" className="secondary-button" disabled={!apiKey || pending} title={!apiKey ? "Maps configuration is required for address search" : undefined}>
        {pending ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}{pending ? "Searching" : "Find address"}
      </button>
    </form>
    <p className="earth-search-privacy">Address searches go to Google. Provider usage may be billed.</p>
    {pending && <p className="earth-address-feedback" role="status">Searching Google Maps</p>}
    {error && <p className="earth-error" role="alert">{error}</p>}
    {empty && <p className="earth-address-feedback" role="status">No address matches. Try a fuller address, city or postal code.</p>}
    {matches.length > 0 && <div className="earth-address-results" aria-label="Address matches">
      <p>Address matches</p>
      {matches.map(match => <button className="earth-address-result" key={match.id} type="button" onClick={() => choose(match)}>
        <MapPin size={17} /><span>{match.label}<small>{match.partial ? "Partial match" : match.approximate ? "Approximate area" : "Address match"}</small></span>
      </button>)}
    </div>}
    {selected && <p className="earth-address-feedback" role="status"><MapPin size={15} /><span>{selected.label}{(selected.partial || selected.approximate) && <small>{selected.partial ? "Partial address match" : "Approximate area"}</small>}</span></p>}
    {(matches.length > 0 || selected) && <p className="earth-address-attribution" translate="no">Google Maps</p>}
  </div>;
}
