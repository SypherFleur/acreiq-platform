"use client";

import { Check, ChevronRight, CircleHelp, X } from "lucide-react";
import type { SiteComparisonArtifact, SiteMetric, SiteMetricKey } from "../lib/site-types";

export const siteFormat = (value: number, digits = 2) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
export function SiteMetricValue({ metric, cash = false }: { metric: SiteMetric; cash?: boolean }) {
  const format = (amount: number) => cash ? amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : siteFormat(amount);
  return <><strong>{metric.value === null ? (metric.known_subtotal > 0 ? format(metric.known_subtotal) : "Unknown") : format(metric.value)}</strong>
    <small>{metric.value === null && metric.known_subtotal > 0 ? "known subtotal" : metric.unit}</small></>;
}
const statusText = { pass: "Constraint-pass", fail: "Constraint-fail", unknown: "Not fully evaluated" };
const columnMetrics: { key: SiteMetricKey; label: string; cash?: boolean }[] = [
  { key: "energy_kwh", label: "Energy" }, { key: "output_kg", label: "Conditional output" },
  { key: "new_setup_cash_usd", label: "New/setup cash", cash: true }, { key: "recurring_cash_usd", label: "Recurring cash", cash: true },
  { key: "horizon_cash_usd", label: "Horizon cash", cash: true },
];
const value = (item: unknown) => item === null ? "Unknown" : typeof item === "number" ? siteFormat(item, 6) : String(item);

