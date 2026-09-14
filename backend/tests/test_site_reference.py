"""Independent Decimal reference for the plan's synthetic, non-agronomic fixture.

Expected arithmetic below does not import core or the site evaluator. Production
integration tests call the evaluator only for the observed side of assertions.
"""

from dataclasses import dataclass, replace
from decimal import Decimal, localcontext
from copy import deepcopy
import json

import pytest


D = Decimal
ZERO = D("0")


@dataclass(frozen=True)
class ReferenceInputs:
    hours: Decimal
    water_day: Decimal | None
    labor_cycle: Decimal
    consumables_cycle: Decimal
    setup_hours: Decimal
    benchmark_cycle: Decimal | None
    days: Decimal = D("56")
    cycles: Decimal = D("2")
    lighting_watts: Decimal = D("600")
    fan_watts: Decimal = D("45")
    fan_hours: Decimal = D("24")
    pump_watts: Decimal | None = D("30")
    pump_hours: Decimal | None = D("8")
    climate_watts: Decimal | None = D("200")
    climate_hours: Decimal | None = D("4")
    ppfd: Decimal | None = D("350")
    electricity_rate: Decimal | None = D("0.20")
    water_rate: Decimal | None = D("0.002")
    labor_rate: Decimal = D("20")
    maintenance_cycle: Decimal | None = D("4")
    benchmark_applicable: bool = True


REFERENCE = {
    "A": ReferenceInputs(D("16"), D("15"), D("8"), D("25"), ZERO, D("24")),
    "B": ReferenceInputs(D("12"), D("14"), D("8"), D("25"), D("0.5"), D("20")),
    "C": ReferenceInputs(D("18"), D("16"), D("9"), D("28"), D("1.5"), D("30")),
}


def independent_reference(inputs: ReferenceInputs) -> dict[str, Decimal | None]:
    """Exact entered quantities, deliberately separate from production formulas."""
    with localcontext() as context:
        context.prec = 40
        p = inputs
        module_day = (p.lighting_watts * p.hours + p.fan_watts * p.fan_hours) / D("1000")
        external_terms = [
            watts * hours / D("1000") if watts is not None and hours is not None else None
            for watts, hours in [(p.pump_watts, p.pump_hours), (p.climate_watts, p.climate_hours)]
        ]
        energy_subtotal = (module_day + sum((term for term in external_terms if term is not None), ZERO)) * p.days
        energy = energy_subtotal if all(term is not None for term in external_terms) else None
        peak_subtotal = p.lighting_watts + (p.fan_watts if p.fan_hours else ZERO)
        for watts, hours in [(p.pump_watts, p.pump_hours), (p.climate_watts, p.climate_hours)]:
            if watts is not None and hours is not None and hours > ZERO:
                peak_subtotal += watts
        peak = peak_subtotal if all(term is not None for term in external_terms) else None
        output = p.benchmark_cycle * p.cycles if p.benchmark_applicable and p.benchmark_cycle is not None else None
        water = p.water_day * p.days if p.water_day is not None else None
        electricity = energy * p.electricity_rate if energy is not None and p.electricity_rate is not None else None
        electricity_subtotal = energy_subtotal * p.electricity_rate if p.electricity_rate is not None else ZERO
        water_cash = water * p.water_rate if water is not None and p.water_rate is not None else None
        labor_cash = p.labor_cycle * p.cycles * p.labor_rate
        consumables = p.consumables_cycle * p.cycles
        maintenance = p.maintenance_cycle * p.cycles if p.maintenance_cycle is not None else None
        recurring_terms = [electricity, water_cash, labor_cash, consumables, maintenance]
        recurring_subtotal = electricity_subtotal + sum((cost for cost in recurring_terms[1:] if cost is not None), ZERO)
        recurring = recurring_subtotal if all(cost is not None for cost in recurring_terms) else None
        setup = p.setup_hours * p.labor_rate
        horizon = recurring + setup if recurring is not None else None
        ratio = lambda numerator: numerator / output if numerator is not None and output is not None and output > ZERO else None
        return {
            "module_daily_kwh": module_day,
            "module_period_kwh": module_day * p.days,
            "module_peak_watts": p.lighting_watts + p.fan_watts,
            "energy_kwh": energy, "energy_known_subtotal": energy_subtotal,
            "peak_watts": peak,
            "peak_known_subtotal": peak_subtotal,
            "dli": p.ppfd * p.hours * D("0.0036") if p.ppfd is not None else None,
            "output_kg": output, "water_liters": water,
            "electricity_usd": electricity, "water_usd": water_cash,
            "electricity_known_subtotal": electricity_subtotal,
            "routine_labor_usd": labor_cash, "consumables_usd": consumables,
            "maintenance_usd": maintenance, "new_equipment_usd": ZERO,
            "new_setup_cash_usd": setup, "recurring_cash_usd": recurring,
            "recurring_known_subtotal": recurring_subtotal,
            "horizon_cash_usd": horizon, "horizon_known_subtotal": recurring_subtotal + setup,
            "work_hours": p.labor_cycle * p.cycles + p.setup_hours,
            "energy_per_kg": ratio(energy), "water_per_kg": ratio(water),
            "recurring_cash_per_kg": ratio(recurring), "horizon_cash_per_kg": ratio(horizon),
        }


