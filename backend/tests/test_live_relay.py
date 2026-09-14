"""Fake-SDK and ASGI transport verification. Never calls a live provider."""

import asyncio
import base64
import io
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.genai import errors, live as sdk_live, types
from PIL import Image
from starlette.websockets import WebSocket

from backend import live
from backend.live_tools import LiveTools
from backend.tests.test_live_tools import draft_context, proposal, workspace

ORIGIN = "http://localhost:3000"


class FakeSession:
    def __init__(self):
        self.events = asyncio.Queue()
        self.sent = []
        self.responses = []
        self.closed = False

    async def send_realtime_input(self, **kwargs):
        self.sent.append(kwargs)

    async def send_tool_response(self, **kwargs):
        self.responses.append(kwargs)

    async def receive(self):
        while True:
            event = await self.events.get()
            if isinstance(event, Exception):
                raise event
            if event is None:
                return
            yield event
            if event.server_content and event.server_content.turn_complete:
                return


class FakeClient:
    def __init__(self, failure=None, session_factory=FakeSession):
        self.failure = failure
        self.session_factory = session_factory
        self.sessions = []
        self.configs = []
        self.aio = SimpleNamespace(live=SimpleNamespace(connect=self.connect), aclose=AsyncMock())
        self.close = Mock()

    @asynccontextmanager
    async def connect(self, *, model, config):
        if self.failure:
            raise self.failure
        self.configs.append((model, config))
        session = self.session_factory()
        self.sessions.append(session)
        try:
            yield session
        finally:
            session.closed = True


class MemoryProviderSocket:
    """Exercise the installed SDK's wire conversion without opening a connection."""

    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []

    async def recv(self, decode=False):
        return json.dumps(await self.incoming.get()).encode()

    async def send(self, value):
        self.sent.append(json.loads(value))


class SDKSession(sdk_live.AsyncSession):
    def __init__(self):
        self.wire = MemoryProviderSocket()
        super().__init__(SimpleNamespace(vertexai=False), self.wire)
        self.closed = False
        self.receive_count = 0

    @property
    def sent(self):
        return self.wire.sent

    @property
    def responses(self):
        return [message["tool_response"]["functionResponses"] for message in self.sent if "tool_response" in message]

    async def receive(self):
        self.receive_count += 1
        async for event in super().receive():
            yield event


class SocketHarness:
    def __init__(self, manager, origin=ORIGIN, query=b"", host="127.0.0.1"):
        self.manager = manager
        self.incoming, self.outgoing = asyncio.Queue(), asyncio.Queue()
        self.scope = {"type": "websocket", "path": "/live/ws", "query_string": query,
                      "headers": [(b"origin", origin.encode())] if origin else [],
                      "client": (host, 50000), "server": ("127.0.0.1", 8000), "scheme": "ws"}
        self.socket = WebSocket(self.scope, self.incoming.get, self.outgoing.put)
        self.task = None

    async def start(self):
        await self.incoming.put({"type": "websocket.connect"})
        self.task = asyncio.create_task(self.manager.websocket(self.socket))
        return await self.raw_event()

    async def send(self, value):
        await self.incoming.put({"type": "websocket.receive", "text": json.dumps(value)})

    async def raw_event(self):
        return await asyncio.wait_for(self.outgoing.get(), 2)

    async def event(self):
        message = await self.raw_event()
        assert message["type"] == "websocket.send", message
        return json.loads(message["text"])

    async def connect(self, ticket=None):
        self.ticket = ticket or self.manager.issue_session(ORIGIN)
        assert (await self.start())["type"] == "websocket.accept"
        await self.send({"type": "auth", "token": self.ticket["token"]})
        ready = await self.event()
        assert ready["type"] == "ready", ready
        await self.send({"type": "context", "context": workspace()})
        await eventually(lambda: self.manager.client.sessions[-1].sent)
        return self.manager.client.sessions[-1]

    async def finish(self, disconnect=False):
        if disconnect:
            await self.incoming.put({"type": "websocket.disconnect", "code": 1000})
        else:
            await self.send({"type": "end"})
        await asyncio.wait_for(self.task, 2)


async def eventually(condition):
    async with asyncio.timeout(2):
        while not condition():
            await asyncio.sleep(0.001)


def app_for(manager):
    app = FastAPI()
    app.state.live = manager
    live.install_live_routes(app)
    return app


