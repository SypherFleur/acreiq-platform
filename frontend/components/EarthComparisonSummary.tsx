"use client";

import type { SiteComparisonArtifact } from "../lib/site-types";
import { SiteMetricValue } from "./SiteComparisonResults";

const goals = { output_kg: "Maximize conditional output", energy_kwh: "Minimize energy", recurring_cash_usd: "Minimize recurring cash", horizon_cash_usd: "Minimize horizon cash", horizon_cash_per_kg: "Minimize horizon cash per kg" };
export default function EarthComparisonSummary({ artifact, scenarioId }: { artifact: SiteComparisonArtifact; scenarioId?: string | null }) {
  const p = artifact.payload;
  const evaluation = p.evaluations.find(item => item.scenario_id === scenarioId)
    ?? p.evaluations.find(item => p.preferred_scenario_ids.includes(item.scenario_id)) ?? p.evaluations[0];
  return <section className="earth-comparison-summary" aria-label="Earth selected comparison" data-comparison-id={p.id}>
    <h3>Saved plan comparison</h3>
    <strong>{p.input_snapshot.site.name}</strong>
    <p>{goals[p.input_snapshot.goal.metric]}</p>
    <strong>{evaluation.snapshot.scenario.name}</strong>
    <p>{p.input_snapshot.operation.horizon_days} days · Indoor leafy greens</p>
    <dl>{([
      ["energy_kwh", "Energy", false], ["output_kg", "Conditional output", false], ["water_liters", "Water", false],
      ["new_setup_cash_usd", "New/setup cash", true], ["recurring_cash_usd", "Recurring cash", true], ["horizon_cash_usd", "Horizon cash", true],
    ] as const).map(([key, label, cash]) => <div key={key} data-metric={key}><dt>{label}</dt><dd><SiteMetricValue metric={evaluation.metrics[key]} cash={cash} /></dd></div>)}</dl>
    <p className={`site-status ${evaluation.feasibility}`}>{evaluation.feasibility === "pass" ? "Constraint-pass" : evaluation.feasibility === "fail" ? "Constraint-fail" : "Not fully evaluated"}</p>
    <p>{evaluation.provenance === "synthetic_fixture" ? "Synthetic / sample-derived evidence." : "User-defined conditional assumptions."} Saved inputs, not map-derived measurements.</p>
    <details><summary>Comparison evidence</summary><p>{p.explanation}</p><code>{p.id}</code><p>{new Date(p.created_at).toLocaleString()} · Local saved artifact; not server verification.</p></details>
  </section>;
}
