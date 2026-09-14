"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowLeft, CheckCheck, CircleHelp, Clock3, FlaskConical, LoaderCircle, MapPin, Play, Plus, Save, ShieldCheck, Star, Upload, X } from "lucide-react";
import type { SiteComparisonArtifact, SiteComparisonRequest, SiteGoal, SiteVerification } from "../lib/site-types";
import { benchmarkContext, reviewSiteInputs, sameSiteInputs, siteApi, siteInputs, siteTwinInputs } from "../lib/site-comparison";
import { appendSiteComparison, emptySiteComparisonStore, importSiteComparisonJson, markSiteComparisonImportant, MAX_SITE_COMPARISON_IMPORT_BYTES, readSiteComparisonStore, validateSiteComparisonArtifact, writeSiteComparisonStore, type SiteComparisonStore } from "../lib/site-comparison-storage";
import { buildSiteComparisonCsvZip, exportSiteComparisonJson } from "../lib/site-comparison-export";
import SiteComparisonTwin from "./SiteComparisonTwin";
import SiteScenarioEditor from "./SiteScenarioEditor";
import SiteComparisonResults, { SiteMetricValue } from "./SiteComparisonResults";
import { SiteNumber, SiteText } from "./SiteScenarioFields";
import { earthSiteCatalog, readEarthStore, setSiteLocation, writeEarthStore, type EarthPoint, type EarthSite } from "../lib/earth-sites";
import { activateSiteWorking, createCurrentSitePlan, createPlanningSite, siteDraftMissingFields, toSiteComparisonRequest, withSiteWorking as checkedSiteWorking, type SitePlanDraft } from "../lib/site-drafts";

export type SiteComparisonOpenRequest =
  | { requestId: number; action: "create"; name: string; point: EarthPoint }
  | { requestId: number; action: "working" | "createPlan" | "selectSite"; siteId: string }
  | { requestId: number; action?: "comparison" | "selectComparison"; siteId: string; comparisonId: string };