@pytest.mark.asyncio
async def test_relay_all_event_parts_and_multiple_turns():
    client = FakeClient()
    manager = live.LiveManager(client=client)
    await manager.start()
    harness = SocketHarness(manager)
    session = await harness.connect()
    assert set(session.sent[0]) == {"text"}
    config = client.configs[0][1]
    assert config.response_modalities == [types.Modality.AUDIO]
    assert config.input_audio_transcription is not None and config.output_audio_transcription is not None
    assert config.context_window_compression.sliding_window is not None
    assert config.session_resumption is not None
    assert all(d.behavior is None for d in config.tools[0].function_declarations)
    event = types.LiveServerMessage(
        server_content=types.LiveServerContent(
            input_transcription=types.Transcription(text="The combined load is 300 watts"),
            output_transcription=types.Transcription(text="Please review."),
            model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=b"\0\0", mime_type="audio/pcm;rate=24000")),
                                           types.Part(text="Additional text"),
                                           types.Part(inline_data=types.Blob(data=b"\1\0", mime_type="audio/pcm;rate=24000"))]),
            turn_complete=True,
        ),
        usage_metadata=types.UsageMetadata(prompt_token_count=12, response_token_count=4, total_token_count=16),
        session_resumption_update=types.LiveServerSessionResumptionUpdate(resumable=True, new_handle="private-provider-handle"),
        tool_call=types.LiveServerToolCall(function_calls=[types.FunctionCall(id="draft", name="propose_update", args=proposal())]),
    )
    await session.events.put(event)
    emitted = [await harness.event() for _ in range(8)]
    assert sum(e["type"] == "audio" for e in emitted) == 2
    assert sum(e["type"] == "transcript" for e in emitted) == 3
    assert {e["type"] for e in emitted} == {"audio", "transcript", "usage", "turn_complete", "draft"}
    assert "private-provider-handle" not in json.dumps(emitted)
    assert not session.responses
    draft = next(e for e in emitted if e["type"] == "draft")
    await harness.send({"type": "action_ack", "action_id": draft["action_id"], "status": "applied", "message": "Rendered",
                        "context": draft_context(workspace(), draft["draft"])})
    await eventually(lambda: session.responses)
    assert session.responses[0]["function_responses"][0].response["status"] == "pending_review"
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(turn_complete=True)))
    assert (await harness.event())["type"] == "turn_complete"
    await harness.finish()
    assert session.closed and not manager._records and not manager._connections
    await manager.close()
    client.aio.aclose.assert_awaited_once()
    client.close.assert_called_once()
    assert manager._sweeper is None


@pytest.mark.asyncio
async def test_audio_video_and_context_use_realtime_input():
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    audio = base64.b64encode(b"\0" * 3200).decode()
    await harness.send({"type": "audio", "data": audio})
    await harness.send({"type": "audio_end"})
    data = io.BytesIO()
    Image.new("RGB", (32, 32), "green").save(data, format="JPEG")
    await harness.send({"type": "video", "data": base64.b64encode(data.getvalue()).decode()})
    next_context = workspace()
    next_context["revision"] = 2
    await harness.send({"type": "context", "context": next_context})
    await eventually(lambda: len(session.sent) == 5)
    assert session.sent[1]["audio"].mime_type == "audio/pcm;rate=16000"
    assert session.sent[1]["audio"].data == b"\0" * 3200
    assert session.sent[2] == {"audio_stream_end": True}
    assert session.sent[3]["video"].mime_type == "image/jpeg"
    assert set(session.sent[4]) == {"text"}
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_same_event_cancel_precedes_calls_and_interruption_precedes_other_output():
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    await session.events.put(types.LiveServerMessage(
        tool_call_cancellation=types.LiveServerToolCallCancellation(ids=["view"]),
        tool_call=types.LiveServerToolCall(function_calls=[types.FunctionCall(id="view", name="set_twin_view", args={"camera": "top"})]),
        server_content=types.LiveServerContent(interrupted=True, input_transcription=types.Transcription(text="Stop"),
            model_turn=types.Content(parts=[types.Part(inline_data=types.Blob(data=b"\0\0", mime_type="audio/pcm;rate=24000"))])),
    ))
    assert await harness.event() == {"type": "interrupted"}
    assert (await harness.event())["type"] == "transcript"
    await asyncio.sleep(0.01)
    assert not session.responses
    assert harness.outgoing.empty()
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_cancellation_cancels_unapplied_draft_without_replaying_action():
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    call = types.FunctionCall(id="one", name="propose_update", args=proposal())
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        input_transcription=types.Transcription(text="The combined load is 300 watts")),
        tool_call=types.LiveServerToolCall(function_calls=[call])))
    assert (await harness.event())["type"] == "transcript"
    draft = await harness.event()
    assert not session.responses
    await session.events.put(types.LiveServerMessage(tool_call_cancellation=types.LiveServerToolCallCancellation(ids=["one"]),
                                                     tool_call=types.LiveServerToolCall(function_calls=[call])))
    assert await harness.event() == {"type": "draft_cancelled", "id": draft["draft"]["id"]}
    await asyncio.sleep(0.01)
    assert not session.responses
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_origin_permissions_and_bootstrap_no_cors_bypass():
    manager = live.LiveManager(client=FakeClient())
    app = app_for(manager)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 50000)), base_url="http://localhost") as client:
        for header in ("https://evil.example", "http://127.0.0.1:3000", "null"):
            assert (await client.post("/live/session", json={"origin": ORIGIN}, headers={"Origin": header})).status_code == 403
        for claimed in ("https://evil.example", "http://localhost.evil.example", "file://localhost", ORIGIN + "/", "http://localhost:0"):
            assert (await client.post("/live/session", json={"origin": claimed})).status_code == 403
        response = await client.post("/live/session", json={"origin": ORIGIN}, headers={"Origin": ORIGIN})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert set(response.json()) == {"token", "resume_token", "websocket_path", "model", "max_duration_seconds", "frame_interval_ms"}
        assert response.json()["websocket_path"] == "/live/ws"
        assert (await client.post("/live/session", json={"origin": ORIGIN, "extra": True})).status_code == 422
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("192.168.0.2", 50000)), base_url="http://localhost") as client:
        assert (await client.post("/live/session", json={"origin": ORIGIN})).status_code == 403
    for origin, query, host in (("https://evil.example", b"", "127.0.0.1"), (None, b"", "127.0.0.1"),
                                (ORIGIN, b"token=forbidden", "127.0.0.1"), (ORIGIN, b"", "192.168.0.2")):
        harness = SocketHarness(manager, origin, query, host)
        assert (await harness.start())["type"] == "websocket.close"
        await harness.task
    await manager.close()


