"""Transparent, bounded lighting scenario model. Not a crop or CFD simulator."""
from itertools import product
from math import isclose, isfinite
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL_VERSION = "lighting-scenarios-0.3.0"

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)

class Scenario(StrictModel):
    source: Literal["sample", "manual", "photo-assisted"] = "manual"
    length_ft: float = Field(gt=0, le=1000)
    width_ft: float = Field(gt=0, le=1000)
    canopy_sqft: float = Field(gt=0, le=1_000_000)
    light_count: int = Field(ge=1, le=100)
    lighting_watts: float = Field(gt=0, le=1_000_000, description="Combined lighting load at full output")
    other_watts: float = Field(ge=0, le=1_000_000)
    other_hours: float = Field(ge=0, le=24)
    baseline_hours: float = Field(gt=0, le=24)
    baseline_dim: float = Field(gt=0, le=1)
    dimmable: bool = False
    ppfd_full: float | None = Field(default=None, gt=0, le=5000)
    min_dli: float | None = Field(default=None, gt=0, le=100)
    min_hours: float = Field(gt=0, le=24)
    max_hours: float = Field(gt=0, le=24)
    power_limit_watts: float = Field(gt=0, le=2_000_000)
    electricity_usd_kwh: float = Field(ge=0, le=10)
    operating_days: int = Field(ge=1, le=366)
    water_liters_day: float | None = Field(default=None, ge=0, le=1_000_000)
    confirmed: bool = False

    @model_validator(mode="after")
    def consistent(self):
        if self.canopy_sqft > self.length_ft * self.width_ft:
            raise ValueError("This first model supports one canopy plane. Canopy must fit the floor area.")
        if self.min_hours > self.max_hours:
            raise ValueError("Minimum photoperiod must not exceed maximum photoperiod.")
        if not self.dimmable and self.baseline_dim != 1:
            raise ValueError("Non-dimmable fixtures must have a baseline dim fraction of 1.")
        baseline_energy = daily_energy(self, self.baseline_hours, self.baseline_dim)
        maximum_energy = daily_energy(self, self.max_hours, 1)
        if baseline_energy <= 0 or not isfinite(100 * (maximum_energy / baseline_energy)):
            raise ValueError("The baseline energy is too small to calculate a finite savings percentage.")
        return self

SAMPLE = {
    "source": "sample", "length_ft": 8, "width_ft": 8, "canopy_sqft": 32,
    "light_count": 2, "lighting_watts": 600, "other_watts": 45,
    "other_hours": 24, "baseline_hours": 16, "baseline_dim": 1,
    "dimmable": False, "ppfd_full": 350, "min_dli": 15,
    "min_hours": 10, "max_hours": 18, "power_limit_watts": 1800,
    "electricity_usd_kwh": 0.15, "operating_days": 365,
    "water_liters_day": 15, "confirmed": False,
}

def daily_energy(s: Scenario, hours: float, dim: float) -> float:
    return (s.lighting_watts * dim * hours + s.other_watts * s.other_hours) / 1000


def peak_power(s: Scenario, dim: float) -> float:
    return s.lighting_watts * dim + (s.other_watts if s.other_hours > 0 else 0)


def calculate(s: Scenario, hours: float, dim: float) -> dict:
    daily = daily_energy(s, hours, dim)
    period = daily * s.operating_days
    return {
        "photoperiod_hours": hours, "dim_fraction": dim,
        "daily_energy_kwh": round(daily, 6),
        "period_energy_kwh": round(period, 4),
        "period_energy_cost_usd": round(period * s.electricity_usd_kwh, 4),
        "peak_modeled_watts": round(peak_power(s, dim), 4),
        "dli_mol_m2_day": round(s.ppfd_full * dim * hours * 0.0036, 6) if s.ppfd_full is not None else None,
        "period_water_liters": round(s.water_liters_day * s.operating_days, 4) if s.water_liters_day is not None else None,
        "canopy_sqft": s.canopy_sqft,
    }

