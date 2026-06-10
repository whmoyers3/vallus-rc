# Handoff — Airflow Balancing Wizard (web tool)

## What this session is for

Build a room-by-room field data-entry wizard that opens in a new browser tab, walks a technician through entering CFM readings and checklist items, and produces a pre-filled version of the existing airflow balancing spreadsheet for download (xlsx + PDF). This is a new feature layered on top of the already-working `POST /api/export/airflow` endpoint.

---

## Project

`/Users/will/Documents/Claude/Projects/WEBAPP - Load Calculation Software`

Read these first:
- `CLAUDE.md` — stack, key files
- `CONTEXT.md` → "Airflow Balancing Export" section — canonical glossary
- `backend/api/airflow_export.py` — the existing xlsx generation pipeline you'll extend
- `frontend/src/main.tsx` — the single-file React frontend (hash-based routing, ~3900 lines)

---

## Architecture: new-tab wizard via localStorage handoff

### Flow

1. Engineer is in the VRC app with a calculated draft. They open the **Export ▾** menu and click **Airflow Wizard…**.
2. Frontend calls `POST /api/airflow/prepare` with the current payload. Backend runs the 8-orientation engine loop and returns the pre-computed orientation table + unit/room groupings as JSON (same data that normally goes into the hidden Ref sheet). No xlsx is built here — this is data only.
3. Frontend stores the returned JSON in `localStorage` under the key `vrc-wizard-<timestamp>`. Then calls `window.open('/#/airflow-wizard?session=<timestamp>', '_blank')`.
4. The new tab loads the same SPA. The hash router sees `/#/airflow-wizard` and renders the `<AirflowWizard>` component. The component reads `vrc-wizard-<timestamp>` from localStorage and has everything it needs — no auth, no additional network calls.
5. Tech enters all readings. On the final screen they click **Download .xlsx** or **Download PDF**.
6. Download: frontend POSTs the original payload **plus** wizard readings to `POST /api/export/airflow`. Backend builds the xlsx with reading cells pre-filled. For PDF, a new endpoint `POST /api/export/airflow/pdf` does the same then runs LibreOffice headless to convert.

### Why this approach

- Works on unsaved draft (same realm as the current Export button — no save required).
- The new tab has full-screen depth with no app chrome — identical UX to a standalone page.
- No auth complexity: localStorage is same-origin, no token needed.
- Later evolution: instead of localStorage, POST the prepare response to a DB and open a shareable URL the engineer can text to the field tech. The wizard code doesn't change — only the data-loading step does.

---

## Backend changes

### 1. New endpoint: `POST /api/airflow/prepare`

File: `backend/api/app.py`

```python
@app.post("/api/airflow/prepare")
async def prepare_airflow_wizard(payload: dict):
    """Pre-compute 8-orientation table + unit groupings for the wizard.
    
    Returns JSON, not an xlsx. The wizard stores this in localStorage
    and uses it to display per-room load targets as the tech enters readings.
    """
    from backend.api.airflow_export import _orientation_table, _group_units, _plan_label
    
    table = _orientation_table(payload)       # room -> orient -> {Cool, Heat, Avg}
    units = _group_units(payload)             # [{id, name, rooms, zone_order, zone_names, selected_tons}]
    
    meta = payload["project"].get("metadata") or {}
    return {
        "orientation_table": table,
        "units": units,
        "plan_label": _plan_label(payload),
        "address": meta.get("address") or "",
        "default_orientation": meta.get("front_door_faces") or "S",
        "payload": payload,   # echoed back so wizard can POST it with readings for download
    }
```

This endpoint must be **fast** — it runs 8 × calculate_project calls, same as the existing export. No change in cost, just separating it from xlsx generation.

### 2. Extend `POST /api/export/airflow` to accept pre-filled readings

File: `backend/api/airflow_export.py`

Add an optional `readings` key to the payload the endpoint accepts. When present, `_build_unit_sheet` pre-fills the reading cells (columns B–E) instead of leaving them blank.

