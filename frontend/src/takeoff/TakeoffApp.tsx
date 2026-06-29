import React, { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ventilationCfmForBedrooms } from "../loadRules";
import { allowNextUnsavedNavigation, registerUnsavedNavigationGuard } from "../navigationGuard";
import type {
  TakeoffAdjacentSpace,
  TakeoffAdjacentSpaceKind,
  TakeoffAuthoringMode,
  TakeoffBoundaryType,
  TakeoffComponentCategory,
  TakeoffComponentDefinition,
  TakeoffConnectedVolume,
  TakeoffFloor,
  TakeoffPoint,
  TakeoffProject,
  TakeoffRectRoom,
  TakeoffRoomComponent,
  TakeoffRoomComponentSource,
  TakeoffRoomType,
  TakeoffScaleLine,
  TakeoffSurfaceTreatmentSuggestion,
  TakeoffValidationIssue,
  TakeoffVerticalProfile,
  TakeoffWallAdjacency,
} from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const { difference, intersection, union } = polygonClipping;

const directionOptions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const defaultLightingWPerSf = 0.502;
const defaultBandJoistHeight = 1;
const takeoffReferenceMaxBytes = 7 * 1024 * 1024;
const pdfPreviewTargetScale = 2;
const pdfPreviewMaxPixels = 8_000_000;
const pdfPreviewMaxDimension = 2800;
const minPlanZoom = 0.5;
const maxPlanZoom = 8;
const planZoomStep = 0.25;
const componentCategories: TakeoffComponentCategory[] = ["Wall", "Door", "Ceiling", "Floor", "Glass"];
const allComponentSurfaces: TakeoffRoomComponent["surface"][] = ["floor", "ceiling", "wall", "glass", "door"];
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
type PlanReviewMode = "plan" | "alignment" | "floor" | "ceiling" | "walls" | "elevation";
type MovablePointTarget = { type: "exterior"; index: number } | { type: "room"; roomId: string; index: number };
type OpeningMoveTarget = { roomId: string; componentId: string };
type DragState = {
  kind: "crop" | "room" | "subtract" | "adjacent" | "move-point" | "move-opening";
  start: TakeoffPoint;
  current: TakeoffPoint;
  target?: MovablePointTarget;
  openingTarget?: OpeningMoveTarget;
} | null;
type AlignmentDragState = {
  pointerId: number;
  start: TakeoffPoint;
  current: TakeoffPoint;
  initialTransform: AlignmentTransform;
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
type ModelLayerKey = "reference" | "windows" | "doors" | "ceilings" | "floors" | "walls" | "interiorWalls" | "adjacentSpaces" | "bandJoists";
type ModelSurfaceKind = "floor" | "ceiling" | "load-wall" | "interior-wall" | "knee-wall" | "window" | "door";
type FloorViewOptions = {
  visible: boolean;
  reference: boolean;
  exterior: boolean;
  rooms: boolean;
};
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
type TakeoffBoundaryCandidate = {
  id: string;
  roomId: string;
  roomName: string;
  adjacentSpaceId: string;
  adjacentSpaceName: string;
  surface: "wall";
  direction: (typeof directionOptions)[number];
  spanStart: number;
  spanEnd: number;
  zMin: number;
  zMax: number;
  area: number;
  existingWallOverlapArea: number;
  wholeSectionArea: number;
  recommendedAdjacency: TakeoffWallAdjacency;
  recommendedAssembly: string;
  recommendedBoundary: TakeoffBoundaryType;
  reason: string;
};
type OrientationLoadResult = { facing: string; cooling: number; heating: number; tons: number };
type TakeoffCalcResult = OrientationLoadResult & { orientations: OrientationLoadResult[]; baseFacing: string };
type ValidationSection = "merge" | "wall-suggestions" | "wall-components" | "glass-components" | "door-components" | "floor-components" | "ceiling-components" | "ceiling-geometry" | "room-profile";
type LeftSetupSection = "project" | "mode" | "scale" | "grid" | "exterior";
type ActiveValidationTarget = {
  key: string;
  floorId?: string;
  roomId?: string;
  severity: TakeoffValidationIssue["severity"];
  section: ValidationSection;
  message: string;
  issueType?: TakeoffValidationIssue["issueType"];
  surfaceTreatmentSuggestion?: TakeoffValidationIssue["surfaceTreatmentSuggestion"];
  wallComponentGeometrySuggestion?: TakeoffValidationIssue["wallComponentGeometrySuggestion"];
  glassTreatmentSuggestion?: TakeoffValidationIssue["glassTreatmentSuggestion"];
  internalGainSuggestion?: TakeoffValidationIssue["internalGainSuggestion"];
  openToAboveEnvelopeSuggestion?: TakeoffValidationIssue["openToAboveEnvelopeSuggestion"];
  verticalMergeSuggestion?: TakeoffValidationIssue["verticalMergeSuggestion"];
};
type ProjectValidationEntry = {
  floor: TakeoffFloor;
  issue: TakeoffValidationIssue;
  index: number;
  key: string;
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

function normalizeReferenceRotation(rotationDeg?: number) {
  return ((Math.round((rotationDeg ?? 0) / 90) * 90) % 360 + 360) % 360;
}

function referenceSourceSizeForFloor(floor: TakeoffFloor) {
  const gridWidth = Math.max(floor.designGrid.width, 1);
  const gridDepth = Math.max(floor.designGrid.depth, 1);
  const previewWidth = Math.max(0, floor.reference?.previewWidthPx ?? 0);
  const previewHeight = Math.max(0, floor.reference?.previewHeightPx ?? 0);
  const nativeAspect = previewWidth > 0 && previewHeight > 0
    ? previewWidth / previewHeight
    : gridWidth / gridDepth;
  const aspect = Number.isFinite(nativeAspect) && nativeAspect > 0 ? nativeAspect : gridWidth / gridDepth;
  const gridAspect = gridWidth / gridDepth;
  return aspect >= gridAspect
    ? { width: gridWidth, depth: gridWidth / aspect }
    : { width: gridDepth * aspect, depth: gridDepth };
}

function designGridForReferenceUpload(floor: TakeoffFloor, reference: NonNullable<TakeoffFloor["reference"]>) {
  const currentWidth = Math.max(floor.designGrid.width, 1);
  const currentDepth = Math.max(floor.designGrid.depth, 1);
  const previewWidth = Math.max(0, reference.previewWidthPx ?? 0);
  const previewHeight = Math.max(0, reference.previewHeightPx ?? 0);
  if (previewWidth <= 0 || previewHeight <= 0) return floor.designGrid;
  const hasModeledGeometry = floor.exteriorPolygon.length > 0 || floor.rooms.length > 0 || (floor.adjacentSpaces ?? []).length > 0;
  if (hasModeledGeometry) return floor.designGrid;
  const aspect = previewWidth / previewHeight;
  const longSide = Math.max(currentWidth, currentDepth);
  return aspect >= 1
    ? { width: Number(longSide.toFixed(3)), depth: Number((longSide / aspect).toFixed(3)) }
    : { width: Number((longSide * aspect).toFixed(3)), depth: Number(longSide.toFixed(3)) };
}

function referenceFullCropForFloor(floor: TakeoffFloor, rotationDeg = normalizeReferenceRotation(floor.reference?.rotationDeg)): PlanRect {
  const source = referenceSourceSizeForFloor(floor);
  return rotationDeg === 90 || rotationDeg === 270
    ? { x: 0, y: 0, width: source.depth, depth: source.width }
    : { x: 0, y: 0, width: source.width, depth: source.depth };
}

function referenceCropForFloor(floor: TakeoffFloor) {
  return floor.reference?.crop ?? referenceFullCropForFloor(floor);
}

function referenceDisplayRectForFloor(floor: TakeoffFloor, cropOverride?: PlanRect): PlanRect {
  const gridWidth = Math.max(floor.designGrid.width, 1);
  const gridDepth = Math.max(floor.designGrid.depth, 1);
  const crop = cropOverride ?? referenceCropForFloor(floor);
  const cropAspect = Math.max(crop.width, 1) / Math.max(crop.depth, 1);
  const gridAspect = gridWidth / gridDepth;

  return cropAspect >= gridAspect
    ? {
        x: 0,
        y: (gridDepth - gridWidth / cropAspect) / 2,
        width: gridWidth,
        depth: gridWidth / cropAspect,
      }
    : {
        x: (gridWidth - gridDepth * cropAspect) / 2,
        y: 0,
        width: gridDepth * cropAspect,
        depth: gridDepth,
      };
}

function referenceImageStyles(floor: TakeoffFloor, crop = referenceCropForFloor(floor)) {
  const rotationDeg = normalizeReferenceRotation(floor.reference?.rotationDeg);
  const mirroredX = Boolean(floor.reference?.mirroredX);
  const fullCrop = referenceFullCropForFloor(floor, rotationDeg);
  const source = referenceSourceSizeForFloor(floor);
  return {
    viewportStyle: {
      left: `${-(crop.x / Math.max(crop.width, 1)) * 100}%`,
      top: `${-(crop.y / Math.max(crop.depth, 1)) * 100}%`,
      width: `${(fullCrop.width / Math.max(crop.width, 1)) * 100}%`,
      height: `${(fullCrop.depth / Math.max(crop.depth, 1)) * 100}%`,
    } satisfies React.CSSProperties,
    imageStyle: {
      left: "50%",
      top: "50%",
      width: `${(source.width / Math.max(fullCrop.width, 1)) * 100}%`,
      height: `${(source.depth / Math.max(fullCrop.depth, 1)) * 100}%`,
      transform: `translate(-50%, -50%) rotate(${rotationDeg}deg) scaleX(${mirroredX ? -1 : 1})`,
      transformOrigin: "center center",
    } satisfies React.CSSProperties,
  };
}

function ReferencePlanImage({ floor, src, alt, crop }: { floor: TakeoffFloor; src: string; alt: string; crop?: PlanRect }) {
  const { viewportStyle, imageStyle } = referenceImageStyles(floor, crop);
  return (
    <div className="takeoff-reference-image-viewport" style={viewportStyle}>
      <img src={src} alt={alt} style={imageStyle} />
    </div>
  );
}

const adjacentSpaceKinds: Array<{ id: TakeoffAdjacentSpaceKind; label: string }> = [
  { id: "garage", label: "Garage" },
  { id: "attic", label: "Attic" },
  { id: "crawl", label: "Crawl space" },
  { id: "covered_porch", label: "Covered porch" },
  { id: "conditioned_addition", label: "Conditioned addition" },
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
const roomTypeInternalLoads: Record<TakeoffRoomType, { people: number; applianceWatts: number }> = {
  plain: { people: 0, applianceWatts: 0 },
  bedroom: { people: 1, applianceWatts: 0 },
  kitchen: { people: 0, applianceWatts: 680 },
  entertainment: { people: 1, applianceWatts: 250 },
  laundry: { people: 0, applianceWatts: 200 },
};
const recGameEntertainmentApplianceWatts = 450;
const officeApplianceWatts = 75;
const computerApplianceWatts = 150;
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
  page_number?: number;
};

type PdfPreviewResult = {
  url: string;
  pageNumber: number;
  pageCount: number;
  scale: number;
  widthPx: number;
  heightPx: number;
};

type AlignmentTransform = {
  translateX: number;
  translateY: number;
  rotationDeg: number;
  scale: number;
};

type DimensionInputMode = NonNullable<TakeoffProject["dimensionInputMode"]>;
type UndoSnapshot = {
  label: string;
  snapshot: string;
  activeFloorId: string;
};
type PendingSessionExit = {
  label: string;
  action: () => void | Promise<void>;
  navigates?: boolean;
};

function defaultFloorViewOptions(): FloorViewOptions {
  return { visible: true, reference: true, exterior: true, rooms: true };
}

function floorsByElevation(floors: TakeoffFloor[]) {
  return floors
    .map((entry, index) => ({ entry, index }))
    .sort((first, second) => ((first.entry.elevation ?? 0) - (second.entry.elevation ?? 0)) || first.index - second.index)
    .map(({ entry }) => entry);
}

function defaultAlignmentTransform(scale = 1): AlignmentTransform {
  return { translateX: 0, translateY: 0, rotationDeg: 0, scale };
}

function floorBandJoistHeight(floor: Pick<TakeoffFloor, "bandJoistHeight">) {
  return Math.max(0, floor.bandJoistHeight ?? defaultBandJoistHeight);
}

function floorBandJoistEnabled(floor: Pick<TakeoffFloor, "bandJoistEnabled" | "bandJoistHeight">) {
  return floor.bandJoistEnabled ?? floorBandJoistHeight(floor) > 0.01;
}

function makeInitialFloor(): TakeoffFloor {
  return {
    id: "floor-1",
    name: "First Floor",
    authoringMode: "grid_manual",
    coordinateSpace: "world_feet",
    elevation: 0,
    floorToFloorHeight: 10,
    bandJoistEnabled: true,
    bandJoistHeight: defaultBandJoistHeight,
    bandJoistHeightUserSet: false,
    floorAlignmentSnapEnabled: true,
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
  dimensionInputMode: DimensionInputMode,
  mechanicalVentilation: boolean,
  ventilationCfm: number,
  frontDoorFaces: TakeoffProject["frontDoorFaces"],
  floors: TakeoffFloor | TakeoffFloor[],
  componentSchedule: TakeoffComponentDefinition[],
  connectedVolumes: TakeoffConnectedVolume[] = [],
): TakeoffProject {
  const projectFloors = Array.isArray(floors) ? floors : [floors];
  return {
    schemaVersion: "takeoff.v1",
    name,
    location,
    dimensionInputMode,
    mechanicalVentilation,
    ventilationCfm,
    frontDoorFaces,
    componentSchedule,
    floors: projectFloors.length ? projectFloors : [makeInitialFloor()],
    connectedVolumes,
  };
}

const COMPASS_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function rotateCompass(direction: string | undefined, steps: number): string | undefined {
  const index = COMPASS_ORDER.indexOf(direction as (typeof COMPASS_ORDER)[number]);
  if (index < 0) return direction;
  return COMPASS_ORDER[(index + steps) % COMPASS_ORDER.length];
}

function mirrorCompassHorizontal(direction: string | undefined): string | undefined {
  const mirrored: Record<(typeof COMPASS_ORDER)[number], (typeof COMPASS_ORDER)[number]> = {
    N: "N",
    NE: "NW",
    E: "W",
    SE: "SW",
    S: "S",
    SW: "SE",
    W: "E",
    NW: "NE",
  };
  return mirrored[direction as (typeof COMPASS_ORDER)[number]] ?? direction;
}

function mirrorPointHorizontal(point: TakeoffPoint | undefined, axisWidth: number): TakeoffPoint | undefined {
  if (!point) return undefined;
  return { x: Number((axisWidth - point.x).toFixed(3)), y: point.y };
}

function mirrorPointsHorizontal(points: TakeoffPoint[] | undefined, axisWidth: number) {
  return points?.map((point) => mirrorPointHorizontal(point, axisWidth)!).reverse();
}

function mirrorRectHorizontal<T extends { x: number; width: number }>(rect: T, axisWidth: number): T {
  return { ...rect, x: Number((axisWidth - rect.x - rect.width).toFixed(3)) };
}

function mirrorReferenceCropHorizontal(floor: TakeoffFloor, crop: PlanRect | undefined) {
  if (!crop) return crop;
  const fullCrop = referenceFullCropForFloor(floor);
  return {
    ...crop,
    x: Number((fullCrop.width - crop.x - crop.width).toFixed(3)),
  };
}

function mirrorVerticalProfileHorizontal(profile: TakeoffVerticalProfile | undefined): TakeoffVerticalProfile | undefined {
  if (!profile || profile.kind !== "shed") return profile;
  return { ...profile, lowSide: mirrorCompassHorizontal(profile.lowSide) as typeof profile.lowSide };
}

function mirrorComponentHorizontal(component: TakeoffRoomComponent, axisWidth: number): TakeoffRoomComponent {
  return {
    ...component,
    direction: mirrorCompassHorizontal(component.direction) as TakeoffRoomComponent["direction"],
    placement: mirrorPointHorizontal(component.placement, axisWidth),
    panelPolygons: component.panelPolygons?.map((panel) => mirrorPointsHorizontal(panel, axisWidth) ?? panel),
  };
}

function mirrorRoomHorizontal(room: TakeoffRectRoom, axisWidth: number): TakeoffRectRoom {
  const polygon = mirrorPointsHorizontal(room.polygon, axisWidth);
  const bounds = polygon && polygon.length >= 3 ? polygonBounds(polygon) : mirrorRectHorizontal(room, axisWidth);
  return {
    ...room,
    ...bounds,
    polygon,
    ceilingRidgeDirection: room.ceilingRidgeDirection,
    components: roomComponents(room).map((component) => mirrorComponentHorizontal(component, axisWidth)),
  };
}

function mirrorAdjacentSpaceHorizontal(space: TakeoffAdjacentSpace, axisWidth: number): TakeoffAdjacentSpace {
  const polygon = mirrorPointsHorizontal(space.polygon, axisWidth);
  const bounds = polygon && polygon.length >= 3 ? polygonBounds(polygon) : mirrorRectHorizontal(space, axisWidth);
  return {
    ...space,
    ...bounds,
    polygon,
    verticalProfile: mirrorVerticalProfileHorizontal(space.verticalProfile),
  };
}

function mirrorScaleLineHorizontal(line: TakeoffScaleLine, axisWidth: number): TakeoffScaleLine {
  return {
    ...line,
    start: mirrorPointHorizontal(line.start, axisWidth)!,
    end: mirrorPointHorizontal(line.end, axisWidth)!,
    sourceStart: mirrorPointHorizontal(line.sourceStart, axisWidth),
    sourceEnd: mirrorPointHorizontal(line.sourceEnd, axisWidth),
  };
}

function mirrorFloorHorizontal(floor: TakeoffFloor): TakeoffFloor {
  const axisWidth = Math.max(floor.designGrid.width, 1);
  const mirroredReference = floor.reference
    ? {
        ...floor.reference,
        mirroredX: !floor.reference.mirroredX,
        crop: mirrorReferenceCropHorizontal(floor, floor.reference.crop),
      }
    : floor.reference;
  return {
    ...floor,
    exteriorPolygon: mirrorPointsHorizontal(floor.exteriorPolygon, axisWidth) ?? [],
    rooms: floor.rooms.map((room) => mirrorRoomHorizontal(room, axisWidth)),
    adjacentSpaces: floor.adjacentSpaces?.map((space) => mirrorAdjacentSpaceHorizontal(space, axisWidth)),
    calibration: {
      ...floor.calibration,
      lines: floor.calibration.lines.map((line) => mirrorScaleLineHorizontal(line, axisWidth)),
      areaConfirmed: false,
    },
    alignment: floor.alignment
      ? {
          ...floor.alignment,
          transform: floor.alignment.transform
            ? {
                ...floor.alignment.transform,
                translateX: -floor.alignment.transform.translateX,
                rotationDeg: -floor.alignment.transform.rotationDeg,
              }
            : floor.alignment.transform,
          pointPairs: floor.alignment.pointPairs?.map((pair) => ({
            ...pair,
            local: mirrorPointHorizontal(pair.local, axisWidth)!,
            reference: mirrorPointHorizontal(pair.reference, axisWidth)!,
          })),
        }
      : floor.alignment,
    reference: mirroredReference,
    referencePoints: floor.referencePoints?.map((point) => ({
      ...point,
      local: mirrorPointHorizontal(point.local, axisWidth)!,
      world: mirrorPointHorizontal(point.world, axisWidth),
    })),
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

function trimNumber(value: number, digits = 3) {
  return Number(value.toFixed(digits)).toString();
}

function formatDimensionValue(value: number, mode: DimensionInputMode) {
  if (mode === "decimal") return trimNumber(value);
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  let feet = Math.floor(absolute);
  let eighths = Math.round((absolute - feet) * 12 * 8);
  if (eighths >= 96) {
    feet += 1;
    eighths = 0;
  }
  const inches = Math.floor(eighths / 8);
  const fraction = eighths % 8;
  const fractionText = fraction === 0 ? "" : ` ${fraction}/8`;
  return `${sign}${feet}'${inches || fraction ? ` ${inches}${fractionText}"` : ""}`;
}

function parseMaybeFraction(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const mixed = trimmed.match(/^(-?\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Math.max(1, Number(mixed[3]));
  const fraction = trimmed.match(/^(-?\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) / Math.max(1, Number(fraction[2]));
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseDimensionValue(raw: string, mode: DimensionInputMode) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const decimal = Number(trimmed);
  if (Number.isFinite(decimal) && !/[\'"\-a-z\s]/.test(trimmed.replace(/^-/, ""))) return decimal;
  const normalized = trimmed
    .replace(/feet|foot|ft/g, "'")
    .replace(/inches|inch|in/g, "\"")
    .replace(/[’]/g, "'")
    .replace(/[”]/g, "\"");
  const explicit = normalized.match(/^(-)?\s*(\d+(?:\.\d+)?)\s*'?\s*(?:(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*\"?)?$/);
  if (explicit && (normalized.includes("'") || normalized.includes("\"") || mode === "feet-inches")) {
    const sign = explicit[1] ? -1 : 1;
    const feet = Number(explicit[2]);
    const inches = parseMaybeFraction(explicit[3] ?? "0");
    if (Number.isFinite(feet) && inches != null) return sign * (feet + inches / 12);
  }
  if (mode === "feet-inches") {
    const pair = normalized.match(/^(-)?\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)$/);
    if (pair) {
      const inches = parseMaybeFraction(pair[3]);
      if (inches != null) return (pair[1] ? -1 : 1) * (Number(pair[2]) + inches / 12);
    }
    const dash = normalized.match(/^(-)?\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)$/);
    if (dash) {
      const inches = parseMaybeFraction(dash[3]);
      if (inches != null) return (dash[1] ? -1 : 1) * (Number(dash[2]) + inches / 12);
    }
  }
  return Number.isFinite(decimal) ? decimal : null;
}

function DimensionInput({
  value,
  mode,
  onCommit,
  min,
  step,
  ariaLabel,
  disabled,
}: {
  value: number;
  mode: DimensionInputMode;
  onCommit: (value: number) => void;
  min?: number;
  step?: number;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatDimensionValue(value, mode));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(formatDimensionValue(value, mode));
  }, [focused, mode, value]);

  const commit = () => {
    const parsed = parseDimensionValue(draft, mode);
    if (parsed == null) {
      setDraft(formatDimensionValue(value, mode));
      return;
    }
    const next = min != null ? Math.max(min, parsed) : parsed;
    onCommit(Number(next.toFixed(4)));
    setDraft(formatDimensionValue(next, mode));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      disabled={disabled}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
      placeholder={mode === "feet-inches" ? "9' 6\"" : step ? String(step) : "0"}
    />
  );
}

function trayStepCount(room: TakeoffRectRoom) {
  const requested = Math.max(1, Math.min(6, Math.round(room.ceilingTraySteps ?? 1)));
  return room.ceilingTrayMode === "double_box" ? Math.max(2, requested) : requested;
}

function trayStepHeight() {
  return 1;
}

function isVaultCeilingType(ceilingType?: TakeoffRectRoom["ceilingType"]) {
  return ceilingType === "vaulted" || ceilingType === "vault_flat_peak";
}

function ceilingTypeLabel(ceilingType?: TakeoffRectRoom["ceilingType"]) {
  if (ceilingType === "none") return "No ceiling load";
  if (ceilingType === "vaulted") return "Vaulted ceiling";
  if (ceilingType === "vault_flat_peak") return "Vault w/ flat peak";
  if (ceilingType === "tray") return "Tray ceiling";
  return "Flat ceiling";
}

function trayModeLabel(mode?: TakeoffRectRoom["ceilingTrayMode"]) {
  if (mode === "follow_room") return "follow room";
  if (mode === "double_box") return "double box";
  if (mode === "custom") return "custom";
  return "smart box";
}

function trayBoundaryDimensions(room: TakeoffRectRoom, offset: number) {
  const bounds = polygonBounds(roomCorners(room));
  return {
    width: Math.max(0, bounds.width - offset * 2),
    depth: Math.max(0, bounds.depth - offset * 2),
  };
}

function trayBoundaryPoints(room: TakeoffRectRoom, offset: number) {
  const bounds = polygonBounds(roomCorners(room));
  const { width, depth } = trayBoundaryDimensions(room, offset);
  if (width <= 0.25 || depth <= 0.25) return [];
  const x0 = bounds.x + offset;
  const y0 = bounds.y + offset;
  const x1 = bounds.x + bounds.width - offset;
  const y1 = bounds.y + bounds.depth - offset;
  const clipped = (room.ceilingTrayShape ?? "rectangular") === "clipped";
  if (!clipped) return rectToPoints({ x: x0, y: y0, width, depth });
  const cornerClip = Math.min(4, width / 4, depth / 4);
  return [
    { x: x0 + cornerClip, y: y0 },
    { x: x1 - cornerClip, y: y0 },
    { x: x1, y: y0 + cornerClip },
    { x: x1, y: y1 - cornerClip },
    { x: x1 - cornerClip, y: y1 },
    { x: x0 + cornerClip, y: y1 },
    { x: x0, y: y1 - cornerClip },
    { x: x0, y: y0 + cornerClip },
  ];
}

function trayBoundaryPerimeter(room: TakeoffRectRoom, offset: number) {
  const { width, depth } = trayBoundaryDimensions(room, offset);
  if (width <= 0.25 || depth <= 0.25) return 0;
  const clipped = (room.ceilingTrayShape ?? "rectangular") === "clipped";
  if (!clipped) return (width + depth) * 2;
  const cornerClip = Math.min(4, width / 4, depth / 4);
  return (width + depth) * 2 + (2 * Math.SQRT2 - 4) * cornerClip * 4;
}

function trayKneeWallArea(room: TakeoffRectRoom) {
  if ((room.ceilingType ?? "flat") !== "tray") return 0;
  const firstOffset = Math.max(0, room.ceilingTrayOffset ?? 2);
  let area = 0;
  for (let stepIndex = 0; stepIndex < trayStepCount(room); stepIndex += 1) {
    const offset = firstOffset + stepIndex;
    area += trayBoundaryPerimeter(room, offset) * trayStepHeight();
  }
  return area;
}

function ceilingGeometryInfo(room: TakeoffRectRoom, defaultCeilingHeight = 9) {
  const ceilingType = room.ceilingType ?? "flat";
  const traySteps = trayStepCount(room);
  const vaultCeiling = isVaultCeilingType(ceilingType);
  const lowHeight = vaultCeiling ? room.ceilingLowHeight ?? room.ceilingHeight : room.ceilingHeight;
  const peakHeight = vaultCeiling
    ? room.ceilingPeakHeight ?? Math.max(lowHeight, room.ceilingHeight)
    : ceilingType === "tray"
      ? room.ceilingHeight + traySteps * trayStepHeight()
      : room.ceilingHeight;
  const ridgeDirection = room.ceilingRidgeDirection ?? "E-W";
  const ridgeOffset = clamp(room.ceilingRidgeOffset ?? 0, -1, 1);
  const ridgeRatio = (ridgeOffset + 1) / 2;
  const flatDelta = Math.max(0, room.ceilingHeight - defaultCeilingHeight);
  const lowDelta = Math.max(0, lowHeight - defaultCeilingHeight);
  const peakDelta = Math.max(0, peakHeight - lowHeight);
  const raisedWallArea = vaultCeiling
    ? roomPerimeter(room) * lowDelta
    : roomPerimeter(room) * flatDelta;
  const gableBase = ridgeDirection === "E-W" ? roomPlanSpan(room, "y") : roomPlanSpan(room, "x");
  const ridgeLength = ridgeDirection === "E-W" ? roomPlanSpan(room, "x") : roomPlanSpan(room, "y");
  const crossSpan = ridgeDirection === "E-W" ? roomPlanSpan(room, "y") : roomPlanSpan(room, "x");
  const ridgePosition = crossSpan * ridgeRatio;
  const requestedFlatPeakWidth = ceilingType === "vault_flat_peak" ? Math.max(0, room.ceilingFlatPeakWidth ?? 4) : 0;
  const flatStart = clamp(ridgePosition - requestedFlatPeakWidth / 2, 0, crossSpan);
  const flatEnd = clamp(ridgePosition + requestedFlatPeakWidth / 2, 0, crossSpan);
  const flatPeakWidth = Math.max(0, flatEnd - flatStart);
  const firstRun = flatStart;
  const secondRun = crossSpan - flatEnd;
  const vaultedSlopedCeilingArea = vaultCeiling
    ? (
      flatPeakWidth <= 0.01 && (firstRun <= 0.25 || secondRun <= 0.25)
        ? Math.sqrt(crossSpan ** 2 + peakDelta ** 2) * ridgeLength
        : (
          (firstRun > 0.25 ? Math.sqrt(firstRun ** 2 + peakDelta ** 2) : 0) +
          (secondRun > 0.25 ? Math.sqrt(secondRun ** 2 + peakDelta ** 2) : 0)
        ) * ridgeLength
    )
    : 0;
  const flatPeakArea = ceilingType === "vault_flat_peak" ? flatPeakWidth * ridgeLength : 0;
  const slopedCeilingArea = vaultCeiling
    ? vaultedSlopedCeilingArea + flatPeakArea
    : rectArea(room);
  const gableArea = vaultCeiling ? (gableBase + flatPeakWidth) * peakDelta : 0;
  const trayArea = trayKneeWallArea(room);
  const estimatedAddedWallArea = raisedWallArea + gableArea + trayArea;
  const heightDelta = Math.max(flatDelta, lowDelta, Math.max(0, peakHeight - defaultCeilingHeight));
  return {
    ceilingType,
    lowHeight,
    peakHeight,
    ridgeDirection,
    ridgeOffset,
    ridgeRatio,
    firstRun,
    secondRun,
    flatPeakWidth,
    flatPeakArea,
    vaultedSlopedCeilingArea,
    slopedCeilingArea,
    heightDelta,
    raisedWallArea,
    gableArea,
    trayArea,
    trayOffset: Math.max(0, room.ceilingTrayOffset ?? 2),
    trayShape: room.ceilingTrayShape ?? "rectangular",
    trayMode: room.ceilingTrayMode ?? "smart_box",
    traySteps,
    estimatedAddedWallArea,
    needsReview: ceilingType !== "none" && (heightDelta > 1.5 || trayArea > 0.5) && !room.ceilingGeometryApproved,
  };
}

type CeilingWallSuggestion = {
  key: string;
  direction?: TakeoffRoomComponent["direction"];
  area: number;
  label: string;
  description: string;
  geometryLabel: string;
  basis: "raised-wall" | "gable-end" | "tray-step";
  source: Extract<TakeoffRoomComponentSource, "raised-ceiling" | "vault-gable" | "tray-knee-wall">;
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
  if (kinds.includes("conditioned_addition")) return "conditioned";
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
  if (openToAboveLinkForRoom(room)) return [];
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  const suggestions: CeilingWallSuggestion[] = [];
  const exteriorDirections = roomExteriorDirections(floor, room);
  const addedLowHeight = isVaultCeilingType(ceilingInfo.ceilingType)
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
  if (ceilingInfo.ceilingType === "tray" && ceilingInfo.trayArea > 0.5) {
    suggestions.push({
      key: `ceiling-tray-${ceilingInfo.trayShape}-${Math.round(ceilingInfo.trayOffset * 10)}-${ceilingInfo.traySteps}`,
      area: Math.round(ceilingInfo.trayArea * 10) / 10,
      label: "Tray ceiling knee wall",
      description: `${ceilingInfo.traySteps} step${ceilingInfo.traySteps === 1 ? "" : "s"} · ${trayModeLabel(ceilingInfo.trayMode)} · ${ceilingInfo.trayOffset} ft ${ceilingInfo.trayShape === "clipped" ? "clipped-corner" : "rectangular"} tray offset`,
      geometryLabel: "Tray ceiling knee wall",
      basis: "tray-step",
      source: "tray-knee-wall",
      adjacency: "attic",
      length: Math.round((ceilingInfo.trayArea / trayStepHeight()) * 10) / 10,
      addedHeight: trayStepHeight(),
    });
  }
  if (!isVaultCeilingType(ceilingInfo.ceilingType) || ceilingInfo.gableArea <= 0) return suggestions;
  const directions: Array<NonNullable<TakeoffRoomComponent["direction"]>> = [...vaultGableDirections(ceilingInfo)];
  const area = Math.round((ceilingInfo.gableArea / 2) * 10) / 10;
  suggestions.push(...directions.flatMap((direction, index) => {
    if (!exteriorDirections.includes(direction) && gableEndSharesMatchingConditionedRoom(floor, room, direction, defaultCeilingHeight)) return [];
    const geometryLabel = `Gable ${index === 0 ? "A" : "B"}`;
    const adjacency: TakeoffWallAdjacency = exteriorDirections.includes(direction) ? "outside" : "attic";
    return [{
      key: `ceiling-gable-${direction}`,
      direction,
      area,
      label: geometryLabel,
      description: `${geometryLabel} · ${direction}-side gable end`,
      geometryLabel,
      basis: "gable-end" as const,
      source: "vault-gable" as const,
      adjacency,
    }];
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

function defaultCeilingLoadComponentsForRoom(room: TakeoffRectRoom): TakeoffRoomComponent[] {
  const ceilingType = room.ceilingType ?? "flat";
  if (ceilingType === "none") return [];
  const ceilingInfo = ceilingGeometryInfo(room);
  if (ceilingType === "vault_flat_peak") {
    const components: TakeoffRoomComponent[] = [];
    if (ceilingInfo.flatPeakArea > 0.5) {
      components.push({
        id: `${room.id}-ceiling-flat-peak`,
        surface: "ceiling",
        assembly: "C1",
        area: Number(ceilingInfo.flatPeakArea.toFixed(3)),
        label: "Flat peak ceiling",
        boundary: "flat_ceiling",
      });
    }
    if (ceilingInfo.vaultedSlopedCeilingArea > 0.5) {
      components.push({
        id: `${room.id}-ceiling-vault-shoulders`,
        surface: "ceiling",
        assembly: "C2",
        area: Number(ceilingInfo.vaultedSlopedCeilingArea.toFixed(3)),
        label: "Vaulted ceiling shoulders",
        boundary: "vaulted_ceiling",
      });
    }
    return components.length ? components : [defaultComponent("ceiling", rectArea(room))];
  }
  const assembly = ceilingType === "vaulted" ? "C2" : "C1";
  const label = ceilingTypeLabel(ceilingType);
  return [{
    id: `${room.id}-ceiling-default`,
    surface: "ceiling",
    assembly,
    area: Number(Math.max(0, room.ceilingLoadArea ?? ceilingInfo.slopedCeilingArea).toFixed(3)),
    label,
    boundary: assembly === "C2" ? "vaulted_ceiling" : "flat_ceiling",
  }];
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
  components.push(...defaultCeilingLoadComponentsForRoom(room));
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

function componentLoadAreaTotal(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  return roomSurfaceComponents(room, surface)
    .filter((component) => !component.loadExempt)
    .reduce((sum, component) => sum + Math.max(0, component.area || 0), 0);
}

function roomSurfaceNoLoad(room: TakeoffRectRoom, surface: TakeoffRoomComponent["surface"]) {
  return (surface === "floor" && room.floorType === "none") || (surface === "ceiling" && room.ceilingType === "none");
}

function expectedSurfaceArea(room: TakeoffRectRoom, surface: "floor" | "ceiling") {
  return surface === "ceiling" ? ceilingGeometryInfo(room).slopedCeilingArea : rectArea(room);
}

function verticalSurfaceTolerance(planArea: number) {
  return clamp(planArea * 0.01, 3, 12);
}

function roomLightingBasis(room: TakeoffRectRoom): "Floor" | "Ceiling" {
  const floorArea = rectArea(room);
  const ceilingArea = expectedSurfaceArea(room, "ceiling");
  return room.ceilingType !== "none" && ceilingArea > floorArea + 0.5 ? "Ceiling" : "Floor";
}

function roomLightingArea(room: TakeoffRectRoom) {
  return roomLightingBasis(room) === "Ceiling" ? expectedSurfaceArea(room, "ceiling") : rectArea(room);
}

function roomAreaReconciliation(room: TakeoffRectRoom, surface: "floor" | "ceiling") {
  const roomArea = expectedSurfaceArea(room, surface);
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
  if (component.source === "raised-ceiling" || component.source === "vault-gable" || component.source === "tray-knee-wall") return true;
  const label = `${component.label ?? ""} ${component.geometryLabel ?? ""}`.toLowerCase();
  return (
    label.includes("gable") ||
    label.includes("raised ceiling wall") ||
    label.includes("raised wall band") ||
    label.includes("knee-wall") ||
    label.includes("kneewall") ||
    label.includes("tray") ||
    label.includes("vault")
  );
}

function componentIsGeneratedEnvelopeWall(component: TakeoffRoomComponent) {
  return componentIsGeneratedCeilingWall(component) || component.source === "open-to-above-envelope" || component.source === "connected-volume";
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
  return !componentIsGeneratedEnvelopeWall(component);
}

function wallCanHostOpenings(component: TakeoffRoomComponent) {
  if (component.surface !== "wall") return false;
  if (componentIsGeneratedEnvelopeWall(component)) return false;
  return component.adjacency == null || component.adjacency === "outside" || component.adjacency === "garage" || component.adjacency === "unknown";
}

function componentIsFloorOverGarage(component: TakeoffRoomComponent) {
  return component.surface === "floor" && (
    component.boundary === "floor_over_garage" ||
    component.adjacency === "garage" ||
    /garage/i.test(component.label ?? "")
  );
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

function assignedWallAreaByDirection(room: TakeoffRectRoom) {
  const walls = new Map<(typeof directionOptions)[number], number>();
  for (const component of roomComponents(room)) {
    if (component.surface !== "wall" || !isCompassDirection(component.direction) || componentIsGeneratedEnvelopeWall(component)) continue;
    walls.set(component.direction, (walls.get(component.direction) ?? 0) + Math.max(0, component.area || 0));
  }
  return walls;
}

function openingHostWallAreaByDirection(room: TakeoffRectRoom) {
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

function roomWallReconciliation(floor: TakeoffFloor, room: TakeoffRectRoom, _floors: TakeoffFloor[] = [floor]) {
  const suggested = new Map(roomExteriorWallSuggestions(floor, room).map((entry) => [entry.direction, entry.area]));
  const assignedWalls = assignedWallAreaByDirection(room);
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

function missingSuggestedExteriorWalls(floor: TakeoffFloor, room: TakeoffRectRoom, _floors: TakeoffFloor[] = [floor]) {
  return roomWallReconciliation(floor, room).filter((entry) => entry.suggestedGross > 0 && !entry.isAssigned);
}

function wallAdjacentSpaceMismatches(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const adjacent = adjacentKindsByDirection(floor, room);
  return roomSurfaceComponents(room, "wall").flatMap((component) => {
    if (!isCompassDirection(component.direction) || componentIsGeneratedEnvelopeWall(component)) return [];
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

function payloadFloorComponentsForRoom(
  floor: TakeoffFloor,
  floors: TakeoffFloor[],
  room: TakeoffRectRoom,
  component: TakeoffRoomComponent,
) {
  if (component.surface !== "floor" || component.assembly !== "F1" || component.boundary || component.adjacency) return [component];
  const floorBelow = nearestFloorByElevation(floor, floors, "below");
  const adjacentBelowByKind = adjacentOverlapByKind(room, floorBelow);
  if ((adjacentBelowByKind.get("garage") ?? 0) <= 0.5) return [component];
  const floorComponents = floorLoadComponentsForExposure(room, floorBelow, component.area || 0, adjacentBelowByKind);
  if (!floorComponents.some((entry) => entry.boundary === "floor_over_garage")) return [component];
  return floorComponents.map((entry) => ({
    ...component,
    assembly: entry.assembly || component.assembly,
    area: entry.area,
    label: entry.label || component.label,
    adjacency: entry.adjacency,
    boundary: entry.boundary,
    panelPolygons: entry.panelPolygons ?? component.panelPolygons,
  }));
}

function payloadComponentsForRoom(floor: TakeoffFloor, room: TakeoffRectRoom, floors: TakeoffFloor[]) {
  const remainingOpenings = new Map(openingAreaByDirection(room));
  return roomComponents(room)
    .filter((component) => !component.loadExempt)
    .flatMap((component) => payloadFloorComponentsForRoom(floor, floors, room, component))
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

function payloadBandJoistComponentsForFloor(floor: TakeoffFloor, floors: TakeoffFloor[]) {
  if (!floorBandJoistEnabled(floor)) return [] as Array<{ room: TakeoffRectRoom; component: TakeoffRoomComponent }>;
  const bandJoistHeight = floorBandJoistHeight(floor);
  if (bandJoistHeight <= 0.01) return [] as Array<{ room: TakeoffRectRoom; component: TakeoffRoomComponent }>;
  if (!nearestFloorByElevation(floor, floors, "above")) return [] as Array<{ room: TakeoffRectRoom; component: TakeoffRoomComponent }>;

  const byRoomDirection = new Map<string, {
    room: TakeoffRectRoom;
    direction: NonNullable<TakeoffRoomComponent["direction"]>;
    length: number;
  }>();
  for (const room of floor.rooms) {
    for (const segment of roomExteriorSegments(floor, room)) {
      if (!isCompassDirection(segment.direction) || segment.length <= 0.25) continue;
      if (adjacentKindsForSegment(floor, segment).includes("garage")) continue;
      const key = `${room.id}:${segment.direction}`;
      const existing = byRoomDirection.get(key);
      if (existing) {
        existing.length += segment.length;
      } else {
        byRoomDirection.set(key, { room, direction: segment.direction, length: segment.length });
      }
    }
  }

  return Array.from(byRoomDirection.values())
    .map(({ room, direction, length }) => {
      const area = Number((length * bandJoistHeight).toFixed(3));
      if (area <= 0.5) return null;
      const roundedLength = Number(length.toFixed(3));
      const component: TakeoffRoomComponent = {
        id: `band-joist-${floor.id}-${room.id}-${direction}`,
        surface: "wall",
        assembly: "W1",
        direction,
        area,
        label: `${direction} band joist`,
        source: "band-joist",
        adjacency: "outside",
        boundary: "band_joist",
        geometryLabel: `${bandJoistHeight} ft band over ${roundedLength} lf exterior wall`,
      };
      return { room, component };
    })
    .filter((entry): entry is { room: TakeoffRectRoom; component: TakeoffRoomComponent } => entry != null);
}

function payloadOpenToAboveEnvelopeComponentsForRoom(floor: TakeoffFloor, room: TakeoffRectRoom, floors: TakeoffFloor[]) {
  const link = openToAboveLinkForRoom(room);
  if (!link || link.envelopeMode !== "generate_wall_extensions") {
    return [] as Array<{ room: TakeoffRectRoom; component: TakeoffRoomComponent }>;
  }
  const extensions = openToAboveWallExtensionsForRoom(floor, room, floors);
  if (extensions.length === 0) {
    return [] as Array<{ room: TakeoffRectRoom; component: TakeoffRoomComponent }>;
  }

  return extensions
    .map(({ direction, adjacency, length, addedHeight, baseHeight, effectiveHeight }) => {
      const area = Number((length * addedHeight).toFixed(3));
      if (area <= 0.5) return null;
      const roundedLength = Number(length.toFixed(3));
      const component: TakeoffRoomComponent = {
        id: `open-to-above-envelope-${floor.id}-${room.id}-${direction}-${adjacency}`,
        surface: "wall",
        assembly: defaultWallAssemblyForAdjacency(adjacency),
        direction,
        area,
        label: `${direction} open-to-above wall extension`,
        source: "open-to-above-envelope",
        adjacency,
        boundary: boundaryForAdjacency(adjacency),
        geometryLabel: `${addedHeight} ft open-to-above extension over ${roundedLength} lf ${wallAdjacencyLabel(adjacency).toLowerCase()}`,
        zMin: baseHeight,
        zMax: effectiveHeight,
      };
      return { room, component };
    })
    .filter((entry): entry is { room: TakeoffRectRoom; component: TakeoffRoomComponent } => entry != null);
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

function distanceToPolygonBoundary(point: TakeoffPoint, polygon: TakeoffPoint[]) {
  return pointsToEdges(polygon).reduce((best, edge) => (
    Math.min(best, distance(point, closestPointOnSegment(point, edge.a, edge.b)))
  ), Number.POSITIVE_INFINITY);
}

function polygonLabelPoint(points: TakeoffPoint[]) {
  if (points.length < 3) {
    return points[0] ?? { x: 0, y: 0 };
  }
  const bounds = polygonBounds(points);
  const fallback = {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
  let best = pointInPolygon(fallback, points)
    ? { point: fallback, score: distanceToPolygonBoundary(fallback, points) }
    : { point: points[0], score: 0 };
  const testPoint = (point: TakeoffPoint) => {
    if (!pointInPolygon(point, points)) return;
    const score = distanceToPolygonBoundary(point, points);
    if (score > best.score) best = { point, score };
  };
  const columns = Math.max(3, Math.min(16, Math.ceil(bounds.width / 2)));
  const rows = Math.max(3, Math.min(16, Math.ceil(bounds.depth / 2)));
  const stepX = bounds.width / columns;
  const stepY = bounds.depth / rows;

  for (let xIndex = 0; xIndex < columns; xIndex += 1) {
    for (let yIndex = 0; yIndex < rows; yIndex += 1) {
      testPoint({
        x: bounds.x + stepX * (xIndex + 0.5),
        y: bounds.y + stepY * (yIndex + 0.5),
      });
    }
  }

  let refinement = Math.max(stepX, stepY) / 2;
  for (let pass = 0; pass < 5; pass += 1) {
    const anchor = best.point;
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        testPoint({ x: anchor.x + dx * refinement, y: anchor.y + dy * refinement });
      }
    }
    refinement /= 2;
  }

  return {
    x: Number(best.point.x.toFixed(3)),
    y: Number(best.point.y.toFixed(3)),
  };
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
    const otherHeight = (isVaultCeilingType(other.ceilingType) ? other.ceilingLowHeight ?? other.ceilingHeight : other.ceilingHeight);
    if (Math.abs(otherHeight - (isVaultCeilingType(room.ceilingType) ? room.ceilingLowHeight ?? room.ceilingHeight : room.ceilingHeight)) > 0.25) return false;
    return pointsToEdges(roomCorners(other)).some((otherEdge) =>
      sharedSegmentLength(edge, otherEdge, tolerance) >= Math.max(0.5, Math.min(distance(edge.a, edge.b), 4) * 0.5)
    );
  }) && addedHeight > 0;
}

function roomsHaveMatchingVaultGeometry(first: TakeoffRectRoom, second: TakeoffRectRoom, defaultCeilingHeight = 9) {
  const firstInfo = ceilingGeometryInfo(first, defaultCeilingHeight);
  const secondInfo = ceilingGeometryInfo(second, defaultCeilingHeight);
  if (!isVaultCeilingType(firstInfo.ceilingType) || !isVaultCeilingType(secondInfo.ceilingType)) return false;
  return (
    firstInfo.ceilingType === secondInfo.ceilingType &&
    firstInfo.ridgeDirection === secondInfo.ridgeDirection &&
    Math.abs(firstInfo.lowHeight - secondInfo.lowHeight) <= 0.25 &&
    Math.abs(firstInfo.peakHeight - secondInfo.peakHeight) <= 0.25 &&
    Math.abs(firstInfo.ridgeOffset - secondInfo.ridgeOffset) <= 0.05 &&
    Math.abs(firstInfo.flatPeakWidth - secondInfo.flatPeakWidth) <= 0.25
  );
}

function vaultGableDirections(ceilingInfo: ReturnType<typeof ceilingGeometryInfo>): Array<NonNullable<TakeoffRoomComponent["direction"]>> {
  return ceilingInfo.ridgeDirection === "N-S"
    ? ["N", "S"]
    : ["E", "W"];
}

function gableEndSharesMatchingConditionedRoom(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  direction: NonNullable<TakeoffRoomComponent["direction"]>,
  defaultCeilingHeight = 9,
) {
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const roomEdges = pointsToEdges(roomCorners(room))
    .filter((edge) => edgeDirectionFromRoom(edge, room) === direction);
  if (roomEdges.length === 0) return false;

  return floor.rooms.some((other) => {
    if (other.id === room.id || !roomsHaveMatchingVaultGeometry(room, other, defaultCeilingHeight)) return false;
    const otherInfo = ceilingGeometryInfo(other, defaultCeilingHeight);
    const otherGableDirections = vaultGableDirections(otherInfo);
    return roomEdges.some((edge) =>
      pointsToEdges(roomCorners(other)).some((otherEdge) => {
        const otherDirection = edgeDirectionFromRoom(otherEdge, other);
        if (!otherGableDirections.includes(otherDirection as typeof otherGableDirections[number])) return false;
        const sharedLength = sharedSegmentLength(edge, otherEdge, tolerance);
        return sharedLength >= Math.max(0.5, Math.min(distance(edge.a, edge.b), 4) * 0.5);
      })
    );
  });
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

type RoomExteriorWallSuggestion = {
  direction: (typeof directionOptions)[number];
  length: number;
  area: number;
  geometryLabel?: string;
};

type OpenToAboveWallExtension = {
  direction: (typeof directionOptions)[number];
  adjacency: TakeoffWallAdjacency;
  length: number;
  addedHeight: number;
  baseHeight: number;
  effectiveHeight: number;
};

type OpenToAboveWallExtensionSegment = OpenToAboveWallExtension & {
  a: TakeoffPoint;
  b: TakeoffPoint;
};

function baseEnvelopeHeightForWallSuggestion(floor: TakeoffFloor, room: TakeoffRectRoom) {
  const link = openToAboveLinkForRoom(room);
  if (!link) return Math.max(0, room.ceilingHeight ?? floor.defaultCeilingHeight ?? 9);
  return baseCeilingHeightForOpenToAboveLink(floor, room, link);
}

function roomExteriorWallSuggestions(floor: TakeoffFloor, room: TakeoffRectRoom, _floors: TakeoffFloor[] = [floor]): RoomExteriorWallSuggestion[] {
  const exteriorPoints = exteriorRingPoints(floor);
  if (exteriorPoints.length < 3) return [];
  const center = {
    x: exteriorPoints.reduce((sum, point) => sum + point.x, 0) / exteriorPoints.length,
    y: exteriorPoints.reduce((sum, point) => sum + point.y, 0) / exteriorPoints.length,
  };
  const exteriorEdges = pointsToEdges(exteriorPoints);
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const baseHeight = baseEnvelopeHeightForWallSuggestion(floor, room);
  const baseLengths = new Map<(typeof directionOptions)[number], number>();
  const lengths = new Map<(typeof directionOptions)[number], number>();
  const areas = new Map<(typeof directionOptions)[number], number>();

  for (const roomEdge of pointsToEdges(roomCorners(room))) {
    for (const exteriorEdge of exteriorEdges) {
      const sharedLength = sharedSegmentLength(roomEdge, exteriorEdge, tolerance);
      if (sharedLength <= 0.25) continue;
      const direction = exteriorEdgeDirection(exteriorEdge, exteriorPoints, center, Math.max(0.75, tolerance * 2));
      baseLengths.set(direction, (baseLengths.get(direction) ?? 0) + sharedLength);
      lengths.set(direction, (lengths.get(direction) ?? 0) + sharedLength);
      areas.set(direction, (areas.get(direction) ?? 0) + sharedLength * baseHeight);
    }
  }

  return directionOptions
    .map((direction) => {
      const length = Number((lengths.get(direction) ?? 0).toFixed(3));
      const baseLength = Number((baseLengths.get(direction) ?? 0).toFixed(3));
      const area = Number((areas.get(direction) ?? 0).toFixed(3));
      const baseLabel = baseLength > 0 && baseHeight > 0 ? [`${Number(baseLength.toFixed(1))} lf x ${Number(baseHeight.toFixed(1))} ft base wall`] : [];
      return {
        direction,
        length,
        area,
        geometryLabel: baseLabel.join(" + ") || undefined,
      };
    })
    .filter((suggestion) => suggestion.length > 0.25);
}

function roomExteriorDirections(floor: TakeoffFloor, room: TakeoffRectRoom, _floors: TakeoffFloor[] = [floor]) {
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

function openToAboveWallExtensionSegmentsForRoom(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  floors: TakeoffFloor[],
  includeReviewMode = false,
): OpenToAboveWallExtensionSegment[] {
  const link = openToAboveLinkForRoom(room);
  const targetFloor = resolvedOpenToAboveTargetFloor(floor, room, floors);
  if (!link || !targetFloor) return [];
  if (!includeReviewMode && link.envelopeMode !== "generate_wall_extensions") return [];

  const baseHeight = baseEnvelopeHeightForWallSuggestion(floor, room);
  const effectiveHeight = computedOpenToAboveHeight(floor, room, floors);
  const addedHeight = Number(Math.max(0, effectiveHeight - baseHeight).toFixed(3));
  const targetExteriorPoints = exteriorRingPoints(targetFloor);
  if (addedHeight <= 0.25 || targetExteriorPoints.length < 3) return [];

  const targetCenter = {
    x: targetExteriorPoints.reduce((sum, point) => sum + point.x, 0) / targetExteriorPoints.length,
    y: targetExteriorPoints.reduce((sum, point) => sum + point.y, 0) / targetExteriorPoints.length,
  };
  const targetExteriorEdges = pointsToEdges(targetExteriorPoints);
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35, targetFloor.scale.feetPerGrid * 0.35);
  const segments: OpenToAboveWallExtensionSegment[] = [];

  for (const sourceSegment of roomExteriorSegments(floor, room)) {
    if (!isCompassDirection(sourceSegment.direction) || sourceSegment.length <= 0.25) continue;
    for (const targetEdge of targetExteriorEdges) {
      const shared = sharedSegment(sourceSegment, targetEdge, tolerance);
      if (!shared || shared.length <= 0.25) continue;
      const direction = exteriorEdgeDirection(targetEdge, targetExteriorPoints, targetCenter, Math.max(0.75, tolerance * 2));
      const adjacency = wallAdjacencyFromAdjacentKinds(adjacentKindsForSegment(targetFloor, shared));
      if (adjacency === "conditioned") continue;
      segments.push({
        a: shared.a,
        b: shared.b,
        direction,
        adjacency,
        length: Number(shared.length.toFixed(3)),
        addedHeight,
        baseHeight,
        effectiveHeight,
      });
    }
  }

  return segments;
}

function openToAboveWallExtensionsForRoom(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  floors: TakeoffFloor[],
  includeReviewMode = false,
): OpenToAboveWallExtension[] {
  const segments = openToAboveWallExtensionSegmentsForRoom(floor, room, floors, includeReviewMode);
  const byDirectionAdjacency = new Map<string, OpenToAboveWallExtension>();

  for (const segment of segments) {
    const { direction, adjacency, length, addedHeight, baseHeight, effectiveHeight } = segment;
    const key = `${direction}:${adjacency}`;
    const existing = byDirectionAdjacency.get(key);
    if (existing) {
      existing.length = Number((existing.length + length).toFixed(3));
    } else {
      byDirectionAdjacency.set(key, {
        direction,
        adjacency,
        length,
        addedHeight,
        baseHeight,
        effectiveHeight,
      });
    }
  }

  return Array.from(byDirectionAdjacency.values()).filter((entry) => entry.length > 0.25);
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

function segmentLength(segment: { a: TakeoffPoint; b: TakeoffPoint }) {
  return Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
}

function meaningfulAdjacentContactLength(segment: { a: TakeoffPoint; b: TakeoffPoint }, tolerance: number) {
  const length = segmentLength(segment);
  return Math.min(Math.max(1.25, tolerance * 2), Math.max(0.35, length * 0.35));
}

function projectedSpanOnSegment(points: TakeoffPoint[], segment: { a: TakeoffPoint; b: TakeoffPoint }) {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || points.length === 0) return 0;
  const ux = dx / length;
  const uy = dy / length;
  const projections = points.map((point) => (point.x - segment.a.x) * ux + (point.y - segment.a.y) * uy);
  const min = Math.max(0, Math.min(...projections));
  const max = Math.min(length, Math.max(...projections));
  return Math.max(0, max - min);
}

function adjacentSpaceContactLength(
  space: TakeoffAdjacentSpace,
  segment: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  const adjacentEdges = pointsToEdges(adjacentSpaceCorners(space));
  const sharedEdgeLength = adjacentEdges.reduce((sum, edge) => sum + sharedSegmentLength(segment, edge, tolerance), 0);

  const corridor = segmentCorridorPolygon(segment, tolerance);
  if (!corridor) return sharedEdgeLength;
  const corridorOverlaps = intersection([corridor], [pointsToClipPolygon(adjacentSpaceCorners(space))]);
  const corridorSpan = corridorOverlaps.reduce((sum, polygon) => {
    const outer = polygon[0] ?? [];
    return sum + projectedSpanOnSegment(clipRingToPoints(outer), segment);
  }, 0);

  return Math.min(segmentLength(segment), Math.max(sharedEdgeLength, corridorSpan));
}

function projectedSpanRangeOnSegment(points: TakeoffPoint[], segment: { a: TakeoffPoint; b: TakeoffPoint }) {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || points.length === 0) return null;
  const ux = dx / length;
  const uy = dy / length;
  const projections = points.map((point) => (point.x - segment.a.x) * ux + (point.y - segment.a.y) * uy);
  const start = Math.max(0, Math.min(...projections));
  const end = Math.min(length, Math.max(...projections));
  if (end - start <= 0.001) return null;
  return { start, end, length: end - start };
}

function adjacentSpaceContactSpan(
  space: TakeoffAdjacentSpace,
  segment: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  const ranges: Array<{ start: number; end: number; length: number }> = [];
  for (const edge of pointsToEdges(adjacentSpaceCorners(space))) {
    const shared = sharedSegment(segment, edge, tolerance);
    if (!shared || shared.length <= 0.05) continue;
    const range = projectedSpanRangeOnSegment([shared.a, shared.b], segment);
    if (range) ranges.push(range);
  }

  const corridor = segmentCorridorPolygon(segment, tolerance);
  if (corridor) {
    const corridorOverlaps = intersection([corridor], [pointsToClipPolygon(adjacentSpaceCorners(space))]);
    for (const polygon of corridorOverlaps) {
      const range = projectedSpanRangeOnSegment(clipRingToPoints(polygon[0] ?? []), segment);
      if (range) ranges.push(range);
    }
  }

  return ranges.sort((a, b) => b.length - a.length)[0] ?? null;
}

function adjacentSpaceTouchesSegment(
  space: TakeoffAdjacentSpace,
  segment: { a: TakeoffPoint; b: TakeoffPoint },
  tolerance: number,
) {
  return adjacentSpaceContactLength(space, segment, tolerance) >= meaningfulAdjacentContactLength(segment, tolerance);
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
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const totalLengthByDirection = new Map<(typeof directionOptions)[number], number>();
  const contactByDirection = new Map<(typeof directionOptions)[number], Map<TakeoffAdjacentSpaceKind, number>>();
  for (const segment of roomExteriorSegments(floor, room)) {
    totalLengthByDirection.set(segment.direction, (totalLengthByDirection.get(segment.direction) ?? 0) + segment.length);
    for (const space of floor.adjacentSpaces ?? []) {
      const contactLength = adjacentSpaceContactLength(space, segment, tolerance);
      if (contactLength < meaningfulAdjacentContactLength(segment, tolerance)) continue;
      const byKind = contactByDirection.get(segment.direction) ?? new Map<TakeoffAdjacentSpaceKind, number>();
      byKind.set(space.kind, (byKind.get(space.kind) ?? 0) + Math.min(contactLength, segment.length));
      contactByDirection.set(segment.direction, byKind);
    }
  }
  const byDirection = new Map<(typeof directionOptions)[number], TakeoffAdjacentSpaceKind[]>();
  for (const [direction, byKind] of contactByDirection) {
    const totalLength = totalLengthByDirection.get(direction) ?? 0;
    const dominantThreshold = Math.max(
      meaningfulAdjacentContactLength({ a: { x: 0, y: 0 }, b: { x: totalLength, y: 0 } }, tolerance),
      totalLength * 0.45,
    );
    const kinds = Array.from(byKind.entries())
      .filter(([, contactLength]) => contactLength >= dominantThreshold)
      .map(([kind]) => kind);
    if (kinds.length > 0) byDirection.set(direction, kinds);
  }
  return byDirection;
}

function verticalProfileRange(profile: TakeoffVerticalProfile | undefined) {
  if (!profile || profile.kind === "none" || profile.kind === "unknown") return null;
  if (profile.kind === "flat") return { zMin: profile.zMin, zMax: profile.zMax };
  if (profile.kind === "shed") return { zMin: profile.zMin, zMax: Math.max(profile.lowHeight, profile.highHeight) };
  if (profile.kind === "gable") return { zMin: profile.zMin, zMax: profile.peakHeight };
  return null;
}

function adjacentSpaceCeilingHeight(space: TakeoffAdjacentSpace, defaultCeilingHeight = 9) {
  return space.ceilingHeight ?? verticalProfileRange(space.verticalProfile)?.zMin ?? defaultCeilingHeight;
}

function adjacentSpaceCanCreateKneeWall(space: TakeoffAdjacentSpace) {
  return Boolean(space.closedCeilingBelow) && ["covered_porch", "garage", "attic"].includes(space.kind);
}

function adjacentSpaceAsRoom(space: TakeoffAdjacentSpace, defaultCeilingHeight = 9): TakeoffRectRoom {
  const profileRange = verticalProfileRange(space.verticalProfile);
  const ceilingHeight = adjacentSpaceCeilingHeight(space, defaultCeilingHeight);
  const lowHeight = ceilingHeight;
  const peakHeight = Math.max(lowHeight, space.ceilingPeakHeight ?? profileRange?.zMax ?? ceilingHeight);
  return {
    id: space.id,
    name: space.name,
    x: space.x,
    y: space.y,
    width: space.width,
    depth: space.depth,
    polygon: space.polygon,
    ceilingHeight,
    ceilingType: space.ceilingType ?? (space.verticalProfile?.kind === "gable" ? "vaulted" : "flat"),
    ceilingLowHeight: lowHeight,
    ceilingPeakHeight: peakHeight,
    ceilingRidgeDirection: space.ceilingRidgeDirection ?? (space.verticalProfile?.kind === "gable" ? space.verticalProfile.ridgeDirection : "E-W"),
    ceilingRidgeOffset: space.ceilingRidgeOffset ?? (space.verticalProfile?.kind === "gable" ? space.verticalProfile.ridgeOffset ?? 0 : 0),
    ceilingFlatPeakWidth: space.ceilingFlatPeakWidth,
    floorType: "none",
    components: [],
  };
}

function verticalProfileForAdjacentSpace(space: TakeoffAdjacentSpace, defaultCeilingHeight = 9): TakeoffVerticalProfile {
  const ceilingType = space.ceilingType ?? "flat";
  if (ceilingType === "none") return { kind: "none" };
  const ceilingHeight = adjacentSpaceCeilingHeight(space, defaultCeilingHeight);
  if (isVaultCeilingType(ceilingType)) {
    const lowHeight = ceilingHeight;
    const peakHeight = Math.max(lowHeight, space.ceilingPeakHeight ?? Math.max(lowHeight, lowHeight + 1));
    return {
      kind: "gable",
      zMin: lowHeight,
      lowHeight,
      peakHeight,
      ridgeDirection: space.ceilingRidgeDirection ?? "E-W",
      ridgeOffset: space.ceilingRidgeOffset ?? 0,
    };
  }
  return { kind: "flat", zMin: ceilingHeight, zMax: ceilingHeight };
}

function boundaryForAdjacency(adjacency: TakeoffWallAdjacency): TakeoffBoundaryType {
  if (adjacency === "attic") return "attic_knee_wall";
  if (adjacency === "garage") return "garage_wall";
  if (adjacency === "crawlspace") return "crawlspace_wall";
  if (adjacency === "conditioned") return "partition";
  if (adjacency === "outside") return "exterior";
  return "unknown";
}

function componentBoundaryForSurface(component: TakeoffRoomComponent): TakeoffBoundaryType | undefined {
  if (component.boundary) return component.boundary;
  if (component.surface === "wall") return boundaryForAdjacency(component.adjacency ?? "outside");
  if (component.surface === "floor") {
    if (component.assembly === "F2") return "slab";
    if (/garage/i.test(component.label ?? "")) return "floor_over_garage";
    if (/cantilever/i.test(component.label ?? "")) return "cantilever";
    return "framed_floor";
  }
  if (component.surface === "ceiling") return component.assembly === "C2" ? "vaulted_ceiling" : "flat_ceiling";
  return undefined;
}

function boundaryCandidatesForFloor(floor: TakeoffFloor): TakeoffBoundaryCandidate[] {
  const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
  const candidates: TakeoffBoundaryCandidate[] = [];
  for (const room of floor.rooms) {
    for (const segment of roomExteriorSegments(floor, room)) {
      for (const space of floor.adjacentSpaces ?? []) {
        if (!adjacentSpaceCanCreateKneeWall(space)) continue;
        const profileRange = verticalProfileRange(space.verticalProfile);
        if (!profileRange) continue;
        const span = adjacentSpaceContactSpan(space, segment, tolerance);
        if (!span || span.length < meaningfulAdjacentContactLength(segment, tolerance)) continue;
        const zMin = Math.max(0, profileRange.zMin);
        const zMax = Math.max(zMin, profileRange.zMax);
        const exposedZMin = zMin;
        const exposedZMax = Math.min(zMax, room.ceilingHeight);
        const exposedHeight = Math.max(0, exposedZMax - exposedZMin);
        if (exposedHeight <= 0.25) continue;

        const area = Number((span.length * exposedHeight).toFixed(3));
        if (area <= 1) continue;
        const existingWallOverlapArea = area;
        const wholeSectionArea = Number((span.length * room.ceilingHeight).toFixed(3));
        const id = [
          "boundary",
          room.id,
          space.id,
          segment.direction,
          Math.round(span.start * 10),
          Math.round(span.end * 10),
          Math.round(exposedZMin * 10),
          Math.round(exposedZMax * 10),
        ].join(":");
        candidates.push({
          id,
          roomId: room.id,
          roomName: room.name || "Room",
          adjacentSpaceId: space.id,
          adjacentSpaceName: space.name || "Covered porch",
          surface: "wall",
          direction: segment.direction,
          spanStart: Number(span.start.toFixed(3)),
          spanEnd: Number(span.end.toFixed(3)),
          zMin: Number(exposedZMin.toFixed(3)),
          zMax: Number(exposedZMax.toFixed(3)),
          area,
          existingWallOverlapArea,
          wholeSectionArea,
          recommendedAdjacency: "attic",
          recommendedAssembly: "W3",
          recommendedBoundary: "attic_knee_wall",
          reason: `${space.name || adjacentSpaceLabel(space.kind)} closed ceiling/roof profile overlaps the conditioned wall from ${Number(exposedZMin.toFixed(1))} ft to ${Number(exposedZMax.toFixed(1))} ft over ${Number(span.length.toFixed(1))} lf.`,
        });
      }
    }
  }
  return candidates;
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

function roomOverlapArea(a: TakeoffRectRoom, b: TakeoffRectRoom) {
  if (a.polygon || b.polygon) {
    return intersection(roomToClipPolygon(a), roomToClipPolygon(b))
      .reduce((sum, polygon) => sum + polygonArea(clipPolygonToPoints(polygon)), 0);
  }
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const depth = Math.max(0, Math.min(a.y + a.depth, b.y + b.depth) - Math.max(a.y, b.y));
  return width * depth;
}

function conditionedOverlapArea(room: TakeoffRectRoom, otherFloor: TakeoffFloor | undefined) {
  const roomArea = rectArea(room);
  if (!otherFloor || roomArea <= 0.25) return 0;
  const overlapArea = otherFloor.rooms.reduce((sum, otherRoom) => sum + roomOverlapArea(room, otherRoom), 0);
  return clamp(overlapArea, 0, roomArea);
}

function adjacentOverlapByKind(room: TakeoffRectRoom, otherFloor: TakeoffFloor | undefined) {
  const byKind = new Map<TakeoffAdjacentSpaceKind, number>();
  if (!otherFloor) return byKind;
  for (const space of otherFloor.adjacentSpaces ?? []) {
    const overlapArea = roomOverlapArea(room, adjacentSpaceAsRoom(space, otherFloor.defaultCeilingHeight ?? 9));
    if (overlapArea <= 0.5) continue;
    byKind.set(space.kind, (byKind.get(space.kind) ?? 0) + overlapArea);
  }
  return byKind;
}

function adjacentOverlapDescription(byKind: Map<TakeoffAdjacentSpaceKind, number>) {
  const entries = Array.from(byKind.entries())
    .filter(([kind, area]) => kind !== "conditioned_addition" && area > 0.5)
    .sort((first, second) => second[1] - first[1]);
  if (entries.length === 0) return null;
  const totalArea = entries.reduce((sum, [, area]) => sum + area, 0);
  const labels = entries.map(([kind, area]) => `${Math.round(area)} sf ${adjacentSpaceLabel(kind).toLowerCase()}`);
  return `${Math.round(totalArea)} sf over ${labels.join(", ")}`;
}

type SurfaceLoadComponentSuggestion = NonNullable<TakeoffSurfaceTreatmentSuggestion["loadComponents"]>[number];

function adjacentPanelPolygonsByKind(
  room: TakeoffRectRoom,
  otherFloor: TakeoffFloor | undefined,
  kind: TakeoffAdjacentSpaceKind,
) {
  const adjacentPolygons = (otherFloor?.adjacentSpaces ?? [])
    .filter((space) => space.kind === kind)
    .map((space) => roomToClipPolygon(adjacentSpaceAsRoom(space, otherFloor?.defaultCeilingHeight ?? 9)));
  if (adjacentPolygons.length === 0) return [];
  const [firstAdjacent, ...remainingAdjacent] = adjacentPolygons;
  let overlap = intersection([roomToClipPolygon(room)], union(firstAdjacent, ...remainingAdjacent));
  const conditionedBlockers = otherFloor?.rooms.map((otherRoom) => roomToClipPolygon(otherRoom)) ?? [];
  if (conditionedBlockers.length > 0) overlap = difference(overlap, ...conditionedBlockers);
  return simplePolygonsFromMultiPolygon(overlap)
    .map(({ polygon }) => clipPolygonToPoints(polygon))
    .filter((points) => polygonArea(points) > 0.5);
}

function floorLoadComponentsForExposure(
  room: TakeoffRectRoom,
  floorBelow: TakeoffFloor | undefined,
  exposedArea: number,
  adjacentBelowByKind: Map<TakeoffAdjacentSpaceKind, number>,
): SurfaceLoadComponentSuggestion[] {
  const boundedExposedArea = Math.max(0, exposedArea);
  if (boundedExposedArea <= 0.5) return [];
  const tolerance = verticalSurfaceTolerance(boundedExposedArea);
  const garageArea = clamp(adjacentBelowByKind.get("garage") ?? 0, 0, boundedExposedArea);
  const garagePolygons = garageArea > 0.5 ? adjacentPanelPolygonsByKind(room, floorBelow, "garage") : [];
  const garageComponent = (area: number): SurfaceLoadComponentSuggestion => ({
    area,
    assembly: "F1",
    label: "Floor over garage",
    adjacency: "garage",
    boundary: "floor_over_garage",
    panelPolygons: garagePolygons.length ? garagePolygons : undefined,
  });
  const framedComponent = (area: number): SurfaceLoadComponentSuggestion => ({
    area,
    assembly: "F1",
    label: "Framed/exposed floor",
    boundary: "framed_floor",
  });

  if (garageArea <= 0.5) return [framedComponent(boundedExposedArea)];
  if (boundedExposedArea - garageArea <= tolerance) return [garageComponent(boundedExposedArea)];
  return [
    garageComponent(Number(garageArea.toFixed(3))),
    framedComponent(Number(Math.max(0, boundedExposedArea - garageArea).toFixed(3))),
  ].filter((component) => component.area > 0.5);
}

function floorLoadActionLabel(components: SurfaceLoadComponentSuggestion[]) {
  if (components.length === 1) return (components[0].label || "framed/exposed floor").toLowerCase();
  if (components.some((component) => component.boundary === "floor_over_garage")) return "garage/exposed floor";
  return "floor exposure";
}

function exposedPanelPolygons(room: TakeoffRectRoom, otherFloor: TakeoffFloor | undefined) {
  let exposed: MultiPolygon = [roomToClipPolygon(room)];
  const blockers = otherFloor?.rooms.map((otherRoom) => roomToClipPolygon(otherRoom)) ?? [];
  if (blockers.length > 0) exposed = difference(exposed, ...blockers);
  return simplePolygonsFromMultiPolygon(exposed)
    .map(({ polygon }) => clipPolygonToPoints(polygon))
    .filter((points) => polygonArea(points) > 0.5);
}

function conditionedPanelPolygons(room: TakeoffRectRoom, otherFloor: TakeoffFloor | undefined) {
  const blockers = otherFloor?.rooms.map((otherRoom) => roomToClipPolygon(otherRoom)) ?? [];
  if (blockers.length === 0) return [];
  const [firstBlocker, ...remainingBlockers] = blockers;
  const conditioned = intersection([roomToClipPolygon(room)], union(firstBlocker, ...remainingBlockers));
  return simplePolygonsFromMultiPolygon(conditioned)
    .map(({ polygon }) => clipPolygonToPoints(polygon))
    .filter((points) => polygonArea(points) > 0.5);
}

function nearestFloorByElevation(floor: TakeoffFloor, floors: TakeoffFloor[], direction: "above" | "below") {
  const currentElevation = floor.elevation ?? 0;
  return floorsByElevation(floors).filter((entry) =>
    entry.id !== floor.id &&
    (direction === "above" ? (entry.elevation ?? 0) > currentElevation + 0.01 : (entry.elevation ?? 0) < currentElevation - 0.01)
  ).sort((first, second) =>
    direction === "above"
      ? (first.elevation ?? 0) - (second.elevation ?? 0)
      : (second.elevation ?? 0) - (first.elevation ?? 0)
  )[0];
}

function openToAboveLinkForRoom(room: TakeoffRectRoom) {
  return room.verticalLinks?.find((link) => link.type === "open_to_above");
}

function baseCeilingHeightForOpenToAboveLink(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  link: { previousCeilingHeight?: number },
) {
  return Math.max(0, link.previousCeilingHeight ?? room.ceilingHeight ?? floor.defaultCeilingHeight ?? 9);
}

function resolvedOpenToAboveTargetFloor(sourceFloor: TakeoffFloor, room: TakeoffRectRoom, floors: TakeoffFloor[]) {
  const link = openToAboveLinkForRoom(room);
  if (!link) return undefined;
  return link.targetFloorId
    ? floors.find((entry) => entry.id === link.targetFloorId)
    : nearestFloorByElevation(sourceFloor, floors, "above");
}

function computedOpenToAboveHeight(sourceFloor: TakeoffFloor, room: TakeoffRectRoom, floors: TakeoffFloor[]) {
  const targetFloor = resolvedOpenToAboveTargetFloor(sourceFloor, room, floors);
  if (!targetFloor) return room.ceilingHeight;
  const link = openToAboveLinkForRoom(room);
  const verticalSpan = Math.max(0, (targetFloor.elevation ?? 0) - (sourceFloor.elevation ?? 0));
  if (link?.ceilingAreaMode === "connected_volume") {
    const baseHeight = baseCeilingHeightForOpenToAboveLink(sourceFloor, room, link);
    return Math.max(baseHeight, verticalSpan);
  }
  return Math.max(room.ceilingHeight, verticalSpan + (targetFloor.defaultCeilingHeight ?? sourceFloor.defaultCeilingHeight ?? 9));
}

type OpenToBelowReservation = {
  sourceFloor: TakeoffFloor;
  room: TakeoffRectRoom;
  link: NonNullable<ReturnType<typeof openToAboveLinkForRoom>>;
  points: TakeoffPoint[];
  label?: string;
  connectedVolumeId?: string;
  targetRoomIds?: string[];
};

function connectedVolumeFootprintPoints(footprint: TakeoffConnectedVolume["footprints"][number], floors: TakeoffFloor[]) {
  if (footprint.polygon && footprint.polygon.length >= 3) return footprint.polygon;
  const footprintFloor = floors.find((entry) => entry.id === footprint.floorId);
  const polygons = (footprint.roomIds ?? [])
    .map((roomId) => footprintFloor?.rooms.find((room) => room.id === roomId))
    .filter((room): room is TakeoffRectRoom => Boolean(room))
    .map((room) => roomToClipPolygon(room));
  if (polygons.length === 0) return null;
  if (polygons.length === 1) return clipPolygonToPoints(polygons[0]);
  const [first, ...rest] = polygons;
  const merged = largestClipPolygon(union(first, ...rest));
  return merged ? clipPolygonToPoints(merged) : null;
}

function connectedVolumeReservationsForRoom(
  sourceFloor: TakeoffFloor,
  room: TakeoffRectRoom,
  targetFloor: TakeoffFloor,
  link: NonNullable<ReturnType<typeof openToAboveLinkForRoom>>,
  floors: TakeoffFloor[],
  connectedVolumes: TakeoffConnectedVolume[],
): OpenToBelowReservation[] {
  const reservations: OpenToBelowReservation[] = [];
  for (const volume of connectedVolumes) {
    if (!connectedVolumeIncludesRoom(volume, sourceFloor.id, room.id)) continue;
    for (const footprint of volume.footprints) {
      if (footprint.floorId !== targetFloor.id) continue;
      const points = connectedVolumeFootprintPoints(footprint, floors);
      if (!points || points.length < 3) continue;
      reservations.push({
        sourceFloor,
        room,
        link,
        points,
        label: footprint.label || volume.name,
        connectedVolumeId: volume.id,
        targetRoomIds: footprint.roomIds ?? [],
      });
    }
  }
  return reservations;
}

function openToBelowRoomsForFloor(
  targetFloor: TakeoffFloor,
  floors: TakeoffFloor[],
  connectedVolumes: TakeoffConnectedVolume[] = [],
): OpenToBelowReservation[] {
  return floors.flatMap((sourceFloor) =>
    sourceFloor.rooms.flatMap((room) => {
      const link = openToAboveLinkForRoom(room);
      if (!link || resolvedOpenToAboveTargetFloor(sourceFloor, room, floors)?.id !== targetFloor.id) return [];
      const connectedReservations = link.ceilingAreaMode === "connected_volume"
        ? connectedVolumeReservationsForRoom(sourceFloor, room, targetFloor, link, floors, connectedVolumes)
        : [];
      if (connectedReservations.length > 0) return connectedReservations;
      return [{ sourceFloor, room, link, points: roomCorners(room), targetRoomIds: [] }];
    })
  );
}

function roomReservationOverlapArea(room: TakeoffRectRoom, reservation: OpenToBelowReservation) {
  if (reservation.points.length < 3) return 0;
  return intersection(roomToClipPolygon(room), pointsToClipPolygon(reservation.points))
    .reduce((sum, polygon) => sum + polygonArea(clipPolygonToPoints(polygon)), 0);
}

function connectedVolumeIncludesRoom(volume: TakeoffConnectedVolume, floorId: string, roomId: string) {
  return volume.footprints.some((footprint) => footprint.floorId === floorId && (footprint.roomIds ?? []).includes(roomId));
}

function connectedVolumeLinksRoomPair(
  connectedVolumes: TakeoffConnectedVolume[],
  firstFloorId: string,
  firstRoomId: string,
  secondFloorId: string,
  secondRoomId: string,
) {
  return connectedVolumes.some((volume) =>
    connectedVolumeIncludesRoom(volume, firstFloorId, firstRoomId) &&
    connectedVolumeIncludesRoom(volume, secondFloorId, secondRoomId)
  );
}

type VerticalMergeRoomLabel = { key: string; label: string };

function verticalMergeRoomLabelForName(name: string): VerticalMergeRoomLabel | null {
  const normalized = normalizedRoomNameForInference(name)
    .replace(/\b(?:main|first|1st|second|2nd|upper|lower|upstairs|downstairs|floor|level|flr)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (/\bstairs?\b/.test(normalized) || /\bstair(?:way|well)s?\b/.test(normalized)) return { key: "stairs", label: "stairs" };
  if (/\bfoyers?\b/.test(normalized) || /\bentries\b/.test(normalized) || /\bentry\b/.test(normalized) || /\bopen to (?:above|below)\b/.test(normalized)) {
    return { key: "foyer", label: "foyer/open volume" };
  }
  if (/\bhalls?\b/.test(normalized) || /\bhallways?\b/.test(normalized) || /\bcorridors?\b/.test(normalized) || /\bcirculation\b/.test(normalized)) {
    return { key: "hall", label: "hall/circulation" };
  }
  if (roomNameHasLoftLabel(normalized)) return { key: "loft", label: "loft" };
  return null;
}

function verticalMergeSuggestionsForRoom(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  floors: TakeoffFloor[],
  connectedVolumes: TakeoffConnectedVolume[],
): NonNullable<TakeoffValidationIssue["verticalMergeSuggestion"]>[] {
  const label = verticalMergeRoomLabelForName(room.name);
  const floorAbove = nearestFloorByElevation(floor, floors, "above");
  if (!label || !floorAbove) return [];

  const suggestions: NonNullable<TakeoffValidationIssue["verticalMergeSuggestion"]>[] = [];
  for (const targetRoom of floorAbove.rooms) {
    const targetLabel = verticalMergeRoomLabelForName(targetRoom.name);
    if (!targetLabel || targetLabel.key !== label.key) continue;
    if (connectedVolumeLinksRoomPair(connectedVolumes, floor.id, room.id, floorAbove.id, targetRoom.id)) continue;
    const overlapArea = roomOverlapArea(room, targetRoom);
    const smallerRoomArea = Math.min(rectArea(room), rectArea(targetRoom));
    const shiftedStairAlignment = label.key === "stairs" &&
      distance(roomCenter(room), roomCenter(targetRoom)) <= Math.max(8, Math.sqrt(smallerRoomArea) * 1.5);
    if (overlapArea < Math.max(5, smallerRoomArea * 0.1) && !shiftedStairAlignment) continue;
    suggestions.push({
      action: "create-connected-volume",
      sourceFloorId: floor.id,
      sourceRoomId: room.id,
      targetFloorId: floorAbove.id,
      targetRoomId: targetRoom.id,
      defaultReportingFloorId: label.key === "stairs" ? floorAbove.id : floor.id,
      overlapArea: Number(overlapArea.toFixed(3)),
      label: label.label,
    });
  }
  return suggestions;
}

function resolveOpenToAboveLinksForFloors(sourceFloors: TakeoffFloor[]) {
  return sourceFloors.map((sourceFloor) => ({
    ...sourceFloor,
    rooms: sourceFloor.rooms.map((room) => {
      const link = openToAboveLinkForRoom(room);
      if (!link || link.targetFloorId) return room;
      const targetFloor = nearestFloorByElevation(sourceFloor, sourceFloors, "above");
      if (!targetFloor) return room;
      const resolvedLink = { ...link, targetFloorId: targetFloor.id };
      const resolvedRoom = {
        ...room,
        verticalLinks: (room.verticalLinks ?? []).map((entry) => entry.id === link.id ? resolvedLink : entry),
      };
      return {
        ...resolvedRoom,
        ceilingHeight: Number(computedOpenToAboveHeight(sourceFloor, resolvedRoom, sourceFloors).toFixed(3)),
      };
    }),
  }));
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

function buildValidation(
  floor: TakeoffFloor,
  unassignedRegions: UnassignedRegion[] = [],
  floors: TakeoffFloor[] = [floor],
  connectedVolumes: TakeoffConnectedVolume[] = [],
): TakeoffValidationIssue[] {
  const issues: TakeoffValidationIssue[] = [];
  const area = footprintArea(floor);
  const roomArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const defaultCeilingHeight = floor.defaultCeilingHeight ?? 9;
  const floorBelow = nearestFloorByElevation(floor, floors, "below");
  const floorAbove = nearestFloorByElevation(floor, floors, "above");
  const openToBelowReservations = openToBelowRoomsForFloor(floor, floors, connectedVolumes);

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
    const openToAboveLink = openToAboveLinkForRoom(room);
    const roomOpenToAbove = Boolean(openToAboveLink);
    const roomTypeSuggestion = inferredRoomTypeFromName(room.name);
    if (
      roomTypeSuggestion &&
      (room.roomType ?? "plain") !== roomTypeSuggestion.type &&
      room.roomTypeSuggestionDismissedKey !== roomTypeSuggestion.key
    ) {
      const suggestedLabel = roomTypeOptions.find((option) => option.id === roomTypeSuggestion.type)?.shortLabel ?? roomTypeLabel(roomTypeSuggestion.type);
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} name suggests ${suggestedLabel}. Select that room type for internal gains or dismiss the suggestion.`,
        issueType: "room-type-suggestion",
        target: roomTarget,
      });
    }
    const internalGainValidation = roomInternalGainValidationSuggestion(room);
    if (internalGainValidation) {
      issues.push({
        severity: "warning",
        message: internalGainValidation.message,
        issueType: "internal-gain-suggestion",
        internalGainSuggestion: internalGainValidation.suggestion,
        target: roomTarget,
      });
    }
    for (const suggestion of verticalMergeSuggestionsForRoom(floor, room, floors, connectedVolumes)) {
      const targetFloor = floors.find((entry) => entry.id === suggestion.targetFloorId);
      const targetRoom = targetFloor?.rooms.find((candidate) => candidate.id === suggestion.targetRoomId);
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} vertically aligns with ${targetRoom?.name || "a like-labeled room"} on ${targetFloor?.name || "the floor above"}. Create a connected volume and choose which floor receives the combined ${suggestion.label || "space"} attributes.`,
        issueType: "vertical-merge-suggestion",
        verticalMergeSuggestion: suggestion,
        target: roomTarget,
      });
    }
    if (!insidePerimeter(room, floor)) {
      issues.push({ severity: "error", message: `${room.name || "Room"} extends beyond the conditioned footprint by about ${Math.round(roomOutsideFootprintArea(room, floor))} sf.`, target: roomTarget });
    }
    if (room.ceilingHeight <= 0) {
      issues.push({ severity: "error", message: `${room.name || "Room"} needs a ceiling height.`, target: roomTarget });
    }
    const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
    if (openToAboveLink) {
      const effectiveHeight = computedOpenToAboveHeight(floor, room, floors);
      const baseHeight = baseCeilingHeightForOpenToAboveLink(floor, room, openToAboveLink);
      const addedHeight = Number(Math.max(0, effectiveHeight - baseHeight).toFixed(3));
      const estimatedWallArea = Number(
        openToAboveWallExtensionsForRoom(floor, room, floors, true)
          .reduce((sum, extension) => sum + extension.length * extension.addedHeight, 0)
          .toFixed(3),
      );
      const handledByConnectedVolume = openToAboveLink.ceilingAreaMode === "connected_volume";
      if (addedHeight > 0.5 && estimatedWallArea > 0.5 && openToAboveLink.envelopeMode !== "generate_wall_extensions" && !handledByConnectedVolume) {
        issues.push({
          severity: "warning",
          message: `${room.name || "Room"} is open to above by about ${Number(addedHeight.toFixed(1))} ft and may need about ${Math.round(estimatedWallArea)} sf of upper exterior wall continuation. Apply generated wall extensions or model this as a connected open volume if the upper footprint shifts.`,
          issueType: "open-to-above-envelope-suggestion",
          openToAboveEnvelopeSuggestion: {
            action: "generate-wall-extensions",
            linkId: openToAboveLink.id,
            addedHeight,
            estimatedWallArea,
            label: "Generate open-to-above wall extensions",
          },
          target: roomTarget,
        });
      }
    }
    if (!roomOpenToAbove && ceilingInfo.needsReview) {
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
    const relevantOpenToBelowReservations = openToBelowReservations.filter((reservation) =>
      !reservation.targetRoomIds?.includes(room.id) &&
      !connectedVolumeLinksRoomPair(connectedVolumes, reservation.sourceFloor.id, reservation.room.id, floor.id, room.id)
    );
    const openToBelowOverlapArea = relevantOpenToBelowReservations.reduce((sum, reservation) => sum + roomReservationOverlapArea(room, reservation), 0);
    if (openToBelowOverlapArea > verticalSurfaceTolerance(roomArea)) {
      const firstOverlappingReservation = relevantOpenToBelowReservations.find((reservation) => roomReservationOverlapArea(room, reservation) > 0.5);
      issues.push({
        severity: "error",
        message: `${room.name || "Room"} overlaps ${Math.round(openToBelowOverlapArea)} sf reserved as open-to-below from ${firstOverlappingReservation?.label || firstOverlappingReservation?.room.name || "the floor below"}. Keep this area open or adjust the room footprint.`,
        target: roomTarget,
      });
    }
    const ceilingExpectedArea = expectedSurfaceArea(room, "ceiling");
    const ceilingSurfaceRatio = roomArea > 0.5 ? ceilingExpectedArea / roomArea : 1;
    const floorArea = componentAreaTotal(room, "floor");
    const ceilingArea = componentAreaTotal(room, "ceiling");
    const floorLoadArea = componentLoadAreaTotal(room, "floor");
    const currentFloorLoadComponents = roomSurfaceComponents(room, "floor").filter((component) => !component.loadExempt);
    const ceilingLoadArea = componentLoadAreaTotal(room, "ceiling");
    const noFloorLoad = roomSurfaceNoLoad(room, "floor");
    const noCeilingLoad = roomSurfaceNoLoad(room, "ceiling");
    const planSurfaceTolerance = verticalSurfaceTolerance(roomArea);
    const ceilingSurfaceTolerance = planSurfaceTolerance * ceilingSurfaceRatio;
    const conditionedBelowArea = conditionedOverlapArea(room, floorBelow);
    const conditionedAboveArea = conditionedOverlapArea(room, floorAbove);
    const exposedFloorArea = Math.max(0, roomArea - conditionedBelowArea);
    const exposedCeilingPlanArea = Math.max(0, roomArea - conditionedAboveArea);
    const adjacentBelowByKind = adjacentOverlapByKind(room, floorBelow);
    const adjacentBelowDescription = adjacentOverlapDescription(adjacentBelowByKind);
    const exposedFloorLoadComponents = floorLoadComponentsForExposure(room, floorBelow, exposedFloorArea, adjacentBelowByKind);
    const floorLoadAction = floorLoadActionLabel(exposedFloorLoadComponents);
    const expectedGarageFloorArea = exposedFloorLoadComponents
      .filter((component) => component.boundary === "floor_over_garage")
      .reduce((sum, component) => sum + component.area, 0);
    const currentGarageFloorArea = currentFloorLoadComponents
      .filter((component) => componentIsFloorOverGarage(component))
      .reduce((sum, component) => sum + Math.max(0, component.area || 0), 0);
    const garageFloorBoundaryMismatch = expectedGarageFloorArea > planSurfaceTolerance && Math.abs(expectedGarageFloorArea - currentGarageFloorArea) > planSurfaceTolerance;
    const conditionedCeilingSurfaceArea = conditionedAboveArea * ceilingSurfaceRatio;
    const exposedCeilingArea = exposedCeilingPlanArea * ceilingSurfaceRatio;
    const exposedFloorPanelPolygons = floorBelow ? exposedPanelPolygons(room, floorBelow) : [];
    const exposedCeilingPanelPolygons = floorAbove ? exposedPanelPolygons(room, floorAbove) : [];
    const conditionedFloorPanelPolygons = floorBelow ? conditionedPanelPolygons(room, floorBelow) : [];
    const conditionedCeilingPanelPolygons = floorAbove ? conditionedPanelPolygons(room, floorAbove) : [];
    const hasConditionedBelow = conditionedBelowArea > planSurfaceTolerance;
    const hasConditionedAbove = conditionedAboveArea > planSurfaceTolerance;
    const fullyConditionedBelow = hasConditionedBelow && exposedFloorArea <= planSurfaceTolerance;
    const fullyConditionedAbove = hasConditionedAbove && exposedCeilingPlanArea <= planSurfaceTolerance;
    if (fullyConditionedBelow && room.floorType !== "none") {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is covered by conditioned space below on ${floorBelow?.name || "the floor below"}. Review floor treatment; it likely should be no floor load instead of ${room.floorType === "framed" ? "framed/exposed floor" : "slab"}.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "floor",
          action: "none",
          roomArea,
          conditionedArea: conditionedBelowArea,
          exposedArea: 0,
          adjacentFloorName: floorBelow?.name,
        },
        target: roomTarget,
      });
    }
    if (!fullyConditionedBelow && hasConditionedBelow && (noFloorLoad || room.floorType === "slab" || Math.abs(floorLoadArea - exposedFloorArea) > planSurfaceTolerance || garageFloorBoundaryMismatch)) {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is partially covered by conditioned space below on ${floorBelow?.name || "the floor below"}: about ${Math.round(conditionedBelowArea)} sf conditioned and ${Math.round(exposedFloorArea)} sf exposed. Apply the ${floorLoadAction} split if only the exposed portion should carry floor load.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "floor",
          action: "partial",
          roomArea,
          conditionedArea: conditionedBelowArea,
          exposedArea: exposedFloorArea,
          adjacentFloorName: floorBelow?.name,
          assembly: exposedFloorLoadComponents[0]?.assembly ?? "F1",
          label: exposedFloorLoadComponents[0]?.label ?? "Framed/exposed floor",
          adjacency: exposedFloorLoadComponents[0]?.adjacency,
          boundary: exposedFloorLoadComponents[0]?.boundary,
          loadComponents: exposedFloorLoadComponents,
          panelPolygons: exposedFloorPanelPolygons,
          conditionedPanelPolygons: conditionedFloorPanelPolygons,
        },
        target: roomTarget,
      });
    }
    if (!hasConditionedBelow && floorBelow && (room.floorType !== "framed" || Math.abs(floorLoadArea - roomArea) > planSurfaceTolerance || garageFloorBoundaryMismatch)) {
      const currentFloorTreatment = room.floorType === "none"
        ? "no floor load"
        : room.floorType === "framed"
          ? `${Math.round(floorLoadArea)} sf framed/exposed floor`
          : "slab";
      issues.push({
        severity: "warning",
        message: adjacentBelowDescription
          ? `${room.name || "Room"} has ${adjacentBelowDescription} on ${floorBelow.name || "the floor below"}. Apply ${floorLoadAction} if this area should carry an F1 floor load instead of ${currentFloorTreatment}.`
          : `${room.name || "Room"} does not overlap conditioned space below on ${floorBelow.name || "the floor below"}. Apply framed/exposed floor if this area should carry an F1 floor load instead of ${currentFloorTreatment}.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "floor",
          action: "full",
          roomArea,
          conditionedArea: 0,
          exposedArea: roomArea,
          adjacentFloorName: floorBelow.name,
          assembly: exposedFloorLoadComponents[0]?.assembly ?? "F1",
          label: exposedFloorLoadComponents[0]?.label ?? "Framed/exposed floor",
          adjacency: exposedFloorLoadComponents[0]?.adjacency,
          boundary: exposedFloorLoadComponents[0]?.boundary,
          loadComponents: exposedFloorLoadComponents,
          panelPolygons: exposedFloorPanelPolygons,
        },
        target: roomTarget,
      });
    }
    if (!floorBelow && room.floorType === "none") {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is on the lowest modeled floor with no floor treatment. Review floor treatment; choose slab or framed/exposed floor as appropriate.`,
        target: roomTarget,
      });
    }
    if (fullyConditionedAbove && (room.ceilingType ?? "flat") !== "none") {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is covered by conditioned space above on ${floorAbove?.name || "the floor above"}. Review ceiling treatment; it likely should be no ceiling load instead of ${(room.ceilingType ?? "flat") === "vaulted" ? "vaulted" : "flat"} ceiling.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "ceiling",
          action: "none",
          roomArea: ceilingExpectedArea,
          conditionedArea: conditionedCeilingSurfaceArea,
          exposedArea: 0,
          adjacentFloorName: floorAbove?.name,
        },
        target: roomTarget,
      });
    }
    if (!fullyConditionedAbove && hasConditionedAbove && (noCeilingLoad || Math.abs(ceilingLoadArea - exposedCeilingArea) > ceilingSurfaceTolerance)) {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is partially covered by conditioned space above on ${floorAbove?.name || "the floor above"}: about ${Math.round(conditionedCeilingSurfaceArea)} sf conditioned ceiling surface and ${Math.round(exposedCeilingArea)} sf exposed to attic/roof. Apply the split if only the exposed portion should carry ceiling load.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "ceiling",
          action: "partial",
          roomArea: ceilingExpectedArea,
          conditionedArea: conditionedCeilingSurfaceArea,
          exposedArea: exposedCeilingArea,
          adjacentFloorName: floorAbove?.name,
          assembly: isVaultCeilingType(ceilingInfo.ceilingType) ? "C2" : "C1",
          label: isVaultCeilingType(ceilingInfo.ceilingType) ? "Vaulted ceiling exposed to attic/roof" : "Ceiling exposed to attic/roof",
          panelPolygons: exposedCeilingPanelPolygons,
          conditionedPanelPolygons: conditionedCeilingPanelPolygons,
        },
        target: roomTarget,
      });
    }
    if (!hasConditionedAbove && floorAbove && (room.ceilingType ?? "flat") === "none") {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} does not overlap conditioned space above on ${floorAbove.name || "the floor above"}. Review ceiling treatment; choose flat/vaulted ceiling or attic/roof treatment as appropriate.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "ceiling",
          action: "full",
          roomArea: ceilingExpectedArea,
          conditionedArea: 0,
          exposedArea: ceilingExpectedArea,
          adjacentFloorName: floorAbove.name,
          assembly: isVaultCeilingType(ceilingInfo.ceilingType) ? "C2" : "C1",
          label: isVaultCeilingType(ceilingInfo.ceilingType) ? "Vaulted ceiling" : "Flat ceiling",
          panelPolygons: exposedCeilingPanelPolygons,
        },
        target: roomTarget,
      });
    }
    if (!floorAbove && (room.ceilingType ?? "flat") === "none") {
      issues.push({
        severity: "warning",
        message: `${room.name || "Room"} is on the highest modeled floor with no ceiling treatment. Review ceiling treatment; choose flat/vaulted ceiling or attic/roof treatment as appropriate.`,
        issueType: "surface-treatment-suggestion",
        surfaceTreatmentSuggestion: {
          surface: "ceiling",
          action: "full",
          roomArea: ceilingExpectedArea,
          conditionedArea: 0,
          exposedArea: ceilingExpectedArea,
          assembly: "C1",
          label: "Flat ceiling",
          panelPolygons: exposedCeilingPanelPolygons,
        },
        target: roomTarget,
      });
    }
    const exteriorDirections = roomExteriorDirections(floor, room, floors);
    const openingAreas = openingAreaByDirection(room);
    const openingHostWallAreas = openingHostWallAreaByDirection(room);
    const missingSuggestedWalls = missingSuggestedExteriorWalls(floor, room, floors);
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
    for (const reconciliation of roomWallReconciliation(floor, room, floors)) {
      if (!reconciliation.isAssigned || reconciliation.suggestedGross <= 0) continue;
      const delta = reconciliation.assignedGross - reconciliation.suggestedGross;
      const tolerance = Math.max(1, reconciliation.suggestedGross * 0.02);
      if (Math.abs(delta) <= tolerance) continue;
      const component = roomSurfaceComponents(room, "wall").find((entry) =>
        entry.direction === reconciliation.direction && !componentIsGeneratedEnvelopeWall(entry)
      );
      if (!component) continue;
      const recommendation = recommendedWallTreatment(reconciliation.adjacentKinds, component.assembly || "W1");
      issues.push({
        severity: "error",
        message: `${room.name || "Room"} has ${Math.round(reconciliation.assignedGross)} sf assigned to ${reconciliation.direction} wall, but detected exterior/load-bearing area is ${Math.round(reconciliation.suggestedGross)} sf after the current footprint. Apply the detected wall slice.`,
        issueType: "wall-component-geometry-suggestion",
        wallComponentGeometrySuggestion: {
          action: "resize",
          componentId: component.id,
          direction: reconciliation.direction,
          area: reconciliation.suggestedGross,
          assembly: recommendation.assembly,
          adjacency: recommendation.adjacency,
          label: `${reconciliation.direction} ${recommendation.label.toLowerCase()}`,
        },
        target: roomTarget,
      });
    }
    if (!noFloorLoad && floorArea > roomArea + 0.5) {
      issues.push({ severity: "error", message: `${room.name || "Room"} floor components exceed room area by ${Math.round(floorArea - roomArea)} sf.`, target: roomTarget });
    }
    if (!noCeilingLoad && ceilingArea > ceilingExpectedArea + 0.5) {
      issues.push({ severity: "error", message: `${room.name || "Room"} ceiling components exceed expected ${isVaultCeilingType(ceilingInfo.ceilingType) ? "vaulted ceiling" : "ceiling"} area by ${Math.round(ceilingArea - ceilingExpectedArea)} sf.`, target: roomTarget });
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
        const removableWallComponent = component.surface === "wall" && !componentIsGeneratedEnvelopeWall(component);
        issues.push({
          severity: "error",
          message: `${room.name || "Room"} cannot assign a ${componentSurfaceLabel(component.surface).toLowerCase()} to ${component.direction}; detected exterior/load-bearing directions: ${exteriorDirections.join(", ") || "none"}.`,
          issueType: removableWallComponent ? "wall-component-geometry-suggestion" : undefined,
          wallComponentGeometrySuggestion: removableWallComponent
            ? {
                action: "remove",
                componentId: component.id,
                direction: component.direction,
                label: component.label || `${component.direction} wall`,
              }
            : undefined,
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
          issues.push({
            severity: "warning",
            message: `${room.name || "Room"} has glass on a covered-porch ${component.direction} wall. Mark it shaded if Salas treats that opening as shaded.`,
            issueType: "glass-treatment-suggestion",
            glassTreatmentSuggestion: {
              action: "shade",
              componentId: component.id,
              direction: component.direction,
              solarDirection: "Shaded",
              label: defaultOpeningLabel("glass", "Shaded"),
            },
            target: roomTarget,
          });
        }
      }
    }
    for (const [direction, openingArea] of openingAreas) {
      const wallArea = openingHostWallAreas.get(direction) ?? 0;
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
    if (!noCeilingLoad && ceilingArea < ceilingExpectedArea - 0.5) {
      issues.push({ severity: "warning", message: `${room.name || "Room"} ceiling components leave ${Math.round(ceilingExpectedArea - ceilingArea)} sf unassigned.`, target: roomTarget });
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

  for (const candidate of boundaryCandidatesForFloor(floor)) {
    if (floor.boundaryCandidateResolutions?.[candidate.id]) continue;
    issues.push({
      severity: "warning",
      message: `${candidate.roomName} ${candidate.direction} wall may need ${Math.round(candidate.area)} sf of attic/knee-wall treatment. ${candidate.reason}`,
      issueType: "boundary-candidate",
      boundaryCandidateId: candidate.id,
      target: { type: "room", roomId: candidate.roomId },
    });
  }

  return issues;
}

function buildVrcPayload(project: TakeoffProject) {
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
  const floorLookup = new Map(project.floors.map((floor) => [floor.id, floor]));
  const roomLookup = new Map<string, { floor: TakeoffFloor; room: TakeoffRectRoom }>();
  for (const floor of project.floors) {
    for (const room of floor.rooms) {
      roomLookup.set(`${floor.id}:${room.id}`, { floor, room });
    }
  }
  const connectedVolumeMetadata = (project.connectedVolumes ?? []).map((volume) => {
    const reportingFloor = volume.reportingFloorId ? floorLookup.get(volume.reportingFloorId) : undefined;
    const assignedRoom = volume.assignedRoomId
      ? Array.from(roomLookup.values()).find(({ room }) => room.id === volume.assignedRoomId)?.room
      : undefined;
    return {
      id: volume.id,
      name: volume.name,
      envelope_mode: volume.envelopeMode ?? "review",
      reporting_floor_id: volume.reportingFloorId,
      reporting_floor_name: reportingFloor?.name,
      assigned_room_id: volume.assignedRoomId,
      assigned_room_name: assignedRoom?.name,
      footprints: volume.footprints.map((footprint) => {
        const footprintFloor = floorLookup.get(footprint.floorId);
        const roomNames = (footprint.roomIds ?? [])
          .map((roomId) => roomLookup.get(`${footprint.floorId}:${roomId}`)?.room.name)
          .filter((name): name is string => Boolean(name));
        return {
          id: footprint.id,
          floor_id: footprint.floorId,
          floor_name: footprintFloor?.name,
          role: footprint.role,
          room_ids: footprint.roomIds ?? [],
          room_names: roomNames,
          area: footprint.areaOverride ?? (footprint.polygon && footprint.polygon.length >= 3 ? polygonArea(footprint.polygon) : undefined),
          label: footprint.label,
        };
      }),
    };
  });
  const levels = project.floors.map((floor, index) => {
    const zoneId = `zone-${floor.id}`;
    const rooms = floor.rooms.map((room) => {
      const effectiveCeilingHeight = computedOpenToAboveHeight(floor, room, project.floors);
      const conditionedFloorArea = rectArea(room);
      const lightingBasis = roomLightingBasis(room);
      const lightingArea = roomLightingArea(room);
      const internalGains = roomInternalGainsForExport(room, conditionedFloorArea, lightingArea);
      return {
        name: room.name,
        floor_area: conditionedFloorArea,
        lighting_area: lightingArea,
        ceiling_height: effectiveCeilingHeight,
        volume: conditionedFloorArea * effectiveCeilingHeight,
        lighting_basis: lightingBasis,
        room_type: internalGains.roomType,
        ...(internalGains.peopleOverride != null ? { people_override: internalGains.peopleOverride } : {}),
        ...(internalGains.applianceWattsOverride != null ? { appliance_watts_override: internalGains.applianceWattsOverride } : {}),
        unit_id: "unit-whole-house",
        zone_id: zoneId,
      };
    });
    const lineItemFromComponent = (room: TakeoffRectRoom, component: TakeoffRoomComponent) => ({
      name: `${room.name} ${component.label || component.assembly}`,
      kind: componentPayloadKind(component.surface),
      room_name: room.name,
      assembly: component.assembly,
      direction: payloadDirectionForComponent(component),
      area: component.area,
      ...(componentBoundaryForSurface(component) ? { boundary: componentBoundaryForSurface(component) } : {}),
      ...(component.source ? { source: component.source } : {}),
      ...(component.adjacency ? { adjacency: component.adjacency } : {}),
      ...(component.geometryLabel ? { geometry_label: component.geometryLabel } : {}),
      ...(component.solarDirection ? { solar_direction: component.solarDirection, wall_direction: component.direction } : {}),
    });
    const roomLineItems = floor.rooms.flatMap((room) =>
      payloadComponentsForRoom(floor, room, project.floors).map((component) => lineItemFromComponent(room, component))
    );
    const openToAboveLineItems = floor.rooms.flatMap((room) =>
      payloadOpenToAboveEnvelopeComponentsForRoom(floor, room, project.floors)
        .map(({ room: componentRoom, component }) => lineItemFromComponent(componentRoom, component))
    );
    const bandJoistLineItems = payloadBandJoistComponentsForFloor(floor, project.floors)
      .map(({ room, component }) => lineItemFromComponent(room, component));
    const lineItems = [...roomLineItems, ...openToAboveLineItems, ...bandJoistLineItems];
    return {
      name: floor.name || `Floor ${index + 1}`,
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
    };
  });
  const bedroomCount = project.floors.reduce((sum, floor) => sum + floor.rooms.filter((room) => room.roomType === "bedroom").length, 0);
  const resolvedBedroomCount = Math.max(bedroomCount, 1);
  const resolvedVentilationCfm = project.ventilationCfm || ventilationCfmForBedrooms(resolvedBedroomCount);

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
        ...(connectedVolumeMetadata.length ? { connected_volumes: connectedVolumeMetadata } : {}),
        units: [{ id: "unit-whole-house", name: "Whole House", selected_tons: 1, selected_kw: 5 }],
        zones: project.floors.map((floor, index) => ({ id: `zone-${floor.id}`, name: floor.name || `Floor ${index + 1}`, unit_id: "unit-whole-house" })),
        takeoff_schema_version: project.schemaVersion,
      },
      selected_system_tons: 1,
      selected_system_kw: 5,
      assemblies: assemblyMap,
      levels,
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
    conditioned_addition: { fill: "rgba(75, 137, 98, 0.2)", stroke: "#4b8962" },
    exterior: { fill: "rgba(93, 106, 118, 0.14)", stroke: "#5d6a76" },
  };
  return colors[kind];
}

function normalizeFloor(rawFloor: Partial<TakeoffFloor> | undefined): TakeoffFloor {
  const fallback = makeInitialFloor();
  if (!rawFloor) return fallback;
  const rawBandJoistHeight = rawFloor.bandJoistHeight;
  const bandJoistHeight = rawBandJoistHeight == null
    ? fallback.bandJoistHeight
    : !rawFloor.bandJoistHeightUserSet && (Math.abs(rawBandJoistHeight - 1) <= 0.001 || Math.abs(rawBandJoistHeight - 0.75) <= 0.001)
      ? defaultBandJoistHeight
      : rawBandJoistHeight;
  const bandJoistEnabled = rawFloor.bandJoistEnabled ?? (rawBandJoistHeight == null ? true : Math.max(0, bandJoistHeight ?? 0) > 0.01);
  return {
    ...fallback,
    ...rawFloor,
    id: rawFloor.id || fallback.id,
    name: rawFloor.name || fallback.name,
    authoringMode: rawFloor.authoringMode || fallback.authoringMode,
    coordinateSpace: rawFloor.coordinateSpace || "world_feet",
    elevation: rawFloor.elevation ?? fallback.elevation,
    floorToFloorHeight: rawFloor.floorToFloorHeight ?? fallback.floorToFloorHeight,
    bandJoistEnabled,
    bandJoistHeight,
    bandJoistHeightUserSet: rawFloor.bandJoistHeightUserSet ?? false,
    floorAlignmentSnapEnabled: rawFloor.floorAlignmentSnapEnabled ?? fallback.floorAlignmentSnapEnabled,
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
  const floors = rawProject.floors?.length
    ? rawProject.floors.map((floor) => normalizeFloor(floor))
    : [normalizeFloor(undefined)];
  return makeTakeoffProject(
    rawProject.name || "Takeoff V1 Draft",
    rawProject.location ?? "",
    rawProject.dimensionInputMode === "feet-inches" ? "feet-inches" : "decimal",
    Boolean(rawProject.mechanicalVentilation),
    Number(rawProject.ventilationCfm ?? 0),
    frontDoorFaces,
    floors,
    rawProject.componentSchedule?.length ? rawProject.componentSchedule : defaultComponentSchedule,
    rawProject.connectedVolumes ?? [],
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

function dedupePolygonPointsForRender(points: TakeoffPoint[], duplicateTolerance = 0.02) {
  const roundedPoints = points.map((point) => ({ x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) }));
  const deduped = roundedPoints.filter((point, index, entries) => index === 0 || distance(point, entries[index - 1]) > duplicateTolerance);
  if (deduped.length > 2 && distance(deduped[0], deduped[deduped.length - 1]) <= duplicateTolerance) deduped.pop();
  return deduped;
}

function cleanPolygonPointsForRender(points: TakeoffPoint[]) {
  const deduped = dedupePolygonPointsForRender(points);
  if (deduped.length <= 3) return deduped;
  const simplified = simplifyPolygonPoints(deduped, { duplicateTolerance: 0.02, collinearTolerance: 0.08, shortSegmentTolerance: 0.18 });
  const originalArea = polygonArea(deduped);
  const simplifiedArea = polygonArea(simplified);
  const areaDelta = Math.abs(simplifiedArea - originalArea);
  if (originalArea > 0.5 && areaDelta > Math.max(0.5, originalArea * 0.08)) return deduped;
  return simplified;
}

function sortedUniqueCoordinates(values: number[]) {
  return values
    .map((value) => Number(value.toFixed(3)))
    .sort((a, b) => a - b)
    .filter((value, index, coords) => index === 0 || Math.abs(value - coords[index - 1]) > 0.02);
}

const maxPlanSurfaceCellSize = 8;

function subdividedSurfaceCoordinates(values: number[]) {
  const coordinates = sortedUniqueCoordinates(values);
  const subdivided = new Set(coordinates);
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index];
    const end = coordinates[index + 1];
    const span = end - start;
    if (span <= maxPlanSurfaceCellSize) continue;
    const stepCount = Math.ceil(span / maxPlanSurfaceCellSize);
    for (let stepIndex = 1; stepIndex < stepCount; stepIndex += 1) {
      subdivided.add(Number((start + (span * stepIndex) / stepCount).toFixed(3)));
    }
  }
  return sortedUniqueCoordinates(Array.from(subdivided));
}

function triangleCentroid(triangle: TakeoffPoint[]) {
  return {
    x: triangle.reduce((sum, point) => sum + point.x, 0) / triangle.length,
    y: triangle.reduce((sum, point) => sum + point.y, 0) / triangle.length,
  };
}

function triangleFitsInsidePolygon(triangle: TakeoffPoint[], polygon: TakeoffPoint[]) {
  const triangleArea = polygonArea(triangle);
  if (triangle.length !== 3 || triangleArea <= 0.001) return false;
  if (!pointInPolygon(triangleCentroid(triangle), polygon)) return false;
  const clipped = intersection([pointsToClipPolygon(triangle)], [pointsToClipPolygon(polygon)]);
  const clippedArea = clipped.reduce((sum, piece) => sum + clipPolygonArea(piece), 0);
  return clippedArea >= triangleArea - Math.max(0.01, triangleArea * 0.02);
}

function triangulateSimplePlanPolygon(points: TakeoffPoint[], containingPolygon = points) {
  const cleanedPoints = cleanPolygonPointsForRender(points);
  if (cleanedPoints.length < 3) return [] as TakeoffPoint[][];
  const contour = cleanedPoints.map((point) => new THREE.Vector2(point.x, point.y));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, [])
    .map((triangle) => triangle.map((index) => cleanedPoints[index]))
    .filter((triangle) => triangleFitsInsidePolygon(triangle, containingPolygon));
  if (triangles.length > 0) return triangles;
  return cleanedPoints.slice(1, -1).map((_, index) => [cleanedPoints[0], cleanedPoints[index + 1], cleanedPoints[index + 2]])
    .filter((triangle) => triangleFitsInsidePolygon(triangle, containingPolygon));
}

function triangulatedPlanPolygon(points: TakeoffPoint[]) {
  const cleanedPoints = cleanPolygonPointsForRender(points);
  if (cleanedPoints.length < 3) return [] as TakeoffPoint[][];
  const bounds = polygonBounds(cleanedPoints);
  const xCoords = subdividedSurfaceCoordinates([bounds.x, bounds.x + bounds.width, ...cleanedPoints.map((point) => point.x)]);
  const yCoords = subdividedSurfaceCoordinates([bounds.y, bounds.y + bounds.depth, ...cleanedPoints.map((point) => point.y)]);
  const sourcePolygon = pointsToClipPolygon(cleanedPoints);
  const triangles: TakeoffPoint[][] = [];

  for (let xIndex = 0; xIndex < xCoords.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < yCoords.length - 1; yIndex += 1) {
      const cell = {
        x: xCoords[xIndex],
        y: yCoords[yIndex],
        width: xCoords[xIndex + 1] - xCoords[xIndex],
        depth: yCoords[yIndex + 1] - yCoords[yIndex],
      };
      if (cell.width <= 0.02 || cell.depth <= 0.02) continue;
      const clipped = intersection([pointsToClipPolygon(rectToPoints(cell))], [sourcePolygon]);
      for (const polygon of clipped.flatMap(simplePolygonsFromClipPolygon)) {
        const piecePoints = clipPolygonToPoints(polygon);
        triangles.push(...triangulateSimplePlanPolygon(piecePoints, cleanedPoints));
      }
    }
  }

  return triangles.length > 0 ? triangles : triangulateSimplePlanPolygon(cleanedPoints, cleanedPoints);
}

function createPlanSurfaceMesh(points: TakeoffPoint[], center: TakeoffPoint, material: THREE.Material, heightAtPoint: (point: TakeoffPoint) => number) {
  const positions: number[] = [];
  for (const triangle of triangulatedPlanPolygon(points)) {
    for (const point of triangle) {
      positions.push(point.x - center.x, heightAtPoint(point), point.y - center.y);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function createHorizontalShapeMesh(points: TakeoffPoint[], center: TakeoffPoint, height: number, material: THREE.Material) {
  return createPlanSurfaceMesh(points, center, material, () => height);
}

function clippedPanelPolygonsForRoom(panel: TakeoffPoint[], room: TakeoffRectRoom) {
  const panelPoints = cleanPolygonPointsForRender(panel);
  const roomPoints = cleanPolygonPointsForRender(roomCorners(room));
  if (panelPoints.length < 3 || roomPoints.length < 3) return [];
  return intersection([pointsToClipPolygon(panelPoints)], [pointsToClipPolygon(roomPoints)])
    .flatMap(simplePolygonsFromClipPolygon)
    .map((polygon) => clipPolygonToPoints(polygon))
    .filter((points) => points.length >= 3 && polygonArea(points) > 0.5);
}

function createHorizontalOutline(points: TakeoffPoint[], center: TakeoffPoint, height: number, material: THREE.LineBasicMaterial) {
  const cleanPoints = cleanPolygonPointsForRender(points);
  const vertices = cleanPoints.map((point) => modelPoint(point, center, height));
  if (vertices[0]) vertices.push(vertices[0].clone());
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), material);
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
  const minCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const maxCoord = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const coord = ceilingInfo.ridgeDirection === "E-W" ? point.y : point.x;
  const flatStartCoord = minCoord + ceilingInfo.firstRun;
  const flatEndCoord = maxCoord - ceilingInfo.secondRun;
  if (ceilingInfo.flatPeakWidth > 0.01 && coord >= flatStartCoord && coord <= flatEndCoord) return ceilingInfo.peakHeight;
  const run = coord <= flatStartCoord ? ceilingInfo.firstRun : ceilingInfo.secondRun;
  if (run <= 0.01) return ceilingInfo.peakHeight;
  const ratio = coord <= flatStartCoord
    ? (coord - minCoord) / run
    : (maxCoord - coord) / run;
  return ceilingInfo.lowHeight + peakDelta * clamp(ratio, 0, 1);
}

function createSlopedShapeMesh(points: TakeoffPoint[], center: TakeoffPoint, bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>, material: THREE.Material) {
  return createPlanSurfaceMesh(points, center, material, (point) => vaultedRoofHeightAtPoint(point, bounds, ceilingInfo));
}

function splitVaultFootprintAtRidge(points: TakeoffPoint[], bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>) {
  if (!isVaultCeilingType(ceilingInfo.ceilingType)) return [points];
  const padding = Math.max(bounds.width, bounds.depth, 1) + 4;
  const crossMin = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const crossMax = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const breakCoords = ceilingInfo.flatPeakWidth > 0.01
    ? [crossMin + ceilingInfo.firstRun, crossMax - ceilingInfo.secondRun]
    : [crossMin + bounds[ceilingInfo.ridgeDirection === "E-W" ? "depth" : "width"] * ceilingInfo.ridgeRatio];
  const ranges = [crossMin, ...breakCoords, crossMax]
    .filter((coord, index, coords) => index === 0 || Math.abs(coord - coords[index - 1]) > 0.01);
  const splitRects = ranges.slice(0, -1)
    .map((start, index) => {
      const end = ranges[index + 1];
      if (end - start <= 0.01) return null;
      return ceilingInfo.ridgeDirection === "E-W"
        ? { x: bounds.x - padding, y: start, width: bounds.width + padding * 2, depth: end - start }
        : { x: start, y: bounds.y - padding, width: end - start, depth: bounds.depth + padding * 2 };
    })
    .filter((rect): rect is PlanRect => rect != null);
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
  const roomPlanArea = Math.max(0.001, rectArea(room));
  return splitVaultFootprintAtRidge(points, bounds, ceilingInfo).map((panelPoints) => {
    const panelBounds = polygonBounds(panelPoints);
    const panelCenterCoord = ceilingInfo.ridgeDirection === "E-W"
      ? panelBounds.y + panelBounds.depth / 2
      : panelBounds.x + panelBounds.width / 2;
    const crossMin = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
    const crossMax = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
    const flatStartCoord = crossMin + ceilingInfo.firstRun;
    const flatEndCoord = crossMax - ceilingInfo.secondRun;
    const flatPanel = ceilingInfo.flatPeakWidth > 0.01 && panelCenterCoord >= flatStartCoord && panelCenterCoord <= flatEndCoord;
    const panelPlanArea = polygonArea(panelPoints);
    const area = flatPanel
      ? panelPlanArea
      : ceilingInfo.vaultedSlopedCeilingArea * (panelPlanArea / roomPlanArea);
    return {
      mesh: createSlopedShapeMesh(panelPoints, center, bounds, ceilingInfo, material),
      kind: "ceiling",
      label: flatPanel ? "Flat peak ceiling plane" : "Vaulted ceiling plane",
      surface: "ceiling",
      area: Number(area.toFixed(3)),
      assembly: flatPanel ? "C1" : "C2",
    };
  });
}

function splitEdgeAtVaultRidge(edge: { a: TakeoffPoint; b: TakeoffPoint }, bounds: PlanRect, ceilingInfo: ReturnType<typeof ceilingGeometryInfo>) {
  const aCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.a.y : edge.a.x;
  const bCoord = ceilingInfo.ridgeDirection === "E-W" ? edge.b.y : edge.b.x;
  if (Math.abs(aCoord - bCoord) <= 0.001) return [edge.a, edge.b];
  const crossMin = ceilingInfo.ridgeDirection === "E-W" ? bounds.y : bounds.x;
  const crossMax = ceilingInfo.ridgeDirection === "E-W" ? bounds.y + bounds.depth : bounds.x + bounds.width;
  const breakCoords = ceilingInfo.flatPeakWidth > 0.01
    ? [crossMin + ceilingInfo.firstRun, crossMax - ceilingInfo.secondRun]
    : [crossMin + (crossMax - crossMin) * ceilingInfo.ridgeRatio];
  const splitPoints = [
    edge.a,
    ...breakCoords
      .filter((coord) => (coord - aCoord) * (coord - bCoord) < 0)
      .map((coord) => {
        const ratio = (coord - aCoord) / (bCoord - aCoord);
        return {
          x: edge.a.x + (edge.b.x - edge.a.x) * ratio,
          y: edge.a.y + (edge.b.y - edge.a.y) * ratio,
        };
      }),
    edge.b,
  ];
  return splitPoints.sort((first, second) => (
    distance(edge.a, first) - distance(edge.a, second)
  ));
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
  const wallHeight = Math.max(0.5, room.ceilingHeight);
  const topPadding = 0.25;
  const bottomPadding = 0.25;
  const visibleHeight = component.surface === "door"
    ? Math.min(height, Math.max(0.5, wallHeight - topPadding))
    : Math.min(height, Math.max(0.5, wallHeight - topPadding - bottomPadding));
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
    ? visibleHeight / 2
    : Math.min(
        Math.max(3 + visibleHeight / 2, bottomPadding + visibleHeight / 2),
        Math.max(bottomPadding + visibleHeight / 2, wallHeight - topPadding - visibleHeight / 2),
      );
  const group = new THREE.Group();
  group.position.set(edge.point.x + outward.x * 0.16 - center.x, verticalCenter, edge.point.y + outward.y * 0.16 - center.y);
  group.rotation.y = -Math.atan2(dz, dx);
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.22, visibleHeight + 0.22), frameMaterial);
  frame.position.z = -0.01;
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, visibleHeight), material);
  fill.position.z = 0.01;
  group.add(frame);
  group.add(fill);
  group.userData.roomId = room.id;
  return group;
}

function referencePlaneForFloor(floor: TakeoffFloor, center: TakeoffPoint, texture: THREE.Texture) {
  const source = referenceSourceSizeForFloor(floor);
  const width = Math.max(source.width, 1);
  const depth = Math.max(source.depth, 1);
  const crop = floor.reference?.crop;
  const display = referenceDisplayRectForFloor(floor);
  const transform = { ...defaultAlignmentTransform(), ...(floor.alignment?.transform ?? {}) };
  const displayScale = Math.max(0.0001, transform.scale || 1);
  const displayWidth = display.width * displayScale;
  const displayDepth = display.depth * displayScale;
  const displayX = display.x + transform.translateX;
  const displayY = display.y + transform.translateY;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  if (crop && crop.width > 0 && crop.depth > 0) {
    const repeatX = crop.width / width;
    const repeatY = crop.depth / depth;
    if (floor.reference?.mirroredX) {
      texture.repeat.set(-repeatX, repeatY);
      texture.offset.set((crop.x + crop.width) / width, 1 - (crop.y + crop.depth) / depth);
    } else {
      texture.repeat.set(repeatX, repeatY);
      texture.offset.set(crop.x / width, 1 - (crop.y + crop.depth) / depth);
    }
  } else {
    texture.repeat.set(1, 1);
    texture.offset.set(0, 0);
  }
  texture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    depthWrite: false,
    opacity: 0.52,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const geometry = new THREE.PlaneGeometry(Math.max(displayWidth, 1), Math.max(displayDepth, 1));
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(displayX + displayWidth / 2 - center.x, -0.08, displayY + displayDepth / 2 - center.y);
  return mesh;
}

function bandJoistMeshesForFloor(floor: TakeoffFloor, center: TakeoffPoint, topOffset: number, material: THREE.Material) {
  if (!floorBandJoistEnabled(floor)) return [];
  const height = floorBandJoistHeight(floor);
  if (height <= 0.01) return [];
  const bandJoistPanels: THREE.Mesh[] = [];
  const edges = floor.rooms.length
    ? floor.rooms
        .filter((room) => room.floorType !== "slab")
        .flatMap((room) => roomExteriorSegments(floor, room).map((segment) => ({ a: segment.a, b: segment.b })))
    : pointsToEdges(cleanPolygonPointsForRender(exteriorRingPoints(floor)));
  for (const edge of edges) {
    if (distance(edge.a, edge.b) <= 0.01) continue;
    bandJoistPanels.push(createPanelMesh([
      modelPoint(edge.a, center, topOffset - height),
      modelPoint(edge.b, center, topOffset - height),
      modelPoint(edge.b, center, topOffset),
      modelPoint(edge.a, center, topOffset),
    ], material));
  }
  return bandJoistPanels;
}

function floorHasRenderableBandJoist(floor: TakeoffFloor) {
  if (!floorBandJoistEnabled(floor) || floorBandJoistHeight(floor) <= 0.01) return false;
  if (floor.rooms.length) return floor.rooms.some((room) => room.floorType !== "slab" && roomExteriorSegments(floor, room).length > 0);
  return cleanPolygonPointsForRender(exteriorRingPoints(floor)).length >= 3;
}

function floorHasRenderable3DGeometry(floor: TakeoffFloor) {
  if (floor.exteriorPolygon.length >= 3) return true;
  if (floor.conditionedPerimeter.width > 0 && floor.conditionedPerimeter.depth > 0) return true;
  if (floor.rooms.some((room) => cleanPolygonPointsForRender(roomCorners(room)).length >= 3 && rectArea(room) > 0.5)) return true;
  return (floor.adjacentSpaces ?? []).some((space) => cleanPolygonPointsForRender(adjacentSpaceCorners(space)).length >= 3 && rectArea(space) > 0.5);
}

function roomRidgePoints(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number) {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  if (!isVaultCeilingType(ceilingInfo.ceilingType)) return null;
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

function trayWallMeshPartsForRoom(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number, kneeWallMaterial: THREE.Material): ModelMeshPart[] {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  if (ceilingInfo.ceilingType !== "tray") return [];
  const parts: ModelMeshPart[] = [];
  for (let stepIndex = 0; stepIndex < ceilingInfo.traySteps; stepIndex += 1) {
    const offset = ceilingInfo.trayOffset + stepIndex;
    const points = trayBoundaryPoints(room, offset);
    if (points.length < 3) continue;
    const bottom = room.ceilingHeight + stepIndex * trayStepHeight();
    const top = bottom + trayStepHeight();
    for (const edge of pointsToEdges(points)) {
      parts.push({
        mesh: createPanelMesh([
          modelPoint(edge.a, center, bottom),
          modelPoint(edge.b, center, bottom),
          modelPoint(edge.b, center, top),
          modelPoint(edge.a, center, top),
        ], kneeWallMaterial),
        kind: "knee-wall",
        label: `Tray step ${stepIndex + 1} knee-wall panel`,
        surface: "wall",
        area: Number(distance(edge.a, edge.b).toFixed(3)),
        source: "tray-knee-wall",
        geometryLabel: `Tray ceiling knee wall - step ${stepIndex + 1}`,
      });
    }
  }
  return parts;
}

function ceilingWallMeshPartsForRoom(room: TakeoffRectRoom, center: TakeoffPoint, defaultCeilingHeight: number, kneeWallMaterial: THREE.Material): ModelMeshPart[] {
  const ceilingInfo = ceilingGeometryInfo(room, defaultCeilingHeight);
  if (isVaultCeilingType(ceilingInfo.ceilingType)) return vaultedWallMeshPartsForRoom(room, center, defaultCeilingHeight, kneeWallMaterial);
  if (ceilingInfo.ceilingType === "tray") return trayWallMeshPartsForRoom(room, center, defaultCeilingHeight, kneeWallMaterial);
  return raisedWallMeshPartsForRoom(room, center, defaultCeilingHeight, room.ceilingHeight, kneeWallMaterial);
}

function openToAboveWallExtensionMeshPartsForRoom(
  floor: TakeoffFloor,
  room: TakeoffRectRoom,
  floors: TakeoffFloor[],
  center: TakeoffPoint,
  material: THREE.Material,
): ModelMeshPart[] {
  return openToAboveWallExtensionSegmentsForRoom(floor, room, floors, true).map((segment) => ({
    mesh: createPanelMesh([
      modelPoint(segment.a, center, segment.baseHeight),
      modelPoint(segment.b, center, segment.baseHeight),
      modelPoint(segment.b, center, segment.effectiveHeight),
      modelPoint(segment.a, center, segment.effectiveHeight),
    ], material),
    kind: "load-wall",
    label: `${segment.direction} open-to-above wall extension`,
    surface: "wall",
    direction: segment.direction,
    area: Number((segment.length * segment.addedHeight).toFixed(3)),
    assembly: defaultWallAssemblyForAdjacency(segment.adjacency),
    source: "open-to-above-envelope",
    geometryLabel: `${segment.addedHeight} ft open-to-above extension over ${Number(segment.length.toFixed(1))} lf ${wallAdjacencyLabel(segment.adjacency).toLowerCase()}`,
  }));
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
  floors,
  activeFloorId,
  referenceUrl,
  referenceUrls,
  floorViewOptions,
  componentSchedule,
  selectedRoomId,
  connectedVolumes,
  onSelectRoom,
  onUpdateFloorViewOptions,
  onAssignSurfaceComponent,
}: {
  floor: TakeoffFloor;
  floors: TakeoffFloor[];
  activeFloorId: string;
  referenceUrl: string;
  referenceUrls: Record<string, string>;
  floorViewOptions: Record<string, FloorViewOptions>;
  componentSchedule: TakeoffComponentDefinition[];
  selectedRoomId: string | null;
  connectedVolumes: TakeoffConnectedVolume[];
  onSelectRoom: (roomId: string) => void;
  onUpdateFloorViewOptions: (floorId: string, patch: Partial<FloorViewOptions>) => void;
  onAssignSurfaceComponent: (selection: ModelSurfaceSelection, assembly: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const spanRef = useRef(40);
  const modelViewStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Record<ModelLayerKey, boolean>>({
    reference: true,
    windows: true,
    doors: true,
    ceilings: true,
    floors: true,
    walls: true,
    interiorWalls: false,
    adjacentSpaces: true,
    bandJoists: true,
  });
  const [selectedSurface, setSelectedSurface] = useState<ModelSurfaceSelection | null>(null);
  const [hoveredSurface, setHoveredSurface] = useState<ModelSurfaceSelection | null>(null);
  const [selectedSurfaceAssembly, setSelectedSurfaceAssembly] = useState("");
  const [sceneRevision, setSceneRevision] = useState(0);

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
    modelViewStateRef.current = { position: camera.position.clone(), target: controls.target.clone() };
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setHoveredSurface(null);
    setSelectedSurface(null);
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
    const previousModelViewState = modelViewStateRef.current;
    if (previousModelViewState) camera.position.copy(previousModelViewState.position);
    else camera.position.set(span * 0.82, span * 0.72, span * 1.05);
    camera.lookAt(previousModelViewState?.target ?? new THREE.Vector3(0, 4, 0));
    const controls = new OrbitControls(camera, renderer.domElement);
    if (previousModelViewState) controls.target.copy(previousModelViewState.target);
    else controls.target.set(0, 4, 0);
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
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const absoluteLowestFloorElevation = Math.min(...floors.map((entry) => entry.elevation ?? 0));
    const lowestFloors = floors.filter((entry) => Math.abs((entry.elevation ?? 0) - absoluteLowestFloorElevation) <= 0.01);
    const modelBaseLift = lowestFloors.some((entry) => floorHasRenderableBandJoist(entry))
      ? Math.max(...lowestFloors.map((entry) => floorHasRenderableBandJoist(entry) ? floorBandJoistHeight(entry) : 0))
      : 0;
    const activeFloorYOffset = ((floor.elevation ?? 0) - absoluteLowestFloorElevation) + modelBaseLift;
    const activeOptions = floorViewOptions[activeFloorId] ?? defaultFloorViewOptions();
    if (activeOptions.visible && activeOptions.reference && visibleLayers.reference && referenceUrl) {
      const texture = loader.load(referenceUrl);
      loadedTextures.push(texture);
      const plane = referencePlaneForFloor(floor, center, texture);
      plane.position.y += activeFloorYOffset;
      scene.add(plane);
    }

    const exteriorMaterial = new THREE.MeshBasicMaterial({ color: 0x8fc0b0, depthWrite: false, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const floorMaterial = new THREE.MeshPhongMaterial({ color: 0xc8ddd5, depthWrite: false, transparent: true, opacity: 0.38, side: THREE.DoubleSide });
    const wallMaterial = new THREE.MeshPhongMaterial({ color: 0x8fb4c8, depthWrite: false, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
    const interiorWallMaterial = new THREE.MeshPhongMaterial({ color: 0x9aa9b5, depthWrite: false, transparent: true, opacity: 0.16, side: THREE.DoubleSide });
    const selectedWallMaterial = new THREE.MeshPhongMaterial({ color: 0x6aa0d6, depthWrite: false, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ceilingMaterial = new THREE.MeshPhongMaterial({ color: 0xcfe3ec, depthWrite: false, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
    const adjacentFloorMaterial = new THREE.MeshPhongMaterial({ color: 0xd9c274, depthWrite: false, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
    const adjacentWallMaterial = new THREE.MeshPhongMaterial({ color: 0xc59a49, depthWrite: false, transparent: true, opacity: 0.24, side: THREE.DoubleSide });
    const adjacentSelectedMaterial = new THREE.MeshPhongMaterial({ color: 0xd48a2b, depthWrite: false, transparent: true, opacity: 0.42, side: THREE.DoubleSide });
    const adjacentCeilingMaterial = new THREE.MeshPhongMaterial({ color: 0xe2d8a2, depthWrite: false, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
    const kneeWallMaterial = new THREE.MeshPhongMaterial({ color: 0xb35b2f, depthWrite: false, transparent: true, opacity: 0.3, side: THREE.DoubleSide });
    const glassMaterial = new THREE.MeshBasicMaterial({ color: 0x4f9ab8, transparent: true, opacity: 0.78, side: THREE.DoubleSide });
    const doorMaterial = new THREE.MeshBasicMaterial({ color: 0x6f5228, transparent: true, opacity: 0.82, side: THREE.DoubleSide });
    const openingFrameMaterial = new THREE.MeshBasicMaterial({ color: 0x2f3b1f, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xb35b2f });
    const hoverOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x0f5fa8, depthTest: false, transparent: true, opacity: 0.95 });
    const ghostReferenceMaterial = new THREE.MeshBasicMaterial({ color: 0x4a6070, depthWrite: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const ghostRoomMaterial = new THREE.MeshPhongMaterial({ color: 0x8799a8, depthWrite: false, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const ghostExteriorMaterial = new THREE.MeshBasicMaterial({ color: 0x5f7f9b, depthWrite: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const passiveWallMaterial = new THREE.MeshPhongMaterial({ color: 0x6f8797, depthWrite: false, transparent: true, opacity: 0.24, side: THREE.DoubleSide });
    const passiveInteriorWallMaterial = new THREE.MeshPhongMaterial({ color: 0x7e8a94, depthWrite: false, transparent: true, opacity: 0.12, side: THREE.DoubleSide });
    const passiveCeilingMaterial = new THREE.MeshPhongMaterial({ color: 0xaebfc8, depthWrite: false, transparent: true, opacity: 0.14, side: THREE.DoubleSide });
    const passiveKneeWallMaterial = new THREE.MeshPhongMaterial({ color: 0x8f6658, depthWrite: false, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const passiveGlassMaterial = new THREE.MeshBasicMaterial({ color: 0x4f9ab8, transparent: true, opacity: 0.38, side: THREE.DoubleSide });
    const passiveDoorMaterial = new THREE.MeshBasicMaterial({ color: 0x6f5228, transparent: true, opacity: 0.36, side: THREE.DoubleSide });
    const bandJoistMaterial = new THREE.MeshPhongMaterial({ color: 0x587082, depthWrite: false, transparent: true, opacity: 0.34, side: THREE.DoubleSide });
    const openVoidMaterial = new THREE.MeshBasicMaterial({ color: 0x2d78ad, depthWrite: false, transparent: true, opacity: 0.22, side: THREE.DoubleSide });
    const openVoidOutlineMaterial = new THREE.LineBasicMaterial({ color: 0x0f5fa8, depthTest: false, transparent: true, opacity: 0.88 });
    const renderOpenToBelowMarkers = (targetFloor: TakeoffFloor, yOffset: number) => {
      if (!visibleLayers.floors) return;
      for (const reservation of openToBelowRoomsForFloor(targetFloor, floors, connectedVolumes)) {
        const points = cleanPolygonPointsForRender(reservation.points);
        if (points.length < 3) continue;
        const marker = createHorizontalShapeMesh(points, center, yOffset + 0.08, openVoidMaterial);
        marker.userData.modelSurface = {
          roomId: reservation.room.id,
          roomName: reservation.label || reservation.room.name,
          kind: "floor",
          label: `Open to below - ${reservation.label || reservation.room.name || "room"}`,
          surface: "floor",
          area: Number(polygonArea(points).toFixed(3)),
        } satisfies ModelSurfaceSelection;
        scene.add(marker);
        scene.add(createHorizontalOutline(points, center, yOffset + 0.105, openVoidOutlineMaterial));
      }
    };
    if (visibleLayers.bandJoists) {
      for (const sourceFloor of floors) {
        const options = floorViewOptions[sourceFloor.id] ?? defaultFloorViewOptions();
        const sourceElevation = sourceFloor.elevation ?? 0;
        if (!options.visible) continue;
        const yOffset = (sourceElevation - absoluteLowestFloorElevation) + modelBaseLift;
        for (const mesh of bandJoistMeshesForFloor(sourceFloor, center, yOffset, bandJoistMaterial)) scene.add(mesh);
      }
    }

    for (const otherFloor of floors) {
      if (otherFloor.id === activeFloorId) continue;
      const options = floorViewOptions[otherFloor.id] ?? defaultFloorViewOptions();
      if (!options.visible) continue;
      const yOffset = ((otherFloor.elevation ?? 0) - absoluteLowestFloorElevation) + modelBaseLift;
      if (visibleLayers.reference && options.reference && referenceUrls[otherFloor.id]) {
        const texture = loader.load(referenceUrls[otherFloor.id]);
        loadedTextures.push(texture);
        const plane = referencePlaneForFloor(otherFloor, center, texture);
        plane.position.y += yOffset;
        scene.add(plane);
      } else if (visibleLayers.reference && options.reference) {
        const display = referenceDisplayRectForFloor(otherFloor);
        const geometry = new THREE.PlaneGeometry(Math.max(display.width, 1), Math.max(display.depth, 1));
        geometry.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geometry, ghostReferenceMaterial);
        mesh.position.set(display.x + display.width / 2 - center.x, yOffset - 0.08, display.y + display.depth / 2 - center.y);
        scene.add(mesh);
      }
      renderOpenToBelowMarkers(otherFloor, yOffset);
      if (visibleLayers.floors) {
        const otherExteriorPoints = exteriorRingPoints(otherFloor);
        if (otherExteriorPoints.length >= 3) {
          const mesh = createHorizontalShapeMesh(otherExteriorPoints, center, yOffset - 0.015, ghostExteriorMaterial);
          scene.add(mesh);
        }
      }
      for (const sourceRoom of otherFloor.rooms) {
        const baseWallHeight = baseEnvelopeHeightForWallSuggestion(otherFloor, sourceRoom);
        const room = { ...sourceRoom, ceilingHeight: computedOpenToAboveHeight(otherFloor, sourceRoom, floors) };
        const wallRoom = { ...room, ceilingHeight: baseWallHeight };
        const points = cleanPolygonPointsForRender(roomCorners(room));
        if (points.length < 3) continue;
        if (visibleLayers.floors) scene.add(createHorizontalShapeMesh(points, center, yOffset + 0.025, ghostRoomMaterial));
        if (visibleLayers.walls) {
          for (const segment of roomExteriorSegments(otherFloor, room)) {
            const wallMesh = wallMeshForEdge(segment.a, segment.b, center, Math.max(baseWallHeight, 0.1), passiveWallMaterial);
            wallMesh.position.y += yOffset;
            scene.add(wallMesh);
          }
          const generatedWallParts = ceilingWallMeshPartsForRoom(wallRoom, center, otherFloor.defaultCeilingHeight ?? 9, passiveKneeWallMaterial);
          for (const part of generatedWallParts) {
            part.mesh.position.y += yOffset;
            scene.add(part.mesh);
          }
          for (const part of openToAboveWallExtensionMeshPartsForRoom(otherFloor, sourceRoom, floors, center, passiveWallMaterial)) {
            part.mesh.position.y += yOffset;
            scene.add(part.mesh);
          }
        }
        if (visibleLayers.interiorWalls) {
          const exposedSegments = roomExteriorSegments(otherFloor, room);
          const tolerance = Math.max(0.35, otherFloor.scale.feetPerGrid * 0.35);
          for (const edge of pointsToEdges(points)) {
            const isLoadWall = exposedSegments.some((segment) => sharedSegmentLength(edge, segment, tolerance) > 0.25);
            if (isLoadWall) continue;
            const wallMesh = wallMeshForEdge(edge.a, edge.b, center, Math.max(baseWallHeight, 0.1), passiveInteriorWallMaterial);
            wallMesh.position.y += yOffset;
            scene.add(wallMesh);
          }
        }
        if (visibleLayers.ceilings && (room.ceilingType ?? "flat") !== "none") {
          const ceilingInfo = ceilingGeometryInfo(room, otherFloor.defaultCeilingHeight ?? 9);
          if (isVaultCeilingType(ceilingInfo.ceilingType)) {
            for (const part of slopedCeilingMeshPartsForRoom(room, center, otherFloor.defaultCeilingHeight ?? 9, passiveCeilingMaterial)) {
              part.mesh.position.y += yOffset;
              scene.add(part.mesh);
            }
          } else {
            const ceilingComponents = roomSurfaceComponents(room, "ceiling").filter((component) => !component.loadExempt);
            const panelComponents = ceilingComponents.filter((component) => component.panelPolygons?.length);
            if (panelComponents.length > 0) {
              for (const component of panelComponents) {
                for (const panel of component.panelPolygons ?? []) {
                  for (const clippedPanel of clippedPanelPolygonsForRoom(panel, room)) {
                    scene.add(createHorizontalShapeMesh(clippedPanel, center, yOffset + room.ceilingHeight, passiveCeilingMaterial));
                  }
                }
              }
            } else if (ceilingComponents.length > 0) {
              scene.add(createHorizontalShapeMesh(points, center, yOffset + room.ceilingHeight, passiveCeilingMaterial));
            }
          }
          const ridge = roomRidgePoints(room, center, otherFloor.defaultCeilingHeight ?? 9);
          if (ridge) {
            const ridgeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ridge), lineMaterial);
            ridgeLine.position.y += yOffset;
            scene.add(ridgeLine);
          }
        }
        for (const component of roomSurfaceComponents(room, "glass").concat(roomSurfaceComponents(room, "door"))) {
          if (component.surface === "glass" && !visibleLayers.windows) continue;
          if (component.surface === "door" && !visibleLayers.doors) continue;
          const openingMesh = openingMeshForComponent(component, room, center, component.surface === "glass" ? passiveGlassMaterial : passiveDoorMaterial, openingFrameMaterial);
          if (openingMesh) {
            openingMesh.position.y += yOffset;
            scene.add(openingMesh);
          }
        }
      }
      if (visibleLayers.adjacentSpaces) {
        for (const space of otherFloor.adjacentSpaces ?? []) {
          const sourceRoom = adjacentSpaceAsRoom(space, otherFloor.defaultCeilingHeight ?? 9);
          const rawPoints = roomCorners(sourceRoom);
          const points = cleanPolygonPointsForRender(rawPoints);
          if (points.length < 3) continue;
          const room = points.length !== rawPoints.length ? { ...sourceRoom, polygon: points } : sourceRoom;
          const ceilingInfo = ceilingGeometryInfo(room, otherFloor.defaultCeilingHeight ?? 9);
          const adjacentWallHeight = isVaultCeilingType(ceilingInfo.ceilingType) ? ceilingInfo.lowHeight : room.ceilingHeight;
          const porchRoofOnly = space.kind === "covered_porch";
          if (visibleLayers.floors && !porchRoofOnly) scene.add(createHorizontalShapeMesh(roomCorners(room), center, yOffset + 0.02, adjacentFloorMaterial));
          if (visibleLayers.walls && !porchRoofOnly) {
            for (const edge of pointsToEdges(roomCorners(room))) {
              const wallMesh = wallMeshForEdge(edge.a, edge.b, center, Math.max(adjacentWallHeight, 0.1), adjacentWallMaterial);
              wallMesh.position.y += yOffset;
              scene.add(wallMesh);
            }
          }
          if (visibleLayers.ceilings && (room.ceilingType ?? "flat") !== "none") {
            if (isVaultCeilingType(ceilingInfo.ceilingType)) {
              for (const part of slopedCeilingMeshPartsForRoom(room, center, otherFloor.defaultCeilingHeight ?? 9, adjacentCeilingMaterial)) {
                part.mesh.position.y += yOffset;
                scene.add(part.mesh);
              }
            } else {
              scene.add(createHorizontalShapeMesh(roomCorners(room), center, yOffset + room.ceilingHeight, adjacentCeilingMaterial));
            }
            const ridge = roomRidgePoints(room, center, otherFloor.defaultCeilingHeight ?? 9);
            if (ridge) {
              const ridgeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ridge), lineMaterial);
              ridgeLine.position.y += yOffset;
              scene.add(ridgeLine);
            }
          }
        }
      }
    }

    const exteriorPoints = exteriorRingPoints(floor);
    if (activeOptions.visible && exteriorPoints.length >= 3) scene.add(createHorizontalShapeMesh(exteriorPoints, center, activeFloorYOffset - 0.02, exteriorMaterial));
    if (activeOptions.visible) renderOpenToBelowMarkers(floor, activeFloorYOffset);

    for (const [index, sourceRoom] of (activeOptions.visible ? floor.rooms : []).entries()) {
      const rawPoints = roomCorners(sourceRoom);
      const renderPoints = cleanPolygonPointsForRender(rawPoints);
      const modelCeilingHeight = computedOpenToAboveHeight(floor, sourceRoom, floors);
      const room = renderPoints.length >= 3 && renderPoints.length !== rawPoints.length
        ? { ...sourceRoom, polygon: renderPoints, ceilingHeight: modelCeilingHeight }
        : { ...sourceRoom, ceilingHeight: modelCeilingHeight };
      const points = roomCorners(room);
      const color = new THREE.Color(roomColor(index));
      const roomFloorMaterial = floorMaterial.clone();
      roomFloorMaterial.color = color;
      const roomCeilingMaterial = ceilingMaterial.clone();
      roomCeilingMaterial.color = color;

      if (visibleLayers.floors) {
        const floorMesh = createHorizontalShapeMesh(points, center, activeFloorYOffset, roomFloorMaterial);
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
          const baseWallHeight = baseEnvelopeHeightForWallSuggestion(floor, sourceRoom);
          const wallMesh = wallMeshForEdge(segment.a, segment.b, center, Math.max(baseWallHeight, 0.1), room.id === selectedRoomId ? selectedWallMaterial : wallMaterial);
          wallMesh.position.y += activeFloorYOffset;
          wallMesh.userData.roomId = room.id;
          wallMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "load-wall",
            label: `${segment.direction ?? "Exterior"} load wall`,
            surface: "wall",
            direction: segment.direction,
            area: Number((segment.length * Math.max(baseWallHeight, 0)).toFixed(3)),
            assembly: roomSurfaceComponents(room, "wall").find((component) => wallCanHostOpenings(component) && component.direction === segment.direction)?.assembly,
          } satisfies ModelSurfaceSelection;
          scene.add(wallMesh);
        }
        const baseWallHeight = baseEnvelopeHeightForWallSuggestion(floor, sourceRoom);
        const wallRoom = { ...room, ceilingHeight: baseWallHeight };
        const generatedWallParts = ceilingWallMeshPartsForRoom(wallRoom, center, floor.defaultCeilingHeight ?? 9, kneeWallMaterial);
        for (const part of generatedWallParts) {
          const component = roomSurfaceComponents(room, "wall").find((candidate) =>
            componentIsGeneratedCeilingWall(candidate) &&
            (!part.source || candidate.source === part.source) &&
            (!part.direction || candidate.direction === part.direction)
          );
          part.mesh.position.y += activeFloorYOffset;
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
        for (const part of openToAboveWallExtensionMeshPartsForRoom(floor, sourceRoom, floors, center, room.id === selectedRoomId ? selectedWallMaterial : wallMaterial)) {
          const component = roomSurfaceComponents(room, "wall").find((candidate) =>
            candidate.source === part.source &&
            candidate.direction === part.direction &&
            (!part.geometryLabel || candidate.geometryLabel === part.geometryLabel)
          );
          part.mesh.position.y += activeFloorYOffset;
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
        const baseWallHeight = baseEnvelopeHeightForWallSuggestion(floor, sourceRoom);
        const exposedSegments = roomExteriorSegments(floor, room);
        const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
        for (const edge of pointsToEdges(points)) {
          const isLoadWall = exposedSegments.some((segment) => sharedSegmentLength(edge, segment, tolerance) > 0.25);
          if (isLoadWall) continue;
          const wallMesh = wallMeshForEdge(edge.a, edge.b, center, Math.max(baseWallHeight, 0.1), interiorWallMaterial);
          wallMesh.position.y += activeFloorYOffset;
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
        if (isVaultCeilingType(ceilingInfo.ceilingType)) {
          for (const part of slopedCeilingMeshPartsForRoom(room, center, floor.defaultCeilingHeight ?? 9, roomCeilingMaterial)) {
            part.mesh.position.y += activeFloorYOffset;
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
          const ceilingComponents = roomSurfaceComponents(room, "ceiling").filter((component) => !component.loadExempt);
          const panelComponents = ceilingComponents.filter((component) => component.panelPolygons?.length);
          if (panelComponents.length > 0) {
            for (const component of panelComponents) {
              const clippedPanels = (component.panelPolygons ?? []).flatMap((panel) => clippedPanelPolygonsForRoom(panel, room));
              const componentPanelArea = clippedPanels.reduce((sum, panel) => sum + polygonArea(panel), 0);
              for (const panel of clippedPanels) {
                const panelArea = componentPanelArea > 0.5
                  ? (component.area || 0) * (polygonArea(panel) / componentPanelArea)
                  : polygonArea(panel);
                const panelMesh = createHorizontalShapeMesh(panel, center, activeFloorYOffset + room.ceilingHeight, roomCeilingMaterial);
                panelMesh.userData.roomId = room.id;
                panelMesh.userData.modelSurface = {
                  roomId: room.id,
                  roomName: room.name,
                  kind: "ceiling",
                  label: component.label || "Ceiling surface",
                  surface: "ceiling",
                  area: Number(panelArea.toFixed(3)),
                  assembly: component.assembly,
                  componentId: component.id,
                } satisfies ModelSurfaceSelection;
                scene.add(panelMesh);
              }
            }
          } else if (ceilingComponents.length > 0) {
            const ceilingMesh = createHorizontalShapeMesh(points, center, activeFloorYOffset + room.ceilingHeight, roomCeilingMaterial);
            ceilingMesh.userData.roomId = room.id;
            ceilingMesh.userData.modelSurface = {
              roomId: room.id,
              roomName: room.name,
              kind: "ceiling",
              label: "Ceiling surface",
              surface: "ceiling",
              area: Number(rectArea(room).toFixed(3)),
              assembly: ceilingComponents[0]?.assembly,
            } satisfies ModelSurfaceSelection;
            scene.add(ceilingMesh);
          }
        }
      }

      const ridge = roomRidgePoints(room, center, floor.defaultCeilingHeight ?? 9);
      if (visibleLayers.ceilings && ridge) {
        const ridgeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ridge), lineMaterial);
        ridgeLine.position.y += activeFloorYOffset;
        scene.add(ridgeLine);
      }

      for (const component of roomSurfaceComponents(room, "glass").concat(roomSurfaceComponents(room, "door"))) {
        if (component.surface === "glass" && !visibleLayers.windows) continue;
        if (component.surface === "door" && !visibleLayers.doors) continue;
        const openingMesh = openingMeshForComponent(component, room, center, component.surface === "glass" ? glassMaterial : doorMaterial, openingFrameMaterial);
        if (openingMesh) {
          openingMesh.position.y += activeFloorYOffset;
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

    for (const space of activeOptions.visible && visibleLayers.adjacentSpaces ? floor.adjacentSpaces ?? [] : []) {
      const sourceRoom = adjacentSpaceAsRoom(space, floor.defaultCeilingHeight ?? 9);
      const rawPoints = roomCorners(sourceRoom);
      const renderPoints = cleanPolygonPointsForRender(rawPoints);
      if (renderPoints.length < 3) continue;
      const room = renderPoints.length !== rawPoints.length ? { ...sourceRoom, polygon: renderPoints } : sourceRoom;
      const points = roomCorners(room);
      const selected = room.id === selectedRoomId;
      const area = Number(rectArea(room).toFixed(3));
      const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
      const adjacentWallHeight = isVaultCeilingType(ceilingInfo.ceilingType) ? ceilingInfo.lowHeight : room.ceilingHeight;
      const porchRoofOnly = space.kind === "covered_porch";

      if (visibleLayers.floors && !porchRoofOnly) {
        const floorMesh = createHorizontalShapeMesh(points, center, activeFloorYOffset - 0.01, selected ? adjacentSelectedMaterial : adjacentFloorMaterial);
        floorMesh.userData.roomId = room.id;
        floorMesh.userData.modelSurface = {
          roomId: room.id,
          roomName: room.name,
          kind: "floor",
          label: `${adjacentSpaceLabel(space.kind)} footprint`,
          surface: "floor",
          area,
        } satisfies ModelSurfaceSelection;
        scene.add(floorMesh);
      }

      if (visibleLayers.walls && !porchRoofOnly) {
        for (const edge of pointsToEdges(points)) {
          const wallMesh = wallMeshForEdge(edge.a, edge.b, center, Math.max(adjacentWallHeight, 0.1), selected ? adjacentSelectedMaterial : adjacentWallMaterial);
          wallMesh.position.y += activeFloorYOffset;
          wallMesh.userData.roomId = room.id;
          wallMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "interior-wall",
            label: `${adjacentSpaceLabel(space.kind)} side`,
          } satisfies ModelSurfaceSelection;
          scene.add(wallMesh);
        }
      }

      if (visibleLayers.ceilings && (room.ceilingType ?? "flat") !== "none") {
        if (isVaultCeilingType(ceilingInfo.ceilingType)) {
          for (const part of slopedCeilingMeshPartsForRoom(room, center, floor.defaultCeilingHeight ?? 9, adjacentCeilingMaterial)) {
            part.mesh.position.y += activeFloorYOffset;
            part.mesh.userData.roomId = room.id;
            part.mesh.userData.modelSurface = {
              roomId: room.id,
              roomName: room.name,
              kind: part.kind,
              label: `${adjacentSpaceLabel(space.kind)} vaulted roof`,
              surface: "ceiling",
              area: part.area,
            } satisfies ModelSurfaceSelection;
            scene.add(part.mesh);
          }
        } else {
          const ceilingMesh = createHorizontalShapeMesh(points, center, activeFloorYOffset + room.ceilingHeight, adjacentCeilingMaterial);
          ceilingMesh.userData.roomId = room.id;
          ceilingMesh.userData.modelSurface = {
            roomId: room.id,
            roomName: room.name,
            kind: "ceiling",
            label: `${adjacentSpaceLabel(space.kind)} ceiling / roof`,
            surface: "ceiling",
            area,
          } satisfies ModelSurfaceSelection;
          scene.add(ceilingMesh);
        }
        const ridge = roomRidgePoints(room, center, floor.defaultCeilingHeight ?? 9);
        if (ridge) {
          const ridgeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ridge), lineMaterial);
          ridgeLine.position.y += activeFloorYOffset;
          scene.add(ridgeLine);
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
      modelViewStateRef.current = { position: camera.position.clone(), target: controls.target.clone() };
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
  }, [activeFloorId, connectedVolumes, floor, floorViewOptions, floors, onSelectRoom, referenceUrl, referenceUrls, sceneRevision, selectedRoomId, visibleLayers]);

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
        <div className="takeoff-model-floor-filter" aria-label="3D floor filters">
          {floors.map((entry, index) => {
            const options = floorViewOptions[entry.id] ?? defaultFloorViewOptions();
            return (
              <div className="takeoff-model-floor-filter-row" key={entry.id}>
                <span>{entry.name || `Floor ${index + 1}`}</span>
                <button
                  type="button"
                  className={options.visible ? "is-active" : ""}
                  aria-pressed={options.visible}
                  onClick={() => onUpdateFloorViewOptions(entry.id, { visible: !options.visible })}
                >
                  Enable
                </button>
                <button
                  type="button"
                  className={options.reference && visibleLayers.reference ? "is-active" : ""}
                  aria-pressed={options.reference && visibleLayers.reference}
                  onClick={() => {
                    const nextReferenceVisible = !(options.reference && visibleLayers.reference);
                    onUpdateFloorViewOptions(entry.id, { reference: nextReferenceVisible });
                    if (nextReferenceVisible) setVisibleLayers((current) => ({ ...current, reference: true }));
                  }}
                >
                  PDF
                </button>
              </div>
            );
          })}
        </div>
        <div className="takeoff-model-layer-divider" />
        {([
          ["floors", "Floor plates"],
          ["ceilings", "Ceilings"],
          ["walls", "Exterior walls"],
          ["bandJoists", "Band joists"],
          ["interiorWalls", "Interior walls"],
          ["adjacentSpaces", "Adjacent spaces"],
          ["reference", "Plan PDFs"],
          ["windows", "Windows"],
          ["doors", "Doors"],
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
        <button
          type="button"
          className="takeoff-model-layer-all"
          onClick={() => setVisibleLayers({
            reference: true,
            windows: true,
            doors: true,
            ceilings: true,
            floors: true,
            walls: true,
            interiorWalls: true,
            adjacentSpaces: true,
            bandJoists: true,
          })}
        >
          All layers
        </button>
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
        <button
          type="button"
          className="takeoff-model-refresh"
          onClick={() => setSceneRevision((current) => current + 1)}
        >
          Refresh 3D
        </button>
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

function roomNameHasLoftLabel(name: string) {
  const normalized = normalizedRoomNameForInference(name);
  return /\blofts?\b/.test(normalized);
}

function roomNameHasRecOrGameLabel(name: string) {
  const normalized = normalizedRoomNameForInference(name);
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, "");
  return /\brec(?:reation)?(?: room| area| space)?\b/.test(normalized) ||
    /\bgame(?: room| area| space)?\b/.test(normalized) ||
    /^(?:rec|recreation|game)(?:room|area|space)?$/.test(compact);
}

function roomNameHasOfficeLabel(name: string) {
  const normalized = normalizedRoomNameForInference(name);
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, "");
  return /\boffices?\b/.test(normalized) ||
    /\bhome office\b/.test(normalized) ||
    /\bwork from home\b/.test(normalized) ||
    /\bwf home\b/.test(normalized) ||
    /\bwfh\b/.test(normalized) ||
    compact === "wfhome";
}

function roomNameHasComputerLabel(name: string) {
  const normalized = normalizedRoomNameForInference(name);
  return /\bcomputers?\b/.test(normalized) || /\bpc\b/.test(normalized);
}

function roomNameHasStudyFlexDenLabel(name: string) {
  const normalized = normalizedRoomNameForInference(name);
  return /\bstud(?:y|ies)\b/.test(normalized) ||
    /\bflex\b/.test(normalized) ||
    /\bdens?\b/.test(normalized);
}

type TakeoffRoomInternalGainExport = {
  roomType: TakeoffRoomType;
  peopleOverride?: number;
  applianceWattsOverride?: number;
};

type TakeoffRoomInternalGainValidation = {
  message: string;
  suggestion: NonNullable<TakeoffValidationIssue["internalGainSuggestion"]>;
};

function inferredLoftInternalGainProfile(
  room: TakeoffRectRoom,
  floorArea = rectArea(room),
  lightingArea = roomLightingArea(room),
): TakeoffRoomInternalGainExport | null {
  if (!roomNameHasLoftLabel(room.name) || lightingArea <= 0.5) return null;
  return {
    roomType: "entertainment",
    peopleOverride: 1,
    applianceWattsOverride: floorArea < 100 ? 75 : 250,
  };
}

function roomInternalGainsForExport(
  room: TakeoffRectRoom,
  floorArea = rectArea(room),
  lightingArea = roomLightingArea(room),
): TakeoffRoomInternalGainExport {
  const roomType = room.roomType ?? "plain";
  const loftProfile = inferredLoftInternalGainProfile(room, floorArea, lightingArea);
  if (loftProfile && (roomType === "plain" || roomType === "entertainment")) {
    return {
      roomType: loftProfile.roomType,
      peopleOverride: room.peopleOverride ?? loftProfile.peopleOverride,
      applianceWattsOverride: room.applianceWattsOverride ?? loftProfile.applianceWattsOverride,
    };
  }
  return {
    roomType,
    peopleOverride: room.peopleOverride,
    applianceWattsOverride: room.applianceWattsOverride,
  };
}

function effectiveRoomInternalGainValues(room: TakeoffRectRoom) {
  const exportProfile = roomInternalGainsForExport(room);
  const defaults = roomTypeInternalLoads[exportProfile.roomType];
  return {
    roomType: exportProfile.roomType,
    people: exportProfile.peopleOverride ?? defaults.people,
    applianceWatts: exportProfile.applianceWattsOverride ?? defaults.applianceWatts,
  };
}

function internalGainOverrideSuggestion(
  room: TakeoffRectRoom,
  options: {
    roomType: TakeoffRoomType;
    people: number;
    applianceWatts: number;
    label: string;
  },
): NonNullable<TakeoffValidationIssue["internalGainSuggestion"]> | null {
  const current = effectiveRoomInternalGainValues(room);
  if (current.people >= options.people && current.applianceWatts >= options.applianceWatts) return null;
  return {
    action: "set-overrides",
    roomType: options.roomType,
    people: options.people,
    applianceWatts: options.applianceWatts,
    label: options.label,
  };
}

function roomInternalGainValidationSuggestion(room: TakeoffRectRoom): TakeoffRoomInternalGainValidation | null {
  const roomName = room.name || "Room";
  if (roomNameHasRecOrGameLabel(room.name)) {
    const suggestion = internalGainOverrideSuggestion(room, {
      roomType: "entertainment",
      people: 1,
      applianceWatts: recGameEntertainmentApplianceWatts,
      label: "1 person + 450 W entertainment",
    });
    return suggestion
      ? {
          message: `${roomName} is labeled as a rec/game room. Consider adding another 200 W of entertainment load (${suggestion.applianceWatts} W total) if this space has heavier media or game equipment.`,
          suggestion,
        }
      : null;
  }

  if (roomNameHasComputerLabel(room.name)) {
    const suggestion = internalGainOverrideSuggestion(room, {
      roomType: "plain",
      people: 1,
      applianceWatts: computerApplianceWatts,
      label: "1 person + 150 W computer equipment",
    });
    return suggestion
      ? {
          message: `${roomName} is labeled as a computer-focused space. Consider adding 1 person and ${suggestion.applianceWatts} W for computer equipment if Salas treats that load explicitly.`,
          suggestion,
        }
      : null;
  }

  if (roomNameHasOfficeLabel(room.name)) {
    const suggestion = internalGainOverrideSuggestion(room, {
      roomType: "plain",
      people: 1,
      applianceWatts: officeApplianceWatts,
      label: "1 person + 75 W office equipment",
    });
    return suggestion
      ? {
          message: `${roomName} is labeled as an office/work-from-home space. Consider adding 1 person and ${suggestion.applianceWatts} W for small office equipment if Salas treats that room explicitly.`,
          suggestion,
        }
      : null;
  }

  if (roomNameHasStudyFlexDenLabel(room.name) && inferredRoomTypeFromName(room.name)?.type !== "bedroom") {
    const suggestion = internalGainOverrideSuggestion(room, {
      roomType: "plain",
      people: 1,
      applianceWatts: 0,
      label: "1 person",
    });
    return suggestion
      ? {
          message: `${roomName} is labeled as a study/flex/den. Consider adding 1 person if it is used as occupied work, study, or guest space.`,
          suggestion,
        }
      : null;
  }

  return null;
}

function inferredRoomTypeFromName(name: string): { type: TakeoffRoomType; reason: string; key: string } | null {
  const normalized = normalizedRoomNameForInference(name);
  if (!normalized) return null;
  const compact = normalized.replace(/\s+/g, "");
  const has = (pattern: RegExp) => pattern.test(normalized);
  const hasCompact = (pattern: RegExp) => pattern.test(compact);
  const bedroomOrdinal = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const hasEntertainmentLabel = has(/\bfamily(?: room)?\b/) ||
    has(/\bgathering(?: room)?\b/) ||
    has(/\bgreat(?: room)?\b/) ||
    has(/\bentertainment(?: area| room)?\b/);
  const hasBedroomLanguage = has(new RegExp(`\\bbed(?:room)?(?: ${bedroomOrdinal})?\\b`)) ||
    has(/\bbdrm\b/) ||
    has(/\bbr\b/) ||
    has(/\bowners? suite\b/) ||
    has(/\bprimary suite\b/) ||
    has(/\bmaster\b/) ||
    hasCompact(/^bed(?:room)?(?:\d+)?$/);
  if (hasEntertainmentLabel) {
    return { type: "entertainment", reason: "The room name reads like a family/gathering/entertainment space.", key: `${normalized}:entertainment` };
  }
  if (has(/\bkitchen\b/) || has(/\bkitch(?:en)?\b/) || has(/\bkit\b/)) {
    return { type: "kitchen", reason: "The room name includes kitchen, which carries appliance/internal gains.", key: `${normalized}:kitchen` };
  }
  if (has(/\blaundry\b/) || has(/\blndry\b/) || has(/\butility\b/)) {
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

function projectValidationIssueKey(floorId: string, issue: TakeoffValidationIssue, index?: number) {
  return `${floorId}:${validationIssueKey(issue, index)}`;
}

function validationSectionForIssue(issue: TakeoffValidationIssue): ValidationSection {
  const message = issue.message.toLowerCase();
  if (issue.issueType === "internal-gain-suggestion") return "room-profile";
  if (issue.issueType === "open-to-above-envelope-suggestion") return "wall-components";
  if (issue.issueType === "vertical-merge-suggestion") return "merge";
  if (message.includes("room type") || message.includes("internal gains")) return "room-profile";
  if (message.includes("suggested exterior wall")) return "wall-suggestions";
  if (issue.issueType === "wall-component-geometry-suggestion") return "wall-components";
  if (message.includes("glass") || message.includes("window") || message.includes("opening")) return "glass-components";
  if (message.includes("door")) return "door-components";
  if (message.includes("wall component") || message.includes("wall components") || message.includes("garage-adjacent") || message.includes("adjacent space")) return "wall-components";
  if (message.includes("floor component") || message.includes("floor components") || message.includes("floor area") || message.includes("floor treatment")) return "floor-components";
  if (message.includes("ceiling geometry") || message.includes("ceiling shape") || message.includes("generated ceiling-wall") || message.includes("raised wall") || message.includes("gable")) return "ceiling-geometry";
  if (message.includes("ceiling component") || message.includes("ceiling components") || message.includes("ceiling area") || message.includes("ceiling treatment")) return "ceiling-components";
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
  if (source === "tray-knee-wall") return "Generated from tray ceiling";
  if (source === "open-to-above-envelope") return "Generated from open-to-above envelope";
  if (source === "connected-volume") return "Generated from connected volume";
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

function activeValidationElementId(roomId: string) {
  return `active-validation-target-${roomId}`;
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
  const [dimensionInputMode, setDimensionInputMode] = useState<DimensionInputMode>("decimal");
  const [floors, setFloors] = useState<TakeoffFloor[]>(() => [makeInitialFloor()]);
  const [connectedVolumes, setConnectedVolumes] = useState<TakeoffConnectedVolume[]>([]);
  const [activeFloorId, setActiveFloorId] = useState("floor-1");
  const [floorViewOptions, setFloorViewOptions] = useState<Record<string, FloorViewOptions>>(() => ({ "floor-1": defaultFloorViewOptions() }));
  const [draftRoom, setDraftRoom] = useState({ name: "", x: 0, y: 0, width: 0, depth: 0, ceilingHeight: 9 });
  const [message, setMessage] = useState("");
  const [activeValidationTarget, setActiveValidationTarget] = useState<ActiveValidationTarget | null>(null);
  const [dismissedValidationKeys, setDismissedValidationKeys] = useState<Set<string>>(() => new Set());
  const [activeSketchTarget, setActiveSketchTarget] = useState<SketchTarget | null>(null);
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);
  const undoRestoreInProgressRef = useRef(false);
  const [takeoffId, setTakeoffId] = useState<number | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState(() => takeoffSnapshot(makeTakeoffProject("Takeoff V1 Draft", "", "decimal", false, 0, "S", makeInitialFloor(), defaultComponentSchedule)));
  const [saveLoading, setSaveLoading] = useState(false);
  const [pendingSessionExit, setPendingSessionExit] = useState<PendingSessionExit | null>(null);
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
  const [modelPreviewRevision, setModelPreviewRevision] = useState(0);
  const [traceTool, setTraceTool] = useState<"select" | "exterior">("select");
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>("trace");
  const [calibrationOrientation, setCalibrationOrientation] = useState<TakeoffScaleLine["orientation"]>("horizontal");
  const [calibrationStart, setCalibrationStart] = useState<TakeoffPoint | null>(null);
  const [referenceUrls, setReferenceUrls] = useState<Record<string, string>>({});
  const [referenceRenderStatus, setReferenceRenderStatus] = useState("");
  const [dragState, setDragState] = useState<DragState>(null);
  const [alignmentDrag, setAlignmentDrag] = useState<AlignmentDragState>(null);
  const [roomDrawMode, setRoomDrawMode] = useState(false);
  const [roomPolygonMode, setRoomPolygonMode] = useState(false);
  const [roomPolygonDraft, setRoomPolygonDraft] = useState<TakeoffPoint[]>([]);
  const [adjacentDrawMode, setAdjacentDrawMode] = useState(false);
  const [adjacentSpaceKind, setAdjacentSpaceKind] = useState<TakeoffAdjacentSpaceKind>("garage");
  const [subtractMode, setSubtractMode] = useState(false);
  const [subtractRoomId, setSubtractRoomId] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [pendingInlineRoomNameSelectId, setPendingInlineRoomNameSelectId] = useState<string | null>(null);
  const [roomTileMetric, setRoomTileMetric] = useState<RoomTileMetric>("floor");
  const [roomLoadSketchRotationSteps, setRoomLoadSketchRotationSteps] = useState(0);
  const [ceilingSketchRotationSteps, setCeilingSketchRotationSteps] = useState(0);
  const [sliceRoomId, setSliceRoomId] = useState("");
  const [mergeTargetRoomId, setMergeTargetRoomId] = useState("");
  const [roomMergeMenuOpen, setRoomMergeMenuOpen] = useState(false);
  const [roomTypeMenuOpen, setRoomTypeMenuOpen] = useState(false);
  const [roomWorkbenchSections, setRoomWorkbenchSections] = useState({ floor: false, ceiling: false, reconciliation: false });
  const [componentAddSurface, setComponentAddSurface] = useState<TakeoffRoomComponent["surface"] | "">("");
  const [componentSurfaceFilters, setComponentSurfaceFilters] = useState<TakeoffRoomComponent["surface"][]>(allComponentSurfaces);
  const [editingComponentId, setEditingComponentId] = useState<string | null>(null);
  const [suggestedWallRowAssemblies, setSuggestedWallRowAssemblies] = useState<Record<string, string>>({});
  const [suggestedWallRowAdjacencies, setSuggestedWallRowAdjacencies] = useState<Record<string, TakeoffWallAdjacency>>({});
  const [selectedUnassignedRegionId, setSelectedUnassignedRegionId] = useState<string | null>(null);
  const [suggestedWallAssembly, setSuggestedWallAssembly] = useState("W1");
  const [openingPlacement, setOpeningPlacement] = useState<OpeningPlacement>(null);
  const [openingModeActive, setOpeningModeActive] = useState(false);
  const [pendingOpeningTarget, setPendingOpeningTarget] = useState<PendingOpeningTarget>(null);
  const [editingOpeningTarget, setEditingOpeningTarget] = useState<EditingOpeningTarget>(null);
  const [selectedOpening, setSelectedOpening] = useState<OpeningMoveTarget | null>(null);
  const inlineRoomNameInputRef = useRef<HTMLInputElement | null>(null);
  const roomMergeMenuRef = useRef<HTMLDivElement | null>(null);
  const roomTypeMenuRef = useRef<HTMLDivElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const suppressNextCanvasClickRef = useRef(false);
  const modalPointerStartedOnBackdropRef = useRef(false);
  const openingDragMovedRef = useRef(false);

  function openPlanReviewMode(mode: PlanReviewMode) {
    if (mode === "elevation") {
      if (!floors.some(floorHasRenderable3DGeometry)) {
        setMessage("Trace an exterior footprint or add at least one room before opening 3D QA.");
        return;
      }
      setModelPreviewRevision((current) => current + 1);
    }
    setPlanReviewMode(mode);
  }

  function open2DPlanView() {
    setPlanReviewMode("plan");
    setWorkflowStep("trace");
    setTraceTool("select");
    setRoomDrawMode(false);
    setRoomPolygonMode(false);
    setAdjacentDrawMode(false);
    setSubtractMode(false);
    stopOpeningPlacement();
  }

  const floor = floors.find((candidate) => candidate.id === activeFloorId) ?? floors[0] ?? makeInitialFloor();
  const referenceUrl = referenceUrls[floor.id] ?? "";
  const activeFloorViewOptions = floorViewOptions[floor.id] ?? defaultFloorViewOptions();
  const orderedFloors = useMemo(() => floorsByElevation(floors), [floors]);
  const canOpen3DView = floors.some(floorHasRenderable3DGeometry);

  useEffect(() => {
    if (planReviewMode !== "elevation" || canOpen3DView) return;
    setPlanReviewMode("plan");
    setMessage("3D QA is available after an exterior footprint, floor area, room, or adjacent space exists.");
  }, [canOpen3DView, planReviewMode]);

  function setFloor(update: React.SetStateAction<TakeoffFloor>) {
    pushUndoSnapshot("floor edit");
    setFloors((currentFloors) => {
      const targetId = currentFloors.some((candidate) => candidate.id === activeFloorId)
        ? activeFloorId
        : currentFloors[0]?.id;
      if (!targetId) {
        const fallback = makeInitialFloor();
        return [typeof update === "function" ? update(fallback) : update];
      }
      return currentFloors.map((candidate) => {
        if (candidate.id !== targetId) return candidate;
        return typeof update === "function" ? update(candidate) : update;
      });
    });
  }

  function setReferenceUrl(value: React.SetStateAction<string>) {
    const targetFloorId = floor.id;
    setReferenceUrls((current) => {
      const nextValue = typeof value === "function" ? value(current[targetFloorId] ?? "") : value;
      return { ...current, [targetFloorId]: nextValue };
    });
  }

  useEffect(() => {
    return () => {
      for (const url of Object.values(referenceUrls)) {
        if (url) revokeReferenceUrl(url);
      }
    };
  }, []);

  useEffect(() => {
    const missingReferenceFloors = floors.filter((entry) => entry.reference?.downloadUrl && !referenceUrls[entry.id]);
    if (!missingReferenceFloors.length) return;
    let cancelled = false;
    async function restoreFloorReferences() {
      for (const entry of missingReferenceFloors) {
        const sourceUrl = entry.reference?.downloadUrl;
        if (!sourceUrl) continue;
        try {
          const restoredPreview = entry.reference?.kind === "pdf"
            ? await renderPdfPreview(sourceUrl, entry.reference?.sourcePageNumber ?? 1)
            : null;
          const restoredUrl = restoredPreview?.url ?? sourceUrl;
          if (cancelled || !restoredUrl) return;
          setReferenceUrls((current) => ({ ...current, [entry.id]: restoredUrl }));
          setReferenceRenderStatus(`Reference restored: ${entry.reference?.filename ?? entry.name}`);
        } catch {
          if (!cancelled) setReferenceRenderStatus("Reference metadata reopened, but one stored file was not available.");
        }
      }
    }
    void restoreFloorReferences();
    return () => {
      cancelled = true;
    };
  }, [floors, referenceUrls]);

  useEffect(() => {
    setRoomWorkbenchSections({ floor: false, ceiling: false, reconciliation: false });
    setRoomMergeMenuOpen(false);
    setRoomTypeMenuOpen(false);
    setComponentAddSurface("");
    setComponentSurfaceFilters(allComponentSurfaces);
    setEditingComponentId(null);
    setSuggestedWallRowAssemblies({});
    setSuggestedWallRowAdjacencies({});
  }, [selectedRoomId]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (roomMergeMenuOpen && roomMergeMenuRef.current && !roomMergeMenuRef.current.contains(target)) {
        setRoomMergeMenuOpen(false);
      }
      if (roomTypeMenuOpen && roomTypeMenuRef.current && !roomTypeMenuRef.current.contains(target)) {
        setRoomTypeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [roomMergeMenuOpen, roomTypeMenuOpen]);

  const takeoffProject = useMemo<TakeoffProject>(
    () => makeTakeoffProject(projectName, location, dimensionInputMode, mechanicalVentilation, ventilationCfm, frontDoorFaces, floors, componentSchedule, connectedVolumes),
    [componentSchedule, connectedVolumes, dimensionInputMode, floors, frontDoorFaces, location, mechanicalVentilation, projectName, ventilationCfm],
  );
  const currentUndoSnapshot = useMemo(() => takeoffSnapshot(persistableTakeoffProject(takeoffProject)), [takeoffProject]);
  function pushUndoSnapshot(label: string) {
    if (undoRestoreInProgressRef.current) return;
    const snapshot = currentUndoSnapshot;
    setUndoStack((current) => {
      if (current[0]?.snapshot === snapshot) return current;
      return [{ label, snapshot, activeFloorId }, ...current].slice(0, 2);
    });
  }
  function restoreProjectFromSnapshot(snapshot: UndoSnapshot) {
    const restored = normalizeTakeoffProject(JSON.parse(snapshot.snapshot));
    const restoredFloors = restored.floors.length ? restored.floors : [makeInitialFloor()];
    setProjectName(restored.name);
    setLocation(restored.location ?? "");
    setDimensionInputMode(restored.dimensionInputMode ?? "decimal");
    setMechanicalVentilation(Boolean(restored.mechanicalVentilation));
    setVentilationCfm(Number(restored.ventilationCfm ?? 0));
    setFrontDoorFaces(restored.frontDoorFaces);
    setComponentSchedule(restored.componentSchedule?.length ? restored.componentSchedule : defaultComponentSchedule);
    setFloors(restoredFloors);
    setConnectedVolumes(restored.connectedVolumes ?? []);
    setFloorViewOptions((current) => {
      return Object.fromEntries(restoredFloors.map((entry) => [entry.id, current[entry.id] ?? defaultFloorViewOptions()]));
    });
    setActiveFloorId(restoredFloors.some((entry) => entry.id === snapshot.activeFloorId)
      ? snapshot.activeFloorId
      : restoredFloors[0]?.id ?? "floor-1");
    setActiveValidationTarget(null);
    setDismissedValidationKeys(new Set());
    resetTransientFloorTools();
  }
  function undoLastTakeoffChange() {
    const latest = undoStack[0];
    if (!latest) return;
    undoRestoreInProgressRef.current = true;
    restoreProjectFromSnapshot(latest);
    setUndoStack((current) => current.slice(1));
    window.requestAnimationFrame(() => {
      undoRestoreInProgressRef.current = false;
    });
    setMessage(`Undid ${latest.label}.`);
  }
  const taggedBedroomCount = Math.max(floors.reduce((sum, entry) => sum + entry.rooms.filter((room) => room.roomType === "bedroom").length, 0), 1);
  const suggestedVentilationCfm = ventilationCfmForBedrooms(taggedBedroomCount);
  const persistableTakeoff = useMemo(() => persistableTakeoffProject(takeoffProject), [takeoffProject]);
  const serializedTakeoff = useMemo(() => takeoffSnapshot(persistableTakeoff), [persistableTakeoff]);
  const hasSaveWorthyChanges = serializedTakeoff !== savedSnapshot;
  const isDirty = takeoffId === null || hasSaveWorthyChanges;
  useEffect(() => registerUnsavedNavigationGuard({
    id: "takeoff",
    hasUnsavedChanges: () => hasSaveWorthyChanges,
    message: "This takeoff has unsaved changes. Select OK to leave without saving, or Cancel to stay and save your work.",
  }), [hasSaveWorthyChanges]);
  const computedFootprintArea = footprintArea(floor);
  const assignedArea = floor.rooms.reduce((sum, room) => sum + rectArea(room), 0);
  const unassignedArea = computedFootprintArea - assignedArea;
  const payload = useMemo(() => buildVrcPayload(takeoffProject), [takeoffProject]);
  const selectedRoom = floor.rooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedAdjacentSpace = selectedRoom ? null : (floor.adjacentSpaces ?? []).find((space) => space.id === selectedRoomId) ?? null;
  const selectedAdjacentRoom = selectedAdjacentSpace ? adjacentSpaceAsRoom(selectedAdjacentSpace, floor.defaultCeilingHeight ?? 9) : null;
  const roomRenameShortcutEnabled = workflowStep === "trace" &&
    !roomDrawMode &&
    !roomPolygonMode &&
    !adjacentDrawMode &&
    !subtractMode &&
    !openingModeActive &&
    !(traceTool === "exterior" && !floor.perimeterLocked);
  const show2DDraftingPanels = planReviewMode === "plan" && workflowStep === "trace";
  const hasReference = Boolean(floor.reference);
  const hasHorizontalScale = floor.calibration.lines.some((line) => line.orientation === "horizontal" && scaleLineHasKnownDimension(line));
  const hasVerticalScale = floor.calibration.lines.some((line) => line.orientation === "vertical" && scaleLineHasKnownDimension(line));
  const scaleApplied = Boolean(
    floor.calibration.confirmed ||
    (floor.reference && floor.calibration.appliedFactor && Math.abs(floor.calibration.appliedFactor - 1) > 0.00001)
  );
  const scaleLinesVisible = floor.calibration.linesVisible ?? true;
  const scaleReady = hasHorizontalScale && hasVerticalScale && !scaleApplied;
  const activeRoomValidationTarget = activeValidationTarget && selectedRoom && activeValidationTarget.floorId === floor.id && activeValidationTarget.roomId === selectedRoom.id
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
  const fullReferenceCrop = referenceFullCropForFloor(floor);
  const visibleCrop = workflowStep === "crop" ? fullReferenceCrop : referenceCropForFloor(floor);
  const referenceDisplay = referenceDisplayRectForFloor(floor, visibleCrop);
  const referenceRotationLocked = floor.rooms.length > 0 || floor.exteriorPolygon.length > 0 || (floor.adjacentSpaces ?? []).length > 0 || Boolean(floor.calibration.confirmed);
  const canRotateReferenceInCrop = workflowStep === "crop" && Boolean(floor.reference) && !referenceRotationLocked;
  const alignmentReferenceFloor = (floor.alignment?.referenceFloorId
    ? floors.find((entry) => entry.id === floor.alignment?.referenceFloorId)
    : floors.find((entry) => entry.id !== floor.id)) ?? null;
  const alignmentReferenceUrl = alignmentReferenceFloor ? referenceUrls[alignmentReferenceFloor.id] ?? "" : "";
  const alignmentReferenceDisplay = alignmentReferenceFloor ? referenceDisplayRectForFloor(alignmentReferenceFloor) : null;
  const alignmentPointPairs = floor.alignment?.pointPairs ?? [];
  const alignmentReferenceScaleFactor = alignmentReferenceFloor?.calibration.appliedFactor || 1;
  const alignmentTransform = { ...defaultAlignmentTransform(), ...(floor.alignment?.transform ?? {}) };
  const canAlignCurrentReference = floors.length > 1 && Boolean(floor.alignment?.referenceFloorId && floor.reference && alignmentReferenceFloor?.reference);
  const alignmentEffectiveScale = alignmentTransform.scale;
  const activeOpenToBelowReservations = useMemo(() => openToBelowRoomsForFloor(floor, floors, connectedVolumes), [connectedVolumes, floor, floors]);
  const unassignedCells = useMemo(() => {
    if (floor.exteriorPolygon.length < 3 && (floor.conditionedPerimeter.width <= 0 || floor.conditionedPerimeter.depth <= 0)) return [];
    const cellSize = Math.max(1, floor.scale.feetPerGrid);
    const floorBounds = footprintBounds(floor);
    const cells: UnassignedCell[] = [];
    let available: MultiPolygon = floor.exteriorPolygon.length >= 3
      ? [pointsToClipPolygon(floor.exteriorPolygon)]
      : [pointsToClipPolygon(rectToPoints({ x: 0, y: 0, width: floor.conditionedPerimeter.width, depth: floor.conditionedPerimeter.depth }))];
    const blockers = [
      ...floor.rooms.map((room) => roomToClipPolygon(room)),
      ...activeOpenToBelowReservations.map((reservation) => pointsToClipPolygon(reservation.points)),
    ];
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
  }, [activeOpenToBelowReservations, floor]);
  const unassignedRegions = useMemo(() => buildUnassignedRegions(floor, unassignedCells), [floor, unassignedCells]);
  const selectedUnassignedRegion = unassignedRegions.find((region) => region.id === selectedUnassignedRegionId) ?? unassignedRegions[0] ?? null;
  const activeUnassignedCells = selectedUnassignedRegion?.cells ?? unassignedCells;
  const unassignedCellArea = activeUnassignedCells.reduce((sum, cell) => sum + unassignedCellMeasuredArea(cell), 0);
  const selectedUnassignedAdjacentRoomIds = selectedUnassignedRegion?.adjacentRoomIds ?? [];
  const sliceRoomOptions = floor.rooms
    .map((room, index) => ({ room, index, adjacentIndex: selectedUnassignedAdjacentRoomIds.indexOf(room.id) }))
    .sort((first, second) => {
      const firstAdjacent = first.adjacentIndex >= 0;
      const secondAdjacent = second.adjacentIndex >= 0;
      if (firstAdjacent !== secondAdjacent) return firstAdjacent ? -1 : 1;
      if (firstAdjacent && secondAdjacent) return first.adjacentIndex - second.adjacentIndex;
      return first.index - second.index;
    })
    .map(({ room }) => room);
  const selectedSliceRoomId = sliceRoomId && sliceRoomOptions.some((room) => room.id === sliceRoomId)
    ? sliceRoomId
    : sliceRoomOptions[0]?.id ?? "";
  const projectValidation = useMemo<ProjectValidationEntry[]>(() => {
    const activeFirstFloors = [
      ...orderedFloors.filter((entry) => entry.id === activeFloorId),
      ...orderedFloors.filter((entry) => entry.id !== activeFloorId),
    ];
    return activeFirstFloors.flatMap((entry) =>
      buildValidation(entry, entry.id === activeFloorId ? unassignedRegions : [], floors, connectedVolumes).map((issue, index) => ({
        floor: entry,
        issue,
        index,
        key: projectValidationIssueKey(entry.id, issue, index),
      }))
    );
  }, [activeFloorId, connectedVolumes, floors, orderedFloors, unassignedRegions]);
  const visibleProjectValidation = useMemo(
    () => projectValidation.filter((entry) => !dismissedValidationKeys.has(entry.key)),
    [dismissedValidationKeys, projectValidation],
  );
  const roomValidationSummary = useMemo(() => {
    const summary = new Map<string, { errors: number; warnings: number }>();
    for (const entry of visibleProjectValidation) {
      const roomId = entry.issue.target?.roomId;
      if (!roomId) continue;
      const key = `${entry.floor.id}:${roomId}`;
      const current = summary.get(key) ?? { errors: 0, warnings: 0 };
      if (entry.issue.severity === "error") current.errors += 1;
      else current.warnings += 1;
      summary.set(key, current);
    }
    return summary;
  }, [visibleProjectValidation]);
  const roomValidationBadge = (floorId: string, roomId: string) => {
    const summary = roomValidationSummary.get(`${floorId}:${roomId}`);
    if (!summary || (!summary.errors && !summary.warnings)) return null;
    const count = summary.errors + summary.warnings;
    const label = `${count} validation ${count === 1 ? "flag" : "flags"}${summary.errors ? `, ${summary.errors} fix required` : ""}`;
    return (
      <span
        className={`takeoff-room-validation-badge ${summary.errors ? "takeoff-room-validation-badge--error" : "takeoff-room-validation-badge--warning"}`}
        aria-label={label}
        title={label}
      >
        !
      </span>
    );
  };
  const polygonDraftActive = roomPolygonMode && roomPolygonDraft.length > 0;

  useEffect(() => {
    if (!activeValidationTarget) return;
    const stillPresent = projectValidation.some((entry) => entry.key === activeValidationTarget.key);
    if (!stillPresent) setActiveValidationTarget(null);
  }, [activeValidationTarget, projectValidation]);

  useEffect(() => {
    if (!activeRoomValidationTarget || !selectedRoom) return;
    const section = activeRoomValidationTarget.section;
    if (section === "floor-components") {
      setRoomWorkbenchSections((current) => ({ ...current, floor: true }));
    }
    if (section === "ceiling-components" || section === "ceiling-geometry") {
      setRoomWorkbenchSections((current) => ({ ...current, ceiling: true }));
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const sectionTarget = document.getElementById(validationSectionElementId(selectedRoom.id, section));
        const activeTarget = document.getElementById(activeValidationElementId(selectedRoom.id));
        (activeTarget ?? sectionTarget)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, [activeRoomValidationTarget?.key, activeRoomValidationTarget?.roomId, activeRoomValidationTarget?.section, selectedRoom?.id]);

  useEffect(() => {
    if (!pendingInlineRoomNameSelectId || editingRoomId !== pendingInlineRoomNameSelectId) return;
    const input = inlineRoomNameInputRef.current;
    if (!input) return;
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
      setPendingInlineRoomNameSelectId(null);
    });
  }, [editingRoomId, pendingInlineRoomNameSelectId]);

  useEffect(() => {
    setLeftSectionsOpen((current) => ({
      ...current,
      mode: hasReference ? false : current.mode,
      scale: hasReference && !scaleApplied ? true : false,
      exterior: scaleApplied && floor.exteriorPolygon.length < 3 ? true : current.exterior,
    }));
  }, [floor.exteriorPolygon.length, hasReference, scaleApplied]);

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

  function updateFloorDefaultCeilingHeight(height: number) {
    setFloor((current) => ({
      ...current,
      defaultCeilingHeight: height,
      rooms: current.rooms.map((room) => ({ ...room, ceilingGeometryApproved: false })),
    }));
  }

  function applyFloorDefaultCeilingHeightToRooms() {
    let appliedHeight = floor.defaultCeilingHeight ?? 9;
    let roomCount = floor.rooms.length;
    let floorName = floor.name || "Active floor";
    setFloor((current) => {
      const height = current.defaultCeilingHeight ?? 9;
      appliedHeight = height;
      roomCount = current.rooms.length;
      floorName = current.name || "Active floor";
      return {
        ...current,
        rooms: current.rooms.map((room) => {
          return {
            ...room,
            ceilingHeight: height,
            ceilingLowHeight: isVaultCeilingType(room.ceilingType) ? height : room.ceilingLowHeight,
            ceilingPeakHeight: isVaultCeilingType(room.ceilingType) ? Math.max(height, room.ceilingPeakHeight ?? height + 1) : room.ceilingPeakHeight,
            ceilingGeometryApproved: false,
          };
        }),
      };
    });
    setMessage(`${floorName} default ceiling height (${formatDimensionValue(appliedHeight, dimensionInputMode)}) applied to ${roomCount} room${roomCount === 1 ? "" : "s"}.`);
  }

  function resetTransientFloorTools(options: { preserveZoom?: boolean } = {}) {
    setSelectedRoomId(null);
    setSelectedUnassignedRegionId(null);
    setCalibrationStart(null);
    setRoomPolygonDraft([]);
    setAdjacentDrawMode(false);
    setOpeningModeActive(false);
    setOpeningPlacement(null);
    setPendingOpeningTarget(null);
    setEditingOpeningTarget(null);
    setSelectedOpening(null);
    setDragState(null);
    setAlignmentDrag(null);
    setWorkflowStep("trace");
    setTraceTool("select");
    if (!options.preserveZoom) setZoom(1);
  }

  function switchActiveFloor(floorId: string) {
    if (floorId === activeFloorId) return;
    const currentViewport = canvasScrollRef.current
      ? {
          left: canvasScrollRef.current.scrollLeft,
          top: canvasScrollRef.current.scrollTop,
        }
      : null;
    setActiveFloorId(floorId);
    resetTransientFloorTools({ preserveZoom: true });
    if (currentViewport) {
      requestAnimationFrame(() => {
        if (!canvasScrollRef.current) return;
        canvasScrollRef.current.scrollLeft = currentViewport.left;
        canvasScrollRef.current.scrollTop = currentViewport.top;
      });
    }
  }

  function updateFloorViewOptions(floorId: string, patch: Partial<FloorViewOptions>) {
    setFloorViewOptions((current) => ({
      ...current,
      [floorId]: { ...(current[floorId] ?? defaultFloorViewOptions()), ...patch },
    }));
  }

  function addFloor() {
    pushUndoSnapshot("add floor");
    const floorNumber = floors.length + 1;
    const previousTop = floors.reduce((maxElevation, entry) => Math.max(maxElevation, (entry.elevation ?? 0) + (entry.floorToFloorHeight ?? 10)), 0);
    const base = floor;
    const nextFloor: TakeoffFloor = {
      ...makeInitialFloor(),
      id: nextId("floor"),
      name: floorNumber === 2 ? "Second Floor" : floorNumber === 3 ? "Third Floor" : `Floor ${floorNumber}`,
      designGrid: { ...base.designGrid },
      scale: { ...base.scale },
      defaultCeilingHeight: base.defaultCeilingHeight,
      elevation: previousTop,
      floorToFloorHeight: base.floorToFloorHeight ?? 10,
      bandJoistEnabled: floorBandJoistEnabled(base),
      bandJoistHeight: base.bandJoistHeight ?? defaultBandJoistHeight,
      bandJoistHeightUserSet: base.bandJoistHeightUserSet ?? false,
      alignment: floors.length ? { referenceFloorId: base.id, pointPairs: [] } : undefined,
    };
    setFloors((current) => resolveOpenToAboveLinksForFloors(floorsByElevation([...current, nextFloor])));
    setFloorViewOptions((current) => ({ ...current, [nextFloor.id]: defaultFloorViewOptions() }));
    setActiveFloorId(nextFloor.id);
    resetTransientFloorTools();
    setMessage(`${nextFloor.name} added. Upload its plan reference, then align it to an existing floor.`);
  }

  function addFloorBelow() {
    pushUndoSnapshot("add floor below");
    const floorNumber = floors.length + 1;
    const base = floor;
    const existingNames = new Set(floors.map((entry) => entry.name.trim().toLowerCase()).filter(Boolean));
    const nextElevation = (base.elevation ?? 0) - (base.floorToFloorHeight ?? 10);
    const lowestElevation = floors.reduce((minElevation, entry) => Math.min(minElevation, entry.elevation ?? 0), base.elevation ?? 0);
    const preferredName = nextElevation < lowestElevation - 0.01 ? "Basement" : "Lower Floor";
    const nextName = existingNames.has(preferredName.toLowerCase()) ? `${preferredName} ${floorNumber}` : preferredName;
    const nextFloor: TakeoffFloor = {
      ...makeInitialFloor(),
      id: nextId("floor"),
      name: nextName,
      designGrid: { ...base.designGrid },
      scale: { ...base.scale },
      defaultCeilingHeight: base.defaultCeilingHeight,
      elevation: nextElevation,
      floorToFloorHeight: base.floorToFloorHeight ?? 10,
      bandJoistEnabled: floorBandJoistEnabled(base),
      bandJoistHeight: base.bandJoistHeight ?? defaultBandJoistHeight,
      bandJoistHeightUserSet: base.bandJoistHeightUserSet ?? false,
      alignment: { referenceFloorId: base.id, pointPairs: [] },
    };
    setFloors((current) => resolveOpenToAboveLinksForFloors(floorsByElevation([...current, nextFloor])));
    setFloorViewOptions((current) => ({ ...current, [nextFloor.id]: defaultFloorViewOptions() }));
    setActiveFloorId(nextFloor.id);
    resetTransientFloorTools();
    setMessage(`${nextFloor.name} added below ${base.name || "the active floor"}. Upload its plan reference, then align it to the floor above.`);
  }

  function removeActiveFloor() {
    if (floors.length <= 1) {
      setMessage("At least one floor must remain in the takeoff.");
      return;
    }
    const target = floor;
    const confirmed = window.confirm(`Remove ${target.name || "this floor"}? This will delete its PDF reference, rooms, exterior trace, and alignment points. This cannot be undone.`);
    if (!confirmed) return;
    pushUndoSnapshot("remove floor");

    if (referenceUrls[target.id]) revokeReferenceUrl(referenceUrls[target.id]);
    const remainingFloors = floors
      .filter((entry) => entry.id !== target.id)
      .map((entry) => ({
        ...entry,
        alignment: entry.alignment?.referenceFloorId === target.id ? undefined : entry.alignment,
        rooms: entry.rooms.map((room) => {
          const nextVerticalLinks = room.verticalLinks?.map((link) => (
            link.targetFloorId === target.id ? { ...link, targetFloorId: undefined } : link
          ));
          const lostOpenAboveTarget = room.verticalLinks?.some((link) => link.targetFloorId === target.id);
          return {
            ...room,
            ceilingHeight: lostOpenAboveTarget ? (openToAboveLinkForRoom(room)?.previousCeilingHeight ?? entry.defaultCeilingHeight ?? 9) : room.ceilingHeight,
            verticalLinks: nextVerticalLinks,
          };
        }),
      }));
    const nextActiveFloor = remainingFloors[0] ?? makeInitialFloor();
    setFloors(remainingFloors.length ? remainingFloors : [nextActiveFloor]);
    setConnectedVolumes((current) =>
      current.filter((volume) => !volume.footprints.some((footprint) => footprint.floorId === target.id))
    );
    setFloorViewOptions((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    setReferenceUrls((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    setActiveFloorId(nextActiveFloor.id);
    resetTransientFloorTools();
    setMessage(`${target.name || "Floor"} removed.`);
  }

  function setAlignmentReferenceFloor(referenceFloorId: string) {
    updateFloor({
      alignment: {
        ...(floor.alignment ?? {}),
        referenceFloorId,
        pointPairs: floor.alignment?.pointPairs ?? [],
        transform: defaultAlignmentTransform(),
      },
    });
  }

  function updateAlignmentTransform(patch: Partial<AlignmentTransform>) {
    setFloor((current) => {
      const currentTransform = { ...defaultAlignmentTransform(), ...(current.alignment?.transform ?? {}) };
      const nextTransform = {
        ...currentTransform,
        ...patch,
        scale: Math.min(4, Math.max(0.25, patch.scale ?? currentTransform.scale)),
      };
      return {
        ...current,
        alignment: {
          ...(current.alignment ?? {}),
          referenceFloorId: current.alignment?.referenceFloorId ?? alignmentReferenceFloor?.id,
          pointPairs: current.alignment?.pointPairs ?? [],
          transform: nextTransform,
        },
      };
    });
  }

  function nudgeAlignment(deltaX: number, deltaY: number) {
    updateAlignmentTransform({
      translateX: Number((alignmentTransform.translateX + deltaX).toFixed(3)),
      translateY: Number((alignmentTransform.translateY + deltaY).toFixed(3)),
    });
  }

  function stepAlignmentScale(delta: number) {
    updateAlignmentTransform({ scale: Number((alignmentTransform.scale + delta).toFixed(4)) });
  }

  function resetAlignmentTransform() {
    updateAlignmentTransform(defaultAlignmentTransform());
    setMessage("Alignment preview reset.");
  }

  function alignmentLocalToReferencePoint(point: TakeoffPoint) {
    const display = referenceDisplayRectForFloor(floor);
    return {
      x: display.x + alignmentTransform.translateX + (point.x - display.x) * alignmentEffectiveScale,
      y: display.y + alignmentTransform.translateY + (point.y - display.y) * alignmentEffectiveScale,
    };
  }

  function alignmentReferenceToLocalPoint(point: TakeoffPoint) {
    const display = referenceDisplayRectForFloor(floor);
    const nextScale = Math.max(0.0001, alignmentEffectiveScale);
    return {
      x: Number(Math.min(floor.designGrid.width, Math.max(0, display.x + (point.x - display.x - alignmentTransform.translateX) / nextScale)).toFixed(3)),
      y: Number(Math.min(floor.designGrid.depth, Math.max(0, display.y + (point.y - display.y - alignmentTransform.translateY) / nextScale)).toFixed(3)),
    };
  }

  function acceptAlignment() {
    setPlanReviewMode("plan");
    setWorkflowStep("trace");
    setTraceTool(floor.perimeterLocked ? "select" : "exterior");
    setRoomDrawMode(false);
    setAdjacentDrawMode(false);
    setOpeningModeActive(false);
    setMessage(
      alignmentPointPairs.length > 0
        ? `Alignment accepted with ${alignmentPointPairs.length} point pair${alignmentPointPairs.length === 1 ? "" : "s"}. Trace this floor's exterior next.`
        : "Alignment preview accepted. Trace this floor's exterior next.",
    );
  }

  function addSameScreenAlignmentPair(point: TakeoffPoint) {
    if (!alignmentReferenceFloor) {
      setMessage("Add another floor before recording alignment points.");
      return;
    }
    const pair = { id: nextId("align-pair"), reference: point, local: alignmentReferenceToLocalPoint(point) };
    setFloor((current) => ({
      ...current,
      alignment: {
        ...(current.alignment ?? {}),
        referenceFloorId: current.alignment?.referenceFloorId ?? alignmentReferenceFloor.id,
        transform: current.alignment?.transform ?? alignmentTransform,
        pointPairs: [...(current.alignment?.pointPairs ?? []), pair],
      },
    }));
    setMessage(`Alignment pair ${(floor.alignment?.pointPairs?.length ?? 0) + 1} recorded from the current overlay.`);
  }

  function clearAlignmentPairs() {
    setFloor((current) => ({
      ...current,
      alignment: {
        ...(current.alignment ?? {}),
        pointPairs: [],
        residualFt: undefined,
        transform: defaultAlignmentTransform(),
      },
    }));
    setMessage("Alignment point pairs cleared.");
  }

  function startInlineRoomRename(roomId: string) {
    setSelectedRoomId(roomId);
    setEditingRoomId(roomId);
    setPendingInlineRoomNameSelectId(roomId);
  }

  function updateRoom(roomId: string, patch: Partial<TakeoffRectRoom>) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => (room.id === roomId ? { ...room, ...patch } : room)),
    }));
  }

  function acceptRoomTypeSuggestion(roomId: string, suggestion: NonNullable<ReturnType<typeof inferredRoomTypeFromName>>) {
    updateRoom(roomId, { roomType: suggestion.type, roomTypeSuggestionDismissedKey: suggestion.key });
    setActiveValidationTarget(null);
  }

  function rejectRoomTypeSuggestion(roomId: string, suggestion: NonNullable<ReturnType<typeof inferredRoomTypeFromName>>) {
    updateRoom(roomId, { roomType: "plain", roomTypeSuggestionDismissedKey: suggestion.key });
    setActiveValidationTarget(null);
  }

  function recheckValidation() {
    setFloors((current) => current.map((entry) => ({
      ...entry,
      rooms: entry.rooms.map((room) => ({ ...room, roomTypeSuggestionDismissedKey: undefined })),
    })));
    setDismissedValidationKeys(new Set());
    setActiveValidationTarget(null);
    setMessage("Validation rechecked. Previously dismissed flags can appear again.");
  }

  function dismissActiveValidation() {
    if (!activeValidationTarget) return;
    setDismissedValidationKeys((current) => {
      const next = new Set(current);
      next.add(activeValidationTarget.key);
      return next;
    });
    setActiveValidationTarget(null);
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
    const ceilingInfo = ceilingGeometryInfo(room, floor.defaultCeilingHeight ?? 9);
    const bounds = polygonBounds(points);
    const defaultCeilingHeight = floor.defaultCeilingHeight ?? 9;
    const ceilingExtraRise = Math.min(
      mode === "ceiling" ? 84 : 54,
      Math.max(0, ceilingInfo.peakHeight - defaultCeilingHeight) * (mode === "ceiling" ? 10 : 7),
    );
    const ceilingHeightScale = ceilingExtraRise / Math.max(1, ceilingInfo.peakHeight - defaultCeilingHeight);
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
    const usableHeight = Math.max(1, viewHeight - sketchPadding * 2 - verticalRise - ceilingExtraRise);
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
    const defaultCeilingProject = (point: TakeoffPoint) => {
      return screenProject(point, verticalRise / 2);
    };
    const ceilingProject = (point: TakeoffPoint) => {
      const height = isVaultCeilingType(ceilingInfo.ceilingType)
        ? vaultedRoofHeightAtPoint(point, bounds, ceilingInfo)
        : ceilingInfo.ceilingType === "none"
          ? defaultCeilingHeight
          : ceilingInfo.peakHeight;
      const extraZ = Math.max(0, height - defaultCeilingHeight) * ceilingHeightScale;
      return screenProject(point, verticalRise / 2 + extraZ);
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
    const generatedWallComponents = wallComponents.filter(componentIsGeneratedCeilingWall);
    const glassComponents = roomSurfaceComponents(room, "glass");
    const doorComponents = roomSurfaceComponents(room, "door");
    const floorComponent = roomSurfaceComponents(room, "floor")[0];
    const ceilingComponents = roomSurfaceComponents(room, "ceiling");
    const ceilingPanels = isVaultCeilingType(ceilingInfo.ceilingType)
      ? splitVaultFootprintAtRidge(points, bounds, ceilingInfo)
      : [points];
    const isActive = (surface: SketchTarget["surface"], direction?: TakeoffRoomComponent["direction"]) => (
      activeSketchTarget?.roomId === room.id &&
      activeSketchTarget.surface === surface &&
      (!direction || !activeSketchTarget.direction || activeSketchTarget.direction === direction)
    );
    const exteriorSegments = roomExteriorSegments(floor, room);
    const sketchWallContext = (edge: { a: TakeoffPoint; b: TakeoffPoint }) => {
      const tolerance = Math.max(0.35, floor.scale.feetPerGrid * 0.35);
      const exteriorSegment = exteriorSegments.find((segment) => sharedSegmentLength(edge, segment, tolerance) > 0.25);
      const adjacentKinds = adjacentKindsForSegment(floor, edge);
      return {
        adjacentKinds,
        direction: exteriorSegment?.direction ?? edgeDirectionFromRoom(edge, room),
        exteriorSegment,
        isLoadEdge: Boolean(exteriorSegment) || adjacentKinds.length > 0,
      };
    };
    const wallComponentForSketchEdge = (edge: { a: TakeoffPoint; b: TakeoffPoint }) => {
      const context = sketchWallContext(edge);
      if (!context.isLoadEdge) return null;
      return wallComponents.find((component) => {
        if (!component.direction || component.direction !== context.direction) return false;
        const adjacency = component.adjacency ?? "outside";
        const adjacencyKey = String(adjacency);
        if (adjacencyKey === "outside" || adjacencyKey === "exterior") return Boolean(context.exteriorSegment) && context.adjacentKinds.length === 0;
        if (adjacency === "unknown") return context.isLoadEdge;
        if (adjacency === "conditioned") return context.adjacentKinds.includes("conditioned_addition");
        return context.adjacentKinds.includes(adjacency as TakeoffAdjacentSpaceKind);
      }) ?? null;
    };
    const sketchEdgeKey = (edge: { a: TakeoffPoint; b: TakeoffPoint }) => `${edge.a.x},${edge.a.y}:${edge.b.x},${edge.b.y}`;
    const gablePeakPointsForDirection = (direction: TakeoffRoomComponent["direction"]) => {
      if (!isVaultCeilingType(ceilingInfo.ceilingType)) return null;
      if (ceilingInfo.ridgeDirection === "E-W") {
        if (direction !== "E" && direction !== "W") return null;
        const x = direction === "W" ? bounds.x : bounds.x + bounds.width;
        if (ceilingInfo.flatPeakWidth > 0.01) {
          return [
            { x, y: bounds.y + ceilingInfo.firstRun },
            { x, y: bounds.y + bounds.depth - ceilingInfo.secondRun },
          ];
        }
        return {
          x,
          y: bounds.y + bounds.depth * ceilingInfo.ridgeRatio,
        };
      }
      if (direction !== "N" && direction !== "S") return null;
      const y = direction === "N" ? bounds.y : bounds.y + bounds.depth;
      if (ceilingInfo.flatPeakWidth > 0.01) {
        return [
          { x: bounds.x + ceilingInfo.firstRun, y },
          { x: bounds.x + bounds.width - ceilingInfo.secondRun, y },
        ];
      }
      return {
        x: bounds.x + bounds.width * ceilingInfo.ridgeRatio,
        y,
      };
    };
    const labelForSurface = (surface: TakeoffRoomComponent["surface"], direction?: TakeoffRoomComponent["direction"]) => {
      if (surface === "floor") return floorComponent ? componentSketchLabel(floorComponent) : "Floor";
      if (surface === "ceiling") return ceilingComponents[0] ? componentSketchLabel(ceilingComponents[0]) : "Ceiling";
      return surface === "glass" ? "Glass" : "Door";
    };
    const openingSketchEdgeInfo = (component: TakeoffRoomComponent) => {
      if (!component.placement || !component.direction) return null;
      const edge = nearestRoomEdge(component.placement, room);
      const tolerance = Math.max(1.5, floor.scale.feetPerGrid * 1.5, floor.scale.gridSnapInches / 12);
      if (!edge || edge.distance > tolerance) return null;
      if (sketchWallContext(edge).direction !== component.direction) return null;
      const edgeLength = Math.max(0.001, distance(edge.a, edge.b));
      const t = clamp(distance(edge.a, edge.point) / edgeLength, 0.08, 0.92);
      return { edge, t };
    };
    const openingMarker = (component: TakeoffRoomComponent) => {
      const edgeInfo = openingSketchEdgeInfo(component);
      if (!edgeInfo) return null;
      const { edge, t } = edgeInfo;
      const floorA = floorProject(edge.a);
      const ceilingA = ceilingProject(edge.a);
      const floorB = floorProject(edge.b);
      const ceilingB = ceilingProject(edge.b);
      const wallBottom = { a: floorA, b: floorB };
      const wallTop = { a: ceilingA, b: ceilingB };
      const bottomCenter = {
        x: wallBottom.a.x + (wallBottom.b.x - wallBottom.a.x) * t,
        y: wallBottom.a.y + (wallBottom.b.y - wallBottom.a.y) * t,
      };
      const topCenter = {
        x: wallTop.a.x + (wallTop.b.x - wallTop.a.x) * t,
        y: wallTop.a.y + (wallTop.b.y - wallTop.a.y) * t,
      };
      const dx = wallBottom.b.x - wallBottom.a.x;
      const dy = wallBottom.b.y - wallBottom.a.y;
      const length = Math.max(Math.hypot(dx, dy), 1);
      const ux = dx / length;
      const uy = dy / length;
      const vertical = {
        x: topCenter.x - bottomCenter.x,
        y: topCenter.y - bottomCenter.y,
      };
      const verticalLength = Math.max(Math.hypot(vertical.x, vertical.y), 1);
      const vx = vertical.x / verticalLength;
      const vy = vertical.y / verticalLength;
      const panelWidth = component.surface === "glass" ? 24 : 18;
      const panelHeight = component.surface === "glass" ? 34 : 48;
      const centerHeight = component.surface === "glass" ? 0.58 : 0.46;
      const centerPoint = {
        x: bottomCenter.x + vertical.x * centerHeight,
        y: bottomCenter.y + vertical.y * centerHeight,
      };
      const halfWidth = Math.min(panelWidth, Math.max(12, length * 0.42)) / 2;
      const halfHeight = Math.min(panelHeight, Math.max(16, verticalLength * 0.64)) / 2;
      const panel = [
        { x: centerPoint.x - ux * halfWidth - vx * halfHeight, y: centerPoint.y - uy * halfWidth - vy * halfHeight },
        { x: centerPoint.x + ux * halfWidth - vx * halfHeight, y: centerPoint.y + uy * halfWidth - vy * halfHeight },
        { x: centerPoint.x + ux * halfWidth + vx * halfHeight, y: centerPoint.y + uy * halfWidth + vy * halfHeight },
        { x: centerPoint.x - ux * halfWidth + vx * halfHeight, y: centerPoint.y - uy * halfWidth + vy * halfHeight },
      ];
      const mullionA = {
        x: centerPoint.x - vx * halfHeight,
        y: centerPoint.y - vy * halfHeight,
      };
      const mullionB = {
        x: centerPoint.x + vx * halfHeight,
        y: centerPoint.y + vy * halfHeight,
      };
      const labelPoint = {
        x: centerPoint.x + uy * (halfWidth + 8),
        y: centerPoint.y - ux * (halfWidth + 8),
      };
      const active = isActive(component.surface, component.direction);
      return (
        <g
          key={`${component.surface}-${component.id}`}
          className={`takeoff-room-sketch-opening takeoff-room-sketch-opening--${component.surface} ${active ? "takeoff-room-sketch-opening--active" : ""}`}
          onClick={() => focusRoomSketchPanel(room.id, component.surface, component.direction)}
        >
          <polygon points={panel.map((point) => `${point.x},${point.y}`).join(" ")} />
          {component.surface === "glass" ? <line x1={mullionA.x} y1={mullionA.y} x2={mullionB.x} y2={mullionB.y} /> : null}
          <text x={labelPoint.x} y={labelPoint.y}>{component.assembly}</text>
        </g>
      );
    };
    const openingsBySurfaceEdge = (surface: "glass" | "door", edge: { a: TakeoffPoint; b: TakeoffPoint }) => (
      (surface === "glass" ? glassComponents : doorComponents).filter((component) => {
        const edgeInfo = openingSketchEdgeInfo(component);
        return edgeInfo && sketchEdgeKey(edgeInfo.edge) === sketchEdgeKey(edge);
      })
    );
    const updateRidgeOffsetFromSketch = (event: React.PointerEvent<SVGLineElement>) => {
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg || !isVaultCeilingType(ceilingInfo.ceilingType)) return;
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
      <div key={`${mode}-${room.id}`} className={`takeoff-room-sketch takeoff-room-sketch--${mode}`}>
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
            const context = sketchWallContext(edge);
            const direction = context.direction;
            const wallComponent = wallComponentForSketchEdge(edge);
            if (!wallComponent) return [];
            const quad = [floorProject(edge.a), floorProject(edge.b), ceilingProject(edge.b), ceilingProject(edge.a)];
            const midpoint = sketchLabelPoint(quad, (point) => point);
            const active = isActive("wall", direction);
            const label = componentSketchLabel(wallComponent);
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
          {roomEdges.flatMap((edge) => {
            const direction = edgeDirectionFromRoom(edge, room);
            const matchingGeneratedWalls = generatedWallComponents.filter((component) => component.direction === direction);
            if (matchingGeneratedWalls.length === 0) return [];
            return matchingGeneratedWalls.map((component) => {
              const active = isActive("wall", direction);
              if (component.source === "vault-gable") {
                const peakPoints = gablePeakPointsForDirection(direction);
                if (!peakPoints) return null;
                const peakList = Array.isArray(peakPoints) ? peakPoints : [peakPoints];
                const panel = [
                  defaultCeilingProject(edge.a),
                  defaultCeilingProject(edge.b),
                  ...peakList.slice().reverse().map(ceilingProject),
                ];
                const labelPoint = sketchLabelPoint(panel, (point) => point);
                return (
                  <g
                    key={`generated-${component.id}-${edge.a.x}-${edge.a.y}`}
                    className={`takeoff-room-sketch-wall takeoff-room-sketch-wall--generated ${active ? "takeoff-room-sketch-panel--active" : ""}`}
                    onClick={() => focusRoomSketchPanel(room.id, "wall", direction)}
                  >
                    <polygon points={panel.map((point) => `${point.x},${point.y}`).join(" ")} />
                    <text x={labelPoint.x} y={labelPoint.y}>{componentSketchLabel(component)}</text>
                  </g>
                );
              }
              const band = [defaultCeilingProject(edge.a), defaultCeilingProject(edge.b), ceilingProject(edge.b), ceilingProject(edge.a)];
              const labelPoint = sketchLabelPoint(band, (point) => point);
              return (
                <g
                  key={`generated-${component.id}-${edge.a.x}-${edge.a.y}`}
                  className={`takeoff-room-sketch-wall takeoff-room-sketch-wall--generated ${component.adjacency === "attic" ? "takeoff-room-sketch-wall--attic" : ""} ${active ? "takeoff-room-sketch-panel--active" : ""}`}
                  onClick={() => focusRoomSketchPanel(room.id, "wall", direction)}
                >
                  <polygon points={band.map((point) => `${point.x},${point.y}`).join(" ")} />
                  <text x={labelPoint.x} y={labelPoint.y}>{componentSketchLabel(component)}</text>
                </g>
              );
            });
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
                <text x={labelPoint.x} y={labelPoint.y}>{mode === "ceiling" && isVaultCeilingType(ceilingInfo.ceilingType) ? `${ceilingInfo.ceilingType === "vault_flat_peak" && index === 1 ? "Flat peak" : "Vault"} ${index + 1}` : labelForSurface("ceiling")}</text>
              </g>
            );
          })}
          {mode === "ceiling" && ceilingInfo.ceilingType === "tray" && trayBoundaryPoints(room, ceilingInfo.trayOffset).length >= 3 && (
            <polygon
              className="takeoff-room-sketch-tray"
              points={sketchPointList(trayBoundaryPoints(room, ceilingInfo.trayOffset), ceilingProject)}
            />
          )}
          {roomEdges.flatMap((edge) => {
            const glass = openingsBySurfaceEdge("glass", edge);
            const doors = openingsBySurfaceEdge("door", edge);
            return [
              ...glass.map((component) => openingMarker(component)),
              ...doors.map((component) => openingMarker(component)),
            ];
          })}
          {mode === "ceiling" && isVaultCeilingType(ceilingInfo.ceilingType) && (() => {
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

  function renderRoomComponentRows(room: TakeoffRectRoom, surfaces: TakeoffRoomComponent["surface"][]) {
    const exteriorDirections = roomExteriorDirections(floor, room);
    const staleCeilingWallIds = new Set(staleGeneratedCeilingWallComponents(floor, room).map((component) => component.id));
    const visibleComponents = roomComponents(room).filter((component) => surfaces.includes(component.surface));
    if (visibleComponents.length === 0) {
      return <p className="takeoff-muted">No load components in this section.</p>;
    }
    return (
      <div className="takeoff-component-list takeoff-component-list--workbench">
        {visibleComponents.map((component) => {
          const surface = component.surface;
          const options = scheduleOptionsBySurface[surface];
          const selectedDefinition = options.find((option) => option.code === component.assembly);
          const directionChoices = Array.from(new Set([
            ...exteriorDirections,
            ...(isCompassDirection(component.direction) ? [component.direction] : []),
          ]));
          const isStaleCeilingWall = staleCeilingWallIds.has(component.id);
          const sourceLabel = componentSourceLabel(component.source);
          const isActiveComponentRow = activeSketchTarget?.roomId === room.id &&
            activeSketchTarget.surface === component.surface &&
            (!activeSketchTarget.direction || !component.direction || activeSketchTarget.direction === component.direction);
          const isEditingComponent = editingComponentId === component.id;
          const treatmentLabel = surface === "wall"
            ? wallAdjacencyLabel(component.adjacency ?? "outside")
            : surface === "glass"
              ? component.solarDirection ?? "Wall direction"
              : component.loadExempt ? "Conditioned" : "—";
          const assemblyLabel = component.loadExempt
            ? "NO_LOAD - Conditioned"
            : selectedDefinition ? `${selectedDefinition.code} - ${selectedDefinition.description}` : component.assembly;
          return (
            <div key={component.id} className={`takeoff-component-row takeoff-component-row--workbench ${isEditingComponent ? "takeoff-component-row--editing" : "takeoff-component-row--readonly"} ${componentRequiresDirection(component) ? "takeoff-component-row--directional" : ""} ${isStaleCeilingWall ? "takeoff-component-row--stale" : ""} ${isActiveComponentRow ? "takeoff-component-row--active" : ""}`}>
              <span className="takeoff-component-kind">{componentSurfaceLabel(surface)}</span>
              {isEditingComponent ? (
                <>
                  <select
                    value={component.assembly}
                    className="takeoff-component-assembly"
                    disabled={component.loadExempt}
                    onChange={(event) => updateRoomComponentAssembly(room.id, component.id, surface, event.target.value)}
                  >
                    {component.loadExempt ? <option value={component.assembly}>NO_LOAD - Conditioned</option> : null}
                    {options.map((option) => (
                      <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                    ))}
                  </select>
                  {componentRequiresDirection(component) ? (
                    <select
                      value={component.direction ?? ""}
                      className="takeoff-component-direction"
                      onChange={(event) => updateRoomComponent(room.id, component.id, { direction: event.target.value as TakeoffRoomComponent["direction"] || undefined })}
                    >
                      <option value="">Direction</option>
                      {directionChoices.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
                    </select>
                  ) : <span className="takeoff-component-placeholder takeoff-component-direction-placeholder" aria-hidden="true" />}
                  {surface === "wall" && (
                    <select
                      aria-label="wall adjacent space"
                      className="takeoff-component-treatment"
                      value={component.adjacency ?? "outside"}
                      onChange={(event) => {
                        const adjacency = event.target.value as TakeoffWallAdjacency;
                        updateRoomComponent(room.id, component.id, {
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
                      className="takeoff-component-treatment"
                      value={component.solarDirection ?? ""}
                      onChange={(event) => {
                        const solarDirection = event.target.value ? event.target.value as NonNullable<TakeoffRoomComponent["solarDirection"]> : undefined;
                        updateRoomComponent(room.id, component.id, {
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
                  {surface !== "wall" && surface !== "glass" ? <span className="takeoff-component-placeholder takeoff-component-treatment-placeholder" aria-hidden="true" /> : null}
                  <input
                    aria-label={`${surface} component label`}
                    className="takeoff-component-label"
                    value={component.label ?? ""}
                    placeholder="Label"
                    onChange={(event) => updateRoomComponent(room.id, component.id, { label: event.target.value })}
                  />
                  <input
                    aria-label={`${surface} component area`}
                    type="number"
                    min="0"
                    step="1"
                    className="takeoff-component-area"
                    value={component.area}
                    onChange={(event) => updateRoomComponent(room.id, component.id, { area: Number(event.target.value) })}
                  />
                  <div className="takeoff-component-actions">
                    <button type="button" className="toolbar-primary" onClick={() => setEditingComponentId(null)}>Done</button>
                    <button type="button" onClick={() => { removeRoomComponent(room.id, component.id); setEditingComponentId(null); }}>Remove</button>
                  </div>
                </>
              ) : (
                <>
                  <span className="takeoff-component-display takeoff-component-assembly" title={assemblyLabel}>{assemblyLabel}</span>
                  <span className="takeoff-component-display takeoff-component-direction">{component.direction ?? "All"}</span>
                  <span className="takeoff-component-display takeoff-component-treatment">{treatmentLabel}</span>
                  <span className="takeoff-component-display takeoff-component-label">{component.label || selectedDefinition?.description || componentSurfaceLabel(surface)}</span>
                  <span className="takeoff-component-display takeoff-component-area">{Math.round(component.area)} sf</span>
                  <button type="button" className="takeoff-component-edit" onClick={() => setEditingComponentId(component.id)}>Edit</button>
                </>
              )}
              <p className="takeoff-component-meta">
                <strong>{selectedDefinition?.code ?? component.assembly}</strong>
                {sourceLabel ? <em>{sourceLabel}</em> : null}
                {component.loadExempt ? <em>No load</em> : null}
                {isStaleCeilingWall ? " · Stale ceiling-generated wall" : ""}
                {component.surface === "glass" && component.solarDirection ? ` · Solar ${component.solarDirection}` : ""}
                {selectedDefinition?.description ? ` · ${selectedDefinition.description}` : ""}
                {component.loadExempt ? "" : <>{" · "}{componentThermalSummary(selectedDefinition)}</>}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  function renderAreaWorkspace(room: TakeoffRectRoom, surface: "floor" | "ceiling") {
    const roomArea = expectedSurfaceArea(room, surface);
    const assigned = componentAreaTotal(room, surface);
    const delta = roomArea - assigned;
    const areaCheck = roomAreaReconciliation(room, surface);
    return (
      <div
        id={validationTargetId(componentValidationSection(surface))}
        className={`takeoff-workbench-section-body ${validationSectionClass(componentValidationSection(surface))}`}
      >
        <p className={assigned > roomArea + 0.5 ? "takeoff-component-total takeoff-component-total--error" : "takeoff-component-total"}>
          Assigned {Math.round(assigned)} / {Math.round(roomArea)} sf
          {Math.abs(delta) > 0.5 ? ` · ${delta > 0 ? Math.round(delta) + " sf open" : Math.round(Math.abs(delta)) + " sf over"}` : " · balanced"}
        </p>
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
            <button onClick={() => setRoomSurfaceFullArea(room.id, surface)}>Set = {surface === "ceiling" ? "ceiling area" : "room area"}</button>
            <button onClick={() => setRoomSurfaceNoLoad(room.id, surface)}>No {componentSurfaceLabel(surface)} load</button>
          </div>
        </div>
        {renderRoomComponentRows(room, [surface])}
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
        ceilingFlatPeakWidth: undefined,
        ceilingTrayOffset: undefined,
        ceilingTrayShape: undefined,
        ceilingTrayMode: undefined,
        ceilingTraySteps: undefined,
        components: roomComponents(room).filter((component) => component.surface !== "ceiling"),
      };
    }
    const vaultCeiling = isVaultCeilingType(ceilingType);
    const nextRoom = {
      ...room,
      ceilingType,
      ceilingLowHeight: vaultCeiling ? room.ceilingLowHeight ?? room.ceilingHeight : undefined,
      ceilingPeakHeight: vaultCeiling ? room.ceilingPeakHeight ?? Math.max(room.ceilingHeight, room.ceilingHeight + 1) : undefined,
      ceilingRidgeDirection: vaultCeiling ? room.ceilingRidgeDirection ?? "E-W" : undefined,
      ceilingRidgeOffset: vaultCeiling ? room.ceilingRidgeOffset ?? 0 : undefined,
      ceilingFlatPeakWidth: ceilingType === "vault_flat_peak" ? room.ceilingFlatPeakWidth ?? 4 : undefined,
      ceilingTrayOffset: ceilingType === "tray" ? room.ceilingTrayOffset ?? 2 : undefined,
      ceilingTrayShape: ceilingType === "tray" ? room.ceilingTrayShape ?? "rectangular" : undefined,
      ceilingTrayMode: ceilingType === "tray" ? room.ceilingTrayMode ?? "smart_box" : undefined,
      ceilingTraySteps: ceilingType === "tray" ? trayStepCount(room) : undefined,
    };
    const normalizedCeiling = defaultCeilingLoadComponentsForRoom(nextRoom);
    return {
      ...nextRoom,
      ceilingGeometryApproved: false,
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
          !(isVaultCeilingType(ceilingInfo.ceilingType) && component.surface === "ceiling")
        );
        if (isVaultCeilingType(ceilingInfo.ceilingType)) {
          return {
            ...room,
            ceilingGeometryApproved: true,
            components: [
              ...baseComponents,
              ...defaultCeilingLoadComponentsForRoom(room),
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
        const roomArea = surface === "floor" || surface === "ceiling" ? expectedSurfaceArea(room, surface) : rectArea(room);
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

  function updateRoomComponentAssembly(roomId: string, componentId: string, surface: TakeoffRoomComponent["surface"], assembly: string) {
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return {
          ...room,
          components: roomComponents(room).map((component) => {
            if (component.id !== componentId) return component;
            const nextLabel = surface === "ceiling"
              ? component.label
              : surface === "floor"
                ? component.label
                : component.label;
            return { ...component, assembly, label: nextLabel };
          }),
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
        if (surface === "ceiling" && room.ceilingType === "vault_flat_peak") {
          return {
            ...room,
            components: [
              ...roomComponents(room).filter((entry) => entry.surface !== surface),
              ...defaultCeilingLoadComponentsForRoom(room),
            ],
          };
        }
        const existing = roomSurfaceComponents(room, surface).find((component) => !component.loadExempt);
        const expectedArea = expectedSurfaceArea(room, surface);
        const component = {
          ...(existing ?? defaultComponent(surface, expectedArea)),
          area: Number(expectedArea.toFixed(3)),
          loadExempt: false,
          panelPolygons: undefined,
        };
        return {
          ...room,
          components: [
            ...roomComponents(room).filter((entry) => entry.surface !== surface),
            component,
          ],
        };
      }),
    }));
    setMessage(`${componentSurfaceLabel(surface)} set to full ${surface === "ceiling" ? "ceiling" : "room"} area.`);
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
              ceilingFlatPeakWidth: surface === "ceiling" ? undefined : room.ceilingFlatPeakWidth,
              ceilingTrayMode: surface === "ceiling" ? undefined : room.ceilingTrayMode,
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

  function applySurfaceTreatmentSuggestion(issue: TakeoffValidationIssue) {
    const suggestion = issue.surfaceTreatmentSuggestion;
    const roomId = issue.target?.roomId;
    if (!suggestion || !roomId) return;

    if (suggestion.action === "none" || suggestion.exposedArea <= 0.5) {
      setRoomSurfaceNoLoad(roomId, suggestion.surface);
      return;
    }

    const surface = suggestion.surface;
    const componentArea = Number(Math.max(0, suggestion.exposedArea).toFixed(3));
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        const existingLoadComponents = roomSurfaceComponents(room, surface).filter((component) => !component.loadExempt);
        const suggestedLoadComponents = suggestion.loadComponents?.length
          ? suggestion.loadComponents
          : [{
              area: componentArea,
              assembly: suggestion.assembly,
              label: suggestion.label,
              adjacency: suggestion.adjacency,
              boundary: suggestion.boundary,
              panelPolygons: suggestion.panelPolygons,
            }];
        const loadComponents: TakeoffRoomComponent[] = suggestedLoadComponents
          .filter((component) => component.area > 0.5)
          .map((component, index) => {
            const existing = existingLoadComponents[index];
            return {
              ...(existing ?? defaultComponent(surface, component.area)),
              surface,
              assembly: component.assembly || existing?.assembly || (surface === "ceiling" ? "C1" : "F1"),
              area: Number(Math.max(0, component.area).toFixed(3)),
              label: component.label || existing?.label || (surface === "ceiling" ? "Ceiling exposed to attic/roof" : "Framed/exposed floor"),
              adjacency: component.adjacency,
              boundary: component.boundary,
              loadExempt: false,
              panelPolygons: component.panelPolygons?.length ? component.panelPolygons : undefined,
            };
          });
        const conditionedArea = Number(Math.max(0, suggestion.conditionedArea).toFixed(3));
        const conditionedComponent: TakeoffRoomComponent | null = suggestion.action === "partial" && conditionedArea > 0.5
          ? {
              ...defaultComponent(surface, conditionedArea),
              assembly: "NO_LOAD",
              area: conditionedArea,
              label: surface === "ceiling" ? "Conditioned space above - no load" : "Conditioned space below - no load",
              loadExempt: true,
              panelPolygons: suggestion.conditionedPanelPolygons?.length ? suggestion.conditionedPanelPolygons : undefined,
            }
          : null;
        return {
          ...room,
          floorType: surface === "floor" ? (loadComponents.some((component) => component.assembly === "F2") ? "slab" : "framed") : room.floorType,
          ceilingType: surface === "ceiling" ? "flat" : room.ceilingType,
          ceilingGeometryApproved: surface === "ceiling" ? false : room.ceilingGeometryApproved,
          ceilingLowHeight: surface === "ceiling" ? undefined : room.ceilingLowHeight,
          ceilingPeakHeight: surface === "ceiling" ? undefined : room.ceilingPeakHeight,
          ceilingRidgeDirection: surface === "ceiling" ? undefined : room.ceilingRidgeDirection,
          ceilingRidgeOffset: surface === "ceiling" ? undefined : room.ceilingRidgeOffset,
          components: [
            ...roomComponents(room).filter((entry) => entry.surface !== surface),
            ...loadComponents,
            ...(conditionedComponent ? [conditionedComponent] : []),
          ],
        };
      }),
    }));
    setMessage(
      suggestion.action === "partial"
        ? `${componentSurfaceLabel(surface)} split applied: ${Math.round(suggestion.conditionedArea)} sf conditioned, ${Math.round(componentArea)} sf exposed.`
        : `${componentSurfaceLabel(surface)} set to ${Math.round(componentArea)} sf.`,
    );
  }

  function applyWallComponentGeometrySuggestion(issue: TakeoffValidationIssue) {
    const suggestion = issue.wallComponentGeometrySuggestion;
    const roomId = issue.target?.roomId;
    if (!suggestion || !roomId) return;
    const roomName = floor.rooms.find((room) => room.id === roomId)?.name || "Room";

    if (suggestion.action === "remove") {
      removeRoomComponent(roomId, suggestion.componentId);
      setMessage(`${suggestion.label || "Wall component"} removed from ${roomName}; that boundary is no longer exterior/load-bearing.`);
      return;
    }

    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return {
          ...room,
          components: roomComponents(room).map((component) => (
            component.id === suggestion.componentId
              ? {
                  ...component,
                  area: Math.round(Math.max(0, suggestion.area ?? component.area)),
                  assembly: suggestion.assembly ?? component.assembly,
                  adjacency: suggestion.adjacency ?? component.adjacency,
                  label: suggestion.label ?? component.label,
                  source: "exterior-perimeter",
                }
              : component
          )),
        };
      }),
    }));
    setMessage(`${suggestion.direction || "Wall"} wall slice updated to ${Math.round(suggestion.area ?? 0)} sf for ${roomName}.`);
  }

  function applyGlassTreatmentSuggestion(issue: TakeoffValidationIssue) {
    const suggestion = issue.glassTreatmentSuggestion;
    const roomId = issue.target?.roomId;
    if (!suggestion || !roomId || suggestion.action !== "shade") return;
    const roomName = floor.rooms.find((room) => room.id === roomId)?.name || "Room";

    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return {
          ...room,
          components: roomComponents(room).map((component) => {
            if (component.id !== suggestion.componentId || component.surface !== "glass") return component;
            return {
              ...component,
              solarDirection: suggestion.solarDirection,
              label: isAutoOpeningLabel(component.label)
                ? suggestion.label || defaultOpeningLabel("glass", suggestion.solarDirection)
                : component.label,
            };
          }),
        };
      }),
    }));
    setMessage(`${roomName} glass marked as shaded.`);
  }

  function applyInternalGainSuggestion(issue: TakeoffValidationIssue) {
    const suggestion = issue.internalGainSuggestion;
    const roomId = issue.target?.roomId;
    if (!suggestion || !roomId || suggestion.action !== "set-overrides") return;
    const roomName = floor.rooms.find((room) => room.id === roomId)?.name || "Room";

    updateRoom(roomId, {
      roomType: suggestion.roomType,
      peopleOverride: suggestion.people,
      applianceWattsOverride: suggestion.applianceWatts,
    });
    setActiveValidationTarget(null);
    setMessage(`${roomName} set to ${suggestion.label || `${suggestion.people} person + ${suggestion.applianceWatts} W`}.`);
  }

  function applyOpenToAboveEnvelopeSuggestion(issue: TakeoffValidationIssue) {
    const suggestion = issue.openToAboveEnvelopeSuggestion;
    const roomId = issue.target?.roomId;
    if (!suggestion || !roomId || suggestion.action !== "generate-wall-extensions") return;
    const roomName = floor.rooms.find((room) => room.id === roomId)?.name || "Room";

    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((room) => {
        if (room.id !== roomId) return room;
        return {
          ...room,
          verticalLinks: (room.verticalLinks ?? []).map((link) => (
            link.id === suggestion.linkId
              ? { ...link, envelopeMode: "generate_wall_extensions" as const }
              : link
          )),
        };
      }),
    }));
    setActiveValidationTarget(null);
    setMessage(`${roomName} will export open-to-above wall extensions as separate oriented line items.`);
  }

  function applyVerticalMergeSuggestion(issue: TakeoffValidationIssue, reportingFloorId: string) {
    const suggestion = issue.verticalMergeSuggestion;
    if (!suggestion || suggestion.action !== "create-connected-volume") return;
    const sourceFloor = floors.find((entry) => entry.id === suggestion.sourceFloorId);
    const targetFloor = floors.find((entry) => entry.id === suggestion.targetFloorId);
    const sourceRoom = sourceFloor?.rooms.find((room) => room.id === suggestion.sourceRoomId);
    const targetRoom = targetFloor?.rooms.find((room) => room.id === suggestion.targetRoomId);
    if (!sourceFloor || !targetFloor || !sourceRoom || !targetRoom) return;

    const resolvedReportingFloorId = reportingFloorId === targetFloor.id || reportingFloorId === sourceFloor.id
      ? reportingFloorId
      : suggestion.defaultReportingFloorId;
    const reportingFloor = resolvedReportingFloorId === targetFloor.id ? targetFloor : sourceFloor;
    const assignedRoom = resolvedReportingFloorId === targetFloor.id ? targetRoom : sourceRoom;
    const volumeId = nextId("connected-volume");
    const sourceFootprintId = nextId("connected-volume-footprint");
    const targetFootprintId = nextId("connected-volume-footprint");
    const linkId = nextId("vertical-link");

    pushUndoSnapshot("connected vertical volume");
    setConnectedVolumes((current) => {
      if (connectedVolumeLinksRoomPair(current, sourceFloor.id, sourceRoom.id, targetFloor.id, targetRoom.id)) return current;
      return [
        ...current,
        {
          id: volumeId,
          name: `${sourceRoom.name || "Lower room"} + ${targetRoom.name || "Upper room"}`,
          assignedRoomId: assignedRoom.id,
          reportingFloorId: reportingFloor.id,
          envelopeMode: "review",
          footprints: [
            {
              id: sourceFootprintId,
              floorId: sourceFloor.id,
              role: "lower",
              roomIds: [sourceRoom.id],
              polygon: roomCorners(sourceRoom),
              label: sourceRoom.name || "Lower footprint",
            },
            {
              id: targetFootprintId,
              floorId: targetFloor.id,
              role: "upper",
              roomIds: [targetRoom.id],
              polygon: roomCorners(targetRoom),
              label: targetRoom.name || "Upper footprint",
            },
          ],
        },
      ];
    });
    setFloors((current) => current.map((entry) => {
      if (entry.id !== sourceFloor.id) return entry;
      return {
        ...entry,
        rooms: entry.rooms.map((room) => {
          if (room.id !== sourceRoom.id) return room;
          const existingLink = openToAboveLinkForRoom(room);
          const nextLink = {
            id: existingLink?.id ?? linkId,
            type: "open_to_above" as const,
            targetFloorId: targetFloor.id,
            previousCeilingHeight: existingLink?.previousCeilingHeight ?? room.ceilingHeight,
            envelopeMode: "review" as const,
            ceilingAreaMode: "connected_volume" as const,
          };
          const linkedRoom = {
            ...room,
            verticalLinks: [...(room.verticalLinks ?? []).filter((link) => link.type !== "open_to_above"), nextLink],
          };
          return {
            ...linkedRoom,
            ceilingHeight: Number(computedOpenToAboveHeight(entry, linkedRoom, current).toFixed(3)),
          };
        }),
      };
    }));
    setActiveFloorId(reportingFloor.id);
    setSelectedRoomId(assignedRoom.id);
    setActiveValidationTarget(null);
    setMessage(`${sourceRoom.name || "Lower room"} and ${targetRoom.name || "upper room"} connected; combined attributes assigned to ${reportingFloor.name || "the selected floor"}.`);
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
    openPlanReviewMode("elevation");
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
    suggestion: Pick<RoomExteriorWallSuggestion, "direction" | "area" | "geometryLabel">,
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
              ? { ...component, assembly, adjacency, area: Math.round(suggestion.area), label: `${suggestion.direction} ${label.toLowerCase()}`, geometryLabel: suggestion.geometryLabel, source: "exterior-perimeter" }
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
              geometryLabel: suggestion.geometryLabel,
              source: "exterior-perimeter",
              adjacency,
            },
          ],
        };
      }),
    }));
  }

  function applySuggestedWallAreas(
    roomId: string,
    rows: Array<{ suggestion: Pick<RoomExteriorWallSuggestion, "direction" | "area" | "geometryLabel">; recommendation: { assembly: string; adjacency: TakeoffWallAdjacency } }>,
  ) {
    rows.forEach((row) => {
      applySuggestedWallArea(roomId, row.suggestion, row.recommendation.assembly, row.recommendation.adjacency);
    });
  }

  function resolveBoundaryCandidate(candidateId: string, resolution: "slice" | "whole-section" | "ignore", floorId = activeFloorId) {
    const targetFloor = floors.find((entry) => entry.id === floorId) ?? floor;
    const candidate = boundaryCandidatesForFloor(targetFloor).find((entry) => entry.id === candidateId);
    if (!candidate) {
      setMessage("That boundary warning is no longer current.");
      return;
    }
    pushUndoSnapshot("boundary suggestion");
    const kneeWallArea = resolution === "whole-section" ? candidate.wholeSectionArea : candidate.area;
    const exteriorOverlapArea = resolution === "whole-section" ? candidate.wholeSectionArea : candidate.existingWallOverlapArea;
    setFloors((currentFloors) => currentFloors.map((entry) => {
      if (entry.id !== targetFloor.id) return entry;
      return {
        ...entry,
        boundaryCandidateResolutions: {
          ...(entry.boundaryCandidateResolutions ?? {}),
          [candidate.id]: resolution,
        },
        rooms: entry.rooms.map((room) => {
          if (room.id !== candidate.roomId || resolution === "ignore") return room;
          const components = roomComponents(room);
          const nextComponents = components.map((component) => {
            if (
              exteriorOverlapArea > 0 &&
              component.surface === "wall" &&
              component.direction === candidate.direction &&
              wallCanHostOpenings(component)
            ) {
              return { ...component, area: Math.max(0, Math.round((component.area || 0) - exteriorOverlapArea)) };
            }
            return component;
          });
          return {
            ...room,
            components: [
              ...nextComponents,
              {
                id: nextId("component-boundary-wall"),
                surface: "wall",
                assembly: candidate.recommendedAssembly,
                direction: candidate.direction,
                area: Math.round(kneeWallArea),
                label: resolution === "whole-section" ? `${candidate.direction} porch knee-wall section` : `${candidate.direction} porch knee-wall slice`,
                source: "manual",
                adjacency: candidate.recommendedAdjacency,
                boundary: candidate.recommendedBoundary,
                geometryLabel: `${candidate.adjacentSpaceName} ${candidate.zMin}-${candidate.zMax} ft`,
                spanStart: candidate.spanStart,
                spanEnd: candidate.spanEnd,
                zMin: candidate.zMin,
                zMax: candidate.zMax,
              },
            ],
          };
        }),
      };
    }));
    setActiveFloorId(targetFloor.id);
    setMessage(
      resolution === "ignore"
        ? "Boundary warning ignored for this adjacent space."
        : `${Math.round(kneeWallArea)} sf ${candidate.recommendedAssembly} knee-wall component added to ${candidate.roomName}.`
    );
  }

  function addSelectedWorkbenchComponent(roomId: string) {
    if (!componentAddSurface) return;
    addRoomComponent(roomId, componentAddSurface);
    setComponentAddSurface("");
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
    if (component && !window.confirm(`Remove ${component.label || "this opening"} from ${room?.name || "this room"}? This cannot be undone.`)) return;
    removeRoomComponent(selectedOpening.roomId, selectedOpening.componentId);
    setEditingOpeningTarget(null);
    setOpeningPlacement(null);
    setSelectedOpening(null);
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

  async function renderPdfPreview(source: File | string, pageNumber = 1): Promise<PdfPreviewResult> {
    setReferenceRenderStatus("Rendering PDF preview...");
    const arrayBuffer = typeof source === "string"
      ? await fetch(source).then((response) => {
          if (!response.ok) throw new Error("Could not download the saved PDF reference.");
          return response.arrayBuffer();
        })
      : await source.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const resolvedPageNumber = Math.min(Math.max(1, Math.round(pageNumber)), pdf.numPages);
    const page = await pdf.getPage(resolvedPageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const pixelLimitedScale = Math.sqrt(pdfPreviewMaxPixels / Math.max(1, baseViewport.width * baseViewport.height));
    const dimensionLimitedScale = Math.min(
      pdfPreviewMaxDimension / Math.max(1, baseViewport.width),
      pdfPreviewMaxDimension / Math.max(1, baseViewport.height),
    );
    const scale = Math.max(0.25, Math.min(pdfPreviewTargetScale, pixelLimitedScale, dimensionLimitedScale));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create PDF preview canvas.");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const downscaled = scale < pdfPreviewTargetScale;
    setReferenceRenderStatus(
      downscaled
        ? `Rendered page ${resolvedPageNumber} of ${pdf.numPages} at ${Math.round(scale * 100)}% for preview.`
        : `Rendered page ${resolvedPageNumber} of ${pdf.numPages}.`,
    );
    return {
      url: canvas.toDataURL("image/png"),
      pageNumber: resolvedPageNumber,
      pageCount: pdf.numPages,
      scale,
      widthPx: canvas.width,
      heightPx: canvas.height,
    };
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

  function snapToExistingGeometry(point: TakeoffPoint, options: { includeFloorAlignment?: boolean; excludeActiveExterior?: boolean } = {}) {
    const localThreshold = Math.max(0.75, floor.scale.gridSnapInches / 12);
    const floorAlignmentThreshold = Math.max(3, floor.scale.gridSnapInches / 12);
    let best = { point, distance: Number.POSITIVE_INFINITY };
    const considerSegmentSet = (points: TakeoffPoint[], threshold: number) => {
      if (points.length < 2) return;
      for (let index = 0; index < points.length; index += 1) {
        const start = points[index];
        const end = points[(index + 1) % points.length];
        const startDistance = distance(point, start);
        if (startDistance <= threshold && startDistance <= best.distance) best = { point: start, distance: startDistance };
        const projected = closestPointOnSegment(point, start, end);
        const projectedDistance = distance(point, projected);
        if (projectedDistance <= threshold && projectedDistance <= best.distance) best = { point: projected, distance: projectedDistance };
      }
    };
    const segmentSets = [
      ...(options.excludeActiveExterior ? [] : [floor.exteriorPolygon]),
      ...floor.rooms.map((room) => roomCorners(room)),
      ...activeOpenToBelowReservations.map((reservation) => reservation.points),
    ].filter((points) => points.length >= 2);

    for (const points of segmentSets) {
      considerSegmentSet(points, localThreshold);
    }

    if (options.includeFloorAlignment && floor.floorAlignmentSnapEnabled !== false) {
      for (const entry of [nearestFloorByElevation(floor, floors, "below"), nearestFloorByElevation(floor, floors, "above")]) {
        if (!entry) continue;
        const exteriorPoints = exteriorRingPoints(entry);
        if (polygonArea(exteriorPoints) > 0.5) considerSegmentSet(exteriorPoints, floorAlignmentThreshold);
      }
    }

    const snapped = Number.isFinite(best.distance) ? best.point : point;
    return { x: Number(snapped.x.toFixed(3)), y: Number(snapped.y.toFixed(3)) };
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

  function prepareCornerPoint(point: TakeoffPoint, previous: TakeoffPoint | undefined, constrainAngle: boolean, includeFloorAlignment = false, excludeActiveExterior = false) {
    const snapped = snapToExistingGeometry(point, { includeFloorAlignment, excludeActiveExterior });
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

  function adjacentSpacePointForEvent(point: TakeoffPoint, precise: boolean) {
    return precise ? point : snapAdjacentSpacePoint(point);
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
    const snapped = snapToExistingGeometry(point, { includeFloorAlignment: target.type === "exterior" });
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

  function referenceCropFromDisplayedRect(floorForCrop: TakeoffFloor, displayedRect: PlanRect) {
    const fullCrop = referenceFullCropForFloor(floorForCrop);
    const display = referenceDisplayRectForFloor(floorForCrop, fullCrop);
    const clampToFull = (value: number, max: number) => Math.min(max, Math.max(0, value));
    const x1 = clampToFull(((displayedRect.x - display.x) / Math.max(display.width, 1)) * fullCrop.width, fullCrop.width);
    const y1 = clampToFull(((displayedRect.y - display.y) / Math.max(display.depth, 1)) * fullCrop.depth, fullCrop.depth);
    const x2 = clampToFull(((displayedRect.x + displayedRect.width - display.x) / Math.max(display.width, 1)) * fullCrop.width, fullCrop.width);
    const y2 = clampToFull(((displayedRect.y + displayedRect.depth - display.y) / Math.max(display.depth, 1)) * fullCrop.depth, fullCrop.depth);
    return {
      x: Number(Math.min(x1, x2).toFixed(3)),
      y: Number(Math.min(y1, y2).toFixed(3)),
      width: Number(Math.abs(x2 - x1).toFixed(3)),
      depth: Number(Math.abs(y2 - y1).toFixed(3)),
    };
  }

  function rotateReferenceBeforeCrop() {
    if (!floor.reference) return;
    if (referenceRotationLocked) {
      setMessage("Reference rotation is locked after crop/scale, tracing, rooms, or adjacent spaces have been started.");
      return;
    }
    setFloor((current) => {
      if (!current.reference) return current;
      const nextRotation = normalizeReferenceRotation((current.reference.rotationDeg ?? 0) + 90);
      const fullCrop = referenceFullCropForFloor({ ...current, reference: { ...current.reference, rotationDeg: nextRotation } }, nextRotation);
      return {
        ...current,
        reference: {
          ...current.reference,
          rotationDeg: nextRotation,
          crop: fullCrop,
        },
        calibration: { ...current.calibration, lines: [], linesVisible: true, confirmed: false, appliedFactor: 1, areaConfirmed: false },
        alignment: current.alignment
          ? { ...current.alignment, pointPairs: [], transform: defaultAlignmentTransform() }
          : current.alignment,
      };
    });
    setWorkflowStep("crop");
    setMessage("Reference rotated 90 degrees. Review the orientation, then crop or proceed without cropping.");
  }

  function mirrorModeledPlan() {
    const ok = window.confirm(
      "Mirror the modeled plan left/right?\n\nThis mirrors every floor, the imported plan PDFs, rooms, adjacent spaces, openings, and directional load components. Compass directions such as E/W will be remapped. This can be reversed by running Mirror Model again, but review surfaces and validations afterward."
    );
    if (!ok) return;
    pushUndoSnapshot("mirror model");
    setFloors((current) => current.map(mirrorFloorHorizontal));
    setFrontDoorFaces((current) => mirrorCompassHorizontal(current) as typeof current);
    setMessage("Modeled plan mirrored left/right. Review validation flags, wall directions, glass exposure, and plan PDF alignment.");
  }

  function applyCrop(crop: { x: number; y: number; width: number; depth: number }) {
    const referenceCrop = referenceCropFromDisplayedRect(floor, crop);
    if (referenceCrop.width < 1 || referenceCrop.depth < 1) {
      setMessage("Crop area is too small. Drag around the plan area you want to keep.");
      return;
    }
    if (canAlignCurrentReference) {
      setFloor((current) => ({
        ...current,
        reference: current.reference ? { ...current.reference, crop: referenceCrop } : current.reference,
        calibration: {
          ...current.calibration,
          lines: [],
          linesVisible: false,
          confirmed: true,
          appliedFactor: alignmentReferenceScaleFactor,
          areaConfirmed: false,
        },
        alignment: {
          ...(current.alignment ?? {}),
          referenceFloorId: current.alignment?.referenceFloorId ?? alignmentReferenceFloor?.id,
          pointPairs: current.alignment?.pointPairs ?? [],
          transform: defaultAlignmentTransform(),
        },
      }));
      setWorkflowStep("trace");
      setPlanReviewMode("alignment");
      setMessage("Crop applied. The active floor inherited the selected reference floor's scale metadata; use the alignment controls for fine adjustment.");
      return;
    }
    setFloor((current) => ({
      ...current,
      reference: current.reference ? { ...current.reference, crop: referenceCrop } : current.reference,
    }));
    setWorkflowStep("calibrate");
    setMessage("Crop applied. Add known dimension lines to set plan scale.");
  }

  function clearCrop() {
    setFloor((current) => ({
      ...current,
      reference: current.reference
        ? { ...current.reference, crop: referenceFullCropForFloor(current) }
        : current.reference,
    }));
    setWorkflowStep("crop");
    setPlanReviewMode("plan");
    setMessage("Crop reset. Drag a new crop around the plan area.");
  }

  function proceedWithoutCropping() {
    const fullCrop = referenceDisplayRectForFloor(floor, referenceFullCropForFloor(floor));
    applyCrop(fullCrop);
  }

  function enterCropMode() {
    setWorkflowStep("crop");
    setPlanReviewMode("plan");
    setRoomDrawMode(false);
    setMessage("Crop mode enabled. Drag a rectangle around the plan area, or proceed without cropping.");
  }

  function continueToAlignment() {
    if (!canAlignCurrentReference) {
      setMessage("Upload references for this floor and another floor before opening alignment.");
      return;
    }
    setWorkflowStep("trace");
    setPlanReviewMode("alignment");
    setMessage("Use the alignment controls to slide and scale the active floor over the selected reference floor.");
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
    const reservationBlockers = activeOpenToBelowReservations.map((reservation) => pointsToClipPolygon(reservation.points));
    if (blockers.length > 0 || reservationBlockers.length > 0) {
      available = difference(available, ...blockers, ...reservationBlockers);
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
      ...(adjacentSpaceKind === "covered_porch"
        ? {
            closedCeilingBelow: false,
            boundaryIntent: "attic" as const,
            ceilingHeight: floor.defaultCeilingHeight ?? 9,
            ceilingType: "flat" as const,
            verticalProfile: { kind: "flat" as const, zMin: floor.defaultCeilingHeight ?? 9, zMax: floor.defaultCeilingHeight ?? 9 },
          }
        : {}),
    };
    const touchesExterior = floor.rooms.some((room) =>
      roomExteriorSegments(floor, room).some((segment) =>
        adjacentSpaceTouchesSegment(space, segment, Math.max(0.35, floor.scale.feetPerGrid * 0.35))
      )
    );
    setFloor((current) => ({ ...current, adjacentSpaces: [...(current.adjacentSpaces ?? []), space] }));
    setSelectedRoomId(space.id);
    setMessage(touchesExterior
      ? space.kind === "conditioned_addition"
        ? `${space.name} added. Convert it to a conditioned room when the addition shape looks right.`
        : `${space.name} added. Shared walls will be tagged in room reconciliation.`
      : `${space.name} added. It does not appear to touch a conditioned exterior wall yet.`);
  }

  function convertAdjacentSpaceToConditionedRoom(id: string) {
    const space = (floor.adjacentSpaces ?? []).find((entry) => entry.id === id);
    if (!space) return;
    const additionPoints = simplifiedRoomPolygon(adjacentSpaceCorners(space));
    if (additionPoints.length < 3 || rectArea({ ...space, polygon: additionPoints }) <= 0.5) {
      setMessage("Draw a larger adjacent addition before converting it to a room.");
      return;
    }

    const exteriorPoints = exteriorRingPoints(floor);
    if (exteriorPoints.length < 3) {
      setMessage("Trace or define the exterior footprint before converting an addition.");
      return;
    }

    const additionArea = polygonArea(additionPoints);
    const existingExteriorArea = polygonArea(exteriorPoints);
    const mergedExterior = largestClipPolygon(union(pointsToClipPolygon(exteriorPoints), pointsToClipPolygon(additionPoints)));
    const mergedExteriorArea = mergedExterior ? clipPolygonArea(mergedExterior) : 0;
    if (!mergedExterior || mergedExteriorArea < existingExteriorArea + additionArea - Math.max(1, additionArea * 0.03)) {
      setMessage("The addition must touch the exterior footprint before it can be converted to conditioned space.");
      return;
    }

    const exteriorPolygon = simplifyPolygonPoints(clipPolygonToPoints(mergedExterior), {
      duplicateTolerance: 0.02,
      collinearTolerance: Math.max(0.08, floor.scale.gridSnapInches / 36),
      shortSegmentTolerance: 0,
    });
    const bounds = polygonBounds(additionPoints);
    const roomName = space.kind === "conditioned_addition" ? space.name.replace(/conditioned addition/i, "Addition") : space.name;
    const room: TakeoffRectRoom = {
      id: nextId("room"),
      name: roomName || `Room ${floor.rooms.length + 1}`,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      depth: bounds.depth,
      polygon: additionPoints,
      ceilingHeight: space.ceilingHeight ?? floor.defaultCeilingHeight ?? draftRoom.ceilingHeight,
      ceilingType: space.ceilingType === "none" ? "flat" : (space.ceilingType ?? "flat"),
      ceilingLowHeight: space.ceilingLowHeight,
      ceilingPeakHeight: space.ceilingPeakHeight,
      ceilingRidgeDirection: space.ceilingRidgeDirection,
    };
    const roomWithComponents = { ...room, components: defaultRoomComponents(rectArea(room)) };
    const exteriorBounds = polygonBounds(exteriorPolygon);

    setFloor((current) => ({
      ...current,
      rooms: [...current.rooms, roomWithComponents],
      adjacentSpaces: (current.adjacentSpaces ?? []).filter((entry) => entry.id !== id),
      exteriorPolygon,
      conditionedPerimeter: {
        width: Number(Math.max(current.conditionedPerimeter.width, exteriorBounds.x + exteriorBounds.width).toFixed(3)),
        depth: Number(Math.max(current.conditionedPerimeter.depth, exteriorBounds.y + exteriorBounds.depth).toFixed(3)),
      },
    }));
    setSelectedRoomId(roomWithComponents.id);
    setMessage(`${roomWithComponents.name} converted to conditioned space. Review the new wall, floor, and ceiling suggestions.`);
  }

  function removeAdjacentSpace(id: string) {
    setFloor((current) => ({ ...current, adjacentSpaces: (current.adjacentSpaces ?? []).filter((space) => space.id !== id) }));
    if (selectedRoomId === id) setSelectedRoomId(null);
  }

  function updateAdjacentSpace(id: string, patch: Partial<TakeoffAdjacentSpace>) {
    setFloor((current) => ({
      ...current,
      adjacentSpaces: (current.adjacentSpaces ?? []).map((space) => (space.id === id ? { ...space, ...patch } : space)),
    }));
  }

  function updateAdjacentSpaceCeilingGeometry(id: string, patch: Partial<Pick<
    TakeoffAdjacentSpace,
    "ceilingHeight" | "ceilingType" | "ceilingLowHeight" | "ceilingPeakHeight" | "ceilingRidgeDirection" | "ceilingRidgeOffset" | "ceilingFlatPeakWidth" | "closedCeilingBelow"
  >>) {
    setFloor((current) => ({
      ...current,
      adjacentSpaces: (current.adjacentSpaces ?? []).map((space) => {
        if (space.id !== id) return space;
        const next: TakeoffAdjacentSpace = { ...space, ...patch };
        if (isVaultCeilingType(next.ceilingType ?? "flat")) {
          if (patch.ceilingLowHeight != null) next.ceilingHeight = patch.ceilingLowHeight;
          if (patch.ceilingHeight != null && patch.ceilingLowHeight == null) next.ceilingLowHeight = patch.ceilingHeight;
          const lowHeight = next.ceilingLowHeight ?? next.ceilingHeight ?? current.defaultCeilingHeight ?? 9;
          next.ceilingHeight = lowHeight;
          next.ceilingLowHeight = lowHeight;
          next.ceilingPeakHeight = Math.max(lowHeight, next.ceilingPeakHeight ?? lowHeight + 1);
        } else if (next.ceilingType === "flat") {
          next.ceilingLowHeight = undefined;
          next.ceilingPeakHeight = undefined;
          next.ceilingRidgeDirection = undefined;
          next.ceilingRidgeOffset = undefined;
          next.ceilingFlatPeakWidth = undefined;
        }
        return {
          ...next,
          verticalProfile: verticalProfileForAdjacentSpace(next, current.defaultCeilingHeight ?? 9),
        };
      }),
    }));
  }

  function updateAdjacentSpaceCeilingType(id: string, ceilingType: NonNullable<TakeoffRectRoom["ceilingType"]>) {
    const space = floor.adjacentSpaces?.find((candidate) => candidate.id === id);
    if (!space) return;
    const ceilingHeight = adjacentSpaceCeilingHeight(space, floor.defaultCeilingHeight ?? 9);
    updateAdjacentSpaceCeilingGeometry(id, {
      ceilingType,
      ceilingHeight,
      ceilingLowHeight: isVaultCeilingType(ceilingType) ? space.ceilingLowHeight ?? ceilingHeight : undefined,
      ceilingPeakHeight: isVaultCeilingType(ceilingType) ? space.ceilingPeakHeight ?? Math.max(ceilingHeight, ceilingHeight + 1) : undefined,
      ceilingRidgeDirection: isVaultCeilingType(ceilingType) ? space.ceilingRidgeDirection ?? "E-W" : undefined,
      ceilingRidgeOffset: isVaultCeilingType(ceilingType) ? space.ceilingRidgeOffset ?? 0 : undefined,
      ceilingFlatPeakWidth: ceilingType === "vault_flat_peak" ? space.ceilingFlatPeakWidth ?? 4 : undefined,
    });
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
    const candidateRooms = sliceRoomOptions.map((room) => room.id);
    const roomId = selectedSliceRoomId || candidateRooms[0] || floor.rooms[0]?.id;
    if (!roomId || activeUnassignedCells.length === 0) return;
    const targetRoom = floor.rooms.find((room) => room.id === roomId);
    if (!targetRoom) return;
    const mergedRoom = mergePolygonsIntoRoom(targetRoom, activeUnassignedCells.map((cell) => pointsToClipPolygon(unassignedCellPoints(cell))));
    if (!mergedRoom) {
      setMessage("Could not merge highlighted slices into that room. Try a room that touches the highlighted area; adjacent rooms are marked in the list.");
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

  function toggleRoomOpenToAbove(roomId: string) {
    const sourceFloor = floor;
    const targetFloor = nearestFloorByElevation(sourceFloor, floors, "above");
    const room = sourceFloor.rooms.find((candidate) => candidate.id === roomId);
    if (!room) return;
    const existingLink = openToAboveLinkForRoom(room);
    if (existingLink) {
      const restoredHeight = existingLink.previousCeilingHeight ?? sourceFloor.defaultCeilingHeight ?? 9;
      setFloor((current) => ({
        ...current,
        rooms: current.rooms.map((candidate) => candidate.id === roomId
          ? {
              ...candidate,
              ceilingHeight: restoredHeight,
              verticalLinks: (candidate.verticalLinks ?? []).filter((link) => link.id !== existingLink.id),
            }
          : candidate),
      }));
      setMessage(`${room.name || "Room"} is no longer marked open to above.`);
      return;
    }
    const linkedHeight = computedOpenToAboveHeight(
      sourceFloor,
      {
        ...room,
        verticalLinks: [{ id: "preview", type: "open_to_above", targetFloorId: targetFloor?.id }],
      },
      floors,
    );
    const link = {
      id: nextId("vertical-link"),
      type: "open_to_above" as const,
      targetFloorId: targetFloor?.id,
      previousCeilingHeight: room.ceilingHeight,
      envelopeMode: "review" as const,
    };
    setFloor((current) => ({
      ...current,
      rooms: current.rooms.map((candidate) => candidate.id === roomId
        ? {
            ...candidate,
            ceilingHeight: Number(linkedHeight.toFixed(3)),
            verticalLinks: [...(candidate.verticalLinks ?? []).filter((entry) => entry.type !== "open_to_above"), link],
          }
        : candidate),
    }));
    setMessage(targetFloor
      ? `${room.name || "Room"} marked open to ${targetFloor.name || "the floor above"} and raised to ${Number(linkedHeight.toFixed(1))} ft.`
      : `${room.name || "Room"} marked open above. Add a floor above and this footprint will be reserved automatically.`);
  }

  function focusValidationIssue(issue: TakeoffValidationIssue, key = projectValidationIssueKey(floor.id, issue), issueFloor = floor) {
    const section = validationSectionForIssue(issue);
    setActiveValidationTarget({
      key,
      floorId: issueFloor.id,
      roomId: issue.target?.roomId,
      severity: issue.severity,
      section,
      message: issue.message,
      issueType: issue.issueType,
      surfaceTreatmentSuggestion: issue.surfaceTreatmentSuggestion,
      wallComponentGeometrySuggestion: issue.wallComponentGeometrySuggestion,
      glassTreatmentSuggestion: issue.glassTreatmentSuggestion,
      internalGainSuggestion: issue.internalGainSuggestion,
      openToAboveEnvelopeSuggestion: issue.openToAboveEnvelopeSuggestion,
      verticalMergeSuggestion: issue.verticalMergeSuggestion,
    });
    if (issueFloor.id !== activeFloorId) {
      setActiveFloorId(issueFloor.id);
      resetTransientFloorTools();
    }
    if (issue.target?.roomId) {
      const sketchSurface = sketchSurfaceForSection(section);
      if (sketchSurface) setActiveSketchTarget({ roomId: issue.target.roomId, surface: sketchSurface });
    }
    if (!issue.target) return;
    if (issue.target.type === "room" && issue.target.roomId) {
      setSelectedRoomId(issue.target.roomId);
      setRightPanelOpen(true);
      const room = issueFloor.rooms.find((candidate) => candidate.id === issue.target?.roomId);
      setMessage(room ? `${room.name} selected from ${issueFloor.name} validation.` : `${issueFloor.name} room selected from validation.`);
      return;
    }
    if (issue.target.type === "unassigned") {
      setSelectedRoomId(null);
      setSelectedUnassignedRegionId(issue.target.regionId ?? null);
      setRightPanelOpen(true);
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
    if (event.shiftKey && !adjacentDrawMode) {
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
      const adjacentPoint = adjacentSpacePointForEvent(point, event.shiftKey);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragState({ kind: "adjacent", start: adjacentPoint, current: adjacentPoint });
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
      addExteriorPoint(prepareCornerPoint(point, floor.exteriorPolygon[floor.exteriorPolygon.length - 1], event.shiftKey, true, true));
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
    setDragState((current) => (current ? { ...current, current: current.kind === "adjacent" ? adjacentSpacePointForEvent(point, event.shiftKey) : point } : current));
  }

  function handleCanvasPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState) return;
    const releasePoint = pointFromCanvasEvent(event);
    const dragCurrent = dragState.kind === "adjacent" && releasePoint
      ? adjacentSpacePointForEvent(releasePoint, event.shiftKey)
      : dragState.current;
    const rect = rectFromPoints(dragState.start, dragCurrent);
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
      const moved = lineLength({ start: dragState.start, end: dragCurrent }) > 0.15;
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

  function handleAlignmentPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    if (event.shiftKey) {
      event.preventDefault();
      addSameScreenAlignmentPair(point);
      return;
    }
    if (!canAlignCurrentReference) {
      setMessage("Upload references for the active floor and a reference floor before dragging alignment.");
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setAlignmentDrag({ pointerId: event.pointerId, start: point, current: point, initialTransform: alignmentTransform });
    setMessage("Drag the active floor plan to align it. Hold Shift and click to record a matched point.");
  }

  function handleAlignmentPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!alignmentDrag) return;
    const point = pointFromCanvasEvent(event);
    if (!point) return;
    const nextTransform = {
      ...alignmentDrag.initialTransform,
      translateX: Number((alignmentDrag.initialTransform.translateX + point.x - alignmentDrag.start.x).toFixed(3)),
      translateY: Number((alignmentDrag.initialTransform.translateY + point.y - alignmentDrag.start.y).toFixed(3)),
    };
    setAlignmentDrag((current) => current ? { ...current, current: point } : current);
    setFloor((current) => ({
      ...current,
      alignment: {
        ...(current.alignment ?? {}),
        referenceFloorId: current.alignment?.referenceFloorId ?? alignmentReferenceFloor?.id,
        pointPairs: current.alignment?.pointPairs ?? [],
        transform: nextTransform,
      },
    }));
  }

  function handleAlignmentPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    if (!alignmentDrag) return;
    if (event.currentTarget.hasPointerCapture(alignmentDrag.pointerId)) {
      event.currentTarget.releasePointerCapture(alignmentDrag.pointerId);
    }
    const moved = lineLength({ start: alignmentDrag.start, end: alignmentDrag.current }) > 0.05;
    setAlignmentDrag(null);
    setMessage(moved ? "Active floor plan moved." : "Hold Shift and click a matching overlaid point to record an alignment pair.");
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
    const blockingEntry = projectValidation.find((entry) => entry.issue.severity === "error") ?? null;
    if (blockingEntry) {
      const blockingIssue = blockingEntry.issue;
      setMessage(blockingIssue.message);
      focusValidationIssue(blockingIssue, blockingEntry.key, blockingEntry.floor);
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
        for (const level of rotated.project.levels ?? []) {
          for (const item of level.line_items ?? []) {
            if (item.direction) item.direction = rotateCompass(item.direction, steps);
          }
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

  async function saveTakeoff(): Promise<boolean> {
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
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? `Could not save takeoff: ${error.message}` : "Could not save takeoff.");
      return false;
    } finally {
      setSaveLoading(false);
    }
  }

  function navigateToHash(hash: string) {
    if (hash) {
      window.location.hash = hash;
      return;
    }
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }

  function resetToNewTakeoff() {
    for (const url of Object.values(referenceUrls)) {
      if (url) revokeReferenceUrl(url);
    }
    const initialFloor = makeInitialFloor();
    const nextProjectName = "Takeoff V1 Draft";
    const nextSnapshot = takeoffSnapshot(
      makeTakeoffProject(nextProjectName, "", "decimal", false, 0, "S", initialFloor, defaultComponentSchedule),
    );

    setProjectName(nextProjectName);
    setLocation("");
    setMechanicalVentilation(false);
    setVentilationCfm(0);
    setFrontDoorFaces("S");
    setCalcResult(null);
    setComponentSchedule(defaultComponentSchedule);
    setDimensionInputMode("decimal");
    setFloors([initialFloor]);
    setConnectedVolumes([]);
    setActiveFloorId(initialFloor.id);
    setFloorViewOptions({ [initialFloor.id]: defaultFloorViewOptions() });
    setDraftRoom({ name: "", x: 0, y: 0, width: 0, depth: 0, ceilingHeight: 9 });
    setMessage("Started a new takeoff draft.");
    setActiveValidationTarget(null);
    setDismissedValidationKeys(new Set());
    setActiveSketchTarget(null);
    setUndoStack([]);
    setTakeoffId(null);
    setSavedSnapshot(nextSnapshot);
    setPendingSessionExit(null);
    setOpenDialog(false);
    setOpenDialogError("");
    setComponentScheduleOpen(false);
    setReferenceUrls({});
    setReferenceRenderStatus("");
    setPlanReviewMode("plan");
    setModelPreviewRevision((current) => current + 1);
    resetTransientFloorTools();
  }

  function requestTakeoffSessionExit(label: string, action: PendingSessionExit["action"], navigates = false) {
    if (!hasSaveWorthyChanges) {
      void action();
      return;
    }
    setPendingSessionExit({ label, action, navigates });
  }

  async function continuePendingSessionExit(saveFirst: boolean) {
    const pending = pendingSessionExit;
    if (!pending) return;
    if (saveFirst) {
      const saved = await saveTakeoff();
      if (!saved) return;
    }
    if (pending.navigates) allowNextUnsavedNavigation();
    setPendingSessionExit(null);
    await pending.action();
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
      for (const url of Object.values(referenceUrls)) {
        if (url) revokeReferenceUrl(url);
      }
      setReferenceUrls({});
      const firstLoadedFloor = loadedProject.floors[0] ?? makeInitialFloor();
      setProjectName(loadedProject.name);
      setLocation(loadedProject.location ?? "");
      setDimensionInputMode(loadedProject.dimensionInputMode ?? "decimal");
      setMechanicalVentilation(Boolean(loadedProject.mechanicalVentilation));
      setVentilationCfm(Number(loadedProject.ventilationCfm ?? 0));
      setFrontDoorFaces(loadedProject.frontDoorFaces);
      setComponentSchedule(loadedProject.componentSchedule?.length ? loadedProject.componentSchedule : defaultComponentSchedule);
      setFloors(loadedProject.floors.length ? loadedProject.floors : [firstLoadedFloor]);
      setConnectedVolumes(loadedProject.connectedVolumes ?? []);
      setUndoStack([]);
      setFloorViewOptions(Object.fromEntries((loadedProject.floors.length ? loadedProject.floors : [firstLoadedFloor]).map((entry) => [entry.id, defaultFloorViewOptions()])));
      setActiveFloorId(firstLoadedFloor.id);
      setTakeoffId(id);
      setSavedSnapshot(takeoffSnapshot(persistableTakeoffProject(loadedProject)));
      setOpenDialog(false);
      resetTransientFloorTools();
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
    const shouldCropForAlignment = floors.length > 1 && Boolean(alignmentReferenceFloor?.reference);
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
      const pdfPreview = kind === "pdf" ? await renderPdfPreview(file) : null;
      const nextReferenceUrl = pdfPreview?.url ?? URL.createObjectURL(file);
      setReferenceRenderStatus("Uploading plan reference...");
      const asset = await uploadReferenceAsset(file, floor.id);
      setReferenceUrl(nextReferenceUrl);
      setReferenceRenderStatus(`Stored ${asset.filename} (${formatBytes(asset.size_bytes)}).`);
      setFloor((current) => {
        const nextReference: NonNullable<TakeoffFloor["reference"]> = {
          filename: file.name,
          kind,
          assetId: asset.id,
          storagePath: asset.storage_path,
          mimeType: asset.mime_type,
          sizeBytes: asset.size_bytes,
          downloadUrl: asset.download_url,
          signedUrl: asset.signed_url,
          sourcePageNumber: asset.page_number ?? pdfPreview?.pageNumber ?? 1,
          renderScale: pdfPreview?.scale,
          previewWidthPx: pdfPreview?.widthPx,
          previewHeightPx: pdfPreview?.heightPx,
          rotationDeg: 0,
          mirroredX: false,
        };
        const nextDesignGrid = designGridForReferenceUpload(current, nextReference);
        const floorWithReference = { ...current, designGrid: nextDesignGrid, reference: nextReference };
        return {
          ...current,
          authoringMode: kind === "pdf" ? "pdf_trace" : "image_trace",
          coordinateSpace: "world_feet",
          designGrid: nextDesignGrid,
          reference: {
            ...nextReference,
            crop: referenceFullCropForFloor(floorWithReference),
          },
          calibration: { lines: [], linesVisible: true, confirmed: false, appliedFactor: 1, areaConfirmed: false },
          exteriorPolygon: [],
          perimeterLocked: false,
        };
      });
    } catch (error) {
      setReferenceUrl("");
      setReferenceRenderStatus("Could not store the plan reference.");
      setMessage(error instanceof Error ? error.message : "Could not store the plan reference.");
      return;
    }
    setWorkflowStep("crop");
    setPlanReviewMode("plan");
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
    setMessage(
      shouldCropForAlignment
        ? "Reference uploaded. Crop this floor plan, or proceed without cropping, then continue to alignment."
        : "Reference uploaded. Drag a crop around the plan area, or proceed without cropping to continue to scale setup.",
    );
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
      const netWallArea = roomWallReconciliation(floor, room, floors).reduce((sum, entry) => sum + entry.netArea, 0);
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

  const stageTitle = (() => {
    if (planReviewMode === "alignment") return "Align Floor References";
    if (workflowStep === "crop") return "Crop Plan Reference";
    if (workflowStep === "calibrate") return "Import Scale Setup";
    if (planReviewMode === "elevation") return "3D QA View";
    if (planReviewMode === "floor") return "Floor Review";
    if (planReviewMode === "ceiling") return "Ceiling Review";
    if (planReviewMode === "walls") return "Wall Review";
    return "Plan Grid";
  })();

  const modeGuidance = (() => {
    if (!projectName.trim()) {
      return {
        tone: "warning" as const,
        title: "Please name your project",
        body: "Start with a recognizable plan name so saved takeoffs and exports are easy to identify.",
      };
    }
    if (planReviewMode === "alignment") {
      return {
        tone: "neutral" as const,
        title: "Alignment overlay",
        body: "Only plan references are shown here. Move and scale this floor over the reference floor, then hold Shift and click a matched point.",
      };
    }
    if (!floor.reference) {
      return {
        tone: "info" as const,
        title: "Ready to upload a PDF",
        body: "Upload one floor-plan page. After upload, crop to the plan area or proceed without cropping.",
        actionLabel: "Upload PDF",
        action: () => document.getElementById("takeoff-reference-input")?.click(),
      };
    }
    if (workflowStep === "crop") {
      return {
        tone: "active" as const,
        title: "Crop mode enabled",
        body: canAlignCurrentReference
          ? "Rotate the page if needed, then crop to the floor plan you wish to align or proceed without cropping. You do not need sizing markers; scale is inherited from the selected reference floor."
          : "Rotate the page if needed, then crop to the plan area or proceed without cropping. Include measurement markers if you crop before scaling.",
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
    if (planReviewMode === "elevation") {
      return {
        tone: "neutral" as const,
        title: "3D QA view",
        body: "Review the modeled home, floor filters, plan PDF visibility, surfaces, openings, and band joists in the floating controls.",
      };
    }
    if (planReviewMode === "floor") {
      return {
        tone: "neutral" as const,
        title: "Floor review",
        body: "Review room floor areas and component assignments before sending the takeoff to the calculator.",
      };
    }
    if (planReviewMode === "ceiling") {
      return {
        tone: "neutral" as const,
        title: "Ceiling review",
        body: "Review ceiling panels, vaulted surfaces, open-to-above rooms, and any validation suggestions for split ceiling loads.",
      };
    }
    if (planReviewMode === "walls") {
      return {
        tone: "neutral" as const,
        title: "Wall review",
        body: "Review exterior exposure, wall components, windows, doors, and no-load boundaries created by conditioned adjacent space.",
      };
    }
    if (traceTool === "exterior" && !floor.perimeterLocked) {
      return {
        tone: "active" as const,
        title: "Exterior trace enabled",
        body: "Click the grid corners around the conditioned exterior. Lock the trace when the outline is complete.",
      };
    }
    return null;
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
          <button onClick={() => requestTakeoffSessionExit("start a new takeoff", resetToNewTakeoff)}>New</button>
          <button onClick={() => requestTakeoffSessionExit("open saved takeoffs", openTakeoffList)}>Open</button>
          <button onClick={undoLastTakeoffChange} disabled={undoStack.length === 0} title={undoStack[0] ? `Undo ${undoStack[0].label}` : "Nothing to undo"}>
            Undo
          </button>
          <button className="toolbar-primary" onClick={saveTakeoff} disabled={saveLoading}>
            {saveLoading ? "Saving..." : takeoffId ? "Save" : "Save Draft"}
          </button>
          <button className="toolbar-primary" onClick={runCalculate} disabled={calcLoading}>
            {calcLoading ? "Calculating..." : "Calculate"}
          </button>
          <span className={`takeoff-save-status ${isDirty ? "takeoff-save-status--dirty" : ""}`}>
            {isDirty ? "Unsaved" : "Saved"}
          </span>
          <a
            className="button"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              requestTakeoffSessionExit("open the calculator", () => navigateToHash(""), true);
            }}
          >
            Calculator
          </a>
          <a
            className="button"
            href="/#/projects"
            onClick={(event) => {
              event.preventDefault();
              requestTakeoffSessionExit("open saved projects", () => navigateToHash("#/projects"), true);
            }}
          >
            Projects
          </a>
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
          <details
            className="takeoff-panel takeoff-left-details"
            open={leftSectionsOpen.project}
            onToggle={(event) => setLeftSectionOpen("project", event.currentTarget.open)}
          >
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
              Dimension entry
              <select value={dimensionInputMode} onChange={(event) => setDimensionInputMode(event.target.value as DimensionInputMode)}>
                <option value="decimal">Decimal feet</option>
                <option value="feet-inches">Feet and inches</option>
              </select>
            </label>
            <div className="takeoff-floor-manager">
              <div className="takeoff-floor-manager-head">
                <span>Floors</span>
                <div className="takeoff-floor-manager-actions">
                  <button type="button" onClick={addFloorBelow}>Add Floor Below</button>
                  <button type="button" onClick={addFloor}>Add Floor</button>
                </div>
              </div>
              <div className="takeoff-floor-tabs" aria-label="Takeoff floors">
                {orderedFloors.map((entry, index) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={entry.id === floor.id ? "active" : ""}
                    onClick={() => switchActiveFloor(entry.id)}
                  >
                    <strong>{entry.name || `Floor ${index + 1}`}</strong>
                    <span>{entry.rooms.length} rooms</span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={removeActiveFloor} disabled={floors.length <= 1}>Remove Active Floor</button>
            </div>
            <label>
              Active floor name
              <input value={floor.name} onChange={(event) => updateFloor({ name: event.target.value })} />
            </label>
            <label>
              Front
              <select value={frontDoorFaces} onChange={(event) => setFrontDoorFaces(event.target.value as typeof frontDoorFaces)}>
                {directionOptions.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
              </select>
            </label>
            <label>
              Default ceiling height
              <DimensionInput
                value={floor.defaultCeilingHeight ?? 9}
                mode={dimensionInputMode}
                min={0}
                step={0.5}
                onCommit={updateFloorDefaultCeilingHeight}
              />
            </label>
            <button
              type="button"
              onMouseDown={() => {
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              }}
              onClick={applyFloorDefaultCeilingHeightToRooms}
              disabled={floor.rooms.length === 0}
            >
              Apply New Ceiling Height to All Rooms on this Floor
            </button>
            <label>
              Floor elevation
              <DimensionInput
                value={floor.elevation ?? 0}
                mode={dimensionInputMode}
                step={0.5}
                onCommit={(value) => updateFloor({ elevation: value, coordinateSpace: "world_feet" })}
              />
            </label>
            <label>
              Floor-to-floor height
              <DimensionInput
                value={floor.floorToFloorHeight ?? 10}
                mode={dimensionInputMode}
                min={0}
                step={0.5}
                onCommit={(value) => updateFloor({ floorToFloorHeight: value, coordinateSpace: "world_feet" })}
              />
            </label>
            <label className="check-field">Band joist load
              <input
                type="checkbox"
                checked={floorBandJoistEnabled(floor)}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  updateFloor({
                    bandJoistEnabled: enabled,
                    bandJoistHeight: enabled && floorBandJoistHeight(floor) <= 0.01 ? defaultBandJoistHeight : floor.bandJoistHeight ?? defaultBandJoistHeight,
                    coordinateSpace: "world_feet",
                  });
                }}
              />
            </label>
            <label>
              Band joist height
              <DimensionInput
                value={floor.bandJoistHeight ?? defaultBandJoistHeight}
                mode={dimensionInputMode}
                min={0}
                step={0.25}
                disabled={!floorBandJoistEnabled(floor)}
                onCommit={(value) => updateFloor({ bandJoistHeight: value, bandJoistHeightUserSet: true, coordinateSpace: "world_feet" })}
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
              <input
                key={`takeoff-reference-input-${floor.id}`}
                id="takeoff-reference-input"
                type="file"
                accept=".pdf,image/*"
                onChange={(event) => {
                  void handleReference(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
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
            <div className="takeoff-form-actions">
              <button className={planReviewMode === "plan" && workflowStep === "trace" ? "toolbar-primary" : ""} onClick={open2DPlanView}>2D Plan</button>
              {floor.reference && <button className={workflowStep === "crop" ? "toolbar-primary" : ""} onClick={enterCropMode}>Crop PDF</button>}
              {canAlignCurrentReference && (
                <button className={planReviewMode === "alignment" ? "toolbar-primary" : ""} onClick={continueToAlignment}>Align PDF</button>
              )}
            </div>
          </details>

          {floor.reference && (
            <details className="takeoff-panel takeoff-left-details" open={leftSectionsOpen.scale} onToggle={(event) => setLeftSectionOpen("scale", event.currentTarget.open)}>
            <summary>Import Scale</summary>
            <p className="takeoff-muted">
                {canAlignCurrentReference
                  ? "Crop to the floor plan you wish to align, or proceed without cropping. Sizing markers are not needed for floor-to-floor alignment."
                  : workflowStep === "calibrate"
                    ? "Click two endpoints for known dimensions on the preview."
                    : workflowStep === "crop"
                      ? "Crop to the plan area, or proceed without cropping to use the full page."
                      : "Scale setup complete."}
              </p>
              <div className="takeoff-form-actions">
                {canRotateReferenceInCrop && <button onClick={rotateReferenceBeforeCrop}>Rotate PDF</button>}
                <button className={workflowStep === "crop" ? "toolbar-primary" : ""} onClick={enterCropMode}>Crop</button>
                <button onClick={proceedWithoutCropping}>Proceed without cropping</button>
                <button onClick={clearCrop}>Undo Crop</button>
                {canAlignCurrentReference && <button className="toolbar-primary" onClick={continueToAlignment}>Align Floors</button>}
                {!canAlignCurrentReference && (
                  <>
                    <button className={workflowStep === "calibrate" && calibrationOrientation === "horizontal" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("horizontal"); }}>Horizontal</button>
                    <button className={workflowStep === "calibrate" && calibrationOrientation === "vertical" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("vertical"); }}>Vertical</button>
                    <button className={workflowStep === "calibrate" && calibrationOrientation === "any" ? "toolbar-primary" : ""} onClick={() => { setWorkflowStep("calibrate"); setCalibrationOrientation("any"); }}>Any</button>
                  </>
                )}
              </div>
              {workflowStep === "crop" && (
                <p className="takeoff-note">
                  {canAlignCurrentReference
                    ? "Rotate first if needed. Then drag a rectangle around only the floor plan you want to align, or use the whole page if the plan is already clean."
                    : "Rotate first if needed. Then drag a rectangle around only the plan and visible dimensions. This removes title blocks and border clutter before scaling."}
                </p>
              )}
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
            <label className="check-field">
              <input
                type="checkbox"
                checked={floor.floorAlignmentSnapEnabled !== false}
                onChange={(event) => updateFloor({ floorAlignmentSnapEnabled: event.target.checked })}
              />
              Snap exterior to nearby floors
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
            <div className="takeoff-advanced-subsection">
              <h3>Advanced model transform</h3>
              <p className="takeoff-muted">Mirror a completed repeated-builder plan left/right. This remaps E/W directions, openings, surfaces, adjacent spaces, and plan PDFs.</p>
              <button type="button" onClick={mirrorModeledPlan}>Mirror Model</button>
            </div>
            <p className="takeoff-muted">Advanced controls for the drafting canvas, snapping, and fallback footprint before an exterior trace exists.</p>
          </details>
          </>
          )}
        </aside>

        <section className="takeoff-stage-panel">
          <div className="takeoff-stage-head">
            <div>
              <h2>{stageTitle}</h2>
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
                <div className="takeoff-review-mode-group" aria-label="View mode">
                  <button
                    className={planReviewMode !== "elevation" ? "toolbar-primary" : ""}
                    data-tooltip="Show the editable 2D floor plan."
                    aria-label="Show the editable 2D floor plan"
                    onClick={open2DPlanView}
                  >
                    2D
                  </button>
                  <button
                    className={planReviewMode === "elevation" ? "toolbar-primary" : ""}
                    data-tooltip={canOpen3DView ? "Show the 3D quality-assurance model." : "Trace an exterior footprint or add a room before opening 3D QA."}
                    aria-label={canOpen3DView ? "Show the 3D quality-assurance model" : "3D QA unavailable until the plan has renderable geometry"}
                    disabled={!canOpen3DView}
                    onClick={() => openPlanReviewMode("elevation")}
                  >
                    3D
                  </button>
                </div>
                {planReviewMode !== "elevation" && (
                  <div className="takeoff-stage-floor-chips" aria-label="Active floor">
                    {orderedFloors.map((entry, index) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`takeoff-stage-floor-chip${entry.id === floor.id ? " takeoff-stage-floor-chip--active" : ""}`}
                        aria-pressed={entry.id === floor.id}
                        onClick={() => switchActiveFloor(entry.id)}
                      >
                        {entry.name || `Floor ${index + 1}`}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {modeGuidance && (
            <div className={`takeoff-mode-guidance takeoff-mode-guidance--${modeGuidance.tone}`}>
              <div>
                <strong>{modeGuidance.title}</strong>
                <span>{modeGuidance.body}</span>
              </div>
              {modeGuidance.action && modeGuidance.actionLabel && (
                <button onClick={modeGuidance.action}>{modeGuidance.actionLabel}</button>
              )}
              {workflowStep === "crop" && floor.reference && (
                <div className="takeoff-mode-guidance-actions">
                  {canRotateReferenceInCrop && <button type="button" onClick={rotateReferenceBeforeCrop}>Rotate PDF</button>}
                  <button type="button" className="toolbar-primary" onClick={enterCropMode}>Crop</button>
                  <button type="button" onClick={proceedWithoutCropping}>Proceed without cropping</button>
                </div>
              )}
            </div>
          )}

          {planReviewMode === "alignment" && (
            <div className="takeoff-alignment-floating-controls">
              <div className="takeoff-alignment-control-main">
                <label>
                  Reference floor
                  <select
                    value={alignmentReferenceFloor?.id ?? ""}
                    onChange={(event) => setAlignmentReferenceFloor(event.target.value)}
                    disabled={floors.length <= 1}
                  >
                    {orderedFloors.filter((entry) => entry.id !== floor.id).map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.name}</option>
                    ))}
                  </select>
                </label>
                <span>{alignmentPointPairs.length} point pair{alignmentPointPairs.length === 1 ? "" : "s"}</span>
                <button type="button" onClick={clearAlignmentPairs} disabled={alignmentPointPairs.length === 0}>Clear Pairs</button>
              </div>
              <div className="takeoff-alignment-dpad" aria-label="Move active floor reference">
                <button type="button" className="takeoff-alignment-dpad-up" onClick={() => nudgeAlignment(0, -0.25)} aria-label="Move active plan up">Up</button>
                <button type="button" className="takeoff-alignment-dpad-left" onClick={() => nudgeAlignment(-0.25, 0)} aria-label="Move active plan left">Left</button>
                <button type="button" className="takeoff-alignment-dpad-right" onClick={() => nudgeAlignment(0.25, 0)} aria-label="Move active plan right">Right</button>
                <button type="button" className="takeoff-alignment-dpad-down" onClick={() => nudgeAlignment(0, 0.25)} aria-label="Move active plan down">Down</button>
              </div>
              <div className="takeoff-alignment-scale-controls" aria-label="Scale active floor reference">
                <button type="button" onClick={() => stepAlignmentScale(-0.005)} aria-label="Scale active plan down">-</button>
                <span>{Math.round(alignmentTransform.scale * 1000) / 10}%</span>
                <button type="button" onClick={() => stepAlignmentScale(0.005)} aria-label="Scale active plan up">+</button>
                <button type="button" onClick={resetAlignmentTransform}>Reset</button>
              </div>
              <button type="button" onClick={clearCrop}>Undo Crop</button>
              <button type="button" className="toolbar-primary" onClick={acceptAlignment}>Accept Alignment</button>
            </div>
          )}

          <div className="takeoff-canvas-scroll" ref={canvasScrollRef}>
            {planReviewMode === "elevation" ? (
              <TakeoffModelPreview
                key={`takeoff-model-preview-${modelPreviewRevision}`}
                floor={floor}
                floors={orderedFloors}
                activeFloorId={floor.id}
                referenceUrl={referenceUrl}
                referenceUrls={referenceUrls}
                floorViewOptions={floorViewOptions}
                componentSchedule={componentSchedule}
                selectedRoomId={selectedRoomId}
                connectedVolumes={connectedVolumes}
                onSelectRoom={setSelectedRoomId}
                onUpdateFloorViewOptions={updateFloorViewOptions}
                onAssignSurfaceComponent={assignModelSurfaceComponent}
              />
            ) : planReviewMode === "alignment" ? (
              <div className="takeoff-drawing-layer takeoff-alignment-layer" style={{ width: drawingWidth, height: drawingHeight }}>
                {alignmentReferenceFloor && alignmentReferenceUrl && alignmentReferenceDisplay && alignmentReferenceFloor.reference && (
                  <div
                    className="takeoff-reference-layer takeoff-reference-layer--alignment-base"
                    style={{
                      left: offsetX + alignmentReferenceDisplay.x * scale,
                      top: offsetY + alignmentReferenceDisplay.y * scale,
                      width: alignmentReferenceDisplay.width * scale,
                      height: alignmentReferenceDisplay.depth * scale,
                    }}
                  >
                    <ReferencePlanImage floor={alignmentReferenceFloor} src={alignmentReferenceUrl} alt={`${alignmentReferenceFloor.name} reference`} />
                  </div>
                )}
                {referenceUrl && floor.reference && (
                  <div
                    className="takeoff-reference-layer takeoff-reference-layer--alignment-active"
                    style={{
                      left: offsetX + referenceDisplay.x * scale,
                      top: offsetY + referenceDisplay.y * scale,
                      width: referenceDisplay.width * scale,
                      height: referenceDisplay.depth * scale,
                      transform: `translate(${alignmentTransform.translateX * scale}px, ${alignmentTransform.translateY * scale}px) scale(${alignmentEffectiveScale})`,
                      transformOrigin: "top left",
                    }}
                  >
                    <ReferencePlanImage floor={floor} src={referenceUrl} alt={`${floor.name} reference`} crop={visibleCrop} />
                  </div>
                )}
                <svg
                  className="takeoff-canvas takeoff-alignment-canvas"
                  viewBox={`0 0 ${drawingWidth} ${drawingHeight}`}
                  width={drawingWidth}
                  height={drawingHeight}
                  role="img"
                  aria-label="Floor alignment reference overlay"
                  style={{ cursor: alignmentDrag ? "grabbing" : "grab" }}
                  onPointerDown={handleAlignmentPointerDown}
                  onPointerMove={handleAlignmentPointerMove}
                  onPointerUp={handleAlignmentPointerUp}
                  onPointerCancel={handleAlignmentPointerUp}
                >
                  <rect x="0" y="0" width={drawingWidth} height={drawingHeight} fill="transparent" />
                  <rect x={offsetX} y={offsetY} width={floor.designGrid.width * scale} height={floor.designGrid.depth * scale} fill="none" stroke="#9aa8b4" strokeDasharray="5 5" strokeWidth="1.5" />
                  {alignmentPointPairs.map((pair, index) => (
                    <g key={pair.id}>
                      <circle cx={offsetX + pair.reference.x * scale} cy={offsetY + pair.reference.y * scale} r="7" fill="#ffffff" stroke="#2f7a4f" strokeWidth="2" />
                      <circle cx={offsetX + alignmentLocalToReferencePoint(pair.local).x * scale} cy={offsetY + alignmentLocalToReferencePoint(pair.local).y * scale} r="4" fill="#2f7a4f" stroke="#ffffff" strokeWidth="1.5" />
                      <text x={offsetX + pair.reference.x * scale + 10} y={offsetY + pair.reference.y * scale - 10} fontSize="12" fill="#204b2b">{index + 1}</text>
                    </g>
                  ))}
                </svg>
                <div className="takeoff-alignment-empty">
                  {floors.length <= 1
                    ? "Add another floor to use the alignment overlay."
                    : !alignmentReferenceUrl || !referenceUrl
                      ? "Open or upload references for both floors before recording point pairs."
                      : "Move and scale the active floor until corners line up, then hold Shift and click a matched point."}
                </div>
              </div>
            ) : (
            <div className="takeoff-drawing-layer" style={{ width: drawingWidth, height: drawingHeight }}>
              {orderedFloors.filter((entry) => entry.id !== floor.id).map((entry) => {
                const options = floorViewOptions[entry.id] ?? defaultFloorViewOptions();
                if (!options.visible) return null;
                const otherReferenceUrl = referenceUrls[entry.id] ?? "";
                const otherReferenceDisplay = referenceDisplayRectForFloor(entry);
                return options.reference && otherReferenceUrl && entry.reference ? (
                  <div
                    key={`reference-${entry.id}`}
                    className="takeoff-reference-layer takeoff-reference-layer--floor-ghost"
                    style={{
                      left: offsetX + otherReferenceDisplay.x * scale,
                      top: offsetY + otherReferenceDisplay.y * scale,
                      width: otherReferenceDisplay.width * scale,
                      height: otherReferenceDisplay.depth * scale,
                    }}
                  >
                    <ReferencePlanImage floor={entry} src={otherReferenceUrl} alt={`${entry.name} reference`} />
                  </div>
                ) : null;
              })}
              {activeFloorViewOptions.visible && activeFloorViewOptions.reference && referenceUrl && floor.reference && (
                <div
                  className="takeoff-reference-layer"
                  style={{
                    left: offsetX + referenceDisplay.x * scale,
                    top: offsetY + referenceDisplay.y * scale,
                    width: referenceDisplay.width * scale,
                    height: referenceDisplay.depth * scale,
                    ...(floor.alignment?.transform
                      ? {
                          transform: `translate(${alignmentTransform.translateX * scale}px, ${alignmentTransform.translateY * scale}px) scale(${alignmentEffectiveScale})`,
                          transformOrigin: "top left",
                        }
                      : {}),
                    }}
                  >
                  <ReferencePlanImage
                    floor={floor}
                    src={referenceUrl}
                    alt={floor.reference.kind === "image" ? `${floor.reference.filename} reference` : `${floor.reference.filename} rendered PDF reference`}
                    crop={visibleCrop}
                  />
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
              <rect x="0" y="0" width={drawingWidth} height={drawingHeight} fill={referenceUrl && activeFloorViewOptions.visible && activeFloorViewOptions.reference ? "transparent" : "#f8fafb"} />
              <rect x={offsetX} y={offsetY} width={floor.designGrid.width * scale} height={floor.designGrid.depth * scale} fill="url(#takeoff-grid-small)" stroke="#b7c4cf" strokeWidth="1.5" />
              {orderedFloors.filter((entry) => entry.id !== floor.id).flatMap((entry) => {
                const options = floorViewOptions[entry.id] ?? defaultFloorViewOptions();
                if (!options.visible) return [];
                const overlays: React.ReactNode[] = [];
                if (options.exterior && entry.exteriorPolygon.length >= 3) {
                  overlays.push(
                    <polygon
                      key={`${entry.id}-exterior`}
                      points={entry.exteriorPolygon.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                      fill="rgba(92, 117, 138, 0.08)"
                      stroke="#5c758a"
                      strokeDasharray="6 5"
                      strokeWidth="2"
                    />
                  );
                }
                if (options.rooms) {
                  for (const room of entry.rooms) {
                    overlays.push(
                      <polygon
                        key={`${entry.id}-${room.id}`}
                        points={roomCorners(room).map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                        fill="rgba(92, 117, 138, 0.07)"
                        stroke="rgba(92, 117, 138, 0.45)"
                        strokeWidth="1"
                      />
                    );
                  }
                }
                return overlays;
              })}
              {activeFloorViewOptions.visible && activeFloorViewOptions.exterior && (floor.exteriorPolygon.length >= 3 ? (
                <polygon points={exteriorPath} fill="rgba(31, 111, 178, 0.08)" stroke="#1f6fb2" strokeWidth="2.5" />
              ) : (
                <rect x={offsetX} y={offsetY} width={floor.conditionedPerimeter.width * scale} height={floor.conditionedPerimeter.depth * scale} fill="rgba(31, 111, 178, 0.07)" stroke="#1f6fb2" strokeDasharray="6 5" strokeWidth="2" />
              ))}
              {activeFloorViewOptions.visible && activeFloorViewOptions.exterior && !polygonDraftActive && floor.exteriorPolygon.map((point, index) => (
                <g key={`${point.x}-${point.y}-${index}`}>
                  <circle cx={offsetX + point.x * scale} cy={offsetY + point.y * scale} r="4" fill="#1f6fb2" stroke="#ffffff" strokeWidth="1.5" />
                  <text x={offsetX + point.x * scale + 6} y={offsetY + point.y * scale - 6} fontSize="10" fill="#1f2933">{index + 1}</text>
                </g>
              ))}
              {activeFloorViewOptions.visible && activeFloorViewOptions.rooms && unassignedRegions.flatMap((region) => region.cells.map((cell, index) => {
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
              {activeFloorViewOptions.visible && activeFloorViewOptions.rooms && activeOpenToBelowReservations.map((reservation) => {
                const points = reservation.points;
                const labelPoint = polygonLabelPoint(points);
                return (
                  <g key={`open-to-below-${reservation.sourceFloor.id}-${reservation.room.id}-${reservation.connectedVolumeId ?? "simple"}`} pointerEvents="none">
                    <polygon
                      points={points.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                      fill="rgba(45, 120, 173, 0.16)"
                      stroke="#0f5fa8"
                      strokeDasharray="8 4"
                      strokeWidth="2.5"
                    />
                    <text
                      x={offsetX + labelPoint.x * scale}
                      y={offsetY + labelPoint.y * scale}
                      fontSize="11"
                      fill="#0f5fa8"
                      fontWeight="800"
                      textAnchor="middle"
                    >
                      Open to below
                    </text>
                    <text
                      x={offsetX + labelPoint.x * scale}
                      y={offsetY + labelPoint.y * scale + 13}
                      fontSize="10"
                      fill="#38556f"
                      textAnchor="middle"
                    >
                      {reservation.label || reservation.room.name || reservation.sourceFloor.name || "Room below"}
                    </text>
                  </g>
                );
              })}
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
              {activeFloorViewOptions.visible && activeFloorViewOptions.rooms && (floor.adjacentSpaces ?? []).map((space) => {
                const color = adjacentSpaceColor(space.kind);
                const points = adjacentSpaceCorners(space);
                const labelPoint = polygonLabelPoint(points);
                const isSelected = selectedRoomId === space.id;
                return (
                  <g
                    key={space.id}
                    pointerEvents={polygonDraftActive ? "none" : undefined}
                    onClick={(event) => {
                      if (openingModeActive) return;
                      event.stopPropagation();
                      setSelectedRoomId(space.id);
                    }}
                    style={{ cursor: openingModeActive ? "crosshair" : "pointer" }}
                  >
                    <polygon
                      points={points.map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                      fill={color.fill}
                      stroke={isSelected ? "#0f5fa8" : color.stroke}
                      strokeDasharray="7 4"
                      strokeWidth={isSelected ? "3" : "2"}
                    />
                    <text
                      x={offsetX + labelPoint.x * scale}
                      y={offsetY + labelPoint.y * scale}
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
              {activeFloorViewOptions.visible && activeFloorViewOptions.rooms && floor.rooms.map((room, index) => {
                const points = roomCorners(room);
                const labelPoint = polygonLabelPoint(points);
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
                    startInlineRoomRename(room.id);
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
                      {isVaultCeilingType(ceilingInfo.ceilingType) ? (
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
                            x={offsetX + labelPoint.x * scale}
                            y={offsetY + labelPoint.y * scale - 18}
                            fontSize="10"
                            fill="#7f3f20"
                            fontWeight="700"
                            textAnchor="middle"
                          >
                            {ceilingInfo.ceilingType === "vault_flat_peak" ? `Vault flat peak ${Math.round(ceilingInfo.flatPeakWidth)} ft` : "Vault"} {ceilingInfo.ridgeDirection} {ceilingInfo.lowHeight}/{ceilingInfo.peakHeight} ft
                          </text>
                        </>
                      ) : ceilingInfo.ceilingType === "tray" ? (
                        <>
                          {trayBoundaryPoints(room, ceilingInfo.trayOffset).length >= 3 && (
                            <polygon
                              points={trayBoundaryPoints(room, ceilingInfo.trayOffset).map((point) => `${offsetX + point.x * scale},${offsetY + point.y * scale}`).join(" ")}
                              fill="none"
                              stroke="#b35b2f"
                              strokeWidth="2"
                              strokeDasharray="6 4"
                            />
                          )}
                          <text
                            x={offsetX + labelPoint.x * scale}
                            y={offsetY + labelPoint.y * scale - 18}
                            fontSize="10"
                            fill="#7f3f20"
                            fontWeight="700"
                            textAnchor="middle"
                          >
                            Tray {trayModeLabel(ceilingInfo.trayMode)} · {ceilingInfo.trayOffset} ft · {ceilingInfo.traySteps} step{ceilingInfo.traySteps === 1 ? "" : "s"}
                          </text>
                        </>
                      ) : (
                        <text
                          x={offsetX + labelPoint.x * scale}
                          y={offsetY + labelPoint.y * scale - 18}
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
                      x={offsetX + labelPoint.x * scale}
                      y={offsetY + labelPoint.y * scale - 18}
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
                    <foreignObject x={offsetX + labelPoint.x * scale - 50} y={offsetY + labelPoint.y * scale - 17} width="120" height="32">
                      <input
                        ref={inlineRoomNameInputRef}
                        className="takeoff-svg-input"
                        value={room.name}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.select();
                        }}
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
                      x={offsetX + labelPoint.x * scale}
                      y={offsetY + labelPoint.y * scale}
                      fontSize="12"
                      fill="#1f2933"
                      textAnchor="middle"
                      onClick={(event) => {
                        if (openingModeActive) return;
                        event.stopPropagation();
                        startInlineRoomRename(room.id);
                      }}
                      onDoubleClick={(event) => {
                        if (!roomRenameShortcutEnabled) return;
                        event.preventDefault();
                        event.stopPropagation();
                        startInlineRoomRename(room.id);
                      }}
                      style={{ cursor: "text", fontWeight: 700 }}
                    >
                      {room.name}
                    </text>
                  )}
                  <text x={offsetX + labelPoint.x * scale} y={offsetY + labelPoint.y * scale + 16} fontSize="11" fill="#465667" textAnchor="middle">
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
              {floor.rooms.length === 0 && (floor.adjacentSpaces ?? []).length === 0 ? (
                <p className="takeoff-muted">Draw or add rooms to build the space profile list.</p>
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
                        <span className="takeoff-room-card-title">
                          <strong>{room.name}</strong>
                          {roomValidationBadge(floor.id, room.id)}
                        </span>
                        <span>{metric.value} {metric.label}</span>
                        {room.roomType && room.roomType !== "plain" && (
                          <em>{roomTypeLabel(room.roomType)}</em>
                        )}
                      </button>
                    );
                  })}
                  {(floor.adjacentSpaces ?? []).length > 0 && (
                    <div className="takeoff-space-list-divider">Adjacent / Unconditioned</div>
                  )}
                  {(floor.adjacentSpaces ?? []).map((space) => {
                    const roomLike = adjacentSpaceAsRoom(space, floor.defaultCeilingHeight ?? 9);
                    return (
                      <button
                        key={space.id}
                        className={`takeoff-room-tile takeoff-room-tile--adjacent ${selectedRoomId === space.id ? "takeoff-room-tile--selected" : ""}`}
                        onClick={() => setSelectedRoomId(space.id)}
                      >
                        <strong>{space.name}</strong>
                        <span>{Math.round(rectArea(roomLike))} sf · {adjacentSpaceLabel(space.kind)}</span>
                        <em>{space.closedCeilingBelow ? "Closed ceiling" : "Unconditioned"}</em>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="takeoff-panel takeoff-room-profile-panel takeoff-room-profile-panel--workbench">
              {selectedRoom ? (
                (() => {
                  const roomArea = rectArea(selectedRoom);
                  const ceilingSurfaceArea = expectedSurfaceArea(selectedRoom, "ceiling");
                  const suggestions = roomExteriorWallSuggestions(floor, selectedRoom, floors);
                  const reconciliation = roomWallReconciliation(floor, selectedRoom, floors);
                  const openToAboveLink = openToAboveLinkForRoom(selectedRoom);
                  const resolvedOpenToAboveFloor = resolvedOpenToAboveTargetFloor(floor, selectedRoom, floors);
                  const floorAboveForRoom = nearestFloorByElevation(floor, floors, "above");
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
                  const pendingSuggestionRows = suggestionRows.filter((row) => !row.approved);
                  const suggestionHighlightClass = validationSectionClass("wall-suggestions");
                  const showSuggestionReview = pendingSuggestionRows.length > 0 || Boolean(suggestionHighlightClass);
                  const ceilingInfo = ceilingGeometryInfo(selectedRoom, floor.defaultCeilingHeight ?? 9);
                  const roomBounds = polygonBounds(roomCorners(selectedRoom));
                  const ceilingSuggestions = ceilingWallSuggestionsForRoom(floor, selectedRoom, floor.defaultCeilingHeight ?? 9);
                  return (
                    <>
                      <div className="takeoff-workbench-head">
                        <div>
                          <input
                            className="takeoff-room-title-input"
                            value={selectedRoom.name}
                            onChange={(event) => updateRoom(selectedRoom.id, { name: event.target.value })}
                            aria-label="Room name"
                          />
                          <p className="takeoff-muted">
                            {Math.round(roomArea)} sf · {roomTypeLabel(selectedRoom.roomType ?? "plain")} · {selectedRoom.ceilingHeight} ft ceiling
                            {openToAboveLink ? ` · ${resolvedOpenToAboveFloor ? `open to ${resolvedOpenToAboveFloor.name || "floor above"}` : "open above pending"}` : ""}
                          </p>
                        </div>
                        <div className="takeoff-workbench-actions">
                          <button
                            type="button"
                            onClick={() => toggleRoomOpenToAbove(selectedRoom.id)}
                            title={openToAboveLink ? "Remove the vertical open-to-above link" : floorAboveForRoom ? `Mark this room open to ${floorAboveForRoom.name || "the floor above"}` : "Reserve this room as open above when an upper floor is added"}
                          >
                            {openToAboveLink ? "Clear Open Above" : "Open Above"}
                          </button>
                          {floor.rooms.length > 1 && (
                            <div ref={roomMergeMenuRef} id={validationTargetId("merge")} className={`takeoff-popout ${validationSectionClass("merge")}`}>
                              <button onClick={() => setRoomMergeMenuOpen((open) => !open)}>Merge</button>
                              {roomMergeMenuOpen && (
                                <div className="takeoff-popout-menu">
                                  <label>
                                    Merge into
                                    <select
                                      value={mergeTargetRoomId && mergeTargetRoomId !== selectedRoom.id ? mergeTargetRoomId : floor.rooms.find((room) => room.id !== selectedRoom.id)?.id ?? ""}
                                      onChange={(event) => setMergeTargetRoomId(event.target.value)}
                                    >
                                      {floor.rooms.filter((room) => room.id !== selectedRoom.id).map((room) => (
                                        <option key={room.id} value={room.id}>{room.name}</option>
                                      ))}
                                    </select>
                                  </label>
                                  <button className="toolbar-primary" onClick={() => { mergeSelectedRoomIntoTarget(); setRoomMergeMenuOpen(false); }}>Merge Room</button>
                                </div>
                              )}
                            </div>
                          )}
                          <div ref={roomTypeMenuRef} className="takeoff-popout">
                            <button onClick={() => setRoomTypeMenuOpen((open) => !open)}>Type</button>
                            {roomTypeMenuOpen && (
                              <div className="takeoff-popout-menu">
                                <label>
                                  Room type
                                  <select
                                    value={selectedRoom.roomType ?? "plain"}
                                    onChange={(event) => {
                                      updateRoom(selectedRoom.id, { roomType: event.target.value as TakeoffRoomType });
                                      setRoomTypeMenuOpen(false);
                                    }}
                                  >
                                    {roomTypeOptions.map((option) => (
                                      <option key={option.id} value={option.id}>{option.label}</option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            )}
                          </div>
                          <button onClick={() => removeRoom(selectedRoom.id)}>Remove Room</button>
                        </div>
                      </div>

                      {activeRoomValidationTarget && (
                        (() => {
                          const roomTypeSuggestion = activeRoomValidationTarget.issueType === "room-type-suggestion"
                            ? inferredRoomTypeFromName(selectedRoom.name)
                            : null;
                          const surfaceTreatmentSuggestion = activeRoomValidationTarget.surfaceTreatmentSuggestion;
                          const wallComponentGeometrySuggestion = activeRoomValidationTarget.wallComponentGeometrySuggestion;
                          const glassTreatmentSuggestion = activeRoomValidationTarget.glassTreatmentSuggestion;
                          const internalGainSuggestion = activeRoomValidationTarget.internalGainSuggestion;
                          const openToAboveEnvelopeSuggestion = activeRoomValidationTarget.openToAboveEnvelopeSuggestion;
                          const verticalMergeSuggestion = activeRoomValidationTarget.verticalMergeSuggestion;
                          const verticalMergeSourceFloor = verticalMergeSuggestion ? floors.find((entry) => entry.id === verticalMergeSuggestion.sourceFloorId) : null;
                          const verticalMergeTargetFloor = verticalMergeSuggestion ? floors.find((entry) => entry.id === verticalMergeSuggestion.targetFloorId) : null;
                          const suggestedLabel = roomTypeSuggestion
                            ? roomTypeOptions.find((option) => option.id === roomTypeSuggestion.type)?.shortLabel ?? roomTypeLabel(roomTypeSuggestion.type)
                            : "";
                          const activeValidationIssue: TakeoffValidationIssue = {
                            severity: activeRoomValidationTarget.severity,
                            message: activeRoomValidationTarget.message,
                            issueType: activeRoomValidationTarget.issueType,
                            surfaceTreatmentSuggestion,
                            wallComponentGeometrySuggestion,
                            glassTreatmentSuggestion,
                            internalGainSuggestion,
                            openToAboveEnvelopeSuggestion,
                            verticalMergeSuggestion,
                            target: { type: "room", roomId: selectedRoom.id },
                          };
                          return (
                            <div id={activeValidationElementId(selectedRoom.id)} className={`takeoff-active-validation takeoff-active-validation--${activeRoomValidationTarget.severity}`}>
                              <div>
                                <strong>{activeRoomValidationTarget.severity === "error" ? "Fix required" : "Review suggestion"}</strong>
                                <span>{validationSectionLabel(activeRoomValidationTarget.section)}</span>
                              </div>
                              <p>{activeRoomValidationTarget.message}</p>
                              <div className="takeoff-active-validation-actions">
                                {roomTypeSuggestion ? (
                                  <>
                                    <button className="toolbar-primary" onClick={() => acceptRoomTypeSuggestion(selectedRoom.id, roomTypeSuggestion)}>Use {suggestedLabel}</button>
                                    <button onClick={() => rejectRoomTypeSuggestion(selectedRoom.id, roomTypeSuggestion)}>Keep Plain</button>
                                  </>
                                ) : surfaceTreatmentSuggestion ? (
                                  <button className="toolbar-primary" onClick={() => applySurfaceTreatmentSuggestion(activeValidationIssue)}>Apply Change</button>
                                ) : wallComponentGeometrySuggestion ? (
                                  <button className="toolbar-primary" onClick={() => applyWallComponentGeometrySuggestion(activeValidationIssue)}>Apply Change</button>
                                ) : glassTreatmentSuggestion ? (
                                  <button className="toolbar-primary" onClick={() => applyGlassTreatmentSuggestion(activeValidationIssue)}>Apply Change</button>
                                ) : internalGainSuggestion ? (
                                  <button className="toolbar-primary" onClick={() => applyInternalGainSuggestion(activeValidationIssue)}>Apply Change</button>
                                ) : openToAboveEnvelopeSuggestion ? (
                                  <button className="toolbar-primary" onClick={() => applyOpenToAboveEnvelopeSuggestion(activeValidationIssue)}>Apply Change</button>
                                ) : verticalMergeSuggestion ? (
                                  <>
                                    <button className="toolbar-primary" onClick={() => applyVerticalMergeSuggestion(activeValidationIssue, verticalMergeSuggestion.defaultReportingFloorId)}>
                                      Assign to {verticalMergeSuggestion.defaultReportingFloorId === verticalMergeTargetFloor?.id ? verticalMergeTargetFloor?.name || "upper floor" : verticalMergeSourceFloor?.name || "lower floor"}
                                    </button>
                                    <button onClick={() => applyVerticalMergeSuggestion(activeValidationIssue, verticalMergeSuggestion.defaultReportingFloorId === verticalMergeTargetFloor?.id ? verticalMergeSourceFloor?.id ?? verticalMergeSuggestion.sourceFloorId : verticalMergeTargetFloor?.id ?? verticalMergeSuggestion.targetFloorId)}>
                                      Assign to {verticalMergeSuggestion.defaultReportingFloorId === verticalMergeTargetFloor?.id ? verticalMergeSourceFloor?.name || "lower floor" : verticalMergeTargetFloor?.name || "upper floor"}
                                    </button>
                                  </>
                                ) : (
                                  <button onClick={() => scrollToValidationSection(selectedRoom.id, activeRoomValidationTarget.section)}>Jump to section</button>
                                )}
                                <button onClick={dismissActiveValidation}>Dismiss</button>
                              </div>
                            </div>
                          );
                        })()
                      )}
                      {renderRoomTypeSuggestion(selectedRoom)}

                      {showSuggestionReview && (
                        <div id={validationTargetId("wall-suggestions")} className={`takeoff-wall-suggestions takeoff-wall-suggestions--workbench ${suggestionHighlightClass}`}>
                          <div className="takeoff-component-head">
                            <div>
                              <h3>Review suggestion</h3>
                              <p className="takeoff-muted">Suggested Exterior Walls</p>
                            </div>
                            {pendingSuggestionRows.length > 1 && (
                              <button
                                className="toolbar-primary"
                                onClick={() => applySuggestedWallAreas(selectedRoom.id, pendingSuggestionRows.map((row) => {
                                  const rowKey = `${selectedRoom.id}:${row.suggestion.direction}`;
                                  const adjacency = suggestedWallRowAdjacencies[rowKey] ?? row.recommendation.adjacency;
                                  return {
                                    suggestion: row.suggestion,
                                    recommendation: {
                                      adjacency,
                                      assembly: suggestedWallRowAssemblies[rowKey] ?? row.recommendation.assembly ?? defaultWallAssemblyForAdjacency(adjacency),
                                    },
                                  };
                                }))}
                              >
                                Apply all
                              </button>
                            )}
                          </div>
                          {pendingSuggestionRows.map(({ suggestion, adjacentKinds, recommendation }) => {
                            const rowKey = `${selectedRoom.id}:${suggestion.direction}`;
                            const selectedAdjacency = suggestedWallRowAdjacencies[rowKey] ?? recommendation.adjacency;
                            const selectedAssembly = suggestedWallRowAssemblies[rowKey] ?? recommendation.assembly ?? defaultWallAssemblyForAdjacency(selectedAdjacency);
                            const geometrySummary = suggestion.geometryLabel ?? `${Number(suggestion.length.toFixed(1))} lf x ${Number((suggestion.area / Math.max(suggestion.length, 0.001)).toFixed(1))} ft`;
                            return (
                              <div key={suggestion.direction} className="takeoff-wall-suggestion-row takeoff-wall-suggestion-row--workbench">
                                <span>
                                  <strong>{Math.round(suggestion.area)} sf</strong>
                                  <small>
                                    {suggestion.direction} {wallAdjacencyLabel(selectedAdjacency).toLowerCase()} · {geometrySummary}
                                    {adjacentKinds.length > 0 ? ` · adjacent ${adjacentKinds.map(adjacentSpaceLabel).join(", ")}` : ""}
                                  </small>
                                </span>
                                <select
                                  value={selectedAdjacency}
                                  onChange={(event) => {
                                    const adjacency = event.target.value as TakeoffWallAdjacency;
                                    setSuggestedWallRowAdjacencies((current) => ({ ...current, [rowKey]: adjacency }));
                                    setSuggestedWallRowAssemblies((current) => current[rowKey] ? current : { ...current, [rowKey]: defaultWallAssemblyForAdjacency(adjacency) });
                                  }}
                                >
                                  <option value="outside">Exterior wall</option>
                                  <option value="garage">Garage wall</option>
                                  <option value="attic">Attic wall</option>
                                  <option value="crawlspace">Crawlspace wall</option>
                                  <option value="conditioned">Conditioned wall</option>
                                  <option value="unknown">Unknown wall</option>
                                </select>
                                <select
                                  value={selectedAssembly}
                                  onChange={(event) => setSuggestedWallRowAssemblies((current) => ({ ...current, [rowKey]: event.target.value }))}
                                >
                                  {scheduleOptionsBySurface.wall.map((option) => (
                                    <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                  ))}
                                </select>
                                <button onClick={() => applySuggestedWallArea(selectedRoom.id, suggestion, selectedAssembly, selectedAdjacency)}>Apply</button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="takeoff-workbench-metrics">
                        <span>Floor <strong>{Math.round(componentAreaTotal(selectedRoom, "floor"))} sf</strong></span>
                        <span>Ceiling <strong>{Math.round(componentAreaTotal(selectedRoom, "ceiling"))} sf</strong></span>
                        <span>Wall <strong>{Math.round(componentAreaTotal(selectedRoom, "wall"))} sf</strong></span>
                        <span>Openings <strong>{Math.round(componentAreaTotal(selectedRoom, "glass") + componentAreaTotal(selectedRoom, "door"))} sf</strong></span>
                        <span>Volume <strong>{Math.round(roomArea * selectedRoom.ceilingHeight)} cu ft</strong></span>
                      </div>

                      <div className="takeoff-workbench-section">
                        <button
                          type="button"
                          className="takeoff-workbench-toggle"
                          onClick={() => setRoomWorkbenchSections((current) => ({ ...current, floor: !current.floor }))}
                        >
                          <span>Floor</span>
                          <strong>{Math.round(componentAreaTotal(selectedRoom, "floor"))} assigned / {Math.round(roomArea)} sf</strong>
                          <em>{roomWorkbenchSections.floor ? "Hide" : "Show"}</em>
                        </button>
                        {roomWorkbenchSections.floor && renderAreaWorkspace(selectedRoom, "floor")}
                      </div>

                      <div className="takeoff-workbench-section">
                        <button
                          type="button"
                          className="takeoff-workbench-toggle"
                          onClick={() => setRoomWorkbenchSections((current) => ({ ...current, ceiling: !current.ceiling }))}
                        >
                          <span>Ceiling</span>
                          <strong>{Math.round(componentAreaTotal(selectedRoom, "ceiling"))} assigned / {Math.round(ceilingSurfaceArea)} sf</strong>
                          <em>{roomWorkbenchSections.ceiling ? "Hide" : "Show"}</em>
                        </button>
                        {roomWorkbenchSections.ceiling && (
                          <div id={validationTargetId("ceiling-geometry")} className={`takeoff-workbench-section-body ${validationSectionClass("ceiling-geometry")}`}>
                            <div className="takeoff-ceiling-shape">
                              <label>
                                Ceiling height
                                <DimensionInput
                                  value={selectedRoom.ceilingHeight}
                                  mode={dimensionInputMode}
                                  min={0}
                                  step={0.5}
                                  onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingHeight: value })}
                                />
                              </label>
                              <label>
                                Ceiling shape
                                <select
                                  value={selectedRoom.ceilingType ?? "flat"}
                                  onChange={(event) => updateRoomCeilingType(selectedRoom.id, event.target.value as NonNullable<TakeoffRectRoom["ceilingType"]>)}
                                >
                                  <option value="flat">Flat / taller flat</option>
                                  <option value="vaulted">Vaulted</option>
                                  <option value="vault_flat_peak">Vault w/ flat peak</option>
                                  <option value="tray">Tray</option>
                                  <option value="none">No ceiling load</option>
                                </select>
                              </label>
                              {isVaultCeilingType(selectedRoom.ceilingType ?? "flat") && (
                                <div className="takeoff-ceiling-shape-grid">
                                  <label>
                                    Low height
                                    <DimensionInput
                                      value={selectedRoom.ceilingLowHeight ?? selectedRoom.ceilingHeight}
                                      mode={dimensionInputMode}
                                      min={0}
                                      step={0.5}
                                      onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingLowHeight: value })}
                                    />
                                  </label>
                                  <label>
                                    Peak height
                                    <DimensionInput
                                      value={selectedRoom.ceilingPeakHeight ?? Math.max(selectedRoom.ceilingHeight, selectedRoom.ceilingHeight + 1)}
                                      mode={dimensionInputMode}
                                      min={0}
                                      step={0.5}
                                      onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingPeakHeight: value })}
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
                                  {(selectedRoom.ceilingType ?? "flat") === "vault_flat_peak" && (
                                    <label>
                                      Flat peak width
                                      <DimensionInput
                                        value={selectedRoom.ceilingFlatPeakWidth ?? 4}
                                        mode={dimensionInputMode}
                                        min={0}
                                        step={0.5}
                                        onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingFlatPeakWidth: value })}
                                      />
                                    </label>
                                  )}
                                </div>
                              )}
                              {(selectedRoom.ceilingType ?? "flat") === "tray" && (
                                <div className="takeoff-ceiling-shape-grid">
                                  <label>
                                    Tray mode
                                    <select
                                      value={selectedRoom.ceilingTrayMode ?? "smart_box"}
                                      onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayMode: event.target.value as NonNullable<TakeoffRectRoom["ceilingTrayMode"]> })}
                                    >
                                      <option value="smart_box">Smart box</option>
                                      <option value="double_box">Double box</option>
                                      <option value="follow_room">Follow room</option>
                                      <option value="custom">Custom</option>
                                    </select>
                                  </label>
                                  <label>
                                    Tray offset
                                    <DimensionInput
                                      value={selectedRoom.ceilingTrayOffset ?? 2}
                                      mode={dimensionInputMode}
                                      min={0}
                                      step={0.5}
                                      onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayOffset: value })}
                                    />
                                  </label>
                                  <label>
                                    Tray shape
                                    <select
                                      value={selectedRoom.ceilingTrayShape ?? "rectangular"}
                                      onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayShape: event.target.value as NonNullable<TakeoffRectRoom["ceilingTrayShape"]> })}
                                    >
                                      <option value="rectangular">Rectangular</option>
                                      <option value="clipped">Clipped corners</option>
                                    </select>
                                  </label>
                                  <label>
                                    Steps
                                    <input
                                      type="number"
                                      min="1"
                                      max="6"
                                      step="1"
                                      value={selectedRoom.ceilingTraySteps ?? 1}
                                      onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTraySteps: Number(event.target.value) })}
                                    />
                                  </label>
                                </div>
                              )}
                            </div>
                            <div className={`takeoff-ceiling-qa ${ceilingInfo.needsReview ? "takeoff-ceiling-qa--warning" : ""}`}>
                              <div className="takeoff-component-head">
                                <h3>Ceiling Geometry</h3>
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
                                  {ceilingInfo.ceilingType === "vault_flat_peak" ? <span>Flat / sloped <strong>{Math.round(ceilingInfo.flatPeakArea)} / {Math.round(ceilingInfo.vaultedSlopedCeilingArea)} sf</strong></span> : null}
                                  <span>Estimated added exposure <strong>{Math.round(ceilingInfo.estimatedAddedWallArea)} sf</strong></span>
                                </div>
                              </div>
                              {ceilingSuggestions.length > 0 && (
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
                                            {suggestion.basis === "gable-end" ? " · vault gable" : suggestion.basis === "tray-step" ? " · tray knee wall" : " · raised wall band"} · {suggestion.direction ? `${suggestion.direction}-side` : "no direction required"} · {selectedAdjacency}
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
                            {renderAreaWorkspace(selectedRoom, "ceiling")}
                          </div>
                        )}
                      </div>

                      <div className="takeoff-component-editor takeoff-component-editor--workbench">
                        <span id={validationTargetId("wall-components")} className="takeoff-scroll-anchor" />
                        <span id={validationTargetId("glass-components")} className="takeoff-scroll-anchor" />
                        <span id={validationTargetId("door-components")} className="takeoff-scroll-anchor" />
                        <div className="takeoff-component-head">
                          <h3>Load Components</h3>
                          <div className="takeoff-component-head-actions">
                            <div className="takeoff-component-filter-row" aria-label="Load component filters">
                              <button
                                type="button"
                                className={componentSurfaceFilters.length === allComponentSurfaces.length ? "toolbar-primary" : ""}
                                onClick={() => setComponentSurfaceFilters(allComponentSurfaces)}
                              >
                                All
                              </button>
                              {allComponentSurfaces.map((surface) => {
                                const selected = componentSurfaceFilters.includes(surface);
                                return (
                                  <button
                                    key={surface}
                                    type="button"
                                    className={selected ? "toolbar-primary" : ""}
                                    onClick={() => {
                                      setComponentSurfaceFilters((current) => {
                                        const next = selected
                                          ? current.filter((entry) => entry !== surface)
                                          : [...current, surface];
                                        return next.length ? next : allComponentSurfaces;
                                      });
                                    }}
                                  >
                                    {surface === "glass" ? "Glass" : surface === "wall" ? "Walls" : surface === "door" ? "Doors" : componentSurfaceLabel(surface)}
                                  </button>
                                );
                              })}
                            </div>
                            <span className="takeoff-component-total">{roomComponents(selectedRoom).length} total</span>
                          </div>
                        </div>
                        {renderRoomComponentRows(selectedRoom, componentSurfaceFilters)}
                        <div className="takeoff-add-component-footer">
                          {componentAddSurface ? (
                            <div className="takeoff-add-component-inline">
                              <select value={componentAddSurface} onChange={(event) => setComponentAddSurface(event.target.value as TakeoffRoomComponent["surface"])}>
                                <option value="glass">Add window</option>
                                <option value="door">Add door</option>
                                <option value="ceiling">Add ceiling component</option>
                                <option value="wall">Add wall component</option>
                                <option value="floor">Add floor</option>
                              </select>
                              <button className="toolbar-primary" onClick={() => addSelectedWorkbenchComponent(selectedRoom.id)}>Add</button>
                              <button onClick={() => setComponentAddSurface("")}>Cancel</button>
                            </div>
                          ) : (
                            <button className="toolbar-primary" onClick={() => setComponentAddSurface("glass")}>Add Component</button>
                          )}
                        </div>
                      </div>

                      <div className="takeoff-workbench-section">
                        <button
                          type="button"
                          className="takeoff-workbench-toggle"
                          onClick={() => setRoomWorkbenchSections((current) => ({ ...current, reconciliation: !current.reconciliation }))}
                        >
                          <span>Wall / Opening Reconciliation</span>
                          <strong>Net {Math.round(totals.netArea)} sf</strong>
                          <em>{roomWorkbenchSections.reconciliation ? "Hide" : "Show"}</em>
                        </button>
                        {roomWorkbenchSections.reconciliation && (
                          <div className="takeoff-wall-reconciliation takeoff-workbench-section-body">
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
                        )}
                      </div>
                    </>
                  );
                })()
              ) : selectedAdjacentSpace && selectedAdjacentRoom ? (
                (() => {
                  const spaceArea = rectArea(selectedAdjacentRoom);
                  const ceilingInfo = ceilingGeometryInfo(selectedAdjacentRoom, floor.defaultCeilingHeight ?? 9);
                  const roomBounds = polygonBounds(roomCorners(selectedAdjacentRoom));
                  const isConditionedAddition = selectedAdjacentSpace.kind === "conditioned_addition";
                  return (
                    <>
                      <div className="takeoff-workbench-head takeoff-workbench-head--adjacent">
                        <div>
                          <input
                            className="takeoff-room-title-input"
                            value={selectedAdjacentSpace.name}
                            onChange={(event) => updateAdjacentSpace(selectedAdjacentSpace.id, { name: event.target.value })}
                            aria-label="Adjacent space name"
                          />
                          <p className="takeoff-muted">
                            {Math.round(spaceArea)} sf · {adjacentSpaceLabel(selectedAdjacentSpace.kind)} · {isConditionedAddition ? "planned conditioned space" : "unconditioned"}
                          </p>
                        </div>
                        <div className="takeoff-workbench-actions">
                          {isConditionedAddition && (
                            <button className="toolbar-primary" onClick={() => convertAdjacentSpaceToConditionedRoom(selectedAdjacentSpace.id)}>Convert to Room</button>
                          )}
                          <button onClick={() => removeAdjacentSpace(selectedAdjacentSpace.id)}>Remove Space</button>
                        </div>
                      </div>

                      <div className="takeoff-workbench-metrics takeoff-workbench-metrics--adjacent">
                        <span>Area <strong>{Math.round(spaceArea)} sf</strong></span>
                        <span>Ceiling <strong>{selectedAdjacentRoom.ceilingHeight} ft</strong></span>
                        <span>Peak <strong>{ceilingInfo.peakHeight} ft</strong></span>
                        <span>{selectedAdjacentSpace.closedCeilingBelow ? "Closed ceiling" : "Open / roof only"}</span>
                      </div>

                      <div className="takeoff-workbench-section">
                        <button
                          type="button"
                          className="takeoff-workbench-toggle"
                          onClick={() => setRoomWorkbenchSections((current) => ({ ...current, ceiling: !current.ceiling }))}
                        >
                          <span>Ceiling / Roof Geometry</span>
                          <strong>{isVaultCeilingType(ceilingInfo.ceilingType) ? `${ceilingInfo.lowHeight}/${ceilingInfo.peakHeight} ft` : `${selectedAdjacentRoom.ceilingHeight} ft flat`}</strong>
                          <em>{roomWorkbenchSections.ceiling ? "Hide" : "Show"}</em>
                        </button>
                        {roomWorkbenchSections.ceiling && (
                          <div className="takeoff-workbench-section-body">
                            <div className="takeoff-ceiling-shape">
                              <label>
                                Closed ceiling
                                <input
                                  type="checkbox"
                                  checked={Boolean(selectedAdjacentSpace.closedCeilingBelow)}
                                  onChange={(event) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { closedCeilingBelow: event.target.checked })}
                                />
                              </label>
                              <label>
                                Ceiling height
                                <DimensionInput
                                  value={selectedAdjacentRoom.ceilingHeight}
                                  mode={dimensionInputMode}
                                  min={0}
                                  step={0.5}
                                  onCommit={(value) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { ceilingHeight: value })}
                                />
                              </label>
                              <label>
                                Ceiling shape
                                <select
                                  value={selectedAdjacentRoom.ceilingType ?? "flat"}
                                  onChange={(event) => updateAdjacentSpaceCeilingType(selectedAdjacentSpace.id, event.target.value as NonNullable<TakeoffRectRoom["ceilingType"]>)}
                                >
                                  <option value="flat">Flat / roof only</option>
                                  <option value="vaulted">Vaulted / gable</option>
                                  <option value="vault_flat_peak">Vault w/ flat peak</option>
                                  <option value="none">No ceiling/roof geometry</option>
                                </select>
                              </label>
                              {isVaultCeilingType(selectedAdjacentRoom.ceilingType ?? "flat") && (
                                <div className="takeoff-ceiling-shape-grid">
                                  <label>
                                    Low height
                                    <DimensionInput
                                      value={selectedAdjacentRoom.ceilingLowHeight ?? selectedAdjacentRoom.ceilingHeight}
                                      mode={dimensionInputMode}
                                      min={0}
                                      step={0.5}
                                      onCommit={(value) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { ceilingLowHeight: value })}
                                    />
                                  </label>
                                  <label>
                                    Peak height
                                    <DimensionInput
                                      value={selectedAdjacentRoom.ceilingPeakHeight ?? Math.max(selectedAdjacentRoom.ceilingHeight, selectedAdjacentRoom.ceilingHeight + 1)}
                                      mode={dimensionInputMode}
                                      min={0}
                                      step={0.5}
                                      onCommit={(value) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { ceilingPeakHeight: value })}
                                    />
                                  </label>
                                  <label>
                                    Ridge direction
                                    <select
                                      value={selectedAdjacentRoom.ceilingRidgeDirection ?? "E-W"}
                                      onChange={(event) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { ceilingRidgeDirection: event.target.value as NonNullable<TakeoffRectRoom["ceilingRidgeDirection"]> })}
                                    >
                                      <option value="E-W">East - West</option>
                                      <option value="N-S">North - South</option>
                                    </select>
                                  </label>
                                  {(selectedAdjacentRoom.ceilingType ?? "flat") === "vault_flat_peak" && (
                                    <label>
                                      Flat peak width
                                      <DimensionInput
                                        value={selectedAdjacentRoom.ceilingFlatPeakWidth ?? 4}
                                        mode={dimensionInputMode}
                                        min={0}
                                        step={0.5}
                                        onCommit={(value) => updateAdjacentSpaceCeilingGeometry(selectedAdjacentSpace.id, { ceilingFlatPeakWidth: value })}
                                      />
                                    </label>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className="takeoff-ceiling-qa">
                              <div className="takeoff-component-head">
                                <h3>Unconditioned Space Geometry</h3>
                              </div>
                              <div className="takeoff-ceiling-qa-grid">
                                {renderRoomLoadSketch(selectedAdjacentRoom, "ceiling")}
                                <div className="takeoff-ceiling-qa-copy">
                                  <span>Floor default <strong>{floor.defaultCeilingHeight ?? 9} ft</strong></span>
                                  <span>Space <strong>{Math.round(roomBounds.width)} x {Math.round(roomBounds.depth)} ft</strong></span>
                                  <span>Low / peak <strong>{ceilingInfo.lowHeight} / {ceilingInfo.peakHeight} ft</strong></span>
                                  <span>Ridge offset <strong>{Math.round(ceilingInfo.ridgeOffset * 100)}%</strong></span>
                                  <span>Ceiling surface <strong>{Math.round(ceilingInfo.slopedCeilingArea)} sf</strong></span>
                                  <span>Boundary use <strong>{selectedAdjacentSpace.closedCeilingBelow ? "Can create adjacent attic exposure" : "Visual only"}</strong></span>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()
              ) : (
                <p className="takeoff-muted">Select a room or shaded adjacent space on the plan or in the space list.</p>
              )}
            </section>
          </div>
        </section>

        <aside className={`takeoff-sidebar takeoff-tools-sidebar ${!rightPanelOpen ? "takeoff-sidebar--collapsed" : ""}`}>
          {!rightPanelOpen ? (
            <button className="takeoff-rail-toggle" onClick={() => setRightPanelOpen(true)} aria-label="Show tools panel">Tools</button>
          ) : (
          <>
          <div className="takeoff-tools-head">
            <h2>Tools</h2>
            <button className="takeoff-icon-button" onClick={() => setRightPanelOpen(false)} aria-label="Hide tools panel">Hide</button>
          </div>

          <details className="takeoff-panel takeoff-right-details takeoff-export-panel">
            <summary>Export</summary>
            <div className="takeoff-form-actions">
              <button onClick={exportTakeoffJson}>Takeoff JSON</button>
              <button onClick={exportPayloadJson}>Payload JSON</button>
              <button onClick={exportDiagnosticReport}>Diagnostic Report JSON</button>
            </div>
          </details>

          {show2DDraftingPanels && (
            <>
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

              <details className="takeoff-panel takeoff-right-details takeoff-adjacent-details">
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
                  <p className="takeoff-note">Drag a rectangle along the outside of conditioned space. Corners snap within 5 ft; hold Shift for precise placement, then release Shift during the drag to resume snapping.</p>
                ) : (
                  <p className="takeoff-muted">Adjacent spaces tag exterior wall treatment without adding conditioned room area.</p>
                )}
                {(floor.adjacentSpaces ?? []).length > 0 && (
                  <div className="takeoff-adjacent-list">
                    {(floor.adjacentSpaces ?? []).map((space) => (
                      <div key={space.id} className="takeoff-adjacent-row">
                        <div className="takeoff-adjacent-row-main">
                          <span><strong>{space.name}</strong> · {Math.round(polygonArea(adjacentSpaceCorners(space)))} sf · {adjacentSpaceLabel(space.kind)}</span>
                          <button className={selectedRoomId === space.id ? "toolbar-primary" : ""} onClick={() => setSelectedRoomId(space.id)}>Select</button>
                          <button onClick={() => removeAdjacentSpace(space.id)}>Remove</button>
                        </div>
                        <p className="takeoff-muted">Select this shaded space to edit its ceiling / roof geometry in the Rooms panel.</p>
                      </div>
                    ))}
                  </div>
                )}
              </details>

              <details className="takeoff-panel takeoff-right-details">
                <summary>Openings</summary>
                <div className="takeoff-form-actions takeoff-openings-actions">
                  <button className={openingModeActive ? "toolbar-primary" : ""} onClick={() => (openingModeActive ? stopOpeningPlacement() : startOpeningPlacement())}>
                    {openingModeActive ? "Stop Placing" : "Place Opening"}
                  </button>
                  <button onClick={openComponentSchedule}>Component Schedule</button>
                </div>
                {openingModeActive ? (
                  <p className="takeoff-note">
                    Click the plan on an exterior wall. The tool will identify the room and wall facing, then ask which door or glass component to place.
                  </p>
                ) : (
                  <p className="takeoff-muted">Openings are assigned from the plan grid and must land on exterior/load-bearing room edges.</p>
                )}
              </details>
            </>
          )}

          {selectedRoom && (
            <section className="takeoff-panel">
              {renderRoomLoadSketch(selectedRoom, "load")}
            </section>
          )}

          <section className="takeoff-panel takeoff-validation-panel">
            <div className="takeoff-panel-head">
              <h2>Validation</h2>
              <button type="button" onClick={recheckValidation}>Recheck Validation</button>
            </div>
            {visibleProjectValidation.length === 0 ? (
              <p className="takeoff-ok">{projectValidation.length > 0 ? "All visible validation flags are dismissed. Recheck Validation will show them again." : "Ready for payload preview."}</p>
            ) : (
              <div className="takeoff-issue-list">
                {visibleProjectValidation.map((entry, listIndex) => (
                  (() => {
                    const { issue, floor: issueFloor, key: issueKey } = entry;
                    const previousEntry = visibleProjectValidation[listIndex - 1];
                    const showFloorDivider = !previousEntry || previousEntry.floor.id !== issueFloor.id;
                    const boundaryCandidate = issue.boundaryCandidateId
                      ? boundaryCandidatesForFloor(issueFloor).find((candidate) => candidate.id === issue.boundaryCandidateId)
                      : null;
                    return (
                      <div key={issueKey} className="takeoff-issue-stack">
                        {showFloorDivider && (
                          <div className="takeoff-validation-floor-divider">
                            <span>{issueFloor.name}</span>
                            {issueFloor.id === activeFloorId && <strong>Active</strong>}
                          </div>
                        )}
                        <button
                          className={`takeoff-issue takeoff-issue--${issue.severity} ${issue.target ? "takeoff-issue--clickable" : ""} ${activeValidationTarget?.key === issueKey ? "takeoff-issue--active" : ""}`}
                          onClick={() => focusValidationIssue(issue, issueKey, issueFloor)}
                          disabled={!issue.target}
                        >
                          {issue.message}
                        </button>
                        {boundaryCandidate && (
                          <div className="takeoff-boundary-actions">
                            <button onClick={() => resolveBoundaryCandidate(boundaryCandidate.id, "slice", issueFloor.id)}>Slice wall</button>
                            <button onClick={() => resolveBoundaryCandidate(boundaryCandidate.id, "whole-section", issueFloor.id)}>Whole section</button>
                            <button onClick={() => resolveBoundaryCandidate(boundaryCandidate.id, "ignore", issueFloor.id)}>Keep exterior</button>
                          </div>
                        )}
                      </div>
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
                    else if (floor.rooms[0]) setSliceRoomId(floor.rooms[0].id);
                  }}
                >
                  {unassignedRegions.map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label} - {Math.round(region.area)} sf
                    </option>
                  ))}
                </select>
                <select
                  value={selectedSliceRoomId}
                  onChange={(event) => setSliceRoomId(event.target.value)}
                >
                  {sliceRoomOptions.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}{selectedUnassignedAdjacentRoomIds.includes(room.id) ? " (adjacent)" : ""}
                    </option>
                  ))}
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
                    <span className="takeoff-room-card-title">
                      <strong>{room.name}</strong>
                      {roomValidationBadge(floor.id, room.id)}
                    </span>
                    <span>
                      {Math.round(rectArea(room))} sf · {room.ceilingHeight} ft ·
                      floor {Math.round(componentAreaTotal(room, "floor"))} sf ·
                      ceiling {Math.round(componentAreaTotal(room, "ceiling"))} sf
                    </span>
                  </div>
                  <button onClick={(event) => { event.stopPropagation(); removeRoom(room.id); }}>Remove</button>
                </div>
              ))}
              {(floor.adjacentSpaces ?? []).map((space) => {
                const roomLike = adjacentSpaceAsRoom(space, floor.defaultCeilingHeight ?? 9);
                return (
                  <div
                    key={space.id}
                    className={`takeoff-room-row takeoff-room-row--adjacent ${selectedRoomId === space.id ? "takeoff-room-row--selected" : ""}`}
                    onClick={() => setSelectedRoomId(space.id)}
                  >
                    <div>
                      <strong>{space.name}</strong>
                      <span>{Math.round(rectArea(roomLike))} sf · {adjacentSpaceLabel(space.kind)} · {roomLike.ceilingHeight} ft</span>
                    </div>
                    <button onClick={(event) => { event.stopPropagation(); removeAdjacentSpace(space.id); }}>Remove</button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="takeoff-panel takeoff-room-sidebar-legacy">
            <div className="takeoff-panel-head">
              <h2>Room Profile</h2>
            </div>
            {selectedRoom ? (
              <>
                {(() => {
                  const suggestions = roomExteriorWallSuggestions(floor, selectedRoom, floors);
                  const exteriorDirections = suggestions.map((suggestion) => suggestion.direction);
                  const reconciliation = roomWallReconciliation(floor, selectedRoom, floors);
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
                          ) : suggestionRows.map(({ suggestion, adjacentKinds, recommendation, approved }) => {
                            const geometrySummary = suggestion.geometryLabel ?? `${Number(suggestion.length.toFixed(1))} lf x ${Number((suggestion.area / Math.max(suggestion.length, 0.001)).toFixed(1))} ft`;
                            return (
                              <div key={suggestion.direction} className="takeoff-wall-suggestion-row">
                                <span>
                                  Suggested wall area: <strong>{Math.round(suggestion.area)} sf</strong> {suggestion.direction} {recommendation.label.toLowerCase()}
                                  <small>
                                    {geometrySummary}
                                    {adjacentKinds.length > 0 ? ` · adjacent ${adjacentKinds.map(adjacentSpaceLabel).join(", ")} · ${recommendation.assembly}` : ""}
                                  </small>
                                </span>
                                <button className={approved ? "toolbar-primary" : ""} onClick={() => applySuggestedWallArea(selectedRoom.id, suggestion, recommendation.assembly, recommendation.adjacency)}>
                                  {approved ? "Approved" : "Apply"}
                                </button>
                              </div>
                            );
                          })}
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
                  Ceiling height
                  <DimensionInput
                    value={selectedRoom.ceilingHeight}
                    mode={dimensionInputMode}
                    min={0}
                    step={0.5}
                    onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingHeight: value })}
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
                      <option value="vault_flat_peak">Vault w/ flat peak</option>
                      <option value="tray">Tray</option>
                      <option value="none">No ceiling load</option>
                    </select>
                  </label>
                  {isVaultCeilingType(selectedRoom.ceilingType ?? "flat") && (
                    <div className="takeoff-ceiling-shape-grid">
                      <label>
                        Low height
                        <DimensionInput
                          value={selectedRoom.ceilingLowHeight ?? selectedRoom.ceilingHeight}
                          mode={dimensionInputMode}
                          min={0}
                          step={0.5}
                          onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingLowHeight: value })}
                        />
                      </label>
                      <label>
                        Peak height
                        <DimensionInput
                          value={selectedRoom.ceilingPeakHeight ?? Math.max(selectedRoom.ceilingHeight, selectedRoom.ceilingHeight + 1)}
                          mode={dimensionInputMode}
                          min={0}
                          step={0.5}
                          onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingPeakHeight: value })}
                        />
                      </label>
                      {(selectedRoom.ceilingType ?? "flat") === "vault_flat_peak" && (
                        <label>
                          Flat peak width
                          <DimensionInput
                            value={selectedRoom.ceilingFlatPeakWidth ?? 4}
                            mode={dimensionInputMode}
                            min={0}
                            step={0.5}
                            onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingFlatPeakWidth: value })}
                          />
                        </label>
                      )}
                    </div>
                  )}
                  {(selectedRoom.ceilingType ?? "flat") === "tray" && (
                    <div className="takeoff-ceiling-shape-grid">
                      <label>
                        Tray mode
                        <select
                          value={selectedRoom.ceilingTrayMode ?? "smart_box"}
                          onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayMode: event.target.value as NonNullable<TakeoffRectRoom["ceilingTrayMode"]> })}
                        >
                          <option value="smart_box">Smart box</option>
                          <option value="double_box">Double box</option>
                          <option value="follow_room">Follow room</option>
                          <option value="custom">Custom</option>
                        </select>
                      </label>
                      <label>
                        Tray offset
                        <DimensionInput
                          value={selectedRoom.ceilingTrayOffset ?? 2}
                          mode={dimensionInputMode}
                          min={0}
                          step={0.5}
                          onCommit={(value) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayOffset: value })}
                        />
                      </label>
                      <label>
                        Tray shape
                        <select
                          value={selectedRoom.ceilingTrayShape ?? "rectangular"}
                          onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTrayShape: event.target.value as NonNullable<TakeoffRectRoom["ceilingTrayShape"]> })}
                        >
                          <option value="rectangular">Rectangular</option>
                          <option value="clipped">Clipped corners</option>
                        </select>
                      </label>
                      <label>
                        Steps
                        <input
                          type="number"
                          min="1"
                          max="6"
                          step="1"
                          value={selectedRoom.ceilingTraySteps ?? 1}
                          onChange={(event) => updateRoomCeilingGeometry(selectedRoom.id, { ceilingTraySteps: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                  )}
                  <p className="takeoff-muted">
                    Ceiling shape is stored with the editable takeoff JSON; generated knee-wall sections are added when ceiling geometry is approved.
                  </p>
                </div>
                {(["floor", "ceiling", "wall", "glass", "door"] as const).map((surface) => {
                  const isAreaChecked = surface === "floor" || surface === "ceiling";
                  const roomArea = isAreaChecked ? expectedSurfaceArea(selectedRoom, surface) : rectArea(selectedRoom);
                  const assigned = componentAreaTotal(selectedRoom, surface);
                  const delta = roomArea - assigned;
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
                              <div key={component.id} className={`takeoff-component-row ${componentRequiresDirection(component) ? "takeoff-component-row--directional" : ""} ${isStaleCeilingWall ? "takeoff-component-row--stale" : ""} ${isActiveComponentRow ? "takeoff-component-row--active" : ""}`}>
                                <select
                                  value={component.assembly}
                                  onChange={(event) => updateRoomComponent(selectedRoom.id, component.id, { assembly: event.target.value })}
                                >
                                  {options.map((option) => (
                                    <option key={option.id} value={option.code}>{option.code} - {option.description}</option>
                                  ))}
                                </select>
                                {componentRequiresDirection(component) && (
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
                <label className="takeoff-opening-field">
                  Type
                  <select
                    value={openingPlacement.surface}
                    onChange={(event) => updateOpeningPlacement({ surface: event.target.value as "glass" | "door" })}
                  >
                    <option value="glass">Glass / Window</option>
                    <option value="door">Door</option>
                  </select>
                </label>
                <label className="takeoff-opening-field takeoff-opening-field--component">
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
                  <label className="takeoff-opening-field">
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
                <label className="takeoff-opening-field">
                  Width ft
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={openingPlacement.width}
                    onChange={(event) => updateOpeningPlacement({ width: Number(event.target.value) })}
                  />
                </label>
                <label className="takeoff-opening-field">
                  Height ft
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={openingPlacement.height}
                    onChange={(event) => updateOpeningPlacement({ height: Number(event.target.value) })}
                  />
                </label>
                <label className="takeoff-opening-field takeoff-opening-field--label">
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
              <div className="takeoff-opening-footer">
                <div className="takeoff-form-actions">
                  <button className="toolbar-primary" onClick={editingOpeningTarget ? confirmOpeningEdit : confirmOpeningPlacement}>
                    {editingOpeningTarget ? "Update Opening" : "Confirm Opening"}
                  </button>
                  <button onClick={closeOpeningDialog}>Cancel</button>
                </div>
                {editingOpeningTarget && <button className="danger-button takeoff-opening-remove" onClick={removeSelectedOpening}>Remove</button>}
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
      {pendingSessionExit && (
        <div className="modal-backdrop open-dialog-backdrop" onClick={() => setPendingSessionExit(null)}>
          <div className="modal takeoff-unsaved-exit-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Save before leaving?</h2>
              <button className="modal-close" onClick={() => setPendingSessionExit(null)}>x</button>
            </div>
            <p className="takeoff-muted">
              This takeoff has unsaved changes. Save before you {pendingSessionExit.label}, continue without saving, or stay on this page.
            </p>
            <div className="takeoff-unsaved-exit-actions">
              <button className="toolbar-primary" onClick={() => void continuePendingSessionExit(true)} disabled={saveLoading}>
                {saveLoading ? "Saving..." : "Save and Continue"}
              </button>
              <button onClick={() => void continuePendingSessionExit(false)} disabled={saveLoading}>
                Continue Without Saving
              </button>
              <button onClick={() => setPendingSessionExit(null)} disabled={saveLoading}>
                Stay Here
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
                      <td>
                        <button className="toolbar-primary" onClick={() => loadTakeoff(row.id)}>
                          Open
                        </button>
                      </td>
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
