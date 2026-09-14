import type { WebSocketRoute } from "@playwright/test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";
import type { LiveContext, LiveDraft, LiveEvent } from "../lib/live/types";
import type { OptimizationResult } from "../lib/types";
import {
  expect, test, type Page, expectFreshMeasurements, measurementConfirmation,
  mockHealth, savedWorkspace, persistedWorkspace,
} from "./test-support";

const SOCKET_URL = "ws://127.0.0.1:8000/live/ws";
const SESSION_TOKEN = "opaque-browser-test-session";
const RESUME_TOKEN = "opaque-browser-test-resume";
const CONSENT = /I consent to sending microphone audio and reviewed workspace context/;
const SAMPLE_CONFIRMATION = "I reviewed these sample assumptions for Live.";

type MediaAudit = {
  requests: MediaStreamConstraints[];
  tracks: { track: MediaStreamTrack; stops: number }[];
  contexts: AudioContext[];
  worklets: string[];
  sockets: WebSocket[];
  sent: { type: string; at: number; bytes: number }[];
  jpegTimes: number[];
  sourceStops: number;
  sourceStarts: { source: AudioBufferSourceNode; when: number; at: number; duration: number; sampleRate: number }[];
  cleanup: Map<string, () => void>;
};
type AuditWindow = Window & { __liveTestMedia: MediaAudit };
type ClientEvent =
  | { type: "auth"; token: string }
  | { type: "context"; context: LiveContext }
  | { type: "audio" | "video"; data: string }
  | { type: "action_ack"; action_id: string; status: "applied" | "rejected"; message: string; context: LiveContext }
  | { type: "audio_end" | "end" };
type ActionEvent = Extract<LiveEvent, { type: "draft" | "view" | "result" | "proposal_action" }>;
type RelayEvent = LiveEvent | { [K in ActionEvent["type"]]: Omit<Extract<ActionEvent, { type: K }>, "action_id"> }[ActionEvent["type"]];
type VersionedDraft = LiveDraft & Required<Pick<LiveDraft, "proposal_id" | "version" | "base_revision" | "provenance">>;
type DriverReply = { driver_error?: string; turn_id?: string; response?: Record<string, unknown>; events?: LiveEvent[] };

function liveToolsDriver() {
  const root = path.resolve(process.cwd(), "..");
  const child = spawn(path.join(root, "backend/.venv/Scripts/python.exe"), ["-u", path.join(root, "backend/tests/live_contract_driver.py")], {
    cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let waiting: { resolve: (value: DriverReply) => void; reject: (error: Error) => void } | undefined;
  let failed: Error | undefined;
  const fail = (error: Error) => { failed = error; waiting?.reject(error); waiting = undefined; };
  child.on("error", fail);
  child.stdin.on("error", fail);
  // The test driver imports only LiveTools. It never loads .env or contacts a provider.
  child.stderr.resume();
  lines.on("line", line => {
    const pending = waiting;
    waiting = undefined;
    if (!pending) { fail(new Error("Unexpected Python contract-driver response.")); return; }
    try { pending.resolve(JSON.parse(line) as DriverReply); }
    catch { pending.reject(new Error("The Python contract driver returned invalid JSON.")); }
  });
  const exited = new Promise<void>(resolve => child.once("close", () => {
    if (waiting) fail(new Error("The Python contract driver closed before responding."));
    resolve();
  }));
  return {
    async request(command: Record<string, unknown>): Promise<DriverReply> {
      if (failed) throw failed;
      if (waiting) throw new Error("Contract-driver commands must be sequential.");
      const reply = await new Promise<DriverReply>((resolve, reject) => {
        const timer = setTimeout(() => { waiting = undefined; reject(new Error("Python contract-driver response timed out.")); }, 10000);
        waiting = {
          resolve: value => { clearTimeout(timer); resolve(value); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
        child.stdin.write(`${JSON.stringify(command)}\n`, error => { if (error) fail(error); });
      });
      expect(reply.driver_error).toBeUndefined();
      return reply;
    },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(timer);
      lines.close();
    },
  };
}

for (const entry of ["UI before Live", "UI during Live", "Live tool"] as const) {
  test(`saved-run explanation: ${entry} uses exact numerical evidence without a render receipt`, async ({ page }, info) => {
    await installMedia(page);
    const relay = await fakeRelay(page);
    const driver = liveToolsDriver();
    let output: OptimizationResult | undefined;
    let simulations = 0;
    await page.route("**/api/optimize", async route => {
      simulations++;
      const reply = await driver.request({ op: "optimize", scenario: route.request().postDataJSON() });
      output = reply.response as OptimizationResult;
      await route.fulfill({ json: output });
    });
    try {
      await openLive(page);
      if (entry !== "UI before Live") await startLive(page, relay);
      if (entry === "Live tool") {
        await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
        await expect.poll(() => relay.context().scenario.confirmed).toBe(true);
        await driver.request({ op: "context", context: relay.context() });
        const action = await driver.request({ op: "dispatch", id: "spoken-simulation", name: "run_lighting_comparison" });
        expect(action.response?.status).toBe("pending_application");
        output = (action.events![0] as Extract<LiveEvent, { type: "result" }>).result;
        await relay.deliver(...action.events!);
        const receipt = await expectAck(relay, action.response!.action_id as string, "applied");
        await driver.request({ op: "ack", action_id: receipt.action_id, status: receipt.status, message: receipt.message, context: receipt.context });
        const completed = await driver.request({ op: "wait", action_id: receipt.action_id });
        expect(completed.response).toMatchObject({ status: "ok", acknowledged: true });
      } else {
        await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
        await expect(page.getByRole("region", { name: "Why this result?", exact: true })).toBeVisible();
        if (entry === "UI before Live") await startLive(page, relay);
        // UI sample calculations do not silently tick Live's review checkbox.
        expect(relay.context().scenario.confirmed).toBe(false);
      }
      await expect.poll(() => relay.context().selected_run?.id).toBe(output!.run!.id);
      const before = await persistedWorkspace(page);
      const context = structuredClone(relay.context());
      const acknowledgments = relay.acknowledgments().length;
      await driver.request({ op: "context", context });
      const explanation = await driver.request({ op: "dispatch", id: "explain-selected", name: "get_scenario_result" });
      expect(explanation.response).toMatchObject({ status: "ok", earlier_result: false,
        run: { id: output!.run!.id, input_snapshot: output!.run!.input_snapshot, evidence: output!.run!.evidence },
        workspace_version: context.selected_run });
      expect(explanation.events!.map(event => event.type)).toEqual(["explanation_status"]);
      const summary = output!.run!.evidence.summary;
      await relay.deliver(...explanation.events!, { type: "transcript", role: "assistant", text: summary }, { type: "turn_complete" });
      expect(relay.acknowledgments()).toHaveLength(acknowledgments);
      expect(relay.context()).toEqual(context);
      expect(await persistedWorkspace(page)).toEqual(before);
      expect(simulations).toBe(entry === "Live tool" ? 0 : 1);
      const why = page.getByRole("region", { name: "Why this result?", exact: true });
      await expect(why).toContainText(summary);
      await expect(page.getByRole("log", { name: "Live transcript" })).toContainText(summary);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export run evidence", exact: true }).click();
      const artifact = await download;
      const exported = JSON.parse(readFileSync((await artifact.path())!, "utf8"));
      expect(JSON.stringify(exported)).toContain(output!.run!.id);
      expect(JSON.stringify(exported)).toContain("131.4");
      await why.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join("..", ".acreiq-local/screenshots", `explanation-${entry.replaceAll(" ", "-")}-${info.project.name}.png`) });
      await page.getByRole("button", { name: "End session", exact: true }).click();
      await expectStopped(page, ["audio"]);
      expect(relay.unexpected).toEqual([]);
    } finally { await driver.close(); }
  });
}

test("saved-run explanation: edited inputs preserve earlier evidence, reruns replace selection and failures keep local evidence", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  const driver = liveToolsDriver();
  const results: OptimizationResult[] = [];
  await page.route("**/api/optimize", async route => {
    const reply = await driver.request({ op: "optimize", scenario: route.request().postDataJSON() });
    results.push(reply.response as OptimizationResult);
    await route.fulfill({ json: reply.response });
  });
  try {
    await openLive(page); await startLive(page, relay);
    await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
    await expect.poll(() => relay.context().selected_run?.id).toBeTruthy();
    const first = structuredClone(relay.context());
    await page.getByRole("spinbutton", { name: "Current schedule", exact: true }).fill("15");
    await page.getByRole("spinbutton", { name: "Current schedule", exact: true }).blur();
    await expect.poll(() => relay.context().scenario.baseline_hours).toBe(15);
    const why = page.getByRole("region", { name: "Why this result?", exact: true });
    await expect(why).toContainText("Earlier result");
    await driver.request({ op: "context", context: relay.context() });
    const old = await driver.request({ op: "dispatch", id: "earlier", name: "get_scenario_result" });
    expect(old.response).toMatchObject({ status: "ok", earlier_result: true, run: { id: first.selected_run!.id, input_snapshot: { baseline_hours: 16 } } });
    await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
    await expect.poll(() => results.length).toBe(2);
    await expect.poll(() => relay.context().selected_run?.id).toBe(results[1].run!.id);
    await driver.request({ op: "context", context: relay.context() });
    const next = await driver.request({ op: "dispatch", id: "new-result", name: "get_scenario_result", args: { alternative_hours: 11.75, alternative_dim: 1 } });
    expect(next.response).toMatchObject({ status: "ok", earlier_result: false,
      run: { input_snapshot: { baseline_hours: 15 }, evidence: { savings: { period_energy_kwh: 657, period_energy_cost_usd: 98.55 } } },
      requested_alternative: { status: "tested", candidate: { rejected_for: ["minimum_dli"], dli_mol_m2_day: 14.805 } } });
    const before = await persistedWorkspace(page);
    const stale = await driver.request({ op: "dispatch", id: "old-id", name: "get_scenario_result", args: { run_id: first.selected_run!.id } });
    expect(stale.response).toMatchObject({ status: "error", code: "stale_run" });
    await relay.deliver(...stale.events!);
    await expect(why.getByRole("alert")).toContainText("selected run changed");
    await expect(why).toContainText(results[1].run!.evidence.summary);
    await expect(page.getByRole("status").filter({ hasText: "Live connected" })).toBeVisible();
    await relay.deliver({ type: "interrupted" });
    expect(await persistedWorkspace(page)).toEqual(before);
    expect(results).toHaveLength(2);
    await relay.deliver(...next.events!);
    await expect(why.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expectStopped(page, ["audio"]);
  } finally { await driver.close(); }
});

test("saved-run explanation: reloading retains the original run for a later Live connection", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  const driver = liveToolsDriver();
  let result: OptimizationResult | undefined;
  await page.route("**/api/optimize", async route => {
    result = (await driver.request({ op: "optimize", scenario: route.request().postDataJSON() })).response as OptimizationResult;
    await route.fulfill({ json: result });
  });
  try {
    await openLive(page);
    await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
    await expect(page.getByRole("region", { name: "Why this result?", exact: true })).toBeVisible();
    await openLive(page);
    await startLive(page, relay);
    expect(relay.context().selected_run?.id).toBe(result!.run!.id);
    expect(relay.context().has_result).toBe(true);
    const before = await persistedWorkspace(page);
    await driver.request({ op: "context", context: relay.context() });
    const answer = await driver.request({ op: "dispatch", id: "after-reload", name: "get_scenario_result" });
    expect(answer.response).toMatchObject({ status: "ok", earlier_result: false, run: result!.run });
    await relay.deliver(...answer.events!);
    await expect(page.getByRole("region", { name: "Why this result?", exact: true })).toContainText(result!.run!.evidence.summary);
    expect(await persistedWorkspace(page)).toEqual(before);
    expect(relay.acknowledgments()).toEqual([]);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expectStopped(page, ["audio"]);
  } finally { await driver.close(); }
});

