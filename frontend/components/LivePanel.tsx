"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Camera, CameraOff, Mic, MicOff, Play, Radio, Square, VolumeX, X } from "lucide-react";
import { LiveMedia, mediaErrorMessage } from "../lib/live/audio";
import { sameWorkspace, waitForWorkspacePaint } from "../lib/live/receipt";
import type { ActionReceipt, ExplanationStatus, LiveContext, LiveDraft, LiveEvent, ProposalAction } from "../lib/live/types";
import type { OptimizationResult } from "../lib/types";

type ApplicationEvent = Extract<LiveEvent, { type: "draft" | "view" | "result" | "proposal_action" }>;
type ReceiptHandler = ActionReceipt | Promise<ActionReceipt>;

type Props = {
  context: LiveContext;
  onDraft: (draft: LiveDraft) => ReceiptHandler;
  onCancelDraft: (id: string) => void;
  onClearDrafts: () => void;
  onView: (camera?: "top" | "perspective", assetId?: string) => ReceiptHandler;
  onResult: (revision: number, result: OptimizationResult) => ReceiptHandler;
  onExplanation?: (status: ExplanationStatus) => void;
  onProposalAction: (event: ProposalAction) => ReceiptHandler;
  onClose: () => void;
  onNewSpace: () => void;
  review: { id: string; status: "applied" | "rejected" } | null;
};
type State = "idle" | "connecting" | "connected" | "disconnected";

