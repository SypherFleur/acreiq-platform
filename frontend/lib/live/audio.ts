export const CAPTURE_SAMPLE_RATE = 16_000;
export const PLAYBACK_SAMPLE_RATE = 24_000;
// Native speech can arrive much faster than real time. Bound the backlog, not reply length.
export const MAX_PLAYBACK_SECONDS = 30;
const MAX_PLAYBACK_SOURCES = 2048;
const MAX_PCM_CHUNK_BYTES = 256 * 1024;
const FRAME_INTERVAL_MS = 1_000;
const MAX_FRAME_BYTES = 200 * 1024;

type Capture = {
  context: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  sink?: GainNode;
  revision: number;
};

type Camera = {
  video: HTMLVideoElement;
  stream?: MediaStream;
  canvas?: HTMLCanvasElement;
  timer?: ReturnType<typeof setTimeout>;
};

export function mediaErrorMessage(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error
    ? String(error.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Media permission was denied. Allow microphone or camera access in your browser and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No matching microphone or camera was found. Connect a device and try again.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone or camera could not start. Close other apps using it and try again.";
    case "OverconstrainedError":
      return "This device does not support the requested media settings.";
    case "UnsupportedSampleRateError":
      return "This browser cannot capture audio at 16 kHz. Try another browser or audio device.";
    case "NotSupportedError":
      return "Live media is unavailable in this browser. Use a supported browser over HTTPS or localhost.";
    case "InvalidStateError":
      return "Audio playback is not ready. Use Start to enable audio and try again.";
    case "QuotaExceededError":
      return "This spoken reply exceeded the playback buffer. Playback stopped; Live is still connected. Ask for a shorter reply.";
    case "DataError":
    case "InvalidCharacterError":
      return "The received audio was not valid 24 kHz PCM audio.";
    case "AbortError":
      return "Media startup was interrupted. Try again.";
    default:
      return "Media could not start. Check your browser permissions and connected devices, then try again.";
  }
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function decodePCM24k(base64: string): Float32Array {
  // Bound the allocation before decoding untrusted network audio.
  if (base64.length > 4 * Math.ceil(MAX_PCM_CHUNK_BYTES / 3)) {
    throw new DOMException("Audio chunk exceeds the queue limit.", "QuotaExceededError");
  }
  if (!base64.length || base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new DOMException("Invalid PCM encoding.", "DataError");
  }
  const binary = atob(base64);
  if (binary.length > MAX_PCM_CHUNK_BYTES) {
    throw new DOMException("Audio chunk exceeds the byte limit.", "QuotaExceededError");
  }
  if (!binary.length || binary.length % 2) {
    throw new DOMException("PCM requires complete 16-bit samples.", "DataError");
  }
  const samples = new Float32Array(binary.length / 2);
  for (let index = 0; index < samples.length; index++) {
    const unsigned = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
    samples[index] = (unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned) / 32768;
  }
  return samples;
}

function stopTracks(stream?: MediaStream): void {
  stream?.getTracks().forEach(track => track.stop());
}

function requireMediaDevices(): MediaDevices {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new DOMException("Media capture is unavailable.", "NotSupportedError");
  }
  return navigator.mediaDevices;
}

export class LiveMedia {
  private capture?: Capture;
  private camera?: Camera;
  private playback?: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private closingContexts = new Set<Promise<void>>();
  private captureGeneration = 0;
  private cameraGeneration = 0;
  private muted = false;
  private nextPlaybackTime = 0;

