# AcreIQ Local Release Review

Date: 2026-09-13. Current integrated workspace, source-only review.

## Positioning

AcreIQ's first customer is an existing controlled-environment agriculture
operator evaluating operational improvements before expanding infrastructure.
Lettuce is the first benchmark crop because it gives the team one concrete CEA
operation to validate before broadening the resource-planning vision.

This release preserves the synthetic AcreIQ demonstration and its provenance. The
fixture values remain test assumptions, not validated crop requirements or field
results. Fictional assumptions are not relabeled as agronomic truth.

## Current Release Scope

- Earth to site to operating plans is available in the existing AcreIQ app.
- The local review origin is `http://127.0.0.1:3007/`.
- Active completed build: `9ba2XMT8R5DEW7ERSbLgW`, from
  `frontend/.next-earth-handoff`.
- Previous Earth address build preserved for rollback:
  `gkWdlBO6ZYNhqJRqGisnr`, from `frontend/.next-earth-address`.
- Private numerical API for review: `http://127.0.0.1:8003`.
- Local HEAD: `022bb6c06266acd75bf7196cf21500ba126f90ce`, branch
  `codex/acreiq-product`. The integrated working files, not historical HEAD
  alone, contain this build.

The current energy model uses entered loads, requested schedules, operating
horizon and flat tariffs. It does not model regional peak-demand charges,
time-of-use tariffs, fixed charges, taxes, HVAC feedback, weather response or a
complete utility bill.

Conditional output in the site comparison workflow is a reviewed benchmark input.
It is not a predicted yield model. A lettuce label or passing DLI constraint does
not validate output, transpiration or crop quality.

## Runtime Identity and Rollback

The 3007 runtime was relaunched from the completed handoff build because no live
3007 process was responsive at release review time. The previous 3007 build
directory and build ID were not deleted or modified. Browser local storage was
not cleared.

Current sanitized runtime identity is recorded in
`.acreiq-local/earth-release/runtime-3007.json`. It records process IDs, build
IDs, directories and whether a Maps browser key was present, but no credential
values.

Rollback, if needed:

1. Stop only the current 3007 frontend process identified in
   `.acreiq-local/earth-release/runtime-3007.json`.
2. Start `frontend/.next-earth-address/standalone/server.js` with
   `PORT=3007`, `HOSTNAME=127.0.0.1` and the same private
   `ACREIQ_BACKEND_URL`.
3. Keep `frontend/.env.local` private and unchanged. Do not clear browser
   storage; records remain origin-scoped.

Records created on `http://127.0.0.1:3008/` are not automatically available on
`http://127.0.0.1:3007/`. Use explicit comparison JSON export/import to move
completed comparison evidence between origins. Pins and incomplete drafts stay in
the browser origin where they were created.

## Maps and Provider Status

No Google Maps, Gemini, Live or photo provider request was made while preparing
this release-review note. The 3007 runtime has a Maps browser key configured
privately, but this note does not re-test it.

Earlier Earth checkpoints separately verified actual Google Satellite/Hybrid
imagery and one authorized Geocoding API request at the exact origin
`http://127.0.0.1:3007`. Those results remain prior provider evidence, not new
calls made for this release note. Google imagery is location context only; it is
not parcel evidence, ownership proof, a measurement source or operational
feasibility evidence.

## Validation Protocol

The validation path is documented in [Validation Protocol](../../VALIDATION_PROTOCOL.md).
It requires operator bills, interval electricity where available, actual
schedules, harvest records, crop/stage details, indoor conditions, water records
and relevant weather context. Calibration and held-out evaluation periods must be
separated before reporting predicted-versus-observed energy or cost errors.

Yield and transpiration validation remain out of scope until supported models and
held-out observations exist. Historical outcomes must not be reused as both
inputs and prediction targets.

## Import Boundary

The existing comparison JSON import is a recovery path for exact AcreIQ
comparison artifacts. It is not a historical operational-data upload feature and
does not calibrate the model from operator history. Any future upload workflow
needs its own consent, schema, data-quality and validation controls.

## Verification Inherited for This Release

The app behavior and numerical source are inherited from the completed
Earth-to-operating-plans checkpoint:

- Production build and type checking passed.
- Backend tests: 524 passed.
- Final production browser suite: 529 passed with one intentional duplicate
  mobile-resize skip and zero unexpected failures.
- Fresh-browser journey repeat: 12 passed, including schematic pixel and camera
  checks.
- JSON and CSV evidence export compatibility was preserved by the Phase 2 and
  handoff suites.

Post-replacement checks on the final `http://127.0.0.1:3007/` origin:

- Provider-free desktop/mobile browser regression: 78 passed, zero failures.
  This covered fresh site creation, incomplete plans, first-time comparison,
  objective changes, read-only Earth summaries, reload/reopen behavior,
  JSON recovery, export evidence, address-primary UI, mocked Maps error states
  and exact-run integrity.
- Frontend type check: passed.
- Backend tests: 524 passed, with two upstream deprecation warnings.
- `git diff --check`: passed; Git reported existing Windows line-ending notices.

No new production rebuild was required because app source and calculations were
not changed for this release-note pass. This release note adds positioning and
validation documentation only. It does not change sample numbers, calculations,
provider configuration, cloud permissions, billing, deployment, commits, pushes
or merges.
