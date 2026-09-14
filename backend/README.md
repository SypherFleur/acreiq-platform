# AcreIQ Local API

Python 3.12. Install and run from the repository root in PowerShell:

```powershell
py -3.12 -m venv backend/.venv
& backend/.venv/Scripts/python.exe -m pip install -r backend/requirements-dev.txt
& backend/.venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

API docs: <http://127.0.0.1:8000/docs>. Launching `uvicorn main:app` from
`backend` also works. This is a local, stateless API; keep it on loopback. It has
no user authentication, durable storage, or cross-process quota management.

To run the backend and frontend together under one manager, use
`.\scripts\start-local.ps1` from the repository root. Add `-InstallDependencies`
for initial setup, or `-CheckOnly` to run preflight without starting services.
The launcher selects available ports, records process ownership and URLs in
`.acreiq-local/runtime.json`, and prints the log directory. Stop the managed
services with `.\scripts\stop-local.ps1`. Stop any separately launched Uvicorn
instance before switching to the shared launcher.

## API Contract

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| GET | `/health` | None | `{status:"ok", service:"acreiq-api", vision_available:boolean, vision_provider:"manual"\|"gemini"\|"vertex", model_version:string}` |
| GET | `/sample` | None | The exact `core.SAMPLE` Scenario, with `confirmed:false` |
| POST | `/optimize` | JSON `core.Scenario` directly; no wrapper | `OptimizationResult` matching `frontend/lib/types.ts` |
| POST | `/scan` | `multipart/form-data`, exactly one file field named `image` | `ScanResult` matching `frontend/lib/types.ts` |

`/scan` responds with `{source:"gemini"|"manual", assets:[], observations:[], warnings:[]}`.
Each asset contains only `id`, `name`, `type`, `quantity`, `confidence`, and
`confirmed:false`. Allowed types are `light_fixture`, `shelving_rack`,
`circulation_fan`, `plant`, `container`, and `other`. Confidence is null or 0-1.
Asset names and qualitative observations come from a fixed server vocabulary;
provider-written measurements or prose are never forwarded. Vertex scans also
use `source:"gemini"` to preserve the frontend contract.

Missing configuration returns HTTP 200, `source:"manual"`, no assets or
observations, and a warning that the photo was not scanned, including setup steps.
Invalid configuration, authentication/ADC failures, quota, timeout, or temporary
provider unavailability return 503. Rejected model requests, malformed/oversized
provider output, blocked responses, and truncated responses return 502. Provider
messages, tokens, and credential details are not included in error bodies.

Request errors use `{detail:...}`: 400 for malformed multipart, 408 for stalled
uploads, 413 for byte/pixel limits, 415 for unsupported or mismatched content
types, and 422 for invalid scenarios, empty/corrupt images or the wrong file
field. Scenario numbers/booleans are strict; unknown fields, NaN, and infinity
are rejected. Missing PPFD or DLI and unconfirmed inputs return a successful
`needs_measurement` result without candidate search or savings.

## Vision Configuration

Create `backend/.env` using `.env.example`. `python-dotenv` loads that exact path
when `backend.main` is imported, using `load_dotenv(..., override=False)`;
it does not depend on the launcher's working directory. Real environment
variables take precedence. Secrets are loaded only on the server and never returned by health.
Restart after configuration changes. The SDK is Google's `google-genai` package.

- Developer API: `GEMINI_API_KEY`, or `GOOGLE_API_KEY` as a fallback.
- Vertex ADC: explicitly set `GOOGLE_GENAI_USE_VERTEXAI=true`,
  `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`; provision ADC separately.
  A gcloud CLI login or configured project alone is not ADC. Vertex mode takes
  precedence over API keys and uses ADC only.
- `GEMINI_MODEL` defaults to `gemini-2.5-flash`; choose a supported image-capable
  Gemini model available in your account/region.
- `GEMINI_TIMEOUT_SECONDS` defaults to 30 and must be between 5 and 60.
- `ACREIQ_CORS_ORIGINS` is an exact comma-separated origin list, defaulting to
  `http://localhost:3000,http://127.0.0.1:3000`.

