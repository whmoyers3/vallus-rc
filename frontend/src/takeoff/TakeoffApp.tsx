import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ventilationCfmForBedrooms } from "../loadRules";
import type {
  TakeoffAdjacentSpace,
  TakeoffAdjacentSpaceKind,
  TakeoffAuthoringMode,
  TakeoffComponentCategory,
  TakeoffComponentDefinition,
  TakeoffFloor,
  TakeoffPoint,
  TakeoffProject,
  TakeoffRectRoom,
  TakeoffRoomComponent,
  TakeoffRoomComponentSource,
  TakeoffRoomType,
  TakeoffScaleLine,
  TakeoffValidationIssue,
  TakeoffWallAdjacency,
} from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const { difference, intersection, union } = polygonClipping;

const directionOptions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const defaultLightingWPerSf = 0.502;
const takeoffReferenceMaxBytes = 7 * 1024 * 1024;
const minPlanZoom = 0.5;
const maxPlanZoom = 8;
const planZoomStep = 0.25;
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
type RoomTileMetric = "floor" | "ceiling" | "wall" | "glass";
type PlanReviewMode = "plan" | "floor" | "ceiling" | "walls" | "elevation";
type MovablePointTarget = { type: "exterior"; index: number } | { type: "room"; roomId: string; index: number };
type OpeningMoveTarget = { roomId: string; componentId: string };
type DragState = {
  kind: "crop" | "room" | "subtract" | "adjacent" | "move-point" | "move-opening";
  start: TakeoffPoint;
  current: TakeoffPoint;
  target?: MovablePointTarget;
  openingTarget?: OpeningMoveTarget;
} | null;
type OpeningPlacement = {
  surface: "glass" | "door";
  assembly: string;
  width: number;
  height: number;
  label: string;
  solarDirection?: TakeoffRoomComponent["solarDirection"];
} | null;
type PendingOpeningTarget = {
  roomId: string;
  roomName: string;
  direction: (typeof directionOptions)[number];
  placement: TakeoffPoint;
  adjacentKinds: TakeoffAdjacentSpaceKind[];
} | null;
type EditingOpeningTarget = OpeningMoveTarget | null;
type PlanRect = { x: number; y: number; width: number; depth: number };
type UnassignedCell = { x: number; y: number; width: number; depth: number; polygon?: TakeoffPoint[]; area?: number };
type ModelViewPreset = "iso" | "front" | "rear" | "left" | "right";
type ModelLayerKey = "reference" | "windows" | "doors" | "ceilings" | "floors" | "walls" | "interiorWalls";
type ModelSurfaceKind = "floor" | "ceiling" | "load-wall" | "interior-wall" | "knee-wall" | "window" | "door";
type ModelMeshPart = {
  mesh: THREE.Mesh;
  kind: ModelSurfaceKind;
  label: string;
  surface?: TakeoffRoomComponent["surface"];
  direction?: TakeoffRoomComponent["direction"];
  area?: number;
  assembly?: string;
  source?: TakeoffRoomComponentSource;
  geometryLabel?: string;
};
type ModelSurfaceSelection = {
  roomId: string;
  roomName: string;
  kind: ModelSurfaceKind;
  label: string;
  surface?: TakeoffRoomComponent["surface"];
  direction?: TakeoffRoomComponent["direction"];
  area?: number;
  componentId?: string;
  assembly?: string;
  source?: TakeoffRoomComponentSource;
  geometryLabel?: string;
};
type StaleCeilingWallPrompt = {
  roomId: string;
  roomName: string;
  components: Array<{ id: string; label: string; area: number; source?: TakeoffRoomComponentSource }>;
} | null;
type OrientationLoadResult = { facing: string; cooling: number; heating: number; tons: number };
type TakeoffCalcResult = OrientationLoadResult & { orientations: OrientationLoadResult[]; baseFacing: string };
type ValidationSection = "merge" | "wall-suggestions" | "wall-components" | "glass-components" | "door-components" | "floor-components" | "ceiling-components" | "ceiling-geometry" | "room-profile";
type LeftSetupSection = "project" | "mode" | "scale" | "grid" | "exterior";
type ActiveValidationTarget = {
  key: string;
  roomId?: string;
  severity: TakeoffValidationIssue["severity"];
  section: ValidationSection;
  message: string;
};
type SketchTarget = {
  roomId: string;
  surface: TakeoffRoomComponent["surface"] | "ceiling-geometry";
  direction?: TakeoffRoomComponent["direction"];
};
type UnassignedRegion = {
  id: string;
  label: string;
  cells: UnassignedCell[];
  area: number;
  bounds: PlanRect;
  adjacentRoomIds: string[];
};
const adjacentSpaceKinds: Array<{ id: TakeoffAdjacentSpaceKind; label: string }> = [
  { id: "garage", label: "Garage" },
  { id: "attic", label: "Attic" },
  { id: "crawl", label: "Crawl space" },
  { id: "covered_porch", label: "Covered porch" },
  { id: "exterior", label: "Exterior" },
];
const roomTileMetrics: Array<{ id: RoomTileMetric; label: string }> = [
  { id: "floor", label: "Floor" },
  { id: "ceiling", label: "Ceiling" },
  { id: "wall", label: "Wall" },
  { id: "glass", label: "Glass" },
];
const roomTypeOptions: Array<{ id: TakeoffRoomType; label: string; shortLabel: string }> = [
  { id: "plain", label: "Plain (no internal load)", shortLabel: "Plain" },
  { id: "bedroom", label: "Bedroom (1 person)", shortLabel: "Bedroom" },
  { id: "kitchen", label: "Kitchen (680 W)", shortLabel: "Kitchen" },
  { id: "entertainment", label: "Entertainment (250 W + 1 person)", shortLabel: "Entertainment" },
  { id: "laundry", label: "Laundry (200 W)", shortLabel: "Laundry" },
];
const planReviewModes: Array<{ id: PlanReviewMode; label: string; tooltip: string }> = [
  { id: "plan", label: "Plan", tooltip: "Show the editable plan-tracing view." },
  { id: "floor", label: "Floor", tooltip: "Review floor load areas by room." },
  { id: "ceiling", label: "Ceiling", tooltip: "Review ceiling surfaces and height changes." },
  { id: "walls", label: "Walls", tooltip: "Review wall exposure and opening assignments." },
  { id: "elevation", label: "3D QA", tooltip: "Open the 3D quality-assurance view." },
];
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
    coordinateSpace: "world_feet",
    elevation: 0,
    floorToFloorHeight: 10,
    alignment: undefined,
    referencePoints: [],
    designGrid: { width: 60, depth: 45 },
    scale: { feetPerGrid: 1, gridSnapInches: 6 },
    defaultCeilingHeight: 9,
    conditionedPerimeter: { width: 0, depth: 0 },
    calibration: { lines: [], linesVisible: true, confirmed: false, appliedFactor: 1, areaConfirmed: false },
    exteriorPolygon: [],
    perimeterLocked: false,
    rooms: [],
    adjacentSpaces: [],
  };
}

function makeTakeoffProject(
  name: string,
  location: string,
  mechanicalVentilation: boolean,
  ventilationCfm: number,
  frontDoorFaces: TakeoffProject["frontDoorFaces"],
  floor: TakeoffFloor,
  componentSchedule: TakeoffComponentDefinition[],
): TakeoffProject {
  return {
    schemaVersion: "takeoff.v1",
    name,
    location,
    mechanicalVentilation,
    ventilationCfm,
    frontDoorFaces,
    componentSchedule,
    floors: [floor],
  };
}

const COMPASS_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function rotateCompass(direction: string | undefined, steps: number): string | undefined {
  const index = COMPASS_ORDER.indexOf(direction as (typeof COMPASS_ORDER)[number]);
  if (index < 0) return direction;
  return COMPASS_ORDER[(index + steps) % COMPASS_ORDER.length];
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

function clipRingToPoints(ring: Ring) {
  return ring.slice(0, -1).map(([x, y]) => ({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) }));
}

function clipPolygonArea(polygon: Polygon) {
  const [outer, ...holes] = polygon;
  const outerArea = outer ? polygonArea(clipRingToPoints(outer)) : 0;
  const holeArea = holes.reduce((sum, ring) => sum + polygonArea(clipRingToPoints(ring)), 0);
  return Math.max(0, outerArea - holeArea);
}

function clipRingBounds(ring: Ring) {
  return polygonBounds(clipRingToPoints(ring));
}

function simplePolygonsFromClipPolygon(polygon: Polygon) {
  if (polygon.length <= 1) return clipPolygonArea(polygon) > 0.5 ? [polygon] : [];
  const [outer, ...holes] = polygon;
  if (!outer) return [];
  const outerPoints = clipRingToPoints(outer);
  const holePoints = holes.map(clipRingToPoints);
  const outerBounds = polygonBounds(outerPoints);
  const xCuts = new Set([outerBounds.x, outerBounds.x + outerBounds.width]);
  const yCuts = new Set([outerBounds.y, outerBounds.y + outerBounds.depth]);

  for (const hole of holes) {
    const bounds = clipRingBounds(hole);
    xCuts.add(bounds.x);
    xCuts.add(bounds.x + bounds.width);
    yCuts.add(bounds.y);
    yCuts.add(bounds.y + bounds.depth);
  }

  const xs = Array.from(xCuts).sort((a, b) => a - b);
  const ys = Array.from(yCuts).sort((a, b) => a - b);
  const pieces: Polygon[] = [];

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const rect = {
        x: xs[xIndex],
        y: ys[yIndex],
        width: xs[xIndex + 1] - xs[xIndex],
        depth: ys[yIndex + 1] - ys[yIndex],
      };
      if (rect.width < 0.25 || rect.depth < 0.25) continue;
      const center = { x: rect.x + rect.width / 2, y: rect.y + rect.depth / 2 };
      if (!pointInPolygon(center, outerPoints)) continue;
      if (holePoints.some((hole) => pointInPolygon(center, hole))) continue;
      const candidate = pointsToClipPolygon(rectToPoints(rect));
      const clipped = intersection([candidate], [polygon]);
      for (const clippedPolygon of clipped) {
        if (clippedPolygon.length === 1 && clipPolygonArea(clippedPolygon) > 0.5) pieces.push(clippedPolygon);
      }
    }
  }

  return pieces;
}

function simplePolygonsFromMultiPolygon(multiPolygon: MultiPolygon) {
  const pieces = multiPolygon
    .flatMap(simplePolygonsFromClipPolygon)
    .map((polygon) => ({ polygon, area: clipPolygonArea(polygon) }))
    .filter((entry) => entry.area > 0.5)
    .sort((a, b) => b.area - a.area);
  return mergeConnectedSimplePolygons(pieces);
}

function mergePolygonEntries(entries: Array<{ polygon: Polygon; area: number }>) {
  if (entries.length === 0) return [];
  const [firstPolygon, ...remainingPolygons] = entries.map((entry) => entry.polygon);
  return simplePolygonsFromMultiPolygon(union(firstPolygon, ...remainingPolygons));
}

function polygonsShareBoundary(first: Polygon, second: Polygon) {
  const firstEdges = pointsToEdges(clipPolygonToPoints(first));
  const secondEdges = pointsToEdges(clipPolygonToPoints(second));
  return firstEdges.some((firstEdge) =>
    secondEdges.some((secondEdge) => sharedSegmentLength(firstEdge, secondEdge, 0.18) > 0.05)
  );
}

function mergeConnectedSimplePolygons(entries: Array<{ polygon: Polygon; area: number }>) {
  const remaining = new Set(entries.map((_, index) => index));
  const mergedEntries: Array<{ polygon: Polygon; area: number }> = [];

  while (remaining.size > 0) {
    const firstIndex = remaining.values().next().value as number;
    const queue = [firstIndex];
    const group: Array<{ polygon: Polygon; area: number }> = [];
    remaining.delete(firstIndex);

    while (queue.length > 0) {
      const currentIndex = queue.shift()!;
      const current = entries[currentIndex];
      group.push(current);
      for (const candidateIndex of Array.from(remaining)) {
        if (!group.some((groupEntry) => polygonsShareBoundary(groupEntry.polygon, entries[candidateIndex].polygon))) continue;
        remaining.delete(candidateIndex);
        queue.push(candidateIndex);
      }
    }

    const [firstPolygon, ...remainingPolygons] = group.map((entry) => entry.polygon);
    const merged = union(firstPolygon, ...remainingPolygons);
    const simpleMerged = merged
      .filter((polygon) => polygon.length === 1)
      .map((polygon) => ({ polygon, area: clipPolygonArea(polygon) }))
      .filter((entry) => entry.area > 0.5);

    if (simpleMerged.length > 0 && simpleMerged.reduce((sum, entry) => sum + entry.area, 0) >= group.reduce((sum, entry) => sum + entry.area, 0) - 0.5) {
      mergedEntries.push(...simpleMerged);
    } else {
      mergedEntries.push(...group);
    }
  }

  return mergedEntries.sort((a, b) => b.area - a.area);
}

