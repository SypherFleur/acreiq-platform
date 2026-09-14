import copy
import hashlib
import json
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from backend import site_comparison as sc
from backend.site_fixture import fixture
from backend.site_schemas import ComparisonRequest, Inputs


def reviewed(payload=None):
    payload = copy.deepcopy(payload if payload is not None else fixture())
    snapshot = {k: v for k, v in payload.items() if k not in ("review", "prior_comparison_id")}
    payload["review"] = {"snapshot_json": json.dumps(snapshot), "reviewed_at": "2026-09-13T12:34:56Z"}
    return payload


def run(payload=None, store=None):
    return sc.compare(ComparisonRequest.model_validate(reviewed(payload)), store)["payload"]


def value(evaluation, key):
    return evaluation["metrics"][key]["value"]


def cost(scenario, category):
    return next(c for c in scenario["costs"] if c["category"] == category)


def test_fixture_is_unreviewed_and_exact_requested_lighting_survives():
    data = fixture()
    assert data["review"] is None
    unreviewed = sc.compare(ComparisonRequest.model_validate(data))["payload"]
    assert unreviewed["preferred_scenario_ids"] == []
    assert all(e["module_result"]["status"] == "needs_measurement" for e in unreviewed["evaluations"])
    assert all(value(e, "output_kg") is None for e in unreviewed["evaluations"])
    result = run()
    assert result["scenario_count"] == 3
    assert result["feasible_count"] == 2
    assert result["preferred_scenario_ids"] == ["fixture-C"]
    assert [e["module_result"]["baseline"]["photoperiod_hours"] for e in result["evaluations"]] == [16, 12, 18]
    assert [e["module_result"]["optimized"]["photoperiod_hours"] for e in result["evaluations"]] == [12, 12, 12]
    assert [e["module_result"]["configurations_evaluated"] for e in result["evaluations"]] == [33, 33, 33]
    assert [value(e, "horizon_cash_usd") for e in result["evaluations"]] == [510.944, 493.952, 600.496]
    assert [value(e, "output_kg") for e in result["evaluations"]] == [48, 40, 60]
    assert [value(e, "peak_watts") for e in result["evaluations"]] == [875, 875, 875]
    assert all(e["provenance"] == "synthetic_fixture" for e in result["evaluations"])


def test_review_is_snapshot_bound_not_key_order_or_float_spelling():
    data = reviewed()
    parsed = json.loads(data["review"]["snapshot_json"])
    parsed["site"]["length_ft"] = 8
    data["review"]["snapshot_json"] = json.dumps(parsed, sort_keys=True)
    sc.compare(ComparisonRequest.model_validate(data))
    data["scenarios"][0]["water_liters_day"] = 16
    with pytest.raises(sc.ComparisonError, match="Review is stale"):
        sc.compare(ComparisonRequest.model_validate(data))


@pytest.mark.parametrize("snapshot", ["null", "[]", "{}", "not JSON"])
def test_bad_review_is_recoverable(snapshot):
    data = reviewed()
    data["review"]["snapshot_json"] = snapshot
    with pytest.raises(sc.ComparisonError, match="malformed"):
        sc.compare(ComparisonRequest.model_validate(data))


def test_review_requires_timezone():
    data = reviewed()
    data["review"]["reviewed_at"] = "2026-09-13"
    with pytest.raises(sc.ComparisonError, match="malformed"):
        sc.compare(ComparisonRequest.model_validate(data))


@pytest.mark.parametrize("metric,direction,winner", [("energy_kwh", "minimize", "fixture-A"), ("recurring_cash_usd", "minimize", "fixture-A"), ("horizon_cash_usd", "minimize", "fixture-A"), ("horizon_cash_per_kg", "minimize", "fixture-C")])
def test_goal_changes_reuse_original_immutable_evaluations(metric, direction, winner):
    store = sc.ComparisonRegistry()
    original = run(store=store)
    data = fixture()
    data["goal"].update(id=f"goal-{metric}", metric=metric, direction=direction)
    data["prior_comparison_id"] = original["id"]
    with patch.object(sc, "execute_run", side_effect=AssertionError("Goal changes must not rerun lighting")):
        updated = run(data, store)
    assert updated["preferred_scenario_ids"] == [winner]
    assert updated["reused_evaluations"]
    assert updated["evaluations"] == original["evaluations"]
    assert updated["id"] != original["id"]
    assert updated["parent_id"] == original["id"]


