from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID

import pytest

from backend import core, run_evidence
from backend.schemas import OptimizationResult, RunArtifact


def scenario(**changes):
    return core.Scenario.model_validate({**core.SAMPLE, "confirmed": True, **changes})


@pytest.fixture(autouse=True)
def isolated_registry(monkeypatch):
    registry = run_evidence.RunRegistry()
    monkeypatch.setattr(run_evidence, "_registry", registry)
    return registry


def test_sample_evidence_preserves_solver_and_reproducible_figures():
    s = scenario()
    before = s.model_dump()
    result = run_evidence.execute_run(s)
    assert {k: v for k, v in result.items() if k != "run"} == core.solve(s)
    assert s.model_dump() == before
    assert OptimizationResult.model_validate(result).model_dump() == result
    artifact = result["run"]
    assert artifact["input_snapshot"] == before
    assert artifact["model_version"] == core.MODEL_VERSION
    assert artifact["source"] == "sample"
    assert artifact["status"] == "optimized"
    evidence = artifact["evidence"]
    assert "Synthetic sample" in evidence["summary"]
    assert evidence["baseline"] == result["baseline"]
    assert evidence["selected"] == result["optimized"]
    assert evidence["savings"] == result["savings"]
    assert evidence["baseline"]["daily_energy_kwh"] == 10.68
    assert evidence["selected"]["daily_energy_kwh"] == 8.28
    assert evidence["selected"]["photoperiod_hours"] == 12
    assert evidence["selected"]["dli_mol_m2_day"] == 15.12
    assert evidence["savings"]["period_energy_kwh"] == 876
    assert evidence["savings"]["period_energy_cost_usd"] == 131.4
    assert evidence["savings"]["energy_pct"] == 22.47
    assert evidence["configurations_evaluated"] == 33
    assert evidence["feasible_configurations"] == 25
    assert evidence["horizon"] == {"operating_days": 365, "electricity_usd_kwh": 0.15}
    inputs = {item["field"]: item for item in evidence["inputs"]}
    assert {field: item["value"] for field, item in inputs.items()} == before
    assert inputs["lighting_watts"]["unit"] == "W"
    assert "combined load" in inputs["light_count"]["used_for"]
    assert evidence["missing_inputs"] == []
    assert evidence["limitations"][:-1] == result["limitations"]
    assert "Weather" in evidence["limitations"][-1]
    assert "not modeled" in evidence["limitations"][-1]
    constraints = {item["name"]: item for item in evidence["constraints"]}
    assert constraints["minimum_dli"]["rejected_configurations"] == 8
    assert all(c["baseline_passed"] and c["selected_passed"] for c in constraints.values())
    assert "candidates" not in evidence


def test_every_execution_has_a_uuid_and_utc_creation_time():
    before = datetime.now(timezone.utc)
    first = run_evidence.execute_run(scenario())["run"]
    second = run_evidence.execute_run(scenario())["run"]
    changed = run_evidence.execute_run(scenario(baseline_hours=18))["run"]
    after = datetime.now(timezone.utc)
    assert len({r["id"] for r in (first, second, changed)}) == 3
    assert first["evidence"] == second["evidence"]
    assert first["input_snapshot"] != changed["input_snapshot"]
    for artifact in (first, second, changed):
        assert str(UUID(artifact["id"])) == artifact["id"]
        assert UUID(artifact["id"]).version == 4
        created = datetime.fromisoformat(artifact["created_at"])
        assert created.utcoffset().total_seconds() == 0
        assert before <= created <= after


@pytest.mark.parametrize("source", ["sample", "manual", "photo-assisted"])
def test_source_and_horizon_are_from_the_actual_scenario(source):
    result = run_evidence.execute_run(scenario(source=source, operating_days=30, electricity_usd_kwh=0.23))
    artifact = result["run"]
    evidence = artifact["evidence"]
    assert artifact["source"] == artifact["input_snapshot"]["source"] == source
    assert evidence["horizon"] == {"operating_days": 30, "electricity_usd_kwh": 0.23}
    assert evidence["savings"]["period_energy_kwh"] == 72
    assert evidence["savings"]["period_energy_cost_usd"] == 16.56
    assert ("Synthetic sample" in evidence["summary"]) == (source == "sample")


