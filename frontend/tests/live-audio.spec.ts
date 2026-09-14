import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test, type Page } from "./test-support";

const runtimeSource = ts.transpileModule(
  readFileSync(path.resolve(__dirname, "../lib/live/audio.ts"), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } },
).outputText;
const workletSource = readFileSync(path.resolve(__dirname, "../public/live-capture-worklet.js"), "utf8");

declare global {
  interface Window {
    liveAudio: typeof import("../lib/live/audio");
    mediaHarness: ReturnType<typeof installMediaMocks>;
    liveMedia: InstanceType<typeof import("../lib/live/audio").LiveMedia>;
    chunks: string[];
    pendingMedia: Promise<void>;
    cameraEncoding: {
      callbacks: BlobCallback[];
      frames: string[];
      stream: ReturnType<ReturnType<typeof installMediaMocks>["stream"]>;
    };
  }
}

function installMediaMocks() {
  const events: string[] = [];
  const settings = { captureRate: 16000, failModule: false, failSource: false, deferResume: false };
  const resumes: (() => void)[] = [];
  const requests: {
    constraints: MediaStreamConstraints;
    resolve: (stream: MediaStream) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const contexts: MockContext[] = [];
  const worklets: MockWorklet[] = [];
  class MockNode {
    connections: unknown[] = [];
    disconnected = false;
    buffer: AudioBuffer | null = null;
    gain = { value: 1 };
    onended: (() => void) | null = null;
    starts: number[] = [];
    stops = 0;
    connect(target: unknown) { this.connections.push(target); return target; }
    disconnect() { this.disconnected = true; this.connections = []; }
    start(when = 0) { this.starts.push(when); events.push("source.start"); }
    stop() { this.stops++; }
  }
  class MockContext {
    sampleRate: number;
    state: AudioContextState = "suspended";
    currentTime = 10;
    destination = {};
    nodes: MockNode[] = [];
    closed = 0;
    audioWorklet = { addModule: async (url: string) => {
      events.push(url);
      if (settings.failModule) throw new DOMException("private device details", "NotSupportedError");
    } };
    constructor(options?: AudioContextOptions) {
      this.sampleRate = options?.sampleRate ? settings.captureRate : 48000;
      contexts.push(this);
      events.push(`context:${this.sampleRate}`);
    }
    resume() {
      events.push("resume");
      if (settings.deferResume) return new Promise<void>(resolve => resumes.push(() => {
        if (this.state !== "closed") this.state = "running";
        resolve();
      }));
      this.state = "running";
      return Promise.resolve();
    }
    close() { this.state = "closed"; this.closed++; return Promise.resolve(); }
    createBuffer(channels: number, length: number, sampleRate: number) {
      return new AudioBuffer({ numberOfChannels: channels, length, sampleRate });
    }
    node() { const node = new MockNode(); this.nodes.push(node); return node; }
    createBufferSource() { return this.node(); }
    createGain() { return this.node(); }
    createMediaStreamSource() {
      if (settings.failSource) throw new DOMException("private device details", "NotReadableError");
      return this.node();
    }
  }
  class MockWorklet extends MockNode {
    port = {
      onmessage: null as ((event: { data: { pcm: ArrayBuffer; revision: number } }) => void) | null,
      messages: [] as { type: string; muted?: boolean; revision?: number }[],
      closed: false,
      postMessage: (message: { type: string; muted?: boolean; revision?: number }) => { this.port.messages.push(message); },
      close: () => { this.port.closed = true; },
    };
    constructor(context: MockContext, public name: string, public options: AudioWorkletNodeOptions) {
      super();
      context.nodes.push(this);
      worklets.push(this);
    }
  }
  Object.defineProperty(window, "AudioContext", { configurable: true, value: MockContext });
  Object.defineProperty(window, "AudioWorkletNode", { configurable: true, value: MockWorklet });
  Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: (constraints: MediaStreamConstraints) => {
    events.push("permission");
    return new Promise<MediaStream>((resolve, reject) => requests.push({ constraints, resolve, reject }));
  } });
  const stream = (kind: "audio" | "video") => {
    const track = { kind, enabled: true, stopped: 0, stop() { this.stopped++; } };
    return {
      track,
      media: {
        getTracks: () => [track],
        getAudioTracks: () => kind === "audio" ? [track] : [],
        getVideoTracks: () => kind === "video" ? [track] : [],
      } as unknown as MediaStream,
    };
  };
  const harness = { events, settings, resumes, requests, contexts, worklets, stream };
  window.mediaHarness = harness;
  window.chunks = [];
  window.liveMedia = new window.liveAudio.LiveMedia();
  return harness;
}