test("saved-run explanation: legacy history revision remains valid in Live without overwriting accepted inputs", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  const driver = liveToolsDriver();
  let result: OptimizationResult | undefined;
  let simulations = 0;
  await page.route("**/api/optimize", async route => {
    simulations++;
    result = (await driver.request({ op: "optimize", scenario: route.request().postDataJSON() })).response as OptimizationResult;
    await route.fulfill({ json: result });
  });
  try {
    await openLive(page);
    await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
    const why = page.getByRole("region", { name: "Why this result?", exact: true });
    await expect(why).toBeVisible();
    const originalRun = result!.run!;
    const schedule = page.getByRole("spinbutton", { name: "Current schedule", exact: true });
    await schedule.fill("15"); await schedule.blur();
    await expect.poll(async () => (await persistedWorkspace(page)).scenario.baseline_hours).toBe(15);
    const accepted = await persistedWorkspace(page);

    // Reproduce the previous storage format after clearing the active run, with
    // a historical reference newer than the fallback working revision of zero.
    await page.evaluate(id => {
      const saved = JSON.parse(localStorage.getItem("acreiq.workspace.v1")!);
      const original = saved.history.find((run: { id: string }) => run.id === id);
      if (!original?.reference) throw new Error("The original run reference was not persisted.");
      original.reference = { ...original.reference, workspace_revision: 7, accepted_revision: 7 };
      saved.saved_run = null;
      for (const key of ["working_revision", "accepted_revision", "accepted_result_id", "inspected_run_id", "view", "mode"]) delete saved[key];
      localStorage.setItem("acreiq.workspace.v1", JSON.stringify(saved));
    }, originalRun.id);

    // openLive navigates again and instruments the fresh page before connecting.
    await openLive(page);
    await expect(schedule).toHaveValue("15");
    await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Scenarios", exact: true }).click();
    await page.locator(`.history-entry[data-run-id="${originalRun.id}"] .history-row`).click();
    await expect(page.getByRole("region", { name: "Saved run inspection", exact: true })).toContainText("read-only");
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(schedule).toHaveValue(String(originalRun.input_snapshot.baseline_hours));
    await expect(schedule).toBeDisabled();
    await expect(why).toHaveAttribute("data-run-id", originalRun.id);
    expect((await persistedWorkspace(page)).scenario).toEqual(accepted.scenario);
    expect((await persistedWorkspace(page)).assets).toEqual(accepted.assets);

    await startLive(page, relay);
    const context = structuredClone(relay.context());
    expect(context.selected_run).toEqual({ id: originalRun.id, workspace_revision: 7, accepted_revision: 7, proposal_id: null, proposal_version: null });
    expect(context.revision).toBeGreaterThanOrEqual(7);
    expect(context.accepted_revision).toBeLessThanOrEqual(context.revision);
    expect(context.scenario).toEqual(accepted.scenario);
    expect(context.has_result).toBe(true);
    const beforeExplanation = await persistedWorkspace(page);
    const validated = await driver.request({ op: "context", context });
    expect(validated.events).toEqual([]);
    const answer = await driver.request({ op: "dispatch", id: "legacy-history-explanation", name: "get_scenario_result" });
    expect(answer.response).toMatchObject({ status: "ok", earlier_result: true, workspace_version: context.selected_run });
    expect(answer.response?.run).toEqual(originalRun);
    expect(answer.events!.map(event => event.type)).toEqual(["explanation_status"]);
    await relay.deliver(...answer.events!);
    await expect(why).toContainText(originalRun.evidence.summary);
    expect(relay.context()).toEqual(context);
    expect(relay.acknowledgments()).toEqual([]);
    expect(await persistedWorkspace(page)).toEqual(beforeExplanation);
    expect((await persistedWorkspace(page)).scenario).toEqual(accepted.scenario);
    expect(simulations).toBe(1);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expectStopped(page, ["audio"]);
    expect(relay.unexpected).toEqual([]);
  } finally { await driver.close(); }
});

test("saved-run explanation: no result, missing PPFD and infeasible runs remain honest and read-only", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  const driver = liveToolsDriver();
  const results: OptimizationResult[] = [];
  await page.route("**/api/optimize", async route => {
    const result = (await driver.request({ op: "optimize", scenario: route.request().postDataJSON() })).response as OptimizationResult;
    results.push(result);
    await route.fulfill({ json: result });
  });
  try {
    await openLive(page); await startLive(page, relay);
    await driver.request({ op: "context", context: relay.context() });
    const none = await driver.request({ op: "dispatch", id: "no-result", name: "get_scenario_result" });
    expect(none.response?.status).toBe("no_result");
    await relay.deliver(...none.events!);
    await expect(page.locator(".live-error")).toContainText("no selected saved calculation");
    for (const [status, field, value] of [["needs_measurement", "Full-output PPFD", ""], ["no_feasible_configuration", "Power ceiling", "500"]] as const) {
      if (status === "no_feasible_configuration") {
        await page.getByRole("spinbutton", { name: "Full-output PPFD", exact: true }).fill("350");
        await page.getByRole("spinbutton", { name: "Full-output PPFD", exact: true }).blur();
      }
      await page.getByRole("spinbutton", { name: field, exact: true }).fill(value);
      await page.getByRole("spinbutton", { name: field, exact: true }).blur();
      await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
      await expect.poll(() => results.at(-1)?.status).toBe(status);
      await expect.poll(() => relay.context().selected_run?.id).toBe(results.at(-1)!.run!.id);
      const before = await persistedWorkspace(page);
      await driver.request({ op: "context", context: relay.context() });
      const answer = await driver.request({ op: "dispatch", id: status, name: "get_scenario_result" });
      expect(answer.response).toMatchObject({ status: "ok", result: { status, optimized: null, savings: null } });
      await relay.deliver(...answer.events!);
      await expect(page.getByRole("region", { name: "Why this result?", exact: true })).toContainText("No savings are estimated");
      expect(await persistedWorkspace(page)).toEqual(before);
    }
    expect(relay.acknowledgments()).toEqual([]);
    expect(results).toHaveLength(2);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expectStopped(page, ["audio"]);
  } finally { await driver.close(); }
});

// Only getUserMedia is faked. Capture, resampling, AudioWorklet, JPEG encoding,
// and playback run through the browser's real media implementations.
async function installMedia(page: Page, failure?: "NotAllowedError" | "NotFoundError") {
  await page.addInitScript(({ failure }) => {
    const audit: MediaAudit = {
      requests: [], tracks: [], contexts: [], worklets: [], sockets: [], sent: [],
      jpegTimes: [], sourceStops: 0, sourceStarts: [], cleanup: new Map(),
    };
    (window as unknown as AuditWindow).__liveTestMedia = audit;
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        audit.contexts.push(this);
      }
    };
    const NativeAudioWorkletNode = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeAudioWorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        audit.worklets.push(name);
      }
    };
    const stopTrack = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      const record = audit.tracks.find(item => item.track === this);
      if (record) record.stops++;
      stopTrack.call(this);
      audit.cleanup.get(this.id)?.();
      audit.cleanup.delete(this.id);
    };
    const startSource = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
      const record = {
        source: this, when, at: this.context.currentTime,
        duration: this.buffer?.duration ?? 0, sampleRate: this.buffer?.sampleRate ?? 0,
      };
      startSource.call(this, when, offset, duration);
      audit.sourceStarts.push(record);
    };
    const stopSource = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when?: number) {
      audit.sourceStops++;
      stopSource.call(this, when);
    };
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      if (type === "image/jpeg") audit.jpegTimes.push(performance.now());
      toBlob.call(this, callback, type, quality);
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
        audit.requests.push(constraints);
        if (failure) throw new DOMException("Private device diagnostic must not be displayed", failure);
        let stream: MediaStream;
        let cleanup: () => void;
        if (constraints.audio) {
          const context = new AudioContext({ sampleRate: 48000 });
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const destination = context.createMediaStreamDestination();
          oscillator.frequency.value = 440;
          gain.gain.value = 0.15;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          await context.resume();
          stream = destination.stream;
          cleanup = () => { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); void context.close(); };
        } else if (constraints.video) {
          const canvas = document.createElement("canvas");
          canvas.width = 960; canvas.height = 720;
          const context = canvas.getContext("2d")!;
          let frame = 0;
          const draw = () => {
            context.fillStyle = "#e02020";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#20d040";
            context.fillRect(240 + frame++ % 20, 180, 480, 360);
          };
          draw();
          stream = canvas.captureStream(10);
          const timer = setInterval(draw, 100);
          cleanup = () => { clearInterval(timer); canvas.width = 0; canvas.height = 0; };
        } else throw new Error("Test requires explicit microphone or camera constraints");
        for (const track of stream.getTracks()) {
          audit.tracks.push({ track, stops: 0 });
          audit.cleanup.set(track.id, cleanup);
        }
        return stream;
      },
    });
  }, { failure });
}

async function mediaState(page: Page) {
  return page.evaluate(() => {
    const audit = (window as unknown as AuditWindow).__liveTestMedia;
    return {
      requests: audit.requests,
      tracks: audit.tracks.map(({ track, stops }) => ({ kind: track.kind, state: track.readyState, enabled: track.enabled, stops })),
      contexts: audit.contexts.map(context => ({ sampleRate: context.sampleRate, state: context.state })),
      worklets: audit.worklets,
      sockets: audit.sockets.map(socket => socket.readyState),
      sent: audit.sent, jpegTimes: audit.jpegTimes, sourceStops: audit.sourceStops,
      sourceStarts: audit.sourceStarts.map(({ source, ...start }) => ({ ...start, buffered: source.buffer !== null })),
    };
  });
}

