class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    if (sampleRate !== 16000) throw new Error("Live capture requires a 16000 Hz AudioContext.");
    this.muted = options.processorOptions?.muted ?? false;
    this.revision = options.processorOptions?.revision ?? 0;
    this.stopped = false;
    this.offset = 0;
    this.pcm = new ArrayBuffer(1600 * 2);
    this.view = new DataView(this.pcm);
    this.port.onmessage = ({ data }) => {
      if (data.type === "set-muted") {
        this.muted = data.muted;
        this.revision = data.revision;
        this.offset = 0;
        new Uint8Array(this.pcm).fill(0);
      } else if (data.type === "stop") {
        this.stopped = true;
        this.offset = 0;
        new Uint8Array(this.pcm).fill(0);
        this.port.onmessage = null;
        this.port.close();
      }
    };
  }

  process(inputs, outputs) {
    // Keep the graph alive without ever routing microphone samples to the speakers.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    if (this.muted) return true;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      const clipped = Number.isNaN(value) ? 0 : Math.max(-1, Math.min(1, value));
      const sample = Math.round(clipped * (clipped < 0 ? 32768 : 32767));
      this.view.setInt16(this.offset * 2, sample, true);
      this.offset++;
      if (this.offset === 1600) {
        this.port.postMessage({ pcm: this.pcm, revision: this.revision }, [this.pcm]);
        this.pcm = new ArrayBuffer(1600 * 2);
        this.view = new DataView(this.pcm);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("live-capture", LiveCaptureProcessor);