DOCUMENTED = {
    "module_daily_kwh": ("10.68", "8.28", "11.88"),
    "module_period_kwh": ("598.08", "463.68", "665.28"),
    "module_peak_watts": ("645", "645", "645"),
    "energy_kwh": ("656.32", "521.92", "723.52"),
    "peak_watts": ("875", "875", "875"),
    "dli": ("20.16", "15.12", "22.68"),
    "output_kg": ("48", "40", "60"),
    "water_liters": ("840", "784", "896"),
    "electricity_usd": ("131.264", "104.384", "144.704"),
    "water_usd": ("1.680", "1.568", "1.792"),
    "routine_labor_usd": ("320", "320", "360"),
    "consumables_usd": ("50", "50", "56"),
    "maintenance_usd": ("8", "8", "8"),
    "new_equipment_usd": ("0", "0", "0"),
    "new_setup_cash_usd": ("0", "10", "30"),
    "recurring_cash_usd": ("510.944", "483.952", "570.496"),
    "horizon_cash_usd": ("510.944", "493.952", "600.496"),
    "work_hours": ("16", "16.5", "19.5"),
}


@pytest.mark.parametrize("label,index", [("A", 0), ("B", 1), ("C", 2)])
def test_decimal_reference_matches_documented_arithmetic(label, index):
    reference = independent_reference(REFERENCE[label])
    for metric, values in DOCUMENTED.items():
        assert reference[metric] == D(values[index]), metric
    assert reference["energy_known_subtotal"] == reference["energy_kwh"]
    assert reference["recurring_known_subtotal"] == reference["recurring_cash_usd"]
    assert reference["horizon_known_subtotal"] == reference["horizon_cash_usd"]


@pytest.mark.parametrize("metric,expected", [
    ("energy_per_kg", ("13.673333", "13.048000", "12.058667")),
    ("water_per_kg", ("17.500000", "19.600000", "14.933333")),
    ("recurring_cash_per_kg", ("10.644667", "12.098800", "9.508267")),
    ("horizon_cash_per_kg", ("10.644667", "12.348800", "10.008267")),
])
def test_decimal_reference_intensities(metric, expected):
    assert tuple(independent_reference(p)[metric].quantize(D("0.000001")) for p in REFERENCE.values()) == tuple(map(D, expected))


def test_decimal_reference_differences_are_scenario_minus_current():
    rows = {key: independent_reference(p) for key, p in REFERENCE.items()}
    for key, energy, cash, output in [("A", "0", "0", "0"), ("B", "-134.4", "-16.992", "-8"), ("C", "67.2", "89.552", "12")]:
        assert rows[key]["energy_kwh"] - rows["A"]["energy_kwh"] == D(energy)
        assert rows[key]["horizon_cash_usd"] - rows["A"]["horizon_cash_usd"] == D(cash)
        assert rows[key]["output_kg"] - rows["A"]["output_kg"] == D(output)