async function mocks(page: Page) {
  await page.evaluate(installMediaMocks);
}

test.beforeEach(async ({ page }) => {
  // A routed same-origin fixture needs no app changes, backend, providers, or physical devices.
  await page.route("**/api/**", route => route.abort("blockedbyclient"));
  await page.route("**/live-audio-test", route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><html><body><button id="start">Start</button><video id="preview"></video></body></html>',
  }));
  await page.route("**/live-capture-worklet.js", route => route.fulfill({ contentType: "application/javascript", body: workletSource }));
  await page.goto("/live-audio-test");
  await page.addScriptTag({ content: `{ const exports = {}; ${runtimeSource}\nwindow.liveAudio = exports; }` });
});

test("construction is inert and Start primes playback before any media permission", async ({ page }) => {
  await mocks(page);
  expect(await page.evaluate(() => window.mediaHarness.events)).toEqual([]);
  await page.evaluate(() => {
    document.querySelector("#start")!.addEventListener("click", () => {
      window.pendingMedia = window.liveMedia.primePlayback();
      window.mediaHarness.events.push("click-return");
    });
  });
  await page.getByRole("button", { name: "Start" }).click();
  const result = await page.evaluate(async () => {
    await window.pendingMedia;
    const beforeStop = [...window.mediaHarness.events];
    await window.liveMedia.stop();
    return { beforeStop, permissions: window.mediaHarness.requests.length, closed: window.mediaHarness.contexts[0].closed };
  });
  expect(result).toEqual({ beforeStop: ["context:48000", "resume", "source.start", "click-return"], permissions: 0, closed: 1 });
});

test("real OfflineAudioContext resamples 48 kHz into 16 kHz before the real worklet emits PCM", async ({ page }) => {
  const result = await page.evaluate(async moduleSource => {
    const context = new OfflineAudioContext(1, 3200, 16000);
    // Chromium worklet fetches bypass Playwright page routing. Execute the unchanged file.
    const moduleURL = URL.createObjectURL(new Blob([moduleSource], { type: "application/javascript" }));
    try { await context.audioWorklet.addModule(moduleURL); } finally { URL.revokeObjectURL(moduleURL); }
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 9600, 48000);
    const original = source.buffer.getChannelData(0);
    for (let i = 0; i < original.length; i++) original[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * i / 48000);
    const worklet = new AudioWorkletNode(context, "live-capture");
    const sink = context.createGain();
    sink.gain.value = 0;
    const chunks: ArrayBuffer[] = [];
    let complete!: () => void;
    const received = new Promise<void>(resolve => { complete = resolve; });
    worklet.port.onmessage = event => {
      chunks.push(event.data.pcm);
      if (chunks.length === 2) complete();
    };
    source.connect(worklet).connect(sink).connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    await received;
    const decoded = chunks.flatMap(buffer => {
      const view = new DataView(buffer);
      return Array.from({ length: buffer.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true) / 32768);
    });
    let squaredError = 0;
    // Ignore the resampling filter's edge transients, then compare frequency and amplitude.
    for (let i = 64; i < 3100; i++) squaredError += (decoded[i] - 0.5 * Math.sin(2 * Math.PI * 1000 * i / 16000)) ** 2;
    worklet.port.postMessage({ type: "stop" });
    worklet.port.close();
    source.disconnect(); worklet.disconnect(); sink.disconnect();
    return {
      inputRate: source.buffer!.sampleRate,
      outputRate: rendered.sampleRate,
      bytes: chunks.map(chunk => chunk.byteLength),
      count: decoded.length,
      rmsError: Math.sqrt(squaredError / (3100 - 64)),
      silent: rendered.getChannelData(0).every(value => value === 0),
    };
  }, workletSource);
  expect(result).toMatchObject({ inputRate: 48000, outputRate: 16000, bytes: [3200, 3200], count: 3200, silent: true });
  expect(result.rmsError).toBeLessThan(0.005);
});

