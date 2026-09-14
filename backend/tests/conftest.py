import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi.testclient import TestClient
from google.genai import types
from PIL import Image

from backend.main import create_app
from backend.vision import VisionService


@pytest.fixture
def image_bytes():
    def make(format="PNG", size=(16, 16)):
        buffer = io.BytesIO()
        Image.new("RGB", size, "green").save(buffer, format=format)
        return buffer.getvalue()
    return make


@pytest.fixture
def manual_client():
    with TestClient(create_app(VisionService())) as client:
        yield client


@pytest.fixture
def provider_response():
    def response(payload=None, finish=types.FinishReason.STOP):
        if payload is None:
            payload = {"assets": [{"type": "light_fixture", "quantity": 2, "confidence": 0.8}],
                       "observations": ["overhead_lights"], "warnings": ["occluded"]}
        text = payload if isinstance(payload, str) else json.dumps(payload)
        return types.GenerateContentResponse(candidates=[types.Candidate(
            content=types.Content(parts=[types.Part(text=text)]), finish_reason=finish,
        )])
    return response


@pytest.fixture
def configured_service(provider_response):
    generate = AsyncMock(return_value=provider_response())
    client = SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate),
                                                aclose=AsyncMock()), close=Mock())
    return VisionService(provider="gemini", client=client)
