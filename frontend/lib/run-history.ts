import type { OptimizationResult, Scenario, TwinAsset } from "./types";
import { activeWorkspace, createDesign, sameRunInputs, type DesignState, type SavedCalculation, type WorkspaceVersion } from "./live/design";
import type { RunReference } from "./live/types";

export type SavedRun = {
  id: string;
  name: string;
  at: string;
  scenario: Scenario;
  assets: TwinAsset[];
  crop?: string | null;
  assumptions?: WorkspaceVersion["assumptions"];
  provenance?: WorkspaceVersion["provenance"];
  inputRecords?: WorkspaceVersion["inputRecords"];
  important?: boolean;
  result: OptimizationResult;
  reference?: RunReference;
};

export function appendRun(history: SavedRun[], run: SavedRun): SavedRun[] {
  const prior = history.find(item => item.id === run.id);
  return [{ ...run, important: prior?.important ?? run.important }, ...history.filter(item => item.id !== run.id)];
}

export function calculationFor(run: SavedRun | undefined): SavedCalculation | null {
  if (!run?.result.run || !run.reference || run.reference.id !== run.result.run.id) return null;
  const saved = { result: run.result, reference: run.reference };
  return validCalculation(saved) ? saved : null;
}

export function selectedCalculationFor(state: DesignState, history: SavedRun[]): SavedCalculation | null {
  const result = activeWorkspace(state).result;
  if (!result) return state.saved_run ?? null;
  const id = result.run?.id;
  if (!id) return null;
  return state.saved_run?.reference.id === id ? state.saved_run
    : calculationFor(history.find(run => run.id === id));
}

export function validCalculation(value: unknown): value is SavedCalculation {
  if (!value || typeof value !== "object") return false;
  const saved = value as SavedCalculation;
  const run = saved.result?.run;
  return !!run?.evidence && !!run.input_snapshot && saved.reference?.id === run.id
    && Number.isSafeInteger(saved.reference.workspace_revision) && saved.reference.workspace_revision >= 0
    && Number.isSafeInteger(saved.reference.accepted_revision) && saved.reference.accepted_revision >= 0
    && saved.reference.accepted_revision <= saved.reference.workspace_revision
    && saved.result.model_version === run.model_version && saved.result.source === run.source
    && saved.result.status === run.status && Array.isArray(saved.result.candidates);
}

export function restoreDesign(workspace: WorkspaceVersion, saved: SavedCalculation | null, history: SavedRun[],
  acceptedResultId: string | null | undefined, workingRevision?: number, acceptedRevision?: number) {
  const historyRevision = history.reduce((maximum, run) => Math.max(maximum, calculationFor(run)?.reference.workspace_revision ?? 0), 0);
  const revision = Math.max(historyRevision, Number.isSafeInteger(workingRevision) && workingRevision! >= 0
    ? workingRevision! : saved?.reference.workspace_revision ?? 0);
  const state = createDesign(workspace, revision, saved);
  if (Number.isSafeInteger(acceptedRevision) && acceptedRevision! >= 0 && acceptedRevision! <= revision) state.accepted_revision = acceptedRevision!;
  const requested = acceptedResultId === undefined ? saved : acceptedResultId === null ? null
    : (saved?.reference.id === acceptedResultId ? saved : calculationFor(history.find(run => run.id === acceptedResultId)));
  if (!requested || !validCalculation(requested) || !sameRunInputs(requested.result.run!.input_snapshot, workspace.scenario)
    || Object.keys(workspace.assumptions ?? {}).length) return state;
  // Older saved workspaces did not persist the active result link. Only restore a matching accepted snapshot.
  if (acceptedResultId === undefined) {
    const original = history.find(run => run.id === requested.reference.id);
    if (!original || (original.crop ?? null) !== workspace.crop
      || JSON.stringify(original.assets) !== JSON.stringify(workspace.assets)
      || requested.reference.proposal_id !== null) return state;
  }
  state.accepted.result = structuredClone(requested.result);
  return state;
}
