"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Box,
  Camera,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Droplets,
  Earth,
  Expand,
  FlaskConical,
  Focus,
  Gauge,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Radio,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Sprout,
  Sun,
  Trash2,
  Upload,
  Wind,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  Scenario,
  TwinAsset,
  OptimizationResult,
  ScanResult,
} from "../lib/types";
import { SAMPLE_SCENARIO, SAMPLE_ASSETS, baselineMetrics } from "../lib/sample";
import LivePanel from "../components/LivePanel";
import ProposalReview from "../components/ProposalReview";
import ResultExplanation from "../components/ResultExplanation";
import { INPUT_RULES, type ActionReceipt, type ExplanationStatus, type LiveDraft, type ProposalAction, type RunReference } from "../lib/live/types";
import { activeWorkspace, actOnDesign, createDesign, designChanges, designContext, invalidateDesign, isEarlierRun, recordResult, stageDesign, updateActive, type DesignState, type SavedCalculation, type WorkspaceVersion } from "../lib/live/design";
import { appendRun, calculationFor, restoreDesign, selectedCalculationFor, validCalculation, type SavedRun as Run } from "../lib/run-history";
import { buildRunCsv } from "../lib/run-export";
import { candidateId, buildCandidateIdentityMetadata } from "../lib/candidate-identity";
import { exportInputRecords, inputOrigin, validInputRecords } from "../lib/input-records";
import MeasurementRecord from "../components/MeasurementRecord";
import "../components/site-comparison.css";
import "../components/earth.css";
import type { EarthSite } from "../lib/earth-sites";
import type { SiteComparisonOpenRequest } from "../components/SiteScenarioComparison";

const SiteScenarioComparison = dynamic(() => import("../components/SiteScenarioComparison"), { ssr: false });
const EarthView = dynamic(() => import("../components/EarthView"), { ssr: false });

const SpatialTwin = dynamic(() => import("../components/SpatialTwin"), {
  ssr: false,
  loading: () => (
    <div className="scene-loading">
      <LoaderCircle size={24} className="spin" />
      <span>Building resource twin</span>
    </div>
  ),
});
type View = "workspace" | "scenarios" | "impact" | "earth";
type Health = {
  status: string;
  vision_available?: boolean;
  vision_provider?: string;
};
// Zero/null values mark an incomplete real workspace, never sample measurements.
const EMPTY_SCENARIO: Scenario = {
  source: "manual",
  length_ft: 0,
  width_ft: 0,
  canopy_sqft: 0,
  light_count: 0,
  lighting_watts: 0,
  other_watts: 0,
  other_hours: 0,
  baseline_hours: 0,
  baseline_dim: 1, // Non-dimmable fixtures operate at full output.
  dimmable: false,
  ppfd_full: null,
  min_dli: null,
  min_hours: 0,
  max_hours: 0,
  power_limit_watts: 0,
  electricity_usd_kwh: 0,
  operating_days: 0,
  water_liters_day: null,
  confirmed: false,
};
const number = (value: number, digits = 0) =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });
const money = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
const assetIcons: Record<TwinAsset["type"], LucideIcon> = {
  light_fixture: Lightbulb,
  shelving_rack: Layers3,
  circulation_fan: Wind,
  plant: Sprout,
  container: Box,
  other: Box,
};
const assetNames: Record<TwinAsset["type"], string> = {
  light_fixture: "LED grow light",
  shelving_rack: "Growing rack",
  circulation_fan: "Circulation fan",
  plant: "Plant",
  container: "Container",
  other: "Equipment",
};

function IconButton({
  icon: Icon,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? "active" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={18} strokeWidth={1.65} />
    </button>
  );
}

function Field({
  label,
  value,
  unit,
  onChange,
  min = 0,
  max,
  step = 1,
  optional,
  changed = false,
}: {
  label: string;
  value: number | null;
  unit?: string;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  optional?: boolean;
  changed?: boolean;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  useEffect(() => setDraft(value === null ? "" : String(value)), [value]);
  const commit = () => {
    if (draft.trim() === "") {
      onChange(optional ? null : 0);
      return;
    }
    const parsed = Number(draft);
    if (
      draft.trim() !== "" &&
      Number.isFinite(parsed) &&
      parsed >= min &&
      (max === undefined || parsed <= max)
    ) {
      if (parsed !== value) onChange(parsed);
    } else setDraft(value === null ? "" : String(value));
  };
  return (
    <label className={`field${changed ? " is-changed" : ""}`}>
      <span>{label}</span>
      <div className="input-wrap">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          placeholder={optional ? "Unknown" : ""}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-label={label}
        />
        {unit && <span>{unit}</span>}
      </div>
    </label>
  );
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail
          .map(
            (item: { msg: string; loc?: string[] }) =>
              `${item.loc?.slice(1).join(" ") || "Input"}: ${item.msg}`,
          )
          .join(". ")
      : data.detail;
    throw new Error(
      typeof detail === "string"
        ? detail
        : "Something went wrong. Please try again.",
    );
  }
  return data as T;
}

function validSaved(
  data: unknown,
): data is {
  scenario: Scenario;
  assets: TwinAsset[];
  name: string;
  crop?: string | null;
  assumptions?: WorkspaceVersion["assumptions"];
  provenance?: WorkspaceVersion["provenance"];
  history?: Run[];
  saved_run?: SavedCalculation | null;
  inputRecords?: WorkspaceVersion["inputRecords"];
  accepted_result_id?: string | null;
  inspected_run_id?: string | null;
  working_revision?: number;
  accepted_revision?: number;
  view?: View;
  mode?: "current" | "optimized";
} {
  if (!data || typeof data !== "object") return false;
  const saved = data as { scenario?: Scenario; assets?: TwinAsset[]; assumptions?: WorkspaceVersion["assumptions"] };
  const s = saved.scenario;
  return (
    !!s && typeof s === "object" &&
    Object.keys(SAMPLE_SCENARIO).every((key) => key in s) &&
    Object.entries(s).every(
      ([, value]) => typeof value !== "number" || Number.isFinite(value),
    ) &&
    s.length_ft >= 0 &&
    s.width_ft >= 0 &&
    s.canopy_sqft >= 0 &&
    (!saved.assumptions || (typeof saved.assumptions === "object" && Object.entries(saved.assumptions).every(([key, value]) => Object.hasOwn(INPUT_RULES, key) && value && [value.label, value.source, value.growth_stage].every(text => typeof text === "string" && text.length > 0 && text.length <= 300)))) &&
    Array.isArray(saved.assets) &&
    saved.assets.every(
      (a) =>
        !!a &&
        typeof a.id === "string" &&
        a.type in assetIcons &&
        Number.isInteger(a.quantity) &&
        a.quantity > 0,
    )
  );
}