function largestClipPolygon(multiPolygon: MultiPolygon) {
  return multiPolygon
    .map((polygon) => ({ polygon, area: clipPolygonArea(polygon) }))
    .filter((entry) => entry.area > 0.5 && entry.polygon.length === 1)
    .sort((a, b) => b.area - a.area)[0]?.polygon ?? null;
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.round(Math.random() * 1000)}`;
}

function rectArea(rect: Pick<TakeoffRectRoom, "width" | "depth"> & { polygon?: TakeoffPoint[]; areaAdjustment?: number }) {
  const baseArea = rect.polygon && rect.polygon.length >= 3 ? polygonArea(rect.polygon) : Math.max(0, rect.width) * Math.max(0, rect.depth);
  return baseArea + Math.max(0, rect.areaAdjustment ?? 0);
}

function roomPerimeter(room: TakeoffRectRoom) {
  return pointsToEdges(roomCorners(room)).reduce((sum, edge) => sum + distance(edge.a, edge.b), 0);
}

function roomPlanSpan(room: TakeoffRectRoom, axis: "x" | "y") {
  const bounds = polygonBounds(roomCorners(room));
  return axis === "x" ? bounds.width : bounds.depth;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function ceilingGeometryInfo(room: TakeoffRectRoom, defaultCeilingHeight = 9) {
  const ceilingType = room.ceilingType ?? "flat";
  const lowHeight = ceilingType === "vaulted" ? room.ceilingLowHeight ?? room.ceilingHeight : room.ceilingHeight;
  const peakHeight = ceilingType === "vaulted" ? room.ceilingPeakHeight ?? Math.max(lowHeight, room.ceilingHeight) : room.ceilingHeight;
  const ridgeDirection = room.ceilingRidgeDirection ?? "E-W";
  const ridgeOffset = clamp(room.ceilingRidgeOffset ?? 0, -1, 1);
  const ridgeRatio = (ridgeOffset + 1) / 2;
  const flatDelta = Math.max(0, room.ceilingHeight - defaultCeilingHeight);
  const lowDelta = Math.max(0, lowHeight - defaultCeilingHeight);
  const peakDelta = Math.max(0, peakHeight - lowHeight);
  const raisedWallArea = ceilingType === "vaulted"
    ? roomPerimeter(room) * lowDelta
    : roomPerimeter(room) * flatDelta;
  const gableBase = ridgeDirection === "E-W" ? roomPlanSpan(room, "y") : roomPlanSpan(room, "x");
  const ridgeLength = ridgeDirection === "E-W" ? roomPlanSpan(room, "x") : roomPlanSpan(room, "y");
  const crossSpan = ridgeDirection === "E-W" ? roomPlanSpan(room, "y") : roomPlanSpan(room, "x");
  const firstRun = crossSpan * ridgeRatio;
  const secondRun = crossSpan - firstRun;
  const slopedCeilingArea = ceilingType === "vaulted"
    ? (
      firstRun <= 0.25 || secondRun <= 0.25
        ? Math.sqrt(crossSpan ** 2 + peakDelta ** 2) * ridgeLength
        : (Math.sqrt(firstRun ** 2 + peakDelta ** 2) + Math.sqrt(secondRun ** 2 + peakDelta ** 2)) * ridgeLength
    )
    : rectArea(room);
  const gableArea = ceilingType === "vaulted" ? gableBase * peakDelta : 0;
  const estimatedAddedWallArea = raisedWallArea + gableArea;
  const heightDelta = Math.max(flatDelta, lowDelta, Math.max(0, peakHeight - defaultCeilingHeight));
  return {
    ceilingType,
    lowHeight,
    peakHeight,
    ridgeDirection,
    ridgeOffset,
    ridgeRatio,
    slopedCeilingArea,
    heightDelta,
    raisedWallArea,
    gableArea,
    estimatedAddedWallArea,
    needsReview: ceilingType !== "none" && heightDelta > 1.5 && !room.ceilingGeometryApproved,
  };
}

type CeilingWallSuggestion = {
  key: string;
  direction: TakeoffRoomComponent["direction"];
  area: number;
  label: string;
  description: string;
  geometryLabel: string;
  basis: "raised-wall" | "gable-end";
  source: Extract<TakeoffRoomComponentSource, "raised-ceiling" | "vault-gable">;
  adjacency: TakeoffWallAdjacency;
  length?: number;
  addedHeight?: number;
};

function defaultWallAssemblyForAdjacency(adjacency: TakeoffWallAdjacency) {
  if (adjacency === "attic") return "W3";
  if (adjacency === "crawlspace" || adjacency === "conditioned") return "W2";
  return "W1";
}

function wallAdjacencyFromAdjacentKinds(kinds: TakeoffAdjacentSpaceKind[]): TakeoffWallAdjacency {
  if (kinds.includes("garage")) return "garage";
  if (kinds.includes("attic")) return "attic";
  if (kinds.includes("crawl")) return "crawlspace";
  return "outside";
}

function wallAdjacencyLabel(adjacency: TakeoffWallAdjacency) {
  const labels: Record<TakeoffWallAdjacency, string> = {
    outside: "Exterior wall",
    attic: "Attic wall",
    garage: "Garage wall",
    crawlspace: "Crawlspace wall",
    conditioned: "Conditioned partition",
    unknown: "Unknown adjacent wall",
  };
  return labels[adjacency];
}

function recommendedWallTreatment(kinds: TakeoffAdjacentSpaceKind[], fallbackAssembly = "W1") {
  const adjacency = wallAdjacencyFromAdjacentKinds(kinds);
  const assembly = adjacency === "outside" ? fallbackAssembly : defaultWallAssemblyForAdjacency(adjacency);
  return {
    adjacency,
    assembly,
    label: wallAdjacencyLabel(adjacency),
  };
}

function ceilingWallSuggestionsForRoom(floor: TakeoffFloor, room: TakeoffRectRoom, defaultCeilingHeight = 9): CeilingWallSuggestion[] {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  const suggestions: CeilingWallSuggestion[] = [];
  const exteriorDirections = roomExteriorDirections(floor, room);
  const addedLowHeight = ceilingInfo.ceilingType === "vaulted"
    ? Math.max(0, ceilingInfo.lowHeight - defaultCeilingHeight)
    : Math.max(0, room.ceilingHeight - defaultCeilingHeight);
  if (ceilingInfo.ceilingType !== "none" && addedLowHeight > 0.25) {
    for (const edge of pointsToEdges(roomCorners(room))) {
      if (edgeSharesSameHeightRoom(floor, room, edge, addedLowHeight)) continue;
      const length = distance(edge.a, edge.b);
      const direction = edgeDirectionFromRoom(edge, room);
      const area = Math.round(length * addedLowHeight * 10) / 10;
      if (area <= 0.5) continue;
      suggestions.push({
        key: `ceiling-raised-${direction}-${Math.round(edge.a.x * 10)}-${Math.round(edge.a.y * 10)}`,
        direction,
        area,
        label: `Raised ceiling wall - ${direction}`,
        description: `${direction}-facing raised wall band`,
        geometryLabel: `Raised wall band - ${direction}`,
        basis: "raised-wall",
        source: "raised-ceiling",
        adjacency: exteriorDirections.includes(direction) ? "outside" : "attic",
        length,
        addedHeight: addedLowHeight,
      });
    }
  }
  if (ceilingInfo.ceilingType !== "vaulted" || ceilingInfo.gableArea <= 0) return suggestions;
  const directions: Array<NonNullable<TakeoffRoomComponent["direction"]>> = ceilingInfo.ridgeDirection === "N-S"
    ? ["N", "S"]
    : ["E", "W"];
  const area = Math.round((ceilingInfo.gableArea / 2) * 10) / 10;
  suggestions.push(...directions.map((direction, index) => {
    const geometryLabel = `Gable ${index === 0 ? "A" : "B"}`;
    const adjacency: TakeoffWallAdjacency = exteriorDirections.includes(direction) ? "outside" : "attic";
    return {
      key: `ceiling-gable-${direction}`,
      direction,
      area,
      label: geometryLabel,
      description: `${geometryLabel} · ${direction}-side gable end`,
      geometryLabel,
      basis: "gable-end" as const,
      source: "vault-gable" as const,
      adjacency,
    };
  }));
  return suggestions;
}

function ceilingWallSuggestionApplied(room: TakeoffRectRoom, suggestion: CeilingWallSuggestion) {
  return roomSurfaceComponents(room, "wall").some((component) =>
    component.label === suggestion.label &&
    component.direction === suggestion.direction &&
    Math.abs((component.area || 0) - Math.round(suggestion.area)) <= 0.5
  );
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

function roomSurfaceNoLoad(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  return (surface === "floor" && room.floorType === "none") || (surface === "ceiling" && room.ceilingType === "none");
}

function roomAreaReconciliation(room: TakeoffRectRoom, surface: "floor" | "ceiling") {
  const roomArea = rectArea(room);
  const assignedArea = componentAreaTotal(room, surface);
  const noLoad = roomSurfaceNoLoad(room, surface);
  return {
    roomArea,
    assignedArea,
    openArea: Math.max(0, roomArea - assignedArea),
    overArea: Math.max(0, assignedArea - roomArea),
    noLoad,
    isBalanced: noLoad || Math.abs(roomArea - assignedArea) <= 0.5,
    isOver: !noLoad && assignedArea > roomArea + 0.5,
  };
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

function componentIsGeneratedCeilingWall(component: TakeoffRoomComponent) {
  if (component.surface !== "wall") return false;
  if (component.source === "raised-ceiling" || component.source === "vault-gable") return true;
  const label = `${component.label ?? ""} ${component.geometryLabel ?? ""}`.toLowerCase();
  return (
    label.includes("gable") ||
    label.includes("raised ceiling wall") ||
    label.includes("raised wall band") ||
    label.includes("knee-wall") ||
    label.includes("kneewall") ||
    label.includes("vault")
  );
}

function staleGeneratedCeilingWallComponents(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const currentSuggestions = ceilingWallSuggestionsForRoom(floor, room, floor.defaultCeilingHeight ?? 9);
  return roomSurfaceComponents(room, "wall").filter((component) => {
    if (!componentIsGeneratedCeilingWall(component)) return false;
    if (currentSuggestions.length === 0) return true;
    return !currentSuggestions.some((suggestion) =>
      suggestion.source === component.source &&
      suggestion.label === component.label &&
      suggestion.direction === component.direction &&
      Math.abs(Math.round(suggestion.area) - (component.area || 0)) <= 0.5
    );
  });
}

function componentRequiresDirection(component: TakeoffRoomComponent) {
  if (component.surface === "glass" || component.surface === "door") return true;
  if (component.surface !== "wall") return false;
  return !componentIsGeneratedCeilingWall(component);
}

function wallCanHostOpenings(component: TakeoffRoomComponent) {
  if (component.surface !== "wall") return false;
  if (componentIsGeneratedCeilingWall(component)) return false;
  return component.adjacency == null || component.adjacency === "outside" || component.adjacency === "garage" || component.adjacency === "unknown";
}

function componentThermalSummary(component: TakeoffComponentDefinition | undefined) {
  if (!component) return "No schedule values found.";
  const values = [`U-value ${component.uValue ?? "-"}`, `U-factor ${component.uValue ?? "-"}`];
  if (component.category === "Glass") values.push(`SHGC ${component.shgc ?? "-"}`);
  return values.join(" · ");
}

function openingAreaByDirection(room: TakeoffRectRoom) {
  const openings = new Map<(typeof directionOptions)[number], number>();
  for (const component of roomComponents(room)) {
    if ((component.surface !== "glass" && component.surface !== "door") || !isCompassDirection(component.direction)) continue;
    openings.set(component.direction, (openings.get(component.direction) ?? 0) + Math.max(0, component.area || 0));
  }
  return openings;
}

function wallAreaByDirection(room: TakeoffRectRoom) {
  const walls = new Map<(typeof directionOptions)[number], number>();
  for (const component of roomComponents(room)) {
    if (component.surface !== "wall" || !isCompassDirection(component.direction) || !wallCanHostOpenings(component)) continue;
    walls.set(component.direction, (walls.get(component.direction) ?? 0) + Math.max(0, component.area || 0));
  }
  return walls;
}

function componentAreaBySurfaceAndDirection(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  const totals = new Map<(typeof directionOptions)[number], number>();
  for (const component of roomComponents(room)) {
    if (component.surface !== surface || !isCompassDirection(component.direction)) continue;
    totals.set(component.direction, (totals.get(component.direction) ?? 0) + Math.max(0, component.area || 0));
  }
  return totals;
}

function roomWallReconciliation(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const suggested = new Map(roomExteriorWallSuggestions(floor, room).map((entry) => [entry.direction, entry.area]));
  const assignedWalls = wallAreaByDirection(room);
  const windows = componentAreaBySurfaceAndDirection(room, "glass");
  const doors = componentAreaBySurfaceAndDirection(room, "door");
  const adjacent = adjacentKindsByDirection(floor, room);
  return directionOptions
    .map((direction) => {
      const assignedGross = assignedWalls.get(direction) ?? 0;
      const suggestedGross = suggested.get(direction) ?? 0;
      const glassArea = windows.get(direction) ?? 0;
      const doorArea = doors.get(direction) ?? 0;
      const openingArea = glassArea + doorArea;
      const grossArea = assignedGross > 0 ? assignedGross : suggestedGross;
      return {
        direction,
        assignedGross,
        suggestedGross,
        grossArea,
        glassArea,
        doorArea,
        openingArea,
        netArea: Math.max(0, grossArea - openingArea),
        adjacentKinds: adjacent.get(direction) ?? [],
        isAssigned: assignedGross > 0,
        isOverOpened: openingArea > grossArea + 0.5,
      };
    })
    .filter((entry) => entry.grossArea > 0 || entry.openingArea > 0);
}

function missingSuggestedExteriorWalls(floor: TakeoffFloor, room: TakeoffRectRoom) {
  return roomWallReconciliation(floor, room).filter((entry) => entry.suggestedGross > 0 && !entry.isAssigned);
}

function wallAdjacentSpaceMismatches(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const adjacent = adjacentKindsByDirection(floor, room);
  return roomSurfaceComponents(room, "wall").flatMap((component) => {
    if (!isCompassDirection(component.direction) || componentIsGeneratedCeilingWall(component)) return [];
    const adjacentKinds = adjacent.get(component.direction) ?? [];
    if (adjacentKinds.length === 0) return [];
    const recommendation = recommendedWallTreatment(adjacentKinds, component.assembly || "W1");
    if (recommendation.adjacency === "outside") return [];
    const mismatches: string[] = [];
    if (component.adjacency !== recommendation.adjacency) {
      mismatches.push(`${wallAdjacencyLabel(recommendation.adjacency).toLowerCase()} adjacency`);
    }
    if (recommendation.assembly !== component.assembly) {
      mismatches.push(`${recommendation.assembly} assembly`);
    }
    if (mismatches.length === 0) return [];
    return [{
      component,
      adjacentKinds,
      recommendation,
      mismatches,
    }];
  });
}

function exportedWallComponent(component: TakeoffRoomComponent): TakeoffRoomComponent {
  if (component.surface !== "wall" || component.adjacency !== "garage") return component;
  const label = component.label || wallAdjacencyLabel("garage");
  return {
    ...component,
    direction: undefined,
    label: /garage/i.test(label) ? label : `${label} - Garage`,
  };
}

function payloadDirectionForComponent(component: TakeoffRoomComponent) {
  if (component.surface === "glass" && component.solarDirection) return component.solarDirection;
  return component.direction;
}

function payloadComponentsForRoom(room: TakeoffRectRoom) {
  const remainingOpenings = new Map(openingAreaByDirection(room));
  return roomComponents(room)
    .map((component) => {
      if (component.surface !== "wall" || !isCompassDirection(component.direction) || !wallCanHostOpenings(component)) return exportedWallComponent(component);
      const remaining = remainingOpenings.get(component.direction) ?? 0;
      const grossArea = Math.max(0, component.area || 0);
      const subtract = Math.min(grossArea, remaining);
      remainingOpenings.set(component.direction, Math.max(0, remaining - subtract));
      return exportedWallComponent({
        ...component,
        area: Number(Math.max(0, grossArea - subtract).toFixed(3)),
        label: subtract > 0 ? `${component.label || wallAdjacencyLabel(component.adjacency ?? "outside")} net of openings` : component.label,
      });
    })
    .filter((component) => Math.max(0, component.area || 0) > 0);
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

function scaleLineSourcePoints(line: TakeoffScaleLine) {
  return {
    start: line.sourceStart ?? line.start,
    end: line.sourceEnd ?? line.end,
  };
}

function scalePoint(point: TakeoffPoint, factor: number): TakeoffPoint {
  return { x: Number((point.x * factor).toFixed(3)), y: Number((point.y * factor).toFixed(3)) };
}

function unscalePoint(point: TakeoffPoint, factor: number): TakeoffPoint {
  if (!factor) return point;
  return { x: Number((point.x / factor).toFixed(3)), y: Number((point.y / factor).toFixed(3)) };
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

function scaleAdjacentSpace(space: TakeoffAdjacentSpace, factor: number): TakeoffAdjacentSpace {
  return {
    ...space,
    x: Number((space.x * factor).toFixed(3)),
    y: Number((space.y * factor).toFixed(3)),
    width: Number((space.width * factor).toFixed(3)),
    depth: Number((space.depth * factor).toFixed(3)),
    polygon: space.polygon?.map((point) => scalePoint(point, factor)),
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
      const measured = lineLength(scaleLineSourcePoints(line));
      return measured > 0 && line.knownFeet > 0 ? line.knownFeet / measured : 0;
    })
    .filter((factor) => factor > 0);

  if (factors.length === 0) return 0;
  return factors.reduce((sum, factor) => sum + factor, 0) / factors.length;
}

function scaleLinePrefix(line: TakeoffScaleLine) {
  if (line.orientation === "horizontal") return "H";
  if (line.orientation === "vertical") return "V";
  return "A";
}

function scaleLineDisplayLabel(lines: TakeoffScaleLine[], line: TakeoffScaleLine, index: number) {
  const prefix = scaleLinePrefix(line);
  const ordinal = lines.slice(0, index + 1).filter((candidate) => scaleLinePrefix(candidate) === prefix).length;
  const feet = line.knownFeet || Number(lineLength(line).toFixed(1));
  return `${prefix}${ordinal} = ${feet} ft`;
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

function rectsBounds(rects: PlanRect[]) {
  const usableRects = rects.filter((rect) => rect.width > 0 && rect.depth > 0);
  if (usableRects.length === 0) return null;
  const minX = Math.min(...usableRects.map((rect) => rect.x));
  const minY = Math.min(...usableRects.map((rect) => rect.y));
  const maxX = Math.max(...usableRects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...usableRects.map((rect) => rect.y + rect.depth));
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

function adjacentSpaceCorners(space: TakeoffAdjacentSpace): TakeoffPoint[] {
  if (space.polygon && space.polygon.length >= 3) return space.polygon;
  return rectToPoints(space);
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

function pointsToEdges(points: TakeoffPoint[]) {
  return points.map((point, index) => ({ a: point, b: points[(index + 1) % points.length] })).filter(({ a, b }) => distance(a, b) > 0.001);
}

function cornerPoints(points: TakeoffPoint[], minTurnDegrees = 12.5) {
  if (points.length < 3) return points;
  const minTurnRadians = minTurnDegrees * Math.PI / 180;
  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const previousVector = { x: previous.x - point.x, y: previous.y - point.y };
    const nextVector = { x: next.x - point.x, y: next.y - point.y };
    const previousLength = Math.hypot(previousVector.x, previousVector.y);
    const nextLength = Math.hypot(nextVector.x, nextVector.y);
    if (previousLength <= 0.001 || nextLength <= 0.001) return false;
    const dot = (previousVector.x * nextVector.x + previousVector.y * nextVector.y) / (previousLength * nextLength);
    const angle = Math.acos(clamp(dot, -1, 1));
    return Math.abs(Math.PI - angle) >= minTurnRadians;
  });
}

function compassFromVector(dx: number, dy: number): (typeof directionOptions)[number] {
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const normalized = (angle + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "E";
  if (normalized < 67.5) return "SE";
  if (normalized < 112.5) return "S";
  if (normalized < 157.5) return "SW";
  if (normalized < 202.5) return "W";
  if (normalized < 247.5) return "NW";
  if (normalized < 292.5) return "N";
  return "NE";
}

function edgeDirectionFromRoom(edge: { a: TakeoffPoint; b: TakeoffPoint }, room: TakeoffRectRoom) {
  const midpoint = {
    x: (edge.a.x + edge.b.x) / 2,
    y: (edge.a.y + edge.b.y) / 2,
  };
  const center = roomCenter(room);
  return compassFromVector(midpoint.x - center.x, midpoint.y - center.y);
}

function exteriorEdgeDirection(
  edge: { a: TakeoffPoint; b: TakeoffPoint },
  exteriorPoints: TakeoffPoint[],
  fallbackCenter: TakeoffPoint,
  sampleDistance = 1,
) {
  const dx = edge.b.x - edge.a.x;
  const dy = edge.b.y - edge.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001) return compassFromVector(edge.a.x - fallbackCenter.x, edge.a.y - fallbackCenter.y);
  const midpoint = {
    x: (edge.a.x + edge.b.x) / 2,
    y: (edge.a.y + edge.b.y) / 2,
  };
  const normals = [
    { x: -dy / length, y: dx / length },
    { x: dy / length, y: -dx / length },
  ];
  const outward = normals.find((normal) => !pointInPolygon({
    x: midpoint.x + normal.x * sampleDistance,
    y: midpoint.y + normal.y * sampleDistance,
  }, exteriorPoints));
  if (outward) return compassFromVector(outward.x, outward.y);
  return compassFromVector(midpoint.x - fallbackCenter.x, midpoint.y - fallbackCenter.y);
}

function edgeSharesSameHeightRoom(floor: TakeoffFloor, room: TakeoffRectRoom, edge: { a: TakeoffPoint; b: TakeoffPoint }, addedHeight: number) {
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  return floor.rooms.some((other) => {
    if (other.id === room.id) return false;
    const otherHeight = (other.ceilingType === "vaulted" ? other.ceilingLowHeight ?? other.ceilingHeight : other.ceilingHeight);
    if (Math.abs(otherHeight - (room.ceilingType === "vaulted" ? room.ceilingLowHeight ?? room.ceilingHeight : room.ceilingHeight)) > 0.25) return false;
    return pointsToEdges(roomCorners(other)).some((otherEdge) =>
      sharedSegmentLength(edge, otherEdge, tolerance) >= Math.max(0.5, Math.min(distance(edge.a, edge.b), 4) * 0.5)
    );
  }) && addedHeight > 0;
}

function exteriorRingPoints(floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) return floor.exteriorPolygon;
  const bounds = footprintBounds(floor);
  return rectToPoints({ x: bounds.x, y: bounds.y, width: bounds.width, depth: bounds.depth });
}

function sharedSegmentLength(
  first: { a: TakeoffPoint; b: TakeoffPoint },
  second: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  const dx1 = first.b.x - first.a.x;
  const dy1 = first.b.y - first.a.y;
  const len1 = Math.hypot(dx1, dy1);
  const dx2 = second.b.x - second.a.x;
  const dy2 = second.b.y - second.a.y;
  const len2 = Math.hypot(dx2, dy2);
  if (len1 <= 0.001 || len2 <= 0.001) return 0;
  const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
  if (cross > tolerance * Math.max(len1, len2)) return 0;
  const distanceToLine = Math.abs((second.a.x - first.a.x) * dy1 - (second.a.y - first.a.y) * dx1) / len1;
  if (distanceToLine > tolerance) return 0;
  const ux = dx1 / len1;
  const uy = dy1 / len1;
  const project = (point: TakeoffPoint) => (point.x - first.a.x) * ux + (point.y - first.a.y) * uy;
  const firstMin = 0;
  const firstMax = len1;
  const secondA = project(second.a);
  const secondB = project(second.b);
  const secondMin = Math.min(secondA, secondB);
  const secondMax = Math.max(secondA, secondB);
  return Math.max(0, Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin));
}

function sharedSegment(
  first: { a: TakeoffPoint; b: TakeoffPoint },
  second: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  const dx1 = first.b.x - first.a.x;
  const dy1 = first.b.y - first.a.y;
  const len1 = Math.hypot(dx1, dy1);
  const dx2 = second.b.x - second.a.x;
  const dy2 = second.b.y - second.a.y;
  const len2 = Math.hypot(dx2, dy2);
  if (len1 <= 0.001 || len2 <= 0.001) return null;
  const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
  if (cross > tolerance * Math.max(len1, len2)) return null;
  const distanceToLine = Math.abs((second.a.x - first.a.x) * dy1 - (second.a.y - first.a.y) * dx1) / len1;
  if (distanceToLine > tolerance) return null;
  const ux = dx1 / len1;
  const uy = dy1 / len1;
  const project = (point: TakeoffPoint) => (point.x - first.a.x) * ux + (point.y - first.a.y) * uy;
  const secondA = project(second.a);
  const secondB = project(second.b);
  const overlapStart = Math.max(0, Math.min(secondA, secondB));
  const overlapEnd = Math.min(len1, Math.max(secondA, secondB));
  const length = overlapEnd - overlapStart;
  if (length <= 0) return null;
  return {
    a: { x: first.a.x + ux * overlapStart, y: first.a.y + uy * overlapStart },
    b: { x: first.a.x + ux * overlapEnd, y: first.a.y + uy * overlapEnd },
    length,
  };
}

function roomExteriorWallSuggestions(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const exteriorPoints = exteriorRingPoints(floor);
  if (exteriorPoints.length < 3) return [] as Array<{ direction: (typeof directionOptions)[number]; length: number; area: number }>;
  const center = {
    x: exteriorPoints.reduce((sum, point) => sum + point.x, 0) / exteriorPoints.length,
    y: exteriorPoints.reduce((sum, point) => sum + point.y, 0) / exteriorPoints.length,
  };
  const exteriorEdges = pointsToEdges(exteriorPoints);
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const lengths = new Map<(typeof directionOptions)[number], number>();

  for (const roomEdge of pointsToEdges(roomCorners(room))) {
    for (const exteriorEdge of exteriorEdges) {
      const sharedLength = sharedSegmentLength(roomEdge, exteriorEdge, tolerance);
      if (sharedLength <= 0.25) continue;
      const direction = exteriorEdgeDirection(exteriorEdge, exteriorPoints, center, Math.max(0.75, tolerance * 2));
      lengths.set(direction, (lengths.get(direction) ?? 0) + sharedLength);
    }
  }

  return directionOptions
    .map((direction) => ({
      direction,
      length: Number((lengths.get(direction) ?? 0).toFixed(3)),
      area: Number(((lengths.get(direction) ?? 0) * Math.max(0, room.ceilingHeight)).toFixed(3)),
    }))
    .filter((suggestion) => suggestion.length > 0.25);
}

function roomExteriorDirections(floor: TakeoffFloor, room: TakeoffRectRoom) {
  return roomExteriorWallSuggestions(floor, room).map((suggestion) => suggestion.direction);
}

function roomExteriorSegments(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const exteriorPoints = exteriorRingPoints(floor);
  if (exteriorPoints.length < 3) return [] as Array<{ a: TakeoffPoint; b: TakeoffPoint; direction: (typeof directionOptions)[number]; length: number }>;
  const center = {
    x: exteriorPoints.reduce((sum, point) => sum + point.x, 0) / exteriorPoints.length,
    y: exteriorPoints.reduce((sum, point) => sum + point.y, 0) / exteriorPoints.length,
  };
  const exteriorEdges = pointsToEdges(exteriorPoints);
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const segments: Array<{ a: TakeoffPoint; b: TakeoffPoint; direction: (typeof directionOptions)[number]; length: number }> = [];

  for (const roomEdge of pointsToEdges(roomCorners(room))) {
    for (const exteriorEdge of exteriorEdges) {
      const exposed = sharedSegment(roomEdge, exteriorEdge, tolerance);
      if (!exposed || exposed.length <= 0.25) continue;
      segments.push({
        ...exposed,
        direction: exteriorEdgeDirection(exteriorEdge, exteriorPoints, center, Math.max(0.75, tolerance * 2)),
        length: Number(exposed.length.toFixed(3)),
      });
    }
  }

  return segments;
}

function adjacentKindsForSegment(floor: TakeoffFloor, segment: { a: TakeoffPoint; b: TakeoffPoint }) {
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const kinds = new Set<TakeoffAdjacentSpaceKind>();
  for (const space of floor.adjacentSpaces ?? []) {
    if (adjacentSpaceTouchesSegment(space, segment, tolerance)) kinds.add(space.kind);
  }
  return Array.from(kinds);
}

function segmentCorridorPolygon(segment: { a: TakeoffPoint; b: TakeoffPoint }, tolerance: number): Polygon | null {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001) return null;
  const halfWidth = Math.max(0.15, tolerance);
  const px = -dy / length * halfWidth;
  const py = dx / length * halfWidth;
  return pointsToClipPolygon([
    { x: segment.a.x + px, y: segment.a.y + py },
    { x: segment.b.x + px, y: segment.b.y + py },
    { x: segment.b.x - px, y: segment.b.y - py },
    { x: segment.a.x - px, y: segment.a.y - py },
  ]);
}

function adjacentSpaceTouchesSegment(
  space: TakeoffAdjacentSpace,
  segment: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  const adjacentEdges = pointsToEdges(adjacentSpaceCorners(space));
  if (adjacentEdges.some((edge) => sharedSegmentLength(segment, edge, tolerance) > 0.25)) return true;

  const corridor = segmentCorridorPolygon(segment, tolerance);
  if (!corridor) return false;
  const overlapArea = intersection([corridor], [pointsToClipPolygon(adjacentSpaceCorners(space))])
    .reduce((sum, polygon) => sum + clipPolygonArea(polygon), 0);
  return overlapArea > Math.max(0.2, tolerance * 0.5);
}

function normalizeAdjacentSpaceRect(floor: TakeoffFloor, rect: PlanRect) {
  const rectPolygon = pointsToClipPolygon(rectToPoints(rect));
  const conditionedPoints = exteriorRingPoints(floor);
  if (conditionedPoints.length < 3) return { rect, polygon: undefined };

  const outsidePolygons = simplePolygonsFromMultiPolygon(
    difference([rectPolygon], [pointsToClipPolygon(conditionedPoints)])
  );
  const largest = outsidePolygons
    .sort((a, b) => b.area - a.area)[0]?.polygon;
  if (!largest) return null;

  const polygon = clipPolygonToPoints(largest);
  const bounds = polygonBounds(polygon);
  return {
    rect: {
      x: Number(bounds.x.toFixed(3)),
      y: Number(bounds.y.toFixed(3)),
      width: Number(bounds.width.toFixed(3)),
      depth: Number(bounds.depth.toFixed(3)),
    },
    polygon: polygon.map((point) => ({ x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) })),
  };
}

function adjacentKindsByDirection(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const byDirection = new Map<(typeof directionOptions)[number], TakeoffAdjacentSpaceKind[]>();
  for (const segment of roomExteriorSegments(floor, room)) {
    const kinds = adjacentKindsForSegment(floor, segment);
    if (kinds.length === 0) continue;
    const existing = new Set(byDirection.get(segment.direction) ?? []);
    kinds.forEach((kind) => existing.add(kind));
    byDirection.set(segment.direction, Array.from(existing));
  }
  return byDirection;
}

function adjacentKindsForPlacedOpening(floor: TakeoffFloor, room: TakeoffRectRoom, component: TakeoffRoomComponent) {
  if (!component.placement || !isCompassDirection(component.direction)) return [];
  const tolerance = Math.max(1.5, floor.scale.feetPerGrid * 1.5);
  const kinds = new Set<TakeoffAdjacentSpaceKind>();
  for (const segment of roomExteriorSegments(floor, room).filter((entry) => entry.direction === component.direction)) {
    const distanceToSegment = distance(closestPointOnSegment(component.placement, segment.a, segment.b), component.placement);
    if (distanceToSegment <= tolerance) {
      adjacentKindsForSegment(floor, segment).forEach((kind) => kinds.add(kind));
    }
  }
  return Array.from(kinds);
}

function isCompassDirection(value: TakeoffRoomComponent["direction"] | undefined): value is (typeof directionOptions)[number] {
  return !!value && (directionOptions as readonly string[]).includes(value);
}

function overlaps(a: TakeoffRectRoom, b: TakeoffRectRoom) {
  if (a.polygon || b.polygon) {
    return intersection(roomToClipPolygon(a), roomToClipPolygon(b)).some((polygon) => polygonArea(clipPolygonToPoints(polygon)) > 0.25);
  }
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.depth && a.y + a.depth > b.y;
}

function roomOutsideFootprintArea(room: TakeoffRectRoom, floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) {
    const roomArea = rectArea(room);
    if (roomArea <= 0.25) return roomArea;
    const insideArea = intersection(roomToClipPolygon(room), pointsToClipPolygon(floor.exteriorPolygon))
      .reduce((sum, polygon) => sum + polygonArea(clipPolygonToPoints(polygon)), 0);
    return Math.max(0, roomArea - insideArea);
  }

  const outsideLeft = Math.max(0, -room.x);
  const outsideTop = Math.max(0, -room.y);
  const outsideRight = Math.max(0, room.x + room.width - floor.conditionedPerimeter.width);
  const outsideBottom = Math.max(0, room.y + room.depth - floor.conditionedPerimeter.depth);
  return (outsideLeft + outsideRight) * room.depth + (outsideTop + outsideBottom) * room.width;
}

function insidePerimeter(room: TakeoffRectRoom, floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) {
    const roomArea = rectArea(room);
    if (roomArea <= 0.25) return false;
    return roomOutsideFootprintArea(room, floor) <= Math.max(2, roomArea * 0.01);
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

function cellKey(cell: Pick<UnassignedCell, "x" | "y">) {
  return `${cell.x.toFixed(3)},${cell.y.toFixed(3)}`;
}

function unassignedCellPoints(cell: UnassignedCell) {
  return cell.polygon && cell.polygon.length >= 3 ? cell.polygon : rectToPoints(cell);
}

function unassignedCellMeasuredArea(cell: UnassignedCell) {
  return cell.area ?? polygonArea(unassignedCellPoints(cell));
}

function cellsAreAdjacent(a: UnassignedCell, b: UnassignedCell) {
  const firstEdges = pointsToEdges(unassignedCellPoints(a));
  const secondEdges = pointsToEdges(unassignedCellPoints(b));
  return firstEdges.some((firstEdge) =>
    secondEdges.some((secondEdge) => sharedSegmentLength(firstEdge, secondEdge, 0.01) > 0.01)
  );
}

function unassignedRegionBounds(cells: UnassignedCell[]): PlanRect {
  const bounds = cells.map((cell) => polygonBounds(unassignedCellPoints(cell)));
  const minX = Math.min(...bounds.map((bound) => bound.x));
  const minY = Math.min(...bounds.map((bound) => bound.y));
  const maxX = Math.max(...bounds.map((bound) => bound.x + bound.width));
  const maxY = Math.max(...bounds.map((bound) => bound.y + bound.depth));
  return { x: minX, y: minY, width: maxX - minX, depth: maxY - minY };
}

function adjacentRoomsForCells(floor: TakeoffFloor, cells: UnassignedCell[]) {
  const cellEdges = cells.flatMap((cell) => pointsToEdges(unassignedCellPoints(cell)));
  const tolerance = Math.max(0.25, floor.scale.feetPerGrid * 0.25);
  return floor.rooms
    .filter((room) => pointsToEdges(roomCorners(room)).some((roomEdge) =>
      cellEdges.some((cellEdge) => sharedSegmentLength(roomEdge, cellEdge, tolerance) > 0.1)
    ))
    .map((room) => room.id);
}

function buildUnassignedRegions(floor: TakeoffFloor, cells: UnassignedCell[]): UnassignedRegion[] {
  const remaining = new Map(cells.map((cell) => [cellKey(cell), cell]));
  const regions: UnassignedRegion[] = [];

  while (remaining.size > 0) {
    const first = remaining.values().next().value as UnassignedCell;
    const queue = [first];
    const regionCells: UnassignedCell[] = [];
    remaining.delete(cellKey(first));

    while (queue.length > 0) {
      const current = queue.shift()!;
      regionCells.push(current);
      for (const [key, candidate] of Array.from(remaining.entries())) {
        if (!cellsAreAdjacent(current, candidate)) continue;
        remaining.delete(key);
        queue.push(candidate);
      }
    }

    const bounds = unassignedRegionBounds(regionCells);
    const area = regionCells.reduce((sum, cell) => sum + unassignedCellMeasuredArea(cell), 0);
    regions.push({
      id: `unassigned-${bounds.x.toFixed(2)}-${bounds.y.toFixed(2)}-${regionCells.length}`,
      label: `Unassigned area ${regions.length + 1}`,
      cells: regionCells,
      area,
      bounds,
      adjacentRoomIds: adjacentRoomsForCells(floor, regionCells),
    });
  }

  return regions.sort((a, b) => b.area - a.area);
}

function buildValidation(floor: TakeoffFloor, unassignedRegions: UnassignedRegion[] = []): TakeoffValidationIssue[] {
  const issues: TakeoffValidationIssue[] = [];
  const area = footprintArea(floor);
  const roomArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const defaultCeilingHeight = floor.defaultCeilingHeight ?? 9;

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
    const roomTarget = { type: "room" as const, roomId: room.id };
    if (!insidePerimeter(room, floor)) {
      issues.push({ severity: "error", message: `${room.name || "Room"} extends beyond the conditioned footprint by about ${Math.round(roomOutsideFootprintArea(room, floor))} sf.`, target: roomTarget });
    }
    if (room.ceilingHeight <= 0) {
      issues.push({ severity: "error", message: `${room.name || "Room"} needs a ceiling height.`, target: roomTarget });
    }
    const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
    if (ceilingInfo.needsReview) {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} ceiling height differs from the floor default by about ${ceilingInfo.heightDelta.toFixed(1)} ft. If attic space is above this may create about ${Math.round(ceilingInfo.estimatedAddedWallArea)} sf of raised wall/knee-wall exposure. Review and approve ceiling geometry.`,
        target: roomTarget,
      });
    }
    const missingCeilingWallSuggestions = ceilingWallSuggestionsForRoom(floor, room, defaultCeilingHeight)
      .filter((suggestion) => !ceilingWallSuggestionApplied(room, suggestion));
    if (room.ceilingGeometryApproved && missingCeilingWallSuggestions.length > 0) {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} approved ceiling geometry is missing ${missingCeilingWallSuggestions.length} generated raised wall/gable component${missingCeilingWallSuggestions.length === 1 ? "" : "s"}. Re-approve the ceiling geometry or add the wall sections manually.`,
        target: roomTarget,
      });
    }
    const staleCeilingWalls = staleGeneratedCeilingWallComponents(floor, room);
    if (staleCeilingWalls.length > 0) {
      issues.push({
        severity: "error",
        message: `${room.name || "Room"} has ${staleCeilingWalls.length} generated ceiling-wall component${staleCeilingWalls.length === 1 ? "" : "s"} that no longer match the current ceiling shape: ${staleCeilingWalls.map((component) => component.label || component.geometryLabel || component.assembly).join(", ")}. Remove them or rebuild the ceiling geometry.`,
        target: roomTarget,
      });
    }
    const roomArea = rectArea(room);
    const floorArea = componentAreaTotal(room, "floor");
    const ceilingArea = componentAreaTotal(room, "ceiling");
    const noFloorLoad = roomSurfaceNoLoad(room, "floor");
    const noCeilingLoad = roomSurfaceNoLoad(room, "ceiling");
    const exteriorDirections = roomExteriorDirections(floor, room);
    const openingAreas = openingAreaByDirection(room);
    const wallAreas = wallAreaByDirection(room);
    const missingSuggestedWalls = missingSuggestedExteriorWalls(floor, room);
    if (missingSuggestedWalls.length > 0) {
      issues.push({
        severity: "error",
        message: `${room.name || "Room"} has ${missingSuggestedWalls.length} suggested exterior wall area${missingSuggestedWalls.length === 1 ? "" : "s"} not assigned: ${missingSuggestedWalls.map((entry) => `${entry.direction} ${Math.round(entry.suggestedGross)} sf`).join(", ")}.`,
        target: roomTarget,
      });
    }
    const adjacentWallMismatches = wallAdjacentSpaceMismatches(floor, room);
    if (adjacentWallMismatches.length > 0) {
      issues.push({
        severity: "error",
        message: `${room.name || "Room"} has wall component${adjacentWallMismatches.length === 1 ? "" : "s"} touching adjacent space but still classified differently: ${adjacentWallMismatches.map(({ component, recommendation }) => `${component.direction} should be ${recommendation.label} (${recommendation.assembly})`).join(", ")}.`,
        target: roomTarget,
      });
    }
    if (!noFloorLoad && floorArea > roomArea + 0.5) {
      issues.push({ severity: "error", message: `${room.name || "Room"} floor components exceed room area by ${Math.round(floorArea - roomArea)} sf.`, target: roomTarget });
    }
    if (!noCeilingLoad && ceilingArea > roomArea + 0.5 && !(ceilingInfo.ceilingType === "vaulted" && room.ceilingGeometryApproved)) {
      issues.push({ severity: "error", message: `${room.name || "Room"} ceiling components exceed room area by ${Math.round(ceilingArea - roomArea)} sf.`, target: roomTarget });
    }
    for (const component of roomComponents(room)) {
      if (!component.assembly) {
        issues.push({ severity: "error", message: `${room.name || "Room"} has a component with no assembly code.`, target: roomTarget });
      }
      const isGeneratedCeilingWall = componentIsGeneratedCeilingWall(component);
      if (componentRequiresDirection(component) && !component.direction) {
        issues.push({ severity: "warning", message: `${room.name || "Room"} has a ${componentSurfaceLabel(component.surface).toLowerCase()} component with no direction.`, target: roomTarget });
      }
      if (
        componentRequiresDirection(component) &&
        isCompassDirection(component.direction) &&
        !exteriorDirections.includes(component.direction)
      ) {
        issues.push({
          severity: "error",
          message: `${room.name || "Room"} cannot assign a ${componentSurfaceLabel(component.surface).toLowerCase()} to ${component.direction}; detected exterior/load-bearing directions: ${exteriorDirections.join(", ") || "none"}.`,
          target: roomTarget,
        });
      }
      if (
        isGeneratedCeilingWall &&
        component.adjacency === "outside" &&
        isCompassDirection(component.direction) &&
        !exteriorDirections.includes(component.direction)
      ) {
        issues.push({
          severity: "warning",
          message: `${room.name || "Room"} ${component.geometryLabel || component.label || "generated ceiling wall"} is marked exterior on ${component.direction}, but this room's detected exterior/load-bearing directions are ${exteriorDirections.join(", ") || "none"}. Change adjacency to attic/conditioned or verify the exterior trace.`,
          target: roomTarget,
        });
      }
      if (isGeneratedCeilingWall && !component.adjacency) {
        issues.push({
          severity: "warning",
          message: `${room.name || "Room"} ${component.geometryLabel || component.label || "generated ceiling wall"} needs an adjacency: attic, exterior, garage, crawlspace, conditioned, or unknown.`,
          target: roomTarget,
        });
      }
      if (component.area <= 0) {
        issues.push({ severity: "warning", message: `${room.name || "Room"} has a ${component.surface} component with no area.`, target: roomTarget });
      }
      if (component.surface === "glass" && component.placement && isCompassDirection(component.direction)) {
        const adjacentKinds = adjacentKindsForPlacedOpening(floor, room, component);
        if (adjacentKinds.includes("garage")) {
          issues.push({ severity: "error", message: `${room.name || "Room"} has glass on a garage-adjacent ${component.direction} wall.`, target: roomTarget });
        }
        if (adjacentKinds.includes("covered_porch") && component.solarDirection !== "Shaded") {
          issues.push({ severity: "warning", message: `${room.name || "Room"} has glass on a covered-porch ${component.direction} wall. Mark it shaded if Salas treats that opening as shaded.`, target: roomTarget });
        }
      }
    }
    for (const [direction, openingArea] of openingAreas) {
      const wallArea = wallAreas.get(direction) ?? 0;
      if (openingArea > wallArea + 0.5) {
        issues.push({
          severity: "error",
          message: `${room.name || "Room"} has ${Math.round(openingArea)} sf of windows/doors on ${direction}, exceeding ${Math.round(wallArea)} sf of assigned wall area.`,
          target: roomTarget,
        });
      }
    }
    if (!noFloorLoad && floorArea < roomArea - 0.5) {
      issues.push({ severity: "warning", message: `${room.name || "Room"} floor components leave ${Math.round(roomArea - floorArea)} sf unassigned.`, target: roomTarget });
    }
    if (!noCeilingLoad && ceilingArea < roomArea - 0.5) {
      issues.push({ severity: "warning", message: `${room.name || "Room"} ceiling components leave ${Math.round(roomArea - ceilingArea)} sf unassigned.`, target: roomTarget });
    }
  }

  for (let i = 0; i < floor.rooms.length; i += 1) {
    for (let j = i + 1; j < floor.rooms.length; j += 1) {
      if (overlaps(floor.rooms[i], floor.rooms[j])) {
        issues.push({ severity: "error", message: `${floor.rooms[i].name} overlaps ${floor.rooms[j].name}.`, target: { type: "room", roomId: floor.rooms[i].id } });
      }
    }
  }

  if (area > 0 && floor.rooms.length === 0) {
    issues.push({
      severity: "warning",
      message: `No rooms are assigned yet. Conditioned footprint is ${Math.round(area)} sf.`,
    });
  } else if (area > 0 && unassignedRegions.length > 0) {
    for (const region of unassignedRegions) {
      if (region.area <= 1) continue;
      issues.push({
        severity: "warning",
        message: `${region.label}: ${Math.round(region.area)} sf of conditioned footprint remains unassigned.`,
        target: { type: "unassigned", regionId: region.id },
      });
    }
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
    room_type: room.roomType ?? "plain",
    ...(room.peopleOverride != null ? { people_override: room.peopleOverride } : {}),
    ...(room.applianceWattsOverride != null ? { appliance_watts_override: room.applianceWattsOverride } : {}),
    unit_id: "unit-whole-house",
    zone_id: "zone-default",
  }));
  const bedroomCount = floor.rooms.filter((room) => room.roomType === "bedroom").length;
  const resolvedBedroomCount = Math.max(bedroomCount, 1);
  const resolvedVentilationCfm = project.ventilationCfm || ventilationCfmForBedrooms(resolvedBedroomCount);
  const lineItems = floor.rooms.flatMap((room) => {
    return payloadComponentsForRoom(room).map((component) => ({
      name: `${room.name} ${component.label || component.assembly}`,
      kind: componentPayloadKind(component.surface),
      room_name: room.name,
      assembly: component.assembly,
      direction: payloadDirectionForComponent(component),
      area: component.area,
      ...(component.source ? { source: component.source } : {}),
      ...(component.adjacency ? { adjacency: component.adjacency } : {}),
      ...(component.geometryLabel ? { geometry_label: component.geometryLabel } : {}),
      ...(component.solarDirection ? { solar_direction: component.solarDirection, wall_direction: component.direction } : {}),
    }));
  });

  return {
    project: {
      name: project.name,
      location: project.location || "",
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
      infiltration: project.mechanicalVentilation
        ? { mode: "standard_ach", outside_air_cfm: resolvedVentilationCfm }
        : { mode: "standard_ach" },
      metadata: {
        ach50: 5,
        bedrooms: resolvedBedroomCount,
        seer: 14,
        front_door_faces: project.frontDoorFaces,
        ...(project.mechanicalVentilation ? { mechanical_ventilation: true, outside_air_cfm: resolvedVentilationCfm } : {}),
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
          auto_internal_gains: true,
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

function adjacentSpaceLabel(kind: TakeoffAdjacentSpaceKind) {
  return adjacentSpaceKinds.find((entry) => entry.id === kind)?.label ?? "Adjacent";
}

function adjacentSpaceColor(kind: TakeoffAdjacentSpaceKind) {
  const colors: Record<TakeoffAdjacentSpaceKind, { fill: string; stroke: string }> = {
    garage: { fill: "rgba(138, 101, 50, 0.22)", stroke: "#8a6532" },
    attic: { fill: "rgba(117, 91, 145, 0.18)", stroke: "#755b91" },
    crawl: { fill: "rgba(73, 119, 117, 0.18)", stroke: "#497775" },
    covered_porch: { fill: "rgba(53, 121, 107, 0.16)", stroke: "#35796b" },
    exterior: { fill: "rgba(93, 106, 118, 0.14)", stroke: "#5d6a76" },
  };
  return colors[kind];
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
    coordinateSpace: rawFloor.coordinateSpace || "world_feet",
    elevation: rawFloor.elevation ?? fallback.elevation,
    floorToFloorHeight: rawFloor.floorToFloorHeight ?? fallback.floorToFloorHeight,
    alignment: rawFloor.alignment,
    referencePoints: rawFloor.referencePoints ?? [],
    designGrid: { ...fallback.designGrid, ...(rawFloor.designGrid ?? {}) },
    scale: { ...fallback.scale, ...(rawFloor.scale ?? {}) },
    defaultCeilingHeight: rawFloor.defaultCeilingHeight ?? fallback.defaultCeilingHeight,
    reference: rawFloor.reference,
    calibration: {
      ...fallback.calibration,
      ...(rawFloor.calibration ?? {}),
      lines: rawFloor.calibration?.lines ?? [],
      linesVisible: rawFloor.calibration?.linesVisible ?? !rawFloor.calibration?.confirmed,
      confirmed: Boolean(
        rawFloor.calibration?.confirmed ||
        (rawFloor.reference && rawFloor.calibration?.appliedFactor && Math.abs(rawFloor.calibration.appliedFactor - 1) > 0.00001)
      ),
    },
    conditionedPerimeter: { ...fallback.conditionedPerimeter, ...(rawFloor.conditionedPerimeter ?? {}) },
    exteriorPolygon: rawFloor.exteriorPolygon ?? [],
    perimeterLocked: Boolean(rawFloor.perimeterLocked),
    rooms: rawFloor.rooms ?? [],
    adjacentSpaces: rawFloor.adjacentSpaces ?? [],
    attributedSlices: rawFloor.attributedSlices ?? [],
  };
}

function normalizeTakeoffProject(rawProject: Partial<TakeoffProject>): TakeoffProject {
  const frontDoorFaces = directionOptions.includes(rawProject.frontDoorFaces as TakeoffProject["frontDoorFaces"])
    ? rawProject.frontDoorFaces as TakeoffProject["frontDoorFaces"]
    : "S";
  return makeTakeoffProject(
    rawProject.name || "Takeoff V1 Draft",
    rawProject.location ?? "",
    Boolean(rawProject.mechanicalVentilation),
    Number(rawProject.ventilationCfm ?? 0),
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

function shapeFromPoints(points: TakeoffPoint[], center: TakeoffPoint) {
  const cleanedPoints = cleanPolygonPointsForRender(points);
  const shape = new THREE.Shape();
  cleanedPoints.forEach((point, index) => {
    const x = point.x - center.x;
    const y = point.y - center.y;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();
  return shape;
}

function simplifyPolygonPoints(points: TakeoffPoint[], options: { duplicateTolerance?: number; collinearTolerance?: number; shortSegmentTolerance?: number; preserveIndices?: number[] } = {}): TakeoffPoint[] {
  if (points.length <= 3) return points;
  const duplicateTolerance = options.duplicateTolerance ?? 0.02;
  const collinearTolerance = options.collinearTolerance ?? 0.08;
  const shortSegmentTolerance = options.shortSegmentTolerance ?? 0.18;
  const preserveIndices = new Set(options.preserveIndices ?? []);
  type SimplifyEntry = { point: TakeoffPoint; originalIndex: number; preserve: boolean };
  let entries: SimplifyEntry[] = points
    .map((point, index) => ({ point, originalIndex: index, preserve: preserveIndices.has(index) }))
    .filter((entry, index, entries) => index === 0 || entry.preserve || distance(entry.point, entries[index - 1].point) > duplicateTolerance);
  if (entries.length > 2 && distance(entries[0].point, entries[entries.length - 1].point) <= duplicateTolerance && !entries[entries.length - 1].preserve) {
    entries = entries.slice(0, -1);
  }
  if (entries.length <= 3) return entries.map(({ point }) => point);
  let simplified = entries;
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    const nextPoints = simplified.filter((point, index) => {
      if (point.preserve) return true;
      const previous = simplified[(index - 1 + simplified.length) % simplified.length].point;
      const next = simplified[(index + 1) % simplified.length].point;
      const previousLength = distance(previous, point.point);
      const nextLength = distance(point.point, next);
      const segmentLength = distance(previous, next);
      if (segmentLength <= duplicateTolerance) {
        changed = true;
        return false;
      }
      const offLine = Math.abs((next.x - previous.x) * (previous.y - point.point.y) - (previous.x - point.point.x) * (next.y - previous.y)) / segmentLength;
      const isNearStraightRun = offLine <= collinearTolerance;
      const isTinyJogOnLine = offLine <= collinearTolerance * 1.75 && Math.min(previousLength, nextLength) <= shortSegmentTolerance;
      if (isNearStraightRun || isTinyJogOnLine) {
        changed = true;
        return false;
      }
      return true;
    });
    if (nextPoints.length < 3) break;
    simplified = nextPoints;
  }
  return simplified.length >= 3
    ? simplified.map(({ point }) => ({ x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) }))
    : entries.map(({ point }) => point);
}

function cleanPolygonPointsForRender(points: TakeoffPoint[]) {
  return simplifyPolygonPoints(points, { duplicateTolerance: 0.02, collinearTolerance: 0.08, shortSegmentTolerance: 0.18 });
}

function createHorizontalShapeMesh(points: TakeoffPoint[], center: TakeoffPoint, height: number, material: THREE.Material) {
  const geometry = new THREE.ShapeGeometry(shapeFromPoints(points, center));
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, height, 0);
  return new THREE.Mesh(geometry, material);
}

function modelPoint(point: TakeoffPoint, center: TakeoffPoint, height: number) {
  return new THREE.Vector3(point.x - center.x, height, point.y - center.y);
}

function createPanelMesh(vertices: THREE.Vector3[], material: THREE.Material) {
  const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
  if (vertices.length === 3) {
    geometry.setIndex([0, 1, 2]);
  } else if (vertices.length === 4) {
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function raisedWallMeshPartsForRoom(room: TakeoffRectRoom, center: TakeoffPoint, baseHeight: number, topHeight: number, material: THREE.Material): ModelMeshPart[] {
  if (topHeight <= baseHeight + 0.01) return [];
  return pointsToEdges(roomCorners(room)).map((edge) => {
    const direction = edgeDirectionFromRoom(edge, room);
    const length = distance(edge.a, edge.b);
    return {
      mesh: createPanelMesh([
        modelPoint(edge.a, center, baseHeight),
        modelPoint(edge.b, center, baseHeight),
        modelPoint(edge.b, center, topHeight),
        modelPoint(edge.a, center, topHeight),
      ], material),
      kind: "knee-wall",
      label: `${direction}-side raised wall band`,
      surface: "wall",
      direction,
      area: Number((length * Math.max(0, topHeight - baseHeight)).toFixed(3)),
      source: "raised-ceiling",
      geometryLabel: `Raised wall band - ${direction}`,
    };
  });
}

function vaultedRoofHeightAtPoint(point: TakeoffPoint, bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>) {
  const peakDelta = Math.max(0, ceilingInfo.peakHeight - ceilingInfo.lowHeight);
  if (peakDelta <= 0) return ceilingInfo.lowHeight;
  const ridgeCoord = ceilingInfo.ridgeDirection === "E-W"
    ? bounds.y + bounds.depth * ceilingInfo.ridgeRatio
    : bounds.x + bounds.width * ceilingInfo.ridgeRatio;
  const minCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const maxCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const coord = ceilingInfo.ridgeDirection === "E-W" ? point.y : point.x;
  const run = coord <= ridgeCoord ? ridgeCoord - minCoord : maxCoord - ridgeCoord;
  if (run <= 0.01) return ceilingInfo.peakHeight;
  const ratio = coord <= ridgeCoord
    ? (coord - minCoord) / run
    : (maxCoord - coord) / run;
  return ceilingInfo.lowHeight + peakDelta * clamp(ratio, 0, 1);
}

function createSlopedShapeMesh(points: TakeoffPoint[], center: TakeoffPoint, bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>, material: THREE.Material) {
  const geometry = new THREE.ShapeGeometry(shapeFromPoints(points, center));
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index += 1) {
    const localX = positions.getX(index);
    const localPlanY = positions.getY(index);
    const point = { x: localX + center.x, y: localPlanY + center.y };
    positions.setXYZ(index, localX, vaultedRoofHeightAtPoint(point, bounds, ceilingInfo), localPlanY);
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function splitVaultFootprintAtRidge(points: TakeoffPoint[], bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>) {
  if (ceilingInfo.ceilingType !== "vaulted") return [points];
  const padding = Math.max(bounds.width, bounds.depth, 1) + 4;
  const ridgeCoord = ceilingInfo.ridgeDirection === "E-W"
    ? bounds.y + bounds.depth * ceilingInfo.ridgeRatio
    : bounds.x + bounds.width * ceilingInfo.ridgeRatio;
  const splitRects = ceilingInfo.ridgeDirection === "E-W"
    ? [
        { x: bounds.x - padding, y: bounds.y - padding, width: bounds.width + padding * 2, depth: ridgeCoord - bounds.y + padding },
        { x: bounds.x - padding, y: ridgeCoord, width: bounds.width + padding * 2, depth: bounds.y + bounds.depth - ridgeCoord + padding },
      ]
    : [
        { x: bounds.x - padding, y: bounds.y - padding, width: ridgeCoord - bounds.x + padding, depth: bounds.depth + padding * 2 },
        { x: ridgeCoord, y: bounds.y - padding, width: bounds.x + bounds.width - ridgeCoord + padding, depth: bounds.depth + padding * 2 },
      ];
  const roomPolygon = pointsToClipPolygon(points);
  return splitRects.flatMap((rect) =>
    simplePolygonsFromMultiPolygon(intersection([roomPolygon], [pointsToClipPolygon(rectToPoints(rect))]))
      .map(({ polygon }) => clipPolygonToPoints(polygon))
      .filter((polygonPoints) => polygonPoints.length >= 3)
  );
}

function slopedCeilingMeshPartsForRoom(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number, material: THREE.Material): ModelMeshPart[] {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  const points = roomCorners(room);
  const bounds = polygonBounds(points);
  const ceilingArea = Number(ceilingInfo.slopedCeilingArea.toFixed(3));
  return splitVaultFootprintAtRidge(points, bounds, ceilingInfo).map((panelPoints) => ({
    mesh: createSlopedShapeMesh(panelPoints, center, bounds, ceilingInfo, material),
    kind: "ceiling",
    label: "Vaulted ceiling plane",
    surface: "ceiling",
    area: ceilingArea,
    assembly: roomSurfaceComponents(room, "ceiling")[0]?.assembly,
  }));
}

function splitEdgeAtVaultRidge(edge: { a: TakeoffPoint; b: TakeoffPoint }, bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>) {
  const ridgeCoord = ceilingInfo.ridgeDirection === "E-W"
    ? bounds.y + bounds.depth * ceilingInfo.ridgeRatio
    : bounds.x + bounds.width * ceilingInfo.ridgeRatio;
  const aCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.a.y : edge.a.x;
  const bCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.b.y : edge.b.x;
  if ((ridgeCoord - aCoord) * (ridgeCoord - bCoord) >= 0 || Math.abs(aCoord - bCoord) <= 0.001) return [edge.a, edge.b];
  const ratio = (ridgeCoord - aCoord) / (bCoord - aCoord);
  return [
    edge.a,
    {
      x: edge.a.x + (edge.b.x - edge.a.x) * ratio,
      y: edge.a.y + (edge.b.y - edge.a.y) * ratio,
    },
    edge.b,
  ];
}

function wallMeshForEdge(a: TakeoffPoint, b: TakeoffPoint, center: TakeoffPoint, height: number, material: THREE.Material) {
  const dx = b.x - a.x;
  const dz = b.y - a.y;
  const length = Math.hypot(dx, dz);
  const geometry = new THREE.BoxGeometry(length, Math.max(height, 0.1), 0.18);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(((a.x + b.x) / 2) - center.x, height / 2, ((a.y + b.y) / 2) - center.y);
  mesh.rotation.y = -Math.atan2(dz, dx);
  return mesh;
}

function nearestRoomEdge(point: TakeoffPoint, room: TakeoffRectRoom) {
  let best: { a: TakeoffPoint; b: TakeoffPoint; point: TakeoffPoint; distance: number } | null = null;
  for (const edge of pointsToEdges(roomCorners(room))) {
    const projected = closestPointOnSegment(point, edge.a, edge.b);
    const edgeDistance = distance(point, projected);
    if (!best || edgeDistance < best.distance) best = { ...edge, point: projected, distance: edgeDistance };
  }
  return best;
}

function openingMeshForComponent(component: TakeoffRoomComponent, room: TakeoffRectRoom, center: TakeoffPoint, material: THREE.Material, frameMaterial: THREE.Material) {
  if (!component.placement) return null;
  const width = Math.max(1.5, component.width ?? Math.sqrt(Math.max(component.area, 1) * 0.6));
  const height = Math.max(2, component.height ?? Math.max(2, component.area / width));
  const edge = nearestRoomEdge(component.placement, room);
  if (!edge) return null;
  const dx = edge.b.x - edge.a.x;
  const dz = edge.b.y - edge.a.y;
  const length = Math.max(0.001, Math.hypot(dx, dz));
  const ux = dx / length;
  const uz = dz / length;
  const edgeCenter = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
  const roomCenterPoint = roomCenter(room);
  const normalA = { x: -uz, y: ux };
  const normalB = { x: uz, y: -ux };
  const outward = distance({ x: edgeCenter.x + normalA.x, y: edgeCenter.y + normalA.y }, roomCenterPoint) >
    distance({ x: edgeCenter.x + normalB.x, y: edgeCenter.y + normalB.y }, roomCenterPoint)
    ? normalA
    : normalB;
  const verticalCenter = component.surface === "door"
    ? height / 2
    : Math.min(Math.max(3 + height / 2, height / 2), Math.max(height / 2, room.ceilingHeight - 0.4));
  const group = new THREE.Group();
  group.position.set(edge.point.x + outward.x * 0.16 - center.x, verticalCenter, edge.point.y + outward.y * 0.16 - center.y);
  group.rotation.y = -Math.atan2(dz, dx);
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.22, height + 0.22), frameMaterial);
  frame.position.z = -0.01;
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  fill.position.z = 0.01;
  group.add(frame);
  group.add(fill);
  group.userData.roomId = room.id;
  return group;
}

function referencePlaneForFloor(floor: TakeoffFloor, center: TakeoffPoint, texture: THREE.Texture) {
  const width = Math.max(floor.designGrid.width, 1);
  const depth = Math.max(floor.designGrid.depth, 1);
  const crop = floor.reference?.crop;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  if (crop && crop.width > 0 && crop.depth > 0) {
    texture.repeat.set(crop.width / width, crop.depth / depth);
    texture.offset.set(crop.x / width, 1 - (crop.y + crop.depth) / depth);
  }
  texture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    depthWrite: false,
    opacity: 0.52,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const geometry = new THREE.PlaneGeometry(width, depth);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(width / 2 - center.x, -0.08, depth / 2 - center.y);
  return mesh;
}

function roomRidgePoints(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number) {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  if (ceilingInfo.ceilingType !== "vaulted") return null;
  const bounds = polygonBounds(roomCorners(room));
  const ridgeRunsEastWest = ceilingInfo.ridgeDirection === "E-W";
  const a = ridgeRunsEastWest
    ? { x: bounds.x, y: bounds.y + bounds.depth * ceilingInfo.ridgeRatio }
    : { x: bounds.x + bounds.width * ceilingInfo.ridgeRatio, y: bounds.y };
  const b = ridgeRunsEastWest
    ? { x: bounds.x + bounds.width, y: bounds.y + bounds.depth * ceilingInfo.ridgeRatio }
    : { x: bounds.x + bounds.width * ceilingInfo.ridgeRatio, y: bounds.y + bounds.depth };
  return [
    new THREE.Vector3(a.x - center.x, ceilingInfo.peakHeight, a.y - center.y),
    new THREE.Vector3(b.x - center.x, ceilingInfo.peakHeight, b.y - center.y),
  ];
}

function vaultedWallMeshPartsForRoom(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number, kneeWallMaterial: THREE.Material): ModelMeshPart[] {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  const points = roomCorners(room);
  const bounds = polygonBounds(points);
  const parts: ModelMeshPart[] = [];
  parts.push(...raisedWallMeshPartsForRoom(room, center, defaultCeilingHeight, ceilingInfo.lowHeight, kneeWallMaterial));

  for (const edge of pointsToEdges(points)) {
    const splitPoints = splitEdgeAtVaultRidge(edge, bounds, ceilingInfo);
    for (let index = 0; index < splitPoints.length - 1; index += 1) {
      const a = splitPoints[index];
      const b = splitPoints[index + 1];
      const aHeight = vaultedRoofHeightAtPoint(a, bounds, ceilingInfo);
      const bHeight = vaultedRoofHeightAtPoint(b, bounds, ceilingInfo);
      if (Math.max(aHeight, bHeight) <= ceilingInfo.lowHeight + 0.01) continue;
      const direction = edgeDirectionFromRoom({ a, b }, room);
      const averageHeight = Math.max(0, ((aHeight + bHeight) / 2) - ceilingInfo.lowHeight);
      parts.push({
        mesh: createPanelMesh([
          modelPoint(a, center, ceilingInfo.lowHeight),
          modelPoint(b, center, ceilingInfo.lowHeight),
          modelPoint(b, center, bHeight),
          modelPoint(a, center, aHeight),
        ], kneeWallMaterial),
        kind: "knee-wall",
        label: `${direction}-side vault gable / knee-wall panel`,
        surface: "wall",
        direction,
        area: Number((distance(a, b) * averageHeight).toFixed(3)),
        source: "vault-gable",
        geometryLabel: `Vault gable / knee-wall - ${direction}`,
      });
    }
  }

  return parts;
}

function modelSurfaceFromObject(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.modelSurface) return current.userData.modelSurface as ModelSurfaceSelection;
    current = current.parent;
  }
  return null;
}

function meshFromObject(object: THREE.Object3D) {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current instanceof THREE.Mesh && current.geometry) return current;
    current = current.parent;
  }
  return null;
}