def test_fastapi_installed_websocket_route_works():
    manager = live.LiveManager(client=FakeClient())
    app = FastAPI()
    live.install_live_routes(app, lambda: manager)
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        bootstrap = client.post("/live/session", json={"origin": ORIGIN}).json()
        with client.websocket_connect("/live/ws", headers={"Origin": ORIGIN}) as socket:
            socket.send_json({"type": "auth", "token": bootstrap["token"]})
            assert socket.receive_json()["type"] == "ready"
            socket.send_json({"type": "context", "context": workspace()})
            socket.send_json({"type": "end"})
            assert socket.receive_json() == {"type": "ended", "reason": "user_ended"}
    assert not manager._records and not manager._connections


@pytest.mark.asyncio
async def test_one_use_ticket_origin_binding_expiry_and_two_session_limit():
    now = [100.0]
    manager = live.LiveManager(client=FakeClient(), clock=lambda: now[0])
    ticket = manager.issue_session(ORIGIN)
    other = manager.issue_session(ORIGIN)
    with pytest.raises(live.LiveValidationError, match="two"):
        manager.issue_session(ORIGIN)
    with pytest.raises(live.LiveValidationError):
        manager._authenticate(other["token"], "http://127.0.0.1:3000")
    manager._authenticate(ticket["token"], ORIGIN)
    with pytest.raises(live.LiveValidationError):
        manager._authenticate(ticket["token"], ORIGIN)
    now[0] += 31
    with pytest.raises(live.LiveValidationError):
        manager._authenticate(other["token"], ORIGIN)
    await manager.close()


@pytest.mark.asyncio
async def test_disconnect_resumption_handle_private_total_duration_fixed_and_end_forgets():
    now = [100.0]
    manager = live.LiveManager(client=FakeClient(), clock=lambda: now[0])
    harness = SocketHarness(manager)
    session = await harness.connect()
    await session.events.put(types.LiveServerMessage(session_resumption_update=types.LiveServerSessionResumptionUpdate(
        resumable=True, new_handle="opaque-provider-private")))
    record = manager._records[harness.ticket["resume_token"]]
    await eventually(lambda: record.handle)
    await harness.finish(disconnect=True)
    assert session.closed and record.handle == "opaque-provider-private"
    assert record.expires == 160
    now[0] += 20
    resumed = manager.issue_session(ORIGIN, harness.ticket["resume_token"])
    assert "opaque-provider-private" not in json.dumps(resumed)
    next_harness = SocketHarness(manager)
    await next_harness.connect(resumed)
    assert manager.client.configs[-1][1].session_resumption.handle == "opaque-provider-private"
    assert record.deadline == 400
    await next_harness.finish()
    assert not manager._records and record.handle is None and record.tools.context is None
    with pytest.raises(live.LiveValidationError):
        manager.issue_session(ORIGIN, resumed["resume_token"])
    await manager.close()


@pytest.mark.asyncio
async def test_resumption_expiry_sweeper_clears_private_state():
    now = [100.0]
    manager = live.LiveManager(client=FakeClient(), clock=lambda: now[0])
    ticket = manager.issue_session(ORIGIN)
    record = manager._records[ticket["resume_token"]]
    record.handle = "secret"
    record.tools.set_context(workspace())
    now[0] += 31
    manager._prune()
    assert not manager._records and not manager._tickets
    assert record.handle is None and record.tools.context is None
    await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,code", [("auth", "auth_timeout"), ("context", "context_timeout"), ("duration", "duration_limit")])
async def test_bounded_timeouts_and_complete_cleanup(monkeypatch, kind, code):
    monkeypatch.setattr(live, "AUTH_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(live, "CONTEXT_TIMEOUT_SECONDS", 0.02)
    if kind == "duration":
        monkeypatch.setattr(live, "MAX_DURATION_SECONDS", 0.04)
    manager = live.LiveManager(client=FakeClient())
    ticket = manager.issue_session(ORIGIN)
    harness = SocketHarness(manager)
    await harness.start()
    if kind != "auth":
        await harness.send({"type": "auth", "token": ticket["token"]})
        assert (await harness.event())["type"] == "ready"
    if kind == "duration":
        await harness.send({"type": "context", "context": workspace()})
        assert await harness.event() == {"type": "ended", "reason": code}
    else:
        assert (await harness.event())["code"] == code
        assert (await harness.event())["reason"] == code
    await asyncio.wait_for(harness.task, 1)
    assert not manager._connections
    assert all(s.closed for s in manager.client.sessions)
    await manager.close()
    assert not manager._records and not manager._tickets


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(401, "live_access"), (403, "live_access"), (404, "live_model"), (429, "live_quota"), (503, "live_unavailable")])
async def test_provider_errors_sanitized(status, code, caplog):
    failure = errors.APIError(status, {"error": {"code": status, "message": "private-canary-value"}})
    manager = live.LiveManager(client=FakeClient(failure=failure))
    ticket = manager.issue_session(ORIGIN)
    harness = SocketHarness(manager)
    await harness.start()
    await harness.send({"type": "auth", "token": ticket["token"]})
    result = await harness.event()
    assert result["code"] == code
    assert "private-canary-value" not in json.dumps(result) + caplog.text
    await harness.task
    assert not manager._records
    await manager.close()