def test_cache_miss_and_changed_inputs_do_not_reuse_old_calculations():
    store = sc.ComparisonRegistry()
    original = run(store=store)
    data = fixture()
    data["prior_comparison_id"] = "missing-comparison"
    with pytest.raises(sc.ComparisonError, match="unavailable"):
        run(data, store)
    data["prior_comparison_id"] = original["id"]
    data["scenarios"][2]["water_liters_day"] = 17
    with pytest.raises(sc.ComparisonError, match="Only goal changes"):
        run(data, store)
    data = fixture()
    data["prior_comparison_id"] = original["id"]
    with pytest.raises(sc.ComparisonError, match="Review status changed"):
        sc.compare(ComparisonRequest.model_validate(data), store)


def test_changed_recipe_is_not_an_inferred_yield_response():
    data = fixture()
    c = data["scenarios"][2]
    c["revision"] += 1
    c["lighting"]["hours_per_day"] = 17
    c["loads"][0]["hours_per_day"] = 17
    result = run(data)
    e = result["evaluations"][2]
    assert value(e, "energy_kwh") == 689.92
    assert value(e, "dli") == 21.42
    assert e["applicability"]["status"] == "fail"
    assert value(e, "output_kg") is None
    assert value(e, "horizon_cash_per_kg") is None
    assert result["preferred_scenario_ids"] == ["fixture-A"]
    assert result["comparison_incomplete"]
    assert any(c["metric"] == "output_kg" and c["status"] == "unknown" for c in e["constraints"])


def test_new_explicit_assumption_can_supply_own_context_but_never_unknown_requirements():
    data = fixture()
    c = data["scenarios"][2]
    c["lighting"]["hours_per_day"] = c["loads"][0]["hours_per_day"] = 17
    c["benchmark"]["version"] += 1
    c["benchmark"]["kg_per_cycle"] = 26
    c["benchmark"]["context"] = sc.benchmark_context(data, c)
    e = run(data)["evaluations"][2]
    assert value(e, "output_kg") == 52
    c["lighting"]["ppfd_full"] = None
    c["benchmark"]["context"] = sc.benchmark_context(data, c)
    e = run(data)["evaluations"][2]
    assert e["applicability"]["status"] == "unknown"
    assert value(e, "output_kg") is None


@pytest.mark.parametrize("field", ["ppfd_full", "min_dli"])
def test_missing_light_measurements_preserve_energy_but_withhold_selection_and_output(field):
    data = fixture()
    data["scenarios"][2]["lighting"][field] = None
    e = run(data)["evaluations"][2]
    assert e["module_result"]["status"] == "needs_measurement"
    assert e["module_result"]["optimized"] is None
    assert e["module_result"]["savings"] is None
    assert value(e, "energy_kwh") == 723.52
    assert value(e, "output_kg") is None


@pytest.mark.parametrize("category,field", [("maintenance", "rate"), ("electricity", "rate"), ("new_equipment", "amount"), ("setup_materials", "amount")])
def test_missing_cost_is_unknown_not_zero(category, field):
    data = fixture()
    cost(data["scenarios"][2], category)[field] = None
    e = run(data)["evaluations"][2]
    assert value(e, "horizon_cash_usd") is None
    assert value(e, "horizon_cash_per_kg") is None
    assert not e["metrics"]["horizon_cash_usd"]["complete"]
    assert e["metrics"]["horizon_cash_usd"]["unknown_line_ids"]
    assert value(e, "energy_kwh") == 723.52


def test_missing_maintenance_subtotal_proves_only_upper_bound_failure():
    data = fixture()
    cost(data["scenarios"][2], "maintenance")["rate"] = None
    e = run(data)["evaluations"][2]
    assert e["metrics"]["recurring_cash_usd"]["known_subtotal"] == 562.496
    assert e["metrics"]["horizon_cash_usd"]["known_subtotal"] == 592.496
    c = next(c for c in e["constraints"] if c["metric"] == "horizon_cash_usd")
    assert c["status"] == "unknown"
    next(l for l in data["limits"] if l["metric"] == "horizon_cash_usd")["maximum"] = 590
    e = run(data)["evaluations"][2]
    c = next(c for c in e["constraints"] if c["metric"] == "horizon_cash_usd")
    assert c["status"] == "fail"
    assert "subtotal" in c["reason"]


