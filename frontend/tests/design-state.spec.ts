import { test, expect } from "@playwright/test";
import { SAMPLE_ASSETS, SAMPLE_SCENARIO } from "../lib/sample";
import { actOnDesign, activeWorkspace, createDesign, designContext, invalidateDesign, stageDesign, updateActive } from "../lib/live/design";
import type { DesignState } from "../lib/live/design";
import type { LiveDraft } from "../lib/live/types";

const initial = () => createDesign({ scenario: { ...SAMPLE_SCENARIO }, assets: structuredClone(SAMPLE_ASSETS), crop: null, result: null });
function draft(state: DesignState, inputs: LiveDraft["inputs"] = []): LiveDraft {
  return { id: `call-${state.revision}`, proposal_id: state.proposal?.id ?? "design-one", revision: state.revision, base_revision: state.accepted_revision, version: (state.proposal?.version ?? 0) + 1, reason: "Revised schematic", inputs, inventory: [], provenance: { turn_ids: ["user-1"], basis: "user_instruction" } };
}
const dimensions: LiveDraft["inputs"] = [{ field: "length_ft", value: 20, unit: "ft" }, { field: "width_ft", value: 10, unit: "ft" }];
const action = (state: DesignState, name: "approve" | "revise" | "discard" | "undo") => actOnDesign(state, name, state.proposal?.id ?? null, state.proposal?.version ?? null, state.revision);

test("one atomic proposal previews both dimensions and preserves accepted canopy", () => {
  const before = initial();
  const state = stageDesign(before, draft(before, dimensions));
  expect(state.accepted.scenario).toEqual(before.accepted.scenario);
  expect(activeWorkspace(state).scenario).toMatchObject({ length_ft: 20, width_ft: 10, canopy_sqft: 32, source: "sample", confirmed: false });
  expect(state.proposal).toMatchObject({ version: 1, base_revision: 0, status: "review" });
  expect(state.revision).toBe(1);
});
test("crop label never silently changes a light or water requirement", () => {
  const before = initial();
  const state = stageDesign(before, { ...draft(before), crop: "basil" });
  expect(activeWorkspace(state).crop).toBe("basil");
  expect(activeWorkspace(state).scenario).toEqual({ ...before.accepted.scenario, confirmed: false });
});
test("delegation may start a scoped preview without invented measurements", () => {
  const before = initial();
  const state = stageDesign(before, { ...draft(before), provenance: { turn_ids: ["user-2"], basis: "delegated_design" } });
  expect(state.proposal).not.toBeNull();
  expect(activeWorkspace(state).result).toBeNull();
  expect(activeWorkspace(state).scenario.canopy_sqft).toBe(32);
});
test("missing PPFD permits geometry preview but carries no savings", () => {
  const before = updateActive(initial(), { scenario: { ...SAMPLE_SCENARIO, source: "manual", ppfd_full: null, min_dli: null, confirmed: false } });
  const state = stageDesign(before, draft(before, dimensions));
  expect(activeWorkspace(state).scenario).toMatchObject({ length_ft: 20, ppfd_full: null, min_dli: null, source: "manual", confirmed: false });
  expect(designContext(state, null).has_result).toBe(false);
  expect(activeWorkspace(state).result).toBeNull();
});
test("approval adopts exactly the visible version and undo restores its predecessor", () => {
  const before = initial();
  const preview = stageDesign(before, draft(before, dimensions));
  const adopted = action(preview, "approve");
  expect(adopted.proposal).toBeNull();
  expect(adopted.accepted).toEqual(preview.proposal!.workspace);
  expect(adopted.accepted.scenario.confirmed).toBe(false);
  expect(adopted.accepted_revision).toBe(adopted.revision);
  const undone = action(adopted, "undo");
  expect(undone.accepted).toEqual(before.accepted);
  expect(undone.undo).toBeNull();
});
test("discard never changes accepted values", () => {
  const before = initial();
  const staged = stageDesign(before, draft(before, dimensions));
  const discarded = action(staged, "discard");
  expect(discarded.accepted).toEqual(before.accepted);
  expect(discarded.accepted_revision).toBe(before.accepted_revision);
  expect(discarded.proposal).toBeNull();
});
test("revise advances the visible version and subsequent grouped edits preserve other inputs", () => {
  const before = initial();
  const staged = stageDesign(before, draft(before, dimensions));
  const revised = action(staged, "revise");
  expect(revised.proposal).toMatchObject({ version: 2, status: "revising" });
  const next = stageDesign(revised, draft(revised, [{ field: "length_ft", value: 24, unit: "ft" }]));
  expect(activeWorkspace(next).scenario).toMatchObject({ length_ft: 24, width_ft: 10, canopy_sqft: 32 });
  expect(next.proposal?.version).toBe(3);
});
test("duplicate drafts, stale approval and unrelated proposal IDs fail closed", () => {
  const before = initial();
  const change = draft(before, dimensions);
  const staged = stageDesign(before, change);
  expect(() => stageDesign(staged, change)).toThrow(/already processed/);
  expect(() => actOnDesign(staged, "approve", "other", 1, staged.revision)).toThrow(/active version/);
  expect(() => actOnDesign(staged, "approve", staged.proposal!.id, 1, 0)).toThrow(/workspace changed/);
  expect(() => stageDesign(staged, { ...draft(staged), version: 9 })).toThrow(/stale/);
  expect(staged.accepted.scenario.length_ft).toBe(8);
});
test("user edit invalidates a pending solver revision and makes the old proposal approval stale", () => {
  const before = initial();
  const staged = stageDesign(before, draft(before, dimensions));
  const edited = updateActive(invalidateDesign(staged), { scenario: { ...activeWorkspace(staged).scenario, width_ft: 12 } });
  expect(edited.proposal?.version).toBe(2);
  expect(edited.revision).toBeGreaterThan(staged.revision);
  expect(activeWorkspace(edited).result).toBeNull();
  expect(() => actOnDesign(edited, "approve", staged.proposal!.id, staged.proposal!.version, staged.revision)).toThrow();
});
test("unknown units and impossible canopy fail the whole proposal, not just one dimension", () => {
  const before = initial();
  expect(() => stageDesign(before, draft(before, [{ field: "length_ft", value: 20, unit: "m" }]))).toThrow(/unit/);
  expect(() => stageDesign(before, draft(before, [{ field: "length_ft", value: 1, unit: "ft" }, { field: "width_ft", value: 1, unit: "ft" }]))).toThrow(/Canopy/);
  expect(before.accepted.scenario.length_ft).toBe(8);
});
test("real incomplete values and selected asset references never inherit synthetic defaults", () => {
  const before = initial();
  const real = createDesign({ ...before.accepted, scenario: { ...before.accepted.scenario, source: "manual", lighting_watts: 0, ppfd_full: null, min_dli: null, operating_days: 0 }, assets: [] });
  const state = stageDesign(real, draft(real, dimensions));
  expect(designContext(state, "missing")).toMatchObject({ selected_asset_id: null, scenario: { lighting_watts: 0, ppfd_full: null, min_dli: null, operating_days: 0, light_count: 0 } });
});
test("ordinary edits after adoption clear undo rather than overwriting later accepted work", () => {
  const before = initial();
  const adopted = action(stageDesign(before, draft(before, dimensions)), "approve");
  const edited = invalidateDesign(adopted);
  expect(edited.undo).toBeNull();
  expect(() => action(edited, "undo")).toThrow();
});

