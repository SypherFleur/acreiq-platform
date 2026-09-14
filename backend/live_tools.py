"""Validated, review-first workspace tools for the optional Live relay."""

import asyncio
import hashlib
import json
import re
import time
from copy import deepcopy
from contextlib import suppress
from typing import Literal
from uuid import uuid4

from pydantic import Field, TypeAdapter, ValidationError, model_validator
from pydantic.json_schema import SkipJsonSchema

if __package__:
    from . import core
    from .run_evidence import execute_run, get_run
    from .schemas import AssetType, OptimizationResult
else:
    import core
    from run_evidence import execute_run, get_run
    from schemas import AssetType, OptimizationResult

MAX_CALLS = 256
MAX_DRAFTS = 8
MAX_TOOL_BYTES = 16 * 1024
EVIDENCE_WAIT_SECONDS = 0.8
TRANSCRIPT_SETTLE_SECONDS = 0.12
ACTION_ACK_SECONDS = 3.0


class ProposalVersion(core.StrictModel):
    id: str = Field(min_length=1, max_length=64)
    version: int = Field(ge=1, le=2**53 - 1)
    base_revision: int = Field(ge=0, le=2**53 - 1)
    status: Literal["review", "revising"]


class CropAssumption(core.StrictModel):
    label: str = Field(min_length=1, max_length=160)
    source: str = Field(min_length=1, max_length=300)
    growth_stage: str = Field(min_length=1, max_length=80)

    @model_validator(mode="after")
    def not_blank(self):
        if any(not text.strip() for text in (self.label, self.source, self.growth_stage)):
            raise ValueError("Assumptions require a label, source and growth stage.")
        return self


class WorkspaceScenario(core.StrictModel):
    """The UI's unfinished scenario, without inventing defaults for unknown inputs."""

    source: Literal["sample", "manual", "photo-assisted"]
    length_ft: float = Field(ge=0, le=1000)
    width_ft: float = Field(ge=0, le=1000)
    canopy_sqft: float = Field(ge=0, le=1_000_000)
    light_count: int = Field(ge=0, le=100)
    lighting_watts: float = Field(ge=0, le=1_000_000)
    other_watts: float = Field(ge=0, le=1_000_000)
    other_hours: float = Field(ge=0, le=24)
    baseline_hours: float = Field(ge=0, le=24)
    baseline_dim: float = Field(ge=0, le=1)
    dimmable: bool
    ppfd_full: float | None = Field(ge=0, le=5000)
    min_dli: float | None = Field(ge=0, le=100)
    min_hours: float = Field(ge=0, le=24)
    max_hours: float = Field(ge=0, le=24)
    power_limit_watts: float = Field(ge=0, le=2_000_000)
    electricity_usd_kwh: float = Field(ge=0, le=10)
    operating_days: int = Field(ge=0, le=366)
    water_liters_day: float | None = Field(ge=0, le=1_000_000)
    confirmed: bool


class WorkspaceAsset(core.StrictModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=80)
    type: AssetType
    quantity: int = Field(ge=1, le=1000)
    confidence: float | None = Field(ge=0, le=1)
    confirmed: bool


class RunReference(core.StrictModel):
    id: str = Field(min_length=1, max_length=64)
    workspace_revision: int = Field(ge=0, le=2**53 - 1)
    accepted_revision: int = Field(ge=0, le=2**53 - 1)
    proposal_id: str | None = Field(default=None, min_length=1, max_length=64)
    proposal_version: int | None = Field(default=None, ge=1, le=2**53 - 1)

    @model_validator(mode="after")
    def consistent(self):
        if (self.proposal_id is None) != (self.proposal_version is None):
            raise ValueError("A proposed run needs both its proposal ID and version.")
        if self.accepted_revision > self.workspace_revision:
            raise ValueError("The accepted version cannot follow the run version.")
        return self


class WorkspaceContext(core.StrictModel):
    revision: int = Field(ge=0, le=2**53 - 1)
    scenario: WorkspaceScenario
    assets: list[WorkspaceAsset] = Field(max_length=64)
    selected_asset_id: str | None = Field(max_length=64)
    has_result: bool
    selected_run: RunReference | None = None
    accepted_revision: int = Field(default=0, ge=0, le=2**53 - 1)
    crop: str | None = Field(default=None, min_length=1, max_length=80)
    proposal: ProposalVersion | None = None
    can_undo: bool = False
    assumptions: dict[str, CropAssumption] = Field(default_factory=dict, max_length=18)

    @model_validator(mode="after")
    def consistent(self):
        ids = {asset.id for asset in self.assets}
        if len(ids) != len(self.assets) or sum(a.quantity for a in self.assets) > 1000:
            raise ValueError("Inventory IDs must be unique and total quantity at most 1000.")
        if self.selected_asset_id is not None and self.selected_asset_id not in ids:
            raise ValueError("Selected asset must exist in inventory.")
        if self.proposal is not None and self.proposal.base_revision != self.accepted_revision:
            raise ValueError("A proposal must reference the current accepted version.")
        if self.crop is not None and not self.crop.strip():
            raise ValueError("Crop label must not be blank.")
        if self.selected_run and self.selected_run.workspace_revision > self.revision:
            raise ValueError("A selected run cannot reference a future workspace version.")
        if any(key not in INPUT_UNITS for key in self.assumptions):
            raise ValueError("Assumptions must reference supported input fields.")
        return self


# Canonical units are part of the tool contract; no implicit unit conversion.
INPUT_UNITS = {
    "length_ft": "ft", "width_ft": "ft", "canopy_sqft": "ft2",
    "lighting_watts": "W", "other_watts": "W",
    "other_hours": "h/day", "baseline_hours": "h/day", "baseline_dim": "fraction",
    "dimmable": "boolean", "ppfd_full": "umol/m2/s", "min_dli": "mol/m2/day",
    "min_hours": "h/day", "max_hours": "h/day", "power_limit_watts": "W",
    "electricity_usd_kwh": "USD/kWh", "operating_days": "day", "water_liters_day": "L/day",
}


class Provenance(core.StrictModel):
    turn_ids: list[str] = Field(default_factory=list, max_length=8)
    basis: Literal["user_instruction", "delegated_design"] = "user_instruction"

    @model_validator(mode="after")
    def valid_ids(self):
        if len(set(self.turn_ids)) != len(self.turn_ids) or any(not 1 <= len(i) <= 64 for i in self.turn_ids):
            raise ValueError("Reference unique actual user turn IDs.")
        return self


class InputPatch(core.StrictModel):
    field: str = Field(min_length=1, max_length=40)
    value: float | int | bool | None
    unit: str = Field(min_length=1, max_length=24)
    # Accepted for old clients only; model-authored text is never evidence.
    user_statement: SkipJsonSchema[str | None] = Field(default=None, max_length=500, exclude=True)
    assumption: CropAssumption | None = None

    @model_validator(mode="after")
    def valid_input(self):
        if self.field not in INPUT_UNITS or self.unit != INPUT_UNITS[self.field]:
            raise ValueError("Use an allowlisted scenario field and its canonical unit.")
        info = core.Scenario.model_fields[self.field]
        # Reuse the numerical engine's per-field bounds, without requiring a complete scenario.
        TypeAdapter(info.rebuild_annotation()).validate_python(self.value, strict=True)
        if self.field not in {"dimmable", "other_watts", "other_hours", "electricity_usd_kwh", "water_liters_day"}:
            if self.value is not None and self.value < 0.001:
                raise ValueError("Positive inputs must be at least 0.001 in canonical units.")
        return self


