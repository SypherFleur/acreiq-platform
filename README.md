# AcreIQ

**AI Spatial Optimization & Resource Twin Engine**

Optimize existing growing-space equipment before buying more.

AcreIQ's first customer is an existing controlled-environment agriculture
operator evaluating operational improvements before expansion. Lettuce is the
first benchmark crop, while the broader resource-planning vision remains. AcreIQ
combines an editable equipment inventory, a schematic spatial twin, and a
transparent lighting scenario search. Start with the labeled sample, enter a room
manually, or use an optional Gemini photo scan to suggest visible assets. Review
the inventory and enter actual dimensions, electrical loads, canopy light
measurements, and operating constraints before comparing scenarios.

The Next.js interface calls a FastAPI backend through same-origin API routes.
The Python model tests a finite set of lighting schedules and supported dim
levels using the equipment already entered. Results include modeled energy and
cost from entered loads and flat tariffs, light dose, tested configurations, and
reasons settings were rejected.

This is not a crop-yield forecast, a water-savings model, a complete utility-bill
model, photogrammetry, or a layout optimization engine. A photo cannot measure
PPFD or electrical load. Water use, when entered, is carried through unchanged;
yield gains and avoided purchases remain unestimated. The sample is illustrative,
not a measured installation.

## Start locally on Windows

Use PowerShell from the repository root with Python 3.11+ and Node.js 20+ with npm available. The launcher also recognizes the bundled Codex runtimes on this machine.

```powershell
.\scripts\start-local.ps1 -InstallDependencies
```

The script creates `backend/.venv` if needed, installs dependencies only when requested, and launches both services in hidden windows. Defaults are frontend `http://127.0.0.1:3000` and backend `http://127.0.0.1:8000`. Busy ports are skipped; use the URL printed by the script. Logs and process metadata live under ignored `.acreiq-local/`.

```powershell
.\scripts\start-local.ps1 -CheckOnly
.\scripts\start-local.ps1
.\scripts\stop-local.ps1 -WhatIf
.\scripts\stop-local.ps1
```

For production mode, with dependencies installed and the managed servers stopped:

```powershell
npm.cmd --prefix frontend run build
.\scripts\start-local.ps1 -Production
```

No cloud account is needed for the sample, manual entry, or scenario calculation. Photo interpretation requires a backend-only Gemini API key or configured Vertex AI credentials. Configure `backend/.env` using `backend/.env.example`; the backend loads that file using dotenv. Never use a `NEXT_PUBLIC_` variable for credentials.

## Documentation

- [Optional AcreIQ Live walkthrough: local setup, consent and review boundaries](docs/live.md)
- [Current local release review](docs/checkpoints/earth-release/README.md)
- [Validation protocol for operator data](docs/VALIDATION_PROTOCOL.md)
- [AcreIQ Live checkpoint: provider verification and regression evidence](docs/checkpoints/acreiq-live/README.md)
- [Live-photo readiness checkpoint and evidence](docs/checkpoints/2026-09-12/README.md)
- [Chapter report and verified build status](docs/BUILD_PROGRESS.md)
- [Remaining inputs and private placeholder locations](docs/WHAT_I_NEED.md)
- [Setup, credentials, troubleshooting, and delivery](docs/setup.md)
- [Model inputs, formulas, search rules, and API contract](docs/model.md)
- [Demo walkthrough and verification commands](docs/demo.md)
- [Production containers, CI, and manual Cloud Run deployment](docs/deployment.md)

The source of truth for calculations is `backend/core.py`; frontend contracts are in `frontend/lib/types.ts`. The stack is Next.js, React, TypeScript, Three.js, FastAPI, and Python, with optional Gemini vision. No cloud deployment or billing configuration is performed by the local scripts.
