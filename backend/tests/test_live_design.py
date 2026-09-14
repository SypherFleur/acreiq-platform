"""Offline design acceptance: real-turn evidence, version transactions and UI receipts."""

import asyncio
from copy import deepcopy

import pytest
from pydantic import ValidationError

from backend import live_tools
from backend.live_tools import LiveTools, WorkspaceContext, tool_declarations
from backend.tests.test_live_tools import acknowledge_result, draft_context, workspace


def dimensions(length=20, width=10, **extra):
    return {"reason": "Revised room schematic", "inputs": [
        {"field": "length_ft", "value": length, "unit": "ft"},
        {"field": "width_ft", "value": width, "unit": "ft"},
    ], **extra}


def ready(text=None, **changes):
    tools = LiveTools()
    tools.set_context(workspace(**changes))
    if text:
        tools.observe_user_transcript(text)
    return tools


async def display(tools, args=None, call_id="draft"):
    response, events = await tools.dispatch(call_id, "propose_update", args or dimensions())
    assert response["status"] == "pending_application", response
    event = events[0]
    context = draft_context(tools.context.model_dump(), event["draft"])
    acknowledged, _ = tools.acknowledge(event["action_id"], "applied", "Rendered", context)
    assert acknowledged["status"] == "acknowledged"
    receipt, _ = await tools.wait_action(event["action_id"])
    assert receipt["acknowledged"] and receipt["status"] == "pending_review"
    return context, event


@pytest.mark.asyncio
@pytest.mark.parametrize("speech", ["Make the room 20 x 10 ft and keep the canopy the same",
    "Make the room twenty by ten feet; keep the canopy the same",
    "Set length to 20 feet and width to 10 feet. Keep canopy the same."])
async def test_grouped_dimensions_no_quotes_proposed_before_adoption(speech):
    tools = ready(speech)
    accepted = tools.context.model_dump()
    response, events = await tools.dispatch("group", "propose_update", dimensions())
    assert response["status"] == "pending_application"
    assert "result" not in response and tools.context.model_dump() == accepted
    draft = events[0]["draft"]
    assert draft["provenance"] == {"turn_ids": [tools.user_turns[-1]["id"]], "basis": "user_instruction"}
    assert len(draft["inputs"]) == 2 and "user_statement" not in str(draft)
    proposed = draft_context(accepted, draft)
    assert proposed["scenario"]["canopy_sqft"] == 32
    assert proposed["scenario"]["min_dli"] == 15
    assert proposed["scenario"]["source"] == "sample" and not proposed["scenario"]["confirmed"]
    # React may send the regular context effect before its post-render receipt.
    assert tools.set_context(proposed) == []
    assert events[0]["action_id"] in tools.actions
    tools.acknowledge(events[0]["action_id"], "applied", "Rendered", proposed)
    receipt, _ = await tools.wait_action(events[0]["action_id"])
    assert receipt["acknowledged"] and receipt["status"] == "pending_review"
    assert tools.context.accepted_revision == accepted["accepted_revision"]


@pytest.mark.asyncio
async def test_conflict_gets_one_focused_question_and_short_answer_resolves_both_dimensions():
    tools = ready("Make the room 20 by 10 or 24 by 10 feet")
    response, events = await tools.dispatch("conflict", "propose_update", dimensions())
    assert not events and response["code"] == "clarification_required"
    assert response["message"] == "Which length should I use: 20 or 24 ft?"
    old_turn = tools.user_turns[-1]["id"]
    tools.observe_user_transcript("Twenty feet")
    response, events = await tools.dispatch("resolved", "propose_update", dimensions())
    assert response["status"] == "pending_application", response
    assert events[0]["draft"]["provenance"]["turn_ids"] == [old_turn, tools.user_turns[-1]["id"]]


@pytest.mark.asyncio
async def test_one_dimension_call_requests_internal_grouping_not_user_repetition():
    tools = ready("Make the room 20 by 10 feet")
    args = dimensions()
    args["inputs"].pop()
    response, events = await tools.dispatch("half", "propose_update", args)
    assert response["code"] == "group_dimensions" and not events
    assert "do not ask the user to repeat" in response["message"]


@pytest.mark.asyncio
async def test_keep_canopy_rejects_even_delegated_change_and_retains_same_value():
    tools = ready("Design it for me, keep canopy the same")
    args = dimensions(provenance={"basis": "delegated_design"})
    args["inputs"].append({"field": "canopy_sqft", "value": 40, "unit": "ft2"})
    assert (await tools.dispatch("wrong", "propose_update", args))[0]["code"] == "preserve_constraint"
    args["inputs"][-1]["value"] = 32
    _, events = await tools.dispatch("right", "propose_update", args)
    assert draft_context(tools.context.model_dump(), events[0]["draft"])["scenario"]["canopy_sqft"] == 32