Health reports local provider initialization, not a live inference or quota
check. A configured key may still be rejected by the provider during a scan.
The application never invokes gcloud or provisions cloud resources.

## Bounds and Privacy

Uploads are at most 10 MiB (10 * 1024 * 1024 = 10,485,760 bytes),
JPEG/PNG/WEBP only, 20 million decoded pixels, and
8192 pixels per side. Both actual container validation and full pixel decoding
are required; animated images and MIME mismatches are rejected. Request bytes
are bounded before multipart spooling, including chunked uploads. Multipart
overhead is limited to an additional 64 KiB. Other request bodies are limited
to 64 KiB. Uploads have a 30-second deadline and 15-second idle timeout.

Images are orientation-corrected, resized to at most 2048 pixels per side, and
encoded to clean JPEG before being sent to the provider. EXIF/GPS metadata,
filenames, and appended bytes are excluded. Uploads use temporary multipart
storage and are closed after parsing; the app does not persist images or results.
Configured scanning transmits the sanitized image to Google's selected service.

Two scans per process may upload/decode/query concurrently; excess requests
receive 503 with Retry-After. The SDK gets one attempt, a transport timeout, an
overall inference deadline, one output candidate, and 2048 maximum output tokens.
Upstream HTTP responses are limited to 256 KiB before SDK parsing; compression
and redirects are rejected. Inventory JSON is limited to 16 KiB, six unique asset
types and 1000 total suggested objects. Schema validation rejects extra fields,
measurement prose, invalid confidences/counts, and contradictory inventory.

## Auditable Model

`lighting-scenarios-0.3.0` retains the original finite search and equations.
It tests quarter-hour schedules within bounds, both entered bounds, and in-range
baseline hours. Dimmable scenarios test 50-100% in 5% steps plus the entered
baseline fraction. The exact baseline is always evaluated, even when outside
constraints. Duplicate settings are removed, every candidate includes rejection
reasons, and counts reflect the actual candidate list. No continuous optimum is
claimed; `no_feasible_configuration` refers only to tested settings.

Energy is computed from combined entered lighting watts and other load-hours;
fixture count does not multiply the combined watts. DLI is PPFD times dim fraction
times lighting hours times 0.0036. All active loads conservatively overlap for
peak power; zero-hour loads are excluded. Ranking and savings use unrounded
energy, with the nearest baseline dim/schedule breaking ties. A feasible baseline
is retained. Meeting constraints can increase energy, producing negative savings.

This is not a crop, yield, airflow, electrical design, or water optimization model.
It assumes linear power/light dimming, one canopy plane, and a constant measured
full-output canopy PPFD. A photo supplies none of these numerical inputs. Entered
water usage is merely carried through; water savings, yield gains, and avoided
CapEx remain null. Equipment spend is zero because the search adds no equipment.
The schematic twin is not a measured reconstruction. Validate power, canopy light
distribution, fixture behavior, and crop response before changing operation.

## Verification

```powershell
& backend/.venv/Scripts/python.exe -m pytest backend/tests -q
& backend/.venv/Scripts/python.exe -m pip check
```

Tests cover solver feasibility, baseline retention, exact counts, strict inputs,
missing PPFD, narrow/off-grid bounds, tiny-load rounding, unchanged water and null
yield/CapEx, image decode/metadata/animation/limits, multipart failures, chunked
bodies, manual fallback, provider failures and timeouts, bounded provider output,
and real SDK serialization over mock HTTP for both API-key and ADC paths.
These tests make no live paid inference calls; account access and recognition
quality still need verification with configured credentials and representative images.

SDK reference: <https://googleapis.github.io/python-genai/>.
