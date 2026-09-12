import copy
import unittest
from unittest.mock import patch
from pydantic import ValidationError
from .core import SAMPLE, Scenario, solve
from .main import ImageRequest, vision
from fastapi import HTTPException

class CoreTests(unittest.TestCase):
    def scenario(self, **changes):
        return Scenario(**(copy.deepcopy(SAMPLE) | {"confirmed": True} | changes))

    def test_energy_units(self):
        r = solve(self.scenario())
        self.assertAlmostEqual(r["baseline"]["daily_energy_kwh"], 10.68)
        self.assertAlmostEqual(r["baseline"]["period_energy_kwh"], 3898.2)

    def test_search_counts_are_real(self):
        r = solve(self.scenario())
        self.assertEqual(r["configurations_evaluated"], len(r["candidates"]))
        self.assertEqual(r["configurations_evaluated"], 33)
        self.assertEqual(r["feasible_configurations"], sum(c["feasible"] for c in r["candidates"]))

    def test_search_finds_minimum_energy(self):
        r = solve(self.scenario())
        feasible = [c for c in r["candidates"] if c["feasible"]]
        self.assertEqual(r["optimized"]["daily_energy_kwh"], min(c["daily_energy_kwh"] for c in feasible))
        self.assertEqual(r["optimized"]["photoperiod_hours"], 12)
        self.assertAlmostEqual(r["savings"]["period_energy_kwh"], 876)

    def test_unknown_light_measurement_abstains(self):
        r = solve(self.scenario(ppfd_full=None))
        self.assertIsNone(r["optimized"])
        self.assertEqual(r["configurations_evaluated"], 0)

    def test_confirmation_required(self):
        self.assertEqual(solve(self.scenario(confirmed=False))["status"], "needs_measurement")

    def test_infeasible_is_not_fake_success(self):
        r = solve(self.scenario(power_limit_watts=100))
        self.assertEqual(r["status"], "no_feasible_configuration")
        self.assertIsNone(r["savings"])

    def test_never_fabricates_water_yield_or_capex(self):
        r = solve(self.scenario())
        for k in ("water_liters", "yield_gain_lb", "avoided_capex_usd"):
            self.assertIsNone(r["savings"][k])
        self.assertEqual(r["baseline"]["period_water_liters"], r["optimized"]["period_water_liters"])

    def test_invalid_dimensions_and_nonfinite(self):
        for changes in ({"length_ft": 0}, {"canopy_sqft": 65}, {"lighting_watts": float("nan")}, {"min_hours": 20}, {"baseline_dim": .5}):
            with self.assertRaises(ValidationError):
                self.scenario(**changes)

    def test_dimming_expands_real_grid(self):
        r = solve(self.scenario(dimmable=True))
        self.assertEqual(r["configurations_evaluated"], 363)
        for c in r["candidates"]:
            if c["feasible"]:
                self.assertGreaterEqual(c["dli_mol_m2_day"], 15)
                self.assertLessEqual(c["peak_modeled_watts"], 1800)

    def test_user_target_can_require_more_energy(self):
        r = solve(self.scenario(baseline_hours=8))
        self.assertLess(r["savings"]["period_energy_kwh"], 0)

    def test_already_optimal_and_zero_rate(self):
        r = solve(self.scenario(baseline_hours=12, electricity_usd_kwh=0))
        self.assertEqual(r["savings"]["period_energy_kwh"], 0)
        self.assertEqual(r["savings"]["period_energy_cost_usd"], 0)

    def test_horizon_scales_not_calendar_claim(self):
        r = solve(self.scenario(operating_days=30))
        self.assertAlmostEqual(r["savings"]["period_energy_kwh"], 72)

    def test_missing_credentials_are_explicit(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(HTTPException) as cm:
                vision(ImageRequest(mime_type="image/png", image_base64="A" * 16))
            self.assertEqual(cm.exception.status_code, 503)

    def test_vision_rejects_mismatched_image(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": "test", "GEMINI_MODEL": "test"}):
            with self.assertRaises(HTTPException) as cm:
                vision(ImageRequest(mime_type="image/png", image_base64="A" * 16))
            self.assertEqual(cm.exception.status_code, 422)

if __name__ == "__main__":
    unittest.main()
