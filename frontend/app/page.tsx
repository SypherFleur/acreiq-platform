"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Cpu,
  Droplets,
  Gauge,
  Leaf,
  ScanLine,
  Sparkles,
  Upload,
  Zap,
} from "lucide-react";

type Phase = "idle" | "scanned" | "optimized";

const baseline = {
  score: 61.4,
  energy: 58400,
  water: 182500,
  capex: 10000,
  utilization: 54,
  reuse: 71,
  output: 5000,
};

const optimized = {
  score: 87.9,
  energy: 49640,
  water: 146000,
  capex: 7500,
  utilization: 82,
  reuse: 94,
  output: 5500,
};

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const active = phase === "optimized" ? optimized : baseline;

  const savings = useMemo(
    () => ({
      energy: baseline.energy - optimized.energy,
      water: baseline.water - optimized.water,
      capex: baseline.capex - optimized.capex,
      output: optimized.output - baseline.output,
    }),
    []
  );

  function handleFile(file?: File) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setPhase("scanned");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brandMark"><Leaf size={18} /></div>
          <span>AcreIQ</span>
        </div>
        <div className="status"><span className="statusDot" /> Resource Twin Online</div>
      </header>

      <section className="hero">
        <div className="eyebrow"><Sparkles size={15} /> AI spatial optimization</div>
        <h1>See what you have.<br />Build what&apos;s possible.</h1>
        <p>
          Scan a growing space. AcreIQ builds a resource twin, simulates thousands of configurations,
          and shows how to produce more with less energy, water, and new equipment.
        </p>
      </section>

      <section className="workspace">
        <div className="panel scanPanel">
          <div className="panelHead">
            <div>
              <span className="step">01</span>
              <h2>Observe the space</h2>
            </div>
            <ScanLine size={20} />
          </div>

          <button className="scanArea" onClick={() => inputRef.current?.click()}>
            {imageUrl ? (
              <img src={imageUrl} alt="Uploaded growing space" className="preview" />
            ) : (
              <div className="scanEmpty">
                <div className="scannerIcon"><Camera size={30} /></div>
                <strong>Scan or upload your environment</strong>
                <span>Photo, camera capture, or room image</span>
              </div>
            )}
            <div className="scanCorners" />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => handleFile(e.target.files?.[0])}
          />

          <div className="actions">
            <button className="secondary" onClick={() => inputRef.current?.click()}>
              <Upload size={16} /> {imageUrl ? "Replace image" : "Upload image"}
            </button>
            <button
              className="primary"
              disabled={!imageUrl}
              onClick={() => setPhase("optimized")}
            >
              Run AcreIQ <ArrowRight size={16} />
            </button>
          </div>
        </div>

        <div className="panel twinPanel">
          <div className="panelHead">
            <div>
              <span className="step">02</span>
              <h2>Resource twin</h2>
            </div>
            <Cpu size={20} />
          </div>

          <div className={`twinStage ${phase}`}>
            <div className="gridFloor" />
            <div className="rack rackOne"><span /><span /><span /></div>
            <div className="rack rackTwo"><span /><span /></div>
            <div className="lightBeam beamOne" />
            <div className="lightBeam beamTwo" />
            <div className="assetTag tagOne">Rack · 2 levels</div>
            <div className="assetTag tagTwo">300W light</div>
            {phase === "optimized" && <div className="optimizationPulse">4,862 configurations evaluated</div>}
          </div>

          <div className="detected">
            <span><CheckCircle2 size={14} /> 2 lights</span>
            <span><CheckCircle2 size={14} /> 2 racks</span>
            <span><CheckCircle2 size={14} /> 1 fan</span>
            <span><CheckCircle2 size={14} /> 12 plants</span>
          </div>
        </div>
      </section>

      <section className="metricsRow">
        <Metric icon={<Gauge size={17} />} label="AcreIQ score" value={active.score.toFixed(1)} delta={phase === "optimized" ? "+26.5" : "Baseline"} />
        <Metric icon={<Zap size={17} />} label="Energy / year" value={`${active.energy.toLocaleString()} kWh`} delta={phase === "optimized" ? "−15%" : "Current"} />
        <Metric icon={<Droplets size={17} />} label="Water / year" value={`${active.water.toLocaleString()} gal`} delta={phase === "optimized" ? "−20%" : "Current"} />
        <Metric icon={<Leaf size={17} />} label="Space utilization" value={`${active.utilization}%`} delta={phase === "optimized" ? "+28 pts" : "Current"} />
      </section>

      {phase === "optimized" && (
        <section className="resultPanel">
          <div className="resultCopy">
            <div className="eyebrow"><Sparkles size={15} /> Optimization complete</div>
            <h2>Reuse more. Buy less. Produce more.</h2>
            <p>
              AcreIQ recommends increasing vertical utilization with the existing rack structure,
              adjusting the light schedule, and repositioning airflow before adding new hardware.
            </p>
          </div>
          <div className="impactGrid">
            <Impact value={`$${savings.capex.toLocaleString()}`} label="CapEx avoided" />
            <Impact value={`${savings.energy.toLocaleString()} kWh`} label="Energy saved / yr" />
            <Impact value={`${savings.water.toLocaleString()} gal`} label="Water saved / yr" />
            <Impact value={`+${savings.output.toLocaleString()} lb`} label="Projected output / yr" />
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({ icon, label, value, delta }: { icon: React.ReactNode; label: string; value: string; delta: string }) {
  return (
    <div className="metricCard">
      <div className="metricLabel">{icon}<span>{label}</span></div>
      <strong>{value}</strong>
      <small>{delta}</small>
    </div>
  );
}

function Impact({ value, label }: { value: string; label: string }) {
  return (
    <div className="impact">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