@pytest.mark.asyncio
@pytest.mark.parametrize("speech", ["Use bazil as the crop", "The crop sounds like basil", "Maybe basil or kale"])
async def test_unclear_crop_not_silently_substituted(speech):
    tools = ready(speech)
    response, events = await tools.dispatch("crop", "propose_update", {"reason": "Crop label", "crop": "basil"})
    assert response["code"] == "clarification_required" and not events
    assert response["message"] == "Which crop name should I use for the label?"


@pytest.mark.asyncio
async def test_basil_only_preserves_light_water_and_sample_provenance():
    tools = ready("Select basil as the crop")
    before = tools.context.model_dump()
    proposed, _ = await display(tools, {"reason": "Crop label only", "crop": "basil"})
    assert proposed["crop"] == "basil"
    assert {k: v for k, v in proposed["scenario"].items() if k != "confirmed"} == {
        k: v for k, v in before["scenario"].items() if k != "confirmed"}
    assert proposed["assumptions"] == {}


@pytest.mark.asyncio
async def test_crop_requirement_must_be_sourced_assumption_and_checkbox_never_unlocks_solver():
    tools = ready("Select basil and set target DLI to 12")
    args = {"reason": "Tentative crop requirement", "crop": "basil", "inputs": [
        {"field": "min_dli", "value": 12, "unit": "mol/m2/day"}]}
    assert (await tools.dispatch("unsourced", "propose_update", args))[0]["code"] == "crop_requirement_source"
    assumption = {"label": "Unverified illustrative requirement", "source": "User supplied reference, not verified",
                  "growth_stage": "Vegetative, user-proposed"}
    args["inputs"][0]["assumption"] = assumption
    proposed, _ = await display(tools, args, "sourced")
    assert proposed["assumptions"] == {"min_dli": assumption}
    proposed["scenario"]["confirmed"] = True
    proposed["assets"][0]["confirmed"] = True
    tools.set_context(proposed)
    response, events = await tools.dispatch("blocked", "run_lighting_comparison", {})
    assert response["code"] == "unresolved_assumptions" and not events and tools.result is None


@pytest.mark.asyncio
async def test_genuine_you_decide_can_start_zero_change_version_without_adoption():
    tools = ready("You decide")
    proposed, event = await display(tools, {"reason": "Start scoped local design", "provenance": {"basis": "delegated_design"}})
    assert not event["draft"]["inputs"] and not event["draft"]["inventory"]
    assert proposed["proposal"]["status"] == "review" and proposed["accepted_revision"] == 0
    assert event["draft"]["provenance"]["basis"] == "delegated_design"


@pytest.mark.asyncio
async def test_delegation_cannot_invent_measurements_or_escape_explicit_geometry_scope():
    for field, value in (("ppfd_full", 500), ("lighting_watts", 100), ("min_dli", 10), ("baseline_hours", 15)):
        tools = ready("Choose the dimensions of this room. You decide.")
        response, events = await tools.dispatch("scope", "propose_update", {"reason": "Design", "inputs": [
            {"field": field, "value": value, "unit": live_tools.INPUT_UNITS[field]}], "provenance": {"basis": "delegated_design"}})
        assert response["code"] == "clarification_required" and not events


@pytest.mark.asyncio
async def test_delegated_geometric_choices_have_explicit_assumptions():
    tools = ready("Choose the room dimensions. You decide")
    proposed, event = await display(tools, dimensions(provenance={"basis": "delegated_design"}))
    assert set(proposed["assumptions"]) == {"length_ft", "width_ft"}
    assert all("not a measurement" in p["assumption"]["label"] for p in event["draft"]["inputs"])


@pytest.mark.asyncio
async def test_delayed_partial_and_cumulative_transcriptions_consolidated_internally():
    tools = ready()
    task = asyncio.create_task(tools.dispatch("delayed", "propose_update", dimensions()))
    await asyncio.sleep(0.01)
    turn_id = tools.observe_user_transcript("Make the room twenty", finished=False)
    await asyncio.sleep(0.01)
    assert not task.done()
    tools.observe_user_transcript("Make the room twenty by ten feet", finished=True)
    response, events = await task
    assert response["status"] == "pending_application"
    assert len(tools.user_turns) == 1 and tools.user_turns[0]["text"] == "Make the room twenty by ten feet"
    assert events[0]["draft"]["provenance"]["turn_ids"] == [turn_id]


