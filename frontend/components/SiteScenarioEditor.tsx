"use client";

import { Copy, Plus, Trash2 } from "lucide-react";
import type { SiteAsset, SiteCost } from "../lib/site-types";
import type { SitePlanDraft } from "../lib/site-drafts";
import { SiteNumber, SiteText } from "./SiteScenarioFields";

const categoryLabels: Record<SiteCost["category"], string> = {
  electricity: "Electricity", water: "Water", routine_labor: "Routine cash labor", consumables: "Consumables",
  maintenance: "Maintenance", new_equipment: "New equipment", setup_labor: "One-time setup labor", setup_materials: "Setup materials and fees",
};
const rateUnits = { kwh: "USD/kWh", liter: "USD/L", routine_hour: "USD/h", setup_hour: "USD/h", cycle: "USD/cycle", horizon: "USD/horizon" };
type SiteOperation = SitePlanDraft["operation"];
type SiteScenario = SitePlanDraft["scenarios"][number];

export default function SiteScenarioEditor({ request, scenarioId, onChange, onSelect, disabled, onBenchmark }: {
  request: SitePlanDraft; scenarioId: string; onChange: (next: SitePlanDraft, selectedId?: string) => void;
  onSelect: (id: string) => void; disabled: boolean; onBenchmark: () => void;
}) {
  const scenario = request.scenarios.find(item => item.id === scenarioId) ?? request.scenarios[0];
  const alter = (change: (next: SitePlanDraft) => string | void) => {
    const next = structuredClone(request); next.review = null; const selectedId = change(next); onChange(next, selectedId || undefined);
  };
  const setScenario = (patch: Partial<SiteScenario>) => alter(next => {
    next.scenarios = next.scenarios.map(item => item.id === scenario.id ? { ...item, ...patch,
      ...(patch.lighting ? { loads: item.loads.map(load => load.accounting === "lighting" ? { ...load, hours_per_day: patch.lighting!.hours_per_day, status: patch.lighting!.hours_per_day === null ? "unknown" : "known" } : load) } : {}),
      revision: item.revision + 1 } : item);
  });
  const setOperation = (patch: Partial<SiteOperation>) => alter(next => {
    next.operation = { ...next.operation, ...patch, revision: next.operation.revision + 1 };
    next.scenarios = next.scenarios.map(item => ({ ...item, operation_revision: next.operation.revision, revision: item.revision + 1 }));
  });
  const setAsset = (id: string, patch: Partial<SiteAsset>) => alter(next => {
    const asset = next.assets.find(item => item.id === id)!; Object.assign(asset, patch); asset.revision++;
    next.scenarios.forEach(item => { item.revision++; item.loads.forEach(load => { if (load.asset_id === id) load.asset_revision = asset.revision; }); });
  });
  const updateCost = (id: string, patch: Partial<SiteCost>) => setScenario({ costs: scenario.costs.map(item => item.id === id ? { ...item, ...patch, ...(patch.status === "known" ? { reason: null } : {}), version: item.version + 1 } : item) });
  const cloneScenario = () => alter(next => {
    const clone = structuredClone(scenario); clone.id = `scenario-${crypto.randomUUID()}`; clone.revision = 1; clone.role = "alternative";
    clone.name = `Alternative ${next.scenarios.length}`; clone.change_description = `Draft based on ${scenario.name}; conditional assumptions require review.`;
    if (clone.benchmark) clone.benchmark = { ...clone.benchmark, id: `benchmark-${crypto.randomUUID()}`, version: 1, scenario_id: clone.id };
    next.scenarios.push(clone); return clone.id;
  });
  const addAsset = () => alter(next => {
    const id = `asset-${crypto.randomUUID()}`;
    const asset: SiteAsset = { id, revision: 1, site_id: next.site.id, name: `Asset ${next.assets.length + 1}`, kind: "lighting", quantity: 1,
      ownership: "unknown", available: null, power_basis: "aggregate", watts: null, component_ids: [id], footprint_sqft: null,
      evidence: { id: `evidence-${crypto.randomUUID()}`, version: 1, source: next.site.evidence.source === "synthetic_fixture" ? "synthetic_fixture" : "user_assumption",
        entry_route: next.site.evidence.source === "synthetic_fixture" ? "sample" : "manual", note: "User-added asset record. Quantity and accounting require review; power and availability start unknown.", recorded_at: null, instrument: null, conditions: null, uncertainty: null } };
    next.assets.push(asset);
    next.scenarios.forEach(plan => { plan.revision++; plan.loads.push({ id: `load-${crypto.randomUUID()}`, asset_id: id, asset_revision: 1, component_ids: [id], accounting: "lighting", hours_per_day: plan.lighting.hours_per_day, status: plan.lighting.hours_per_day === null ? "unknown" : "known", reason: null }); });
  });
  return <fieldset className="site-editor" disabled={disabled} aria-label="Site plan inputs">
    <details className="site-disclosure" open>
      <summary>Site and existing assets <span>{request.site.length_ft ?? "?"} &times; {request.site.width_ft ?? "?"} ft · {request.assets.length} asset records</span></summary>
      <div className="site-fields">
        <SiteText label="Site name" value={request.site.name} onChange={name => alter(next => { next.site.name = name; })} />
        <SiteText label="Included growing space" value={request.site.included_spaces.join("; ")} onChange={value => alter(next => { next.site.included_spaces = value.split(";").map(item => item.trim()).filter(Boolean); next.site.revision++; next.site.boundary_revision++; next.scenarios.forEach(item => { item.site_revision = next.site.revision; item.revision++; }); })} />
        <SiteText label="Excluded spaces" value={request.site.excluded_spaces.join("; ")} onChange={value => alter(next => { next.site.excluded_spaces = value.split(";").map(item => item.trim()).filter(Boolean); next.site.revision++; next.site.boundary_revision++; next.scenarios.forEach(item => { item.site_revision = next.site.revision; item.revision++; }); })} />
        <SiteText label="Excluded costs" value={request.site.excluded_costs.join("; ")} onChange={value => alter(next => { next.site.excluded_costs = value.split(";").map(item => item.trim()).filter(Boolean); })} />
        {([['length_ft', 'Site length', 'ft'], ['width_ft', 'Site width', 'ft'], ['canopy_sqft', 'Usable canopy', 'sq ft']] as const).map(([key, label, unit]) => <SiteNumber key={key} label={label} unit={unit} min={0.000001} max={key === "canopy_sqft" ? 1e6 : 1000} value={request.site[key]} onChange={value => alter(next => {
          next.site[key] = value; next.site.revision++; next.site.boundary_revision++;
          next.scenarios.forEach(item => { item.site_revision = next.site.revision; item.revision++; });
        })} />)}
      </div>
      <div className="site-boundary"><strong>Included:</strong> {request.site.included_spaces.join("; ")}<br /><strong>Outside the boundary:</strong> {request.site.excluded_spaces.join("; ")}</div>
      <button className="secondary-button" onClick={addAsset} disabled={disabled || request.assets.length >= 64}><Plus size={15} />Add asset</button>
      {request.assets.map(asset => <details key={asset.id} className="site-asset-row">
        <summary><span>{asset.name}</span><small>{asset.quantity} · {asset.ownership} · {asset.watts ?? "unknown"} W {asset.power_basis === "aggregate" ? "combined" : "each"}</small></summary>
        <div className="site-fields">
          <SiteText label={`${asset.name} name`} value={asset.name} onChange={name => setAsset(asset.id, { name })} />
          <SiteNumber label={`${asset.name} quantity`} unit="units" value={asset.quantity} min={1} max={100} step={1} required onChange={quantity => { if (quantity !== null) setAsset(asset.id, { quantity }); }} />
          <SiteNumber label={`${asset.name} power`} unit="W" max={1e6} value={asset.watts} onChange={watts => setAsset(asset.id, { watts })} />
          <label className="field"><span>Power basis</span><select aria-label={`${asset.name} power basis`} value={asset.power_basis} onChange={event => setAsset(asset.id, { power_basis: event.target.value as SiteAsset["power_basis"] })}><option value="aggregate">Combined total, all units</option><option value="per_unit">Per unit</option></select></label>
          <label className="field"><span>Ownership</span><select aria-label={`${asset.name} ownership`} value={asset.ownership} onChange={event => setAsset(asset.id, { ownership: event.target.value as SiteAsset["ownership"] })}><option value="owned">Already owned</option><option value="proposed">New acquisition</option><option value="unknown">Unknown</option></select></label>
          <label className="field"><span>Available</span><select aria-label={`${asset.name} availability`} value={asset.available === null ? "unknown" : String(asset.available)} onChange={event => setAsset(asset.id, { available: event.target.value === "unknown" ? null : event.target.value === "true" })}><option value="true">Available</option><option value="false">Unavailable</option><option value="unknown">Unknown</option></select></label>
          <label className="field"><span>Load accounting in this plan</span><select aria-label={`${asset.name} accounting`} value={scenario.loads.find(load => load.asset_id === asset.id)?.accounting ?? "external"} onChange={event => {
            const accounting = event.target.value as SiteScenario["loads"][number]["accounting"];
            setScenario({ loads: scenario.loads.map(load => load.asset_id === asset.id ? { ...load, accounting,
              hours_per_day: accounting === "lighting" ? scenario.lighting.hours_per_day : accounting === "unpowered" ? 0 : null,
              status: accounting === "unpowered" || (accounting === "lighting" && scenario.lighting.hours_per_day !== null) ? "known" : "unknown" } : load) });
          }}><option value="lighting">Lighting module: fixtures</option><option value="module_other">Lighting module: other load</option><option value="external">Additional load</option><option value="unpowered">Unpowered asset</option></select></label>
        </div><p className="site-note">{asset.evidence.source.replaceAll("_", " ")}; footprint {asset.footprint_sqft === null ? "unknown" : `${asset.footprint_sqft} sq ft`}. Equipment position is not evaluated.</p>
        <button className="site-text-button" onClick={() => alter(next => { next.assets = next.assets.filter(item => item.id !== asset.id); next.scenarios.forEach(plan => { plan.revision++; plan.loads = plan.loads.filter(load => load.asset_id !== asset.id); plan.costs = plan.costs.map(cost => ({ ...cost, asset_ids: cost.asset_ids.filter(id => id !== asset.id) })); }); })}><Trash2 size={14} />Remove asset</button>
      </details>)}
    </details>
    <details className="site-disclosure">
      <summary>Operation and common conditions <span>{request.operation.crop || "Crop unknown"} · {request.operation.horizon_days ?? "Unknown"} days</span></summary>
      <div className="site-fields">
        <SiteText label="Crop" value={request.operation.crop ?? ""} onChange={crop => setOperation({ crop: crop || null })} />
        <SiteText label="Cultivar" value={request.operation.cultivar ?? ""} onChange={cultivar => setOperation({ cultivar: cultivar || null })} />
        <SiteText label="Production method" value={request.operation.method ?? ""} onChange={method => setOperation({ method: method || null })} />
        <SiteText label="Starting stage" value={request.operation.start_stage ?? ""} onChange={start_stage => setOperation({ start_stage: start_stage || null })} />
        <SiteText label="Harvest stage" value={request.operation.end_stage ?? ""} onChange={end_stage => setOperation({ end_stage: end_stage || null })} />
        <SiteText label="Marketable product definition" value={request.operation.product_definition} onChange={product_definition => setOperation({ product_definition })} />
        <SiteNumber label="Operating horizon" unit="days" value={request.operation.horizon_days} min={1} max={366} step={1} onChange={horizon_days => setOperation({ horizon_days })} />
        <SiteNumber label="Cycle duration" unit="days" value={request.operation.cycle_days} min={1} max={366} step={1} onChange={cycle_days => setOperation({ cycle_days })} />
        <SiteNumber label="Complete cycles" unit="cycles" value={request.operation.completed_cycles} min={1} max={366} step={1} onChange={completed_cycles => setOperation({ completed_cycles })} />
        <SiteNumber label="Turnover per cycle" unit="days" value={request.operation.turnover_days} max={366} step={1} onChange={turnover_days => setOperation({ turnover_days })} />
        <SiteNumber label="Idle time" unit="days" value={request.operation.idle_days} max={366} step={1} onChange={idle_days => setOperation({ idle_days })} />
        <label className="site-check"><input type="checkbox" checked={request.operation.identical_cycles} onChange={event => setOperation({ identical_cycles: event.target.checked })} />Identical operating conditions for each completed cycle</label>
        <SiteNumber label="Starts per cycle" unit="plants" value={request.operation.starts_per_cycle} min={1} max={1e6} step={1} onChange={starts_per_cycle => setOperation({ starts_per_cycle })} />
        <SiteNumber label="Temperature" unit="°C" value={request.operation.temperature_c} min={-20} max={60} onChange={temperature_c => setOperation({ temperature_c })} />
        <SiteNumber label="Relative humidity" unit="%" value={request.operation.humidity_pct} max={100} onChange={humidity_pct => setOperation({ humidity_pct })} />
        <SiteNumber label="Carbon dioxide" unit="ppm" max={10000} value={request.operation.co2_ppm} onChange={co2_ppm => setOperation({ co2_ppm })} />
        <SiteNumber label="Nutrient pH" unit="pH" value={request.operation.ph} max={14} onChange={ph => setOperation({ ph })} />
        <SiteNumber label="Electrical conductivity" unit="mS/cm" max={100} value={request.operation.ec_ms_cm} onChange={ec_ms_cm => setOperation({ ec_ms_cm })} />
        <SiteText label="Nutrient protocol" value={request.operation.nutrient_protocol ?? ""} onChange={nutrient_protocol => setOperation({ nutrient_protocol: nutrient_protocol || null, protocol_version: request.operation.protocol_version + 1 })} />
        <SiteText label="Operation assumption/source note" value={request.operation.evidence.note} onChange={note => setOperation({ evidence: { ...request.operation.evidence, note, version: request.operation.evidence.version + 1 } })} />
      </div>
      <p className="site-note">{request.operation.start_stage} to {request.operation.end_stage}. {request.operation.product_definition}. Complete harvests only; no prorated output. These conditions are inputs, not climate predictions.</p>
    </details>
    <section className="site-plan-edit" aria-label="Selected operating plan">
      <div className="site-section-heading"><h3>Operating plans</h3><button className="icon-button" title="Duplicate selected plan" aria-label="Duplicate selected plan" disabled={request.scenarios.length >= 5} onClick={cloneScenario}><Copy size={17} /></button></div>
      <div className="site-plan-tabs" role="tablist" aria-label="Editable operating plans">
        {request.scenarios.map(item => <button type="button" role="tab" aria-selected={item.id === scenario.id} key={item.id} className={item.id === scenario.id ? "selected" : ""} onClick={() => onSelect(item.id)}>{item.name}<small>{item.role === "current" ? "Current operation" : "Alternative"}</small></button>)}
      </div>
      <div className="site-fields">
        <SiteText label="Plan name" value={scenario.name} onChange={name => setScenario({ name })} />
        <SiteNumber label="Lighting schedule" unit="h/day" value={scenario.lighting.hours_per_day} min={0.000001} max={24} onChange={hours_per_day => setScenario({ lighting: { ...scenario.lighting, hours_per_day } })} />
        <SiteNumber label="Light output fraction" unit="0-1" value={scenario.lighting.dim_fraction} min={0.000001} max={1} onChange={dim_fraction => setScenario({ lighting: { ...scenario.lighting, dim_fraction } })} />
        <SiteNumber label="Minimum lighting schedule" unit="h/day" value={scenario.lighting.min_hours} min={0.000001} max={24} onChange={min_hours => setScenario({ lighting: { ...scenario.lighting, min_hours } })} />
        <SiteNumber label="Maximum lighting schedule" unit="h/day" value={scenario.lighting.max_hours} min={0.000001} max={24} onChange={max_hours => setScenario({ lighting: { ...scenario.lighting, max_hours } })} />
        <SiteNumber label="Modeled power limit" unit="W" value={scenario.lighting.power_limit_watts} min={0.000001} max={2e6} onChange={power_limit_watts => setScenario({ lighting: { ...scenario.lighting, power_limit_watts } })} />
        <SiteNumber label="Plan PPFD" unit="µmol/m²/s" value={scenario.lighting.ppfd_full} min={0.000001} max={5000} onChange={ppfd_full => setScenario({ lighting: { ...scenario.lighting, ppfd_full } })} />
        <SiteNumber label="Required daily light integral" unit="mol/m²/day" value={scenario.lighting.min_dli} min={0.000001} max={100} onChange={min_dli => setScenario({ lighting: { ...scenario.lighting, min_dli } })} />
        <SiteText label="PPFD basis" value={scenario.lighting.ppfd_basis ?? ""} onChange={ppfd_basis => setScenario({ lighting: { ...scenario.lighting, ppfd_basis: ppfd_basis || null } })} />
        <SiteNumber label="Water use" unit="L/day" value={scenario.water_liters_day} onChange={water_liters_day => setScenario({ water_liters_day })} />
        <SiteNumber label="Routine labor" unit="h/cycle" value={scenario.routine_labor_hours_cycle} onChange={routine_labor_hours_cycle => setScenario({ routine_labor_hours_cycle })} />
        <SiteNumber label="Setup labor" unit="h once" value={scenario.setup_labor_hours} onChange={setup_labor_hours => setScenario({ setup_labor_hours })} />
      </div>
      <SiteText label="Plan assumption/source note" value={scenario.evidence.note} onChange={note => setScenario({ evidence: { ...scenario.evidence, note, version: scenario.evidence.version + 1 } })} />
      <p className="site-note">{scenario.evidence.source.replaceAll("_", " ")}. Entering or reviewing a value does not verify a measurement.</p>
      <label className="site-check"><input type="checkbox" checked={scenario.lighting.dimmable} onChange={event => setScenario({ lighting: { ...scenario.lighting, dimmable: event.target.checked } })} />Fixtures support modeled dimming</label>
      <details className="site-disclosure">
        <summary>Load schedules <span>Each component counted once</span></summary>
        <div className="site-fields">{scenario.loads.filter(load => load.accounting !== "unpowered" && load.accounting !== "lighting").map(load => <SiteNumber key={load.id} label={`${request.assets.find(asset => asset.id === load.asset_id)?.name ?? load.asset_id} schedule`} unit="h/day" max={24} value={load.hours_per_day}
          onChange={hours_per_day => setScenario({ loads: scenario.loads.map(item => item.id === load.id ? { ...item, hours_per_day, status: hours_per_day === null ? "unknown" : "known" } : item) })} />)}</div>
        <p className="site-note">Assignments marked lighting module are included there; additional loads are added once. Peak demand assumes coincident operation; no startup surges or climate response are modeled.</p>
      </details>
      <details className="site-disclosure">
        <summary>Scoped cash costs <span>USD · unknown is not zero</span></summary>
        {scenario.costs.map(cost => <div className="site-cost-edit" key={cost.id}>
          <strong>{categoryLabels[cost.category]}</strong>
          <div className="site-fields"><label className="field"><span>Accounting status</span><select aria-label={`${categoryLabels[cost.category]} status`} value={cost.status} onChange={event => updateCost(cost.id, { status: event.target.value as SiteCost["status"], reason: event.target.value === "excluded" ? cost.reason ?? "Explicitly outside this comparison boundary" : cost.reason })}><option value="known">Known</option><option value="unknown">Unknown</option><option value="excluded">Explicitly excluded</option></select></label>
            <SiteNumber label={`${categoryLabels[cost.category]} ${cost.basis === "horizon" ? "amount" : "rate"}`} unit={rateUnits[cost.basis]} max={cost.category === "electricity" ? 10 : 1e9} value={cost.basis === "horizon" ? cost.amount : cost.rate} onChange={value => updateCost(cost.id, { [cost.basis === "horizon" ? "amount" : "rate"]: value, status: value === null ? "unknown" : "known" })} />
          </div>
          {cost.status !== "known" && <SiteText label={`${categoryLabels[cost.category]} reason`} value={cost.reason ?? ""} onChange={reason => updateCost(cost.id, { reason: reason || null })} />}
          {cost.category === "new_equipment" && request.assets.some(asset => asset.ownership === "proposed") && <div>{request.assets.filter(asset => asset.ownership === "proposed").map(asset => <label key={asset.id} className="site-check"><input type="checkbox" checked={cost.asset_ids.includes(asset.id)} onChange={event => updateCost(cost.id, { asset_ids: event.target.checked ? [...cost.asset_ids, asset.id] : cost.asset_ids.filter(id => id !== asset.id) })} />New equipment cost includes {asset.name}</label>)}</div>}
          <p className="site-note">{cost.evidence.note}</p>
        </div>)}
        <p className="site-note"><strong>Excluded costs:</strong> {request.site.excluded_costs.join("; ")}. Owned equipment is separate from new cash expenditure.</p>
      </details>
      <details className="site-disclosure">
        <summary>Conditional output benchmark <span>{scenario.benchmark?.kg_per_cycle ?? "Unknown"} kg/cycle</span></summary>
        <p className="site-note">A benchmark is a conditional input, not predicted yield. Changed conditions require an applicable benchmark; a DLI pass never establishes unchanged output.</p>
        {scenario.benchmark && <><code>{scenario.benchmark.id} / v{scenario.benchmark.version}</code><p className="site-note">{scenario.benchmark.evidence.note}</p><dl className="site-context">{Object.entries(scenario.benchmark.context).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "object" ? JSON.stringify(value) : String(value ?? "Unknown")}</dd></div>)}</dl></>}
        <button className="secondary-button" onClick={onBenchmark}><Plus size={15} />Create revised benchmark assumption</button>
      </details>
      {scenario.role === "alternative" && <button className="site-text-button" onClick={() => alter(next => { next.scenarios = next.scenarios.filter(item => item.id !== scenario.id); return next.scenarios[0].id; })}><Trash2 size={14} />Remove this draft alternative</button>}
    </section>
    <details className="site-disclosure">
      <summary>Resource limits <span>{request.limits.filter(limit => limit.enabled).length} active</span></summary>
      <p className="site-note">Site-wide requirements for every plan, separate from each plan's lighting-module inputs. Missing bounds remain not evaluated. Constraint-pass refers only to the enabled requirements, not whole-site feasibility.</p>
      {request.limits.map(limit => <div className="site-limit-edit" key={limit.id}>
        <label className="site-check"><input type="checkbox" checked={limit.enabled} onChange={event => alter(next => { const item = next.limits.find(item => item.id === limit.id)!; item.enabled = event.target.checked; item.version++; item.reason = event.target.checked ? null : "Disabled by user for this comparison"; })} />{limit.metric.replaceAll("_", " ")}</label>
        <div className="site-fields">{(["minimum", "maximum"] as const).map(bound => <SiteNumber key={bound} label={`${limit.metric.replaceAll("_", " ")} ${bound}`} unit={limit.unit} value={limit[bound]} onChange={value => alter(next => { const item = next.limits.find(item => item.id === limit.id)!; item[bound] = value; item.version++; })} />)}</div>
      </div>)}
    </details>
  </fieldset>;
}
