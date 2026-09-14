"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Box, Focus, Layers3, LoaderCircle, Pause, Play, Sun } from "lucide-react";
import type { Scenario, TwinAsset } from "../lib/types";

const SpatialTwin = dynamic(() => import("./SpatialTwin"), {
  ssr: false,
  loading: () => <div className="scene-loading"><LoaderCircle className="spin" size={22} /><span>Building resource twin</span></div>,
});

export default function SiteComparisonTwin({ scenario, assets, name, saved }: {
  scenario: Scenario; assets: TwinAsset[]; name: string; saved: boolean;
}) {
  const [camera, setCamera] = useState<"top" | "perspective">("perspective");
  const [rotate, setRotate] = useState(true);
  const [layer, setLayer] = useState<"structure" | "light">("structure");
  const [reset, setReset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const asset = assets.find(item => item.id === selected);
  return <section className="site-twin twin-workspace" aria-label="Site plan schematic">
    <div className="twin-toolbar">
      <strong>{name}</strong><span className="schematic-tag"><Box size={13} />SCHEMATIC TWIN</span>
    </div>
    <div className="scene">
      <SpatialTwin scenario={scenario} assets={assets} optimized={null} mode="current" layer={layer}
        selectedAsset={selected} onSelectAsset={setSelected} autoRotate={rotate} view={camera} resetKey={reset} />
      <div className="scene-top">
        <div><div className="scene-kicker">{saved ? "SAVED SCENARIO" : "DRAFT INPUTS"}</div>
          <div className="scene-dimension">{scenario.length_ft || "?"} &times; {scenario.width_ft || "?"} <span>ft</span></div></div>
        <div className="scene-schedule"><Sun size={15} /><strong>{scenario.baseline_hours} h</strong><span>requested / day</span></div>
      </div>
      {asset && <div className="asset-callout"><Box size={15} /><div><strong>{asset.name}</strong><span>{asset.quantity} in resource inventory</span></div></div>}
      <div className="scene-bottom"><span className="scene-source">{scenario.source === "sample" ? "Synthetic geometry" : "Input-based geometry"}</span>
        <div className="scene-controls">
          <button className={`icon-button ${layer === "light" ? "active" : ""}`} title="Site light layer" aria-label="Site light layer" onClick={() => setLayer(layer === "light" ? "structure" : "light")}><Sun size={17} /></button>
          <button className={`icon-button ${camera === "top" ? "active" : ""}`} title="Site top view" aria-label="Site top view" onClick={() => { setCamera(camera === "top" ? "perspective" : "top"); setRotate(false); }}><Layers3 size={17} /></button>
          <button className="icon-button" title={rotate ? "Pause site rotation" : "Rotate site twin"} aria-label={rotate ? "Pause site rotation" : "Rotate site twin"} onClick={() => setRotate(!rotate)}>{rotate ? <Pause size={17} /> : <Play size={17} />}</button>
          <button className="icon-button" title="Reset site camera" aria-label="Reset site camera" onClick={() => { setCamera("perspective"); setReset(reset + 1); }}><Focus size={17} /></button>
        </div>
      </div>
    </div>
    <div className="scene-strip"><span>{scenario.canopy_sqft} sq ft canopy</span><span>Placement is illustrative, not calculated.</span></div>
  </section>;
}