test("real Chrome MediaStream capture verifies cross-context sample-rate behavior and cleanup", async ({ page }) => {
  const deployedWorklet = await page.request.get("/live-capture-worklet.js");
  expect(deployedWorklet.ok()).toBe(true);
  expect(await deployedWorklet.text()).toBe(workletSource);
  await page.evaluate(() => {
    const NativeAudioContext = window.AudioContext;
    const contexts: AudioContext[] = [];
    class TrackedAudioContext extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    }
    window.AudioContext = TrackedAudioContext;
    document.querySelector("#start")!.addEventListener("click", () => {
      window.pendingMedia = (async () => {
        const media = new window.liveAudio.LiveMedia();
        const primed = media.primePlayback();
        const input = new NativeAudioContext({ sampleRate: 48000 });
        const resumed = input.resume();
        const destination = input.createMediaStreamDestination();
        const oscillator = input.createOscillator();
        const gain = input.createGain();
        gain.gain.value = 0.2;
        oscillator.frequency.value = 1000;
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => destination.stream });
        const chunks: string[] = [];
        let failure: { name: string; message: string } | null = null;
        try {
          await Promise.all([primed, resumed]);
          await media.startMicrophone(chunk => chunks.push(chunk));
          // Native audio graph startup is asynchronous, especially under Windows load.
          // Wait for the evidence being asserted instead of assuming a 450 ms startup.
          await new Promise<void>(resolve => {
            const deadline = performance.now() + 5000;
            const check = () => {
              const ready = chunks.length >= 2 && chunks.some(chunk => Array.from(atob(chunk)).some(char => char.charCodeAt(0) !== 0));
              if (ready || performance.now() >= deadline) resolve();
              else setTimeout(check, 25);
            };
            check();
          });
        } catch (error) {
          failure = { name: (error as Error).name, message: (error as Error).message };
        } finally {
          await media.stop();
          oscillator.stop(); oscillator.disconnect(); gain.disconnect(); destination.disconnect();
          await input.close();
        }
        const result = {
          inputRate: input.sampleRate, captureRate: contexts[1]?.sampleRate,
          failure, chunkSizes: chunks.map(chunk => atob(chunk).length),
          hasSignal: chunks.some(chunk => Array.from(atob(chunk)).some(char => char.charCodeAt(0) !== 0)),
          ended: destination.stream.getTracks().every(track => track.readyState === "ended"),
          closed: contexts.every(context => context.state === "closed"),
        };
        document.body.dataset.captureResult = JSON.stringify(result);
      })();
    });
  });
  await page.getByRole("button", { name: "Start" }).click();
  const result = await page.evaluate(async () => {
    await window.pendingMedia;
    return JSON.parse(document.body.dataset.captureResult!) as {
      inputRate: number; captureRate: number; failure: { name: string; message: string } | null;
      chunkSizes: number[]; hasSignal: boolean; ended: boolean; closed: boolean;
    };
  });
  expect(result).toMatchObject({ inputRate: 48000, captureRate: 16000, ended: true, closed: true });
  console.info(`Synthetic 48 kHz -> 16 kHz capture: ${result.failure ? result.failure.message : `${result.chunkSizes.length} PCM chunks with signal=${result.hasSignal}; all tracks and contexts released`}`);
  if (result.failure) {
    // Some Chromium builds reject streams produced by a different-rate AudioContext.
    // This is distinct from a device stream; the runtime must fail and release it honestly.
    expect(result.failure.name).toBe("NotSupportedError");
    expect(result.failure.message).toMatch(/different sample.rate.*not supported/i);
    expect(result.chunkSizes).toEqual([]);
    test.info().annotations.push({ type: "browser limitation", description: result.failure.message });
  } else {
    expect(result.chunkSizes.length).toBeGreaterThanOrEqual(2);
    expect(result.chunkSizes.every(size => size === 3200)).toBe(true);
    expect(result.hasSignal).toBe(true);
  }
});

