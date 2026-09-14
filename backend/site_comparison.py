"""Conditional site accounting around the unchanged lighting engine, with immutable evidence."""

import hashlib
import json
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal
from math import isclose
from threading import Lock
from types import SimpleNamespace
from uuid import uuid4

if __package__:
    from . import core
    from .run_evidence import execute_run, get_run
    from .site_schemas import ComparisonRequest, Inputs, METRIC_UNITS, COST_BASES
else:
    import core
    from run_evidence import execute_run, get_run
    from site_schemas import ComparisonRequest, Inputs, METRIC_UNITS, COST_BASES

SCHEMA_VERSION = "site-scenario-comparison/2.0.0"
ACCOUNTING_VERSION = "site-scenario-accounting/1.0.0"
BENCHMARK_VERSION = "user-output-benchmark/1.0.0"
CANONICALIZATION = "python-json-sort-keys-ascii/1"
MAX_COMPARISONS = 100
LIMITATIONS = [
    "Conditional accounting of reviewed user scenarios, not predicted yield, measured savings, or a crop/weather forecast.",
    "Output benchmarks are conditional inputs. A DLI pass does not establish productive output or validate a benchmark.",
    "Only one indoor leafy-greens operation, one canopy plane and explicit complete-cycle plans are supported.",
    "The schematic does not calculate equipment placement, access, airflow or layout feasibility.",
    "Supplementary loads use entered duty arithmetic; climate conditions are stipulated, not predicted by an HVAC model.",
    "All active loads conservatively coincide; no startup surges, demand charges, circuit certification or power-factor model.",
    "Costs are scoped cash outflows, not enterprise production cost, revenue, profit, depreciation or avoided purchases.",
    "Browser exports are local evidence; server verification only checks a process-local FIFO of 100 comparisons.",
    "Uncertainty is unknown unless supplied by the benchmark source; sensitivity is not a confidence interval.",
]


class ComparisonError(ValueError):
    def __init__(self, message, status_code=409):
        super().__init__(message)
        self.status_code = status_code


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(encoded):
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def setting_number(value):
    """Preserve exact float identity with Number.toString's decimal/exponent thresholds."""
    value = float(value)
    if value == 0:
        return "0"
    if 1e-6 <= abs(value) < 1e21:
        text = format(Decimal(repr(value)), "f")
        return text.rstrip("0").rstrip(".") if "." in text else text
    mantissa, exponent = repr(value).lower().split("e")
    return f"{mantissa.removesuffix('.0')}e{int(exponent):+d}"


class ComparisonRegistry:
    def __init__(self, capacity=MAX_COMPARISONS):
        self.capacity = capacity
        self._items = OrderedDict()
        self._lock = Lock()

    def add(self, artifact):
        encoded = canonical(artifact)
        identity = artifact["payload"]["id"]
        with self._lock:
            if identity in self._items:
                raise ValueError("An immutable comparison cannot be replaced.")
            self._items[identity] = encoded
            while len(self._items) > self.capacity:
                self._items.popitem(last=False)

    def get(self, identity):
        with self._lock:
            encoded = self._items.get(identity)
        return json.loads(encoded) if encoded is not None else None


registry = ComparisonRegistry()


def input_snapshot(request):
    return Inputs.model_validate(request.model_dump(include=set(Inputs.model_fields))).model_dump()


