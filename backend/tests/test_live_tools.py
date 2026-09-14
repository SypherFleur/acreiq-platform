"""Offline workspace-tool tests. No provider requests or local credentials."""

import asyncio
from copy import deepcopy
from threading import Event

import pytest
from pydantic import ValidationError

from backend import core
from backend.run_evidence import execute_run
from backend.live_tools import INPUT_UNITS, LiveTools, LiveValidationError, WorkspaceContext


def workspace(**scenario_changes):
    return {
        "revision": 1, "scenario": {**core.SAMPLE, "confirmed": True, **scenario_changes},
        "assets": [{"id": "lights", "name": "Reviewed lights", "type": "light_fixture",
                    "quantity": 2, "confidence": None, "confirmed": True}],
        "selected_asset_id": "lights", "has_result": False,
    }


def proposal(**changes):
    return {"reason": "User supplied the combined load.", "inputs": [
        {"field": "lighting_watts", "value": 300, "unit": "W",
         "user_statement": "The combined load is 300 watts"},
    ], "inventory": [], **changes}


def prepared():
    tools = LiveTools()
    tools.set_context(workspace())
    tools.observe_user_transcript("The combined load is 300 watts")
    return tools


def draft_context(before, draft):
    """Independent UI transaction model for testing the public receipt contract."""
    after = WorkspaceContext.model_validate(before).model_dump()
    after["revision"] += 1
    after["proposal"] = {"id": draft["proposal_id"], "version": draft["version"],
                         "base_revision": draft["base_revision"], "status": "review"}
    after["scenario"].update({p["field"]: p["value"] for p in draft["inputs"]})
    for patch in draft["inputs"]:
        if "assumption" in patch:
            after["assumptions"][patch["field"]] = deepcopy(patch["assumption"])
        else:
            after["assumptions"].pop(patch["field"], None)
    after["scenario"]["confirmed"] = False
    after["has_result"] = False
    after["crop"] = draft.get("crop", after["crop"])
    assets = {a["id"]: a for a in after["assets"]}
    for patch in draft["inventory"]:
        if patch["operation"] == "remove":
            assets.pop(patch["id"])
        elif patch["operation"] == "add":
            assets[patch["id"]] = {"id": patch["id"], "name": patch["name"], "quantity": patch["quantity"],
                                   "type": patch["asset_type"], "confidence": None, "confirmed": False}
        else:
            for key, target in (("name", "name"), ("quantity", "quantity"), ("asset_type", "type")):
                if key in patch:
                    assets[patch["id"]][target] = patch[key]
    after["assets"] = list(assets.values())
    for asset in after["assets"]:
        asset["confirmed"] = False
    after["scenario"]["light_count"] = sum(a["quantity"] for a in after["assets"] if a["type"] == "light_fixture")
    if after["selected_asset_id"] not in assets:
        after["selected_asset_id"] = None
    return after


async def acknowledge_result(tools, events):
    context = tools.context.model_dump()
    context["has_result"] = True
    event = events[0]
    run = event["result"].get("run")
    if run:
        proposal = context["proposal"]
        context["selected_run"] = {"id": run["id"], "workspace_revision": context["revision"],
                                   "accepted_revision": context["accepted_revision"],
                                   "proposal_id": proposal["id"] if proposal else None,
                                   "proposal_version": proposal["version"] if proposal else None}
    tools.acknowledge(event["action_id"], "applied", "Result rendered", context)
    return (await tools.wait_action(event["action_id"]))[0]


def test_context_accepts_unknown_zeros_without_defaults_or_client_results():
    value = workspace(length_ft=0, light_count=0, ppfd_full=0, baseline_dim=0, operating_days=0)
    assert WorkspaceContext.model_validate(value).scenario.length_ft == 0
    for bad in ({**value, "result": {"savings": 99}}, {**value, "revision": True}):
        with pytest.raises(ValidationError):
            WorkspaceContext.model_validate(bad)
    for field, number in (("lighting_watts", float("inf")), ("light_count", 1.5), ("baseline_hours", -1)):
        with pytest.raises(ValidationError):
            WorkspaceContext.model_validate(workspace(**{field: number}))
    del value["scenario"]["width_ft"]
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(value)