def test_alternatives_are_actual_selected_rejected_and_next_ranked_candidates():
    s = scenario(dimmable=True, baseline_hours=8, power_limit_watts=500)
    result = run_evidence.execute_run(s)
    assert result["status"] == "optimized"
    assert result["feasible_configurations"] >= 2
    evidence = result["run"]["evidence"]
    alternatives = evidence["alternatives"]
    assert len(alternatives) == 5
    assert all(a["candidate"] in result["candidates"] for a in alternatives)
    chosen = next(a["candidate"] for a in alternatives if a["kind"] == "selected")
    assert {k: v for k, v in chosen.items() if k not in {"feasible", "rejected_for"}} == result["optimized"]
    rejected = [a for a in alternatives if a["kind"] == "rejected"]
    assert {a["reason"] for a in rejected} == {reason for c in result["candidates"] for reason in c["rejected_for"]}
    assert all(a["reason"] in a["candidate"]["rejected_for"] for a in rejected)
    ranked = sorted((c for c in result["candidates"] if c["feasible"]), key=lambda c: (
        core.daily_energy(s, c["photoperiod_hours"], c["dim_fraction"]),
        abs(c["dim_fraction"] - s.baseline_dim), abs(c["photoperiod_hours"] - s.baseline_hours)))
    assert chosen == ranked[0]
    assert next(a["candidate"] for a in alternatives if a["kind"] == "nearest_feasible") == ranked[1]
    baseline = next(c for c in result["candidates"] if c["photoperiod_hours"] == 8 and c["dim_fraction"] == 1)
    for constraint in evidence["constraints"]:
        reason = constraint["name"]
        assert constraint["baseline_passed"] == (reason not in baseline["rejected_for"])
        assert constraint["rejected_configurations"] == sum(reason in c["rejected_for"] for c in result["candidates"])
    assert "Exact energy ties" in evidence["selection_reason"]
    assert "ascending (hours, dim fraction)" in evidence["selection_reason"]


def test_single_feasible_candidate_does_not_invent_an_alternative():
    evidence = run_evidence.execute_run(scenario(min_hours=12, max_hours=12))["run"]["evidence"]
    assert evidence["feasible_configurations"] == 1
    assert [a["kind"] for a in evidence["alternatives"]] == ["selected", "rejected"]
    assert evidence["alternatives"][1]["reason"] == "photoperiod"


def test_equal_raw_energy_prefers_baseline_dim_in_actual_alternatives():
    s = scenario(dimmable=True, baseline_dim=0.8, min_dli=12.6, max_hours=20, other_watts=0)
    result = run_evidence.execute_run(s)
    evidence = result["run"]["evidence"]
    selected = next(a["candidate"] for a in evidence["alternatives"] if a["kind"] == "selected")
    other = next(a["candidate"] for a in evidence["alternatives"] if a["kind"] == "nearest_feasible")
    assert selected["dim_fraction"] == s.baseline_dim
    assert core.daily_energy(s, selected["photoperiod_hours"], selected["dim_fraction"]) == core.daily_energy(
        s, other["photoperiod_hours"], other["dim_fraction"])
    assert abs(selected["dim_fraction"] - s.baseline_dim) < abs(other["dim_fraction"] - s.baseline_dim)


@pytest.mark.parametrize("changes,missing", [
    ({"confirmed": False}, ["confirmed"]),
    ({"ppfd_full": None}, ["ppfd_full"]),
    ({"min_dli": None}, ["min_dli"]),
    ({"confirmed": False, "ppfd_full": None, "min_dli": None}, ["confirmed", "ppfd_full", "min_dli"]),
])
def test_missing_inputs_have_no_candidates_or_invented_savings(changes, missing):
    result = run_evidence.execute_run(scenario(**changes))
    artifact = result["run"]
    evidence = artifact["evidence"]
    assert artifact["status"] == "needs_measurement"
    assert evidence["selected"] is evidence["savings"] is None
    assert evidence["missing_inputs"] == missing
    assert evidence["alternatives"] == result["candidates"] == []
    assert evidence["configurations_evaluated"] == evidence["feasible_configurations"] == 0
    assert all(f["scope"] == "baseline" for f in evidence["formulas"])
    if changes.get("ppfd_full", 350) is None:
        assert all(f["metric"] != "dli_mol_m2_day" for f in evidence["formulas"])
    assert all(not c["evaluated"] and c["baseline_passed"] is c["selected_passed"] is None
               for c in evidence["constraints"])
    assert run_evidence.get_run(artifact["id"]) == result


