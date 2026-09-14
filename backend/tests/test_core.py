import math

import pytest
from pydantic import ValidationError

from backend.core import SAMPLE, Scenario, calculate, daily_energy, solve
from backend.schemas import OptimizationResult


def scenario(**changes):
    return Scenario.model_validate({**SAMPLE, "confirmed": True, **changes})


def test_sample_has_reproducible_counts_and_energy():
    result = solve(scenario())
    OptimizationResult.model_validate(result)
    assert result["baseline"]["daily_energy_kwh"] == 10.68
    assert result["optimized"]["photoperiod_hours"] == 12
    assert result["optimized"]["dli_mol_m2_day"] == 15.12
    assert result["savings"]["period_energy_kwh"] == 876
    assert result["savings"]["period_energy_cost_usd"] == 131.4
    assert result["configurations_evaluated"] == len(result["candidates"]) == 33
    assert result["feasible_configurations"] == sum(c["feasible"] for c in result["candidates"]) == 25


@pytest.mark.parametrize("changes", [{"confirmed": False}, {"ppfd_full": None}, {"min_dli": None}])
def test_unknown_or_unconfirmed_inputs_do_not_invent_savings(changes):
    result = solve(scenario(**changes))
    assert result["status"] == "needs_measurement"
    assert result["optimized"] is result["savings"] is None
    assert result["candidates"] == []
    assert result["configurations_evaluated"] == result["feasible_configurations"] == 0


@pytest.mark.parametrize("changes,reason", [
    ({"min_dli": 100}, "minimum_dli"),
    ({"power_limit_watts": 100}, "modeled_power_limit"),
])
def test_infeasible_search_reports_real_reasons(changes, reason):
    result = solve(scenario(**changes))
    assert result["status"] == "no_feasible_configuration"
    assert result["optimized"] is result["savings"] is None
    assert result["feasible_configurations"] == 0
    assert result["configurations_evaluated"] == len(result["candidates"]) > 0
    assert all(reason in c["rejected_for"] for c in result["candidates"])


def test_off_grid_baseline_is_retained_and_no_more_expensive_result_is_chosen():
    s = scenario(dimmable=True, baseline_hours=12.13, baseline_dim=0.43, min_dli=6)
    result = solve(s)
    pairs = {(c["photoperiod_hours"], c["dim_fraction"]) for c in result["candidates"]}
    assert (12.13, 0.43) in pairs
    assert (12, 0.43) in pairs
    assert (12.13, 0.5) in pairs
    assert result["savings"]["period_energy_kwh"] >= 0
    assert len(pairs) == result["configurations_evaluated"]


def test_narrow_off_grid_bounds_are_tested():
    result = solve(scenario(min_hours=12.01, max_hours=12.02, min_dli=15))
    assert result["status"] == "optimized"
    assert result["optimized"]["photoperiod_hours"] == 12.01
    assert result["configurations_evaluated"] == 3
    baseline = next(c for c in result["candidates"] if c["photoperiod_hours"] == 16)
    assert baseline["rejected_for"] == ["photoperiod"]


def test_power_checks_exclude_inactive_load_but_conservatively_include_active_load():
    inactive = scenario(other_hours=0, other_watts=900, power_limit_watts=600)
    assert solve(inactive)["status"] == "optimized"
    assert calculate(inactive, 12, 1)["peak_modeled_watts"] == 600
    assert solve(scenario(other_hours=0.01, other_watts=900, power_limit_watts=600))["status"] == "no_feasible_configuration"


def test_constraints_can_require_more_energy_without_calling_it_savings():
    result = solve(scenario(baseline_hours=8))
    assert result["savings"]["period_energy_kwh"] < 0
    assert result["savings"]["energy_pct"] < 0
    assert "more modeled energy" in result["recommendations"][0]


def test_tiny_energy_values_do_not_use_rounded_denominator_or_ranking():
    result = solve(scenario(lighting_watts=0.00000001, other_watts=0))
    assert result["baseline"]["period_energy_kwh"] == 0
    assert result["optimized"]["photoperiod_hours"] == 12
    assert result["savings"]["energy_pct"] == 25


def test_dli_tolerance_cannot_override_a_tiny_but_unmet_requirement():
    result = solve(scenario(ppfd_full=1e-20, min_dli=1e-10))
    assert result["status"] == "no_feasible_configuration"


def test_equal_dli_and_power_limits_are_feasible():
    result = solve(scenario(min_hours=12, max_hours=12, min_dli=15.12, power_limit_watts=645))
    assert result["status"] == "optimized"
    assert result["optimized"]["photoperiod_hours"] == 12


@pytest.mark.parametrize("dim", [5e-324, 1e-310])
def test_numerically_unrepresentable_savings_are_rejected(dim):
    with pytest.raises(ValidationError):
        scenario(dimmable=True, baseline_dim=dim, other_watts=0)


@pytest.mark.parametrize("water", [None, 0, 15])
def test_water_is_only_entered_usage_and_no_yield_or_capex_is_fabricated(water):
    result = solve(scenario(water_liters_day=water))
    expected = water * 365 if water is not None else None
    assert result["baseline"]["period_water_liters"] == expected
    assert result["optimized"]["period_water_liters"] == expected
    assert result["savings"]["water_liters"] is None
    assert result["savings"]["yield_gain_lb"] is None
    assert result["savings"]["avoided_capex_usd"] is None
    assert result["savings"]["new_equipment_required_by_scenario_usd"] == 0


def test_light_count_does_not_multiply_combined_wattage():
    assert solve(scenario(light_count=1))["baseline"] == solve(scenario(light_count=100))["baseline"]


def test_every_feasible_candidate_obeys_constraints_and_selected_cost_is_minimal():
    s = scenario(dimmable=True, min_hours=8.13, max_hours=23.12, baseline_dim=0.67, baseline_hours=16.33,
                 ppfd_full=520, power_limit_watts=500)
    result = solve(s)
    assert result == solve(s)
    assert result["configurations_evaluated"] == len(result["candidates"]) <= 1200
    feasible = [c for c in result["candidates"] if c["feasible"]]
    assert len(feasible) == result["feasible_configurations"]
    for candidate in feasible:
        assert s.min_hours <= candidate["photoperiod_hours"] <= s.max_hours
        assert candidate["dli_mol_m2_day"] >= s.min_dli - 1e-6
        assert candidate["peak_modeled_watts"] <= s.power_limit_watts
        assert candidate["rejected_for"] == []
    best = result["optimized"]
    assert daily_energy(s, best["photoperiod_hours"], best["dim_fraction"]) == min(
        daily_energy(s, c["photoperiod_hours"], c["dim_fraction"]) for c in feasible)


@pytest.mark.parametrize("changes", [
    {"length_ft": 0}, {"length_ft": math.inf}, {"ppfd_full": math.nan}, {"length_ft": True},
    {"light_count": 1.5}, {"light_count": True}, {"confirmed": "true"}, {"lighting_watts": "600"},
    {"canopy_sqft": 65}, {"min_hours": 19}, {"baseline_dim": 0.5}, {"invented_yield": 100},
])
def test_invalid_scenarios_fail_without_coercion(changes):
    with pytest.raises(ValidationError):
        scenario(**changes)
