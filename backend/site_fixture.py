"""Editable A/B/C fixture. Every number is synthetic, not an agronomic recommendation."""

if __package__:
    from .site_schemas import ComparisonRequest, COST_BASES, METRIC_UNITS
    from .site_comparison import benchmark_context
else:
    from site_schemas import ComparisonRequest, COST_BASES, METRIC_UNITS
    from site_comparison import benchmark_context


def evidence(identity, note="Synthetic test fixture, not agronomic evidence."):
    return {"id": identity, "version": 1, "source": "synthetic_fixture", "entry_route": "sample",
            "note": note, "recorded_at": None, "instrument": None, "conditions": None, "uncertainty": None}


def fixture():
    site = {"id": "fixture-site-1", "revision": 1, "name": "Synthetic growing bay", "boundary_id": "fixture-bay-boundary", "boundary_revision": 1,
            "length_ft": 8.0, "width_ft": 8.0, "canopy_sqft": 32.0,
            "included_spaces": ["Single growing bay, one 4 x 8 ft canopy; transplant-ready starts through graded harvest"],
            "excluded_spaces": ["Upstream nursery before receipt", "Building common areas", "Off-site cold storage and distribution"],
            "excluded_costs": ["Rent", "Shared building charges", "Financing", "Tax accounting", "Depreciation", "Owner opportunity cost", "Sales and distribution"],
            "evidence": evidence("fixture-common-inputs")}
    assets = []
    for suffix, name, kind, count, watts, basis in [("lights", "Two owned LED fixtures", "lighting", 2, 600.0, "aggregate"), ("fan", "Circulation fan", "fan", 1, 45.0, "per_unit"), ("pump", "Recirculation pump", "pump", 1, 30.0, "per_unit"), ("climate", "Climate unit", "climate", 1, 200.0, "per_unit"), ("bench", "Bench and reservoir", "bench", 1, 0.0, "aggregate")]:
        identity = f"fixture-{suffix}"
        assets.append({"id": identity, "revision": 1, "site_id": site["id"], "name": name, "kind": kind,
                       "quantity": count, "ownership": "owned", "available": True, "power_basis": basis, "watts": watts,
                       "component_ids": [identity], "footprint_sqft": None, "evidence": evidence("fixture-load-accounting")})
    operation = {"id": "fixture-lettuce-op", "revision": 1, "site_id": site["id"], "operation_type": "indoor_leafy_greens", "operation_schema_version": 1,
                 "name": "Synthetic two-cycle lettuce operation", "crop": "Lettuce", "cultivar": "FIXTURE-LETTUCE-1", "method": "Recirculating hydroponics, inert plugs",
                 "start_stage": "Transplant-ready starts, day 1", "end_stage": "Graded marketable harvest, end of day 28",
                 "product_definition": "Net marketable fresh leaves after grading; excludes roots, medium, packaging and rejects",
                 "output_unit": "kg_net_marketable_fresh", "horizon_days": 56, "cycle_days": 28, "completed_cycles": 2,
                 "turnover_days": 0, "idle_days": 0, "identical_cycles": True, "starts_per_cycle": 160,
                 "temperature_c": 22.0, "humidity_pct": 60.0, "co2_ppm": 420.0, "ph": 6.0, "ec_ms_cm": 1.5,
                 "nutrient_protocol": "FIXTURE-N1", "protocol_version": 1, "evidence": evidence("fixture-common-conditions", "Synthetic identical cycles; cleaning/reset within last day. Climate stipulated, not modeled; fictional nutrient protocol, not a recipe.")}
    scenarios = []
    for letter, name, hours, water, routine, consumables, setup, kg in [("A", "A - Current operation", 16.0, 15.0, 8.0, 25.0, 0.0, 24.0), ("B", "B - Shorter schedule", 12.0, 14.0, 8.0, 25.0, .5, 20.0), ("C", "C - Longer schedule", 18.0, 16.0, 9.0, 28.0, 1.5, 30.0)]:
        sid = f"fixture-{letter}"
        loads = []
        for asset, accounting, duty in zip(assets, ["lighting", "module_other", "external", "external", "unpowered"], [hours, 24.0, 8.0, 4.0, 0.0]):
            loads.append({"id": f"{sid}-{asset['id']}-usage", "asset_id": asset["id"], "asset_revision": 1, "component_ids": asset["component_ids"], "accounting": accounting, "hours_per_day": duty, "status": "known", "reason": "Synthetic daily clock starts at 00:00; all active loads coincide."})
        rates = {"electricity": .20, "water": .002, "routine_labor": 20.0, "consumables": consumables, "maintenance": 4.0, "setup_labor": 20.0}
        costs = []
        for category, basis in COST_BASES.items():
            note = "Synthetic cost basis; scoped cash, not whole-enterprise cost."
            if category == "consumables":
                note = "All-in per-cycle starts, nutrients, inert plugs and harvest packaging; no separately charged subitems."
            elif category == "water":
                note = "Combined variable supply/disposal tariff on make-up and cleaning water; fixed charges excluded from this boundary."
            elif category == "new_equipment":
                note = "Explicit zero new acquisition cash: all listed assets are already owned. Historical value is not a cash outflow."
            costs.append({"id": f"{sid}-cost-{category}", "version": 1, "category": category, "status": "known", "basis": basis,
                          "rate": rates.get(category), "amount": 0.0 if basis == "horizon" else None,
                          "component_ids": [f"expense-{category}"], "asset_ids": [a["id"] for a in assets] if category == "new_equipment" else [],
                          "reason": None, "evidence": evidence("fixture-cost-basis", note)})
        scenarios.append({"id": sid, "revision": 1, "name": name, "role": "current" if letter == "A" else "alternative",
                          "site_revision": 1, "operation_revision": 1,
                          "lighting": {"hours_per_day": hours, "dim_fraction": 1.0, "dimmable": False, "ppfd_full": 350.0, "ppfd_basis": "Synthetic representative full-output canopy scalar; no sunlight; instrument/date/map/uniformity unknown", "min_dli": 15.0, "min_hours": 10.0, "max_hours": 18.0, "power_limit_watts": 1000.0},
                          "loads": loads, "water_liters_day": water, "routine_labor_hours_cycle": routine, "setup_labor_hours": setup, "costs": costs,
                          "benchmark": {"id": f"fixture-benchmark-{letter}", "version": 1, "scenario_id": sid, "kg_per_cycle": kg, "context": {}, "uncertainty": None, "evidence": evidence(f"fixture-inputs-{letter}", "Independent synthetic kg/cycle assumption for this exact recipe and two repetitions; no fitted yield response.")},
                          "change_description": "Synthetic reference current operation" if letter == "A" else "Reviewed schedule/usage alternative; same owned assets, no equipment movement",
                          "evidence": evidence(f"fixture-inputs-{letter}")})
    limits = []
    for suffix, key, lower, upper in [("hours", "lighting_hours", 10.0, 18.0), ("dli", "dli", 15.0, None), ("power", "peak_watts", None, 1000.0), ("output", "output_kg", 44.0, None), ("water", "water_liters", None, 900.0), ("labor", "work_hours", None, 20.0), ("cash", "horizon_cash_usd", None, 620.0), ("new-cash", "new_setup_cash_usd", None, 40.0)]:
        limits.append({"id": f"fixture-{suffix}", "version": 1, "metric": key, "minimum": lower, "maximum": upper, "unit": METRIC_UNITS[key], "enabled": True, "reason": None, "evidence": evidence("fixture-limits")})
    result = {"site": site, "assets": assets, "operation": operation, "scenarios": scenarios,
              "goal": {"id": "fixture-output-goal", "version": 1, "metric": "output_kg", "direction": "maximize", "secondary": []},
              "limits": limits, "review": None, "prior_comparison_id": None}
    for scenario in scenarios:
        scenario["benchmark"]["context"] = benchmark_context(result, scenario)
    return ComparisonRequest.model_validate(result).model_dump()
