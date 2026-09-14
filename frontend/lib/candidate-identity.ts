import type { Metrics, OptimizationResult, RunEvidence } from "./types";

export type CandidateSetting = Pick<Metrics, "photoperiod_hours" | "dim_fraction">;

/**
 * An exact setting key, stable across sorting, filtering and JSON round trips.
 * Number.toString preserves distinct finite JS numbers without display rounding.
 * Numerically equal settings (including -0 and 0) share a key. For cross-run
 * identity, use the pair (run.id, candidateId(candidate)); this key alone does
 * not identify a run or imply that a setting was tested, selected or feasible.
 */
export function candidateId(candidate: CandidateSetting): string {
  const { photoperiod_hours: hours, dim_fraction: dim } = candidate;
  if (!Number.isFinite(hours) || !Number.isFinite(dim)) {
    throw new RangeError("Candidate identity requires finite hours and dim fraction.");
  }
  return `h${hours}-d${dim}`;
}

export type CandidateIdentityMetadata = {
  schema_version: 1;
  run_id: string | null;
  scope: "run" | "unknown_legacy";
  key_definition: string;
  candidates: Record<string, CandidateSetting>;
  baseline_candidate_id: string | null;
  selected_candidate_id: string | null;
  alternatives: { kind: RunEvidence["alternatives"][number]["kind"]; reason: string | null; candidate_id: string }[];
};

/** Detached frontend metadata for a JSON export envelope, never inserted into result.run. */
export function buildCandidateIdentityMetadata(result: OptimizationResult): CandidateIdentityMetadata {
  const candidates = Object.fromEntries(result.candidates.map(candidate => [candidateId(candidate), {
    photoperiod_hours: candidate.photoperiod_hours, dim_fraction: candidate.dim_fraction,
  }] as const).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  const testedId = (metrics: Metrics | null) => metrics && Object.hasOwn(candidates, candidateId(metrics)) ? candidateId(metrics) : null;
  return {
    schema_version: 1,
    run_id: result.run?.id ?? null,
    scope: result.run ? "run" : "unknown_legacy",
    key_definition: "candidateId = h{exact hours}-d{exact dim fraction}; identity is (run_id, candidateId). Equal settings share a key; an unknown run_id is not unique run identity.",
    candidates,
    baseline_candidate_id: testedId(result.baseline),
    selected_candidate_id: testedId(result.optimized),
    alternatives: (result.run?.evidence.alternatives ?? []).map(alternative => ({
      kind: alternative.kind, reason: alternative.reason, candidate_id: candidateId(alternative.candidate),
    })),
  };
}