@pytest.mark.parametrize("changes,reason", [
    ({"min_dli": 100}, "minimum_dli"),
    ({"power_limit_watts": 100}, "modeled_power_limit"),
])
def test_infeasible_evidence_has_actual_rejections_without_savings(changes, reason):
    result = run_evidence.execute_run(scenario(**changes))
    evidence = result["run"]["evidence"]
    assert result["run"]["status"] == "no_feasible_configuration"
    assert evidence["selected"] is evidence["savings"] is None
    assert evidence["missing_inputs"] == []
    assert evidence["configurations_evaluated"] == 33
    assert evidence["feasible_configurations"] == 0
    assert all(a["kind"] == "rejected" and a["candidate"] in result["candidates"] for a in evidence["alternatives"])
    assert reason in {a["reason"] for a in evidence["alternatives"]}
    assert all(f["scope"] == "baseline" for f in evidence["formulas"])
    assert all(c["evaluated"] and c["selected_passed"] is None for c in evidence["constraints"])
    assert "No savings are estimated" in evidence["summary"]


@pytest.mark.parametrize("changes", [
    {},
    {"lighting_watts": 1e-8, "other_watts": 0},
    {"baseline_hours": 12.13, "baseline_dim": 0.43, "dimmable": True, "min_dli": 6},
    {"other_hours": 0, "other_watts": 900, "power_limit_watts": 600, "water_liters_day": None},
])
def test_formulas_use_raw_precision_and_match_all_reported_metrics(changes):
    s = scenario(**changes)
    result = run_evidence.execute_run(s)
    formulas = result["run"]["evidence"]["formulas"]
    for formula in formulas:
        assert round(formula["raw_value"], formula["round_digits"]) == formula["reported_value"]
        assert repr(formula["raw_value"]) in formula["substituted"]
        scope = "optimized" if formula["scope"] == "selected" else formula["scope"]
        assert formula["reported_value"] == result[scope][formula["metric"]]
    for scope, metrics in (("baseline", result["baseline"]), ("selected", result["optimized"])):
        values = {f["metric"]: f["raw_value"] for f in formulas if f["scope"] == scope}
        hours, dim = metrics["photoperiod_hours"], metrics["dim_fraction"]
        assert values["daily_energy_kwh"] == core.daily_energy(s, hours, dim)
        assert values["peak_modeled_watts"] == core.peak_power(s, dim)
        assert values["dli_mol_m2_day"] == s.ppfd_full * dim * hours * 0.0036
        assert values["period_energy_kwh"] == values["daily_energy_kwh"] * s.operating_days
        assert values["period_energy_cost_usd"] == values["period_energy_kwh"] * s.electricity_usd_kwh
    if s.lighting_watts == 1e-8:
        assert result["baseline"]["daily_energy_kwh"] == 0
        assert result["optimized"]["photoperiod_hours"] == 12
        assert result["savings"]["energy_pct"] == 25
        assert next(f for f in formulas if f["scope"] == "baseline" and f["metric"] == "daily_energy_kwh")["raw_value"] > 0


@pytest.mark.parametrize("changes,settings,energy,cost", [
    ({}, "16 h/day at 100% output to 12 h/day at 100% output", "876 kWh less energy", "USD 131.4 less cost"),
    ({"baseline_hours": 8}, "8 h/day at 100% output to 12 h/day at 100% output", "876 kWh more energy", "USD 131.4 more cost"),
    ({"baseline_hours": 12}, "Lighting stays at 12 h/day at 100% output; no operating change is proposed", "0 kWh energy difference", "USD 0 cost difference"),
    ({"electricity_usd_kwh": 0}, "16 h/day at 100% output to 12 h/day at 100% output", "876 kWh less energy", "USD 0 cost difference"),
    ({"lighting_watts": 1e-8, "other_watts": 0}, "16 h/day at 100% output to 12 h/day at 100% output", "0 kWh energy difference", "USD 0 cost difference"),
    ({"operating_days": 30, "electricity_usd_kwh": 0.23}, "16 h/day at 100% output to 12 h/day at 100% output", "72 kWh less energy", "USD 16.56 less cost"),
])
def test_summary_explains_change_selection_signed_impact_and_limits(changes, settings, energy, cost):
    s = scenario(**changes)
    result = run_evidence.execute_run(s)
    summary = result["run"]["evidence"]["summary"]
    assert settings in summary
    assert "minimum modeled energy" in summary
    assert f"{result['configurations_evaluated']} tested settings" in summary
    assert "meeting all entered constraints" in summary
    assert f"{result['feasible_configurations']} feasible" in summary
    assert f"over {s.operating_days} operating days" in summary
    assert energy in summary and cost in summary
    assert "conditional projection depends on entered inputs" in summary
    assert "not measured savings or a crop or weather forecast" in summary
    assert len(summary.split()) <= 90
    assert "000000000" not in summary and "999999999" not in summary


