import type { OptimizationResult, Scenario, TwinAsset } from "../types";

export type LiveContext = {
  revision: number;
  scenario: Scenario;
  assets: TwinAsset[];
  selected_asset_id: string | null;
  has_result: boolean;
  selected_run?: RunReference | null;
  accepted_revision?: number;
  crop?: string | null;
  proposal?: ProposalVersion | null;
  can_undo?: boolean;
  assumptions?: Partial<Record<InputField, InputAssumption>>;
};
export type RunReference = {
  id: string;
  workspace_revision: number;
  accepted_revision: number;
  proposal_id: string | null;
  proposal_version: number | null;
};
export type ExplanationStatus = { type: "explanation_status"; status: "ok" | "error" | "no_result"; run_id: string | null; code?: string | null; message?: string | null };
export type InputAssumption = { label: string; source: string; growth_stage: string };
export type ProposalVersion = { id: string; version: number; base_revision: number; status: "review" | "revising" };
export type ActionReceipt = { status: "applied" | "rejected"; message: string; context: LiveContext };
export type ProposalAction = { type: "proposal_action"; action_id: string; action: "approve" | "revise" | "discard" | "undo"; proposal_id: string | null; version: number | null; revision: number };
export type InputField = Exclude<keyof Scenario, "source" | "confirmed" | "light_count">;
export type LiveDraft = {
  id: string;
  revision: number;
  reason: string;
  proposal_id?: string;
  version?: number;
  base_revision?: number;
  crop?: string | null;
  provenance?: { turn_ids: string[]; basis: "user_instruction" | "delegated_design" };
  inputs: { field: InputField; value: number | boolean | null; unit: string; assumption?: InputAssumption }[];
  inventory: {
    operation: "add" | "update" | "remove";
    id?: string;
    name?: string;
    asset_type?: TwinAsset["type"];
    quantity?: number;
  }[];
};
export type LiveEvent =
  | { type: "ready"; model: string; max_duration_seconds: number }
  | { type: "audio"; data: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string }
  | { type: "interrupted" | "turn_complete" }
  | { type: "usage"; input_tokens?: number; output_tokens?: number; total_tokens?: number }
  | { type: "draft"; draft: LiveDraft; action_id?: string }
  | { type: "draft_cancelled"; id: string }
  | { type: "view"; camera?: "top" | "perspective"; asset_id?: string; action_id?: string }
  | { type: "result"; revision: number; result: OptimizationResult; action_id?: string }
  | ProposalAction
  | ExplanationStatus
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: string }
  | { type: "reconnect"; message: string };

// Units are canonical API units, not text recognized from the camera.
export const INPUT_RULES: Record<InputField, { label: string; unit: string; min: number; max: number; nullable?: boolean; integer?: boolean }> = {
  length_ft: { label: "Room length", unit: "ft", min: 0.001, max: 1000 },
  width_ft: { label: "Room width", unit: "ft", min: 0.001, max: 1000 },
  canopy_sqft: { label: "Current canopy coverage", unit: "ft2", min: 0.001, max: 1000000 },
  lighting_watts: { label: "Combined lighting load", unit: "W", min: 0.001, max: 1000000 },
  other_watts: { label: "Other load", unit: "W", min: 0, max: 1000000 },
  other_hours: { label: "Other load hours", unit: "h/day", min: 0, max: 24 },
  baseline_hours: { label: "Current lighting hours", unit: "h/day", min: 0.001, max: 24 },
  baseline_dim: { label: "Current output fraction", unit: "fraction", min: 0.001, max: 1 },
  dimmable: { label: "Dimmable fixtures", unit: "boolean", min: 0, max: 1 },
  ppfd_full: { label: "Measured canopy PPFD", unit: "umol/m2/s", min: 0.001, max: 5000, nullable: true },
  min_dli: { label: "Crop light target", unit: "mol/m2/day", min: 0.001, max: 100, nullable: true },
  min_hours: { label: "Minimum lighting hours", unit: "h/day", min: 0.001, max: 24 },
  max_hours: { label: "Maximum lighting hours", unit: "h/day", min: 0.001, max: 24 },
  power_limit_watts: { label: "Connected load limit", unit: "W", min: 0.001, max: 2000000 },
  electricity_usd_kwh: { label: "Electricity price", unit: "USD/kWh", min: 0, max: 10 },
  operating_days: { label: "Operating period", unit: "day", min: 1, max: 366, integer: true },
  water_liters_day: { label: "Daily water use", unit: "L/day", min: 0, max: 1000000, nullable: true },
};

