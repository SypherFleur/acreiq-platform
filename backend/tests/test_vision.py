import asyncio
import io
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from google.auth.exceptions import DefaultCredentialsError
from google.genai import errors, types
from google.oauth2.credentials import Credentials
from PIL import Image

from backend.main import create_app
from backend.vision import (
    MAX_RESPONSE_BYTES, Inventory, LimitedResponseStream, LimitedTransport,
    ResponseTooLarge, VerifiedImage, VisionService, validate_image,
)


def test_configured_scan_is_unconfirmed_and_request_contains_no_filename(configured_service, image_bytes):
    generate = configured_service.client.aio.models.generate_content
    with TestClient(create_app(configured_service)) as client:
        assert client.get("/health").json()["vision_available"] is True
        response = client.post("/scan", files={"image": ("secret-name.png", image_bytes(), "image/png")})
    assert response.status_code == 200
    result = response.json()
    assert result["source"] == "gemini"
    assert result["assets"][0]["confirmed"] is False
    assert result["assets"][0]["quantity"] == 2
    assert result["assets"][0]["confidence"] == 0.8
    assert set(result["assets"][0]) == {"id", "name", "type", "quantity", "confidence", "confirmed"}
    assert any("No dimensions" in warning for warning in result["warnings"])
    kwargs = generate.call_args.kwargs
    assert kwargs["contents"][0].inline_data.mime_type == "image/jpeg"
    assert kwargs["config"].max_output_tokens == 2048
    assert "secret-name" not in str(kwargs)
    assert "ppfd_full" not in json.dumps(Inventory.model_json_schema())


@pytest.mark.parametrize("payload", [
    "not JSON", "x" * 17000,
    {"assets": [{"type": "light_fixture", "quantity": 0, "confidence": None}], "observations": [], "warnings": []},
    {"assets": [{"type": "light_fixture", "quantity": 1, "confidence": 1.5}], "observations": [], "warnings": []},
    {"assets": [{"type": "light_fixture", "quantity": "2", "confidence": None}], "observations": [], "warnings": []},
    {"assets": [{"type": "light_fixture", "quantity": True, "confidence": None}], "observations": [], "warnings": []},
    {"assets": [{"type": "light_fixture", "quantity": 1, "confidence": None, "confirmed": True}], "observations": [], "warnings": []},
    {"assets": [], "observations": ["The room is 12 feet wide"], "warnings": []},
    {"assets": [], "observations": [], "warnings": [], "ppfd": 350},
    {"assets": [{"type": "light_fixture", "quantity": 1, "confidence": None}] * 2, "observations": [], "warnings": []},
    {"assets": [{"type": "plant", "quantity": 1, "confidence": None}] * 7, "observations": [], "warnings": []},
    {"assets": [{"type": "plant", "quantity": 1, "confidence": None}], "observations": ["no_growing_equipment"], "warnings": []},
], ids=["bad-json", "oversized", "zero-count", "invalid-confidence", "string-count", "boolean-count",
        "confirmed", "measurement-prose", "measurement-field", "duplicate-types", "too-many-assets", "contradiction"])
def test_untrusted_provider_output_is_rejected(configured_service, provider_response, image_bytes, payload):
    configured_service.client.aio.models.generate_content.return_value = provider_response(payload)
    with TestClient(create_app(configured_service)) as client:
        response = client.post("/scan", files={"image": ("image.png", image_bytes(), "image/png")})
    assert response.status_code == 502
    assert "assets" not in response.json()


@pytest.mark.parametrize("finish", [types.FinishReason.MAX_TOKENS, types.FinishReason.SAFETY])
async def test_truncated_or_blocked_provider_output_is_not_accepted(configured_service, provider_response, finish):
    configured_service.client.aio.models.generate_content.return_value = provider_response(finish=finish)
    with pytest.raises(HTTPException) as error:
        await configured_service.scan(VerifiedImage(b"already verified test data"))
    assert error.value.status_code == 502


