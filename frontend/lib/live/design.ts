import type { OptimizationResult, Scenario, TwinAsset } from "../types";
import type { InputRecords } from "../input-records";
import { applyLiveDraft, INPUT_RULES, type LiveContext, type LiveDraft, type ProposalVersion, type RunReference } from "./types";

export type WorkspaceVersion = {
  scenario: Scenario;
  assets: TwinAsset[];
  crop: string | null;
  result: OptimizationResult | null;
  assumptions?: LiveContext["assumptions"];
  provenance?: NonNullable<LiveDraft["provenance"]>[];
  inputRecords?: InputRecords;
};
export type DesignProposal = ProposalVersion & {
  reason: string;
  workspace: WorkspaceVersion;
  provenance: NonNullable<LiveDraft["provenance"]>[];
};
export type DesignState = {
  revision: number;
  accepted_revision: number;
  accepted: WorkspaceVersion;
  proposal: DesignProposal | null;
  undo: WorkspaceVersion | null;
  appliedDraftIds: string[];
  saved_run?: SavedCalculation | null;
};
export type SavedCalculation = { reference: RunReference; result: OptimizationResult };

export const activeWorkspace = (state: DesignState): WorkspaceVersion => state.proposal?.workspace ?? state.accepted;
export function createDesign(workspace: WorkspaceVersion, revision = 0, savedRun: SavedCalculation | null = null): DesignState {
  revision = Math.max(revision, savedRun?.reference.workspace_revision ?? 0);
  return { revision, accepted_revision: revision, accepted: structuredClone(workspace), proposal: null, undo: null, appliedDraftIds: [], saved_run: savedRun ? structuredClone(savedRun) : null };
}
export function designContext(state: DesignState, selected: string | null): LiveContext {
  const workspace = activeWorkspace(state);
  const proposal = state.proposal;
  return {
    revision: state.revision, accepted_revision: state.accepted_revision,
    scenario: workspace.scenario, assets: workspace.assets, crop: workspace.crop,
    selected_asset_id: workspace.assets.some(asset => asset.id === selected) ? selected : null,
    has_result: workspace.result !== null,
    selected_run: state.saved_run?.reference ?? null,
    proposal: proposal ? { id: proposal.id, version: proposal.version, base_revision: proposal.base_revision, status: proposal.status } : null,
    can_undo: state.undo !== null,
    assumptions: workspace.assumptions ?? {},
  };
}
export function sameRunInputs(left: Scenario, right: Scenario): boolean {
  return (Object.keys(left) as (keyof Scenario)[]).filter(key => key !== "confirmed").every(key => {
    const normalize = (value: Scenario[typeof key]) => (key === "ppfd_full" || key === "min_dli") && value === 0 ? null : value;
    return normalize(left[key]) === normalize(right[key]);
  });
}
export function recordResult(state: DesignState, result: OptimizationResult): DesignState {
  const run = result.run;
  if (run && (!sameRunInputs(run.input_snapshot, activeWorkspace(state).scenario)
      || run.source !== result.source || run.model_version !== result.model_version || run.status !== result.status)) {
    throw new Error("The returned run does not match the requested inputs. No result was applied.");
  }
  const reference: RunReference | null = run ? {
    id: run.id, workspace_revision: state.revision, accepted_revision: state.accepted_revision,
    proposal_id: state.proposal?.id ?? null, proposal_version: state.proposal?.version ?? null,
  } : null;
  return { ...updateActive(state, { result: structuredClone(result) }),
    saved_run: reference ? { reference, result: structuredClone(result) } : null };
}
export function isEarlierRun(state: DesignState): boolean {
  const saved = state.saved_run;
  return !!saved && (saved.reference.workspace_revision !== state.revision
    || (!!saved.result.run && !sameRunInputs(saved.result.run.input_snapshot, activeWorkspace(state).scenario)));
}
export function updateActive(state: DesignState, change: Partial<WorkspaceVersion>): DesignState {
  const workspace = { ...activeWorkspace(state), ...change };
  return state.proposal
    ? { ...state, proposal: { ...state.proposal, workspace } }
    : { ...state, accepted: workspace };
}
export function invalidateDesign(state: DesignState): DesignState {
  const next = updateActive(state, { result: null });
  return {
    ...next, revision: state.revision + 1,
    accepted_revision: state.proposal ? state.accepted_revision : state.revision + 1,
    proposal: next.proposal ? { ...next.proposal, version: next.proposal.version + 1, status: "revising" } : null,
    // Undo is only for the last adoption, never for overwriting later accepted edits.
    undo: state.proposal ? state.undo : null,
  };
}
export function stageDesign(state: DesignState, draft: LiveDraft): DesignState {
  if (state.appliedDraftIds.includes(draft.id)) throw new Error("This draft was already processed. Read the current proposal.");
  const id = draft.proposal_id ?? draft.id;
  const version = draft.version ?? ((state.proposal?.version ?? 0) + 1);
  const base = draft.base_revision ?? state.accepted_revision;
  if (base !== state.accepted_revision || (state.proposal && id !== state.proposal.id)
    || version !== (state.proposal?.version ?? 0) + 1) throw new Error("This proposal version is stale. Read the current workspace.");
  const current = activeWorkspace(state);
  const next = applyLiveDraft(designContext(state, null), draft);
  if (draft.crop !== undefined && draft.crop !== null && (typeof draft.crop !== "string" || !draft.crop.trim() || draft.crop.length > 80)) throw new Error("Check the crop label.");
  // A crop is descriptive metadata; it never supplies light or water measurements.
  const crop = draft.crop === undefined ? current.crop : draft.crop?.trim() ?? null;
  const assumptions = { ...current.assumptions };
  for (const patch of draft.inputs) {
    if (patch.assumption) {
      for (const [key, maximum] of [["label", 160], ["source", 300], ["growth_stage", 80]] as const) {
        const value = patch.assumption[key];
        if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error("A crop requirement needs an assumption label, source and growth stage.");
      }
      assumptions[patch.field] = { ...patch.assumption };
    } else delete assumptions[patch.field];
  }
  const provenance = [...(current.provenance ?? []), ...(draft.provenance ? [draft.provenance] : [])].slice(-32);
  return {
    ...state, revision: state.revision + 1,
    proposal: {
      id, version, base_revision: base, status: "review", reason: draft.reason,
      workspace: { ...next, crop, result: null, assumptions, provenance, inputRecords: current.inputRecords },
      provenance: [...(state.proposal?.provenance ?? []), ...(draft.provenance ? [draft.provenance] : [])].slice(-32),
    },
    appliedDraftIds: [...state.appliedDraftIds, draft.id].slice(-256),
  };
}
export function actOnDesign(state: DesignState, action: "approve" | "revise" | "discard" | "undo", id: string | null, version: number | null, revision: number): DesignState {
  if (revision !== state.revision) throw new Error("The workspace changed. Review the current version.");
  if (action === "undo") {
    if (state.proposal || !state.undo || id !== null || version !== null) throw new Error("Discard the active proposal before undoing the last adoption.");
    return { ...state, revision: state.revision + 1, accepted_revision: state.revision + 1, accepted: { ...state.undo, result: null }, undo: null };
  }
  const proposal = state.proposal;
  if (!proposal || id !== proposal.id || version !== proposal.version) throw new Error("This proposal is no longer the active version.");
  if (action === "revise") return { ...state, revision: state.revision + 1, proposal: { ...proposal, version: proposal.version + 1, status: "revising" } };
  if (action === "discard") return { ...state, revision: state.revision + 1, accepted: { ...state.accepted, result: null }, proposal: null };
  return {
    ...state, revision: state.revision + 1, accepted_revision: state.revision + 1,
    accepted: proposal.workspace, undo: state.accepted, proposal: null,
  };
}