const goals: { value: SiteGoal["metric"]; label: string }[] = [
  { value: "output_kg", label: "Maximize conditional output" }, { value: "energy_kwh", label: "Minimize energy" },
  { value: "recurring_cash_usd", label: "Minimize recurring cash" }, { value: "horizon_cash_usd", label: "Minimize horizon cash" },
  { value: "horizon_cash_per_kg", label: "Minimize horizon cash per kg" },
];
function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })); const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function withSiteWorking(state: SiteComparisonStore, draft: SitePlanDraft): SiteComparisonStore {
  const result = checkedSiteWorking(state, draft);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function missingLabel(field: string, draft: SitePlanDraft) {
  const labels: Record<string, string> = { "operation.horizon_days": "Operating horizon (days)", "operation.cycle_days": "Cycle duration (days)", "operation.completed_cycles": "Complete cycles", "operation.turnover_days": "Turnover per cycle (days)", "operation.idle_days": "Idle time (days)", "operation.product_definition": "Marketable product definition" };
  if (labels[field]) return labels[field];
  const planField = /^scenarios\[(\d+)\]\.lighting\.(.+)$/.exec(field);
  if (planField) return `${draft.scenarios[Number(planField[1])]?.name ?? "Plan"}: ${{ hours_per_day: "Lighting schedule (h/day)", dim_fraction: "Light output fraction (0-1)", min_hours: "Minimum lighting schedule (h/day)", max_hours: "Maximum lighting schedule (h/day)" }[planField[2]] ?? planField[2]}`;
  if (field.startsWith("assets")) return "Add at least one asset and its load accounting.";
  if (field.startsWith("scenarios (")) return "Create an alternative from the current plan.";
  const loadField = /^scenarios\[(\d+)\]\.loads/.exec(field);
  if (loadField) return `${draft.scenarios[Number(loadField[1])]?.name ?? "Plan"}: assign each asset once, including a lighting component.`;
  return field;
}

export default function SiteScenarioComparison({ visible, onSites, openRequest, onOpened, onEarth }: {
  visible: boolean;
  onSites?: (sites: EarthSite[] | null) => void;
  openRequest?: SiteComparisonOpenRequest | null;
  onOpened?: (requestId: number, error: string | null) => void;
  onEarth?: () => void;
}) {
  const [state, setState] = useState<SiteComparisonStore>(emptySiteComparisonStore);
  const stateRef = useRef(state);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState("Checking browser storage");
  const [notice, setNotice] = useState<string | null>(null);
  const [verification, setVerification] = useState<Record<string, SiteVerification | { status: "offline"; message: string; checked_at: string }>>({});
  const [benchmark, setBenchmark] = useState<{ kg: number | null; note: string; acknowledged: boolean; siteId: string; scenarioId: string; context: ReturnType<typeof benchmarkContext> } | null>(null);
  const [newSiteName, setNewSiteName] = useState("");
  const rawRef = useRef<string | null>(null);
  const writable = useRef(true);
  const writeQueue = useRef(Promise.resolve());
  const writeRevision = useRef(0);
  const requestSerial = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openedRequest = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let result;
      try { result = await readSiteComparisonStore(localStorage); }
      catch { writable.current = false; if (!cancelled) { setStorageError("Browser storage is inaccessible; new comparisons are session-only."); setReady(true); } return; }
      if (cancelled) return;
      rawRef.current = result.raw;
      if (result.ok) { stateRef.current = result.value; setState(result.value); setSaveStatus("Saved in this browser"); }
      else { writable.current = false; setStorageError(result.message); setSaveStatus("Session-only changes"); }
      setReady(true);
    })();
    return () => { cancelled = true; controller.current?.abort(); };
  }, []);

  useEffect(() => { onSites?.(ready ? earthSiteCatalog(state, true) : null); }, [state, ready, onSites]);
  useEffect(() => {
    if (!ready || busy || !openRequest || openedRequest.current === openRequest.requestId) return;
    openedRequest.current = openRequest.requestId;
    void (async () => {
      setBenchmark(null);
      try {
        if (openRequest.action === "create") {
          const draft = createPlanningSite(openRequest.name);
          const saved = await commit(withSiteWorking(stateRef.current, draft));
          if (!saved) throw new Error("The new site is session-only because local saving failed. The location was not saved; export this session before leaving.");
          const earth = readEarthStore(localStorage);
          if (!earth.ok) throw new Error(`Site created; location not saved: ${earth.message}`);
          const stored = writeEarthStore(localStorage, setSiteLocation(earth.store, draft.site, openRequest.point, new Date().toISOString()), earth.raw);
          if (!stored.ok) throw new Error(`Site created; location not saved: ${stored.message}`);
          window.dispatchEvent(new Event("acreiq-earth-locations-changed"));
        } else if (openRequest.action === "selectSite") {
          if (!earthSiteCatalog(stateRef.current).some(site => site.id === openRequest.siteId)) throw new Error("That site is no longer available in this browser.");
          if (!await commit({ ...stateRef.current, selectedSiteId: openRequest.siteId })) throw new Error("Site selected for this session, but browser storage could not save the selection.");
        } else if (openRequest.action === "working" || openRequest.action === "createPlan") {
          let selected = activateSiteWorking(stateRef.current, openRequest.siteId);
          if (!selected.ok && openRequest.action === "createPlan") {
            const site = earthSiteCatalog(stateRef.current).find(site => site.id === openRequest.siteId);
            if (!site) throw new Error("That site is not available.");
            const draft = createPlanningSite(site.name);
            draft.site.id = site.id; draft.site.revision = site.revision; draft.operation.site_id = site.id;
            selected = { ok: true, value: withSiteWorking(stateRef.current, draft) };
          }
          if (!selected.ok) throw new Error(selected.message);
          let next = selected.value;
          if (openRequest.action === "createPlan" && next.working && !next.working.scenarios.length) next = withSiteWorking(next, createCurrentSitePlan(next.working));
          if (!await commit(next)) throw new Error("Plans opened for this session, but browser storage could not save the selection.");
        } else {
          if (!("comparisonId" in openRequest)) throw new Error("Select a saved comparison for this site.");
          const saved = stateRef.current.history.find(item => item.artifact.payload.id === openRequest.comparisonId);
          if (!saved || saved.artifact.payload.input_snapshot.site.id !== openRequest.siteId) throw new Error("That comparison is no longer available for this site. Select an existing saved comparison.");
          const retainScenario = stateRef.current.selectedComparisonId === saved.artifact.payload.id && saved.artifact.payload.evaluations.some(item => item.scenario_id === stateRef.current.selectedScenarioId);
          if (!await commit({ ...stateRef.current, selectedSiteId: openRequest.siteId, selectedComparisonId: saved.artifact.payload.id,
            selectedScenarioId: retainScenario ? stateRef.current.selectedScenarioId : saved.artifact.payload.baseline_scenario_id })) throw new Error("Comparison opened for this session, but browser storage could not save the selection. Original evidence is unchanged.");
        }
        onOpened?.(openRequest.requestId, null);
      } catch (cause) { onOpened?.(openRequest.requestId, cause instanceof Error ? cause.message : "Site handoff failed. Existing records were preserved."); }
    })();
  }, [ready, busy, openRequest, onOpened]);

  function commit(next: SiteComparisonStore) {
    stateRef.current = next; setState(next);
    const savingRevision = ++writeRevision.current;
    if (!writable.current) return Promise.resolve(false);
    setSaveStatus("Saving locally");
    const snapshot = structuredClone(next);
    const saving = writeQueue.current.then(async () => {
      if (!writable.current) return false;
      try {
        const result = await writeSiteComparisonStore(localStorage, snapshot, rawRef.current);
        if (!result.ok) {
          const inputError = result.code === "invalid_artifact";
          if (!inputError) writable.current = false;
          setStorageError(inputError ? `Draft not saved: ${result.message} Correct the input to resume saving.` : result.message);
          setSaveStatus(inputError ? "Draft needs correction" : "Session-only changes");
          return false;
        } else {
          rawRef.current = result.raw;
          if (savingRevision === writeRevision.current) { setStorageError(null); setSaveStatus("Saved in this browser"); }
          return true;
        }
      } catch { writable.current = false; setStorageError("Local saving failed. Existing saved data was preserved; export this session."); setSaveStatus("Session-only changes"); return false; }
    });
    writeQueue.current = saving.then(() => {});
    return saving;
  }

  const working = state.working;
  const inspected = state.history.find(item => item.artifact.payload.id === state.selectedComparisonId)?.artifact;
  const artifact = inspected ?? state.history.find(item => item.artifact.payload.input_snapshot.site.id === working?.site.id)?.artifact;
  const currentMatch = !!artifact && !!working && sameSiteInputs(siteInputs(working), artifact.payload.input_snapshot);
  const shownInputs = inspected?.payload.input_snapshot ?? (working ? siteInputs(working) : artifact?.payload.input_snapshot);
  const shownScenario = shownInputs?.scenarios.find(item => item.id === state.selectedScenarioId) ?? shownInputs?.scenarios[0];
  const selectedEvaluation = artifact?.payload.evaluations.find(item => item.scenario_id === shownScenario?.id) ?? artifact?.payload.evaluations[0];
  const twin = shownInputs && shownScenario ? siteTwinInputs(shownInputs, shownScenario) : null;
  const readonly = !!inspected;
  const inspectedWorking = inspected ? [working, ...(state.otherWorking ?? [])].find(draft => draft?.site.id === inspected.payload.input_snapshot.site.id) : null;
  const selectedCheck = artifact ? verification[artifact.payload.id] : undefined;
  const missingFields = working ? siteDraftMissingFields(working) : [];
  const location = (() => { try { const saved = readEarthStore(localStorage); return saved.ok ? saved.store.associations.find(item => item.siteId === shownInputs?.site.id) : null; } catch { return null; } })();

  function changeWorking(next: SitePlanDraft, selectedId?: string) {
    requestSerial.current++;
    setBenchmark(null);
    next = { ...next, review: null, prior_comparison_id: null };
    const selected = selectedId ?? stateRef.current.selectedScenarioId;
    try { commit({ ...withSiteWorking(stateRef.current, next), selectedComparisonId: null, selectedScenarioId: next.scenarios.some(item => item.id === selected) ? selected! : next.scenarios[0]?.id ?? null }); setError(null); setNotice(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Draft could not be updated. Existing saved work is unchanged."); }
  }
  function selectScenario(id: string) { if (id !== stateRef.current.selectedScenarioId) setBenchmark(null); commit({ ...stateRef.current, selectedScenarioId: id }); }
  function validEditor() {
    const invalid = Array.from(document.querySelectorAll<HTMLInputElement>(".site-editor input")).find(input => !input.checkValidity() || input.getAttribute("aria-invalid") === "true");
    if (!invalid) return true;
    invalid.focus(); invalid.reportValidity(); setError("Correct the highlighted input before review or comparison. No new calculation was started."); return false;
  }
  async function loadFixture() {
    setBusy("Loading fixture"); setError(null);
    try {
      const request = await siteApi<SiteComparisonRequest>("/fixture", undefined, AbortSignal.timeout(15000));
      requestSerial.current++; commit({ ...withSiteWorking(stateRef.current, request), selectedComparisonId: null, selectedScenarioId: request.scenarios[0].id });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The fixture could not be loaded."); }
    finally { setBusy(null); }
  }
  async function compare(request: SiteComparisonRequest) {
    if (controller.current || !validEditor()) return;
    setError(null); setNotice(null); setBusy("Comparing reviewed plans");
    const serial = requestSerial.current; const abort = new AbortController(); controller.current = abort;
    const timeout = setTimeout(() => abort.abort("timeout"), 25000);
    try {
      const returned = await siteApi<SiteComparisonArtifact>("", request, abort.signal);
      const validated = await validateSiteComparisonArtifact(returned);
      if (!validated.ok) throw new Error(`Returned comparison could not be validated: ${validated.message}`);
      const payload = validated.value.payload;
      if (!sameSiteInputs(payload.input_snapshot, siteInputs(request)) || payload.parent_id !== request.prior_comparison_id
        || payload.review_status !== (request.review ? "reviewed" : "unreviewed")
        || payload.evaluations.some(item => item.review_status !== payload.review_status)) {
        throw new Error("Returned comparison does not match the submitted inputs, review or parent run. No new evidence was saved; earlier results are unchanged. Retry the reviewed comparison.");
      }
      if (abort.signal.aborted) return;
      const appended = appendSiteComparison(stateRef.current, validated.value);
      if (!appended.ok) throw new Error(appended.message);
      if (serial !== requestSerial.current) {
        commit({ ...appended.value, selectedComparisonId: stateRef.current.selectedComparisonId, selectedScenarioId: stateRef.current.selectedScenarioId });
        setNotice("The inputs changed while this comparison ran. Its original evidence was saved as an earlier result; it is not the current comparison.");
      } else {
        commit({ ...appended.value, selectedScenarioId: stateRef.current.selectedScenarioId && validated.value.payload.evaluations.some(item => item.scenario_id === stateRef.current.selectedScenarioId) ? stateRef.current.selectedScenarioId : validated.value.payload.baseline_scenario_id });
        setNotice("Comparison completed. Exact inputs and evidence are retained; no operating plan was adopted automatically.");
      }
    } catch (caught) {
      setError(abort.signal.aborted ? abort.signal.reason === "timeout" ? "Comparison timed out. Existing evidence is unchanged. Retry to create a new comparison." : "Comparison cancelled. No successful result is claimed; earlier evidence is unchanged." : caught instanceof Error ? caught.message : "Comparison failed. Earlier evidence is preserved.");
    } finally { clearTimeout(timeout); if (controller.current === abort) controller.current = null; setBusy(null); }
  }
  async function changeGoal(metric: SiteGoal["metric"]) {
    const previous = stateRef.current.working; if (!previous) return;
    const next = { ...previous, goal: { ...previous.goal, metric, direction: metric === "output_kg" ? "maximize" as const : "minimize" as const, version: previous.goal.version + 1, secondary: [] }, prior_comparison_id: null };
    requestSerial.current++;
    if (currentMatch && artifact && previous.review) {
      const valid = toSiteComparisonRequest(next); if (!valid.ok) { setError(valid.message); return; }
      const reviewed = reviewSiteInputs({ ...valid.value, prior_comparison_id: artifact.payload.id });
      commit({ ...stateRef.current, working: reviewed });
      await compare(reviewed);
    } else { commit({ ...stateRef.current, working: { ...next, review: null }, selectedComparisonId: null }); setNotice("Goal updated. Review the edited inputs before comparing."); }
  }
  async function verify() {
    if (!artifact) return;
    setBusy("Checking saved identity");
    const id = artifact.payload.id;
    try { const checked = await siteApi<SiteVerification>("/verify", { comparison_id: id, sha256: artifact.sha256 }, AbortSignal.timeout(15000));
      if (checked.comparison_id !== id) throw new Error("Verification response did not match this comparison.");
      setVerification(previous => ({ ...previous, [id]: checked }));
    } catch (caught) { setVerification(previous => ({ ...previous, [id]: { status: "offline", checked_at: new Date().toISOString(), message: caught instanceof Error ? caught.message : "Local server verification failed. Local evidence remains readable." } })); }
    finally { setBusy(null); }
  }
  async function importFile(file: File | undefined) {
    if (!file || !ready) return;
    setError(null); setBusy("Checking imported evidence");
    try {
      if (file.size > MAX_SITE_COMPARISON_IMPORT_BYTES) throw new Error("Comparison JSON exceeds the 16 MiB safe import limit.");
      const validated = await importSiteComparisonJson(await file.text());
      if (!validated.ok) throw new Error(validated.message);
      const appended = appendSiteComparison(stateRef.current, validated.value);
      if (!appended.ok) throw new Error(appended.message);
      commit(appended.value); setNotice("Imported as read-only local evidence. Hash consistency is checked; server origin and measurement truth are not verified.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Import failed. Existing inputs and history are unchanged."); }
    finally { setBusy(null); if (fileInput.current) fileInput.current.value = ""; }
  }
  function saveBenchmark() {
    if (!benchmark?.acknowledged || benchmark.kg === null || !benchmark.note.trim() || !working || !shownScenario) return;
    if (benchmark.siteId !== working.site.id || benchmark.scenarioId !== shownScenario.id
      || JSON.stringify(benchmark.context) !== JSON.stringify(benchmarkContext(siteInputs(working), shownScenario))) {
      setBenchmark(null); setError("The plan or its conditions changed. Open a new benchmark assumption and review its current context before saving."); return;
    }
    const next = structuredClone(working); const plan = next.scenarios.find(item => item.id === shownScenario.id)!;
    const id = plan.benchmark?.id ?? `benchmark-${crypto.randomUUID()}`; const version = (plan.benchmark?.version ?? 0) + 1;
    plan.revision++;
    plan.benchmark = { id, version, scenario_id: plan.id, kg_per_cycle: benchmark.kg, context: benchmarkContext(siteInputs(next), plan), uncertainty: null,
      evidence: { id: `evidence-${crypto.randomUUID()}`, version: 1, source: next.site.evidence.source === "synthetic_fixture" ? "synthetic_fixture" : "user_assumption", entry_route: next.site.evidence.source === "synthetic_fixture" ? "sample" : "manual", note: benchmark.note.trim(), recorded_at: null, instrument: null, conditions: "Explicit conditional assumption for this exact scenario context; not a verified measurement or yield prediction.", uncertainty: null } };
    changeWorking(next); setBenchmark(null);
  }

  if (!visible) return null;
  return <section className="site-comparison" aria-label="Site scenario comparison">
    <div className="site-section-heading"><div><h2>Site scenario comparison</h2><p>Indoor leafy greens · one growing bay</p></div><div className="site-actions">
      <button className="secondary-button" disabled={!ready || !!busy} onClick={() => fileInput.current?.click()}><Upload size={15} />Import comparison JSON</button>
      {artifact && <><button className="secondary-button" onClick={() => download(exportSiteComparisonJson(artifact), `${artifact.payload.id}.json`, "application/json")}><ArrowDownToLine size={15} />Comparison JSON</button>
        <button className="secondary-button" onClick={() => download(buildSiteComparisonCsvZip(artifact), `${artifact.payload.id}-evidence.zip`, "application/zip")}><ArrowDownToLine size={15} />CSV evidence bundle</button></>}
    </div></div>
    {shownInputs && <div className="site-context-bar"><strong>{shownInputs.site.name}</strong><code>{shownInputs.site.id}</code>
      {location && <span><MapPin size={14} />{location.point.lat.toFixed(6)}, {location.point.lng.toFixed(6)} · user-selected reference</span>}
      {onEarth && <button className="secondary-button" onClick={onEarth}><MapPin size={15} />Return to Earth</button>}</div>}
    {ready && <p className="site-note">{saveStatus}. Up to 21 working sites in this browser; no automatic deletion. Browser storage is limited, can be cleared and is not a durable cloud archive. Export important comparison evidence.</p>}
    <details className="site-origin-recovery"><summary>Existing plans on another local origin?</summary><p>This browser origin is <code>{typeof window !== "undefined" ? window.location.origin : "this preview"}</code>. Port 3004 and port 3007 have separate storage. Open the earlier Phase 2 app at <a href="http://127.0.0.1:3004/" target="_blank" rel="noreferrer">127.0.0.1:3004</a>, select its saved comparison and export Comparison JSON. Import that file here. Imports preserve run/site IDs and remain read-only; current working inputs are not replaced.</p></details>
    <input className="hidden" ref={fileInput} type="file" accept=".json,application/json" aria-label="Import site comparison file" onChange={event => void importFile(event.target.files?.[0])} />
    {storageError && <div className="error-banner" role="alert"><CircleHelp size={17} /><span>{storageError}</span><button className="secondary-button" onClick={() => download(JSON.stringify({ schema_version: 3, ...stateRef.current }, null, 2), "acreiq-site-session.json", "application/json")}><Save size={15} />Export session</button></div>}
    {error && <div className="error-banner" role="alert"><CircleHelp size={17} /><span>{error}</span><button className="icon-button" title="Dismiss site error" aria-label="Dismiss site error" onClick={() => setError(null)}><X size={16} /></button></div>}
    {notice && <p className="site-notice" role="status">{notice}</p>}
    {!ready ? <p className="site-note"><LoaderCircle className="spin" size={15} /> Checking saved comparisons</p> : !shownInputs ? <div className="site-empty"><h3>Create a planning site</h3>
      <SiteText label="Planning site name" value={newSiteName} onChange={setNewSiteName} />
      <button className="primary-button" disabled={!newSiteName.trim() || !!busy} onClick={() => { try { commit(withSiteWorking(stateRef.current, createPlanningSite(newSiteName))); } catch (cause) { setError(cause instanceof Error ? cause.message : "Check the site name."); } }}><Plus size={16} />Create planning site</button>
      <p>Indoor leafy greens in one growing bay. Measurements and costs start unknown.</p>
      {onEarth && <button className="secondary-button" onClick={onEarth}><MapPin size={16} />Choose location in Earth</button>}
      <details open><summary>Synthetic demonstration</summary><button className="secondary-button" onClick={() => void loadFixture()} disabled={!!busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <FlaskConical size={16} />}Load A/B/C synthetic fixture</button></details></div> : <>
      <p className="site-provenance">{shownInputs.site.evidence.source === "synthetic_fixture" ? "Synthetic test fixture, not agronomic evidence. All original and sample-derived inputs remain synthetic." : "User-defined scenario assumptions. Review is not independent measurement verification."}</p>
      <p className="site-note">Operation scope: indoor leafy greens in one growing bay only. A farm location does not extend this model to outdoor acreage, parcels or ownership.</p>
      {!shownInputs.scenarios.length && working && <div className="site-first-plan"><h3>No operating plan yet</h3><p>Site saved. Measurements, resources and costs remain unknown.</p><button className="primary-button" onClick={() => changeWorking(createCurrentSitePlan(working))}><Plus size={16} />Create current plan</button></div>}
      <div className="site-review-bar">
        <label className="field site-goal"><span>Comparison goal</span><select aria-label="Comparison goal" value={(inspected && !currentMatch ? inspected.payload.input_snapshot.goal : working?.goal ?? shownInputs.goal).metric} disabled={!!busy || !working || (readonly && !currentMatch)} onChange={event => void changeGoal(event.target.value as SiteGoal["metric"])}>{goals.map(goal => <option key={goal.value} value={goal.value}>{goal.label}</option>)}</select></label>
        <div className="site-actions">{readonly ? <button className="secondary-button" disabled={!!busy} onClick={() => {
          if (inspectedWorking) commit({ ...withSiteWorking(stateRef.current, inspectedWorking), selectedComparisonId: null, selectedScenarioId: inspectedWorking.scenarios[0]?.id ?? null });
          else { requestSerial.current++; commit({ ...withSiteWorking(stateRef.current, { ...structuredClone(inspected.payload.input_snapshot), review: null, prior_comparison_id: null }), selectedComparisonId: null, selectedScenarioId: inspected.payload.baseline_scenario_id }); }
        }}><ArrowLeft size={15} />{inspectedWorking ? "Edit operating plans" : "Create draft from comparison"}</button>
          : <><label className="site-check"><input type="checkbox" aria-label="Site plan review" checked={!!working?.review} disabled={!!busy || missingFields.length > 0} onChange={event => {
            if (!working || !validEditor()) return;
            const valid = toSiteComparisonRequest(working);
            if (!valid.ok) { setError(valid.message); return; }
            setError(null); commit({ ...stateRef.current, working: event.target.checked ? reviewSiteInputs(valid.value) : { ...working, review: null } });
          }} />I reviewed the site, plans and conditional assumptions.</label>
          <button className="primary-button" disabled={!!busy || !working?.review || missingFields.length > 0} onClick={() => { if (working) { const valid = toSiteComparisonRequest(working); if (valid.ok) void compare({ ...valid.value, prior_comparison_id: null }); else setError(valid.message); } }}>{busy ? <LoaderCircle className="spin" size={16} /> : <CheckCheck size={16} />}Compare reviewed plans</button></>}
          {controller.current && <button className="secondary-button" onClick={() => controller.current?.abort("cancelled")}><X size={15} />Cancel comparison</button>}
        </div>
      </div>
      {!readonly && working && working.scenarios.length > 0 && missingFields.length > 0 && <details className="site-missing-draft" open={missingFields.length <= 4}><summary>Needed before comparison ({missingFields.length})</summary><p>Incomplete drafts are saved. Unknown values are not replaced with sample measurements.</p><ul>{missingFields.map((field, index) => <li key={`${field}-${index}`}>{missingLabel(field, working)}</li>)}</ul></details>}
      {readonly && <p className="site-readonly"><ShieldCheck size={15} /> Read-only comparison. Working inputs are unchanged.{!currentMatch && working ? " Earlier result: original inputs shown." : ""}</p>}
      {!readonly && artifact && !currentMatch && <p className="site-warning">Inputs changed. The saved result below uses its original inputs and is not a current comparison.</p>}
      <div className="site-workspace-grid">
        {twin && shownScenario && <SiteComparisonTwin {...twin} name={shownScenario.name} saved={readonly} />}
        {readonly && selectedEvaluation ? <aside className="site-snapshot-summary"><h3>{selectedEvaluation.snapshot.scenario.name}</h3><p>{selectedEvaluation.explanation}</p>
          <dl><div><dt>Requested lighting</dt><dd>{selectedEvaluation.requested_setting.hours} h/day</dd></div><div><dt>Conditional output</dt><dd><SiteMetricValue metric={selectedEvaluation.metrics.output_kg} /></dd></div><div><dt>New/setup cash</dt><dd><SiteMetricValue metric={selectedEvaluation.metrics.new_setup_cash_usd} cash /></dd></div><div><dt>Canopy</dt><dd>{selectedEvaluation.snapshot.site.canopy_sqft ?? "Unknown"} sq ft</dd></div><div><dt>Benchmark</dt><dd>{selectedEvaluation.applicability.status}</dd></div></dl>
          <p className="site-note">Equipment positions are schematic. Comparison does not change the accepted lighting workspace.</p></aside>
          : working && shownScenario && <div className="site-editor-scroll"><SiteScenarioEditor request={working} scenarioId={shownScenario.id} onChange={changeWorking} onSelect={selectScenario} disabled={!!busy} onBenchmark={() => setBenchmark({ kg: null, note: "", acknowledged: false, siteId: working.site.id, scenarioId: shownScenario.id, context: structuredClone(benchmarkContext(siteInputs(working), shownScenario)) })} /></div>}
      </div>
      {benchmark && !readonly && <section className="site-benchmark-edit" aria-label="Revised benchmark assumption"><h3>New conditional assumption for {shownScenario?.name}</h3><p>This creates a new benchmark version for the current conditions. It is not calculated yield and does not turn unknown conditions into measurements.</p><div className="site-fields"><SiteNumber label="Assumed marketable output per cycle" unit="kg/cycle" value={benchmark.kg} onChange={kg => setBenchmark({ ...benchmark, kg })} /><SiteText label="Assumption source and applicability note" value={benchmark.note} onChange={note => setBenchmark({ ...benchmark, note })} /></div><label className="site-check"><input type="checkbox" checked={benchmark.acknowledged} onChange={event => setBenchmark({ ...benchmark, acknowledged: event.target.checked })} />This is my explicit conditional assumption, not a measured or predicted yield.</label><div className="site-actions"><button className="primary-button" disabled={!benchmark.acknowledged || benchmark.kg === null || !benchmark.note.trim()} onClick={saveBenchmark}><Save size={15} />Save benchmark assumption</button><button className="secondary-button" onClick={() => setBenchmark(null)}><X size={15} />Cancel assumption</button></div></section>}
      {artifact && <><SiteComparisonResults artifact={artifact} selectedId={shownScenario?.id ?? artifact.payload.baseline_scenario_id} onSelect={id => { if (!readonly) commit({ ...stateRef.current, selectedComparisonId: artifact.payload.id, selectedScenarioId: id }); else selectScenario(id); }} earlier={!currentMatch} />
        <div className="site-verification"><button className="secondary-button" disabled={!!busy} onClick={() => void verify()}><ShieldCheck size={15} />Check local server copy</button><span>{selectedCheck ? `${selectedCheck.status} · ${new Date(selectedCheck.checked_at).toLocaleString()}: ${selectedCheck.message}` : "Server copy not checked. A local hash match is not server verification."}</span></div></>}
    </>}
    {state.history.length > 0 && <section className="site-history" aria-label="Saved site comparisons"><div className="site-section-heading"><h3>Saved site comparisons</h3><span>{state.history.length} · {saveStatus}</span></div>
      <p className="site-note">No automatic deletion. Browser storage has limited capacity and can be cleared; it is not a durable cloud archive. Export important comparisons.</p>
      {[...state.history].sort((a, b) => Number(b.important) - Number(a.important)).map(entry => <div className="history-entry" key={entry.artifact.payload.id} data-site-comparison-id={entry.artifact.payload.id}>
        <button className="history-row" disabled={!!busy} aria-pressed={state.selectedComparisonId === entry.artifact.payload.id} onClick={() => { setBenchmark(null); commit({ ...stateRef.current, selectedSiteId: entry.artifact.payload.input_snapshot.site.id, selectedComparisonId: entry.artifact.payload.id, selectedScenarioId: entry.artifact.payload.baseline_scenario_id }); }}><Clock3 size={16} /><div><strong>{entry.artifact.payload.input_snapshot.site.name}</strong><span>{new Date(entry.artifact.payload.created_at).toLocaleString()} · {goals.find(goal => goal.value === entry.artifact.payload.input_snapshot.goal.metric)?.label}</span><code>{entry.artifact.payload.id}</code></div><span>{entry.artifact.payload.scenario_count} plans</span></button>
        <button className={`icon-button ${entry.important ? "active" : ""}`} title={entry.important ? "Unmark important comparison" : "Mark important comparison"} aria-label={entry.important ? "Unmark important comparison" : "Mark important comparison"} onClick={() => commit(markSiteComparisonImportant(stateRef.current, entry.artifact.payload.id, !entry.important))}><Star size={17} /></button>
      </div>)}
    </section>}
  </section>;
}