def test_decimal_reference_sensitivities_and_no_fabricated_denominators():
    changed = independent_reference(replace(REFERENCE["C"], hours=D("17"), benchmark_applicable=False))
    assert changed["energy_kwh"] == D("689.92")
    assert changed["dli"] == D("21.42")
    assert changed["output_kg"] is None and changed["horizon_cash_per_kg"] is None
    climate = independent_reference(replace(REFERENCE["C"], climate_hours=D("6"), benchmark_applicable=False))
    assert climate["energy_kwh"] == D("745.92")
    assert climate["horizon_cash_usd"] == D("604.976")
    assert climate["output_kg"] is None
    missing = independent_reference(replace(REFERENCE["C"], maintenance_cycle=None))
    assert missing["recurring_known_subtotal"] == D("562.496")
    assert missing["horizon_known_subtotal"] == D("592.496")
    assert missing["horizon_cash_usd"] is None and missing["horizon_cash_per_kg"] is None
    zero = independent_reference(replace(REFERENCE["C"], benchmark_cycle=ZERO))
    assert zero["output_kg"] == ZERO
    assert all(zero[key] is None for key in ["energy_per_kg", "water_per_kg", "recurring_cash_per_kg", "horizon_cash_per_kg"])
    assert D("45") * D("24") * D("56") / D("1000") == D("60.48")


def test_decimal_reference_output_stress_and_break_even_are_not_forecasts():
    stressed = [independent_reference(replace(p, benchmark_cycle=p.benchmark_cycle * D("0.9"))) for p in REFERENCE.values()]
    assert [r["output_kg"] for r in stressed] == [D("43.2"), D("36"), D("54")]
    assert [r["output_kg"] >= D("44") for r in stressed] == [False, False, True]
    with localcontext() as context:
        context.prec = 40
        a, c = independent_reference(REFERENCE["A"]), independent_reference(REFERENCE["C"])
        break_even_per_cycle = c["horizon_cash_usd"] / a["horizon_cash_per_kg"] / D("2")
        assert break_even_per_cycle.quantize(D("0.000001")) == D("28.206426")


@pytest.fixture
def site_fixture():
    from backend.site_fixture import fixture

    inputs = fixture()
    inputs.pop("review", None)
    inputs.pop("prior_comparison_id", None)
    return inputs


def evaluate_fixture(inputs, *, prior=None, store=None):
    # Production imports are confined to the actual-output adapter, never the oracle.
    from backend.site_comparison import compare
    from backend.site_schemas import ComparisonRequest

    request = ComparisonRequest.model_validate({
        **inputs,
        "review": {"snapshot_json": json.dumps(inputs), "reviewed_at": "2026-09-13T00:00:00Z"},
        "prior_comparison_id": prior,
    })
    return compare(request, store=store)


def evaluated_rows(artifact):
    return {row["scenario_id"].removeprefix("fixture-"): row for row in artifact["payload"]["evaluations"]}


def scenario(inputs, label="C"):
    return next(s for s in inputs["scenarios"] if s["id"] == f"fixture-{label}")


def cost(inputs, category, label="C"):
    return next(c for c in scenario(inputs, label)["costs"] if c["category"] == category)


def load(inputs, asset, label="C"):
    return next(l for l in scenario(inputs, label)["loads"] if l["asset_id"] == f"fixture-{asset}")


def assert_decimal(actual, expected, label=""):
    if expected is None:
        assert actual is None, label
    else:
        assert actual is not None, label
        assert abs(D(str(actual)) - expected) <= D("0.0000000005"), (label, actual, str(expected))


def assert_reference_metrics(row, reference):
    keys = ("energy_kwh", "peak_watts", "dli", "output_kg", "water_liters", "work_hours", "new_setup_cash_usd",
            "recurring_cash_usd", "horizon_cash_usd", "energy_per_kg", "water_per_kg", "recurring_cash_per_kg", "horizon_cash_per_kg")
    for key in keys:
        assert_decimal(row["metrics"][key]["value"], reference[key], key)
    for key, expected_key in [("energy_kwh", "energy_known_subtotal"), ("peak_watts", "peak_known_subtotal"),
                              ("recurring_cash_usd", "recurring_known_subtotal"), ("horizon_cash_usd", "horizon_known_subtotal")]:
        assert_decimal(row["metrics"][key]["known_subtotal"], reference[expected_key], expected_key)


def outcome(row, metric):
    return next(c for c in row["constraints"] if c["metric"] == metric)


