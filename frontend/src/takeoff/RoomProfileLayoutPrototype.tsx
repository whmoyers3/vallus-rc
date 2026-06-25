import React, { useEffect, useMemo, useState } from "react";

// PROTOTYPE - throwaway layout study for the Takeoff room profile center section.

type SurfaceTab = "Floor" | "Ceiling" | "Walls" | "Glass" | "Door";
type SuggestionStatus = "pending" | "accepted" | "dismissed";
type SurfaceFilters = Record<SurfaceTab, boolean>;
type CeilingShape = "Flat / taller flat" | "Vaulted" | "No ceiling load";
type FloorMode = "Match room area" | "No floor load" | "Split floor";
type RoomTypeId = "Plain" | "Bedroom" | "Kitchen" | "Entertainment" | "Laundry";
type RoomTypeOverrides = Record<string, RoomTypeId>;
type SuggestionRowId = "garage-wall" | "exterior-wall";
type SuggestionRowsApplied = Record<SuggestionRowId, boolean>;

type PrototypeRoom = {
  id: string;
  name: string;
  type: RoomTypeId;
  floorSf: number;
  height: number;
  issue?: string;
  wallCount: number;
  glassCount: number;
  doorCount: number;
};

const surfaceTabs: SurfaceTab[] = ["Floor", "Ceiling", "Walls", "Glass", "Door"];
const roomTypeLabels: RoomTypeId[] = ["Plain", "Bedroom", "Kitchen", "Entertainment", "Laundry"];
const internalLoadRoomTypes = new Set<RoomTypeId>(["Bedroom", "Kitchen", "Entertainment", "Laundry"]);
const allSurfaceFilters: SurfaceFilters = {
  Floor: true,
  Ceiling: true,
  Walls: true,
  Glass: true,
  Door: true,
};
const emptySuggestionRowsApplied: SuggestionRowsApplied = {
  "garage-wall": false,
  "exterior-wall": false,
};

const rooms: PrototypeRoom[] = [
  { id: "laundry", name: "Laundry", type: "Laundry", floorSf: 69, height: 9, issue: "garage wall review", wallCount: 2, glassCount: 0, doorCount: 0 },
  { id: "wic", name: "WIC", type: "Plain", floorSf: 132, height: 9, issue: "2 wall suggestions", wallCount: 4, glassCount: 0, doorCount: 0 },
  { id: "owners-suite", name: "Owners Suite", type: "Bedroom", floorSf: 224, height: 9, issue: "tray ceiling note", wallCount: 2, glassCount: 4, doorCount: 0 },
  { id: "foyer", name: "Foyer", type: "Plain", floorSf: 233, height: 9, issue: "door split", wallCount: 3, glassCount: 0, doorCount: 2 },
  { id: "dining", name: "Dining Room", type: "Plain", floorSf: 117, height: 9, wallCount: 1, glassCount: 2, doorCount: 0 },
  { id: "kitchen", name: "Kitchen", type: "Kitchen", floorSf: 179, height: 9, wallCount: 0, glassCount: 0, doorCount: 0 },
  { id: "owners-bath", name: "Owners Bath", type: "Plain", floorSf: 128, height: 9, wallCount: 1, glassCount: 1, doorCount: 0 },
  { id: "family", name: "Family Room", type: "Entertainment", floorSf: 284, height: 9, wallCount: 2, glassCount: 3, doorCount: 0 },
  { id: "bed-2", name: "Bed 2", type: "Bedroom", floorSf: 143, height: 9, wallCount: 2, glassCount: 2, doorCount: 0 },
];

const planPreviewRooms: Array<{ id: string; points: string; fill: string }> = [
  { id: "family", points: "52,52 260,52 260,210 52,210", fill: "#d8eee8" },
  { id: "dining", points: "260,52 392,52 392,142 260,142", fill: "#eadff4" },
  { id: "owners-suite", points: "392,52 650,52 650,150 472,150 472,132 432,92", fill: "#f5e7cf" },
  { id: "kitchen", points: "260,142 432,142 472,184 472,296 260,296", fill: "#f7dfe3" },
  { id: "owners-bath", points: "472,150 650,150 650,270 560,270 560,230 472,230", fill: "#dff1f4" },
  { id: "wic", points: "560,270 650,270 650,392 472,392 472,296 560,296", fill: "#f4dfe7" },
  { id: "laundry", points: "392,296 472,296 472,392 392,392", fill: "#e8def3" },
  { id: "foyer", points: "260,296 392,296 392,392 336,392 336,356 260,356", fill: "#dcecfb" },
  { id: "bed-2", points: "52,278 204,278 204,392 52,392", fill: "#dff1e8" },
];

const surfaceRows: Record<SurfaceTab, Array<{ label: string; type: string; direction?: string; area: string; status: string }>> = {
  Floor: [
    { label: "F1", type: "Slab edge default", area: "132 sf", status: "balanced" },
  ],
  Ceiling: [
    { label: "C1", type: "Flat ceiling", area: "132 sf", status: "approved" },
  ],
  Walls: [
    { label: "W1", type: "Garage", direction: "S", area: "87 sf", status: "from suggestion" },
    { label: "W1", type: "Exterior", direction: "E", area: "146 sf", status: "assigned" },
  ],
  Glass: [
    { label: "G1", type: "Low-e window", direction: "E", area: "15 sf", status: "placed" },
  ],
  Door: [
    { label: "D1", type: "Exterior door", direction: "S", area: "21 sf", status: "placed" },
  ],
};

function roomById(id: string): PrototypeRoom {
  return rooms.find((room) => room.id === id) ?? rooms[0]!;
}

