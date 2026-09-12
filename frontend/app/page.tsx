"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Camera, ChevronDown, Download, Leaf, Loader2, ScanLine, SlidersHorizontal, Upload, X, Zap } from "lucide-react";
import type { FormEvent } from "react";
import "./workspace.css";

type Source = "sample" | "manual" | "photo-assisted";
type Scenario = {
  source: Source; length_ft: number; width_ft: number; canopy_sqft: number; light_count: number;
  lighting_watts: number; other_watts: number; other_hours: number; baseline_hours: number;
  baseline_dim: number; dimmable: boolean; ppfd_full: number | null; min_dli: number | null;
  min_hours: number; max_hours: number; power_limit_watts: number; electricity_usd_kwh: number;
  operating_days: number; water_liters_day: number | null; confirmed: boolean;
};
type NumericKey = Exclude<keyof Scenario, "source" | "dimmable" | "confirmed">;
type FormState = Record<NumericKey, string>;
type Metrics = {
  photoperiod_hours: number; dim_fraction: number; daily_energy_kwh: number;
  period_energy_kwh: number; period_energy_cost_usd: number; peak_modeled_watts: number;
  dli_mol_m2_day: number | null; period_water_liters: number | null; canopy_sqft: number;
};
type Candidate = Metrics & { feasible: boolean; rejected_for: string[] };
type Result = {
  status: "needs_measurement" | "no_feasible_configuration" | "optimized";
  model_version: string; source: Source; operating_days: number; baseline: Metrics;
  optimized: Metrics | null; configurations_evaluated: number; feasible_configurations: number;
  candidates: Candidate[]; recommendations: string[]; limitations: string[];
  savings: { period_energy_kwh: number; energy_pct: number; period_energy_cost_usd: number } | null;
};
type Vision = { summary: string; observations: { kind: string; quantity: number; description: string }[]; missing_information: string[] };
const EMPTY: FormState = {
  length_ft: "", width_ft: "", canopy_sqft: "", light_count: "", lighting_watts: "",
  other_watts: "0", other_hours: "24", baseline_hours: "", baseline_dim: "1",
  ppfd_full: "", min_dli: "", min_hours: "", max_hours: "", power_limit_watts: "",
  electricity_usd_kwh: "", operating_days: "365", water_liters_day: "",
};
const format = (n: number | null | undefined, digits = 1) => n == null ? "Not estimated" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  const data = await response.json();
  if (!response.ok) {
    const detail = data.detail;
    throw new Error(Array.isArray(detail) ? detail.map((d: { loc?: string[]; msg?: string }) => `${d.loc?.slice(1).join(".") || "Input"}: ${d.msg}`).join("; ") : typeof detail === "string" ? detail : "Request failed. Check that the backend is running.");
  }
  return data as T;
}