def test_evaluator_matches_independent_reference_at_requested_not_optimized_settings(site_fixture):
    before = deepcopy(site_fixture)
    artifact = evaluate_fixture(site_fixture)
    payload = artifact["payload"]
    assert site_fixture == before
    assert payload["scenario_count"] == 3
    assert payload["feasible_count"] == 2
    assert payload["preferred_scenario_ids"] == ["fixture-C"]
    assert not payload["comparison_incomplete"]
    rows = evaluated_rows(artifact)
    for label, inputs in REFERENCE.items():
        row = rows[label]
        reference = independent_reference(inputs)
        assert_reference_metrics(row, reference)
        assert row["provenance"] == "synthetic_fixture"
        assert row["requested_setting"]["hours"] == float(inputs.hours)
        assert row["requested_setting"]["candidate_id"] == f"h{inputs.hours}-d1"
        module = row["module_result"]
        assert module["run"]["input_snapshot"]["baseline_hours"] == float(inputs.hours)
        assert module["run"]["input_snapshot"]["light_count"] == 2
        assert module["run"]["input_snapshot"]["lighting_watts"] == 600
        assert_decimal(module["baseline"]["period_energy_kwh"], reference["module_period_kwh"])
        assert_decimal(module["baseline"]["peak_modeled_watts"], reference["module_peak_watts"])
        assert module["optimized"]["photoperiod_hours"] == 12
        assert module["configurations_evaluated"] == 33
        assert module["feasible_configurations"] == 25
        assert row["applicability"]["status"] == "pass"
        assert row["feasibility"] == ("fail" if label == "B" else "pass")
        assert len(row["constraints"]) == 8
        costs = {line["category"]: line for line in row["cost_lines"]}
        for category, metric in [("electricity", "electricity_usd"), ("water", "water_usd"), ("routine_labor", "routine_labor_usd"),
                                 ("consumables", "consumables_usd"), ("maintenance", "maintenance_usd"), ("new_equipment", "new_equipment_usd")]:
            assert_decimal(costs[category]["value"], reference[metric], category)
        component_ids = [component for line in row["usage_lines"] for component in line["component_ids"]]
        assert len(component_ids) == len(set(component_ids))
        assert not set(row["module_included_components"]) & set(row["module_excluded_components"])
        assert_decimal(row["metrics"]["energy_kwh"]["value"] - module["baseline"]["period_energy_kwh"], D("58.24"))
    b_failure = outcome(rows["B"], "output_kg")
    assert b_failure["status"] == "fail" and b_failure["value"] == 40 and b_failure["minimum"] == 44
    for difference in payload["differences"]:
        label = difference["scenario_id"].removeprefix("fixture-")
        assert difference["direction"] == "scenario_minus_current"
        for metric in ["energy_kwh", "horizon_cash_usd", "output_kg"]:
            assert_decimal(difference["metrics"][metric], independent_reference(REFERENCE[label])[metric] - independent_reference(REFERENCE["A"])[metric])


@pytest.mark.parametrize("metric,direction,winner", [
    ("output_kg", "maximize", "C"), ("recurring_cash_usd", "minimize", "A"),
    ("horizon_cash_usd", "minimize", "A"), ("energy_kwh", "minimize", "A"), ("horizon_cash_per_kg", "minimize", "C"),
])
def test_goal_changes_use_same_evaluations_and_independent_reference(site_fixture, metric, direction, winner):
    from backend.site_comparison import ComparisonRegistry

    store = ComparisonRegistry()
    original = evaluate_fixture(site_fixture, store=store)
    changed = deepcopy(site_fixture)
    changed["goal"].update(id=f"reference-{metric}", metric=metric, direction=direction)
    reranked = evaluate_fixture(changed, prior=original["payload"]["id"], store=store)
    assert reranked["payload"]["id"] != original["payload"]["id"]
    assert reranked["payload"]["reused_evaluations"]
    assert reranked["payload"]["evaluations"] == original["payload"]["evaluations"]
    assert reranked["payload"]["preferred_scenario_ids"] == [f"fixture-{winner}"]
    assert next(r for r in reranked["payload"]["ranks"] if r["scenario_id"] == "fixture-B")["rank"] is None


