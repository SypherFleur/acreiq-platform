"""Saved HTTP/Live run explanations, using in-process transports and no providers."""

import json
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from google.genai import types
from pydantic import ValidationError

from backend import core, live, live_tools, run_evidence
from backend.live_tools import LiveTools, RunReference, WorkspaceContext
from backend.main import create_app
from backend.schemas import OptimizationResult, RunArtifact
from backend.tests.test_live_relay import FakeClient, ORIGIN, SocketHarness, eventually
from backend.tests.test_live_tools import acknowledge_result, draft_context, proposal, workspace
from backend.vision import VisionService


@pytest.fixture
def evidence_client():
    vision = Mock(spec=VisionService, start=AsyncMock(), close=AsyncMock())
    manager = Mock(spec=live.LiveManager, start=AsyncMock(), close=AsyncMock())
    with TestClient(create_app(vision_service=vision, live_manager=manager)) as client:
        yield client
    vision.start.assert_awaited_once()
    vision.close.assert_awaited_once()
    manager.start.assert_awaited_once()
    manager.close.assert_awaited_once()


def api_run(client, **changes):
    inputs = {**core.SAMPLE, "confirmed": True, **changes}
    response = client.post("/optimize", json=inputs)
    assert response.status_code == 200
    result = response.json()
    assert result["run"] is not None
    assert OptimizationResult.model_validate(result).model_dump() == result
    assert RunArtifact.model_validate(result["run"]).model_dump() == result["run"]
    assert result["run"]["input_snapshot"] == core.Scenario.model_validate(inputs).model_dump()
    assert datetime.fromisoformat(result["run"]["created_at"]).utcoffset() is not None
    assert run_evidence.get_run(result["run"]["id"]) == result
    return result


def select_run(context, result):
    selected = WorkspaceContext.model_validate(context).model_dump()
    current_proposal = selected["proposal"]
    selected["has_result"] = True
    selected["selected_run"] = {
        "id": result["run"]["id"], "workspace_revision": selected["revision"],
        "accepted_revision": selected["accepted_revision"],
        "proposal_id": current_proposal["id"] if current_proposal else None,
        "proposal_version": current_proposal["version"] if current_proposal else None,
    }
    return selected


def read_state(tools):
    # Calls are intentionally recorded; workspace transactions and their futures are not.
    state = deepcopy({key: value for key, value in vars(tools).items()
                      if key not in {"calls", "actions", "_transcript_changed"}})
    state["actions"] = {
        key: {**deepcopy({k: v for k, v in action.items() if k != "future"}),
              "future_done": action["future"].done(), "future_cancelled": action["future"].cancelled()}
        for key, action in tools.actions.items()
    }
    return state


@contextmanager
def no_calculation(monkeypatch):
    with monkeypatch.context() as patch:
        guards = []
        for module, name in ((core, "solve"), (core, "calculate"), (live_tools, "execute_run")):
            guard = Mock(side_effect=AssertionError("An explanation must not calculate a new result."))
            patch.setattr(module, name, guard)
            guards.append(guard)
        yield
        for guard in guards:
            guard.assert_not_called()


async def read_saved(tools, call_id="explain", arguments=None):
    before = read_state(tools)
    response, events = await tools.dispatch(call_id, "get_scenario_result", arguments or {})
    assert read_state(tools) == before
    reference = tools.context.selected_run
    assert events == [{
        "type": "explanation_status", "status": response["status"],
        "run_id": reference.id if reference else None,
        "code": response.get("code"), "message": response.get("message"),
    }]
    assert "action_id" not in response and "acknowledged" not in response
    return response


