import type { LiveContext } from "./types";

export function sameWorkspace(current: LiveContext, expected: LiveContext) {
  return current.revision === expected.revision
    && current.accepted_revision === expected.accepted_revision
    && current.crop === expected.crop
    && current.proposal?.id === expected.proposal?.id
    && current.proposal?.version === expected.proposal?.version
    && current.proposal?.base_revision === expected.proposal?.base_revision
    && current.proposal?.status === expected.proposal?.status
    && current.can_undo === expected.can_undo
    && current.has_result === expected.has_result
    && JSON.stringify(current.selected_run) === JSON.stringify(expected.selected_run)
    && current.selected_asset_id === expected.selected_asset_id
    && JSON.stringify(current.scenario) === JSON.stringify(expected.scenario)
    && JSON.stringify(current.assets) === JSON.stringify(expected.assets);
}

type PaintClock = {
  frame: (callback: () => void) => number;
  cancel: (id: number) => void;
  deadline: (callback: () => void, milliseconds: number) => () => void;
};
const browserClock: PaintClock = {
  frame: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
  deadline: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
type PaintOutcome = "painted" | "changed" | "unconfirmed" | "inactive";

export function waitForWorkspacePaint(read: () => LiveContext, expected: LiveContext,
  active: () => boolean, clock: PaintClock = browserClock): Promise<PaintOutcome> {
  return new Promise(resolve => {
    let frame = 0;
    let matchedFrames = 0;
    const finish = (outcome: PaintOutcome) => {
      clock.cancel(frame);
      cancelDeadline();
      resolve(outcome);
    };
    const cancelDeadline = clock.deadline(() => finish("unconfirmed"), 2500);
    const inspect = () => {
      if (!active()) return finish("inactive");
      const current = read();
      const matches = sameWorkspace(current, expected);
      if ((!matches && matchedFrames > 0) || current.revision > expected.revision) return finish("changed");
      // Animation frames can run before a concurrent React commit. Count only
      // frames with the exact committed run/workspace, never the pre-action state.
      if (matches && ++matchedFrames === 2) return finish("painted");
      frame = clock.frame(inspect);
    };
    frame = clock.frame(inspect);
  });
}
