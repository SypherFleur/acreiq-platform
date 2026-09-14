# AcreIQ Validation Protocol

Date: 2026-09-13. This protocol describes how AcreIQ should be validated with
real operators after the current local release. It is not a claim that validation
has already been completed.

## Customer and Crop Scope

The first customer profile is an existing controlled-environment agriculture
operator evaluating operational improvements before expansion. The initial
benchmark crop is lettuce, with crop/stage and production method recorded for
each validation case. The broader AcreIQ vision remains resource planning across
sites, infrastructure and operating goals, but this release should not be sold as
a general land-use optimizer.

## Current Model Boundary

The current energy model uses user-entered connected loads, requested operating
schedules, operating horizon and a flat electricity tariff. It does not model
regional peak-demand charges, time-of-use rates, fixed charges, taxes, HVAC
feedback, weather-driven load response or a complete utility bill. Cost outputs
must be described as known modeled subtotals when inputs are incomplete.

Current conditional output benchmarks are reviewed assumptions supplied by the
user or a documented test fixture. A crop label, a DLI pass or a lettuce benchmark
does not establish predicted yield. Yield and transpiration validation should be
added only when a supported model exists and the required observations are
available.

## Required Operator Data

- Utility bills for the facility and the billed service period.
- Interval electricity data when available, with timestamp, timezone and meter
  boundary.
- Actual lighting and operating schedules for the same periods.
- Harvest records with crop, stage, method, harvest dates, harvested units and
  quality or marketability rules.
- Indoor conditions relevant to the crop and stage, including temperature,
  relative humidity and CO2 when available.
- Water records and fertigation context when water or transpiration is being
  evaluated.
- Relevant weather records only as context or for later supported models; weather
  is not a driver in the current flat-load lighting model.

## Calibration and Held-Out Evaluation

Separate each validation effort into a calibration period and a held-out
evaluation period before scoring results. Calibration data can be used to set or
adjust entered loads, schedules, tariff assumptions, operating boundaries and
documented benchmarks. Held-out records are reserved for checking predictions or
scenario calculations after those assumptions are fixed.

Historical outcomes must not be reused as both model inputs and prediction
targets. For example, an observed harvest can be documented as the source of a
benchmark assumption, or it can be held out for evaluation, but it cannot do both
in the same claim.

## Error Reporting

Energy and cost validation should compare predicted versus observed values over
matched periods and boundaries. Report absolute error, percent error and the
underlying units. When enough observations exist, also report MAE, RMSE, NMBE and
CVRMSE for energy or cost. Reconcile known flat-tariff energy charges separately
from demand charges, fixed charges, riders, taxes and other bill items excluded
from the current model.

Yield and transpiration validation should remain marked not evaluated until
supported models, required crop/stage inputs and independent held-out outcomes
exist. Do not report invented validation statistics or convert a conditional
benchmark into a validated forecast.

## Import Versus Future Upload

The current application supports comparison JSON import for previously exported
AcreIQ scenario evidence. That is a recovery and review path for exact saved
comparisons, not a historical operational-data upload feature.

A future operator-data upload workflow would need explicit schemas, consent,
privacy handling, data-quality checks, calibration/evaluation split controls and
separate evidence records. It should not be implied by the current JSON import
button.

## Release Status

No validation results are included in this release. Synthetic demonstrations
remain synthetic and preserve their provenance. Operator validation starts only
after the operator supplies reviewed data and agrees to the evaluation boundary.