def test_context_validates_asset_ids_selection_and_limits():
    value = workspace()
    value["assets"].append(deepcopy(value["assets"][0]))
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(value)
    value = workspace()
    value["selected_asset_id"] = "absent"
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(value)


@pytest.mark.asyncio
async def test_proposal_pending_review_does_not_mutate_state_or_allow_old_state_solve():
    tools = prepared()
    before = tools.context.model_dump()
    response, events = await tools.dispatch("proposal", "propose_update", proposal())
    assert response["status"] == "pending_application"
    draft = events[0]["draft"]
    assert draft["revision"] == 1
    assert set(draft["inputs"][0]) == {"field", "value", "unit"}
    assert tools.context.model_dump() == before
    assert (await tools.dispatch("blocked", "run_lighting_comparison", {}))[0]["status"] == "needs_review"
    after = draft_context(before, draft)
    tools.acknowledge(events[0]["action_id"], "applied", "Proposed version rendered", after)
    assert (await tools.wait_action(events[0]["action_id"]))[0]["status"] == "pending_review"
    assert (await tools.dispatch("unconfirmed", "run_lighting_comparison", {}))[0]["status"] == "needs_review"
    after["scenario"]["confirmed"] = True
    after["assets"][0]["confirmed"] = True
    tools.set_context(after)
    _, events = await tools.dispatch("confirmed", "run_lighting_comparison", {})
    assert (await acknowledge_result(tools, events))["status"] == "ok"


@pytest.mark.asyncio
async def test_duplicate_and_conflicting_ids_never_repeat_actions():
    tools = prepared()
    _, events = await tools.dispatch("one", "propose_update", proposal())
    assert len(events) == 1
    assert (await tools.dispatch("one", "propose_update", proposal())) == ({"status": "duplicate"}, [])
    assert (await tools.dispatch("one", "set_twin_view", {"camera": "top"})) == ({"status": "call_id_conflict"}, [])
    assert len(tools.pending) == 1
    cancelled = tools.cancel(["one", "not-started"])
    assert cancelled == [{"type": "draft_cancelled", "id": events[0]["draft"]["id"]}]
    assert not tools.pending
    assert (await tools.dispatch("not-started", "set_twin_view", {"camera": "top"})) == ({"status": "cancelled"}, [])


@pytest.mark.asyncio
async def test_late_review_after_context_cancel_is_harmless():
    tools = prepared()
    _, events = await tools.dispatch("one", "propose_update", proposal())
    draft_id = events[0]["draft"]["id"]
    update = workspace(lighting_watts=300)
    update["revision"] = 2
    tools.set_context(update)
    assert tools.review(draft_id, "applied")["status"] == "already_settled"
    with pytest.raises(LiveValidationError):
        tools.review("unknown", "applied")


@pytest.mark.asyncio
@pytest.mark.parametrize("change", [
    {"unit": "watts"}, {"field": "light_count", "unit": "count", "value": 2},
    {"field": "confirmed", "value": True}, {"value": -1}, {"value": True},
    {"value": float("nan")}, {"value": "300"}, {"value": 0.00001},
    {"value": 400},
    {"basis": "visual"},
])
async def test_invalid_input_units_types_bounds_or_unspoken_evidence_rejected(change):
    tools = prepared()
    args = proposal()
    args["inputs"][0].update(change)
    response, events = await tools.dispatch("invalid", "propose_update", args)
    assert response["status"] == "error"
    assert not events and not tools.pending


