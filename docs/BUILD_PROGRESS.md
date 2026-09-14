# AcreIQ Product Build

Current local release review: [AcreIQ Local Release Review](checkpoints/earth-release/README.md).
The first customer is an existing controlled-environment agriculture operator
evaluating operational improvements before expansion. Lettuce is the first
benchmark crop; the broader resource-planning vision remains. This release keeps
the synthetic demonstration and provenance intact and adds the
[Validation Protocol](VALIDATION_PROTOCOL.md) for future operator data. It does
not introduce validation results, new yield assumptions, provider calls, cloud
changes or sample-number changes.

Current handoff checkpoint: [Earth to operating plans](checkpoints/earth-handoff/README.md).
First-time site creation, incomplete drafts, selected-site plan editing and saved
Earth comparison summaries are implemented in the current integrated source.
The completed handoff build now serves the approved local review origin
`http://127.0.0.1:3007/` with build `9ba2XMT8R5DEW7ERSbLgW`. The prior 3007
Earth-address build `gkWdlBO6ZYNhqJRqGisnr` remains preserved for rollback.
Final production regressions: 529 passed, one intentional skip; fresh-browser
journey repeat: 12 passed including schematic pixel/camera checks; backend: 524
passed. Type checking and production build passed. No new live provider calls
were made while preparing the release materials. After replacing the local 3007
preview, 78 provider-free desktop/mobile checks passed on that exact origin;
frontend type checking and the 524-test backend suite also passed.

Prior Earth checkpoint: [AcreIQ Earth](checkpoints/earth/README.md). The existing
workspace now has a bounded Google Satellite/Hybrid location view with coordinate
entry, selectable pins and links to exact existing Phase 2 comparisons. Location
metadata is separate from numerical inputs and evidence. Actual Google imagery,
desktop pan/zoom, mobile rendering, pin association and comparison restoration
passed at `http://127.0.0.1:3007`, build `A65E-DuIAAfozkOGWGjd5`. Google accepted
that origin with no Maps errors; the Cloud Console restriction list was not changed
or audited. Build/type checking passed. Full pre-key regression: 351 passed with
one intentional skip; post-key affected regressions: 78 passed. Backend remains
unchanged (524 passing tests in this milestone). The duplicate Maps template value
was cleared with approval; the dedicated key remains in ignored frontend config.
No Gemini credentials, calculations, API enablement or billing settings were changed.
The original and tested Phase 2 runtimes remain running.

Address-first Earth refinement: `http://127.0.0.1:3007`, build `gkWdlBO6ZYNhqJRqGisnr`.
Street address/city/region is the primary input; precise coordinates are optional.
Explicit searches support multiple/partial/approximate results and cancellation;
results focus the map without silently saving an address-derived site pin. No
scenario inputs, calculations or saved evidence changed. Build/type check passed;
96 targeted development checks, 158 final production regression checks on desktop/
mobile and 524 backend tests passed. A real public-address
lookup returned `REQUEST_DENIED`; owner-authorized Geocoding API/key access is
still required. Real Satellite/Hybrid, pins and exact saved comparisons passed on
desktop/mobile with 90 tile responses. No cloud or Gemini configuration changed.
See the existing Earth checkpoint for final production regression evidence.

Geocoding enablement recheck: after the owner enabled the API, exactly one real
address request returned **OK** from the same 3007 origin and existing key. Google
Building 41 at 1600 Amphitheatre Parkway appeared as the address result. The first
automated post-search pin click timed out during map transition; no address retry
was made. A zero-geocoding follow-up associated the returned coordinates with the
isolated synthetic site and verified satellite position, reload and unchanged
scenario records. Both APIs are functionally permitted; the Cloud Console key
restriction list was not readable. No app code, credentials or cloud settings
changed. Full evidence and this test limitation are in the existing Earth note.