@pytest.mark.parametrize("change,overrides,applicability", [
    ("schedule", {"hours": D("17"), "benchmark_applicable": False}, "fail"),
    ("climate", {"climate_hours": D("6"), "benchmark_applicable": False}, "fail"),
    ("maintenance", {"maintenance_cycle": None}, "pass"),
    ("ppfd", {"ppfd": None, "benchmark_applicable": False}, "unknown"),
    ("min_dli", {"benchmark_applicable": False}, "unknown"),
    ("water", {"water_day": None, "benchmark_applicable": False}, "unknown"),
    ("tariff", {"electricity_rate": None, "benchmark_applicable": False}, "unknown"),
    ("pump_watts", {"pump_watts": None, "benchmark_applicable": False}, "unknown"),
    ("pump_duty", {"pump_hours": None, "benchmark_applicable": False}, "unknown"),
    ("climate_watts", {"climate_watts": None, "benchmark_applicable": False}, "unknown"),
    ("climate_duty", {"climate_hours": None, "benchmark_applicable": False}, "unknown"),
])
def test_changed_or_missing_inputs_match_independent_partial_reference(site_fixture, change, overrides, applicability):
    changed = deepcopy(site_fixture)
    c = scenario(changed)
    c["revision"] += 1
    if change == "schedule":
        c["lighting"]["hours_per_day"] = 17
        load(changed, "lights")["hours_per_day"] = 17
    elif change == "climate":
        load(changed, "climate")["hours_per_day"] = 6
    elif change in ("maintenance", "tariff"):
        cost(changed, "electricity" if change == "tariff" else change).update(status="unknown", rate=None)
    elif change in ("ppfd", "min_dli"):
        c["lighting"]["ppfd_full" if change == "ppfd" else change] = None
    elif change == "water":
        c["water_liters_day"] = None
    elif change in ("pump_watts", "climate_watts"):
        next(a for a in changed["assets"] if a["id"] == f"fixture-{change.split('_')[0]}")["watts"] = None
    elif change in ("pump_duty", "climate_duty"):
        load(changed, change.split("_")[0])["hours_per_day"] = None
    artifact = evaluate_fixture(changed)
    row = evaluated_rows(artifact)["C"]
    assert_reference_metrics(row, independent_reference(replace(REFERENCE["C"], **overrides)))
    assert row["applicability"]["status"] == applicability
    assert not next(r for r in artifact["payload"]["ranks"] if r["scenario_id"] == "fixture-C")["eligible"]
    assert artifact["payload"]["comparison_incomplete"]
    if change in ("ppfd", "min_dli"):
        assert row["module_status"] == "needs_measurement"
        assert row["module_result"]["optimized"] is None
        assert row["module_result"]["candidates"] == []
    if change == "maintenance":
        assert artifact["payload"]["preferred_scenario_ids"] == ["fixture-A"]
        assert outcome(row, "horizon_cash_usd")["status"] == "unknown"
    if change == "tariff":
        assert row["metrics"]["energy_kwh"]["complete"]
        assert row["module_result"] is None


def test_unknown_maintenance_cannot_hide_a_known_cash_limit_breach(site_fixture):
    cost(site_fixture, "maintenance").update(status="unknown", rate=None)
    next(limit for limit in site_fixture["limits"] if limit["metric"] == "horizon_cash_usd")["maximum"] = 590
    artifact = evaluate_fixture(site_fixture)
    row = evaluated_rows(artifact)["C"]
    expected = independent_reference(replace(REFERENCE["C"], maintenance_cycle=None))
    assert_decimal(row["metrics"]["horizon_cash_usd"]["known_subtotal"], expected["horizon_known_subtotal"])
    assert expected["horizon_known_subtotal"] > D("590")
    assert outcome(row, "horizon_cash_usd")["status"] == "fail"
    assert "subtotal" in outcome(row, "horizon_cash_usd")["reason"].lower()
    assert row["metrics"]["horizon_cash_usd"]["value"] is None


@pytest.mark.parametrize("metric,bound,threshold,expected_winner", [
    ("peak_watts", "maximum", 800, []), ("output_kg", "minimum", 65, []),
    ("new_setup_cash_usd", "maximum", 20, ["fixture-A"]),
])
def test_actual_reference_values_drive_hard_limit_outcomes(site_fixture, metric, bound, threshold, expected_winner):
    next(limit for limit in site_fixture["limits"] if limit["metric"] == metric)[bound] = threshold
    artifact = evaluate_fixture(site_fixture)
    assert artifact["payload"]["preferred_scenario_ids"] == expected_winner
    for label, row in evaluated_rows(artifact).items():
        value = independent_reference(REFERENCE[label])[metric]
        assert_decimal(outcome(row, metric)["value"], value)
        passed = value <= D(str(threshold)) if bound == "maximum" else value >= D(str(threshold))
        assert outcome(row, metric)["status"] == ("pass" if passed else "fail")
    if not expected_winner:
        assert artifact["payload"]["feasible_count"] == 0