class InventoryPatch(core.StrictModel):
    operation: Literal["add", "update", "remove"]
    id: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    asset_type: AssetType | None = None
    quantity: int | None = Field(default=None, ge=1, le=1000)

    @model_validator(mode="after")
    def valid_operation(self):
        if self.name is not None:
            self.name = self.name.strip()
            if not self.name:
                raise ValueError("An asset name must not be blank.")
        if self.operation == "add":
            if self.id is not None or None in (self.name, self.asset_type, self.quantity):
                raise ValueError("Add requires name, asset_type and quantity; the UI assigns its ID.")
        elif self.id is None:
            raise ValueError("Updates and removals require an existing ID.")
        elif self.operation == "remove" and any(
            item is not None for item in (self.name, self.asset_type, self.quantity)
        ):
            raise ValueError("Remove accepts only an ID.")
        elif self.operation == "update" and all(
            item is None for item in (self.name, self.asset_type, self.quantity)
        ):
            raise ValueError("Update must include a change.")
        return self


class Proposal(core.StrictModel):
    reason: str = Field(min_length=1, max_length=500)
    inputs: list[InputPatch] = Field(default_factory=list, max_length=18)
    inventory: list[InventoryPatch] = Field(default_factory=list, max_length=16)
    crop: str | None = Field(default=None, min_length=1, max_length=80)
    provenance: Provenance = Field(default_factory=Provenance)

    @model_validator(mode="after")
    def nonempty(self):
        if self.crop is not None:
            self.crop = self.crop.strip()
            if not self.crop:
                raise ValueError("Crop label must not be blank.")
        if len({p.field for p in self.inputs}) != len(self.inputs):
            raise ValueError("Propose each input only once.")
        ids = [p.id for p in self.inventory if p.id is not None]
        if len(set(ids)) != len(ids):
            raise ValueError("Propose each existing asset only once.")
        return self


class ProposalAction(core.StrictModel):
    action: Literal["approve", "revise", "discard", "undo"]
    proposal_id: str | None = Field(default=None, min_length=1, max_length=64)
    version: int | None = Field(default=None, ge=1, le=2**53 - 1)
    provenance: Provenance = Field(default_factory=Provenance)


class ViewRequest(core.StrictModel):
    camera: Literal["top", "perspective"] | None = None
    asset_id: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def nonempty(self):
        if self.camera is None and self.asset_id is None:
            raise ValueError("Specify a camera or existing asset.")
        return self


class NoArguments(core.StrictModel):
    pass


class ResultRequest(core.StrictModel):
    run_id: str | None = Field(default=None, min_length=1, max_length=64)
    workspace_revision: int | None = Field(default=None, ge=0, le=2**53 - 1)
    alternative_hours: float | None = Field(default=None, gt=0, le=24)
    alternative_dim: float | None = Field(default=None, gt=0, le=1)

    @model_validator(mode="after")
    def alternative_pair(self):
        if (self.alternative_hours is None) != (self.alternative_dim is None):
            raise ValueError("A tested alternative needs both hours and dim fraction.")
        return self


TOOL_MODELS = {
    "get_workspace_state": NoArguments,
    "propose_update": Proposal,
    "manage_proposal": ProposalAction,
    "set_twin_view": ViewRequest,
    "run_lighting_comparison": NoArguments,
    "get_scenario_result": ResultRequest,
}
TOOL_DESCRIPTIONS = {
    "get_workspace_state": "Read reviewed UI state, missing inputs and review status. No measurements from video.",
    "propose_update": (
        "Render one grouped, reversible proposed schematic, never adopt it. Reference actual user turn IDs "
        "from get_workspace_state, or omit IDs to resolve the latest input turn internally. Do not request "
        "quotes or exact sentences. Use delegated_design for scoped design instructions; a genuine delegation "
        "can start a zero-change version. Preserve unspecified inputs and explicit keep constraints. Crop is "
        "only a label; a crop requirement also needs an assumption with source and growth_stage. "
        "Unknown measurements never become known through delegation. "
        "Use canonical units: " + json.dumps(INPUT_UNITS, separators=(",", ":"))
    ),
    "manage_proposal": "Approve, revise, discard the active proposal ID/version, or undo the last adoption. Requires actual contextual user instruction, not delegation or an ambiguous yes. Await UI acknowledgement.",
    "set_twin_view": "Select an existing inventory asset or top/perspective schematic camera. No physical moves.",
    "run_lighting_comparison": "Run the Python solver on the current confirmed scenario and matching reviewed inventory. No arguments.",
    "get_scenario_result": "Read the selected saved run's exact numerical evidence without calculating, editing, review or approval. Omit arguments to use current selection; optional run_id and workspace_revision must match. For a particular tested alternative supply both alternative_hours and alternative_dim (fraction). Earlier results retain original inputs. Explain the summary first, then formulas or alternatives on request.",
}


def tool_declarations():
    return [{"name": name, "description": TOOL_DESCRIPTIONS[name],
             "parameters_json_schema": model.model_json_schema()}
            for name, model in TOOL_MODELS.items()]


class LiveValidationError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


NUMBER_WORDS = dict(zip(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(),
    range(20),
))
NUMBER_WORDS.update(dict(zip("twenty thirty forty fifty sixty seventy eighty ninety".split(), range(20, 100, 10))))
NUMBER_WORD_PATTERN = r"\b(?:" + "|".join(NUMBER_WORDS) + r"|hundred|thousand)(?:[ -]+(?:" + "|".join(NUMBER_WORDS) + r"|hundred|thousand))*\b"
NUMBER = r"\d+(?:\.\d+)?"
FIELD_WORDS = {
    "length_ft": r"length|long", "width_ft": r"width|wide", "canopy_sqft": r"canopy(?: coverage)?",
    "lighting_watts": r"(?:combined|total|lighting|light) (?:load|power|watts)|lighting",
    "other_watts": r"other (?:load|watts|power)", "other_hours": r"other (?:hours|schedule)",
    "baseline_hours": r"lighting schedule|light(?:ing)? hours|photoperiod|hours? (?:per day|a day)",
    "baseline_dim": r"dim(?:ming)?(?: fraction)?", "dimmable": r"dimmable",
    "ppfd_full": r"ppfd", "min_dli": r"(?:minimum |target )?dli",
    "min_hours": r"minimum hours|min hours", "max_hours": r"maximum hours|max hours",
    "power_limit_watts": r"power limit", "electricity_usd_kwh": r"electricity|tariff|rate|price",
    "operating_days": r"operating days|horizon", "water_liters_day": r"water",
}
DELEGATION = r"\b(?:you decide|you choose|design (?:it|this|the\b.+?) for me|go ahead|optimi[sz]e (?:this|it|the\b.+?)|choose (?:the |a )?(?:design|dimensions|layout|crop|schedule))\b"
DESIGN_FIELDS = {"length_ft", "width_ft", "canopy_sqft", "baseline_hours", "baseline_dim", "min_hours", "max_hours"}