@pytest.mark.asyncio
async def test_missing_evidence_is_internal_retry_not_verbatim_prompt(monkeypatch):
    monkeypatch.setattr(live_tools, "EVIDENCE_WAIT_SECONDS", 0.01)
    tools = ready()
    args = dimensions()
    args["inputs"][0]["user_statement"] = "Make the room twenty by ten feet"
    response, events = await tools.dispatch("fake", "propose_update", args)
    assert response["code"] == "evidence_pending" and not events
    assert "retry internally" in response["message"]
    tools.observe_user_transcript("Make the room twenty by ten feet")
    assert (await tools.dispatch("real", "propose_update", dimensions()))[0]["status"] == "pending_application"


@pytest.mark.asyncio
async def test_legacy_quote_is_not_authority_actual_numeric_evidence_is():
    tools = ready("Set the lighting schedule to fifteen hours per day")
    args = {"reason": "Schedule", "inputs": [{"field": "baseline_hours", "value": 15, "unit": "h/day",
                                               "user_statement": "fabricated unrelated quote"}]}
    response, events = await tools.dispatch("valid", "propose_update", args)
    assert response["status"] == "pending_application" and "fabricated" not in str(events)
    tools.cancel(["valid"])
    args["inputs"][0]["value"] = 13
    assert (await tools.dispatch("invalid", "propose_update", args))[0]["code"] == "clarification_required"


@pytest.mark.asyncio
async def test_forged_or_stale_user_turn_ids_cannot_authorize_changes(monkeypatch):
    monkeypatch.setattr(live_tools, "EVIDENCE_WAIT_SECONDS", 0.01)
    tools = ready("Make room 20 by 10 feet")
    old = tools.user_turns[-1]["id"]
    tools.observe_user_transcript("Do not change the dimensions")
    for ids, expected in (([old], "stale_evidence"), (["assistant-1"], "evidence_pending")):
        response, events = await tools.dispatch(expected, "propose_update", dimensions(provenance={"turn_ids": ids}))
        assert response["code"] == expected and not events


@pytest.mark.asyncio
async def test_preview_with_missing_real_measurements_cannot_get_synthetic_savings():
    tools = ready("Make room 20 by 10 feet", source="manual", ppfd_full=None)
    proposed, _ = await display(tools)
    assert proposed["scenario"]["source"] == "manual" and proposed["scenario"]["ppfd_full"] is None
    assert (await tools.dispatch("before-review", "run_lighting_comparison", {}))[0]["status"] == "needs_review"
    proposed["scenario"]["confirmed"] = True
    proposed["assets"][0]["confirmed"] = True
    tools.set_context(proposed)
    _, events = await tools.dispatch("abstain", "run_lighting_comparison", {})
    response = await acknowledge_result(tools, events)
    assert response["result"]["status"] == "needs_measurement"
    assert response["result"]["savings"] is None


def action_context(before, action, accepted=None):
    after = deepcopy(before)
    after["revision"] += 1
    if action == "revise":
        after["proposal"]["version"] += 1
        after["proposal"]["status"] = "revising"
    else:
        after["proposal"] = None
        if action in {"approve", "undo"}:
            after["accepted_revision"] = after["revision"]
        if action == "approve":
            after["can_undo"] = True
        else:
            for key in ("scenario", "assets", "crop", "assumptions"):
                after[key] = deepcopy(accepted[key])
            after["has_result"] = False
    return after


@pytest.mark.asyncio
@pytest.mark.parametrize("action,speech", [("approve", "Looks good, use this version please"),
    ("revise", "I'd like to revise this design"), ("discard", "Discard that proposal please")])
