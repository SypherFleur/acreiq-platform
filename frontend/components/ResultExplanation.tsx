"use client";

import { Download } from "lucide-react";
import type { SavedCalculation } from "../lib/live/design";
import type { RunEvidence } from "../lib/types";
import { candidateId, buildCandidateIdentityMetadata } from "../lib/candidate-identity";
import { exportInputRecords, inputOrigin, type InputRecords, type NumericScenarioField } from "../lib/input-records";
import type { LiveContext } from "../lib/live/types";
import "./result-explanation.css";

type Props = {
  saved: SavedCalculation | null | undefined;
  earlier: boolean;
  error?: string | null;
  inputRecords?: InputRecords;
  assumptions?: LiveContext["assumptions"];
};

const scopeLabels: Record<RunEvidence["formulas"][number]["scope"], string> = {
  baseline: "Baseline",
  selected: "Selected",
  savings: "Modeled difference",
};

const alternativeLabels: Record<RunEvidence["alternatives"][number]["kind"], string> = {
  selected: "Selected",
  rejected: "Rejected alternative",
  nearest_feasible: "Nearest feasible alternative",
};

const statusLabels = {
  optimized: "Optimized",
  needs_measurement: "Needs measurement",
  no_feasible_configuration: "No feasible configuration",
};

function value(value: number | boolean | string | null): string {
  return value === null ? "Not supplied" : String(value);
}

function ConstraintValue({ actual, passed }: { actual: number | null; passed: boolean | null }) {
  return <>
    <span>{actual === null ? "Not available" : String(actual)}</span>
    <span className={`why-result-check ${passed === null ? "" : passed ? "why-result-pass" : "why-result-fail"}`}>
      {passed === null ? "Not evaluated" : passed ? "Pass" : "Fail"}
    </span>
  </>;
}