@pytest.mark.asyncio
async def test_inventory_is_suggestion_only_and_existing_ids_are_required():
    tools = prepared()
    tools.observe_user_transcript("Review the inventory and suggest a possible fan")
    args = proposal(inputs=[], inventory=[{"operation": "add", "name": "Possible fan", "asset_type": "circulation_fan", "quantity": 1}])
    response, events = await tools.dispatch("inventory", "propose_update", args)
    assert response["status"] == "pending_application"
    assert len(tools.context.assets) == 1
    assert "Await" in response["message"]
    tools.cancel(["inventory"])
    for i, patch in enumerate([
        {"operation": "remove", "id": "absent"},
        {"operation": "update", "id": "lights", "quantity": 101},
        {"operation": "add", "name": " ", "asset_type": "other", "quantity": 1},
        {"operation": "add", "name": "Lights", "asset_type": "light_fixture", "quantity": 100},
    ]):
        assert (await tools.dispatch(f"bad-{i}", "propose_update", proposal(inputs=[], inventory=[patch])))[0]["status"] == "error"
    assert events[0]["draft"]["inventory"][0]["operation"] == "add"


@pytest.mark.asyncio
async def test_views_allow_known_ids_and_cameras_only():
    tools = prepared()
    response, events = await tools.dispatch("a", "set_twin_view", {"camera": "top", "asset_id": "lights"})
    assert events == [{"type": "view", "camera": "top", "asset_id": "lights", "action_id": response["action_id"]}]
    assert response["status"] == "pending_application"
    for i, args in enumerate(({"camera": "move"}, {"asset_id": "missing"}, {}, {"camera": "top", "x": 1})):
        assert (await tools.dispatch(f"bad-{i}", "set_twin_view", args))[0]["status"] == "error"
    assert (await tools.dispatch("bad-tool", "buy_equipment", {}))[0]["status"] == "error"


@pytest.mark.asyncio
async def test_comparison_is_real_solver_result_and_invalidates_on_input_change():
    tools = prepared()
    assert (await tools.dispatch("prior", "get_scenario_result", {}))[0]["status"] == "no_result"
    response, events = await tools.dispatch("solve", "run_lighting_comparison", {})
    assert response["status"] == "pending_application" and tools.result is None
    response = await acknowledge_result(tools, events)
    expected = core.solve(core.Scenario.model_validate(workspace()["scenario"]))
    assert {k: v for k, v in events[0]["result"].items() if k != "run"} == expected
    assert {k: v for k, v in response["result"].items() if k != "candidates"} == {k: v for k, v in expected.items() if k != "candidates"}
    assert all(candidate in expected["candidates"] for candidate in response["result"]["candidates"])
    assert len(response["result"]["candidates"]) <= 5
    assert response["result"]["savings"]["yield_gain_lb"] is None
    response["result"]["savings"]["energy_pct"] = 99
    assert (await tools.dispatch("get", "get_scenario_result", {}))[0]["result"]["savings"] == expected["savings"]
    assert (await tools.dispatch("injection", "run_lighting_comparison", {"lighting_watts": 1}))[0]["status"] == "error"
    change = workspace(lighting_watts=400)
    change["revision"] = 2
    tools.set_context(change)
    assert (await tools.dispatch("after", "get_scenario_result", {}))[0]["status"] == "no_result"


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", [None, 0])
async def test_missing_ppfd_uses_solver_abstention(missing):
    tools = LiveTools()
    tools.set_context(workspace(ppfd_full=missing))
    response, events = await tools.dispatch("solve", "run_lighting_comparison", {})
    response = await acknowledge_result(tools, events)
    assert response["result"]["status"] == "needs_measurement"
    assert events[0]["result"]["savings"] is None


@pytest.mark.asyncio
async def test_infeasibility_and_invalid_or_unreviewed_state():
    tools = LiveTools()
    tools.set_context(workspace(power_limit_watts=1))
    _, events = await tools.dispatch("solve", "run_lighting_comparison", {})
    response = await acknowledge_result(tools, events)
    assert response["result"]["status"] == "no_feasible_configuration"
    assert all("modeled_power_limit" in c["rejected_for"] for c in response["result"]["candidates"])
    for i, value in enumerate((workspace(length_ft=0), workspace(min_hours=20, max_hours=10), workspace(light_count=1))):
        other = LiveTools()
        other.set_context(value)
        assert (await other.dispatch(str(i), "run_lighting_comparison", {}))[0]["status"] in {"error", "needs_review"}
    unreviewed = workspace()
    unreviewed["assets"][0]["confirmed"] = False
    tools = LiveTools()
    tools.set_context(unreviewed)
    assert (await tools.dispatch("unreviewed", "run_lighting_comparison", {}))[0]["status"] == "needs_review"


