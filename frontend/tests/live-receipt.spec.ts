import { expect, test } from "@playwright/test";
import { createDesign, designContext } from "../lib/live/design";
import { waitForWorkspacePaint } from "../lib/live/receipt";
import { SAMPLE_ASSETS, SAMPLE_SCENARIO } from "../lib/sample";

function harness() {
  const initial = designContext(createDesign({ scenario: { ...SAMPLE_SCENARIO },
    assets: structuredClone(SAMPLE_ASSETS), crop: null, result: null }), null);
  const expected = { ...initial, has_result: true, selected_run: {
    id: "exact-run", workspace_revision: 0, accepted_revision: 0, proposal_id: null, proposal_version: null,
  } };
  const state = { current: initial, active: true };
  const callbacks = new Map<number, () => void>();
  let id = 0;
  let deadline: (() => void) | undefined;
  const pending = waitForWorkspacePaint(() => state.current, expected, () => state.active, {
    frame: callback => { callbacks.set(++id, callback); return id; },
    cancel: key => { callbacks.delete(key); },
    deadline: (callback, milliseconds) => {
      expect(milliseconds).toBe(2500);
      deadline = callback;
      return () => { deadline = undefined; };
    },
  });
  let outcome: string | undefined;
  void pending.then(value => { outcome = value; });
  return { state, expected, pending, callbacks, outcome: () => outcome,
    async frame() {
      const queued = [...callbacks.values()]; callbacks.clear();
      queued.forEach(callback => callback());
      await Promise.resolve();
    },
    timeout: () => deadline?.(),
  };
}

test("Live result receipt waits beyond two frames for the exact React commit", async () => {
  const run = harness();
  for (let i = 0; i < 5; i++) await run.frame();
  expect(run.outcome()).toBeUndefined();
  run.state.current = run.expected;
  await run.frame();
  expect(run.outcome()).toBeUndefined();
  await run.frame();
  expect(await run.pending).toBe("painted");
  expect(run.callbacks.size).toBe(0);
});

test("Live result receipt never accepts a different run at the same revision", async () => {
  const run = harness();
  run.state.current = { ...run.expected, selected_run: { ...run.expected.selected_run, id: "another-run" } };
  await run.frame(); await run.frame();
  expect(run.outcome()).toBeUndefined();
  run.timeout();
  expect(await run.pending).toBe("unconfirmed");
  expect(run.callbacks.size).toBe(0);
});

test("Live result receipt rejects an intervening workspace revision", async () => {
  const run = harness();
  run.state.current = { ...run.expected, revision: 1 };
  await run.frame();
  expect(await run.pending).toBe("changed");
});

test("Live receipt rejects changes between matching commit and paint", async () => {
  const run = harness();
  run.state.current = run.expected;
  await run.frame();
  run.state.current = { ...run.expected, selected_asset_id: "fan-1" };
  await run.frame();
  expect(await run.pending).toBe("changed");
});

test("Live receipt timeout cannot report success without a visible frame", async () => {
  const run = harness();
  run.state.current = run.expected;
  run.timeout();
  expect(await run.pending).toBe("unconfirmed");
  expect(run.callbacks.size).toBe(0);
});

test("Live session cancellation stops a pending receipt", async () => {
  const run = harness();
  run.state.active = false;
  await run.frame();
  expect(await run.pending).toBe("inactive");
  expect(run.callbacks.size).toBe(0);
});