Reading data shape:
```json
{
  "supply": {
    "<unit_id>": {
      "<room_name>": [cfm1, cfm2, cfm3, cfm4]  // up to 4 readings (cols B-E)
    }
  },
  "return": {
    "<unit_id>": [
      {"name": "Living Room", "readings": [210, 215, 0]}  // 3 readings (cols B-D)
    ]
  },
  "static_pressure": {
    "<unit_id>": {
      "supply_esp": 0.42,
      "return_esp": 0.38,
      "before_filter": 0.15,
      "filter_type": "16x25 MERV 8"
    }
  },
  "checklist": {
    "<unit_id>": {
      "size_match": "y",
      "total_airflow": "y",
      "room_room": "n",
      "strip_check": "y",
      "cool_check": "y",
      "zone_check": "y"
    }
  }
}
```

In `build_airflow_workbook`, extract `readings = payload.pop("readings", None)` before calling the sub-functions, then thread it through to `_build_unit_sheet`.

In `_build_unit_sheet`: for supply rows, if `readings["supply"][unit_id][room_name]` exists, write the values into cells B–E (up to 4 values). For return, static pressure, and checklist, write the corresponding values if present.

### 3. New endpoint: `POST /api/export/airflow/pdf`

File: `backend/api/app.py`

```python
@app.post("/api/export/airflow/pdf")
async def export_airflow_pdf(payload: dict):
    import subprocess, tempfile, os
    xlsx_bytes, xlsx_filename = build_airflow_workbook(payload)
    with tempfile.TemporaryDirectory() as tmpdir:
        xlsx_path = os.path.join(tmpdir, xlsx_filename)
        with open(xlsx_path, "wb") as f:
            f.write(xlsx_bytes)
        subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "pdf", "--outdir", tmpdir, xlsx_path],
            check=True, capture_output=True
        )
        pdf_path = xlsx_path.replace(".xlsx", ".pdf")
        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()
    pdf_filename = xlsx_filename.replace(".xlsx", ".pdf")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{pdf_filename}"'}
    )
```

Verify LibreOffice is available in the Vercel environment. If not, note it in the handoff for the next session — the xlsx download works without it.

---

## Frontend changes

### 1. New state + handler in `main.tsx`

Near the existing `exportAirflowSheet` function (around line 1263), add:

```typescript
async function startAirflowWizard() {
  setExportLoading(true);
  try {
    const response = await fetch("/api/airflow/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(project, assemblies))
    });
    if (!response.ok) throw new Error("Wizard preparation failed.");
    const data = await response.json();
    const key = `vrc-wizard-${Date.now()}`;
    localStorage.setItem(key, JSON.stringify(data));
    window.open(`/#/airflow-wizard?session=${key}`, "_blank");
  } catch (error) {
    setValidationMessage(error instanceof Error ? error.message : "Could not start wizard.");
  } finally {
    setExportLoading(false);
  }
}
```

### 2. Export menu update

Replace the current Export ▾ popover items with a split that adds the wizard option alongside the existing direct download:

```tsx
{showExportMenu && (
  <div className="toolbar-menu-popover" onMouseLeave={() => setShowExportMenu(false)}>
    <button onClick={() => { setShowExportMenu(false); startAirflowWizard(); }} disabled={exportLoading}>
      Airflow Wizard…
    </button>
    {projectId ? (
      <a className="button" href={`/api/projects/${projectId}/airflow`} onClick={() => setShowExportMenu(false)}>
        Airflow Sheet (direct)
      </a>
    ) : (
      <button onClick={() => { setShowExportMenu(false); exportAirflowSheet(); }}>
        {exportLoading ? "Exporting…" : "Airflow Sheet (direct)"}
      </button>
    )}
    {projectId && (
      <a className="button" href={`/api/projects/${projectId}/report`} onClick={() => setShowExportMenu(false)}>PDF Report</a>
    )}
  </div>
)}
```

Add the same "Airflow Wizard…" item to the mobile action sheet (around line 1831).

### 3. Hash router: add `/#/airflow-wizard` route