def assert_saved(response, exported, context, *, earlier=False):
    assert response["status"] == "ok"
    assert response["run"] == exported["run"]
    assert response["workspace_version"] == context["selected_run"]
    assert response["revision"] == context["selected_run"]["workspace_revision"]
    assert response["current_workspace_revision"] == context["revision"]
    assert response["earlier_result"] is earlier
    assert response["candidate_details_total"] == len(exported["candidates"])
    assert {key: value for key, value in response["result"].items() if key != "candidates"} == {
        key: value for key, value in exported.items() if key not in {"run", "candidates"}
    }
    compact = response["result"]["candidates"]
    assert len(compact) <= 5
    assert all(candidate in exported["candidates"] for candidate in compact)
    assert {reason for candidate in compact for reason in candidate["rejected_for"]} == {
        reason for candidate in exported["candidates"] for reason in candidate["rejected_for"]
    }
    for metrics in (exported["baseline"], exported["optimized"]):
        if metrics is not None and exported["candidates"]:
            assert any(all(candidate[key] == value for key, value in metrics.items()) for candidate in compact)


@pytest.mark.asyncio
@pytest.mark.parametrize("already_connected", [False, True], ids=["run-before-live", "run-during-live"])
async def test_http_run_is_read_through_connected_live_without_action_ack(evidence_client, monkeypatch, already_connected):
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    exported = None if already_connected else api_run(evidence_client)
    try:
        ticket = manager.issue_session(ORIGIN)
        assert (await harness.start())["type"] == "websocket.accept"
        await harness.send({"type": "auth", "token": ticket["token"]})
        assert (await harness.event())["type"] == "ready"
        context = workspace() if already_connected else select_run(workspace(), exported)
        await harness.send({"type": "context", "context": context})
        await eventually(lambda: manager.client.sessions and manager.client.sessions[-1].sent)
        session = manager.client.sessions[-1]
        tools = manager._records[ticket["resume_token"]].tools
        if already_connected:
            exported = api_run(evidence_client)
            context = select_run(context, exported)
            await harness.send({"type": "context", "context": context})
            await eventually(lambda: tools.context.selected_run is not None)

        before = read_state(tools)
        with no_calculation(monkeypatch):
            await session.events.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
                types.FunctionCall(id="explain-ui-run", name="get_scenario_result", args={}),
            ])))
            notification = await harness.event()
            assert notification["type"] == "explanation_status"
            assert notification["status"] == "ok" and notification["run_id"] == exported["run"]["id"]
            assert "action_id" not in notification
            await eventually(lambda: session.responses)
        response = session.responses[0]["function_responses"][0]
        assert response.id == "explain-ui-run" and response.name == "get_scenario_result"
        assert_saved(response.response, exported, context)
        assert "acknowledged" not in response.response and "action_id" not in response.response
        assert read_state(tools) == before
        assert tools.result is None and not tools.actions
        assert harness.outgoing.empty()
        assert run_evidence.get_run(exported["run"]["id"]) == exported
    finally:
        if harness.task is not None and not harness.task.done():
            await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("proposed", [False, True], ids=["accepted-workspace", "reviewed-proposal"])
async def test_live_run_is_read_after_authoritative_action_ack(monkeypatch, proposed):
    context = workspace()
    if proposed:
        context.update(revision=4, accepted_revision=2, can_undo=True,
                       proposal={"id": "proposal-lighting", "version": 3, "base_revision": 2, "status": "review"})
    tools = LiveTools()
    tools.set_context(context)
    response, events = await tools.dispatch("calculate", "run_lighting_comparison", {})
    assert response["status"] == "pending_application" and events[0]["type"] == "result"
    exported = events[0]["result"]
    assert exported["run"] is not None and run_evidence.get_run(exported["run"]["id"]) == exported
    assert tools.result is None and tools.context.selected_run is None
    receipt = await acknowledge_result(tools, events)
    assert receipt["status"] == "ok" and receipt["acknowledged"] is True
    assert not tools.actions
    selected = tools.context.model_dump()
    assert selected["selected_run"]["proposal_id"] == ("proposal-lighting" if proposed else None)
    assert selected["selected_run"]["proposal_version"] == (3 if proposed else None)
    with no_calculation(monkeypatch):
        explanation = await read_saved(tools)
    assert_saved(explanation, exported, selected)


