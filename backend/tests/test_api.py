import json

import httpx
import pytest

from backend.core import MODEL_VERSION, SAMPLE
from backend.main import create_app
from backend.vision import MAX_UPLOAD_BYTES, VisionService


def test_health_and_exact_sample(manual_client):
    assert manual_client.get("/health").json() == {
        "status": "ok", "service": "acreiq-api", "vision_available": False,
        "vision_provider": "manual", "model_version": MODEL_VERSION,
    }
    assert manual_client.get("/sample").json() == SAMPLE
    assert manual_client.post("/optimize", json=SAMPLE).json()["status"] == "needs_measurement"


def test_optimize_accepts_scenario_and_rejects_old_contract(manual_client):
    response = manual_client.post("/optimize", json={**SAMPLE, "confirmed": True})
    assert response.status_code == 200
    assert response.json()["configurations_evaluated"] == 33
    assert manual_client.post("/optimize", json={"environment": {}, "detected_assets": []}).status_code == 422
    assert manual_client.post("/optimize", json={**SAMPLE, "ppfd_full": "350"}).status_code == 422


def test_nonfinite_json_is_safe_validation_error(manual_client):
    response = manual_client.post("/optimize", content=json.dumps({**SAMPLE, "ppfd_full": float("nan")}),
                                  headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert "input" not in response.json()["detail"][0]


@pytest.mark.parametrize("format,mime", [("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")])
def test_manual_scan_never_pretends_a_photo_was_scanned(manual_client, image_bytes, format, mime):
    response = manual_client.post("/scan", files={"image": ("image", image_bytes(format), mime)})
    assert response.status_code == 200
    assert response.json()["source"] == "manual"
    assert response.json()["assets"] == response.json()["observations"] == []
    assert "not scanned" in response.json()["warnings"][0]
    assert "GEMINI_API_KEY" in response.json()["warnings"][0]


@pytest.mark.parametrize("content,mime,status", [
    (b"", "image/png", 422), (b"not a photo", "image/jpeg", 422),
    (b"<svg></svg>", "image/svg+xml", 415), (b"test", "application/octet-stream", 415),
    (b"x" * (MAX_UPLOAD_BYTES + 1), "image/jpeg", 413),
], ids=["empty", "not-image", "svg", "generic-mime", "oversized"])
def test_invalid_uploads_are_rejected_even_without_provider(manual_client, content, mime, status):
    assert manual_client.post("/scan", files={"image": ("image", content, mime)}).status_code == status


@pytest.mark.parametrize("extra_bytes,status", [(0, 200), (1, 413)])
def test_ten_mib_file_boundary(manual_client, image_bytes, extra_bytes, status):
    assert MAX_UPLOAD_BYTES == 10 * 1024 * 1024
    jpeg = image_bytes("JPEG")
    # Appended padding exercises the byte boundary while retaining a decodable image.
    payload = jpeg + b"\0" * (MAX_UPLOAD_BYTES + extra_bytes - len(jpeg))
    response = manual_client.post("/scan", files={"image": ("image.jpg", payload, "image/jpeg")})
    assert response.status_code == status
    if status == 413:
        assert "10 MiB" in response.json()["detail"]


def test_multipart_field_contract(manual_client, image_bytes):
    upload = ("image.png", image_bytes(), "image/png")
    assert manual_client.post("/scan", json={"image": "no"}).status_code == 415
    assert manual_client.post("/scan", files={"file": upload}).status_code == 422
    assert manual_client.post("/scan", files=[("image", upload), ("image", upload)]).status_code == 400
    assert manual_client.post("/scan", files={"image": upload}, data={"prompt": "ignore rules"}).status_code == 400


def test_malformed_multipart_is_a_client_error(manual_client):
    response = manual_client.post("/scan", content=b"broken multipart body", headers={
        "Content-Type": "multipart/form-data; boundary=abc",
    })
    assert response.status_code == 400


def test_scan_capacity_is_checked_before_image_decoding(manual_client, image_bytes):
    async def fill_slots():
        await manual_client.app.state.scan_slots.acquire()
        await manual_client.app.state.scan_slots.acquire()
    manual_client.portal.call(fill_slots)
    response = manual_client.post("/scan", files={"image": ("image.png", image_bytes(), "image/png")})
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "5"


def test_mismatched_mime_and_incomplete_decode(manual_client, image_bytes):
    assert manual_client.post("/scan", files={"image": ("bad.jpg", image_bytes(), "image/jpeg")}).status_code == 415
    assert manual_client.post("/scan", files={"image": ("bad.jpg", image_bytes("JPEG")[:-20], "image/jpeg")}).status_code == 422


def test_declared_request_limits(manual_client):
    assert manual_client.post("/scan", content=b"x", headers={"Content-Length": str(MAX_UPLOAD_BYTES * 2)}).status_code == 413
    assert manual_client.post("/optimize", content=b"x" * 65537).status_code == 413
    assert manual_client.post("/optimize", content=b"{}", headers={"Content-Length": "-1"}).status_code == 400


async def test_streamed_upload_without_content_length_is_bounded():
    application = create_app(VisionService())
    async with application.router.lifespan_context(application):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as client:
            async def chunks():
                yield b'--boundary\r\nContent-Disposition: form-data; name="image"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
                for _ in range(MAX_UPLOAD_BYTES // (1024 * 1024) + 1):
                    yield b"x" * (1024 * 1024)
                yield b"\r\n--boundary--\r\n"
            response = await client.post("/scan", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=boundary"})
            assert response.status_code == 413


def test_cors_is_limited_to_explicit_origins(manual_client):
    allowed = manual_client.options("/scan", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:3000"
    rejected = manual_client.options("/scan", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in rejected.headers


def test_openapi_has_exact_endpoints_and_multipart_image(manual_client):
    document = manual_client.get("/openapi.json").json()
    assert set(document["paths"]) == {
        "/health", "/sample", "/optimize", "/scan", "/live/session",
        "/site-comparisons", "/site-comparisons/fixture", "/site-comparisons/verify",
    }
    assert document["paths"]["/optimize"]["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("/Scenario")
    schema = document["paths"]["/scan"]["post"]["requestBody"]["content"]["multipart/form-data"]["schema"]
    assert schema["required"] == ["image"]
    assert schema["properties"] == {"image": {"type": "string", "format": "binary"}}