function modelSurfaceKey(surface: ModelSurfaceSelection | null) {
  if (!surface) return "";
  return [
    surface.roomId,
    surface.kind,
    surface.surface ?? "",
    surface.direction ?? "",
    surface.componentId ?? "",
    surface.label,
    surface.area ?? "",
  ].join("|");
}

function modelScheduleCategory(surface: TakeoffRoomComponent["surface"]) {
  if (surface === "glass") return "Glass";
  if (surface === "door") return "Door";
  if (surface === "ceiling") return "Ceiling";
  if (surface === "floor") return "Floor";
  return "Wall";
}

function TakeoffModelPreview({
  floor,
  referenceUrl,
  componentSchedule,
  selectedRoomId,
  onSelectRoom,
  onAssignSurfaceComponent,
}: {
  floor: TakeoffFloor;
  referenceUrl: string;
  componentSchedule: TakeoffComponentDefinition[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onAssignSurfaceComponent: (selection: ModelSurfaceSelection, assembly: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const spanRef = useRef(40);
  const [visibleLayers, setVisibleLayers] = useState<Record<ModelLayerKey, boolean>>({
    reference: true,
    windows: true,
    doors: true,
    ceilings: true,
    floors: true,
    walls: true,
    interiorWalls: false,
  });
  const [selectedSurface, setSelectedSurface] = useState<ModelSurfaceSelection | null>(null);
  const [hoveredSurface, setHoveredSurface] = useState<ModelSurfaceSelection | null>(null);
  const [selectedSurfaceAssembly, setSelectedSurfaceAssembly] = useState("");

  const selectedSurfaceOptions = selectedSurface?.surface
    ? componentSchedule.filter((component) => component.category === modelScheduleCategory(selectedSurface.surface!))
    : [];

  useEffect(() => {
    if (!selectedSurface?.surface) {
      setSelectedSurfaceAssembly("");
      return;
    }
    const firstOption = componentSchedule.find((component) => component.category === modelScheduleCategory(selectedSurface.surface!));
    setSelectedSurfaceAssembly(selectedSurface.assembly || firstOption?.code || "");
  }, [componentSchedule, selectedSurface]);

  function setModelViewPreset(preset: ModelViewPreset) {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const span = spanRef.current;
    const positions: Record<ModelViewPreset, [number, number, number]> = {
      iso: [span * 0.82, span * 0.72, span * 1.05],
      front: [0, span * 0.42, span * 1.35],
      rear: [0, span * 0.42, -span * 1.35],
      left: [-span * 1.35, span * 0.42, 0],
      right: [span * 1.35, span * 0.42, 0],
    };
    camera.position.set(...positions[preset]);
    controls.target.set(0, 4, 0);
    controls.update();
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setHoveredSurface(null);
    const bounds = footprintBounds(floor);
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.depth / 2 };
    const width = Math.max(container.clientWidth, 720);
    const height = Math.max(container.clientHeight, 520);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0xeaf2ef, 1);
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xeaf2ef, 120, 420);
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000);
    const span = Math.max(bounds.width, bounds.depth, 30);
    spanRef.current = span;
    cameraRef.current = camera;
    camera.position.set(span * 0.82, span * 0.72, span * 1.05);
    camera.lookAt(0, 4, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 4, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.minDistance = span * 0.22;
    controls.maxDistance = span * 3.2;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const light = new THREE.DirectionalLight(0xffffff, 0.82);
    light.position.set(40, 70, 45);
    scene.add(light);

    const grid = new THREE.GridHelper(Math.max(span * 1.35, 60), Math.max(12, Math.round(span / 5)), 0x8fb2a1, 0xc8d8cf);
    grid.position.y = -0.04;
    scene.add(grid);

    const loadedTextures: THREE.Texture[] = [];
    if (visibleLayers.reference && referenceUrl) {
      const loader = new THREE.TextureLoader();
      loader.setCrossOrigin("anonymous");
      const texture = loader.load(referenceUrl);
      loadedTextures.push(texture);
      scene.add(referencePlaneForFloor(floor, center, texture));
    }

    const exteriorMaterial = new THREE.MeshBasicMaterial({ color: 0x8fc0b0, depthWrite: false, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const floorMaterial = new THREE.MeshPhongMaterial({ color: 0xc8ddd5, depthWrite: false, transparent: true, opacity: 0.38, side: THREE.DoubleSide });
    const wallMaterial = new THREE.MeshPhongMaterial({ color: 0x8fb4c8, depthWrite: false, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
    const interiorWallMaterial = new THREE.MeshPhongMaterial({ color: 0x9aa9b5, depthWrite: false, transparent: true, opacity: 0.16, side: THREE.DoubleSide });
    const selectedWallMaterial = new THREE.MeshPhongMaterial({ color: 0x6aa0d6, depthWrite: false, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ceilingMaterial = new THREE.MeshPhongMaterial({ color: 0xcfe3ec, depthWrite: false, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
    const kneeWallMaterial = new THREE.MeshPhongMaterial({ color: 0xb35b2f, depthWrite: false, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const glassMaterial = new THREE.MeshBasicMaterial({ color: 0x4f9ab8, transparent: true, opacity: 0.78, side: THREE.DoubleSide });
    const doorMaterial = new THREE.MeshBasicMaterial({ color: 0x6f5228, transparent: true, opacity: 0.82, side: THREE.DoubleSide });
    const openingFrameMaterial = new THREE.MeshBasicMaterial({ color: 0x2f3b1f, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xb35b2f });
    const hoverOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x0f5fa8, depthTest: false, transparent: true, opacity: 0.95 });

    const exteriorPoints = exteriorRingPoints(floor);
    if (exteriorPoints.length >= 3) scene.add(createHorizontalShapeMesh(exteriorPoints, center, -0.02, exteriorMaterial));

    for (const [index, room] of floor.rooms.entries()) {
      const points = roomCorners(room);
      const color = new THREE.Color(roomColor(index));
      const roomFloorMaterial = floorMaterial.clone();
      roomFloorMaterial.color = color;
      const roomCeilingMaterial = ceilingMaterial.clone();
      roomCeilingMaterial.color = color;

      if (visibleLayers.floors) {
        const floorMesh = createHorizontalShapeMesh(points, center, 0, roomFloorMaterial);
        floorMesh.userData.roomId = room.id;
        floorMesh.userData.modelSurface = {
          roomId: room.id,
          roomName: room.name,
          kind: "floor",
          label: "Floor surface",
          surface: "floor",
          area: Number(rectArea(room).toFixed(3)),
          assembly: roomSurfaceComponents(room, "floor")[0]?.assembly,
        } satisfies ModelSurfaceSelection;
        scene.add(floorMesh);
      }

      if (visibleLayers.walls) {
        for (const segment of roomExteriorSegments(floor, room)) {
          const wallMesh = wallMeshForEdge(segment.a, segment.b, center, Math.max(room.ceilingHeight, 0.1), room.id === selectedRoomId ? selectedWallMaterial : wallMaterial);
          wallMesh.userData.roomId = room.id;
          wallMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "load-wall",
            label: `${segment.direction ?? "Exterior"} load wall`,
            surface: "wall",
            direction: segment.direction,
            area: Number((segment.length * Math.max(room.ceilingHeight, 0)).toFixed(3)),
            assembly: roomSurfaceComponents(room, "wall").find((component) => wallCanHostOpenings(component) && component.direction === segment.direction)?.assembly,
          } satisfies ModelSurfaceSelection;
          scene.add(wallMesh);
        }
        const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
        const generatedWallParts = ceilingInfo.ceilingType === "vaulted"
          ? vaultedWallMeshPartsForRoom(room, center, floor.defaultCeilingHeight ?? 9, kneeWallMaterial)
          : raisedWallMeshPartsForRoom(room, center, floor.defaultCeilingHeight ?? 9, room.ceilingHeight, kneeWallMaterial);
        for (const part of generatedWallParts) {
          const component = roomSurfaceComponents(room, "wall").find((candidate) =>
            componentIsGeneratedCeilingWall(candidate) &&
            (!part.direction || candidate.direction === part.direction)
          );
          part.mesh.userData.roomId = room.id;
          part.mesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: part.kind,
            label: part.label,
            surface: "wall",
            direction: part.direction,
            area: part.area,
            assembly: component?.assembly ?? part.assembly,
            componentId: component?.id,
            source: component?.source ?? part.source,
            geometryLabel: component?.geometryLabel ?? part.geometryLabel,
          } satisfies ModelSurfaceSelection;
          scene.add(part.mesh);
        }
      }

      if (visibleLayers.interiorWalls) {
        const exposedSegments = roomExteriorSegments(floor, room);
        const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
        for (const edge of pointsToEdges(points)) {
          const isLoadWall = exposedSegments.some((segment) => sharedSegmentLength(edge, segment, tolerance) > 0.25);
          if (isLoadWall) continue;
          const wallMesh = wallMeshForEdge(edge.a, edge.b, center, Math.max(room.ceilingHeight, 0.1), interiorWallMaterial);
          wallMesh.userData.roomId = room.id;
          wallMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "interior-wall",
            label: "Interior wall",
          } satisfies ModelSurfaceSelection;
          scene.add(wallMesh);
        }
      }

      if (visibleLayers.ceilings && (room.ceilingType ?? "flat") !== "none") {
        const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
        if (ceilingInfo.ceilingType === "vaulted") {
          for (const part of slopedCeilingMeshPartsForRoom(room, center, floor.defaultCeilingHeight ?? 9, roomCeilingMaterial)) {
            part.mesh.userData.roomId = room.id;
            part.mesh.userData.modelSurface = {
              roomId: room.id,
              roomName: room.name,
              kind: part.kind,
              label: part.label,
              surface: part.surface,
              area: part.area,
              assembly: part.assembly,
              source: part.source,
              geometryLabel: part.geometryLabel,
            } satisfies ModelSurfaceSelection;
            scene.add(part.mesh);
          }
        } else {
          const ceilingMesh = createHorizontalShapeMesh(points, center, room.ceilingHeight, roomCeilingMaterial);
          ceilingMesh.userData.roomId = room.id;
          ceilingMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "ceiling",
            label: "Ceiling surface",
            surface: "ceiling",
            area: Number(rectArea(room).toFixed(3)),
            assembly: roomSurfaceComponents(room, "ceiling")[0]?.assembly,
          } satisfies ModelSurfaceSelection;
          scene.add(ceilingMesh);
        }
      }

      const ridge = roomRidgePoints(room, center, floor.defaultCeilingHeight ?? 9);
      if (visibleLayers.ceilings && ridge) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ridge), lineMaterial));

      for (const component of roomSurfaceComponents(room, "glass").concat(roomSurfaceComponents(room, "door"))) {
        if (component.surface === "glass" && !visibleLayers.windows) continue;
        if (component.surface === "door" && !visibleLayers.doors) continue;
        const openingMesh = openingMeshForComponent(component, room, center, component.surface === "glass" ? glassMaterial : doorMaterial, openingFrameMaterial);
        if (openingMesh) {
          openingMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: component.surface === "glass" ? "window" : "door",
            label: component.label || (component.surface === "glass" ? "Window" : "Door"),
            surface: component.surface,
            direction: component.direction,
            area: component.area,
            componentId: component.id,
            assembly: component.assembly,
          } satisfies ModelSurfaceSelection;
          scene.add(openingMesh);
        }
      }
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hoverOutline: THREE.LineSegments | null = null;
    let hoverSurfaceKey = "";

    function clearHoverOutline() {
      if (!hoverOutline) return;
      hoverOutline.parent?.remove(hoverOutline);
      hoverOutline.geometry.dispose();
      hoverOutline = null;
    }

    function setPointerFromEvent(event: PointerEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      pointer.y = -(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
    }

    function firstSelectableHit() {
      return raycaster.intersectObjects(scene.children, true).find((entry) =>
        !entry.object.userData.hoverOutline &&
        (entry.object.userData.roomId || modelSurfaceFromObject(entry.object))
      );
    }

    function updateHover(event: PointerEvent) {
      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = firstSelectableHit();
      const surface = hit ? modelSurfaceFromObject(hit.object) : null;
      const nextKey = modelSurfaceKey(surface);
      if (nextKey === hoverSurfaceKey) return;
      hoverSurfaceKey = nextKey;
      clearHoverOutline();
      if (hit && surface) {
        const mesh = meshFromObject(hit.object);
        if (mesh) {
          hoverOutline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), hoverOutlineMaterial);
          hoverOutline.userData.hoverOutline = true;
          hoverOutline.renderOrder = 999;
          mesh.add(hoverOutline);
        }
      }
      setHoveredSurface(surface);
    }

    function clearHover() {
      hoverSurfaceKey = "";
      clearHoverOutline();
      setHoveredSurface(null);
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.button === 2) return;
      setPointerFromEvent(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = firstSelectableHit();
      if (!hit) return;
      const surface = modelSurfaceFromObject(hit.object);
      if (surface) {
        setSelectedSurface(surface);
        onSelectRoom(surface.roomId);
        return;
      }
      if (hit.object.userData.roomId) onSelectRoom(hit.object.userData.roomId);
    }
    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    renderer.domElement.addEventListener("pointermove", updateHover);
    renderer.domElement.addEventListener("pointerleave", clearHover);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("contextmenu", handleContextMenu);

    let animationFrame = 0;
    function animate() {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    }
    animate();

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextWidth = Math.max(entry.contentRect.width, 720);
      const nextHeight = Math.max(entry.contentRect.height, 520);
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", updateHover);
      renderer.domElement.removeEventListener("pointerleave", clearHover);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("contextmenu", handleContextMenu);
      hoverSurfaceKey = "";
      clearHoverOutline();
      controls.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
      renderer.dispose();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else material?.dispose?.();
      });
      loadedTextures.forEach((texture) => texture.dispose());
      hoverOutlineMaterial.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [floor, onSelectRoom, referenceUrl, selectedRoomId, visibleLayers]);

  return (
    <div className="takeoff-model-preview" ref={containerRef}>
      <div className="takeoff-model-caption">3D QA View · right-click drag to orbit · scroll to zoom · drag to pan</div>
      {hoveredSurface && (
        <div className="takeoff-model-hover-panel">
          <strong>{hoveredSurface.label}</strong>
          <span>{hoveredSurface.roomName}</span>
          {hoveredSurface.direction && <span>{hoveredSurface.direction}</span>}
          {hoveredSurface.area !== undefined && <span>{Math.round(hoveredSurface.area)} sf</span>}
        </div>
      )}
      <div className="takeoff-model-layer-controls" aria-label="3D layer controls">
        {([
          ["reference", "Plan PDF"],
          ["windows", "Windows"],
          ["doors", "Doors"],
          ["ceilings", "Ceilings"],
          ["floors", "Floors"],
          ["walls", "Load walls"],
          ["interiorWalls", "Interior walls"],
        ] as Array<[ModelLayerKey, string]>).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={visibleLayers[key]}
              onChange={(event) => setVisibleLayers((current) => ({ ...current, [key]: event.target.checked }))}
            />
            <span className="takeoff-model-checkbox" aria-hidden="true" />
            {label}
          </label>
        ))}
      </div>
      {selectedSurface && (
        <div className="takeoff-model-surface-panel">
          <div className="takeoff-model-surface-head">
            <strong>{selectedSurface.label}</strong>
            <button type="button" onClick={() => setSelectedSurface(null)} aria-label="Close selected 3D surface">Close</button>
          </div>
          <span>{selectedSurface.roomName}</span>
          {selectedSurface.direction && <span>{selectedSurface.direction} facing</span>}
          {selectedSurface.area !== undefined && <span>{Math.round(selectedSurface.area)} sf</span>}
          {selectedSurface.surface && selectedSurface.kind !== "window" && selectedSurface.kind !== "door" && selectedSurfaceOptions.length > 0 ? (
            <>
              <select value={selectedSurfaceAssembly} onChange={(event) => setSelectedSurfaceAssembly(event.target.value)}>
                {selectedSurfaceOptions.map((option) => (
                  <option key={option.id} value={option.code}>
                    {option.code} - {option.description}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="toolbar-primary"
                onClick={() => {
                  if (!selectedSurfaceAssembly) return;
                  onAssignSurfaceComponent(selectedSurface, selectedSurfaceAssembly);
                }}
              >
                Apply Component
              </button>
            </>
          ) : (
            <span>Selectable for review. Component assignment for this surface is coming next.</span>
          )}
        </div>
      )}
      <div className="takeoff-model-view-controls" aria-label="3D view controls">
        <button type="button" onClick={() => setModelViewPreset("iso")}>Iso</button>
        <button type="button" onClick={() => setModelViewPreset("front")}>Front</button>
        <button type="button" onClick={() => setModelViewPreset("rear")}>Rear</button>
        <button type="button" onClick={() => setModelViewPreset("left")}>Left</button>
        <button type="button" onClick={() => setModelViewPreset("right")}>Right</button>
      </div>
    </div>
  );
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

function fileSafeName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "takeoff";
}

function downloadJsonFile(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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

function roomTypeLabel(roomType?: TakeoffRoomType) {
  return roomTypeOptions.find((option) => option.id === (roomType ?? "plain"))?.shortLabel ?? "Plain";
}

function normalizedRoomNameForInference(name: string) {
  return name.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function inferredRoomTypeFromName(name: string): { type: TakeoffRoomType; reason: string; key: string } | null {
  const normalized = normalizedRoomNameForInference(name);
  if (!normalized) return null;
  const has = (pattern: RegExp) => pattern.test(normalized);
  const hasEntertainmentLabel = has(/\bfamily room\b/) || has(/\bgathering\b/) || has(/\bgreat room\b/) || has(/\bentertainment area\b/);
  const hasBedroomLanguage = has(/\bbed(room)?\b/) || has(/\bowners? suite\b/) || has(/\bmaster\b/);
  if (hasEntertainmentLabel) {
    return { type: "entertainment", reason: "The room name reads like a family/gathering/entertainment space.", key: `${normalized}:entertainment` };
  }
  if (has(/\bkitchen\b/)) {
    return { type: "kitchen", reason: "The room name includes kitchen, which carries appliance/internal gains.", key: `${normalized}:kitchen` };
  }
  if (has(/\blaundry\b/)) {
    return { type: "laundry", reason: "The room name includes laundry, which carries appliance/internal gains.", key: `${normalized}:laundry` };
  }
  if (hasBedroomLanguage) {
    return { type: "bedroom", reason: "The room name reads like a bedroom/owner suite and may affect people and ventilation counts.", key: `${normalized}:bedroom` };
  }
  return null;
}

function validationIssueKey(issue: TakeoffValidationIssue, index?: number) {
  return `${issue.severity}:${issue.target?.type ?? "global"}:${issue.target?.roomId ?? issue.target?.regionId ?? ""}:${issue.message}:${index ?? ""}`;
}

function validationSectionForIssue(issue: TakeoffValidationIssue): ValidationSection {
  const message = issue.message.toLowerCase();
  if (message.includes("suggested exterior wall")) return "wall-suggestions";
  if (message.includes("glass") || message.includes("window") || message.includes("opening")) return "glass-components";
  if (message.includes("door")) return "door-components";
  if (message.includes("wall component") || message.includes("wall components") || message.includes("garage-adjacent") || message.includes("adjacent space")) return "wall-components";
  if (message.includes("floor component") || message.includes("floor components") || message.includes("floor area")) return "floor-components";
  if (message.includes("ceiling geometry") || message.includes("ceiling shape") || message.includes("generated ceiling-wall") || message.includes("raised wall") || message.includes("gable")) return "ceiling-geometry";
  if (message.includes("ceiling component") || message.includes("ceiling components") || message.includes("ceiling area")) return "ceiling-components";
  if (message.includes("merge") || message.includes("unassigned")) return "merge";
  return "room-profile";
}

function componentValidationSection(surface: TakeoffRoomComponent["surface"]): ValidationSection {
  if (surface === "wall") return "wall-components";
  if (surface === "glass") return "glass-components";
  if (surface === "door") return "door-components";
  if (surface === "floor") return "floor-components";
  return "ceiling-components";
}

function sketchPointList(points: TakeoffPoint[], project: (point: TakeoffPoint) => TakeoffPoint) {
  return points.map((point) => {
    const projected = project(point);
    return `${projected.x},${projected.y}`;
  }).join(" ");
}

function sketchLabelPoint(points: TakeoffPoint[], project: (point: TakeoffPoint) => TakeoffPoint) {
  const projected = points.map(project);
  return {
    x: projected.reduce((sum, point) => sum + point.x, 0) / Math.max(projected.length, 1),
    y: projected.reduce((sum, point) => sum + point.y, 0) / Math.max(projected.length, 1),
  };
}

function componentSketchLabel(component: TakeoffRoomComponent) {
  const bits = [component.assembly];
  if (component.surface === "wall") bits.push(wallAdjacencyLabel(component.adjacency ?? "outside").replace(" wall", ""));
  if (component.surface === "glass" && component.solarDirection) bits.push(component.solarDirection);
  return bits.filter(Boolean).join(" ");
}

function componentSourceLabel(source?: TakeoffRoomComponent["source"]) {
  if (source === "exterior-perimeter") return "Approved from suggested wall";
  if (source === "raised-ceiling") return "Generated from raised ceiling";
  if (source === "vault-gable") return "Generated from vaulted ceiling";
  if (source === "opening-placement") return "Placed opening";
  return null;
}

function defaultOpeningLabel(surface: "glass" | "door", solarDirection?: TakeoffRoomComponent["solarDirection"]) {
  if (surface === "door") return "Door";
  return solarDirection === "Shaded" ? "Shaded window" : "Window";
}

function isAutoOpeningLabel(label?: string) {
  if (!label) return true;
  return ["window", "shaded window", "door"].includes(label.trim().toLowerCase());
}

function validationSectionLabel(section: ValidationSection) {
  const labels: Record<ValidationSection, string> = {
    merge: "Merge / attribution tools",
    "wall-suggestions": "Suggested Exterior Walls",
    "wall-components": "Wall Components",
    "glass-components": "Glass Components",
    "door-components": "Door Components",
    "floor-components": "Floor Components",
    "ceiling-components": "Ceiling Components",
    "ceiling-geometry": "Ceiling Geometry",
    "room-profile": "Room Profile",
  };
  return labels[section];
}

function validationSectionElementId(roomId: string, section: ValidationSection) {
  if (section === "wall-components") return `room-wall-components-${roomId}`;
  return `validation-target-${roomId}-${section}`;
}

function scaleLineHasKnownDimension(line: TakeoffScaleLine) {
  return line.knownFeet > 0 && lineLength(scaleLineSourcePoints(line)) > 0;
}

export function TakeoffApp() {
  const [projectName, setProjectName] = useState("Takeoff V1 Draft");
  const [location, setLocation] = useState("");
  const [mechanicalVentilation, setMechanicalVentilation] = useState(false);
  const [ventilationCfm, setVentilationCfm] = useState(0);
  const [frontDoorFaces, setFrontDoorFaces] = useState<(typeof directionOptions)[number]>("S");
  const [calcLoading, setCalcLoading] = useState(false);
  const [calcResult, setCalcResult] = useState<TakeoffCalcResult | null>(null);
  const [componentSchedule, setComponentSchedule] = useState<TakeoffComponentDefinition[]>(() => defaultComponentSchedule);
  const [floor, setFloor] = useState<TakeoffFloor>(() => makeInitialFloor());
  const [draftRoom, setDraftRoom] = useState({ name: "", x: 0, y: 0, width: 0, depth: 0, ceilingHeight: 9 });
  const [message, setMessage] = useState("");
  const [activeValidationTarget, setActiveValidationTarget] = useState<ActiveValidationTarget | null>(null);
  const [activeSketchTarget, setActiveSketchTarget] = useState<SketchTarget | null>(null);
  const [takeoffId, setTakeoffId] = useState<number | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState(() => takeoffSnapshot(makeTakeoffProject("Takeoff V1 Draft", "", false, 0, "S", makeInitialFloor(), defaultComponentSchedule)));
  const [saveLoading, setSaveLoading] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [openDialogLoading, setOpenDialogLoading] = useState(false);
  const [openDialogError, setOpenDialogError] = useState("");
  const [savedTakeoffs, setSavedTakeoffs] = useState<SavedTakeoffRow[]>([]);
  const [componentScheduleOpen, setComponentScheduleOpen] = useState(false);
  const [componentSearch, setComponentSearch] = useState("");
  const [pendingComponentAssignment, setPendingComponentAssignment] = useState<TakeoffComponentDefinition | null>(null);
  const [ceilingWallAssemblies, setCeilingWallAssemblies] = useState<Record<string, string>>({});
  const [ceilingWallAdjacencies, setCeilingWallAdjacencies] = useState<Record<string, TakeoffWallAdjacency>>({});
  const [staleCeilingWallPrompt, setStaleCeilingWallPrompt] = useState<StaleCeilingWallPrompt>(null);
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
  const [leftSectionsOpen, setLeftSectionsOpen] = useState<Record<LeftSetupSection, boolean>>({
    project: true,
    mode: true,
    scale: true,
    grid: false,
    exterior: false,
  });
  const [zoom, setZoom] = useState(1);
  const [planReviewMode, setPlanReviewMode] = useState<PlanReviewMode>("plan");
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
  const [adjacentDrawMode, setAdjacentDrawMode] = useState(false);
  const [adjacentSpaceKind, setAdjacentSpaceKind] = useState<TakeoffAdjacentSpaceKind>("garage");
  const [subtractMode, setSubtractMode] = useState(false);
  const [subtractRoomId, setSubtractRoomId] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [pendingRoomNameSelectId, setPendingRoomNameSelectId] = useState<string | null>(null);
  const [roomTileMetric, setRoomTileMetric] = useState<RoomTileMetric>("floor");
  const [roomLoadSketchRotationSteps, setRoomLoadSketchRotationSteps] = useState(0);
  const [ceilingSketchRotationSteps, setCeilingSketchRotationSteps] = useState(0);
  const [sliceRoomId, setSliceRoomId] = useState("");
  const [mergeTargetRoomId, setMergeTargetRoomId] = useState("");
  const [selectedUnassignedRegionId, setSelectedUnassignedRegionId] = useState<string | null>(null);
  const [suggestedWallAssembly, setSuggestedWallAssembly] = useState("W1");
  const [openingPlacement, setOpeningPlacement] = useState<OpeningPlacement>(null);
  const [openingModeActive, setOpeningModeActive] = useState(false);
  const [pendingOpeningTarget, setPendingOpeningTarget] = useState<PendingOpeningTarget>(null);
  const [editingOpeningTarget, setEditingOpeningTarget] = useState<EditingOpeningTarget>(null);
  const [selectedOpening, setSelectedOpening] = useState<OpeningMoveTarget | null>(null);
  const roomNameInputRef = useRef<HTMLInputElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const suppressNextCanvasClickRef = useRef(false);
  const modalPointerStartedOnBackdropRef = useRef(false);
  const openingDragMovedRef = useRef(false);

  useEffect(() => {
    return () => {
      if (referenceUrl) revokeReferenceUrl(referenceUrl);
    };
  }, [referenceUrl]);

  const takeoffProject = useMemo<TakeoffProject>(
    () => makeTakeoffProject(projectName, location, mechanicalVentilation, ventilationCfm, frontDoorFaces, floor, componentSchedule),
    [componentSchedule, floor, frontDoorFaces, location, mechanicalVentilation, projectName, ventilationCfm],
  );
  const taggedBedroomCount = Math.max(floor.rooms.filter((room) => room.roomType === "bedroom").length, 1);
  const suggestedVentilationCfm = ventilationCfmForBedrooms(taggedBedroomCount);
  const persistableTakeoff = useMemo(() => persistableTakeoffProject(takeoffProject), [takeoffProject]);
  const serializedTakeoff = useMemo(() => takeoffSnapshot(persistableTakeoff), [persistableTakeoff]);
  const isDirty = takeoffId === null || serializedTakeoff !== savedSnapshot;
  const computedFootprintArea = footprintArea(floor);
  const assignedArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const unassignedArea = computedFootprintArea - assignedArea;
  const payload = useMemo(() => buildVrcPayload(takeoffProject), [takeoffProject]);
  const selectedRoom = floor.rooms.find((room) => room.id === selectedRoomId) ?? null;
  const roomRenameShortcutEnabled = workflowStep === "trace" &&
    !roomDrawMode &&
    !roomPolygonMode &&
    !adjacentDrawMode &&
    !subtractMode &&
    !openingModeActive &&
    !(traceTool === "exterior" && !floor.perimeterLocked);
  const projectInfoComplete = projectName.trim().length > 0 && location.trim().length > 0;
  const hasReference = Boolean(floor.reference);
  const hasHorizontalScale = floor.calibration.lines.some((line) => line.orientation === "horizontal" && scaleLineHasKnownDimension(line));
  const hasVerticalScale = floor.calibration.lines.some((line) => line.orientation === "vertical" && scaleLineHasKnownDimension(line));
  const scaleApplied = Boolean(
    floor.calibration.confirmed ||
    (floor.reference && floor.calibration.appliedFactor && Math.abs(floor.calibration.appliedFactor - 1) > 0.00001)
  );
  const scaleLinesVisible = floor.calibration.linesVisible ?? true;
  const scaleReady = hasHorizontalScale && hasVerticalScale && !scaleApplied;
  const activeRoomValidationTarget = activeValidationTarget && selectedRoom && activeValidationTarget.roomId === selectedRoom.id
    ? activeValidationTarget
    : null;
  const validationSectionClass = (section: ValidationSection) => (
    activeRoomValidationTarget?.section === section
      ? `takeoff-validation-section takeoff-validation-section--${activeRoomValidationTarget.severity}`
      : ""
  );
  const validationTargetId = (section: ValidationSection) => selectedRoom ? validationSectionElementId(selectedRoom.id, section) : undefined;
  const setLeftSectionOpen = (section: LeftSetupSection, open: boolean) => {
    setLeftSectionsOpen((current) => ({ ...current, [section]: open }));
  };
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
  const cropAspect = Math.max(visibleCrop.width, 1) / Math.max(visibleCrop.depth, 1);
  const gridAspect = Math.max(floor.designGrid.width, 1) / Math.max(floor.designGrid.depth, 1);
  const referenceDisplay = cropAspect >= gridAspect
    ? {
        x: 0,
        y: (floor.designGrid.depth - floor.designGrid.width / cropAspect) / 2,
        width: floor.designGrid.width,
        depth: floor.designGrid.width / cropAspect,
      }
    : {
        x: (floor.designGrid.width - floor.designGrid.depth * cropAspect) / 2,
        y: 0,
        width: floor.designGrid.depth * cropAspect,
        depth: floor.designGrid.depth,
      };
  const unassignedCells = useMemo(() => {
    if (floor.exteriorPolygon.length < 3 && (floor.conditionedPerimeter.width <= 0 || floor.conditionedPerimeter.depth <= 0)) return [];
    const cellSize = Math.max(1, floor.scale.feetPerGrid);
    const floorBounds = footprintBounds(floor);
    const cells: UnassignedCell[] = [];
    let available: MultiPolygon = floor.exteriorPolygon.length >= 3
      ? [pointsToClipPolygon(floor.exteriorPolygon)]
      : [pointsToClipPolygon(rectToPoints({ x: 0, y: 0, width: floor.conditionedPerimeter.width, depth: floor.conditionedPerimeter.depth }))];
    const blockers = floor.rooms.map((room) => roomToClipPolygon(room));
    if (blockers.length > 0) {
      available = difference(available, ...blockers);
    }

    for (let y = floorBounds.y; y < floorBounds.y + floorBounds.depth; y += cellSize) {
      for (let x = floorBounds.x; x < floorBounds.x + floorBounds.width; x += cellSize) {
        const cell = {
          x: Number(x.toFixed(3)),
          y: Number(y.toFixed(3)),
          width: Math.min(cellSize, floorBounds.x + floorBounds.width - x),
          depth: Math.min(cellSize, floorBounds.y + floorBounds.depth - y),
        };
        const clipped = intersection([pointsToClipPolygon(rectToPoints(cell))], available);
        for (const polygon of clipped) {
          for (const { polygon: simplePolygon, area } of simplePolygonsFromMultiPolygon([polygon])) {
            if (area <= 0.5) continue;
            const polygonPoints = clipPolygonToPoints(simplePolygon);
            const bounds = polygonBounds(polygonPoints);
            cells.push({
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              depth: bounds.depth,
              polygon: polygonPoints,
              area,
            });
          }
        }
      }
    }

    return cells;
  }, [floor]);
  const unassignedRegions = useMemo(() => buildUnassignedRegions(floor, unassignedCells), [floor, unassignedCells]);
  const selectedUnassignedRegion = unassignedRegions.find((region) => region.id === selectedUnassignedRegionId) ?? unassignedRegions[0] ?? null;
  const activeUnassignedCells = selectedUnassignedRegion?.cells ?? unassignedCells;
  const unassignedCellArea = activeUnassignedCells.reduce((sum, cell) => sum + unassignedCellMeasuredArea(cell), 0);
  const validation = useMemo(() => buildValidation(floor, unassignedRegions), [floor, unassignedRegions]);
  const polygonDraftActive = roomPolygonMode && roomPolygonDraft.length > 0;

  useEffect(() => {
    if (!activeValidationTarget) return;
    const stillPresent = validation.some((issue, index) => validationIssueKey(issue, index) === activeValidationTarget.key);
    if (!stillPresent) setActiveValidationTarget(null);
  }, [activeValidationTarget, validation]);

  useEffect(() => {
    if (!pendingRoomNameSelectId || selectedRoomId !== pendingRoomNameSelectId) return;
    const input = roomNameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    setPendingRoomNameSelectId(null);
  }, [pendingRoomNameSelectId, selectedRoomId]);

  useEffect(() => {
    setLeftSectionsOpen((current) => ({
      ...current,
      project: projectInfoComplete ? false : current.project,
      mode: hasReference ? false : current.mode,
      scale: hasReference && !scaleApplied ? true : false,
      exterior: scaleApplied && floor.exteriorPolygon.length < 3 ? true : current.exterior,
    }));
  }, [floor.exteriorPolygon.length, hasReference, projectInfoComplete, scaleApplied]);

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

  function acceptRoomTypeSuggestion(roomId: string, suggestion: NonNullable<ReturnType<typeof inferredRoomTypeFromName>>) {
    updateRoom(roomId, { roomType: suggestion.type, roomTypeSuggestionDismissedKey: suggestion.key });
  }

  function rejectRoomTypeSuggestion(roomId: string, suggestion: NonNullable<ReturnType<typeof inferredRoomTypeFromName>>) {
    updateRoom(roomId, { roomType: "plain", roomTypeSuggestionDismissedKey: suggestion.key });
  }

  function updateRoomCeilingGeometry(roomId: string, patch: Partial<TakeoffRectRoom>) {
    updateRoom(roomId, { ...patch, ceilingGeometryApproved: false });
  }

  function scrollToWallComponents(roomId: string) {
    window.requestAnimationFrame(() => {
      document.getElementById(`room-wall-components-${roomId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function scrollToValidationSection(roomId: string, section: ValidationSection) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById(validationSectionElementId(roomId, section))?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  function sketchSurfaceForSection(section: ValidationSection): SketchTarget["surface"] | null {
    if (section === "wall-suggestions" || section === "wall-components") return "wall";
    if (section === "glass-components") return "glass";
    if (section === "door-components") return "door";
    if (section === "floor-components") return "floor";
    if (section === "ceiling-components") return "ceiling";
    if (section === "ceiling-geometry") return "ceiling-geometry";
    return null;
  }

  function focusRoomSketchPanel(roomId: string, surface: SketchTarget["surface"], direction?: TakeoffRoomComponent["direction"]) {
    setActiveSketchTarget({ roomId, surface, direction });
    const section = surface === "ceiling-geometry" ? "ceiling-geometry" : componentValidationSection(surface);
    scrollToValidationSection(roomId, section);
  }

  function renderRoomLoadSketch(room: TakeoffRectRoom, mode: "load" | "ceiling" = "load") {
    const points = roomCorners(room);
    if (points.length < 3) return null;
    const viewWidth = mode === "ceiling" ? 380 : 320;
    const viewHeight = mode === "ceiling" ? 250 : 220;
    const sketchPadding = mode === "ceiling" ? 40 : 34;
    const verticalRise = mode === "ceiling" ? 90 : 76;
    const isoXFromDepth = 0.45;
    const isoYFromDepth = 0.22;
    const isoYFromWidth = -0.08;
    const center = {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
    const sketchRotationSteps = ((mode === "ceiling" ? ceilingSketchRotationSteps : roomLoadSketchRotationSteps) % 4 + 4) % 4;
    const setSketchRotationSteps = mode === "ceiling" ? setCeilingSketchRotationSteps : setRoomLoadSketchRotationSteps;
    const rotateLocalPoint = (x: number, y: number) => {
      if (sketchRotationSteps === 1) return { x: -y, y: x };
      if (sketchRotationSteps === 2) return { x: -x, y: -y };
      if (sketchRotationSteps === 3) return { x: y, y: -x };
      return { x, y };
    };
    const unrotateLocalPoint = (x: number, y: number) => {
      if (sketchRotationSteps === 1) return { x: y, y: -x };
      if (sketchRotationSteps === 2) return { x: -x, y: -y };
      if (sketchRotationSteps === 3) return { x: -y, y: x };
      return { x, y };
    };
    const rawProject = (point: TakeoffPoint) => {
      const rotated = rotateLocalPoint(point.x - center.x, point.y - center.y);
      return {
        x: rotated.x + rotated.y * isoXFromDepth,
        y: rotated.y * isoYFromDepth + rotated.x * isoYFromWidth,
      };
    };
    const rawPoints = points.map(rawProject);
    const rawBounds = polygonBounds(rawPoints);
    const usableWidth = Math.max(1, viewWidth - sketchPadding * 2);
    const usableHeight = Math.max(1, viewHeight - sketchPadding * 2 - verticalRise);
    const sketchScale = Math.min(usableWidth / Math.max(rawBounds.width, 1), usableHeight / Math.max(rawBounds.depth, 1));
    const offsetX = (viewWidth - rawBounds.width * sketchScale) / 2 - rawBounds.x * sketchScale;
    const offsetY = (viewHeight - rawBounds.depth * sketchScale) / 2 - rawBounds.y * sketchScale;
    const screenProject = (point: TakeoffPoint, z: number) => {
      const raw = rawProject(point);
      return {
        x: offsetX + raw.x * sketchScale,
        y: offsetY + raw.y * sketchScale - z,
      };
    };
    const floorProject = (point: TakeoffPoint) => {
      return screenProject(point, -verticalRise / 2);
    };
    const ceilingProject = (point: TakeoffPoint) => {
      return screenProject(point, verticalRise / 2);
    };
    const unprojectCeiling = (point: TakeoffPoint) => {
      const raw = {
        x: (point.x - offsetX) / sketchScale,
        y: (point.y + verticalRise / 2 - offsetY) / sketchScale,
      };
      const determinant = isoYFromDepth - isoXFromDepth * isoYFromWidth;
      const localX = (raw.x * isoYFromDepth - isoXFromDepth * raw.y) / determinant;
      const localY = (raw.y - isoYFromWidth * raw.x) / determinant;
      const unrotated = unrotateLocalPoint(localX, localY);
      return { x: unrotated.x + center.x, y: unrotated.y + center.y };
    };
    const roomEdges = pointsToEdges(points);
    const wallComponents = roomSurfaceComponents(room, "wall");
    const glassComponents = roomSurfaceComponents(room, "glass");
    const doorComponents = roomSurfaceComponents(room, "door");
    const floorComponent = roomSurfaceComponents(room, "floor")[0];
    const ceilingComponents = roomSurfaceComponents(room, "ceiling");
    const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
    const bounds = polygonBounds(points);
    const ceilingPanels = ceilingInfo.ceilingType === "vaulted"
      ? splitVaultFootprintAtRidge(points, bounds, ceilingInfo)
      : [points];
    const isActive = (surface: SketchTarget["surface"], direction?: TakeoffRoomComponent["direction"]) => (
      activeSketchTarget?.roomId === room.id &&
      activeSketchTarget.surface === surface &&
      (!direction || !activeSketchTarget.direction || activeSketchTarget.direction === direction)
    );
    const wallByDirection = new Map<TakeoffRoomComponent["direction"], TakeoffRoomComponent>();
    for (const component of wallComponents) {
      if (component.direction && !wallByDirection.has(component.direction)) wallByDirection.set(component.direction, component);
    }
    const detectedAdjacentByDirection = adjacentKindsByDirection(floor, room);
    const directionDistance = (first: TakeoffRoomComponent["direction"], second: TakeoffRoomComponent["direction"]) => {
      if (!first || !second) return Number.POSITIVE_INFINITY;
      const firstIndex = directionOptions.indexOf(first);
      const secondIndex = directionOptions.indexOf(second);
      if (firstIndex < 0 || secondIndex < 0) return Number.POSITIVE_INFINITY;
      const diff = Math.abs(firstIndex - secondIndex);
      return Math.min(diff, directionOptions.length - diff);
    };
    const wallComponentForSketchEdge = (direction: NonNullable<TakeoffRoomComponent["direction"]>) => {
      const exact = wallByDirection.get(direction);
      if (exact) return exact;
      const detectedAdjacent = detectedAdjacentByDirection.get(direction) ?? [];
      const garageCandidate = wallComponents.find((component) =>
        component.adjacency === "garage" &&
        detectedAdjacent.includes("garage") &&
        directionDistance(component.direction, direction) <= 1
      );
      if (garageCandidate) return garageCandidate;
      return wallComponents.find((component) =>
        component.direction &&
        directionDistance(component.direction, direction) <= 1 &&
        directionDistance(component.direction, direction) === Math.min(...wallComponents
          .filter((candidate) => candidate.direction)
          .map((candidate) => directionDistance(candidate.direction, direction)))
      );
    };
    const labelForSurface = (surface: TakeoffRoomComponent["surface"], direction?: TakeoffRoomComponent["direction"]) => {
      if (surface === "floor") return floorComponent ? componentSketchLabel(floorComponent) : "Floor";
      if (surface === "ceiling") return ceilingComponents[0] ? componentSketchLabel(ceilingComponents[0]) : "Ceiling";
      if (surface === "wall") {
        const wall = direction ? wallComponentForSketchEdge(direction) : undefined;
        return wall ? componentSketchLabel(wall) : null;
      }
      return surface === "glass" ? "Glass" : "Door";
    };
    const openingMarker = (component: TakeoffRoomComponent, index: number, total: number) => {
      if (!component.direction) return null;
      const edge = roomEdges.find((candidate) => edgeDirectionFromRoom(candidate, room) === component.direction);
      if (!edge) return null;
      const floorA = floorProject(edge.a);
      const ceilingA = ceilingProject(edge.a);
      const floorB = floorProject(edge.b);
      const ceilingB = ceilingProject(edge.b);
      const a = { x: (floorA.x + ceilingA.x) / 2, y: (floorA.y + ceilingA.y) / 2 };
      const b = { x: (floorB.x + ceilingB.x) / 2, y: (floorB.y + ceilingB.y) / 2 };
      const t = total <= 1 ? 0.5 : (index + 1) / (total + 1);
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.max(Math.hypot(dx, dy), 1);
      const ux = dx / length;
      const uy = dy / length;
      const markerLength = component.surface === "glass" ? 22 : 16;
      const markerStart = { x: x - ux * markerLength / 2, y: y - uy * markerLength / 2 };
      const markerEnd = { x: x + ux * markerLength / 2, y: y + uy * markerLength / 2 };
      const active = isActive(component.surface, component.direction);
      return (
        <g
          key={`${component.surface}-${component.id}`}
          className={`takeoff-room-sketch-opening takeoff-room-sketch-opening--${component.surface} ${active ? "takeoff-room-sketch-opening--active" : ""}`}
          onClick={() => focusRoomSketchPanel(room.id, component.surface, component.direction)}
        >
          <line x1={markerStart.x} y1={markerStart.y} x2={markerEnd.x} y2={markerEnd.y} />
          <text x={x + uy * 7} y={y - ux * 7}>{component.assembly}</text>
        </g>
      );
    };
    const openingsBySurfaceDirection = (surface: "glass" | "door", direction: TakeoffRoomComponent["direction"]) => (
      (surface === "glass" ? glassComponents : doorComponents).filter((component) => component.direction === direction)
    );
    const updateRidgeOffsetFromSketch = (event: React.PointerEvent<SVGLineElement>) => {
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg || ceilingInfo.ceilingType !== "vaulted") return;
      const rect = svg.getBoundingClientRect();
      const viewX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * viewWidth;
      const viewY = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * viewHeight;
      const planPoint = unprojectCeiling({ x: viewX, y: viewY });
      const ratio = ceilingInfo.ridgeDirection === "E-W"
        ? clamp((planPoint.y - bounds.y) / Math.max(bounds.depth, 1), 0, 1)
        : clamp((planPoint.x - bounds.x) / Math.max(bounds.width, 1), 0, 1);
      updateRoomCeilingGeometry(room.id, { ceilingRidgeOffset: Number((ratio * 2 - 1).toFixed(3)) });
    };
    return (
      <div className={`takeoff-room-sketch takeoff-room-sketch--${mode}`}>
        <div className="takeoff-component-head">
          <h3>{mode === "ceiling" ? "Ceiling Geometry Sketch" : "Room Load Sketch"}</h3>
          <div className="takeoff-room-sketch-actions">
            <button
              type="button"
              onClick={() => setSketchRotationSteps((current) => (current + 1) % 4)}
              title="Rotate sketch view 90 degrees"
            >
              Rotate 90
            </button>
            <span className="takeoff-component-total">{Math.round(rectArea(room))} sf</span>
          </div>
        </div>
        <svg viewBox={`0 0 ${viewWidth} ${viewHeight}`} role="img" aria-label={`${room.name} load component sketch`}>
          <polygon
            className={`takeoff-room-sketch-floor ${isActive("floor") ? "takeoff-room-sketch-panel--active" : ""}`}
            points={sketchPointList(points, floorProject)}
            onClick={() => focusRoomSketchPanel(room.id, "floor")}
          />
          {roomEdges.flatMap((edge) => {
            const direction = edgeDirectionFromRoom(edge, room);
            const wallComponent = wallComponentForSketchEdge(direction);
            if (!wallComponent) return [];
            const quad = [floorProject(edge.a), floorProject(edge.b), ceilingProject(edge.b), ceilingProject(edge.a)];
            const midpoint = sketchLabelPoint(quad, (point) => point);
            const active = isActive("wall", direction);
            const label = labelForSurface("wall", direction);
            return [(
              <g
                key={`${direction}-${edge.a.x}-${edge.a.y}`}
                className={`takeoff-room-sketch-wall takeoff-room-sketch-wall--load ${wallComponent.adjacency === "garage" ? "takeoff-room-sketch-wall--garage" : ""} ${active ? "takeoff-room-sketch-panel--active" : ""}`}
                onClick={() => focusRoomSketchPanel(room.id, "wall", direction)}
              >
                <polygon points={quad.map((point) => `${point.x},${point.y}`).join(" ")} />
                {label ? <text x={midpoint.x} y={midpoint.y}>{label}</text> : null}
              </g>
            )];
          })}
          {ceilingPanels.map((panel, index) => {
            const labelPoint = sketchLabelPoint(panel, ceilingProject);
            return (
              <g
                key={`ceiling-panel-${index}`}
                className={`takeoff-room-sketch-ceiling ${mode === "ceiling" ? "takeoff-room-sketch-ceiling--focus" : ""} ${isActive(mode === "ceiling" ? "ceiling-geometry" : "ceiling") ? "takeoff-room-sketch-panel--active" : ""}`}
                onClick={() => focusRoomSketchPanel(room.id, mode === "ceiling" ? "ceiling-geometry" : "ceiling")}
              >
                <polygon points={sketchPointList(panel, ceilingProject)} />
                <text x={labelPoint.x} y={labelPoint.y}>{mode === "ceiling" && ceilingInfo.ceilingType === "vaulted" ? `Vault ${index + 1}` : labelForSurface("ceiling")}</text>
              </g>
            );
          })}
          {roomEdges.flatMap((edge) => {
            const direction = edgeDirectionFromRoom(edge, room);
            const glass = openingsBySurfaceDirection("glass", direction);
            const doors = openingsBySurfaceDirection("door", direction);
            return [
              ...glass.map((component, index) => openingMarker(component, index, glass.length)),
              ...doors.map((component, index) => openingMarker(component, index, doors.length)),
            ];
          })}
          {mode === "ceiling" && ceilingInfo.ceilingType === "vaulted" && (() => {
            const ridge = roomRidgePoints(room, { x: 0, y: 0 }, floor.defaultCeilingHeight ?? 9);
            if (!ridge) return null;
            const ridgeA = ceilingProject({ x: ridge[0].x, y: ridge[0].z });
            const ridgeB = ceilingProject({ x: ridge[1].x, y: ridge[1].z });
            return (
              <line
                className="takeoff-room-sketch-ridge"
                x1={ridgeA.x}
                y1={ridgeA.y}
                x2={ridgeB.x}
                y2={ridgeB.y}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  updateRidgeOffsetFromSketch(event);
                }}
                onPointerMove={(event) => {
                  if (event.buttons !== 1) return;
                  updateRidgeOffsetFromSketch(event);
                }}
              />
            );
          })()}
        </svg>
        <p className="takeoff-muted">
          {mode === "ceiling"
            ? "Ceiling panels are emphasized; room walls, floor, doors, and glass are muted for context."
            : "Muted edges are reference geometry. Colored panels are assigned load components."}
        </p>
      </div>
    );
  }

  function renderRoomTypeSuggestion(room: TakeoffRectRoom) {
    const suggestion = inferredRoomTypeFromName(room.name);
    if (!suggestion) return null;
    if ((room.roomType ?? "plain") === suggestion.type) return null;
    if (room.roomTypeSuggestionDismissedKey === suggestion.key) return null;
    const suggestedLabel = roomTypeOptions.find((option) => option.id === suggestion.type)?.shortLabel ?? roomTypeLabel(suggestion.type);
    return (
      <div className="takeoff-room-type-suggestion">
        <div>
          <strong>Room type suggestion</strong>
          <p>{suggestion.reason} Consider tagging this room as <strong>{suggestedLabel}</strong> for internal gains.</p>
        </div>
        <div className="takeoff-room-type-suggestion-actions">
          <button className="toolbar-primary" onClick={() => acceptRoomTypeSuggestion(room.id, suggestion)}>Use {suggestedLabel}</button>
          <button onClick={() => rejectRoomTypeSuggestion(room.id, suggestion)}>Keep Plain</button>
        </div>
      </div>
    );
  }

  function exportTakeoffJson() {
    downloadJsonFile(`${fileSafeName(projectName)}-takeoff.json`, persistableTakeoff);
  }

  function exportPayloadJson() {
    downloadJsonFile(`${fileSafeName(projectName)}-calculator-payload.json`, payload);
  }

  async function exportDiagnosticReport() {
    try {
      const response = await fetch("/api/export/diagnostics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ?? "Diagnostic report export failed.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : `${fileSafeName(projectName)}-diagnostic-report.json`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setMessage("Exported diagnostic report from the current calculator payload.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not export diagnostic report.");
    }
  }

  function roomWithCeilingType(room: TakeoffRectRoom, ceilingType: NonNullable<TakeoffRectRoom["ceilingType"]>): TakeoffRectRoom {
    if (ceilingType === "none") {
      return {
        ...room,
        ceilingType,
        ceilingGeometryApproved: false,
        ceilingLowHeight: undefined,
        ceilingPeakHeight: undefined,
        ceilingRidgeDirection: undefined,
        ceilingRidgeOffset: undefined,
        components: roomComponents(room).filter((component) => component.surface !== "ceiling"),
      };
    }
    const ceilingComponents = roomSurfaceComponents(room, "ceiling");
    const defaultCeiling = defaultComponent("ceiling", rectArea(room));
    const normalizedCeiling = ceilingComponents.length > 0
      ? ceilingComponents.map((component, index) => {
        if (index !== 0) return component;
        const nextAssembly = ceilingType === "vaulted"
          ? "C2"
          : component.assembly === "C2" ? "C1" : component.assembly || "C1";
        return { ...component, assembly: nextAssembly, area: Number((component.area || rectArea(room)).toFixed(3)) };
      })
      : [{ ...defaultCeiling, assembly: ceilingType === "vaulted" ? "C2" : "C1" }];
    return {
      ...room,
      ceilingType,
      ceilingGeometryApproved: false,
      ceilingLowHeight: ceilingType === "vaulted" ? room.ceilingLowHeight ?? room.ceilingHeight : undefined,
      ceilingPeakHeight: ceilingType === "vaulted" ? room.ceilingPeakHeight ?? Math.max(room.ceilingHeight, room.ceilingHeight + 1) : undefined,
      ceilingRidgeDirection: ceilingType === "vaulted" ? room.ceilingRidgeDirection ?? "E-W" : undefined,
      ceilingRidgeOffset: ceilingType === "vaulted" ? room.ceilingRidgeOffset ?? 0 : undefined,
      components: [
        ...roomComponents(room).filter((component) => component.surface !== "ceiling"),
        ...normalizedCeiling,
      ],
    };
  }

  function staleCeilingPromptForRoom(nextFloor: TakeoffFloor, roomId: string): StaleCeilingWallPrompt {
    const room = nextFloor.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return null;
    const staleComponents = staleGeneratedCeilingWallComponents(nextFloor, room);
    if (staleComponents.length === 0) return null;
    return {
      roomId: room.id,
      roomName: room.name,
      components: staleComponents.map((component) => ({
        id: component.id,
        label: component.label || component.geometryLabel || component.assembly,
        area: component.area || 0,
        source: component.source,
      })),
    };
  }

  function approveRoomCeilingGeometry(
    roomId: string,
    wallAssemblies: Record<string, string> = {},
    wallAdjacencies: Record<string, TakeoffWallAdjacency> = {},
  ) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const ceilingInfo = ceilingGeometryInfo(room, current.defaultCeilingHeight ?? 9);
        const components = roomComponents(room);
        const ceilingSuggestions = ceilingWallSuggestionsForRoom(current, room, current.defaultCeilingHeight ?? 9);
        const suggestionLabels = new Set(ceilingSuggestions.map((suggestion) => suggestion.label));
        const nextWallComponents = ceilingSuggestions.map((suggestion) => {
          const existing = components.find((component) => component.surface === "wall" && component.label === suggestion.label);
          const key = `${room.id}:${suggestion.key}`;
          const adjacency = wallAdjacencies[key] || existing?.adjacency || suggestion.adjacency;
          const assembly = wallAssemblies[key] || existing?.assembly || defaultWallAssemblyForAdjacency(adjacency);
          return {
            ...(existing ?? defaultComponent("wall", suggestion.area)),
            assembly,
            area: Math.round(suggestion.area),
            direction: suggestion.direction,
            label: suggestion.label,
            geometryLabel: suggestion.geometryLabel,
            source: suggestion.source,
            adjacency,
          };
        });
        const baseComponents = components.filter((component) =>
          !(component.surface === "wall" && component.label && suggestionLabels.has(component.label)) &&
          !(ceilingInfo.ceilingType === "vaulted" && component.surface === "ceiling")
        );
        if (ceilingInfo.ceilingType === "vaulted") {
          const ceilingComponents = components.filter((component) => component.surface === "ceiling");
          const nextCeilingArea = Math.max(0, Math.round(ceilingInfo.slopedCeilingArea));
          const defaultCeiling = defaultComponent("ceiling", nextCeilingArea);
          const nextCeilingComponents = ceilingComponents.length > 0
            ? ceilingComponents.map((component, index) => index === 0 ? { ...component, area: nextCeilingArea, assembly: component.assembly || "C2" } : component)
            : [{ ...defaultCeiling, assembly: "C2" }];
          return {
            ...room,
            ceilingGeometryApproved: true,
            components: [
              ...baseComponents,
              ...nextCeilingComponents,
              ...nextWallComponents,
            ],
          };
        }
        return {
          ...room,
          ceilingGeometryApproved: true,
          components: [
            ...baseComponents,
            ...nextWallComponents,
          ],
        };
      }),
    }));
    setMessage("Ceiling geometry reviewed and approved. Suggested raised wall and gable components were added where applicable.");
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
        const component = defaultComponent(surface, remainingArea || roomArea);
        if (componentNeedsDirection(surface)) {
          component.direction = roomExteriorDirections(current, room)[0];
        }
        return {
          ...room,
          components: [...components, component],
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

  function assignModelSurfaceComponent(selection: ModelSurfaceSelection, assembly: string) {
    if (!selection.surface || !selection.area || selection.kind === "window" || selection.kind === "door") {
      setMessage("That 3D surface is selectable, but direct component assignment for it is not wired yet.");
      return;
    }
    const surface = selection.surface;
    const option = componentSchedule.find((component) => component.code === assembly);
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== selection.roomId) return room;
        const components = roomComponents(room);
        const existing = components.find((component) => {
          if (component.surface !== surface) return false;
          if (surface === "wall" && selection.kind === "load-wall") return wallCanHostOpenings(component) && component.direction === selection.direction;
          if (surface === "wall") return component.id === selection.componentId;
          return true;
        });
        const nextComponent: TakeoffRoomComponent = {
          ...(existing ?? defaultComponent(surface, selection.area ?? rectArea(room))),
          assembly,
          area: Number((selection.area ?? existing?.area ?? rectArea(room)).toFixed(3)),
          direction: selection.direction ?? existing?.direction,
          label: selection.label || option?.description || existing?.label,
          source: selection.source ?? existing?.source,
          geometryLabel: selection.geometryLabel ?? existing?.geometryLabel,
        };
        return {
          ...room,
          components: existing
            ? components.map((component) => (component.id === existing.id ? nextComponent : component))
            : [...components, nextComponent],
        };
      }),
    }));
    setMessage(`${selection.label} assigned to ${assembly}${option?.description ? ` - ${option.description}` : ""}.`);
  }

  function setRoomSurfaceFullArea(roomId: string, surface: "floor" | "ceiling") {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const existing = roomSurfaceComponents(room, surface)[0];
        const component = {
          ...(existing ?? defaultComponent(surface, rectArea(room))),
          area: Number(rectArea(room).toFixed(3)),
        };
        return {
          ...room,
          floorType: surface === "floor" ? (component.assembly === "F1" ? "framed" : "slab") : room.floorType,
          ceilingType: surface === "ceiling" ? (component.assembly === "C2" ? "vaulted" : "flat") : room.ceilingType,
          components: [
            ...roomComponents(room).filter((entry) => entry.surface !== surface),
            component,
          ],
        };
      }),
    }));
    setMessage(`${componentSurfaceLabel(surface)} set to full room area.`);
  }

  function setRoomSurfaceNoLoad(roomId: string, surface: "floor" | "ceiling") {
    const nextFloor = surface === "ceiling"
      ? { ...floor, rooms: floor.rooms.map((room) => room.id === roomId ? roomWithCeilingType(room, "none") : room) }
      : null;
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (
        room.id === roomId
          ? {
              ...room,
              floorType: surface === "floor" ? "none" : room.floorType,
              ceilingType: surface === "ceiling" ? "none" : room.ceilingType,
              ceilingGeometryApproved: surface === "ceiling" ? false : room.ceilingGeometryApproved,
              ceilingLowHeight: surface === "ceiling" ? undefined : room.ceilingLowHeight,
              ceilingPeakHeight: surface === "ceiling" ? undefined : room.ceilingPeakHeight,
              ceilingRidgeDirection: surface === "ceiling" ? undefined : room.ceilingRidgeDirection,
              ceilingRidgeOffset: surface === "ceiling" ? undefined : room.ceilingRidgeOffset,
              components: roomComponents(room).filter((entry) => entry.surface !== surface),
            }
          : room
      )),
    }));
    if (nextFloor) {
      const prompt = staleCeilingPromptForRoom(nextFloor, roomId);
      if (prompt) {
        setStaleCeilingWallPrompt(prompt);
        setSelectedRoomId(roomId);
      }
    }
    setMessage(`${componentSurfaceLabel(surface)} load marked as none for this room.`);
  }

  function updateRoomCeilingType(roomId: string, ceilingType: NonNullable<TakeoffRectRoom["ceilingType"]>) {
    const nextFloor = {
      ...floor,
      rooms: floor.rooms.map((room) => room.id === roomId ? roomWithCeilingType(room, ceilingType) : room),
    };
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return roomWithCeilingType(room, ceilingType);
      }),
    }));
    const prompt = staleCeilingPromptForRoom(nextFloor, roomId);
    if (prompt) {
      setStaleCeilingWallPrompt(prompt);
      setSelectedRoomId(roomId);
      setMessage(`${prompt.roomName} has generated ceiling-wall components that no longer match the ${ceilingType} ceiling.`);
    }
  }

  function removePromptedStaleCeilingWalls() {
    const prompt = staleCeilingWallPrompt;
    if (!prompt) return;
    const staleIds = new Set(prompt.components.map((component) => component.id));
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (
        room.id === prompt.roomId
          ? { ...room, components: roomComponents(room).filter((component) => !staleIds.has(component.id)) }
          : room
      )),
    }));
    setStaleCeilingWallPrompt(null);
    setMessage(`${prompt.components.length} generated ceiling-wall component${prompt.components.length === 1 ? "" : "s"} removed from ${prompt.roomName}.`);
  }

  function reviewPromptedStaleCeilingWalls() {
    const prompt = staleCeilingWallPrompt;
    if (!prompt) return;
    setSelectedRoomId(prompt.roomId);
    setRightPanelOpen(true);
    setPlanReviewMode("elevation");
    setRoomTileMetric("wall");
    setStaleCeilingWallPrompt(null);
    scrollToWallComponents(prompt.roomId);
    setMessage(`Review the highlighted generated wall components for ${prompt.roomName}.`);
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
    setSelectedOpening((current) => (current?.roomId === roomId && current.componentId === componentId ? null : current));
  }

  function applySuggestedWallArea(
    roomId: string,
    suggestion: { direction: TakeoffRoomComponent["direction"]; area: number },
    assembly: string,
    adjacency: TakeoffWallAdjacency = "outside",
  ) {
    const label = wallAdjacencyLabel(adjacency);
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const components = roomComponents(room);
        const existing = components.find((component) => component.surface === "wall" && component.direction === suggestion.direction);
        if (existing) {
          return {
            ...room,
            components: components.map((component) => component.id === existing.id
              ? { ...component, assembly, adjacency, area: Math.round(suggestion.area), label: `${suggestion.direction} ${label.toLowerCase()}`, source: "exterior-perimeter" }
              : component),
          };
        }
        return {
          ...room,
          components: [
            ...components,
            {
              id: nextId("component-wall"),
              surface: "wall",
              assembly,
              direction: suggestion.direction,
              area: Math.round(suggestion.area),
              label: `${suggestion.direction} ${label.toLowerCase()}`,
              source: "exterior-perimeter",
              adjacency,
            },
          ],
        };
      }),
    }));
  }

  function startOpeningPlacement(surface: "glass" | "door" = "glass") {
    const option = scheduleOptionsBySurface[surface][0];
    setOpeningModeActive(true);
    setPendingOpeningTarget(null);
    setEditingOpeningTarget(null);
    setOpeningPlacement({
      surface,
      assembly: option?.code ?? (surface === "glass" ? "G1" : "D1"),
      width: surface === "glass" ? 3 : 3,
      height: surface === "glass" ? 5 : 6.67,
      label: surface === "glass" ? "Window" : "Door",
    });
    setWorkflowStep("trace");
    setTraceTool("select");
    setRoomDrawMode(false);
    setRoomPolygonMode(false);
    setAdjacentDrawMode(false);
    setSubtractMode(false);
    setMessage("Openings mode active. Click an exterior wall segment, then confirm the component and size.");
  }

  function stopOpeningPlacement() {
    setOpeningModeActive(false);
    setPendingOpeningTarget(null);
    setEditingOpeningTarget(null);
    setOpeningPlacement(null);
    setMessage("Openings mode stopped.");
  }

  function closeOpeningDialog() {
    setPendingOpeningTarget(null);
    setEditingOpeningTarget(null);
    if (!openingModeActive) setOpeningPlacement(null);
  }

  function updateOpeningPlacement(patch: Partial<NonNullable<OpeningPlacement>>) {
    setOpeningPlacement((current) => {
      if (!current) return current;
      const nextSurface = patch.surface ?? current.surface;
      const surfaceChanged = patch.surface && patch.surface !== current.surface;
      const option = surfaceChanged ? scheduleOptionsBySurface[nextSurface][0] : null;
      const targetAdjacent = pendingOpeningTarget?.adjacentKinds ?? [];
      const solarDirectionProvided = Object.prototype.hasOwnProperty.call(patch, "solarDirection");
      const nextSolarDirection = nextSurface === "glass"
        ? solarDirectionProvided
          ? patch.solarDirection
          : surfaceChanged
            ? targetAdjacent.includes("covered_porch") ? "Shaded" : undefined
            : current.solarDirection
        : undefined;
      const shouldUseAutoLabel = patch.label === undefined && (surfaceChanged || solarDirectionProvided) && isAutoOpeningLabel(current.label);
      return {
        ...current,
        ...patch,
        assembly: patch.assembly ?? option?.code ?? current.assembly,
        width: patch.width ?? (surfaceChanged ? 3 : current.width),
        height: patch.height ?? (surfaceChanged ? (nextSurface === "glass" ? 5 : 6.67) : current.height),
        label: patch.label ?? (shouldUseAutoLabel ? defaultOpeningLabel(nextSurface, nextSolarDirection) : current.label),
        solarDirection: nextSolarDirection,
      };
    });
  }

  function nearestExteriorSegment(point: TakeoffPoint) {
    const threshold = Math.max(1.5, floor.scale.feetPerGrid * 1.5, floor.scale.gridSnapInches / 12);
    const candidates = floor.rooms.flatMap((room) =>
      roomExteriorSegments(floor, room).map((segment) => {
        const closest = closestPointOnSegment(point, segment.a, segment.b);
        return {
          room,
          segment,
          adjacentKinds: adjacentKindsForSegment(floor, segment),
          closest,
          distance: distance(point, closest),
        };
      }),
    );
    return candidates
      .filter((candidate) => candidate.distance <= threshold)
      .sort((a, b) => {
        if (a.room.id === selectedRoomId && b.room.id !== selectedRoomId) return -1;
        if (b.room.id === selectedRoomId && a.room.id !== selectedRoomId) return 1;
        return a.distance - b.distance;
      })[0] ?? null;
  }

  function placeOpeningAt(point: TakeoffPoint) {
    if (!openingPlacement) return false;
    const target = nearestExteriorSegment(point);
    if (!target) {
      setMessage("Click closer to an exterior wall segment for a room. Openings cannot be placed on interior-only walls.");
      return false;
    }
    setPendingOpeningTarget({
      roomId: target.room.id,
      roomName: target.room.name,
      direction: target.segment.direction,
      placement: {
        x: Number(target.closest.x.toFixed(3)),
        y: Number(target.closest.y.toFixed(3)),
      },
      adjacentKinds: target.adjacentKinds,
    });
    if (openingPlacement.surface === "glass") {
      const nextSolarDirection = target.adjacentKinds.includes("covered_porch") ? "Shaded" : undefined;
      setOpeningPlacement((current) => current
        ? {
            ...current,
            solarDirection: nextSolarDirection,
            label: isAutoOpeningLabel(current.label) ? defaultOpeningLabel("glass", nextSolarDirection) : current.label,
          }
        : current);
    }
    setSelectedRoomId(target.room.id);
    setMessage(target.adjacentKinds.includes("covered_porch")
      ? `Detected ${target.room.name} ${target.segment.direction} wall at covered porch. Glass will default to shaded.`
      : `Detected ${target.room.name} ${target.segment.direction} wall. Confirm the opening details.`);
    return true;
  }

  function confirmOpeningPlacement() {
    if (!openingPlacement || !pendingOpeningTarget) return false;
    const area = Number(Math.max(0, openingPlacement.width * openingPlacement.height).toFixed(2));
    if (area <= 0) {
      setMessage("Enter a positive width and height before placing an opening.");
      return false;
    }
    if (openingPlacement.surface === "glass" && pendingOpeningTarget.adjacentKinds.includes("garage")) {
      setMessage("Glass cannot be placed on a garage-adjacent wall. Change the opening to a door or choose a different wall.");
      return false;
    }
    const component: TakeoffRoomComponent = {
      id: nextId(`component-${openingPlacement.surface}`),
      surface: openingPlacement.surface,
      assembly: openingPlacement.assembly,
      area,
      width: openingPlacement.width,
      height: openingPlacement.height,
      direction: pendingOpeningTarget.direction,
      solarDirection: openingPlacement.surface === "glass"
        ? openingPlacement.solarDirection ?? (pendingOpeningTarget.adjacentKinds.includes("covered_porch") ? "Shaded" : undefined)
        : undefined,
      label: openingPlacement.label || (openingPlacement.surface === "glass" ? "Window" : "Door"),
      placement: pendingOpeningTarget.placement,
      source: "opening-placement",
    };
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (
        room.id === pendingOpeningTarget.roomId
          ? { ...room, components: [...roomComponents(room), component] }
          : room
      )),
    }));
    setSelectedRoomId(pendingOpeningTarget.roomId);
    setMessage(`${component.label} placed on ${pendingOpeningTarget.roomName} ${pendingOpeningTarget.direction} wall (${area} sf).`);
    setPendingOpeningTarget(null);
    setSelectedOpening({ roomId: pendingOpeningTarget.roomId, componentId: component.id });
    return true;
  }

  function openOpeningEditor(room: TakeoffRectRoom, component: TakeoffRoomComponent) {
    if (component.surface !== "glass" && component.surface !== "door") return;
    const fallbackHeight = component.surface === "glass" ? 5 : 6.67;
    const width = component.width ?? Number((Math.max(0, component.area || 0) / fallbackHeight).toFixed(2));
    const height = component.height ?? fallbackHeight;
    setOpeningModeActive(false);
    setPendingOpeningTarget(null);
    setEditingOpeningTarget({ roomId: room.id, componentId: component.id });
    setSelectedOpening({ roomId: room.id, componentId: component.id });
    setSelectedRoomId(room.id);
    const adjacentKinds = adjacentKindsForPlacedOpening(floor, room, component);
    setOpeningPlacement({
      surface: component.surface,
      assembly: component.assembly,
      width,
      height,
      solarDirection: component.surface === "glass"
        ? component.solarDirection ?? (adjacentKinds.includes("covered_porch") ? "Shaded" : undefined)
        : undefined,
      label: component.surface === "glass" && isAutoOpeningLabel(component.label)
        ? defaultOpeningLabel("glass", component.solarDirection ?? (adjacentKinds.includes("covered_porch") ? "Shaded" : undefined))
        : component.label || defaultOpeningLabel(component.surface),
    });
  }

  function confirmOpeningEdit() {
    if (!openingPlacement || !editingOpeningTarget) return false;
    const area = Number(Math.max(0, openingPlacement.width * openingPlacement.height).toFixed(2));
    if (area <= 0) {
      setMessage("Enter a positive width and height before updating an opening.");
      return false;
    }
    const editingRoom = floor.rooms.find((room) => room.id === editingOpeningTarget.roomId);
    const editingComponent = editingRoom ? roomComponents(editingRoom).find((component) => component.id === editingOpeningTarget.componentId) : null;
    const adjacentKinds = editingRoom && editingComponent ? adjacentKindsForPlacedOpening(floor, editingRoom, editingComponent) : [];
    if (openingPlacement.surface === "glass" && editingRoom && editingComponent?.placement) {
      if (adjacentKinds.includes("garage")) {
        setMessage("Glass cannot be assigned to a garage-adjacent wall. Keep this opening as a door or move it to a different exterior wall.");
        return false;
      }
    }
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (
        room.id === editingOpeningTarget.roomId
          ? {
              ...room,
              components: roomComponents(room).map((component) => (
                component.id === editingOpeningTarget.componentId
                  ? {
                      ...component,
                      surface: openingPlacement.surface,
                      assembly: openingPlacement.assembly,
                      area,
                      width: openingPlacement.width,
                      height: openingPlacement.height,
                      label: openingPlacement.label || defaultOpeningLabel(openingPlacement.surface, openingPlacement.solarDirection),
                      solarDirection: openingPlacement.surface === "glass"
                        ? openingPlacement.solarDirection ?? (adjacentKinds.includes("covered_porch") ? "Shaded" : undefined)
                        : undefined,
                      source: component.source ?? "opening-placement",
                    }
                  : component
              )),
            }
          : room
      )),
    }));
    setMessage(`${openingPlacement.label || "Opening"} updated (${area} sf).`);
    setEditingOpeningTarget(null);
    setOpeningPlacement(null);
    return true;
  }

  function projectedOpeningPlacement(currentFloor: TakeoffFloor, point: TakeoffPoint, room: TakeoffRectRoom, component: TakeoffRoomComponent) {
    if (!isCompassDirection(component.direction)) return null;
    const candidates = roomExteriorSegments(currentFloor, room)
      .filter((segment) => segment.direction === component.direction)
      .map((segment) => {
        const closest = closestPointOnSegment(point, segment.a, segment.b);
        return { closest, distance: distance(point, closest) };
      })
      .sort((a, b) => a.distance - b.distance);
    const closest = candidates[0]?.closest;
    return closest ? { x: Number(closest.x.toFixed(3)), y: Number(closest.y.toFixed(3)) } : null;
  }

  function moveOpening(target: OpeningMoveTarget | undefined, point: TakeoffPoint) {
    if (!target) return;
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== target.roomId) return room;
        const component = roomComponents(room).find((existing) => existing.id === target.componentId);
        if (!component) return room;
        const placement = projectedOpeningPlacement(current, point, room, component);
        if (!placement) return room;
        const adjacentKinds = adjacentKindsForPlacedOpening(current, room, { ...component, placement });
        const solarDirection = component.surface === "glass"
          ? adjacentKinds.includes("covered_porch") ? "Shaded" : undefined
          : component.solarDirection;
        return {
          ...room,
          components: roomComponents(room).map((existing) => (
            existing.id === target.componentId
              ? {
                  ...existing,
                  placement,
                  solarDirection,
                  label: existing.surface === "glass" && isAutoOpeningLabel(existing.label)
                    ? defaultOpeningLabel("glass", solarDirection)
                    : existing.label,
                }
              : existing
          )),
        };
      }),
    }));
  }

  function removeSelectedOpening() {
    if (!selectedOpening) return;
    const room = floor.rooms.find((candidate) => candidate.id === selectedOpening.roomId);
    const component = room ? roomComponents(room).find((candidate) => candidate.id === selectedOpening.componentId) : null;
    removeRoomComponent(selectedOpening.roomId, selectedOpening.componentId);
    setEditingOpeningTarget(null);
    setOpeningPlacement(null);
    setMessage(component ? `${component.label || "Opening"} removed from ${room?.name || "room"}.` : "Opening removed.");
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

  function constrainPointToAngle(previous: TakeoffPoint | undefined, point: TakeoffPoint) {
    if (!previous) return point;
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0.001) return point;
    const snappedAngle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return {
      x: Number(clamp(previous.x + Math.cos(snappedAngle) * length, 0, floor.designGrid.width).toFixed(3)),
      y: Number(clamp(previous.y + Math.sin(snappedAngle) * length, 0, floor.designGrid.depth).toFixed(3)),
    };
  }

  function prepareCornerPoint(point: TakeoffPoint, previous: TakeoffPoint | undefined, constrainAngle: boolean) {
    const snapped = snapToExistingGeometry(point);
    return constrainAngle ? constrainPointToAngle(previous, snapped) : snapped;
  }

  function snapAdjacentSpacePoint(point: TakeoffPoint) {
    const threshold = 5;
    const exteriorCorners = cornerPoints(exteriorRingPoints(floor));
    let best = { point, distance: threshold };
    for (const corner of exteriorCorners) {
      const cornerDistance = distance(point, corner);
      if (cornerDistance <= best.distance) best = { point: corner, distance: cornerDistance };
    }
    return {
      x: Number(best.point.x.toFixed(3)),
      y: Number(best.point.y.toFixed(3)),
    };
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
      sourceStart: unscalePoint(calibrationStart, floor.calibration.appliedFactor || 1),
      sourceEnd: unscalePoint(end, floor.calibration.appliedFactor || 1),
      knownFeet: Number(measured.toFixed(1)),
    };

    setFloor((current) => ({
      ...current,
      calibration: { ...current.calibration, lines: [...current.calibration.lines, line], linesVisible: true, confirmed: false, areaConfirmed: false },
    }));
    setCalibrationStart(null);
    const nextLines = [...floor.calibration.lines, line];
    const nextHasHorizontal = nextLines.some((entry) => entry.orientation === "horizontal" && scaleLineHasKnownDimension(entry));
    const nextHasVertical = nextLines.some((entry) => entry.orientation === "vertical" && scaleLineHasKnownDimension(entry));
    if (calibrationOrientation === "horizontal" && !nextHasVertical) {
      setCalibrationOrientation("vertical");
      setMessage("Horizontal scale line added. Enter the real dimension, then set a known vertical measurement.");
      return;
    }
    if (nextHasHorizontal && nextHasVertical) {
      setWorkflowStep("trace");
      setTraceTool("select");
      setMessage("Horizontal and vertical scale measurements are set. Review dimensions, then apply scale.");
      return;
    }
    setMessage("Scale line added. Enter the real dimension, then add another line or apply scale.");
  }

  function updateScaleLine(id: string, patch: Partial<Pick<TakeoffScaleLine, "label" | "knownFeet">>) {
    setFloor((current) => ({
      ...current,
      calibration: {
        ...current.calibration,
        confirmed: false,
        linesVisible: true,
        lines: current.calibration.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      },
    }));
  }

  function removeScaleLine(id: string) {
    setFloor((current) => ({
      ...current,
      calibration: { ...current.calibration, lines: current.calibration.lines.filter((line) => line.id !== id), linesVisible: true, confirmed: false },
    }));
  }

  function clearScaleLines() {
    setCalibrationStart(null);
    setFloor((current) => ({ ...current, calibration: { ...current.calibration, lines: [], linesVisible: true, confirmed: false, appliedFactor: 1, areaConfirmed: false } }));
    setMessage("Scale lines cleared.");
  }

  function setScaleLinesVisible(visible: boolean) {
    setFloor((current) => ({ ...current, calibration: { ...current.calibration, linesVisible: visible } }));
  }

  function applyCalibration(hideLinesAfterApply = false) {
    const factor = calibrationFactor(floor.calibration.lines);
    if (!factor) {
      setMessage("Add at least one scale line with a known dimension before applying scale.");
      return;
    }

    setFloor((current) => {
      const previousFactor = current.calibration.appliedFactor || 1;
      const relativeFactor = factor / previousFactor;
      return {
        ...current,
        coordinateSpace: "world_feet",
        designGrid: {
          width: Number((current.designGrid.width * relativeFactor).toFixed(3)),
          depth: Number((current.designGrid.depth * relativeFactor).toFixed(3)),
        },
        conditionedPerimeter: {
          width: Number((current.conditionedPerimeter.width * relativeFactor).toFixed(3)),
          depth: Number((current.conditionedPerimeter.depth * relativeFactor).toFixed(3)),
        },
        exteriorPolygon: current.exteriorPolygon.map((point) => scalePoint(point, relativeFactor)),
        rooms: current.rooms.map((room) => scaleRoom(room, relativeFactor)),
        adjacentSpaces: current.adjacentSpaces?.map((space) => scaleAdjacentSpace(space, relativeFactor)) ?? [],
        reference: current.reference
          ? {
              ...current.reference,
              crop: current.reference.crop ? scaleRect(current.reference.crop, relativeFactor) : current.reference.crop,
            }
          : current.reference,
        attributedSlices: current.attributedSlices?.map((slice) => ({
          ...slice,
          cells: slice.cells.map((cell) => scaleRect(cell, relativeFactor)),
        })),
        calibration: {
          ...current.calibration,
          lines: current.calibration.lines.map((line) => ({
            ...scaleLine(line, relativeFactor),
            sourceStart: line.sourceStart ?? line.start,
            sourceEnd: line.sourceEnd ?? line.end,
          })),
          linesVisible: !hideLinesAfterApply,
          confirmed: true,
          appliedFactor: Number(factor.toFixed(5)),
          areaConfirmed: false,
        },
      };
    });
    setWorkflowStep("trace");
    setTraceTool("exterior");
    setCalibrationStart(null);
    setMessage(`Scale recorded in world feet. Average correction factor: ${factor.toFixed(3)}.${hideLinesAfterApply ? " Scale guide lines hidden." : ""}`);
  }

  function skipCalibration() {
    setFloor((current) => ({ ...current, coordinateSpace: "world_feet", calibration: { ...current.calibration, confirmed: true, linesVisible: false } }));
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

  function availablePolygonsFromRect(rect: PlanRect, ignoredRoomId?: string) {
    if (rect.width < 0.25 || rect.depth < 0.25) return [];
    return availablePolygonsFromPoints(rectToPoints(rect), ignoredRoomId);
  }

  function availablePolygonFromPoints(points: TakeoffPoint[], ignoredRoomId?: string) {
    return availablePolygonsFromPoints(points, ignoredRoomId)[0]?.polygon ?? null;
  }

  function availablePolygonsFromPoints(points: TakeoffPoint[], ignoredRoomId?: string) {
    if (points.length < 3 || polygonArea(points) < 0.25) return [];
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
    return simplePolygonsFromMultiPolygon(available);
  }

  function unassignedPolygonsInsideRect(rect: PlanRect) {
    if (unassignedCells.length === 0) return [];
    const rectPolygon = pointsToClipPolygon(rectToPoints(rect));
    return unassignedCells.flatMap((cell) => {
      const clipped = intersection([pointsToClipPolygon(unassignedCellPoints(cell))], [rectPolygon]);
      return simplePolygonsFromMultiPolygon(clipped);
    });
  }

  function simplifiedRoomPolygon(points: TakeoffPoint[]) {
    return simplifyPolygonPoints(points, {
      duplicateTolerance: 0.02,
      collinearTolerance: Math.max(0.08, floor.scale.gridSnapInches / 36),
      shortSegmentTolerance: 0,
    });
  }

  function makeRoomFromPolygon(points: TakeoffPoint[], simplify = false) {
    const polygon = simplify ? simplifiedRoomPolygon(points) : points;
    const bounds = polygonBounds(polygon);
    const room = {
      id: nextId("room"),
      name: `${draftRoom.name || "Room"} ${floor.rooms.length + 1}`,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      depth: bounds.depth,
      ceilingHeight: draftRoom.ceilingHeight,
      polygon,
    } satisfies TakeoffRectRoom;
    return { ...room, components: defaultRoomComponents(rectArea(room)) };
  }

  function addDraggedRoom(rect: { x: number; y: number; width: number; depth: number }) {
    if (rect.width < 1 || rect.depth < 1) {
      setMessage("Drag a larger area to create a room.");
      return;
    }
    let availablePolygons = availablePolygonsFromRect(rect);
    if (availablePolygons.length === 0) {
      availablePolygons = mergePolygonEntries(unassignedPolygonsInsideRect(rect));
    }
    if (availablePolygons.length === 0) {
      setMessage("No open room area remains after clipping to the exterior and existing rooms.");
      return;
    }
    const rooms = availablePolygons.map(({ polygon }, index) => {
      const room = makeRoomFromPolygon(clipPolygonToPoints(polygon));
      return availablePolygons.length > 1 ? { ...room, name: `${room.name}${String.fromCharCode(65 + index)}` } : room;
    });
    setFloor((current) => ({ ...current, rooms: [...current.rooms, ...rooms] }));
    setSelectedRoomId(rooms[0].id);
    setMessage(rooms.length === 1 ? `${rooms[0].name} added as available polygon area.` : `${rooms.length} available room sections added.`);
  }

  function addDraggedAdjacentSpace(rect: PlanRect) {
    if (rect.width < 1 || rect.depth < 1) {
      setMessage("Drag a larger area to create an adjacent space.");
      return;
    }
    const normalized = normalizeAdjacentSpaceRect(floor, rect);
    if (!normalized) {
      setMessage("Adjacent spaces must extend outside the conditioned footprint. Overlap the wall while drawing, but release past the exterior side.");
      return;
    }
    const label = adjacentSpaceKinds.find((kind) => kind.id === adjacentSpaceKind)?.label ?? "Adjacent";
    const space: TakeoffAdjacentSpace = {
      id: nextId("adjacent"),
      name: `${label} ${(floor.adjacentSpaces?.filter((existing) => existing.kind === adjacentSpaceKind).length ?? 0) + 1}`,
      kind: adjacentSpaceKind,
      ...normalized.rect,
      polygon: normalized.polygon,
    };
    const touchesExterior = floor.rooms.some((room) =>
      roomExteriorSegments(floor, room).some((segment) =>
        adjacentSpaceTouchesSegment(space, segment, Math.max(0.35, floor.scale.feetPerGrid * 0.35))
      )
    );
    setFloor((current) => ({ ...current, adjacentSpaces: [...(current.adjacentSpaces ?? []), space] }));
    setMessage(touchesExterior
      ? `${space.name} added. Shared walls will be tagged in room reconciliation.`
      : `${space.name} added. It does not appear to touch a conditioned exterior wall yet.`);
  }

  function removeAdjacentSpace(id: string) {
    setFloor((current) => ({ ...current, adjacentSpaces: (current.adjacentSpaces ?? []).filter((space) => space.id !== id) }));
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

  function createPolygonRoom(points: TakeoffPoint[], preserveClosingEndpoints = false) {
    const simplifiedInput = simplifyPolygonPoints(points, {
      duplicateTolerance: 0.02,
      collinearTolerance: Math.max(0.08, floor.scale.gridSnapInches / 36),
      shortSegmentTolerance: Math.max(0.18, floor.scale.gridSnapInches / 18),
      preserveIndices: preserveClosingEndpoints ? [0, points.length - 1] : undefined,
    });
    if (simplifiedInput.length < 3) {
      setMessage("Polygon room needs at least 3 points.");
      return false;
    }
    let availablePolygon: Polygon | null = null;
    try {
      availablePolygon = availablePolygonFromPoints(simplifiedInput);
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
    return createPolygonRoom(roomPolygonDraft, true);
  }

  function addPolygonRoomPoint(point: TakeoffPoint, constrainAngle = false) {
    const snapped = prepareCornerPoint(point, roomPolygonDraft[roomPolygonDraft.length - 1], constrainAngle);
    if (roomPolygonDraft.length >= 3 && distance(snapped, roomPolygonDraft[0]) <= Math.max(1, floor.scale.gridSnapInches / 12)) {
      finishPolygonRoom();
      return;
    }
    setRoomPolygonDraft((current) => {
      const next = [...current, snapped];
      if (next.length < 4) return next;
      return simplifyPolygonPoints(next, {
        duplicateTolerance: 0.02,
        collinearTolerance: Math.max(0.08, floor.scale.gridSnapInches / 36),
        shortSegmentTolerance: Math.max(0.18, floor.scale.gridSnapInches / 18),
        preserveIndices: [0, next.length - 1],
      });
    });
    setMessage(roomPolygonDraft.length >= 2 ? "Polygon point added. Click Close or press Enter to finish." : "Polygon point added.");
  }

  function resizeBalancedAreaComponents(room: TakeoffRectRoom, nextArea: number) {
    const currentArea = rectArea(room);
    const components = roomComponents(room);
    let nextComponents = components;
    for (const surface of ["floor", "ceiling"] as const) {
      if (roomSurfaceNoLoad(room, surface)) continue;
      const surfaceComponents = roomSurfaceComponents(room, surface);
      if (surfaceComponents.length === 0) continue;
      const assigned = surfaceComponents.reduce((sum, component) => sum + Math.max(0, component.area || 0), 0);
      if (Math.abs(assigned - currentArea) > 0.5) continue;
      const scaleFactor = assigned > 0 ? nextArea / assigned : 1;
      let runningTotal = 0;
      let seen = 0;
      nextComponents = nextComponents.map((component) => {
        if (component.surface !== surface) return component;
        seen += 1;
        const area = seen === surfaceComponents.length
          ? Math.max(0, Number((nextArea - runningTotal).toFixed(3)))
          : Math.max(0, Number((component.area * scaleFactor).toFixed(3)));
        runningTotal += area;
        return { ...component, area };
      });
    }
    return nextComponents;
  }

  function mergePolygonsIntoRoom(targetRoom: TakeoffRectRoom, polygons: Polygon[]) {
    const merged = union(roomToClipPolygon(targetRoom), ...polygons);
    const mergedPieces = simplePolygonsFromMultiPolygon(merged);
    if (mergedPieces.length !== 1) return null;
    const largest = largestClipPolygon(merged);
    if (!largest) return null;
    const polygon = clipPolygonToPoints(largest);
    const bounds = polygonBounds(polygon);
    const nextArea = polygonArea(polygon);
    return {
      ...targetRoom,
      ...bounds,
      polygon,
      areaAdjustment: undefined,
      components: resizeBalancedAreaComponents(targetRoom, nextArea),
    };
  }

  function assignHighlightedSlices() {
    const candidateRooms = selectedUnassignedRegion?.adjacentRoomIds.length ? selectedUnassignedRegion.adjacentRoomIds : floor.rooms.map((room) => room.id);
    const roomId = sliceRoomId && candidateRooms.includes(sliceRoomId) ? sliceRoomId : candidateRooms[0] || floor.rooms[0]?.id;
    if (!roomId || activeUnassignedCells.length === 0) return;
    const targetRoom = floor.rooms.find((room) => room.id === roomId);
    if (!targetRoom) return;
    const mergedRoom = mergePolygonsIntoRoom(targetRoom, activeUnassignedCells.map((cell) => pointsToClipPolygon(unassignedCellPoints(cell))));
    if (!mergedRoom) {
      setMessage("Could not merge highlighted slices into that room.");
      return;
    }
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === roomId ? mergedRoom : room)),
      attributedSlices: [
        ...(current.attributedSlices ?? []),
        { id: nextId("slice"), roomId, cells: activeUnassignedCells },
      ],
    }));
    setSelectedUnassignedRegionId(null);
    setMessage(`${Math.round(unassignedCellArea)} sf merged into ${targetRoom.name}.`);
  }

  function mergeSelectedRoomIntoTarget() {
    if (!selectedRoom) return;
    const targetId = mergeTargetRoomId || floor.rooms.find((room) => room.id !== selectedRoom.id)?.id || "";
    if (!targetId || targetId === selectedRoom.id) {
      setMessage("Select another room to merge into.");
      return;
    }
    const targetRoom = floor.rooms.find((room) => room.id === targetId);
    if (!targetRoom) return;
    const mergedRoom = mergePolygonsIntoRoom(targetRoom, [roomToClipPolygon(selectedRoom)]);
    if (!mergedRoom) {
      setMessage("Those rooms do not form one connected room yet. Merge only slices that touch the target room.");
      return;
    }
    setFloor((current) => ({
      ...current,
      rooms: current.rooms
        .filter((room) => room.id !== selectedRoom.id)
        .map((room) => (room.id === targetRoom.id ? mergedRoom : room)),
    }));
    setSelectedRoomId(targetRoom.id);
    setMergeTargetRoomId("");
    setMessage(`${selectedRoom.name} merged into ${targetRoom.name}.`);
  }

  function focusValidationIssue(issue: TakeoffValidationIssue, key = validationIssueKey(issue)) {
    const section = validationSectionForIssue(issue);
    setActiveValidationTarget({
      key,
      roomId: issue.target?.roomId,
      severity: issue.severity,
      section,
      message: issue.message,
    });
    if (issue.target?.roomId) {
      const sketchSurface = sketchSurfaceForSection(section);
      if (sketchSurface) setActiveSketchTarget({ roomId: issue.target.roomId, surface: sketchSurface });
    }
    if (!issue.target) return;
    if (issue.target.type === "room" && issue.target.roomId) {
      setSelectedRoomId(issue.target.roomId);
      setRightPanelOpen(true);
      const room = floor.rooms.find((candidate) => candidate.id === issue.target?.roomId);
      setMessage(room ? `${room.name} selected from validation.` : "Room selected from validation.");
      scrollToValidationSection(issue.target.roomId, section);
      return;
    }
    if (issue.target.type === "unassigned") {
      setSelectedRoomId(null);
      setSelectedUnassignedRegionId(issue.target.regionId ?? null);
      setRightPanelOpen(false);
      const region = unassignedRegions.find((candidate) => candidate.id === issue.target?.regionId);
      const adjacentRoomId = region?.adjacentRoomIds[0];
      if (adjacentRoomId) setSliceRoomId(adjacentRoomId);
      else if (!sliceRoomId && floor.rooms[0]) setSliceRoomId(floor.rooms[0].id);
      fitPlan();
      setMessage(`${Math.round(region?.area ?? unassignedCellArea)} sf of unassigned area is highlighted on the plan.`);
    }
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
        return;
      }
    }
    if (workflowStep === "calibrate") {
      event.preventDefault();
      addCalibrationPoint(point);
      suppressNextCanvasClickRef.current = true;
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
    if (workflowStep === "trace" && adjacentDrawMode) {
      const snappedPoint = snapAdjacentSpacePoint(point);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "adjacent", start: snappedPoint, current: snappedPoint });
      return;
    }
    if (workflowStep === "trace" && roomDrawMode) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "room", start: point, current: point });
      return;
    }
    if (workflowStep === "trace" && openingModeActive) {
      event.preventDefault();
      placeOpeningAt(point);
      suppressNextCanvasClickRef.current = true;
      return;
    }
    if (workflowStep === "trace" && roomPolygonMode) {
      event.preventDefault();
      addPolygonRoomPoint(point, event.shiftKey);
      suppressNextCanvasClickRef.current = true;
      return;
    }
    if (traceTool === "exterior" && !floor.perimeterLocked) {
      event.preventDefault();
      addExteriorPoint(prepareCornerPoint(point, floor.exteriorPolygon[floor.exteriorPolygon.length - 1], event.shiftKey));
      suppressNextCanvasClickRef.current = true;
    }
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState) return;
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    if (dragState.kind === "move-point") {
      movePoint(dragState.target, point);
    }
    if (dragState.kind === "move-opening") {
      moveOpening(dragState.openingTarget, point);
    }
    setDragState((current) => (current ? { ...current, current: current.kind === "adjacent" ? snapAdjacentSpacePoint(point) : point } : current));
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
    if (kind === "move-opening") {
      const moved = lineLength({ start: dragState.start, end: dragState.current }) > 0.15;
      openingDragMovedRef.current = moved;
      setMessage(moved ? "Opening moved along its assigned wall." : "Opening selected.");
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
    if (kind === "adjacent") {
      addDraggedAdjacentSpace(rect);
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

  function clampPlanZoom(value: number) {
    return Number(clamp(value, minPlanZoom, maxPlanZoom).toFixed(2));
  }

  function stepPlanZoom(delta: number) {
    setZoom((current) => clampPlanZoom(current + delta));
  }

  function maxZoomPlan() {
    setZoom(maxPlanZoom);
    setMessage("Zoomed to 800%.");
  }

  function planFitBounds() {
    if (floor.exteriorPolygon.length >= 3) return polygonBounds(floor.exteriorPolygon);
    const roomBounds = rectsBounds(floor.rooms.map((room) => polygonBounds(roomCorners(room))));
    if (roomBounds) return roomBounds;
    if (floor.reference) return referenceDisplay;
    if (floor.conditionedPerimeter.width > 0 && floor.conditionedPerimeter.depth > 0) return footprintBounds(floor);
    return { x: 0, y: 0, width: floor.designGrid.width, depth: floor.designGrid.depth };
  }

  function planViewportSize() {
    const scroll = canvasScrollRef.current;
    return {
      width: Math.max(canvasWidth, scroll?.clientWidth ?? canvasWidth),
      height: Math.max(canvasHeight, scroll?.clientHeight ?? canvasHeight, Math.round(window.innerHeight * 0.62)),
    };
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
    const targetBounds = planFitBounds();
    const planWidth = Math.max(targetBounds.width, 1);
    const planDepth = Math.max(targetBounds.depth, 1);
    const viewport = planViewportSize();
    const fitZoom = Math.min((viewport.width - 56) / (planWidth * baseScale), (viewport.height - 56) / (planDepth * baseScale));
    const nextZoom = clampPlanZoom(fitZoom);
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!canvasScrollRef.current) return;
        const targetCenterX = offsetX + (targetBounds.x + targetBounds.width / 2) * baseScale * nextZoom;
        const targetCenterY = offsetY + (targetBounds.y + targetBounds.depth / 2) * baseScale * nextZoom;
        canvasScrollRef.current.scrollLeft = Math.max(0, targetCenterX - canvasScrollRef.current.clientWidth / 2);
        canvasScrollRef.current.scrollTop = Math.max(0, targetCenterY - canvasScrollRef.current.clientHeight / 2);
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
    if (dragState) return;
    if (workflowStep === "calibrate") return;
    if (workflowStep === "trace" && (openingModeActive || roomPolygonMode || (traceTool === "exterior" && !floor.perimeterLocked))) return;
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

  async function runCalculate() {
    let resolvedLocation = location.trim();
    if (!resolvedLocation) {
      if (window.confirm("No location set. Use Atlanta, GA?")) {
        resolvedLocation = "Atlanta, GA";
        setLocation(resolvedLocation);
      } else {
        setMessage("Enter a location before calculating.");
        return;
      }
    }
    const blockingIssueIndex = validation.findIndex((issue) => issue.severity === "error");
    const blockingIssue = blockingIssueIndex >= 0 ? validation[blockingIssueIndex] : null;
    if (blockingIssue) {
      setMessage(blockingIssue.message);
      focusValidationIssue(blockingIssue, validationIssueKey(blockingIssue, blockingIssueIndex));
      return;
    }
    setCalcLoading(true);
    setMessage("");
    try {
      const basePayload = buildVrcPayload({ ...takeoffProject, location: resolvedLocation });
      const frontIndex = COMPASS_ORDER.indexOf(takeoffProject.frontDoorFaces as (typeof COMPASS_ORDER)[number]);
      let best: OrientationLoadResult | null = null;
      const orientations: OrientationLoadResult[] = [];
      // Worst-case orientation: rotate every surface direction through all 8 facings, keep the max.
      for (let steps = 0; steps < COMPASS_ORDER.length; steps += 1) {
        const rotated = JSON.parse(JSON.stringify(basePayload));
        for (const item of rotated.project.levels[0].line_items) {
          if (item.direction) item.direction = rotateCompass(item.direction, steps);
        }
        const response = await fetch("/api/calculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rotated),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail ?? "Calculation failed.");
        const cooling = data.whole_house_sensible_cooling ?? 0;
        const heating = data.whole_house_heating ?? 0;
        const orientationResult = {
          facing: COMPASS_ORDER[(frontIndex + steps + COMPASS_ORDER.length) % COMPASS_ORDER.length] ?? "?",
          cooling,
          heating,
          tons: data.units?.[0]?.recommended_tons ?? data.system_tons ?? 0,
        };
        orientations.push(orientationResult);
        if (!best || cooling > best.cooling || (cooling === best.cooling && heating > best.heating)) {
          best = orientationResult;
        }
      }
      setCalcResult(best ? { ...best, orientations, baseFacing: takeoffProject.frontDoorFaces } : null);
      setMessage("Calculated worst-case orientation.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Calculation failed.");
    } finally {
      setCalcLoading(false);
    }
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
      setLocation(loadedProject.location ?? "");
      setMechanicalVentilation(Boolean(loadedProject.mechanicalVentilation));
      setVentilationCfm(Number(loadedProject.ventilationCfm ?? 0));
      setFrontDoorFaces(loadedProject.frontDoorFaces);
      setComponentSchedule(loadedProject.componentSchedule?.length ? loadedProject.componentSchedule : defaultComponentSchedule);
      setFloor(loadedProject.floors[0]);
      setTakeoffId(id);
      setSavedSnapshot(takeoffSnapshot(persistableTakeoffProject(loadedProject)));
      setOpenDialog(false);
      setCalibrationStart(null);
      setRoomPolygonDraft([]);
      setAdjacentDrawMode(false);
      setOpeningModeActive(false);
      setOpeningPlacement(null);
      setPendingOpeningTarget(null);
      setEditingOpeningTarget(null);
      setSelectedOpening(null);
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
        coordinateSpace: "world_feet",
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
        calibration: { lines: [], linesVisible: true, confirmed: false, appliedFactor: 1, areaConfirmed: false },
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
    setAdjacentDrawMode(false);
    setCalibrationStart(null);
    setOpeningModeActive(false);
    setOpeningPlacement(null);
    setPendingOpeningTarget(null);
    setEditingOpeningTarget(null);
    setSelectedOpening(null);
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

  useEffect(() => {
    if (unassignedRegions.length === 0) {
      if (selectedUnassignedRegionId) setSelectedUnassignedRegionId(null);
      return;
    }
    if (!selectedUnassignedRegionId || !unassignedRegions.some((region) => region.id === selectedUnassignedRegionId)) {
      setSelectedUnassignedRegionId(unassignedRegions[0].id);
    }
  }, [selectedUnassignedRegionId, unassignedRegions]);

  function roomTileMetricSummary(room: TakeoffRectRoom) {
    if (roomTileMetric === "wall") {
      const netWallArea = roomWallReconciliation(floor, room).reduce((sum, entry) => sum + entry.netArea, 0);
      return { value: Math.round(netWallArea), label: "net wall sf" };
    }
    if (roomTileMetric === "glass") {
      return { value: Math.round(componentAreaTotal(room, "glass")), label: "glass sf" };
    }
    return {
      value: Math.round(componentAreaTotal(room, roomTileMetric)),
      label: `${roomTileMetric} sf`,
    };
  }

  const modeGuidance = (() => {
    if (!projectName.trim()) {
      return {
        tone: "warning" as const,
        title: "Please name your project",
        body: "Start with a recognizable plan name so saved takeoffs and exports are easy to identify.",
      };
    }
    if (!location.trim()) {
      return {
        tone: "warning" as const,
        title: "Select a location",
        body: "Location is required before calculation. Most Atlanta-area plans can start with Atlanta, GA.",
        actionLabel: "Use Atlanta, GA",
        action: () => setLocation("Atlanta, GA"),
      };
    }
    if (!floor.reference) {
      return {
        tone: "info" as const,
        title: "Ready to upload a PDF",
        body: "Upload one floor-plan page. After upload, the tool will enter crop mode so you can focus on the plan and measurement markers.",
        actionLabel: "Upload PDF",
        action: () => document.getElementById("takeoff-reference-input")?.click(),
      };
    }
    if (workflowStep === "crop") {
      return {
        tone: "active" as const,
        title: "Crop mode enabled",
        body: "Select the area of the plan you want to focus on. Include the measurement markers you plan to use for scaling, and leave a little space around the floor plan.",
      };
    }
    if (scaleReady) {
      return {
        tone: "success" as const,
        title: "Horizontal and vertical scale measurements are set",
        body: "Review the known dimensions, then apply scale to convert the reference into world feet. The guide lines will be hidden but retained.",
        actionLabel: "Apply scale and hide lines",
        action: () => applyCalibration(true),
      };
    }
    if (workflowStep === "calibrate") {
      const label = calibrationOrientation === "horizontal" ? "Horizontal line mode enabled" : calibrationOrientation === "vertical" ? "Vertical line mode enabled" : "Known dimension mode enabled";
      const body = calibrationStart
        ? "First point is set. Move to the second endpoint of the known measurement and click to finish the scale line."
        : calibrationOrientation === "horizontal"
          ? "Click the first endpoint of a known horizontal measurement, then click the second endpoint. The tool will move you to vertical next."
          : calibrationOrientation === "vertical"
            ? "Click the first endpoint of a known vertical measurement, then click the second endpoint. Once horizontal and vertical are set, you can apply scale."
            : "Click the two endpoints of any known measurement, then enter the real dimension in the scale list.";
      return {
        tone: "active" as const,
        title: label,
        body,
      };
    }
    if (!scaleApplied && floor.reference) {
      return {
        tone: "info" as const,
        title: "Set import scale",
        body: "Add one horizontal and one vertical known measurement for the most reliable PDF scale before tracing rooms.",
        actionLabel: "Start horizontal line",
        action: () => {
          setWorkflowStep("calibrate");
          setCalibrationOrientation("horizontal");
        },
      };
    }
    return {
      tone: "neutral" as const,
      title: "Trace mode enabled",
      body: "Draw or edit the exterior, rooms, adjacent spaces, and openings. Validation will guide you to any missing wall or opening assignments.",
    };
  })();

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
          <button className="toolbar-primary" onClick={runCalculate} disabled={calcLoading}>
            {calcLoading ? "Calculating..." : "Calculate"}
          </button>
          <span className={`takeoff-save-status ${isDirty ? "takeoff-save-status--dirty" : ""}`}>
            {isDirty ? "Unsaved" : "Saved"}
          </span>
          <a className="button" href="#">Calculator</a>
          <a className="button" href="/#/projects">Projects</a>
        </div>
      </header>

      {calcResult && (
        <div className="takeoff-calc-result">
          <div>
            <strong>Worst-case cooling load</strong> (house faces {calcResult.facing}):
            {" "}Cooling <strong>{calcResult.cooling.toLocaleString()}</strong> BTU/hr ·
            {" "}Heating <strong>{calcResult.heating.toLocaleString()}</strong> BTU/hr ·
            {" "}<strong>{calcResult.tons}</strong> tons
          </div>
          <details>
            <summary>Orientation sweep from current payload facing {calcResult.baseFacing}</summary>
            <div className="takeoff-orientation-sweep">
              {calcResult.orientations.map((entry) => (
                <span key={entry.facing} className={entry.facing === calcResult.facing ? "takeoff-orientation-sweep-best" : ""}>
                  {entry.facing}: {entry.cooling.toLocaleString()} cool / {entry.heating.toLocaleString()} heat
                </span>
              ))}
            </div>
          </details>
        </div>
      )}

      <section className={`takeoff-layout ${!leftPanelOpen ? "takeoff-layout--left-collapsed" : ""} ${!rightPanelOpen ? "takeoff-layout--right-collapsed" : ""}`}>
        <aside className={`takeoff-sidebar ${!leftPanelOpen ? "takeoff-sidebar--collapsed" : ""}`}>
          {!leftPanelOpen ? (
            <button className="takeoff-rail-toggle" onClick={() => setLeftPanelOpen(true)} aria-label="Show setup panel">Setup</button>
          ) : (
          <>
          <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.project} onToggle={(event) => setLeftSectionOpen("project", event.currentTarget.open)}>
            <summary>
              Project
              <button
                className="takeoff-icon-button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setLeftPanelOpen(false);
                }}
                aria-label="Hide setup panel"
              >
                Hide
              </button>
            </summary>
            <label>
              Name
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} />
            </label>
            <label>
              Location <span className="required-star">*</span>
              <input value={location} placeholder="City, ST (e.g. Atlanta, GA)" onChange={(event) => setLocation(event.target.value)} />
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
            <label>
              Default ceiling height ft
              <input
                type="number"
                min="0"
                step="0.5"
                value={floor.defaultCeilingHeight ?? 9}
                onChange={(event) => setFloor((current) => ({
                  ...current,
                  defaultCeilingHeight: Number(event.target.value),
                  rooms: current.rooms.map((room) => ({ ...room, ceilingGeometryApproved: false })),
                }))}
              />
            </label>
            <label>
              Floor elevation ft
              <input
                type="number"
                step="0.5"
                value={floor.elevation ?? 0}
                onChange={(event) => updateFloor({ elevation: Number(event.target.value), coordinateSpace: "world_feet" })}
              />
            </label>
            <label>
              Floor-to-floor height ft
              <input
                type="number"
                min="0"
                step="0.5"
                value={floor.floorToFloorHeight ?? 10}
                onChange={(event) => updateFloor({ floorToFloorHeight: Number(event.target.value), coordinateSpace: "world_feet" })}
              />
            </label>
            <label className="check-field">Mechanical ventilation
              <input
                type="checkbox"
                checked={mechanicalVentilation}
                onChange={(event) => {
                  const on = event.target.checked;
                  setMechanicalVentilation(on);
                }}
              />
            </label>
            {mechanicalVentilation && (
              <>
                <label>
                  Ventilation CFM
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={ventilationCfm || suggestedVentilationCfm}
                    onChange={(event) => setVentilationCfm(Number(event.target.value))}
                  />
                </label>
                <p className="takeoff-muted">
                  Bedroom tags: {taggedBedroomCount} · suggested {suggestedVentilationCfm} CFM.
                </p>
              </>
            )}
          </details>

          <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.mode} onToggle={(event) => setLeftSectionOpen("mode", event.currentTarget.open)}>
            <summary>Mode</summary>
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
              <input id="takeoff-reference-input" type="file" accept=".pdf,image/*" onChange={(event) => handleReference(event.target.files?.[0])} />
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
          </details>

          {floor.reference && (
            <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.scale} onToggle={(event) => setLeftSectionOpen("scale", event.currentTarget.open)}>
              <summary>Import Scale</summary>
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
              {floor.calibration.lines.length > 0 && !scaleLinesVisible && (
                <p className="takeoff-muted">{floor.calibration.lines.length} scale guide line{floor.calibration.lines.length === 1 ? "" : "s"} hidden but retained.</p>
              )}
              {scaleLinesVisible && (
                <div className="takeoff-scale-list">
                  {floor.calibration.lines.map((line) => {
                    const measured = lineLength(scaleLineSourcePoints(line));
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
                        <span>{measured.toFixed(1)} source ft · {factor ? factor.toFixed(3) : "-"}x</span>
                        <button onClick={() => removeScaleLine(line.id)}>Remove</button>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="takeoff-muted">
                {pendingScaleFactor
                  ? `Average scale correction: ${pendingScaleFactor.toFixed(3)}x`
                  : scaleApplied
                    ? `Scale applied${floor.calibration.appliedFactor ? ` at ${floor.calibration.appliedFactor}x` : ""}.`
                    : "Add at least one known dimension."}
              </p>
              <div className="takeoff-form-actions">
                <button className="toolbar-primary" onClick={() => applyCalibration()}>Apply Scale</button>
                {scaleReady && <button onClick={() => applyCalibration(true)}>Apply + Hide Lines</button>}
                {floor.calibration.lines.length > 0 && (
                  <button onClick={() => setScaleLinesVisible(!scaleLinesVisible)}>{scaleLinesVisible ? "Hide Lines" : "Show Lines"}</button>
                )}
                <button onClick={skipCalibration}>Skip</button>
                <button onClick={clearScaleLines}>Clear Lines</button>
                <button onClick={clearCrop}>Reset Crop</button>
              </div>
            </details>
          )}

          <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.exterior} onToggle={(event) => setLeftSectionOpen("exterior", event.currentTarget.open)}>
            <summary>Exterior Trace</summary>
            <div className="takeoff-form-actions">
              <button className={traceTool === "exterior" ? "toolbar-primary" : ""} onClick={() => setTraceTool("exterior")}>Trace</button>
              <button onClick={togglePerimeterLock}>{floor.perimeterLocked ? "Unlock" : "Lock"}</button>
              <button onClick={clearExteriorTrace}>Clear</button>
            </div>
            <p className="takeoff-muted">
              {floor.exteriorPolygon.length} points · {floor.perimeterLocked ? "locked" : "editable"} · {Math.round(computedFootprintArea)} sf
            </p>
            {traceTool === "exterior" && !floor.perimeterLocked && (
              <p className="takeoff-note">Click the grid corners around the conditioned exterior. Hold Shift before clicking to constrain the next line to 45/90 degrees. Lock it when the outline is closed.</p>
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
          </details>

          <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.grid} onToggle={(event) => setLeftSectionOpen("grid", event.currentTarget.open)}>
            <summary>Advanced Grid &amp; Footprint</summary>
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
            <div className="takeoff-advanced-subsection">
              <h3>Fallback Footprint</h3>
              <label>
                Width ft
                <input type="number" min="0" value={floor.conditionedPerimeter.width} onChange={(event) => updatePerimeter("width", Number(event.target.value))} />
              </label>
              <label>
                Depth ft
                <input type="number" min="0" value={floor.conditionedPerimeter.depth} onChange={(event) => updatePerimeter("depth", Number(event.target.value))} />
              </label>
              <button onClick={seedRectangularExterior}>Copy to Trace</button>
            </div>
            <p className="takeoff-muted">Advanced controls for the drafting canvas, snapping, and fallback footprint before an exterior trace exists.</p>
          </details>
          </>
          )}
        </aside>

        <section className="takeoff-stage-panel">
          <div className="takeoff-stage-head">
            <div>
              <h2>{workflowStep === "crop" ? "Crop Plan Reference" : workflowStep === "calibrate" ? "Import Scale Setup" : "Plan Grid"}</h2>
              <p>
                {Math.round(computedFootprintArea)} sf conditioned footprint · {floor.designGrid.width} x {floor.designGrid.depth} ft design grid
                {scaleApplied ? ` · scale ${floor.calibration.appliedFactor}x` : ""}
              </p>
            </div>
            <div className="takeoff-stage-actions">
              <div className="takeoff-stats">
                <span><b>{floor.rooms.length}</b> rooms</span>
                <span><b>{Math.round(assignedArea)}</b> assigned</span>
                <span><b>{Math.max(0, Math.round(unassignedArea))}</b> open</span>
              </div>
              <div className="takeoff-stage-tools" aria-label="Plan zoom controls">
                <div className="takeoff-stage-tool-group">
                  <button data-tooltip="Fit the full drawable grid workspace." aria-label="Fit the full drawable grid workspace" onClick={fitGrid}>Fit Grid</button>
                  <button data-tooltip="Fit the traced exterior plan, or the plan reference before tracing." aria-label="Fit the traced exterior plan or plan reference" onClick={fitPlan}>Fit Plan</button>
                  <button data-tooltip="Jump directly to 800% zoom." aria-label="Jump directly to 800 percent zoom" onClick={maxZoomPlan}>Max Zoom</button>
                </div>
                <div className="takeoff-zoom-group" aria-label="Zoom level">
                  <button data-tooltip="Zoom out one step." aria-label="Zoom out one step" onClick={() => stepPlanZoom(-planZoomStep)}>-</button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button data-tooltip="Zoom in one step." aria-label="Zoom in one step" onClick={() => stepPlanZoom(planZoomStep)}>+</button>
                </div>
                <div className="takeoff-review-mode-group" aria-label="Plan review mode">
                  {planReviewModes.map((mode) => (
                    <button
                      key={mode.id}
                      className={planReviewMode === mode.id ? "toolbar-primary" : ""}
                      data-tooltip={mode.tooltip}
                      aria-label={mode.tooltip}
                      onClick={() => setPlanReviewMode(mode.id)}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className={`takeoff-mode-guidance takeoff-mode-guidance--${modeGuidance.tone}`}>
            <div>
              <strong>{modeGuidance.title}</strong>
              <span>{modeGuidance.body}</span>
            </div>
            {modeGuidance.action && modeGuidance.actionLabel && (
              <button onClick={modeGuidance.action}>{modeGuidance.actionLabel}</button>
            )}
          </div>

          <div className="takeoff-canvas-scroll" ref={canvasScrollRef}>
            {planReviewMode === "elevation" ? (
              <TakeoffModelPreview
                floor={floor}
                referenceUrl={referenceUrl}
                componentSchedule={componentSchedule}
                selectedRoomId={selectedRoomId}
                onSelectRoom={setSelectedRoomId}
                onAssignSurfaceComponent={assignModelSurfaceComponent}
              />
            ) : (
            <div className="takeoff-drawing-layer" style={{ width: drawingWidth, height: drawingHeight }}>
              {referenceUrl && floor.reference && (
                <div
                  className="takeoff-reference-layer"
                  style={{
                    left: offsetX + referenceDisplay.x * scale,
                    top: offsetY + referenceDisplay.y * scale,
                    width: referenceDisplay.width * scale,
                    height: referenceDisplay.depth * scale,
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
              style={{ cursor: workflowStep === "crop" || workflowStep === "calibrate" || roomDrawMode || adjacentDrawMode || openingModeActive || (traceTool === "exterior" && !floor.perimeterLocked) ? "crosshair" : "default" }}
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
              {!polygonDraftActive && floor.exteriorPolygon.map((point, index) => (
                <g key={`${point.x}-${point.y}-${index}`}>
                  <circle cx={offsetX + point.x * scale} cy={offsetY + point.y * scale} r="4" fill="#1f6fb2" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + point.x * scale + 6} y={offsetY + point.y * scale - 6} fontSize="10" fill="#1f2933">{index + 1}</text>
                </g>
              ))}
              {unassignedRegions.flatMap((region) => region.cells.map((cell, index) => {
                const isSelected = !selectedUnassignedRegionId || selectedUnassignedRegionId === region.id;
                const points = unassignedCellPoints(cell).map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ");
                return (
                  <polygon
                    key={`${region.id}-${index}-${cell.x}-${cell.y}`}
                    points={points}
                    fill={isSelected ? "rgba(244, 187, 68, 0.34)" : "rgba(244, 187, 68, 0.12)"}
                    stroke={isSelected ? "rgba(154, 106, 18, 0.55)" : "rgba(154, 106, 18, 0.18)"}
                    strokeWidth={isSelected ? "0.8" : "0.4"}
                  />
                );
              }))}
              {activeDragRect && (
                <rect
                  x={offsetX + activeDragRect.x * scale}
                  y={offsetY + activeDragRect.y * scale}
                  width={activeDragRect.width * scale}
                  height={activeDragRect.depth * scale}
                  fill={dragState?.kind === "crop" || dragState?.kind === "subtract" ? "rgba(179, 67, 47, 0.12)" : dragState?.kind === "adjacent" ? "rgba(130, 97, 47, 0.16)" : "rgba(72, 128, 93, 0.16)"}
                  stroke={dragState?.kind === "crop" || dragState?.kind === "subtract" ? "#b3432f" : dragState?.kind === "adjacent" ? "#8a6532" : "#2f7a4f"}
                  strokeDasharray="6 4"
                  strokeWidth="2"
                />
              )}
              {scaleLinesVisible && floor.calibration.lines.map((line, index) => (
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
                    {scaleLineDisplayLabel(floor.calibration.lines, line, index)}
                  </text>
                </g>
              ))}
              {calibrationStart && (
                <g>
                  <circle cx={offsetX + calibrationStart.x * scale} cy={offsetY + calibrationStart.y * scale} r="5" fill="#b3432f" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + calibrationStart.x * scale + 7} y={offsetY + calibrationStart.y * scale - 7} fontSize="11" fill="#7f2d20">start</text>
                </g>
              )}
              {(floor.adjacentSpaces ?? []).map((space) => {
                const color = adjacentSpaceColor(space.kind);
                const points = adjacentSpaceCorners(space);
                const center = {
                  x: points.reduce((sum, point) => sum + point.x, 0) / Math.max(points.length, 1),
                  y: points.reduce((sum, point) => sum + point.y, 0) / Math.max(points.length, 1),
                };
                return (
                  <g key={space.id} pointerEvents="none">
                    <polygon
                      points={points.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                      fill={color.fill}
                      stroke={color.stroke}
                      strokeDasharray="7 4"
                      strokeWidth="2"
                    />
                    <text
                      x={offsetX + center.x * scale}
                      y={offsetY + center.y * scale}
                      fontSize="11"
                      fill={color.stroke}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {space.name}
                    </text>
                  </g>
                );
              })}
              {floor.rooms.map((room, index) => {
                const points = roomCorners(room);
                const center = roomCenter(room);
                const bounds = polygonBounds(points);
                const color = roomColor(index);
                const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
                const reviewActive = planReviewMode !== "plan";
                const ridgeRunsEastWest = ceilingInfo.ridgeDirection === "E-W";
                const ridgeRatio = ceilingInfo.ridgeRatio;
                const ridgeA = ridgeRunsEastWest
                  ? { x: bounds.x, y: bounds.y + bounds.depth * ridgeRatio }
                  : { x: bounds.x + bounds.width * ridgeRatio, y: bounds.y };
                const ridgeB = ridgeRunsEastWest
                  ? { x: bounds.x + bounds.width, y: bounds.y + bounds.depth * ridgeRatio }
                  : { x: bounds.x + bounds.width * ridgeRatio, y: bounds.y + bounds.depth };
                const planPoints = points.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ");
                return (
                <g
                  key={room.id}
                  pointerEvents={polygonDraftActive ? "none" : undefined}
                  onClick={(event) => {
                    if (openingModeActive) return;
                    event.stopPropagation();
                    setSelectedRoomId(room.id);
                  }}
                  onDoubleClick={(event) => {
                    if (!roomRenameShortcutEnabled) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingRoomId(null);
                    setSelectedRoomId(room.id);
                    setPendingRoomNameSelectId(room.id);
                  }}
                  style={{ cursor: openingModeActive ? "crosshair" : "pointer" }}
                >
                  <polygon
                    points={planPoints}
                    fill={color}
                    fillOpacity={reviewActive ? "0.5" : "0.75"}
                    stroke={selectedRoomId === room.id ? "#0f5fa8" : "#324457"}
                    strokeWidth={selectedRoomId === room.id ? "3" : "1.5"}
                  />
                  {planReviewMode === "ceiling" && (
                    <g pointerEvents="none">
                      {ceilingInfo.ceilingType === "vaulted" ? (
                        <>
                          <line
                            x1={offsetX + ridgeA.x * scale}
                            y1={offsetY + ridgeA.y * scale}
                            x2={offsetX + ridgeB.x * scale}
                            y2={offsetY + ridgeB.y * scale}
                            stroke="#b35b2f"
                            strokeWidth="3"
                            strokeLinecap="round"
                          />
                          <text
                            x={offsetX + center.x * scale}
                            y={offsetY + center.y * scale - 18}
                            fontSize="10"
                            fill="#7f3f20"
                            fontWeight="700"
                            textAnchor="middle"
                          >
                            Vault {ceilingInfo.ridgeDirection} {ceilingInfo.lowHeight}/{ceilingInfo.peakHeight} ft
                          </text>
                        </>
                      ) : (
                        <text
                          x={offsetX + center.x * scale}
                          y={offsetY + center.y * scale - 18}
                          fontSize="10"
                          fill="#31516b"
                          fontWeight="700"
                          textAnchor="middle"
                        >
                          {ceilingInfo.ceilingType === "none" ? "No ceiling load" : `${room.ceilingHeight} ft flat`}
                        </text>
                      )}
                    </g>
                  )}
                  {planReviewMode === "floor" && (
                    <text
                      x={offsetX + center.x * scale}
                      y={offsetY + center.y * scale - 18}
                      fontSize="10"
                      fill="#31516b"
                      fontWeight="700"
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      Floor {Math.round(componentAreaTotal(room, "floor"))} sf
                    </text>
                  )}
                  {planReviewMode === "walls" && roomExteriorSegments(floor, room).map((segment, segmentIndex) => (
                    <line
                      key={`${room.id}-wall-review-${segmentIndex}`}
                      x1={offsetX + segment.a.x * scale}
                      y1={offsetY + segment.a.y * scale}
                      x2={offsetX + segment.b.x * scale}
                      y2={offsetY + segment.b.y * scale}
                      stroke="#b35b2f"
                      strokeWidth="4"
                      strokeLinecap="round"
                      pointerEvents="none"
                    />
                  ))}
                  {!polygonDraftActive && room.polygon?.map((point, pointIndex) => (
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
                        if (openingModeActive) return;
                        event.stopPropagation();
                        setEditingRoomId(room.id);
                      }}
                      onDoubleClick={(event) => {
                        if (!roomRenameShortcutEnabled) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setEditingRoomId(null);
                        setSelectedRoomId(room.id);
                        setPendingRoomNameSelectId(room.id);
                      }}
                      style={{ cursor: "text", fontWeight: 700 }}
                    >
                      {room.name}
                    </text>
                  )}
                  <text x={offsetX + roomCenter(room).x * scale} y={offsetY + roomCenter(room).y * scale + 16} fontSize="11" fill="#465667" textAnchor="middle">
                    {Math.round(rectArea(room))} sf
                  </text>
                  {roomSurfaceComponents(room, "glass").concat(roomSurfaceComponents(room, "door")).filter((component) => component.placement).map((component) => {
                    const isSelectedOpening = selectedOpening?.roomId === room.id && selectedOpening.componentId === component.id;
                    return (
                    <g
                      key={`${room.id}-${component.id}-marker`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (openingDragMovedRef.current) {
                          openingDragMovedRef.current = false;
                          return;
                        }
                        if (openingModeActive) return;
                        openOpeningEditor(room, component);
                      }}
                      onPointerDown={(event) => {
                        if (openingModeActive) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const placement = component.placement;
                        if (!placement) return;
                        const target = { roomId: room.id, componentId: component.id };
                        setSelectedOpening(target);
                        setDragState({ kind: "move-opening", start: placement, current: placement, openingTarget: target });
                      }}
                      style={{ cursor: openingModeActive ? "crosshair" : "grab" }}
                    >
                      <rect
                        x={offsetX + (component.placement?.x ?? 0) * scale - 8}
                        y={offsetY + (component.placement?.y ?? 0) * scale - 8}
                        width="16"
                        height="16"
                        rx="3"
                        fill={component.surface === "glass" ? "#ffffff" : "#2b4c6f"}
                        stroke={isSelectedOpening ? "#b3432f" : component.surface === "glass" ? "#1f6fb2" : "#ffffff"}
                        strokeWidth={isSelectedOpening ? "2.5" : "1.8"}
                      />
                      <text
                        x={offsetX + (component.placement?.x ?? 0) * scale}
                        y={offsetY + (component.placement?.y ?? 0) * scale + 4}
                        fontSize="10"
                        fill={component.surface === "glass" ? "#1f6fb2" : "#ffffff"}
                        fontWeight="700"
                        textAnchor="middle"
                      >
                        {component.surface === "glass" ? "G" : "D"}
                      </text>
                    </g>
                    );
                  })}
                </g>
                );
              })}
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
            )}
          </div>

          <div className="takeoff-lower-grid takeoff-room-workspace">
            <section className="takeoff-panel takeoff-room-summary-panel">
              <div className="takeoff-panel-head">
                <h2>Rooms</h2>
                <div className="takeoff-room-metric-toggle" aria-label="Room summary metric">
                  {roomTileMetrics.map((metric) => (
                    <button
                      key={metric.id}
                      className={roomTileMetric === metric.id ? "toolbar-primary" : ""}
                      onClick={() => setRoomTileMetric(metric.id)}
                    >
                      {metric.label}
                    </button>
                  ))}
                </div>
              </div>
              {floor.rooms.length === 0 ? (
                <p className="takeoff-muted">Draw or add rooms to build the room profile list.</p>
              ) : (
                <div className="takeoff-room-tile-list">
                  {floor.rooms.map((room) => {
                    const metric = roomTileMetricSummary(room);
                    return (
                      <button
                        key={room.id}
                        className={`takeoff-room-tile ${selectedRoomId === room.id ? "takeoff-room-tile--selected" : ""}`}
                        onClick={() => setSelectedRoomId(room.id)}
                      >
                        <strong>{room.name}</strong>
                        <span>{metric.value} {metric.label}</span>
                        {room.roomType && room.roomType !== "plain" && (
                          <em>{roomTypeLabel(room.roomType)}</em>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="takeoff-panel takeoff-room-profile-panel">
              <div className="takeoff-panel-head">
                <h2>Room Profile</h2>
                {selectedRoom && <button onClick={() => removeRoom(selectedRoom.id)}>Remove Room</button>}
              </div>
              {selectedRoom ? (
                <>
                  {activeRoomValidationTarget && (
                    <div className={`takeoff-active-validation takeoff-active-validation--${activeRoomValidationTarget.severity}`}>
                      <div>
                        <strong>{activeRoomValidationTarget.severity === "error" ? "Fix required" : "Review suggestion"}</strong>
                        <span>{validationSectionLabel(activeRoomValidationTarget.section)}</span>
                      </div>
                      <p>{activeRoomValidationTarget.message}</p>
                      <div className="takeoff-active-validation-actions">
                        <button onClick={() => scrollToValidationSection(selectedRoom.id, activeRoomValidationTarget.section)}>Jump to section</button>
                        <button onClick={() => setActiveValidationTarget(null)}>Dismiss</button>
                      </div>
                    </div>
                  )}
                  {floor.rooms.length > 1 && (
                    <div id={validationTargetId("merge")} className={`takeoff-room-merge-tools ${validationSectionClass("merge")}`}>
                      <span>Merge selected room into</span>
                      <select
                        value={mergeTargetRoomId && mergeTargetRoomId !== selectedRoom.id ? mergeTargetRoomId : floor.rooms.find((room) => room.id !== selectedRoom.id)?.id ?? ""}
                        onChange={(event) => setMergeTargetRoomId(event.target.value)}
                      >
                        {floor.rooms.filter((room) => room.id !== selectedRoom.id).map((room) => (
                          <option key={room.id} value={room.id}>{room.name}</option>
                        ))}
                      </select>
                      <button onClick={mergeSelectedRoomIntoTarget}>Merge</button>
                    </div>
                  )}
                  {(() => {
                    const suggestions = roomExteriorWallSuggestions(floor, selectedRoom);
                    const reconciliation = roomWallReconciliation(floor, selectedRoom);
                    const totals = reconciliation.reduce(
                      (sum, entry) => ({
                        grossArea: sum.grossArea + entry.grossArea,
                        glassArea: sum.glassArea + entry.glassArea,
                        doorArea: sum.doorArea + entry.doorArea,
                        netArea: sum.netArea + entry.netArea,
                      }),
                      { grossArea: 0, glassArea: 0, doorArea: 0, netArea: 0 },
                    );
                    const suggestionRows = suggestions.map((suggestion) => {
                      const adjacentKinds = adjacentKindsByDirection(floor, selectedRoom).get(suggestion.direction) ?? [];
                      const recommendation = recommendedWallTreatment(adjacentKinds, suggestedWallAssembly);
                      const approved = roomSurfaceComponents(selectedRoom, "wall").some((component) =>
                        component.direction === suggestion.direction &&
                        component.adjacency === recommendation.adjacency &&
                        component.assembly === recommendation.assembly &&
                        Math.abs(component.area - Math.round(suggestion.area)) <= 0.5
                      );
                      return { suggestion, adjacentKinds, recommendation, approved };
                    });
                    const allSuggestionsApproved = suggestionRows.length > 0 && suggestionRows.every((row) => row.approved);
                    const suggestionHighlightClass = validationSectionClass("wall-suggestions");
                    const shouldRenderSuggestionBlock = suggestionRows.length > 0 || Boolean(suggestionHighlightClass);
                    return (
                      <>
                        {shouldRenderSuggestionBlock && (
                          <div id={validationTargetId("wall-suggestions")} className={`takeoff-wall-suggestions ${allSuggestionsApproved ? "takeoff-wall-suggestions--resolved" : ""} ${suggestionHighlightClass}`}>
                            <div className="takeoff-component-head">
                              <h3>Suggested Exterior Walls</h3>
                              {allSuggestionsApproved && !suggestionHighlightClass ? (
                                <span className="takeoff-component-total">Applied</span>
                              ) : (
                                <select value={suggestedWallAssembly} onChange={(event) => setSuggestedWallAssembly(event.target.value)}>
                                  {scheduleOptionsBySurface.wall.map((option) => (
                                    <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                  ))}
                                </select>
                              )}
                            </div>
                            {allSuggestionsApproved && !suggestionHighlightClass ? (
                              <p className="takeoff-muted">
                                {suggestionRows.length} suggested wall area{suggestionRows.length === 1 ? "" : "s"} applied. Flagged wall components remain below for review.
                              </p>
                            ) : suggestionRows.map(({ suggestion, adjacentKinds, recommendation, approved }) => (
                                <div key={suggestion.direction} className="takeoff-wall-suggestion-row">
                                  <span>
                                    Suggested wall area: <strong>{Math.round(suggestion.area)} sf</strong> {suggestion.direction} {recommendation.label.toLowerCase()}
                                    <small>
                                      {Number(suggestion.length.toFixed(1))} lf x {selectedRoom.ceilingHeight} ft
                                      {adjacentKinds.length > 0 ? ` · adjacent ${adjacentKinds.map(adjacentSpaceLabel).join(", ")} · ${recommendation.assembly}` : ""}
                                    </small>
                                  </span>
                                  <button className={approved ? "toolbar-primary" : ""} onClick={() => applySuggestedWallArea(selectedRoom.id, suggestion, recommendation.assembly, recommendation.adjacency)}>
                                    {approved ? "Approved" : "Apply"}
                                  </button>
                                </div>
                            ))}
                            {(!allSuggestionsApproved || suggestionHighlightClass) && (
                              <p className="takeoff-muted">You can apply a suggested gross wall area, then edit it manually in Wall Components below.</p>
                            )}
                          </div>
                          )}

                        <div className="takeoff-wall-reconciliation">
                          <div className="takeoff-component-head">
                            <h3>Wall / Opening Reconciliation</h3>
                            {reconciliation.length > 0 && (
                              <span className="takeoff-component-total">
                                Net {Math.round(totals.netArea)} sf
                              </span>
                            )}
                          </div>
                          {reconciliation.length ? (
                            <>
                              <div className="takeoff-wall-reconciliation-total">
                                <span>Gross <strong>{Math.round(totals.grossArea)} sf</strong></span>
                                <span>Glass <strong>{Math.round(totals.glassArea)} sf</strong></span>
                                <span>Doors <strong>{Math.round(totals.doorArea)} sf</strong></span>
                                <span>Net wall <strong>{Math.round(totals.netArea)} sf</strong></span>
                              </div>
                              {reconciliation.map((entry) => (
                                <div key={entry.direction} className={`takeoff-wall-reconciliation-row ${entry.isOverOpened ? "takeoff-wall-reconciliation-row--error" : ""}`}>
                                  <div>
                                    <strong>{entry.direction} wall</strong>
                                    <small>
                                      {entry.isAssigned ? "Assigned gross" : "Suggested gross"} {Math.round(entry.grossArea)} sf
                                      {!entry.isAssigned && entry.suggestedGross > 0 ? " · apply wall component before export" : ""}
                                      {entry.adjacentKinds.length > 0 ? ` · adjacent ${entry.adjacentKinds.map(adjacentSpaceLabel).join(", ")}` : ""}
                                    </small>
                                  </div>
                                  <span>{Math.round(entry.grossArea)} sf gross</span>
                                  <span>- {Math.round(entry.glassArea)} sf glass</span>
                                  <span>- {Math.round(entry.doorArea)} sf door</span>
                                  <strong>= {Math.round(entry.netArea)} sf net</strong>
                                </div>
                              ))}
                            </>
                          ) : (
                            <p className="takeoff-muted">Apply exterior wall areas or place openings to populate this room's reconciliation.</p>
                          )}
                        </div>
                      </>
                    );
                  })()}
                  <div className="takeoff-room-profile-grid">
                    <label>
                      Name
                      <input value={selectedRoom.name} onChange={(event) => updateRoom(selectedRoom.id, { name: event.target.value })} />
                    </label>
                    <label>
                      Room type
                      <select
                        value={selectedRoom.roomType ?? "plain"}
                        onChange={(event) => updateRoom(selectedRoom.id, { roomType: event.target.value as TakeoffRoomType })}
                      >
                        {roomTypeOptions.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Ceiling height ft
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        value={selectedRoom.ceilingHeight}
                        onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingHeight: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  {renderRoomTypeSuggestion(selectedRoom)}
                  <div id={validationTargetId("ceiling-geometry")} className={`takeoff-ceiling-shape ${validationSectionClass("ceiling-geometry")}`}>
                    <label>
                      Ceiling shape
                      <select
                        value={selectedRoom.ceilingType ?? "flat"}
                        onChange={(event) => updateRoomCeilingType(selectedRoom.id, event.target.value as NonNullable<TakeoffRectRoom["ceilingType"]>)}
                      >
                        <option value="flat">Flat / taller flat</option>
                        <option value="vaulted">Vaulted</option>
                        <option value="none">No ceiling load</option>
                      </select>
                    </label>
                    {(selectedRoom.ceilingType ?? "flat") === "vaulted" && (
                      <div className="takeoff-ceiling-shape-grid">
                        <label>
                          Low height ft
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={selectedRoom.ceilingLowHeight ?? selectedRoom.ceilingHeight}
                            onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingLowHeight: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Peak height ft
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={selectedRoom.ceilingPeakHeight ?? Math.max(selectedRoom.ceilingHeight, selectedRoom.ceilingHeight + 1)}
                            onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingPeakHeight: Number(event.target.value) })}
                          />
                        </label>
                        <label>
                          Ridge direction
                          <select
                            value={selectedRoom.ceilingRidgeDirection ?? "E-W"}
                            onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingRidgeDirection: event.target.value as NonNullable<TakeoffRectRoom["ceilingRidgeDirection"]> })}
                          >
                            <option value="E-W">East - West</option>
                            <option value="N-S">North - South</option>
                          </select>
                        </label>
                      </div>
                    )}
                    <p className="takeoff-muted">
                      Ceiling shape is stored with the editable takeoff JSON; vaulted geometry refinement and sketching will build on these values.
                    </p>
                  </div>
                  {(() => {
                    const ceilingInfo = ceilingGeometryInfo(selectedRoom, floor.defaultCeilingHeight ?? 9);
                    const roomBounds = polygonBounds(roomCorners(selectedRoom));
                    const ceilingSuggestions = ceilingWallSuggestionsForRoom(floor, selectedRoom, floor.defaultCeilingHeight ?? 9);
                    const hasCeilingSuggestions = ceilingSuggestions.length > 0;
                    return (
                      <div className={`takeoff-ceiling-qa ${ceilingInfo.needsReview ? "takeoff-ceiling-qa--warning" : ""} ${validationSectionClass("ceiling-geometry")}`}>
                        <div className="takeoff-component-head">
                          <h3>Ceiling Geometry QA</h3>
                          <button className={selectedRoom.ceilingGeometryApproved ? "toolbar-primary" : ""} onClick={() => approveRoomCeilingGeometry(selectedRoom.id, ceilingWallAssemblies, ceilingWallAdjacencies)}>
                            {selectedRoom.ceilingGeometryApproved ? "Approved" : "Approve"}
                          </button>
                        </div>
                        <div className="takeoff-ceiling-qa-grid">
                          {renderRoomLoadSketch(selectedRoom, "ceiling")}
                          <div className="takeoff-ceiling-qa-copy">
                            <span>Floor default <strong>{floor.defaultCeilingHeight ?? 9} ft</strong></span>
                            <span>Room <strong>{Math.round(roomBounds.width)} x {Math.round(roomBounds.depth)} ft</strong></span>
                            <span>Low / peak <strong>{ceilingInfo.lowHeight} / {ceilingInfo.peakHeight} ft</strong></span>
                            <span>Ridge offset <strong>{Math.round(ceilingInfo.ridgeOffset * 100)}%</strong></span>
                            <span>Ceiling surface <strong>{Math.round(ceilingInfo.slopedCeilingArea)} sf</strong></span>
                            <span>Estimated added exposure <strong>{Math.round(ceilingInfo.estimatedAddedWallArea)} sf</strong></span>
                          </div>
                        </div>
                        {ceilingInfo.needsReview ? (
                          <p className="takeoff-note">
                            This ceiling height change may create about {Math.round(ceilingInfo.estimatedAddedWallArea)} sf of raised wall or knee-wall exposure if attic space is above. Review ridge direction, assign the wall sections, then approve the geometry.
                          </p>
                        ) : (
                          <p className="takeoff-muted">Use this sketch to confirm ridge direction and relative ceiling heights before export.</p>
                        )}
                        {hasCeilingSuggestions && (
                          <div className="takeoff-ceiling-wall-suggestions">
                            <div className="takeoff-component-head">
                              <h4>Generated Wall Sections</h4>
                              <span>{ceilingSuggestions.filter((suggestion) => ceilingWallSuggestionApplied(selectedRoom, suggestion)).length} / {ceilingSuggestions.length} added</span>
                            </div>
                            {ceilingSuggestions.map((suggestion) => {
                              const key = `${selectedRoom.id}:${suggestion.key}`;
                              const applied = ceilingWallSuggestionApplied(selectedRoom, suggestion);
                              const selectedAdjacency = ceilingWallAdjacencies[key] || suggestion.adjacency;
                              const selectedAssembly = ceilingWallAssemblies[key] || defaultWallAssemblyForAdjacency(selectedAdjacency);
                              return (
                                <button
                                  key={suggestion.key}
                                  className={`takeoff-ceiling-wall-suggestion ${applied ? "takeoff-ceiling-wall-suggestion--applied" : ""}`}
                                  type="button"
                                  onClick={() => {
                                    if (!applied) return;
                                    setMessage(`${suggestion.label} has been added. Review it in Wall Components below.`);
                                    scrollToWallComponents(selectedRoom.id);
                                  }}
                                >
                                  <span>
                                    <strong>{suggestion.description}</strong>
                                    <small>
                                      {Math.round(suggestion.area)} sf
                                      {suggestion.length && suggestion.addedHeight ? ` · ${Number(suggestion.length.toFixed(1))} lf x ${Number(suggestion.addedHeight.toFixed(1))} ft` : ""}
                                      {suggestion.basis === "gable-end" ? " · vault gable" : " · raised wall band"} · {suggestion.direction}-side · {selectedAdjacency}
                                    </small>
                                  </span>
                                  <select
                                    value={selectedAdjacency}
                                    disabled={applied}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => {
                                      const adjacency = event.target.value as TakeoffWallAdjacency;
                                      setCeilingWallAdjacencies((current) => ({ ...current, [key]: adjacency }));
                                      setCeilingWallAssemblies((current) => current[key] ? current : { ...current, [key]: defaultWallAssemblyForAdjacency(adjacency) });
                                    }}
                                  >
                                    <option value="outside">Exterior</option>
                                    <option value="attic">Attic / knee wall</option>
                                    <option value="garage">Garage adjacent</option>
                                    <option value="crawlspace">Crawlspace adjacent</option>
                                    <option value="conditioned">Conditioned / adiabatic</option>
                                    <option value="unknown">Unknown</option>
                                  </select>
                                  <select
                                    value={selectedAssembly}
                                    disabled={applied}
                                    onClick={(event) => event.stopPropagation()}
                                    onChange={(event) => setCeilingWallAssemblies((current) => ({ ...current, [key]: event.target.value }))}
                                  >
                                    {scheduleOptionsBySurface.wall.map((option) => (
                                      <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                    ))}
                                  </select>
                                  <em>{applied ? "Added" : "Pending"}</em>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {(["floor", "ceiling", "wall", "glass", "door"] as const).map((surface) => {
                    const roomArea = rectArea(selectedRoom);
                    const assigned = componentAreaTotal(selectedRoom, surface);
                    const delta = roomArea - assigned;
                    const isAreaChecked = surface === "floor" || surface === "ceiling";
                    const areaSurface = isAreaChecked ? surface as "floor" | "ceiling" : null;
                    const areaCheck = areaSurface ? roomAreaReconciliation(selectedRoom, areaSurface) : null;
                    const options = scheduleOptionsBySurface[surface];
                    const exteriorDirections = roomExteriorDirections(floor, selectedRoom);
                    const staleCeilingWallIds = new Set(staleGeneratedCeilingWallComponents(floor, selectedRoom).map((component) => component.id));
                    return (
                      <div
                        key={surface}
                        id={validationTargetId(componentValidationSection(surface)) ?? (surface === "wall" ? `room-wall-components-${selectedRoom.id}` : undefined)}
                        className={`takeoff-component-editor ${validationSectionClass(componentValidationSection(surface))}`}
                      >
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
                            {Math.round(assigned)} sf total · {surface === "wall" ? "wall area is gross; same-direction windows/doors subtract in payload." : "enter area manually until click-to-place openings is enabled."}
                          </p>
                        )}
                        {areaCheck && (
                          <div className={`takeoff-area-reconciliation ${areaCheck.isOver ? "takeoff-area-reconciliation--error" : ""}`}>
                            <div className="takeoff-area-reconciliation-grid">
                              <span>Measured <strong>{Math.round(areaCheck.roomArea)} sf</strong></span>
                              <span>Assigned <strong>{Math.round(areaCheck.assignedArea)} sf</strong></span>
                              <span>Open <strong>{Math.round(areaCheck.openArea)} sf</strong></span>
                              <span>Over <strong>{Math.round(areaCheck.overArea)} sf</strong></span>
                            </div>
                            <p>
                              {areaCheck.noLoad
                                ? `No ${componentSurfaceLabel(surface).toLowerCase()} load marked for this room.`
                                : areaCheck.isBalanced
                                  ? `${componentSurfaceLabel(surface)} area is balanced.`
                                  : areaCheck.isOver
                                    ? `${componentSurfaceLabel(surface)} area is over-assigned by ${Math.round(areaCheck.overArea)} sf.`
                                    : `${componentSurfaceLabel(surface)} area has ${Math.round(areaCheck.openArea)} sf unassigned.`}
                            </p>
                            <div className="takeoff-quick-actions">
                              <button onClick={() => areaSurface && setRoomSurfaceFullArea(selectedRoom.id, areaSurface)}>Set = room area</button>
                              <button onClick={() => areaSurface && setRoomSurfaceNoLoad(selectedRoom.id, areaSurface)}>No {componentSurfaceLabel(surface)} load</button>
                            </div>
                          </div>
                        )}
                        {roomSurfaceComponents(selectedRoom, surface).length === 0 ? (
                          <p className="takeoff-muted">No {componentSurfaceLabel(surface).toLowerCase()} load components.</p>
                        ) : (
                          <div className="takeoff-component-list">
                            {roomSurfaceComponents(selectedRoom, surface).map((component) => {
                              const selectedDefinition = options.find((option) => option.code === component.assembly);
                              const directionChoices = Array.from(new Set([
                                ...exteriorDirections,
                                ...(isCompassDirection(component.direction) ? [component.direction] : []),
                              ]));
                              const isStaleCeilingWall = staleCeilingWallIds.has(component.id);
                              const sourceLabel = componentSourceLabel(component.source);
                              const isActiveComponentRow = activeSketchTarget?.roomId === selectedRoom.id &&
                                activeSketchTarget.surface === component.surface &&
                                (!activeSketchTarget.direction || !component.direction || activeSketchTarget.direction === component.direction);
                              return (
                                <div key={component.id} className={`takeoff-component-row ${componentNeedsDirection(surface) ? "takeoff-component-row--directional" : ""} ${isStaleCeilingWall ? "takeoff-component-row--stale" : ""} ${isActiveComponentRow ? "takeoff-component-row--active" : ""}`}>
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
                                      {directionChoices.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
                                    </select>
                                  )}
                                  {surface === "wall" && (
                                    <select
                                      aria-label="wall adjacent space"
                                      value={component.adjacency ?? "outside"}
                                      onChange={(event) => {
                                        const adjacency = event.target.value as TakeoffWallAdjacency;
                                        updateRoomComponent(selectedRoom.id, component.id, {
                                          adjacency,
                                          assembly: adjacency === "outside" ? component.assembly : defaultWallAssemblyForAdjacency(adjacency),
                                          label: component.label && !/exterior wall/i.test(component.label) ? component.label : wallAdjacencyLabel(adjacency),
                                        });
                                      }}
                                    >
                                      <option value="outside">Exterior</option>
                                      <option value="garage">Garage</option>
                                      <option value="attic">Attic</option>
                                      <option value="crawlspace">Crawlspace</option>
                                      <option value="conditioned">Conditioned</option>
                                      <option value="unknown">Unknown</option>
                                    </select>
                                  )}
                                  {surface === "glass" && (
                                    <select
                                      aria-label="glass solar exposure"
                                      value={component.solarDirection ?? ""}
                                      onChange={(event) => {
                                        const solarDirection = event.target.value ? event.target.value as NonNullable<TakeoffRoomComponent["solarDirection"]> : undefined;
                                        updateRoomComponent(selectedRoom.id, component.id, {
                                          solarDirection,
                                          label: isAutoOpeningLabel(component.label) ? defaultOpeningLabel("glass", solarDirection) : component.label,
                                        });
                                      }}
                                    >
                                      <option value="">Wall direction</option>
                                      <option value="Shaded">Shaded</option>
                                      <option value="Skylight">Skylight</option>
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
                                  <p className="takeoff-component-meta">
                                    <strong>{selectedDefinition?.code ?? component.assembly}</strong>
                                    {sourceLabel ? <em>{sourceLabel}</em> : null}
                                    {isStaleCeilingWall ? " · Stale ceiling-generated wall" : ""}
                                    {component.surface === "glass" && component.solarDirection ? ` · Solar ${component.solarDirection}` : ""}
                                    {selectedDefinition?.description ? ` · ${selectedDefinition.description}` : ""}
                                    {" · "}{componentThermalSummary(selectedDefinition)}
                                  </p>
                                </div>
                              );
                            })}
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
          </div>
        </section>

        <aside className={`takeoff-sidebar takeoff-tools-sidebar ${!rightPanelOpen ? "takeoff-sidebar--collapsed" : ""}`}>
          {!rightPanelOpen ? (
            <button className="takeoff-rail-toggle" onClick={() => setRightPanelOpen(true)} aria-label="Show tools panel">Tools</button>
          ) : (
          <>
          <section className="takeoff-panel takeoff-export-panel">
            <div className="takeoff-panel-head">
              <h2>Export</h2>
              <button className="takeoff-icon-button" onClick={() => setRightPanelOpen(false)} aria-label="Hide tools panel">Hide</button>
            </div>
            <div className="takeoff-form-actions">
              <button onClick={exportTakeoffJson}>Takeoff JSON</button>
              <button onClick={exportPayloadJson}>Payload JSON</button>
              <button onClick={exportDiagnosticReport}>Diagnostic Report JSON</button>
            </div>
          </section>

          <details className="takeoff-panel takeoff-right-details">
            <summary>Drawing Tools</summary>
            <div className="takeoff-form-actions">
              <button className={roomDrawMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setRoomDrawMode((current) => !current); setRoomPolygonMode(false); setAdjacentDrawMode(false); setSubtractMode(false); setTraceTool("select"); }}>Draw Rect</button>
              <button className={roomPolygonMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setRoomPolygonMode((current) => !current); setRoomDrawMode(false); setAdjacentDrawMode(false); setSubtractMode(false); setTraceTool("select"); }}>Draw Polygon</button>
              <button className={subtractMode ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("trace"); setSubtractMode((current) => !current); setRoomDrawMode(false); setRoomPolygonMode(false); setAdjacentDrawMode(false); setTraceTool("select"); }}>Subtract</button>
              {roomPolygonDraft.length >= 3 && <button className="toolbar-primary" onClick={() => finishPolygonRoom()}>Finish Polygon</button>}
              {roomPolygonDraft.length > 0 && <button onClick={() => setRoomPolygonDraft([])}>Clear Points</button>}
            </div>
            {roomDrawMode && <p className="takeoff-note">Drag over the plan to create a room rectangle.</p>}
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
            <div className="takeoff-room-form takeoff-room-form--rail">
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
          </details>

          <details className="takeoff-panel takeoff-right-details">
            <summary>Adjacent Spaces</summary>
            <div className="takeoff-form-actions">
              <select value={adjacentSpaceKind} onChange={(event) => setAdjacentSpaceKind(event.target.value as TakeoffAdjacentSpaceKind)}>
                {adjacentSpaceKinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
              </select>
              <button
                className={adjacentDrawMode ? "toolbar-primary" : ""}
                onClick={() => {
                  setWorkflowStep("trace");
                  setAdjacentDrawMode((current) => !current);
                  setRoomDrawMode(false);
                  setRoomPolygonMode(false);
                  setSubtractMode(false);
                  setTraceTool("select");
                }}
              >
                {adjacentDrawMode ? "Stop Drawing" : "Draw Adjacent"}
              </button>
            </div>
            {adjacentDrawMode ? (
              <p className="takeoff-note">Drag a rectangle along the outside of conditioned space. Start or release within 5 ft of an exterior corner to snap; drag beyond that to intentionally wrap around the corner.</p>
            ) : (
              <p className="takeoff-muted">Adjacent spaces tag exterior wall treatment without adding conditioned room area.</p>
            )}
            {(floor.adjacentSpaces ?? []).length > 0 && (
              <div className="takeoff-adjacent-list">
                {(floor.adjacentSpaces ?? []).map((space) => (
                  <div key={space.id} className="takeoff-adjacent-row">
                    <span><strong>{space.name}</strong> · {Math.round(polygonArea(adjacentSpaceCorners(space)))} sf · {adjacentSpaceLabel(space.kind)}</span>
                    <button onClick={() => removeAdjacentSpace(space.id)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </details>

          <details className="takeoff-panel takeoff-right-details">
            <summary>Openings</summary>
            <div className="takeoff-form-actions">
              <button className={openingModeActive ? "toolbar-primary" : ""} onClick={() => (openingModeActive ? stopOpeningPlacement() : startOpeningPlacement())}>
                {openingModeActive ? "Stop Placing" : "Place Opening"}
              </button>
            </div>
            {openingModeActive ? (
              <p className="takeoff-note">
                Click the plan on an exterior wall. The tool will identify the room and wall facing, then ask which door or glass component to place.
              </p>
            ) : (
              <p className="takeoff-muted">Openings are assigned from the plan grid and must land on exterior/load-bearing room edges.</p>
            )}
          </details>

          {selectedRoom && (
            <section className="takeoff-panel">
              {renderRoomLoadSketch(selectedRoom, "load")}
            </section>
          )}

          <section className="takeoff-panel">
            <div className="takeoff-panel-head">
              <h2>Validation</h2>
            </div>
            {validation.length === 0 ? (
              <p className="takeoff-ok">Ready for payload preview.</p>
            ) : (
              <div className="takeoff-issue-list">
                {validation.map((issue, index) => (
                  (() => {
                    const issueKey = validationIssueKey(issue, index);
                    return (
                      <button
                        key={issueKey}
                        className={`takeoff-issue takeoff-issue--${issue.severity} ${issue.target ? "takeoff-issue--clickable" : ""} ${activeValidationTarget?.key === issueKey ? "takeoff-issue--active" : ""}`}
                        onClick={() => focusValidationIssue(issue, issueKey)}
                        disabled={!issue.target}
                      >
                        {issue.message}
                      </button>
                    );
                  })()
                ))}
              </div>
            )}
            {unassignedRegions.length > 0 && (
              <div className="takeoff-slice-tools">
                <p className="takeoff-muted">
                  {selectedUnassignedRegion ? `${selectedUnassignedRegion.label}: ` : ""}
                  {Math.round(unassignedCellArea)} sf highlighted as unassigned slices.
                </p>
                <select
                  value={selectedUnassignedRegion?.id ?? ""}
                  onChange={(event) => {
                    const region = unassignedRegions.find((candidate) => candidate.id === event.target.value) ?? null;
                    setSelectedUnassignedRegionId(region?.id ?? null);
                    if (region?.adjacentRoomIds[0]) setSliceRoomId(region.adjacentRoomIds[0]);
                  }}
                >
                  {unassignedRegions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label} - {Math.round(region.area)} sf
                    </option>
                  ))}
                </select>
                <select
                  value={
                    sliceRoomId && (selectedUnassignedRegion?.adjacentRoomIds.length ? selectedUnassignedRegion.adjacentRoomIds.includes(sliceRoomId) : true)
                      ? sliceRoomId
                      : selectedUnassignedRegion?.adjacentRoomIds[0] || floor.rooms[0]?.id || ""
                  }
                  onChange={(event) => setSliceRoomId(event.target.value)}
                >
                  {(selectedUnassignedRegion?.adjacentRoomIds.length
                    ? floor.rooms.filter((room) => selectedUnassignedRegion.adjacentRoomIds.includes(room.id))
                    : floor.rooms
                  ).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}
                </select>
                <button onClick={assignHighlightedSlices}>Attribute Highlighted Area</button>
              </div>
            )}
          </section>

          <section className="takeoff-panel takeoff-room-sidebar-legacy">
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

          <section className="takeoff-panel takeoff-room-sidebar-legacy">
            <div className="takeoff-panel-head">
              <h2>Room Profile</h2>
            </div>
            {selectedRoom ? (
              <>
                {(() => {
                  const suggestions = roomExteriorWallSuggestions(floor, selectedRoom);
                  const exteriorDirections = suggestions.map((suggestion) => suggestion.direction);
                  const reconciliation = roomWallReconciliation(floor, selectedRoom);
                  const totals = reconciliation.reduce(
                    (sum, entry) => ({
                      grossArea: sum.grossArea + entry.grossArea,
                      glassArea: sum.glassArea + entry.glassArea,
                      doorArea: sum.doorArea + entry.doorArea,
                      netArea: sum.netArea + entry.netArea,
                    }),
                    { grossArea: 0, glassArea: 0, doorArea: 0, netArea: 0 },
                  );
                  const suggestionRows = suggestions.map((suggestion) => {
                    const adjacentKinds = adjacentKindsByDirection(floor, selectedRoom).get(suggestion.direction) ?? [];
                    const recommendation = recommendedWallTreatment(adjacentKinds, suggestedWallAssembly);
                    const approved = roomSurfaceComponents(selectedRoom, "wall").some((component) =>
                      component.direction === suggestion.direction &&
                      component.adjacency === recommendation.adjacency &&
                      component.assembly === recommendation.assembly &&
                      Math.abs(component.area - Math.round(suggestion.area)) <= 0.5
                    );
                    return { suggestion, adjacentKinds, recommendation, approved };
                  });
                  const allSuggestionsApproved = suggestionRows.length > 0 && suggestionRows.every((row) => row.approved);
                  const suggestionHighlightClass = validationSectionClass("wall-suggestions");
                  const shouldRenderSuggestionBlock = suggestionRows.length > 0 || Boolean(suggestionHighlightClass);
                  return (
                    <>
                      {shouldRenderSuggestionBlock && (
                        <div className={`takeoff-wall-suggestions ${allSuggestionsApproved ? "takeoff-wall-suggestions--resolved" : ""} ${suggestionHighlightClass}`}>
                          <div className="takeoff-component-head">
                            <h3>Suggested Exterior Walls</h3>
                            {allSuggestionsApproved && !suggestionHighlightClass ? (
                              <span className="takeoff-component-total">Applied</span>
                            ) : (
                              <select value={suggestedWallAssembly} onChange={(event) => setSuggestedWallAssembly(event.target.value)}>
                                {scheduleOptionsBySurface.wall.map((option) => (
                                  <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          {allSuggestionsApproved && !suggestionHighlightClass ? (
                            <p className="takeoff-muted">
                              {suggestionRows.length} suggested wall area{suggestionRows.length === 1 ? "" : "s"} applied. Flagged wall components remain below for review.
                            </p>
                          ) : suggestionRows.map(({ suggestion, adjacentKinds, recommendation, approved }) => (
                              <div key={suggestion.direction} className="takeoff-wall-suggestion-row">
                                <span>
                                  Suggested wall area: <strong>{Math.round(suggestion.area)} sf</strong> {suggestion.direction} {recommendation.label.toLowerCase()}
                                  <small>
                                    {Number(suggestion.length.toFixed(1))} lf x {selectedRoom.ceilingHeight} ft
                                    {adjacentKinds.length > 0 ? ` · adjacent ${adjacentKinds.map(adjacentSpaceLabel).join(", ")} · ${recommendation.assembly}` : ""}
                                  </small>
                                </span>
                                <button className={approved ? "toolbar-primary" : ""} onClick={() => applySuggestedWallArea(selectedRoom.id, suggestion, recommendation.assembly, recommendation.adjacency)}>
                                  {approved ? "Approved" : "Apply"}
                                </button>
                              </div>
                          ))}
                          {(!allSuggestionsApproved || suggestionHighlightClass) && (
                            <p className="takeoff-muted">You can apply a suggested gross wall area, then edit it manually in Wall Components below.</p>
                          )}
                        </div>
                        )}

                      <div className="takeoff-wall-reconciliation">
                        <div className="takeoff-component-head">
                          <h3>Wall / Opening Reconciliation</h3>
                          {reconciliation.length > 0 && (
                            <span className="takeoff-component-total">
                              Net {Math.round(totals.netArea)} sf
                            </span>
                          )}
                        </div>
                        {reconciliation.length ? (
                          <>
                            <div className="takeoff-wall-reconciliation-total">
                              <span>Gross <strong>{Math.round(totals.grossArea)} sf</strong></span>
                              <span>Glass <strong>{Math.round(totals.glassArea)} sf</strong></span>
                              <span>Doors <strong>{Math.round(totals.doorArea)} sf</strong></span>
                              <span>Net wall <strong>{Math.round(totals.netArea)} sf</strong></span>
                            </div>
                            {reconciliation.map((entry) => (
                              <div key={entry.direction} className={`takeoff-wall-reconciliation-row ${entry.isOverOpened ? "takeoff-wall-reconciliation-row--error" : ""}`}>
                                <div>
                                  <strong>{entry.direction} wall</strong>
                                  <small>
                                    {entry.isAssigned ? "Assigned gross" : "Suggested gross"} {Math.round(entry.grossArea)} sf
                                    {!entry.isAssigned && entry.suggestedGross > 0 ? " · apply wall component before export" : ""}
                                    {entry.adjacentKinds.length > 0 ? ` · adjacent ${entry.adjacentKinds.map(adjacentSpaceLabel).join(", ")}` : ""}
                                  </small>
                                </div>
                                <span>{Math.round(entry.grossArea)} sf gross</span>
                                <span>- {Math.round(entry.glassArea)} sf glass</span>
                                <span>- {Math.round(entry.doorArea)} sf door</span>
                                <strong>= {Math.round(entry.netArea)} sf net</strong>
                              </div>
                            ))}
                          </>
                        ) : (
                          <p className="takeoff-muted">Apply exterior wall areas or place openings to populate this room's reconciliation.</p>
                        )}
                      </div>
                    </>
                  );
                })()}
                <label>
                  Name
                  <input ref={roomNameInputRef} value={selectedRoom.name} onChange={(event) => updateRoom(selectedRoom.id, { name: event.target.value })} />
                </label>
                <label>
                  Room type
                  <select
                    value={selectedRoom.roomType ?? "plain"}
                    onChange={(event) => updateRoom(selectedRoom.id, { roomType: event.target.value as TakeoffRoomType })}
                  >
                    {roomTypeOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
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
                {renderRoomTypeSuggestion(selectedRoom)}
                <div className={`takeoff-ceiling-shape ${validationSectionClass("ceiling-geometry")}`}>
                  <label>
                    Ceiling shape
                    <select
                      value={selectedRoom.ceilingType ?? "flat"}
                      onChange={(event) => updateRoomCeilingType(selectedRoom.id, event.target.value as NonNullable<TakeoffRectRoom["ceilingType"]>)}
                    >
                      <option value="flat">Flat / taller flat</option>
                      <option value="vaulted">Vaulted</option>
                      <option value="none">No ceiling load</option>
                    </select>
                  </label>
                  {(selectedRoom.ceilingType ?? "flat") === "vaulted" && (
                    <div className="takeoff-ceiling-shape-grid">
                      <label>
                        Low height ft
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={selectedRoom.ceilingLowHeight ?? selectedRoom.ceilingHeight}
                          onChange={(event) => updateRoom(selectedRoom.id, { ceilingLowHeight: Number(event.target.value) })}
                        />
                      </label>
                      <label>
                        Peak height ft
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={selectedRoom.ceilingPeakHeight ?? Math.max(selectedRoom.ceilingHeight, selectedRoom.ceilingHeight + 1)}
                          onChange={(event) => updateRoom(selectedRoom.id, { ceilingPeakHeight: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                  )}
                  <p className="takeoff-muted">
                    Ceiling shape is stored with the editable takeoff JSON; vaulted geometry refinement and sketching will build on these values.
                  </p>
                </div>
                {(["floor", "ceiling", "wall", "glass", "door"] as const).map((surface) => {
                  const roomArea = rectArea(selectedRoom);
                  const assigned = componentAreaTotal(selectedRoom, surface);
                  const delta = roomArea - assigned;
                  const isAreaChecked = surface === "floor" || surface === "ceiling";
                  const areaSurface = isAreaChecked ? surface as "floor" | "ceiling" : null;
                  const areaCheck = areaSurface ? roomAreaReconciliation(selectedRoom, areaSurface) : null;
                  const options = scheduleOptionsBySurface[surface];
                  const exteriorDirections = roomExteriorDirections(floor, selectedRoom);
                  const staleCeilingWallIds = new Set(staleGeneratedCeilingWallComponents(floor, selectedRoom).map((component) => component.id));
                  return (
                    <div key={surface} className={`takeoff-component-editor ${validationSectionClass(componentValidationSection(surface))}`}>
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
                          {Math.round(assigned)} sf total · {surface === "wall" ? "wall area is gross; same-direction windows/doors subtract in payload." : "enter area manually until click-to-place openings is enabled."}
                        </p>
                      )}
                      {areaCheck && (
                        <div className={`takeoff-area-reconciliation ${areaCheck.isOver ? "takeoff-area-reconciliation--error" : ""}`}>
                          <div className="takeoff-area-reconciliation-grid">
                            <span>Measured <strong>{Math.round(areaCheck.roomArea)} sf</strong></span>
                            <span>Assigned <strong>{Math.round(areaCheck.assignedArea)} sf</strong></span>
                            <span>Open <strong>{Math.round(areaCheck.openArea)} sf</strong></span>
                            <span>Over <strong>{Math.round(areaCheck.overArea)} sf</strong></span>
                          </div>
                          <p>
                            {areaCheck.noLoad
                              ? `No ${componentSurfaceLabel(surface).toLowerCase()} load marked for this room.`
                              : areaCheck.isBalanced
                                ? `${componentSurfaceLabel(surface)} area is balanced.`
                                : areaCheck.isOver
                                  ? `${componentSurfaceLabel(surface)} area is over-assigned by ${Math.round(areaCheck.overArea)} sf.`
                                  : `${componentSurfaceLabel(surface)} area has ${Math.round(areaCheck.openArea)} sf unassigned.`}
                          </p>
                          <div className="takeoff-quick-actions">
                            <button onClick={() => areaSurface && setRoomSurfaceFullArea(selectedRoom.id, areaSurface)}>Set = room area</button>
                            <button onClick={() => areaSurface && setRoomSurfaceNoLoad(selectedRoom.id, areaSurface)}>No {componentSurfaceLabel(surface)} load</button>
                          </div>
                        </div>
                      )}
                      {roomSurfaceComponents(selectedRoom, surface).length === 0 ? (
                        <p className="takeoff-muted">No {componentSurfaceLabel(surface).toLowerCase()} load components.</p>
                      ) : (
                        <div className="takeoff-component-list">
                          {roomSurfaceComponents(selectedRoom, surface).map((component) => {
                            const selectedDefinition = options.find((option) => option.code === component.assembly);
                            const directionChoices = Array.from(new Set([
                              ...exteriorDirections,
                              ...(isCompassDirection(component.direction) ? [component.direction] : []),
                            ]));
                            const isStaleCeilingWall = staleCeilingWallIds.has(component.id);
                            const sourceLabel = componentSourceLabel(component.source);
                            const isActiveComponentRow = activeSketchTarget?.roomId === selectedRoom.id &&
                              activeSketchTarget.surface === component.surface &&
                              (!activeSketchTarget.direction || !component.direction || activeSketchTarget.direction === component.direction);
                            return (
                              <div key={component.id} className={`takeoff-component-row ${componentNeedsDirection(surface) ? "takeoff-component-row--directional" : ""} ${isStaleCeilingWall ? "takeoff-component-row--stale" : ""} ${isActiveComponentRow ? "takeoff-component-row--active" : ""}`}>
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
                                    {directionChoices.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
                                  </select>
                                )}
                                {surface === "wall" && (
                                  <select
                                    aria-label="wall adjacent space"
                                    value={component.adjacency ?? "outside"}
                                    onChange={(event) => {
                                      const adjacency = event.target.value as TakeoffWallAdjacency;
                                      updateRoomComponent(selectedRoom.id, component.id, {
                                        adjacency,
                                        assembly: adjacency === "outside" ? component.assembly : defaultWallAssemblyForAdjacency(adjacency),
                                        label: component.label && !/exterior wall/i.test(component.label) ? component.label : wallAdjacencyLabel(adjacency),
                                      });
                                    }}
                                  >
                                    <option value="outside">Exterior</option>
                                    <option value="garage">Garage</option>
                                    <option value="attic">Attic</option>
                                    <option value="crawlspace">Crawlspace</option>
                                    <option value="conditioned">Conditioned</option>
                                    <option value="unknown">Unknown</option>
                                  </select>
                                )}
                                {surface === "glass" && (
                                  <select
                                    aria-label="glass solar exposure"
                                    value={component.solarDirection ?? ""}
                                    onChange={(event) => {
                                      const solarDirection = event.target.value ? event.target.value as NonNullable<TakeoffRoomComponent["solarDirection"]> : undefined;
                                      updateRoomComponent(selectedRoom.id, component.id, {
                                        solarDirection,
                                        label: isAutoOpeningLabel(component.label) ? defaultOpeningLabel("glass", solarDirection) : component.label,
                                      });
                                    }}
                                  >
                                    <option value="">Wall direction</option>
                                    <option value="Shaded">Shaded</option>
                                    <option value="Skylight">Skylight</option>
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
                                <p className="takeoff-component-meta">
                                  <strong>{selectedDefinition?.code ?? component.assembly}</strong>
                                  {sourceLabel ? <em>{sourceLabel}</em> : null}
                                  {isStaleCeilingWall ? " · Stale ceiling-generated wall" : ""}
                                  {component.surface === "glass" && component.solarDirection ? ` · Solar ${component.solarDirection}` : ""}
                                  {selectedDefinition?.description ? ` · ${selectedDefinition.description}` : ""}
                                  {" · "}{componentThermalSummary(selectedDefinition)}
                                </p>
                              </div>
                            );
                          })}
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

          </>
          )}
        </aside>
      </section>
      {staleCeilingWallPrompt && (
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setStaleCeilingWallPrompt(null)}>
          <div className="modal takeoff-stale-ceiling-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Generated wall sections still attached</h2>
              <button className="modal-close" onClick={() => setStaleCeilingWallPrompt(null)}>x</button>
            </div>
            <p className="takeoff-muted">
              {staleCeilingWallPrompt.roomName} has ceiling-generated wall components that no longer match the current ceiling shape.
            </p>
            <div className="takeoff-stale-ceiling-list">
              {staleCeilingWallPrompt.components.map((component) => (
                <span key={component.id}>
                  <strong>{component.label}</strong>
                  {component.source ? ` · ${component.source}` : ""}
                  {" · "}{Math.round(component.area)} sf
                </span>
              ))}
            </div>
            <div className="takeoff-form-actions">
              <button className="toolbar-primary" onClick={removePromptedStaleCeilingWalls}>Remove Generated Walls</button>
              <button onClick={reviewPromptedStaleCeilingWalls}>Review</button>
              <button onClick={() => setStaleCeilingWallPrompt(null)}>Keep For Now</button>
            </div>
          </div>
        </div>
      )}
      {(pendingOpeningTarget || editingOpeningTarget) && openingPlacement && (() => {
        const editingRoom = editingOpeningTarget ? floor.rooms.find((room) => room.id === editingOpeningTarget.roomId) : null;
        const editingComponent = editingRoom && editingOpeningTarget
          ? roomComponents(editingRoom).find((component) => component.id === editingOpeningTarget.componentId)
          : null;
        const targetRoomName = pendingOpeningTarget?.roomName ?? editingRoom?.name ?? "room";
        const targetDirection = pendingOpeningTarget?.direction ?? editingComponent?.direction ?? "wall";
        const targetAdjacent = pendingOpeningTarget?.adjacentKinds ?? (editingRoom && editingComponent ? adjacentKindsForPlacedOpening(floor, editingRoom, editingComponent) : []);
        const selectedDefinition = scheduleOptionsBySurface[openingPlacement.surface].find((option) => option.code === openingPlacement.assembly);
        return (
          <div
            className="modal-backdrop open-dialog-backdrop"
            onPointerDown={(event) => {
              modalPointerStartedOnBackdropRef.current = event.target === event.currentTarget;
            }}
            onClick={(event) => {
              if (event.target === event.currentTarget && modalPointerStartedOnBackdropRef.current) closeOpeningDialog();
              modalPointerStartedOnBackdropRef.current = false;
            }}
          >
            <div
              className="modal takeoff-opening-modal"
              onPointerDown={(event) => {
                modalPointerStartedOnBackdropRef.current = false;
                event.stopPropagation();
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2>{editingOpeningTarget ? "Edit opening" : "What opening are you placing here?"}</h2>
                <button className="modal-close" onClick={closeOpeningDialog}>x</button>
              </div>
              <p className="takeoff-muted">
                Assigned to <strong>{targetRoomName}</strong> on the <strong>{targetDirection}</strong> wall.
                {targetAdjacent.length > 0 ? ` Adjacent: ${targetAdjacent.map(adjacentSpaceLabel).join(", ")}.` : ""}
              </p>
              <div className="takeoff-opening-grid">
                <label>
                  Type
                  <select
                    value={openingPlacement.surface}
                    onChange={(event) => updateOpeningPlacement({ surface: event.target.value as "glass" | "door" })}
                  >
                    <option value="glass">Glass / Window</option>
                    <option value="door">Door</option>
                  </select>
                </label>
                <label>
                  Component
                  <select
                    value={openingPlacement.assembly}
                    onChange={(event) => updateOpeningPlacement({ assembly: event.target.value })}
                  >
                    {scheduleOptionsBySurface[openingPlacement.surface].map((option) => (
                      <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                    ))}
                  </select>
                </label>
                {openingPlacement.surface === "glass" && (
                  <label>
                    Solar
                    <select
                      value={openingPlacement.solarDirection ?? ""}
                      onChange={(event) => updateOpeningPlacement({ solarDirection: event.target.value ? event.target.value as NonNullable<NonNullable<OpeningPlacement>["solarDirection"]> : undefined })}
                    >
                      <option value="">Use wall direction</option>
                      <option value="Shaded">Shaded</option>
                      <option value="Skylight">Skylight</option>
                    </select>
                  </label>
                )}
                <p className="takeoff-component-meta takeoff-opening-component-meta">
                  <strong>{selectedDefinition?.code ?? openingPlacement.assembly}</strong>
                  {selectedDefinition?.description ? ` · ${selectedDefinition.description}` : ""}
                  {" · "}{componentThermalSummary(selectedDefinition)}
                  {openingPlacement.surface === "glass" && openingPlacement.solarDirection ? ` · exports as ${openingPlacement.solarDirection}` : ""}
                </p>
                <label>
                  Width ft
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={openingPlacement.width}
                    onChange={(event) => updateOpeningPlacement({ width: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Height ft
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={openingPlacement.height}
                    onChange={(event) => updateOpeningPlacement({ height: Number(event.target.value) })}
                  />
                </label>
                <label>
                  Label
                  <input
                    value={openingPlacement.label}
                    onChange={(event) => updateOpeningPlacement({ label: event.target.value })}
                  />
                </label>
                <div className="takeoff-opening-area">
                  <span>Area</span>
                  <strong>{Number((openingPlacement.width * openingPlacement.height).toFixed(2))} sf</strong>
                </div>
              </div>
              <div className="takeoff-form-actions">
                <button className="toolbar-primary" onClick={editingOpeningTarget ? confirmOpeningEdit : confirmOpeningPlacement}>
                  {editingOpeningTarget ? "Update Opening" : "Confirm Opening"}
                </button>
                {editingOpeningTarget && <button onClick={removeSelectedOpening}>Remove Opening</button>}
                <button onClick={closeOpeningDialog}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}
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