@pytest.mark.asyncio
async def test_sample_explanation_matches_exact_export_and_formula_evidence(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    context = select_run(workspace(), exported)
    tools = LiveTools()
    tools.set_context(context)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert_saved(response, exported, context)
    result, evidence = response["result"], response["run"]["evidence"]
    assert result["source"] == response["run"]["source"] == "sample"
    assert result["model_version"] == response["run"]["model_version"] == core.MODEL_VERSION
    assert result["status"] == response["run"]["status"] == "optimized"
    assert result["configurations_evaluated"] == evidence["configurations_evaluated"] == 33
    assert result["feasible_configurations"] == evidence["feasible_configurations"] == 25
    assert result["baseline"] == evidence["baseline"] == {
        "photoperiod_hours": 16, "dim_fraction": 1, "daily_energy_kwh": 10.68,
        "period_energy_kwh": 3898.2, "period_energy_cost_usd": 584.73,
        "peak_modeled_watts": 645, "dli_mol_m2_day": 20.16,
        "period_water_liters": 5475, "canopy_sqft": 32,
    }
    assert result["optimized"] == evidence["selected"] == {
        "photoperiod_hours": 12, "dim_fraction": 1, "daily_energy_kwh": 8.28,
        "period_energy_kwh": 3022.2, "period_energy_cost_usd": 453.33,
        "peak_modeled_watts": 645, "dli_mol_m2_day": 15.12,
        "period_water_liters": 5475, "canopy_sqft": 32,
    }
    assert result["savings"] == evidence["savings"] == {
        "period_energy_kwh": 876, "period_energy_cost_usd": 131.4, "energy_pct": 22.47,
        "water_liters": None, "yield_gain_lb": None, "avoided_capex_usd": None,
        "new_equipment_required_by_scenario_usd": 0,
    }
    assert evidence["horizon"] == {"operating_days": 365, "electricity_usd_kwh": 0.15}
    assert {entry["field"]: entry["value"] for entry in evidence["inputs"]} == response["run"]["input_snapshot"]
    assert "synthetic" in evidence["summary"].lower()
    assert any("synthetic" in item.lower() for item in evidence["assumptions"])
    assert all(item in evidence["limitations"] for item in exported["limitations"])
    assert any("not proof of maintained yield" in item for item in evidence["limitations"])
    assert not evidence["missing_inputs"]
    formulas = {(item["scope"], item["metric"]): item for item in evidence["formulas"]}
    for key, raw, unit in (
        (("baseline", "daily_energy_kwh"), (600 * 16 + 45 * 24) / 1000, "kWh/day"),
        (("selected", "daily_energy_kwh"), (600 * 12 + 45 * 24) / 1000, "kWh/day"),
        (("selected", "dli_mol_m2_day"), 350 * 12 * 3600 / 1_000_000, "mol/m^2/day"),
        (("savings", "period_energy_kwh"), (10.68 - 8.28) * 365, "kWh"),
        (("savings", "period_energy_cost_usd"), (10.68 - 8.28) * 365 * 0.15, "USD"),
    ):
        formula = formulas[key]
        assert formula["raw_value"] == pytest.approx(raw)
        assert formula["unit"] == unit and formula["expression"] and "=" in formula["substituted"]
    for formula in formulas.values():
        assert formula["reported_value"] == evidence[formula["scope"]][formula["metric"]]
        assert round(formula["raw_value"], formula["round_digits"]) == formula["reported_value"]


@pytest.mark.asyncio
async def test_new_inputs_select_new_run_and_old_run_keeps_original_snapshot(evidence_client, monkeypatch):
    original = api_run(evidence_client)
    first_context = select_run(workspace(), original)
    tools = LiveTools()
    tools.set_context(first_context)
    latest = api_run(evidence_client, lighting_watts=300, operating_days=30, electricity_usd_kwh=0.25)
    assert latest["run"]["id"] != original["run"]["id"]
    latest_context = workspace(lighting_watts=300, operating_days=30, electricity_usd_kwh=0.25)
    latest_context["revision"] = 2
    latest_context = select_run(latest_context, latest)
    tools.set_context(latest_context)
    with no_calculation(monkeypatch):
        response = await read_saved(tools, "latest")
        assert_saved(response, latest, latest_context)
        assert response["result"]["savings"]["period_energy_kwh"] == 36
        assert response["result"]["savings"]["period_energy_cost_usd"] == 9
        old_selection = {**latest_context, "selected_run": first_context["selected_run"]}
        tools.set_context(old_selection)
        response = await read_saved(tools, "earlier", {
            "run_id": original["run"]["id"], "workspace_revision": first_context["revision"],
        })
        assert_saved(response, original, old_selection, earlier=True)
        assert "earlier" in response["message"].lower()
        assert response["run"]["input_snapshot"]["lighting_watts"] == 600
        assert response["run"]["evidence"]["horizon"]["operating_days"] == 365
    assert run_evidence.get_run(original["run"]["id"]) == original
    assert run_evidence.get_run(latest["run"]["id"]) == latest


@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"confirmed": False}, {"ppfd_full": None}, {"ppfd_full": 0}, {"min_dli": None},
    {"length_ft": 0, "lighting_watts": 0, "operating_days": 0},
    {"power_limit_watts": 1},
], ids=["unconfirmed", "missing-ppfd", "unknown-ppfd", "missing-dli", "unfinished-form", "infeasible-form"])
async def test_current_review_gates_do_not_block_earlier_evidence(evidence_client, monkeypatch, changes):
    exported = api_run(evidence_client)
    context = select_run(workspace(), exported)
    tools = LiveTools()
    tools.set_context(context)
    context["revision"] += 1
    context["scenario"].update(changes)
    context["has_result"] = False
    context["assets"][0]["confirmed"] = False
    context["assumptions"] = {"min_dli": {
        "label": "Unvalidated crop-stage target", "source": "User's tentative target", "growth_stage": "vegetative",
    }}
    tools.set_context(context)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert_saved(response, exported, context, earlier=True)


