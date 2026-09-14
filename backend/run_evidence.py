"""Process-local numerical run evidence shared by the HTTP and Live wrappers."""

import json
from collections import OrderedDict
from datetime import datetime, timezone
from threading import Lock
from uuid import uuid4

if __package__:
    from . import core
    from .schemas import RunArtifact
else:
    import core
    from schemas import RunArtifact


MAX_RUNS = 100
REASONS = ("photoperiod", "minimum_dli", "modeled_power_limit")
WEATHER_LIMITATION = (
    "Weather, outdoor climate, and weather-driven HVAC effects are not modeled; this is not a weather forecast."
)
SELECTION_REASON = (
    "Select the feasible candidate with the lowest unrounded daily energy. Exact energy ties "
    "prefer the smallest change from baseline dim fraction, then the smallest change from "
    "baseline hours; remaining ties retain ascending (hours, dim fraction) solver order. "
    "The nearest feasible alternative is the next candidate in this same ranking."
)
INPUT_ROLES = {
    "source": ("label", "Provenance; sample inputs are synthetic assumptions."),
    "length_ft": ("ft", "Floor/canopy validation only; not an energy or layout calculation."),
    "width_ft": ("ft", "Floor/canopy validation only; not an energy or layout calculation."),
    "canopy_sqft": ("ft^2", "Validated and reported canopy area; not a multiplier for energy or DLI."),
    "light_count": ("fixtures", "Inventory validation only; lighting_watts is already the combined load."),
    "lighting_watts": ("W", "Combined full-output lighting load for energy and peak power."),
    "other_watts": ("W", "Other-load energy and coincident peak power when other_hours > 0."),
    "other_hours": ("h/day", "Other-load daily energy and whether that load is active for peak power."),
    "baseline_hours": ("h/day", "Baseline metrics, candidate inclusion, and final hours-change tie-break."),
    "baseline_dim": ("fraction", "Baseline metrics, candidate inclusion, and dim-change tie-break."),
    "dimmable": ("boolean", "Whether the search includes 50-100% dim fractions in 5% steps."),
    "ppfd_full": ("umol/m^2/s", "Full-output canopy PPFD for modeled DLI; required before searching."),
    "min_dli": ("mol/m^2/day", "User-supplied minimum DLI constraint; required before searching."),
    "min_hours": ("h/day", "Inclusive lower photoperiod constraint and finite-grid bound."),
    "max_hours": ("h/day", "Inclusive upper photoperiod constraint and finite-grid bound."),
    "power_limit_watts": ("W", "Upper modeled coincident-load constraint."),
    "electricity_usd_kwh": ("USD/kWh", "Flat energy-cost rate over the entered operating horizon."),
    "operating_days": ("days", "Horizon multiplier for energy, cost, and optional baseline water."),
    "water_liters_day": ("L/day", "Optional entered usage, held unchanged; no water optimization."),
    "confirmed": ("boolean", "Review gate; candidates are evaluated only after input confirmation."),
}


class RunRegistry:
    """Thread-safe FIFO store of at most 100 immutable completed results."""

    def __init__(self):
        self._runs: OrderedDict[str, str] = OrderedDict()
        self._lock = Lock()

    def add(self, result: dict) -> None:
        # Immutable serialized values prevent all nested caller mutations from changing evidence.
        encoded = json.dumps(result, allow_nan=False, separators=(",", ":"))
        with self._lock:
            if result["run"]["id"] in self._runs:
                raise ValueError("A completed run cannot be replaced.")
            self._runs[result["run"]["id"]] = encoded
            while len(self._runs) > MAX_RUNS:
                self._runs.popitem(last=False)

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            encoded = self._runs.get(run_id)
        return json.loads(encoded) if encoded is not None else None

    def __len__(self) -> int:
        with self._lock:
            return len(self._runs)


_registry = RunRegistry()