test("worklet clips floats into little-endian 100 ms chunks and discards mute boundaries", async ({ page }) => {
  const result = await page.evaluate(source => {
    type Message = { pcm: ArrayBuffer; revision: number };
    class ProcessorBase {
      port = {
        onmessage: null as ((event: { data: object }) => void) | null,
        messages: [] as Message[], closed: false,
        postMessage(message: Message, transfers: Transferable[]) { this.messages.push(structuredClone(message, { transfer: transfers })); },
        close() { this.closed = true; },
      };
    }
    type Processor = ProcessorBase & { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
    let Constructor!: new (options: object) => Processor;
    new Function("AudioWorkletProcessor", "sampleRate", "registerProcessor", source)(
      ProcessorBase, 16000, (_name: string, ctor: typeof Constructor) => { Constructor = ctor; },
    );
    const processor = new Constructor({ processorOptions: {} });
    const samples = new Float32Array(1600);
    samples.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -Infinity]);
    const output = [[new Float32Array(128).fill(1)]];
    for (let i = 0; i < samples.length; i += 128) processor.process([[samples.slice(i, i + 128)]], output);
    const bytes = Array.from(new Uint8Array(processor.port.messages[0].pcm).slice(0, 20));
    processor.process([[new Float32Array(800).fill(1)]], output);
    processor.port.onmessage!({ data: { type: "set-muted", muted: true, revision: 1 } });
    processor.process([[new Float32Array(3200).fill(1)]], output);
    processor.port.onmessage!({ data: { type: "set-muted", muted: false, revision: 2 } });
    processor.process([[new Float32Array(1600).fill(-1)]], output);
    const second = processor.port.messages[1];
    processor.port.onmessage!({ data: { type: "stop" } });
    let rejects48k = false;
    new Function("AudioWorkletProcessor", "sampleRate", "registerProcessor", source)(
      ProcessorBase, 48000, (_name: string, ctor: typeof Constructor) => {
        try { new ctor({ processorOptions: {} }); } catch { rejects48k = true; }
      },
    );
    return {
      bytes, lengths: processor.port.messages.map(message => message.pcm.byteLength),
      revision: second.revision,
      cleanUnmute: new Int16Array(second.pcm).every(value => value === -32768),
      silent: output[0][0].every(value => value === 0),
      stopped: !processor.process([[samples]], output), closed: processor.port.closed, rejects48k,
    };
  }, workletSource);
  expect(result).toEqual({
    bytes: [0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127, 0, 0, 255, 127, 0, 128],
    lengths: [3200, 3200], revision: 2, cleanUnmute: true, silent: true, stopped: true, closed: true, rejects48k: true,
  });
});

test("microphone uses a verified 16 kHz silent graph and mute disables tracks and stale chunks", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const h = window.mediaHarness;
    window.liveMedia.setMuted(true);
    const started = window.liveMedia.startMicrophone(chunk => window.chunks.push(chunk));
    while (!h.requests.length) await Promise.resolve();
    const stream = h.stream("audio");
    h.requests[0].resolve(stream.media);
    await started;
    const worklet = h.worklets[0];
    const handler = worklet.port.onmessage!;
    const disabledAtStart = !stream.track.enabled;
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 0 } });
    window.liveMedia.setMuted(false);
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 0 } });
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 1 } });
    window.liveMedia.setMuted(true);
    const disabledOnMute = !stream.track.enabled;
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 2 } });
    window.liveMedia.setMuted(false);
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 2 } });
    handler({ data: { pcm: new ArrayBuffer(2), revision: 3 } });
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 3 } });
    const context = h.contexts[0];
    const graph = context.nodes.map(node => ({ connections: node.connections.length, gain: node.gain.value }));
    await window.liveMedia.stop();
    handler({ data: { pcm: new ArrayBuffer(3200), revision: 3 } });
    return {
      constraints: h.requests[0].constraints, rate: context.sampleRate, graph,
      disabledAtStart, disabledOnMute, enabledOnUnmute: stream.track.enabled,
      chunkSizes: window.chunks.map(chunk => atob(chunk).length),
      stoppedTracks: stream.track.stopped, closedContexts: context.closed,
      allDisconnected: context.nodes.every(node => node.disconnected),
      portClosed: worklet.port.closed, handlerRemoved: worklet.port.onmessage === null,
      messages: worklet.port.messages,
    };
  });
  expect(result).toMatchObject({
    constraints: { audio: { channelCount: 1 }, video: false }, rate: 16000,
    graph: [{ connections: 1, gain: 1 }, { connections: 1, gain: 1 }, { connections: 1, gain: 0 }],
    disabledAtStart: true, disabledOnMute: true, enabledOnUnmute: true,
    chunkSizes: [3200, 3200], stoppedTracks: 1, closedContexts: 1,
    allDisconnected: true, portClosed: true, handlerRemoved: true,
  });
  expect(result.messages.at(-1)).toEqual({ type: "stop" });
});

