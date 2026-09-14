import type { SiteComparisonStore } from "./site-comparison-storage";
import type { SiteComparisonArtifact } from "./site-types";

export type EarthPoint = { lat: number; lng: number };
export type EarthSite = {
  id: string;
  name: string;
  revision: number;
  source: string;
  hasWorkingSite?: boolean;
  planCount?: number;
  selected?: boolean;
  selectedComparisonId?: string | null;
  selectedScenarioId?: string | null;
  comparisons: { id: string; createdAt: string; goalMetric: string; siteRevision: number; artifact?: SiteComparisonArtifact }[];
};

/** Catalog metadata only; locations never change site identity or measured evidence. */
export function earthSiteCatalog(store: SiteComparisonStore, includeEvidence = false): EarthSite[] {
  const sites = new Map<string, EarthSite>();
  for (const draft of [store.working, ...(store.otherWorking ?? [])]) {
    if (!draft) continue;
    const site = draft.site;
    sites.set(site.id, { id: site.id, name: site.name, revision: site.revision, source: site.evidence.source, comparisons: [],
      ...(includeEvidence ? { hasWorkingSite: true, planCount: draft.scenarios.length } : {}) });
  }
  const history = [...store.history].sort((a, b) => Date.parse(b.artifact.payload.created_at) - Date.parse(a.artifact.payload.created_at));
  for (const { artifact } of history) {
    const payload = artifact.payload;
    const site = payload.input_snapshot.site;
    let entry = sites.get(site.id);
    if (!entry) {
      entry = { id: site.id, name: site.name, revision: site.revision, source: site.evidence.source, comparisons: [] };
      sites.set(site.id, entry);
    }
    if (!entry.comparisons.some(comparison => comparison.id === payload.id)) {
      entry.comparisons.push({ id: payload.id, createdAt: payload.created_at, goalMetric: payload.input_snapshot.goal.metric, siteRevision: site.revision,
        ...(includeEvidence ? { artifact: structuredClone(artifact) } : {}) });
    }
  }
  if (includeEvidence) {
    const selectedArtifact = store.history.find(item => item.artifact.payload.id === store.selectedComparisonId)?.artifact;
    const activeId = store.selectedSiteId ?? selectedArtifact?.payload.input_snapshot.site.id ?? store.working?.site.id;
    for (const entry of sites.values()) {
      entry.selected = entry.id === activeId;
      entry.selectedComparisonId = entry.comparisons.some(item => item.id === store.selectedComparisonId) ? store.selectedComparisonId : null;
      entry.selectedScenarioId = entry.selectedComparisonId ? store.selectedScenarioId : null;
    }
  }
  return [...sites.values()];
}

function coordinate(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  if (value < -maximum || value > maximum) throw new Error(`${label} must be between -${maximum} and ${maximum}.`);
  return value;
}

export function parseEarthCoordinates(latitude: string, longitude: string): EarthPoint {
  const parse = (value: string, label: string, maximum: number) => {
    if (!value.trim()) throw new Error(`${label} is required.`);
    return coordinate(Number(value), label, maximum);
  };
  return { lat: parse(latitude, "Latitude", 90), lng: parse(longitude, "Longitude", 180) };
}

export const EARTH_STORAGE_KEY = "acreiq.earth-locations.v1";
export type EarthAssociation = {
  siteId: string;
  siteRevision: number;
  point: EarthPoint;
  updatedAt: string;
  source: "user_selected";
  version: number;
};
export type EarthStore = { version: 1; associations: EarthAssociation[] };
export const emptyEarthStore = (): EarthStore => ({ version: 1, associations: [] });

type EarthStorage = Pick<Storage, "getItem" | "setItem">;
type EarthReadResult = { ok: true; store: EarthStore; raw: string | null } | { ok: false; message: string; raw: string | null };
type EarthWriteResult = { ok: true; raw: string } | { ok: false; message: string };
const MAX_ASSOCIATIONS = 1000;
const MAX_RAW_BYTES = 256 * 1024;
const UTF8 = new TextEncoder();