def test_explicit_zero_is_retained_and_missing_categories_are_incomplete():
    data = fixture()
    e = run(data)["evaluations"][0]
    assert value(e, "new_setup_cash_usd") == 0
    assert e["metrics"]["new_setup_cash_usd"]["complete"]
    data["scenarios"][0]["costs"] = [c for c in data["scenarios"][0]["costs"] if c["category"] != "new_equipment"]
    e = run(data)["evaluations"][0]
    assert value(e, "new_setup_cash_usd") is None
    assert "missing-new_equipment" in e["metrics"]["new_setup_cash_usd"]["unknown_line_ids"]


def test_exclusions_remain_explicit_and_inconsistent_boundaries_block_ranking():
    data = fixture()
    c = cost(data["scenarios"][2], "maintenance")
    c["status"], c["reason"] = "excluded", "Separate service outside this comparison boundary"
    result = run(data)
    e = result["evaluations"][2]
    assert c["id"] in e["metrics"]["horizon_cash_usd"]["excluded_line_ids"]
    assert e["metrics"]["horizon_cash_usd"]["complete"]
    assert result["compatibility"]["status"] == "not_comparable"
    assert result["preferred_scenario_ids"] == []


def test_missing_external_power_produces_subtotals_and_unknown_output():
    data = fixture()
    data["assets"][3]["watts"] = None
    result = run(data)
    e = result["evaluations"][2]
    assert e["module_result"] is not None
    assert value(e, "energy_kwh") is None
    assert e["metrics"]["energy_kwh"]["known_subtotal"] == 678.72
    assert e["metrics"]["peak_watts"]["known_subtotal"] == 675
    assert value(e, "peak_watts") is None
    assert value(e, "output_kg") is None
    assert value(e, "horizon_cash_usd") is None


def test_different_other_load_schedules_do_not_invent_legacy_aggregate():
    data = fixture()
    for s in data["scenarios"]:
        s["loads"][2]["accounting"] = "module_other"
    e = run(data)["evaluations"][0]
    assert e["module_result"] is None
    assert value(e, "energy_kwh") == 656.32
    assert value(e, "output_kg") is None


def test_water_null_does_not_inherit_sample_inputs():
    data = fixture()
    data["scenarios"][2]["water_liters_day"] = None
    e = run(data)["evaluations"][2]
    assert value(e, "water_liters") is None
    assert value(e, "output_kg") is None
    assert value(e, "horizon_cash_usd") is None
    assert value(e, "energy_kwh") == 723.52


@pytest.mark.parametrize("metric,maximum,minimum", [("peak_watts", 800, None), ("output_kg", None, 65)])
def test_all_infeasible_selects_nothing(metric, maximum, minimum):
    data = fixture()
    next(l for l in data["limits"] if l["metric"] == metric).update(maximum=maximum, minimum=minimum)
    result = run(data)
    assert result["preferred_scenario_ids"] == []
    assert result["feasible_count"] == 0
    assert all(e["feasibility"] == "fail" for e in result["evaluations"])


def test_partial_horizon_not_normalized_into_harvest():
    data = fixture()
    data["operation"]["horizon_days"] = 55
    result = run(data)
    assert result["compatibility"]["status"] == "not_comparable"
    assert all(value(e, "output_kg") is None for e in result["evaluations"])


def test_unsupported_layout_constraint_unknown_and_disabled_is_not_pass():
    data = fixture()
    l = copy.deepcopy(data["limits"][0])
    l.update(id="layout", metric="layout_feasibility", minimum=1, maximum=1, unit="boolean")
    data["limits"].append(l)
    result = run(data)
    assert result["preferred_scenario_ids"] == []
    assert result["evaluations"][0]["constraints"][-1]["status"] == "unknown"
    l.update(enabled=False, reason="Layout evaluator outside this milestone")
    result = run(data)
    assert result["evaluations"][0]["constraints"][-1]["status"] == "not_evaluated"
    assert result["preferred_scenario_ids"] == ["fixture-C"]