test("wrong capture rate and startup failures fail honestly and release resources", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const h = window.mediaHarness;
    h.settings.captureRate = 48000;
    const wrongRate = await window.liveMedia.startMicrophone(() => {}).catch(window.liveAudio.mediaErrorMessage);
    h.settings.captureRate = 16000;
    h.settings.failModule = true;
    const badModule = await window.liveMedia.startMicrophone(() => {}).catch(window.liveAudio.mediaErrorMessage);
    h.settings.failModule = false;
    const deniedStart = window.liveMedia.startMicrophone(() => {}).catch(window.liveAudio.mediaErrorMessage);
    while (!h.requests.length) await Promise.resolve();
    h.requests[0].reject(new DOMException("SECRET device id", "NotAllowedError"));
    const denied = await deniedStart;
    h.settings.failSource = true;
    const brokenStart = window.liveMedia.startMicrophone(() => {}).catch(window.liveAudio.mediaErrorMessage);
    while (h.requests.length < 2) await Promise.resolve();
    const stream = h.stream("audio");
    h.requests[1].resolve(stream.media);
    const broken = await brokenStart;
    await window.liveMedia.stop();
    return { wrongRate, badModule, denied, broken, requests: h.requests.length, stopped: stream.track.stopped, closed: h.contexts.map(c => c.closed) };
  });
  expect(result.wrongRate).toContain("cannot capture audio at 16 kHz");
  expect(result.badModule).toContain("unavailable");
  expect(result.denied).toContain("permission was denied");
  expect(result.broken).toContain("could not start");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(result).toMatchObject({ requests: 2, stopped: 1, closed: [1, 1, 1, 1] });
});

test("Stop disposes late microphone grants and a newer start survives older requests", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const h = window.mediaHarness;
    const old = window.liveMedia.startMicrophone(() => {});
    while (!h.requests.length) await Promise.resolve();
    await window.liveMedia.stop();
    const newer = window.liveMedia.startMicrophone(() => {});
    while (h.requests.length < 2) await Promise.resolve();
    const late = h.stream("audio");
    const current = h.stream("audio");
    h.requests[1].resolve(current.media);
    await newer;
    h.requests[0].resolve(late.media);
    await old;
    const beforeStop = { late: late.track.stopped, current: current.track.stopped, states: h.contexts.map(c => c.state) };
    await window.liveMedia.stop();
    await window.liveMedia.stop();
    return { beforeStop, stoppedCurrent: current.track.stopped, closed: h.contexts.map(c => c.closed) };
  });
  expect(result).toEqual({ beforeStop: { late: 1, current: 0, states: ["closed", "running"] }, stoppedCurrent: 1, closed: [1, 1] });
});