@pytest.mark.asyncio
async def test_read_during_pending_draft_preserves_proposal_and_transaction_history(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    tools.observe_user_transcript("The combined load is 300 watts")
    _, events = await tools.dispatch("draft", "propose_update", proposal())
    assert events[0]["type"] == "draft" and tools.actions and tools.pending
    with no_calculation(monkeypatch):
        response = await read_saved(tools, "pending-draft")
    assert_saved(response, exported, tools.context.model_dump())

    proposed = draft_context(tools.context.model_dump(), events[0]["draft"])
    tools.acknowledge(events[0]["action_id"], "applied", "Proposal rendered", proposed)
    assert (await tools.wait_action(events[0]["action_id"]))[0]["status"] == "pending_review"
    assert tools.context.proposal is not None and tools.settled and tools.action_receipts
    with no_calculation(monkeypatch):
        response = await read_saved(tools, "displayed-draft")
    assert_saved(response, exported, tools.context.model_dump(), earlier=True)


@pytest.mark.asyncio
async def test_alternatives_are_actual_candidates_rejected_by_entered_constraints(evidence_client, monkeypatch):
    changes = {"dimmable": True, "baseline_hours": 20, "power_limit_watts": 500, "ppfd_full": 500}
    exported = api_run(evidence_client, **changes)
    context = select_run(workspace(**changes), exported)
    tools = LiveTools()
    tools.set_context(context)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert_saved(response, exported, context)
    evidence = response["run"]["evidence"]
    assert exported["status"] == "optimized" and len(exported["candidates"]) > 300
    rejected = [item for item in evidence["alternatives"] if item["kind"] == "rejected"]
    assert {item["reason"] for item in rejected} == {"photoperiod", "minimum_dli", "modeled_power_limit"}
    for alternative in evidence["alternatives"]:
        assert alternative["candidate"] in exported["candidates"]
    for alternative in rejected:
        candidate, reason = alternative["candidate"], alternative["reason"]
        assert candidate["feasible"] is False and reason in candidate["rejected_for"]
        if reason == "photoperiod":
            assert not 10 <= candidate["photoperiod_hours"] <= 18
        elif reason == "minimum_dli":
            assert 500 * candidate["dim_fraction"] * candidate["photoperiod_hours"] * 0.0036 < 15
        else:
            assert 600 * candidate["dim_fraction"] + 45 > 500
    constraints = {item["name"]: item for item in evidence["constraints"]}
    assert constraints["photoperiod"]["minimum"] == 10 and constraints["photoperiod"]["maximum"] == 18
    assert constraints["minimum_dli"]["minimum"] == 15
    assert constraints["modeled_power_limit"]["maximum"] == 500
    for reason, constraint in constraints.items():
        assert constraint["rejected_configurations"] == sum(reason in c["rejected_for"] for c in exported["candidates"])
        assert constraint["evaluated"] is True and constraint["selected_passed"] is True
    assert constraints["photoperiod"]["baseline_passed"] is False
    assert constraints["modeled_power_limit"]["baseline_passed"] is False
    nearest = next(item["candidate"] for item in evidence["alternatives"] if item["kind"] == "nearest_feasible")
    assert nearest["feasible"] and not nearest["rejected_for"]
    assert (nearest["photoperiod_hours"], nearest["dim_fraction"]) != (
        exported["optimized"]["photoperiod_hours"], exported["optimized"]["dim_fraction"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("hours,status", [(11.75, "tested"), (11.8, "not_tested")],
                         ids=["actual-dli-rejection", "off-grid-not-tested"])
async def test_requested_alternative_uses_full_saved_candidates_and_original_constraints(
    evidence_client, monkeypatch, hours, status,
):
    exported = api_run(evidence_client)
    context = select_run(workspace(), exported)
    tools = LiveTools()
    tools.set_context(context)
    with no_calculation(monkeypatch):
        compact = await read_saved(tools, "summary")
        assert "requested_alternative" not in compact
        assert not any(candidate["photoperiod_hours"] == hours for candidate in compact["result"]["candidates"])
        context["revision"] += 1
        context["scenario"].update(min_dli=14, ppfd_full=None, confirmed=False)
        context["has_result"] = False
        tools.set_context(context)
        response = await read_saved(tools, "alternative", {
            "run_id": exported["run"]["id"], "workspace_revision": 1,
            "alternative_hours": hours, "alternative_dim": 1,
        })
    assert_saved(response, exported, context, earlier=True)
    requested = response["requested_alternative"]
    assert set(requested) == {"status", "candidate", "message"}
    assert requested["status"] == status and requested["message"]
    if status == "tested":
        candidate = next(candidate for candidate in exported["candidates"]
                         if candidate["photoperiod_hours"] == 11.75 and candidate["dim_fraction"] == 1)
        assert requested["candidate"] == candidate
        assert candidate["feasible"] is False and candidate["rejected_for"] == ["minimum_dli"]
        assert candidate["dli_mol_m2_day"] == 14.805
        constraint = next(item for item in response["run"]["evidence"]["constraints"] if item["name"] == "minimum_dli")
        assert constraint["minimum"] == 15 and candidate["dli_mol_m2_day"] < constraint["minimum"]
        requested["candidate"]["rejected_for"].clear()
        requested["candidate"]["dli_mol_m2_day"] = 99
    else:
        assert requested["candidate"] is None
        assert not any(candidate["photoperiod_hours"] == hours for candidate in exported["candidates"])
    assert run_evidence.get_run(exported["run"]["id"]) == exported


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [{"alternative_hours": 11.75}, {"alternative_dim": 1}],
                         ids=["hours-without-dim", "dim-without-hours"])
async def test_requested_alternative_requires_both_coordinates(evidence_client, monkeypatch, arguments):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    lookup = Mock(side_effect=AssertionError("Incomplete alternative coordinates must not retrieve evidence."))
    monkeypatch.setattr(live_tools, "get_run", lookup)
    before = read_state(tools)
    with no_calculation(monkeypatch):
        response, events = await tools.dispatch("incomplete-alternative", "get_scenario_result", arguments)
    assert response["status"] == "error" and response["code"] == "invalid_arguments"
    assert not events and "requested_alternative" not in response
    assert read_state(tools) == before
    lookup.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("changes,status,missing", [
    ({"ppfd_full": None}, "needs_measurement", "ppfd_full"),
    ({"confirmed": False}, "needs_measurement", "confirmed"),
    ({"power_limit_watts": 1}, "no_feasible_configuration", None),
], ids=["missing-ppfd-run", "unconfirmed-run", "infeasible-run"])
async def test_abstention_and_infeasibility_are_saved_evidence(evidence_client, monkeypatch, changes, status, missing):
    exported = api_run(evidence_client, **changes)
    context = select_run(workspace(**changes), exported)
    tools = LiveTools()
    tools.set_context(context)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert_saved(response, exported, context)
    evidence = response["run"]["evidence"]
    assert response["result"]["status"] == response["run"]["status"] == status
    assert response["result"]["optimized"] is evidence["selected"] is None
    assert response["result"]["savings"] is evidence["savings"] is None
    assert all(formula["scope"] == "baseline" for formula in evidence["formulas"])
    if missing:
        assert missing in evidence["missing_inputs"]
        assert evidence["configurations_evaluated"] == evidence["feasible_configurations"] == 0
        assert not evidence["alternatives"] and not response["result"]["candidates"]
    else:
        assert evidence["configurations_evaluated"] == 33 and evidence["feasible_configurations"] == 0
        assert all("modeled_power_limit" in c["rejected_for"] for c in exported["candidates"])
        assert any(item["reason"] == "modeled_power_limit" for item in evidence["alternatives"])


@pytest.mark.asyncio
@pytest.mark.parametrize("has_result", [False, True], ids=["no-result", "forged-legacy-flag"])
@pytest.mark.parametrize("changes", [{}, {"confirmed": False, "ppfd_full": None}, {"power_limit_watts": 1}],
                         ids=["valid-inputs", "missing-inputs", "infeasible-inputs"])
async def test_result_flag_alone_never_causes_calculation(monkeypatch, has_result, changes):
    context = workspace(**changes)
    context["has_result"] = has_result
    tools = LiveTools()
    tools.set_context(context)
    lookup = Mock(side_effect=AssertionError("No selected run exists to retrieve."))
    monkeypatch.setattr(live_tools, "get_run", lookup)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert response["status"] == "no_result"
    assert response["code"] == ("run_reference_missing" if has_result else "no_result")
    assert "run" not in response and "result" not in response
    lookup.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("arguments", [
    {"run_id": "stale-run"}, {"workspace_revision": 0},
    {"run_id": "stale-run", "workspace_revision": 2},
], ids=["id", "revision", "both"])
async def test_explicit_stale_identity_fails_before_registry_lookup(evidence_client, monkeypatch, arguments):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    lookup = Mock(side_effect=AssertionError("A stale reference must not be read."))
    monkeypatch.setattr(live_tools, "get_run", lookup)
    with no_calculation(monkeypatch):
        response = await read_saved(tools, arguments=arguments)
    assert response["status"] == "error" and response["code"] == "stale_run"
    assert "run" not in response and "result" not in response
    lookup.assert_not_called()


@pytest.mark.asyncio
async def test_missing_registry_run_does_not_fall_back_to_cached_live_result(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    context = select_run(workspace(), exported)
    context["selected_run"]["id"] = "absent-run"
    tools = LiveTools()
    tools.set_context(context)
    tools.result, tools.result_revision = deepcopy(exported), context["revision"]
    assert run_evidence.get_run("absent-run") is None
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert response["status"] == "error" and response["code"] == "run_unavailable"
    assert "run" not in response and "result" not in response


@pytest.mark.asyncio
async def test_registry_failure_is_sanitized_and_read_only(evidence_client, monkeypatch, caplog):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    private_detail = "private-registry-canary-account-path"
    lookup = Mock(side_effect=RuntimeError(private_detail))
    monkeypatch.setattr(live_tools, "get_run", lookup)
    with no_calculation(monkeypatch):
        response = await read_saved(tools)
    assert response["status"] == "error" and response["code"] == "run_retrieval_failed"
    assert "run" not in response and "result" not in response
    assert private_detail not in json.dumps(response) + caplog.text
    lookup.assert_called_once_with(exported["run"]["id"])


@pytest.mark.asyncio
async def test_cancelled_explanation_has_no_read_notification_or_registry_access(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    assert tools.cancel(["cancelled-explanation"]) == []
    before = read_state(tools)
    lookup = Mock(side_effect=AssertionError("Cancelled calls must not retrieve evidence."))
    monkeypatch.setattr(live_tools, "get_run", lookup)
    with no_calculation(monkeypatch):
        assert await tools.dispatch("cancelled-explanation", "get_scenario_result", {}) == ({"status": "cancelled"}, [])
    assert read_state(tools) == before and not tools.calls
    lookup.assert_not_called()


@pytest.mark.asyncio
async def test_explanation_calls_deduplicate_and_remain_bounded(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    tools = LiveTools()
    tools.set_context(select_run(workspace(), exported))
    lookup = Mock(wraps=run_evidence.get_run)
    monkeypatch.setattr(live_tools, "get_run", lookup)
    before = read_state(tools)
    with no_calculation(monkeypatch):
        assert (await read_saved(tools, "same"))["status"] == "ok"
        assert await tools.dispatch("same", "get_scenario_result", {}) == ({"status": "duplicate"}, [])
        assert await tools.dispatch("same", "get_scenario_result", {"run_id": exported["run"]["id"]}) == (
            {"status": "call_id_conflict"}, [],
        )
        assert lookup.call_count == 1 and len(tools.calls) == 1
        for index in range(1, live_tools.MAX_CALLS):
            assert (await read_saved(tools, f"read-{index}"))["status"] == "ok"
        assert await tools.dispatch("overflow", "get_scenario_result", {}) == (
            {"status": "error", "code": "tool_limit"}, [],
        )
    assert len(tools.calls) == lookup.call_count == live_tools.MAX_CALLS
    assert read_state(tools) == before


@pytest.mark.asyncio
async def test_mutating_export_or_explanation_cannot_change_canonical_registry(evidence_client, monkeypatch):
    exported = api_run(evidence_client)
    canonical = deepcopy(exported)
    context = select_run(workspace(), exported)
    tools = LiveTools()
    tools.set_context(context)
    exported["run"]["input_snapshot"]["lighting_watts"] = 999
    exported["baseline"]["daily_energy_kwh"] = 999
    exported["candidates"].clear()
    exported["run"]["evidence"]["alternatives"][0]["candidate"]["rejected_for"].append("forged")
    with no_calculation(monkeypatch):
        response = await read_saved(tools, "first")
        assert_saved(response, canonical, context)
        response["run"]["input_snapshot"]["ppfd_full"] = 999
        response["run"]["evidence"]["savings"]["energy_pct"] = 99
        response["result"]["baseline"]["daily_energy_kwh"] = 999
        response["result"]["candidates"].clear()
        assert_saved(await read_saved(tools, "second"), canonical, context)
    assert run_evidence.get_run(canonical["run"]["id"]) == canonical


@pytest.mark.parametrize("changes", [
    {"proposal_id": "proposal", "proposal_version": None},
    {"proposal_id": None, "proposal_version": 1},
    {"accepted_revision": 2}, {"workspace_revision": True}, {"proposal_version": True},
], ids=["missing-proposal-version", "missing-proposal-id", "future-accepted", "bool-revision", "bool-version"])
def test_run_reference_rejects_inconsistent_versions(changes):
    reference = {"id": "saved-run", "workspace_revision": 1, "accepted_revision": 0,
                 "proposal_id": None, "proposal_version": None, **changes}
    with pytest.raises(ValidationError):
        RunReference.model_validate(reference)


def test_workspace_rejects_future_run_and_client_supplied_result():
    context = workspace()
    context["selected_run"] = {"id": "saved-run", "workspace_revision": 2, "accepted_revision": 0,
                               "proposal_id": None, "proposal_version": None}
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(context)
    context["selected_run"]["workspace_revision"] = 1
    context["result"] = {"savings": {"energy_pct": 99}}
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(context)