export default function Home() {
  const [source, setSource] = useState<Source | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [dimmable, setDimmable] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<{ vision_configured: boolean } | null>(null);
  const [checked, setChecked] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState("");
  const [vision, setVision] = useState<Vision | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [submitted, setSubmitted] = useState<Scenario | null>(null);
  const [view, setView] = useState<"baseline" | "optimized">("optimized");
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  useEffect(() => { let active = true; request<{ vision_configured: boolean }>("health").then(r => { if (active) setHealth(r); }).catch(() => {}).finally(() => { if (active) setChecked(true); }); return () => { active = false; }; }, []);
  useEffect(() => { if (!file) { setImage(""); return; } const url = URL.createObjectURL(file); setImage(url); return () => URL.revokeObjectURL(url); }, [file]);
  function enter() { setTimeout(() => workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0); }
  function change(key: NumericKey, value: string) { setForm(f => ({ ...f, [key]: value })); setConfirmed(false); setResult(null); }
  function manual() { setSource("manual"); setForm({ ...EMPTY }); setDimmable(false); setConfirmed(false); setResult(null); setVision(null); setFile(null); setError(""); enter(); }
  async function sample() {
    setBusy("Opening sample"); setError("");
    try {
      const { scenario } = await request<{ scenario: Scenario }>("sample");
      const values = { ...EMPTY }; for (const key of Object.keys(values) as NumericKey[]) values[key] = scenario[key] == null ? "" : String(scenario[key]);
      setForm(values); setSource("sample"); setDimmable(scenario.dimmable); setConfirmed(false); setResult(null); setFile(null); setVision(null); enter();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the sample."); }
    finally { setBusy(null); }
  }
  function chooseFile(f?: File) {
    if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size > 4 * 1024 * 1024) { setError("Choose a JPEG, PNG or WebP smaller than 4 MB."); return; }
    setFile(f); setSource("photo-assisted"); setForm({ ...EMPTY }); setDimmable(false); setConfirmed(false); setResult(null); setVision(null); setError(""); enter();
  }
  async function analyze() {
    if (!file) return; setBusy("Identifying visible assets"); setError("");
    try {
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("Could not read this image.")); reader.readAsDataURL(file); });
      const v = await request<Vision>("vision", { mime_type: file.type, image_base64: data });
      setVision(v); const count = v.observations.filter(o => o.kind === "light_fixture").reduce((n, o) => n + o.quantity, 0);
      if (count) setForm(f => ({ ...f, light_count: String(count) }));
      setConfirmed(false); setResult(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Image analysis failed. Manual inputs still work."); }
    finally { setBusy(null); }
  }
  async function optimize(event: FormEvent) {
    event.preventDefault(); if (!source) return; setBusy("Evaluating lighting configurations"); setError("");
    try {
      const numeric = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === "" ? null : Number(v)]));
      const payload = { ...numeric, source, dimmable, confirmed } as Scenario;
      const r = await request<Result>("optimize", payload); setSubmitted(payload); setResult(r); setView("optimized");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not run scenarios."); }
    finally { setBusy(null); }
  }
  function exportRun() {
    if (!result || !submitted) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), inputs: submitted, result }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = "acreiq-scenario.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const active = result ? (view === "optimized" ? result.optimized || result.baseline : result.baseline) : null;
  function field(key: NumericKey, label: string, optional = false, hint?: string) {
    return <label className="aq-field" key={key}><span>{label}{optional && <small> optional</small>}</span><input inputMode="decimal" type="number" step={key === "light_count" || key === "operating_days" ? "1" : "any"} min="0" value={form[key]} required={!optional} onChange={e => change(key, e.target.value)} placeholder={optional ? "Unknown" : "Enter value"} />{hint && <small>{hint}</small>}</label>;
  }
  return <main className="aq-app">
    <a className="aq-skip" href="#workspace">Skip to workspace</a>
    <header className="aq-nav"><a href="#" className="aq-brand" aria-label="AcreIQ home"><span><Leaf size={19} /></span>AcreIQ</a><span className="aq-navlabel">RESOURCE INTELLIGENCE</span><a href="#model-notes" className="aq-link">How it works <ArrowRight size={14} /></a></header>
    <section className="aq-hero"><div className="aq-kicker"><span /> OPTIMIZE FIRST. PURCHASE SECOND.</div><h1>See what you have.<br /><em>Build what’s possible.</em></h1><p>Your space has potential. Map the resources already there, test an operating change, and understand the trade-offs before buying more.</p><div className="aq-heroactions"><button className="aq-primary" disabled={!!busy} onClick={sample}>Explore a sample <ArrowRight size={17} /></button><button className="aq-secondary" disabled={!!busy} onClick={() => uploadRef.current?.click()}><ScanLine size={17} /> Scan your space</button></div><div className="aq-herofoot">No signup needed <span>·</span> Editable assumptions <span>·</span> Transparent calculations</div></section>
    <div className="aq-steps"><span className={source ? "done" : "active"}>01 <b>Observe</b></span><i /><span className={source && !result ? "active" : result ? "done" : ""}>02 <b>Review & model</b></span><i /><span className={result ? "active" : ""}>03 <b>Compare scenarios</b></span></div>
    {error && <div className="aq-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
    <div role="status" aria-live="polite" className={busy ? "aq-working" : "aq-sr"}>{busy && <Loader2 size={16} className="aq-spin" />}{busy || "Ready"}</div>
    <input hidden type="file" accept="image/jpeg,image/png,image/webp" ref={uploadRef} onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
    <input hidden type="file" accept="image/*" capture="environment" ref={cameraRef} onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = ""; }} />
    <section className="aq-workspace" id="workspace" ref={workspaceRef} aria-label="AcreIQ workspace">
      <div className="aq-canvascol"><div className="aq-panel aq-twin"><div className="aq-panelhead"><div><span className="aq-overline">YOUR RESOURCE TWIN</span><h2>{source === "sample" ? "The grow-room sample" : source ? "Your growing environment" : "A clearer view of your space"}</h2></div><span className="aq-badge">{source === "sample" ? "SYNTHETIC SAMPLE" : source ? "INPUT-BASED MODEL" : "SCHEMATIC PREVIEW"}</span></div>
        {image && <div className="aq-image"><img src={image} alt="Your uploaded growing environment" /><div className="aq-imagecaption">Photo preview · not a reconstructed model</div></div>}
        <div className="aq-twinbody"><Twin length={Number(form.length_ft) || 8} width={Number(form.width_ft) || 8} canopy={Number(form.canopy_sqft) || 0} lights={Number(form.light_count) || 0} dim={active?.dim_fraction ?? Number(form.baseline_dim)} hours={active?.photoperiod_hours ?? Number(form.baseline_hours)} preview={!source} /></div>
        <div className="aq-twinbar"><span>{source ? `${form.length_ft || "?"} × ${form.width_ft || "?"} ft · ${form.light_count || "?"} fixtures entered` : "Illustrative preview · upload or enter your space"}</span>{result?.optimized && <div className="aq-toggle" aria-label="Compare configurations"><button aria-pressed={view === "baseline"} onClick={() => setView("baseline")}>Current</button><button aria-pressed={view === "optimized"} onClick={() => setView("optimized")}>Proposed</button></div>}</div>
        <p className="aq-caption">Schematic only, not to scale. Positions are illustrative, not detected coordinates. This milestone tests lighting schedules, not physical rearrangements.</p>
      </div>
      {active && result && <div className="aq-metrics" aria-live="polite"><Metric label="Modeled energy / day" value={`${format(active.daily_energy_kwh, 2)} kWh`} note={`${format(active.peak_modeled_watts)} W combined load`} /><Metric label={`Energy / ${result.operating_days} days`} value={`${format(active.period_energy_kwh)} kWh`} note="Entered loads only" /><Metric label="Daily light integral" value={format(active.dli_mol_m2_day, 2)} note="mol/m²/day · modeled" /><Metric label={`Electricity / ${result.operating_days} days`} value={`$${format(active.period_energy_cost_usd, 2)}`} note="Flat rate; excludes demand charges" /></div>}
      {result && <section className="aq-panel aq-results"><div className="aq-panelhead"><div><span className="aq-overline">SCENARIO EVIDENCE</span><h2>{result.status === "optimized" ? "A change you can test." : result.status === "needs_measurement" ? "One more measurement." : "The constraints do not fit."}</h2></div><button className="aq-iconbutton" onClick={exportRun} aria-label="Export scenario JSON"><Download size={18} /></button></div><div className="aq-evidence"><strong>{result.configurations_evaluated}</strong><span>actual configurations evaluated<br />{result.feasible_configurations} met your constraints</span></div>
        {!!result.candidates.length && <Candidates candidates={result.candidates} />}
        {result.savings && <div className="aq-savings"><Zap size={20} /><div><strong>{format(Math.abs(result.savings.energy_pct))}% {result.savings.energy_pct >= 0 ? "less" : "more"} modeled energy</strong><span>{format(Math.abs(result.savings.period_energy_kwh))} kWh · ${format(Math.abs(result.savings.period_energy_cost_usd), 2)} {result.savings.energy_pct >= 0 ? "avoided" : "additional"} over {result.operating_days} operating days</span></div></div>}
        <div className="aq-recommendations">{result.recommendations.map((r, i) => <p key={r}><span>{String(i + 1).padStart(2, "0")}</span>{r}</p>)}</div><div className="aq-unmodeled">Water savings, yield gains and avoided CapEx: <b>not estimated</b>. Preserving light dose does not validate crop output.</div><details><summary>Assumptions & limitations <ChevronDown size={15} /></summary>{result.limitations.map(l => <p key={l}>{l}</p>)}</details>
      </section>}
      </div>
      <aside className="aq-panel aq-inspector"><div className="aq-panelhead"><div><span className="aq-overline">THE STARTING POINT</span><h2>{source ? "Review your inputs" : "Start with what you have"}</h2></div><SlidersHorizontal size={19} /></div>
        {!source ? <div className="aq-start"><p>Try an editable sample, scan a photo, or enter a known setup. No invented measurements.</p><button className="aq-entry" disabled={!!busy} onClick={sample}><span><Leaf size={19} /><b>Explore the sample</b><small>8 × 8 ft room · illustrative inputs</small></span><ArrowRight size={17} /></button><button className="aq-entry" disabled={!!busy} onClick={() => uploadRef.current?.click()}><span><Upload size={19} /><b>Upload a room photo</b><small>JPEG, PNG or WebP · up to 4 MB</small></span><ArrowRight size={17} /></button><button className="aq-entry" disabled={!!busy} onClick={() => cameraRef.current?.click()}><span><Camera size={19} /><b>Capture with your phone</b><small>Use the device’s camera picker</small></span><ArrowRight size={17} /></button><button className="aq-textbutton" disabled={!!busy} onClick={manual}>Enter measurements manually</button></div> : <>
          <div className="aq-source">{source === "sample" ? "Sample assumptions, not measurements from your room. Edit any value." : "Confirm dimensions, loads and crop constraints. Unknown values are never inferred from a photo."}</div>
          {file && <div className="aq-vision"><button className="aq-secondary" disabled={!!busy} onClick={analyze}><ScanLine size={16} />{vision ? "Analyze again" : "Identify visible assets"}</button><p>This sends your photo to Google’s Gemini API. The app does not persist the image.</p>{vision && <><p>{vision.summary}</p><div className="aq-observations">{vision.observations.map((o, i) => <div key={i}><b>{o.quantity} × {o.kind.replaceAll("_", " ")}</b><span>{o.description}</span></div>)}</div><small>AI suggestions, not confirmed inventory. Review the tentative light count below.</small><details><summary>What the photo cannot establish</summary>{vision.missing_information.map((m, i) => <p key={i}>{m}</p>)}</details></>}</div>}
          <form onSubmit={optimize}><fieldset disabled={!!busy}><legend className="aq-sr">Scenario inputs</legend><div className="aq-formsection"><h3>Space & equipment</h3><div className="aq-fields">{field("length_ft", "Length · ft")}{field("width_ft", "Width · ft")}{field("canopy_sqft", "Canopy · sq ft")}{field("light_count", "Light fixtures")}{field("lighting_watts", "All lights · W", false, "Combined full-output load")}{field("power_limit_watts", "Modeled load limit · W")}</div></div>
          <div className="aq-formsection"><h3>Light & crop constraints</h3><div className="aq-fields">{field("baseline_hours", "Current light hours/day")}{field("ppfd_full", "Canopy PPFD at 100%", true, "µmol/m²/s; use a measured value")}{field("min_dli", "Crop DLI minimum", true, "mol/m²/day; crop-stage specific")}{field("min_hours", "Minimum light hours")}{field("max_hours", "Maximum light hours")}{field("electricity_usd_kwh", "Electricity · $/kWh")}</div><label className="aq-check"><input type="checkbox" checked={dimmable} onChange={e => { setDimmable(e.target.checked); change("baseline_dim", "1"); }} /><span>Existing fixtures support dimming</span></label>{dimmable && field("baseline_dim", "Current output fraction", false, "0–1; 0.8 means 80%")}</div>
          <details className="aq-advanced"><summary>Other loads & forecast horizon <ChevronDown size={15} /></summary><div className="aq-fields">{field("other_watts", "Other combined load · W")}{field("other_hours", "Other load hours/day")}{field("operating_days", "Operating days")}{field("water_liters_day", "Water · liters/day", true)}</div><p>365 days is an annualized scenario, not savings already achieved in 2026. Include fans, pumps and other known loads. Water is reported unchanged.</p></details>
          <label className="aq-check aq-confirm"><input required type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>{source === "sample" ? "I understand these are editable sample assumptions." : "I reviewed the inventory and entered measurements or explicit assumptions."}</span></label><button className="aq-primary aq-full" disabled={!!busy || !confirmed} type="submit">Compare lighting scenarios <ArrowRight size={17} /></button></fieldset></form>
          <div className="aq-reset"><button disabled={!!busy} className="aq-textbutton" onClick={() => uploadRef.current?.click()}>New photo</button><button disabled={!!busy} className="aq-textbutton" onClick={manual}>New setup</button></div>
        </>}
        <div className="aq-connection"><span className={health ? "on" : ""} />{!checked ? "Checking backend…" : !health ? "Backend offline. Start FastAPI to continue." : health.vision_configured ? "API ready · vision configured" : "API ready · vision needs credentials"}</div>
      </aside>
    </section>
    <section className="aq-modelnotes" id="model-notes"><div><span className="aq-overline">THE MATH, NOT THE MAGIC</span><h2>Every result has a reason.</h2><p>Vision suggests what is present. You confirm what matters. A bounded numerical search tests lighting settings against the constraints you enter.</p></div><div className="aq-equations"><p><b>Energy</b><code>watts × hours ÷ 1,000 = kWh</code></p><p><b>Daily light integral</b><code>PPFD × output fraction × hours × 0.0036</code></p><p><b>Current scope</b><span>One canopy plane. Existing fixtures. Lighting schedules and dimming. Not a crop, soil or airflow simulator.</span></p></div></section>
    <footer className="aq-footer"><span>AcreIQ <small>Grow more with what you already have.</small></span><span>Research prototype · verify before implementation</span></footer>
  </main>;
}
function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <div className="aq-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>; }
function Twin({ length, width, canopy, lights, dim, hours, preview }: { length: number; width: number; canopy: number; lights: number; dim: number; hours: number; preview: boolean }) {
  const ratio = Math.min(1, Math.max(0, canopy / (length * width)));
  const plants = preview ? 16 : Math.min(32, Math.ceil(ratio * 32));
  const count = preview ? 2 : Math.min(lights, 12);
  return <svg viewBox="0 0 640 390" role="img" aria-label={preview ? "Illustrative growing-room schematic" : `Input-based schematic, ${length} by ${width} feet, ${lights} light fixtures. Positions are illustrative.`} className="aq-twinsvg">
    <defs><pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#254337" strokeWidth=".6" /></pattern><linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#173529" /><stop offset="1" stopColor="#0c211a" /></linearGradient></defs>
    <rect x="35" y="25" width="570" height="300" rx="10" fill="url(#grid)" opacity=".5" />
    <g transform="translate(320 187)"><g transform="matrix(.88 .30 -.88 .30 0 -15)"><rect x="-155" y="-145" width="310" height="290" fill="url(#floor)" stroke="#6b9f82" strokeWidth="2" /><rect x="-155" y="-145" width="310" height="290" fill="url(#grid)" />{Array.from({ length: plants }, (_, i) => <g key={i} transform={`translate(${-112 + (i % 4) * 74} ${-108 + Math.floor(i / 4) * (plants > 16 ? 32 : 70)})`}><rect width="40" height="40" rx="6" fill="#1c4e38" stroke="#3f8860" /><ellipse cx="20" cy="19" rx="13" ry="9" fill="#6bac74" /><ellipse cx="17" cy="14" rx="7" ry="12" fill="#8ac085" /></g>)}</g>
    <path d="M-264 -12v-92M9 -102v-94M264 -20v-95" stroke="#729683" strokeWidth="2" opacity=".7" /><path d="M-264 -104L9 -196 264 -115" fill="none" stroke="#456954" strokeWidth="2" />
    {Array.from({ length: count }, (_, i) => { const x = -105 + i * (210 / Math.max(1, count - 1)); return <g key={i}><path d={`M${x - 33} -113L${x - 55} 27 ${x + 75} 18 ${x + 32} -118Z`} fill="#a8d997" opacity={.035 + .08 * (dim || 1)} /><path d={`M${x - 33} -113L${x + 30} -135 ${x + 51} -127 ${x - 11} -105Z`} fill="#b9d9ad" stroke="#e3edd5" strokeWidth="1" /></g>; })}
    </g><path d="M69 255l251 86M320 341l247-85" fill="none" stroke="#658572" strokeDasharray="3 5" /><text x="124" y="315" fill="#9bb9a6" fontSize="12" transform="rotate(19 124 315)">{preview ? "Your space" : `${length} ft entered`}</text><text x="459" y="316" fill="#9bb9a6" fontSize="12" transform="rotate(-19 459 316)">{preview ? "Your resources" : `${width} ft entered`}</text>
    <rect x="42" y="344" width="556" height="29" rx="6" fill="#132c22" /><text x="58" y="363" fill="#afcbb7" fontSize="11">{preview ? "VISION → CONFIRMED INPUTS → SCENARIO SEARCH" : `${hours || "?"} h/day · ${Math.round((dim || 1) * 100)}% light output · ${canopy || "?"} sq ft canopy`}</text>
  </svg>;
}
function Candidates({ candidates }: { candidates: Candidate[] }) {
  const minH = Math.min(...candidates.map(c => c.photoperiod_hours)), maxH = Math.max(...candidates.map(c => c.photoperiod_hours));
  const maxE = Math.max(...candidates.map(c => c.daily_energy_kwh));
  return <div className="aq-chart"><svg viewBox="0 0 580 145" role="img" aria-label="Evaluated scenarios. Horizontal axis: lighting hours. Vertical axis: daily modeled energy. Green circles meet constraints, gray crosses fail."><path d="M38 12V114H568" stroke="#355343" fill="none" />{candidates.map((c, i) => { const x = 45 + ((c.photoperiod_hours - minH) / Math.max(1, maxH - minH)) * 510; const y = 110 - (c.daily_energy_kwh / Math.max(.001, maxE)) * 90; return c.feasible ? <circle key={i} cx={x} cy={y} r="3" fill="#aed584"><title>{`${c.photoperiod_hours}h, ${c.dim_fraction * 100}% output, ${c.daily_energy_kwh} kWh/day: feasible`}</title></circle> : <path key={i} d={`M${x - 2},${y - 2}l4,4m0,-4l-4,4`} stroke="#758477"><title>{`${c.photoperiod_hours}h: ${c.rejected_for.join(", ")}`}</title></path>; })}<text x="40" y="135" fill="#9eb3a3" fontSize="11">{minH}h</text><text x="537" y="135" fill="#9eb3a3" fontSize="11">{maxH}h</text><text x="205" y="135" fill="#9eb3a3" fontSize="11">Lighting hours/day</text><text x="43" y="10" fill="#9eb3a3" fontSize="10">kWh/day</text></svg><small>● Meets constraints &nbsp; × Rejected &nbsp; · Each mark is an evaluated setting</small></div>;
}