export default function SiteComparisonResults({ artifact, selectedId, onSelect, earlier }: {
  artifact: SiteComparisonArtifact; selectedId: string; onSelect: (id: string) => void; earlier: boolean;
}) {
  const p = artifact.payload;
  const selected = p.evaluations.find(item => item.scenario_id === selectedId) ?? p.evaluations[0];
  const difference = p.differences.find(item => item.scenario_id === selected.scenario_id);
  return <section className="site-results" aria-label="Site comparison results" data-comparison-id={p.id}>
    <div className="site-section-heading"><div><h2>{earlier ? "Saved comparison" : "Operating plan comparison"}</h2><p>{p.input_snapshot.operation.horizon_days} days · USD · {p.scenario_count} scenarios · {p.feasible_count} constraint-pass</p></div>
      <span className="source-badge">{p.review_status === "reviewed" ? "Reviewed assumptions" : "Unreviewed"}</span></div>
    <div className="site-decision" role="region" aria-label="Comparison explanation"><strong>{p.preferred_scenario_ids.length ? `${p.preferred_scenario_ids.map(id => p.input_snapshot.scenarios.find(item => item.id === id)?.name ?? id).join(" and ")}${p.preferred_scenario_ids.length > 1 ? " tie" : " preferred"}` : "No eligible scenario"}</strong>
      <p>{p.explanation}</p>{p.comparison_incomplete && <p className="site-warning">Best among eligible scenarios only; the comparison is incomplete.</p>}</div>
    <div className="site-comparison-table"><table><thead><tr><th>Operating plan</th>{columnMetrics.map(column => <th key={column.key}>{column.label}</th>)}<th>Feasibility</th></tr></thead>
      <tbody>{p.evaluations.map(evaluation => {
        const rank = p.ranks.find(item => item.scenario_id === evaluation.scenario_id);
        return <tr key={evaluation.id} data-scenario-id={evaluation.scenario_id} className={`${selected.scenario_id === evaluation.scenario_id ? "site-selected" : ""} ${p.preferred_scenario_ids.includes(evaluation.scenario_id) ? "site-preferred" : ""}`}>
          <td><button className="site-scenario-select" aria-label={`Inspect ${evaluation.snapshot.scenario.name}`} aria-pressed={selected.scenario_id === evaluation.scenario_id} onClick={() => onSelect(evaluation.scenario_id)}><strong>{evaluation.snapshot.scenario.name}</strong><ChevronRight size={15} /></button>
            <small>{evaluation.snapshot.scenario.role === "current" ? "Current" : "Alternative"} · {evaluation.requested_setting.hours} h/day</small>
            {rank?.rank !== null && rank?.rank !== undefined && <small className="green-text">Rank {rank.rank}{p.preferred_scenario_ids.includes(evaluation.scenario_id) ? " · Preferred" : ""}</small>}</td>
          {columnMetrics.map(column => <td key={column.key} data-label={column.label} data-metric={column.key}><SiteMetricValue metric={evaluation.metrics[column.key]} cash={column.cash} /></td>)}
          <td data-label="Feasibility"><span className={`site-status ${evaluation.feasibility}`}>{evaluation.feasibility === "pass" ? <Check size={13} /> : evaluation.feasibility === "fail" ? <X size={13} /> : <CircleHelp size={13} />}{statusText[evaluation.feasibility]}</span>
            {rank && !rank.eligible && <small className="site-reason">{rank.reasons.join(" ")}</small>}</td>
        </tr>;
      })}</tbody></table></div>
    <p className="site-note">Conditional output uses scenario-specific benchmarks, not predicted yield. Cash covers the stated boundary only. Unknown inputs are never zero-cost assumptions.</p>
    <section className="site-explanation" aria-label="Why this site result?" data-evaluation-id={selected.id}>
      <div className="site-section-heading"><h3>Why this result? {selected.snapshot.scenario.name}</h3><span className={`site-status ${selected.applicability.status}`}>Benchmark {selected.applicability.status}</span></div>
      <p>{selected.explanation}</p>
      <div className="site-differences">{([['energy_kwh', 'kWh', 'electricity'], ['output_kg', 'kg', 'conditional output'], ['horizon_cash_usd', 'USD', 'horizon cash']] as const).map(([key, unit, label]) => {
        const delta = difference?.metrics[key];
        return <div key={key}><span>{label} vs current</span><strong>{delta === null || delta === undefined ? "Unknown" : delta === 0 ? "No change" : `${siteFormat(Math.abs(delta), 3)} ${unit} ${delta < 0 ? "less" : "more"}`}</strong></div>;
      })}</div>
      <p className="site-note">Signed differences in evidence use scenario minus current. Lower output is not a saving. Raw values determine ranking; rounding is display-only.</p>
      <details className="site-disclosure" open={selected.feasibility !== "pass"} key={`${selected.id}-constraints`}><summary>Constraint outcomes <span>{selected.constraints.filter(item => item.status === "fail").length} fail · {selected.constraints.filter(item => item.status === "unknown").length} unknown</span></summary>
        <div className="site-constraint-list">{selected.constraints.map(constraint => <div key={constraint.id}><span className={`site-status ${constraint.status}`}>{constraint.status.replaceAll("_", " ")}</span><strong>{constraint.metric.replaceAll("_", " ")}</strong><p>{constraint.reason}</p><small>{value(constraint.value)} {constraint.unit}; {constraint.minimum === null ? "no minimum" : `minimum ${value(constraint.minimum)}`}; {constraint.maximum === null ? "no maximum" : `maximum ${value(constraint.maximum)}`}</small></div>)}</div>
      </details>
      <details className="site-disclosure"><summary>Energy and cash ledgers <span>Included, unknown and excluded</span></summary>
        <div className="table-scroll"><table><thead><tr><th>Line</th><th>Quantity</th><th>Rate</th><th>Value</th><th>Status / reason</th></tr></thead><tbody>{[...selected.usage_lines, ...selected.cost_lines].map((line, index) => <tr key={`${line.id}-${index}`}><td>{line.category.replaceAll("_", " ")}<small><code>{line.id}</code></small></td><td>{value(line.quantity)}</td><td>{value(line.rate)}</td><td>{value(line.value)} {line.unit}</td><td>{line.status}<small>{line.reason}</small></td></tr>)}</tbody></table></div>
      </details>
      <details className="site-disclosure"><summary>Benchmark applicability <span>{selected.applicability.status}</span></summary>
        <p className="site-note">{selected.applicability.reasons.join(" ") || "Exact entered conditions match this benchmark. This is conditional bookkeeping, not crop-model validation."}</p>
        <code>{selected.snapshot.scenario.benchmark?.id ?? "No benchmark"} / v{selected.snapshot.scenario.benchmark?.version ?? "?"}</code>
        <div className="table-scroll"><table><thead><tr><th>Condition</th><th>Benchmark requires</th><th>This run used</th><th>Status</th></tr></thead><tbody>{selected.applicability.checks.map(check => <tr key={check.path}><td>{check.path}</td><td>{typeof check.expected === "object" ? JSON.stringify(check.expected) : value(check.expected)}</td><td>{typeof check.actual === "object" ? JSON.stringify(check.actual) : value(check.actual)}</td><td>{check.status}</td></tr>)}</tbody></table></div>
      </details>
      <details className="site-disclosure"><summary>Formulas and exact-run evidence <span>{selected.formulas.length} expressions</span></summary>
        <dl className="site-identities"><div><dt>Comparison</dt><dd><code>{p.id}</code></dd></div><div><dt>Evaluation</dt><dd><code>{selected.id}</code></dd></div><div><dt>Recorded</dt><dd>{new Date(selected.created_at).toLocaleString()}</dd></div><div><dt>Models</dt><dd>{p.accounting_version}; {p.benchmark_version}; {p.lighting_model_version}</dd></div><div><dt>Exact snapshot digest</dt><dd><code>{artifact.sha256}</code></dd></div></dl>
        {selected.formulas.map(formula => <div className="site-formula" key={formula.id}><strong>{formula.metric.replaceAll("_", " ")}</strong><code>{formula.expression}</code><pre>{JSON.stringify(formula.operands, null, 2)}</pre><span>{value(formula.raw_value)} {formula.unit} raw</span></div>)}
        <p className="site-note">Lighting module: {selected.module_status}. Requested setting {selected.requested_setting.candidate_id}. {selected.module_result ? `${selected.module_result.configurations_evaluated} internal settings tested, ${selected.module_result.feasible_configurations} feasible. Its optimum was not substituted for this operating plan. Full candidates are in the JSON and CSV bundle.` : "No complete module run; available arithmetic is identified separately."}</p>
      </details>
      <details className="site-disclosure"><summary>Missing inputs and limitations</summary><ul>{[...selected.missing_inputs, ...selected.limitations, ...p.limitations].map((text, index) => <li key={index}>{text}</li>)}</ul></details>
    </section>
  </section>;
}