async function fakeRelay(page: Page, { autoReady = true }: { autoReady?: boolean } = {}) {
  const messages: ClientEvent[] = [];
  const sockets: WebSocketRoute[] = [];
  const bootstraps: unknown[] = [];
  const unexpected: string[] = [];
  let delivered = 0;
  let actionNumber = 0;
  const prepare = (event: RelayEvent): LiveEvent => {
    if (["draft", "view", "result", "proposal_action"].includes(event.type)) {
      return { ...event, action_id: (event as ActionEvent).action_id ?? `browser-action-${++actionNumber}` } as LiveEvent;
    }
    return event as LiveEvent;
  };
  await mockHealth(page);
  await page.route("**/*", async route => {
    const address = new URL(route.request().url());
    if (["fonts.googleapis.com", "fonts.gstatic.com"].includes(address.hostname)) {
      await route.abort("blockedbyclient");
    } else if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) || address.pathname.startsWith("/live/")) {
      unexpected.push(address.origin + address.pathname);
      await route.abort("blockedbyclient");
    } else await route.fallback();
  });
  // A fail-closed default also prevents a changed socket URL from contacting a provider.
  await page.routeWebSocket(/.*/, async socket => {
    unexpected.push(socket.url());
    await socket.close({ code: 1008, reason: "Only the local test relay is allowed" });
  });
  await page.routeWebSocket(SOCKET_URL, socket => {
    sockets.push(socket);
    socket.onMessage(raw => {
      const message = JSON.parse(raw.toString()) as ClientEvent;
      messages.push(message);
      if (autoReady && message.type === "auth" && message.token === SESSION_TOKEN) {
        socket.send(JSON.stringify({ type: "ready", model: "mock-live-model", max_duration_seconds: 300 }));
      }
    });
  });
  await page.route("**/api/live/session", route => {
    bootstraps.push(route.request().postDataJSON());
    return route.fulfill({ json: {
      token: SESSION_TOKEN, resume_token: RESUME_TOKEN, websocket_url: SOCKET_URL,
      model: "mock-live-model", max_duration_seconds: 300,
    } });
  });
  return {
    messages, sockets, bootstraps, unexpected,
    context: () => messages.filter((message): message is Extract<ClientEvent, { type: "context" }> => message.type === "context").at(-1)!.context,
    acknowledgments: () => messages.filter((message): message is Extract<ClientEvent, { type: "action_ack" }> => message.type === "action_ack"),
    send: (event: RelayEvent) => sockets.at(-1)!.send(JSON.stringify(prepare(event))),
    async deliver(...events: RelayEvent[]) {
      const prepared = events.map(prepare);
      const initialAcks = messages.filter(message => message.type === "action_ack").length;
      for (const event of prepared) sockets.at(-1)!.send(JSON.stringify(event));
      // The usage marker proves preceding events were handled before negative assertions.
      sockets.at(-1)!.send(JSON.stringify({ type: "usage", total_tokens: ++delivered }));
      await expect(page.getByLabel("Live usage", { exact: true })).toContainText(`${delivered} tokens reported`);
      const actionIds = prepared.filter((event): event is ActionEvent => "action_id" in event).map(event => event.action_id);
      // Receipts follow the React commit and two animation frames, not the usage marker.
      await expect.poll(() => messages.filter(message => message.type === "action_ack").slice(initialAcks)
        .filter(message => actionIds.includes((message as Extract<ClientEvent, { type: "action_ack" }>).action_id)).length).toBe(actionIds.length);
    },
  };
}
type Relay = Awaited<ReturnType<typeof fakeRelay>>;

async function openLive(page: Page) {
  await page.goto("/");
  // Install after navigation so instrumentation wraps Playwright's routed socket.
  await page.evaluate(() => {
    const audit = (window as unknown as AuditWindow).__liveTestMedia;
    window.WebSocket = new Proxy(window.WebSocket, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        audit.sockets.push(socket);
        const send = socket.send.bind(socket);
        socket.send = data => {
          if (typeof data === "string") {
            const message = JSON.parse(data) as { type: string; data?: string };
            audit.sent.push({ type: message.type, at: performance.now(), bytes: message.data ? atob(message.data).length : 0 });
          }
          send(data);
        };
        return socket;
      },
    });
  });
  await page.getByRole("button", { name: "Walk through my space", exact: true }).click();
  await expect(page.getByRole("region", { name: "AcreIQ Live", exact: true })).toBeVisible();
}

async function startLive(page: Page, relay: Relay) {
  await page.getByRole("checkbox", { name: CONSENT }).check();
  await page.getByRole("button", { name: "Start Live", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Live connected" })).toBeVisible();
  await expect.poll(() => relay.messages.some(message => message.type === "context")).toBe(true);
  expect(relay.messages.find(message => message.type === "auth")).toEqual({ type: "auth", token: SESSION_TOKEN });
  expect(relay.bootstraps).toEqual([{}]);
}

async function expectStopped(page: Page, kinds: string[]) {
  await expect.poll(async () => (await mediaState(page)).tracks.map(track => track.kind).sort()).toEqual([...kinds].sort());
  await expect.poll(async () => {
    const state = await mediaState(page);
    return state.tracks.every(track => track.state === "ended" && track.stops > 0)
      && state.contexts.every(context => context.state === "closed")
      && state.sockets.every(socket => socket === 3);
  }).toBe(true);
  await expect(page.getByRole("log", { name: "Live transcript" })).toHaveText("No conversation in progress.");
  expect(await page.getByLabel("Private camera preview").evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
}

function inputDraft(relay: Relay, id: string, inputs: LiveDraft["inputs"] = [{ field: "length_ft", value: 12, unit: "ft" }]): VersionedDraft {
  const context = relay.context();
  expect(context.accepted_revision).toEqual(expect.any(Number));
  return {
    id, revision: context.revision, proposal_id: context.proposal?.id ?? `proposal-${id}`,
    version: (context.proposal?.version ?? 0) + 1, base_revision: context.accepted_revision!,
    reason: "Revised schematic based on the user's instruction.", inputs, inventory: [],
    provenance: { turn_ids: ["user-turn-1"], basis: "user_instruction" },
  };
}

function proposalReview(page: Page) {
  return page.getByRole("region", { name: "Proposed version review", exact: true });
}

async function expectAck(relay: Relay, actionId: string, status: "applied" | "rejected") {
  await expect.poll(() => {
    const receipt = relay.acknowledgments().find(message => message.action_id === actionId);
    return status === "applied" && receipt?.status === "rejected"
      ? `rejected: ${receipt.message}`
      : receipt?.status;
  }).toBe(status);
  const receipt = relay.acknowledgments().find(message => message.action_id === actionId)!;
  expect(receipt.message).toEqual(expect.any(String));
  expect(receipt.context).toBeDefined();
  return receipt;
}

function proposalAction(relay: Relay, action: "approve" | "revise" | "discard" | "undo", actionId: string): ActionEvent {
  const context = relay.context();
  return {
    type: "proposal_action", action_id: actionId, action,
    proposal_id: context.proposal?.id ?? null,
    version: context.proposal?.version ?? null,
    revision: context.revision,
  };
}

async function editInput(page: Page, name: string, value: string) {
  await page.getByRole("button", { name: "Inputs", exact: true }).click();
  const input = page.getByRole("spinbutton", { name, exact: true });
  await input.fill(value);
  await input.blur();
}

function liveAlert(page: Page) {
  return page.getByRole("region", { name: "AcreIQ Live", exact: true }).getByRole("alert");
}

function audioChunks(count: number, milliseconds = 20): LiveEvent[] {
  const pcm = Buffer.alloc(24000 * milliseconds / 1000 * 2);
  for (let sample = 0; sample < pcm.length / 2; sample++) {
    pcm.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 330 / 24000) * 1000), sample * 2);
  }
  const data = pcm.toString("base64");
  return Array.from({ length: count }, () => ({ type: "audio", data }));
}

async function expectListeningWithCameraOff(page: Page, relay: Relay) {
  await expect(page.getByRole("status").filter({ hasText: "Live connected" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mute microphone", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Enable camera and share frames", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "AcreIQ Live", exact: true }).getByText("Camera off", { exact: true })).toBeVisible();
  const state = await mediaState(page);
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({ video: false });
  expect(state.tracks).toEqual([{ kind: "audio", state: "live", enabled: true, stops: 0 }]);
  expect(state.contexts.every(context => context.state === "running")).toBe(true);
  expect(state.sockets).toEqual([1]);
  expect(state.jpegTimes).toEqual([]);
  expect(relay.messages.filter(message => ["video", "audio_end", "end"].includes(message.type))).toEqual([]);
  expect(await page.getByLabel("Private camera preview").evaluate((video: HTMLVideoElement) => video.srcObject)).toBeNull();
  const captured = state.sent.filter(message => message.type === "audio").length;
  await expect.poll(async () => (await mediaState(page)).sent.filter(message => message.type === "audio").length).toBeGreaterThan(captured);
  expect(relay.unexpected).toEqual([]);
}

async function endSpokenReplySession(page: Page, relay: Relay) {
  const playing = await mediaState(page);
  const hadProposal = await proposalReview(page).count();
  expect(playing.sourceStarts.some(source => source.buffered)).toBe(true);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expectStopped(page, ["audio"]);
  await expect(proposalReview(page)).toHaveCount(hadProposal);
  await expect(page.getByRole("button", { name: "Stop spoken reply", exact: true })).toHaveCount(0);
  await expect.poll(() => relay.messages.filter(message => message.type === "end").length).toBe(1);
  const ended = await mediaState(page);
  expect(ended.sourceStops).toBeGreaterThan(playing.sourceStops);
  expect(ended.sourceStarts.every(source => !source.buffered)).toBe(true);
  // More than two capture intervals catches microphone callbacks surviving End.
  await page.waitForTimeout(300);
  const after = await mediaState(page);
  expect(after.sourceStarts).toEqual(ended.sourceStarts);
  expect(after.sent).toEqual(ended.sent);
  expect(relay.unexpected).toEqual([]);
}

test("Live asks for consent and Start before permissions, then captures and mutes real worklet audio", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await expect(page.getByRole("button", { name: "Start Live", exact: true })).toBeDisabled();
  expect((await mediaState(page)).requests).toEqual([]);
  expect(relay.bootstraps).toEqual([]);
  expect(relay.sockets).toEqual([]);
  await page.getByRole("checkbox", { name: CONSENT }).check();
  expect((await mediaState(page)).requests).toEqual([]);
  expect((await mediaState(page)).worklets).toEqual([]);
  await startLive(page, relay);
  await expect.poll(() => relay.messages.filter(message => message.type === "audio").length).toBeGreaterThan(1);
  // Native capture may begin with a silent startup frame before the oscillator reaches the graph.
  const audiblePacket = () => relay.messages.find((message): message is Extract<ClientEvent, { type: "audio" | "video" }> =>
    message.type === "audio" && Buffer.from(message.data, "base64").some(byte => byte !== 0));
  await expect.poll(() => audiblePacket() !== undefined).toBe(true);
  const audio = audiblePacket()!;
  const pcm = Buffer.from(audio.data, "base64");
  expect(pcm.length).toBe(3200);
  expect(pcm.some(byte => byte !== 0)).toBe(true);
  expect((await mediaState(page)).worklets).toEqual(["live-capture"]);
  const state = await mediaState(page);
  expect(state.contexts.map(context => context.sampleRate)).toEqual(expect.arrayContaining([16000, 48000]));
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({ video: false });
  await page.getByRole("button", { name: "Mute microphone", exact: true }).click();
  await expect.poll(() => relay.messages.some(message => message.type === "audio_end")).toBe(true);
  expect((await mediaState(page)).tracks[0].enabled).toBe(false);
  const mutedCount = (await mediaState(page)).sent.filter(message => message.type === "audio").length;
  await page.waitForTimeout(300);
  expect((await mediaState(page)).sent.filter(message => message.type === "audio")).toHaveLength(mutedCount);
  await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
  await expect.poll(async () => (await mediaState(page)).sent.filter(message => message.type === "audio").length).toBeGreaterThan(mutedCount);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expectStopped(page, ["audio"]);
  expect(relay.unexpected).toEqual([]);
});

