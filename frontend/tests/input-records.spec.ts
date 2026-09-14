import { expect, test } from "@playwright/test";
import {
  createPPFDRecord, inputOrigin, ppfdContextFingerprint, PPFD_RECORD_UNIT, validInputRecords,
  type InputRecord, type InputRecords, type NumericScenarioField, type PPFDRecordContext,
} from "../lib/input-records";
import type { Scenario } from "../lib/types";

const scenario: Scenario = {
  source: "manual", length_ft: 8, width_ft: 8, canopy_sqft: 32, light_count: 2,
  lighting_watts: 600, other_watts: 45, other_hours: 24, baseline_hours: 16,
  baseline_dim: 1, dimmable: false, ppfd_full: 350, min_dli: 15, min_hours: 10,
  max_hours: 18, power_limit_watts: 1800, electricity_usd_kwh: 0.15,
  operating_days: 365, water_liters_day: null, confirmed: false,
};
const details = { measured_on: "2026-09-12", method: "Handheld meter; canopy grid at full output", note: "User-entered log" };
const recordedAt = "2026-09-13T02:03:04.000Z";
function recordFor(input: Scenario = scenario): InputRecord {
  const record = createPPFDRecord(input, details, recordedAt);
  expect(record).not.toBeNull();
  return record!;
}

test("manual values stay user-entered regardless of review confirmation", () => {
  for (const confirmed of [false, true]) {
    const input = { ...scenario, confirmed };
    for (const [field, value] of Object.entries(input)) {
      if (typeof value === "number") expect(inputOrigin(field as NumericScenarioField, input, undefined)).toBe("user-entered");
    }
    expect(inputOrigin("water_liters_day", input, undefined)).toBe("missing");
  }
  expect(inputOrigin("ppfd_full", { ...scenario, source: "photo-assisted" }, undefined)).toBe("user-entered");
  expect(inputOrigin("other_watts", { ...scenario, other_watts: 0 }, undefined)).toBe("user-entered");
});

test("sample and explicit assumptions cannot acquire measurement status", () => {
  const records = { ppfd_full: recordFor() };
  const sample = { ...scenario, source: "sample" as const, confirmed: true };
  expect(createPPFDRecord(sample, details, recordedAt)).toBeNull();
  expect(validInputRecords(records, sample)).toBe(false);
  for (const [field, value] of Object.entries(sample)) {
    if (typeof value === "number") expect(inputOrigin(field as NumericScenarioField, sample, records)).toBe("sample-assumption");
  }
  const assumptions = { ppfd_full: { label: "Estimate", source: "User assumption", growth_stage: "Unknown" } };
  expect(inputOrigin("ppfd_full", scenario, records, assumptions)).toBe("assumption");
  expect(inputOrigin("ppfd_full", scenario, records, {})).toBe("user-recorded");
});

test("manual and photo records snapshot existing inputs without mutation or verification", () => {
  for (const source of ["manual", "photo-assisted"] as const) {
    const input = Object.freeze({ ...scenario, source });
    const before = structuredClone(input);
    const record = recordFor(input);
    expect(record).toEqual({
      kind: "user-recorded", source, value: 350, unit: PPFD_RECORD_UNIT,
      ...details, recorded_at: recordedAt,
      context: { length_ft: 8, width_ft: 8, canopy_sqft: 32, lighting_watts: 600, light_count: 2 },
      context_fingerprint: ppfdContextFingerprint(input),
    });
    expect(validInputRecords(JSON.parse(JSON.stringify({ ppfd_full: record })), input)).toBe(true);
    expect(inputOrigin("ppfd_full", input, { ppfd_full: record })).toBe("user-recorded");
    expect(input).toEqual(before);
    expect(input.confirmed).toBe(false);
    expect(record).not.toHaveProperty("verified");
  }
});

test("missing, zero, negative and non-finite PPFD cannot be recorded", () => {
  for (const ppfd_full of [null, 0, -1, NaN, Infinity, -Infinity]) {
    const input = { ...scenario, ppfd_full };
    expect(createPPFDRecord(input, details, recordedAt)).toBeNull();
    expect(validInputRecords({ ppfd_full: recordFor() }, input)).toBe(false);
    expect(inputOrigin("ppfd_full", input, undefined)).toBe("missing");
  }
});

