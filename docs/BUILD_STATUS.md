# AcreIQ: audited build status

Date: September 12, 2026. Base inspected: `a822fb36c16a0f7f8f8709e8fbc4b3245dd04b09`.
Branch: `feat/verified-resource-loop`.

## Preserve the chosen product
AcreIQ remains an AI Spatial Optimization & Resource Twin Engine. Its broader loop is
observe → resource graph → twin → constrained simulation → optimized visual blueprint.
The grow-room use case is the first demonstration, not a claim to have solved every environment.
This milestone implements a **lighting-scenario slice** of that larger system.

## Audit of the original scaffold
`frontend/app/page.tsx` originally previewed an uploaded photo and switched between fixed objects;
it did not send the image to a model or call the backend. Asset counts and impact cards were constants.
`backend/main.py` applied fixed 15% energy and 20% water reductions, returned 4,862 candidates
without evaluating them, inferred production from area, and replaced a zero budget with a $10,000
baseline. Those were mockups, not measured or simulated findings. This branch removes them from the active flow.

## Implemented in this branch
- A distinct sample/manual/photo-assisted flow and a redesigned responsive workspace.
- Input review; transparent scenario labeling; current/proposed comparison; real candidate plot.
- FastAPI numerical enumeration: photoperiod at 15-minute increments; optional 50–100% dimming
  at 5-point increments; include the existing baseline even when off-grid.
- Candidate rejection for photoperiod, minimum DLI and modeled connected-load constraints.
- Minimum modeled energy among feasible settings, with stable tie-breaks. This is not a full
  multi-objective/Pareto optimizer or a yield maximizer.
- Real candidate and feasible counts; abstention on missing PPFD/DLI; no fabricated success on infeasibility.
- Optional server-side Gemini REST vision adapter with schema validation, image validation,
  size limits, timeout and explicit provider errors. No image or API key is persisted by application code.
- Same-origin Next.js API proxy, JSON export, credential templates, ignore rules and unit tests.

## Model equations and boundaries
For light output fraction f and photoperiod h:

`daily_kWh = (lighting_W × f × h + other_W × other_hours) / 1000`

`DLI_mol_m2_day = PPFD_at_full_output × f × h × 3600 / 1,000,000`

`period_kWh = daily_kWh × operating_days`

`period_cost_USD = period_kWh × electricity_USD_per_kWh`

Use actual measured canopy PPFD at full output and crop-stage constraints supplied by the user.
Light dose alone is not crop-health/yield equivalence. Linear dimming is a simplifying assumption,
not a calibrated fixture curve. Loads omitted from the input, HVAC feedback, demand charges and
weather are not represented. Other loads are treated as coincident for the conservative modeled peak.
The current geometry is one canopy plane; the schematic is illustrative and not to scale.

Water is optional baseline information only and remains unchanged across candidates.
Water savings, yield gains and avoided CapEx are deliberately null. The search adds no new equipment;
that does not prove that a particular planned purchase can be avoided or that a zero-cost change is safe.
There is no arbitrary AcreIQ Score.

## Reproducible synthetic example
8 × 8 ft room, 32 sq ft canopy, 2 fixtures totaling 600 W, 45 W other load for 24 h/day,
16-hour baseline, non-dimmable, PPFD 350, minimum DLI 15, permitted photoperiod 10–18 h,
modeled load limit 1,800 W, electricity $0.15/kWh, 365 operating days. All values are assumptions.

The actual model evaluates 33 settings, with 25 meeting constraints. It selects 12 lighting hours.
Baseline: 10.68 kWh/day; proposed: 8.28 kWh/day; modeled difference: 876 kWh and $131.40
per 365 operating days, about 22.47%. Proposed DLI: 15.12 mol/m²/day.
These are arithmetic scenario results, NOT AcreIQ field performance or realized 2026 impact.

## Local run (Windows PowerShell)
From the repository root:

```powershell
python -m venv backend/.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
Copy-Item backend/.env.example backend/.env
.\backend\.venv\Scripts\python.exe -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000 --env-file backend/.env
```

Separate terminal:

```powershell
cd frontend
Copy-Item .env.example .env.local
npm install
npm run dev -- --hostname 127.0.0.1
```

Open `http://localhost:3000`. Sample/manual mode needs no Gemini key.
For image analysis set `GEMINI_API_KEY` and the exact allowed `GEMINI_MODEL` locally in `backend/.env`,
then restart the backend. An event chat login is not proof of API access. This adapter uses Gemini
Developer API key authentication; a Vertex-only service account needs a separate adapter.

Keep both services local/private. Before external hosting add authentication, per-user quotas,
rate limiting, secret management and deployment-specific request limits. There is no verified GCP deployment.

## Validation boundaries
The unit suite is executable with the existing FastAPI/Pydantic dependencies. In the assistant runtime
it passed with FastAPI 0.128.2 / Pydantic 2.13.4, not a freshly installed copy of the repository pins.
14 unit tests and six in-process HTTP endpoint checks passed. TypeScript syntax was checked.
Static markup layout previews at 1440px and 390px had no horizontal overflow; these used a lightweight
preview harness, not the React/Next.js runtime or real icon library. Package-install network access
was unavailable, so a complete Next.js
production build and genuine interactive frontend tests must still run in the user's Codex workspace.
Live Gemini execution requires the user's private credentials and remains unverified.

## Current technical references
Gemini REST endpoint and image payload: https://ai.google.dev/api/generate-content
Gemini structured outputs and application-side validation: https://ai.google.dev/gemini-api/docs/structured-output
Next Route Handlers and promised params: https://nextjs.org/docs/app/api-reference/file-conventions/route
Keep credentials server-only; do not add a `NEXT_PUBLIC_` model key.

## Checkpoint schedule caveat
The conversation contains "72 hours / six 12-hour submissions" but also a Saturday-noon kickoff
and Monday-noon environment shutdown. That shutdown is 48 hours after kickoff. Obtain the actual
submission timetable from organizers; do not infer six deadlines or promise a Tuesday finale.
