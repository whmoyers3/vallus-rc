import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import type {
  TakeoffAuthoringMode,
  TakeoffComponentCategory,
  TakeoffComponentDefinition,
  TakeoffFloor,
  TakeoffPoint,
  TakeoffProject,
  TakeoffRectRoom,
  TakeoffRoomComponent,
  TakeoffScaleLine,
  TakeoffValidationIssue,
} from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const { difference, intersection, union } = polygonClipping;

const directionOptions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const defaultLightingWPerSf = 0.502;
const takeoffReferenceMaxBytes = 7 * 1024 * 1024;
const componentCategories: TakeoffComponentCategory[] = ["Wall", "Door", "Ceiling", "Floor", "Glass"];
const defaultComponentSchedule: TakeoffComponentDefinition[] = [
  { id: "default-W1", code: "W1", category: "Wall", uValue: 0.077, description: "Above Grade 2x4 R-13 batt", source: "default" },
  { id: "default-W2", code: "W2", category: "Wall", uValue: 0.067, description: "Basement Concrete + 2x4 R-13 batt", source: "default" },
  { id: "default-W3", code: "W3", category: "Wall", uValue: 0.053, description: "Attic 2x6 R-19 batt", source: "default" },
  { id: "default-D1", code: "D1", category: "Door", uValue: 0.5, description: "Exterior Door R-2", source: "default" },
  { id: "default-D2", code: "D2", category: "Door", uValue: 0.37, description: "Garage Door R-2.7", source: "default" },
  { id: "default-C1", code: "C1", category: "Ceiling", uValue: 0.033, description: "Flat Ceiling R-30 blown", source: "default" },
  { id: "default-C2", code: "C2", category: "Ceiling", uValue: 0.033, description: "Vaulted R-30 batt", source: "default" },
  { id: "default-C3", code: "C3", category: "Ceiling", uValue: 0.033, description: "Custom ceiling", source: "default" },
  { id: "default-F1", code: "F1", category: "Floor", uValue: 0.053, description: "Framed floor R-19 batt", source: "default" },
  { id: "default-F2", code: "F2", category: "Floor", uValue: 0.1, description: "Slab on grade", source: "default" },
  { id: "default-G1", code: "G1", category: "Glass", uValue: 0.32, shgc: 0.22, description: "Double Insulated All types Blinds/Draperies", source: "default" },
  { id: "default-G2", code: "G2", category: "Glass", uValue: 0.32, shgc: 0.22, description: "Glass type 2", source: "default" },
  { id: "default-G3", code: "G3", category: "Glass", uValue: 0.32, shgc: 0.22, description: "Glass type 3", source: "default" },
];
const authoringModes: Array<{ id: TakeoffAuthoringMode; label: string }> = [
  { id: "pdf_trace", label: "PDF Trace" },
  { id: "image_trace", label: "Image Trace" },
  { id: "grid_manual", label: "Grid Manual" },
];
type WorkflowStep = "crop" | "calibrate" | "trace";
type MovablePointTarget = { type: "exterior"; index: number } | { type: "room"; roomId: string; index: number };
type DragState = {
  kind: "crop" | "room" | "subtract" | "move-point";
  start: TakeoffPoint;
  current: TakeoffPoint;
  target?: MovablePointTarget;
} | null;
type PlanRect = { x: number; y: number; width: number; depth: number };
type SavedTakeoffRow = {
  id: number;
  calculation_id?: number | null;
  name: string;
  location?: string;
  description?: string;
  schema_version?: string;
  created_at?: string;
  updated_at?: string;
};
type UploadedTakeoffAsset = {
  id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  download_url: string;
  signed_url?: string;
};

function makeInitialFloor(): TakeoffFloor {
  return {
    id: "floor-1",
    name: "First Floor",
    authoringMode: "grid_manual",
    designGrid: { width: 60, depth: 45 },
    scale: { feetPerGrid: 1, gridSnapInches: 6 },
    conditionedPerimeter: { width: 0, depth: 0 },
    calibration: { lines: [], confirmed: false, appliedFactor: 1, areaConfirmed: false },
    exteriorPolygon: [],
    perimeterLocked: false,
    rooms: [],
  };
}

function makeTakeoffProject(
  name: string,
  frontDoorFaces: TakeoffProject["frontDoorFaces"],
  floor: TakeoffFloor,
  componentSchedule: TakeoffComponentDefinition[],
): TakeoffProject {
  return {
    schemaVersion: "takeoff.v1",
    name,
    frontDoorFaces,
    componentSchedule,
    floors: [floor],
  };
}

function closeRing(points: TakeoffPoint[]): Ring {
  const ring = points.map((point) => [point.x, point.y] as [number, number]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) ring.push(first);
  return ring;
}

function pointsToClipPolygon(points: TakeoffPoint[]): Polygon {
  return [closeRing(points)];
}

function rectToPoints(rect: PlanRect): TakeoffPoint[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.depth },
    { x: rect.x, y: rect.y + rect.depth },
  ];
}

function clipPolygonToPoints(polygon: Polygon) {
  const ring = polygon[0] ?? [];
  return ring.slice(0, -1).map(([x, y]) => ({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) }));
}

function largestClipPolygon(multiPolygon: MultiPolygon) {
  return multiPolygon
    .map((polygon) => ({ polygon, area: polygonArea(clipPolygonToPoints(polygon)) }))
    .filter((entry) => entry.area > 0.5)
    .sort((a, b) => b.area - a.area)[0]?.polygon ?? null;
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function rectArea(rect: Pick<TakeoffRectRoom, "width" | "depth"> & { polygon?: TakeoffPoint[]; areaAdjustment?: number }) {
  const baseArea = rect.polygon && rect.polygon.length >= 3 ? polygonArea(rect.polygon) : Math.max(0, rect.width) * Math.max(0, rect.depth);
  return baseArea + Math.max(0, rect.areaAdjustment ?? 0);
}

function legacyComponentsForRoom(room: TakeoffRectRoom): TakeoffRoomComponent[] {
  const components: TakeoffRoomComponent[] = [];
  if ((room.floorType ?? "slab") !== "none") {
    const assembly = room.floorType === "framed" ? "F1" : "F2";
    components.push({
      id: `${room.id}-floor-default`,
      surface: "floor",
      assembly,
      area: Math.max(0, room.floorLoadArea ?? rectArea(room)),
      label: assembly === "F1" ? "Framed / exposed floor" : "Slab",
    });
  }
  if ((room.ceilingType ?? "flat") !== "none") {
    const assembly = room.ceilingType === "vaulted" ? "C2" : "C1";
    components.push({
      id: `${room.id}-ceiling-default`,
      surface: "ceiling",
      assembly,
      area: Math.max(0, room.ceilingLoadArea ?? rectArea(room)),
      label: assembly === "C2" ? "Vaulted ceiling" : "Flat ceiling",
    });
  }
  return components;
}

function roomComponents(room: TakeoffRectRoom) {
  return room.components?.length ? room.components : legacyComponentsForRoom(room);
}

function roomSurfaceComponents(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  return roomComponents(room).filter((component) => component.surface === surface);
}

function componentAreaTotal(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  return roomSurfaceComponents(room, surface).reduce((sum, component) => sum + Math.max(0, component.area || 0), 0);
}

function defaultComponent(surface: TakeoffRoomComponent["surface"], area: number): TakeoffRoomComponent {
  const defaults: Record<TakeoffRoomComponent["surface"], { assembly: string; label: string; direction?: TakeoffRoomComponent["direction"] }> = {
    floor: { assembly: "F2", label: "Slab" },
    ceiling: { assembly: "C1", label: "Flat ceiling" },
    wall: { assembly: "W1", label: "Exterior wall", direction: "S" },
    glass: { assembly: "G1", label: "Window", direction: "S" },
    door: { assembly: "D1", label: "Door", direction: "S" },
  };
  const fallback = defaults[surface];
  return {
    id: nextId(`component-${surface}`),
    surface,
    assembly: fallback.assembly,
    area: Math.max(0, Math.round(area)),
    direction: fallback.direction,
    label: fallback.label,
  };
}

function defaultRoomComponents(area: number): TakeoffRoomComponent[] {
  return [defaultComponent("floor", area), defaultComponent("ceiling", area)];
}

function componentSurfaceLabel(surface: TakeoffRoomComponent["surface"]) {
  const labels: Record<TakeoffRoomComponent["surface"], string> = {
    floor: "Floor",
    ceiling: "Ceiling",
    wall: "Wall",
    glass: "Window",
    door: "Door",
  };
  return labels[surface];
}

function componentPayloadKind(surface: TakeoffRoomComponent["surface"]) {
  return surface === "glass" ? "glass" : "opaque";
}

function componentNeedsDirection(surface: TakeoffRoomComponent["surface"]) {
  return surface === "wall" || surface === "glass" || surface === "door";
}

function rectFromPoints(a: TakeoffPoint, b: TakeoffPoint) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
    width: Number(Math.abs(a.x - b.x).toFixed(3)),
    depth: Number(Math.abs(a.y - b.y).toFixed(3)),
  };
}

function lineLength(line: Pick<TakeoffScaleLine, "start" | "end">) {
  return Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
}

function scalePoint(point: TakeoffPoint, factor: number): TakeoffPoint {
  return { x: Number((point.x * factor).toFixed(3)), y: Number((point.y * factor).toFixed(3)) };
}

function scaleRoom(room: TakeoffRectRoom, factor: number): TakeoffRectRoom {
  return {
    ...room,
    x: Number((room.x * factor).toFixed(3)),
    y: Number((room.y * factor).toFixed(3)),
    width: Number((room.width * factor).toFixed(3)),
    depth: Number((room.depth * factor).toFixed(3)),
    polygon: room.polygon?.map((point) => scalePoint(point, factor)),
    areaAdjustment: room.areaAdjustment ? Number((room.areaAdjustment * factor * factor).toFixed(3)) : room.areaAdjustment,
  };
}

