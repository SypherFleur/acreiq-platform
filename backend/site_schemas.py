"""Separately versioned, bounded site accounting contracts; legacy schemas stay unchanged."""

from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

Id = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
Text = Annotated[str, Field(max_length=600)]
Revision = Annotated[int, Field(ge=1, le=1_000_000)]
Quantity = Annotated[float, Field(ge=0, le=1e9)]
Hours = Annotated[float, Field(ge=0, le=24)]
Source = Literal["measured", "user_assumption", "synthetic_fixture", "provider_observation"]
MetricKey = Literal["energy_kwh", "peak_watts", "output_kg", "water_liters", "work_hours", "new_setup_cash_usd", "recurring_cash_usd", "horizon_cash_usd", "energy_per_kg", "water_per_kg", "recurring_cash_per_kg", "horizon_cash_per_kg", "lighting_hours", "dli", "layout_feasibility"]
GoalMetric = Literal["output_kg", "energy_kwh", "recurring_cash_usd", "horizon_cash_usd", "horizon_cash_per_kg"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, strict=True)


class Evidence(Strict):
    id: Id
    version: Revision
    source: Source
    entry_route: Literal["manual", "sample", "photo-assisted"]
    note: Text
    recorded_at: Text | None = None
    instrument: Text | None = None
    conditions: Text | None = None
    uncertainty: Text | None = None


class Site(Strict):
    id: Id
    revision: Revision
    name: Text
    boundary_id: Id
    boundary_revision: Revision
    length_ft: Annotated[float, Field(gt=0, le=1000)] | None
    width_ft: Annotated[float, Field(gt=0, le=1000)] | None
    canopy_sqft: Annotated[float, Field(gt=0, le=1e6)] | None
    included_spaces: list[Text] = Field(max_length=30)
    excluded_spaces: list[Text] = Field(max_length=30)
    excluded_costs: list[Text] = Field(max_length=30)
    evidence: Evidence

    @model_validator(mode="after")
    def geometry(self):
        if self.length_ft is not None and self.width_ft is not None and self.canopy_sqft is not None:
            if self.canopy_sqft > self.length_ft * self.width_ft:
                raise ValueError("Single-plane canopy must fit the entered floor area.")
        return self


class Asset(Strict):
    id: Id
    revision: Revision
    site_id: Id
    name: Text
    kind: Annotated[str, Field(min_length=1, max_length=80)]
    quantity: Annotated[int, Field(ge=1, le=100)]
    ownership: Literal["owned", "proposed", "unknown"]
    available: bool | None
    power_basis: Literal["aggregate", "per_unit"]
    watts: Annotated[float, Field(ge=0, le=1e6)] | None
    component_ids: list[Id] = Field(min_length=1, max_length=100)
    footprint_sqft: Quantity | None = None
    evidence: Evidence


class Operation(Strict):
    id: Id
    revision: Revision
    site_id: Id
    operation_type: Literal["indoor_leafy_greens"]
    operation_schema_version: Literal[1]
    name: Text
    crop: Text | None
    cultivar: Text | None
    method: Text | None
    start_stage: Text | None
    end_stage: Text | None
    product_definition: Annotated[str, Field(min_length=1, max_length=600)]
    output_unit: Literal["kg_net_marketable_fresh"]
    horizon_days: Annotated[int, Field(ge=1, le=366)]
    cycle_days: Annotated[int, Field(ge=1, le=366)]
    completed_cycles: Annotated[int, Field(ge=1, le=366)]
    turnover_days: Annotated[int, Field(ge=0, le=366)]
    idle_days: Annotated[int, Field(ge=0, le=366)]
    identical_cycles: bool
    starts_per_cycle: Annotated[int, Field(ge=1, le=1_000_000)] | None
    temperature_c: Annotated[float, Field(ge=-20, le=60)] | None
    humidity_pct: Annotated[float, Field(ge=0, le=100)] | None
    co2_ppm: Annotated[float, Field(ge=0, le=10000)] | None
    ph: Annotated[float, Field(ge=0, le=14)] | None
    ec_ms_cm: Annotated[float, Field(ge=0, le=100)] | None
    nutrient_protocol: Text | None
    protocol_version: Revision
    evidence: Evidence


