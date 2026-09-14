import type { SiteComparisonRequest, SiteInputs, SiteScenario } from "./site-types";
import type { SitePlanDraft } from "./site-drafts";
export { siteBenchmarkContext as benchmarkContext } from "./site-types";
import type { Scenario, TwinAsset } from "./types";

export function siteInputs<T extends SitePlanDraft>(request: T): Omit<T, "review" | "prior_comparison_id"> {
  const { review: _review, prior_comparison_id: _prior, ...inputs } = request;
  return inputs;
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
  return value;
}
export const sameSiteInputs = (a: SiteInputs | Omit<SitePlanDraft, "review" | "prior_comparison_id">, b: SiteInputs | Omit<SitePlanDraft, "review" | "prior_comparison_id">) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export const reviewSiteInputs = (request: SiteComparisonRequest): SiteComparisonRequest => ({ ...request, review: { snapshot_json: JSON.stringify(siteInputs(request)), reviewed_at: new Date().toISOString() } });

export function siteTwinInputs(inputs: Omit<SitePlanDraft, "review" | "prior_comparison_id">, plan: SitePlanDraft["scenarios"][number]): { scenario: Scenario; assets: TwinAsset[] } {
  const power = (accounting: string) => plan.loads.filter(load => load.accounting === accounting).reduce((total, load) => {
    const asset = inputs.assets.find(item => item.id === load.asset_id);
    return total + (asset?.watts ?? 0) * (asset?.power_basis === "per_unit" ? asset.quantity : 1);
  }, 0);
  const lightAssets = inputs.assets.filter(asset => plan.loads.some(load => load.asset_id === asset.id && load.accounting === "lighting"));
  return {
    // Zero/null are rendering placeholders only. Numerical requests use SiteInputs without this adapter.
    scenario: { source: inputs.site.evidence.source === "synthetic_fixture" ? "sample" : "manual",
      length_ft: inputs.site.length_ft ?? 0, width_ft: inputs.site.width_ft ?? 0, canopy_sqft: inputs.site.canopy_sqft ?? 0,
      light_count: lightAssets.reduce((n, asset) => n + asset.quantity, 0), lighting_watts: power("lighting"),
      other_watts: power("module_other"), other_hours: plan.loads.find(load => load.accounting === "module_other")?.hours_per_day ?? 0,
      baseline_hours: plan.lighting.hours_per_day ?? 0, baseline_dim: plan.lighting.dim_fraction ?? 0, dimmable: plan.lighting.dimmable,
      ppfd_full: plan.lighting.ppfd_full, min_dli: plan.lighting.min_dli, min_hours: plan.lighting.min_hours ?? 0, max_hours: plan.lighting.max_hours ?? 0,
      power_limit_watts: plan.lighting.power_limit_watts ?? 0, electricity_usd_kwh: 0, operating_days: inputs.operation.horizon_days ?? 0,
      water_liters_day: plan.water_liters_day, confirmed: false },
    assets: inputs.assets.map(asset => ({ id: asset.id, name: asset.name, quantity: asset.quantity, confidence: null, confirmed: false,
      type: lightAssets.some(light => light.id === asset.id) ? "light_fixture" : /fan/i.test(asset.kind) ? "circulation_fan" : /bench|rack/i.test(asset.kind) ? "shelving_rack" : /reservoir|container/i.test(asset.kind) ? "container" : "other" })),
  };
}

export async function siteApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/site-comparisons${path}`, {
    method: body === undefined ? "GET" : "POST", headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", signal,
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : Array.isArray(data.detail)
      ? data.detail.map((item: { loc?: string[]; msg?: string }) => `${item.loc?.slice(1).join(".") ?? "Input"}: ${item.msg ?? "Invalid value"}`).join("; ") : "Request failed.";
    throw new Error(`${response.status}: ${detail}`);
  }
  return data as T;
}