def test_zero_output_ratios_unknown_not_infinite():
    data = fixture()
    data["scenarios"][2]["benchmark"]["kg_per_cycle"] = 0
    e = run(data)["evaluations"][2]
    assert value(e, "output_kg") == 0
    assert value(e, "horizon_cash_per_kg") is None
    assert value(e, "energy_per_kg") is None
    json.dumps(e, allow_nan=False)


def test_name_or_prices_do_not_invalidate_benchmark_but_conditions_do():
    data = fixture()
    data["scenarios"][2]["name"] = "Different display name"
    cost(data["scenarios"][2], "electricity")["rate"] = .3
    assert run(data)["evaluations"][2]["applicability"]["status"] == "pass"
    data["operation"]["temperature_c"] = 24
    assert run(data)["evaluations"][2]["applicability"]["status"] == "fail"


def test_blank_conditions_and_boolean_number_substitution_cannot_support_benchmarks():
    data = fixture()
    data["operation"]["crop"] = " "
    for s in data["scenarios"]:
        s["benchmark"]["context"] = sc.benchmark_context(data, s)
    e = run(data)["evaluations"][0]
    assert e["applicability"]["status"] == "unknown"
    assert value(e, "output_kg") is None
    data = fixture()
    data["scenarios"][0]["benchmark"]["context"]["lighting"]["dim_fraction"] = True
    assert run(data)["evaluations"][0]["applicability"]["status"] == "fail"


def test_provider_observations_never_become_trusted_measurements_or_benchmarks():
    data = fixture()
    data["scenarios"][2]["benchmark"]["evidence"]["source"] = "provider_observation"
    e = run(data)["evaluations"][2]
    assert value(e, "output_kg") is None
    data = fixture()
    data["assets"][0]["evidence"]["source"] = "provider_observation"
    e = run(data)["evaluations"][0]
    assert e["module_result"] is None
    assert value(e, "energy_kwh") is None


def test_ties_receive_equal_rank_no_id_tiebreak_claim():
    data = fixture()
    data["scenarios"][0]["benchmark"]["kg_per_cycle"] = 30
    result = run(data)
    assert result["preferred_scenario_ids"] == ["fixture-A", "fixture-C"]
    assert [r["rank"] for r in result["ranks"]] == [1, None, 1]


def test_canonical_envelope_hashes_snapshot_and_payload_once():
    artifact = sc.compare(ComparisonRequest.model_validate(reviewed()))
    assert json.loads(artifact["canonical_json"]) == artifact["payload"]
    assert hashlib.sha256(artifact["canonical_json"].encode()).hexdigest() == artifact["sha256"]
    p = artifact["payload"]
    assert json.loads(p["input_canonical_json"]) == p["input_snapshot"]
    assert hashlib.sha256(p["input_canonical_json"].encode()).hexdigest() == p["input_sha256"]
    assert "sha256" not in p
    assert len(json.dumps(reviewed()).encode()) < 256 * 1024
    assert len(json.dumps(artifact).encode()) < 2 * 1024 * 1024
    review = next(f for f in p["evaluations"][0]["formulas"] if f["metric"] == "review-record")
    assert review["operands"]["reviewed_input_sha256"] == p["input_sha256"]
    assert review["operands"]["reviewed_at"] == "2026-09-13T12:34:56Z"


@pytest.mark.parametrize("hours,expected", [
    (12.123456789, "12.123456789"), (16.123456789, "16.123456789"),
    (16.123456789123456, "16.123456789123455"), (0.12345678912345678, "0.12345678912345678"),
    (0.000001, "0.000001"), (0.0000001, "1e-7"), (16, "16"),
])
def test_exact_candidate_identity_never_uses_display_rounding(hours, expected):
    data = fixture()
    data["scenarios"][0]["lighting"]["hours_per_day"] = hours
    data["scenarios"][0]["loads"][0]["hours_per_day"] = hours
    result = run(data)
    e = result["evaluations"][0]
    assert e["requested_setting"]["candidate_id"] == f"h{expected}-d1"
    assert any(c["photoperiod_hours"] == hours for c in e["module_result"]["candidates"])


