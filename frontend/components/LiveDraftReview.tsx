"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { INPUT_RULES, type LiveDraft } from "../lib/live/types";

export default function LiveDraftReview({ draft, stale, disabled, onApply, onReject }: {
  draft: LiveDraft; stale: boolean; disabled: boolean;
  onApply: (draft: LiveDraft) => string | null; onReject: (id: string) => void;
}) {
  const [edited, setEdited] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  return <section className="live-draft" aria-label="Live draft review">
    <span className="eyebrow">AI SUGGESTION / REVIEW REQUIRED</span>
    <h3>Proposed workspace changes</h3>
    <p>{draft.reason}</p>
    {edited.inputs.map((entry, index) => {
      const rule = INPUT_RULES[entry.field];
      if (!rule) return <p key={index}>Unsupported input</p>;
      return <label className="field" key={entry.field}><span>{rule.label}</span><div className="input-wrap">
        {entry.field === "dimmable" ? <input aria-label={`Draft ${rule.label}`} type="checkbox" checked={entry.value === true} onChange={event => setEdited(previous => ({ ...previous, inputs: previous.inputs.map((item, i) => i === index ? { ...item, value: event.target.checked } : item) }))} /> : <input aria-label={`Draft ${rule.label}`} type="number" min={rule.min} max={rule.max} step={rule.integer ? 1 : "any"} value={typeof entry.value === "number" ? entry.value : ""} onChange={event => { const value = event.target.value === "" ? null : Number(event.target.value); setEdited(previous => ({ ...previous, inputs: previous.inputs.map((item, i) => i === index ? { ...item, value } : item) })); }} />}
        <span>{entry.unit}</span></div></label>;
    })}
    {edited.inventory.map((item, index) => <div className="live-inventory-draft" key={index}>
      <span>{item.operation} {item.asset_type?.replaceAll("_", " ") || "asset"}{item.id ? ` (${item.id.slice(0, 18)})` : ""}</span>
      {item.operation !== "remove" && <>
        <label className="field"><span>Name</span><input aria-label={`Draft asset ${index + 1} name`} maxLength={80} value={item.name || ""} onChange={event => setEdited(previous => ({ ...previous, inventory: previous.inventory.map((asset, i) => i === index ? { ...asset, name: event.target.value } : asset) }))} /></label>
        <label className="field"><span>Quantity</span><input aria-label={`Draft asset ${index + 1} quantity`} type="number" min={1} max={item.asset_type === "light_fixture" ? 100 : 1000} value={item.quantity ?? ""} onChange={event => setEdited(previous => ({ ...previous, inventory: previous.inventory.map((asset, i) => i === index ? { ...asset, quantity: Number(event.target.value) } : asset) }))} /></label>
      </>}
    </div>)}
    {stale && <p className="live-error">Workspace changed. Request a fresh draft.</p>}
    {error && <p role="alert" className="live-error">{error}</p>}
    <div className="live-draft-actions"><button className="primary-button" disabled={stale || disabled} onClick={() => setError(onApply(edited))}><Check size={14} />Apply draft</button><button className="icon-button" title="Reject draft" aria-label="Reject draft" disabled={disabled} onClick={() => onReject(draft.id)}><X size={17} /></button></div>
    <small>Applying a draft clears measurement confirmation. Review all inputs before running a comparison.</small>
  </section>;
}
