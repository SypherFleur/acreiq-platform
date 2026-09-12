# AcreIQ engineering instructions

## Product contract
AcreIQ is the AI Spatial Optimization & Resource Twin Engine, Sustainability / Freestyle.
**Optimize first. Purchase second.** Agriculture is the first real demo; broader physical
infrastructure remains the long-term direction. Do not rebrand it as GAIA or turn it into a chatbot.
The interface is a first-class deliverable: easy entry, intentional hierarchy, an understandable
visual model, editable assumptions, mobile support and visible evidence behind results.

## Current architecture
Keep the existing `frontend/` Next.js/TypeScript and `backend/` FastAPI/Python structure.
Do not scaffold a parallel app or overwrite uncommitted work. Inspect `git status` first.
The browser calls same-origin `/api/{health,sample,vision,optimize}`; Next proxies to the private API.
The Python numerical engine, not the LLM, calculates candidate metrics and selects a setting.
Vision returns tentative observations, never trusted dimensions, wattage, PPFD or crop requirements.

## Integrity and safety gates
- No hard-coded savings, scenario counts, detected objects, yields or "AI scores" represented as real.
- Keep synthetic samples conspicuously labeled; a provider error must not silently become sample data.
- Missing inputs produce a clear request for measurements, not invented defaults.
- Keep model keys server-side. Never commit `.env`, tokens, private photos or account JSON.
- Retain baseline feasibility checks, units, operating horizon and failed candidate reasons.
- Do not interpret maintained DLI as proof of maintained crop yield.
- Do not call a 2D illustrative schematic an accurate photo reconstruction, CFD model or NVIDIA integration.
- Keep prior SylionX/BioCube/GAIA intellectual property separate unless Jason intentionally includes it.
- Do not claim GCP deployment, live Gemini success, a frontend build or tests that were not actually run.

## Immediate verification
Run `python -m unittest backend.test_core -v` from the repository root.
Install the declared frontend dependencies and run `npx tsc --noEmit` and `npm run build` from `frontend/`.
Use a real browser to exercise sample → confirm → compare → current/proposed → export, then missing
PPFD, infeasible power limit, backend offline, and invalid image upload at desktop and phone widths.
Full Next.js compilation and a real Gemini request were not verified in the assistant's network-isolated
runtime. Do not treat syntax checking or a static screenshot as an end-to-end browser test.

## Next build gates
1. Verify the current vertical slice locally. Use Jason's account-specific model ID and server credentials.
2. Calibrate against the real tent: dimensions, canopy, power, crop stage, photoperiod and measured PPFD.
3. Add actual constrained layout candidates only with measured asset footprints, room boundary,
   non-overlap, access clearances and a feasibility test for each candidate.
4. Make the spatial view render solver-provided coordinates before animating any recommended moves.
5. Add water or yield models only with defensible inputs and validation; keep unsupported metrics null.

Read `docs/BUILD_STATUS.md` and `docs/CHECKPOINT_DEMO.md` before extending this milestone.