test("24 kHz PCM playback is ordered and bounded, and interrupt stops every queued source", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const media = window.liveMedia;
    const h = window.mediaHarness;
    const errors: string[] = [];
    try { await media.playAudio("AAA="); } catch (error) { errors.push((error as Error).name); }
    await media.primePlayback();
    const context = h.contexts[0];
    context.nodes[0].onended!();
    await media.playAudio(btoa("\x00\x80\xff\x7f\x00\x40\x00\xc0"));
    const littleEndian = Array.from(context.nodes[1].buffer!.getChannelData(0));
    media.interrupt();
    const offset = context.nodes.length;
    for (let i = 0; i < window.liveAudio.MAX_PLAYBACK_SECONDS; i++) await media.playAudio(btoa("\0".repeat(48000)));
    const queued = context.nodes.slice(offset);
    const rates = queued.map(node => node.buffer!.sampleRate);
    const starts = queued.map(node => node.starts[0]);
    try { await media.playAudio("AAA="); } catch (error) { errors.push((error as Error).name); }
    media.interrupt();
    const interrupted = queued.every(node => node.stops === 1 && node.disconnected && node.buffer === null && node.onended === null);
    await media.playAudio("AAA=");
    const resetStart = context.nodes.at(-1)!.starts[0];
    for (const data of ["a", "AQ==", "!!!!", "", "A".repeat(349532)]) {
      try { window.liveAudio.decodePCM24k(data); } catch (error) { errors.push((error as Error).name); }
    }
    await media.stop();
    return { errors, littleEndian, rates, starts, interrupted, resetStart, closed: context.closed, allReleased: context.nodes.every(n => n.disconnected && n.buffer === null) };
  });
  expect(result).toEqual({
    errors: ["InvalidStateError", "QuotaExceededError", "DataError", "DataError", "DataError", "DataError", "QuotaExceededError"],
    littleEndian: [-1, 32767 / 32768, 0.5, -0.5], rates: Array(30).fill(24000),
    starts: Array.from({ length: 30 }, (_, i) => 10 + i), interrupted: true, resetStart: 10, closed: 1, allReleased: true,
  });
});

test("a 12-second burst in small native-audio chunks remains ordered and fully interruptible", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const media = window.liveMedia;
    await media.primePlayback();
    const context = window.mediaHarness.contexts[0];
    context.nodes[0].onended!();
    const pcm = btoa("\0".repeat(960)); // 20 ms of mono PCM16 at 24 kHz.
    for (let i = 0; i < 600; i++) media.playAudio(pcm);
    const queued = context.nodes.slice(1);
    const ordered = queued.every((node, i) => Math.abs(node.starts[0] - (10 + i * 0.02)) < 1e-8);
    const duration = queued.reduce((sum, node) => sum + node.buffer!.duration, 0);
    media.interrupt();
    await media.stop();
    return { count: queued.length, ordered, duration, released: queued.every(node => node.stops === 1 && node.disconnected && node.buffer === null), closed: context.state };
  });
  expect(result).toMatchObject({ count: 600, ordered: true, released: true, closed: "closed" });
  expect(result.duration).toBeCloseTo(12, 8);
});

test("playback backlog follows the audio clock and tiny-chunk resource use stays bounded", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const media = window.liveMedia;
    await media.primePlayback();
    const context = window.mediaHarness.contexts[0];
    context.nodes[0].onended!();
    const oneSecond = btoa("\0".repeat(48000));
    for (let i = 0; i < 30; i++) media.playAudio(oneSecond);
    context.currentTime += 15;
    for (const node of context.nodes.slice(1, 16)) node.onended!();
    for (let i = 0; i < 15; i++) media.playAudio(oneSecond);
    const replenishedEnd = context.nodes.at(-1)!.starts[0] + 1;
    media.interrupt();
    let count = 0, error = "";
    try { for (; count < 3000; count++) media.playAudio("AAA="); }
    catch (cause) { error = (cause as Error).name; }
    await media.stop();
    return { replenishedEnd, count, error, closed: context.state };
  });
  expect(result).toEqual({ replenishedEnd: 55, count: 2048, error: "QuotaExceededError", closed: "closed" });
});

