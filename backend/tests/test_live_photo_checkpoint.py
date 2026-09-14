"""Offline contract checks for photo-assisted and manually entered scenarios."""

from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from google.auth.exceptions import DefaultCredentialsError
from google.genai import errors

from backend.core import MODEL_VERSION
from backend.main import create_app
from backend.vision import VisionService


@pytest.fixture(params=["manual", "photo-assisted"])
def real_input_scenario(request):
    # Synthetic test inputs deliberately independent of the product's SAMPLE.
    return {
        "source": request.param,
        "length_ft": 4, "width_ft": 4, "canopy_sqft": 12,
        "light_count": 1, "lighting_watts": 240, "other_watts": 20,
        "other_hours": 24, "baseline_hours": 18, "baseline_dim": 1,
        "dimmable": False, "ppfd_full": 400, "min_dli": 18,
        "min_hours": 12, "max_hours": 18, "power_limit_watts": 300,
        "electricity_usd_kwh": 0.2, "operating_days": 30,
        "water_liters_day": None, "confirmed": True,
    }


def assert_abstained(result, source):
    assert result["source"] == source
    assert result["status"] == "needs_measurement"
    assert result["optimized"] is result["savings"] is None
    assert result["configurations_evaluated"] == result["feasible_configurations"] == 0
    assert result["candidates"] == []
    assert result["recommendations"]


def test_confirmed_real_inputs_use_entered_horizon_and_loads(manual_client, real_input_scenario):
    response = manual_client.post("/optimize", json=real_input_scenario)
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == real_input_scenario["source"]
    assert result["status"] == "optimized"
    assert result["operating_days"] == 30
    assert result["baseline"]["daily_energy_kwh"] == pytest.approx(4.8)
    assert result["optimized"]["photoperiod_hours"] == 12.5
    assert result["savings"]["period_energy_kwh"] == pytest.approx(39.6)
    assert result["savings"]["period_energy_cost_usd"] == pytest.approx(7.92)
    assert result["baseline"]["period_water_liters"] is None
    assert result["optimized"]["period_water_liters"] is None
    assert all(result["savings"][field] is None for field in (
        "water_liters", "yield_gain_lb", "avoided_capex_usd",
    ))


@pytest.mark.parametrize("field", [
    "length_ft", "width_ft", "canopy_sqft", "light_count", "lighting_watts",
    "other_watts", "other_hours", "baseline_hours", "baseline_dim",
    "min_hours", "max_hours", "power_limit_watts", "electricity_usd_kwh", "operating_days",
])
@pytest.mark.parametrize("missing", ["omitted", "null"])
def test_missing_real_measurements_are_validation_errors(
    manual_client, real_input_scenario, field, missing,
):
    if missing == "omitted":
        real_input_scenario.pop(field)
    else:
        real_input_scenario[field] = None
    response = manual_client.post("/optimize", json=real_input_scenario)
    assert response.status_code == 422
    assert set(response.json()) == {"detail"}
    assert any(error["loc"] == ["body", field] for error in response.json()["detail"])


@pytest.mark.parametrize("field", ["ppfd_full", "min_dli"])
@pytest.mark.parametrize("missing", ["omitted", "null"])
def test_missing_crop_measurements_abstain_without_sample_fallback(
    manual_client, real_input_scenario, field, missing,
):
    if missing == "omitted":
        real_input_scenario.pop(field)
    else:
        real_input_scenario[field] = None
    response = manual_client.post("/optimize", json=real_input_scenario)
    assert response.status_code == 200
    result = response.json()
    assert_abstained(result, real_input_scenario["source"])
    assert result["operating_days"] == 30
    assert result["baseline"]["daily_energy_kwh"] == pytest.approx(4.8)
    assert "PPFD" in " ".join(result["recommendations"])
    assert "DLI" in " ".join(result["recommendations"])
    if field == "ppfd_full":
        assert result["baseline"]["dli_mol_m2_day"] is None


@pytest.mark.parametrize("confirmation", ["omitted", "false"])
def test_real_inputs_require_explicit_confirmation(manual_client, real_input_scenario, confirmation):
    if confirmation == "omitted":
        real_input_scenario.pop("confirmed")
    else:
        real_input_scenario["confirmed"] = False
    response = manual_client.post("/optimize", json=real_input_scenario)
    assert response.status_code == 200
    assert_abstained(response.json(), real_input_scenario["source"])
    assert "Confirm" in " ".join(response.json()["recommendations"])


def test_missing_credentials_preserve_manual_scan_and_optimization(monkeypatch, image_bytes, real_input_scenario):
    monkeypatch.setattr("backend.vision.os.environ", {})
    sdk_client = Mock(side_effect=AssertionError("Manual mode must not initialize a provider"))
    adc = Mock(side_effect=AssertionError("Manual mode must not discover credentials"))
    monkeypatch.setattr("backend.vision.genai.Client", sdk_client)
    monkeypatch.setattr("backend.vision.google.auth.default", adc)
    with TestClient(create_app()) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {
            "status": "ok", "service": "acreiq-api", "vision_available": False,
            "vision_provider": "manual", "model_version": MODEL_VERSION,
        }
        scan = client.post("/scan", files={"image": ("fixture.png", image_bytes(), "image/png")})
        assert scan.status_code == 200
        assert set(scan.json()) == {"source", "assets", "observations", "warnings"}
        assert scan.json()["source"] == "manual"
        assert scan.json()["assets"] == scan.json()["observations"] == []
        assert "not scanned" in " ".join(scan.json()["warnings"])
        result = client.post("/optimize", json=real_input_scenario)
        assert result.status_code == 200
        assert result.json()["source"] == real_input_scenario["source"]
        assert result.json()["status"] == "optimized"
    sdk_client.assert_not_called()
    adc.assert_not_called()