def review_valid(request, snapshot):
    if request.review is None:
        return False
    try:
        parsed = json.loads(request.review.snapshot_json)
        reviewed = Inputs.model_validate(parsed).model_dump()
        timestamp = datetime.fromisoformat(request.review.reviewed_at.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("Review time must have a timezone.")
    except (ValueError, TypeError, RecursionError):
        raise ComparisonError("Review snapshot is malformed. Review the current inputs again.", 422) from None
    if canonical(reviewed) != canonical(snapshot):
        raise ComparisonError("Review is stale: inputs differ from the reviewed snapshot. Review the current inputs again.")
    return True


def dec(value):
    return Decimal(str(value))


def mul(*values):
    if any(v is None for v in values):
        return None
    result = Decimal(1)
    for value in values:
        result *= dec(value)
    return float(result)


def add(values):
    return float(sum((dec(v) for v in values), Decimal(0)))


def metric(value, unit, unknown=(), excluded=(), known=None, reason=None):
    missing = list(unknown)
    return {"value": value if not missing else None, "known_subtotal": value if known is None and value is not None else known or 0,
            "complete": value is not None and not missing, "unit": unit,
            "unknown_line_ids": missing, "excluded_line_ids": list(excluded), "reason": reason}


def subtotal(items, unit):
    known = add([m["known_subtotal"] for m in items])
    unknown = list(dict.fromkeys(i for m in items for i in m["unknown_line_ids"]))
    excluded = list(dict.fromkeys(i for m in items for i in m["excluded_line_ids"]))
    return metric(known if not unknown else None, unit, unknown, excluded, known,
                  "Known subtotal only; one or more in-boundary inputs are unknown." if unknown else None)


def trusted(evidence):
    return evidence["source"] != "provider_observation"


def benchmark_context(inputs, scenario):
    """Versioned projection intentionally excludes money, goals, limits, display names and review times."""
    site = inputs["site"]
    operation = inputs["operation"]
    return {
        "site": {k: site[k] for k in ("id", "revision", "boundary_id", "boundary_revision", "length_ft", "width_ft", "canopy_sqft", "included_spaces", "excluded_spaces")},
        "assets": [{k: a[k] for k in ("id", "revision", "site_id", "kind", "quantity", "power_basis", "watts", "component_ids", "available")} for a in inputs["assets"]],
        "operation": {k: v for k, v in operation.items() if k not in ("name", "evidence")},
        "loads": [{k: l[k] for k in ("asset_id", "asset_revision", "component_ids", "accounting", "hours_per_day", "status")} for l in scenario["loads"]],
        "lighting": {k: scenario["lighting"][k] for k in ("hours_per_day", "dim_fraction", "dimmable", "ppfd_full", "ppfd_basis")},
        "water_liters_day": scenario["water_liters_day"],
    }


def flatten(value, prefix=""):
    if isinstance(value, dict):
        return {p: v for k, item in value.items() for p, v in flatten(item, f"{prefix}.{k}" if prefix else k).items()}
    if isinstance(value, list):
        if not value:
            return {prefix: []}
        return {p: v for i, item in enumerate(value) for p, v in flatten(item, f"{prefix}[{i}]").items()}
    return {prefix: value}


def applicability(inputs, scenario, light_supported, reviewed):
    benchmark = scenario["benchmark"]
    if benchmark is None:
        return {"status": "unknown", "checks": [], "reasons": ["A scenario-specific conditional output benchmark is missing."]}
    actual = flatten(benchmark_context(inputs, scenario))
    expected = flatten(benchmark["context"])
    checks = []
    for path in sorted(set(actual) | set(expected)):
        a, e = actual.get(path), expected.get(path)
        unknown = a is None or e is None or (isinstance(a, str) and not a.strip()) or (isinstance(e, str) and not e.strip())
        equal = a == e and isinstance(a, bool) == isinstance(e, bool)
        state = "unknown" if unknown else "pass" if equal else "fail"
        checks.append({"path": path, "expected": e, "actual": a, "status": state})
    reasons = [f"{c['path']}: {'condition differs from benchmark' if c['status'] == 'fail' else 'required condition is unknown'}"
               for c in checks if c["status"] != "pass"]
    if not reviewed:
        reasons.append("Benchmark and operating assumptions are not reviewed.")
    if not trusted(benchmark["evidence"]):
        reasons.append("Provider observations cannot establish output benchmarks.")
    if benchmark["kg_per_cycle"] is None:
        reasons.append("Conditional kg per completed cycle is unknown.")
    op = inputs["operation"]
    cycle_supported = op["identical_cycles"] and op["completed_cycles"] * (op["cycle_days"] + op["turnover_days"]) + op["idle_days"] == op["horizon_days"]
    if not cycle_supported:
        reasons.append("Complete identical-cycle, turnover and idle-day accounting does not match the horizon.")
    if not light_supported:
        reasons.append("The requested lighting setting lacks supported passing PPFD/DLI, photoperiod or module power evidence.")
    if any(c["status"] == "fail" for c in checks):
        status = "fail"
    elif reasons:
        status = "unknown"
    else:
        status = "pass"
    return {"status": status, "checks": checks, "reasons": reasons}


def aggregate_provenance(snapshot):
    return "synthetic_fixture" if any(v == "synthetic_fixture" for k, v in flatten(snapshot).items() if k.endswith(".source")) else "user_defined"


def _lighting(inputs, scenario, reviewed):
    assets = {a["id"]: a for a in inputs["assets"]}
    lighting = scenario["lighting"]
    lines = []
    included, excluded, pieces = [], [], []
    for load in scenario["loads"]:
        asset = assets[load["asset_id"]]
        watts = asset["watts"] if trusted(asset["evidence"]) else None
        if watts is not None and asset["power_basis"] == "per_unit":
            watts = mul(watts, asset["quantity"])
        hours = load["hours_per_day"]
        status = load["status"]
        if status == "known" and (watts is None or hours is None or not trusted(scenario["evidence"])):
            status = "unknown"
        fraction = lighting["dim_fraction"] if load["accounting"] == "lighting" else 1
        daily = mul(watts, fraction, hours, 0.001) if status == "known" else None
        peak = mul(watts, fraction) if status == "known" and hours > 0 else 0 if status == "known" else None
        ids = included if load["accounting"] in ("lighting", "module_other") else excluded
        ids.extend(load["component_ids"])
        lines.append({"id": load["id"], "category": load["accounting"], "status": status, "value": daily, "unit": "kWh/day", "quantity": hours, "rate": mul(watts, fraction, 0.001), "component_ids": load["component_ids"], "reason": load["reason"] or ("Load power or daily duty is unknown or untrusted." if status == "unknown" else None)})
        pieces.append({"load": load, "asset": asset, "watts": watts, "hours": hours, "daily": daily, "peak": peak, "status": status})
    lights = [p for p in pieces if p["load"]["accounting"] == "lighting"]
    others = [p for p in pieces if p["load"]["accounting"] == "module_other"]
    mapped = all(p["status"] == "known" for p in lights + others) and len({p["hours"] for p in others}) <= 1
    count = sum(p["asset"]["quantity"] for p in lights)
    module = None
    missing = []
    raw_daily = raw_peak = None
    core_args = None
    if mapped:
        watts = add([p["watts"] for p in lights])
        other_watts = add([p["watts"] for p in others])
        other_hours = others[0]["hours"] if others else 0.0
        core_args = {"lighting_watts": watts, "other_watts": other_watts, "other_hours": other_hours}
        raw_daily = core.daily_energy(SimpleNamespace(**core_args), lighting["hours_per_day"], lighting["dim_fraction"])
        raw_peak = core.peak_power(SimpleNamespace(**core_args), lighting["dim_fraction"])
    else:
        missing.append("lighting_module.component_mapping: unknown loads or incompatible other-load schedules")
    costs = {c["category"]: c for c in scenario["costs"]}
    tariff_line = costs.get("electricity")
    tariff = tariff_line["rate"] if tariff_line and tariff_line["status"] == "known" and trusted(tariff_line["evidence"]) else None
    site = inputs["site"]
    for key in ("length_ft", "width_ft", "canopy_sqft"):
        if site[key] is None or not trusted(site["evidence"]):
            missing.append(f"site.{key}")
    if tariff is None:
        missing.append("costs.electricity.rate")
    if lighting["power_limit_watts"] is None:
        missing.append("lighting.power_limit_watts")
    if not 1 <= count <= 100:
        missing.append("lighting.light_count: outside legacy module bounds")
    if mapped and core_args["lighting_watts"] <= 0:
        missing.append("lighting.lighting_watts: the existing lighting module requires positive combined power")
    if not trusted(scenario["evidence"]):
        missing.append("scenario.evidence: provider observations are not trusted operating measurements")
    if mapped and not missing and core_args["lighting_watts"] > 0 and trusted(scenario["evidence"]):
        payload = {**core_args, "source": "sample" if aggregate_provenance(inputs) == "synthetic_fixture" else "manual",
                   **{k: site[k] for k in ("length_ft", "width_ft", "canopy_sqft")}, "light_count": count,
                   "baseline_hours": lighting["hours_per_day"], "baseline_dim": lighting["dim_fraction"],
                   **{k: lighting[k] for k in ("dimmable", "ppfd_full", "min_dli", "min_hours", "max_hours", "power_limit_watts")},
                   "electricity_usd_kwh": tariff, "operating_days": inputs["operation"]["horizon_days"],
                   "water_liters_day": scenario["water_liters_day"], "confirmed": reviewed}
        try:
            legacy = core.Scenario.model_validate(payload)
        except ValueError:
            missing.append("lighting_module.inputs: outside the unchanged module's supported bounds")
        else:
            module = execute_run(legacy)
    if lighting["ppfd_full"] is None:
        missing.append("lighting.ppfd_full")
    if lighting["min_dli"] is None:
        missing.append("lighting.min_dli")
    light_pass = False
    if module:
        candidate = next((c for c in module["candidates"] if c["photoperiod_hours"] == lighting["hours_per_day"] and c["dim_fraction"] == lighting["dim_fraction"]), None)
        light_pass = candidate is not None and candidate["feasible"]
    return module, raw_daily, raw_peak, lines, pieces, included, excluded, missing, light_pass


def evaluate(inputs, scenario, reviewed, reviewed_at=None):
    identity = str(uuid4())
    created = now()
    module, raw_daily, raw_peak, usage, pieces, included, excluded, missing, light_pass = _lighting(inputs, scenario, reviewed)
    days = inputs["operation"]["horizon_days"]
    cycles = inputs["operation"]["completed_cycles"]
    formulas = []

    def formula(name, expression, operands, value, unit):
        formulas.append({"id": f"{identity}/formula/{name}", "metric": name, "expression": expression,
                         "operands": operands, "raw_value": value, "reported_value": round(value, 6) if value is not None else None, "unit": unit})

    formula("review-record", "User acknowledgement bound to the exact input snapshot; not independent measurement verification",
            {"review_status": "reviewed" if reviewed else "unreviewed", "reviewed_at": reviewed_at if reviewed else None,
             "reviewed_input_sha256": digest(canonical(inputs)) if reviewed else None,
             "canonicalization": CANONICALIZATION}, None, "acknowledgement")
    formula("accounting-policy", "Raw core floats are preserved; decimal bookkeeping uses their exact serialized values; display rounding never determines ranks",
            {"accounting_version": ACCOUNTING_VERSION, "benchmark_version": BENCHMARK_VERSION,
             "money_display_decimals": 2, "evidence_display_decimals": 6,
             "core_dli_power_relative_tolerance": 1e-12, "other_limits_tolerance": 0,
             "currency": "USD", "operating_days": days, "partial_cycle_output_prorated": False}, None, "policy")

    energy_parts, peak_parts = [], []
    for p in pieces:
        load = p["load"]
        if p["status"] == "excluded":
            energy_parts.append(metric(0, "kWh", excluded=[load["id"]]))
            peak_parts.append(metric(0, "W", excluded=[load["id"]]))
        else:
            unknown = [load["id"]] if p["status"] == "unknown" else []
            energy_parts.append(metric(mul(p["daily"], days), "kWh", unknown))
            peak_parts.append(metric(p["peak"], "W", unknown))
        formula(f"load-{load['id']}", "aggregate_watts * dim_fraction * hours_per_day / 1000 * operating_days",
                {"asset_id": load["asset_id"], "power_basis": p["asset"]["power_basis"], "entered_watts": p["asset"]["watts"], "quantity": p["asset"]["quantity"], "aggregate_watts": p["watts"], "dim_fraction": scenario["lighting"]["dim_fraction"] if load["accounting"] == "lighting" else 1, "hours_per_day": p["hours"], "operating_days": days}, mul(p["daily"], days), "kWh")
    energy = subtotal(energy_parts, "kWh")
    peak = subtotal(peak_parts, "W")
    # Reuse raw core totals where the exact module mapping is known; do not sum rounded module displays.
    if raw_daily is not None:
        external = [m for p, m in zip(pieces, energy_parts) if p["load"]["accounting"] not in ("lighting", "module_other")]
        energy = subtotal([metric(mul(raw_daily, days), "kWh"), *external], "kWh")
        external_peaks = [m for p, m in zip(pieces, peak_parts) if p["load"]["accounting"] not in ("lighting", "module_other")]
        peak = subtotal([metric(raw_peak, "W"), *external_peaks], "W")
    formula("energy_kwh", "core.daily_energy(requested_hours, requested_dim) * operating_days + external_period_kwh",
            {"module_daily_raw_kwh": raw_daily, "operating_days": days, "external_load_ids": [p["load"]["id"] for p in pieces if p["load"]["accounting"] not in ("lighting", "module_other")], "known_subtotal_kwh": energy["known_subtotal"]}, energy["value"], "kWh")
    formula("peak_watts", "core.peak_power(requested_dim) + external_coincident_watts", {"module_peak_raw_watts": raw_peak, "all_active_loads_coincide": True, "known_subtotal_watts": peak["known_subtotal"]}, peak["value"], "W")
    scenario_trusted = trusted(scenario["evidence"])
    water = mul(scenario["water_liters_day"], days) if scenario_trusted else None
    routine = mul(scenario["routine_labor_hours_cycle"], cycles) if scenario_trusted else None
    setup = scenario["setup_labor_hours"] if scenario_trusted else None
    app = applicability(inputs, scenario, light_pass, reviewed)
    output = mul(scenario["benchmark"]["kg_per_cycle"], cycles) if app["status"] == "pass" else None
    formula("output_kg", "applicable_benchmark_kg_per_complete_cycle * supported_complete_cycles", {"benchmark_id": scenario["benchmark"]["id"] if scenario["benchmark"] else None, "benchmark_version": scenario["benchmark"]["version"] if scenario["benchmark"] else None, "kg_per_cycle": scenario["benchmark"]["kg_per_cycle"] if scenario["benchmark"] else None, "complete_cycles": cycles, "applicability": app["status"]}, output, "kg")
    formula("water_liters", "entered_liters_per_day * operating_days", {"liters_per_day": scenario["water_liters_day"], "operating_days": days}, water, "L")
    work = subtotal([metric(routine, "h", ["routine_labor_hours_cycle"] if routine is None else []), metric(setup, "h", ["setup_labor_hours"] if setup is None else [])], "h")
    formula("work_hours", "routine_labor_hours_per_cycle * complete_cycles + setup_labor_hours", {"routine_labor_hours_per_cycle": scenario["routine_labor_hours_cycle"], "complete_cycles": cycles, "setup_labor_hours": setup}, work["value"], "h")
    metrics = {"energy_kwh": energy, "peak_watts": peak,
               "output_kg": metric(output, "kg", ["benchmark.applicability"] if output is None else [], reason="; ".join(app["reasons"]) or None),
               "water_liters": metric(water, "L", ["water_liters_day"] if water is None else []), "work_hours": work}
    quantities = {"kwh": energy["value"], "liter": water, "routine_hour": routine, "setup_hour": setup, "cycle": cycles, "horizon": 1}
    cost_metrics, cost_lines = {}, []
    cost_lookup = {c["category"]: c for c in scenario["costs"]}
    for category, basis in COST_BASES.items():
        c = cost_lookup.get(category)
        cid = c["id"] if c else f"missing-{category}"
        q = quantities[basis]
        rate = c["rate"] if c else None
        amount = c["amount"] if c else None
        status = c["status"] if c else "unknown"
        reason = c["reason"] if c else "Required cash category is not entered; missing is not zero."
        if c and not trusted(c["evidence"]):
            status, reason = "unknown", "Provider observation is not a reviewed cash input."
        known = 0
        value = None
        if status == "excluded":
            cm = metric(0, "USD", excluded=[cid])
        else:
            if status == "known":
                value = amount if basis == "horizon" else mul(q, rate)
                known = value if value is not None else mul(energy["known_subtotal"], rate) if basis == "kwh" and rate is not None else 0
            if value is None:
                status = "unknown"
                reason = reason or "Amount, applicable usage or rate is unknown; this is not a zero expense."
            cm = metric(value, "USD", [cid] if status == "unknown" else [], known=known, reason=reason)
        cost_metrics[category] = cm
        cost_lines.append({"id": cid, "category": category, "status": status, "value": value,
                           "unit": "USD", "quantity": q, "rate": rate, "component_ids": c["component_ids"] if c else [], "reason": reason})
        formula(f"cost-{category}", "explicit_horizon_amount" if basis == "horizon" else "quantity * rate", {"cost_line_id": cid, "basis": basis, "quantity": q, "rate": rate, "explicit_horizon_amount": amount, "known_subtotal": cm["known_subtotal"], "status": status}, value, "USD")
    metrics["new_setup_cash_usd"] = subtotal([cost_metrics[k] for k in ("new_equipment", "setup_labor", "setup_materials")], "USD")
    metrics["recurring_cash_usd"] = subtotal([cost_metrics[k] for k in ("electricity", "water", "routine_labor", "consumables", "maintenance")], "USD")
    metrics["horizon_cash_usd"] = subtotal([metrics["new_setup_cash_usd"], metrics["recurring_cash_usd"]], "USD")
    for key, categories in (("new_setup_cash_usd", ["new_equipment", "setup_labor", "setup_materials"]), ("recurring_cash_usd", ["electricity", "water", "routine_labor", "consumables", "maintenance"]), ("horizon_cash_usd", list(COST_BASES))):
        formula(key, "sum(included cash lines); unknown in-boundary line withholds total", {"cost_categories": categories, "known_subtotal": metrics[key]["known_subtotal"], "unknown_line_ids": metrics[key]["unknown_line_ids"], "excluded_line_ids": metrics[key]["excluded_line_ids"]}, metrics[key]["value"], "USD")
    for key, numerator in (("energy_per_kg", "energy_kwh"), ("water_per_kg", "water_liters"), ("recurring_cash_per_kg", "recurring_cash_usd"), ("horizon_cash_per_kg", "horizon_cash_usd")):
        n = metrics[numerator]["value"]
        value = float(dec(n) / dec(output)) if n is not None and output is not None and output > 0 else None
        metrics[key] = metric(value, METRIC_UNITS[key], [f"{numerator}/positive_applicable_output"] if value is None else [], reason="Requires a complete numerator and positive applicable conditional output." if value is None else None)
        formula(key, "complete_numerator / positive_applicable_output_kg", {"numerator_metric": numerator, "numerator": n, "output_kg": output}, value, METRIC_UNITS[key])
    lighting = scenario["lighting"]
    dli = mul(lighting["ppfd_full"], lighting["dim_fraction"], lighting["hours_per_day"], .0036) if scenario_trusted else None
    metrics["lighting_hours"] = metric(lighting["hours_per_day"] if scenario_trusted else None, "h/day", [] if scenario_trusted else ["lighting.hours_per_day"])
    metrics["dli"] = metric(dli, "mol/m^2/day", ["lighting.ppfd_full"] if dli is None else [])
    metrics["layout_feasibility"] = metric(None, "boolean", ["validated_layout_model"], reason="A schematic cannot establish layout feasibility.")
    formula("dli", "full_output_PPFD * output_fraction * hours_per_day * 0.0036", {"ppfd_umol_m2_s": lighting["ppfd_full"], "dim_fraction": lighting["dim_fraction"], "hours_per_day": lighting["hours_per_day"], "conversion": .0036}, dli, "mol/m^2/day")
    constraints = [constraint(identity, limit, metrics[limit["metric"]]) for limit in inputs["limits"]]
    unavailable = [a["id"] for a in inputs["assets"] if a["available"] is not True]
    if unavailable:
        state = "fail" if any(a["available"] is False for a in inputs["assets"]) else "unknown"
        constraints.append({"id": f"{identity}/constraint/asset-availability", "metric": "layout_feasibility", "status": state, "value": None, "known_subtotal": 0, "minimum": None, "maximum": None, "unit": "boolean", "reason": "Required asset availability: " + ", ".join(unavailable)})
    states = {c["status"] for c in constraints}
    feasibility = "fail" if "fail" in states else "unknown" if "unknown" in states else "pass"
    missing += [p for key, m in metrics.items() if key != "layout_feasibility" for p in m["unknown_line_ids"]]
    missing = list(dict.fromkeys(missing))
    provenance = aggregate_provenance(inputs)
    summary = f"{scenario['name']}: requested {lighting['hours_per_day']:g} h/day at {lighting['dim_fraction'] * 100:g}% lighting output. "
    summary += f"{energy['value']:g} kWh over {days} days. " if energy["value"] is not None else f"Known energy subtotal {energy['known_subtotal']:g} kWh; full energy is unknown. "
    summary += f"Conditional output {output:g} kg from its own reviewed benchmark. " if output is not None else "Conditional output is withheld: " + "; ".join(app["reasons"][:3]) + ". "
    summary += f"Constraint outcome: {feasibility}. The lighting module's separate optimum was not substituted."
    if provenance == "synthetic_fixture":
        summary = "Synthetic test fixture, not agronomic evidence. " + summary
    return {"id": identity, "created_at": created, "scenario_id": scenario["id"], "scenario_revision": scenario["revision"],
            "snapshot": {"site": inputs["site"], "assets": inputs["assets"], "operation": inputs["operation"], "scenario": scenario, "limits": inputs["limits"]},
            "review_status": "reviewed" if reviewed else "unreviewed", "provenance": provenance,
            "status": "partial" if missing else "evaluated", "metrics": metrics, "feasibility": feasibility, "constraints": constraints,
            "applicability": app, "module_result": module, "module_status": module["status"] if module else "not_evaluated_missing_inputs",
            "module_included_components": included, "module_excluded_components": excluded,
            "requested_setting": {"hours": lighting["hours_per_day"], "dim": lighting["dim_fraction"], "candidate_id": f"h{setting_number(lighting['hours_per_day'])}-d{setting_number(lighting['dim_fraction'])}"},
            "usage_lines": usage, "cost_lines": cost_lines, "formulas": formulas, "missing_inputs": missing,
            "limitations": list(LIMITATIONS), "explanation": summary}


def constraint(evaluation_id, limit, value):
    actual = value["value"]
    lower, upper = limit["minimum"], limit["maximum"]
    status = "unknown"
    reason = "Required value is unknown: " + ", ".join(value["unknown_line_ids"])
    if not limit["enabled"]:
        status, reason = "not_evaluated", limit["reason"]
    elif lower is None and upper is None:
        reason = "No numeric evaluator or bound is supplied for this requirement."
    elif not trusted(limit["evidence"]):
        reason = "Provider observations cannot establish trusted operational constraints."
    elif actual is not None:
        def equal(a, b):
            return isclose(a, b, rel_tol=1e-12, abs_tol=0) if limit["metric"] in ("dli", "peak_watts") else dec(a) == dec(b)
        failed = (lower is not None and actual < lower and not equal(actual, lower)) or (upper is not None and actual > upper and not equal(actual, upper))
        status = "fail" if failed else "pass"
        reason = f"{actual:g} {value['unit']} {'violates' if failed else 'satisfies'} inclusive bounds [{lower}, {upper}]."
    elif upper is not None and dec(value["known_subtotal"]) > dec(upper):
        status = "fail"
        reason = f"Known nonnegative subtotal {value['known_subtotal']:g} {value['unit']} already exceeds {upper:g}; unknown remaining inputs cannot remove this breach."
    return {"id": f"{evaluation_id}/constraint/{limit['id']}", "metric": limit["metric"], "status": status, "value": actual,
            "known_subtotal": value["known_subtotal"], "minimum": lower, "maximum": upper, "unit": value["unit"], "reason": reason}


def compatibility(inputs):
    reasons = []
    op = inputs["operation"]
    if op["completed_cycles"] * (op["cycle_days"] + op["turnover_days"]) + op["idle_days"] != op["horizon_days"]:
        reasons.append("The horizon does not match complete cycles, turnover and idle days; no partial harvest is inferred.")
    exclusions = [sorted((c["category"], c["reason"]) for c in s["costs"] if c["status"] == "excluded") for s in inputs["scenarios"]]
    if any(e != exclusions[0] for e in exclusions[1:]):
        reasons.append("Cost exclusions differ across scenarios; align the accounting boundary before ranking.")
    loads = [sorted((l["asset_id"], l["reason"]) for l in s["loads"] if l["status"] == "excluded") for s in inputs["scenarios"]]
    if any(e != loads[0] for e in loads[1:]):
        reasons.append("Energy exclusions differ across scenarios; align the boundary before ranking.")
    return {"status": "not_comparable" if reasons else "comparable", "reasons": reasons}


def compare(request: ComparisonRequest, store=None):
    store = store if store is not None else registry
    inputs = input_snapshot(request)
    reviewed = review_valid(request, inputs)
    prior = None
    if request.prior_comparison_id:
        prior = store.get(request.prior_comparison_id)
        if prior is None:
            raise ComparisonError("The earlier comparison is unavailable on this local server. Keep local evidence; explicitly compare again without prior_comparison_id to create new evaluations.")
        previous = prior["payload"]["input_snapshot"]
        if canonical({k: v for k, v in previous.items() if k != "goal"}) != canonical({k: v for k, v in inputs.items() if k != "goal"}):
            raise ComparisonError("Only goal changes can reuse this comparison. Inputs or limits changed; explicitly compare again to create new evaluations.")
        if prior["payload"]["review_status"] != ("reviewed" if reviewed else "unreviewed"):
            raise ComparisonError("Review status changed; explicitly compare again to create reviewed evaluations.")
    evaluations = prior["payload"]["evaluations"] if prior else [evaluate(inputs, s, reviewed, request.review.reviewed_at if request.review else None) for s in inputs["scenarios"]]
    compatible = compatibility(inputs)
    ranks = []
    terms = [inputs["goal"], *inputs["goal"]["secondary"]]
    keys = {}
    for e in evaluations:
        reasons = []
        if not reviewed:
            reasons.append("Review the current input snapshot before this scenario is eligible.")
        if compatible["status"] != "comparable":
            reasons.extend(compatible["reasons"])
        reasons.extend(c["reason"] for c in e["constraints"] if c["status"] in ("fail", "unknown"))
        for term in terms:
            m = e["metrics"][term["metric"]]
            if not m["complete"]:
                reasons.append(f"Objective {term['metric']} requires a complete value; known subtotals are ineligible.")
        value = e["metrics"][inputs["goal"]["metric"]]["value"]
        eligible = not reasons
        ranks.append({"scenario_id": e["scenario_id"], "evaluation_id": e["id"], "eligible": eligible, "rank": None, "value": value, "reasons": reasons})
        if eligible:
            keys[e["scenario_id"]] = tuple(dec(e["metrics"][t["metric"]]["value"]) * (-1 if t["direction"] == "maximize" else 1) for t in terms)
    ordered = sorted(keys, key=lambda i: (keys[i], i))
    for row in ranks:
        if row["eligible"]:
            row["rank"] = 1 + sum(keys[i] < keys[row["scenario_id"]] for i in ordered)
    preferred = [r["scenario_id"] for r in ranks if r["rank"] == 1]
    incomplete = compatible["status"] != "comparable" or not reviewed or any(e["feasibility"] == "unknown" or any(c["status"] == "unknown" for c in e["constraints"]) or not e["metrics"][inputs["goal"]["metric"]]["complete"] for e in evaluations)
    baseline_id = next(s["id"] for s in inputs["scenarios"] if s["role"] == "current")
    baseline = next(e for e in evaluations if e["scenario_id"] == baseline_id)
    differences = []
    for e in evaluations:
        values = {}
        for key, m in e["metrics"].items():
            b = baseline["metrics"][key]["value"]
            values[key] = float(dec(m["value"]) - dec(b)) if m["value"] is not None and b is not None else None
        differences.append({"scenario_id": e["scenario_id"], "direction": "scenario_minus_current", "metrics": values})
    names = {s["id"]: s["name"] for s in inputs["scenarios"]}
    goal_labels = {"output_kg": "conditional marketable output", "energy_kwh": "energy use", "recurring_cash_usd": "recurring cash", "horizon_cash_usd": "horizon cash", "horizon_cash_per_kg": "horizon cash per conditional kilogram"}
    goal_unit = METRIC_UNITS[inputs["goal"]["metric"]]
    preferred_value = next((r["value"] for r in ranks if r["rank"] == 1), None)
    eligible_count = sum(r["eligible"] for r in ranks)
    explanation = (", ".join(names[i] for i in preferred) + (" tie as best" if len(preferred) > 1 else " is best") +
                   f" for {inputs['goal']['direction']} {goal_labels[inputs['goal']['metric']]}: {preferred_value:g} {goal_unit} among {eligible_count} eligible entered scenarios. " if preferred else "No scenario is eligible for the selected goal. ")
    if len(preferred) == 1:
        delta = next(d["metrics"] for d in differences if d["scenario_id"] == preferred[0])
        changes = []
        for key, unit, positive, negative in (("energy_kwh", "kWh", "additional consumption", "less consumption"), ("output_kg", "kg", "more conditional output", "less conditional output"), ("horizon_cash_usd", "USD", "additional scoped cash", "less scoped cash")):
            difference = delta[key]
            if difference is None:
                changes.append(f"{goal_labels.get(key, key)} difference unknown")
            elif difference == 0:
                changes.append(f"no change in {goal_labels.get(key, key)}")
            else:
                changes.append(f"{abs(difference):g} {unit} {positive if difference > 0 else negative}")
        explanation += f"Against the current operation over {inputs['operation']['horizon_days']} days: " + ", ".join(changes) + ". "
    rejected = [r for r in ranks if not r["eligible"]]
    if rejected:
        explanation += "Not eligible: " + "; ".join(f"{names[r['scenario_id']]}: {r['reasons'][0]}" for r in rejected) + " "
    if incomplete:
        explanation += "Comparison incomplete: required unknowns, review or incompatible boundaries remain. "
    explanation += "Differences are scenario minus current. Output is conditional benchmark bookkeeping, not predicted yield; this is not a physical or biological optimum."
    input_json = canonical(inputs)
    payload = {"id": str(uuid4()), "created_at": now(), "parent_id": request.prior_comparison_id,
               "accounting_version": ACCOUNTING_VERSION, "benchmark_version": BENCHMARK_VERSION, "lighting_model_version": core.MODEL_VERSION,
               "input_snapshot": inputs, "input_canonical_json": input_json, "input_sha256": digest(input_json),
               "review_status": "reviewed" if reviewed else "unreviewed", "baseline_scenario_id": baseline_id,
               "evaluations": evaluations, "reused_evaluations": prior is not None, "compatibility": compatible, "ranks": ranks,
               "preferred_scenario_ids": preferred, "comparison_incomplete": incomplete, "scenario_count": len(evaluations),
               "feasible_count": sum(e["feasibility"] == "pass" for e in evaluations), "differences": differences,
               "explanation": explanation, "limitations": list(LIMITATIONS)}
    encoded = canonical(payload)
    artifact = {"schema_version": SCHEMA_VERSION, "canonicalization": CANONICALIZATION, "payload": payload, "canonical_json": encoded, "sha256": digest(encoded)}
    store.add(artifact)
    return artifact


def verify(comparison_id, sha256, store=None):
    store = store if store is not None else registry
    artifact = store.get(comparison_id)
    status = "unavailable" if artifact is None else "available" if artifact["sha256"] == sha256 else "mismatch"
    messages = {"unavailable": "This comparison is not available in this local server process. Local evidence may still be read; no recalculation was performed.", "mismatch": "The supplied digest does not match the stored comparison. Preserve the original local evidence and inspect its identity.", "available": "The exact comparison digest is available on this local server. This checks content consistency, not measured truth or durable storage."}
    modules = [{"id": e["module_result"]["run"]["id"], "available": get_run(e["module_result"]["run"]["id"]) is not None} for e in artifact["payload"]["evaluations"] if e["module_result"]] if status == "available" else []
    return {"comparison_id": comparison_id, "checked_at": now(), "status": status, "message": messages[status], "module_runs": modules}