async def test_contextual_voice_actions_use_same_version_contract_as_ui(action, speech):
    tools = ready("Make room 20 by 10 feet")
    accepted = tools.context.model_dump()
    proposed, _ = await display(tools)
    tools.observe_user_transcript(speech)
    args = {"action": action, "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]}
    response, events = await tools.dispatch("action", "manage_proposal", args)
    assert response["status"] == "pending_application"
    assert tools.context.model_dump() == proposed
    after = action_context(proposed, action, accepted)
    assert tools.set_context(after) == []
    tools.acknowledge(events[0]["action_id"], "applied", "Rendered", after)
    receipt, _ = await tools.wait_action(events[0]["action_id"])
    assert receipt["acknowledged"] and receipt["status"] == "ok"
    assert tools.context.model_dump() == after
    if action == "approve":
        assert not after["scenario"]["confirmed"]
        tools.observe_user_transcript("Undo the last change")
        response, events = await tools.dispatch("undo", "manage_proposal", {"action": "undo", "proposal_id": None, "version": None})
        assert response["status"] == "pending_application"
        undone = action_context(after, "undo", accepted)
        tools.acknowledge(events[0]["action_id"], "applied", "Restored", undone)
        assert (await tools.wait_action(events[0]["action_id"]))[0]["status"] == "ok"
        assert tools.context.scenario.length_ft == 8


@pytest.mark.asyncio
@pytest.mark.parametrize("speech", ["Yes", "Go ahead", "You decide", "Don't approve it", "Should I approve it?", "Approve it and discard it"])
async def test_ambiguous_or_negated_speech_is_not_adoption_authority(speech):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_user_transcript(speech)
    response, events = await tools.dispatch("approve", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["code"] == "clarification_required" and not events
    assert tools.context.proposal is not None


@pytest.mark.asyncio
async def test_stale_proposal_version_and_user_confirmation_cannot_target_new_edits():
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_user_transcript("Use this version")
    edited = deepcopy(proposed)
    edited["revision"] += 1
    edited["proposal"]["version"] += 1
    edited["scenario"]["length_ft"] = 24
    tools.set_context(edited)
    args = {"action": "approve", "proposal_id": proposed["proposal"]["id"], "version": 1}
    assert (await tools.dispatch("old-version", "manage_proposal", args))[0]["code"] == "stale_proposal"
    args["version"] = 2
    assert (await tools.dispatch("old-authority", "manage_proposal", args))[0]["code"] == "stale_evidence"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "rejected", "wrong_value", "external_edit", "confirmed"])
async def test_failed_or_stale_receipts_never_return_success(failure):
    tools = ready("Make room 20 by 10 feet")
    response, events = await tools.dispatch("draft", "propose_update", dimensions())
    action_id = response["action_id"]
    proposed = draft_context(tools.context.model_dump(), events[0]["draft"])
    if failure == "timeout":
        receipt, _ = await tools.wait_action(action_id, timeout=0.001)
    else:
        if failure == "wrong_value":
            proposed["scenario"]["canopy_sqft"] = 40
        if failure == "confirmed":
            proposed["scenario"]["confirmed"] = True
        if failure == "external_edit":
            changed = workspace(length_ft=30)
            changed["revision"] = 2
            tools.set_context(changed)
        tools.acknowledge(action_id, "rejected" if failure == "rejected" else "applied", "Model must say success", proposed)
        receipt, _ = await tools.wait_action(action_id)
    assert receipt["status"] == "error" and not receipt.get("acknowledged")
    assert "Model must say success" not in str(receipt)
    assert not tools.actions and tools.result is None


@pytest.mark.asyncio
async def test_ack_duplicates_and_interruption_preserve_displayed_proposal():
    tools = ready("Make room 20 by 10 feet")
    proposed, event = await display(tools)
    assert tools.interrupt() == []
    assert tools.cancel(["draft"]) == []
    assert tools.context.model_dump() == proposed
    assert tools.acknowledge(event["action_id"], "applied", "Duplicate", proposed)[0]["status"] == "already_settled"


@pytest.mark.asyncio
async def test_interruption_after_context_before_receipt_preserves_visible_proposal():
    tools = ready("Make room 20 by 10 feet")
    response, events = await tools.dispatch("draft", "propose_update", dimensions())
    proposed = draft_context(tools.context.model_dump(), events[0]["draft"])
    tools.set_context(proposed)
    assert tools.interrupt() == []
    assert tools.context.model_dump() == proposed
    receipt, _ = await tools.wait_action(response["action_id"])
    assert receipt["status"] == "error"


def test_context_assumptions_and_tool_schema_are_bounded_and_backwards_compatible():
    context = WorkspaceContext.model_validate(workspace())
    assert context.assumptions == {} and context.proposal is None and context.accepted_revision == 0
    bad = workspace()
    bad["assumptions"] = {"confirmed": {"label": "Known", "source": "Model", "growth_stage": "Any"}}
    with pytest.raises(ValidationError):
        WorkspaceContext.model_validate(bad)
    declarations = tool_declarations()
    assert "manage_proposal" in {d["name"] for d in declarations}
    assert not any("requires a verbatim" in d["description"] for d in declarations)
    assert "user_statement" not in str(declarations)