@pytest.mark.asyncio
async def test_environment_key_precedence_developer_api_and_configuration_isolation(monkeypatch):
    monkeypatch.setattr(live.os, "environ", {})
    factory = Mock()
    monkeypatch.setattr(live.genai, "Client", factory)
    manager = live.LiveManager.from_environment()
    await manager.start()
    assert manager.configuration_error[0] == "live_not_configured"
    factory.assert_not_called()
    monkeypatch.setattr(live.os, "environ", {"GEMINI_API_KEY": "fake-priority", "GOOGLE_API_KEY": "fake-secondary", "GOOGLE_GENAI_USE_VERTEXAI": "false"})
    factory.return_value = FakeClient()
    manager = live.LiveManager.from_environment()
    await manager.start()
    assert factory.call_args.kwargs["api_key"] == "fake-priority"
    assert factory.call_args.kwargs["vertexai"] is False
    assert manager.model == live.DEFAULT_LIVE_MODEL
    assert "fake-priority" not in repr(manager)
    await manager.close()
    for extra, code in (({"GEMINI_LIVE_MODEL": ""}, "live_model"), ({"GEMINI_LIVE_MODEL": "gemini-2.5-flash"}, "live_model"),
                        ({"GOOGLE_GENAI_USE_VERTEXAI": "true"}, "live_configuration")):
        monkeypatch.setattr(live.os, "environ", {"GOOGLE_API_KEY": "fake", **extra})
        manager = live.LiveManager.from_environment()
        await manager.start()
        assert manager.configuration_error[0] == code


@pytest.mark.asyncio
@pytest.mark.parametrize("message,code", [
    ({"type": "unknown"}, "invalid_message"), ({"type": "end", "extra": True}, "invalid_message"),
    ({"type": "audio", "data": "bad!"}, "invalid_media"),
    ({"type": "audio", "data": "AAAA"}, "invalid_media"),
    ({"type": "video", "data": "AAAA"}, "invalid_media"),
    ({"type": "video", "data": "a" * 280001}, "message_too_large"),
])
async def test_unknown_or_invalid_media_rejected_without_provider_forwarding(message, code):
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    await harness.send(message)
    assert (await harness.event())["code"] == code
    await harness.task
    assert len(session.sent) == 1 and session.closed
    await manager.close()


@pytest.mark.asyncio
async def test_manager_close_cancels_active_sessions_and_workers():
    manager = live.LiveManager(client=FakeClient())
    await manager.start()
    harness = SocketHarness(manager)
    session = await harness.connect()
    await manager.close()
    assert harness.task.done() and session.closed
    assert not manager._records and not manager._tickets and not manager._connections
    assert not any(t.get_name().startswith("acreiq-live-") for t in asyncio.all_tasks() if not t.done())


def test_json_and_frame_decode_bounds():
    for raw in ('{"type":"end","type":"end"}', '{"value":NaN}', '[' * 2000, '[]'):
        with pytest.raises(live.LiveValidationError):
            live.strict_json(raw, live.MAX_MESSAGE_BYTES)
    data = io.BytesIO()
    Image.new("RGB", (2000, 1)).save(data, format="JPEG")
    with pytest.raises(live.LiveValidationError):
        live.validate_frame(base64.b64encode(data.getvalue()).decode())


@pytest.mark.asyncio
@pytest.mark.parametrize("name,arguments", [
    ("set_twin_view", {"camera": "top"}),
    ("propose_update", proposal()),
    ("manage_proposal", {"action": "approve", "proposal_id": "old", "version": 1}),
    ("run_lighting_comparison", {}),
])
async def test_queued_tool_from_old_inputs_returns_correlated_stale_error_without_mutation(monkeypatch, name, arguments):
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    relay = live.LiveRelay(manager, harness.socket)
    relay.record = live.SessionRecord(ORIGIN, 300, 30)
    relay.record.tools.set_context(workspace())
    relay.session = SDKSession()
    dispatch = AsyncMock(wraps=relay.record.tools.dispatch)
    monkeypatch.setattr(relay.record.tools, "dispatch", dispatch)
    call = types.FunctionCall(id="old-action", name=name, args=arguments)
    relay.tool_queue.put_nowait((call, relay.record.tools.generation))
    changed = workspace(lighting_watts=300)
    changed["revision"] = 2
    relay.record.tools.set_context(changed)
    before = relay.record.tools.context.model_dump()
    task = asyncio.create_task(relay.tool_loop())
    try:
        await asyncio.wait_for(relay.tool_queue.join(), 1)
        dispatch.assert_not_awaited()
        assert len(relay.session.responses) == 1
        response = relay.session.responses[0][0]
        assert response["id"] == "old-action" and response["name"] == name
        assert response["response"]["status"] == "error" and response["response"]["code"] == "stale_context"
        assert "old-action" not in relay.record.tools.cancelled
        assert relay.record.tools.context.model_dump() == before
        assert not relay.record.tools.pending and not relay.record.tools.actions
        assert harness.outgoing.empty()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read", ["workspace", "current_selection", "explicit_old_id", "explicit_old_revision"])