test("crop requirement assumptions survive preview, adoption and subsequent unrelated changes", () => {
  const before = initial();
  const assumption = { label: "Unverified crop requirement", source: "User-supplied reference", growth_stage: "Vegetative" };
  const staged = stageDesign(before, draft(before, [{ field: "min_dli", value: 14, unit: "mol/m2/day", assumption }]));
  const adopted = action(staged, "approve");
  expect(adopted.accepted.assumptions?.min_dli).toEqual(assumption);
  expect(adopted.accepted.provenance).toEqual([{ turn_ids: ["user-1"], basis: "user_instruction" }]);
  const revised = stageDesign(adopted, draft(adopted, dimensions));
  expect(designContext(revised, null).assumptions?.min_dli).toEqual(assumption);
  expect(activeWorkspace(revised).scenario.confirmed).toBe(false);
});
test("a malformed assumption never appears as a validated numerical input", () => {
  const before = initial();
  expect(() => stageDesign(before, draft(before, [{ field: "min_dli", value: 14, unit: "mol/m2/day", assumption: { label: "Estimate", source: "", growth_stage: "Unknown" } }]))).toThrow(/assumption/);
  expect(before.accepted.scenario.min_dli).toBe(15);
});
test("discarding a proposal invalidates an old accepted numerical result", () => {
  const before = initial();
  const staged = stageDesign(before, draft(before, dimensions));
  const state = { ...staged, accepted: { ...staged.accepted, result: { status: "optimized" } as NonNullable<typeof staged.accepted.result> } };
  expect(action(state, "discard").accepted.result).toBeNull();
});