class Load(Strict):
    id: Id
    asset_id: Id
    asset_revision: Revision
    component_ids: list[Id] = Field(min_length=1, max_length=100)
    accounting: Literal["lighting", "module_other", "external", "unpowered"]
    hours_per_day: Hours | None
    status: Literal["known", "unknown", "excluded"]
    reason: Text | None = None


class Lighting(Strict):
    hours_per_day: Annotated[float, Field(gt=0, le=24)]
    dim_fraction: Annotated[float, Field(gt=0, le=1)]
    dimmable: bool
    ppfd_full: Annotated[float, Field(gt=0, le=5000)] | None
    ppfd_basis: Text | None
    min_dli: Annotated[float, Field(gt=0, le=100)] | None
    min_hours: Annotated[float, Field(gt=0, le=24)]
    max_hours: Annotated[float, Field(gt=0, le=24)]
    power_limit_watts: Annotated[float, Field(gt=0, le=2e6)] | None

    @model_validator(mode="after")
    def bounds(self):
        if self.min_hours > self.max_hours or (not self.dimmable and self.dim_fraction != 1):
            raise ValueError("Lighting bounds or non-dimmable setting are inconsistent.")
        return self


CostCategory = Literal["electricity", "water", "routine_labor", "consumables", "maintenance", "new_equipment", "setup_labor", "setup_materials"]
COST_BASES = {"electricity": "kwh", "water": "liter", "routine_labor": "routine_hour", "setup_labor": "setup_hour", "consumables": "cycle", "maintenance": "cycle", "new_equipment": "horizon", "setup_materials": "horizon"}


class Cost(Strict):
    id: Id
    version: Revision
    category: CostCategory
    status: Literal["known", "unknown", "excluded"]
    basis: Literal["kwh", "liter", "routine_hour", "setup_hour", "cycle", "horizon"]
    rate: Quantity | None
    amount: Quantity | None
    component_ids: list[Id] = Field(min_length=1, max_length=100)
    asset_ids: list[Id] = Field(max_length=64)
    reason: Text | None
    evidence: Evidence

    @model_validator(mode="after")
    def accounting(self):
        if self.basis != COST_BASES[self.category]:
            raise ValueError("Cost category and dimensional basis disagree.")
        if self.basis == "horizon" and self.rate is not None:
            raise ValueError("Horizon amounts cannot also include a rate.")
        if self.basis != "horizon" and self.amount is not None:
            raise ValueError("Rate-based costs cannot also include a period amount.")
        if self.status == "excluded" and not self.reason:
            raise ValueError("Excluded costs require an explicit boundary reason.")
        if self.category == "electricity" and self.rate is not None and self.rate > 10:
            raise ValueError("Electricity tariff exceeds the existing module's supported bound.")
        return self


class Uncertainty(Strict):
    lower: Quantity
    upper: Quantity
    meaning: Text

    @model_validator(mode="after")
    def ordered(self):
        if self.lower > self.upper:
            raise ValueError("Uncertainty lower bound exceeds upper bound.")
        return self


class Benchmark(Strict):
    id: Id
    version: Revision
    scenario_id: Id
    kg_per_cycle: Quantity | None
    context: dict[str, JsonValue]
    uncertainty: Uncertainty | None = None
    evidence: Evidence


class SiteScenario(Strict):
    id: Id
    revision: Revision
    name: Text
    role: Literal["current", "alternative"]
    site_revision: Revision
    operation_revision: Revision
    lighting: Lighting
    loads: list[Load] = Field(min_length=1, max_length=64)
    water_liters_day: Quantity | None
    routine_labor_hours_cycle: Quantity | None
    setup_labor_hours: Quantity | None
    costs: list[Cost] = Field(max_length=8)
    benchmark: Benchmark | None
    change_description: Text
    evidence: Evidence


class GoalTerm(Strict):
    metric: GoalMetric
    direction: Literal["minimize", "maximize"]


class Goal(GoalTerm):
    id: Id
    version: Revision
    secondary: list[GoalTerm] = Field(max_length=4)


class Limit(Strict):
    id: Id
    version: Revision
    metric: MetricKey
    minimum: Quantity | None
    maximum: Quantity | None
    unit: Annotated[str, Field(max_length=50)]
    enabled: bool
    reason: Text | None
    evidence: Evidence