function RoomRail({
  selectedRoomId,
  onSelect,
  roomTypeOverrides = {},
  resolvedValidationTags = {},
  orientation = "horizontal",
}: {
  selectedRoomId: string;
  onSelect: (roomId: string) => void;
  roomTypeOverrides?: RoomTypeOverrides;
  resolvedValidationTags?: Record<string, boolean>;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div className={`proto-room-rail proto-room-rail--${orientation}`} aria-label="Rooms">
      {rooms.map((room) => {
        const roomType = roomTypeOverrides[room.id] ?? room.type;
        const hasInternalLoad = internalLoadRoomTypes.has(roomType);
        return (
          <button
            key={room.id}
            type="button"
            className={room.id === selectedRoomId ? "proto-room-card proto-room-card--selected" : "proto-room-card"}
            onClick={() => onSelect(room.id)}
          >
            <strong>{room.name}</strong>
            <span>{room.floorSf} floor sf</span>
            {hasInternalLoad && <em>{roomType}</em>}
            {room.issue && !resolvedValidationTags[room.id] && (
              <small className="proto-room-card-caution" aria-label={room.issue} title={room.issue}>!</small>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TypePopover({
  selectedRoom,
  onRoomType,
  onAction,
  open,
  onOpenChange,
}: {
  selectedRoom: PrototypeRoom;
  onRoomType: (roomType: RoomTypeId) => void;
  onAction: (message: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draftType, setDraftType] = useState<RoomTypeId>(selectedRoom.type);

  useEffect(() => {
    setDraftType(selectedRoom.type);
  }, [selectedRoom.id, selectedRoom.type]);

  return (
    <div className="proto-merge-popout">
      <button type="button" onClick={() => onOpenChange(!open)}>Type</button>
      {open && (
        <div className="proto-merge-menu proto-type-menu">
          <label>Room type<select value={draftType} onChange={(event) => setDraftType(event.target.value as RoomTypeId)}>
            {roomTypeLabels.map((type) => <option key={type}>{type}</option>)}
          </select></label>
          <p className="proto-popout-note">Only internal-gain room types from the calculator are shown here.</p>
          <div className="proto-action-row">
            <button
              type="button"
              className="toolbar-primary"
              onClick={() => {
                onRoomType(draftType);
                onAction(`${selectedRoom.name} room type set to ${draftType}.`);
                onOpenChange(false);
              }}
            >
              Apply
            </button>
            <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MergePopover({
  selectedRoom,
  mergeTargetId,
  onMergeTarget,
  onAction,
  open,
  onOpenChange,
}: {
  selectedRoom: PrototypeRoom;
  mergeTargetId: string;
  onMergeTarget: (roomId: string) => void;
  onAction: (message: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const targetRooms = rooms.filter((room) => room.id !== selectedRoom.id);
  const target = roomById(mergeTargetId === selectedRoom.id ? targetRooms[0]?.id ?? selectedRoom.id : mergeTargetId);
  return (
    <div className="proto-merge-popout">
      <button type="button" onClick={() => onOpenChange(!open)}>Merge</button>
      {open && (
        <div className="proto-merge-menu">
          <label>Merge selected room into<select value={target.id} onChange={(event) => onMergeTarget(event.target.value)}>
            {targetRooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
          </select></label>
          <div className="proto-action-row">
            <button
              type="button"
              className="toolbar-primary"
              onClick={() => {
                onAction(`${selectedRoom.name} queued to merge into ${target.name}.`);
                onOpenChange(false);
              }}
            >
              Merge
            </button>
            <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReconciliationPanel({
  open = true,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <section className="proto-subpanel proto-reconcile-panel">
      <button
        type="button"
        className="proto-section-toggle"
        onClick={() => onOpenChange?.(!open)}
      >
        <span>Wall / Opening Reconciliation</span>
        <strong>Net 212 sf</strong>
        {onOpenChange && <em>{open ? "Hide" : "Show"}</em>}
      </button>
      {open && (
        <>
          <div className="proto-reconcile">
            <div><span>Gross</span><strong>233 sf</strong></div>
            <div><span>Glass</span><strong>15 sf</strong></div>
            <div><span>Doors</span><strong>21 sf</strong></div>
            <div><span>Net wall</span><strong>212 sf</strong></div>
          </div>
          <div className="proto-reconcile-rows">
            <div><strong>S wall</strong><span>87 sf gross - 21 sf door = 66 sf net</span></div>
            <div><strong>E wall</strong><span>146 sf gross - 15 sf glass = 131 sf net</span></div>
          </div>
        </>
      )}
    </section>
  );
}

function ValidationReviewPanel({
  selectedRoom,
  status,
  onStatus,
  rowStatus,
  onApplyRow,
  onApplyAll,
}: {
  selectedRoom: PrototypeRoom;
  status: SuggestionStatus;
  onStatus: (status: SuggestionStatus) => void;
  rowStatus: SuggestionRowsApplied;
  onApplyRow: (rowId: SuggestionRowId) => void;
  onApplyAll: () => void;
}) {
  const allRowsApplied = Object.values(rowStatus).every(Boolean);
  if (!selectedRoom.issue || status === "accepted" || status === "dismissed" || allRowsApplied) return null;
  return (
    <section className="proto-validation-review">
      <header className="proto-validation-review-head">
        <div>
          <strong>Review suggestion</strong>
          <span>Suggested changes</span>
        </div>
        <em>Review</em>
      </header>
      <p>{selectedRoom.name} has suggested component assignments.</p>
      <div className="proto-validation-wall-list">
        <div className={rowStatus["garage-wall"] ? "proto-validation-wall-row proto-validation-wall-row--applied" : "proto-validation-wall-row"}>
          <div><strong>87 sf</strong><span>S wall · 9.7 lf x 9 ft · adjacent garage</span></div>
          <label>Treatment<select defaultValue="garage"><option value="garage">Garage wall</option><option value="outside">Exterior wall</option><option value="conditioned">Conditioned</option></select></label>
          <label>Assembly<select defaultValue="W1"><option>W1 - Above Grade 2x4 R-13 batt</option><option>W2 - Basement Concrete + 2x4 R-13 batt</option><option>W3 - Attic 2x6 R-19 batt</option></select></label>
          <button type="button" disabled={rowStatus["garage-wall"]} onClick={() => onApplyRow("garage-wall")}>
            {rowStatus["garage-wall"] ? "Applied" : "Apply"}
          </button>
        </div>
        <div className={rowStatus["exterior-wall"] ? "proto-validation-wall-row proto-validation-wall-row--applied" : "proto-validation-wall-row"}>
          <div><strong>146 sf</strong><span>E wall · 16.2 lf x 9 ft</span></div>
          <label>Treatment<select defaultValue="outside"><option value="outside">Exterior wall</option><option value="garage">Garage wall</option><option value="conditioned">Conditioned</option></select></label>
          <label>Assembly<select defaultValue="W1"><option>W1 - Above Grade 2x4 R-13 batt</option><option>W2 - Basement Concrete + 2x4 R-13 batt</option><option>W3 - Attic 2x6 R-19 batt</option></select></label>
          <button type="button" disabled={rowStatus["exterior-wall"]} onClick={() => onApplyRow("exterior-wall")}>
            {rowStatus["exterior-wall"] ? "Applied" : "Apply"}
          </button>
        </div>
      </div>
      <div className="proto-action-row">
        <button type="button" className="toolbar-primary" disabled={allRowsApplied} onClick={onApplyAll}>Apply all</button>
        <button type="button" onClick={() => onStatus("dismissed")}>Dismiss</button>
      </div>
    </section>
  );
}

function RoomTypeSuggestionPanel({
  selectedRoom,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  onAction: (message: string) => void;
}) {
  if (selectedRoom.type === "Plain") return null;
  return (
    <div className="proto-room-type-suggestion">
      <div>
        <strong>Room type suggestion</strong>
        <span>{selectedRoom.name} reads like a {selectedRoom.type.toLowerCase()} space with internal gains.</span>
      </div>
      <div className="proto-action-row">
        <button type="button" className="toolbar-primary" onClick={() => onAction("Room type suggestion accepted.")}>Use {selectedRoom.type}</button>
        <button type="button" onClick={() => onAction("Room type suggestion dismissed.")}>Keep Plain</button>
      </div>
    </div>
  );
}

function ComponentTabs({
  selectedRoom,
  surfaceFilters,
  addSurface,
  onToggleSurface,
  onSetAllSurfaces,
  onAddSurface,
  addDrawerOpen,
  onAddDrawerOpen,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  surfaceFilters: SurfaceFilters;
  addSurface: SurfaceTab;
  onToggleSurface: (surface: SurfaceTab) => void;
  onSetAllSurfaces: () => void;
  onAddSurface: (surface: SurfaceTab) => void;
  addDrawerOpen: boolean;
  onAddDrawerOpen: (open: boolean) => void;
  onAction: (message: string) => void;
}) {
  const allSelected = surfaceTabs.every((surface) => surfaceFilters[surface]);
  const roomArea = selectedRoom.floorSf;
  const addLabels: Record<SurfaceTab, string> = {
    Floor: "add floor",
    Ceiling: "add ceiling component",
    Walls: "add wall component",
    Glass: "add window",
    Door: "add door",
  };
  const assemblyOptions: Record<SurfaceTab, string[]> = {
    Floor: ["F2 - Slab on grade", "F1 - Framed R-19 batt"],
    Ceiling: ["C1 - Flat Ceiling R-30 blown", "C2 - Vaulted R-30 batt"],
    Walls: ["W1 - Above Grade 2x4 R-13 batt", "W2 - Basement Concrete + 2x4 R-13 batt", "W3 - Attic 2x6 R-19 batt"],
    Glass: ["G1 - Double Insulated All types"],
    Door: ["D1 - Exterior Door R-2", "D2 - Garage Door R-2.7"],
  };
  const addNeedsDirection = addSurface === "Walls" || addSurface === "Glass" || addSurface === "Door";
  const addLabel = addSurface === "Glass" ? "Window" : addSurface === "Door" ? "Door" : addSurface === "Ceiling" ? "Flat ceiling" : addSurface === "Floor" ? "Slab" : "Wall";
  const rows = [
    { surface: "Floor" as SurfaceTab, label: "F2", type: "Slab on grade", direction: "All", area: `${roomArea} sf`, status: "balanced" },
    { surface: "Ceiling" as SurfaceTab, label: "C1", type: "Flat Ceiling R-30 blown", direction: "All", area: `${roomArea} sf`, status: "balanced" },
    { surface: "Walls" as SurfaceTab, label: "W1", type: "Garage wall", direction: "S", area: "87 sf", status: "from suggestion" },
    { surface: "Walls" as SurfaceTab, label: "W1", type: "Exterior wall", direction: "E", area: "146 sf", status: "assigned" },
    { surface: "Glass" as SurfaceTab, label: "G1", type: "Window", direction: "E", area: "15 sf", status: "placed" },
    { surface: "Door" as SurfaceTab, label: "D1", type: "Door", direction: "S", area: "21 sf", status: "placed" },
  ].filter((row) => surfaceFilters[row.surface]);
  return (
    <section className="proto-panel proto-components">
      <div className="proto-panel-head">
        <h2>Load Components</h2>
        <div className="proto-component-actions">
          <div className="proto-tab-row">
            <button
              type="button"
              className={allSelected ? "toolbar-primary" : ""}
              aria-pressed={allSelected}
              onClick={onSetAllSurfaces}
            >
              All
            </button>
            {surfaceTabs.map((surface) => (
              <button
                key={surface}
                type="button"
                className={surfaceFilters[surface] ? "toolbar-primary" : ""}
                aria-pressed={surfaceFilters[surface]}
                onClick={() => onToggleSurface(surface)}
              >
                {surface}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="proto-component-list">
        {rows.length === 0 && (
          <div className="proto-component-empty">No component surfaces selected.</div>
        )}
        {rows.map((row, index) => (
          <div className="proto-component-row" key={`${row.surface}-${row.label}-${index}`}>
            <span>{row.surface}</span>
            <strong>{row.label}</strong>
            <span>{row.type}</span>
            <span>{row.direction}</span>
            <span>{row.area}</span>
            <em>{row.status}</em>
          </div>
        ))}
      </div>
      <div className="proto-component-add-footer">
        <button type="button" className="toolbar-primary" onClick={() => onAddDrawerOpen(!addDrawerOpen)}>
          {addDrawerOpen ? "Hide Add Component" : "Add Component"}
        </button>
      </div>
      {addDrawerOpen && (
        <div className={addNeedsDirection ? "proto-add-component-drawer" : "proto-add-component-drawer proto-add-component-drawer--no-direction"}>
          <label>Component type<select value={addSurface} onChange={(event) => onAddSurface(event.target.value as SurfaceTab)}>
            <option value="Glass">add window</option>
            <option value="Door">add door</option>
            <option value="Ceiling">add ceiling component</option>
            <option value="Walls">add wall component</option>
            <option value="Floor">add floor</option>
          </select></label>
          <label>Assembly<select defaultValue={assemblyOptions[addSurface][0]}>
            {assemblyOptions[addSurface].map((assembly) => <option key={assembly}>{assembly}</option>)}
          </select></label>
          {addNeedsDirection && (
            <label>Direction<select defaultValue={addSurface === "Glass" ? "E" : "S"}>
              <option>S</option>
              <option>E</option>
              <option>N</option>
              <option>W</option>
              <option>Shaded</option>
            </select></label>
          )}
          <label>Description<input defaultValue={addLabel} /></label>
          <label>Area<input defaultValue={addSurface === "Glass" ? "15" : addSurface === "Door" ? "21" : addSurface === "Ceiling" || addSurface === "Floor" ? roomArea : "87"} /></label>
          <button type="button" className="toolbar-primary" onClick={() => onAction(`Prototype added ${addSurface.toLowerCase()} component draft.`)}>
            {addLabels[addSurface]}
          </button>
        </div>
      )}
    </section>
  );
}

function FloorBlock({
  selectedRoom,
  floorMode,
  open,
  onOpenChange,
  onFloorMode,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  floorMode: FloorMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFloorMode: (mode: FloorMode) => void;
  onAction: (message: string) => void;
}) {
  const assignedFloorArea = floorMode === "No floor load" ? 0 : selectedRoom.floorSf;
  const balanced = assignedFloorArea === selectedRoom.floorSf;
  const toggleOpen = () => onOpenChange(!open);
  return (
    <section className="proto-subpanel proto-surface-block proto-floor-block">
      <header
        className="proto-section-toggle proto-ceiling-toggle"
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleOpen();
          }
        }}
      >
        <div>
          <h2>Floor</h2>
          <span className={balanced ? "proto-balance-chip" : "proto-balance-chip proto-balance-chip--warn"}>
            {assignedFloorArea} assigned / {selectedRoom.floorSf} balanced
          </span>
        </div>
        <div className="proto-ceiling-header-actions">
          <em>{open ? "Hide" : "Show"}</em>
        </div>
      </header>
      {open && (
        <div className="proto-surface-unified">
          <div className="proto-ceiling-controls-card">
            <div className="proto-ceiling-editor">
              <label>Floor treatment<select value={floorMode} onChange={(event) => onFloorMode(event.target.value as FloorMode)}>
                <option>Match room area</option>
                <option>No floor load</option>
                <option>Split floor</option>
              </select></label>
              <label>Assembly<select defaultValue="F2">
                <option>F2 - Slab None</option>
                <option>F1 - Framed R-19 batt</option>
              </select></label>
              <label>Component area<input value={`${assignedFloorArea} sf`} readOnly /></label>
            </div>
            <div className="proto-ceiling-actions">
              <button type="button" onClick={() => onFloorMode("Match room area")}>Match room area</button>
              <button type="button" onClick={() => onFloorMode("No floor load")}>No floor load</button>
              <button type="button" onClick={() => onFloorMode("Split floor")}>Split floor</button>
              <span>{floorMode === "Split floor" ? "Split floor areas pending" : floorMode}</span>
            </div>
            <div className="proto-overwrite-warning">
              <strong>Overwrite check</strong>
              <span>Changing floor treatment may replace existing floor components. Confirm before resetting prior floor rows.</span>
              <div className="proto-action-row">
                <button type="button" className="toolbar-primary" onClick={() => onAction("Floor component update queued for confirmation.")}>Update floor</button>
                <button type="button" onClick={() => onAction("Existing floor components preserved.")}>Keep existing rows</button>
              </div>
            </div>
          </div>
          <div className="proto-ceiling-preview-card">
            <RoomSketch room={selectedRoom} dense ceilingShape="No ceiling load" />
            <div className="proto-ceiling-component-summary">
              <div><span>Component</span><strong>{floorMode === "No floor load" ? "None" : "F2"}</strong><em>{floorMode}</em></div>
              <div><span>Surface</span><strong>{assignedFloorArea} sf</strong><em>{balanced ? "balanced" : "review"}</em></div>
              <div><span>Split</span><strong>{floorMode === "Split floor" ? "2 rows" : "0 rows"}</strong><em>draft</em></div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function CeilingBlock({
  selectedRoom,
  ceilingShape,
  ridgeOffset,
  open,
  onOpenChange,
  onCeilingShape,
  onRidgeOffset,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  ceilingShape: CeilingShape;
  ridgeOffset: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCeilingShape: (shape: CeilingShape) => void;
  onRidgeOffset: (offset: number) => void;
  onAction: (message: string) => void;
}) {
  const assignedCeilingArea = selectedRoom.floorSf;
  const balanced = assignedCeilingArea === selectedRoom.floorSf;
  const peakHeight = ceilingShape === "Vaulted" ? selectedRoom.height + 1 : selectedRoom.height;
  const moveRidge = (delta: number) => onRidgeOffset(Math.max(-40, Math.min(40, ridgeOffset + delta)));
  const toggleOpen = () => onOpenChange(!open);
  return (
    <section className="proto-subpanel proto-ceiling-block">
      <header
        className="proto-section-toggle proto-ceiling-toggle"
        role="button"
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleOpen();
          }
        }}
      >
        <div>
          <h2>Ceiling</h2>
          <span className={balanced ? "proto-balance-chip" : "proto-balance-chip proto-balance-chip--warn"}>
            {assignedCeilingArea} assigned / {selectedRoom.floorSf} balanced
          </span>
        </div>
        <div className="proto-ceiling-header-actions">
          <em>{open ? "Hide" : "Show"}</em>
        </div>
      </header>
      {open && (
        <div className="proto-ceiling-unified">
          <div className="proto-ceiling-controls-card">
            <div className="proto-ceiling-editor">
              <label>Ceiling height<input value={`${selectedRoom.height} ft`} readOnly /></label>
              <label>Ceiling shape<select value={ceilingShape} onChange={(event) => onCeilingShape(event.target.value as CeilingShape)}>
                <option>Flat / taller flat</option>
                <option>Vaulted</option>
                <option>No ceiling load</option>
              </select></label>
              <label>Assembly<select defaultValue={ceilingShape === "Vaulted" ? "C2" : "C1"}>
                <option>C1 - Flat Ceiling R-30 blown</option>
                <option>C2 - Vaulted R-30 batt</option>
              </select></label>
              <label>Component area<input value={`${assignedCeilingArea} sf`} readOnly /></label>
              <label>Plan dimensions<input value="10 x 13 ft" readOnly /></label>
              <label>Low / peak<input value={`${selectedRoom.height} / ${peakHeight} ft`} readOnly /></label>
              <label className="proto-ridge-field">Ridge alignment
                <input type="range" min="-40" max="40" value={ridgeOffset} onChange={(event) => onRidgeOffset(Number(event.target.value))} />
              </label>
            </div>
            <div className="proto-ceiling-actions">
              <button type="button" onClick={() => onAction(`Ceiling area set to ${selectedRoom.floorSf} sf.`)}>Match room area</button>
              <button type="button" onClick={() => onAction("Ceiling load removed.")}>No ceiling load</button>
              <button type="button" onClick={() => onCeilingShape("Vaulted")}>Add ceiling geometry</button>
              <div className="proto-ridge-buttons">
                <button type="button" onClick={() => moveRidge(-10)}>Move left</button>
                <button type="button" onClick={() => onRidgeOffset(0)}>Center</button>
                <button type="button" onClick={() => moveRidge(10)}>Move right</button>
              </div>
              <span>{ridgeOffset === 0 ? "Centered ridge" : `${ridgeOffset > 0 ? "+" : ""}${ridgeOffset}% ridge offset`}</span>
            </div>
            <div className="proto-overwrite-warning">
              <strong>Overwrite check</strong>
              <span>Changing ceiling geometry may replace existing ceiling components. Confirm before resetting prior floor or ceiling rows.</span>
              <div className="proto-action-row">
                <button type="button" className="toolbar-primary" onClick={() => onAction("Ceiling geometry update queued for confirmation.")}>Update ceiling</button>
                <button type="button" onClick={() => onAction("Existing ceiling components preserved.")}>Keep existing rows</button>
              </div>
            </div>
          </div>
          <div className="proto-ceiling-preview-card">
            <RoomSketch room={selectedRoom} dense ceilingShape={ceilingShape} ridgeOffset={ridgeOffset} showRidgeGuide />
            <div className="proto-ceiling-component-summary">
              <div><span>Component</span><strong>C1</strong><em>{ceilingShape}</em></div>
              <div><span>Surface</span><strong>{assignedCeilingArea} sf</strong><em>{balanced ? "balanced" : "review"}</em></div>
              <div><span>Added exposure</span><strong>{ceilingShape === "Vaulted" ? "24 sf" : "0 sf"}</strong><em>estimated</em></div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function GeometryFooter({ selectedRoom }: { selectedRoom: PrototypeRoom }) {
  return (
    <p className="proto-geometry-footer">
      Geometry {selectedRoom.floorSf} sf · Volume {Math.round(selectedRoom.floorSf * selectedRoom.height)} cu ft
    </p>
  );
}

function RoomSketch({
  room,
  dense = false,
  ceilingShape = "Flat / taller flat",
  ridgeOffset = 0,
  showRidgeGuide = false,
}: {
  room: PrototypeRoom;
  dense?: boolean;
  ceilingShape?: CeilingShape;
  ridgeOffset?: number;
  showRidgeGuide?: boolean;
}) {
  const showRidge = ceilingShape === "Vaulted";
  const renderRidge = showRidge || showRidgeGuide;
  const ridgeX = 168 + ridgeOffset * 0.7;
  return (
    <div className={dense ? "proto-sketch proto-sketch--dense" : "proto-sketch"}>
      <svg viewBox="0 0 320 220" role="img" aria-label={`${room.name} component sketch`}>
        <polygon className="proto-sketch-floor" points="58,158 210,170 278,132 130,118" />
        <polygon className="proto-sketch-ceiling" points="58,64 210,76 278,38 130,24" />
        <polygon className="proto-sketch-wall proto-sketch-wall--load" points="210,76 278,38 278,132 210,170" />
        <polygon className="proto-sketch-wall proto-sketch-wall--garage" points="58,64 130,24 130,118 58,158" />
        <rect className="proto-sketch-window" x="237" y="73" width="20" height="40" />
        <rect className="proto-sketch-door" x="80" y="104" width="24" height="54" />
        {renderRidge && (
          <g className={showRidge ? "proto-sketch-ridge" : "proto-sketch-ridge proto-sketch-ridge--guide"}>
            <line x1={ridgeX - 42} y1="48" x2={ridgeX + 42} y2="56" />
            <circle cx={ridgeX} cy="52" r="4" />
            <text x={ridgeX} y="68">{showRidge ? ridgeOffset === 0 ? "ridge" : `${ridgeOffset > 0 ? "+" : ""}${ridgeOffset}%` : "ridge guide"}</text>
          </g>
        )}
        <g className="proto-sketch-labels">
          <text className="proto-surface-label" x="168" y="50" transform="rotate(4 168 50)">C1</text>
          <text className="proto-surface-label" x="116" y="148" transform="rotate(4 116 148)">F1</text>
          <text className="proto-surface-label proto-surface-label--wall" x="244" y="108" textLength={44} lengthAdjust="spacingAndGlyphs">W1 ext</text>
          <text className="proto-surface-label proto-surface-label--wall" x="94" y="101" textLength={42} lengthAdjust="spacingAndGlyphs" transform="rotate(-28 94 101)">W1 gar</text>
          <text className="proto-surface-label proto-surface-label--opening" x="247" y="96">G1</text>
          <text className="proto-surface-label proto-surface-label--opening" x="92" y="132">D1</text>
        </g>
      </svg>
    </div>
  );
}

function ProfileHeader({
  selectedRoom,
  mergeTargetId,
  onMergeTarget,
  mergeOpen,
  onMergeOpenChange,
  typeOpen,
  onTypeOpenChange,
  onRoomType,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  mergeTargetId?: string;
  onMergeTarget?: (roomId: string) => void;
  mergeOpen?: boolean;
  onMergeOpenChange?: (open: boolean) => void;
  typeOpen?: boolean;
  onTypeOpenChange?: (open: boolean) => void;
  onRoomType?: (roomType: RoomTypeId) => void;
  onAction?: (message: string) => void;
}) {
  const canMerge = mergeTargetId && onMergeTarget && onMergeOpenChange && onAction;
  const canChangeType = onRoomType && onTypeOpenChange && onAction;
  return (
    <div className="proto-profile-head">
      <div>
        <div className="proto-title-actions">
          <button
            type="button"
            className="proto-room-name-button"
            onClick={() => onAction?.(`${selectedRoom.name} name editor opened.`)}
          >
            {selectedRoom.name}
          </button>
          {canMerge && (
            <MergePopover
              selectedRoom={selectedRoom}
              mergeTargetId={mergeTargetId}
              onMergeTarget={onMergeTarget}
              open={Boolean(mergeOpen)}
              onOpenChange={onMergeOpenChange}
              onAction={onAction}
            />
          )}
          {canChangeType && (
            <TypePopover
              selectedRoom={selectedRoom}
              open={Boolean(typeOpen)}
              onOpenChange={onTypeOpenChange}
              onRoomType={onRoomType}
              onAction={onAction}
            />
          )}
        </div>
        <span>{selectedRoom.floorSf} sf · {selectedRoom.type} · {selectedRoom.height} ft ceiling</span>
      </div>
      <div className="proto-counts">
        <span>{selectedRoom.wallCount} walls</span>
        <span>{selectedRoom.glassCount} glass</span>
        <span>{selectedRoom.doorCount} doors</span>
      </div>
    </div>
  );
}

function PrototypeLeftRail() {
  return (
    <>
      <details className="takeoff-panel takeoff-left-details" open>
        <summary>
          Project
          <button className="takeoff-icon-button" type="button">Hide</button>
        </summary>
        <label>Name<input defaultValue="Langford Plan" /></label>
        <label>Location<input defaultValue="Atlanta, GA" /></label>
        <label>Floor<input defaultValue="First Floor" /></label>
        <label>Front<select defaultValue="S"><option>S</option><option>SE</option><option>E</option></select></label>
        <label>Default ceiling height ft<input type="number" defaultValue={9} /></label>
      </details>
      <details className="takeoff-panel takeoff-left-details">
        <summary>Mode</summary>
        <div className="takeoff-segmented">
          <button type="button" className="toolbar-primary">Trace PDF</button>
          <button type="button">Sketch from grid</button>
        </div>
      </details>
      <details className="takeoff-panel takeoff-left-details">
        <summary>Import Scale</summary>
        <p className="takeoff-muted">Scale 2.03475x applied from saved drawing.</p>
      </details>
      <details className="takeoff-panel takeoff-left-details">
        <summary>Exterior Trace</summary>
        <p className="takeoff-muted">Exterior perimeter is traced and assigned.</p>
      </details>
      <details className="takeoff-panel takeoff-left-details">
        <summary>Advanced Grid &amp; Footprint</summary>
        <p className="takeoff-muted">Grid width, depth, feet per grid, snap inches, and fallback footprint settings.</p>
      </details>
    </>
  );
}

function PrototypePlanStage({
  selectedRoomId,
  onSelectRoom,
}: {
  selectedRoomId: string;
  onSelectRoom: (roomId: string) => void;
}) {
  return (
    <section className="takeoff-stage-panel proto-plan-stage">
      <div className="takeoff-stage-head">
        <div>
          <h2>Plan Grid</h2>
          <p>1754 sf conditioned footprint · scale 2.03475x</p>
        </div>
        <div className="takeoff-stage-actions">
          <div className="takeoff-stats">
            <span>11 rooms</span>
            <span>1754 assigned</span>
            <span>2 open</span>
          </div>
          <div className="takeoff-stage-tools">
            <button type="button">Fit Grid</button>
            <button type="button">Fit Plan</button>
            <button type="button">Max Zoom</button>
            <div className="takeoff-zoom-group">
              <button type="button">-</button>
              <span>100%</span>
              <button type="button">+</button>
            </div>
            <div className="takeoff-review-mode-group">
              <button type="button" className="toolbar-primary">Plan</button>
              <button type="button">Floor</button>
              <button type="button">Ceiling</button>
              <button type="button">Walls</button>
              <button type="button">3D QA</button>
            </div>
          </div>
        </div>
      </div>
      <div className="takeoff-mode-guidance takeoff-mode-guidance--neutral">
        <div>
          <strong>Trace mode enabled</strong>
          <span>Draw or edit the exterior, rooms, adjacent spaces, and openings. Validation will guide you to missing wall or opening assignments.</span>
        </div>
      </div>
      <div className="proto-plan-preview" aria-label="Plan grid preview">
        <svg viewBox="0 0 700 430" role="img" aria-label="Simplified traced floor plan">
          <defs>
            <pattern id="proto-plan-grid" width="18" height="18" patternUnits="userSpaceOnUse">
              <path d="M 18 0 L 0 0 0 18" fill="none" stroke="#d7e2ea" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="700" height="430" fill="url(#proto-plan-grid)" />
          <path className="proto-plan-outline" d="M52 52 H650 V392 H472 V296 H392 V392 H52 V52 Z" />
          {planPreviewRooms.map((room) => {
            const roomInfo = roomById(room.id);
            const selected = selectedRoomId === room.id;
            return (
              <g key={room.id} role="button" tabIndex={0} onClick={() => onSelectRoom(room.id)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRoom(room.id);
                }
              }}>
                <polygon className={selected ? "proto-plan-room proto-plan-room--selected" : "proto-plan-room"} points={room.points} fill={room.fill} />
                <text className="proto-plan-room-name" x={room.id === "owners-suite" ? 540 : room.id === "family" ? 156 : room.id === "kitchen" ? 352 : room.id === "wic" ? 560 : room.id === "laundry" ? 432 : room.id === "foyer" ? 326 : room.id === "bed-2" ? 128 : 326} y={room.id === "owners-suite" ? 100 : room.id === "family" ? 132 : room.id === "kitchen" ? 218 : room.id === "wic" ? 344 : room.id === "laundry" ? 344 : room.id === "foyer" ? 334 : room.id === "bed-2" ? 344 : 98}>{roomInfo.name}</text>
                <text className="proto-plan-room-area" x={room.id === "owners-suite" ? 540 : room.id === "family" ? 156 : room.id === "kitchen" ? 352 : room.id === "wic" ? 560 : room.id === "laundry" ? 432 : room.id === "foyer" ? 326 : room.id === "bed-2" ? 128 : 326} y={room.id === "owners-suite" ? 122 : room.id === "family" ? 154 : room.id === "kitchen" ? 240 : room.id === "wic" ? 366 : room.id === "laundry" ? 366 : room.id === "foyer" ? 356 : room.id === "bed-2" ? 366 : 120}>{roomInfo.floorSf} sf</text>
              </g>
            );
          })}
          <rect className="proto-plan-adjacent" x="472" y="392" width="178" height="24" />
          <text className="proto-plan-adjacent-label" x="560" y="409">Garage 1</text>
        </svg>
      </div>
    </section>
  );
}

function PrototypeRightRail({
  selectedRoom,
  resolvedValidationTags,
  onFocusValidation,
  onAction,
}: {
  selectedRoom: PrototypeRoom;
  resolvedValidationTags: Record<string, boolean>;
  onFocusValidation: (roomId: string) => void;
  onAction: (message: string) => void;
}) {
  const validationRooms = rooms.filter((room) => room.issue && !resolvedValidationTags[room.id]);
  return (
    <>
      <section className="takeoff-panel takeoff-export-panel">
        <div className="takeoff-panel-head">
          <h2>Export</h2>
          <button className="takeoff-icon-button" type="button">Hide</button>
        </div>
        <div className="takeoff-form-actions">
          <button type="button">Takeoff JSON</button>
          <button type="button">Payload JSON</button>
          <button type="button">Diagnostic Report JSON</button>
        </div>
      </section>
      <details className="takeoff-panel takeoff-right-details">
        <summary>Drawing Tools</summary>
        <div className="takeoff-form-actions">
          <button type="button">Draw Rect</button>
          <button type="button">Draw Polygon</button>
          <button type="button">Subtract</button>
        </div>
      </details>
      <details className="takeoff-panel takeoff-right-details">
        <summary>Adjacent Spaces</summary>
        <p className="takeoff-muted">Garage and covered porch regions are available for wall-treatment review.</p>
      </details>
      <details className="takeoff-panel takeoff-right-details">
        <summary>Openings</summary>
        <div className="takeoff-form-actions takeoff-openings-actions">
          <button type="button">Place Opening</button>
          <button type="button">Component Schedule</button>
        </div>
      </details>
      <section className="takeoff-panel proto-right-sketch">
        <div className="takeoff-panel-head">
          <h2>Room Load Sketch</h2>
          <button type="button" onClick={() => onAction("Room sketch rotated 90 degrees.")}>Rotate 90</button>
        </div>
        <RoomSketch room={selectedRoom} dense ceilingShape="Flat / taller flat" />
        <p className="takeoff-muted">Colored panels are assigned load components.</p>
      </section>
      <section className="takeoff-panel">
        <div className="takeoff-panel-head">
          <h2>Validation</h2>
        </div>
        {validationRooms.length > 0 ? (
          <div className="takeoff-issue-list">
            {validationRooms.map((room) => (
              <button
                key={room.id}
                type="button"
                className={`takeoff-issue takeoff-issue--warning takeoff-issue--clickable ${selectedRoom.id === room.id ? "takeoff-issue--active" : ""}`}
                onClick={() => onFocusValidation(room.id)}
              >
                {room.name} has {room.issue}.
              </button>
            ))}
          </div>
        ) : (
          <p className="takeoff-ok">Ready for payload preview.</p>
        )}
      </section>
    </>
  );
}

function WorkbenchVariant(props: VariantProps) {
  const { selectedRoom, selectedRoomId, setSelectedRoomId, roomTypeOverrides, resolvedValidationTags, setSelectedRoomType, mergeTargetId, setMergeTargetId, mergePopoverOpen, setMergePopoverOpen, typePopoverOpen, setTypePopoverOpen, floorOpen, setFloorOpen, floorMode, setFloorMode, ceilingOpen, setCeilingOpen, reconciliationOpen, setReconciliationOpen, surfaceFilters, addSurface, toggleSurfaceFilter, setAllSurfaceFilters, setAddSurface, ceilingShape, ridgeOffset, setCeilingShape, setRidgeOffset, suggestionStatus, setSuggestionStatus, suggestionRowsApplied, applySuggestionRow, applyAllSuggestionRows, addDrawerOpen, setAddDrawerOpen, setLastAction } = props;
  return (
    <div className="proto-layout proto-layout--workbench">
      <RoomRail selectedRoomId={selectedRoomId} onSelect={setSelectedRoomId} roomTypeOverrides={roomTypeOverrides} resolvedValidationTags={resolvedValidationTags} />
      <section className="proto-panel proto-profile-main">
        <ProfileHeader selectedRoom={selectedRoom} mergeTargetId={mergeTargetId} onMergeTarget={setMergeTargetId} mergeOpen={mergePopoverOpen} onMergeOpenChange={setMergePopoverOpen} typeOpen={typePopoverOpen} onTypeOpenChange={setTypePopoverOpen} onRoomType={setSelectedRoomType} onAction={setLastAction} />
        <div className="proto-profile-stack">
          <ValidationReviewPanel selectedRoom={selectedRoom} status={suggestionStatus} onStatus={setSuggestionStatus} rowStatus={suggestionRowsApplied} onApplyRow={applySuggestionRow} onApplyAll={applyAllSuggestionRows} />
          <RoomTypeSuggestionPanel selectedRoom={selectedRoom} onAction={setLastAction} />
          <FloorBlock selectedRoom={selectedRoom} floorMode={floorMode} open={floorOpen} onOpenChange={setFloorOpen} onFloorMode={setFloorMode} onAction={setLastAction} />
          <CeilingBlock selectedRoom={selectedRoom} ceilingShape={ceilingShape} ridgeOffset={ridgeOffset} open={ceilingOpen} onOpenChange={setCeilingOpen} onCeilingShape={setCeilingShape} onRidgeOffset={setRidgeOffset} onAction={setLastAction} />
          <GeometryFooter selectedRoom={selectedRoom} />
        </div>
      </section>
      <ComponentTabs selectedRoom={selectedRoom} surfaceFilters={surfaceFilters} addSurface={addSurface} onToggleSurface={toggleSurfaceFilter} onSetAllSurfaces={setAllSurfaceFilters} onAddSurface={setAddSurface} addDrawerOpen={addDrawerOpen} onAddDrawerOpen={setAddDrawerOpen} onAction={setLastAction} />
      <ReconciliationPanel open={reconciliationOpen} onOpenChange={setReconciliationOpen} />
    </div>
  );
}

type VariantProps = {
  selectedRoom: PrototypeRoom;
  selectedRoomId: string;
  setSelectedRoomId: (roomId: string) => void;
  roomTypeOverrides: RoomTypeOverrides;
  resolvedValidationTags: Record<string, boolean>;
  setSelectedRoomType: (roomType: RoomTypeId) => void;
  mergeTargetId: string;
  setMergeTargetId: (roomId: string) => void;
  mergePopoverOpen: boolean;
  setMergePopoverOpen: (open: boolean) => void;
  typePopoverOpen: boolean;
  setTypePopoverOpen: (open: boolean) => void;
  floorOpen: boolean;
  setFloorOpen: (open: boolean) => void;
  floorMode: FloorMode;
  setFloorMode: (mode: FloorMode) => void;
  ceilingOpen: boolean;
  setCeilingOpen: (open: boolean) => void;
  reconciliationOpen: boolean;
  setReconciliationOpen: (open: boolean) => void;
  surfaceFilters: SurfaceFilters;
  addSurface: SurfaceTab;
  toggleSurfaceFilter: (surface: SurfaceTab) => void;
  setAllSurfaceFilters: () => void;
  setAddSurface: (surface: SurfaceTab) => void;
  ceilingShape: CeilingShape;
  ridgeOffset: number;
  setCeilingShape: (shape: CeilingShape) => void;
  setRidgeOffset: (offset: number) => void;
  suggestionStatus: SuggestionStatus;
  setSuggestionStatus: (status: SuggestionStatus) => void;
  suggestionRowsApplied: SuggestionRowsApplied;
  applySuggestionRow: (rowId: SuggestionRowId) => void;
  applyAllSuggestionRows: () => void;
  addDrawerOpen: boolean;
  setAddDrawerOpen: (open: boolean) => void;
  setLastAction: (message: string) => void;
};

export function RoomProfileLayoutPrototype() {
  const [selectedRoomId, setSelectedRoomId] = useState("wic");
  const [roomTypeOverrides, setRoomTypeOverrides] = useState<RoomTypeOverrides>({});
  const [resolvedValidationTags, setResolvedValidationTags] = useState<Record<string, boolean>>({});
  const [mergeTargetId, setMergeTargetId] = useState("laundry");
  const [mergePopoverOpen, setMergePopoverOpen] = useState(false);
  const [typePopoverOpen, setTypePopoverOpen] = useState(false);
  const [floorOpen, setFloorOpen] = useState(false);
  const [floorMode, setFloorMode] = useState<FloorMode>("Match room area");
  const [ceilingOpen, setCeilingOpen] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [surfaceFilters, setSurfaceFilters] = useState<SurfaceFilters>(allSurfaceFilters);
  const [addSurface, setAddSurface] = useState<SurfaceTab>("Walls");
  const [ceilingShape, setCeilingShape] = useState<CeilingShape>("Flat / taller flat");
  const [ridgeOffset, setRidgeOffset] = useState(0);
  const [suggestionStatus, setSuggestionStatus] = useState<SuggestionStatus>("pending");
  const [suggestionRowsApplied, setSuggestionRowsApplied] = useState<SuggestionRowsApplied>(emptySuggestionRowsApplied);
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [lastAction, setLastAction] = useState("Prototype opened.");
  const baseSelectedRoom = roomById(selectedRoomId);
  const selectedRoom = { ...baseSelectedRoom, type: roomTypeOverrides[selectedRoomId] ?? baseSelectedRoom.type };

  useEffect(() => {
    if (!mergePopoverOpen && !typePopoverOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".proto-merge-popout")) return;
      setMergePopoverOpen(false);
      setTypePopoverOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [mergePopoverOpen, typePopoverOpen]);

  const props = useMemo<VariantProps>(() => ({
    selectedRoom,
    selectedRoomId,
    setSelectedRoomId: (roomId) => {
      const room = roomById(roomId);
      setSelectedRoomId(roomId);
      const resolved = Boolean(resolvedValidationTags[roomId]);
      setSuggestionStatus(room.issue && !resolved ? "pending" : "accepted");
      setSuggestionRowsApplied(resolved ? { "garage-wall": true, "exterior-wall": true } : emptySuggestionRowsApplied);
      setMergePopoverOpen(false);
      setTypePopoverOpen(false);
      setFloorOpen(false);
      setCeilingOpen(false);
      setReconciliationOpen(false);
      setAddDrawerOpen(false);
      setLastAction(`${room.name} selected.`);
    },
    roomTypeOverrides,
    resolvedValidationTags,
    setSelectedRoomType: (roomType) => {
      setRoomTypeOverrides((current) => ({ ...current, [selectedRoomId]: roomType }));
      setLastAction(`${selectedRoom.name} room type set to ${roomType}.`);
    },
    mergeTargetId,
    setMergeTargetId: (roomId) => {
      setMergeTargetId(roomId);
      setLastAction(`Merge target changed to ${roomById(roomId).name}.`);
    },
    mergePopoverOpen,
    setMergePopoverOpen: (open) => {
      if (open) setTypePopoverOpen(false);
      setMergePopoverOpen(open);
      setLastAction(open ? "Merge menu opened." : "Merge menu closed.");
    },
    typePopoverOpen,
    setTypePopoverOpen: (open) => {
      if (open) setMergePopoverOpen(false);
      setTypePopoverOpen(open);
      setLastAction(open ? "Room type menu opened." : "Room type menu closed.");
    },
    floorOpen,
    setFloorOpen: (open) => {
      setFloorOpen(open);
      setLastAction(open ? "Floor section shown." : "Floor section hidden.");
    },
    floorMode,
    setFloorMode: (mode) => {
      setFloorMode(mode);
      setLastAction(`Floor mode changed to ${mode}.`);
    },
    ceilingOpen,
    setCeilingOpen: (open) => {
      setCeilingOpen(open);
      setLastAction(open ? "Ceiling section shown." : "Ceiling section hidden.");
    },
    reconciliationOpen,
    setReconciliationOpen: (open) => {
      setReconciliationOpen(open);
      setLastAction(open ? "Reconciliation panel shown." : "Reconciliation panel hidden.");
    },
    surfaceFilters,
    addSurface,
    toggleSurfaceFilter: (surface) => {
      setSurfaceFilters((current) => {
        const next = { ...current, [surface]: !current[surface] };
        const selected = surfaceTabs.filter((entry) => next[entry]);
        setLastAction(selected.length === 0
          ? "All component filters cleared."
          : `${surface} component filter ${next[surface] ? "enabled" : "disabled"}.`);
        return next;
      });
    },
    setAllSurfaceFilters: () => {
      setSurfaceFilters(allSurfaceFilters);
      setLastAction("All component filters enabled.");
    },
    setAddSurface: (surface) => {
      setAddSurface(surface);
      setLastAction(`${surface} selected for new component.`);
    },
    ceilingShape,
    ridgeOffset,
    setCeilingShape: (shape) => {
      setCeilingShape(shape);
      setLastAction(`Ceiling geometry changed to ${shape}.`);
    },
    setRidgeOffset: (offset) => {
      setRidgeOffset(offset);
      setLastAction(`Ceiling ridge offset set to ${offset}%.`);
    },
    suggestionStatus,
    setSuggestionStatus: (status) => {
      setSuggestionStatus(status);
      if (status === "accepted" || status === "dismissed") {
        setResolvedValidationTags((current) => ({ ...current, [selectedRoomId]: true }));
      }
      setLastAction(`Wall suggestion ${status}.`);
    },
    suggestionRowsApplied,
    applySuggestionRow: (rowId) => {
      setSuggestionRowsApplied((current) => {
        const next = { ...current, [rowId]: true };
        if (Object.values(next).every(Boolean)) {
          setSuggestionStatus("accepted");
          setResolvedValidationTags((tags) => ({ ...tags, [selectedRoomId]: true }));
        }
        return next;
      });
      setLastAction(`${rowId === "garage-wall" ? "Garage wall" : "Exterior wall"} suggestion applied.`);
    },
    applyAllSuggestionRows: () => {
      setSuggestionRowsApplied({ "garage-wall": true, "exterior-wall": true });
      setSuggestionStatus("accepted");
      setResolvedValidationTags((current) => ({ ...current, [selectedRoomId]: true }));
      setLastAction("All room suggestions applied.");
    },
    addDrawerOpen,
    setAddDrawerOpen: (open) => {
      setAddDrawerOpen(open);
      setLastAction(open ? "Add component drawer opened." : "Add component drawer closed.");
    },
    setLastAction,
  }), [addDrawerOpen, addSurface, ceilingOpen, ceilingShape, floorMode, floorOpen, mergePopoverOpen, mergeTargetId, reconciliationOpen, resolvedValidationTags, ridgeOffset, roomTypeOverrides, selectedRoom, selectedRoomId, suggestionRowsApplied, suggestionStatus, surfaceFilters, typePopoverOpen]);

  return (
    <main className="takeoff-root proto-full-takeoff">
      <header className="takeoff-toolbar proto-full-toolbar">
        <div>
          <h1>Takeoff V1</h1>
          <p>First Floor · 1754 sf assigned · 2 open · Workbench room profile prototype</p>
        </div>
        <div className="takeoff-toolbar-actions">
          <button type="button">Open</button>
          <button type="button" className="toolbar-primary">Save</button>
          <button type="button" className="toolbar-primary">Calculate</button>
          <span className="takeoff-save-status">Saved</span>
          <a className="button" href="/#/takeoff">Takeoff</a>
          <a className="button" href="/#/projects">Projects</a>
        </div>
      </header>
      <section className="takeoff-layout proto-full-layout">
        <aside className="takeoff-sidebar">
          <PrototypeLeftRail />
        </aside>
        <section className="proto-full-center">
          <PrototypePlanStage selectedRoomId={selectedRoomId} onSelectRoom={props.setSelectedRoomId} />
          <WorkbenchVariant {...props} />
        </section>
        <aside className="takeoff-sidebar takeoff-tools-sidebar">
          <PrototypeRightRail
            selectedRoom={selectedRoom}
            resolvedValidationTags={resolvedValidationTags}
            onFocusValidation={(roomId) => {
              props.setSelectedRoomId(roomId);
              setLastAction(`${roomById(roomId).name} validation review focused.`);
            }}
            onAction={setLastAction}
          />
        </aside>
      </section>
    </main>
  );
}
