"""Response schemas matching frontend/lib/types.ts."""

from typing import Literal

from pydantic import Field

if __package__:
    from .core import Scenario, StrictModel
else:
    from core import Scenario, StrictModel


class Health(StrictModel):
    status: Literal["ok"]
    service: Literal["acreiq-api"]
    vision_available: bool
    vision_provider: Literal["manual", "gemini", "vertex"]
    model_version: str


class Metrics(StrictModel):
    photoperiod_hours: float
    dim_fraction: float
    daily_energy_kwh: float
    period_energy_kwh: float
    period_energy_cost_usd: float
    peak_modeled_watts: float
    dli_mol_m2_day: float | None
    period_water_liters: float | None
    canopy_sqft: float


RejectionReason = Literal["photoperiod", "minimum_dli", "modeled_power_limit"]
RunStatus = Literal["optimized", "needs_measurement", "no_feasible_configuration"]


class Candidate(Metrics):
    feasible: bool
    rejected_for: list[RejectionReason]


class Savings(StrictModel):
    period_energy_kwh: float
    energy_pct: float
    period_energy_cost_usd: float
    water_liters: None
    yield_gain_lb: None
    avoided_capex_usd: None
    new_equipment_required_by_scenario_usd: Literal[0]


class EvidenceInput(StrictModel):
    field: str
    value: float | bool | str | None
    unit: str
    used_for: str


class EvidenceFormula(StrictModel):
    scope: Literal["baseline", "selected", "savings"]
    metric: str
    expression: str
    substituted: str
    raw_value: float
    reported_value: float
    unit: str
    round_digits: int = Field(ge=0, le=6)


class EvidenceConstraint(StrictModel):
    name: RejectionReason
    unit: str
    minimum: float | None
    maximum: float | None
    evaluated: bool
    baseline_value: float | None
    baseline_passed: bool | None
    selected_value: float | None
    selected_passed: bool | None
    rejected_configurations: int = Field(ge=0, le=1200)


class EvidenceAlternative(StrictModel):
    kind: Literal["selected", "rejected", "nearest_feasible"]
    reason: RejectionReason | None
    candidate: Candidate


class RunHorizon(StrictModel):
    operating_days: int = Field(ge=1, le=366)
    electricity_usd_kwh: float = Field(ge=0, le=10)


class RunEvidence(StrictModel):
    summary: str
    inputs: list[EvidenceInput]
    baseline: Metrics
    selected: Metrics | None
    savings: Savings | None
    formulas: list[EvidenceFormula]
    objective: str
    constraints: list[EvidenceConstraint]
    configurations_evaluated: int = Field(ge=0, le=1200)
    feasible_configurations: int = Field(ge=0, le=1200)
    selection_reason: str
    alternatives: list[EvidenceAlternative] = Field(max_length=5)
    horizon: RunHorizon
    assumptions: list[str]
    missing_inputs: list[str]
    limitations: list[str]


class RunArtifact(StrictModel):
    id: str
    created_at: str
    input_snapshot: Scenario
    model_version: str
    source: Literal["sample", "manual", "photo-assisted"]
    status: RunStatus
    evidence: RunEvidence


class OptimizationResult(StrictModel):
    model_version: str
    source: Literal["sample", "manual", "photo-assisted"]
    status: RunStatus
    operating_days: int
    baseline: Metrics
    optimized: Metrics | None
    savings: Savings | None
    configurations_evaluated: int = Field(ge=0, le=1200)
    feasible_configurations: int = Field(ge=0, le=1200)
    candidates: list[Candidate] = Field(max_length=1200)
    recommendations: list[str]
    limitations: list[str]
    run: RunArtifact | None = None


AssetType = Literal["light_fixture", "shelving_rack", "circulation_fan", "plant", "container", "other"]


class TwinAsset(StrictModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=80)
    type: AssetType
    quantity: int = Field(ge=1, le=1000)
    confidence: float | None = Field(ge=0, le=1)
    confirmed: Literal[False] = False


class ScanResult(StrictModel):
    source: Literal["gemini", "manual"]
    assets: list[TwinAsset] = Field(max_length=6)
    observations: list[str] = Field(max_length=12)
    warnings: list[str] = Field(max_length=12)