function scaleLine(line: TakeoffScaleLine, factor: number): TakeoffScaleLine {
  return { ...line, start: scalePoint(line.start, factor), end: scalePoint(line.end, factor) };
}

function scaleRect<T extends { x: number; y: number; width: number; depth: number }>(rect: T, factor: number): T {
  return {
    ...rect,
    x: Number((rect.x * factor).toFixed(3)),
    y: Number((rect.y * factor).toFixed(3)),
    width: Number((rect.width * factor).toFixed(3)),
    depth: Number((rect.depth * factor).toFixed(3)),
  };
}

function calibrationFactor(lines: TakeoffScaleLine[]) {
  const factors = lines
    .map((line) => {
      const measured = lineLength(line);
      return measured > 0 && line.knownFeet > 0 ? line.knownFeet / measured : 0;
    })
    .filter((factor) => factor > 0);

  if (factors.length === 0) return 0;
  return factors.reduce((sum, factor) => sum + factor, 0) / factors.length;
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

function closestPointOnSegment(point: TakeoffPoint, a: TakeoffPoint, b: TakeoffPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return a;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function distance(a: TakeoffPoint, b: TakeoffPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
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
  if (room.polygon && room.polygon.length >= 3) return room.polygon;
  return [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y },
    { x: room.x + room.width, y: room.y + room.depth },
    { x: room.x, y: room.y + room.depth },
  ];
}

function roomCenter(room: TakeoffRectRoom) {
  const points = roomCorners(room);
  if (points.length === 0) return { x: room.x, y: room.y };
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function roomToClipPolygon(room: TakeoffRectRoom): Polygon {
  return pointsToClipPolygon(roomCorners(room));
}

function pointInRoom(point: TakeoffPoint, room: TakeoffRectRoom) {
  if (room.polygon && room.polygon.length >= 3) return pointInPolygon(point, room.polygon);
  return point.x >= room.x && point.x <= room.x + room.width && point.y >= room.y && point.y <= room.y + room.depth;
}

function overlaps(a: TakeoffRectRoom, b: TakeoffRectRoom) {
  if (a.polygon || b.polygon) {
    return intersection(roomToClipPolygon(a), roomToClipPolygon(b)).some((polygon) => polygonArea(clipPolygonToPoints(polygon)) > 0.25);
  }
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
    if (room.ceilingHeight <= 0) {
      issues.push({ severity: "error", message: `${room.name || "Room"} needs a ceiling height.` });
    }
    const roomArea = rectArea(room);
    const floorArea = componentAreaTotal(room, "floor");
    const ceilingArea = componentAreaTotal(room, "ceiling");
    if (floorArea > roomArea + 0.5) {
      issues.push({ severity: "error", message: `${room.name || "Room"} floor components exceed room area by ${Math.round(floorArea - roomArea)} sf.` });
    }
    if (ceilingArea > roomArea + 0.5) {
      issues.push({ severity: "error", message: `${room.name || "Room"} ceiling components exceed room area by ${Math.round(ceilingArea - roomArea)} sf.` });
    }
    for (const component of roomComponents(room)) {
      if (!component.assembly) {
        issues.push({ severity: "error", message: `${room.name || "Room"} has a component with no assembly code.` });
      }
      if (componentNeedsDirection(component.surface) && !component.direction) {
        issues.push({ severity: "warning", message: `${room.name || "Room"} has a ${componentSurfaceLabel(component.surface).toLowerCase()} component with no direction.` });
      }
      if (component.area <= 0) {
        issues.push({ severity: "warning", message: `${room.name || "Room"} has a ${component.surface} component with no area.` });
      }
    }
    if (floorArea < roomArea - 0.5) {
      issues.push({ severity: "warning", message: `${room.name || "Room"} floor components leave ${Math.round(roomArea - floorArea)} sf unassigned.` });
    }
    if (ceilingArea < roomArea - 0.5) {
      issues.push({ severity: "warning", message: `${room.name || "Room"} ceiling components leave ${Math.round(roomArea - ceilingArea)} sf unassigned.` });
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
  const schedule = project.componentSchedule?.length ? project.componentSchedule : defaultComponentSchedule;
  const assemblyMap = Object.fromEntries(schedule.map((component) => [
    component.code,
    {
      code: component.code,
      u_value: component.uValue,
      shgc: component.category === "Glass" ? component.shgc ?? null : null,
      description: component.description,
    },
  ]));
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
  const lineItems = floor.rooms.flatMap((room) => {
    return roomComponents(room).map((component) => ({
      name: `${room.name} ${component.label || component.assembly}`,
      kind: componentPayloadKind(component.surface),
      room_name: room.name,
      assembly: component.assembly,
      direction: component.direction,
      area: component.area,
    }));
  });

  return {
    project: {
      name: project.name,
      location: "",
      description: "Generated from Baseline Takeoff Tool",
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
      assemblies: assemblyMap,
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

function normalizeFloor(rawFloor: Partial<TakeoffFloor> | undefined): TakeoffFloor {
  const fallback = makeInitialFloor();
  if (!rawFloor) return fallback;
  return {
    ...fallback,
    ...rawFloor,
    id: rawFloor.id || fallback.id,
    name: rawFloor.name || fallback.name,
    authoringMode: rawFloor.authoringMode || fallback.authoringMode,
    designGrid: { ...fallback.designGrid, ...(rawFloor.designGrid ?? {}) },
    scale: { ...fallback.scale, ...(rawFloor.scale ?? {}) },
    reference: rawFloor.reference,
    calibration: {
      ...fallback.calibration,
      ...(rawFloor.calibration ?? {}),
      lines: rawFloor.calibration?.lines ?? [],
    },
    conditionedPerimeter: { ...fallback.conditionedPerimeter, ...(rawFloor.conditionedPerimeter ?? {}) },
    exteriorPolygon: rawFloor.exteriorPolygon ?? [],
    perimeterLocked: Boolean(rawFloor.perimeterLocked),
    rooms: rawFloor.rooms ?? [],
    attributedSlices: rawFloor.attributedSlices ?? [],
  };
}

function normalizeTakeoffProject(rawProject: Partial<TakeoffProject>): TakeoffProject {
  const frontDoorFaces = directionOptions.includes(rawProject.frontDoorFaces as TakeoffProject["frontDoorFaces"])
    ? rawProject.frontDoorFaces as TakeoffProject["frontDoorFaces"]
    : "S";
  return makeTakeoffProject(
    rawProject.name || "Takeoff V1 Draft",
    frontDoorFaces,
    normalizeFloor(rawProject.floors?.[0]),
    rawProject.componentSchedule?.length ? rawProject.componentSchedule : defaultComponentSchedule,
  );
}

function takeoffSnapshot(project: TakeoffProject) {
  return JSON.stringify(project);
}

function persistableTakeoffProject(project: TakeoffProject): TakeoffProject {
  return {
    ...project,
    floors: project.floors.map((floor) => ({
      ...floor,
      reference: floor.reference
        ? {
            ...floor.reference,
            signedUrl: undefined,
            downloadUrl: undefined,
          }
        : floor.reference,
    })),
  };
}

function formatTimestamp(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function revokeReferenceUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function formatBytes(bytes?: number) {
  if (!bytes) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function categoryFromCode(code: string): TakeoffComponentCategory {
  const first = code.trim().toUpperCase()[0];
  if (first === "G") return "Glass";
  if (first === "D") return "Door";
  if (first === "C" || first === "R") return "Ceiling";
  if (first === "F") return "Floor";
  return "Wall";
}

function libraryCodeForCategory(category: TakeoffComponentCategory) {
  if (category === "Glass") return "G";
  if (category === "Door") return "D";
  if (category === "Ceiling") return "C";
  if (category === "Floor") return "F";
  return "W";
}

function nextScheduleSlotCode(category: TakeoffComponentCategory, schedule: TakeoffComponentDefinition[]) {
  const prefix = libraryCodeForCategory(category);
  const used = new Set(schedule.map((component) => component.code.trim().toUpperCase()));
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function scheduleIdFor(component: Pick<TakeoffComponentDefinition, "code" | "uValue" | "shgc" | "description">) {
  return `${component.code}-${component.uValue ?? "x"}-${component.shgc ?? "x"}-${component.description}`.replace(/\s+/g, "-");
}

export function TakeoffApp() {
  const [projectName, setProjectName] = useState("Takeoff V1 Draft");
  const [frontDoorFaces, setFrontDoorFaces] = useState<(typeof directionOptions)[number]>("S");
  const [componentSchedule, setComponentSchedule] = useState<TakeoffComponentDefinition[]>(() => defaultComponentSchedule);
  const [floor, setFloor] = useState<TakeoffFloor>(() => makeInitialFloor());
  const [draftRoom, setDraftRoom] = useState({ name: "", x: 0, y: 0, width: 0, depth: 0, ceilingHeight: 9 });
  const [message, setMessage] = useState("");
  const [takeoffId, setTakeoffId] = useState<number | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState(() => takeoffSnapshot(makeTakeoffProject("Takeoff V1 Draft", "S", makeInitialFloor(), defaultComponentSchedule)));
  const [saveLoading, setSaveLoading] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [openDialogLoading, setOpenDialogLoading] = useState(false);
  const [openDialogError, setOpenDialogError] = useState("");
  const [savedTakeoffs, setSavedTakeoffs] = useState<SavedTakeoffRow[]>([]);
  const [componentScheduleOpen, setComponentScheduleOpen] = useState(false);
  const [componentSearch, setComponentSearch] = useState("");
  const [pendingComponentAssignment, setPendingComponentAssignment] = useState<TakeoffComponentDefinition | null>(null);
  const [libraryComponents, setLibraryComponents] = useState<TakeoffComponentDefinition[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [componentDraft, setComponentDraft] = useState<Omit<TakeoffComponentDefinition, "id" | "source">>({
    code: "C1",
    category: "Ceiling",
    uValue: 0.033,
    shgc: null,
    description: "",
  });
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [traceTool, setTraceTool] = useState<"select" | "exterior">("select");
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>("trace");
  const [calibrationOrientation, setCalibrationOrientation] = useState<TakeoffScaleLine["orientation"]>("horizontal");
  const [calibrationStart, setCalibrationStart] = useState<TakeoffPoint | null>(null);
  const [referenceUrl, setReferenceUrl] = useState("");
  const [referenceRenderStatus, setReferenceRenderStatus] = useState("");
  const [dragState, setDragState] = useState<DragState>(null);
  const [roomDrawMode, setRoomDrawMode] = useState(false);
  const [roomPolygonMode, setRoomPolygonMode] = useState(false);
  const [roomPolygonDraft, setRoomPolygonDraft] = useState<TakeoffPoint[]>([]);
  const [subtractMode, setSubtractMode] = useState(false);
  const [subtractRoomId, setSubtractRoomId] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [sliceRoomId, setSliceRoomId] = useState("");
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const suppressNextCanvasClickRef = useRef(false);

  useEffect(() => {
    return () => {
      if (referenceUrl) revokeReferenceUrl(referenceUrl);
    };
  }, [referenceUrl]);

  const takeoffProject = useMemo<TakeoffProject>(
    () => makeTakeoffProject(projectName, frontDoorFaces, floor, componentSchedule),
    [componentSchedule, floor, frontDoorFaces, projectName],
  );
  const persistableTakeoff = useMemo(() => persistableTakeoffProject(takeoffProject), [takeoffProject]);
  const serializedTakeoff = useMemo(() => takeoffSnapshot(persistableTakeoff), [persistableTakeoff]);
  const isDirty = takeoffId === null || serializedTakeoff !== savedSnapshot;
  const validation = useMemo(() => buildValidation(floor), [floor]);
  const computedFootprintArea = footprintArea(floor);
  const assignedArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const unassignedArea = computedFootprintArea - assignedArea;
  const payload = useMemo(() => buildVrcPayload(takeoffProject), [takeoffProject]);
  const selectedRoom = floor.rooms.find((room) => room.id === selectedRoomId) ?? null;
  const floorScheduleOptions = componentSchedule.filter((component) => component.category === "Floor");
  const ceilingScheduleOptions = componentSchedule.filter((component) => component.category === "Ceiling");
  const scheduleOptionsBySurface = {
    floor: floorScheduleOptions,
    ceiling: ceilingScheduleOptions,
    wall: componentSchedule.filter((component) => component.category === "Wall"),
    glass: componentSchedule.filter((component) => component.category === "Glass"),
    door: componentSchedule.filter((component) => component.category === "Door"),
  } satisfies Record<TakeoffRoomComponent["surface"], TakeoffComponentDefinition[]>;
  const filteredLibraryComponents = libraryComponents.filter((component) => {
    const needle = componentSearch.trim().toLowerCase();
    const matchesSearch = !needle || `${component.code} ${component.description} ${component.category}`.toLowerCase().includes(needle);
    return matchesSearch;
  });
  const pendingComponentSlots = pendingComponentAssignment
    ? componentSchedule
        .map((component, index) => ({ component, index }))
        .filter(({ component }) => component.category === pendingComponentAssignment.category)
    : [];
  const bounds = footprintBounds(floor);
  const pendingScaleFactor = calibrationFactor(floor.calibration.lines);
  const areaDeltaPct = floor.calibration.expectedArea && computedFootprintArea > 0
    ? ((computedFootprintArea - floor.calibration.expectedArea) / floor.calibration.expectedArea) * 100
    : 0;
  const activeDragRect = dragState ? rectFromPoints(dragState.start, dragState.current) : null;
  const visibleCrop = floor.reference?.crop ?? { x: 0, y: 0, width: floor.designGrid.width, depth: floor.designGrid.depth };
  const unassignedCells = useMemo(() => {
    if (floor.exteriorPolygon.length < 3) return [];
    const cellSize = Math.max(1, floor.scale.feetPerGrid);
    const floorBounds = footprintBounds(floor);
    const attributed = floor.attributedSlices?.flatMap((slice) => slice.cells) ?? [];
    const cells: Array<{ x: number; y: number; width: number; depth: number }> = [];

    for (let y = floorBounds.y; y < floorBounds.y + floorBounds.depth; y += cellSize) {
      for (let x = floorBounds.x; x < floorBounds.x + floorBounds.width; x += cellSize) {
        const cell = {
          x: Number(x.toFixed(3)),
          y: Number(y.toFixed(3)),
          width: Math.min(cellSize, floorBounds.x + floorBounds.width - x),
          depth: Math.min(cellSize, floorBounds.y + floorBounds.depth - y),
        };
        const center = { x: cell.x + cell.width / 2, y: cell.y + cell.depth / 2 };
        const inFootprint = pointInPolygon(center, floor.exteriorPolygon);
        const inRoom = floor.rooms.some((room) => pointInRoom(center, room));
        const alreadyAttributed = attributed.some((slice) => center.x >= slice.x && center.x <= slice.x + slice.width && center.y >= slice.y && center.y <= slice.y + slice.depth);
        if (inFootprint && !inRoom && !alreadyAttributed) cells.push(cell);
      }
    }

    return cells.slice(0, 500);
  }, [floor]);
  const unassignedCellArea = unassignedCells.reduce((sum, cell) => sum + cell.width * cell.depth, 0);

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

  function updateRoom(roomId: string, patch: Partial<TakeoffRectRoom>) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === roomId ? { ...room, ...patch } : room)),
    }));
  }

  function addRoomComponent(roomId: string, surface: TakeoffRoomComponent["surface"]) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const roomArea = rectArea(room);
        const assignedArea = componentAreaTotal(room, surface);
        const remainingArea = Math.max(0, roomArea - assignedArea);
        const components = roomComponents(room);
        return {
          ...room,
          components: [...components, defaultComponent(surface, remainingArea || roomArea)],
        };
      }),
    }));
  }

  function updateRoomComponent(roomId: string, componentId: string, patch: Partial<TakeoffRoomComponent>) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return {
          ...room,
          components: roomComponents(room).map((component) => (component.id === componentId ? { ...component, ...patch } : component)),
        };
      }),
    }));
  }

  function removeRoomComponent(roomId: string, componentId: string) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (
        room.id === roomId
          ? { ...room, components: roomComponents(room).filter((component) => component.id !== componentId) }
          : room
      )),
    }));
  }

  function applyComponentToScheduleSlot(component: TakeoffComponentDefinition, target: number | "new") {
    setComponentSchedule((current) => {
      if (target === "new") {
        return [
          ...current,
          {
            ...component,
            id: nextId(`schedule-${component.category.toLowerCase()}`),
            code: nextScheduleSlotCode(component.category, current),
            shgc: component.category === "Glass" ? component.shgc ?? null : null,
            source: component.source,
          }
        ];
      }
      const targetIndex = current[target] ? target : 0;
      const targetComponent = current[targetIndex];
      if (!targetComponent) return current;
      return current.map((existing, index) => (
        index === targetIndex
          ? {
              ...existing,
              uValue: component.uValue,
              shgc: existing.category === "Glass" ? component.shgc ?? null : null,
              description: component.description,
              source: component.source,
            }
          : existing
      ));
    });
    setPendingComponentAssignment(null);
    setMessage("Component schedule updated.");
  }

  async function loadComponentLibrary() {
    setLibraryLoading(true);
    try {
      const rows: Array<{ code: string; u_value?: number | null; shgc?: number | null; label: string }> = await fetch("/api/assemblies").then((response) => {
        if (!response.ok) throw new Error("Could not load component library.");
        return response.json();
      });
      setLibraryComponents(rows.map((row) => ({
        id: scheduleIdFor({ code: row.code, uValue: row.u_value ?? undefined, shgc: row.shgc ?? null, description: row.label }),
        code: row.code,
        category: categoryFromCode(row.code),
        uValue: row.u_value ?? undefined,
        shgc: row.shgc ?? null,
        description: row.label,
        source: "library",
      })));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load component library.");
    } finally {
      setLibraryLoading(false);
    }
  }

  function openComponentSchedule() {
    setComponentScheduleOpen(true);
    void loadComponentLibrary();
  }

  function componentFromDraft(source: TakeoffComponentDefinition["source"]): TakeoffComponentDefinition {
    const code = libraryCodeForCategory(componentDraft.category);
    return {
      id: nextId(`schedule-${code || "component"}`),
      code,
      category: componentDraft.category,
      uValue: componentDraft.uValue,
      shgc: componentDraft.category === "Glass" ? componentDraft.shgc ?? null : null,
      description: componentDraft.description.trim(),
      source,
    };
  }

  function addDraftComponentToSchedule() {
    const component = componentFromDraft("one_off");
    if (!component.description) {
      setMessage("Component description is required.");
      return;
    }
    setPendingComponentAssignment(component);
  }

  async function saveDraftComponentToLibrary() {
    const component = componentFromDraft("library");
    if (!component.description) {
      setMessage("Component description is required.");
      return;
    }
    try {
      const response = await fetch("/api/assemblies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: component.code,
          u_value: component.uValue,
          shgc: component.category === "Glass" ? component.shgc : null,
          label: component.description,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      await loadComponentLibrary();
      setPendingComponentAssignment(component);
      setMessage("Component saved to the library. Choose where to assign it.");
    } catch (error) {
      setMessage(error instanceof Error ? `Could not save component: ${error.message}` : "Could not save component.");
    }
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

  async function renderPdfPreview(source: File | string) {
    setReferenceRenderStatus("Rendering PDF preview...");
    const arrayBuffer = typeof source === "string"
      ? await fetch(source).then((response) => {
          if (!response.ok) throw new Error("Could not download the saved PDF reference.");
          return response.arrayBuffer();
        })
      : await source.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create PDF preview canvas.");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    setReferenceRenderStatus(`Rendered page 1 of ${pdf.numPages}.`);
    return canvas.toDataURL("image/png");
  }

  function pointFromCanvasEvent(event: React.MouseEvent<SVGSVGElement>) {
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const svgX = (event.clientX - rect.left) * (drawingWidth / rect.width);
    const svgY = (event.clientY - rect.top) * (drawingHeight / rect.height);
    const rawX = (svgX - offsetX) / scale;
    const rawY = (svgY - offsetY) / scale;
    const x = Math.min(floor.designGrid.width, Math.max(0, rawX));
    const y = Math.min(floor.designGrid.depth, Math.max(0, rawY));
    return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) };
  }

  function snapToExistingGeometry(point: TakeoffPoint) {
    const threshold = Math.max(0.75, floor.scale.gridSnapInches / 12);
    let best = { point, distance: threshold };
    const segmentSets = [
      floor.exteriorPolygon,
      ...floor.rooms.map((room) => roomCorners(room)),
    ].filter((points) => points.length >= 2);

    for (const points of segmentSets) {
      for (let index = 0; index < points.length; index += 1) {
        const start = points[index];
        const end = points[(index + 1) % points.length];
        if (distance(point, start) <= best.distance) best = { point: start, distance: distance(point, start) };
        const projected = closestPointOnSegment(point, start, end);
        const projectedDistance = distance(point, projected);
        if (projectedDistance <= best.distance) best = { point: projected, distance: projectedDistance };
      }
    }

    return { x: Number(best.point.x.toFixed(3)), y: Number(best.point.y.toFixed(3)) };
  }

  function findMovablePoint(point: TakeoffPoint) {
    const threshold = Math.max(0.75, floor.scale.gridSnapInches / 12);
    let bestTarget: MovablePointTarget | null = null;
    let bestDistance = threshold;
    for (let index = 0; index < floor.exteriorPolygon.length; index += 1) {
      const candidate = floor.exteriorPolygon[index];
      const candidateDistance = distance(point, candidate);
      if (candidateDistance <= bestDistance) {
        bestTarget = { type: "exterior", index };
        bestDistance = candidateDistance;
      }
    }
    for (const room of floor.rooms) {
      if (!room.polygon) continue;
      for (let index = 0; index < room.polygon.length; index += 1) {
        const candidate = room.polygon[index];
        const candidateDistance = distance(point, candidate);
        if (candidateDistance <= bestDistance) {
          bestTarget = { type: "room", roomId: room.id, index };
          bestDistance = candidateDistance;
        }
      }
    }
    return bestTarget;
  }

  function movePoint(target: MovablePointTarget | undefined, point: TakeoffPoint) {
    if (!target) return;
    const snapped = snapToExistingGeometry(point);
    setFloor((current) => {
      if (target.type === "exterior") {
        return {
          ...current,
          perimeterLocked: false,
          exteriorPolygon: current.exteriorPolygon.map((existing, index) => (index === target.index ? snapped : existing)),
        };
      }
      return {
        ...current,
        rooms: current.rooms.map((room) => {
          if (room.id !== target.roomId || !room.polygon) return room;
          const polygon = room.polygon.map((existing, index) => (index === target.index ? snapped : existing));
          const bounds = polygonBounds(polygon);
          return { ...room, ...bounds, polygon };
        }),
      };
    });
  }

  function addCalibrationPoint(point: TakeoffPoint) {
    if (!calibrationStart) {
      setCalibrationStart(point);
      setMessage(`Scale line start set at ${point.x} ft, ${point.y} ft. Click the other end.`);
      return;
    }

    const end = { ...point };
    if (calibrationOrientation === "horizontal") end.y = calibrationStart.y;
    if (calibrationOrientation === "vertical") end.x = calibrationStart.x;

    const measured = lineLength({ start: calibrationStart, end });
    if (measured <= 0) {
      setMessage("Scale line needs two different points.");
      return;
    }

    const line: TakeoffScaleLine = {
      id: nextId("scale"),
      label: calibrationOrientation === "horizontal" ? "Known horizontal" : calibrationOrientation === "vertical" ? "Known vertical" : "Known dimension",
      orientation: calibrationOrientation,
      start: calibrationStart,
      end,
      knownFeet: Number(measured.toFixed(1)),
    };

    setFloor((current) => ({
      ...current,
      calibration: { ...current.calibration, lines: [...current.calibration.lines, line], confirmed: false, areaConfirmed: false },
    }));
    setCalibrationStart(null);
    setMessage("Scale line added. Enter the real dimension, then add another line or apply scale.");
  }

  function updateScaleLine(id: string, patch: Partial<Pick<TakeoffScaleLine, "label" | "knownFeet">>) {
    setFloor((current) => ({
      ...current,
      calibration: {
        ...current.calibration,
        confirmed: false,
        lines: current.calibration.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      },
    }));
  }

  function removeScaleLine(id: string) {
    setFloor((current) => ({
      ...current,
      calibration: { ...current.calibration, lines: current.calibration.lines.filter((line) => line.id !== id), confirmed: false },
    }));
  }

  function clearScaleLines() {
    setCalibrationStart(null);
    setFloor((current) => ({ ...current, calibration: { ...current.calibration, lines: [], confirmed: false, areaConfirmed: false } }));
    setMessage("Scale lines cleared.");
  }

  function applyCalibration() {
    const factor = calibrationFactor(floor.calibration.lines);
    if (!factor) {
      setMessage("Add at least one scale line with a known dimension before applying scale.");
      return;
    }

    setFloor((current) => ({
      ...current,
      designGrid: {
        width: Number((current.designGrid.width * factor).toFixed(3)),
        depth: Number((current.designGrid.depth * factor).toFixed(3)),
      },
      conditionedPerimeter: {
        width: Number((current.conditionedPerimeter.width * factor).toFixed(3)),
        depth: Number((current.conditionedPerimeter.depth * factor).toFixed(3)),
      },
      exteriorPolygon: current.exteriorPolygon.map((point) => scalePoint(point, factor)),
      rooms: current.rooms.map((room) => scaleRoom(room, factor)),
      reference: current.reference
        ? {
            ...current.reference,
            crop: current.reference.crop ? scaleRect(current.reference.crop, factor) : current.reference.crop,
          }
        : current.reference,
      attributedSlices: current.attributedSlices?.map((slice) => ({
        ...slice,
        cells: slice.cells.map((cell) => scaleRect(cell, factor)),
      })),
      calibration: {
        ...current.calibration,
        lines: current.calibration.lines.map((line) => scaleLine(line, factor)),
        confirmed: true,
        appliedFactor: Number((current.calibration.appliedFactor * factor).toFixed(5)),
        areaConfirmed: false,
      },
    }));
    setWorkflowStep("trace");
    setTraceTool("exterior");
    setCalibrationStart(null);
    setMessage(`Scale applied. Average correction factor: ${factor.toFixed(3)}.`);
  }

  function skipCalibration() {
    setFloor((current) => ({ ...current, calibration: { ...current.calibration, confirmed: true } }));
    setWorkflowStep("trace");
    setTraceTool("exterior");
    setMessage("Calibration skipped. Trace carefully and confirm the computed floor area before room work.");
  }

  function updateExpectedArea(value: number) {
    setFloor((current) => ({
      ...current,
      calibration: { ...current.calibration, expectedArea: Number.isFinite(value) && value > 0 ? value : undefined, areaConfirmed: false },
    }));
  }

  function confirmFootprintArea() {
    if (floor.exteriorPolygon.length < 3) {
      setMessage("Trace the exterior perimeter before confirming floor area.");
      return;
    }
    setFloor((current) => ({ ...current, calibration: { ...current.calibration, areaConfirmed: true } }));
    setMessage("Footprint area confirmed. You can continue assigning rooms.");
  }

  function applyCrop(crop: { x: number; y: number; width: number; depth: number }) {
    if (crop.width < 1 || crop.depth < 1) {
      setMessage("Crop area is too small. Drag around the plan area you want to keep.");
      return;
    }
    setFloor((current) => ({
      ...current,
      reference: current.reference ? { ...current.reference, crop } : current.reference,
    }));
    setWorkflowStep("calibrate");
    setMessage("Crop applied. Add known dimension lines to set plan scale.");
  }

  function clearCrop() {
    setFloor((current) => ({
      ...current,
      reference: current.reference
        ? { ...current.reference, crop: { x: 0, y: 0, width: current.designGrid.width, depth: current.designGrid.depth } }
        : current.reference,
    }));
    setWorkflowStep("crop");
    setMessage("Crop reset. Drag a new crop around the plan area.");
  }

  function availablePolygonFromRect(rect: PlanRect, ignoredRoomId?: string) {
    if (rect.width < 0.25 || rect.depth < 0.25) return null;
    return availablePolygonFromPoints(rectToPoints(rect), ignoredRoomId);
  }

  function availablePolygonFromPoints(points: TakeoffPoint[], ignoredRoomId?: string) {
    if (points.length < 3 || polygonArea(points) < 0.25) return null;
    let available: MultiPolygon = [pointsToClipPolygon(points)];
    if (floor.exteriorPolygon.length >= 3) {
      available = intersection(available, pointsToClipPolygon(floor.exteriorPolygon));
    } else if (floor.conditionedPerimeter.width > 0 && floor.conditionedPerimeter.depth > 0) {
      available = intersection(available, pointsToClipPolygon(rectToPoints({
        x: 0,
        y: 0,
        width: floor.conditionedPerimeter.width,
        depth: floor.conditionedPerimeter.depth,
      })));
    }
    const blockers = floor.rooms
      .filter((room) => room.id !== ignoredRoomId)
      .map((room) => roomToClipPolygon(room));
    if (blockers.length > 0) {
      available = difference(available, ...blockers);
    }
    return largestClipPolygon(available);
  }

  function makeRoomFromPolygon(points: TakeoffPoint[]) {
    const bounds = polygonBounds(points);
    const room = {
      id: nextId("room"),
      name: `${draftRoom.name || "Room"} ${floor.rooms.length + 1}`,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      depth: bounds.depth,
      ceilingHeight: draftRoom.ceilingHeight,
      polygon: points,
    } satisfies TakeoffRectRoom;
    return { ...room, components: defaultRoomComponents(rectArea(room)) };
  }

  function addDraggedRoom(rect: { x: number; y: number; width: number; depth: number }) {
    if (rect.width < 1 || rect.depth < 1) {
      setMessage("Drag a larger area to create a room.");
      return;
    }
    const availablePolygon = availablePolygonFromRect(rect);
    if (!availablePolygon) {
      setMessage("No open room area remains after clipping to the exterior and existing rooms.");
      return;
    }
    const points = clipPolygonToPoints(availablePolygon);
    const room = makeRoomFromPolygon(points);
    setFloor((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelectedRoomId(room.id);
    setMessage(`${room.name} added as available polygon area.`);
  }

  function subtractDraggedShape(rect: PlanRect) {
    const roomId = subtractRoomId || floor.rooms[0]?.id;
    const targetRoom = floor.rooms.find((room) => room.id === roomId);
    if (!targetRoom) {
      setMessage("Select a room before using the subtract tool.");
      return;
    }
    const subtractShape = availablePolygonFromRect(rect, targetRoom.id) ?? pointsToClipPolygon(rectToPoints(rect));
    const result = difference(roomToClipPolygon(targetRoom), subtractShape);
    const largest = largestClipPolygon(result);
    if (!largest) {
      setMessage("Subtraction would remove the entire room.");
      return;
    }
    const polygon = clipPolygonToPoints(largest);
    const bounds = polygonBounds(polygon);
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === targetRoom.id ? { ...room, ...bounds, polygon } : room)),
    }));
    setMessage(`Subtracted shape from ${targetRoom.name}.`);
  }

  function createPolygonRoom(points: TakeoffPoint[]) {
    if (points.length < 3) {
      setMessage("Polygon room needs at least 3 points.");
      return false;
    }
    let availablePolygon: Polygon | null = null;
    try {
      availablePolygon = availablePolygonFromPoints(points);
    } catch (error) {
      setMessage("That polygon could not be resolved. Try clearing points and drawing the room with simpler edges.");
      return false;
    }
    if (!availablePolygon) {
      setMessage("That polygon does not enclose any open room area inside the conditioned footprint.");
      return false;
    }
    const room = makeRoomFromPolygon(clipPolygonToPoints(availablePolygon));
    setFloor((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelectedRoomId(room.id);
    setRoomPolygonDraft([]);
    setRoomPolygonMode(false);
    setTraceTool("select");
    setMessage(`${room.name} added as available polygon area.`);
    return true;
  }

  function finishPolygonRoom(suppressCanvasClick = false) {
    if (suppressCanvasClick) suppressNextCanvasClickRef.current = true;
    if (roomPolygonDraft.length < 3) {
      setMessage("Add at least 3 polygon points before finishing the room.");
      return false;
    }
    return createPolygonRoom(roomPolygonDraft);
  }

  function addPolygonRoomPoint(point: TakeoffPoint) {
    const snapped = snapToExistingGeometry(point);
    if (roomPolygonDraft.length >= 3 && distance(snapped, roomPolygonDraft[0]) <= Math.max(1, floor.scale.gridSnapInches / 12)) {
      finishPolygonRoom();
      return;
    }
    setRoomPolygonDraft((current) => [...current, snapped]);
    setMessage(roomPolygonDraft.length >= 2 ? "Polygon point added. Click Close or press Enter to finish." : "Polygon point added.");
  }

  function assignHighlightedSlices() {
    const roomId = sliceRoomId || floor.rooms[0]?.id;
    if (!roomId || unassignedCells.length === 0) return;
    const targetRoom = floor.rooms.find((room) => room.id === roomId);
    if (!targetRoom) return;
    const cellPolygons = unassignedCells.map((cell) => pointsToClipPolygon(rectToPoints(cell)));
    const merged = union(roomToClipPolygon(targetRoom), ...cellPolygons);
    const largest = largestClipPolygon(merged);
    if (!largest) {
      setMessage("Could not merge highlighted slices into that room.");
      return;
    }
    const polygon = clipPolygonToPoints(largest);
    const bounds = polygonBounds(polygon);
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === roomId ? { ...room, ...bounds, polygon, areaAdjustment: undefined } : room)),
      attributedSlices: [
        ...(current.attributedSlices ?? []),
        { id: nextId("slice"), roomId, cells: unassignedCells },
      ],
    }));
    setMessage(`${Math.round(unassignedCellArea)} sf merged into ${targetRoom.name}.`);
  }

  function handleCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    if (event.shiftKey) {
      const target = findMovablePoint(point);
      if (target) {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragState({ kind: "move-point", start: point, current: point, target });
        setMessage("Move point started. Drag to the new location.");
      }
      return;
    }
    if (workflowStep === "crop") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "crop", start: point, current: point });
      return;
    }
    if (workflowStep === "trace" && subtractMode) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "subtract", start: point, current: point });
      return;
    }
    if (workflowStep === "trace" && roomDrawMode) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "room", start: point, current: point });
    }
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState) return;
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    if (dragState.kind === "move-point") {
      movePoint(dragState.target, point);
    }
    setDragState((current) => (current ? { ...current, current: point } : current));
  }

  function handleCanvasPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState) return;
    const rect = rectFromPoints(dragState.start, dragState.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const kind = dragState.kind;
    setDragState(null);
    suppressNextCanvasClickRef.current = true;
    if (kind === "move-point") {
      setMessage("Point moved.");
      return;
    }
    if (kind === "crop") {
      applyCrop(rect);
      return;
    }
    if (kind === "subtract") {
      subtractDraggedShape(rect);
      return;
    }
    addDraggedRoom(rect);
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
    const nextZoom = Math.min(8, Math.max(0.5, Math.min((canvasWidth - 56) / (planWidth * baseScale), (canvasHeight - 56) / (planDepth * baseScale))));
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
    if (suppressNextCanvasClickRef.current) {
      suppressNextCanvasClickRef.current = false;
      return;
    }
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    if (event.shiftKey || dragState) return;
    if (workflowStep === "calibrate") {
      addCalibrationPoint(point);
      return;
    }
    if (workflowStep === "trace" && roomPolygonMode) {
      addPolygonRoomPoint(point);
      return;
    }
    if (traceTool !== "exterior" || floor.perimeterLocked) return;
    addExteriorPoint(snapToExistingGeometry(point));
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

    room = { ...room, components: defaultRoomComponents(rectArea(room)) };
    setFloor((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelectedRoomId(room.id);
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
    if (selectedRoomId === id) setSelectedRoomId(null);
  }

  async function uploadReferenceAsset(file: File, floorId: string) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("floor_id", floorId);
    formData.append("page_number", "1");

    const response = await fetch("/api/takeoff-assets", { method: "POST", body: formData });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "Could not upload plan reference.");
    }
    return await response.json() as UploadedTakeoffAsset;
  }

  async function saveTakeoff() {
    setSaveLoading(true);
    setMessage("");
    try {
      const response = await fetch(takeoffId ? `/api/takeoffs/${takeoffId}` : "/api/takeoffs", {
        method: takeoffId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: serializedTakeoff,
      });
      if (!response.ok) throw new Error(await response.text());
      const data: { id: number } = await response.json();
      setTakeoffId(data.id);
      setSavedSnapshot(serializedTakeoff);
      setMessage("Takeoff saved.");
    } catch (error) {
      setMessage(error instanceof Error ? `Could not save takeoff: ${error.message}` : "Could not save takeoff.");
    } finally {
      setSaveLoading(false);
    }
  }

  async function openTakeoffList() {
    setOpenDialog(true);
    setOpenDialogLoading(true);
    setOpenDialogError("");
    try {
      const response = await fetch("/api/takeoffs");
      if (!response.ok) throw new Error(await response.text());
      const rows: SavedTakeoffRow[] = await response.json();
      setSavedTakeoffs(rows);
    } catch (error) {
      setOpenDialogError(error instanceof Error ? error.message : "Could not load saved takeoffs.");
    } finally {
      setOpenDialogLoading(false);
    }
  }

  async function loadTakeoff(id: number) {
    setOpenDialogLoading(true);
    setOpenDialogError("");
    try {
      const response = await fetch(`/api/takeoffs/${id}`);
      if (!response.ok) throw new Error(await response.text());
      const loadedProject = normalizeTakeoffProject(await response.json());
      if (referenceUrl) revokeReferenceUrl(referenceUrl);
      const loadedReference = loadedProject.floors[0].reference;
      if (loadedReference?.downloadUrl) {
        const restoredUrl = loadedReference.kind === "pdf"
          ? await renderPdfPreview(loadedReference.downloadUrl)
          : loadedReference.downloadUrl;
        setReferenceUrl(restoredUrl);
        setReferenceRenderStatus(`Reference restored: ${loadedReference.filename}`);
      } else {
        setReferenceUrl("");
      setReferenceRenderStatus(loadedReference ? "Reference metadata reopened, but the stored file was not available." : "");
      }
      setProjectName(loadedProject.name);
      setFrontDoorFaces(loadedProject.frontDoorFaces);
      setComponentSchedule(loadedProject.componentSchedule?.length ? loadedProject.componentSchedule : defaultComponentSchedule);
      setFloor(loadedProject.floors[0]);
      setTakeoffId(id);
      setSavedSnapshot(takeoffSnapshot(persistableTakeoffProject(loadedProject)));
      setOpenDialog(false);
      setCalibrationStart(null);
      setRoomPolygonDraft([]);
      setDragState(null);
      setWorkflowStep("trace");
      setTraceTool("select");
      setMessage("Takeoff reopened.");
    } catch (error) {
      setOpenDialogError(error instanceof Error ? error.message : "Could not open takeoff.");
    } finally {
      setOpenDialogLoading(false);
    }
  }

  async function handleReference(file: File | undefined) {
    if (!file) return;
    const kind = file.type.includes("pdf") ? "pdf" : "image";
    if (file.size > takeoffReferenceMaxBytes) {
      setMessage("Plan reference files are capped at 7 MB. Please upload a single extracted floor-plan page.");
      return;
    }
    if (!["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setMessage("Upload a PDF, PNG, JPEG, or WebP plan reference.");
      return;
    }
    if (referenceUrl) revokeReferenceUrl(referenceUrl);
    try {
      const nextReferenceUrl = kind === "pdf" ? await renderPdfPreview(file) : URL.createObjectURL(file);
      setReferenceRenderStatus("Uploading plan reference...");
      const asset = await uploadReferenceAsset(file, floor.id);
      setReferenceUrl(nextReferenceUrl);
      setReferenceRenderStatus(`Stored ${asset.filename} (${formatBytes(asset.size_bytes)}).`);
      setFloor((current) => ({
        ...current,
        authoringMode: kind === "pdf" ? "pdf_trace" : "image_trace",
        reference: {
          filename: file.name,
          kind,
          assetId: asset.id,
          storagePath: asset.storage_path,
          mimeType: asset.mime_type,
          sizeBytes: asset.size_bytes,
          downloadUrl: asset.download_url,
          signedUrl: asset.signed_url,
          crop: { x: 0, y: 0, width: current.designGrid.width, depth: current.designGrid.depth },
        },
        calibration: { lines: [], confirmed: false, appliedFactor: 1, areaConfirmed: false },
        exteriorPolygon: [],
        perimeterLocked: false,
      }));
    } catch (error) {
      setReferenceUrl("");
      setReferenceRenderStatus("Could not store the plan reference.");
      setMessage(error instanceof Error ? error.message : "Could not store the plan reference.");
      return;
    }
    setWorkflowStep("crop");
    setTraceTool("select");
    setRoomDrawMode(false);
    setCalibrationStart(null);
    setDragState(null);
    setRightPanelOpen(false);
    setZoom(1);
    setMessage("Reference uploaded. Drag a crop around the plan area, then continue to scale setup.");
  }

  useEffect(() => {
    if (!roomPolygonMode) return;
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        finishPolygonRoom();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setRoomPolygonDraft([]);
        setMessage("Polygon draft cleared.");
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [roomPolygonDraft, roomPolygonMode]);

  return (
    <main className="takeoff-root">
      <header className="takeoff-toolbar">
        <div>
          <h1>Takeoff V1</h1>
          <p>
            {floor.name} · {Math.round(assignedArea)} sf assigned · {Math.max(0, Math.round(unassignedArea))} sf open
            {takeoffId ? ` · Takeoff #${takeoffId}` : ""}
          </p>
        </div>
        <div className="takeoff-toolbar-actions">
          <button onClick={openComponentSchedule}>Component Schedule</button>
          <button onClick={openTakeoffList}>Open</button>
          <button className="toolbar-primary" onClick={saveTakeoff} disabled={saveLoading}>
            {saveLoading ? "Saving..." : takeoffId ? "Save" : "Save Draft"}
          </button>
          <span className={`takeoff-save-status ${isDirty ? "takeoff-save-status--dirty" : ""}`}>
            {isDirty ? "Unsaved" : "Saved"}
          </span>
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
            {floor.reference && (
              <p className="takeoff-muted">
                {floor.reference.filename}
                {floor.reference.sizeBytes ? ` · ${formatBytes(floor.reference.sizeBytes)}` : ""}
                {floor.reference.assetId ? ` · stored asset #${floor.reference.assetId}` : ""}
              </p>
            )}
            {referenceRenderStatus && <p className="takeoff-muted">{referenceRenderStatus}</p>}
            {floor.authoringMode !== "grid_manual" && (
              <p className="takeoff-note">
                The reference is shown under the grid. Upload one floor-plan page at a time, up to 7 MB.
              </p>
            )}
          </section>

          {floor.reference && (
            <section className="takeoff-panel">
              <div className="takeoff-panel-head">
                <h2>Import Scale</h2>
              </div>
              <p className="takeoff-muted">
                {workflowStep === "calibrate" ? "Click two endpoints for known dimensions on the preview." : "Scale setup complete."}
              </p>
              <div className="takeoff-form-actions">
                <button className={workflowStep === "crop" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("crop"); setRoomDrawMode(false); }}>Crop</button>
                <button className={workflowStep === "calibrate" && calibrationOrientation === "horizontal" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("horizontal"); }}>Horizontal</button>
                <button className={workflowStep === "calibrate" && calibrationOrientation === "vertical" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("vertical"); }}>Vertical</button>
                <button className={workflowStep === "calibrate" && calibrationOrientation === "any" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("any"); }}>Any</button>
              </div>
              {workflowStep === "crop" && <p className="takeoff-note">Drag a rectangle around only the plan and visible dimensions. This removes title blocks and border clutter before scaling.</p>}
              {calibrationStart && <p className="takeoff-note">First point is set. Click the other end of the known dimension.</p>}
              <div className="takeoff-scale-list">
                {floor.calibration.lines.map((line) => {
                  const measured = lineLength(line);
                  const factor = measured > 0 && line.knownFeet > 0 ? line.knownFeet / measured : 0;
                  return (
                    <div key={line.id} className="takeoff-scale-row">
                      <label>
                        Label
                        <input value={line.label} onChange={(event) => updateScaleLine(line.id, { label: event.target.value })} />
                      </label>
                      <label>
                        Known ft
                        <input type="number" min="0" step="0.1" value={line.knownFeet} onChange={(event) => updateScaleLine(line.id, { knownFeet: Number(event.target.value) })} />
                      </label>
                      <span>{measured.toFixed(1)} grid ft · {factor ? factor.toFixed(3) : "-"}x</span>
                      <button onClick={() => removeScaleLine(line.id)}>Remove</button>
                    </div>
                  );
                })}
              </div>
              <p className="takeoff-muted">
                {pendingScaleFactor ? `Average scale correction: ${pendingScaleFactor.toFixed(3)}x` : "Add at least one known dimension."}
              </p>
              <div className="takeoff-form-actions">
                <button className="toolbar-primary" onClick={applyCalibration}>Apply Scale</button>
                <button onClick={skipCalibration}>Skip</button>
                <button onClick={clearScaleLines}>Clear Lines</button>
                <button onClick={clearCrop}>Reset Crop</button>
              </div>
            </section>
          )}

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
            <label>
              Expected floor area sf
              <input
                type="number"
                min="0"
                value={floor.calibration.expectedArea ?? ""}
                onChange={(event) => updateExpectedArea(Number(event.target.value))}
              />
            </label>
            <p className="takeoff-muted">
              Computed {Math.round(computedFootprintArea)} sf
              {floor.calibration.expectedArea ? ` · ${areaDeltaPct >= 0 ? "+" : ""}${areaDeltaPct.toFixed(1)}% vs expected` : ""}
              {floor.calibration.areaConfirmed ? " · confirmed" : ""}
            </p>
            <button onClick={confirmFootprintArea}>Confirm Area</button>
          </section>
          </>
          )}
        </aside>

        <section className="takeoff-stage-panel">
          <div className="takeoff-stage-head">
            <div>
              <h2>{workflowStep === "crop" ? "Crop Plan Reference" : workflowStep === "calibrate" ? "Import Scale Setup" : "Plan Grid"}</h2>
              <p>
                {Math.round(computedFootprintArea)} sf conditioned footprint · {floor.designGrid.width} x {floor.designGrid.depth} ft design grid
                {floor.calibration.confirmed ? ` · scale ${floor.calibration.appliedFactor}x` : ""}
              </p>
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
                <button onClick={() => setZoom((current) => Math.min(8, Number((current + 0.25).toFixed(2))))}>+</button>
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
                    <img
                      src={referenceUrl}
                      alt={`${floor.reference.filename} reference`}
                      style={{
                        left: `${-(visibleCrop.x / Math.max(visibleCrop.width, 1)) * 100}%`,
                        top: `${-(visibleCrop.y / Math.max(visibleCrop.depth, 1)) * 100}%`,
                        width: `${(floor.designGrid.width / Math.max(visibleCrop.width, 1)) * 100}%`,
                        height: `${(floor.designGrid.depth / Math.max(visibleCrop.depth, 1)) * 100}%`,
                      }}
                    />
                  ) : (
                    <img
                      src={referenceUrl}
                      alt={`${floor.reference.filename} rendered PDF reference`}
                      style={{
                        left: `${-(visibleCrop.x / Math.max(visibleCrop.width, 1)) * 100}%`,
                        top: `${-(visibleCrop.y / Math.max(visibleCrop.depth, 1)) * 100}%`,
                        width: `${(floor.designGrid.width / Math.max(visibleCrop.width, 1)) * 100}%`,
                        height: `${(floor.designGrid.depth / Math.max(visibleCrop.depth, 1)) * 100}%`,
                      }}
                    />
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
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={() => setDragState(null)}
              onClick={handleCanvasClick}
              style={{ cursor: workflowStep === "crop" || workflowStep === "calibrate" || roomDrawMode || (traceTool === "exterior" && !floor.perimeterLocked) ? "crosshair" : "default" }}
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
              {unassignedCells.map((cell, index) => (
                <rect
                  key={`unassigned-${index}-${cell.x}-${cell.y}`}
                  x={offsetX + cell.x * scale}
                  y={offsetY + cell.y * scale}
                  width={cell.width * scale}
                  height={cell.depth * scale}
                  fill="rgba(244, 187, 68, 0.28)"
                  stroke="rgba(154, 106, 18, 0.38)"
                  strokeWidth="0.5"
                />
              ))}
              {activeDragRect && (
                <rect
                  x={offsetX + activeDragRect.x * scale}
                  y={offsetY + activeDragRect.y * scale}
                  width={activeDragRect.width * scale}
                  height={activeDragRect.depth * scale}
                  fill={dragState?.kind === "crop" || dragState?.kind === "subtract" ? "rgba(179, 67, 47, 0.12)" : "rgba(72, 128, 93, 0.16)"}
                  stroke={dragState?.kind === "crop" || dragState?.kind === "subtract" ? "#b3432f" : "#2f7a4f"}
                  strokeDasharray="6 4"
                  strokeWidth="2"
                />
              )}
              {floor.calibration.lines.map((line, index) => (
                <g key={line.id}>
                  <line
                    x1={offsetX + line.start.x * scale}
                    y1={offsetY + line.start.y * scale}
                    x2={offsetX + line.end.x * scale}
                    y2={offsetY + line.end.y * scale}
                    stroke="#b3432f"
                    strokeWidth="2.5"
                  />
                  <circle cx={offsetX + line.start.x * scale} cy={offsetY + line.start.y * scale} r="4" fill="#b3432f" stroke="#ffffff" strokeWidth="1.5" />
                  <circle cx={offsetX + line.end.x * scale} cy={offsetY + line.end.y * scale} r="4" fill="#b3432f" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + ((line.start.x + line.end.x) / 2) * scale + 6} y={offsetY + ((line.start.y + line.end.y) / 2) * scale - 6} fontSize="11" fill="#7f2d20">
                    {line.knownFeet || lineLength(line).toFixed(1)} ft {index + 1}
                  </text>
                </g>
              ))}
              {calibrationStart && (
                <g>
                  <circle cx={offsetX + calibrationStart.x * scale} cy={offsetY + calibrationStart.y * scale} r="5" fill="#b3432f" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + calibrationStart.x * scale + 7} y={offsetY + calibrationStart.y * scale - 7} fontSize="11" fill="#7f2d20">start</text>
                </g>
              )}
              {floor.rooms.map((room, index) => (
                <g
                  key={room.id}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedRoomId(room.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {room.polygon && room.polygon.length >= 3 ? (
                    <polygon
                      points={room.polygon.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                      fill={roomColor(index)}
                      fillOpacity="0.75"
                      stroke={selectedRoomId === room.id ? "#0f5fa8" : "#324457"}
                      strokeWidth={selectedRoomId === room.id ? "3" : "1.5"}
                    />
                  ) : (
                    <rect
                      x={offsetX + room.x * scale}
                      y={offsetY + room.y * scale}
                      width={room.width * scale}
                      height={room.depth * scale}
                      fill={roomColor(index)}
                      fillOpacity="0.75"
                      stroke={selectedRoomId === room.id ? "#0f5fa8" : "#324457"}
                      strokeWidth={selectedRoomId === room.id ? "3" : "1.5"}
                    />
                  )}
                  {room.polygon?.map((point, pointIndex) => (
                    <circle key={`${room.id}-point-${pointIndex}`} cx={offsetX + point.x * scale} cy={offsetY + point.y * scale} r="3.5" fill="#324457" stroke="#ffffff" strokeWidth="1.2" />
                  ))}
                  {editingRoomId === room.id ? (
                    <foreignObject x={offsetX + roomCenter(room).x * scale - 50} y={offsetY + roomCenter(room).y * scale - 17} width="120" height="32">
                      <input
                        className="takeoff-svg-input"
                        value={room.name}
                        autoFocus
                        onBlur={() => setEditingRoomId(null)}
                        onChange={(event) => {
                          const name = event.target.value;
                          setFloor((current) => ({
                            ...current,
                            rooms: current.rooms.map((existing) => (existing.id === room.id ? { ...existing, name } : existing)),
                          }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === "Escape") setEditingRoomId(null);
                        }}
                      />
                    </foreignObject>
                  ) : (
                    <text
                      x={offsetX + roomCenter(room).x * scale}
                      y={offsetY + roomCenter(room).y * scale}
                      fontSize="12"
                      fill="#1f2933"
                      textAnchor="middle"
                      onClick={(event) => {
                        event.stopPropagation();
                        setEditingRoomId(room.id);
                      }}
                      style={{ cursor: "text", fontWeight: 700 }}
                    >
                      {room.name}
                    </text>
                  )}
                  <text x={offsetX + roomCenter(room).x * scale} y={offsetY + roomCenter(room).y * scale + 16} fontSize="11" fill="#465667" textAnchor="middle">
                    {Math.round(rectArea(room))} sf
                  </text>
                </g>
              ))}
              {roomPolygonDraft.length > 0 && (
                <g>
                  <polyline
                    points={roomPolygonDraft.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                    fill="none"
                    stroke="#2f7a4f"
                    strokeDasharray="6 4"
                    strokeWidth="2"
                  />
                  {roomPolygonDraft.length >= 3 && (
                    <>
                      <line
                        x1={offsetX + roomPolygonDraft[roomPolygonDraft.length - 1].x * scale}
                        y1={offsetY + roomPolygonDraft[roomPolygonDraft.length - 1].y * scale}
                        x2={offsetX + roomPolygonDraft[0].x * scale}
                        y2={offsetY + roomPolygonDraft[0].y * scale}
                        stroke="#2f7a4f"
                        strokeDasharray="3 4"
                        strokeWidth="2"
                      />
                      <polygon
                        points={roomPolygonDraft.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                        fill="rgba(72, 128, 93, 0.12)"
                        stroke="none"
                      />
                    </>
                  )}
                  {roomPolygonDraft.map((point, index) => {
                    const canClose = index === 0 && roomPolygonDraft.length >= 3;
                    return (
                      <g
                        key={`draft-room-point-${index}`}
                        onClick={(event) => {
                          if (!canClose) return;
                          event.preventDefault();
                          event.stopPropagation();
                          finishPolygonRoom(true);
                        }}
                        onPointerDown={(event) => {
                          if (!canClose) return;
                          event.preventDefault();
                          event.stopPropagation();
                          suppressNextCanvasClickRef.current = true;
                        }}
                        onPointerUp={(event) => {
                          if (!canClose) return;
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        style={{ cursor: canClose ? "pointer" : "default" }}
                      >
                        <circle
                          cx={offsetX + point.x * scale}
                          cy={offsetY + point.y * scale}
                          r={canClose ? 7 : 4}
                          fill={canClose ? "#1f6f3c" : "#2f7a4f"}
                          stroke="#ffffff"
                          strokeWidth={canClose ? "2" : "1.5"}
                        />
                        {canClose && (
                          <text
                            x={offsetX + point.x * scale + 10}
                            y={offsetY + point.y * scale - 8}
                            fontSize="11"
                            fill="#1f6f3c"
                            fontWeight="700"
                          >
                            Close
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              )}
            </svg>
            </div>
          </div>

          <div className="takeoff-lower-grid">
            <section className="takeoff-panel">
              <div className="takeoff-panel-head">
                <h2>New Room</h2>
              </div>
              <div className="takeoff-form-actions">
                <button className={roomDrawMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setRoomDrawMode((current) => !current); setRoomPolygonMode(false); setSubtractMode(false); setTraceTool("select"); }}>Draw Rect</button>
                <button className={roomPolygonMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setRoomPolygonMode((current) => !current); setRoomDrawMode(false); setSubtractMode(false); setTraceTool("select"); }}>Draw Polygon</button>
                <button className={subtractMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setSubtractMode((current) => !current); setRoomDrawMode(false); setRoomPolygonMode(false); setTraceTool("select"); }}>Subtract</button>
                {roomPolygonDraft.length >= 3 && <button className="toolbar-primary" onClick={() => finishPolygonRoom()}>Finish Polygon</button>}
                {roomPolygonDraft.length > 0 && <button onClick={() => setRoomPolygonDraft([])}>Clear Points</button>}
              </div>
              {roomDrawMode && <p className="takeoff-note">Drag over the plan to create a room rectangle. Point-by-point room shapes are the next step.</p>}
              {roomPolygonMode && <p className="takeoff-note">Click room corners. After 3 points, use Finish Polygon, press Enter, or click the Close marker on the first point.</p>}
              {subtractMode && (
                <>
                  <label>
                    Subtract from
                    <select value={subtractRoomId || floor.rooms[0]?.id || ""} onChange={(event) => setSubtractRoomId(event.target.value)}>
                      {floor.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                    </select>
                  </label>
                  <p className="takeoff-note">Drag a subtraction shape across the selected room to cut it away.</p>
                </>
              )}
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
              {unassignedCells.length > 0 && (
                <div className="takeoff-slice-tools">
                  <p className="takeoff-muted">{Math.round(unassignedCellArea)} sf highlighted as unassigned slices.</p>
                  <select value={sliceRoomId || floor.rooms[0]?.id || ""} onChange={(event) => setSliceRoomId(event.target.value)}>
                    {floor.rooms.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                  </select>
                  <button onClick={assignHighlightedSlices}>Attribute Highlighted Area</button>
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
                <div
                  key={room.id}
                  className={`takeoff-room-row ${selectedRoomId === room.id ? "takeoff-room-row--selected" : ""}`}
                  onClick={() => setSelectedRoomId(room.id)}
                >
                  <div>
                    <strong>{room.name}</strong>
                    <span>
                      {Math.round(rectArea(room))} sf · {room.ceilingHeight} ft ·
                      floor {Math.round(componentAreaTotal(room, "floor"))} sf ·
                      ceiling {Math.round(componentAreaTotal(room, "ceiling"))} sf
                    </span>
                  </div>
                  <button onClick={(event) => { event.stopPropagation(); removeRoom(room.id); }}>Remove</button>
                </div>
              ))}
            </div>
          </section>

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Room Profile</h2>
            </div>
            {selectedRoom ? (
              <>
                <label>
                  Name
                  <input value={selectedRoom.name} onChange={(event) => updateRoom(selectedRoom.id, { name: event.target.value })} />
                </label>
                <label>
                  Ceiling height ft
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={selectedRoom.ceilingHeight}
                    onChange={(event) => updateRoom(selectedRoom.id, { ceilingHeight: Number(event.target.value) })}
                  />
                </label>
                {(["floor", "ceiling", "wall", "glass", "door"] as const).map((surface) => {
                  const roomArea = rectArea(selectedRoom);
                  const assigned = componentAreaTotal(selectedRoom, surface);
                  const delta = roomArea - assigned;
                  const isAreaChecked = surface === "floor" || surface === "ceiling";
                  const options = scheduleOptionsBySurface[surface];
                  return (
                    <div key={surface} className="takeoff-component-editor">
                      <div className="takeoff-component-head">
                        <h3>{componentSurfaceLabel(surface)} Components</h3>
                        <button onClick={() => addRoomComponent(selectedRoom.id, surface)}>Add</button>
                      </div>
                      {isAreaChecked ? (
                        <p className={assigned > roomArea + 0.5 ? "takeoff-component-total takeoff-component-total--error" : "takeoff-component-total"}>
                          Assigned {Math.round(assigned)} / {Math.round(roomArea)} sf
                          {Math.abs(delta) > 0.5 ? ` · ${delta > 0 ? Math.round(delta) + " sf open" : Math.round(Math.abs(delta)) + " sf over"}` : " · balanced"}
                        </p>
                      ) : (
                        <p className="takeoff-component-total">
                          {Math.round(assigned)} sf total · enter area manually until click-to-place openings is enabled.
                        </p>
                      )}
                      {roomSurfaceComponents(selectedRoom, surface).length === 0 ? (
                        <p className="takeoff-muted">No {componentSurfaceLabel(surface).toLowerCase()} load components.</p>
                      ) : (
                        <div className="takeoff-component-list">
                          {roomSurfaceComponents(selectedRoom, surface).map((component) => (
                            <div key={component.id} className={`takeoff-component-row ${componentNeedsDirection(surface) ? "takeoff-component-row--directional" : ""}`}>
                              <select
                                value={component.assembly}
                                onChange={(event) => updateRoomComponent(selectedRoom.id, component.id, { assembly: event.target.value })}
                              >
                                {options.map((option) => (
                                  <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                ))}
                              </select>
                              {componentNeedsDirection(surface) && (
                                <select
                                  value={component.direction ?? ""}
                                  onChange={(event) => updateRoomComponent(selectedRoom.id, component.id, { direction: event.target.value as TakeoffRoomComponent["direction"] || undefined })}
                                >
                                  <option value="">Direction</option>
                                  {directionOptions.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
                                  {surface === "glass" && <option value="Shaded">Shaded</option>}
                                  {surface === "glass" && <option value="Skylight">Skylight</option>}
                                </select>
                              )}
                              <input
                                aria-label={`${surface} component label`}
                                value={component.label ?? ""}
                                placeholder="Label"
                                onChange={(event) => updateRoomComponent(selectedRoom.id, component.id, { label: event.target.value })}
                              />
                              <input
                                aria-label={`${surface} component area`}
                                type="number"
                                min="0"
                                step="1"
                                value={component.area}
                                onChange={(event) => updateRoomComponent(selectedRoom.id, component.id, { area: Number(event.target.value) })}
                              />
                              <button onClick={() => removeRoomComponent(selectedRoom.id, component.id)}>Remove</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="takeoff-muted">
                  Geometry {Math.round(rectArea(selectedRoom))} sf · Volume {Math.round(rectArea(selectedRoom) * selectedRoom.ceilingHeight)} cu ft
                </p>
              </>
            ) : (
              <p className="takeoff-muted">Select a room on the plan or in the room list.</p>
            )}
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
      {componentScheduleOpen && (
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setComponentScheduleOpen(false)}>
          <div className="modal takeoff-component-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Component Schedule</h2>
              <button className="modal-close" onClick={() => setComponentScheduleOpen(false)}>x</button>
            </div>
            <div className="takeoff-schedule-grid">
              <section>
                <div className="takeoff-component-head">
                  <h3>Project Schedule</h3>
                  <span className="takeoff-muted">{componentSchedule.length} items</span>
                </div>
                <div className="takeoff-schedule-list">
                  {componentSchedule.map((component) => (
                    <div key={component.id} className="takeoff-schedule-row">
                      <strong>{component.code}</strong>
                      <span>{component.category}</span>
                      <span>U {component.uValue ?? "-"}</span>
                      <span>{component.category === "Glass" ? `SHGC ${component.shgc ?? "-"}` : ""}</span>
                      <em>{component.description}</em>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="takeoff-component-head">
                  <h3>Library</h3>
                  <button onClick={loadComponentLibrary}>{libraryLoading ? "Loading..." : "Refresh"}</button>
                </div>
                <p className="takeoff-muted">
                  Click Use to choose an existing project slot or create the next available slot.
                </p>
                <input
                  className="takeoff-schedule-search"
                  value={componentSearch}
                  placeholder="Search description, U-value, or category"
                  onChange={(event) => setComponentSearch(event.target.value)}
                />
                <div className="takeoff-schedule-list">
                  {filteredLibraryComponents.map((component) => (
                    <div key={component.id} className="takeoff-schedule-row takeoff-schedule-row--library">
                      <span>{component.category}</span>
                      <span>U {component.uValue ?? "-"}</span>
                      <span>{component.category === "Glass" ? `SHGC ${component.shgc ?? "-"}` : ""}</span>
                      <em>{component.description}</em>
                      <button onClick={() => setPendingComponentAssignment(component)}>Use</button>
                    </div>
                  ))}
                  {!libraryLoading && filteredLibraryComponents.length === 0 && (
                    <p className="modal-empty">No matching library components.</p>
                  )}
                </div>
              </section>
            </div>

            <section className="takeoff-component-new">
              <h3>New Component</h3>
              <div className="takeoff-component-new-grid">
                <label>
                  Library category
                  <select value={componentDraft.category} onChange={(event) => setComponentDraft((current) => ({ ...current, category: event.target.value as TakeoffComponentCategory, code: libraryCodeForCategory(event.target.value as TakeoffComponentCategory) }))}>
                    {componentCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                  </select>
                </label>
                <label>
                  U-value
                  <input type="number" step="0.001" value={componentDraft.uValue ?? ""} onChange={(event) => setComponentDraft((current) => ({ ...current, uValue: event.target.value === "" ? undefined : Number(event.target.value) }))} />
                </label>
                <label>
                  SHGC
                  <input
                    type="number"
                    step="0.001"
                    value={componentDraft.shgc ?? ""}
                    disabled={componentDraft.category !== "Glass"}
                    onChange={(event) => setComponentDraft((current) => ({ ...current, shgc: event.target.value === "" ? null : Number(event.target.value) }))}
                  />
                </label>
                <label>
                  Description
                  <input value={componentDraft.description} onChange={(event) => setComponentDraft((current) => ({ ...current, description: event.target.value }))} />
                </label>
              </div>
              <div className="takeoff-form-actions">
                <button onClick={addDraftComponentToSchedule}>Add One-Off</button>
                <button className="toolbar-primary" onClick={saveDraftComponentToLibrary}>Save To Library</button>
              </div>
            </section>
          </div>
        </div>
      )}
      {pendingComponentAssignment && (
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setPendingComponentAssignment(null)}>
          <div className="modal assembly-assign-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Assign Component</h2>
              <button className="modal-close" onClick={() => setPendingComponentAssignment(null)}>x</button>
            </div>
            <p className="takeoff-muted">
              {pendingComponentAssignment.category} · U {pendingComponentAssignment.uValue ?? "-"}
              {pendingComponentAssignment.shgc != null ? ` / SHGC ${pendingComponentAssignment.shgc}` : ""} · {pendingComponentAssignment.description}
            </p>
            <div className="assembly-assign-list">
              {pendingComponentSlots.map(({ component, index }) => (
                <button key={`${component.code}-${index}`} onClick={() => applyComponentToScheduleSlot(pendingComponentAssignment, index)}>
                  Use {component.code} - {component.description || component.category}
                </button>
              ))}
              <button className="toolbar-primary" onClick={() => applyComponentToScheduleSlot(pendingComponentAssignment, "new")}>
                Create {nextScheduleSlotCode(pendingComponentAssignment.category, componentSchedule)}
              </button>
            </div>
          </div>
        </div>
      )}
      {openDialog && (
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setOpenDialog(false)}>
          <div className="modal open-dialog-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Open Takeoff</h2>
              <button className="modal-close" onClick={() => setOpenDialog(false)}>x</button>
            </div>
            {openDialogLoading && <p className="modal-empty">Loading...</p>}
            {openDialogError && <p className="modal-error">{openDialogError}</p>}
            {!openDialogLoading && !openDialogError && savedTakeoffs.length === 0 && (
              <p className="modal-empty">No saved takeoffs yet. Save this draft to create the first one.</p>
            )}
            {!openDialogLoading && savedTakeoffs.length > 0 && (
              <table className="project-list-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Reference</th>
                    <th>Updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {savedTakeoffs.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.name || "Untitled Takeoff"}</strong>
                        <div className="takeoff-muted">{row.schema_version || "takeoff.v1"}</div>
                      </td>
                      <td>{row.description || "-"}</td>
                      <td>{formatTimestamp(row.updated_at) || "-"}</td>
                      <td><button className="toolbar-primary" onClick={() => loadTakeoff(row.id)}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
