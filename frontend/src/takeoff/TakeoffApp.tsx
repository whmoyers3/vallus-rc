import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  TakeoffAuthoringMode,
  TakeoffFloor,
  TakeoffPoint,
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

function polygonArea(points: TakeoffPoint[]) {
  if (points.length < 3) return 0;
  const sum = points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0);
  return Math.abs(sum) / 2;
}

function polygonBounds(points: TakeoffPoint[]) {
  if (points.length === 0) return { x: 0, y: 0, width: 0, depth: 0 };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, depth: maxY - minY };
}

function pointOnSegment(point: TakeoffPoint, a: TakeoffPoint, b: TakeoffPoint) {
  const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
  if (Math.abs(cross) > 0.001) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  if (dot < -0.001) return false;
  const squaredLength = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  return dot <= squaredLength + 0.001;
}

function pointInPolygon(point: TakeoffPoint, polygon: TakeoffPoint[]) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (pointOnSegment(point, pj, pi)) return true;
    const intersects = pi.y > point.y !== pj.y > point.y && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function footprintArea(floor: TakeoffFloor) {
  const tracedArea = polygonArea(floor.exteriorPolygon);
  return tracedArea > 0 ? tracedArea : floor.conditionedPerimeter.width * floor.conditionedPerimeter.depth;
}

function footprintBounds(floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) return polygonBounds(floor.exteriorPolygon);
  return { x: 0, y: 0, width: floor.conditionedPerimeter.width, depth: floor.conditionedPerimeter.depth };
}

function roomCorners(room: TakeoffRectRoom): TakeoffPoint[] {
  return [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y },
    { x: room.x + room.width, y: room.y + room.depth },
    { x: room.x, y: room.y + room.depth },
  ];
}

function overlaps(a: TakeoffRectRoom, b: TakeoffRectRoom) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.depth && a.y + a.depth > b.y;
}

function insidePerimeter(room: TakeoffRectRoom, floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) {
    return room.width > 0 && room.depth > 0 && roomCorners(room).every((corner) => pointInPolygon(corner, floor.exteriorPolygon));
  }

  return (
    room.x >= 0 &&
    room.y >= 0 &&
    room.width > 0 &&
    room.depth > 0 &&
    room.x + room.width <= floor.conditionedPerimeter.width &&
    room.y + room.depth <= floor.conditionedPerimeter.depth
  );
}