@pytest.mark.parametrize("code,status", [(400, 502), (401, 503), (403, 503), (404, 502), (429, 503), (500, 503), (503, 503)])
async def test_provider_errors_are_clear_and_do_not_leak_credentials(configured_service, code, status):
    configured_service.client.aio.models.generate_content.side_effect = errors.APIError(
        code, {"error": {"code": code, "message": "secret-key-provider-debug-information"}})
    with pytest.raises(HTTPException) as error:
        await configured_service.scan(VerifiedImage(b"test"))
    assert error.value.status_code == status
    assert "secret-key" not in error.value.detail
    assert configured_service._active_scans == 0


async def test_total_provider_timeout(configured_service):
    async def stall(**kwargs):
        await asyncio.sleep(0.2)
    configured_service.timeout_seconds = 0.01
    configured_service.client.aio.models.generate_content = stall
    with pytest.raises(HTTPException) as error:
        await configured_service.scan(VerifiedImage(b"test"))
    assert error.value.status_code == 503
    assert "timed out" in error.value.detail
    assert configured_service._active_scans == 0


async def test_concurrent_scan_admission_is_bounded(configured_service):
    configured_service._active_scans = 2
    with pytest.raises(HTTPException) as error:
        await configured_service.scan(VerifiedImage(b"test"))
    assert error.value.status_code == 503
    assert error.value.headers["Retry-After"] == "5"
    configured_service.client.aio.models.generate_content.assert_not_called()


def test_image_reencoding_strips_metadata_and_trailing_payload():
    image = Image.new("RGB", (16, 16), "green")
    exif = Image.Exif()
    exif[270] = "private description"
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    result = validate_image(buffer.getvalue() + b"private appended instructions", "image/jpeg")
    assert b"private" not in result.data
    with Image.open(io.BytesIO(result.data)) as clean:
        assert len(clean.getexif()) == 0


def test_exif_rotation_and_size_are_normalized():
    image = Image.new("RGB", (100, 200))
    exif = Image.Exif()
    exif[274] = 6
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif)
    result = validate_image(buffer.getvalue(), "image/jpeg")
    with Image.open(io.BytesIO(result.data)) as clean:
        assert clean.size == (200, 100)


def test_animation_is_rejected():
    frames = [Image.new("RGB", (16, 16), color) for color in ["green", "red"]]
    buffer = io.BytesIO()
    frames[0].save(buffer, format="WEBP", save_all=True, append_images=frames[1:])
    with pytest.raises(HTTPException) as error:
        validate_image(buffer.getvalue(), "image/webp")
    assert error.value.status_code == 422


@pytest.mark.parametrize("size", [(8193, 1), (5000, 4001)])
def test_decoded_dimensions_are_bounded(image_bytes, size):
    with pytest.raises(HTTPException) as error:
        validate_image(image_bytes(size=size), "image/png")
    assert error.value.status_code == 413


@pytest.fixture
def clean_environment(monkeypatch):
    for name in ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT",
                 "GOOGLE_CLOUD_LOCATION", "GEMINI_MODEL", "GEMINI_TIMEOUT_SECONDS"]:
        monkeypatch.delenv(name, raising=False)


def test_keys_are_server_only_with_explicit_precedence(monkeypatch, clean_environment):
    assert VisionService.from_environment().provider == "manual"
    monkeypatch.setenv("GOOGLE_API_KEY", "google-test-key")
    assert VisionService.from_environment().api_key == "google-test-key"
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test-key")
    service = VisionService.from_environment()
    assert service.api_key == "gemini-test-key"
    assert "test-key" not in repr(service)
    monkeypatch.setenv("GOOGLE_GENAI_USE_VERTEXAI", "true")
    service = VisionService.from_environment()
    assert service.api_key is None
    assert service.provider == "vertex"
    assert service.configuration_error


@pytest.mark.parametrize("variable,value", [
    ("GEMINI_TIMEOUT_SECONDS", "NaN"), ("GEMINI_TIMEOUT_SECONDS", "61"),
    ("GEMINI_TIMEOUT_SECONDS", "0"), ("GEMINI_TIMEOUT_SECONDS", "invalid"),
    ("GEMINI_MODEL", "https://untrusted.example"), ("GOOGLE_GENAI_USE_VERTEXAI", "maybe"),
])
async def test_invalid_config_is_explicit_503(monkeypatch, clean_environment, variable, value):
    monkeypatch.setenv(variable, value)
    service = VisionService.from_environment()
    assert not service.available
    with pytest.raises(HTTPException) as error:
        await service.scan(VerifiedImage(b"test"))
    assert error.value.status_code == 503