test("Stop cancels pending playback resume without scheduling late sources", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const h = window.mediaHarness;
    h.settings.deferResume = true;
    const prime = window.liveMedia.primePlayback();
    await window.liveMedia.stop();
    h.resumes[0]();
    await prime;
    return { contexts: h.contexts.map(c => c.state), nodes: h.contexts[0].nodes.map(n => ({ stops: n.stops, disconnected: n.disconnected, cleared: n.buffer === null })) };
  });
  expect(result).toEqual({ contexts: ["closed"], nodes: [{ stops: 1, disconnected: true, cleared: true }] });
});

test("stopCamera and Stop both release late grants and camera denial is safely reported", async ({ page }) => {
  await mocks(page);
  const result = await page.evaluate(async () => {
    const h = window.mediaHarness;
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "srcObject", { configurable: true, writable: true, value: null });
    video.play = async () => {};
    video.pause = () => {};
    const old = window.liveMedia.startCamera(video, () => {});
    window.liveMedia.stopCamera();
    const current = window.liveMedia.startCamera(video, () => {});
    const lateStream = h.stream("video");
    const currentStream = h.stream("video");
    h.requests[1].resolve(currentStream.media);
    await current;
    h.requests[0].resolve(lateStream.media);
    await old;
    const active = video.srcObject === currentStream.media;
    await window.liveMedia.stop();
    const pending = window.liveMedia.startCamera(video, () => {});
    await window.liveMedia.stop();
    const afterStop = h.stream("video");
    h.requests[2].resolve(afterStop.media);
    await pending;
    const denied = window.liveMedia.startCamera(video, () => {}).catch(window.liveAudio.mediaErrorMessage);
    h.requests[3].reject(new DOMException("SECRET hardware details", "NotFoundError"));
    return {
      active, late: lateStream.track.stopped, current: currentStream.track.stopped, afterStop: afterStop.track.stopped,
      detached: video.srcObject === null, muted: video.muted, inline: video.playsInline,
      constraints: h.requests.map(request => request.constraints), error: await denied,
    };
  });
  expect(result).toMatchObject({ active: true, late: 1, current: 1, afterStop: 1, detached: true, muted: true, inline: true });
  expect(result.constraints.every(constraints => constraints.audio === false)).toBe(true);
  expect(result.error).toContain("No matching microphone or camera was found");
  expect(result.error).not.toContain("SECRET");
});

test("camera samples real synthetic video as bounded JPEGs and stops timers and tracks", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1280; canvas.height = 720;
    const paint = canvas.getContext("2d")!;
    paint.fillStyle = "#00b070";
    paint.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(5);
    let permissions = 0;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { permissions++; return stream; } });
    const originalEncode = HTMLCanvasElement.prototype.toBlob;
    const encodings: { width: number; height: number; quality: number | undefined; type: string | undefined }[] = [];
    let inFlight = 0, maxInFlight = 0;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      encodings.push({ width: this.width, height: this.height, type, quality });
      originalEncode.call(this, blob => { inFlight--; callback(blob); }, type, quality);
    };
    const video = document.querySelector("video")!;
    const media = new window.liveAudio.LiveMedia();
    const frames: { base64: string; at: number }[] = [];
    let done!: () => void;
    const received = new Promise<void>(resolve => { done = resolve; });
    await media.startCamera(video, base64 => {
      frames.push({ base64, at: performance.now() });
      if (frames.length === 2) done();
    });
    // Request a fresh synthetic frame after the video element starts consuming it.
    paint.fillRect(0, 0, 1280, 720);
    await received;
    await media.stop();
    const countAtStop = frames.length;
    await new Promise(resolve => setTimeout(resolve, 1100));
    HTMLCanvasElement.prototype.toBlob = originalEncode;
    const decoded = await createImageBitmap(new Blob([Uint8Array.from(atob(frames[0].base64), char => char.charCodeAt(0))], { type: "image/jpeg" }));
    const dimensions = [decoded.width, decoded.height];
    decoded.close();
    return {
      permissions, encodings, dimensions, maxInFlight,
      lengths: frames.map(frame => frame.base64.length), interval: frames[1].at - frames[0].at,
      jpeg: frames.every(frame => atob(frame.base64).startsWith("\xff\xd8")),
      ended: stream.getTracks().every(track => track.readyState === "ended"),
      detached: video.srcObject === null, muted: video.muted, inline: video.playsInline,
      stableAfterStop: countAtStop === frames.length,
    };
  });
  expect(result).toMatchObject({ permissions: 1, dimensions: [640, 360], maxInFlight: 1, jpeg: true, ended: true, detached: true, muted: true, inline: true, stableAfterStop: true });
  expect(result.encodings).toEqual(Array(2).fill({ width: 640, height: 360, type: "image/jpeg", quality: 0.65 }));
  expect(result.lengths.every(length => length <= 200 * 1024)).toBe(true);
  expect(result.interval).toBeGreaterThanOrEqual(999);
});

