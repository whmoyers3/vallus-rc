# 0012 - AI plan compiler as an advanced takeoff branch gated by manual geometry coverage

**Status:** Accepted (2026-06-28)

## Context

The long-term opportunity is for an AI-backed workflow to analyze a construction plan set,
build a first-pass building-envelope model, surface missing assumptions, and prepare the
project for user verification before handoff to the calculator. This could materially
reduce turnaround time on complex custom jobs, especially where vaulted ceilings, open
volumes, shifted upper/lower footprints, and unusual attic or garage boundaries make manual
takeoff slow.

The risk is allowing AI to invent geometry before the takeoff tool can represent and
validate that geometry deterministically. The early takeoff goal remains a fast, accurate,
auditable manual takeoff assistant, not automatic plan recognition. The manual workflow must
prove that every awkward geometry has a modeled home before an AI agent is allowed to infer
or prefill it.

## Decision

Treat the AI plan compiler as a **version two / advanced branch** of the takeoff tool, not
as part of the early production workflow.

The production pipeline remains:

1. users create or upload plan references;
2. users calibrate scale and align floors;
3. users trace conditioned geometry and slice rooms in 2D;
4. users place openings, assign boundary conditions, and model ceiling/vertical envelope
   conditions;
5. validation forces every assumption and awkward geometry into an explicit reviewed state;
6. the takeoff generates a calculator payload through the existing generate-forward handoff.

The advanced AI pipeline may be introduced only after the deterministic takeoff model can
represent the complex geometry corpus. When it is introduced, AI must write into the same
takeoff JSON model and validation system. It may propose geometry, envelope components,
sheet evidence, confidence scores, and QA checklist items, but it must not create a second
model or bypass validation.

## Dependency gates

AI plan compilation is blocked until these gates are complete enough to be boring:

- **World-feet geometry and non-destructive calibration.** All floors, rooms, openings, and
  references resolve to the same project-level feet coordinate frame.
- **Multi-floor alignment with confidence.** Floor overlays use reference point pairs,
  similarity transforms, residual fit error, and scale-vs-calibration checks.
- **Opening schema maturity.** Windows and doors carry explicit host wall placement plus
  vertical sill/head or equivalent height data, with 3D edits constrained to the host wall.
- **Connected/open-volume modeling.** Open-to-above, open-to-below, foyer/stair/loft
  overlaps, shifted upper/lower footprints, ceiling areas, wall continuations, and transition
  faces have deterministic authoring and export behavior.
- **Boundary and surface rule coverage.** Garage, attic, crawl, porch, cantilever, slab,
  framed floor, floor-over-garage, band joist, knee-wall, tray, and vaulted cases generate
  explicit reviewed components.
- **Validation as export gate.** Geometry, room overlap, unassigned area, component coverage,
  ceiling geometry, opening placement, boundary ambiguity, and unresolved assumptions are
  visible before export.
- **Plan battery.** The manual engine has been exercised against a representative corpus:
  simple slab, two-story standard, townhouse, basement/crawl, vaulted custom, open
  foyer/stair, porch/garage adjacency, and one ambiguous or poor-quality plan.

## Future AI workflow

The later AI branch should be a plan compiler, not a freeform 3D artist:

1. classify sheets and extract evidence from plans, schedules, sections, elevations, and
   notes;
2. propose takeoff JSON objects with page/crop/source citations and confidence;
3. run the same deterministic validation used by manual takeoffs;
4. produce a QA list of missing details and assumptions;
5. render the existing 3D QA/authoring workspace from the proposed takeoff model;
6. require user verification before calculator import.

For standard builder-grade jobs, the normal manual workflow remains preferred. The AI branch
is reserved for complex custom jobs where the extra compute time is justified by the
expected reduction in manual modeling and QA effort.

## Consequences

- The current takeoff roadmap stays focused on deterministic authoring, validation, and
  calculator handoff.
- AI work can begin as offline research, test harnesses, and evidence schemas, but not as a
  production geometry author until the dependency gates are met.
- Every AI-generated claim must map back to a takeoff object, a source location in the plan
  set, a confidence score, and a validation state.
- This preserves the single-source-of-truth rule from ADR 0006 and the generate-forward
  handoff from ADR 0009.

## Alternatives considered

- **Let AI generate the 3D model first.** Rejected. It would encourage assumptions before the
  rule set is known and could create geometry the takeoff payload cannot represent.
- **Make AI part of the early takeoff MVP.** Rejected. The early value is an auditable manual
  assistant; automation should follow a proven representation.
- **Keep AI out permanently.** Rejected. Once the manual engine proves the rule set, an AI
  compiler can become a strong advantage for complex plan sets.