for (const [failure, message] of [
  ["NotAllowedError", "Media permission was denied."],
  ["NotFoundError", "No matching microphone or camera was found."],
] as const) {
  test(`${failure} leaves photo upload and blank manual inputs available`, async ({ page }) => {
    await installMedia(page, failure);
    const relay = await fakeRelay(page);
    await openLive(page);
    await page.getByRole("checkbox", { name: CONSENT }).check();
    await page.getByRole("button", { name: "Start Live", exact: true }).click();
    await expect(liveAlert(page)).toContainText(message);
    await expect(liveAlert(page)).toContainText("Photo upload and manual inputs remain available.");
    await expect(liveAlert(page)).not.toContainText("Private device diagnostic");
    await expect(page.getByRole("button", { name: "Reconnect Live" })).toBeEnabled();
    await expectStopped(page, []);
    expect(relay.bootstraps).toEqual([]);
    expect(relay.sockets).toEqual([]);
    await page.getByRole("button", { name: "Scan a space", exact: true }).click();
    await expect(page.locator('input[type="file"]:not([capture])')).toBeAttached();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start a blank real space", exact: true }).click();
    await expectFreshMeasurements(page);
    expect(relay.unexpected).toEqual([]);
  });
}

for (const [status, detail] of [
  [503, "The configured Live model is unavailable. Check the server model configuration."],
  [429, "Live quota is exhausted. Try again after your quota resets."],
] as const) {
  test(`bootstrap ${status} displays the sanitized error and never reports success`, async ({ page }) => {
    await installMedia(page);
    const relay = await fakeRelay(page);
    let requests = 0;
    await page.route("**/api/live/session", route => {
      requests++;
      return route.fulfill({ status, json: { detail, diagnostic: "PRIVATE_PROVIDER_DIAGNOSTIC", token: SESSION_TOKEN } });
    });
    await openLive(page);
    await page.getByRole("checkbox", { name: CONSENT }).check();
    await page.getByRole("button", { name: "Start Live", exact: true }).click();
    await expect(liveAlert(page)).toContainText(detail);
    await expect(page.getByRole("status").filter({ hasText: "Live connected" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("PRIVATE_PROVIDER_DIAGNOSTIC");
    await expect(page.locator("body")).not.toContainText(SESSION_TOKEN);
    await expectStopped(page, ["audio"]);
    expect(requests).toBe(1);
    expect(relay.sockets).toEqual([]);
    await expect(page.getByRole("button", { name: "Scan a space", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Start a blank real space", exact: true }).click();
    await expectFreshMeasurements(page);
    expect(relay.unexpected).toEqual([]);
  });
}

test("camera is opt-in, sends bounded real JPEGs at most once per second, and End releases media without adopting a preview", async ({ page }, info) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  expect((await mediaState(page)).requests.some(request => request.video)).toBe(false);
  await page.getByRole("button", { name: "Enable camera and share frames", exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn camera off", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => relay.messages.filter(message => message.type === "video").length).toBeGreaterThanOrEqual(3);
  const videos = relay.messages.filter((message): message is Extract<ClientEvent, { type: "audio" | "video" }> => message.type === "video");
  const encoded = Buffer.from(videos[0].data, "base64");
  expect(encoded.length).toBeLessThanOrEqual(200 * 1024);
  const metadata = await sharp(encoded).metadata();
  expect(metadata.format).toBe("jpeg");
  expect(metadata.width).toBeLessThanOrEqual(640);
  expect(metadata.height).toBeLessThanOrEqual(480);
  const pixels = await sharp(encoded).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...pixels.data.subarray((y * pixels.info.width + x) * pixels.info.channels, (y * pixels.info.width + x) * pixels.info.channels + 3)];
  const corner = pixel(20, 20);
  const center = pixel(Math.floor(pixels.info.width / 2), Math.floor(pixels.info.height / 2));
  expect(corner[0]).toBeGreaterThan(corner[1] * 2);
  expect(center[1]).toBeGreaterThan(center[0] * 2);
  const captured = await mediaState(page);
  const videoTimes = captured.sent.filter(message => message.type === "video").map(message => message.at);
  expect(captured.jpegTimes.length).toBeGreaterThanOrEqual(3);
  for (const times of [captured.jpegTimes, videoTimes]) {
    for (let index = 1; index < times.length; index++) expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(1000);
  }
  await relay.deliver(
    { type: "transcript", role: "user", text: "A camera test, with no real scene or device." },
    { type: "draft", draft: inputDraft(relay, "end-pending-draft") },
  );
  await expect(proposalReview(page)).toBeVisible();
  const accepted = await savedWorkspace(page);
  await page.getByRole("region", { name: "AcreIQ Live", exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const panel = await page.getByRole("region", { name: "AcreIQ Live", exact: true }).boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual((page.viewportSize()!.width) + 1);
  await page.screenshot({ path: info.outputPath(`live-camera-${info.project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expectStopped(page, ["audio", "video"]);
  await expect(proposalReview(page)).toBeVisible();
  expect(await savedWorkspace(page)).toEqual(accepted);
  await expect.poll(() => relay.messages.some(message => message.type === "end")).toBe(true);
  const ended = await mediaState(page);
  // Wait beyond the camera interval to catch callbacks surviving End.
  await page.waitForTimeout(1200);
  const after = await mediaState(page);
  expect(after.jpegTimes).toEqual(ended.jpegTimes);
  expect(after.sent.filter(message => ["audio", "video"].includes(message.type))).toEqual(ended.sent.filter(message => ["audio", "video"].includes(message.type)));
  expect(relay.unexpected).toEqual([]);
});

for (const cause of ["relay error", "socket error", "disconnect"] as const) {
  test(`${cause} releases microphone and camera without changing the reviewed workspace`, async ({ page }) => {
    await installMedia(page);
    const relay = await fakeRelay(page);
    await openLive(page);
    await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
    await startLive(page, relay);
    const before = await savedWorkspace(page);
    await page.getByRole("button", { name: "Enable camera and share frames", exact: true }).click();
    await expect(page.getByRole("button", { name: "Turn camera off", exact: true })).toBeEnabled();
    await relay.deliver({ type: "transcript", role: "assistant", text: "This session will stop." });
    if (cause === "relay error") relay.send({ type: "error", code: "quota_exhausted", message: "Live quota is exhausted." });
    else if (cause === "disconnect") await relay.sockets[0].close({ code: 1011, reason: "Mock relay disconnected" });
    else await page.evaluate(() => (window as unknown as AuditWindow).__liveTestMedia.sockets[0].dispatchEvent(new Event("error")));
    await expect(page.getByRole("button", { name: "Reconnect Live", exact: true })).toBeEnabled();
    await expect(liveAlert(page)).toContainText(cause === "relay error" ? "Live quota is exhausted." : "Live disconnected.");
    await expectStopped(page, ["audio", "video"]);
    await expect.poll(() => savedWorkspace(page)).toEqual(before);
    expect(relay.messages.filter(message => message.type === "end")).toEqual([]);
    const stopped = (await mediaState(page)).jpegTimes;
    await page.waitForTimeout(1100);
    expect((await mediaState(page)).jpegTimes).toEqual(stopped);
    expect(relay.unexpected).toEqual([]);
  });
}

test("interruption stops queued audio while all separate transcript parts remain visible", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const pcm = Buffer.alloc(24000 * 2 * 2);
  for (let sample = 0; sample < pcm.length / 2; sample++) pcm.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 330 / 24000) * 1000), sample * 2);
  await relay.deliver(
    { type: "transcript", role: "user", text: "Measure the first area." },
    { type: "turn_complete" },
    { type: "transcript", role: "assistant", text: "The first part " },
    { type: "audio", data: pcm.toString("base64") },
    { type: "transcript", role: "assistant", text: "and its continuation." },
  );
  const stops = (await mediaState(page)).sourceStops;
  await relay.deliver(
    { type: "interrupted" },
    { type: "transcript", role: "user", text: "Wait, use the other area." },
    { type: "turn_complete" },
    { type: "transcript", role: "assistant", text: "Keeping both parts of the conversation." },
  );
  await expect.poll(async () => (await mediaState(page)).sourceStops).toBeGreaterThan(stops);
  const transcript = page.getByRole("log", { name: "Live transcript" });
  await expect(transcript.locator("p")).toHaveCount(4);
  await expect(transcript).toContainText("Measure the first area.");
  await expect(transcript).toContainText("The first part and its continuation.");
  await expect(transcript).toContainText("Wait, use the other area.");
  await expect(transcript).toContainText("Keeping both parts of the conversation.");
  await expect(page.getByRole("status").filter({ hasText: "Live connected" })).toBeVisible();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expectStopped(page, ["audio"]);
  expect(relay.unexpected).toEqual([]);
});

test("spoken reply: a 12-second burst of 600 PCM24k chunks keeps Live listening and processes transcript, draft and view events", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const primed = await mediaState(page);
  const before = await savedWorkspace(page);
  const draft = inputDraft(relay, "burst-draft");
  await relay.deliver(
    { type: "transcript", role: "user", text: "Review the room with me." },
    { type: "turn_complete" },
    ...audioChunks(600),
    { type: "transcript", role: "assistant", text: "The spoken reply is still queued. " },
    { type: "draft", draft },
    { type: "view", camera: "top", asset_id: "rack-1" },
    { type: "transcript", role: "assistant", text: "Review this measurement before applying it." },
  );
  const playback = await mediaState(page);
  const reply = playback.sourceStarts.slice(primed.sourceStarts.length);
  expect(reply).toHaveLength(600);
  expect(reply.every(source => source.sampleRate === 24000 && source.duration === 0.02)).toBe(true);
  expect(reply.reduce((seconds, source) => seconds + source.duration, 0)).toBeCloseTo(12, 5);
  // Prove delivery outran playback and actually exceeded the former five-second limit.
  expect(reply.some(source => source.when + source.duration - source.at > 5)).toBe(true);
  expect(playback.sourceStops).toBe(primed.sourceStops);
  await expect(liveAlert(page)).toHaveCount(0);
  const transcript = page.getByRole("log", { name: "Live transcript" });
  await expect(transcript.locator("p")).toHaveCount(2);
  await expect(transcript).toContainText("Review the room with me.");
  await expect(transcript).toContainText("The spoken reply is still queued. Review this measurement before applying it.");
  await expect(proposalReview(page)).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("12");
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => relay.context().selected_asset_id).toBe("rack-1");
  expect(await savedWorkspace(page)).toEqual(before);
  await expectListeningWithCameraOff(page, relay);
  await endSpokenReplySession(page, relay);
});

for (const boundary of ["turn_complete", "interrupted"] as const) {
  test(`spoken reply: overflow stops only playback, preserves edits and ignores audio until ${boundary}`, async ({ page }) => {
    await installMedia(page);
    const relay = await fakeRelay(page);
    await openLive(page);
    await startLive(page, relay);
    const before = await savedWorkspace(page);
    await relay.deliver(
      { type: "transcript", role: "user", text: "Keep my reviewed measurements." },
      { type: "turn_complete" },
      { type: "transcript", role: "assistant", text: "This transcript must survive overflow. " },
      { type: "draft", draft: inputDraft(relay, `overflow-${boundary}`) },
    );
    const review = proposalReview(page);
    await review.getByRole("button", { name: "Revise", exact: true }).click();
    await editInput(page, "Length", "11");
    // Each chunk is below 256 KiB; only the accumulated queue can hit the 30-second cap.
    await relay.deliver(
      ...audioChunks(40, 1000),
      { type: "transcript", role: "assistant", text: "Text still arrives after the queue fills. " },
      { type: "view", camera: "top", asset_id: "rack-1" },
    );
    const overflowed = await mediaState(page);
    expect(overflowed.sourceStarts.length).toBeGreaterThan(0);
    expect(overflowed.sourceStarts.length).toBeLessThan(40);
    expect(overflowed.sourceStarts.every(source => source.when + source.duration - source.at <= 30.001)).toBe(true);
    expect(overflowed.sourceStops).toBeGreaterThan(0);
    expect(overflowed.sourceStarts.every(source => !source.buffered)).toBe(true);
    const transcript = page.getByRole("log", { name: "Live transcript" });
    await expect(transcript).toContainText("Keep my reviewed measurements.");
    await expect(transcript).toContainText("This transcript must survive overflow. Text still arrives after the queue fills.");
    await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("11");
    await expect(review.getByRole("button", { name: "Use this version", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => relay.context().selected_asset_id).toBe("rack-1");
    await expectListeningWithCameraOff(page, relay);
    await relay.deliver(
      ...audioChunks(20),
      { type: "transcript", role: "assistant", text: "The remainder of this reply stays silent." },
    );
    const suppressed = await mediaState(page);
    expect(suppressed.sourceStarts).toEqual(overflowed.sourceStarts);
    expect(suppressed.sourceStops).toBe(overflowed.sourceStops);
    await expect(transcript).toContainText("The remainder of this reply stays silent.");
    await relay.deliver(
      { type: boundary },
      ...audioChunks(2, 2000),
      { type: "transcript", role: "assistant", text: "The next spoken reply can play." },
    );
    const resumed = await mediaState(page);
    expect(resumed.sourceStarts).toHaveLength(overflowed.sourceStarts.length + 2);
    expect(resumed.sourceStarts.slice(-2).every(source => source.sampleRate === 24000 && source.duration === 2)).toBe(true);
    await expect(transcript.locator("p")).toHaveCount(3);
    await expect(transcript).toContainText("The next spoken reply can play.");
    await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("11");
    expect(await savedWorkspace(page)).toEqual(before);
    await expectListeningWithCameraOff(page, relay);
    await endSpokenReplySession(page, relay);
  });
}

test("spoken reply: Stop spoken reply is connected-only and suppresses the current reply until turn_complete", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page, { autoReady: false });
  await openLive(page);
  const stopReply = page.getByRole("button", { name: "Stop spoken reply", exact: true });
  await expect(stopReply).toHaveCount(0);
  await page.getByRole("checkbox", { name: CONSENT }).check();
  await page.getByRole("button", { name: "Start Live", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connecting" })).toBeVisible();
  await expect.poll(() => relay.messages.some(message => message.type === "auth")).toBe(true);
  await expect(page.getByRole("button", { name: "Stop spoken reply", exact: true, disabled: false })).toHaveCount(0);
  await relay.deliver({ type: "ready", model: "mock-live-model", max_duration_seconds: 300 });
  await expect.poll(() => relay.messages.some(message => message.type === "context")).toBe(true);
  await expect(stopReply).toBeEnabled();
  const primed = await mediaState(page);
  const before = await savedWorkspace(page);
  await relay.deliver(
    { type: "transcript", role: "assistant", text: "Keep this transcript while stopping speech. " },
    { type: "draft", draft: inputDraft(relay, "stop-spoken-draft") },
    ...audioChunks(4, 2000),
  );
  const review = proposalReview(page);
  await review.getByRole("button", { name: "Revise", exact: true }).click();
  await editInput(page, "Length", "10");
  const playing = await mediaState(page);
  expect(playing.sourceStarts).toHaveLength(primed.sourceStarts.length + 4);
  expect(playing.sourceStops).toBe(primed.sourceStops);
  await stopReply.click();
  const stopped = await mediaState(page);
  expect(stopped.sourceStops).toBeGreaterThan(playing.sourceStops);
  expect(stopped.sourceStarts.every(source => !source.buffered)).toBe(true);
  await relay.deliver(
    ...audioChunks(8, 1000),
    { type: "transcript", role: "assistant", text: "Text can continue while this spoken reply is stopped." },
    { type: "view", camera: "top" },
  );
  const ignored = await mediaState(page);
  expect(ignored.sourceStarts).toEqual(stopped.sourceStarts);
  expect(ignored.sourceStops).toBe(stopped.sourceStops);
  const transcript = page.getByRole("log", { name: "Live transcript" });
  await expect(transcript).toContainText("Keep this transcript while stopping speech. Text can continue while this spoken reply is stopped.");
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("10");
  await expect(review.getByRole("button", { name: "Use this version", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectListeningWithCameraOff(page, relay);
  await expect(stopReply).toBeEnabled();
  await relay.deliver(
    { type: "turn_complete" },
    ...audioChunks(2, 2000),
    { type: "transcript", role: "assistant", text: "A new spoken reply is audible again." },
  );
  const resumed = await mediaState(page);
  expect(resumed.sourceStarts).toHaveLength(stopped.sourceStarts.length + 2);
  expect(resumed.sourceStarts.slice(-2).every(source => source.sampleRate === 24000 && source.duration === 2)).toBe(true);
  await expect(transcript.locator("p")).toHaveCount(2);
  await expect(transcript).toContainText("A new spoken reply is audible again.");
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("10");
  expect(await savedWorkspace(page)).toEqual(before);
  await expectListeningWithCameraOff(page, relay);
  await endSpokenReplySession(page, relay);
});

test("spoken reply: stopping idle or completed speech does not suppress the next reply", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const primed = await mediaState(page);
  const stopReply = page.getByRole("button", { name: "Stop spoken reply", exact: true });
  await stopReply.click();
  const idleStopped = await mediaState(page);
  expect(idleStopped.sourceStarts).toHaveLength(primed.sourceStarts.length);
  await relay.deliver(
    ...audioChunks(2, 2000),
    { type: "transcript", role: "assistant", text: "The first reply plays after an idle stop." },
    { type: "turn_complete" },
  );
  const completed = await mediaState(page);
  expect(completed.sourceStarts).toHaveLength(primed.sourceStarts.length + 2);
  expect(completed.sourceStarts.some(source => source.buffered)).toBe(true);
  expect(completed.sourceStops).toBe(idleStopped.sourceStops);
  // The provider finished its turn, but native playback still has queued speech.
  await stopReply.click();
  const stopped = await mediaState(page);
  expect(stopped.sourceStops).toBeGreaterThan(completed.sourceStops);
  expect(stopped.sourceStarts.every(source => !source.buffered)).toBe(true);
  await relay.deliver(
    ...audioChunks(2, 2000),
    { type: "transcript", role: "assistant", text: "The next reply plays without another turn boundary." },
  );
  const resumed = await mediaState(page);
  expect(resumed.sourceStarts).toHaveLength(primed.sourceStarts.length + 4);
  expect(resumed.sourceStops).toBe(stopped.sourceStops);
  const transcript = page.getByRole("log", { name: "Live transcript" });
  await expect(transcript.locator("p")).toHaveCount(2);
  await expect(transcript).toContainText("The first reply plays after an idle stop.");
  await expect(transcript).toContainText("The next reply plays without another turn boundary.");
  await expectListeningWithCameraOff(page, relay);
  await endSpokenReplySession(page, relay);
});

test("a grouped draft previews canonical inputs and inventory before UI adoption clears confirmations", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft = inputDraft(relay, "review-edit", [
    { field: "length_ft", value: 12, unit: "ft" },
    { field: "ppfd_full", value: 420, unit: "umol/m2/s" },
    { field: "dimmable", value: true, unit: "boolean" },
  ]);
  draft.inventory = [{ operation: "update", id: "light-1", asset_type: "light_fixture", name: "Suggested lights", quantity: 3 }];
  await relay.deliver({ type: "draft", action_id: "atomic-preview", draft });
  const receipt = await expectAck(relay, "atomic-preview", "applied");
  const review = proposalReview(page);
  await expect(review).toBeVisible();
  expect(receipt.context.scenario).toMatchObject({ length_ft: 12, ppfd_full: 420, dimmable: true, light_count: 3, confirmed: false });
  expect(receipt.context.assets.find(asset => asset.id === "light-1")).toMatchObject({ name: "Suggested lights", quantity: 3, confirmed: false });
  expect(await savedWorkspace(page)).toEqual(before);
  await review.getByRole("button", { name: "Revise", exact: true }).click();
  await editInput(page, "Length", "11");
  await editInput(page, "Full-output PPFD", "410");
  await expect.poll(() => relay.context().proposal?.version).toBeGreaterThan(draft.version);
  expect(await savedWorkspace(page)).toEqual(before);
  await review.getByRole("button", { name: "Use this version", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(async () => (await savedWorkspace(page)).scenario).toMatchObject({ length_ft: 11, ppfd_full: 410, dimmable: true, light_count: 3, confirmed: false, source: "sample" });
  const after = await savedWorkspace(page);
  expect(after.assets.find(asset => asset.id === "light-1")).toMatchObject({ name: "Suggested lights", quantity: 3 });
  expect(after.assets.every(asset => !asset.confirmed)).toBe(true);
  await expect(page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true })).not.toBeChecked();
  await expect.poll(() => relay.context().proposal).toBeNull();
  expect(relay.context().can_undo).toBe(true);
  await expect.poll(() => relay.context().revision).toBeGreaterThan(draft.revision);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("invalid units are rejected before display and cancellation cannot erase an acknowledged preview", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const invalid = inputDraft(relay, "wrong-unit", [{ field: "length_ft", value: 12, unit: "m" }]);
  await relay.deliver({ type: "draft", action_id: "invalid-preview", draft: invalid });
  const invalidReceipt = await expectAck(relay, "invalid-preview", "rejected");
  expect(invalidReceipt.message).toMatch(/field|unit/i);
  const review = proposalReview(page);
  await expect(review).toHaveCount(0);
  expect(await savedWorkspace(page)).toEqual(before);
  const cancelled = inputDraft(relay, "cancelled-before-display");
  await relay.deliver({ type: "draft_cancelled", id: cancelled.id });
  await relay.deliver({ type: "draft", action_id: "cancelled-preview", draft: cancelled });
  await expectAck(relay, "cancelled-preview", "rejected");
  await expect(review).toHaveCount(0);
  const displayed = inputDraft(relay, "acknowledged-preview");
  await relay.deliver({ type: "draft", action_id: "displayed-preview", draft: displayed });
  await expectAck(relay, "displayed-preview", "applied");
  await relay.deliver({ type: "draft_cancelled", id: displayed.id }, { type: "interrupted" });
  await expect(review).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("12");
  expect(await savedWorkspace(page)).toEqual(before);
  await review.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("8");
  expect(await savedWorkspace(page)).toEqual(before);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("a local proposal revision rejects late drafts and stale spoken approval without losing edits", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const stale = inputDraft(relay, "old-revision");
  await relay.deliver({ type: "draft", draft: stale });
  const oldApproval = proposalAction(relay, "approve", "stale-approval");
  const review = proposalReview(page);
  await review.getByRole("button", { name: "Revise", exact: true }).click();
  await editInput(page, "Length", "9");
  await expect.poll(() => relay.context().revision).toBeGreaterThan(stale.revision);
  const before = await savedWorkspace(page);
  await expect.poll(() => relay.context().proposal?.version).toBeGreaterThan(stale.version);
  await relay.deliver({ type: "draft", action_id: "late-preview", draft: { ...stale, id: "late-old-revision" } }, oldApproval);
  await expectAck(relay, "late-preview", "rejected");
  await expectAck(relay, "stale-approval", "rejected");
  await expect(review.getByRole("button", { name: "Use this version", exact: true })).toBeEnabled();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("9");
  expect(await savedWorkspace(page)).toEqual(before);
  expect(relay.context().proposal?.id).toBe(stale.proposal_id);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("view events accept only known assets and supported camera views", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const asset = relay.context().assets.find(item => item.id === "rack-1")!;
  await relay.deliver({ type: "view", action_id: "valid-top-view", camera: "top", asset_id: asset.id });
  await expectAck(relay, "valid-top-view", "applied");
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => relay.context().selected_asset_id).toBe(asset.id);
  await expect(page.getByRole("button", { name: "Clear asset selection", exact: true })).toBeVisible();
  await relay.deliver({ type: "view", action_id: "unsupported-camera", camera: "unrecognized" as "top" });
  await expectAck(relay, "unsupported-camera", "rejected");
  await relay.deliver({ type: "view", action_id: "invalid-view", camera: "unrecognized" as "top", asset_id: "invented-asset-id" });
  await expectAck(relay, "invalid-view", "rejected");
  expect(relay.context().selected_asset_id).toBe(asset.id);
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "true");
  await relay.deliver({ type: "view", camera: "perspective" });
  await expect(page.getByRole("button", { name: "Top view", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await savedWorkspace(page)).toEqual(before);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("Live results require confirmed current inputs and blank manual measurements never inherit sample results", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const initial = relay.context();
  // This endpoint is the local numerical engine, with no model/provider call.
  const solved = await page.request.post("/api/optimize", { data: { ...initial.scenario, confirmed: true } });
  expect(solved.status()).toBe(200);
  const result = await solved.json() as OptimizationResult;
  expect(result.status).toBe("optimized");
  expect(result.configurations_evaluated).toBe(result.candidates.length);
  await relay.deliver({ type: "result", action_id: "unconfirmed-result", revision: initial.revision, result });
  await expectAck(relay, "unconfirmed-result", "rejected");
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  expect(relay.context().has_result).toBe(false);
  await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
  await expect.poll(() => relay.context().scenario.confirmed).toBe(true);
  expect(relay.context().assets.every(asset => asset.confirmed)).toBe(true);
  await relay.deliver({ type: "result", action_id: "stale-result", revision: relay.context().revision - 1, result });
  await expectAck(relay, "stale-result", "rejected");
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  expect(relay.context().has_result).toBe(false);
  await relay.deliver({ type: "result", action_id: "wrong-source-result", revision: relay.context().revision, result: { ...result, source: "manual" } });
  await expectAck(relay, "wrong-source-result", "rejected");
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  expect(relay.context().has_result).toBe(false);
  await relay.deliver({ type: "result", action_id: "current-result", revision: relay.context().revision, result });
  const resultReceipt = await expectAck(relay, "current-result", "applied");
  expect(resultReceipt.context.has_result).toBe(true);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(exported.result).toEqual(result);
  expect(exported.scenario).toEqual({ ...initial.scenario, confirmed: true });
  expect(exported.result.savings).toMatchObject({ water_liters: null, yield_gain_lb: null, avoided_capex_usd: null });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Start a blank real space", exact: true }).click();
  await expectFreshMeasurements(page);
  await expect.poll(() => relay.context().scenario.source).toBe("manual");
  const manual = relay.context();
  expect(manual.assets).toEqual([]);
  expect(manual.scenario.ppfd_full).toBeNull();
  expect(manual.has_result).toBe(false);
  await relay.deliver(
    { type: "result", revision: initial.revision, result },
    { type: "result", revision: manual.revision, result },
  );
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  expect(relay.context().has_result).toBe(false);
  const measured = inputDraft(relay, "manual-missing-ppfd", [
    { field: "length_ft", value: 12, unit: "ft" }, { field: "width_ft", value: 10, unit: "ft" },
    { field: "canopy_sqft", value: 48, unit: "ft2" }, { field: "lighting_watts", value: 420, unit: "W" },
    { field: "baseline_hours", value: 14, unit: "h/day" }, { field: "min_hours", value: 9, unit: "h/day" },
    { field: "max_hours", value: 17, unit: "h/day" }, { field: "other_watts", value: 30, unit: "W" },
    { field: "other_hours", value: 12, unit: "h/day" }, { field: "power_limit_watts", value: 1500, unit: "W" },
    { field: "electricity_usd_kwh", value: 0.22, unit: "USD/kWh" }, { field: "operating_days", value: 47, unit: "day" },
    { field: "min_dli", value: 14, unit: "mol/m2/day" }, { field: "ppfd_full", value: null, unit: "umol/m2/s" },
  ]);
  measured.inventory = [{ operation: "add", id: "live-manual-light", name: "User stated fixture", asset_type: "light_fixture", quantity: 1 }];
  await relay.deliver({ type: "draft", draft: measured });
  await expect(proposalReview(page)).toBeVisible();
  expect(relay.context().scenario.ppfd_full).toBeNull();
  expect(relay.context().has_result).toBe(false);
  expect((await savedWorkspace(page)).scenario).toEqual(manual.scenario);
  await proposalReview(page).getByRole("button", { name: "Use this version", exact: true }).click();
  await measurementConfirmation(page).check();
  await expect.poll(() => relay.context().scenario.confirmed).toBe(true);
  const request = relay.context();
  const missing = await page.request.post("/api/optimize", { data: request.scenario });
  expect(missing.status()).toBe(200);
  const missingResult = await missing.json() as OptimizationResult;
  expect(missingResult.status).toBe("needs_measurement");
  expect(missingResult.optimized).toBeNull();
  expect(missingResult.savings).toBeNull();
  await relay.deliver({ type: "result", revision: request.revision, result: missingResult });
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: missingResult.recommendations[0] })).toBeVisible();
  const saved = await savedWorkspace(page);
  expect(saved.scenario).toMatchObject({ source: "manual", ppfd_full: null, operating_days: 47, lighting_watts: 420 });
  expect(saved.assets.map(asset => asset.id)).toEqual(["live-manual-light"]);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("one 20 by 10 request shows both dimensions and unchanged 32-square-foot canopy in a reversible twin", async ({ page }, info) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft = inputDraft(relay, "grouped-room", [
    { field: "length_ft", value: 20, unit: "ft" },
    { field: "width_ft", value: 10, unit: "ft" },
  ]);
  await relay.deliver(
    { type: "transcript", role: "user", text: "Make the room twenty by ten feet and keep the canopy the same." },
    { type: "turn_complete" },
    { type: "draft", action_id: "grouped-room-preview", draft },
  );
  const receipt = await expectAck(relay, "grouped-room-preview", "applied");
  expect(receipt.context.scenario).toMatchObject({ length_ft: 20, width_ft: 10, canopy_sqft: 32, source: "sample" });
  expect(receipt.context.accepted_revision).toBe(draft.base_revision);
  expect(receipt.context.proposal).toMatchObject({ id: draft.proposal_id, version: 1, base_revision: draft.base_revision });
  const review = proposalReview(page);
  await expect(review).toHaveCount(1);
  await expect(review).toContainText("Proposed version v1");
  await expect(review).toContainText(/schematic/i);
  await expect(review.getByRole("group", { name: "Design comparison", exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("20");
  await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("10");
  await expect(page.getByRole("spinbutton", { name: "Canopy area", exact: true })).toHaveValue("32");
  await expect(page.locator(".field.is-changed").filter({ has: page.getByRole("spinbutton", { name: "Length", exact: true }) })).toHaveCount(1);
  await expect(page.locator(".field.is-changed").filter({ has: page.getByRole("spinbutton", { name: "Width", exact: true }) })).toHaveCount(1);
  await expect(page.locator(".field.is-changed").filter({ has: page.getByRole("spinbutton", { name: "Canopy area", exact: true }) })).toHaveCount(0);
  await expect(page.locator(".scene")).toContainText("20 by 10 feet, 32 square feet of canopy");
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  const canvas = page.locator(".scene canvas");
  await expect(canvas).toBeVisible();
  await review.getByRole("button", { name: "Current", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("8");
  await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("8");
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toBeDisabled();
  expect(relay.context().scenario).toMatchObject({ length_ft: 20, width_ft: 10, canopy_sqft: 32 });
  await expect(page.locator(".scene")).toContainText("8 by 8 feet, 32 square feet of canopy");
  const currentPixels = await canvas.screenshot();
  await review.getByRole("button", { name: "Proposed", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("20");
  await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("10");
  await expect(page.locator(".scene")).toContainText("20 by 10 feet, 32 square feet of canopy");
  const proposedPixels = await canvas.screenshot();
  expect(proposedPixels.equals(currentPixels)).toBe(false);
  for (const frame of [currentPixels, proposedPixels]) {
    const pixels = await sharp(frame).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let lit = 0;
    for (let index = 0; index < pixels.data.length; index += pixels.info.channels) {
      if (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2] > 180) lit++;
    }
    expect(lit / (pixels.info.width * pixels.info.height)).toBeGreaterThan(0.01);
  }
  expect(await savedWorkspace(page)).toEqual(before);
  expect(relay.context().scenario).toMatchObject({ length_ft: 20, width_ft: 10, canopy_sqft: 32 });
  expect(relay.acknowledgments().filter(message => message.action_id === "grouped-room-preview")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await review.scrollIntoViewIfNeeded();
  const box = (await review.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: info.outputPath(`proposed-twin-${info.project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: "End session", exact: true }).click();
  await expectStopped(page, ["audio"]);
  expect(relay.unexpected).toEqual([]);
});

test("a crop-label-only basil proposal preserves DLI, PPFD, water and all numerical inputs", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft = { ...inputDraft(relay, "crop-label", []), crop: "basil" };
  await relay.deliver(
    { type: "transcript", role: "user", text: "Change the crop label to basil." },
    { type: "draft", action_id: "basil-preview", draft },
  );
  const receipt = await expectAck(relay, "basil-preview", "applied");
  expect(receipt.context.crop).toBe("basil");
  expect(receipt.context.scenario).toEqual({ ...before.scenario, confirmed: false });
  expect(receipt.context.scenario).toMatchObject({ min_dli: 15, ppfd_full: 350, water_liters_day: 15, source: "sample" });
  expect(receipt.context.has_result).toBe(false);
  await expect(proposalReview(page)).toContainText(/basil/i);
  await expect(page.getByRole("spinbutton", { name: "Minimum DLI", exact: true })).toHaveValue("15");
  expect(await savedWorkspace(page)).toEqual(before);
  await proposalReview(page).getByRole("button", { name: "Use this version", exact: true }).click();
  await expect.poll(() => relay.context().proposal).toBeNull();
  expect(relay.context().crop).toBe("basil");
  expect((await savedWorkspace(page)).scenario).toEqual({ ...before.scenario, confirmed: false });
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("scoped You decide delegation opens a zero-change proposed version without adopting assumptions", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft: LiveDraft = {
    ...inputDraft(relay, "delegated-start", []),
    reason: "Lighting-design draft using the current sample assumptions; review remains required.",
    provenance: { turn_ids: ["user-turn-1"], basis: "delegated_design" },
  };
  await relay.deliver(
    { type: "transcript", role: "user", text: "For the sample lighting design, you decide." },
    { type: "draft", action_id: "delegated-preview", draft },
  );
  const receipt = await expectAck(relay, "delegated-preview", "applied");
  await expect(proposalReview(page)).toContainText("Proposed version v1");
  expect(receipt.context.proposal?.id).toBe(draft.proposal_id);
  expect(receipt.context.scenario).toEqual({ ...before.scenario, confirmed: false });
  expect(receipt.context.has_result).toBe(false);
  expect(await savedWorkspace(page)).toEqual(before);
  await proposalReview(page).getByRole("button", { name: "Discard", exact: true }).click();
  await expect(proposalReview(page)).toHaveCount(0);
  expect(await savedWorkspace(page)).toEqual(before);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

for (const input of ["voice", "UI"] as const) {
  test(`${input} can revise, adopt, undo and discard one active proposal without a second approval mechanism`, async ({ page }) => {
    await installMedia(page);
    const relay = await fakeRelay(page);
    await openLive(page);
    await startLive(page, relay);
    const before = await savedWorkspace(page);
    const draft = inputDraft(relay, `${input}-lifecycle`);
    await relay.deliver({ type: "draft", draft });
    const review = proposalReview(page);
    const act = async (action: "approve" | "revise" | "discard" | "undo", label: string) => {
      if (input === "voice") {
        const event = proposalAction(relay, action, `${input}-${action}`);
        await relay.deliver({ type: "transcript", role: "user", text: label }, event);
        await expectAck(relay, `${input}-${action}`, "applied");
      } else await page.getByRole("button", { name: label, exact: true }).click();
    };
    await act("revise", "Revise");
    await expect.poll(() => relay.context().proposal?.status).toBe("revising");
    await editInput(page, "Length", "14");
    await expect.poll(() => relay.context().scenario.length_ft).toBe(14);
    expect(await savedWorkspace(page)).toEqual(before);
    await act("approve", "Use this version");
    await expect(review).toHaveCount(0);
    await expect.poll(() => relay.context().proposal).toBeNull();
    await expect.poll(async () => (await savedWorkspace(page)).scenario.length_ft).toBe(14);
    expect(relay.context().can_undo).toBe(true);
    expect(relay.context().scenario.confirmed).toBe(false);
    await act("undo", "Undo last adoption");
    await expect.poll(async () => (await savedWorkspace(page)).scenario).toEqual(before.scenario);
    expect((await savedWorkspace(page)).assets).toEqual(before.assets);
    await relay.deliver({ type: "draft", draft: inputDraft(relay, `${input}-discard`, [{ field: "width_ft", value: 16, unit: "ft" }]) });
    await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("16");
    await act("discard", "Discard");
    await expect(review).toHaveCount(0);
    await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("8");
    expect((await savedWorkspace(page)).scenario).toEqual(before.scenario);
    expect((await savedWorkspace(page)).assets).toEqual(before.assets);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    expect(relay.unexpected).toEqual([]);
  });
}

test("a blank real space permits a dimension preview without PPFD, synthetic assets or savings", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await page.getByRole("button", { name: "Start a blank real space", exact: true }).click();
  await expectFreshMeasurements(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft = inputDraft(relay, "manual-geometry", [
    { field: "length_ft", value: 20, unit: "ft" },
    { field: "width_ft", value: 10, unit: "ft" },
  ]);
  await relay.deliver({ type: "draft", action_id: "manual-geometry-preview", draft });
  const receipt = await expectAck(relay, "manual-geometry-preview", "applied");
  expect(receipt.context.scenario).toEqual({ ...before.scenario, length_ft: 20, width_ft: 10 });
  expect(receipt.context.scenario).toMatchObject({ source: "manual", ppfd_full: null, min_dli: null, lighting_watts: 0, canopy_sqft: 0, confirmed: false });
  expect(receipt.context.assets).toEqual([]);
  expect(receipt.context.has_result).toBe(false);
  await expect(proposalReview(page)).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("20");
  await expect(page.getByRole("spinbutton", { name: "Width", exact: true })).toHaveValue("10");
  await expect(page.getByRole("spinbutton", { name: "Full-output PPFD", exact: true })).toBeEmpty();
  await expect(page.getByRole("status").filter({ hasText: "Canopy unknown" })).toBeVisible();
  await expect(page.locator(".scene-schedule strong")).toHaveText("Unknown");
  await expect(page.locator(".insight-fact").filter({ hasText: "Current canopy coverage" })).toContainText("Unknown");
  await expect(proposalReview(page).locator(".proposal-before")).toHaveText(["Current: Unknown", "Current: Unknown"]);
  const boundary = page.locator(".scene canvas");
  await expect(boundary).toBeVisible();
  const boundaryPixels = await sharp(await boundary.screenshot()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let litPixels = 0;
  for (let index = 0; index < boundaryPixels.data.length; index += boundaryPixels.info.channels) {
    if (boundaryPixels.data[index] + boundaryPixels.data[index + 1] + boundaryPixels.data[index + 2] > 130) litPixels++;
  }
  expect(litPixels / (boundaryPixels.info.width * boundaryPixels.info.height)).toBeGreaterThan(0.01);
  await page.screenshot({ path: test.info().outputPath(`boundary-only-${test.info().project.name}.png`), fullPage: true });
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await expect(page.locator(".sample-notice")).toHaveCount(0);
  expect(await savedWorkspace(page)).toEqual(before);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export proposed version", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("acreiq-proposed-version.json");
  const exported = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(exported.scenario).toEqual(receipt.context.scenario);
  expect(exported.assets).toEqual([]);
  expect(exported.result).toBeNull();
  expect(exported.workspace_version).toMatchObject({ id: draft.proposal_id, version: 1, base_revision: draft.base_revision, status: "proposed" });
  expect(exported.limitations).toContain("Revised schematic, not calculated spatial optimization.");
  await proposalReview(page).getByRole("button", { name: "Use this version", exact: true }).click();
  await expect.poll(async () => (await savedWorkspace(page)).scenario).toEqual({ ...before.scenario, length_ft: 20, width_ft: 10 });
  await expect(measurementConfirmation(page)).not.toBeChecked();
  expect(relay.context().has_result).toBe(false);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("the real local lighting engine and proposed-version export share reviewed draft inputs and clear stale results", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const accepted = await savedWorkspace(page);
  const draft = inputDraft(relay, "lighting-design", [{ field: "baseline_hours", value: 15, unit: "h/day" }]);
  await relay.deliver({ type: "draft", action_id: "lighting-preview", draft });
  await expectAck(relay, "lighting-preview", "applied");
  await expect(proposalReview(page)).toContainText("Sample-derived");
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toHaveValue("15");
  await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
  await expect.poll(() => relay.context().scenario.confirmed).toBe(true);
  const reviewed = relay.context();
  const response = await page.request.post("/api/optimize", { data: reviewed.scenario });
  expect(response.status()).toBe(200);
  const result = await response.json() as OptimizationResult;
  expect(result.status).toBe("optimized");
  expect(result.baseline.photoperiod_hours).toBe(15);
  expect(result.source).toBe("sample");
  await relay.deliver({ type: "result", action_id: "draft-lighting-result", revision: reviewed.revision, result });
  const receipt = await expectAck(relay, "draft-lighting-result", "applied");
  expect(receipt.context.has_result).toBe(true);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export proposed version", exact: true }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(exported.scenario).toEqual(reviewed.scenario);
  expect(exported.assets).toEqual(reviewed.assets);
  expect(exported.result).toEqual(result);
  expect(exported.workspace_version).toMatchObject({ id: draft.proposal_id, status: "proposed" });
  expect((await savedWorkspace(page)).scenario).toEqual(accepted.scenario);
  expect((await savedWorkspace(page)).assets).toEqual(accepted.assets);
  await editInput(page, "Current schedule", "14");
  await expect.poll(() => relay.context().scenario.baseline_hours).toBe(14);
  await expect.poll(() => relay.context().has_result).toBe(false);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await relay.deliver({ type: "result", action_id: "stale-draft-result", revision: reviewed.revision, result });
  await expectAck(relay, "stale-draft-result", "rejected");
  expect(relay.context().has_result).toBe(false);
  const unsolvedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export proposed version", exact: true }).click();
  const unsolved = JSON.parse(readFileSync((await (await unsolvedDownload).path())!, "utf8"));
  expect(unsolved.result).toBeNull();
  expect(unsolved.scenario).toMatchObject({ baseline_hours: 14, source: "sample", confirmed: false });
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("duplicate action IDs cannot reapply a draft, adopt twice or revive a discarded version", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const draft = inputDraft(relay, "idempotent-preview");
  const event: ActionEvent = { type: "draft", action_id: "same-draft-call", draft };
  await relay.deliver(event);
  await expectAck(relay, "same-draft-call", "applied");
  const preview = relay.context();
  await relay.deliver(event);
  expect(relay.context().revision).toBe(preview.revision);
  expect(relay.context().proposal).toEqual(preview.proposal);
  await expect(proposalReview(page)).toHaveCount(1);
  expect(await savedWorkspace(page)).toEqual(before);
  await relay.deliver({ ...event, draft: { ...draft, inputs: [{ field: "length_ft", value: 30, unit: "ft" }] } });
  expect(relay.acknowledgments().filter(message => message.action_id === "same-draft-call").at(-1)?.status).toBe("rejected");
  expect(relay.context().revision).toBe(preview.revision);
  expect(relay.context().scenario.length_ft).toBe(12);
  const approval = proposalAction(relay, "approve", "same-approval-call");
  await relay.deliver(approval);
  await expectAck(relay, "same-approval-call", "applied");
  const accepted = relay.context();
  await relay.deliver(approval);
  expect(relay.context().revision).toBe(accepted.revision);
  expect(relay.context().accepted_revision).toBe(accepted.accepted_revision);
  await relay.deliver(proposalAction(relay, "undo", "undo-once"));
  await expect.poll(async () => (await savedWorkspace(page)).scenario).toEqual(before.scenario);
  const discarded = inputDraft(relay, "never-revive");
  await relay.deliver({ type: "draft", action_id: "discardable-preview", draft: discarded });
  await relay.deliver(proposalAction(relay, "discard", "discard-once"));
  await relay.deliver({ type: "draft", action_id: "late-revival", draft: discarded });
  await expectAck(relay, "late-revival", "rejected");
  await expect(proposalReview(page)).toHaveCount(0);
  expect((await savedWorkspace(page)).scenario).toEqual(before.scenario);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("conflicting dimensions, an unclear crop and an ambiguous yes remain transcript-only until a validated action", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const context = relay.context();
  // Intent extraction and authorization are backend tests; this checks that speech
  // and clarification text alone cannot mutate the UI or synthesize tool receipts.
  await relay.deliver(
    { type: "transcript", role: "user", text: "Make it twenty feet, or twenty-four feet, by ten." },
    { type: "turn_complete" },
    { type: "transcript", role: "assistant", text: "Should the length be twenty or twenty-four feet?" },
    { type: "turn_complete" },
    { type: "transcript", role: "user", text: "Use the crop bazzle or something similar." },
    { type: "turn_complete" },
    { type: "transcript", role: "assistant", text: "Which crop name should I use?" },
    { type: "turn_complete" },
    { type: "transcript", role: "user", text: "Yes." },
  );
  const transcript = page.getByRole("log", { name: "Live transcript" });
  await expect(transcript).toContainText("Should the length be twenty or twenty-four feet?");
  await expect(transcript).toContainText("Which crop name should I use?");
  expect(relay.context().scenario).toEqual(context.scenario);
  expect(relay.context().crop).toEqual(context.crop);
  expect(relay.acknowledgments()).toEqual([]);
  await expect(proposalReview(page)).toHaveCount(0);
  expect(await savedWorkspace(page)).toEqual(before);
  await relay.deliver({ type: "draft", draft: inputDraft(relay, "unapproved-conversation") });
  const proposed = relay.context();
  await relay.deliver(
    { type: "turn_complete" },
    { type: "transcript", role: "assistant", text: "Use this version, change the crop, and run a comparison?" },
    { type: "turn_complete" },
    { type: "transcript", role: "user", text: "Yes." },
  );
  await expect(proposalReview(page)).toBeVisible();
  expect(relay.context().proposal).toEqual(proposed.proposal);
  expect(relay.context().scenario).toEqual(proposed.scenario);
  expect(await savedWorkspace(page)).toEqual(before);
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("real Python LiveTools and browser receipts agree through grouped design, revise, adopt and undo", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const driver = liveToolsDriver();
  let calls = 0;
  try {
    await driver.request({ op: "context", context: relay.context() });
    const perform = async (name: "propose_update" | "manage_proposal", text: string, args: Record<string, unknown>) => {
      const observed = await driver.request({ op: "observe", text });
      expect(observed.turn_id).toEqual(expect.any(String));
      const dispatched = await driver.request({
        op: "dispatch", id: `contract-action-${++calls}`, name,
        args: { ...args, provenance: { turn_ids: [observed.turn_id], basis: "user_instruction" } },
      });
      expect(dispatched.response).toMatchObject({ status: "pending_application" });
      expect(dispatched.response?.acknowledged).not.toBe(true);
      expect(dispatched.events).toHaveLength(1);
      const actionId = dispatched.response!.action_id as string;
      const messageStart = relay.messages.length;
      await relay.deliver({ type: "transcript", role: "user", text }, ...dispatched.events!);
      const receipt = await expectAck(relay, actionId, "applied");
      // Match the actual socket order: a React context update may reach Python
      // before the two-frame application receipt. Both paths must agree.
      for (const message of relay.messages.slice(messageStart)) {
        if (message.type === "context") {
          const update = await driver.request({ op: "context", context: message.context });
          expect(update.events).toEqual([]);
        } else if (message.type === "action_ack" && message.action_id === actionId) {
          const accepted = await driver.request({ op: "ack", action_id: actionId, status: message.status, message: message.message, context: message.context });
          expect(accepted.response).toEqual({ status: "acknowledged", action_id: actionId });
          expect(accepted.events).toEqual([]);
        }
      }
      const completed = await driver.request({ op: "wait", action_id: actionId });
      expect(completed.response).toMatchObject({ acknowledged: true, action_id: actionId, revision: receipt.context.revision });
      const authoritative = await driver.request({ op: "dispatch", id: `contract-state-${calls}`, name: "get_workspace_state", args: {} });
      expect(authoritative.response?.context).toMatchObject(relay.context());
      return receipt.context;
    };
    let context = await perform("propose_update", "Make the room twenty by ten feet and keep the canopy the same.", {
      reason: "Group the requested room dimensions in one revised schematic.",
      inputs: [{ field: "length_ft", value: 20, unit: "ft" }, { field: "width_ft", value: 10, unit: "ft" }],
    });
    expect(context.scenario).toMatchObject({ length_ft: 20, width_ft: 10, canopy_sqft: 32, confirmed: false });
    await expect(proposalReview(page)).toContainText("Proposed version v1");
    expect(await savedWorkspace(page)).toEqual(before);
    context = await perform("manage_proposal", "Revise this version.", {
      action: "revise", proposal_id: context.proposal!.id, version: context.proposal!.version,
    });
    expect(context.proposal).toMatchObject({ version: 2, status: "revising" });
    context = await perform("propose_update", "Change the room length to twenty-four feet and keep the width and canopy the same.", {
      reason: "Revise the length while preserving width and canopy.", inputs: [{ field: "length_ft", value: 24, unit: "ft" }],
    });
    expect(context.proposal).toMatchObject({ version: 3, status: "review" });
    expect(context.scenario).toMatchObject({ length_ft: 24, width_ft: 10, canopy_sqft: 32 });
    await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("24");
    expect(await savedWorkspace(page)).toEqual(before);
    context = await perform("manage_proposal", "Use this version.", {
      action: "approve", proposal_id: context.proposal!.id, version: context.proposal!.version,
    });
    expect(context.proposal).toBeNull();
    expect(context.accepted_revision).toBe(context.revision);
    expect(context.can_undo).toBe(true);
    await expect.poll(async () => (await savedWorkspace(page)).scenario).toEqual(context.scenario);
    context = await perform("manage_proposal", "Undo the last adoption.", { action: "undo", proposal_id: null, version: null });
    expect(context.proposal).toBeNull();
    expect(context.can_undo).toBe(false);
    expect(context.scenario).toEqual(before.scenario);
    await expect.poll(() => savedWorkspace(page)).toEqual(before);
    await page.getByRole("button", { name: "End session", exact: true }).click();
    await expectStopped(page, ["audio"]);
    expect(relay.unexpected).toEqual([]);
  } finally { await driver.close(); }
});

test("crop requirements retain assumption provenance and cannot bypass calculation gates through adoption or confirmation", async ({ page }) => {
  await installMedia(page);
  const relay = await fakeRelay(page);
  let optimizeRequests = 0;
  await page.route("**/api/optimize", route => {
    optimizeRequests++;
    return route.fulfill({ status: 500, json: { detail: "This test must not calculate with an unverified requirement." } });
  });
  await openLive(page);
  await startLive(page, relay);
  const before = await savedWorkspace(page);
  const assumption = { label: "Unverified crop requirement", source: "User-supplied reference", growth_stage: "Vegetative" };
  const draft = inputDraft(relay, "crop-assumption", [{ field: "min_dli", value: 14, unit: "mol/m2/day", assumption }]);
  await relay.deliver({ type: "draft", action_id: "assumption-preview", draft });
  const receipt = await expectAck(relay, "assumption-preview", "applied");
  expect(receipt.context.assumptions).toEqual({ min_dli: assumption });
  await expect(page.getByText("ASSUMPTION, NOT A MEASUREMENT", { exact: true })).toBeVisible();
  await expect(page.getByText(assumption.label, { exact: true })).toBeVisible();
  await expect(page.getByText("Vegetative", { exact: false }).filter({ hasText: assumption.source })).toBeVisible();
  expect(receipt.context.has_result).toBe(false);
  expect(await savedWorkspace(page)).toEqual(before);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export proposed version", exact: true }).click();
  const exported = JSON.parse(readFileSync((await (await download).path())!, "utf8"));
  expect(exported.assumptions).toEqual({ min_dli: assumption });
  expect(exported.result).toBeNull();
  expect(exported.scenario).toMatchObject({ min_dli: 14, confirmed: false, source: "sample" });
  await proposalReview(page).getByRole("button", { name: "Use this version", exact: true }).click();
  await expect(proposalReview(page)).toHaveCount(0);
  await page.getByRole("checkbox", { name: SAMPLE_CONFIRMATION, exact: true }).check();
  await expect.poll(() => relay.context().scenario.confirmed).toBe(true);
  expect(relay.context().assumptions).toEqual({ min_dli: assumption });
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  await expect(page.getByRole("alert").filter({ hasText: /proposed (?:crop requirements|assumptions).*verified inputs before calculating/ })).toBeVisible();
  expect(optimizeRequests).toBe(0);
  expect(relay.context().has_result).toBe(false);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "End session", exact: true }).click();
  expect(relay.unexpected).toEqual([]);
});

test("session bootstrap rejects unauthorized origins before reaching the relay", async ({ request }) => {
  for (const origin of ["https://unauthorized.example", "http://127.0.0.1:65534"]) {
    const response = await request.post("/api/live/session", { headers: { origin }, data: {} });
    expect(response.status()).toBe(403);
    const body = await response.json();
    expect(body).toEqual({ detail: "Live is restricted to this local browser." });
    expect(body.token).toBeUndefined();
    expect(body.resume_token).toBeUndefined();
  }
});