def normalized_speech(text):
    """Normalize a small domain number vocabulary, without manufacturing transcript quotes."""
    text = text.casefold().replace("\u00d7", " x ").replace("\u2019", "'")

    def number(match):
        total, current = 0, 0
        for word in re.split(r"[ -]+", match.group()):
            if word == "hundred":
                current = max(1, current) * 100
            elif word == "thousand":
                total += max(1, current) * 1000
                current = 0
            else:
                current += NUMBER_WORDS[word]
        return str(total + current)

    text = re.sub(NUMBER_WORD_PATTERN, number, text)
    text = re.sub(r"(\d+) point (\d+)", r"\1.\2", text)
    return " ".join(text.split())


def field_values(text, field):
    # An explicit correction supersedes earlier alternatives; unresolved alternatives do not.
    text = re.split(r"\b(?:actually|i meant|make that|instead use)\b", text)[-1]
    values = []
    if field in {"length_ft", "width_ft"}:
        pairs = re.findall(rf"({NUMBER})\s*(?:ft|feet|foot)?\s*(?:x|by)\s*({NUMBER})", text)
        values.extend(float(pair[0 if field == "length_ft" else 1]) for pair in pairs)
    label = FIELD_WORDS[field]
    patterns = [rf"\b(?:{label})\b\s*(?:should be |is |to |of |at |as |:|=)?\s*({NUMBER})",
                rf"({NUMBER})\s*(?:ft|feet|foot|watts|w|hours?|h|sq ft|square feet)?\s*(?:{label})\b"]
    for pattern in patterns:
        values.extend(float(value) for value in re.findall(pattern, text))
    if not values and re.search(rf"\b(?:{label})\b", text):
        # A sole value in a field-specific utterance is unambiguous, e.g. "set the lighting schedule to 15 hours per day".
        numbers = re.findall(NUMBER, text)
        if len(numbers) == 1:
            values.append(float(numbers[0]))
    return set(values)