def _setting(metrics: dict) -> tuple[float, float]:
    return metrics["photoperiod_hours"], metrics["dim_fraction"]


def _rank(s: core.Scenario, candidate: dict) -> tuple[float, float, float]:
    hours, dim = _setting(candidate)
    return (core.daily_energy(s, hours, dim), abs(dim - s.baseline_dim), abs(hours - s.baseline_hours))


def _formula(scope, metric, expression, substituted, raw, reported, unit, digits):
    return {"scope": scope, "metric": metric, "expression": expression,
            "substituted": f"{substituted} = {raw!r}", "raw_value": raw,
            "reported_value": reported, "unit": unit, "round_digits": digits}


def _metric_formulas(s: core.Scenario, metrics: dict, scope: str) -> list[dict]:
    hours, dim = _setting(metrics)
    daily = core.daily_energy(s, hours, dim)
    period = daily * s.operating_days
    active_other = s.other_watts if s.other_hours > 0 else 0
    formulas = [
        _formula(scope, "daily_energy_kwh",
                 "(lighting_watts * dim_fraction * photoperiod_hours + other_watts * other_hours) / 1000",
                 f"({s.lighting_watts!r} * {dim!r} * {hours!r} + {s.other_watts!r} * {s.other_hours!r}) / 1000",
                 daily, metrics["daily_energy_kwh"], "kWh/day", 6),
        _formula(scope, "period_energy_kwh", "daily_energy_kwh_raw * operating_days",
                 f"{daily!r} * {s.operating_days!r}", period, metrics["period_energy_kwh"], "kWh", 4),
        _formula(scope, "period_energy_cost_usd", "period_energy_kwh_raw * electricity_usd_kwh",
                 f"{period!r} * {s.electricity_usd_kwh!r}", period * s.electricity_usd_kwh,
                 metrics["period_energy_cost_usd"], "USD", 4),
        _formula(scope, "peak_modeled_watts", "lighting_watts * dim_fraction + (other_watts if other_hours > 0 else 0)",
                 f"{s.lighting_watts!r} * {dim!r} + {active_other!r}", core.peak_power(s, dim),
                 metrics["peak_modeled_watts"], "W", 4),
    ]
    if s.ppfd_full is not None:
        formulas.append(_formula(scope, "dli_mol_m2_day", "ppfd_full * dim_fraction * photoperiod_hours * 0.0036",
                                 f"{s.ppfd_full!r} * {dim!r} * {hours!r} * 0.0036",
                                 s.ppfd_full * dim * hours * 0.0036, metrics["dli_mol_m2_day"], "mol/m^2/day", 6))
    if s.water_liters_day is not None:
        formulas.append(_formula(scope, "period_water_liters", "water_liters_day * operating_days",
                                 f"{s.water_liters_day!r} * {s.operating_days!r}",
                                 s.water_liters_day * s.operating_days, metrics["period_water_liters"], "L", 4))
    return formulas


def _savings_formulas(s: core.Scenario, result: dict) -> list[dict]:
    baseline = core.daily_energy(s, *_setting(result["baseline"]))
    selected = core.daily_energy(s, *_setting(result["optimized"]))
    delta = baseline - selected
    period = delta * s.operating_days
    savings = result["savings"]
    return [
        _formula("savings", "period_energy_kwh", "(baseline_daily_kwh_raw - selected_daily_kwh_raw) * operating_days",
                 f"({baseline!r} - {selected!r}) * {s.operating_days!r}", period,
                 savings["period_energy_kwh"], "kWh", 4),
        _formula("savings", "period_energy_cost_usd", "period_energy_difference_kwh_raw * electricity_usd_kwh",
                 f"{period!r} * {s.electricity_usd_kwh!r}", period * s.electricity_usd_kwh,
                 savings["period_energy_cost_usd"], "USD", 4),
        _formula("savings", "energy_pct", "100 * ((baseline_daily_kwh_raw - selected_daily_kwh_raw) / baseline_daily_kwh_raw)",
                 f"100 * (({baseline!r} - {selected!r}) / {baseline!r})", 100 * (delta / baseline),
                 savings["energy_pct"], "%", 2),
    ]