def test_registry_is_immutable_fifo_and_verify_is_read_only():
    store = sc.ComparisonRegistry(capacity=1)
    original = sc.compare(ComparisonRequest.model_validate(reviewed()), store)
    p = original["payload"]
    exact = copy.deepcopy(original)
    p["evaluations"][0]["metrics"]["energy_kwh"]["value"] = 999
    assert store.get(p["id"]) == exact
    with patch.object(sc, "execute_run", side_effect=AssertionError("Verification is read-only")):
        assert sc.verify(p["id"], exact["sha256"], store)["status"] == "available"
        assert sc.verify(p["id"], "0" * 64, store)["status"] == "mismatch"
    sc.compare(ComparisonRequest.model_validate(reviewed()), store)
    assert sc.verify(p["id"], exact["sha256"], store)["status"] == "unavailable"
    assert sc.verify("unknown", "0" * 64, store)["module_runs"] == []


@pytest.mark.parametrize("mutate", [
    lambda p: p["assets"].append(copy.deepcopy(p["assets"][0])),
    lambda p: p["assets"][1]["component_ids"].append("fixture-lights"),
    lambda p: p["scenarios"][0]["loads"].append(copy.deepcopy(p["scenarios"][0]["loads"][0])),
    lambda p: p["scenarios"][0]["costs"].append(copy.deepcopy(p["scenarios"][0]["costs"][0])),
    lambda p: p["scenarios"][0]["costs"][1]["component_ids"].append("expense-electricity"),
    lambda p: p["scenarios"][0]["loads"][0].update(asset_revision=2),
    lambda p: p["assets"][0].update(site_id="another-site"),
    lambda p: p["scenarios"][0].update(site_revision=2),
    lambda p: p["scenarios"][0]["lighting"].update(lighting_watts=1200),
    lambda p: p["scenarios"][0]["loads"][0].update(hours_per_day=12),
    lambda p: p["scenarios"][0]["costs"][0].update(amount=10),
    lambda p: p["scenarios"][0]["costs"][0].update(rate=-1),
    lambda p: p["scenarios"][0]["costs"][0].update(status="excluded", reason=None),
    lambda p: cost(p["scenarios"][0], "new_equipment").update(amount=10),
    lambda p: p["operation"].update(operation_type="general-land-optimizer"),
    lambda p: p["limits"][0].update(unit="W"),
    lambda p: p["site"].update(id="../invalid"),
    lambda p: p["site"].update(length_ft=float("nan")),
    lambda p: p["site"].update(length_ft="8"),
    lambda p: p["scenarios"][0]["benchmark"].update(scenario_id="fixture-C"),
])
def test_strict_contracts_reject_duplicates_units_references_and_nonfinite(mutate):
    data = fixture()
    mutate(data)
    with pytest.raises(ValidationError):
        ComparisonRequest.model_validate(data)


def test_get_fixture_post_compare_and_verify_routes(manual_client):
    response = manual_client.get("/site-comparisons/fixture")
    assert response.status_code == 200
    assert response.json()["review"] is None
    response = manual_client.post("/site-comparisons", json=reviewed(response.json()))
    assert response.status_code == 200
    artifact = response.json()
    assert artifact["payload"]["preferred_scenario_ids"] == ["fixture-C"]
    verified = manual_client.post("/site-comparisons/verify", json={"comparison_id": artifact["payload"]["id"], "sha256": artifact["sha256"]})
    assert verified.status_code == 200
    assert verified.json()["status"] == "available"
    assert len(verified.json()["module_runs"]) == 3
    assert manual_client.post("/site-comparisons/fixture", json={}).status_code == 405
    assert manual_client.get("/site-comparisons").status_code == 405


@pytest.mark.parametrize("route,limit", [("/site-comparisons", 256 * 1024), ("/site-comparisons/verify", 8 * 1024), ("/optimize", 64 * 1024)])
def test_per_route_body_limits(manual_client, route, limit):
    assert manual_client.post(route, content=b" " * (limit + 1)).status_code == 413
    assert manual_client.post(route, content=b" " * limit).status_code == 422


def test_site_api_errors_are_specific_and_do_not_echo_payload(manual_client):
    data = reviewed()
    data["scenarios"][0]["water_liters_day"] = 99
    response = manual_client.post("/site-comparisons", json=data)
    assert response.status_code == 409
    assert "Review is stale" in response.json()["detail"]
    data = reviewed()
    data["prior_comparison_id"] = "not-cached"
    response = manual_client.post("/site-comparisons", json=data)
    assert response.status_code == 409
    assert "unavailable" in response.json()["detail"]
