# VRC UI Redesign Spec

_Decisions from design session, 2026-06-08. Implementation reference for the load calculator redesign._

---

## 1. Layout & Navigation

### App shell
- Persistent top-level nav: **icon rail** on tablet/desktop (collapsed by default, expands on hover or pin), **bottom tab bar** on mobile.
- Tabs: Load Calc · Airflow · Admin. Admin hidden on mobile.
- Load calculator is tablet/desktop-first (≥768px baseline); degrades gracefully to mobile for quick field edits.

### Left nav (load calculator)
- Replaces the current static 240px sidebar.
- **Desktop/tablet:** collapsible icon rail. Expanded shows section list with scroll-spy highlighting as user scrolls.
- **Mobile:** small floating button opens a bottom drawer with the section list. No sub-items in the drawer — tapping a section jumps to its top.
- **Section list:**
  1. Project Settings
  2. Envelope Assemblies
  3. Units & Zones
  4. Rooms _(expands to show room sub-items only when user is scrolled into the Rooms section; sub-items hidden on mobile)_
  5. Load Summary
  6. Salas Comparison _(only if a Salas import is loaded)_
- Status indicators on nav items: inline validation dot (e.g. red on Rooms if a room has missing required fields; checkmark on Load Summary once calculated).

### Scroll-spy navigation
- All sections rendered on the page at all times (no section-switching / tab model).
- Left nav highlights the active section as user scrolls.
- Clicking a nav item anchor-scrolls to that section.

---

## 2. Toolbar

### Button groups
| Group | Buttons | Visible |
|---|---|---|
| Project | Open ▾ (New · Open Saved · Import · Continue Draft*) | Always |
| Primary action | Calculate | Always |
| Persist | Save ▾ (Save · Save As) | After first successful calculate |
| Export | Export ▾ (Airflow Sheet · PDF Report) | After first successful calculate |

_*Continue Draft appears in the Open dropdown only if a localStorage draft exists._

### Mobile toolbar
- **Calculate** as a persistent large pill button at the bottom of the screen.
- All other actions in a **⋯ overflow menu** (or bottom action sheet).
- Save and Export only appear in the overflow after calculate, same gating as desktop.

### Save logic
- **Save Draft:** always available, no required fields, no calculate needed. Saves inputs only.
- **Calculate:** validates required fields inline before proceeding. Will not run if required fields are missing.
- **Save (full):** available after first successful calculate. Saves inputs + results.
- **Save As flow:**
  1. Modal opens with name field pre-filled with current project name.
  2. User edits name and confirms.
  3. If name matches an existing project → warning: _"A project named '...' already exists."_ with three options: **Cancel** (back to project) · **Rename** (back to naming modal, field still populated) · **Overwrite** (saves and proceeds).
  4. If name is new → saves immediately, no warning.
  5. After save, working project becomes the newly named version.

### Required fields (gate on Calculate, never on Save Draft)
Name, Location, Building Type, Front Door Faces, Bedrooms, ACH50, SEER.

### Advanced fields (collapsed by default in Project Settings)
Outdoor/indoor design temps, safety factors, mechanical ventilation + CFM, natural ACH, system tons/kw override.

---

## 3. Rooms Panel

### Default state
- All rooms collapsed on load, always. No last-edited state tracking.
- **Exception:** if the project has exactly one room, auto-expand it on load.

### Collapsed room card (~48px)
Room name · floor area · ceiling height · unit assignment · cooling/heating BTU result (if calculated). Drag handle for reordering.

### Expanded room
All room fields + component list.

### Component entry
- Single **+ Add Component** button (replaces separate Add Wall / Add Glass / etc. buttons).
- Opens an assembly picker: user selects from defined Envelope Assemblies (W1, G1, C1, etc.). Category, direction defaults, and area field pre-populate based on the assembly selection.
- **Desktop:** components displayed as a table inside the expanded room.
- **Mobile:** components displayed as cards. Tapping a card opens an inline form or bottom sheet for editing.

---

## 4. Envelope Assemblies Panel

- Renamed from "Types" / "Type Inputs" throughout the UI.
- Nav label and panel heading: **Envelope Assemblies**.
- No behavioral changes in this redesign; label change only.

---

## 5. Load Summary — Mobile View

On narrow viewports (mobile), the Load Summary section shows a reduced view:
- Tonnage per unit
- Airflow (CFM) per unit

Full room-level breakdown table is desktop/tablet only.

---

## 6. File Exports

- All export buttons (Airflow Sheet, PDF Report) use direct `<a href="..." download>` endpoint links, not fetch-then-blob.
- On iOS Safari: triggers native share sheet. Techs choose Numbers, Excel, Files, etc.
- On desktop: triggers normal browser file download.
- No behavioral difference to the user on desktop; more reliable on iOS.

---

## 7. Platform & Offline (see also ADR 0003)

- **Stage 1:** PWA manifest + service worker. Airflow wizard route cached for offline (best-effort on iOS).
- **Stage 2:** Capacitor wrap for unconditional offline reliability. Zero UI changes at migration.
- Do not use `alert()` / `confirm()` — use React modal components throughout.

---

## Open items (not yet designed)

- Airflow balancing wizard UI (mobile-first, phone screen, reading collection flow)
- Exact visual design system (colors, typography, component library choice)
- Admin panel responsive behavior
- Room merge UI (planned feature)
- Import fidelity badge display after PDF import
