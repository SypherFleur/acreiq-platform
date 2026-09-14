"""Local AcreIQ API. Run from the repository with uvicorn backend.main:app."""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from python_multipart.exceptions import MultipartParseError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartException

if __package__:
    from .core import MODEL_VERSION, SAMPLE, Scenario
    from .run_evidence import execute_run
    from .schemas import Health, OptimizationResult, ScanResult
    from .vision import MAX_UPLOAD_BYTES, VisionService, validate_image
    from .live import LiveManager, install_live_routes
    from .site_schemas import ComparisonRequest, VerifyRequest
    from .site_comparison import compare as compare_site, verify as verify_site, ComparisonError
    from .site_fixture import fixture as site_fixture
else:  # Support launching uvicorn main:app from the backend directory too.
    from core import MODEL_VERSION, SAMPLE, Scenario
    from run_evidence import execute_run
    from schemas import Health, OptimizationResult, ScanResult
    from vision import MAX_UPLOAD_BYTES, VisionService, validate_image
    from live import LiveManager, install_live_routes
    from site_schemas import ComparisonRequest, VerifyRequest
    from site_comparison import compare as compare_site, verify as verify_site, ComparisonError
    from site_fixture import fixture as site_fixture

load_dotenv(Path(__file__).with_name(".env"), override=False)


class RequestLimits:
    """Bound bytes before multipart spooling, including chunked requests."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        is_scan = scope["path"].rstrip("/") == "/scan"
        site_limits = {"/site-comparisons": 256 * 1024, "/site-comparisons/verify": 8 * 1024}
        limit = MAX_UPLOAD_BYTES + 64 * 1024 if is_scan else site_limits.get(scope["path"].rstrip("/"), 64 * 1024)
        raw_length = dict(scope["headers"]).get(b"content-length")
        if raw_length is not None:
            try:
                length = int(raw_length)
                if length < 0:
                    raise ValueError
            except ValueError:
                return await JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)(scope, receive, send)
            if length > limit:
                return await JSONResponse({"detail": "Request body exceeds the byte limit."}, status_code=413)(scope, receive, send)
        consumed = 0
        deadline = asyncio.get_running_loop().time() + 30

        async def bounded_receive():
            nonlocal consumed
            try:
                remaining = deadline - asyncio.get_running_loop().time()
                message = await asyncio.wait_for(receive(), timeout=max(0, min(15, remaining)))
            except TimeoutError:
                if is_scan:
                    raise MultiPartException("Upload stalled.") from None
                raise HTTPException(408, "Upload stalled.") from None
            consumed += len(message.get("body", b""))
            if consumed > limit:
                # Starlette closes temporary uploads when parsing raises MultiPartException.
                if is_scan:
                    raise MultiPartException("Upload exceeds the request byte limit.")
                raise HTTPException(413, "Request body exceeds the byte limit.")
            return message

        await self.app(scope, bounded_receive, send)


def create_app(vision_service: VisionService | None = None, live_manager: LiveManager | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        service = vision_service or VisionService.from_environment()
        application.state.vision = service
        application.state.scan_slots = asyncio.Semaphore(2)
        live = live_manager or LiveManager.from_environment()
        application.state.live = live
        await service.start()
        await live.start()
        try:
            yield
        finally:
            await live.close()
            await service.close()

    application = FastAPI(title="AcreIQ API", version=MODEL_VERSION, lifespan=lifespan)
    install_live_routes(application)
    application.add_middleware(RequestLimits)
    origins = os.getenv("ACREIQ_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in origins.split(",") if origin.strip() and origin.strip() != "*"],
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # Do not echo request bodies or non-JSON numeric values in validation errors.
        return JSONResponse(status_code=422, content={"detail": [
            {"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
            for item in error.errors()
        ]})

    @application.get("/health", response_model=Health)
    async def health(request: Request):
        service = request.app.state.vision
        return Health(status="ok", service="acreiq-api", vision_available=service.available,
                      vision_provider=service.provider, model_version=MODEL_VERSION)

    @application.get("/sample", response_model=Scenario)
    def sample():
        return Scenario.model_validate(SAMPLE)

    @application.post("/optimize", response_model=OptimizationResult)
    def optimize(payload: Scenario):
        return execute_run(payload)

    @application.get("/site-comparisons/fixture")
    def comparison_fixture():
        return site_fixture()

    @application.post("/site-comparisons")
    def site_comparison(payload: ComparisonRequest):
        try:
            return compare_site(payload)
        except ComparisonError as exc:
            raise HTTPException(exc.status_code, str(exc)) from None

    @application.post("/site-comparisons/verify")
    def verify_comparison(payload: VerifyRequest):
        return verify_site(payload.comparison_id, payload.sha256)

    @application.post("/scan", response_model=ScanResult, openapi_extra={
        "requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {
            "type": "object", "required": ["image"], "additionalProperties": False,
            "properties": {"image": {"type": "string", "format": "binary"}},
        }}}},
    })
    async def scan(request: Request):
        slots = request.app.state.scan_slots
        if slots.locked():
            raise HTTPException(503, "Photo analysis is busy. Retry shortly.", headers={"Retry-After": "5"})
        async with slots:
            return await scan_upload(request)

    async def scan_upload(request: Request):
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
            raise HTTPException(415, "Send multipart/form-data with one image field named 'image'.")
        try:
            async with asyncio.timeout(30):
                async with request.form(max_files=1, max_fields=0, max_part_size=64 * 1024) as form:
                    if list(form.keys()) != ["image"] or not isinstance(form["image"], UploadFile):
                        raise HTTPException(422, "Provide exactly one image field named 'image'.")
                    upload = form["image"]
                    raw = await upload.read(MAX_UPLOAD_BYTES + 1)
                    mime_type = upload.content_type or ""
        except TimeoutError:
            raise HTTPException(408, "Upload took too long. Retry with a local image.") from None
        except MultipartParseError:
            raise HTTPException(400, "Malformed multipart upload. Send one image field named 'image'.") from None
        except StarletteHTTPException as exc:
            if "request byte limit" in str(exc.detail):
                raise HTTPException(413, "Image exceeds the 10 MiB upload limit.") from None
            if "Upload stalled" in str(exc.detail):
                raise HTTPException(408, "Upload stalled. Retry with a local image.") from None
            raise
        image = await run_in_threadpool(validate_image, raw, mime_type)
        return await request.app.state.vision.scan(image)

    return application


app = create_app()