def solve(s: Scenario) -> dict:
    baseline = calculate(s, s.baseline_hours, s.baseline_dim)
    result = {
        "model_version": MODEL_VERSION, "source": s.source,
        "status": "needs_measurement", "operating_days": s.operating_days,
        "baseline": baseline, "optimized": None, "savings": None,
        "configurations_evaluated": 0, "feasible_configurations": 0,
        "candidates": [], "recommendations": [],
        "limitations": [
            "Scenario estimates, not measured savings or a validated crop-yield forecast.",
            "PPFD must represent the crop canopy at full lighting output. A room photo cannot supply it.",
            "DLI is a screening constraint, not proof of maintained yield, plant health, or light uniformity.",
            "Dimming uses a linear light-output and power assumption. Validate against actual fixtures.",
            "The finite search tests quarter-hour schedules plus entered bounds and baseline hours, with 50-100% output in 5% steps plus the entered baseline dim fraction. It is not a continuous or global optimum.",
            "Peak power conservatively assumes entered active loads overlap. Loads with zero operating hours are excluded; startup surges are not modeled.",
            "Only entered loads are counted. HVAC, pump loads, tariffs and demand charges may change results.",
            "No soil, airflow, water, crop-production, layout-rearrangement or avoided-CapEx model is implemented.",
            "The visual twin is a schematic derived from confirmed inputs, not a measured 3D reconstruction.",
        ],
    }
    if not s.confirmed:
        result["recommendations"] = ["Confirm the inventory, dimensions, loads and crop constraints before running scenarios."]
        return result
    if s.ppfd_full is None or s.min_dli is None:
        result["recommendations"] = ["Enter canopy PPFD at full output and an appropriate crop-stage DLI minimum. No savings are invented when these are unknown."]
        return result

    # Include off-grid bounds and baseline choices in the auditable finite grid.
    hours = {round(i / 4, 2) for i in range(1, 97) if s.min_hours <= i / 4 <= s.max_hours}
    hours.update((s.min_hours, s.max_hours))
    if s.min_hours <= s.baseline_hours <= s.max_hours:
        hours.add(s.baseline_hours)
    dims = {round(i / 20, 2) for i in range(10, 21)} if s.dimmable else {1.0}
    dims.add(s.baseline_dim)
    settings = set(product(hours, dims)) | {(s.baseline_hours, s.baseline_dim)}
    candidates = []
    for h, d in sorted(settings):
        m = calculate(s, h, d)
        reasons = []
        if not s.min_hours <= h <= s.max_hours:
            reasons.append("photoperiod")
        dose = s.ppfd_full * d * h * 0.0036
        if dose < s.min_dli and not isclose(dose, s.min_dli, rel_tol=1e-12, abs_tol=0):
            reasons.append("minimum_dli")
        peak = peak_power(s, d)
        if peak > s.power_limit_watts and not isclose(peak, s.power_limit_watts, rel_tol=1e-12, abs_tol=0):
            reasons.append("modeled_power_limit")
        candidates.append({**m, "feasible": not reasons, "rejected_for": reasons})
    feasible = [c for c in candidates if c["feasible"]]
    result.update(configurations_evaluated=len(candidates), feasible_configurations=len(feasible), candidates=candidates)
    if not feasible:
        result["status"] = "no_feasible_configuration"
        result["recommendations"] = ["No tested setting satisfies your constraints. Review measurements and crop requirements; do not buy equipment based on this result alone."]
        return result
    best = min(feasible, key=lambda c: (
        daily_energy(s, c["photoperiod_hours"], c["dim_fraction"]), abs(c["dim_fraction"] - s.baseline_dim),
        abs(c["photoperiod_hours"] - s.baseline_hours)))
    optimized = {k: v for k, v in best.items() if k not in ("feasible", "rejected_for")}
    # Rank and compute savings before display rounding (tiny loads may round to zero).
    baseline_daily = daily_energy(s, s.baseline_hours, s.baseline_dim)
    optimized_daily = daily_energy(s, best["photoperiod_hours"], best["dim_fraction"])
    daily_delta = baseline_daily - optimized_daily
    delta = daily_delta * s.operating_days
    result.update(status="optimized", optimized=optimized, savings={
        "period_energy_kwh": round(delta, 4),
        "energy_pct": round(100 * (daily_delta / baseline_daily), 2) if baseline_daily else 0.0,
        "period_energy_cost_usd": round(delta * s.electricity_usd_kwh, 4),
        "water_liters": None, "yield_gain_lb": None, "avoided_capex_usd": None,
        "new_equipment_required_by_scenario_usd": 0,
    })
    result["recommendations"] = [
        f"Test {best['photoperiod_hours']:g} lighting hours/day at {best['dim_fraction'] * 100:g}% output using the existing fixtures.",
        f"The modeled light dose is {best['dli_mol_m2_day']:.2f} mol/m²/day against your minimum of {s.min_dli:g}.",
        "Measure actual power, canopy light distribution and crop response before adopting the proposed schedule.",
        "Water, yield and avoided purchases remain unestimated. No new assets are added by this scenario search.",
    ]
    if delta < 0:
        result["recommendations"].insert(0, "Meeting your constraints requires more modeled energy than the current setting, not an energy saving.")
    return result