def test_summary_formats_off_grid_hours_and_dim_without_float_artifacts():
    s = scenario(source="manual", baseline_hours=12.13, baseline_dim=0.43, dimmable=True, min_dli=6)
    result = run_evidence.execute_run(s)
    summary = result["run"]["evidence"]["summary"]
    assert "from 12.13 h/day at 43% output to" in summary
    assert "000000000" not in summary and "999999999" not in summary
    assert len(summary.split()) <= 90


def test_constraint_outcomes_preserve_solver_boundary_tolerance():
    s = scenario(min_hours=12, max_hours=12, min_dli=15.12 * (1 + 5e-13),
                 power_limit_watts=645 * (1 - 5e-13))
    result = run_evidence.execute_run(s)
    constraints = {c["name"]: c for c in result["run"]["evidence"]["constraints"]}
    assert result["status"] == "optimized"
    assert constraints["minimum_dli"]["selected_value"] < constraints["minimum_dli"]["minimum"]
    assert constraints["modeled_power_limit"]["selected_value"] > constraints["modeled_power_limit"]["maximum"]
    assert all(c["selected_passed"] for c in constraints.values())


def test_returned_results_and_every_nested_read_are_detached(isolated_registry):
    s = scenario()
    result = run_evidence.execute_run(s)
    expected = deepcopy(result)
    run_id = result["run"]["id"]
    s.lighting_watts = 900
    result["baseline"]["daily_energy_kwh"] = -1
    result["candidates"].clear()
    result["run"]["input_snapshot"]["lighting_watts"] = 900
    result["run"]["evidence"]["alternatives"][0]["candidate"]["rejected_for"].append("made_up")
    result["run"]["evidence"]["formulas"].clear()
    first_read = run_evidence.get_run(run_id)
    assert first_read == expected
    first_read["run"]["evidence"]["inputs"][0]["value"] = "changed"
    first_read["candidates"][0]["rejected_for"].clear()
    assert run_evidence.get_run(run_id) == expected
    assert len(isolated_registry) == 1
    assert run_evidence.get_run(str(UUID(int=0))) is None
    assert run_evidence.get_run("unknown") is None


def test_registry_is_bounded_and_reads_do_not_refresh_old_runs(isolated_registry):
    ids = [run_evidence.execute_run(scenario())["run"]["id"] for _ in range(100)]
    assert run_evidence.MAX_RUNS == len(isolated_registry) == 100
    assert run_evidence.get_run(ids[0]) is not None
    newest = run_evidence.execute_run(scenario())["run"]["id"]
    assert len(isolated_registry) == 100
    assert run_evidence.get_run(ids[0]) is None
    assert all(run_evidence.get_run(run_id) is not None for run_id in ids[1:] + [newest])


def test_completed_runs_cannot_be_replaced(isolated_registry):
    result = run_evidence.execute_run(scenario())
    changed = deepcopy(result)
    changed["baseline"]["daily_energy_kwh"] = -1
    with pytest.raises(ValueError, match="cannot be replaced"):
        isolated_registry.add(changed)
    assert run_evidence.get_run(result["run"]["id"]) == result


def test_concurrent_runs_are_distinct_and_registry_stays_bounded(isolated_registry):
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: run_evidence.execute_run(scenario()), range(110)))
    ids = {r["run"]["id"] for r in results}
    assert len(ids) == 110
    assert len(isolated_registry) == 100
    retained = [run_evidence.get_run(run_id) for run_id in ids]
    assert sum(r is not None for r in retained) == 100
    assert all(r["run"]["input_snapshot"] == scenario().model_dump() for r in retained if r is not None)


def test_execute_calls_core_once_and_keeps_legacy_schema_valid(monkeypatch):
    original = core.solve
    calls = []

    def observed(s):
        calls.append(s.model_dump())
        return original(s)

    monkeypatch.setattr(core, "solve", observed)
    result = run_evidence.execute_run(scenario())
    assert calls == [scenario().model_dump()]
    assert result["run"] is not None
    legacy = original(scenario())
    parsed = OptimizationResult.model_validate(legacy)
    assert parsed.run is None
    assert parsed.model_dump(exclude={"run"}) == legacy


@pytest.mark.parametrize("changes", [{}, {"ppfd_full": None}, {"power_limit_watts": 100}])
def test_api_emits_non_null_retrievable_run_with_same_scenario_payload(manual_client, changes):
    s = scenario(**changes)
    response = manual_client.post("/optimize", json=s.model_dump())
    assert response.status_code == 200
    result = response.json()
    RunArtifact.model_validate(result["run"])
    assert result["run"]["status"] == result["status"]
    assert run_evidence.get_run(result["run"]["id"]) == result
    assert {k: v for k, v in result.items() if k != "run"} == core.solve(s)