  /** Call directly in the Start click handler, before awaiting permission or network work. */
  async primePlayback(): Promise<void> {
    if (typeof AudioContext === "undefined") {
      throw new DOMException("Web Audio is unavailable.", "NotSupportedError");
    }
    const context = this.playback ?? new AudioContext();
    this.playback = context;
    // Both resume and the silent source start execute within the user gesture.
    const resumed = context.resume();
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, 1, PLAYBACK_SAMPLE_RATE);
    this.trackSource(source, context);
    source.start();
    try {
      await resumed;
      if (this.playback === context && context.state !== "running") {
        throw new DOMException("Playback did not resume.", "InvalidStateError");
      }
    } catch (error) {
      if (this.playback !== context) return;
      this.interrupt();
      this.playback = undefined;
      await this.closeContext(context);
      throw error;
    }
  }

  async startMicrophone(onChunk: (base64: string) => void): Promise<void> {
    const generation = ++this.captureGeneration;
    this.releaseCapture();
    const devices = requireMediaDevices();
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
      throw new DOMException("AudioWorklet is unavailable.", "NotSupportedError");
    }
    const capture: Capture = { context: new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE }), revision: 0 };
    this.capture = capture;
    const active = () => this.capture === capture && generation === this.captureGeneration;
    try {
      if (capture.context.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new DOMException("A 16 kHz context is required.", "UnsupportedSampleRateError");
      }
      await capture.context.resume();
      if (!active()) return;
      await capture.context.audioWorklet.addModule("/live-capture-worklet.js");
      if (!active()) return;
      const stream = await devices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (!active()) {
        stopTracks(stream);
        return;
      }
      capture.stream = stream;
      stream.getAudioTracks().forEach(track => { track.enabled = !this.muted; });
      capture.source = capture.context.createMediaStreamSource(stream);
      capture.worklet = new AudioWorkletNode(capture.context, "live-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        processorOptions: { muted: this.muted, revision: capture.revision },
      });
      capture.worklet.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; revision: number }>) => {
        if (!active() || this.muted || event.data.revision !== capture.revision) return;
        if (event.data.pcm instanceof ArrayBuffer && event.data.pcm.byteLength === 3200) {
          onChunk(toBase64(event.data.pcm));
        }
      };
      capture.sink = capture.context.createGain();
      capture.sink.gain.value = 0;
      capture.source.connect(capture.worklet);
      capture.worklet.connect(capture.sink);
      capture.sink.connect(capture.context.destination);
    } catch (error) {
      if (!active()) return;
      this.releaseCapture();
      await Promise.all([...this.closingContexts]);
      throw error;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const capture = this.capture;
    if (!capture) return;
    capture.revision++;
    capture.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    capture.worklet?.port.postMessage({ type: "set-muted", muted, revision: capture.revision });
  }

  async startCamera(video: HTMLVideoElement, onFrame: (base64: string) => void): Promise<void> {
    this.stopCamera();
    const generation = this.cameraGeneration;
    const camera: Camera = { video };
    this.camera = camera;
    const active = () => this.camera === camera && generation === this.cameraGeneration;
    try {
      const stream = await requireMediaDevices().getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: "environment" } },
      });
      if (!active()) {
        stopTracks(stream);
        return;
      }
      camera.stream = stream;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (!active()) return;
      camera.canvas = document.createElement("canvas");
      const captureFrame = async () => {
        if (!active()) return;
        camera.timer = undefined;
        try {
          const canvas = camera.canvas!;
          if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
          canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) return;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.65));
          if (!active() || !blob || blob.type !== "image/jpeg" || blob.size > MAX_FRAME_BYTES) return;
          const buffer = await blob.arrayBuffer();
          if (!active()) return;
          const base64 = toBase64(buffer);
          if (base64.length <= MAX_FRAME_BYTES) onFrame(base64);
        } catch {
          // A transient preview/encoding failure drops this frame; no frames are retained.
        } finally {
          if (active()) camera.timer = setTimeout(() => { void captureFrame(); }, FRAME_INTERVAL_MS);
        }
      };
      camera.timer = setTimeout(() => { void captureFrame(); }, FRAME_INTERVAL_MS);
    } catch (error) {
      if (!active()) return;
      this.stopCamera();
      throw error;
    }
  }

  stopCamera(): void {
    this.cameraGeneration++;
    const camera = this.camera;
    this.camera = undefined;
    if (!camera) return;
    clearTimeout(camera.timer);
    stopTracks(camera.stream);
    if (camera.stream && camera.video.srcObject === camera.stream) {
      camera.video.pause();
      camera.video.srcObject = null;
    }
    if (camera.canvas) {
      camera.canvas.width = 0;
      camera.canvas.height = 0;
      camera.canvas = undefined;
    }
  }

  /** Schedule mono PCM16LE. Overflow is rejected so latency cannot grow without bound. */
  playAudio(base64PCM24k: string): void {
    const context = this.playback;
    if (!context || context.state !== "running") {
      throw new DOMException("Call primePlayback from Start first.", "InvalidStateError");
    }
    const samples = decodePCM24k(base64PCM24k);
    const start = Math.max(context.currentTime, this.nextPlaybackTime);
    const duration = samples.length / PLAYBACK_SAMPLE_RATE;
    if (start + duration - context.currentTime > MAX_PLAYBACK_SECONDS || this.sources.size >= MAX_PLAYBACK_SOURCES) {
      throw new DOMException("Playback queue is full.", "QuotaExceededError");
    }
    const buffer = context.createBuffer(1, samples.length, PLAYBACK_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    this.trackSource(source, context);
    try {
      source.start(start);
      this.nextPlaybackTime = start + duration;
    } catch (error) {
      this.releaseSource(source);
      throw error;
    }
  }

  interrupt(): void {
    this.nextPlaybackTime = 0;
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* The source may already have ended. */ }
      this.releaseSource(source);
    }
  }

  async stop(): Promise<void> {
    this.captureGeneration++;
    this.releaseCapture();
    this.stopCamera();
    this.interrupt();
    const playback = this.playback;
    this.playback = undefined;
    if (playback) void this.closeContext(playback);
    // getUserMedia cannot be cancelled; generation guards dispose of late grants.
    await Promise.all([...this.closingContexts]);
  }

  private trackSource(source: AudioBufferSourceNode, context: AudioContext): void {
    this.sources.add(source);
    source.onended = () => this.releaseSource(source);
    source.connect(context.destination);
  }

  private releaseSource(source: AudioBufferSourceNode): void {
    source.onended = null;
    source.disconnect();
    source.buffer = null;
    this.sources.delete(source);
  }

  private releaseCapture(): void {
    const capture = this.capture;
    this.capture = undefined;
    if (!capture) return;
    stopTracks(capture.stream);
    if (capture.worklet) {
      capture.worklet.port.postMessage({ type: "stop" });
      capture.worklet.port.onmessage = null;
      capture.worklet.port.close();
      capture.worklet.disconnect();
    }
    capture.source?.disconnect();
    capture.sink?.disconnect();
    void this.closeContext(capture.context);
  }

  private closeContext(context: AudioContext): Promise<void> {
    if (context.state === "closed") return Promise.resolve();
    const closed = context.close().catch(() => undefined);
    this.closingContexts.add(closed);
    void closed.then(() => this.closingContexts.delete(closed));
    return closed;
  }
}