async def test_queued_read_after_context_change_uses_current_selection_or_reports_stale(monkeypatch, read):
    from backend import core, live_tools, run_evidence

    saved = run_evidence.execute_run(core.Scenario.model_validate(workspace(lighting_watts=300)["scenario"]))
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    await harness.incoming.put({"type": "websocket.connect"})
    await harness.socket.accept()
    await harness.raw_event()
    relay = live.LiveRelay(manager, harness.socket)
    relay.record = live.SessionRecord(ORIGIN, 300, 30)
    relay.record.tools.set_context(workspace())
    relay.session = SDKSession()
    name = "get_workspace_state" if read == "workspace" else "get_scenario_result"
    arguments = {"run_id": "old-selected-run"} if read == "explicit_old_id" else (
        {"workspace_revision": 1} if read == "explicit_old_revision" else {})
    call = types.FunctionCall(id="queued-read", name=name, args=arguments)
    relay.tool_queue.put_nowait((call, relay.record.tools.generation))
    changed = workspace(lighting_watts=300, confirmed=False)
    changed.update({"revision": 2, "has_result": True, "selected_run": {
        "id": saved["run"]["id"], "workspace_revision": 2, "accepted_revision": 0,
        "proposal_id": None, "proposal_version": None}})
    relay.record.tools.set_context(changed)
    before = relay.record.tools.context.model_dump()
    execute = Mock(side_effect=AssertionError("A queued read must not calculate"))
    monkeypatch.setattr(live_tools, "execute_run", execute)
    task = asyncio.create_task(relay.tool_loop())
    try:
        await asyncio.wait_for(relay.tool_queue.join(), 1)
        assert len(relay.session.responses) == 1
        envelope = relay.session.responses[0][0]
        assert envelope["id"] == "queued-read" and envelope["name"] == name
        response = envelope["response"]
        if read == "workspace":
            assert response["status"] == "ok" and response["context"] == before
        else:
            explanation = await harness.event()
            assert explanation["type"] == "explanation_status"
            assert explanation["run_id"] == saved["run"]["id"]
            if read == "current_selection":
                assert response["status"] == "ok" and response["run"] == saved["run"]
            else:
                assert response["status"] == "error" and response["code"] == "stale_run"
        assert "queued-read" not in relay.record.tools.cancelled
        assert relay.record.tools.context.model_dump() == before
        assert not relay.record.tools.pending and not relay.record.tools.actions
        assert harness.outgoing.empty()
        execute.assert_not_called()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_connect_timeout_is_sanitized_and_releases_reservation(monkeypatch):
    monkeypatch.setattr(live, "CONNECT_TIMEOUT_SECONDS", 0.02)
    client = FakeClient()

    @asynccontextmanager
    async def stalled_connect(**_):
        await asyncio.Event().wait()
        yield

    client.aio.live.connect = stalled_connect
    manager = live.LiveManager(client=client)
    harness = SocketHarness(manager)
    ticket = manager.issue_session(ORIGIN)
    await harness.start()
    await harness.send({"type": "auth", "token": ticket["token"]})
    assert (await harness.event())["code"] == "live_timeout"
    await harness.task
    assert not manager._records and not manager._connections
    await manager.close()


@pytest.mark.asyncio
async def test_video_rate_is_enforced_and_media_is_not_replayed():
    manager = live.LiveManager(client=FakeClient(), clock=lambda: 100.0)
    harness = SocketHarness(manager)
    session = await harness.connect()
    data = io.BytesIO()
    Image.new("RGB", (16, 16)).save(data, format="JPEG")
    message = {"type": "video", "data": base64.b64encode(data.getvalue()).decode()}
    await harness.send(message)
    await eventually(lambda: len(session.sent) == 2)
    await harness.send(message)
    assert (await harness.event())["code"] == "frame_rate"
    await harness.task
    assert len(session.sent) == 2 and session.closed
    await manager.close()


@pytest.mark.asyncio
async def test_duration_timeout_uses_expired_state_when_clock_reads_before_deadline(monkeypatch):
    # Allow the real event loop to finish the fake handshake under Windows scheduling.
    # The fixed clock still stays before the deadline, exercising expired() rather than time comparison.
    monkeypatch.setattr(live, "MAX_DURATION_SECONDS", 0.25)
    manager = live.LiveManager(client=FakeClient(), clock=lambda: 100.0)
    harness = SocketHarness(manager)
    session = await harness.connect()
    assert await harness.event() == {"type": "ended", "reason": "duration_limit"}
    await harness.task
    assert session.closed and not manager._records and not manager._connections
    await manager.close()


@pytest.mark.asyncio
async def test_provider_success_waits_for_valid_ui_receipt_context_may_arrive_first():
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        input_transcription=types.Transcription(text="The combined load is 300 watts", finished=True)),
        tool_call=types.LiveServerToolCall(function_calls=[types.FunctionCall(id="draft", name="propose_update", args=proposal())])))
    assert (await harness.event())["type"] == "transcript"
    event = await harness.event()
    assert event["type"] == "draft" and not session.responses
    proposed = draft_context(workspace(), event["draft"])
    await harness.send({"type": "context", "context": proposed})
    await eventually(lambda: len(session.sent) == 2)
    assert not session.responses
    await harness.send({"type": "action_ack", "action_id": event["action_id"], "status": "applied", "message": "Rendered", "context": proposed})
    await eventually(lambda: session.responses)
    response = session.responses[0]["function_responses"][0].response
    assert response["status"] == "pending_review" and response["acknowledged"]
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(interrupted=True)))
    assert (await harness.event())["type"] == "interrupted"
    assert not manager._records[harness.ticket["resume_token"]].tools.pending
    assert manager._records[harness.ticket["resume_token"]].tools.context.proposal is not None
    await harness.finish()
    remaining = []
    while not harness.outgoing.empty():
        remaining.append(await harness.raw_event())
    assert "draft_cancelled" not in str(remaining)
    await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "rejected", "stale"])
