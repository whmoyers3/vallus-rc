export type TakeoffAuthoringMode = "pdf_trace" | "image_trace" | "grid_manual";

export type TakeoffRoomType = "plain" | "bedroom" | "kitchen" | "entertainment" | "laundry";

export type TakeoffPoint = {
  x: number;
  y: number;
};

export type TakeoffRoomComponentSource = "manual" | "exterior-perimeter" | "opening-placement" | "raised-ceiling" | "vault-gable";
export type TakeoffWallAdjacency = "outside" | "attic" | "garage" | "crawlspace" | "conditioned" | "unknown";
export type TakeoffBoundaryType =
  | "exterior"
  | "attic_knee_wall"
  | "garage_wall"
  | "partition"
  | "crawlspace_wall"
  | "floor_over_garage"
  | "cantilever"
  | "framed_floor"
  | "slab"
  | "flat_ceiling"
  | "vaulted_ceiling"
  | "unknown";

export type TakeoffRoomComponent = {
  id: string;
  surface: "floor" | "ceiling" | "wall" | "glass" | "door";
  assembly: string;
  area: number;
  width?: number;
  height?: number;
  direction?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  label?: string;
  placement?: TakeoffPoint;
  source?: TakeoffRoomComponentSource;
  adjacency?: TakeoffWallAdjacency;
  boundary?: TakeoffBoundaryType;
  geometryLabel?: string;
  spanStart?: number;
  spanEnd?: number;
  zMin?: number;
  zMax?: number;
  solarDirection?: "Shaded" | "Skylight";
};

export type TakeoffAdjacentSpaceKind = "garage" | "attic" | "crawl" | "covered_porch" | "exterior";
export type TakeoffVerticalProfile =
  | { kind: "none" }
  | { kind: "flat"; zMin: number; zMax: number }
  | { kind: "shed"; zMin: number; lowSide: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW"; lowHeight: number; highHeight: number }
  | { kind: "gable"; zMin: number; lowHeight: number; peakHeight: number; ridgeDirection: "E-W" | "N-S"; ridgeOffset?: number }
  | { kind: "unknown"; zMin?: number; zMax?: number };
export type TakeoffBoundaryCandidateResolution = "slice" | "whole-section" | "ignore";

export type TakeoffAdjacentSpace = {
  id: string;
  name: string;
  kind: TakeoffAdjacentSpaceKind;
  x: number;
  y: number;
  width: number;
  depth: number;
  polygon?: TakeoffPoint[];
  ceilingHeight?: number;
  ceilingType?: "none" | "flat" | "vaulted";
  ceilingLowHeight?: number;
  ceilingPeakHeight?: number;
  ceilingRidgeDirection?: "E-W" | "N-S";
  ceilingRidgeOffset?: number;
  verticalProfile?: TakeoffVerticalProfile;
  closedCeilingBelow?: boolean;
  boundaryIntent?: TakeoffWallAdjacency;
};

export type TakeoffComponentCategory = "Wall" | "Door" | "Ceiling" | "Floor" | "Glass";

export type TakeoffComponentDefinition = {
  id: string;
  code: string;
  category: TakeoffComponentCategory;
  uValue?: number;
  shgc?: number | null;
  description: string;
  source: "default" | "library" | "one_off";
};

export type TakeoffRectRoom = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  ceilingHeight: number;
  ceilingType?: "none" | "flat" | "vaulted";
  ceilingLowHeight?: number;
  ceilingPeakHeight?: number;
  ceilingRidgeDirection?: "E-W" | "N-S";
  ceilingRidgeOffset?: number;
  ceilingGeometryApproved?: boolean;
  floorType?: "none" | "slab" | "framed";
  ceilingLoadArea?: number;
  floorLoadArea?: number;
  roomType?: TakeoffRoomType;
  roomTypeSuggestionDismissedKey?: string;
  peopleOverride?: number;
  applianceWattsOverride?: number;
  components?: TakeoffRoomComponent[];
  polygon?: TakeoffPoint[];
  areaAdjustment?: number;
};

export type TakeoffScaleLine = {
  id: string;
  label: string;
  orientation: "horizontal" | "vertical" | "any";
  start: TakeoffPoint;
  end: TakeoffPoint;
  sourceStart?: TakeoffPoint;
  sourceEnd?: TakeoffPoint;
  knownFeet: number;
};

export type TakeoffFloor = {
  id: string;
  name: string;
  authoringMode: TakeoffAuthoringMode;
  coordinateSpace?: "world_feet";
  elevation?: number;
  floorToFloorHeight?: number;
  alignment?: {
    referenceFloorId?: string;
    transform?: {
      translateX: number;
      translateY: number;
      rotationDeg: number;
      scale: number;
    };
    residualFt?: number;
    pointPairs?: Array<{
      id: string;
      reference: TakeoffPoint;
      local: TakeoffPoint;
    }>;
  };
  referencePoints?: Array<{
    id: string;
    label?: string;
    local: TakeoffPoint;
    world?: TakeoffPoint;
  }>;
  designGrid: {
    width: number;
    depth: number;
  };
  scale: {
    feetPerGrid: number;
    gridSnapInches: number;
  };
  defaultCeilingHeight?: number;
  reference?: {
    filename: string;
    kind: "pdf" | "image";
    assetId?: number;
    storagePath?: string;
    mimeType?: string;
    sizeBytes?: number;
    downloadUrl?: string;
    signedUrl?: string;
    sourcePlanDocumentId?: string | number;
    sourcePageNumber?: number;
    optimizedFromCrop?: boolean;
    renderScale?: number;
    previewWidthPx?: number;
    previewHeightPx?: number;
    crop?: {
      x: number;
      y: number;
      width: number;
      depth: number;
    };
  };
  calibration: {
    lines: TakeoffScaleLine[];
    linesVisible?: boolean;
    confirmed: boolean;
    appliedFactor: number;
    expectedArea?: number;
    areaConfirmed: boolean;
  };
  conditionedPerimeter: {
    width: number;
    depth: number;
  };
  exteriorPolygon: TakeoffPoint[];
  perimeterLocked: boolean;
  rooms: TakeoffRectRoom[];
  adjacentSpaces?: TakeoffAdjacentSpace[];
  boundaryCandidateResolutions?: Record<string, TakeoffBoundaryCandidateResolution>;
  attributedSlices?: Array<{
    id: string;
    roomId: string;
    cells: Array<{ x: number; y: number; width: number; depth: number }>;
  }>;
};

export type TakeoffProject = {
  schemaVersion: "takeoff.v1";
  name: string;
  location?: string;
  mechanicalVentilation?: boolean;
  ventilationCfm?: number;
  frontDoorFaces: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  componentSchedule?: TakeoffComponentDefinition[];
  floors: TakeoffFloor[];
};

export type TakeoffValidationIssue = {
  severity: "error" | "warning";
  message: string;
  issueType?: "room-type-suggestion" | "boundary-candidate";
  boundaryCandidateId?: string;
  target?: {
    type: "room" | "unassigned";
    roomId?: string;
    regionId?: string;
  };
};