test("camera encoding cannot overlap, exceed the payload limit, or deliver after Stop", async ({ page }) => {
  await mocks(page);
  await page.clock.install();
  await page.evaluate(async () => {
    const h = window.mediaHarness;
    const video = document.querySelector("video")!;
    Object.defineProperties(video, {
      srcObject: { configurable: true, writable: true, value: null },
      readyState: { configurable: true, value: 4 },
      videoWidth: { configurable: true, value: 1920 },
      videoHeight: { configurable: true, value: 1080 },
    });
    video.play = async () => {};
    video.pause = () => {};
    CanvasRenderingContext2D.prototype.drawImage = () => {};
    const callbacks: BlobCallback[] = [];
    HTMLCanvasElement.prototype.toBlob = callback => { callbacks.push(callback); };
    const stream = h.stream("video");
    const frames: string[] = [];
    window.cameraEncoding = { callbacks, frames, stream };
    const started = window.liveMedia.startCamera(video, frame => frames.push(frame));
    h.requests[0].resolve(stream.media);
    await started;
  });
  await page.clock.fastForward(1000);
  expect(await page.evaluate(() => window.cameraEncoding.callbacks.length)).toBe(1);
  await page.clock.fastForward(5000);
  expect(await page.evaluate(() => window.cameraEncoding.callbacks.length)).toBe(1);
  await page.evaluate(() => window.cameraEncoding.callbacks[0](new Blob([new Uint8Array(210000)], { type: "image/jpeg" })));
  await page.clock.fastForward(1000);
  expect(await page.evaluate(() => window.cameraEncoding.callbacks.length)).toBe(2);
  await page.evaluate(() => window.cameraEncoding.callbacks[1](new Blob([new Uint8Array(170000)], { type: "image/jpeg" })));
  // arrayBuffer() completes asynchronously before the next timer is armed.
  await expect.poll(() => page.evaluate(() => {
    const runtime = window.liveMedia as unknown as { camera?: { timer?: number } };
    return runtime.camera?.timer;
  })).toBeTruthy();
  await page.clock.fastForward(1000);
  await expect.poll(() => page.evaluate(() => window.cameraEncoding.callbacks.length)).toBe(3);
  await page.evaluate(async () => {
    await window.liveMedia.stop();
    window.cameraEncoding.callbacks[2](new Blob([new Uint8Array(100)], { type: "image/jpeg" }));
  });
  await page.clock.fastForward(5000);
  const result = await page.evaluate(() => ({
    encodings: window.cameraEncoding.callbacks.length,
    frames: window.cameraEncoding.frames.length,
    stopped: window.cameraEncoding.stream.track.stopped,
    detached: document.querySelector("video")!.srcObject === null,
  }));
  expect(result).toEqual({ encodings: 3, frames: 0, stopped: 1, detached: true });
});

test("media errors never expose raw device, provider or exception text", async ({ page }) => {
  const result = await page.evaluate(() => {
    const message = window.liveAudio.mediaErrorMessage;
    return [
      message(new Error("SECRET")), message("SECRET"), message(null),
      message({ name: "NotAllowedError", message: "SECRET" }),
      message({ name: "NotFoundError", message: "SECRET" }),
      message({ name: "NotReadableError", message: "SECRET" }),
    ];
  });
  expect(result.every(message => message.length > 20 && !message.includes("SECRET"))).toBe(true);
});