async def test_failed_ack_is_reported_to_model_without_success(monkeypatch, failure):
    from backend import live_tools
    monkeypatch.setattr(live_tools, "ACTION_ACK_SECONDS", 0.05 if failure == "timeout" else 1)
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    await session.events.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
        types.FunctionCall(id="view", name="set_twin_view", args={"camera": "top"})])))
    event = await harness.event()
    assert event["type"] == "view" and not session.responses
    if failure != "timeout":
        context = workspace()
        if failure == "stale":
            context["revision"] = 2
            context["scenario"]["lighting_watts"] = 400
        await harness.send({"type": "action_ack", "action_id": event["action_id"],
                            "status": "rejected" if failure == "rejected" else "applied",
                            "message": "private-canary-success-instruction", "context": context})
    await eventually(lambda: session.responses)
    response = session.responses[0]["function_responses"][0].response
    assert response["status"] == "error" and not response.get("acknowledged")
    assert "private-canary" not in str(response)
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_delayed_input_evidence_is_collected_while_tool_is_waiting():
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    args = {"reason": "Dimension preview", "inputs": [
        {"field": "length_ft", "value": 20, "unit": "ft"}, {"field": "width_ft", "value": 10, "unit": "ft"}]}
    await session.events.put(types.LiveServerMessage(tool_call=types.LiveServerToolCall(function_calls=[
        types.FunctionCall(id="delayed", name="propose_update", args=args)])))
    await asyncio.sleep(0.01)
    assert not session.responses and harness.outgoing.empty()
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        input_transcription=types.Transcription(text="Make the room twenty by ten feet", finished=True))))
    assert (await harness.event())["type"] == "transcript"
    event = await harness.event()
    assert event["type"] == "draft" and not session.responses
    await harness.send({"type": "action_ack", "action_id": event["action_id"], "status": "applied",
                        "message": "Rendered", "context": draft_context(workspace(), event["draft"])})
    await eventually(lambda: session.responses)
    assert session.responses[0]["function_responses"][0].response["acknowledged"]
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_assistant_transcript_cannot_supply_numeric_evidence(monkeypatch):
    from backend import live_tools
    monkeypatch.setattr(live_tools, "EVIDENCE_WAIT_SECONDS", 0.02)
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        output_transcription=types.Transcription(text="The combined load is 300 watts", finished=True)),
        tool_call=types.LiveServerToolCall(function_calls=[types.FunctionCall(id="invented", name="propose_update", args=proposal())])))
    assert (await harness.event())["role"] == "assistant"
    await eventually(lambda: session.responses)
    assert session.responses[0]["function_responses"][0].response["code"] == "evidence_pending"
    assert not manager._records[harness.ticket["resume_token"]].tools.user_turns
    assert harness.outgoing.empty()
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
async def test_relay_single_assistant_question_then_actual_user_yes_can_adopt():
    from backend.tests.test_live_design import action_context
    manager = live.LiveManager(client=FakeClient())
    harness = SocketHarness(manager)
    session = await harness.connect()
    tools = manager._records[harness.ticket["resume_token"]].tools
    tools.observe_user_transcript("The combined load is 300 watts")
    _, events = await tools.dispatch("draft", "propose_update", proposal())
    proposed = draft_context(workspace(), events[0]["draft"])
    tools.acknowledge(events[0]["action_id"], "applied", "Rendered", proposed)
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        output_transcription=types.Transcription(text="Use this version?", finished=True), turn_complete=True)))
    assert (await harness.event())["role"] == "assistant"
    assert (await harness.event())["type"] == "turn_complete"
    await session.events.put(types.LiveServerMessage(server_content=types.LiveServerContent(
        input_transcription=types.Transcription(text="Yes", finished=True)),
        tool_call=types.LiveServerToolCall(function_calls=[types.FunctionCall(id="yes", name="manage_proposal", args={
            "action": "approve", "proposal_id": proposed["proposal"]["id"], "version": proposed["proposal"]["version"]})])))
    assert (await harness.event())["role"] == "user"
    event = await harness.event()
    assert event["type"] == "proposal_action" and not session.responses
    await harness.send({"type": "action_ack", "action_id": event["action_id"], "status": "applied", "message": "Adopted",
                        "context": action_context(proposed, "approve")})
    await eventually(lambda: session.responses)
    assert session.responses[0]["function_responses"][0].response["acknowledged"]
    await harness.finish()
    await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("completion", [{"turnComplete": True}, {"interactionStatus": "IDLE"}])
