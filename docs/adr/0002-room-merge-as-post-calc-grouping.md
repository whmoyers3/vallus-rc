# 0002 — Room merge as non-destructive post-calculation grouping

**Status:** Accepted (2026-06-07)

## Context

The load calculation models every conditioned area as its own room. In the field,
HVAC contractors frequently install one supply trunk that serves two adjacent areas
(e.g. a small foyer and an adjacent dining area), or install multiple supplies to hit
a single room's target. A technician balancing the home therefore needs to treat some
calc rooms as a single **balancing target**, comparing one combined airflow against the
combined load of the grouped rooms.

The airflow balancing sheet handles the one-off case with an editable **Override**
column. But the same plan recurs dozens of times, so once the field reports which rooms
are physically combined, we want to codify the grouping at the tool layer so every later
run of that plan is correct without manual sheet edits.

A merge cannot be allowed to:

- change the load calculation result (house totals, tonnage, airflow) — it is an
  organizational concern, not a physics concern;
- silently break the Salas O'Brien comparison, where **room variance** and the
  **comparison snapshot** are strictly per-room;
- falsely fail **import fidelity**, which validates room count against the source PDF.

## Decision

A room merge is a **non-destructive, post-calculation grouping label** — never a
re-calculation and never a mutation of the underlying rooms.

1. **Physics is untouched.** The engine still calculates every component/line item
   individually. The merge is applied to the *results*: the merged room's
   cooling/heating/CFM and its floor area and volume are the **sum** of the source
   rooms. House totals are therefore identical with or without the merge.

2. **Declarative storage, trivial reversal.** Merges are stored as a list of groups in
   project metadata: `[{ merged_name, source_rooms: [...] }]`. `merged_name` defaults to
   the auto-concatenated source names (e.g. `"Foyer + Dining"`) and is editable.
   Un-merging is deleting the group entry; the source rooms reappear untouched because
   nothing was ever destroyed or rewritten.

3. **Comparison is merge-aware.** The same group keys map onto
   `metadata.salas_obrien_comparison`, summing the corresponding Salas rooms so a merged
   VRC room is diffed against the summed Salas rooms (apples to apples). A source room
   with no Salas counterpart is flagged, not silently dropped.

4. **Import fidelity is merge-blind.** Fidelity runs on the raw, pre-merge rooms because
   it answers "did we import the PDF faithfully," which is about the original imported
   structure. A merge is a later editorial action and never trips the room-count check.

5. **Frozen copies inherit merges.** Because merges live in project metadata, test
   battery frozen copies carry them like any other project state.

## Consequences

- The result-aggregation layer and the comparison/snapshot layer must both apply merge
  groups; the fidelity layer must not. This split is deliberate and must be preserved.
- A future reader will see one VRC "room" mapping to two Salas rooms in comparison views;
  that is expected and is the reason this ADR exists.
- Reversal is trivial by construction (delete the group), which was an explicit design
  goal: we accept the merge feature only because it can never corrupt the underlying data.
- The spreadsheet Override column and tool-layer merges coexist: Override handles the
  first, not-yet-codified occurrence; a merge group handles the codified, recurring case.

## Alternatives considered

- **Re-calculate merged rooms as a single room.** Rejected: it would let a grouping
  decision change the load answer, and it discards per-component detail needed for
  component variance analysis.
- **Merge only in the spreadsheet (Override column), never in the tool.** Rejected as the
  long-term answer: it repeats manual work on every run of a recurring plan, though it is
  retained as the mechanism for the first occurrence.
- **Make import fidelity merge-aware.** Rejected: fidelity must measure the faithfulness
  of the import itself, which is a property of the pre-merge structure.