class LiveTools:
    """Validate user evidence and await authoritative UI receipts for reversible actions."""

    def __init__(self):
        self.context = None
        self.result = None
        self.result_revision = None
        self.pending = {}
        self.calls = {}
        self.cancelled = set()
        self.settled = {}
        self.user_transcript = ""
        self.user_turns = []
        self._turn_counter = 0
        self._turn_prefix = uuid4().hex[:8]
        self._open_turn = None
        self._transcript_changed = asyncio.Event()
        self.actions = {}
        self.action_receipts = {}
        self.used_actions = set()
        self.clarification = None
        self._assistant_text = ""
        self._assistant_open = False
        self._confirmation_question = None
        self._user_confirmation = None
        self.generation = 0
        self.awaiting_context_revision = None

    def observe_user_transcript(self, text, finished=True):
        if not isinstance(text, str) or not text.strip():
            if finished:
                self.finish_user_turn()
            return None
        if self._open_turn is None:
            self._turn_counter += 1
            proposal = self.context.proposal if self.context else None
            self._open_turn = {"id": f"user-{self._turn_prefix}-{self._turn_counter}", "text": "", "complete": False,
                               "revision": self.context.revision if self.context else None,
                               "proposal_id": proposal.id if proposal else None,
                               "proposal_version": proposal.version if proposal else None}
            self.user_turns.append(self._open_turn)
            binding = self._confirmation_question
            self._user_confirmation = {**binding, "turn_id": self._open_turn["id"]} if binding else None
            self._confirmation_question = None
        turn = self._open_turn
        prior, part = turn["text"], text.strip()
        if part.startswith(prior):
            combined = part
        elif prior.endswith(part):
            combined = prior
        else:
            combined = (prior + " " + part).strip()
        turn["text"], turn["updated"] = combined[-4000:], time.monotonic()
        self.user_turns = self.user_turns[-32:]
        while len(self.user_turns) > 1 and sum(len(t["text"]) for t in self.user_turns) > 8000:
            self.user_turns.pop(0)
        self.user_transcript = " ".join(t["text"] for t in self.user_turns)
        self._transcript_changed.set()
        if finished:
            self.finish_user_turn()
        return turn["id"]

    def finish_user_turn(self):
        if self._open_turn:
            self._open_turn["complete"] = True
            self._open_turn = None
            self._transcript_changed.set()

    def clear_transcripts(self):
        self.user_transcript = ""
        self.user_turns.clear()
        self._open_turn = None
        self._clear_confirmation()
        self._transcript_changed.set()

    def _clear_confirmation(self):
        self._assistant_text = ""
        self._assistant_open = False
        self._confirmation_question = self._user_confirmation = None

    def observe_assistant_transcript(self, text):
        """A question binds context only. Authorization must come from a later user turn."""
        if not isinstance(text, str) or not text.strip() or self.context is None:
            return
        part = text.strip()
        prior = self._assistant_text if self._assistant_open else ""
        self._assistant_open = True
        self._assistant_text = (part if part.startswith(prior) else prior if prior.endswith(part)
                                else (prior + " " + part).strip())[-1600:]
        self._confirmation_question = self._user_confirmation = None
        speech = normalized_speech(self._assistant_text)
        if speech.count("?") != 1 or not speech.endswith("?"):
            return
        question = re.split(r"[.!]", speech)[-1].strip()
        prefix = r"(?:(?:would you like (?:me )?to|do you want (?:me )?to|shall i|should i|should we|may i|do you) )?"
        target = r"(?:this|that|the proposed) (?:version|proposal|design)"
        patterns = {"approve": prefix + rf"(?:use|approve|accept|adopt) {target}\?",
                    "revise": prefix + rf"(?:revise|edit|rework) {target}\?",
                    "discard": prefix + rf"(?:discard|reject) {target}\?",
                    "undo": prefix + r"undo (?:the )?last (?:change|adopted version)\?"}
        kind = next((key for key, pattern in patterns.items() if re.fullmatch(pattern, question)), None)
        proposal = self.context.proposal
        if kind is None or (kind == "undo" and (proposal or not self.context.can_undo)) or (kind != "undo" and proposal is None):
            return
        self.finish_user_turn()
        self._confirmation_question = {"action": kind, "revision": self.context.revision,
                                       "proposal_id": proposal.id if proposal else None,
                                       "version": proposal.version if proposal else None}

    def finish_assistant_turn(self):
        self._assistant_open = False

    async def _evidence(self, provenance):
        deadline = time.monotonic() + EVIDENCE_WAIT_SECONDS
        while True:
            selected = ([t for t in self.user_turns if t["id"] in provenance.turn_ids]
                        if provenance.turn_ids else self.user_turns[-1:])
            if not provenance.turn_ids and selected and self.clarification and self.clarification["revision"] == self.context.revision:
                previous = [t for t in self.user_turns if t["id"] in self.clarification["turn_ids"]]
                if selected[-1]["id"] not in self.clarification["turn_ids"]:
                    selected = previous + selected
            found = bool(selected) and (not provenance.turn_ids or len(selected) == len(provenance.turn_ids))
            remaining = deadline - time.monotonic()
            settled = found and (selected[-1]["complete"] or (remaining <= 0 and
                                time.monotonic() - selected[-1]["updated"] >= TRANSCRIPT_SETTLE_SECONDS))
            if settled:
                if selected[-1] is not self.user_turns[-1]:
                    raise LiveValidationError("stale_evidence", "Use the latest user instruction and current workspace state.")
                return selected, " ".join(normalized_speech(t["text"]) for t in selected)
            if remaining <= 0:
                raise LiveValidationError("evidence_pending", "User transcription is not available yet. Read state and retry internally; do not request a repeated sentence.")
            self._transcript_changed.clear()
            with suppress(TimeoutError):
                await asyncio.wait_for(self._transcript_changed.wait(), min(remaining, TRANSCRIPT_SETTLE_SECONDS))

    def set_context(self, value):
        incoming = WorkspaceContext.model_validate(value)
        changed = self.context is None or self._input_state(incoming) != self._input_state(self.context)
        version_changed = self.context is not None and (incoming.proposal != self.context.proposal or
                          incoming.accepted_revision != self.context.accepted_revision or incoming.can_undo != self.context.can_undo)
        if self.context is not None:
            if incoming.revision < self.context.revision:
                raise LiveValidationError("stale_context", "Context revision must not decrease.")
            if incoming.revision == self.context.revision:
                if changed or version_changed:
                    raise LiveValidationError("stale_context", "Changed context needs a new revision.")
                if incoming == self.context:
                    return []
        events = []
        for action_id, action in list(self.actions.items()):
            if self._matches_action(action, incoming):
                action["observed"] = True
            elif changed or incoming.proposal != action["before"].proposal or incoming.accepted_revision != action["before"].accepted_revision:
                events.extend(self._fail_action(action_id, "stale_context"))
        if changed:
            self.generation += 1
            self.result = self.result_revision = None
            self.clarification = None
        if changed or version_changed:
            self._clear_confirmation()
        if not changed and self.result is not None:
            self.result_revision = incoming.revision
        if version_changed and not changed:
            self.generation += 1
        if self.context is not None and (
            incoming.scenario.confirmed != self.context.scenario.confirmed or
            [a.confirmed for a in incoming.assets] != [a.confirmed for a in self.context.assets]
        ):
            self.generation += 1
        self.context = incoming.model_copy(deep=True)
        if self.awaiting_context_revision is not None and incoming.revision > self.awaiting_context_revision:
            self.awaiting_context_revision = None
        return events

    @staticmethod
    def _input_state(context):
        return (context.scenario.model_dump(exclude={"confirmed"}),
                [a.model_dump(exclude={"confirmed"}) for a in context.assets], context.crop,
                {name: value.model_dump() for name, value in context.assumptions.items()})

    def state(self):
        if self.context is None:
            return {"status": "needs_context"}
        scenario = self.context.scenario
        missing = [name for name in (
            "length_ft", "width_ft", "canopy_sqft", "light_count", "lighting_watts",
            "baseline_hours", "baseline_dim", "ppfd_full", "min_dli", "min_hours",
            "max_hours", "power_limit_watts", "operating_days",
        ) if not getattr(scenario, name)]
        return {"status": "ok", "context": self.context.model_dump(), "missing_inputs": missing,
                "pending_review": list(self.pending), "has_server_result": bool(self.context.selected_run and get_run(self.context.selected_run.id)),
                "inventory_matches": self.inventory_matches(),
                "user_turns": [{k: v for k, v in turn.items() if k != "updated"} for turn in self.user_turns],
                "pending_application": list(self.actions),
                "clarification": deepcopy(self.clarification),
                "design_scope": "Local revised schematic or lighting schedule only; not asset-position optimization."}

    def inventory_matches(self):
        return self.context is not None and bool(self.context.assets) and all(
            asset.confirmed for asset in self.context.assets
        ) and sum(a.quantity for a in self.context.assets if a.type == "light_fixture") == self.context.scenario.light_count

    def cancel_drafts(self, call_ids=None):
        events = []
        for action_id, action in list(self.actions.items()):
            if call_ids is None or action["call_id"] in call_ids:
                events.extend(self._fail_action(action_id, "cancelled"))
        for draft_id, record in list(self.pending.items()):
            if call_ids is None or record["call_id"] in call_ids:
                del self.pending[draft_id]
                self.settled[draft_id] = "cancelled"
                events.append({"type": "draft_cancelled", "id": draft_id})
        return events

    def cancel(self, call_ids):
        valid = {item for item in call_ids if isinstance(item, str) and 0 < len(item) <= 128}
        if len(self.cancelled | valid) > MAX_CALLS:
            raise LiveValidationError("tool_limit", "The Live tool-call limit was reached.")
        self.cancelled.update(valid)
        return self.cancel_drafts(valid)

    def interrupt(self):
        self.generation += 1
        self.finish_user_turn()
        return self.cancel_drafts()

    def _stage_action(self, call_id, event, success, expected=None):
        action_id = uuid4().hex
        event = {**event, "action_id": action_id}
        self.actions[action_id] = {"call_id": call_id, "event": event, "success": success,
                                   "before": self.context.model_copy(deep=True), "expected": expected,
                                   "future": asyncio.get_running_loop().create_future(), "observed": False}
        return {"status": "pending_application", "action_id": action_id,
                "message": "Await the application receipt before claiming this action succeeded or is displayed."}, [deepcopy(event)]

    def _matches_action(self, action, incoming):
        before, event = action["before"], action["event"]
        if incoming.revision < before.revision:
            return False
        if event["type"] == "draft":
            draft, expected = event["draft"], action["expected"]
            return (incoming.revision == before.revision + 1 and incoming.accepted_revision == before.accepted_revision
                    and incoming.proposal is not None and incoming.proposal.model_dump() == {
                        "id": draft["proposal_id"], "version": draft["version"], "base_revision": draft["base_revision"], "status": "review"}
                    and self._input_state(incoming) == self._input_state(expected)
                    and not incoming.scenario.confirmed and not incoming.has_result
                    and not any(a.confirmed for a in incoming.assets))
        if event["type"] in {"view", "result"}:
            return (incoming.revision == before.revision and self._input_state(incoming) == self._input_state(before)
                    and incoming.proposal == before.proposal and incoming.accepted_revision == before.accepted_revision
                    and incoming.scenario.confirmed == before.scenario.confirmed
                    and [a.confirmed for a in incoming.assets] == [a.confirmed for a in before.assets]
                    and (event["type"] != "result" or (incoming.has_result
                         and (not event["result"].get("run") or (incoming.selected_run is not None
                              and incoming.selected_run.id == event["result"]["run"]["id"]
                              and incoming.selected_run.workspace_revision == before.revision
                              and incoming.selected_run.accepted_revision == before.accepted_revision
                              and incoming.selected_run.proposal_id == (before.proposal.id if before.proposal else None)
                              and incoming.selected_run.proposal_version == (before.proposal.version if before.proposal else None)))))
                    and (not event.get("asset_id") or incoming.selected_asset_id == event["asset_id"]))
        if event["type"] == "proposal_action":
            kind = event["action"]
            if kind == "revise":
                return (incoming.proposal is not None and before.proposal is not None
                        and incoming.revision == before.revision + 1
                        and incoming.proposal.model_dump() == {**before.proposal.model_dump(), "status": "revising", "version": before.proposal.version + 1}
                        and incoming.accepted_revision == before.accepted_revision
                        and self._input_state(incoming) == self._input_state(before)
                        and incoming.scenario.confirmed == before.scenario.confirmed)
            if incoming.proposal is not None or incoming.revision != before.revision + 1:
                return False
            if kind == "approve":
                return (incoming.accepted_revision == incoming.revision and incoming.can_undo
                        and self._input_state(incoming) == self._input_state(before)
                        and incoming.scenario.confirmed == before.scenario.confirmed
                        and [a.confirmed for a in incoming.assets] == [a.confirmed for a in before.assets])
            # The UI owns the accepted/undo snapshot; its receipt cannot create a solver result.
            return (not incoming.has_result and (incoming.accepted_revision == before.accepted_revision
                    if kind == "discard" else incoming.accepted_revision == incoming.revision))
        return False

    def _fail_action(self, action_id, code):
        action = self.actions.pop(action_id, None)
        if action is None:
            return []
        response = {"status": "error", "code": code,
                    "message": "The application did not acknowledge this action. Do not claim it succeeded; read current state before retrying."}
        self.action_receipts[action_id] = response
        if not action["future"].done():
            action["future"].set_result(response)
        event = action["event"]
        if event["type"] == "draft":
            draft_id = event["draft"]["id"]
            self.pending.pop(draft_id, None)
            self.settled[draft_id] = code
            # Once the UI shows a proposal it belongs to the workspace, not the audio turn.
            if not action["observed"]:
                return [{"type": "draft_cancelled", "id": draft_id}]
        return []

    def acknowledge(self, action_id, status, message, context):
        action = self.actions.get(action_id)
        if action is None:
            return {"status": "already_settled" if action_id in self.action_receipts else "unknown_action"}, []
        if status != "applied":
            return {"status": "rejected"}, self._fail_action(action_id, "ui_rejected")
        try:
            incoming = WorkspaceContext.model_validate(context)
            if not self._matches_action(action, incoming):
                raise LiveValidationError("invalid_receipt", "Application receipt does not match the requested action.")
            events = self.set_context(incoming.model_dump())
            if action_id not in self.actions:
                return {"status": "stale_context"}, events
        except (ValidationError, LiveValidationError):
            return {"status": "rejected"}, self._fail_action(action_id, "invalid_receipt")
        self.actions.pop(action_id)
        event = action["event"]
        response = deepcopy(action["success"])
        response.update({"action_id": action_id, "revision": incoming.revision, "acknowledged": True})
        if event["type"] == "result":
            self.result, self.result_revision = deepcopy(event["result"]), incoming.revision
            response.update(self.result_response())
        if event["type"] == "draft":
            draft_id = event["draft"]["id"]
            self.pending.pop(draft_id, None)
            self.settled[draft_id] = "displayed"
        self.action_receipts[action_id] = response
        if not action["future"].done():
            action["future"].set_result(response)
        # The client message is deliberately not echoed into the model's instructions.
        return {"status": "acknowledged", "action_id": action_id}, events

    async def wait_action(self, action_id, timeout=None):
        if action_id in self.action_receipts:
            return deepcopy(self.action_receipts[action_id]), []
        action = self.actions.get(action_id)
        if action is None:
            return {"status": "error", "code": "unknown_action"}, []
        try:
            response = await asyncio.wait_for(asyncio.shield(action["future"]), ACTION_ACK_SECONDS if timeout is None else timeout)
            return deepcopy(response), []
        except TimeoutError:
            events = self._fail_action(action_id, "action_timeout")
            return deepcopy(self.action_receipts[action_id]), events

    def review(self, draft_id, status):
        record = self.pending.get(draft_id)
        if record is None:
            if draft_id in self.settled:
                return {"draft_id": draft_id, "status": "already_settled"}
            raise LiveValidationError("unknown_draft", "This draft is no longer pending review.")
        del self.pending[draft_id]
        self.settled[draft_id] = status
        if status == "applied":
            self.awaiting_context_revision = self.context.revision
        for action_id, action in list(self.actions.items()):
            if action["event"]["type"] == "draft" and action["event"]["draft"]["id"] == draft_id:
                self._fail_action(action_id, "legacy_review_requires_receipt")
        # The next context message is authoritative. An applied acknowledgement alone changes nothing.
        return {"draft_id": draft_id, "status": status, "awaiting_ui_context": status == "applied"}

    async def dispatch(self, call_id, name, arguments):
        if not isinstance(call_id, str) or not 1 <= len(call_id) <= 128:
            return {"status": "error", "code": "invalid_call"}, []
        if call_id in self.cancelled:
            return {"status": "cancelled"}, []
        if name not in TOOL_MODELS or not isinstance(arguments, dict):
            return {"status": "error", "code": "invalid_tool"}, []
        try:
            encoded = json.dumps(arguments, allow_nan=False, sort_keys=True, separators=(",", ":"))
            if len(encoded.encode()) > MAX_TOOL_BYTES:
                raise ValueError
        except (TypeError, ValueError, RecursionError):
            return {"status": "error", "code": "invalid_arguments"}, []
        digest = hashlib.sha256((name + encoded).encode()).digest()
        if call_id in self.calls:
            status = "duplicate" if self.calls[call_id] == digest else "call_id_conflict"
            return {"status": status}, []
        if len(self.calls) >= MAX_CALLS:
            return {"status": "error", "code": "tool_limit"}, []
        self.calls[call_id] = digest
        try:
            args = TOOL_MODELS[name].model_validate(arguments)
            if name == "get_workspace_state":
                return self.state(), []
            if self.context is None:
                return {"status": "needs_context"}, []
            if name == "propose_update":
                generation = self.generation
                turns, spoken = await self._evidence(args.provenance)
                if call_id in self.cancelled or generation != self.generation:
                    return {"status": "cancelled"}, []
                return self._propose(call_id, args, turns, spoken)
            if name == "manage_proposal":
                generation = self.generation
                turns, spoken = await self._evidence(args.provenance)
                if call_id in self.cancelled or generation != self.generation:
                    return {"status": "cancelled"}, []
                return self._manage(call_id, args, turns, spoken)
            if name == "set_twin_view":
                if args.asset_id is not None and args.asset_id not in {a.id for a in self.context.assets}:
                    raise LiveValidationError("unknown_asset", "Select an existing asset.")
                return self._stage_action(call_id, {"type": "view", **args.model_dump(exclude_none=True)},
                                          {"status": "ok", "message": "The application acknowledged the schematic view change."})
            if name == "get_scenario_result":
                response = self.read_result(args)
                return response, [{"type": "explanation_status", "status": response["status"],
                                   "run_id": self.context.selected_run.id if self.context.selected_run else None,
                                   "code": response.get("code"), "message": response.get("message")}]
            if self.context.assumptions:
                return {"status": "needs_review", "code": "unresolved_assumptions", "fields": list(self.context.assumptions),
                        "message": "Resolve the explicitly labeled assumptions with validated inputs before calculating. A review checkbox alone does not make an assumption a measurement."}, []
            if not self.context.scenario.confirmed or not self.inventory_matches() or self.actions or self.pending or self.awaiting_context_revision is not None:
                return {"status": "needs_review", "message": "Confirm the scenario and matching inventory, and review pending drafts."}, []
            inputs = self.context.scenario.model_dump()
            # UI zero means unknown for these nullable measurements; the solver explicitly abstains.
            for field in ("ppfd_full", "min_dli"):
                if inputs[field] == 0:
                    inputs[field] = None
            scenario = core.Scenario.model_validate(inputs)
            generation, revision = self.generation, self.context.revision
            calculated = await asyncio.to_thread(execute_run, scenario)
            if call_id in self.cancelled or self.generation != generation:
                return {"status": "cancelled"}, []
            if self.context.revision != revision:
                return {"status": "stale_context"}, []
            result = OptimizationResult.model_validate(calculated).model_dump()
            return self._stage_action(call_id, {"type": "result", "revision": revision, "result": result}, {"status": "ok"})
        except (ValidationError, LiveValidationError) as exc:
            code = exc.code if isinstance(exc, LiveValidationError) else "invalid_arguments"
            message = exc.message if isinstance(exc, LiveValidationError) else "Check field bounds, units, required inputs and scenario consistency."
            return {"status": "error", "code": code, "message": message}, []

    def read_result(self, request):
        reference = self.context.selected_run
        if reference is None:
            return {"status": "no_result", "code": "run_reference_missing" if self.context.has_result else "no_result",
                    "message": "This legacy result has no saved run identity. Its local figures remain available; run a new comparison only if you want fresh server evidence."
                    if self.context.has_result else "There is no selected saved calculation to explain. No simulation was started."}
        if ((request.run_id is not None and request.run_id != reference.id)
                or (request.workspace_revision is not None and request.workspace_revision != reference.workspace_revision)):
            return {"status": "error", "code": "stale_run", "message": "The selected run changed. Read the current selected run and retry the explanation; do not recalculate."}
        try:
            result = get_run(reference.id)
        except Exception:
            return {"status": "error", "code": "run_retrieval_failed", "message": "Saved-run retrieval failed. Local evidence remains in Why this result? Retry the explanation without changing inputs."}
        if result is None:
            return {"status": "error", "code": "run_unavailable", "message": "This run is no longer in the local server's bounded run cache (for example, after a restart). Its saved evidence remains in Why this result? No new calculation was substituted."}
        response = self.result_response(result, reference)
        if request.alternative_hours is not None:
            candidate = next((c for c in result["candidates"] if
                              (c["photoperiod_hours"], c["dim_fraction"]) ==
                              (request.alternative_hours, request.alternative_dim)), None)
            response["requested_alternative"] = {"status": "tested" if candidate else "not_tested",
                                                 "candidate": candidate,
                                                 "message": "Actual stored candidate; use its rejection reasons and the run's original constraint thresholds."
                                                 if candidate else "This setting was not evaluated in the saved run. Do not describe an invented candidate or rejection."}
        return response

    def result_response(self, saved_result=None, reference=None):
        # The browser receives every candidate. Keep spoken explanation context bounded,
        # retaining real baseline/selected candidates and examples of each rejection reason.
        result = deepcopy(saved_result if saved_result is not None else self.result)
        reference = reference or self.context.selected_run
        artifact = result.pop("run", None)
        candidates = result.pop("candidates")
        selected = []
        seen_reasons = set()
        for candidate in candidates:
            setting = (candidate["photoperiod_hours"], candidate["dim_fraction"])
            important = any(
                metrics is not None and setting == (metrics["photoperiod_hours"], metrics["dim_fraction"])
                for metrics in (result["baseline"], result["optimized"])
            )
            new_reason = set(candidate["rejected_for"]) - seen_reasons
            if important or new_reason:
                selected.append(candidate)
                seen_reasons.update(candidate["rejected_for"])
        result["candidates"] = selected
        inputs = artifact["input_snapshot"] if artifact else None
        original_inputs = {k: v for k, v in (inputs or {}).items() if k != "confirmed"}
        current_inputs = self.context.scenario.model_dump(exclude={"confirmed"})
        for field in ("ppfd_full", "min_dli"):
            if current_inputs[field] == 0:
                current_inputs[field] = None
        earlier = bool(reference and (reference.workspace_revision != self.context.revision or original_inputs != current_inputs))
        return {"status": "ok", "revision": reference.workspace_revision if reference else self.result_revision,
                "run": artifact, "workspace_version": reference.model_dump() if reference else None,
                "earlier_result": earlier, "current_workspace_revision": self.context.revision,
                "message": "Earlier saved result: use its original inputs, not the current form values." if earlier else "Selected saved result. Reading did not change the workspace or run a simulation.",
                "result": result,
                "candidate_details": "Subset of actual solver candidates; full results were sent to the workspace.",
                "candidate_details_total": len(candidates)}

    def _validate_evidence(self, args, turns, spoken):
        latest = normalized_speech(turns[-1]["text"])
        delegated = bool(re.search(DELEGATION, latest)) and not re.search(r"\b(?:don't|do not|not yet|never)\b", latest)
        if args.provenance.basis == "delegated_design" and not delegated:
            raise LiveValidationError("clarification_required", "What would you like me to design in this workspace?")
        # Include a directly preceding task when resolving 'you decide', but not arbitrary historical authority.
        scope_text = spoken
        if delegated and self.user_turns:
            index = self.user_turns.index(turns[-1])
            prior = self.user_turns[max(0, index - 3):index]
            prior = [t for t in prior if t["revision"] == self.context.revision]
            scope_text = " ".join(normalized_speech(t["text"]) for t in prior) + " " + spoken
        scope_text = scope_text.strip()
        keep_canopy = bool(re.search(r"\bkeep\b.{0,35}\bcanopy\b.{0,25}\b(?:same|unchanged)\b|\b(?:don't|do not) change (?:the )?canopy", scope_text))
        if re.search(r"\b(?:don't|do not|never) (?:change|set|alter)\b", latest) and not keep_canopy and args.inputs:
            raise LiveValidationError("clarification_required", "Which input should change? Your latest instruction says to keep it unchanged.")
        for patch in args.inputs:
            if patch.field == "canopy_sqft" and keep_canopy and patch.value != self.context.scenario.canopy_sqft:
                raise LiveValidationError("preserve_constraint", "Keep current canopy coverage unchanged.")
            values = field_values(spoken, patch.field)
            pairs = re.findall(rf"({NUMBER})\s*(?:ft|feet|foot)?\s*(?:x|by)\s*({NUMBER})", spoken)
            alternatives = (None if len(pairs) > 1 else re.search(rf"({NUMBER})\s*(?:ft|feet|hours?|watts)?\s*(?:or|/)\s*({NUMBER})", spoken))
            resolved = False
            if self.clarification and self.clarification["field"] == patch.field and turns[-1]["id"] not in self.clarification["turn_ids"]:
                answer = field_values(latest, patch.field)
                if not answer and len(re.findall(NUMBER, latest)) == 1:
                    answer = {float(re.findall(NUMBER, latest)[0])}
                if len(answer) == 1:
                    values, alternatives, resolved = answer, None, True
            dimension_pair = patch.field in {"length_ft", "width_ft"} and bool(re.search(rf"{NUMBER}\s*(?:ft|feet|foot)?\s*(?:x|by)\s*{NUMBER}", spoken))
            alternate_values = {float(alternatives[1]), float(alternatives[2])} if alternatives else set()
            if not resolved and (len(values) > 1 or (alternatives and (re.search(FIELD_WORDS[patch.field], spoken) or (dimension_pair and values & alternate_values)))):
                label = "length" if patch.field == "length_ft" else "width" if patch.field == "width_ft" else patch.field.replace("_", " ")
                choices = sorted(values | ({float(alternatives[1]), float(alternatives[2])} if alternatives else set()))
                options = " or ".join(f"{value:g}" for value in choices[:3])
                self.clarification = {"field": patch.field, "turn_ids": [t["id"] for t in turns], "revision": self.context.revision}
                raise LiveValidationError("clarification_required", f"Which {label} should I use: {options} {patch.unit}?")
            if patch.field == "dimmable":
                supported = bool(re.search(r"\bdimmable\b", spoken)) and patch.value == (not bool(re.search(r"\b(?:not|isn't|non)[ -]?dimmable\b", spoken)))
            elif patch.value is None:
                supported = bool(re.search(FIELD_WORDS[patch.field], spoken)) and bool(re.search(r"\b(?:unknown|clear|remove|missing|not measured)\b", spoken))
            else:
                supported = patch.value in values
                if patch.field == "canopy_sqft" and keep_canopy and patch.value == self.context.scenario.canopy_sqft:
                    supported = True
                if patch.field == "baseline_dim" and re.search(r"percent|%", spoken):
                    supported = patch.value * 100 in values
            if not supported and delegated and patch.field in DESIGN_FIELDS:
                geometric = bool(re.search(r"\b(?:room|dimensions|length|width|schematic|space)\b", scope_text))
                lighting = bool(re.search(r"\b(?:lighting|schedule|photoperiod|dim|optimi[sz]e)\b", scope_text))
                if not geometric and not lighting:
                    geometric = lighting = True
                supported = ((patch.field in {"length_ft", "width_ft"} and geometric)
                             or (patch.field in {"baseline_hours", "baseline_dim", "min_hours", "max_hours"} and lighting)
                             or (patch.field == "canopy_sqft" and not keep_canopy and "canopy" in scope_text))
                if supported and patch.assumption is None:
                    patch.assumption = CropAssumption(label="Delegated design assumption, not a measurement",
                                                      source="User design delegation: " + turns[-1]["id"],
                                                      growth_stage="Not specified; schematic or schedule preview only")
            if not supported:
                raise LiveValidationError("clarification_required", f"What value should {patch.field.replace('_', ' ')} use? It is not resolved by your instruction or delegated design scope.")
        fields = {p.field for p in args.inputs}
        if args.inventory and not re.search(r"\b(?:inventory|assets?|equipment|fan|fans|lights?|fixtures?|plants?|containers?|shelves|shelving|rack|racks|space)\b", scope_text):
            raise LiveValidationError("clarification_required", "Should this design include inventory changes?")
        pairs = re.findall(rf"({NUMBER})\s*(?:ft|feet|foot)?\s*(?:x|by)\s*({NUMBER})", spoken)
        if pairs and fields & {"length_ft", "width_ft"} and not {"length_ft", "width_ft"} <= fields:
            raise LiveValidationError("group_dimensions", "Draft length and width from this instruction together in one tool call; do not ask the user to repeat them.")
        if "crop" in args.model_fields_set:
            if args.crop is None:
                crop_supported = bool(re.search(r"\b(?:clear|remove|unset)\b.{0,20}\bcrop\b", spoken))
            else:
                crop_supported = bool(re.search(r"(?<!\w)" + re.escape(normalized_speech(args.crop)) + r"(?!\w)", spoken))
                if re.search(r"\b(?:not sure|sounds like|something like|maybe|or)\b", spoken):
                    crop_supported = False
                if delegated and re.search(r"\b(?:choose|decide|select)\b.{0,25}\bcrop\b", scope_text):
                    crop_supported = True
            if not crop_supported:
                raise LiveValidationError("clarification_required", "Which crop name should I use for the label?")
            if fields & {"min_dli", "ppfd_full", "water_liters_day"}:
                for patch in args.inputs:
                    if patch.field in {"min_dli", "ppfd_full", "water_liters_day"} and patch.assumption is None:
                        raise LiveValidationError("crop_requirement_source", "Keep light and water inputs unchanged. A crop requirement needs an explicit assumption, source and growth stage.")
        if not (args.inputs or args.inventory or "crop" in args.model_fields_set or delegated):
            raise LiveValidationError("clarification_required", "What would you like to revise in this workspace?")
        return {"turn_ids": [t["id"] for t in turns], "basis": "delegated_design" if delegated else "user_instruction"}

    def _manage(self, call_id, args, turns, spoken):
        if self.actions:
            raise LiveValidationError("action_pending", "Wait for the pending application receipt, then read current state.")
        proposal = self.context.proposal
        if args.action == "undo":
            if not self.context.can_undo or proposal is not None or args.proposal_id is not None or args.version is not None:
                raise LiveValidationError("stale_proposal", "Undo requires an adopted version and no active proposal.")
        elif proposal is None or args.proposal_id != proposal.id or args.version != proposal.version:
            raise LiveValidationError("stale_proposal", "Read the current proposal ID and version before acting.")
        turn = turns[-1]
        if (turn["proposal_id"], turn["proposal_version"]) != (proposal.id if proposal else None, proposal.version if proposal else None):
            raise LiveValidationError("stale_evidence", "That instruction referred to a different proposal. Review the current version.")
        if turn["revision"] != self.context.revision:
            raise LiveValidationError("stale_evidence", "The workspace changed after that instruction. Review the current version.")
        speech = normalized_speech(turn["text"])
        patterns = {"approve": r"\b(?:approve|accept|adopt)\b|\buse (?:this|that|the proposed|the new) (?:version|proposal|design)\b|\buse it\b",
                    "revise": r"\b(?:revise|edit|rework)\b|\bchange (?:this|that|the) (?:proposal|version|design)\b",
                    "discard": r"\b(?:discard|reject)\b|\bcancel (?:this|that|the) (?:proposal|version|draft)\b|\bkeep (?:the )?(?:current|accepted) version\b",
                    "undo": r"\bundo\b|\brevert (?:the )?(?:last|adopted) (?:version|change)\b"}
        intents = {kind for kind, pattern in patterns.items() if re.search(pattern, speech)}
        affirmative = bool(re.fullmatch(r"(?:yes|yeah|yep|sure|okay|ok|please do)(?:[, ]+(?:please|go ahead|do it))?[.!]*", speech))
        binding = self._user_confirmation
        if affirmative and binding and binding == {"action": args.action, "revision": self.context.revision,
                "proposal_id": args.proposal_id, "version": args.version, "turn_id": turn["id"]}:
            intents = {args.action}
        qualified = bool(re.search(r"\b(?:only|except|if|tomorrow|later|will|would|might|after|unless|when|once|before|eventually)\b|\bas long as\b", speech))
        if args.action == "approve" and not (affirmative and binding):
            courtesy = r"(?:(?:yes|yeah|okay|ok|looks good|that looks good|please|go ahead and)[,.! ]+)*"
            target = r"(?:it|this|that|(?:this|that|the)?\s*(?:whole |proposed |new )?(?:version|proposal|design)|these changes)"
            imperative = courtesy + rf"(?:(?:i )?(?:approve|accept|adopt)(?: {target})?|use {target})(?:[, ]+(?:please|now|thanks|thank you))*[.!]*"
            if not re.fullmatch(imperative, speech):
                qualified = True
        if qualified or intents != {args.action} or re.search(r"\b(?:don't|do not|not yet|never|not sure|should i|can i|could i|what if)\b", speech):
            raise LiveValidationError("clarification_required", "Do you want to use, revise, or discard the active proposed version?" if proposal else "Do you want to undo the last adopted version?")
        key = (turn["id"], args.action, args.proposal_id, args.version)
        if key in self.used_actions:
            raise LiveValidationError("duplicate_action", "This instruction was already handled; read current state.")
        self.used_actions.add(key)
        return self._stage_action(call_id, {"type": "proposal_action", "action": args.action,
                                  "proposal_id": args.proposal_id, "version": args.version, "revision": self.context.revision},
                                  {"status": "ok", "action": args.action, "message": "The application acknowledged the version action."})

    def _propose(self, call_id, args, turns, spoken):
        if len(self.pending) >= MAX_DRAFTS:
            raise LiveValidationError("draft_limit", "Review existing drafts before proposing more.")
        if self.actions:
            raise LiveValidationError("action_pending", "Wait for the application to acknowledge the current action before revising it.")
        provenance = self._validate_evidence(args, turns, spoken)
        self.clarification = None
        assets = {a.id: a.model_dump() for a in self.context.assets}
        inventory = []
        for patch in args.inventory:
            item = patch.model_dump(exclude_none=True)
            if patch.operation != "add" and patch.id not in assets:
                raise LiveValidationError("unknown_asset", "Inventory changes must reference an existing asset.")
            if patch.operation == "remove":
                del assets[patch.id]
            elif patch.operation == "add":
                item["id"] = uuid4().hex
                assets[item["id"]] = {"id": item["id"], "name": patch.name, "quantity": patch.quantity,
                                      "type": patch.asset_type, "confirmed": False, "confidence": None}
            else:
                current = assets[patch.id]
                item = {"name": current["name"], "asset_type": current["type"], "quantity": current["quantity"], **item}
                if patch.name is not None:
                    current["name"] = patch.name
                if patch.quantity is not None:
                    assets[patch.id]["quantity"] = patch.quantity
                if patch.asset_type is not None:
                    assets[patch.id]["type"] = patch.asset_type
            if patch.name is not None and not patch.name.strip():
                raise LiveValidationError("invalid_arguments", "An asset name must not be blank.")
            inventory.append(item)
        if len(assets) > 64 or sum(a["quantity"] for a in assets.values()) > 1000 or sum(
            a["quantity"] for a in assets.values() if a["type"] == "light_fixture"
        ) > 100:
            raise LiveValidationError("inventory_limit", "Suggested inventory exceeds the size or quantity limit.")
        current = self.context.proposal
        draft = {"id": uuid4().hex, "revision": self.context.revision, "reason": args.reason,
                 "proposal_id": current.id if current else uuid4().hex,
                 "version": current.version + 1 if current else 1, "base_revision": self.context.accepted_revision,
                 "inputs": [p.model_dump(exclude={"user_statement"}, exclude_none=True) | {"value": p.value} for p in args.inputs],
                 "inventory": inventory, "provenance": provenance}
        if "crop" in args.model_fields_set:
            draft["crop"] = args.crop
        scenario = self.context.scenario.model_dump()
        scenario.update({p.field: p.value for p in args.inputs})
        scenario["confirmed"] = False
        scenario["light_count"] = sum(a["quantity"] for a in assets.values() if a["type"] == "light_fixture")
        if scenario["length_ft"] and scenario["width_ft"] and scenario["canopy_sqft"] > scenario["length_ft"] * scenario["width_ft"]:
            raise LiveValidationError("invalid_geometry", "Current canopy coverage does not fit these dimensions. Keep the canopy and revise the room dimensions.")
        if scenario["min_hours"] and scenario["max_hours"] and scenario["min_hours"] > scenario["max_hours"]:
            raise LiveValidationError("invalid_arguments", "Minimum hours must not exceed maximum hours.")
        if not scenario["dimmable"] and scenario["baseline_dim"] not in (0, 1):
            raise LiveValidationError("invalid_arguments", "Non-dimmable lighting must remain at full output.")
        for asset in assets.values():
            asset["confirmed"] = False
        expected = self.context.model_copy(deep=True)
        expected.scenario = WorkspaceScenario.model_validate(scenario)
        expected.assets = [WorkspaceAsset.model_validate(a) for a in assets.values()]
        expected.crop = draft.get("crop", self.context.crop)
        for patch in args.inputs:
            if patch.assumption is not None:
                expected.assumptions[patch.field] = patch.assumption.model_copy(deep=True)
            else:
                expected.assumptions.pop(patch.field, None)
        self.pending[draft["id"]] = {"call_id": call_id, "draft": draft}
        response, events = self._stage_action(call_id, {"type": "draft", "draft": draft},
                                  {"status": "pending_review", "draft_id": draft["id"], "proposal_id": draft["proposal_id"],
                                   "version": draft["version"], "message": "Proposed schematic displayed for review. The accepted version is unchanged. Inputs remain unconfirmed; sample-derived inputs remain synthetic."}, expected)
        return response, events

    def clear(self):
        self.cancel_drafts()
        self.context = self.result = self.result_revision = None
        self.pending.clear()
        self.calls.clear()
        self.cancelled.clear()
        self.settled.clear()
        self.clear_transcripts()
        self.actions.clear()
        self.action_receipts.clear()
        self.used_actions.clear()
        self.clarification = None
        self.awaiting_context_revision = None
        self.generation += 1