export default function ResultExplanation({ saved, earlier, error, inputRecords, assumptions }: Props) {
  const run = saved?.result.run;
  if (!saved || !run) return null;

  const { evidence } = run;
  const { reference } = saved;

  function exportEvidence() {
    const url = URL.createObjectURL(new Blob([
      JSON.stringify({ ...run, workspace_version: reference, candidate_identity: buildCandidateIdentityMetadata(saved!.result),
        ...exportInputRecords(inputRecords, run!.input_snapshot), server_verification: "not_checked" }, null, 2),
    ], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `acreiq-run-${reference.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      // Keep the object URL alive until the browser has started the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  return <section className="why-result" aria-label="Why this result?" data-run-id={run.id}>
    <div className="why-result-heading">
      <h2>Why this result?</h2>
      <button type="button" className="why-result-export" onClick={exportEvidence}
        title="Export run evidence" aria-label="Export run evidence">
        <Download size={17} aria-hidden="true" />
      </button>
    </div>
    <p className="why-result-summary">{evidence.summary}</p>
    <div className="why-result-labels">
      <span className="why-result-badge">{run.source === "sample" ? "Sample-derived" : "User-entered scenario"}</span>
      <span className={earlier ? "why-result-earlier" : "why-result-current"}>{earlier ? "Earlier result: original inputs" : "Current result"}</span>
    </div>
    <p className="why-result-provenance">Local run evidence; server availability not checked. Input review is not independent measurement verification.</p>
    <dl className="why-result-metadata">
      <div><dt>Run ID</dt><dd><code>{run.id}</code></dd></div>
      <div><dt>Model</dt><dd>{run.model_version}</dd></div>
      <div><dt>Status</dt><dd>{statusLabels[run.status]}</dd></div>
      <div><dt>Recorded</dt><dd><time dateTime={run.created_at}>{run.created_at}</time></dd></div>
      <div><dt>Workspace revision</dt><dd>{reference.workspace_revision}</dd></div>
      <div><dt>Accepted revision</dt><dd>{reference.accepted_revision}</dd></div>
      <div><dt>Proposal ID</dt><dd>{reference.proposal_id === null ? "None" : <code>{reference.proposal_id}</code>}</dd></div>
      <div><dt>Proposal version</dt><dd>{reference.proposal_version ?? "None"}</dd></div>
    </dl>
    {error && <p className="why-result-error" role="alert">{error}</p>}

    <details className="why-result-details">
      <summary>Inputs and units</summary>
      <div className="why-result-body">
        <p className="why-result-horizon">Operating horizon: <strong>{evidence.horizon.operating_days} days</strong>
          {"; electricity rate: "}<strong>{evidence.horizon.electricity_usd_kwh} USD/kWh</strong></p>
        <div className="why-result-table-scroll" role="region" aria-label="Recorded inputs and units" tabIndex={0}>
          <table className="why-result-table why-result-inputs">
            <thead><tr><th scope="col">Input</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Provenance</th><th scope="col">Used for</th></tr></thead>
            <tbody>{evidence.inputs.map(input => <tr key={input.field}>
              <th scope="row"><code>{input.field}</code></th><td>{value(input.value)}</td><td>{input.unit}</td>
              <td>{typeof input.value === "number" || input.value === null
                ? { missing: "Unknown", "sample-assumption": "Synthetic assumption", assumption: "Assumption, not measurement", "user-entered": "User-entered", "user-recorded": "User-recorded; not independently verified" }[inputOrigin(input.field as NumericScenarioField, run.input_snapshot, inputRecords, assumptions)]
                : run.source === "sample" ? "Sample metadata" : "User-entered metadata"}</td><td>{input.used_for}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {inputRecords?.ppfd_full && inputOrigin("ppfd_full", run.input_snapshot, inputRecords, assumptions) === "user-recorded" && <p className="why-result-provenance">User-recorded PPFD: {inputRecords.ppfd_full.measured_on} · {inputRecords.ppfd_full.method}. {inputRecords.ppfd_full.note} Not independently verified.</p>}
      </div>
    </details>

    <details className="why-result-details">
      <summary>Calculations</summary>
      <div className="why-result-body">
        <ul className="why-result-formulas">
          {evidence.formulas.map((formula, index) => <li key={`${formula.scope}-${formula.metric}-${index}`}>
            <h3>{scopeLabels[formula.scope]}: {formula.metric.replaceAll("_", " ")}</h3>
            <code className="why-result-expression">{formula.expression}</code>
            <div className="why-result-calculation"><code>{formula.substituted}</code>
              <span className="why-result-reported">{" -> "}<strong>{formula.reported_value} {formula.unit}</strong></span>
            </div>
            <p className="why-result-rounding">Raw: {formula.raw_value}; reported to {formula.round_digits} decimal places</p>
          </li>)}
        </ul>
      </div>
    </details>

    <details className="why-result-details">
      <summary>Selection and alternatives</summary>
      <div className="why-result-body">
        <p>{evidence.objective}</p>
        <p>{evidence.selection_reason}</p>
        <dl className="why-result-counts">
          <div><dt>Evaluated</dt><dd>{evidence.configurations_evaluated}</dd></div>
          <div><dt>Feasible</dt><dd>{evidence.feasible_configurations}</dd></div>
        </dl>
        <div className="why-result-table-scroll" role="region" aria-label="Constraint checks" tabIndex={0}>
          <table className="why-result-table why-result-constraints">
            <thead><tr><th scope="col">Constraint</th><th scope="col">Unit</th><th scope="col">Minimum</th><th scope="col">Maximum</th><th scope="col">Baseline</th><th scope="col">Selected</th><th scope="col">Rejected configurations</th></tr></thead>
            <tbody>{evidence.constraints.map(constraint => <tr key={constraint.name}>
              <th scope="row">{constraint.name.replaceAll("_", " ")}<span className="why-result-check">{constraint.evaluated ? "Evaluated" : "Not evaluated"}</span></th>
              <td>{constraint.unit}</td><td>{constraint.minimum ?? "Not specified"}</td><td>{constraint.maximum ?? "Not specified"}</td>
              <td><ConstraintValue actual={constraint.baseline_value} passed={constraint.baseline_passed} /></td>
              <td><ConstraintValue actual={constraint.selected_value} passed={constraint.selected_passed} /></td>
              <td>{constraint.rejected_configurations}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {evidence.alternatives.length > 0 && <div className="why-result-table-scroll" role="region" aria-label="Actual alternatives" tabIndex={0}>
          <table className="why-result-table why-result-alternatives">
            <thead><tr><th scope="col">Alternative / Candidate ID</th><th scope="col">Hours/day</th><th scope="col">Dim fraction</th><th scope="col">Energy (kWh/day)</th><th scope="col">DLI (mol/m^2/day)</th><th scope="col">Modeled peak (W)</th><th scope="col">Constraint outcome</th></tr></thead>
            <tbody>{evidence.alternatives.map((alternative, index) => <tr key={`${alternative.kind}-${index}`}>
              <th scope="row">{alternativeLabels[alternative.kind]}<code className="why-result-check">{candidateId(alternative.candidate)}</code>{alternative.reason && <span className="why-result-check">{alternative.reason}</span>}</th>
              <td>{alternative.candidate.photoperiod_hours}</td><td>{alternative.candidate.dim_fraction}</td>
              <td>{alternative.candidate.daily_energy_kwh}</td><td>{alternative.candidate.dli_mol_m2_day ?? "Not available"}</td><td>{alternative.candidate.peak_modeled_watts}</td>
              <td><span className={alternative.candidate.feasible ? "why-result-pass" : "why-result-fail"}>{alternative.candidate.feasible ? "Feasible" : "Rejected"}</span>
                {alternative.candidate.rejected_for.length > 0 && <ul className="why-result-rejections">{alternative.candidate.rejected_for.map(reason => <li key={reason}>{reason}</li>)}</ul>}
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
      </div>
    </details>

    <details className="why-result-details">
      <summary>Assumptions and limitations</summary>
      <div className="why-result-body">
        {evidence.missing_inputs.length > 0 && <div>
          <h3>Missing inputs</h3>
          <ul className="why-result-list">{evidence.missing_inputs.map(input => <li key={input}><code>{input}</code></li>)}</ul>
        </div>}
        {evidence.assumptions.length > 0 && <div>
          <h3>Assumptions</h3>
          <ul className="why-result-list">{evidence.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
        </div>}
        {evidence.limitations.length > 0 && <div>
          <h3>Limitations</h3>
          <ul className="why-result-list">{evidence.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
        </div>}
      </div>
    </details>
  </section>;
}