def test_transcript_memory_bounded_and_clear_removes_private_text():
    tools = ready()
    for i in range(100):
        tools.observe_user_transcript(f"User {i}: " + "word " * 100)
    assert len(tools.user_turns) <= 32 and len(tools.user_transcript) <= 8032
    tools.clear()
    assert not tools.user_turns and not tools.user_transcript


@pytest.mark.asyncio
@pytest.mark.parametrize("action,question,answer", [
    ("approve", "Use this version?", "Yes"),
    ("discard", "Discard this proposal?", "Yes please"),
    ("revise", "Would you like me to revise this version?", "Sure"),
])
async def test_one_actual_assistant_question_binds_later_affirmative(action, question, answer):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    count = len(tools.user_turns)
    tools.observe_assistant_transcript(question)
    tools.finish_assistant_turn()
    assert len(tools.user_turns) == count and not tools.actions
    tools.observe_user_transcript(answer)
    response, events = await tools.dispatch("yes", "manage_proposal", {"action": action,
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["status"] == "pending_application", response
    assert events[0]["action"] == action and tools.context.model_dump() == proposed


@pytest.mark.asyncio
@pytest.mark.parametrize("question", ["Use this version? And change the crop?",
    "Use this version or discard this proposal?", "Use this version and buy new lights?",
    "Could you confirm the dimensions? Use this version?", "Use this version? Actually, we should wait."])
async def test_multiple_unrelated_or_withdrawn_questions_do_not_bind_yes(question):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_assistant_transcript(question)
    tools.finish_assistant_turn()
    tools.observe_user_transcript("Yes")
    response, events = await tools.dispatch("yes", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["code"] == "clarification_required" and not events


@pytest.mark.asyncio
@pytest.mark.parametrize("intervening", ["user", "assistant", "version"])
async def test_question_binding_cleared_by_other_turn_or_version(intervening):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_assistant_transcript("Use this version?")
    tools.finish_assistant_turn()
    if intervening == "user":
        tools.observe_user_transcript("What would this change?")
    elif intervening == "assistant":
        tools.observe_assistant_transcript("Do you want a different crop?")
        tools.finish_assistant_turn()
    else:
        proposed = action_context(proposed, "revise")
        tools.set_context(proposed)
    tools.observe_user_transcript("Yes")
    response, events = await tools.dispatch("yes", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["code"] == "clarification_required" and not events


@pytest.mark.asyncio
async def test_assistant_question_without_user_answer_never_authorizes_action():
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_assistant_transcript("Use this version?")
    tools.finish_assistant_turn()
    response, events = await tools.dispatch("no-user", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["status"] == "error" and not events


@pytest.mark.asyncio
async def test_accepted_checkpoint_revision_after_several_proposal_versions():
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    for _ in range(3):
        proposed = action_context(proposed, "revise")
        tools.set_context(proposed)
    assert proposed["revision"] == 5 and proposed["accepted_revision"] == 0
    tools.observe_user_transcript("Use this version")
    response, events = await tools.dispatch("adopt", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    adopted = action_context(proposed, "approve")
    tools.acknowledge(response["action_id"], "applied", "Adopted", adopted)
    assert (await tools.wait_action(events[0]["action_id"]))[0]["status"] == "ok"
    assert tools.context.accepted_revision == tools.context.revision == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("speech", [
    "Approve the crop only, keep the dimensions", "I will approve it tomorrow",
    "Approve this version if the crop is basil", "Approve everything except the length",
    "I might approve it later", "Approve it after we measure PPFD", "We discussed how to approve it",
    "Someone said, approve it", "Do you think I should approve it?",
])
async def test_partial_conditional_or_future_approval_never_adopts_entire_proposal(speech):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_user_transcript(speech)
    response, events = await tools.dispatch("not-current-approval", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["code"] == "clarification_required" and not events
    assert tools.context.model_dump() == proposed


@pytest.mark.asyncio
@pytest.mark.parametrize("speech", ["Approve", "Accept", "I approve this version", "Please use this version now", "Yes, adopt the whole proposal please"])
async def test_clear_current_whole_version_approval_remains_natural(speech):
    tools = ready("Make room 20 by 10 feet")
    proposed, _ = await display(tools)
    tools.observe_user_transcript(speech)
    response, events = await tools.dispatch("approve", "manage_proposal", {"action": "approve",
        "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})
    assert response["status"] == "pending_application", response
    assert events[0]["action"] == "approve"