function findOpenRoomPosition(floor: TakeoffFloor, candidate: TakeoffRectRoom) {
  if (candidate.width <= 0 || candidate.depth <= 0) return null;

  const snapFeet = Math.max(0.25, floor.scale.gridSnapInches / 12);
  const bounds = footprintBounds(floor);
  const maxX = bounds.x + bounds.width - candidate.width;
  const maxY = bounds.y + bounds.depth - candidate.depth;

  if (maxX < 0 || maxY < 0) return null;

  for (let y = bounds.y; y <= maxY + 0.001; y += snapFeet) {
    for (let x = bounds.x; x <= maxX + 0.001; x += snapFeet) {
      const room = { ...candidate, x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
      if (insidePerimeter(room, floor) && !floor.rooms.some((existing) => overlaps(existing, room))) {
        return { x: room.x, y: room.y };
      }
    }
  }

  return null;
}

function buildValidation(floor: TakeoffFloor): TakeoffValidationIssue[] {
  const issues: TakeoffValidationIssue[] = [];
  const area = footprintArea(floor);
  const roomArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);

  if (floor.designGrid.width <= 0 || floor.designGrid.depth <= 0) {
    issues.push({ severity: "error", message: "Design grid dimensions are required." });
  }

  if (floor.exteriorPolygon.length > 0 && floor.exteriorPolygon.length < 3) {
    issues.push({ severity: "warning", message: "Exterior trace needs at least 3 points before it can calculate conditioned area." });
  }

  if (floor.exteriorPolygon.length === 0 && (floor.conditionedPerimeter.width <= 0 || floor.conditionedPerimeter.depth <= 0)) {
    issues.push({ severity: "error", message: "Trace an exterior perimeter or provide fallback footprint dimensions." });
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

  const unassigned = area - roomArea;
  if (area > 0 && floor.rooms.length === 0) {
    issues.push({
      severity: "warning",
      message: `No rooms are assigned yet. Conditioned footprint is ${Math.round(area)} sf.`,
    });
  } else if (area > 0 && unassigned > 1) {
    issues.push({ severity: "warning", message: `${Math.round(unassigned)} sf of conditioned footprint remains unassigned.` });
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
    designGrid: { width: 60, depth: 45 },
    scale: { feetPerGrid: 1, gridSnapInches: 6 },
    conditionedPerimeter: { width: 40, depth: 30 },
    exteriorPolygon: [],
    perimeterLocked: false,
    rooms: [
      { id: "room-1", name: "Great Room", x: 0, y: 0, width: 18, depth: 16, ceilingHeight: 9 },
      { id: "room-2", name: "Kitchen", x: 18, y: 0, width: 12, depth: 14, ceilingHeight: 9 },
    ],
  });
  const [draftRoom, setDraftRoom] = useState({ name: "Bedroom", x: 0, y: 16, width: 12, depth: 12, ceilingHeight: 9 });
  const [message, setMessage] = useState("");
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [traceTool, setTraceTool] = useState<"select" | "exterior">("select");
  const [referenceUrl, setReferenceUrl] = useState("");
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    };
  }, [referenceUrl]);

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
  const computedFootprintArea = footprintArea(floor);
  const assignedArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const unassignedArea = computedFootprintArea - assignedArea;
  const payload = useMemo(() => buildVrcPayload(takeoffProject), [takeoffProject]);
  const bounds = footprintBounds(floor);

  const canvasWidth = 720;
  const canvasHeight = 420;
  const baseScale = Math.min(
    (canvasWidth - 56) / Math.max(floor.designGrid.width, 1),
    (canvasHeight - 56) / Math.max(floor.designGrid.depth, 1),
  );
  const scale = baseScale * zoom;
  const drawingWidth = Math.max(canvasWidth, floor.designGrid.width * scale + 56);
  const drawingHeight = Math.max(canvasHeight, floor.designGrid.depth * scale + 56);
  const gridSize = Math.max(4, scale * floor.scale.feetPerGrid);
  const offsetX = 28;
  const offsetY = 28;
  const exteriorPath = floor.exteriorPolygon.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ");

  function updateFloor(patch: Partial<TakeoffFloor>) {
    setFloor((current) => ({ ...current, ...patch }));
  }

  function updatePerimeter(field: "width" | "depth", value: number) {
    setFloor((current) => ({
      ...current,
      conditionedPerimeter: { ...current.conditionedPerimeter, [field]: Math.max(0, value) },
    }));
  }

  function updateDesignGrid(field: "width" | "depth", value: number) {
    setFloor((current) => ({
      ...current,
      designGrid: { ...current.designGrid, [field]: Math.max(0, value) },
    }));
  }

  function addExteriorPoint(point: TakeoffPoint) {
    setFloor((current) => {
      if (current.perimeterLocked) return current;
      return { ...current, exteriorPolygon: [...current.exteriorPolygon, point] };
    });
    setMessage(`Exterior point added at ${point.x} ft, ${point.y} ft.`);
  }

  function clearExteriorTrace() {
    setFloor((current) => ({ ...current, exteriorPolygon: [], perimeterLocked: false }));
    setTraceTool("exterior");
    setMessage("Exterior trace cleared.");
  }

  function seedRectangularExterior() {
    setFloor((current) => ({
      ...current,
      exteriorPolygon: [
        { x: 0, y: 0 },
        { x: current.conditionedPerimeter.width, y: 0 },
        { x: current.conditionedPerimeter.width, y: current.conditionedPerimeter.depth },
        { x: 0, y: current.conditionedPerimeter.depth },
      ],
      perimeterLocked: false,
    }));
    setTraceTool("exterior");
    setMessage("Fallback rectangle copied into the exterior trace.");
  }

  function togglePerimeterLock() {
    if (floor.exteriorPolygon.length < 3) {
      setMessage("Add at least 3 exterior points before locking the perimeter.");
      return;
    }
    setFloor((current) => ({ ...current, perimeterLocked: !current.perimeterLocked }));
    setTraceTool(floor.perimeterLocked ? "exterior" : "select");
    setMessage(floor.perimeterLocked ? "Exterior perimeter unlocked." : "Exterior perimeter locked.");
  }

  function fitGrid() {
    setZoom(1);
    requestAnimationFrame(() => {
      if (!canvasScrollRef.current) return;
      canvasScrollRef.current.scrollLeft = 0;
      canvasScrollRef.current.scrollTop = 0;
    });
  }

  function fitPlan() {
    const planWidth = Math.max(bounds.width, 1);
    const planDepth = Math.max(bounds.depth, 1);
    const nextZoom = Math.min(4, Math.max(0.5, Math.min((canvasWidth - 56) / (planWidth * baseScale), (canvasHeight - 56) / (planDepth * baseScale))));
    setZoom(Number(nextZoom.toFixed(2)));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!canvasScrollRef.current) return;
        canvasScrollRef.current.scrollLeft = Math.max(0, offsetX + bounds.x * baseScale * nextZoom - 24);
        canvasScrollRef.current.scrollTop = Math.max(0, offsetY + bounds.y * baseScale * nextZoom - 24);
      });
    });
  }

  function handleCanvasClick(event: React.MouseEvent<SVGSVGElement>) {
    if (traceTool !== "exterior" || floor.perimeterLocked) return;
    const svg = event.currentTarget;
    const transform = svg.getScreenCTM();
    if (!transform) return;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const svgPoint = point.matrixTransform(transform.inverse());
    const snapFeet = Math.max(0.25, floor.scale.gridSnapInches / 12);
    const rawX = (svgPoint.x - offsetX) / scale;
    const rawY = (svgPoint.y - offsetY) / scale;
    const x = Math.min(floor.designGrid.width, Math.max(0, Math.round(rawX / snapFeet) * snapFeet));
    const y = Math.min(floor.designGrid.depth, Math.max(0, Math.round(rawY / snapFeet) * snapFeet));
    addExteriorPoint({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  }

  function addRoom() {
    let room: TakeoffRectRoom = { id: nextId("room"), ...draftRoom };
    const hasConflict = !insidePerimeter(room, floor) || floor.rooms.some((existing) => overlaps(existing, room));

    if (hasConflict) {
      const openPosition = findOpenRoomPosition(floor, room);
      if (!openPosition) {
        setMessage("No open spot fits that room size inside the conditioned footprint.");
        return;
      }
      room = { ...room, ...openPosition };
    }

    setFloor((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setDraftRoom((current) => {
      const nextCandidate = { ...current, x: room.x, y: room.y + room.depth };
      const nextRoom: TakeoffRectRoom = { id: "draft", ...nextCandidate };
      const nextPosition = findOpenRoomPosition({ ...floor, rooms: [...floor.rooms, room] }, nextRoom);
      return nextPosition ? { ...nextCandidate, ...nextPosition } : nextCandidate;
    });
    setMessage(hasConflict ? `${room.name} added at the next open spot.` : `${room.name} added.`);
  }

  function moveDraftRoomToOpenSpot() {
    const room: TakeoffRectRoom = { id: "draft", ...draftRoom };
    const openPosition = findOpenRoomPosition(floor, room);
    if (!openPosition) {
      setMessage("No open spot fits that draft room size.");
      return;
    }
    setDraftRoom((current) => ({ ...current, ...openPosition }));
    setMessage("Draft room moved to the next open spot.");
  }

  function removeRoom(id: string) {
    setFloor((current) => ({ ...current, rooms: current.rooms.filter((room) => room.id !== id) }));
  }

  function handleReference(file: File | undefined) {
    if (!file) return;
    const kind = file.type.includes("pdf") ? "pdf" : "image";
    if (referenceUrl) URL.revokeObjectURL(referenceUrl);
    setReferenceUrl(URL.createObjectURL(file));
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

      <section className={`takeoff-layout ${!leftPanelOpen ? "takeoff-layout--left-collapsed" : ""} ${!rightPanelOpen ? "takeoff-layout--right-collapsed" : ""}`}>
        <aside className={`takeoff-sidebar ${!leftPanelOpen ? "takeoff-sidebar--collapsed" : ""}`}>
          {!leftPanelOpen ? (
            <button className="takeoff-rail-toggle" onClick={() => setLeftPanelOpen(true)} aria-label="Show setup panel">Setup</button>
          ) : (
          <>
          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Project</h2>
              <button className="takeoff-icon-button" onClick={() => setLeftPanelOpen(false)} aria-label="Hide setup panel">Hide</button>
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
            {floor.authoringMode !== "grid_manual" && (
              <p className="takeoff-note">
                The reference is shown under the grid for tracing. Set the design grid size first, then trace the conditioned exterior.
              </p>
            )}
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Design Grid</h2>
            </div>
            <label>
              Grid width ft
              <input type="number" min="1" value={floor.designGrid.width} onChange={(event) => updateDesignGrid("width", Number(event.target.value))} />
            </label>
            <label>
              Grid depth ft
              <input type="number" min="1" value={floor.designGrid.depth} onChange={(event) => updateDesignGrid("depth", Number(event.target.value))} />
            </label>
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
              <h2>Fallback Footprint</h2>
            </div>
            <label>
              Width ft
              <input type="number" min="0" value={floor.conditionedPerimeter.width} onChange={(event) => updatePerimeter("width", Number(event.target.value))} />
            </label>
            <label>
              Depth ft
              <input type="number" min="0" value={floor.conditionedPerimeter.depth} onChange={(event) => updatePerimeter("depth", Number(event.target.value))} />
            </label>
            <button onClick={seedRectangularExterior}>Copy to Trace</button>
            <p className="takeoff-muted">Used only until an exterior trace is drawn.</p>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Exterior Trace</h2>
            </div>
            <div className="takeoff-form-actions">
              <button className={traceTool === "exterior" ? "toolbar-primary" : ""} onClick={() => setTraceTool("exterior")}>Trace</button>
              <button onClick={togglePerimeterLock}>{floor.perimeterLocked ? "Unlock" : "Lock"}</button>
              <button onClick={clearExteriorTrace}>Clear</button>
            </div>
            <p className="takeoff-muted">
              {floor.exteriorPolygon.length} points · {floor.perimeterLocked ? "locked" : "editable"} · {Math.round(computedFootprintArea)} sf
            </p>
            {traceTool === "exterior" && !floor.perimeterLocked && (
              <p className="takeoff-note">Click the grid corners around the conditioned exterior. Lock it when the outline is closed.</p>
            )}
          </section>
          </>
          )}
        </aside>

        <section className="takeoff-stage-panel">
          <div className="takeoff-stage-head">
            <div>
              <h2>Plan Grid</h2>
              <p>{Math.round(computedFootprintArea)} sf conditioned footprint · {floor.designGrid.width} x {floor.designGrid.depth} ft design grid</p>
            </div>
            <div className="takeoff-stage-actions">
              <div className="takeoff-stats">
                <span><b>{floor.rooms.length}</b> rooms</span>
                <span><b>{Math.round(assignedArea)}</b> assigned</span>
                <span><b>{Math.max(0, Math.round(unassignedArea))}</b> open</span>
              </div>
              <div className="takeoff-stage-tools" aria-label="Plan zoom controls">
                <button onClick={() => setZoom((current) => Math.max(0.5, Number((current - 0.25).toFixed(2))))}>-</button>
                <button onClick={fitGrid}>Fit Grid</button>
                <button onClick={fitPlan}>Fit Plan</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button onClick={() => setZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}>+</button>
              </div>
            </div>
          </div>

          <div className="takeoff-canvas-scroll" ref={canvasScrollRef}>
            <div className="takeoff-drawing-layer" style={{ width: drawingWidth, height: drawingHeight }}>
              {referenceUrl && floor.reference && (
                <div
                  className="takeoff-reference-layer"
                  style={{
                    left: offsetX,
                    top: offsetY,
                    width: floor.designGrid.width * scale,
                    height: floor.designGrid.depth * scale,
                  }}
                >
                  {floor.reference.kind === "image" ? (
                    <img src={referenceUrl} alt={`${floor.reference.filename} reference`} />
                  ) : (
                    <object data={referenceUrl} type="application/pdf" aria-label={`${floor.reference.filename} reference PDF`} />
                  )}
                </div>
              )}
            <svg
              className="takeoff-canvas"
              viewBox={`0 0 ${drawingWidth} ${drawingHeight}`}
              width={drawingWidth}
              height={drawingHeight}
              role="img"
              aria-label="Takeoff grid preview"
              onClick={handleCanvasClick}
              style={{ cursor: traceTool === "exterior" && !floor.perimeterLocked ? "crosshair" : "default" }}
            >
              <defs>
                <pattern id="takeoff-grid-small" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                  <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#dce4ea" strokeWidth="1" />
                </pattern>
              </defs>
              <rect x="0" y="0" width={drawingWidth} height={drawingHeight} fill={referenceUrl ? "transparent" : "#f8fafb"} />
              <rect x={offsetX} y={offsetY} width={floor.designGrid.width * scale} height={floor.designGrid.depth * scale} fill="url(#takeoff-grid-small)" stroke="#b7c4cf" strokeWidth="1.5" />
              {floor.exteriorPolygon.length >= 3 ? (
                <polygon points={exteriorPath} fill="rgba(31, 111, 178, 0.08)" stroke="#1f6fb2" strokeWidth="2.5" />
              ) : (
                <rect x={offsetX} y={offsetY} width={floor.conditionedPerimeter.width * scale} height={floor.conditionedPerimeter.depth * scale} fill="rgba(31, 111, 178, 0.07)" stroke="#1f6fb2" strokeDasharray="6 5" strokeWidth="2" />
              )}
              {floor.exteriorPolygon.map((point, index) => (
                <g key={`${point.x}-${point.y}-${index}`}>
                  <circle cx={offsetX + point.x * scale} cy={offsetY + point.y * scale} r="4" fill="#1f6fb2" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + point.x * scale + 6} y={offsetY + point.y * scale - 6} fontSize="10" fill="#1f2933">{index + 1}</text>
                </g>
              ))}
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
            </div>
          </div>

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
              <div className="takeoff-form-actions">
                <button className="toolbar-primary" onClick={addRoom}>Add Room</button>
                <button onClick={moveDraftRoomToOpenSpot}>Find Open Spot</button>
              </div>
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

        <aside className={`takeoff-sidebar ${!rightPanelOpen ? "takeoff-sidebar--collapsed" : ""}`}>
          {!rightPanelOpen ? (
            <button className="takeoff-rail-toggle" onClick={() => setRightPanelOpen(true)} aria-label="Show output panel">Output</button>
          ) : (
          <>
          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Rooms</h2>
              <button className="takeoff-icon-button" onClick={() => setRightPanelOpen(false)} aria-label="Hide output panel">Hide</button>
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
          </>
          )}
        </aside>
      </section>
    </main>
  );
}
