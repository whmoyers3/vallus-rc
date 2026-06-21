import React, { useMemo, useState } from "react";
import type {
  TakeoffAuthoringMode,
  TakeoffFloor,
  TakeoffProject,
  TakeoffRectRoom,
  TakeoffValidationIssue,
} from "./types";

const directionOptions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const defaultLightingWPerSf = 0.502;
const authoringModes: Array<{ id: TakeoffAuthoringMode; label: string }> = [
  { id: "pdf_trace", label: "PDF Trace" },
  { id: "image_trace", label: "Image Trace" },
  { id: "grid_manual", label: "Grid Manual" },
];

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function rectArea(rect: Pick<TakeoffRectRoom, "width" | "depth">) {
  return Math.max(0, rect.width) * Math.max(0, rect.depth);
}

function overlaps(a: TakeoffRectRoom, b: TakeoffRectRoom) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.depth && a.y + a.depth > b.y;
}

function insidePerimeter(room: TakeoffRectRoom, floor: TakeoffFloor) {
  return (
    room.x >= 0 &&
    room.y >= 0 &&
    room.width > 0 &&
    room.depth > 0 &&
    room.x + room.width <= floor.conditionedPerimeter.width &&
    room.y + room.depth <= floor.conditionedPerimeter.depth
  );
}

function buildValidation(floor: TakeoffFloor): TakeoffValidationIssue[] {
  const issues: TakeoffValidationIssue[] = [];
  const footprintArea = floor.conditionedPerimeter.width * floor.conditionedPerimeter.depth;
  const roomArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);

  if (floor.conditionedPerimeter.width <= 0 || floor.conditionedPerimeter.depth <= 0) {
    issues.push({ severity: "error", message: "Conditioned footprint dimensions are required." });
  }

  for (const room of floor.rooms) {
    if (!insidePerimeter(room, floor)) {
      issues.push({ severity: "error", message: `${room.name || "Room"} extends beyond the conditioned footprint.` });
    }
  }

  for (let i = 0; i < floor.rooms.length; i += 1) {
    for (let j = i + 1; j < floor.rooms.length; j += 1) {
      if (overlaps(floor.rooms[i], floor.rooms[j])) {
        issues.push({ severity: "error", message: `${floor.rooms[i].name} overlaps ${floor.rooms[j].name}.` });
      }
    }
  }

  const unassigned = footprintArea - roomArea;
  if (footprintArea > 0 && unassigned > 1) {
    issues.push({ severity: "warning", message: `${Math.round(unassigned)} sf is not assigned to a room.` });
  }

  return issues;
}

function buildVrcPayload(project: TakeoffProject) {
  const floor = project.floors[0];
  const rooms = floor.rooms.map((room) => ({
    name: room.name,
    floor_area: rectArea(room),
    lighting_area: rectArea(room),
    ceiling_height: room.ceilingHeight,
    volume: rectArea(room) * room.ceilingHeight,
    lighting_basis: "Floor",
    unit_id: "unit-whole-house",
    zone_id: "zone-default",
  }));
  const lineItems = floor.rooms.map((room) => ({
    name: `${room.name} slab`,
    kind: "opaque",
    room_name: room.name,
    assembly: "F2",
    area: rectArea(room),
  }));

  return {
    project: {
      name: project.name,
      location: "",
      description: "Generated from VRC Takeoff Tool",
      building_type: "single_family",
      design_conditions: {
        outdoor_cooling_db: 95,
        outdoor_heating_db: 18,
        indoor_cooling_db: 75,
        indoor_heating_db: 72,
        slab_delta_t: 27,
        cooling_safety_factor: 1.1,
        heating_safety_factor: 1.15,
      },
      infiltration: { mode: "standard_ach" },
      metadata: {
        ach50: 5,
        bedrooms: 1,
        seer: 14,
        front_door_faces: project.frontDoorFaces,
        units: [{ id: "unit-whole-house", name: "Whole House", selected_tons: 1, selected_kw: 5 }],
        zones: [{ id: "zone-default", name: floor.name, unit_id: "unit-whole-house" }],
        takeoff_schema_version: project.schemaVersion,
      },
      selected_system_tons: 1,
      selected_system_kw: 5,
      assemblies: {
        F2: { code: "F2", u_value: 0.1, description: "Slab on grade" },
      },
      levels: [
        {
          name: floor.name,
          floor_area: rooms.reduce((sum, room) => sum + room.floor_area, 0),
          volume: rooms.reduce((sum, room) => sum + room.volume, 0),
          selected_tons: 1,
          selected_kw: 5,
          cooling_cfm_divisor: 18.1,
          heating_cfm_divisor: 20.2,
          auto_lighting_w_per_sf: defaultLightingWPerSf,
          auto_infiltration: true,
          rooms,
          line_items: lineItems,
        },
      ],
    },
  };
}