The app currently has `/#/admin`. Find where that routing is handled (search for `/#/admin` or `window.location.hash`) and add the wizard route. The wizard should render in place of the main app layout — full screen, no sidebar, no header toolbar.

### 4. New component: `<AirflowWizard>`

This is the main work. Build it as a standalone React component at the bottom of `main.tsx` (or in a new file `frontend/src/AirflowWizard.tsx` imported into `main.tsx` — your call given the existing single-file pattern).

---

## Wizard UX spec

### Data loading (on mount)

```typescript
const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
const key = params.get("session");
const session = JSON.parse(localStorage.getItem(key!) ?? "null");
// session shape: { orientation_table, units, plan_label, address, default_orientation, payload }
```

If `session` is null: show "Session expired — close this tab and re-open the wizard."

### State

```typescript
// Per-unit, per-room supply readings (4 slots)
type SupplyReadings = Record<string, Record<string, [number|"", number|"", number|"", number|""]>>;
// Per-unit return readings
type ReturnEntry = { name: string; readings: [number|"", number|"", number|""] };
// Per-unit static pressure
type StaticPressure = { supply_esp: number|""; return_esp: number|""; before_filter: number|""; filter_type: string };
// Per-unit checklist
type Checklist = Record<string, "y"|"n"|"">;

const [orientation, setOrientation] = useState(session.default_orientation);
const [basis, setBasis] = useState<"Avg"|"Cool"|"Heat">("Avg");
const [step, setStep] = useState<"supply"|"return"|"static"|"checklist"|"review">("supply");
const [currentUnit, setCurrentUnit] = useState(0);
const [currentRoom, setCurrentRoom] = useState(0);
const [supplyReadings, setSupplyReadings] = useState<SupplyReadings>({});
const [returnEntries, setReturnEntries] = useState<Record<string, ReturnEntry[]>>({});
const [staticPressure, setStaticPressure] = useState<Record<string, StaticPressure>>({});
const [checklist, setChecklist] = useState<Record<string, Checklist>>({});
```

### Navigation structure

The wizard has 5 phases, in order:

1. **Supply readings** — one room at a time, scrollable overview below
2. **Return air** — one room-row at a time (manual name + 3 readings)
3. **Static pressure** — single screen per unit
4. **Go/No-Go checklist** — 6 items, tap y or n
5. **Review + Download** — summary table, download buttons

Progress bar across the top. Back/Next buttons at the bottom. Room name and unit name always visible.

### Phase 1 — Supply readings (room by room)

For each room in the current unit:

**Top sticky bar** (collapsible, same concept as the prototype):
- Unit name, plan label, orientation dropdown (N/NE/E/.../NW), basis toggle (Avg / Cool / Heat)
- When orientation or basis changes, the target CFM shown for each room recalculates live from `session.orientation_table[roomName][orientation][basis]`

**Room card**:
```
[Room Name]
Target: 214 CFM    (from orientation_table[room][orientation][basis])

Reading 1: [____]   Reading 2: [____]
Reading 3: [____]   Reading 4: [____]

Total: 210 CFM      Δ: -4 CFM  (-2%)
```

- `font-size: 16px` on all inputs (prevents iOS Safari auto-zoom)
- Number pad input (`inputMode="decimal"`)
- Total and delta computed live as readings change
- Δ shown green if within ±10%, red if outside
- "Next Room →" button advances; at last room, moves to return phase

**Overview panel** (always visible, below the room card, scrollable):
- Table: Room | Total | Target | Δ | %
- Rows are tappable to jump to that room
- Completed rooms show green checkmark; current room highlighted

### Phase 2 — Return air

8 blank rows (matches the spreadsheet). Each row:
```
Room Name: [_________]
Return readings: [____]  [____]  [____]   Total: 0
```
Tech fills in room names manually (same as the spreadsheet — blank by default).

### Phase 3 — Static pressure

Single screen per unit:
```
Supply ESP:    [____] in. w.c.
Return ESP:    [____] in. w.c.
Before Filter: [____] in. w.c.

Filter Type:   [________________]

─────────────────────────────────
Total ESP:     (auto: |return| + |supply|)
Filter Drop:   (auto: |before filter| - |return|)
```

