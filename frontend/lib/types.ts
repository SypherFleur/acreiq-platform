export type Scenario = {
  source: "sample" | "manual" | "photo-assisted";
  length_ft: number;
  width_ft: number;
  canopy_sqft: number;
  light_count: number;
  lighting_watts: number;
  other_watts: number;
  other_hours: number;
  baseline_hours: number;
  baseline_dim: number;
  dimmable: boolean;
  ppfd_full: number | null;
  min_dli: number | null;
  min_hours: number;
  max_hours: number;
  power_limit_watts: number;
  electricity_usd_kwh: number;
  operating_days: number;
  water_liters_day: number | null;
  confirmed: boolean;
};
export type Metrics = {
  photoperiod_hours: number;
  dim_fraction: number;
  daily_energy_kwh: number;
  period_energy_kwh: number;
  period_energy_cost_usd: number;
  peak_modeled_watts: number;
  dli_mol_m2_day: number | null;
  period_water_liters: number | null;
  canopy_sqft: number;
};
export type Candidate = Metrics & { feasible: boolean; rejected_for: string[] };
export type OptimizationResult = {
  run?: RunArtifact | null;
  model_version: string;
  source: Scenario["source"];
  status: "optimized" | "needs_measurement" | "no_feasible_configuration";
  operating_days: number;
  baseline: Metrics;
  optimized: Metrics | null;
  savings: null | {
    period_energy_kwh: number;
    energy_pct: number;
    period_energy_cost_usd: number;
    water_liters: null;
    yield_gain_lb: null;
    avoided_capex_usd: null;
    new_equipment_required_by_scenario_usd: number;
  };
  configurations_evaluated: number;
  feasible_configurations: number;
  candidates: Candidate[];
  recommendations: string[];
  limitations: string[];
};
export type RunEvidence = {
  summary: string;
  inputs: { field: string; value: number | boolean | string | null; unit: string; used_for: string }[];
  baseline: Metrics;
  selected: Metrics | null;
  savings: OptimizationResult["savings"];
  formulas: { scope: "baseline" | "selected" | "savings"; metric: string; expression: string; substituted: string; raw_value: number; reported_value: number; unit: string; round_digits: number }[];
  objective: string;
  constraints: { name: string; unit: string; minimum: number | null; maximum: number | null; evaluated: boolean; baseline_value: number | null; baseline_passed: boolean | null; selected_value: number | null; selected_passed: boolean | null; rejected_configurations: number }[];
  configurations_evaluated: number;
  feasible_configurations: number;
  selection_reason: string;
  alternatives: { kind: "selected" | "rejected" | "nearest_feasible"; reason: string | null; candidate: Candidate }[];
  horizon: { operating_days: number; electricity_usd_kwh: number };
  assumptions: string[];
  missing_inputs: string[];
  limitations: string[];
};
export type RunArtifact = {
  id: string;
  created_at: string;
  input_snapshot: Scenario;
  model_version: string;
  source: Scenario["source"];
  status: OptimizationResult["status"];
  evidence: RunEvidence;
};
export type TwinAsset = {
  id: string;
  name: string;
  type:
    | "light_fixture"
    | "shelving_rack"
    | "circulation_fan"
    | "plant"
    | "container"
    | "other";
  quantity: number;
  confidence: number | null;
  confirmed: boolean;
};
export type ScanResult = {
  source: "gemini" | "manual";
  assets: TwinAsset[];
  observations: string[];
  warnings: string[];
};
export type TwinProps = {
  scenario: Scenario;
  assets: TwinAsset[];
  optimized: Metrics | null;
  mode: "current" | "optimized";
  layer: "structure" | "light";
  selectedAsset: string | null;
  onSelectAsset: (id: string | null) => void;
  autoRotate: boolean;
  view: "perspective" | "top";
  resetKey: number;
};