export default function LivePanel(props: Props) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const [state, setState] = useState<State>("idle");
  const [consent, setConsent] = useState(false);
  const [muted, setMuted] = useState(false);
  const [camera, setCamera] = useState(false);
  const [cameraPending, setCameraPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [transcript, setTranscript] = useState<{ role: string; text: string }[]>([]);
  const [usage, setUsage] = useState({ seconds: 0, audioSeconds: 0, frames: 0, tokens: null as number | null });
  const media = useRef<LiveMedia | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const connected = useRef(false);
  const resumeToken = useRef<string | undefined>(undefined);
  const counters = useRef({ audioSeconds: 0, frames: 0 });
  const turnBoundary = useRef(true);
  const receivingReplyAudio = useRef(false);
  const discardReplyAudio = useRef(false);
  const mounted = useRef(false);
  const actionQueue = useRef(Promise.resolve());
  const actions = useRef(new Map<string, { fingerprint: string; receipt?: ActionReceipt }>());
  const displayedDrafts = useRef(new Set<string>());
  const committingDrafts = useRef(new Set<string>());
  const cancelledDrafts = useRef(new Set<string>());

  async function stop(next: State = "idle", forget = true) {
    generation.current++;
    connected.current = false;
    receivingReplyAudio.current = false;
    discardReplyAudio.current = false;
    actionQueue.current = Promise.resolve();
    actions.current.clear();
    committingDrafts.current.clear();
    cancelledDrafts.current.clear();
    abort.current?.abort(); abort.current = null;
    if (timer.current) clearInterval(timer.current);
    if (watchdog.current) clearTimeout(watchdog.current);
    timer.current = null; watchdog.current = null;
    const ws = socket.current;
    socket.current = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      if (forget && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
      ws.close();
    }
    const current = media.current;
    media.current = null;
    if (video.current) video.current.srcObject = null;
    if (forget) resumeToken.current = undefined;
    setState(next); setCamera(false); setCameraPending(false); setMuted(false); setTranscript([]);
    await current?.stop();
  }
  const stopRef = useRef(stop); stopRef.current = stop;
  useEffect(() => {
    mounted.current = true;
    const leave = () => { void stopRef.current(); };
    window.addEventListener("pagehide", leave);
    return () => { mounted.current = false; window.removeEventListener("pagehide", leave); void stopRef.current(); };
  }, []);

  function send(message: object) {
    const ws = socket.current;
    if (!connected.current || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 512000) {
      setError("The connection cannot keep up. Media stopped; reconnect when ready.");
      void stop("disconnected", false); return;
    }
    ws.send(JSON.stringify(message));
  }
  const contextKey = JSON.stringify(props.context);
  useEffect(() => { send({ type: "context", context: latest.current.context }); }, [contextKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (props.review) send({ type: "draft_review", ...props.review }); }, [props.review]); // eslint-disable-line react-hooks/exhaustive-deps

  function rejected(message: string): ActionReceipt {
    return { status: "rejected", message, context: latest.current.context };
  }

  async function acknowledge(actionId: string, receipt: ActionReceipt, run: number) {
    const active = () => mounted.current && generation.current === run && connected.current;
    if (!active()) return;
    // Never report a displayed draft or completed result from an uncommitted render.
    const painted = await waitForWorkspacePaint(() => latest.current.context, receipt.context, active);
    if (!active()) return;
    const finalReceipt = painted === "unconfirmed"
      ? rejected("The application could not confirm a visible update. Check the current workspace before retrying.")
      : painted !== "painted" || !sameWorkspace(latest.current.context, receipt.context)
        ? rejected("The workspace changed before this action was acknowledged. Review the current version before retrying.")
        : receipt;
    send({ type: "action_ack", action_id: actionId, ...finalReceipt, message: finalReceipt.message.slice(0, 400) });
  }

  function applyAction(message: ApplicationEvent, run: number) {
    const active = () => mounted.current && generation.current === run && connected.current;
    const actionId = message.action_id;
    const fingerprint = JSON.stringify(message);
    if (actionId !== undefined && (typeof actionId !== "string" || !actionId || actionId.length > 128)) return;
    if (actionId) {
      const existing = actions.current.get(actionId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) void acknowledge(actionId, rejected("This action ID was already used for a different request."), run);
        else if (existing.receipt) void acknowledge(actionId, existing.receipt, run);
        return;
      }
      if (actions.current.size >= 256) {
        void acknowledge(actionId, rejected("This session reached its action limit. Reconnect to continue."), run);
        return;
      }
      actions.current.set(actionId, { fingerprint });
    }
    actionQueue.current = actionQueue.current.then(async () => {
      if (!active()) return;
      let receipt: ActionReceipt;
      try {
        if (message.type === "draft" && cancelledDrafts.current.has(message.draft.id)) {
          receipt = rejected("This draft was cancelled before it was displayed.");
        } else {
          switch (message.type) {
            case "draft":
              committingDrafts.current.add(message.draft.id);
              receipt = await latest.current.onDraft(message.draft);
              break;
            case "view": receipt = await latest.current.onView(message.camera, message.asset_id); break;
            case "result": receipt = await latest.current.onResult(message.revision, message.result); break;
            case "proposal_action": receipt = await latest.current.onProposalAction(message); break;
          }
          if (!receipt || !["applied", "rejected"].includes(receipt.status) || typeof receipt.message !== "string" || !receipt.context || !Number.isSafeInteger(receipt.context.revision)) {
            receipt = rejected("The application did not confirm this action. Review the current workspace before retrying.");
          }
        }
      } catch {
        receipt = rejected("The application could not complete this action. No success was confirmed.");
      }
      if (!active()) return;
      if (message.type === "draft") {
        committingDrafts.current.delete(message.draft.id);
        if (receipt.status === "applied") {
          displayedDrafts.current.add(message.draft.id);
          if (displayedDrafts.current.size > 256) displayedDrafts.current.delete(displayedDrafts.current.values().next().value!);
        }
      }
      if (actionId) {
        actions.current.set(actionId, { fingerprint, receipt });
        await acknowledge(actionId, receipt, run);
      }
    }).catch(() => {
      if (active() && actionId) void acknowledge(actionId, rejected("The application could not acknowledge this action."), run);
    });
  }

  async function start() {
    if (!consent || media.current || socket.current) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError("Microphone access needs HTTPS or localhost and a supported browser."); return; }
    const run = ++generation.current;
    const active = () => mounted.current && generation.current === run;
    setError(null); setState("connecting"); setTranscript([]); setUsage({ seconds: 0, audioSeconds: 0, frames: 0, tokens: null });
    counters.current = { audioSeconds: 0, frames: 0 }; turnBoundary.current = true;
    const audio = new LiveMedia(); media.current = audio;
    const controller = new AbortController(); abort.current = controller;
    watchdog.current = setTimeout(() => { if (active()) { setError("Live connection timed out. Media stopped."); void stop("disconnected", false); } }, 25000);
    try {
      await audio.primePlayback();
      if (!active()) { await audio.stop(); return; }
      await audio.startMicrophone(data => {
        if (!active() || !connected.current) return;
        send({ type: "audio", data });
        counters.current.audioSeconds += atob(data).length / 32000;
      });
      if (!active()) { await audio.stop(); return; }
      const response = await fetch("/api/live/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(resumeToken.current ? { resume_token: resumeToken.current } : {}), signal: controller.signal,
      });
      const session = await response.json();
      if (!active()) return;
      if (!response.ok) {
        if (session.code === "invalid_resume") resumeToken.current = undefined;
        throw new Error(typeof session.detail === "string" ? session.detail : "Live session is unavailable.");
      }
      const address = new URL(session.websocket_url);
      if (!["ws:", "wss:"].includes(address.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) || address.pathname !== "/live/ws" || address.search || address.username || address.password || typeof session.token !== "string") throw new Error("Invalid local Live connection.");
      resumeToken.current = session.resume_token;
      const ws = new WebSocket(address); socket.current = ws;
      ws.onopen = () => { if (active()) ws.send(JSON.stringify({ type: "auth", token: session.token })); };
      ws.onmessage = event => {
        if (!active()) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 1000000) throw new Error("Invalid relay message.");
          const message = JSON.parse(event.data) as LiveEvent;
          switch (message.type) {
            case "ready": {
              connected.current = true; setState("connected"); setModel(message.model);
              if (watchdog.current) clearTimeout(watchdog.current);
              send({ type: "context", context: latest.current.context });
              const started = Date.now();
              const limit = Math.min(300, Math.max(1, message.max_duration_seconds || 300));
              timer.current = setInterval(() => {
                const seconds = Math.floor((Date.now() - started) / 1000);
                setUsage(previous => ({ ...previous, seconds, ...counters.current }));
                if (seconds >= limit) { setError("The session time limit was reached. Media stopped."); void stop(); }
              }, 1000);
              break;
            }
            case "audio":
              receivingReplyAudio.current = true;
              if (discardReplyAudio.current) break;
              try { audio.playAudio(message.data); }
              catch (cause) {
                setError(mediaErrorMessage(cause));
                if (cause instanceof DOMException && cause.name === "QuotaExceededError") {
                  // Preserve input, drafts and transcripts; skip only this reply's speech.
                  audio.interrupt();
                  discardReplyAudio.current = true;
                } else void stop("disconnected", false);
              }
              break;
            case "transcript": {
              if (!["user", "assistant"].includes(message.role) || typeof message.text !== "string") break;
              if (message.role === "assistant") receivingReplyAudio.current = true;
              const boundary = turnBoundary.current; turnBoundary.current = false;
              setTranscript(previous => {
                const last = previous.at(-1);
                const next = !boundary && last?.role === message.role ? [...previous.slice(0, -1), { ...last, text: (last.text + message.text).slice(-4000) }] : [...previous, { role: message.role, text: message.text.slice(0, 4000) }];
                return next.slice(-30);
              }); break;
            }
            case "interrupted":
              audio.interrupt(); turnBoundary.current = true;
              receivingReplyAudio.current = discardReplyAudio.current = false;
              break;
            case "turn_complete":
              turnBoundary.current = true;
              receivingReplyAudio.current = discardReplyAudio.current = false;
              break;
            case "usage": if (typeof message.total_tokens === "number" && Number.isFinite(message.total_tokens)) setUsage(previous => ({ ...previous, tokens: message.total_tokens! })); break;
            case "draft":
            case "view":
            case "result":
            case "proposal_action": applyAction(message, run); break;
            case "explanation_status":
              latest.current.onExplanation?.(message);
              setError(message.status === "ok" ? null : message.message?.slice(0, 400) ?? "The saved result could not be retrieved. No new calculation was started.");
              break;
            case "draft_cancelled":
              if (!displayedDrafts.current.has(message.id) && !committingDrafts.current.has(message.id)) {
                cancelledDrafts.current.add(message.id);
                if (cancelledDrafts.current.size > 256) cancelledDrafts.current.delete(cancelledDrafts.current.values().next().value!);
                latest.current.onCancelDraft(message.id);
              }
              break;
            case "error": setError(message.message.slice(0, 400)); void stop("disconnected", false); break;
            case "ended": setError("Live session ended. Media stopped."); void stop(); break;
            case "reconnect": setError("The provider connection is ending. Reconnect to continue; media is off."); void stop("disconnected", false); break;
          }
        } catch { setError("The Live relay sent an invalid response. Media stopped."); void stop("disconnected", false); }
      };
      const disconnected = () => { if (active()) { setError("Live disconnected. Media is off. Your reviewed workspace is unchanged."); void stop("disconnected", false); } };
      ws.onerror = disconnected; ws.onclose = disconnected;
    } catch (cause) {
      if (!active()) return;
      setError(cause instanceof DOMException ? mediaErrorMessage(cause) : cause instanceof Error ? cause.message.slice(0, 400) : "Live could not start.");
      await stop("disconnected", false);
    }
  }

  async function toggleCamera() {
    const current = media.current;
    if (!connected.current || !current || !video.current || cameraPending) return;
    if (camera) { current.stopCamera(); video.current.srcObject = null; setCamera(false); return; }
    const run = generation.current;
    setCameraPending(true); setError(null);
    try {
      await current.startCamera(video.current, data => {
        if (generation.current !== run || !connected.current) return;
        send({ type: "video", data }); counters.current.frames++;
      });
      if (generation.current === run) setCamera(true);
    } catch (cause) { if (generation.current === run) setError(mediaErrorMessage(cause)); }
    finally { if (generation.current === run) setCameraPending(false); }
  }

  return <section className="live-panel" aria-label="AcreIQ Live">
    <div className="live-header">
      <div><Radio size={16} /><h2>AcreIQ Live</h2><span role="status" className={`live-status ${state}`}>{state === "idle" ? "Ready to start" : state === "connecting" ? "Connecting" : state === "connected" ? "Live connected" : "Disconnected"}</span></div>
      <button className="icon-button" aria-label="Close Live panel" title="Close Live panel" onClick={() => { void stop().then(props.onClose); }}><X size={17} /></button>
    </div>
    <div className="live-body">
      <div className="live-camera">
        <video ref={video} autoPlay muted playsInline aria-label="Private camera preview" className={camera ? "" : "live-video-off"} />
        {!camera && <div className="live-camera-off"><CameraOff size={25} /><span>Camera off</span></div>}
        {camera && <span className="live-camera-caption">Live preview / 1 frame per second sent</span>}
      </div>
      <div className="live-conversation">
        <div className="live-transcript" role="log" aria-label="Live transcript" aria-live="polite">
          {!transcript.length ? <p className="muted">{state === "connected" ? "Listening. Awaiting speech." : "No conversation in progress."}</p> : transcript.map((line, index) => <p key={index}><strong>{line.role === "user" ? "You" : "AcreIQ"}</strong>{line.text}</p>)}
        </div>
        <div className="live-controls">
          {state !== "connected" && state !== "connecting" ? <button className="primary-button" disabled={!consent} onClick={() => void start()}><Play size={14} />{state === "disconnected" ? "Reconnect Live" : "Start Live"}</button> : <>
            <button className={`icon-button ${muted ? "active" : ""}`} disabled={state !== "connected"} aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute microphone" : "Mute microphone"} aria-pressed={muted} onClick={() => { media.current?.setMuted(!muted); if (!muted) send({ type: "audio_end" }); setMuted(!muted); }}>{muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
            <button className={`icon-button ${camera ? "active" : ""}`} disabled={state !== "connected" || cameraPending} aria-label={camera ? "Turn camera off" : "Enable camera and share frames"} title={camera ? "Turn camera off" : "Enable camera and share frames"} aria-pressed={camera} onClick={() => void toggleCamera()}>{camera ? <Camera size={18} /> : <CameraOff size={18} />}</button>
            <button className="icon-button" disabled={state !== "connected"} aria-label="Stop spoken reply" title="Stop spoken reply" onClick={() => {
              media.current?.interrupt();
              discardReplyAudio.current = receivingReplyAudio.current;
              setError(null);
            }}><VolumeX size={18} /></button>
            <button className="secondary-button live-end" onClick={() => { setError(null); void stop(); }}><Square size={14} />End session</button>
          </>}
          <span className="live-usage" aria-label="Live usage">{usage.seconds}s / 300s · {usage.audioSeconds.toFixed(1)}s audio sent · {usage.frames} frames{usage.tokens !== null ? ` · ${usage.tokens} tokens reported` : ""}</span>
        </div>
      </div>
    </div>
    {state !== "connected" && state !== "connecting" && <label className="live-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I consent to sending microphone audio and reviewed workspace context to Google Gemini. Camera sharing is separate. Provider usage may be billed.</label>}
    {props.context.scenario.source === "sample" && <div className="live-sample"><span>Sample workspace: all measurements remain synthetic.</span><button className="text-button" disabled={state === "connecting"} onClick={props.onNewSpace}>Start a blank real space<ArrowRight size={13} /></button></div>}
    {error && <p className="live-error" role="alert">{error} Photo upload and manual inputs remain available.</p>}
    <div className="live-privacy"><span>No local recording. Transcript clears when the session ends.</span>{model && <span>{model}</span>}</div>
  </section>;
}