function roomColor(index: number) {
  const colors = ["#d8eadf", "#d9e8f7", "#f7e4cb", "#eadff3", "#f4dada", "#dbe7e6"];
  return colors[index % colors.length];
}

export function TakeoffApp() {
  const [projectName, setProjectName] = useState("Takeoff V1 Draft");
  const [frontDoorFaces, setFrontDoorFaces] = useState<(typeof directionOptions)[number]>("S");
  const [floor, setFloor] = useState<TakeoffFloor>({
    id: "floor-1",
    name: "First Floor",
    authoringMode: "grid_manual",
    scale: { feetPerGrid: 1, gridSnapInches: 6 },
    conditionedPerimeter: { width: 40, depth: 30 },
    rooms: [
      { id: "room-1", name: "Great Room", x: 0, y: 0, width: 18, depth: 16, ceilingHeight: 9 },
      { id: "room-2", name: "Kitchen", x: 18, y: 0, width: 12, depth: 14, ceilingHeight: 9 },
    ],
  });
  const [draftRoom, setDraftRoom] = useState({ name: "Bedroom", x: 0, y: 16, width: 12, depth: 12, ceilingHeight: 9 });
  const [message, setMessage] = useState("");

  const takeoffProject = useMemo<TakeoffProject>(
    () => ({
      schemaVersion: "takeoff.v1",
      name: projectName,
      frontDoorFaces,
      floors: [floor],
    }),
    [floor, frontDoorFaces, projectName],
  );
  const validation = useMemo(() => buildValidation(floor), [floor]);
  const footprintArea = floor.conditionedPerimeter.width * floor.conditionedPerimeter.depth;
  const assignedArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const unassignedArea = footprintArea - assignedArea;
  const payload = useMemo(() => buildVrcPayload(takeoffProject), [takeoffProject]);

  const canvasWidth = 720;
  const canvasHeight = 420;
  const scale = Math.min(
    (canvasWidth - 56) / Math.max(floor.conditionedPerimeter.width, 1),
    (canvasHeight - 56) / Math.max(floor.conditionedPerimeter.depth, 1),
  );
  const offsetX = 28;
  const offsetY = 28;

  function updateFloor(patch: Partial<TakeoffFloor>) {
    setFloor((current) => ({ ...current, ...patch }));
  }

  function updatePerimeter(field: "width" | "depth", value: number) {
    setFloor((current) => ({
      ...current,
      conditionedPerimeter: { ...current.conditionedPerimeter, [field]: Math.max(0, value) },
    }));
  }

  function addRoom() {
    const room: TakeoffRectRoom = { id: nextId("room"), ...draftRoom };
    if (!insidePerimeter(room, floor)) {
      setMessage("Room is outside the conditioned footprint.");
      return;
    }
    const overlap = floor.rooms.find((existing) => overlaps(existing, room));
    if (overlap) {
      setMessage(`Room overlaps ${overlap.name}. Move or resize it first.`);
      return;
    }
    setFloor((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setMessage(`${room.name} added.`);
  }

  function removeRoom(id: string) {
    setFloor((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== id) }));
  }

  function handleReference(file: File | undefined) {
    if (!file) return;
    const kind = file.type.includes("pdf") ? "pdf" : "image";
    setFloor((current) => ({ ...current, reference: { filename: file.name, kind } }));
  }

  return (
    <main className="takeoff-root">
      <header className="takeoff-toolbar">
        <div>
          <h1>Takeoff V1</h1>
          <p>{floor.name} · {Math.round(assignedArea)} sf assigned · {Math.max(0, Math.round(unassignedArea))} sf open</p>
        </div>
        <div className="takeoff-toolbar-actions">
          <a className="button" href="#">Calculator</a>
          <a className="button" href="/#/projects">Projects</a>
        </div>
      </header>

      <section className="takeoff-layout">
        <aside className="takeoff-sidebar">
          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Project</h2>
            </div>
            <label>
              Name
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            </label>
            <label>
              Floor
              <input value={floor.name} onChange={(event) => updateFloor({ name: event.target.value })} />
            </label>
            <label>
              Front
              <select value={frontDoorFaces} onChange={(event) => setFrontDoorFaces(event.target.value as typeof frontDoorFaces)}>
                {directionOptions.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
              </select>
            </label>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Mode</h2>
            </div>
            <div className="takeoff-segmented">
              {authoringModes.map((mode) => (
                <button
                  key={mode.id}
                  className={floor.authoringMode === mode.id ? "active" : ""}
                  onClick={() => updateFloor({ authoringMode: mode.id })}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <label>
              Reference
              <input type="file" accept=".pdf,image/*" onChange={(event) => handleReference(event.target.files?.[0])} />
            </label>
            {floor.reference && <p className="takeoff-muted">{floor.reference.filename}</p>}
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Grid</h2>
            </div>
            <label>
              Feet per grid
              <input
                type="number"
                min="0.25"
                step="0.25"
                value={floor.scale.feetPerGrid}
                onChange={(event) => updateFloor({ scale: { ...floor.scale, feetPerGrid: Number(event.target.value) } })}
              />
            </label>
            <label>
              Snap inches
              <input
                type="number"
                min="1"
                step="1"
                value={floor.scale.gridSnapInches}
                onChange={(event) => updateFloor({ scale: { ...floor.scale, gridSnapInches: Number(event.target.value) } })}
              />
            </label>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Footprint</h2>
            </div>
            <label>
              Width ft
              <input type="number" min="0" value={floor.conditionedPerimeter.width} onChange={(event) => updatePerimeter("width", Number(event.target.value))} />
            </label>
            <label>
              Depth ft
              <input type="number" min="0" value={floor.conditionedPerimeter.depth} onChange={(event) => updatePerimeter("depth", Number(event.target.value))} />
            </label>
          </section>
        </aside>

        <section className="takeoff-stage-panel">
          <div className="takeoff-stage-head">
            <div>
              <h2>Plan Grid</h2>
              <p>{Math.round(footprintArea)} sf footprint</p>
            </div>
            <div className="takeoff-stats">
              <span><b>{floor.rooms.length}</b> rooms</span>
              <span><b>{Math.round(assignedArea)}</b> assigned</span>
              <span><b>{Math.max(0, Math.round(unassignedArea))}</b> open</span>
            </div>
          </div>

          <svg className="takeoff-canvas" viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} role="img" aria-label="Takeoff grid preview">
            <defs>
              <pattern id="takeoff-grid-small" width={scale * floor.scale.feetPerGrid} height={scale * floor.scale.feetPerGrid} patternUnits="userSpaceOnUse">
                <path d={`M ${scale * floor.scale.feetPerGrid} 0 L 0 0 0 ${scale * floor.scale.feetPerGrid}`} fill="none" stroke="#dce4ea" strokeWidth="1" />
              </pattern>
            </defs>
            <rect x="0" y="0" width={canvasWidth} height={canvasHeight} fill="#f8fafb" />
            <rect x={offsetX} y={offsetY} width={floor.conditionedPerimeter.width * scale} height={floor.conditionedPerimeter.depth * scale} fill="url(#takeoff-grid-small)" stroke="#1f6fb2" strokeWidth="2" />
            {floor.rooms.map((room, index) => (
              <g key={room.id}>
                <rect
                  x={offsetX + room.x * scale}
                  y={offsetY + room.y * scale}
                  width={room.width * scale}
                  height={room.depth * scale}
                  fill={roomColor(index)}
                  stroke="#324457"
                  strokeWidth="1.5"
                />
                <text x={offsetX + room.x * scale + 6} y={offsetY + room.y * scale + 18} fontSize="12" fill="#1f2933">
                  {room.name}
                </text>
                <text x={offsetX + room.x * scale + 6} y={offsetY + room.y * scale + 34} fontSize="11" fill="#465667">
                  {Math.round(rectArea(room))} sf
                </text>
              </g>
            ))}
          </svg>

          <div className="takeoff-lower-grid">
            <section className="takeoff-panel">
              <div className="takeoff-panel-head">
                <h2>New Room</h2>
              </div>
              <div className="takeoff-room-form">
                <label>Name<input value={draftRoom.name} onChange={(event) => setDraftRoom({ ...draftRoom, name: event.target.value })} /></label>
                <label>X ft<input type="number" value={draftRoom.x} onChange={(event) => setDraftRoom({ ...draftRoom, x: Number(event.target.value) })} /></label>
                <label>Y ft<input type="number" value={draftRoom.y} onChange={(event) => setDraftRoom({ ...draftRoom, y: Number(event.target.value) })} /></label>
                <label>Width<input type="number" min="0" value={draftRoom.width} onChange={(event) => setDraftRoom({ ...draftRoom, width: Number(event.target.value) })} /></label>
                <label>Depth<input type="number" min="0" value={draftRoom.depth} onChange={(event) => setDraftRoom({ ...draftRoom, depth: Number(event.target.value) })} /></label>
                <label>Height<input type="number" min="0" step="0.5" value={draftRoom.ceilingHeight} onChange={(event) => setDraftRoom({ ...draftRoom, ceilingHeight: Number(event.target.value) })} /></label>
              </div>
              <button className="toolbar-primary" onClick={addRoom}>Add Room</button>
              {message && <p className="takeoff-message">{message}</p>}
            </section>

            <section className="takeoff-panel">
              <div className="takeoff-panel-head">
                <h2>Validation</h2>
              </div>
              {validation.length === 0 ? (
                <p className="takeoff-ok">Ready for payload preview.</p>
              ) : (
                <div className="takeoff-issue-list">
                  {validation.map((issue, index) => (
                    <div key={index} className={`takeoff-issue takeoff-issue--${issue.severity}`}>{issue.message}</div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </section>

        <aside className="takeoff-sidebar">
          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Rooms</h2>
            </div>
            <div className="takeoff-room-list">
              {floor.rooms.map((room) => (
                <div key={room.id} className="takeoff-room-row">
                  <div>
                    <strong>{room.name}</strong>
                    <span>{room.width} x {room.depth} ft · {Math.round(rectArea(room))} sf</span>
                  </div>
                  <button onClick={() => removeRoom(room.id)}>Remove</button>
                </div>
              ))}
            </div>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Takeoff JSON</h2>
            </div>
            <pre className="takeoff-code">{JSON.stringify(takeoffProject, null, 2)}</pre>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Payload Preview</h2>
            </div>
            <pre className="takeoff-code">{JSON.stringify(payload, null, 2)}</pre>
          </section>
        </aside>
      </section>
    </main>
  );
}