@pytest.mark.asyncio
async def test_cancellation_or_state_change_during_solver_cannot_publish(monkeypatch):
    tools = prepared()
    entered, release = Event(), Event()
    original = core.solve

    def delayed(scenario):
        entered.set()
        assert release.wait(2)
        return original(scenario)

    monkeypatch.setattr(core, "solve", delayed)
    task = asyncio.create_task(tools.dispatch("slow", "run_lighting_comparison", {}))
    assert await asyncio.to_thread(entered.wait, 2)
    tools.cancel(["slow"])
    release.set()
    response, events = await task
    assert response["status"] == "cancelled"
    assert not events and tools.result is None


def test_revision_monotonicity_and_missing_inputs():
    tools = prepared()
    old = workspace()
    old["revision"] = 0
    with pytest.raises(LiveValidationError):
        tools.set_context(old)
    with pytest.raises(LiveValidationError):
        tools.set_context(workspace(lighting_watts=300))
    assert tools.set_context(workspace()) == []
    assert "light_count" not in INPUT_UNITS
    assert INPUT_UNITS["canopy_sqft"] == "ft2"
    assert INPUT_UNITS["operating_days"] == "day"


@pytest.mark.asyncio
async def test_limits_and_complete_state_cleanup():
    tools = prepared()
    assert (await tools.dispatch("one", "propose_update", proposal()))[0]["status"] == "pending_application"
    assert (await tools.dispatch("overlap", "propose_update", proposal()))[0]["code"] == "action_pending"
    tools.clear()
    assert tools.context is tools.result is None
    assert not any((tools.pending, tools.calls, tools.cancelled, tools.settled, tools.user_transcript, tools.actions, tools.user_turns))


@pytest.mark.asyncio
async def test_metadata_changes_keep_drafts_and_same_revision_human_confirmation_is_allowed():
    tools = prepared()
    _, events = await tools.dispatch("draft", "propose_update", proposal())
    draft_id = events[0]["draft"]["id"]
    metadata = workspace(confirmed=False)
    metadata["has_result"] = True
    metadata["selected_asset_id"] = None
    metadata["assets"][0]["confirmed"] = False
    assert tools.set_context(metadata) == []
    assert draft_id in tools.pending
    metadata["scenario"]["confirmed"] = True
    metadata["assets"][0]["confirmed"] = True
    assert tools.set_context(metadata) == []
    tools.review(draft_id, "rejected")
    response, events = await tools.dispatch("get-ui-result", "get_scenario_result", {})
    assert response["status"] == "no_result" and response["code"] == "run_reference_missing"
    assert all(event["type"] == "explanation_status" for event in events)
    metadata["scenario"]["confirmed"] = False
    tools.set_context(metadata)
    assert (await tools.dispatch("unconfirmed-get", "get_scenario_result", {}))[0]["status"] == "no_result"
    with pytest.raises(LiveValidationError):
        tools.set_context(workspace(lighting_watts=200))


@pytest.mark.asyncio
async def test_inventory_update_materializes_omitted_display_fields():
    tools = prepared()
    tools.observe_user_transcript("Review the light inventory")
    _, events = await tools.dispatch("inventory", "propose_update", proposal(inputs=[], inventory=[
        {"operation": "update", "id": "lights", "quantity": 1},
    ]))
    assert events[0]["draft"]["inventory"] == [{
        "operation": "update", "id": "lights", "name": "Reviewed lights", "asset_type": "light_fixture", "quantity": 1,
    }]


@pytest.mark.asyncio
async def test_ui_result_flag_never_substitutes_a_calculation_for_a_saved_run():
    for value in (workspace(confirmed=False), workspace(light_count=1), workspace(length_ft=0)):
        value["has_result"] = True
        tools = LiveTools()
        tools.set_context(value)
        response, events = await tools.dispatch("get", "get_scenario_result", {})
        assert response["status"] == "no_result" and response["code"] == "run_reference_missing"
        assert tools.result is None and all(event["type"] == "explanation_status" for event in events)
