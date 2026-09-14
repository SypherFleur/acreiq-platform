# Earth to Operating Plans Checkpoint

Date: 2026-09-13. Current integrated AcreIQ, not a historical checkout.

## Runtime

- Walkthrough origin: `http://127.0.0.1:3008/`.
- Production build: `9ba2XMT8R5DEW7ERSbLgW`, `frontend/.next-earth-handoff`.
- Private numerical API: existing `http://127.0.0.1:8003`.
- Local HEAD: `022bb6c06266acd75bf7196cf21500ba126f90ce`, branch
  `codex/acreiq-product`. Integrated working files, not historical HEAD alone,
  contain this build. No new commit, reset, branch switch or push.
- Original 3000/8000, Phase 2 3004/8003 and Earth 3007 were identified and preserved.
  No user runtime or backend restart. Only this task's temporary 3008 review
  process was replaced during development.
- Maps-approved origin remains `http://127.0.0.1:3007`. Approval to replace that
  Earth preview with this build was requested and remains pending. Restrictions
  were not changed. Google access from 3008 is not verified. The complete automated
  journey uses explicit test coordinates with provider calls blocked, not a live
  Google request. A deliberately disabled test key is not a provider failure.

## Failure and Repair

Earth previously derived sites only from strict working requests or completed
comparisons. Those requests required assets, operating values and two plans.
Fresh users therefore had no site-creation path, and the comparison link opened
an unrelated empty view. Port 3004 storage was also unavailable on 3007 because
browser storage is origin-specific.

The repair introduces an incomplete authoring form of the existing Phase 2
contract, not a second simulator or site database. Stable site IDs exist before
plans or calculations. Unknown numbers remain null. The strict numerical request
is constructed only after required structural inputs and explicit review.

## Completed Workflow

- Select a pin or coordinates, name the site and **Create planning site here**.
  Site creation precedes geographic association; a failed second save reports
  the partial outcome honestly. A point is not a parcel or ownership claim.
- **Connect an existing site** preserves its identity. Sites without plans offer
  **Create current plan** directly in the existing progressive editor.
- Zero-plan and one-plan drafts persist. One active plus 20 parked working sites
  are retained without eviction. Capacity, corrupt data, concurrent writes and
  storage failures preserve existing data and expose errors/session export.
- Measurements and costs start unknown. DLI, peak-power and lighting-schedule
  resource requirements start enabled with unknown bounds. Enter reviewed bounds
  or explicitly disable a requirement; unknown bounds never count as a pass.
- Explicit asset entry accounts for loads once, distinguishing owned from proposed
  equipment. Alternative creation copies the selected plan without adopting it.
  Changed conditions invalidate review and benchmark applicability.
- Pending benchmark approval is bound to site, plan and condition snapshot.
  Editing inputs or switching plans closes it and requires a fresh review.
- Returned comparison artifacts must match submitted inputs, review status and
  parent run. Hash-valid wrong-run responses cannot replace previous evidence.
- **Compare plans** opens the selected site's working plans. **Open site comparison**
  opens the selected immutable artifact without replacing current inputs.
- Earth shows that artifact's goal, scenario, energy, conditional output, water,
  scoped cash and constraint outcome. It reads saved evidence, never recalculates
  map metrics. Location changes do not change numerical inputs or results.
- Existing goal changes, historical evidence, stable IDs, JSON and CSV exports,
  Three.js, lighting/proposal workflow and Live integration are preserved.
- Maps configuration, separate browser key, address handling and attribution are
  unchanged. Missing imagery configuration retains the local coordinate workflow.

## Cross-Origin Recovery

No cross-origin storage reading, automatic migration, clearing or fixture loading.

1. Open the origin holding the earlier comparison, such as
   `http://127.0.0.1:3004/`, in the original browser/profile.
2. Select its saved comparison and export **Comparison JSON**.
3. On the walkthrough origin, use Earth **Recover existing plans** / **Import
   existing comparison**, then **Import comparison JSON**.
4. Run/site IDs and original evidence remain read-only. Current working sites and
   plans are not replaced. Select that site and explicitly associate a pin.

Pins are separate geographic metadata and are not included in numerical JSON.
**Create draft from comparison** explicitly copies historical inputs for editing,
retaining their provenance. A new real site never copies sample measurements or
crop benchmarks automatically. Normal JSON recovery handles completed comparison
artifacts; incomplete drafts persist on their original browser origin.

## Independently Calculable Test Inputs

Fresh-browser tests enter these values through the UI. They never call the sample
or fixture endpoint or seed working storage. Every value is labeled **TEST ONLY**,
not a farm measurement or agronomic recommendation.

| Input | Test value |
| --- | --- |
| Scope | One indoor leafy-greens bay; outdoor acreage excluded |
| Site | 8 x 8 ft; canopy 32 sq ft |
| Asset | One available, owned 600 W aggregate light |
| Operation | Lettuce; TEST-ONLY cultivar/method/protocol; transplant to harvest |
| Product | TEST ONLY net marketable fresh lettuce, kg |
| Horizon | One 28-day cycle; zero turnover and idle days |
| Conditions | 160 starts; 22 C; 60% RH; 420 ppm CO2; pH 6; EC 1.5 mS/cm |
| Lighting | Current 16 h/day, alternative 12 h/day; output fraction 1 |
| Light inputs | Assumed PPFD 350 micromol/m2/s; DLI requirement 15 mol/m2/day |
| Module bounds | 10-18 h/day; modeled power limit 1000 W |
| Common resource limits | DLI minimum 15; peak maximum 1000 W; schedule 10-18 h/day |
| Water | Current 15 L/day; alternative 14 L/day |
| Benchmark | Explicit separate assumptions: 24 and 20 kg per 28-day cycle |
| Cash | Electricity USD 0.20/kWh; all other costs unknown |

