"use client";

import { useEffect, useState } from "react";

export function SiteNumber({ label, unit, value, onChange, min = 0, max = 1e9, step = "any", required = false }: {
  label: string; unit: string; value: number | null; onChange: (value: number | null) => void;
  min?: number; max?: number; step?: number | "any"; required?: boolean;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [error, setError] = useState(false);
  useEffect(() => { setText(value === null ? "" : String(value)); setError(false); }, [value]);
  function commit() {
    const next = text.trim() === "" ? null : Number(text);
    if ((next === null && required) || (next !== null && (!Number.isFinite(next) || next < min || next > max || (step !== "any" && Math.abs((next - min) / step - Math.round((next - min) / step)) > 1e-9)))) { setError(true); return; }
    setError(false);
    if (next !== value) onChange(next);
  }
  return <label className="field site-field"><span>{label}</span><div className="input-wrap">
    <input type="number" aria-label={label} min={min} max={max} step={step} required={required} placeholder="Unknown" value={text} aria-invalid={error}
      onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
    <span>{unit}</span></div>{error && <small role="alert">Enter a value from {min}{max === undefined ? " upward" : ` to ${max}`}.</small>}</label>;
}

export function SiteText({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <label className="field site-field"><span>{label}</span><div className="input-wrap"><input aria-label={label} value={text} maxLength={160}
    onChange={event => setText(event.target.value)} onBlur={() => { if (text !== value) onChange(text); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div></label>;
}