### Phase 4 — Checklist

6 items, large tap targets:
```
Size Match          [Y]  [N]  [ ]
Total Airflow       [Y]  [N]  [ ]
Room-Room           [Y]  [N]  [ ]
Strip Check         [Y]  [N]  [ ]
Cool Check          [Y]  [N]  [ ]
Zone Check          [Y]  [N]  [ ]
```

Y/N are toggle buttons. Blank = not yet answered (shown in gray).

### Phase 5 — Review + Download

Summary table showing all rooms with readings, total, target, and delta. Static pressure summary. Checklist summary.

Two download buttons:
```
[ Download .xlsx ]   [ Download PDF ]
```

**Download .xlsx**:
```typescript
async function downloadXlsx() {
  const payload = {
    ...session.payload,
    readings: buildReadingsPayload()  // assembles supplyReadings, returnEntries, staticPressure, checklist
  };
  const response = await fetch("/api/export/airflow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  // same blob-download logic as existing exportAirflowSheet()
}
```

**Download PDF**: same but POST to `/api/export/airflow/pdf`.

### Mobile considerations

- `font-size: 16px !important` on all `<input>` and `<select>` — prevents iOS Safari zoom-on-focus
- `inputMode="decimal"` on number inputs
- Bottom navigation buttons use `padding-bottom: env(safe-area-inset-bottom, 16px)` for iPhone notch
- `autocomplete="off"` on all inputs
- Touch targets minimum 44×44px
- Orientation dropdown and basis toggle in the collapsible top bar persist across rooms (don't reset on room change)

---

## Multi-unit projects

If the project has more than one HVAC unit, the wizard handles each unit sequentially. After completing all phases for Unit 1, it moves to Unit 2 (same phases). Progress bar reflects total units × phases.

Keep it simple for v1: one unit at a time in series, no parallel entry.

---

## Styling

The wizard runs in a new tab with a clean white page — no sidebar, no main app toolbar. Use the same CSS variables and font as the main app (the stylesheet is loaded since it's the same SPA). Add a thin wizard-specific `<style>` block for the phases and room cards — don't add classes to the main stylesheet to keep things self-contained.

Look at the existing mobile styles in `frontend/src/styles.css` for variable names (colors, border-radius, font). The wizard should feel like the same app.

---

## Files to create / modify

| File | Change |
|------|--------|
| `backend/api/app.py` | Add `POST /api/airflow/prepare`, add `POST /api/export/airflow/pdf` |
| `backend/api/airflow_export.py` | Extend `build_airflow_workbook` + `_build_unit_sheet` to accept and write `readings` |
| `frontend/src/main.tsx` | Add `startAirflowWizard()`, update Export menu + mobile action sheet, add hash route `/#/airflow-wizard`, add `<AirflowWizard>` component |

---

## Implementation order

1. Backend: `POST /api/airflow/prepare` — test it returns correct JSON for Harvey Ranch
2. Backend: extend `build_airflow_workbook` to accept `readings` — write a unit test that verifies reading cells are pre-filled
3. Backend: `POST /api/export/airflow/pdf` — verify LibreOffice is available; if not, skip and note
4. Frontend: `startAirflowWizard()` + new-tab open + localStorage handoff
5. Frontend: `<AirflowWizard>` component, supply phase first (most important)
6. Frontend: return + static pressure + checklist phases
7. Frontend: review + download buttons
8. End-to-end test: Harvey Ranch, 2-unit project if available

---

## Reference: existing export prototype

The HTML prototype from the prior session is at:
```
frontend/prototype-airflow-sheet.html
```
The Wizard variant (V3) in that file is the approved UX model. The overview panel, collapsible top bar, room-by-room navigation, and live delta display are all there — adapt that logic to React.

The approved xlsx output shape is in:
```
Harvey_Ranch_Airflow_PROTO.xlsx
```
Open it to verify column layout and cell positions before modifying `airflow_export.py`.