export default function Page() {
  const [design, setDesign] = useState<DesignState>(() => createDesign({ scenario: { ...SAMPLE_SCENARIO }, assets: SAMPLE_ASSETS.map(asset => ({ ...asset })), crop: null, result: null }));
  const designRef = useRef(design);
  const revision = useRef(0);
  const [history, setHistory] = useState<Run[]>([]);
  const [inspectedRunId, setInspectedRunId] = useState<string | null>(null);
  const inspectedRun = history.find(run => run.id === inspectedRunId);
  const workspace = inspectedRun ? { ...inspectedRun, crop: inspectedRun.crop ?? null } : activeWorkspace(design);
  const { scenario, assets, result, crop } = workspace;
  const assumptions = workspace.assumptions ?? {};
  const hasAssumptions = Object.keys(assumptions).length > 0;
  const [comparison, setComparison] = useState<"current" | "proposed">("proposed");
  const [proposalError, setProposalError] = useState<string | null>(null);
  const displayed = !inspectedRun && design.proposal && comparison === "current" ? design.accepted : workspace;
  function changeDesign(change: (state: DesignState) => DesignState) {
    const next = change(designRef.current);
    designRef.current = next;
    revision.current = next.revision;
    setDesign(next);
  }
  function setWorkspaceField<K extends keyof WorkspaceVersion>(key: K, value: SetStateAction<WorkspaceVersion[K]>) {
    changeDesign(state => updateActive(state, { [key]: typeof value === "function" ? (value as (previous: WorkspaceVersion[K]) => WorkspaceVersion[K])(activeWorkspace(state)[key]) : value }));
  }
  const setScenario = (value: SetStateAction<Scenario>) => setWorkspaceField("scenario", value);
  const setAssets = (value: SetStateAction<TwinAsset[]>) => setWorkspaceField("assets", value);
  const [workspaceName, setWorkspaceName] = useState("Grow space 01");
  const [view, setView] = useState<View>("workspace");
  const [scenarioView, setScenarioView] = useState<"lighting" | "site">("lighting");
  const siteView = view === "scenarios" && scenarioView === "site";
  const earthView = view === "earth";
  const [earthSites, setEarthSites] = useState<EarthSite[] | null>(null);
  const [siteOpenRequest, setSiteOpenRequest] = useState<SiteComparisonOpenRequest | null>(null);
  const [siteOpenError, setSiteOpenError] = useState<string | null>(null);
  const siteOpenSerial = useRef(0);
  const siteOpenTarget = useRef<"earth" | "plans">("plans");
  const receiveSites = useCallback((sites: EarthSite[] | null) => setEarthSites(sites), []);
  const siteOpened = useCallback((requestId: number, error: string | null) => {
    if (requestId !== siteOpenSerial.current) return;
    setSiteOpenRequest(null); setSiteOpenError(error);
    if (!error && siteOpenTarget.current === "plans") { setScenarioView("site"); setView("scenarios"); }
  }, []);
  const [inspectorTab, setInspectorTab] = useState<"inputs" | "inventory">(
    "inputs",
  );
  const [mode, setMode] = useState<"current" | "optimized">("current");
  const [layer, setLayer] = useState<"structure" | "light">("structure");
  const [cameraView, setCameraView] = useState<"perspective" | "top">(
    "perspective",
  );
  const [autoRotate, setAutoRotate] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [engineChecked, setEngineChecked] = useState(false);
  const [busy, setBusy] = useState<"scan" | "optimize" | null>(null);
  const [modal, setModal] = useState<
    "scan" | "method" | "workspace" | "add" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [visionTest, setVisionTest] = useState<"untested" | "succeeded" | "failed">("untested");
  const [liveOpen, setLiveOpen] = useState(false);
  const [explanationStatus, setExplanationStatus] = useState<ExplanationStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<"all" | "feasible">("feasible");
  const [forecastSites, setForecastSites] = useState(1);
  const [savingState, setSavingState] = useState("Checking local storage");
  const [storageError, setStorageError] = useState<string | null>(null);
  const storageReadable = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  function contextFor(state: DesignState) {
    const context = designContext(state, selectedAsset);
    const selected = inspectedRun ? calculationFor(inspectedRun) : selectedCalculationFor(state, history);
    return { ...context, selected_run: selected?.reference ?? null, has_result: inspectedRun ? !!inspectedRun.result : context.has_result };
  }
  const liveContext = contextFor(design);
  const selectedCalculation = inspectedRun ? calculationFor(inspectedRun) : selectedCalculationFor(design, history);
  const changedField = (field: keyof Scenario) => !inspectedRun && !!design.proposal && design.accepted.scenario[field] !== scenario[field];
  const baseline = result?.baseline || baselineMetrics(scenario);
  const unchangedSetting = !!result?.optimized && result.optimized.photoperiod_hours === result.baseline.photoperiod_hours && result.optimized.dim_fraction === result.baseline.dim_fraction;
  const energyDifference = result?.savings?.period_energy_kwh ?? null;
  const costDifference = result?.savings?.period_energy_cost_usd ?? null;
  const activeMetrics =
    !inspectedRun && design.proposal && comparison === "current" ? displayed.result?.baseline || baselineMetrics(displayed.scenario)
    : mode === "optimized" && result?.optimized ? result.optimized : baseline;
  const simulationOnline = health?.status === "ok";
  const simulationLabel = busy === "optimize"
    ? "Simulating"
    : design.proposal ? (scenario.source === "sample" ? "Compare proposed sample" : "Compare proposed lighting")
    : scenario.source === "sample" ? "Simulate this sample" : "Run simulation";
  const visionLabel = !simulationOnline
    ? "Vision status unknown"
    : visionTest === "failed" ? "Vision scan failed"
    : !health?.vision_available ? (health?.vision_provider === "manual" ? "Vision not configured" : "Vision unavailable")
    : visionTest === "succeeded" ? "Vision verified this session"
    : "Vision configured";
  const visionDetail = !simulationOnline
    ? "Provider status is unknown while the simulation backend is unreachable."
    : visionTest === "failed"
      ? "The last photo request failed. Manual inventory and simulation remain available."
      : !health?.vision_available
        ? "Photo analysis is unavailable. Manual inventory and simulation remain available."
        : visionTest === "succeeded"
          ? "A photo request completed in this browser session. Observations still need your review."
          : `${health.vision_provider === "vertex" ? "Vertex AI" : "Gemini"} is configured; no photo request has been verified in this browser session.`;

  const checkEngine = useCallback(async () => {
    try {
      setHealth(await api<Health>("health"));
    } catch {
      setHealth(null);
    } finally {
      setEngineChecked(true);
    }
  }, []);

  useEffect(() => {
    void checkEngine();
    try {
      const text = localStorage.getItem("acreiq.workspace.v1");
      if (text) {
        const saved = JSON.parse(text);
        if (validSaved(saved)) {
          const originalHistory = Array.isArray(saved.history) ? saved.history : [];
          const loadedHistory = originalHistory.filter(run => typeof run?.id === "string" && run?.result?.baseline
            && validSaved({ scenario: run.scenario, assets: run.assets }));
          if (loadedHistory.length !== originalHistory.length) {
            storageReadable.current = false;
            setSavingState("Existing local data preserved; session-only");
            setStorageError("Some saved records could not be read. Existing browser data has not been replaced. Export this session before leaving.");
          }
          setHistory(loadedHistory);
          const working: WorkspaceVersion = { scenario: saved.scenario, assets: saved.assets,
            crop: typeof saved.crop === "string" ? saved.crop.slice(0, 80) : null, result: null,
            assumptions: saved.assumptions ?? {}, inputRecords: saved.inputRecords };
          if (Array.isArray(saved.provenance) && saved.provenance.length <= 32 && saved.provenance.every(item => ["user_instruction", "delegated_design"].includes(item?.basis) && Array.isArray(item.turn_ids) && item.turn_ids.length <= 8 && item.turn_ids.every(id => typeof id === "string" && id.length <= 64))) working.provenance = saved.provenance;
          const savedRun = validCalculation(saved.saved_run) && validSaved({ scenario: saved.saved_run.result.run!.input_snapshot, assets: [] }) ? saved.saved_run : null;
          const restored = restoreDesign(working, savedRun, loadedHistory, saved.accepted_result_id, saved.working_revision, saved.accepted_revision);
          changeDesign(() => restored);
          const inspection = loadedHistory.find(run => run.id === saved.inspected_run_id);
          setInspectedRunId(inspection?.id ?? null);
          setWorkspaceName(typeof saved.name === "string" ? saved.name : "Grow space 01");
          setMode(saved.mode === "current" ? "current" : (inspection?.result.optimized || restored.accepted.result?.optimized) ? "optimized" : "current");
          if (["workspace", "scenarios", "impact", "earth"].includes(saved.view ?? "")) setView(saved.view!);
          if (localStorage.getItem("acreiq.scenario-module.v1") === "site") setScenarioView("site");
        } else throw new Error("Unreadable saved workspace");
      }
    } catch {
      storageReadable.current = false;
      setSavingState("Local storage unavailable");
      setStorageError("Saved browser data could not be read and has not been replaced. Current changes are session-only; export before leaving.");
    }
    setReady(true);
  }, [checkEngine]);

  useEffect(() => {
    if (!ready || !storageReadable.current) return;
    try {
      localStorage.setItem(
        "acreiq.workspace.v1",
        JSON.stringify({ scenario: design.accepted.scenario, assets: design.accepted.assets, crop: design.accepted.crop, assumptions: design.accepted.assumptions, provenance: design.accepted.provenance, inputRecords: design.accepted.inputRecords,
          name: workspaceName, history, saved_run: design.saved_run, accepted_result_id: design.accepted.result?.run?.id ?? null,
          inspected_run_id: inspectedRunId, working_revision: design.revision, accepted_revision: design.accepted_revision, view, mode }),
      );
      setSavingState("Saved on this device");
      setStorageError(null);
    } catch {
      setSavingState("Could not save on this device");
      setStorageError("Browser storage is full or unavailable. Previously saved data is unchanged; latest changes are session-only. Export before leaving.");
    }
  }, [ready, design.accepted, design.saved_run, design.revision, design.accepted_revision, workspaceName, history, inspectedRunId, view, mode]);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem("acreiq.scenario-module.v1", scenarioView); } catch { /* Navigation is optional; evidence saving reports its own errors. */ }
  }, [ready, scenarioView]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
  useEffect(() => {
    if (!modal) return;
    const prior = document.activeElement as HTMLElement | null;
    const el = modalRef.current;
    const timer = setTimeout(
      () => el?.querySelector<HTMLElement>("button, input")?.focus(),
      0,
    );
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) setModal(null);
      if (event.key === "Tab" && el) {
        const focusable = [
          ...el.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), select, a[href]",
          ),
        ];
        if (!focusable.length) return;
        const first = focusable[0],
          last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, [modal, busy]);

  function invalidate() {
    changeDesign(invalidateDesign);
    setMode("current");
    setError(null);
    setProposalError(null);
  }
  function receipt(status: ActionReceipt["status"], message: string): ActionReceipt {
    return { status, message, context: contextFor(designRef.current) };
  }
  function receiveLiveDraft(draft: LiveDraft): ActionReceipt {
    if (inspectedRun) return receipt("rejected", "A saved run is open read-only. Return to working space before changing its design.");
    if (busy) return receipt("rejected", "Wait for the current request to finish.");
    try {
      changeDesign(state => stageDesign(state, draft));
      setMode("current"); setError(null); setProposalError(null);
      setComparison("proposed"); setView("workspace"); setInspectorTab("inputs");
      if (!activeWorkspace(designRef.current).assets.some(asset => asset.id === selectedAsset)) setSelectedAsset(null);
      return receipt("applied", "Proposed workspace staged for review; accepted workspace unchanged.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not stage this proposal.";
      setProposalError(message);
      return receipt("rejected", message);
    }
  }
  function proposalAction(event: Pick<ProposalAction, "action" | "proposal_id" | "version" | "revision">): ActionReceipt {
    if (inspectedRun) return receipt("rejected", "A saved run is open read-only. Return to working space before changing its design.");
    if (busy) return receipt("rejected", "Wait for the current request to finish.");
    try {
      changeDesign(state => actOnDesign(state, event.action, event.proposal_id, event.version, event.revision));
      setComparison("proposed"); setMode("current"); setProposalError(null); setView("workspace");
      if (event.action === "revise") setInspectorTab("inputs");
      const message = { approve: "Version adopted. Changed assumptions still need measurement review before real calculations.", revise: "Proposal opened for revision. The accepted workspace is unchanged.", discard: "Proposal discarded. The accepted workspace is restored.", undo: "Last adoption undone. Review the restored workspace." }[event.action];
      setToast(message);
      return receipt("applied", message);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not change this proposal.";
      setProposalError(message);
      return receipt("rejected", message);
    }
  }
  function receiveLiveResult(contextRevision: number, output: OptimizationResult): ActionReceipt {
    if (inspectedRun) return receipt("rejected", "A saved run is open read-only. No new calculation was displayed. Return to working space first.");
    const current = activeWorkspace(designRef.current);
    if (Object.keys(current.assumptions ?? {}).length) return receipt("rejected", "Resolve proposed assumptions before calculating.");
    if (busy || contextRevision !== revision.current || !current.scenario.confirmed || current.assets.some(asset => !asset.confirmed)) return receipt("rejected", "This result no longer matches reviewed workspace inputs.");
    if (output.source !== current.scenario.source || !Array.isArray(output.candidates) || output.operating_days !== current.scenario.operating_days) return receipt("rejected", "Result provenance does not match this workspace.");
    try { storeResult(output); }
    catch (cause) { return receipt("rejected", cause instanceof Error ? cause.message : "Run identity did not match."); }
    setView("workspace");
    if (output.optimized) {
      setMode("optimized");
      setToast(`${output.configurations_evaluated} configurations evaluated`);
    } else { setMode("current"); setError(output.recommendations[0] || "Review your constraints."); }
    return receipt("applied", "Lighting comparison is available in the workspace.");
  }
  function storeResult(output: OptimizationResult) {
    const current = activeWorkspace(designRef.current);
    changeDesign(state => recordResult(state, output));
    const reference = designRef.current.saved_run?.reference;
    setExplanationStatus(null);
    const run: Run = {
      id: output.run?.id ?? crypto.randomUUID(), name: workspaceName,
      at: output.run?.created_at ?? new Date().toISOString(),
      scenario: structuredClone(output.run?.input_snapshot ?? { ...current.scenario, confirmed: true }),
      assets: structuredClone(current.assets), crop: current.crop,
      assumptions: structuredClone(current.assumptions), provenance: structuredClone(current.provenance),
      inputRecords: validInputRecords(current.inputRecords, current.scenario) ? structuredClone(current.inputRecords) : {},
      result: structuredClone(output), reference,
    };
    setHistory(previous => appendRun(previous, run));
  }
  function updateScenario<K extends keyof Scenario>(
    key: K,
    value: Scenario[K],
  ) {
    invalidate();
    const remainingAssumptions = { ...activeWorkspace(designRef.current).assumptions };
    delete remainingAssumptions[key as keyof typeof remainingAssumptions];
    setWorkspaceField("assumptions", remainingAssumptions);
    setScenario((previous) => ({
      ...previous,
      [key]: value,
      confirmed: false,
    }));
    setAssets((previous) => previous.map((asset) => ({ ...asset, confirmed: false })));
  }
  function updateAssets(next: TwinAsset[]) {
    invalidate();
    setAssets(next.map((asset) => ({ ...asset, confirmed: false })));
    const lights = next
      .filter((asset) => asset.type === "light_fixture")
      .reduce((sum, asset) => sum + asset.quantity, 0);
    setScenario((previous) => ({
      ...previous,
      confirmed: false,
      light_count: lights,
    }));
  }
  function loadSample() {
    setInspectedRunId(null);
    changeDesign(state => createDesign({ scenario: { ...SAMPLE_SCENARIO }, assets: SAMPLE_ASSETS.map(asset => ({ ...asset })), crop: null, result: null }, state.revision + 1));
    setComparison("proposed"); setMode("current"); setError(null); setProposalError(null);
    setImageUrl(null);
    setScan(null);
    setWorkspaceName("Grow space 01");
    setModal(null);
    setView("workspace");
    setSelectedAsset(null);
    setResetKey((value) => value + 1);
    setToast("Sample workspace loaded");
  }
  function startManual() {
    setInspectedRunId(null);
    changeDesign(state => createDesign({ scenario: { ...EMPTY_SCENARIO }, assets: [], crop: null, result: null }, state.revision + 1));
    setComparison("proposed"); setMode("current"); setError(null); setProposalError(null);
    setImageUrl(null);
    setScan(null);
    setSelectedAsset(null);
    setWorkspaceName("New grow space");
    setModal(null);
    setView("workspace");
    setInspectorTab("inputs");
    setResetKey((value) => value + 1);
  }
  async function optimize() {
    if (inspectedRun) { setError("Saved runs are read-only. Return to working space before calculating."); return; }
    if (busy) return;
    if (hasAssumptions) {
      setError("Resolve the proposed assumptions using verified inputs before calculating. A source label alone does not validate an assumption.");
      setView("workspace");
      return;
    }
    if (scenario.source !== "sample" && !scenario.confirmed) {
      setError(
        "Review the inventory and entered inputs before simulating. Review does not verify measurement accuracy.",
      );
      setView("workspace");
      return;
    }
    if (
      assets
        .filter((a) => a.type === "light_fixture")
        .reduce((sum, a) => sum + a.quantity, 0) !== scenario.light_count
    ) {
      setError("The light count must match your equipment inventory.");
      setInspectorTab("inventory");
      return;
    }
    setError(null);
    setBusy("optimize");
    const currentRevision = revision.current;
    try {
      const input = { ...scenario, confirmed: true };
      const output = await api<OptimizationResult>("optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (currentRevision !== revision.current) return;
      storeResult(output);
      if (output.optimized) {
        setMode("optimized");
        setToast(`${output.configurations_evaluated} configurations evaluated`);
      } else setError(output.recommendations[0] || "Review your constraints.");
      void checkEngine();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed.");
      void checkEngine();
    } finally {
      setBusy(null);
    }
  }
  async function upload(file?: File) {
    if (!file || busy) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG or WebP image.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose an image smaller than 10 MB.");
      return;
    }
    changeDesign(state => createDesign({ scenario: { ...EMPTY_SCENARIO, source: "photo-assisted" }, assets: [], crop: null, result: null }, state.revision + 1));
    setComparison("proposed"); setMode("current"); setError(null); setProposalError(null);
    setImageUrl(URL.createObjectURL(file));
    setScan(null);
    setVisionTest("untested");
    setBusy("scan");
    setModal("scan");
    setAssets([]);
    setSelectedAsset(null);
    setScenario({
      ...EMPTY_SCENARIO,
      source: "photo-assisted",
    });
    setWorkspaceName(
      file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "New grow space",
    );
    const form = new FormData();
    form.append("image", file);
    try {
      const output = await api<ScanResult>("scan", {
        method: "POST",
        body: form,
      });
      setScan(output);
      setVisionTest(output.source === "gemini" ? "succeeded" : "untested");
      setAssets(output.assets);
      setScenario((previous) => ({
        ...previous,
        light_count: output.assets
          .filter((a) => a.type === "light_fixture")
          .reduce((sum, a) => sum + a.quantity, 0),
        source: output.source === "gemini" ? "photo-assisted" : "manual",
      }));
      setInspectorTab("inventory");
    } catch (err) {
      setVisionTest("failed");
      setError(
        err instanceof Error
          ? err.message
          : "Scan failed. Enter your equipment manually.",
      );
    } finally {
      setBusy(null);
      void checkEngine();
      if (fileInput.current) fileInput.current.value = "";
      if (cameraInput.current) cameraInput.current.value = "";
    }
  }
  function exportReport(format: "json" | "csv") {
    if (!result) return;
    const original = inspectedRun ?? history.find(run => run.id === result.run?.id);
    const content =
      format === "json"
        ? JSON.stringify(
            {
              workspace: inspectedRun?.name ?? workspaceName,
              exported_at: new Date().toISOString(),
              equivalent_sites: forecastSites,
              scale_assumption: "Identical equipment, measurements and operating conditions at every site. Result metrics below are per site.",
              scenario: result.run?.input_snapshot ?? { ...scenario, confirmed: true },
              assets,
              crop,
              assumptions,
              provenance: workspace.provenance ?? [],
              ...exportInputRecords(original?.inputRecords, result.run?.input_snapshot),
              candidate_identity: buildCandidateIdentityMetadata(result),
              server_verification: "not_checked",
              workspace_version: inspectedRun ? { status: "historical", ...inspectedRun.reference } : design.proposal ? { id: design.proposal.id, version: design.proposal.version, status: "proposed", base_revision: design.proposal.base_revision, provenance: design.proposal.provenance } : { status: "accepted", revision: design.accepted_revision },
              run_reference: selectedCalculation?.reference ?? null,
              result,
            },
            null,
            2,
          )
        : buildRunCsv(result, { reference: selectedCalculation?.reference, inputFallback: scenario,
            name: inspectedRun?.name ?? workspaceName, inputRecords: original?.inputRecords, assumptions: original?.assumptions });
    const url = URL.createObjectURL(
      new Blob([content], {
        type: format === "json" ? "application/json" : "text/csv",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `acreiq-scenario.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setToast("Scenario exported");
  }
  function exportLocalHistory() {
    const content = JSON.stringify({ format: "acreiq-local-history-v1", exported_at: new Date().toISOString(),
      storage: "Browser-local copies, not a durable cloud archive or current server verification.",
      workspace: { ...design.accepted, name: workspaceName }, saved_run: design.saved_run,
      inspected_run_id: inspectedRunId, history }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "acreiq-local-history.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function inspectRun(run: Run) {
    if (busy) return;
    setInspectedRunId(run.id); setExplanationStatus(null); setError(null); setSelectedAsset(null);
    setMode(run.result.optimized ? "optimized" : "current");
  }
  function returnToWorkingSpace() {
    setInspectedRunId(null); setSelectedAsset(null); setExplanationStatus(null); setError(null);
    setMode(activeWorkspace(designRef.current).result?.optimized ? "optimized" : "current");
  }
  function exportProposedVersion() {
    const state = designRef.current;
    if (!state.proposal) return;
    const { workspace, ...version } = state.proposal;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ workspace: workspaceName, exported_at: new Date().toISOString(), workspace_version: { ...version, status: "proposed" }, ...workspace, limitations: ["Revised schematic, not calculated spatial optimization.", "Unreviewed inputs are not verified measurements.", "Crop labels do not supply light, yield or water requirements."] }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "acreiq-proposed-version.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const selected = assets.find((asset) => asset.id === selectedAsset);
  const nav = [
    { id: "workspace", icon: Box, label: "Workspace" },
    { id: "scenarios", icon: FlaskConical, label: "Scenarios" },
    { id: "impact", icon: Activity, label: "Impact" },
    { id: "earth", icon: Earth, label: "AcreIQ Earth" },
  ] as const;
  const setNumeric = (key: keyof Scenario) => (value: number | null) =>
    updateScenario(key, value as never);
  const renderInputs = () => (
    <>
      <div className="inspector-section">
        <div className="section-label">
          <Maximize2 size={14} />
          Space dimensions<span>ft</span>
        </div>
        <div className="field-grid">
          <Field
            label="Length"
            value={displayed.scenario.length_ft}
            changed={changedField("length_ft")}
            min={0.1}
            max={1000}
            step={0.5}
            onChange={setNumeric("length_ft")}
          />
          <Field
            label="Width"
            value={displayed.scenario.width_ft}
            changed={changedField("width_ft")}
            min={0.1}
            max={1000}
            step={0.5}
            onChange={setNumeric("width_ft")}
          />
          <Field
            label="Canopy area"
            value={displayed.scenario.canopy_sqft}
            changed={changedField("canopy_sqft")}
            unit="ft²"
            min={0.1}
            step={0.5}
            onChange={setNumeric("canopy_sqft")}
          />
          <Field
            label="Power ceiling"
            value={displayed.scenario.power_limit_watts}
            changed={changedField("power_limit_watts")}
            unit="W"
            min={1}
            max={2000000}
            onChange={setNumeric("power_limit_watts")}
          />
        </div>
      </div>
      <div className="inspector-section">
        <div className="section-label">
          <Lightbulb size={14} />
          Existing lighting<span>{scenario.light_count} fixtures</span>
        </div>
        <div className="field-grid">
          <Field
            label="Total light load"
            value={displayed.scenario.lighting_watts}
            changed={changedField("lighting_watts")}
            unit="W"
            min={0}
            max={1000000}
            onChange={setNumeric("lighting_watts")}
          />
          <Field
            label="Current schedule"
            value={displayed.scenario.baseline_hours}
            changed={changedField("baseline_hours")}
            unit="h/day"
            min={0.25}
            max={24}
            step={0.25}
            onChange={setNumeric("baseline_hours")}
          />
        </div>
        <label className="toggle-row">
          <span>Dimmable fixtures</span>
          <input
            type="checkbox"
            role="switch"
            checked={displayed.scenario.dimmable}
            onChange={(event) => {
              invalidate();
              setScenario((previous) => ({
                ...previous,
                dimmable: event.target.checked,
                baseline_dim: 1,
                confirmed: false,
              }));
              setAssets((previous) => previous.map((asset) => ({ ...asset, confirmed: false })));
            }}
          />
          <span className="switch" />
        </label>
        {displayed.scenario.dimmable && (
          <label className="slider-field">
            <span>
              Current output<b>{Math.round(displayed.scenario.baseline_dim * 100)}%</b>
            </span>
            <input
              aria-label="Current light output"
              type="range"
              min={5}
              max={100}
              step={5}
              value={displayed.scenario.baseline_dim * 100}
              onChange={(event) =>
                updateScenario("baseline_dim", Number(event.target.value) / 100)
              }
            />
          </label>
        )}
      </div>
      <div className="inspector-section">
        <div className="section-label">
          <Sun size={14} />
          Crop light constraints
        </div>
        <div className="field-grid">
          <label className={`field${!inspectedRun && design.proposal && design.accepted.crop !== crop ? " is-changed" : ""}`}>
            <span>Crop label</span>
            <div className="input-wrap"><input aria-label="Crop label" value={displayed.crop ?? ""} maxLength={80} placeholder="Unspecified" onChange={event => { invalidate(); setWorkspaceField("crop", event.target.value || null); }} /></div>
          </label>
          <Field
            label="Full-output PPFD"
            unit="umol/m2/s"
            value={displayed.scenario.ppfd_full}
            changed={changedField("ppfd_full")}
            min={1}
            max={5000}
            optional
            onChange={setNumeric("ppfd_full")}
          />
          <Field
            label="Minimum DLI"
            value={displayed.scenario.min_dli}
            changed={changedField("min_dli")}
            unit="mol/m²/day"
            min={0.1}
            max={100}
            step={0.5}
            optional
            onChange={setNumeric("min_dli")}
          />
          <Field
            label="Minimum schedule"
            value={displayed.scenario.min_hours}
            changed={changedField("min_hours")}
            unit="h/day"
            min={0.25}
            max={24}
            step={0.25}
            onChange={setNumeric("min_hours")}
          />
          <Field
            label="Maximum schedule"
            value={displayed.scenario.max_hours}
            changed={changedField("max_hours")}
            unit="h/day"
            min={0.25}
            max={24}
            step={0.25}
            onChange={setNumeric("max_hours")}
          />
        </div>
        <p className="input-provenance" data-testid="ppfd-origin">PPFD: {{ missing: "unknown", "sample-assumption": "synthetic sample assumption", assumption: "assumption, not a measurement", "user-entered": "user-entered; no measurement record", "user-recorded": "user-recorded measurement; not independently verified" }[inputOrigin("ppfd_full", displayed.scenario, displayed.inputRecords, displayed.assumptions)]}.</p>
        <MeasurementRecord scenario={displayed.scenario} records={displayed.inputRecords} disabled={!!busy || !!inspectedRun || (!!design.proposal && comparison === "current")}
          onChange={records => { invalidate(); setWorkspaceField("inputRecords", records); setScenario(previous => ({ ...previous, confirmed: false })); }} />
      </div>
      <details className="inspector-section advanced">
        <summary>
          <Settings2 size={14} />
          Operating assumptions
          <ChevronDown size={14} />
        </summary>
        <div className="field-grid">
          <Field
            label="Other loads"
            value={displayed.scenario.other_watts}
            changed={changedField("other_watts")}
            unit="W"
            max={1000000}
            onChange={setNumeric("other_watts")}
          />
          <Field
            label="Other load schedule"
            value={displayed.scenario.other_hours}
            changed={changedField("other_hours")}
            unit="h/day"
            max={24}
            step={0.5}
            onChange={setNumeric("other_hours")}
          />
          <Field
            label="Electricity rate"
            value={displayed.scenario.electricity_usd_kwh}
            changed={changedField("electricity_usd_kwh")}
            unit="$/kWh"
            max={10}
            step={0.01}
            onChange={setNumeric("electricity_usd_kwh")}
          />
          <Field
            label="Operating period"
            value={displayed.scenario.operating_days}
            changed={changedField("operating_days")}
            unit="days"
            min={1}
            max={366}
            onChange={setNumeric("operating_days")}
          />
          <Field
            label="Measured water use"
            value={displayed.scenario.water_liters_day}
            changed={changedField("water_liters_day")}
            unit="L/day"
            optional
            max={1000000}
            onChange={setNumeric("water_liters_day")}
          />
        </div>
      </details>
    </>
  );
  const displayMetric = (
    label: string,
    value: string,
    unit: string,
    Icon: LucideIcon,
    difference?: string,
    caption?: string,
    direction: "saving" | "additional" | "neutral" = "saving",
  ) => (
    <div className="metric">
      <div className="metric-label">
        <Icon size={15} />
        <span>{label}</span>
      </div>
      <div className="metric-number">
        {(Icon === Zap || Icon === Gauge) && (scenario.lighting_watts <= 0 || scenario.baseline_hours <= 0 || scenario.operating_days <= 0 || (scenario.source !== "sample" && !scenario.confirmed)) ? "—" : value}
        <span>{unit}</span>
      </div>
      <div className={`metric-caption ${difference ? direction === "saving" ? "green" : direction : ""}`}>
        {difference ? (
          <>
            {direction === "saving" && <ArrowDown size={12} />}
            {difference}
          </>
        ) : caption ? caption : scenario.operating_days <= 0 ? "Operating period required" : (
          <>
            {scenario.operating_days}-day modeled{" "}
            {mode === "optimized" ? "scenario" : "baseline"}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="app-shell">
      <aside className="rail">
        <button
          className="brand-symbol"
          title="AcreIQ workspace"
          aria-label="AcreIQ workspace"
          onClick={() => setView("workspace")}
        >
          <Sprout size={27} strokeWidth={1.8} />
        </button>
        <nav>
          {nav.map((item) => (
            <IconButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={view === item.id}
              onClick={() => { siteOpenSerial.current++; setSiteOpenRequest(null); setView(item.id); }}
            />
          ))}
        </nav>
        <div className="rail-bottom">
          <IconButton
            icon={CircleHelp}
            label="Model and methodology"
            onClick={() => setModal("method")}
          />
          <button
            className="avatar"
            title="Workspace settings"
            aria-label="Workspace settings"
            onClick={() => setModal("workspace")}
          >
            JN
          </button>
        </div>
      </aside>
      <div className="app-body">
        <header className="topbar">
          <button className="wordmark" onClick={() => setView("workspace")}>
            Acre<span>IQ</span>
          </button>
          <span className="topbar-divider" />
          <button
            className="workspace-picker"
            onClick={() => setModal("workspace")}
          >
            <span>Personal workspace</span>
            <ChevronDown size={13} />
          </button>
          <div className="topbar-right">
            <div className="service-status" aria-label="Service status">
            <button
              className={`engine-status ${simulationOnline ? "online" : "offline"}`}
              onClick={() => void checkEngine()}
              title="Refresh simulation and vision status"
            >
              <span className="status-dot" />
              {simulationOnline
                ? "Simulation online"
                : engineChecked
                  ? "Simulation offline"
                  : "Checking simulation"}
            </button>
            <span className="provider-status" title={visionDetail}>
              <span className={`status-dot ${simulationOnline && health?.vision_available && visionTest === "succeeded" ? "" : "amber"}`} />
              {visionLabel}
            </span>
            </div>
            <span className="version-label">EARLY ACCESS</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="breadcrumb">
                WORKSPACE
                <ChevronRight size={11} />
                {view === "workspace" ? "RESOURCE TWIN" : view.toUpperCase()}
              </div>
              <div className="title-line">
                <h1>
                  {view === "workspace"
                    ? (inspectedRun?.name ?? workspaceName) || "Untitled space"
                    : view === "scenarios"
                      ? "Scenario explorer"
                      : earthView ? "AcreIQ Earth" : "Resource impact"}
                </h1>
                <span className="source-badge">
                  {earthView ? "Location reference" : siteView ? "Site operating plans" : scenario.source === "sample"
                    ? "Sample space"
                    : scenario.source === "photo-assisted"
                      ? "Photo assisted"
                      : "Manual inputs"}
                </span>
              </div>
              <p>
                {view === "workspace"
                  ? "See what you have. Discover what’s possible."
                  : view === "scenarios"
                    ? "Every configuration, every constraint, in view."
                    : earthView ? "Sites and their saved operating plans." : "The difference your existing equipment can make."}
              </p>
            </div>
            <div className="heading-actions">
              {!siteView && !earthView && <button className="secondary-button" onClick={() => { setView("scenarios"); setScenarioView("site"); }}><Layers3 size={16} />Compare site plans</button>}
              {design.undo && !design.proposal && !inspectedRun && <IconButton icon={RotateCcw} label="Undo last adoption" disabled={!!busy} onClick={() => proposalAction({ action: "undo", proposal_id: null, version: null, revision: designRef.current.revision })} />}
              {design.proposal && !inspectedRun && <IconButton icon={ArrowDownToLine} label="Export proposed version" onClick={exportProposedVersion} />}
              {!siteView && !earthView && <button className="secondary-button" aria-expanded={liveOpen} disabled={!!busy} onClick={() => { setLiveOpen(true); setView("workspace"); }}>
                <Radio size={16} />Walk through my space
              </button>}
              {!siteView && !earthView && <button
                className="secondary-button"
                onClick={() => setModal("scan")}
                disabled={!!busy || !!inspectedRun}
              >
                <ScanLine size={16} />
                Scan a space
              </button>}
              {!siteView && !earthView && <button
                className="primary-button"
                onClick={() => void optimize()}
                disabled={!!busy || !!inspectedRun}
              >
                {busy === "optimize" ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Sparkles size={16} />
                )}
                {simulationLabel}
                <ArrowRight size={15} />
              </button>}
            </div>
          </div>
          {storageError && <div className="error-banner" role="alert"><CircleHelp size={17} /><span>{storageError}</span>
            <IconButton icon={ArrowDownToLine} label="Export local history" onClick={exportLocalHistory} /></div>}
          {inspectedRun && <section className="saved-run-banner" aria-label="Saved run inspection">
            <div><strong>Saved run · read-only</strong><code>{inspectedRun.result.run?.id ?? inspectedRun.id}</code>
              <span>Original inputs shown. Working inputs are unchanged. Browser copy; server availability not checked.</span></div>
            <button className="secondary-button" onClick={returnToWorkingSpace}><ArrowLeft size={15} />Return to working space</button>
          </section>}
          {liveOpen && <LivePanel context={liveContext} review={null}
            onDraft={receiveLiveDraft}
            onProposalAction={proposalAction}
            onCancelDraft={() => {}}
            onClearDrafts={() => {}}
            onView={(camera, assetId) => {
              if (inspectedRun) return receipt("rejected", "The saved run is open read-only. Return to working space before changing Live's view.");
              if ((camera !== undefined && camera !== "top" && camera !== "perspective") || (camera === undefined && !assetId)) return receipt("rejected", "This camera view is not supported.");
              if (busy || (assetId && !activeWorkspace(designRef.current).assets.some(asset => asset.id === assetId))) return receipt("rejected", "This view target is no longer available.");
              if (camera === "top" || camera === "perspective") { setCameraView(camera); setAutoRotate(false); }
              if (assetId && assets.some(asset => asset.id === assetId)) setSelectedAsset(assetId);
              setView("workspace");
              return { ...receipt("applied", "Twin view updated."), context: { ...contextFor(designRef.current), selected_asset_id: assetId ?? selectedAsset } };
            }}
            onResult={receiveLiveResult} onExplanation={setExplanationStatus} onClose={() => setLiveOpen(false)} onNewSpace={startManual} />}
          {design.proposal && !inspectedRun && <ProposalReview proposal={design.proposal} comparison={comparison} onComparison={setComparison} changes={designChanges(design)} sampleDerived={scenario.source === "sample"} busy={!!busy} error={proposalError}
            onAction={action => proposalAction({ action, proposal_id: designRef.current.proposal?.id ?? null, version: designRef.current.proposal?.version ?? null, revision: designRef.current.revision })} />}
          {!design.proposal && proposalError && <div className="error-banner" role="alert">{proposalError}</div>}
          {error && (
            <div className="error-banner" role="alert">
              <CircleHelp size={17} />
              <span>{error}</span>
              <IconButton
                icon={X}
                label="Dismiss error"
                onClick={() => setError(null)}
              />
            </div>
          )}
          {view === "workspace" && (
            <>
              <div className="workspace-grid">
                <section
                  className="twin-workspace"
                  aria-label="Resource twin workspace"
                >
                  <div className="twin-toolbar">
                    <div className="segmented" role="group" aria-label="Lighting comparison">
                      <button
                        title="Current lighting schedule for the displayed design"
                        className={mode === "current" ? "selected" : ""}
                        onClick={() => setMode("current")}
                      >
                        Current state
                      </button>
                      <button
                        title="Solver-selected lighting schedule, not a spatial layout"
                        className={mode === "optimized" ? "selected" : ""}
                        onClick={() => setMode("optimized")}
                        disabled={!result?.optimized}
                      >
                        Proposed state
                        {result?.optimized && <span className="tiny-dot" />}
                      </button>
                    </div>
                    <div className="twin-toolbar-right">
                      <span className="schematic-tag">
                        <Box size={13} />
                        SCHEMATIC TWIN
                      </span>
                      <IconButton
                        icon={Expand}
                        label="Expand spatial twin"
                        onClick={() => {
                          if (document.fullscreenElement)
                            void document.exitFullscreen();
                          else
                            void stage.current
                              ?.requestFullscreen()
                              .catch(() =>
                                setToast(
                                  "Full screen is unavailable in this browser",
                                ),
                              );
                        }}
                      />
                    </div>
                  </div>
                  <div className="scene" ref={stage}>
                    <SpatialTwin
                      scenario={displayed.scenario}
                      assets={displayed.assets}
                      optimized={displayed.result?.optimized || null}
                      mode={!inspectedRun && design.proposal && comparison === "current" ? "current" : mode}
                      layer={layer}
                      selectedAsset={selectedAsset}
                      onSelectAsset={setSelectedAsset}
                      autoRotate={autoRotate}
                      view={cameraView}
                      resetKey={resetKey}
                    />
                    <div className="scene-top">
                      <div>
                        <div className="scene-kicker">
                          <span className="status-dot" />
                          {!inspectedRun && design.proposal ? (comparison === "proposed" ? `PROPOSED VERSION ${design.proposal.version}` : "ACCEPTED VERSION") : mode === "optimized"
                            ? "PROPOSED CONFIGURATION"
                            : "EXISTING ENVIRONMENT"}
                        </div>
                        <div className="scene-dimension">
                          {displayed.scenario.length_ft > 0 && displayed.scenario.width_ft > 0 ? <>{number(displayed.scenario.length_ft, 1)} × {number(displayed.scenario.width_ft, 1)} <span>ft</span></> : <span>Dimensions needed</span>}
                          {displayed.crop && <small className="scene-crop-label">{displayed.crop}</small>}
                        </div>
                      </div>
                      <div className="scene-schedule">
                        <Sun size={15} />
                        <strong>
                          {activeMetrics.photoperiod_hours > 0 ? `${number(activeMetrics.photoperiod_hours, 2)} h` : "Unknown"}
                        </strong>
                        <span>light / day</span>
                      </div>
                    </div>
                    {busy && (
                      <div className="scene-progress">
                        <LoaderCircle size={17} className="spin" />
                        {busy === "scan"
                          ? "Interpreting your space"
                          : "Evaluating lighting configurations"}
                      </div>
                    )}
                    {selected && (
                      <div className="asset-callout">
                        <span className="status-dot" />
                        <div>
                          <strong>{selected.name}</strong>
                          <span>{selected.quantity} in resource model</span>
                        </div>
                        <IconButton
                          icon={X}
                          label="Clear asset selection"
                          onClick={() => setSelectedAsset(null)}
                        />
                      </div>
                    )}
                    <div className="scene-bottom">
                      <div className="scene-legend">
                        <span>
                          <i className="legend-green" />
                          Canopy
                        </span>
                        <span>
                          <i className="legend-white" />
                          Equipment
                        </span>
                        <span className="scene-source">
                          {scenario.source === "sample"
                            ? "Sample geometry"
                            : "Input-based geometry"}
                        </span>
                      </div>
                      <div className="scene-controls">
                        <IconButton
                          icon={Sun}
                          label="Light coverage layer"
                          active={layer === "light"}
                          onClick={() =>
                            setLayer((previous) =>
                              previous === "light" ? "structure" : "light",
                            )
                          }
                        />
                        <IconButton
                          icon={Layers3}
                          label="Top view"
                          active={cameraView === "top"}
                          onClick={() =>
                            setCameraView((previous) =>
                              previous === "top" ? "perspective" : "top",
                            )
                          }
                        />
                        <IconButton
                          icon={autoRotate ? Pause : Play}
                          label={autoRotate ? "Pause rotation" : "Rotate twin"}
                          onClick={() => setAutoRotate((previous) => !previous)}
                        />
                        <IconButton
                          icon={Focus}
                          label="Reset camera"
                          onClick={() => {
                            setCameraView("perspective");
                            setResetKey((previous) => previous + 1);
                          }}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="scene-strip">
                    <span>
                      <Layers3 size={14} />
                      <b>{displayed.assets.length}</b> asset groups
                    </span>
                    <span>
                      <Maximize2 size={14} />
                      {displayed.scenario.canopy_sqft > 0 ? <><b>{number(displayed.scenario.canopy_sqft)}</b> ft² canopy</> : "Canopy unknown"}
                    </span>
                    <span>
                      <ShieldCheck size={14} />
                      {scenario.source === "sample"
                        ? "Sample assumptions"
                        : scenario.confirmed
                          ? "Inputs reviewed"
                          : "Review required"}
                    </span>
                    <button onClick={() => setModal("method")}>
                      Model details
                      <ArrowRight size={13} />
                    </button>
                  </div>
                  <div className="metrics-row">
                    {displayMetric(
                      "Electricity",
                      number(activeMetrics.period_energy_kwh),
                      "kWh",
                      Zap,
                      mode === "optimized" &&
                        result?.savings
                        ? energyDifference === 0 ? "No modeled energy change" : `${number(Math.abs(result.savings.energy_pct), 1)}% ${energyDifference! > 0 ? "less" : "more"} than current`
                        : undefined,
                      undefined,
                      energyDifference === 0 ? "neutral" : energyDifference! < 0 ? "additional" : "saving",
                    )}
                    {displayMetric(
                      "Operating cost",
                      money(activeMetrics.period_energy_cost_usd),
                      "",
                      Gauge,
                      mode === "optimized" &&
                        result?.savings
                        ? costDifference === 0 ? "No modeled cost change" : `${money(Math.abs(costDifference!))} ${costDifference! > 0 ? "potential savings" : "additional cost"}`
                        : undefined,
                      undefined,
                      costDifference === 0 ? "neutral" : costDifference! < 0 ? "additional" : "saving",
                    )}
                    {displayMetric(
                      "Daily light integral",
                      activeMetrics.dli_mol_m2_day === null
                        ? "—"
                        : number(activeMetrics.dli_mol_m2_day, 1),
                      "mol/m²/day",
                      Sun,
                      undefined,
                      "Daily total",
                    )}
                    {displayMetric(
                      "Water baseline",
                      activeMetrics.period_water_liters === null
                        ? "—"
                        : number(activeMetrics.period_water_liters),
                      "L",
                      Droplets,
                    )}
                  </div>
                </section>
                <aside className="inspector">
                  <div className="inspector-heading">
                    <div>
                      <span className="eyebrow">YOUR RESOURCES</span>
                      <h2>Resource model</h2>
                    </div>
                    <IconButton
                      icon={RotateCcw}
                      label="Reload sample workspace"
                      onClick={loadSample}
                      disabled={!!busy || !!inspectedRun}
                    />
                  </div>
                  <div className="inspector-tabs">
                    <button
                      className={inspectorTab === "inputs" ? "selected" : ""}
                      onClick={() => setInspectorTab("inputs")}
                    >
                      <Settings2 size={14} />
                      Inputs
                    </button>
                    <button
                      className={inspectorTab === "inventory" ? "selected" : ""}
                      onClick={() => setInspectorTab("inventory")}
                    >
                      <Layers3 size={14} />
                      Inventory<span>{assets.length}</span>
                    </button>
                  </div>
                  <fieldset className="inspector-scroll" disabled={!!busy || !!inspectedRun || (!!design.proposal && comparison === "current")}>
                    {Object.entries(displayed.assumptions ?? {}).map(([field, assumption]) => assumption && <div className="inspector-section" key={field}>
                      <span className="eyebrow">ASSUMPTION, NOT A MEASUREMENT</span>
                      <p>{assumption.label}</p>
                      <small>{assumption.growth_stage} · {assumption.source}</small>
                    </div>)}
                    {inspectorTab === "inputs" ? (
                      renderInputs()
                    ) : (
                      <>
                        <div className="inventory-heading">
                          <span>
                            {assets.reduce(
                              (total, asset) => total + asset.quantity,
                              0,
                            )}{" "}
                            resources recorded
                          </span>
                          <IconButton
                            icon={Plus}
                            label="Add equipment"
                            onClick={() => setModal("add")}
                          />
                        </div>
                        {!assets.length && (
                          <div className="empty-inventory">
                            <Box size={30} />
                            <h3>No equipment yet</h3>
                            <button
                              className="secondary-button"
                              onClick={() => setModal("add")}
                            >
                              <Plus size={14} />
                              Add equipment
                            </button>
                          </div>
                        )}
                        {displayed.assets.map((asset) => {
                          const Icon = assetIcons[asset.type];
                          const suggested = asset.id.startsWith("scan-") || asset.id.startsWith("live-") || scan?.assets.some((item) => item.id === asset.id);
                          return (
                            <div
                              key={asset.id}
                              className={`inventory-item ${selectedAsset === asset.id ? "selected" : ""}`}
                            >
                              <button
                                className="inventory-select"
                                onClick={() =>
                                  setSelectedAsset(
                                    selectedAsset === asset.id
                                      ? null
                                      : asset.id,
                                  )
                                }
                              >
                                <span className="asset-icon">
                                  <Icon size={19} />
                                </span>
                                <span>
                                  <strong>{asset.name}</strong>
                                  <small>
                                    {scenario.source === "sample"
                                      ? "Sample inventory"
                                      : suggested
                                        ? `AI suggestion · ${asset.confirmed ? "user confirmed" : "review required"}`
                                        : "Entered inventory"}
                                  </small>
                                </span>
                              </button>
                              {asset.confidence !== null && (
                                <small className="inventory-confidence">{Math.round(asset.confidence * 100)}% model confidence</small>
                              )}
                              <label className="inventory-name field">
                                <span>Name</span>
                                <input
                                  aria-label={`${asset.name} name`}
                                  value={asset.name}
                                  maxLength={80}
                                  onChange={(event) => updateAssets(assets.map((item) =>
                                    item.id === asset.id ? { ...item, name: event.target.value } : item,
                                  ))}
                                />
                              </label>
                              <div className="inventory-edit">
                                <label>
                                  Quantity
                                  <input
                                    type="number"
                                    min={1}
                                    max={
                                      asset.type === "light_fixture"
                                        ? 100
                                        : 10000
                                    }
                                    value={asset.quantity}
                                    aria-label={`${asset.name} quantity`}
                                    onChange={(event) => {
                                      const q = Number(event.target.value);
                                      if (
                                        q >= 1 &&
                                        q <=
                                          (asset.type === "light_fixture"
                                            ? 100
                                            : 10000) &&
                                        Number.isInteger(q)
                                      )
                                        updateAssets(
                                          assets.map((item) =>
                                            item.id === asset.id
                                              ? { ...item, quantity: q }
                                              : item,
                                          ),
                                        );
                                    }}
                                  />
                                </label>
                                <IconButton
                                  icon={Trash2}
                                  label={`Remove ${asset.name}`}
                                  onClick={() =>
                                    updateAssets(
                                      assets.filter(
                                        (item) => item.id !== asset.id,
                                      ),
                                    )
                                  }
                                />
                              </div>
                            </div>
                          );
                        })}
                        {imageUrl && !inspectedRun && (
                          <button
                            className="source-image"
                            onClick={() => setModal("scan")}
                          >
                            <img
                              src={imageUrl}
                              alt="Uploaded growing environment"
                            />
                            <span>
                              <Camera size={14} />
                              View source image
                              <ArrowRight size={13} />
                            </span>
                          </button>
                        )}
                      </>
                    )}
                  </fieldset>
                  <div className="inspector-footer">
                    {liveOpen && scenario.source === "sample" && <label className="confirm-inputs"><input type="checkbox" checked={displayed.scenario.confirmed} disabled={!!busy || !!inspectedRun || (!!design.proposal && comparison === "current")} onChange={event => {
                      const confirmed = event.target.checked;
                      setScenario(previous => ({ ...previous, confirmed }));
                      setAssets(previous => previous.map(asset => ({ ...asset, confirmed })));
                      if (!confirmed) invalidate();
                    }} /><span>I reviewed these sample assumptions for Live.</span></label>}
                    {scenario.source === "sample" ? (
                      <div className="sample-notice">
                        <FlaskConical size={15} />
                        <span>Sample data · assumed measurements</span>
                      </div>
                    ) : (
                      <label className="confirm-inputs">
                        <input
                          type="checkbox"
                          checked={displayed.scenario.confirmed}
                          onChange={(event) => {
                            const confirmed = event.target.checked;
                            setScenario((previous) => ({
                              ...previous,
                              confirmed,
                            }));
                            setAssets(previous => previous.map(asset => ({ ...asset, confirmed })));
                            if (!confirmed) invalidate();
                          }}
                          disabled={!!busy || !!inspectedRun || (!!design.proposal && comparison === "current")}
                        />
                        <span>I reviewed the inventory and entered inputs.</span>
                      </label>
                    )}
                    <button
                      className="primary-button full-width"
                      onClick={() => void optimize()}
                      disabled={!!busy || !!inspectedRun}
                    >
                      {busy === "optimize" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      {simulationLabel}
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </aside>
              </div>
              <section className="insights">
                <div className="insights-heading">
                  <div>
                    <div className="eyebrow">
                      OPTIMIZE FIRST. PURCHASE SECOND.
                    </div>
                    <h2>
                      {result?.optimized
                        ? unchangedSetting ? "Current setting retained." : energyDifference! < 0 ? "A constraint-feasible operating plan." : energyDifference === 0 ? "An alternative operating plan." : "A lower-energy operating plan."
                        : "More possibility. Same equipment."}
                    </h2>
                  </div>
                  {result && (
                    <button
                      className="text-button"
                      onClick={() => setView("scenarios")}
                    >
                      Explore {result.configurations_evaluated} scenarios
                      <ArrowRight size={15} />
                    </button>
                  )}
                </div>
                <div className="insight-columns">
                  <div className="insight-main">
                    <span className="insight-symbol">
                      <Sparkles size={22} />
                    </span>
                    <div>
                      <h3>
                        {result?.optimized
                          ? `${number(result.optimized.photoperiod_hours, 2)} hours. ${Math.round(result.optimized.dim_fraction * 100)}% output.`
                          : "Start with what’s already here."}
                      </h3>
                      <p>
                        {result?.optimized
                          ? result.recommendations[0]
                          : "Your existing fixtures, your measured space, your operating limits. Find the lighting schedule with the lowest modeled energy use."}
                      </p>
                    </div>
                  </div>
                  <div className="insight-fact">
                    <span className="muted">
                      {result?.optimized
                        ? "Feasible configurations"
                        : "Current canopy coverage"}
                    </span>
                    <strong>
                      {result?.optimized
                        ? `${result.feasible_configurations} / ${result.configurations_evaluated}`
                        : scenario.length_ft > 0 && scenario.width_ft > 0 && scenario.canopy_sqft > 0 ? `${number((scenario.canopy_sqft / (scenario.length_ft * scenario.width_ft)) * 100)}%` : "Unknown"}
                      <span>
                        {result?.optimized
                          ? "meet your constraints"
                          : "of floor footprint"}
                      </span>
                    </strong>
                  </div>
                  <div className="insight-fact">
                    <span className="muted">
                      {result?.optimized
                        ? "New equipment in this scenario"
                        : "Current light dose"}
                    </span>
                    <strong>
                      {result?.optimized
                        ? "$0"
                        : baseline.dli_mol_m2_day === null
                          ? "Unknown"
                          : number(baseline.dli_mol_m2_day, 1)}
                      <span>
                        {result?.optimized
                          ? "existing fixtures only"
                          : "mol/m²/day · modeled"}
                      </span>
                    </strong>
                  </div>
                </div>
              </section>
              <ResultExplanation saved={selectedCalculation} earlier={!!inspectedRun || isEarlierRun({ ...design, saved_run: selectedCalculation })}
                inputRecords={history.find(run => run.id === selectedCalculation?.reference.id)?.inputRecords}
                assumptions={history.find(run => run.id === selectedCalculation?.reference.id)?.assumptions}
                error={explanationStatus?.status !== "ok" && (!explanationStatus?.run_id || explanationStatus.run_id === selectedCalculation?.reference.id) ? explanationStatus?.message : null} />
            </>
          )}
          {view === "scenarios" && <div className="scenario-view-tabs segmented" role="tablist" aria-label="Scenario modules">
            <button role="tab" aria-selected={scenarioView === "lighting"} className={scenarioView === "lighting" ? "selected" : ""} onClick={() => setScenarioView("lighting")}><Sun size={15} />Lighting settings</button>
            <button role="tab" aria-selected={scenarioView === "site"} className={scenarioView === "site" ? "selected" : ""} onClick={() => setScenarioView("site")}><Layers3 size={15} />Site plans</button>
          </div>}
          <SiteScenarioComparison visible={siteView} onSites={receiveSites} openRequest={siteOpenRequest} onOpened={siteOpened} onEarth={() => setView("earth")} />
          <EarthView visible={earthView} sites={earthSites} opening={!!siteOpenRequest} openError={siteOpenError}
            onSitePlans={() => { setView("scenarios"); setScenarioView("site"); }}
            onCreateSite={(name, point) => { siteOpenTarget.current = "earth"; setSiteOpenError(null); setSiteOpenRequest({ requestId: ++siteOpenSerial.current, action: "create", name, point }); }}
            onSelectSite={siteId => { siteOpenTarget.current = "earth"; setSiteOpenError(null); setSiteOpenRequest({ requestId: ++siteOpenSerial.current, action: "selectSite", siteId }); }}
            onSelectComparison={(siteId, comparisonId) => { siteOpenTarget.current = "earth"; setSiteOpenError(null); setSiteOpenRequest({ requestId: ++siteOpenSerial.current, action: "selectComparison", siteId, comparisonId }); }}
            onOpenPlans={(siteId, createPlan) => { siteOpenTarget.current = "plans"; setSiteOpenError(null); setSiteOpenRequest({ requestId: ++siteOpenSerial.current, action: createPlan ? "createPlan" : "working", siteId }); }}
            onOpenComparison={(siteId, comparisonId) => { siteOpenTarget.current = "plans"; setSiteOpenError(null); setSiteOpenRequest({ requestId: ++siteOpenSerial.current, siteId, comparisonId }); }} />
          {view === "scenarios" && scenarioView === "lighting" && (
            <section className="data-view">
              <div className="view-intro">
                <div>
                  <FlaskConical size={20} />
                  <h2>
                    {result
                      ? `${result.configurations_evaluated} configurations evaluated`
                      : "Your next operating plan starts here"}
                  </h2>
                </div>
                {result && (
                  <div className="export-actions">
                    <button
                      className="secondary-button"
                      onClick={() => exportReport("csv")}
                    >
                      <ArrowDownToLine size={15} />
                      CSV
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => exportReport("json")}
                    >
                      <ArrowDownToLine size={15} />
                      JSON
                    </button>
                  </div>
                )}
              </div>
              {result?.candidates.length ? (
                <>
                  <div className="scenario-overview">
                    <div>
                      <span>Search space</span>
                      <strong>{result.configurations_evaluated}</strong>
                      <small>settings tested</small>
                    </div>
                    <div>
                      <span>Within constraints</span>
                      <strong className="green-text">
                        {result.feasible_configurations}
                      </strong>
                      <small>feasible configurations</small>
                    </div>
                    <div>
                      <span>Lowest modeled use</span>
                      <strong>
                        {result.optimized
                          ? number(result.optimized.daily_energy_kwh, 2)
                          : "—"}
                        <small> kWh/day</small>
                      </strong>
                      <small>existing equipment</small>
                    </div>
                  </div>
                  <div className="chart-heading">
                    <span>Energy vs. daily light integral</span>
                    <div className="scene-legend">
                      <span>
                        <i className="legend-green" />
                        Feasible
                      </span>
                      <span>
                        <i className="legend-gray" />
                        Outside constraints
                      </span>
                    </div>
                  </div>
                  <ScenarioPlot result={result} minDli={scenario.min_dli} />
                  <div className="table-toolbar">
                    <h3>Configuration ledger</h3>
                    <div className="segmented">
                      <button
                        className={filter === "feasible" ? "selected" : ""}
                        onClick={() => setFilter("feasible")}
                      >
                        Feasible
                      </button>
                      <button
                        className={filter === "all" ? "selected" : ""}
                        onClick={() => setFilter("all")}
                      >
                        All tested
                      </button>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Configuration</th>
                          <th>Schedule</th>
                          <th>Output</th>
                          <th>DLI</th>
                          <th>Energy / day</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.candidates
                          .filter((c) => filter === "all" || c.feasible)
                          .sort(
                            (a, b) => a.daily_energy_kwh - b.daily_energy_kwh,
                          )
                          .map((candidate) => {
                            const best =
                              result.optimized?.photoperiod_hours ===
                                candidate.photoperiod_hours &&
                              result.optimized?.dim_fraction ===
                                candidate.dim_fraction;
                            return (
                              <tr
                                key={candidateId(candidate)}
                                data-candidate-id={candidateId(candidate)}
                                className={best ? "best-row" : ""}
                              >
                                <td>
                                  <span className="config-id">
                                    {candidateId(candidate)}
                                  </span>
                                  {best && (
                                    <span className="best-tag">
                                      <Sparkles size={11} />
                                      Proposed
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {number(candidate.photoperiod_hours, 2)} h
                                </td>
                                <td>
                                  {Math.round(candidate.dim_fraction * 100)}%
                                </td>
                                <td>
                                  {number(candidate.dli_mol_m2_day || 0, 2)}
                                </td>
                                <td>
                                  {number(candidate.daily_energy_kwh, 3)} kWh
                                </td>
                                <td>
                                  <span
                                    className={
                                      candidate.feasible
                                        ? "feasible"
                                        : "rejected"
                                    }
                                  >
                                    {candidate.feasible ? (
                                      <>
                                        <Check size={13} />
                                        Feasible
                                      </>
                                    ) : (
                                      candidate.rejected_for
                                        .map((reason) =>
                                          reason.replaceAll("_", " "),
                                        )
                                        .join(", ")
                                    )}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <FlaskConical size={42} />
                  <h3>
                    {result
                      ? "Measurements needed"
                      : "Make room for a better scenario."}
                  </h3>
                  <p>
                    {result?.recommendations[0] ||
                      "Run a simulation with your resource model to compare operating schedules."}
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => {
                      setView("workspace");
                      setInspectorTab("inputs");
                    }}
                  >
                    <ArrowLeft size={16} />
                    Return to workspace
                  </button>
                </div>
              )}
              {history.length > 0 && (
                <div className="history">
                  <div className="table-toolbar">
                    <h3>Recent runs</h3>
                    <span className="muted">{history.length} {storageError ? "in this session; saving unavailable" : "saved on this device"}</span>
                    <IconButton icon={ArrowDownToLine} label="Export local history" onClick={exportLocalHistory} />
                  </div>
                  <p className="history-notice">No automatic deletion. Browser storage has limited capacity and can be cleared; this is not a durable cloud archive. Export important runs.</p>
                  {[...history].sort((a, b) => Number(!!b.important) - Number(!!a.important)).map((run) => (
                    <div className="history-entry" key={run.id} data-run-id={run.id}>
                    <button
                      className="history-row"
                      disabled={!!busy}
                      aria-pressed={inspectedRunId === run.id}
                      onClick={() => inspectRun(run)}
                    >
                      <Clock3 size={16} />
                      <div>
                        <strong>{run.name}</strong>
                        <span>{new Date(run.at).toLocaleString()}</span>
                        <span>{run.scenario.length_ft} × {run.scenario.width_ft} ft · {run.scenario.baseline_hours} h baseline · {run.scenario.operating_days} days</span>
                        <code>{run.result.run?.id ?? run.id}</code>
                      </div>
                      <span>{run.result.configurations_evaluated} tested</span>
                      <span className={run.result.savings && run.result.savings.period_energy_cost_usd > 0 ? "green-text" : ""}>
                        {run.result.savings ? run.result.savings.period_energy_cost_usd === 0 ? "No cost change"
                          : `${money(Math.abs(run.result.savings.period_energy_cost_usd))} ${run.result.savings.period_energy_cost_usd > 0 ? "less cost" : "additional cost"}` : "No savings estimate"}
                      </span>
                      <ChevronRight size={16} />
                    </button>
                    <IconButton icon={Star} label={run.important ? "Unmark important run" : "Mark important run"} active={!!run.important}
                      onClick={() => setHistory(previous => previous.map(item => item.id === run.id ? { ...item, important: !item.important } : item))} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {view === "impact" && (
            <section className="data-view impact-view">
              {result?.optimized && result.savings ? (
                <>
                  <div className="impact-lead">
                    <div>
                      <div className="eyebrow">
                        {forecastSites} {forecastSites === 1 ? "SITE" : "EQUIVALENT SITES"} · {scenario.operating_days}-DAY MODELED OPPORTUNITY
                      </div>
                      <h2>
                        {energyDifference === 0 ? "No modeled electricity change." : result.savings.energy_pct > 0
                          ? `${number(result.savings.energy_pct, 1)}% less electricity.`
                          : `${number(Math.abs(result.savings.energy_pct), 1)}% more electricity required.`}
                      </h2>
                      <p>
                        {unchangedSetting ? "Your current setting is already lowest among the tested feasible settings. No operating change is proposed." : energyDifference === 0 ? "A different setting with no energy difference at the reported precision."
                          : result.savings.energy_pct > 0 ? "An operating change, using the fixtures you already have."
                          : "The current setting does not meet all entered requirements."}
                      </p>
                    </div>
                    <button
                      className="secondary-button"
                      onClick={() => exportReport("json")}
                    >
                      <ArrowDownToLine size={15} />
                      Export report
                    </button>
                  </div>
                  <div className="impact-stats">
                    <div>
                      <Zap size={21} />
                      <strong>
                        {number(
                          Math.abs(result.savings.period_energy_kwh) * forecastSites,
                        )}
                        <span>kWh</span>
                      </strong>
                      <span>
                        {energyDifference === 0 ? "no modeled electricity change" : result.savings.period_energy_kwh > 0
                          ? "potential electricity savings"
                          : "additional electricity required"}
                      </span>
                    </div>
                    <div>
                      <Gauge size={21} />
                      <strong>
                        {money(
                          Math.abs(result.savings.period_energy_cost_usd) * forecastSites,
                        )}
                      </strong>
                      <span>{costDifference === 0 ? "no modeled cost change" : costDifference! > 0 ? "potential electricity-cost savings" : "additional electricity cost"}</span>
                    </div>
                    <div>
                      <Layers3 size={21} />
                      <strong>$0</strong>
                      <span>new equipment added to scenario</span>
                    </div>
                  </div>
                  <div className="comparison">
                    <div>
                      <h3>Current vs. proposed · per site</h3>
                      <p>
                        {scenario.operating_days} operating days · $
                        {number(scenario.electricity_usd_kwh, 3)} per kWh
                      </p>
                    </div>
                    <ComparisonRow
                      name="Electricity"
                      before={baseline.period_energy_kwh}
                      after={result.optimized.period_energy_kwh}
                      format={(v) => `${number(v)} kWh`}
                    />
                    <ComparisonRow
                      name="Operating cost"
                      before={baseline.period_energy_cost_usd}
                      after={result.optimized.period_energy_cost_usd}
                      format={money}
                    />
                    <ComparisonRow
                      name="Daily light integral"
                      before={baseline.dli_mol_m2_day || 0}
                      after={result.optimized.dli_mol_m2_day || 0}
                      format={(v) => `${number(v, 2)} mol/m²/day`}
                    />
                  </div>
                  <div className="scale-section">
                    <div>
                      <h3>Explore a multi-site scenario</h3>
                      <p>
                        Assumes identical equipment, measurements and operating
                        conditions at every site.
                      </p>
                    </div>
                    <label className="scale-control">
                      <span>
                        Equivalent sites<strong>{forecastSites}</strong>
                      </span>
                      <input
                        aria-label="Equivalent sites"
                        type="range"
                        min={1}
                        max={100}
                        value={forecastSites}
                        onChange={(event) =>
                          setForecastSites(Number(event.target.value))
                        }
                      />
                    </label>
                  </div>
                  <div className="recommendations">
                    <h3>From scenario to action</h3>
                    {result.recommendations.map((recommendation, i) => (
                      <div key={recommendation}>
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <p>{recommendation}</p>
                      </div>
                    ))}
                  </div>
                  <div className="model-boundary">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>Estimates you can inspect.</strong>
                      <p>
                        Water savings, yield gains and avoided purchases are not
                        estimated. The twin represents your entered inventory;
                        it is not a measured reconstruction. Verify power, light
                        distribution and crop response before adopting the
                        proposed schedule.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => setModal("method")}
                    >
                      Methodology
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <Activity size={42} />
                  <h3>Every change should earn its place.</h3>
                  <p>
                    Complete a feasible simulation to see the modeled resource
                    impact.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => setView("workspace")}
                  >
                    <ArrowLeft size={16} />
                    Return to workspace
                  </button>
                </div>
              )}
            </section>
          )}
          <footer className="page-footer">
            <span>
              <CheckCheck size={13} />
              {savingState}
            </span>
            <span>
              Resource intelligence
              <i />
              AcreIQ
            </span>
            <button onClick={() => setModal("method")}>
              Modeled estimates
              <CircleHelp size={12} />
            </button>
          </footer>
        </main>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <input
        ref={cameraInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <div
            className={`modal ${modal === "scan" ? "scan-modal" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            ref={modalRef}
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">ACREIQ WORKSPACE</div>
                <h2 id="modal-title">
                  {modal === "scan"
                    ? "Bring your space into view."
                    : modal === "method"
                      ? "A model you can inspect."
                      : modal === "add"
                        ? "Add an existing resource"
                        : "Your workspace"}
                </h2>
              </div>
              <IconButton
                icon={X}
                label="Close dialog"
                onClick={() => setModal(null)}
                disabled={!!busy}
              />
            </div>
            {modal === "scan" && (
              <>
                <div className="vision-state">
                  <span
                    className={`status-dot ${simulationOnline && health?.vision_available && visionTest === "succeeded" ? "" : "amber"}`}
                  />
                  <span>
                    {visionLabel}. {visionDetail}
                  </span>
                </div>
                <div
                  className={`upload-area ${imageUrl ? "has-image" : ""}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void upload(event.dataTransfer.files[0]);
                  }}
                >
                  {imageUrl ? (
                    <img src={imageUrl} alt="Your growing environment" />
                  ) : (
                    <>
                      <span className="upload-symbol">
                        <ScanLine size={38} strokeWidth={1} />
                      </span>
                      <h3>A new perspective on your space.</h3>
                      <p>Drop a photo of your growing environment</p>
                      <span className="muted">
                        JPG, PNG or WebP · up to 10 MB
                      </span>
                    </>
                  )}
                  {busy === "scan" && (
                    <div className="upload-scanning">
                      <div className="scan-line" />
                      <LoaderCircle size={26} className="spin" />
                      <span>Analyzing visible resources</span>
                    </div>
                  )}
                </div>
                <div className="upload-actions">
                  <button
                    className="secondary-button"
                    onClick={() => cameraInput.current?.click()}
                    disabled={!!busy}
                  >
                    <Camera size={16} />
                    Take a photo
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => fileInput.current?.click()}
                    disabled={!!busy}
                  >
                    <Upload size={16} />
                    {imageUrl ? "Choose another photo" : "Choose photo"}
                  </button>
                </div>
                {error && (
                  <div className="modal-error" role="alert">
                    {error}
                  </div>
                )}
                {scan && (
                  <div className="scan-results">
                    <h3>
                      {scan.source === "gemini"
                        ? `${scan.assets.length} AI-suggested resource groups`
                        : "Ready for manual inventory"}
                    </h3>
                    {scan.source === "gemini" && (
                      <p>AI suggestions, not confirmed measurements. Review names and quantities; enter dimensions, electrical load and crop-light measurements separately.</p>
                    )}
                    {[...scan.observations, ...scan.warnings].map((item, i) => (
                      <p key={i}>{item}</p>
                    ))}
                    <button
                      className="primary-button full-width"
                      onClick={() => {
                        setModal(null);
                        setView("workspace");
                        setInspectorTab("inventory");
                      }}
                    >
                      Review resource model
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )}
                {!health?.vision_available && !scan && (
                  <p className="scan-note">
                    Connect a Gemini API key on the server for image-assisted
                    inventory. Electrical load, dimensions and crop requirements
                    need your measurements.
                  </p>
                )}
                <button className="secondary-button full-width" onClick={startManual} disabled={!!busy}>
                  <Settings2 size={15} />
                  Start manually
                </button>
                {!imageUrl && (
                  <button
                    className="text-button sample-link"
                    onClick={loadSample}
                  >
                    Open sample space instead
                    <ArrowRight size={14} />
                  </button>
                )}
              </>
            )}
            {modal === "method" && (
              <div className="method-content">
                <div className="method-version">
                  <ShieldCheck size={18} />
                  <strong>
                    {result?.model_version || "Lighting scenario model"}
                  </strong>
                </div>
                <p>
                  Gemini identifies visible equipment. Your reviewed
                  measurements define the scenario. A finite Python search
                  evaluates lighting schedules and, for dimmable fixtures,
                  output levels.
                </p>
                <div className="formula">
                  <span>Electricity / day</span>
                  <code>
                    (light W × output × hours + other W × hours) / 1,000
                  </code>
                  <span>Daily light integral</span>
                  <code>PPFD × output × light hours × 0.0036</code>
                </div>
                <p>
                  The proposed setting has the lowest modeled energy use among
                  settings meeting your photoperiod, minimum DLI and power
                  constraints. Dimming assumes linear power and light output.
                </p>
                <ul>
                  {(
                    result?.limitations || [
                      "Savings are estimates, not measured outcomes or crop-yield forecasts.",
                      "A photo cannot provide calibrated dimensions, wattage or canopy PPFD.",
                      "Only entered equipment loads are included. HVAC and demand charges may change costs.",
                      "Water, yield, airflow, avoided purchases and physical layout optimization are not modeled.",
                      "The 3D twin is an inventory schematic, not a measured reconstruction.",
                    ]
                  ).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <button
                  className="secondary-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        JSON.stringify({ scenario, result }, null, 2),
                      );
                      setToast("Model inputs copied");
                    } catch {
                      setToast(
                        "Clipboard unavailable. Use report export instead.",
                      );
                    }
                  }}
                >
                  <Copy size={15} />
                  Copy model inputs
                </button>
              </div>
            )}
            {modal === "workspace" && (
              <div className="workspace-settings">
                <label className="field">
                  <span>Space name</span>
                  <input
                    className="name-input"
                    maxLength={60}
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                  />
                </label>
                <div className="workspace-summary">
                  <Sprout size={24} />
                  <div>
                    <strong>{workspaceName || "Untitled space"}</strong>
                    <span>
                      {number(scenario.length_ft)} × {number(scenario.width_ft)}{" "}
                      ft · {assets.length} asset groups
                    </span>
                  </div>
                </div>
                <button
                  className="secondary-button full-width"
                  onClick={loadSample}
                >
                  <RotateCcw size={15} />
                  Load sample workspace
                </button>
                <button
                  className="primary-button full-width"
                  onClick={() => setModal("scan")}
                >
                  <Plus size={15} />
                  Start from a photo
                </button>
                <button className="secondary-button full-width" onClick={startManual} disabled={!!busy}>
                  <Settings2 size={15} />
                  Start manually
                </button>
                <p className="muted">
                  Workspace inputs and recent runs are stored on this device.
                  Uploaded photos remain in this session.
                </p>
              </div>
            )}
            {modal === "add" && (
              <div className="add-asset-options">
                {(
                  Object.entries(assetNames) as [TwinAsset["type"], string][]
                ).map(([type, name]) => {
                  const Icon = assetIcons[type];
                  return (
                    <button
                      key={type}
                      onClick={() => {
                        updateAssets([
                          ...assets,
                          {
                            id: crypto.randomUUID(),
                            name,
                            type,
                            quantity: 1,
                            confidence: null,
                            confirmed: true,
                          },
                        ]);
                        setModal(null);
                        setInspectorTab("inventory");
                      }}
                    >
                      <Icon size={22} />
                      <span>{name}</span>
                      <Plus size={16} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ComparisonRow({
  name,
  before,
  after,
  format,
}: {
  name: string;
  before: number;
  after: number;
  format: (value: number) => string;
}) {
  const max = Math.max(before, after, 1);
  return (
    <div className="comparison-row">
      <h4>{name}</h4>
      <div className="comparison-bars">
        <div>
          <span>Current</span>
          <div className="bar-track">
            <div
              className="bar-current"
              style={{ width: `${(before / max) * 100}%` }}
            />
          </div>
          <strong>{format(before)}</strong>
        </div>
        <div>
          <span>Proposed</span>
          <div className="bar-track">
            <div
              className="bar-proposed"
              style={{ width: `${(after / max) * 100}%` }}
            />
          </div>
          <strong>{format(after)}</strong>
        </div>
      </div>
    </div>
  );
}
function ScenarioPlot({
  result,
  minDli,
}: {
  result: OptimizationResult;
  minDli: number | null;
}) {
  const candidates = result.candidates;
  const maxX =
    Math.max(...candidates.map((c) => c.dli_mol_m2_day || 0), minDli || 0, 1) *
    1.12;
  const maxY = Math.max(...candidates.map((c) => c.daily_energy_kwh), 1) * 1.12;
  const x = (value: number) => 58 + (value / maxX) * 880;
  const y = (value: number) => 234 - (value / maxY) * 194;
  return (
    <div className="plot">
      <svg
        viewBox="0 0 980 278"
        role="img"
        aria-label="Tested configurations, showing energy use against daily light integral"
      >
        <rect width="980" height="278" fill="transparent" />
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line
              x1="58"
              y1={y((maxY * i) / 4)}
              x2="938"
              y2={y((maxY * i) / 4)}
              stroke="#29332f"
              strokeDasharray="3 6"
            />
            <text
              x="46"
              y={y((maxY * i) / 4) + 4}
              textAnchor="end"
              fill="#8b9891"
              fontSize="11"
            >
              {number((maxY * i) / 4, 1)}
            </text>
            <text
              x={x((maxX * i) / 4)}
              y="257"
              textAnchor="middle"
              fill="#8b9891"
              fontSize="11"
            >
              {number((maxX * i) / 4, 1)}
            </text>
          </g>
        ))}
        {minDli && (
          <g>
            <line
              x1={x(minDli)}
              x2={x(minDli)}
              y1="24"
              y2="234"
              stroke="#9ddb75"
              opacity="0.55"
              strokeDasharray="5 5"
            />
            <text x={x(minDli) + 8} y="25" fill="#b6d69b" fontSize="11">
              Minimum DLI
            </text>
          </g>
        )}
        {candidates.map((c) => (
          <circle
            key={`${c.photoperiod_hours}-${c.dim_fraction}`}
            cx={x(c.dli_mol_m2_day || 0)}
            cy={y(c.daily_energy_kwh)}
            r="3.3"
            fill={c.feasible ? "#b1e685" : "#58625b"}
            opacity="0.8"
          >
            <title>
              {c.photoperiod_hours}h at {c.dim_fraction * 100}%:{" "}
              {number(c.daily_energy_kwh, 3)} kWh,{" "}
              {c.feasible ? "feasible" : c.rejected_for.join(", ")}
            </title>
          </circle>
        ))}
        {result.optimized && (
          <circle
            cx={x(result.optimized.dli_mol_m2_day || 0)}
            cy={y(result.optimized.daily_energy_kwh)}
            r="7"
            fill="none"
            stroke="#d6ffbc"
            strokeWidth="2"
          />
        )}
        <text x="58" y="17" fill="#8b9891" fontSize="11">
          kWh / day
        </text>
        <text x="938" y="275" textAnchor="end" fill="#8b9891" fontSize="11">
          Daily light integral (mol/m²/day)
        </text>
      </svg>
    </div>
  );
}