function fields(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields.`);
  return value as Record<string, unknown>;
}

function siteId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(value)) throw new Error("Invalid site ID.");
  return value;
}

function positiveInteger(value: unknown, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

function pointValue(value: unknown): EarthPoint {
  const point = fields(value, ["lat", "lng"], "location point");
  return { lat: coordinate(point.lat, "Latitude", 90), lng: coordinate(point.lng, "Longitude", 180) };
}

function timestamp(value: unknown): string {
  const match = typeof value === "string" && value.length <= 60
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value) : null;
  if (!match) throw new Error("Updated time must be a valid ISO timestamp.");
  const [, year, month, day, hour, minute, second, offsetHour = "0", offsetMinute = "0"] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse alone normalizes impossible calendar dates such as February 30.
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(offsetHour) > 23 || Number(offsetMinute) > 59 || !Number.isFinite(Date.parse(value as string))) {
    throw new Error("Updated time must be a valid ISO timestamp.");
  }
  return value as string;
}

function checkRawSize(raw: string): void {
  if (raw.length > MAX_RAW_BYTES || UTF8.encode(raw).byteLength > MAX_RAW_BYTES) throw new Error("Earth locations exceed the 256 KiB limit.");
}

function validatedStore(value: unknown): EarthStore {
  const store = fields(value, ["version", "associations"], "Earth store");
  if (store.version !== 1) throw new Error("Unsupported Earth store version.");
  if (!Array.isArray(store.associations)) throw new Error("Invalid Earth associations.");
  if (store.associations.length > MAX_ASSOCIATIONS) throw new Error("Earth locations exceed the 1000 association limit.");
  const ids = new Set<string>();
  const associations: EarthAssociation[] = [];
  for (const value of store.associations) {
    const item = fields(value, ["siteId", "siteRevision", "point", "updatedAt", "source", "version"], "Earth association");
    const id = siteId(item.siteId);
    if (ids.has(id)) throw new Error("Duplicate site location.");
    ids.add(id);
    if (item.source !== "user_selected") throw new Error("Location source must be user_selected.");
    associations.push({ siteId: id, siteRevision: positiveInteger(item.siteRevision, 1000000, "site revision"),
      point: pointValue(item.point), updatedAt: timestamp(item.updatedAt), source: "user_selected",
      version: positiveInteger(item.version, Number.MAX_SAFE_INTEGER, "association version") });
  }
  const result: EarthStore = { version: 1, associations };
  checkRawSize(JSON.stringify(result));
  return result;
}

function decodeStore(raw: string | null): EarthStore {
  if (raw === null) return emptyEarthStore();
  checkRawSize(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Earth location storage contains invalid JSON."); }
  return validatedStore(parsed);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid Earth location data.";
}

export function readEarthStore(storage: EarthStorage): EarthReadResult {
  let raw: string | null;
  try { raw = storage.getItem(EARTH_STORAGE_KEY); } catch { return { ok: false, message: "Earth location storage is unavailable.", raw: null }; }
  try { return { ok: true, store: decodeStore(raw), raw }; } catch (error) { return { ok: false, message: message(error), raw }; }
}

export function writeEarthStore(storage: EarthStorage, next: EarthStore, expectedRaw: string | null): EarthWriteResult {
  let previous: string | null;
  try { previous = storage.getItem(EARTH_STORAGE_KEY); } catch { return { ok: false, message: "Earth location storage is unavailable." }; }
  const conflict = (): EarthWriteResult => ({ ok: false, message: "Earth locations changed in storage. Reload before saving." });
  if (previous !== expectedRaw) return conflict();
  let raw: string;
  try {
    decodeStore(previous);
    raw = JSON.stringify(validatedStore(next));
  } catch (error) { return { ok: false, message: message(error) }; }
  try {
    if (storage.getItem(EARTH_STORAGE_KEY) !== previous) return conflict();
    if (raw !== previous) storage.setItem(EARTH_STORAGE_KEY, raw);
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.name === "QuotaExceededError"
      ? "Earth location storage is full. Previous data was preserved."
      : "Earth locations could not be saved. Previous data was preserved." };
  }
}

/** Pass an existing catalog site; the association records user selection, not evidence. */
export function setSiteLocation(store: EarthStore, site: Pick<EarthSite, "id" | "revision">, point: EarthPoint, updatedAt: string): EarthStore {
  const next = validatedStore(store);
  const id = siteId(site?.id);
  const index = next.associations.findIndex(item => item.siteId === id);
  const association: EarthAssociation = { siteId: id, siteRevision: positiveInteger(site?.revision, 1000000, "site revision"),
    point: pointValue(point), updatedAt: timestamp(updatedAt), source: "user_selected",
    version: index === -1 ? 1 : positiveInteger(next.associations[index].version + 1, Number.MAX_SAFE_INTEGER, "association version") };
  if (index === -1) next.associations.push(association);
  else next.associations[index] = association;
  return validatedStore(next);
}

export function removeSiteLocation(store: EarthStore, id: string): EarthStore {
  siteId(id);
  const next = validatedStore(store);
  next.associations = next.associations.filter(item => item.siteId !== id);
  return next;
}