Previous implementation: [Site Scenario Comparison P2.1-P2.5](checkpoints/site-comparison/README.md).
Reviewed site/asset and operating-plan inputs now produce requested-setting energy,
conditional benchmark output, scoped cash, tri-state constraints and goal-specific
comparisons. Exact records can be saved, reopened and exported without replacing
accepted lighting inputs. The production review is `http://127.0.0.1:3004`, build
`1LA9tGNEvJfbKV0wCGqi3`; original runtimes remain untouched. Backend: 524 passed;
type checking and production build passed. Final browser regression: 303 passed,
one intentional duplicate-resize skip, no failures or flaky results. The checkpoint
records a corrected Live render-receipt race and the full verification evidence.
No provider calls or new yield model were introduced; sample-derived values remain synthetic.

Previous refinement: [Product Credibility Audit fixes F1-F6](checkpoints/audit-fixes/README.md).
Retention is explicit with no automatic history eviction; selected historical comparisons,
stable candidate IDs and exact-run exports stay coherent without overwriting working inputs.
PPFD provenance and no-change/additional-consumption wording are explicit. Verification:
408 backend tests passed; 239 Playwright checks passed with one intentional duplicate-resize
skip; type checking and an isolated production build passed. No provider calls were made.
The existing managed app remains untouched; the review preview is at `http://127.0.0.1:3001`.

Original design reference: [Site Scenario Comparison](SITE_SCENARIO_COMPARISON_PLAN.md).
The implementation is bounded to one agricultural operation, reviewed alternatives,
explicit resource/cost accounting and conditional output benchmarks, not predicted yield.

Previous refinement: [Exact-run Live explanations](checkpoints/live-explanations/README.md).
Saved numerical evidence is now read-only, shared with the visible Why this result? section,
and retained separately from editable inputs. Local regressions pass; the new real-provider
probe was blocked at connection setup by `live_quota`, before any test audio was sent.

Earlier refinement: [Live delegated design and reversible proposed versions](checkpoints/live-proposals/README.md).
This keeps the accepted workspace separate, removes exact-quote requests, binds voice actions
to actual user turns and versioned browser receipts, and preserves measurement safeguards.

Earlier follow-up: [Live speech playback fix](checkpoints/acreiq-live/PLAYBACK_FIX.md)
after the first hands-on voice attempt reached the browser's old five-second buffer.

The current optional voice/camera milestone is recorded in
[the AcreIQ Live checkpoint](checkpoints/acreiq-live/README.md). The earlier
[live-photo readiness checkpoint](checkpoints/2026-09-12/README.md) and initial
delivery results below are preserved as historical verification, not new test runs.

## Product target

Deliver a usable local product: photograph -> reviewed resource inventory -> constrained scenario search -> interactive spatial twin -> transparent impact comparison and export.

Design direction: graphite, white and green; a large, detailed Three.js growing-space schematic; restrained, legible tools and clear controls. Existing equipment comes first. The current energy accounting uses entered loads, requested schedules, operating horizon and flat tariffs, not regional peak-demand charges or a complete utility-bill model.

## Chapters

1. Intelligence: integrate the existing verified-resource-loop calculation model; expose a validated API; add Gemini image interpretation with editable observations; test model bounds and failure states.
2. Spatial twin: interactive Three.js room, growing beds/racks, fixtures, ventilation, selection, light overlay, camera views and responsive rendering.
3. Product workspace: connected upload and review, scenario controls, before/after comparison, search results, modeled impact, local persistence and export.
4. Delivery: integrate, build, exercise real browser flows at desktop and mobile sizes, verify canvas pixels, document setup and deployment, report remaining external dependencies.

## Coordination

Base: origin/main plus origin/feat/verified-resource-loop at 022bb6c. The latter is work from the existing Hackathon Debrief chat and is retained as the calculation foundation.

Four delegated workers implemented the backend, spatial renderer, stylesheet, and delivery files with disjoint ownership. The main agent integrated the contracts, built the workspace, and performed full browser and production verification.