export function designChanges(state: DesignState): { label: string; before: string; after: string }[] {
  if (!state.proposal) return [];
  const proposed = state.proposal.workspace;
  const format = (value: unknown, unit = "", positiveRequired = false) => value === null || (positiveRequired && value === 0) ? "Unknown" : `${String(value)}${unit ? ` ${unit}` : ""}`;
  const changes = Object.entries(INPUT_RULES).flatMap(([key, rule]) => {
    const field = key as keyof typeof INPUT_RULES;
    return state.accepted.scenario[field] === proposed.scenario[field] ? [] : [{ label: rule.label, before: format(state.accepted.scenario[field], rule.unit, rule.min > 0), after: format(proposed.scenario[field], rule.unit, rule.min > 0) }];
  });
  if (state.accepted.crop !== proposed.crop) changes.push({ label: "Crop label", before: state.accepted.crop ?? "Unspecified", after: proposed.crop ?? "Unspecified" });
  const inventory = (assets: TwinAsset[]) => assets.map(asset => `${asset.quantity} ${asset.name}`).join(", ") || "None";
  if (inventory(state.accepted.assets) !== inventory(proposed.assets)) changes.push({ label: "Inventory", before: inventory(state.accepted.assets), after: inventory(proposed.assets) });
  return changes;
}
