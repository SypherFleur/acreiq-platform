"use client";

import { ArrowRight, Check, GitCompareArrows, Layers2, Pencil, X } from "lucide-react";

type Props = {
  proposal: { id: string; version: number; base_revision: number; status: "review" | "revising"; reason: string };
  comparison: "current" | "proposed";
  onComparison: (value: "current" | "proposed") => void;
  changes: { label: string; before: string; after: string }[];
  sampleDerived: boolean;
  busy: boolean;
  error: string | null;
  onAction: (action: "approve" | "revise" | "discard") => void;
};

export default function ProposalReview({ proposal, comparison, onComparison, changes, sampleDerived, busy, error, onAction }: Props) {
  return <section className="proposal-review" aria-label="Proposed version review" aria-busy={busy} data-proposal-id={proposal.id} data-proposal-version={proposal.version}>
    <div className="proposal-heading">
      <div className="proposal-identity">
        <h2><Layers2 size={15} aria-hidden="true" />Proposed version <span>v{proposal.version}</span></h2>
        <span className="proposal-kind">Revised schematic</span>
        {sampleDerived && <span className="proposal-sample">Sample-derived</span>}
        {proposal.status === "revising" && <span className="proposal-status" role="status">Revising</span>}
      </div>
      <div className="proposal-comparison" role="group" aria-label="Design comparison">
        <GitCompareArrows size={15} aria-hidden="true" />
        <button type="button" aria-pressed={comparison === "current"} onClick={() => onComparison("current")} disabled={busy}>Current</button>
        <button type="button" aria-pressed={comparison === "proposed"} onClick={() => onComparison("proposed")} disabled={busy}>Proposed</button>
      </div>
    </div>
    <p className="proposal-reason">{proposal.reason}</p>
    {changes.length > 0 ? <dl className="proposal-changes" aria-label="Proposed changes">
      {changes.map((change, index) => <div className="proposal-change" key={`${change.label}-${index}`}>
        <dt>{change.label}</dt>
        <dd><span className="proposal-before"><span className="proposal-sr-only">Current: </span>{change.before}</span><ArrowRight size={13} aria-hidden="true" /><span className="proposal-after"><span className="proposal-sr-only">Proposed: </span>{change.after}</span></dd>
      </div>)}
    </dl> : <p className="proposal-unchanged">No input changes yet.</p>}
    <div className="proposal-footer">
      <span className="proposal-preserved">Accepted version unchanged</span>
      <div className="proposal-actions">
        <button type="button" className="primary-button" disabled={busy} onClick={() => onAction("approve")}><Check size={15} aria-hidden="true" />Use this version</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => onAction("revise")}><Pencil size={14} aria-hidden="true" />Revise</button>
        <button type="button" className="proposal-discard" disabled={busy} onClick={() => onAction("discard")}><X size={15} aria-hidden="true" />Discard</button>
      </div>
    </div>
    {error && <p className="proposal-error" role="alert">{error}</p>}
  </section>;
}