The parallel chat later completed its branch at 9a885fe. Its engineering instructions and checkpoint documents were reviewed and preserved locally. Its branch remains unchanged on GitHub. This local build uses multipart `/scan` and the Google GenAI SDK with optional Vertex support; the historical handoff used JSON `/vision`.

## Boundaries

Outputs are modeled operating scenarios, not measured savings. Photo interpretation cannot measure electrical load, PPFD or crop light requirements. No unsupported yield, water-savings or avoided-purchase claims. The twin is a schematic from reviewed inputs, not photogrammetry. Deployment and live model access depend on the user's configured cloud credentials.

## Status

- Chapter 1 complete: constrained Python search, typed API, image validation, optional Gemini/Vertex interpretation, explicit manual fallback. 95 backend tests passed.
- Chapter 2 complete: detailed Three.js room, racks, plants, fixtures and fan; real inventory selection; light layer; orbit, top view and reset; reduced motion and missing-measurement/WebGL states.
- Chapter 3 complete: responsive workspace, reviewed inputs, editable inventory, sample and photo entry, live API simulation, current/proposed comparison, candidate plot/ledger, impact comparison, local run history, CSV/JSON export.
- Chapter 4 complete for local delivery: Next.js production build and TypeScript pass; dependency audit reports zero vulnerabilities; managed development and standalone production launch/stop work; Compose syntax validates.

## Initial delivery verification

- 95 backend tests passed, including exact arithmetic, constraint feasibility, image validation, no-credential fallback, provider errors and mocked Gemini/Vertex responses. Two upstream test-library deprecation warnings remain.
- Production standalone app: 13 Playwright checks passed; one duplicate mobile resize check intentionally skipped. Desktop and phone flows cover camera controls, real inventory selection, actual API simulation, rejected candidates, missing measurements, JSON download, run history, explicit manual scan fallback, invalid upload handling, modal focus, and recovery from a simulated service outage. A follow-up export check passed on desktop and mobile in the development server, including CSV headers and numeric contents.
- Canvas screenshots were decoded to verify nonblank pixels and green plant geometry; consecutive frames and camera changes produced different images. Layouts were checked at 320, 390, 768, 1200, 1440 and 1920 pixels wide with no horizontal overflow. Screenshots are local in `.acreiq-local/screenshots/`.
- Managed launch/stop safety checks passed, including occupied-port selection, process identity verification and retaining unrelated processes. The launcher also supports `-Production` after a frontend build.
- `npm run build`, `npm run typecheck`, `npm audit`, `git diff --check`, and `docker compose config --quiet` passed. CI and Dockerfiles are prepared; remote CI and container builds were not run.
- Local workspace: `http://127.0.0.1:3000`; backend: `http://127.0.0.1:8000`. Use the managed script's printed ports if these are occupied on a future launch.

## Verified sample

The labeled synthetic sample evaluates 33 settings, 25 feasible, and proposes 12 lighting hours/day at full output. It calculates 3,898.2 versus 3,022.2 kWh over 365 operating days, a difference of 876 kWh and $131.40 at $0.15/kWh (22.47%). These are model outputs under sample assumptions, not measurements of the user's grow space.

## Historical Initial-Delivery External Dependencies Snapshot

The notes below are preserved from the initial delivery checkpoint and do not
represent the current release configuration or private credential state.

- User has GCP and Gemini AI Studio available. The Google Cloud CLI is installed and has an existing default project, but no local ADC file or model API key was found. Provider success/error paths are tested with mocks; real photo recognition needs the user's authorized credentials and account-supported model ID in the prepared, Git-ignored backend/.env.
- Docker CLI is present, but its Linux engine is not running. Compose syntax was checked; image builds and container startup have not been executed.
- Cloud Run deployment and GitHub CI execution have not been performed. Deployment files and manual instructions are provided. No cloud resources, billing settings, GitHub branches or public services were changed.
- Current numerical optimization covers lighting schedules, not measured layout rearrangement, yield, airflow or water savings. Those require additional measured inputs and validated models.