def test_missing_adc_keeps_backend_healthy_and_manual_optimization_available(
    monkeypatch, image_bytes, real_input_scenario,
):
    adc = Mock(side_effect=DefaultCredentialsError("private-test-credential-details"))
    monkeypatch.setattr("backend.vision.google.auth.default", adc)
    service = VisionService(provider="vertex", project="test-project", location="global")
    with TestClient(create_app(service)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json() == {
            "status": "ok", "service": "acreiq-api", "vision_available": False,
            "vision_provider": "vertex", "model_version": MODEL_VERSION,
        }
        scan = client.post("/scan", files={"image": ("fixture.png", image_bytes(), "image/png")})
        assert scan.status_code == 503
        assert set(scan.json()) == {"detail"}
        assert "manually" in scan.json()["detail"]
        assert "private-test-credential-details" not in scan.text
        result = client.post("/optimize", json=real_input_scenario)
        assert result.status_code == 200
        assert result.json()["source"] == real_input_scenario["source"]
        assert result.json()["status"] == "optimized"
    adc.assert_called_once()


@pytest.mark.parametrize("provider", ["gemini", "vertex"])
def test_photo_observations_cannot_be_submitted_as_measurements(
    configured_service, provider_response, image_bytes, provider,
):
    configured_service.provider = provider
    configured_service.client.aio.models.generate_content.return_value = provider_response({
        "assets": [
            {"type": "light_fixture", "quantity": 1, "confidence": 0.6},
            {"type": "container", "quantity": 7, "confidence": None},
        ],
        "observations": ["overhead_lights", "containers_visible"],
        "warnings": ["uncertain_counts"],
    })
    with TestClient(create_app(configured_service)) as client:
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert health.json()["vision_available"] is True
        assert health.json()["vision_provider"] == provider
        response = client.post("/scan", files={"image": ("fixture.png", image_bytes(), "image/png")})
        assert response.status_code == 200
        result = response.json()
        assert set(result) == {"source", "assets", "observations", "warnings"}
        assert result["source"] == "gemini"
        assert len(result["assets"]) == 2
        for asset in result["assets"]:
            assert set(asset) == {"id", "name", "type", "quantity", "confidence", "confirmed"}
            assert asset["confirmed"] is False
            assert {key for key, value in asset.items() if type(value) in (int, float)} <= {"quantity", "confidence"}
        assert any("Confirm every item" in warning for warning in result["warnings"])
        assert any("uncalibrated" in warning for warning in result["warnings"])
        assert any("were measured from the photo" in warning and warning.startswith("No ") for warning in result["warnings"])
        for payload in (result, {"source": "photo-assisted", "confirmed": True}):
            rejected = client.post("/optimize", json=payload)
            assert rejected.status_code == 422
            assert set(rejected.json()) == {"detail"}


@pytest.mark.parametrize("injection", ["asset-watts", "dimensions", "savings", "warning-measurement"])
def test_provider_cannot_smuggle_measurements_or_savings_into_scan(
    configured_service, provider_response, image_bytes, injection,
):
    payload = {
        "assets": [{"type": "light_fixture", "quantity": 1, "confidence": None}],
        "observations": [], "warnings": [],
    }
    if injection == "asset-watts":
        payload["assets"][0]["lighting_watts"] = 240
    elif injection == "dimensions":
        payload["length_ft"] = 4
    elif injection == "savings":
        payload["savings"] = {"energy_pct": 25}
    else:
        payload["warnings"] = ["Use an 18 hour photoperiod and 400 PPFD"]
    configured_service.client.aio.models.generate_content.return_value = provider_response(payload)
    with TestClient(create_app(configured_service)) as client:
        response = client.post("/scan", files={"image": ("fixture.png", image_bytes(), "image/png")})
    assert response.status_code == 502
    assert set(response.json()) == {"detail"}
    assert "No suggestions were accepted" in response.json()["detail"]


@pytest.mark.parametrize("code", [403, 429])
def test_provider_failure_is_an_http_error_without_sample_fallback(configured_service, image_bytes, code):
    configured_service.client.aio.models.generate_content.side_effect = errors.APIError(
        code, {"error": {"code": code, "message": "private-test-provider-details"}},
    )
    with TestClient(create_app(configured_service)) as client:
        response = client.post("/scan", files={"image": ("fixture.png", image_bytes(), "image/png")})
        assert response.status_code == 503
        assert set(response.json()) == {"detail"}
        assert "private-test-provider-details" not in response.text
        health = client.get("/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