METRIC_UNITS = {"energy_kwh": "kWh", "peak_watts": "W", "output_kg": "kg", "water_liters": "L", "work_hours": "h", "new_setup_cash_usd": "USD", "recurring_cash_usd": "USD", "horizon_cash_usd": "USD", "energy_per_kg": "kWh/kg", "water_per_kg": "L/kg", "recurring_cash_per_kg": "USD/kg", "horizon_cash_per_kg": "USD/kg", "lighting_hours": "h/day", "dli": "mol/m^2/day", "layout_feasibility": "boolean"}


def unique(values, label):
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate {label} are not permitted.")


class Inputs(Strict):
    site: Site
    assets: list[Asset] = Field(min_length=1, max_length=64)
    operation: Operation
    scenarios: list[SiteScenario] = Field(min_length=2, max_length=5)
    goal: Goal
    limits: list[Limit] = Field(max_length=30)

    @model_validator(mode="after")
    def references(self):
        unique([a.id for a in self.assets], "asset IDs")
        unique([c for a in self.assets for c in a.component_ids], "asset component IDs (aggregate meters cannot overlap components)")
        unique([s.id for s in self.scenarios], "scenario IDs")
        unique([l.id for l in self.limits], "limit IDs")
        if sum(s.role == "current" for s in self.scenarios) != 1:
            raise ValueError("Exactly one current scenario is required.")
        if self.operation.site_id != self.site.id or any(a.site_id != self.site.id for a in self.assets):
            raise ValueError("Cross-site references are not supported.")
        assets = {a.id: a for a in self.assets}
        for limit in self.limits:
            if limit.unit != METRIC_UNITS[limit.metric]:
                raise ValueError("Limit unit does not match its metric.")
            if limit.minimum is not None and limit.maximum is not None and limit.minimum > limit.maximum:
                raise ValueError("Limit minimum exceeds maximum.")
            if not limit.enabled and not limit.reason:
                raise ValueError("Disabled limits require a reason.")
        for scenario in self.scenarios:
            if scenario.site_revision != self.site.revision or scenario.operation_revision != self.operation.revision:
                raise ValueError("Unresolved site or operation revision.")
            unique([l.id for l in scenario.loads], "load IDs")
            unique([l.asset_id for l in scenario.loads], "load asset assignments")
            unique([c for l in scenario.loads for c in l.component_ids], "load component assignments")
            if set(l.asset_id for l in scenario.loads) != set(assets):
                raise ValueError("Every asset requires exactly one explicit load accounting assignment.")
            for load in scenario.loads:
                asset = assets[load.asset_id]
                if load.asset_revision != asset.revision or set(load.component_ids) != set(asset.component_ids):
                    raise ValueError("Load must reference its exact asset revision and complete component set.")
                if load.status == "excluded" and not load.reason:
                    raise ValueError("Excluded loads require a reason.")
                if load.accounting == "unpowered" and asset.watts != 0:
                    raise ValueError("Only explicit zero-watt assets can be unpowered.")
                if load.accounting == "lighting" and load.hours_per_day != scenario.lighting.hours_per_day:
                    raise ValueError("Lighting usage must equal the requested lighting schedule.")
            if not any(l.accounting == "lighting" for l in scenario.loads):
                raise ValueError("At least one lighting component is required.")
            unique([c.id for c in scenario.costs], "cost IDs")
            unique([c.category for c in scenario.costs], "cost categories (use one inclusive amount per category)")
            unique([i for c in scenario.costs for i in c.component_ids], "expense components")
            for cost in scenario.costs:
                if any(a not in assets for a in cost.asset_ids):
                    raise ValueError("Unresolved cost asset reference.")
                if cost.category == "new_equipment" and cost.status == "known" and cost.amount:
                    if not cost.asset_ids or any(assets[a].ownership != "proposed" for a in cost.asset_ids):
                        raise ValueError("New acquisition cash must reference proposed assets, not owned inventory.")
            if scenario.benchmark and scenario.benchmark.scenario_id != scenario.id:
                raise ValueError("A benchmark must explicitly reference its scenario.")
        return self


class Review(Strict):
    snapshot_json: Annotated[str, Field(max_length=220_000)]
    reviewed_at: Annotated[str, Field(min_length=1, max_length=60)]


class ComparisonRequest(Inputs):
    review: Review | None = None
    prior_comparison_id: Id | None = None


class VerifyRequest(Strict):
    comparison_id: Id
    sha256: Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