async def test_missing_vertex_adc_keeps_health_available_without_claiming_vision(monkeypatch):
    def fail(**kwargs):
        raise DefaultCredentialsError("private credential details")
    monkeypatch.setattr("backend.vision.google.auth.default", fail)
    service = VisionService(provider="vertex", project="project", location="global")
    await service.start()
    assert service.available is False
    assert "private" not in service.configuration_error
    with pytest.raises(HTTPException) as error:
        await service.scan(VerifiedImage(b"test"))
    assert error.value.status_code == 503


async def test_real_sdk_serializes_structured_request_with_mock_http(monkeypatch, image_bytes):
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text": json.dumps({
            "assets": [{"type": "plant", "quantity": 3, "confidence": None}], "observations": [], "warnings": [],
        })}]}, "finishReason": "STOP"}]})
    transport = LimitedTransport()
    await transport.transport.aclose()
    transport.transport = httpx.MockTransport(handler)
    monkeypatch.setattr("backend.vision.LimitedTransport", lambda: transport)
    service = VisionService(provider="gemini", api_key="test-only-key")
    await service.start()
    try:
        result = await service.scan(validate_image(image_bytes(), "image/png"))
        assert result.assets[0].quantity == 3
        assert result.assets[0].confidence is None
        assert result.assets[0].confirmed is False
        assert seen[0].url.host == "generativelanguage.googleapis.com"
        body = json.loads(seen[0].content)
        assert body["generationConfig"]["responseMimeType"] == "application/json"
        assert body["generationConfig"]["responseJsonSchema"]["additionalProperties"] is False
        assert "tools" not in body
        assert seen[0].headers["accept-encoding"] == "identity"
    finally:
        await service.close()


async def test_response_stream_is_bounded_before_sdk_json_parsing():
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"x" * (MAX_RESPONSE_BYTES // 2)
            yield b"x" * MAX_RESPONSE_BYTES
    with pytest.raises(ResponseTooLarge):
        async for _ in LimitedResponseStream(Stream()):
            pass


async def test_vertex_uses_adc_and_never_ambient_api_key(monkeypatch, clean_environment, image_bytes):
    monkeypatch.setenv("GOOGLE_API_KEY", "must-not-use-api-key")
    expiry = datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=1)
    credentials = Credentials(token="test-adc-token", expiry=expiry)
    monkeypatch.setattr("backend.vision.google.auth.default", lambda **kwargs: (credentials, "test-project"))
    seen = []
    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"candidates": [{"content": {"role": "model", "parts": [{"text":
            '{"assets":[],"observations":[],"warnings":[]}'
        }]}, "finishReason": "STOP"}]})
    transport = LimitedTransport()
    await transport.transport.aclose()
    transport.transport = httpx.MockTransport(handler)
    monkeypatch.setattr("backend.vision.LimitedTransport", lambda: transport)
    service = VisionService(provider="vertex", project="test-project", location="global")
    await service.start()
    try:
        result = await service.scan(validate_image(image_bytes(), "image/png"))
        assert result.source == "gemini"
        assert "aiplatform.googleapis.com" in seen[0].url.host
        assert seen[0].headers["authorization"] == "Bearer test-adc-token"
        assert "x-goog-api-key" not in seen[0].headers
    finally:
        await service.close()


@pytest.mark.parametrize("headers", [{"content-length": str(MAX_RESPONSE_BYTES + 1)}, {"content-encoding": "gzip"}])
async def test_transport_rejects_oversized_or_compressed_responses(headers):
    transport = LimitedTransport()
    await transport.transport.aclose()
    transport.transport = httpx.MockTransport(lambda request: httpx.Response(200, headers=headers))
    try:
        with pytest.raises(ResponseTooLarge):
            await transport.handle_async_request(httpx.Request("POST", "https://example.test"))
    finally:
        await transport.aclose()
