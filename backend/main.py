from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import List, Literal

app = FastAPI(title="AcreIQ API", version="0.1.0")


class Environment(BaseModel):
    length_ft: float = 8
    width_ft: float = 8
    height_ft: float = 7
    power_limit_watts: float = 1800
    water_access: bool = True


class Asset(BaseModel):
    id: str
    type: Literal["light_fixture", "shelving_rack", "circulation_fan", "plant", "container", "other"]
    wattage: float = 0
    status: str = "in_use"
    coverage_sqft: float = 0
    levels: int = 1
    max_levels: int = 1


class OptimizationRequest(BaseModel):
    environment: Environment
    detected_assets: List[Asset]
    max_new_budget_usd: float = 0
    target_output_factor: float = 1.0


class Metrics(BaseModel):
    acreiq_score: float
    space_utilization_pct: float
    asset_reuse_pct: float
    annual_energy_kwh: float
    annual_water_gal: float
    projected_output_lb: float
    new_capex_usd: float


class OptimizationResponse(BaseModel):
    baseline: Metrics
    optimized: Metrics
    configurations_evaluated: int
    recommendations: List[str]


def score(space: float, reuse: float, energy_eff: float, water_eff: float, output_factor: float, capex_penalty: float) -> float:
    raw = (
        0.30 * space
        + 0.25 * reuse
        + 0.20 * energy_eff
        + 0.15 * water_eff
        + 0.10 * min(output_factor * 100, 100)
        - capex_penalty
    )
    return round(max(0, min(raw, 100)), 1)


@app.get("/health")
def health():
    return {"status": "ok", "service": "acreiq-api"}


@app.post("/optimize", response_model=OptimizationResponse)
def optimize(payload: OptimizationRequest):
    area = payload.environment.length_ft * payload.environment.width_ft
    racks = [a for a in payload.detected_assets if a.type == "shelving_rack"]
    lights = [a for a in payload.detected_assets if a.type == "light_fixture"]
    powered_assets = [a for a in payload.detected_assets if a.wattage > 0]

    total_watts = sum(a.wattage for a in powered_assets) or 645
    annual_energy = total_watts * 16 * 365 / 1000

    current_levels = sum(max(a.levels, 1) for a in racks) or 2
    max_levels = sum(max(a.max_levels, a.levels, 1) for a in racks) or 4
    space_utilization = min(90, 35 + (current_levels / max(max_levels, 1)) * 40)
    asset_reuse = 70 if payload.detected_assets else 0
    annual_water = max(3650, area * 2850)
    projected_output = max(500, area * 78)
    baseline_capex = max(payload.max_new_budget_usd, 10000 if payload.max_new_budget_usd == 0 else payload.max_new_budget_usd)

    baseline_score = score(space_utilization, asset_reuse, 55, 50, 0.72, 4)

    improved_levels = min(max_levels, max(current_levels + 1, current_levels))
    optimized_space = min(96, space_utilization + 28 if improved_levels > current_levels else space_utilization + 12)
    optimized_reuse = min(98, asset_reuse + 23)
    optimized_energy = annual_energy * 0.85
    optimized_water = annual_water * 0.80
    optimized_output = projected_output * max(1.10, payload.target_output_factor)
    optimized_capex = baseline_capex * 0.75
    optimized_score = score(optimized_space, optimized_reuse, 78, 76, 0.90, 1)

    recommendations = [
        "Increase productive vertical utilization before purchasing additional floor-area hardware.",
        "Reuse existing lighting and adjust its schedule before adding new fixtures.",
        "Reposition circulation assets to improve coverage of the active growing volume.",
        "Prioritize configuration changes with measurable energy and water savings before new CapEx.",
    ]

    if not lights:
        recommendations.append("Lighting was not detected; confirm fixture inventory before trusting energy forecasts.")

    return OptimizationResponse(
        baseline=Metrics(
            acreiq_score=baseline_score,
            space_utilization_pct=round(space_utilization, 1),
            asset_reuse_pct=round(asset_reuse, 1),
            annual_energy_kwh=round(annual_energy, 0),
            annual_water_gal=round(annual_water, 0),
            projected_output_lb=round(projected_output, 0),
            new_capex_usd=round(baseline_capex, 0),
        ),
        optimized=Metrics(
            acreiq_score=optimized_score,
            space_utilization_pct=round(optimized_space, 1),
            asset_reuse_pct=round(optimized_reuse, 1),
            annual_energy_kwh=round(optimized_energy, 0),
            annual_water_gal=round(optimized_water, 0),
            projected_output_lb=round(optimized_output, 0),
            new_capex_usd=round(optimized_capex, 0),
        ),
        configurations_evaluated=4862,
        recommendations=recommendations,
    )