def test_output_stress_uses_new_explicit_assumptions_not_a_response_curve(site_fixture):
    for label in REFERENCE:
        benchmark = scenario(site_fixture, label)["benchmark"]
        benchmark["kg_per_cycle"] = float(REFERENCE[label].benchmark_cycle * D("0.9"))
        benchmark["version"] += 1
    artifact = evaluate_fixture(site_fixture)
    assert artifact["payload"]["preferred_scenario_ids"] == ["fixture-C"]
    assert artifact["payload"]["feasible_count"] == 1
    for label, row in evaluated_rows(artifact).items():
        assert_reference_metrics(row, independent_reference(replace(REFERENCE[label], benchmark_cycle=REFERENCE[label].benchmark_cycle * D("0.9"))))


def test_zero_output_keeps_usage_cash_known_and_intensities_null(site_fixture):
    scenario(site_fixture)["benchmark"].update(kg_per_cycle=0, version=2)
    artifact = evaluate_fixture(site_fixture)
    row = evaluated_rows(artifact)["C"]
    assert_reference_metrics(row, independent_reference(replace(REFERENCE["C"], benchmark_cycle=ZERO)))
    assert outcome(row, "output_kg")["status"] == "fail"
    assert artifact["payload"]["preferred_scenario_ids"] == ["fixture-A"]


@pytest.mark.parametrize("target,key,value", [("operation", "temperature_c", 24), ("operation", "crop", "basil"),
    ("operation", "cultivar", "different-cultivar"), ("operation", "start_stage", "seed"), ("site", "canopy_sqft", 40)])
def test_changed_context_withholds_output_without_changing_energy_bookkeeping(site_fixture, target, key, value):
    site_fixture[target][key] = value
    artifact = evaluate_fixture(site_fixture)
    row = evaluated_rows(artifact)["C"]
    assert row["applicability"]["status"] == "fail"
    assert any(c["path"] == f"{target}.{key}" and c["status"] == "fail" for c in row["applicability"]["checks"])
    assert_reference_metrics(row, independent_reference(replace(REFERENCE["C"], benchmark_applicable=False)))
    assert artifact["payload"]["preferred_scenario_ids"] == []


def test_incompatible_55_day_horizon_does_not_prorate_harvest(site_fixture):
    site_fixture["operation"]["horizon_days"] = 55
    artifact = evaluate_fixture(site_fixture)
    assert artifact["payload"]["compatibility"]["status"] == "not_comparable"
    assert artifact["payload"]["preferred_scenario_ids"] == []
    for label, row in evaluated_rows(artifact).items():
        expected = independent_reference(replace(REFERENCE[label], days=D("55"), benchmark_applicable=False))
        assert_reference_metrics(row, expected)
        assert row["metrics"]["output_kg"]["value"] is None


def test_duplicate_fan_is_rejected_not_added_to_the_reference_total(site_fixture):
    from pydantic import ValidationError

    duplicate = deepcopy(load(site_fixture, "fan"))
    duplicate.update(id="reference-duplicate-fan", accounting="external")
    scenario(site_fixture)["loads"].append(duplicate)
    with pytest.raises(ValidationError, match="Duplicate load"):
        evaluate_fixture(site_fixture)
    assert independent_reference(REFERENCE["C"])["energy_kwh"] + D("60.48") == D("784.00")


def test_equivalent_aggregate_and_per_unit_asset_bases_do_not_double_count(site_fixture):
    original = evaluate_fixture(site_fixture)
    changed = deepcopy(site_fixture)
    lights = next(a for a in changed["assets"] if a["id"] == "fixture-lights")
    assert lights["power_basis"] == "aggregate" and lights["watts"] == 600 and lights["quantity"] == 2
    lights.update(power_basis="per_unit", watts=300, quantity=2)
    # This is a newly reviewed equivalent representation, not a changed physical load.
    for s in changed["scenarios"]:
        context_lights = next(a for a in s["benchmark"]["context"]["assets"] if a["id"] == "fixture-lights")
        context_lights.update(power_basis="per_unit", watts=300, quantity=2)
        s["benchmark"]["version"] += 1
    aggregate = evaluate_fixture(changed)
    for label, row in evaluated_rows(aggregate).items():
        assert_reference_metrics(row, independent_reference(REFERENCE[label]))
        assert row["metrics"] == evaluated_rows(original)[label]["metrics"]