const ASSET_TYPES = new Set(["light_fixture", "shelving_rack", "circulation_fan", "plant", "container", "other"]);

export function applyLiveDraft(context: LiveContext, draft: LiveDraft): { scenario: Scenario; assets: TwinAsset[] } {
  if (draft.revision !== context.revision) throw new Error("The workspace changed. Request a fresh draft.");
  if (!draft.id || draft.inputs.length > 18 || draft.inventory.length > 20) throw new Error("Invalid Live draft.");
  const scenario = { ...context.scenario, confirmed: false };
  let assets = context.assets.map(asset => ({ ...asset, confirmed: false }));
  const fields = new Set<string>();
  for (const entry of draft.inputs) {
    const rule = INPUT_RULES[entry.field];
    if (!Object.hasOwn(INPUT_RULES, entry.field) || !rule || fields.has(entry.field) || entry.unit !== rule.unit) throw new Error("Invalid field or unit in Live draft.");
    fields.add(entry.field);
    if (entry.field === "dimmable") {
      if (typeof entry.value !== "boolean") throw new Error("Dimmable must be true or false.");
    } else if (entry.value === null) {
      if (!rule.nullable) throw new Error("This measurement cannot be empty.");
    } else if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || entry.value < rule.min || entry.value > rule.max || (rule.integer && !Number.isInteger(entry.value))) {
      throw new Error(`Check ${rule.label.toLowerCase()}.`);
    }
    Object.assign(scenario, { [entry.field]: entry.value });
  }
  const touched = new Set<string>();
  for (const item of draft.inventory) {
    if (item.id && touched.has(item.id)) throw new Error("An asset appears twice in this draft.");
    if (item.id) touched.add(item.id);
    const existing = assets.find(asset => asset.id === item.id);
    if (item.operation !== "add" && !existing) throw new Error("This asset is no longer in the inventory.");
    if (item.operation === "remove") { assets = assets.filter(asset => asset.id !== item.id); continue; }
    if (item.operation !== "add" && item.operation !== "update") throw new Error("Unknown inventory operation.");
    const type = item.asset_type ?? existing?.type;
    const name = (item.name ?? existing?.name ?? "").trim();
    const quantity = item.quantity ?? existing?.quantity;
    if (!type || !ASSET_TYPES.has(type) || !name || name.length > 80 || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > (type === "light_fixture" ? 100 : 1000)) throw new Error("Check the suggested asset name, type and quantity.");
    if (item.operation === "add") {
      const id = item.id || `live-${crypto.randomUUID()}`;
      if (assets.some(asset => asset.id === id)) throw new Error("Duplicate asset ID.");
      assets.push({ id, type, name, quantity, confidence: null, confirmed: false });
    } else assets = assets.map(asset => asset.id === item.id ? { ...asset, type, name, quantity, confirmed: false } : asset);
  }
  scenario.light_count = assets.filter(asset => asset.type === "light_fixture").reduce((sum, asset) => sum + asset.quantity, 0);
  if (assets.length > 64 || assets.reduce((sum, asset) => sum + asset.quantity, 0) > 1000 || scenario.light_count > 100) throw new Error("Inventory exceeds the model limits.");
  if (scenario.length_ft > 0 && scenario.width_ft > 0 && scenario.canopy_sqft > scenario.length_ft * scenario.width_ft) throw new Error("Canopy coverage exceeds the room area.");
  if (scenario.min_hours > 0 && scenario.max_hours > 0 && scenario.min_hours > scenario.max_hours) throw new Error("Minimum hours exceed maximum hours.");
  if (!scenario.dimmable && scenario.baseline_dim !== 1) throw new Error("Non-dimmable lights require full output.");
  return { scenario, assets };
}
