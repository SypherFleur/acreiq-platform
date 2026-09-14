"use client";

import { useId, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import {
  createPPFDRecord, ppfdContextFingerprint, PPFD_RECORD_UNIT, validInputRecords,
  type InputRecord, type InputRecords,
} from "../lib/input-records";
import type { Scenario } from "../lib/types";
import "./measurement-record.css";

export type MeasurementRecordProps = {
  scenario: Scenario;
  records: InputRecords | undefined;
  disabled?: boolean;
  onChange: (records: InputRecords) => void;
};

function RecordEditor({ scenario, record, hasRecord, disabled, onChange }: Omit<MeasurementRecordProps, "records"> & {
  record: InputRecord | undefined;
  hasRecord: boolean;
}) {
  const id = useId();
  const [measuredOn, setMeasuredOn] = useState(record?.measured_on ?? "");
  const [method, setMethod] = useState(record?.method ?? "");
  const [note, setNote] = useState(record?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const reason = scenario.source === "sample" ? "Sample values remain assumptions."
    : scenario.source !== "manual" && scenario.source !== "photo-assisted" ? "A manual or photo-assisted scenario is required."
    : typeof scenario.ppfd_full !== "number" || !Number.isFinite(scenario.ppfd_full) || scenario.ppfd_full <= 0
      ? "A positive PPFD input is needed before adding a record."
      : ppfdContextFingerprint(scenario) === null ? "Room, canopy and lighting inputs are needed before adding a record." : null;

  function save() {
    if (disabled || reason) return;
    const next = createPPFDRecord(scenario, { measured_on: measuredOn, method: method.trim(), note: note.trim() });
    if (!next) {
      setError("Enter a valid measurement date and a method or instrument (up to 300 characters). Notes may contain up to 2,000 characters.");
      return;
    }
    setError(null);
    onChange({ ppfd_full: next });
  }

  return <div className="measurement-record-body">
    <p id={`${id}-provenance`}>User-recorded provenance only; not independently verified.</p>
    {hasRecord && !record && <p className="measurement-record-stale" role="status">Saved record no longer matches these inputs. A new record is needed.</p>}
    {reason ? <p>{reason}</p> : <>
      <p className="measurement-record-value">PPFD at full output: <strong>{scenario.ppfd_full} {PPFD_RECORD_UNIT}</strong></p>
      <fieldset className="measurement-record-fields" disabled={disabled} aria-label="PPFD record details" aria-describedby={`${id}-provenance`}>
        <label className="field">
          <span>Measurement date</span>
          <div className="input-wrap"><input type="date" aria-required="true" value={measuredOn}
            onChange={event => { setMeasuredOn(event.target.value); setError(null); }} /></div>
        </label>
        <label className="field">
          <span>Method / instrument</span>
          <div className="input-wrap"><input type="text" aria-required="true" maxLength={300} value={method}
            onChange={event => { setMethod(event.target.value); setError(null); }} /></div>
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <textarea rows={3} maxLength={2000} value={note} onChange={event => { setNote(event.target.value); setError(null); }} />
        </label>
        <div className="measurement-record-actions">
          <button type="button" onClick={save} disabled={disabled}><Save size={14} aria-hidden="true" />{record ? "Update record" : "Save record"}</button>
        </div>
      </fieldset>
    </>}
    {record && <p className="measurement-record-time">Recorded: <time dateTime={record.recorded_at}>{record.recorded_at}</time></p>}
    {hasRecord && <div className="measurement-record-actions">
      <button type="button" className="measurement-record-remove" disabled={disabled} title="Remove PPFD record" aria-label="Remove PPFD record"
        onClick={() => { if (!disabled) onChange({}); }}><Trash2 size={16} aria-hidden="true" /></button>
    </div>}
    {error && <p className="measurement-record-error" role="alert">{error}</p>}
  </div>;
}

export default function MeasurementRecord({ scenario, records, disabled = false, onChange }: MeasurementRecordProps) {
  const record = validInputRecords(records, scenario) ? records.ppfd_full : undefined;
  // Context changes reset unsaved metadata so an old draft cannot attest to new inputs.
  const editorKey = JSON.stringify([scenario.source, scenario.ppfd_full, ppfdContextFingerprint(scenario), record ?? null]);
  return <details className="measurement-record">
    <summary>PPFD record (optional){record && <span>User-recorded</span>}</summary>
    <RecordEditor key={editorKey} scenario={scenario} record={record} hasRecord={!!records?.ppfd_full}
      disabled={disabled} onChange={onChange} />
  </details>;
}
