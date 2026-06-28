# Internal Load Room Label Decisions

Last updated: 2026-06-28

This note records the takeoff-tool room-label heuristics used to decide when a room should
receive people and appliance/internal watt load before handoff to the calculator.

The calculator remains the source of truth for standard room-type defaults. The takeoff
should send `room_type` plus optional `people_override` and `appliance_watts_override`;
it should not invent BTU values. These rules are label-based prompts and export helpers
that preserve the current calculator contract.

## Current Rules

| Label pattern | Takeoff behavior | Rationale |
| --- | --- | --- |
| `kitchen` | Room type suggestion: `kitchen` | Standard calculator default: `680 W`, no seeded person. |
| `laundry`, `utility` | Room type suggestion: `laundry` | Standard calculator default: `200 W`, no seeded person. |
| `family`, `great room`, `gathering`, `entertainment` | Room type suggestion: `entertainment` | Standard calculator default: `1 person + 250 W`. |
| `bed`, `bedroom`, `owner suite`, `primary suite`, `master` | Room type suggestion: `bedroom` | Standard calculator default: `1 person`, no appliance watts. |
| lit `loft` under `100 sf` | Auto-export as `entertainment` with `1 person + 75 W` overrides | Small lofts in the available Salas O'Brien sample carried small appliance load. |
| lit `loft` at or above `100 sf` | Auto-export as `entertainment` with `1 person + 250 W` overrides | Larger lofts matched normal entertainment-load treatment. |
| `rec room`, `recreation room`, `game room` | Dismissible validation prompt to apply `1 person + 450 W` | Rec/game spaces usually look like entertainment spaces, but some samples carried heavier loads. Prompt rather than force. |
| `office`, `home office`, `work from home`, `WF Home`, `WFH` | Dismissible validation prompt to apply `1 person + 75 W` | Office labels sometimes carried small equipment load; many study/flex rooms did not. |
| `computer`, `PC` | Dismissible validation prompt to apply `1 person + 150 W` | Computer-focused labels imply equipment beyond a plain occupied room. |
| `study`, `flex`, `den` | Dismissible validation prompt to apply `1 person`, no appliance watts | Most parsed study/flex/den examples were person-only, not appliance-bearing. |

## Evidence From Current Sample

The latest scan used 49 parseable Salas O'Brien PDFs plus local JSON exports. The sample
is not yet large enough to treat as final policy, but it is useful for prompt defaults.

De-duped appliance-load patterns:

| Family | Observed appliance watts |
| --- | --- |
| Kitchen | Mostly `680 W`, with a few `800 W` cases. |
| Laundry / utility | Consistently `200 W`. |
| Living / family / great | Mostly `250 W`, with occasional `400 W`. |
| Loft | `75 W` for small lofts, `250 W` for larger lofts. |
| Rec / game / bonus | Mostly `250 W`, with exceptions at `350 W` and `650 W`. |
| Office / study / flex / den | Mixed. Office-like labels had `75 W` in some cases; plain study/flex/den were usually person-only. |

Notable office/study examples:

| Room label | Observed treatment |
| --- | --- |
| `Office` | Two reports had `75 W`; one report had `1 person` only. |
| `WF Home` | `75 W`. |
| `Kenny's Computer` | `150 W`. |
| `Playroom & Study` | `200 W`, treated as ambiguous/custom rather than a general study rule. |
| `Study`, `Flex`, `Flex / Study`, `Study / Guest`, `Bed 2 / Study` | Person-only in the parsed examples. |

## Modeling Guidance

Use automatic export only when the pattern is strong and low-risk. Today that applies to
lit lofts, because the square-footage split has a clear observed pattern and maps cleanly
to explicit overrides.

Use dismissible validation prompts when the label is suggestive but not universal. Rec/game
rooms, offices, computer rooms, studies, flex rooms, and dens should remain user-reviewed
because Salas O'Brien treatment varies by plan and label specificity.

Do not add a new calculator room type for these edge labels yet. The existing calculator
types plus overrides can express the observed behavior:

- `room_type: "entertainment"` with overrides for loft and rec/game cases.
- `room_type: "plain"` with overrides for office/computer/study/flex/den cases.

## Revisit Criteria

Re-evaluate these prompts after loading the larger one-to-two-year Salas O'Brien corpus.
Specifically check:

- Whether office/home-office labels consistently carry `75 W`.
- Whether `study`, `flex`, or `den` ever consistently carry appliance load, or remain
  person-only.
- Whether rec/game/bonus wattage correlates with square footage, plan option, or explicit
  media/game-room naming.
- Whether living/family/great-room `400 W` cases share a recognizable label or size pattern.

