import type { Scenario, TwinAsset, Metrics } from "./types";

export const SAMPLE_SCENARIO: Scenario = {
  source: "sample",
  length_ft: 8,
  width_ft: 8,
  canopy_sqft: 32,
  light_count: 2,
  lighting_watts: 600,
  other_watts: 45,
  other_hours: 24,
  baseline_hours: 16,
  baseline_dim: 1,
  dimmable: false,
  ppfd_full: 350,
  min_dli: 15,
  min_hours: 10,
  max_hours: 18,
  power_limit_watts: 1800,
  electricity_usd_kwh: 0.15,
  operating_days: 365,
  water_liters_day: 15,
  confirmed: false,
};

export const SAMPLE_ASSETS: TwinAsset[] = [
  {
    id: "rack-1",
    name: "Growing racks",
    type: "shelving_rack",
    quantity: 2,
    confidence: null,
    confirmed: true,
  },
  {
    id: "light-1",
    name: "LED grow lights",
    type: "light_fixture",
    quantity: 2,
    confidence: null,
    confirmed: true,
  },
  {
    id: "plant-1",
    name: "Leafy greens",
    type: "plant",
    quantity: 24,
    confidence: null,
    confirmed: true,
  },
  {
    id: "fan-1",
    name: "Circulation fan",
    type: "circulation_fan",
    quantity: 1,
    confidence: null,
    confirmed: true,
  },
];

export function baselineMetrics(s: Scenario): Metrics {
  const energy =
    (s.lighting_watts * s.baseline_dim * s.baseline_hours +
      s.other_watts * s.other_hours) /
    1000;
  return {
    photoperiod_hours: s.baseline_hours,
    dim_fraction: s.baseline_dim,
    daily_energy_kwh: energy,
    period_energy_kwh: energy * s.operating_days,
    period_energy_cost_usd: energy * s.operating_days * s.electricity_usd_kwh,
    peak_modeled_watts:
      s.lighting_watts * s.baseline_dim +
      (s.other_hours > 0 ? s.other_watts : 0),
    dli_mol_m2_day:
      s.ppfd_full === null
        ? null
        : s.ppfd_full * s.baseline_dim * s.baseline_hours * 0.0036,
    period_water_liters:
      s.water_liters_day === null
        ? null
        : s.water_liters_day * s.operating_days,
    canopy_sqft: s.canopy_sqft,
  };
}