test("every room, canopy and lighting context change invalidates the original record", () => {
  const records = { ppfd_full: recordFor() };
  const before = structuredClone(records);
  const changes: Partial<Scenario>[] = [
    { ppfd_full: 351 }, { length_ft: 9 }, { width_ft: 9 }, { canopy_sqft: 31 },
    { lighting_watts: 601 }, { light_count: 3 }, { source: "photo-assisted" },
  ];
  for (const change of changes) {
    const input = { ...scenario, ...change };
    expect(validInputRecords(records, input)).toBe(false);
    expect(inputOrigin("ppfd_full", input, records)).toBe("user-entered");
  }
  expect(records).toEqual(before);
});

test("unrelated operating inputs and confirmation do not change full-output PPFD provenance", () => {
  const input = { ...scenario, confirmed: true, baseline_dim: 0.8, baseline_hours: 14, electricity_usd_kwh: 0.2, min_dli: 16, water_liters_day: 2 };
  expect(validInputRecords({ ppfd_full: recordFor() }, input)).toBe(true);
  expect(ppfdContextFingerprint(input)).toBe(ppfdContextFingerprint(scenario));
});

test("incomplete context cannot generate a record or a fingerprint", () => {
  const fields: (keyof PPFDRecordContext)[] = ["length_ft", "width_ft", "canopy_sqft", "lighting_watts", "light_count"];
  for (const field of fields) {
    for (const value of [0, -1, NaN, Infinity]) {
      const input = { ...scenario, [field]: value };
      expect(ppfdContextFingerprint(input)).toBeNull();
      expect(createPPFDRecord(input, details, recordedAt)).toBeNull();
    }
  }
  expect(createPPFDRecord({ ...scenario, light_count: 1.5 }, details, recordedAt)).toBeNull();
});

test("validator rejects malformed records, mismatched units and unsupported fields", () => {
  const record = recordFor();
  const invalid = [
    undefined, null, [], "record", 350, new Date(), { ppfd_full: undefined },
    { ppfd_full: null }, { ppfd_full: [] }, { ppfd_full: {} },
    { min_dli: record }, { ppfd_full: record, confirmed: true },
    ...[
      { kind: "verified" }, { verified: true }, { source: "sample" }, { value: "350" },
      { value: 351 }, { unit: "lux" }, { unit: "umol/m^2/s" }, { method: "   " },
      { method: "x".repeat(301) }, { method: 123 }, { note: null }, { note: "x".repeat(2001) },
      { measured_on: "" }, { measured_on: "2026-02-30" }, { measured_on: "2026-13-01" },
      { measured_on: "2026-9-12" }, { measured_on: "2026-09-12T00:00:00Z" },
      { recorded_at: "" }, { recorded_at: "2026-09-13" }, { recorded_at: "2026-02-30T02:03:04.000Z" },
      { recorded_at: "2026-09-13T25:03:04.000Z" }, { context: null },
      { context: { ...record.context, light_count: 3 } },
      { context: { ...record.context, lighting_watts: "600" } },
      { context: { ...record.context, extra: true } }, { context_fingerprint: "stale" },
    ].map(change => ({ ppfd_full: { ...record, ...change } })),
  ];
  for (const input of invalid) expect(validInputRecords(input, scenario)).toBe(false);
  for (const field of Object.keys(record)) {
    const incomplete: Record<string, unknown> = { ...record };
    delete incomplete[field];
    expect(validInputRecords({ ppfd_full: incomplete }, scenario)).toBe(false);
  }
  expect(validInputRecords({}, scenario)).toBe(true);
  expect(validInputRecords({}, { ...scenario, source: "sample" })).toBe(true);
});

test("explicit date and method are required; optional note and real leap dates are accepted", () => {
  expect(createPPFDRecord(scenario, { ...details, measured_on: "" }, recordedAt)).toBeNull();
  expect(createPPFDRecord(scenario, { ...details, method: "" }, recordedAt)).toBeNull();
  expect(createPPFDRecord(scenario, { ...details, measured_on: "2024-02-29", note: "" }, recordedAt)).not.toBeNull();
  expect(createPPFDRecord(scenario, { ...details, measured_on: "2025-02-29" }, recordedAt)).toBeNull();
});

test("a stale record cannot survive classification or a context snapshot edited without its fingerprint", () => {
  const changed = { ...scenario, lighting_watts: 700 };
  const records: InputRecords = { ppfd_full: { ...recordFor(), context: { ...recordFor().context, lighting_watts: 700 } } };
  expect(validInputRecords(records, changed)).toBe(false);
  expect(inputOrigin("ppfd_full", changed, records)).toBe("user-entered");
  const fresh = createPPFDRecord(changed, details, recordedAt);
  expect(validInputRecords({ ppfd_full: fresh }, changed)).toBe(true);
});