@pytest.mark.parametrize("changed_inputs", [False, True])
async def test_sdk_read_response_is_correlated_and_audio_continues_across_receive_completion(monkeypatch, completion, changed_inputs):
    from backend import core, live_tools, run_evidence

    saved = run_evidence.execute_run(core.Scenario.model_validate(workspace()["scenario"]))
    execute = Mock(side_effect=AssertionError("Reading must not run a calculation"))
    solve = Mock(side_effect=AssertionError("Reading must not invoke the solver"))
    monkeypatch.setattr(live_tools, "execute_run", execute)
    monkeypatch.setattr(core, "solve", solve)
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    tools = manager._records[harness.ticket["resume_token"]].tools
    dispatch = AsyncMock(wraps=tools.dispatch)
    monkeypatch.setattr(tools, "dispatch", dispatch)
    changed = workspace(confirmed=False, **({"lighting_watts": 400, "ppfd_full": None} if changed_inputs else {}))
    changed["revision"] = 2 if changed_inputs else 1
    changed["has_result"] = True
    changed["selected_run"] = {"id": saved["run"]["id"], "workspace_revision": 1, "accepted_revision": 0,
                               "proposal_id": None, "proposal_version": None}
    await harness.send({"type": "context", "context": changed})
    await eventually(lambda: len(session.sent) == 2)
    before = tools.context.model_dump()
    try:
        for index in range(2):
            call_id = f"read-{index}"
            arguments = {"run_id": saved["run"]["id"], "workspace_revision": 1} if index == 0 else {}
            call = {"id": call_id, "name": "get_scenario_result"}
            if index == 0:
                call["args"] = arguments
            await session.wire.incoming.put({"toolCall": {"functionCalls": [call]}})
            await eventually(lambda: len(session.responses) == index + 1)
            assert session.responses[index][0]["response"]["status"] == "ok"
            explanation = await harness.event()
            assert explanation["type"] == "explanation_status" and explanation["status"] == "ok"
            assert explanation["run_id"] == saved["run"]["id"] and "action_id" not in explanation
            await eventually(lambda: len(session.responses) == index + 1)
            assert len(session.responses[index]) == 1
            envelope = session.responses[index][0]
            assert envelope["id"] == call_id and envelope["name"] == "get_scenario_result"
            response = envelope["response"]
            assert response["status"] == "ok" and response["earlier_result"] is changed_inputs
            assert response["run"] == saved["run"]
            for key in ("baseline", "optimized", "savings", "source", "operating_days", "limitations"):
                assert response["result"][key] == saved[key]
            assert "action_id" not in response and "acknowledged" not in response
            assert harness.outgoing.empty()  # No draft, result application, or approval round trip.
            await session.wire.incoming.put({"serverContent": {
                "outputTranscription": {"text": f"Saved result {index}.", "finished": True},
                "modelTurn": {"parts": [{"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": "AAA="}}]}}})
            assert await harness.event() == {"type": "transcript", "role": "assistant", "text": f"Saved result {index}."}
            assert await harness.event() == {"type": "audio", "data": "AAA="}
            await session.wire.incoming.put({"serverContent": completion})
            if completion.get("turnComplete"):
                assert (await harness.event())["type"] == "turn_complete"
            await eventually(lambda: session.receive_count == index + 2)
        assert tools.context.model_dump() == before
        assert not tools.pending and not tools.actions
        execute.assert_not_called()
        solve.assert_not_called()
        assert run_evidence.get_run(saved["run"]["id"]) == saved
        assert [call.args for call in dispatch.await_args_list] == [
            ("read-0", "get_scenario_result", {"run_id": saved["run"]["id"], "workspace_revision": 1}),
            ("read-1", "get_scenario_result", {})]
        assert not harness.task.done()
    finally:
        await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("valid_receipt", [True, False])
async def test_sdk_calculation_requires_matching_run_receipt_before_success(valid_receipt):
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    try:
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "calculate", "name": "run_lighting_comparison", "args": {}}]}})
        result_event = await harness.event()
        assert result_event["type"] == "result" and not session.responses
        receipt = workspace()
        receipt["has_result"] = True
        receipt["selected_run"] = {"id": result_event["result"]["run"]["id"] if valid_receipt else "another-run",
                                   "workspace_revision": 1, "accepted_revision": 0,
                                   "proposal_id": None, "proposal_version": None}
        await harness.send({"type": "action_ack", "action_id": result_event["action_id"], "status": "applied",
                            "message": "Displayed", "context": receipt})
        await eventually(lambda: session.responses)
        envelope = session.responses[0][0]
        assert envelope["id"] == "calculate" and envelope["name"] == "run_lighting_comparison"
        if not valid_receipt:
            assert envelope["response"]["status"] == "error" and envelope["response"]["code"] == "invalid_receipt"
            assert not envelope["response"].get("acknowledged")
            return
        assert envelope["response"]["acknowledged"] and envelope["response"]["status"] == "ok"
        assert envelope["response"]["run"] == result_event["result"]["run"]
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "read-live-result", "name": "get_scenario_result", "args": {}}]}})
        assert (await harness.event())["type"] == "explanation_status"
        await eventually(lambda: len(session.responses) == 2)
        read = session.responses[1][0]
        assert read["id"] == "read-live-result" and read["name"] == "get_scenario_result"
        assert read["response"]["run"] == result_event["result"]["run"]
        assert "action_id" not in read["response"] and "acknowledged" not in read["response"]
        assert harness.outgoing.empty()
    finally:
        await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancellation", ["provider", "interruption", "end"])
async def test_cancelled_read_unblocks_following_tools_without_success(monkeypatch, cancellation):
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    tools = manager._records[harness.ticket["resume_token"]].tools
    started, cancelled = asyncio.Event(), asyncio.Event()
    original = tools.dispatch

    async def dispatch(call_id, name, arguments):
        if call_id != "waiting-read":
            return await original(call_id, name, arguments)
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(tools, "dispatch", dispatch)
    try:
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "waiting-read", "name": "get_scenario_result", "args": {}},
            {"id": "queued-read", "name": "get_workspace_state", "args": {}}]}})
        await asyncio.wait_for(started.wait(), 1)
        if cancellation == "end":
            await harness.finish()
        elif cancellation == "provider":
            await session.wire.incoming.put({"toolCallCancellation": {"ids": ["waiting-read", "queued-read"]}})
        else:
            await session.wire.incoming.put({"serverContent": {"interrupted": True}})
            assert (await harness.event())["type"] == "interrupted"
        await asyncio.wait_for(cancelled.wait(), 1)
        assert not session.responses
        if cancellation != "end":
            await session.wire.incoming.put({"toolCall": {"functionCalls": [
                {"id": "next-read", "name": "get_workspace_state", "args": {}}]}})
            await eventually(lambda: session.responses)
            assert len(session.responses) == 1
            assert session.responses[0][0]["id"] == "next-read"
            assert session.responses[0][0]["response"]["status"] == "ok"
            assert not harness.task.done()
        assert not tools.actions and not tools.pending
    finally:
        if not harness.task.done():
            await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("has_reference", [False, True])