Independent arithmetic:

- Current: `0.6 * 16 * 28 = 268.8 kWh`, `350 * 16 * .0036 = 20.16 DLI`,
  `15 * 28 = 420 L`, electricity subtotal `268.8 * .20 = USD 53.76`.
- Alternative: `0.6 * 12 * 28 = 201.6 kWh`, `350 * 12 * .0036 = 15.12 DLI`,
  `14 * 28 = 392 L`, electricity subtotal `201.6 * .20 = USD 40.32`.
- Output goal prefers the current plan's conditional 24 kg. Energy goal prefers
  the alternative's 201.6 kWh: 67.2 kWh less but 4 kg less assumed output. Unknown
  costs keep full totals unknown; these cash amounts are only known subtotals.
- At 13 h/day, the alternative uses `218.4 kWh` but its 12-hour benchmark is
  inapplicable. Missing PPFD leaves energy available, DLI/output unknown, the DLI
  constraint unknown and no preferred eligible plan.

## First-Time Walkthrough

Stay on the one walkthrough origin. Use a private window; do not clear existing
storage and do not load the A/B/C fixture.

1. Open Earth, expand **Precise coordinates**, and select latitude 10, longitude
   20. These arbitrary test coordinates are not the user's farm. Map/address entry
   remains available only when Google permits the runtime origin.
2. Name **TEST ONLY - indoor handoff**, then **Create planning site here**. Confirm
   its saved location and ID; choose **Create current plan**.
3. Enter the table's scope, asset, operation and current-plan inputs. In **Resource
   limits**, enter the common bounds separately from the lighting-module settings.
4. Create a 24 kg benchmark assumption with a TEST ONLY source note and explicit
   acknowledgement. Duplicate the plan; name **Alternative 12**, enter 12 hours
   and 14 L/day, then create a new 20 kg conditional assumption for its context.
5. Choose **Maximize conditional output**, review and compare. Inspect **Why this
   result?**, actual constraint outcomes and numerical evidence.
6. Change to **Minimize energy**. Confirm the alternative becomes preferred without
   changing requested settings or introducing a combined score.
7. Select the alternative result, **Return to Earth**, inspect the saved summary,
   reload and **Open site comparison**. Export JSON or the CSV evidence bundle;
   verify the same comparison ID. No operating plan is automatically adopted.
8. Separately create an incomplete site/plan and reload. Required authoring inputs
   block evaluation. Clear PPFD in a structurally complete reviewed test plan to
   verify honest partial outcomes rather than fabricated output or savings.

## Verification

- Final production build and `npm run typecheck`: passed.
- Backend: **524 passed**, two upstream deprecation warnings and one nonfatal
  pytest-cache permission warning. Numerical source unchanged.
- Existing Earth/comparison/storage development flows: **80 passed**.
- Focused missing-data and JSON-recovery repair: **8 passed**, desktop/mobile.
- Final-build fresh-browser journey: **12 passed**, zero failures/skips, including
  direct Three.js nonblank-pixel and camera-change checks at both viewport sizes.
- Desktop/mobile screenshots of the saved Earth summary and schematic were
  inspected. No horizontal overflow or incoherent text overlap was observed.
- Final integrated production browser suite: **529 passed, one intentional
  duplicate mobile-resize skip, zero failures or flaky results**, in 11.1 minutes
  against the named 3008 build. This includes all Phase 1/Phase 2, Earth/address,
  Live/audio/proposal, exact-run evidence and export regressions, plus 16 targeted
  benchmark/request-integrity cases. No live provider request was made.
- The separate 12-case journey repeat adds the final schematic pixel/camera
  assertions; it is a repeat of the journey cases, not 12 additional unique cases.
- `git diff --check`: passed, with existing Windows line-ending notices.

Local test reports/screenshots reside under `.acreiq-local/` and
`frontend/test-results-earth-handoff-*`; they are excluded from the source archive.
The generated manifest records exact source hashes and the tested build identity.
HTTP inspection confirmed that 3008 serves the named build and simulation health
is `ok`. The isolated API's manual vision configuration is intentional. Existing
Phase 2 archive SHA256 still matches its original `archive-info.json`.

Machine-readable local reports: `.acreiq-local/earth-handoff-final-production-tests.json`,
`.acreiq-local/earth-handoff-final-journey-tests.json` and
`.acreiq-local/earth-handoff-backend-tests.xml`. Earlier provisional runs exposed
the blank-resource-limit and status-selector issues; both were repaired before
the successful final runs. These reports are excluded from the source archive.

## Limitations and Source Review

Only indoor leafy greens in one growing bay are supported. Constraint-pass refers
to enabled modeled requirements, not whole-site feasibility. No outdoor model,
imagery measurements, layout solver, ROI engine, new yield model or cloud changes.
Benchmarks remain conditional inputs; manual entry/review does not verify them.
Local browser history is limited and clearable, not a durable cloud archive.
Schema/hash consistency is not proof of source truth or server availability.

No new real spoken Live, Gemini or Google call was made for this checkpoint. The
suite covers provider-free Live/proposal/simulation regressions. Earlier Google
success on 3007 is separate from this provider-free 3008 handoff verification.

Proposed commit scope: incomplete draft contract/storage migration, Earth/site
handoff actions, progressive plan entry, saved-artifact summary, targeted integrity
guards, regression tests and source-packaging safeguards. Preserve the integrated
Phase 1/Phase 2/Live source. Numerical code and provider configuration are unchanged.
No credentials, user photos, private locations, storage dumps, dependencies, build
output or runtime logs are included in the source-only checkpoint. No commit,
merge, push or deployment is performed.
