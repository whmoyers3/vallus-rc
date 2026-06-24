# 0008 — Shared bedroom-based ventilation sizing (`15 × (bedrooms + 1)`); bring it to the takeoff

**Status:** Accepted (2026-06-23)

## Context

For mechanical-ventilation (tight/ACH50) homes the engine needs an outside-air CFM. The
engine *consumes* one (`ventilation_load = 1.1 · cfm · ΔT`, distributed by level volume);
the importer reads Salas's printed "Mechanical Ventilation CFM" off the PDF.

The **formula already exists in the calculator frontend.** `main.tsx` auto-fills the
ventilation rate when the Mechanical Ventilation checkbox is ticked:

```
ventilation_cfm = 15 × (bedrooms + 1)
```

This was initially scoped as "add a 62.2 calc to the engine," and a first draft of this ADR
hypothesized the textbook `Qtot = 0.03·area + 7.5·(N+1)` with an infiltration credit
(because `0.03 × 2567 = 77` overshoots Finley's printed 75 CFM). That hypothesis was wrong.
Reverse-engineering the example ACH50 plans shows every printed CFM is an exact multiple of
15, across homes of different floor areas:

| Plan | Printed CFM | `15 × (N+1)` ⇒ bedrooms |
|------|-------------|--------------------------|
| Ash CBonus, Carrington E | 60 | 15×4 ⇒ 3 BR |
| Finley 2A, Belfort, Tranquility | 75 | 15×5 ⇒ 4 BR |
| Six Sisters | 105 | 15×7 ⇒ 6 BR |

Six homes of differing area all landing on multiples of 15 is only possible if the rule is
a multiple of 15. So Salas uses the **simplified, floor-area-independent**
`15 × (bedrooms + 1)` — not full ASHRAE 62.2 with the area term. The calculator already
matches this. The gap is not the formula; it is *where the formula lives*.

## Decision

**1. Treat `15 × (bedrooms + 1)` as the validated ventilation rule** (area-independent).
Do not introduce the 62.2 area term or an infiltration credit — they do not match Salas.

**2. Bring ventilation to the takeoff.** The takeoff currently emits no ventilation. Add the
same Mechanical Ventilation toggle and auto-fill, using the bedroom count derived from
bedroom-tagged rooms (ADR 0007), so a from-scratch takeoff produces `outside_air_cfm`
without a Salas PDF.

**3. Single source of truth for the formula.** The rule lives in the calculator frontend
only; the takeoff would duplicate it. Lift `15 × (bedrooms + 1)` into one shared place
(engine helper / shared module) so calculator and takeoff cannot drift — same reasoning as
the component and room-type catalogs.

**4. Imported value retained; computed value as from-scratch truth and divergence
diagnostic.** When a Salas PDF is scanned, keep its printed CFM as the authoritative
per-project input (the VRC-vs-Salas comparison must use what Salas used). Use the computed
rule as the source of truth for from-scratch takeoffs and as a divergence diagnostic on
scanned plans (computed vs printed; normally ~0, but it catches manual overrides or plans
that deviated). Mirrors the imported > computed precedence already in `CONTEXT.md`.

## Consequences

- From-scratch tight homes size ventilation from bedroom count alone.
- The takeoff gains a ventilation toggle wired to its bedroom tags.
- The formula stops being duplicated once lifted to a shared location.
- Bedrooms (from bedroom tags, ADR 0007) feeds this and nothing else in the engine.

## Out of scope

- **Outdoor-air latent load.** `ventilation_load` remains sensible-only; latent stays
  unmodeled, consistent with current behavior.
- **Mechanical-ventilation determination.** Whether a home *requires* mechanical ventilation
  (the ACH50 threshold that triggers the toggle) is a separate decision; this ADR only sizes
  the rate once the toggle is on.

## Alternatives considered

- **Add full ASHRAE 62.2 (`0.03·area + 7.5·(N+1)` with infiltration credit).** Rejected:
  does not match Salas, whose printed CFMs are exact multiples of 15 and area-independent.
- **Leave the formula in the frontend only.** Rejected: the takeoff would duplicate it and
  the two would drift.
- **Replace Salas's scanned CFM with the computed value.** Rejected: breaks the comparison
  and discards import fidelity.