async def test_sdk_missing_saved_run_is_reported_without_calculation_or_ack(monkeypatch, has_reference):
    from backend import core, live_tools

    execute = Mock(side_effect=AssertionError("A missing saved result must not trigger calculation"))
    solve = Mock(side_effect=AssertionError("A missing saved result must not trigger the solver"))
    monkeypatch.setattr(live_tools, "execute_run", execute)
    monkeypatch.setattr(core, "solve", solve)
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    changed = workspace(confirmed=False)
    changed["has_result"] = True
    if has_reference:
        changed["selected_run"] = {"id": "unavailable-saved-run", "workspace_revision": 1, "accepted_revision": 0,
                                   "proposal_id": None, "proposal_version": None}
    try:
        await harness.send({"type": "context", "context": changed})
        await eventually(lambda: len(session.sent) == 2)
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "read-missing", "name": "get_scenario_result", "args": {}}]}})
        explanation = await harness.event()
        status, code = ("error", "run_unavailable") if has_reference else ("no_result", "run_reference_missing")
        assert explanation["type"] == "explanation_status" and explanation["status"] == status
        assert explanation["code"] == code and "action_id" not in explanation
        await eventually(lambda: session.responses)
        envelope = session.responses[0][0]
        assert envelope["id"] == "read-missing" and envelope["name"] == "get_scenario_result"
        response = envelope["response"]
        assert response["status"] == status and response["code"] == code
        assert "result" not in response and "action_id" not in response and not response.get("acknowledged")
        execute.assert_not_called()
        solve.assert_not_called()
        assert harness.outgoing.empty() and not harness.task.done()
    finally:
        await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "exception"])
@pytest.mark.parametrize("selected_run_id", [None, "selected-for-explanation"])
async def test_tool_failure_returns_correlated_sanitized_error_and_keeps_receiving(monkeypatch, failure, selected_run_id):
    monkeypatch.setattr(live, "TOOL_TIMEOUT_SECONDS", 0.05)
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    tools = manager._records[harness.ticket["resume_token"]].tools
    original = tools.dispatch
    finished = asyncio.Event()
    if selected_run_id:
        changed = workspace()
        changed["selected_run"] = {"id": selected_run_id, "workspace_revision": 1, "accepted_revision": 0,
                                   "proposal_id": None, "proposal_version": None}
        await harness.send({"type": "context", "context": changed})
        await eventually(lambda: len(session.sent) == 2)

    async def dispatch(call_id, name, arguments):
        if call_id != "failed-read":
            return await original(call_id, name, arguments)
        try:
            if failure == "timeout":
                await asyncio.Event().wait()
            raise RuntimeError("private-canary-provider-detail")
        finally:
            finished.set()

    monkeypatch.setattr(tools, "dispatch", dispatch)
    try:
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "failed-read", "name": "get_scenario_result", "args": {}}]}})
        await eventually(lambda: session.responses or harness.task.done())
        assert len(session.responses) == 1
        response = session.responses[0][0]
        assert response["id"] == "failed-read" and response["name"] == "get_scenario_result"
        assert response["response"]["status"] == "error"
        assert response["response"]["code"] == ("tool_timeout" if failure == "timeout" else "tool_failed")
        assert not response["response"].get("acknowledged")
        assert "private-canary" not in str(session.sent)
        assert finished.is_set()
        assert await harness.event() == {"type": "explanation_status", "status": "error", "run_id": selected_run_id,
                                         "code": response["response"]["code"], "message": response["response"]["message"]}
        await session.wire.incoming.put({"serverContent": {
            "outputTranscription": {"text": "I could not read that result."}, "turnComplete": True}})
        assert (await harness.event())["text"] == "I could not read that result."
        assert (await harness.event())["type"] == "turn_complete"
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "next-read", "name": "get_workspace_state", "args": {}}]}})
        await eventually(lambda: len(session.responses) == 2)
        assert session.responses[1][0]["id"] == "next-read"
        assert session.responses[1][0]["response"]["status"] == "ok"
        assert not harness.task.done()
    finally:
        if not harness.task.done():
            await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("call_id", [None, "", "x" * 129])
async def test_sdk_missing_or_invalid_call_id_fails_honestly_without_uncorrelated_response(monkeypatch, call_id):
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    dispatch = AsyncMock()
    monkeypatch.setattr(manager._records[harness.ticket["resume_token"]].tools, "dispatch", dispatch)
    try:
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": call_id, "name": "get_scenario_result", "args": {}}]}})
        error = await harness.event()
        assert error["type"] == "error" and error["code"] == "invalid_call"
        assert await harness.event() == {"type": "ended", "reason": "invalid_call"}
        await asyncio.wait_for(harness.task, 1)
        dispatch.assert_not_awaited()
        assert not session.responses and session.closed
    finally:
        if not harness.task.done():
            await harness.finish()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "exception"])
async def test_sdk_response_send_failure_surfaces_transport_error_without_success(monkeypatch, failure):
    manager = live.LiveManager(client=FakeClient(session_factory=SDKSession))
    harness = SocketHarness(manager)
    session = await harness.connect()
    monkeypatch.setattr(live, "SEND_TIMEOUT_SECONDS", 0.05)

    async def fail_send(value):
        if failure == "timeout":
            await asyncio.Event().wait()
        raise RuntimeError("private-canary-wire-detail")

    monkeypatch.setattr(session.wire, "send", fail_send)
    try:
        await session.wire.incoming.put({"toolCall": {"functionCalls": [
            {"id": "state", "name": "get_workspace_state", "args": {}}]}})
        error = await harness.event()
        code = "live_timeout" if failure == "timeout" else "live_unavailable"
        assert error["type"] == "error" and error["code"] == code
        assert "private-canary" not in str(error)
        assert await harness.event() == {"type": "ended", "reason": code}
        await asyncio.wait_for(harness.task, 1)
        assert not session.responses and session.closed
    finally:
        if not harness.task.done():
            await harness.finish()
        await manager.close()