def _constraints(s: core.Scenario, result: dict, baseline: dict | None, selected: dict | None) -> list[dict]:
    def values(metrics):
        if metrics is None:
            return (None, None, None)
        hours, dim = _setting(metrics)
        return (hours, s.ppfd_full * dim * hours * 0.0036 if s.ppfd_full is not None else None,
                core.peak_power(s, dim))

    baseline_values = values(result["baseline"])
    selected_values = values(selected)
    bounds = (("h/day", s.min_hours, s.max_hours), ("mol/m^2/day", s.min_dli, None),
              ("W", None, s.power_limit_watts))
    return [
        {"name": reason, "unit": unit, "minimum": minimum, "maximum": maximum,
         "evaluated": bool(result["configurations_evaluated"]),
         "baseline_value": baseline_values[i],
         "baseline_passed": reason not in baseline["rejected_for"] if baseline is not None else None,
         "selected_value": selected_values[i],
         "selected_passed": reason not in selected["rejected_for"] if selected is not None else None,
         "rejected_configurations": sum(reason in c["rejected_for"] for c in result["candidates"])}
        for i, (reason, (unit, minimum, maximum)) in enumerate(zip(REASONS, bounds))
    ]


def _evidence(s: core.Scenario, result: dict) -> dict:
    candidates = result["candidates"]
    baseline = next((c for c in candidates if _setting(c) == _setting(result["baseline"])), None)
    selected = next((c for c in candidates if result["optimized"] is not None
                     and _setting(c) == _setting(result["optimized"])), None)
    alternatives = []
    if selected is not None:
        alternatives.append({"kind": "selected", "reason": None, "candidate": selected})
        feasible_others = [c for c in candidates if c["feasible"] and _setting(c) != _setting(selected)]
        if feasible_others:
            alternatives.append({"kind": "nearest_feasible", "reason": None,
                                 "candidate": min(feasible_others, key=lambda c: _rank(s, c))})
    for reason in REASONS:
        rejected = next((c for c in candidates if reason in c["rejected_for"]), None)
        if rejected is not None:
            alternatives.append({"kind": "rejected", "reason": reason, "candidate": rejected})

    missing = (["confirmed"] if not s.confirmed else []) + [
        field for field in ("ppfd_full", "min_dli") if getattr(s, field) is None]
    prefix = "Synthetic sample scenario. " if s.source == "sample" else "Scenario estimate from entered inputs. "
    if result["status"] == "needs_measurement":
        summary = prefix + "No candidates were evaluated. Confirm or supply: " + ", ".join(missing) + ". No savings are estimated."
        selection_reason = "No selection: confirmation, full-output canopy PPFD, and minimum crop-stage DLI are required."
    elif result["status"] == "no_feasible_configuration":
        reasons = ", ".join(a["reason"] for a in alternatives if a["kind"] == "rejected")
        summary = (prefix + f"None of the {len(candidates)} tested settings satisfies all constraints. "
                   f"Actual rejection reasons: {reasons}. No savings are estimated.")
        selection_reason = "No selection: every evaluated candidate failed at least one entered constraint."
    else:
        hours, dim = _setting(selected)
        baseline_hours, baseline_dim = _setting(result["baseline"])
        energy = result["savings"]["period_energy_kwh"]
        cost = result["savings"]["period_energy_cost_usd"]
        energy_amount = f"{abs(energy):.4f}".rstrip("0").rstrip(".")
        cost_amount = f"{abs(cost):.4f}".rstrip("0").rstrip(".")
        energy_change = "less energy" if energy > 0 else "more energy" if energy < 0 else "energy difference"
        cost_change = "less cost" if cost > 0 else "more cost" if cost < 0 else "cost difference"
        setting = (f"Lighting stays at {hours:g} h/day at {dim * 100:g}% output; no operating change is proposed. "
                   if (hours, dim) == (baseline_hours, baseline_dim) else
                   f"Lighting changes from {baseline_hours:g} h/day at {baseline_dim * 100:g}% output to {hours:g} h/day at {dim * 100:g}% output. ")
        summary = (prefix + setting +
                   f"Selected for minimum modeled energy among {len(candidates)} tested settings while meeting "
                   f"all entered constraints ({result['feasible_configurations']} feasible). "
                   f"Projected change over {s.operating_days} operating days: {energy_amount} kWh {energy_change} "
                   f"and USD {cost_amount} {cost_change}. "
                   "This conditional projection depends on entered inputs; it is not measured savings or a crop or weather forecast.")
        selection_reason = SELECTION_REASON

    formulas = _metric_formulas(s, result["baseline"], "baseline")
    if selected is not None:
        formulas.extend(_metric_formulas(s, result["optimized"], "selected"))
        formulas.extend(_savings_formulas(s, result))
    return {
        "summary": summary,
        "inputs": [{"field": field, "value": getattr(s, field), "unit": unit, "used_for": role}
                   for field, (unit, role) in INPUT_ROLES.items()],
        "baseline": result["baseline"], "selected": result["optimized"], "savings": result["savings"],
        "formulas": formulas, "objective": "Minimize unrounded daily energy among the evaluated feasible lighting settings.",
        "constraints": _constraints(s, result, baseline, selected),
        "configurations_evaluated": result["configurations_evaluated"],
        "feasible_configurations": result["feasible_configurations"],
        "selection_reason": selection_reason, "alternatives": alternatives,
        "horizon": {"operating_days": s.operating_days, "electricity_usd_kwh": s.electricity_usd_kwh},
        "assumptions": [
            "All sample inputs are synthetic assumptions." if s.source == "sample" else
            "Entered inputs are user supplied; photo assistance does not establish numerical measurements.",
            "The entered schedule and flat electricity rate apply on each operating day; the horizon is not necessarily a calendar year.",
            "Lighting watts are the combined full-output load, not watts per fixture; dimming scales power and PPFD linearly.",
            "DLI conversion uses 0.0036 = 3600 seconds/hour / 1,000,000 micromoles/mole.",
            "Formulas report raw Python floating-point values and separately rounded solver outputs. Ranking, constraint checks, "
            "and savings use raw values; subtracting rounded period metrics can differ from the reported difference.",
            "DLI and power boundary comparisons use relative tolerance 1e-12 and zero absolute tolerance; photoperiod bounds are inclusive.",
            "Each rejection count is independent; a candidate may fail more than one constraint. Alternatives are actual candidates, "
            "with one example per observed reason; the same candidate may illustrate multiple reasons.",
            "Optional water usage is unchanged across settings; water savings, yield, and avoided purchases remain unestimated.",
        ],
        "missing_inputs": missing, "limitations": [*result["limitations"], WEATHER_LIMITATION],
    }


def execute_run(scenario: core.Scenario) -> dict:
    """Run the unchanged solver once, register its evidence, and return a detached result."""
    snapshot = core.Scenario.model_validate(scenario.model_dump())
    result = core.solve(snapshot)
    artifact = RunArtifact.model_validate({
        "id": str(uuid4()), "created_at": datetime.now(timezone.utc).isoformat(),
        "input_snapshot": snapshot.model_dump(), "model_version": result["model_version"],
        "source": result["source"], "status": result["status"], "evidence": _evidence(snapshot, result),
    })
    augmented = {**result, "run": artifact.model_dump()}
    _registry.add(augmented)
    return augmented


def get_run(run_id: str) -> dict | None:
    """Read a deep copy of a completed run; reads do not extend its FIFO retention."""
    return _registry.get(run_id)