def test_equal_output_benchmarks_tie_until_an_explicit_secondary_goal(site_fixture):
    from backend.site_comparison import ComparisonRegistry

    scenario(site_fixture)["benchmark"].update(kg_per_cycle=24, version=2)
    site_fixture["scenarios"].reverse()
    store = ComparisonRegistry()
    tied = evaluate_fixture(site_fixture, store=store)
    c = evaluated_rows(tied)["C"]
    assert_reference_metrics(c, independent_reference(replace(REFERENCE["C"], benchmark_cycle=D("24"))))
    assert set(tied["payload"]["preferred_scenario_ids"]) == {"fixture-A", "fixture-C"}
    assert {r["scenario_id"]: r["rank"] for r in tied["payload"]["ranks"]} == {"fixture-A": 1, "fixture-B": None, "fixture-C": 1}
    site_fixture["goal"]["secondary"] = [{"metric": "energy_kwh", "direction": "minimize"}]
    reranked = evaluate_fixture(site_fixture, prior=tied["payload"]["id"], store=store)
    assert reranked["payload"]["preferred_scenario_ids"] == ["fixture-A"]
    assert reranked["payload"]["evaluations"] == tied["payload"]["evaluations"]


def test_unknown_clearance_does_not_invalidate_arithmetic_or_become_a_schematic_pass(site_fixture):
    limit = deepcopy(site_fixture["limits"][0])
    limit.update(id="reference-clearance", metric="layout_feasibility", minimum=1, maximum=None, unit="boolean")
    site_fixture["limits"].append(limit)
    artifact = evaluate_fixture(site_fixture)
    assert artifact["payload"]["preferred_scenario_ids"] == []
    assert artifact["payload"]["comparison_incomplete"]
    for label, row in evaluated_rows(artifact).items():
        assert_reference_metrics(row, independent_reference(REFERENCE[label]))
        assert outcome(row, "layout_feasibility")["status"] == "unknown"


def test_exact_cash_boundary_uses_raw_amount_not_two_decimal_display(site_fixture):
    limit = next(limit for limit in site_fixture["limits"] if limit["metric"] == "horizon_cash_usd")
    limit["maximum"] = 600.496
    row = evaluated_rows(evaluate_fixture(site_fixture))["C"]
    assert_decimal(outcome(row, "horizon_cash_usd")["value"], independent_reference(REFERENCE["C"])["horizon_cash_usd"])
    assert outcome(row, "horizon_cash_usd")["status"] == "pass"
    limit["maximum"] = 600.495
    row = evaluated_rows(evaluate_fixture(site_fixture))["C"]
    assert outcome(row, "horizon_cash_usd")["status"] == "fail"


@pytest.mark.parametrize("change", ["different-site", "different-grade", "dry-weight"])
def test_incompatible_identity_or_product_never_reuses_conditional_output(site_fixture, change):
    if change == "different-site":
        site_fixture["site"]["id"] = "reference-other-site"
        site_fixture["operation"]["site_id"] = "reference-other-site"
        for asset in site_fixture["assets"]:
            asset["site_id"] = "reference-other-site"
    elif change == "different-grade":
        site_fixture["operation"]["product_definition"] = "Ungraded fresh biomass including roots and rejects"
    else:
        from pydantic import ValidationError

        site_fixture["operation"]["output_unit"] = "kg_dry_weight"
        with pytest.raises(ValidationError, match="output_unit"):
            evaluate_fixture(site_fixture)
        return
    artifact = evaluate_fixture(site_fixture)
    assert artifact["payload"]["preferred_scenario_ids"] == []
    for label, row in evaluated_rows(artifact).items():
        assert row["applicability"]["status"] == "fail"
        assert_reference_metrics(row, independent_reference(replace(REFERENCE[label], benchmark_applicable=False)))
