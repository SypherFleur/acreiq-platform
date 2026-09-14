import type { SiteComparisonRequest, SiteCost, SiteCostCategory, SiteEvidence, SiteLighting, SiteOperation, SiteScenario } from "./site-types";
import { validateSiteComparisonRequest, validateSitePlanDraft } from "./site-comparison-storage";
export { activateSiteWorking, withSiteWorking } from "./site-comparison-storage";

type OperationNumbers = "horizon_days" | "cycle_days" | "completed_cycles" | "turnover_days" | "idle_days";
type LightingNumbers = "hours_per_day" | "dim_fraction" | "min_hours" | "max_hours";
export type SiteOperationDraft = Omit<SiteOperation, OperationNumbers> & Record<OperationNumbers, number | null>;
export type SiteLightingDraft = Omit<SiteLighting, LightingNumbers> & Record<LightingNumbers, number | null>;
export type SiteScenarioDraft = Omit<SiteScenario, "lighting"> & { lighting: SiteLightingDraft };
export type SitePlanDraft = Omit<SiteComparisonRequest, "operation" | "scenarios"> & { operation: SiteOperationDraft; scenarios: SiteScenarioDraft[] };
export type SiteDraftConversion = { ok: true; value: SiteComparisonRequest } | { ok: false; message: string; missing: string[] };

const newId = (kind: string) => `${kind}-${globalThis.crypto.randomUUID()}`;
function unreviewedEvidence(note: string): SiteEvidence {
  return { id: newId("evidence"), version: 1, source: "user_assumption", entry_route: "manual", note: `Unreviewed: ${note}`, recorded_at: null, instrument: null, conditions: null, uncertainty: null };
}

/** A local planning identity, not a measured site, parcel boundary, or ownership claim. */
export function createPlanningSite(name: string): SitePlanDraft {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 600) throw new Error("Enter a planning site name between 1 and 600 characters.");
  const siteId = newId("site");
  return {
    site: { id: siteId, revision: 1, name: cleanName, boundary_id: newId("boundary"), boundary_revision: 1, length_ft: null, width_ft: null, canopy_sqft: null, included_spaces: [], excluded_spaces: [], excluded_costs: [], evidence: unreviewedEvidence("Planning site only; dimensions and included spaces are unknown. No parcel boundary or ownership is established.") },
    assets: [],
    operation: { id: newId("operation"), revision: 1, site_id: siteId, operation_type: "indoor_leafy_greens", operation_schema_version: 1, name: "Indoor leafy greens (unreviewed scope)", crop: null, cultivar: null, method: null, start_stage: null, end_stage: null, product_definition: "", output_unit: "kg_net_marketable_fresh", horizon_days: null, cycle_days: null, completed_cycles: null, turnover_days: null, idle_days: null, identical_cycles: false, starts_per_cycle: null, temperature_c: null, humidity_pct: null, co2_ppm: null, ph: null, ec_ms_cm: null, nutrient_protocol: null, protocol_version: 1, evidence: unreviewedEvidence("Indoor leafy greens is the only supported operation, not a whole-farm model. Cycle settings, product definition, and conditions require review; identical cycles is an unreviewed setting.") },
    scenarios: [],
    goal: { id: newId("goal"), version: 1, metric: "energy_kwh", direction: "minimize", secondary: [] },
    limits: ([ ["dli", "mol/m^2/day"], ["peak_watts", "W"], ["lighting_hours", "h/day"] ] as const).map(([metric, unit]) => ({
      id: newId("limit"), version: 1, metric, unit, minimum: null, maximum: null, enabled: true, reason: null,
      evidence: unreviewedEvidence("No site-wide requirement supplied. Enter reviewed bounds or explicitly disable this requirement; a missing bound is not a constraint pass."),
    })), review: null, prior_comparison_id: null,
  };
}

const costBases: Record<SiteCostCategory, SiteCost["basis"]> = {
  electricity: "kwh", water: "liter", routine_labor: "routine_hour", consumables: "cycle", maintenance: "cycle", new_equipment: "horizon", setup_labor: "setup_hour", setup_materials: "horizon",
};

/** Idempotent; never replaces an existing current plan or borrows sample measurements. */
export function createCurrentSitePlan(draft: SitePlanDraft): SitePlanDraft {
  const checked = validateSitePlanDraft(draft);
  if (!checked.ok) throw new Error(checked.message);
  const next = checked.value;
  if (next.scenarios.some(scenario => scenario.role === "current")) return next;
  const costs = (Object.entries(costBases) as [SiteCostCategory, SiteCost["basis"]][]).map(([category, basis]): SiteCost => ({
    id: newId("cost"), version: 1, category, status: "unknown", basis, rate: null, amount: null, component_ids: [newId("expense")], asset_ids: [], reason: "Unreviewed: cost is unknown, not zero or excluded.", evidence: unreviewedEvidence("No cost supplied; amount, scope and ownership require review."),
  }));
  next.scenarios.push({ id: newId("plan"), revision: 1, name: "Current plan", role: "current", site_revision: next.site.revision, operation_revision: next.operation.revision,
    lighting: { hours_per_day: null, dim_fraction: null, dimmable: false, ppfd_full: null, ppfd_basis: null, min_dli: null, min_hours: null, max_hours: null, power_limit_watts: null },
    loads: [], water_liters_day: null, routine_labor_hours_cycle: null, setup_labor_hours: null, costs, benchmark: null,
    change_description: "Unreviewed: blank current plan; no sample values or output benchmark.", evidence: unreviewedEvidence("Lighting, including the dimmable setting, loads, costs and operating assumptions require review. No measurements are supplied."),
  });
  next.review = null;
  next.prior_comparison_id = null;
  return next;
}

/** Structural readiness only. Null PPFD, benchmarks and costs remain unknown to the engine. */
export function siteDraftMissingFields(draft: SitePlanDraft): string[] {
  const checked = validateSitePlanDraft(draft);
  if (!checked.ok) return [checked.message];
  const missing: string[] = [];
  if (!draft.assets.length) missing.push("assets (at least one explicitly accounted asset)");
  if (draft.scenarios.length < 2) missing.push("scenarios (one current plan and at least one alternative)");
  if (!draft.operation.product_definition.trim()) missing.push("operation.product_definition");
  for (const field of ["horizon_days", "cycle_days", "completed_cycles", "turnover_days", "idle_days"] as const) {
    if (draft.operation[field] === null) missing.push(`operation.${field}`);
  }
  for (const [index, scenario] of draft.scenarios.entries()) {
    for (const field of ["hours_per_day", "dim_fraction", "min_hours", "max_hours"] as const) {
      if (scenario.lighting[field] === null) missing.push(`scenarios[${index}].lighting.${field}`);
    }
    if (!scenario.loads.length || scenario.loads.length !== draft.assets.length) missing.push(`scenarios[${index}].loads (one accounting assignment per asset)`);
    if (!scenario.loads.some(load => load.accounting === "lighting")) missing.push(`scenarios[${index}].loads (at least one lighting component)`);
  }
  if (!missing.length) {
    const strict = validateSiteComparisonRequest(draft);
    if (!strict.ok) missing.push(strict.message);
  }
  return missing;
}

export function toSiteComparisonRequest(draft: SitePlanDraft): SiteDraftConversion {
  const missing = siteDraftMissingFields(draft);
  if (missing.length) return { ok: false, message: "Complete or correct the required planning inputs before evaluation.", missing };
  const result = validateSiteComparisonRequest(draft);
  return result.ok ? result : { ok: false, message: result.message, missing: [result.message] };
}
