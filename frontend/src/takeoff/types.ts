export type TakeoffAuthoringMode = "pdf_trace" | "image_trace" | "grid_manual";

export type TakeoffRoomType = "plain" | "bedroom" | "kitchen" | "entertainment" | "laundry";

export type TakeoffPoint = {
  x: number;
  y: number;
};

export type TakeoffRoomComponentSource =
  | "manual"
  | "exterior-perimeter"
  | "opening-placement"
  | "raised-ceiling"
  | "vault-gable"
  | "tray-knee-wall"
  | "wall-gap-fill"
  | "conditioned-wall-profile"
  | "band-joist"
  | "open-to-above-envelope"
  | "connected-volume";
export type TakeoffWallAdjacency = "outside" | "attic" | "garage" | "crawlspace" | "conditioned" | "unknown";
export type TakeoffBoundaryType =
  | "exterior"
  | "attic_knee_wall"
  | "garage_wall"
  | "band_joist"
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
  sillHeight?: number;
  headHeight?: number;
  source?: TakeoffRoomComponentSource;
  adjacency?: TakeoffWallAdjacency;
  boundary?: TakeoffBoundaryType;
  geometryLabel?: string;
  loadExempt?: boolean;
  spanStart?: number;
  spanEnd?: number;
  zMin?: number;
  zMax?: number;
  panelPolygons?: TakeoffPoint[][];
  wallProfilePolygons?: TakeoffPoint[][];
  solarDirection?: "Shaded" | "Skylight";
};

export type TakeoffAdjacentSpaceKind = "garage" | "attic" | "crawl" | "covered_porch" | "conditioned_addition" | "exterior";
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
  ceilingType?: "none" | "flat" | "vaulted" | "vault_flat_peak" | "tray";
  ceilingLowHeight?: number;
  ceilingPeakHeight?: number;
  ceilingRidgeDirection?: "E-W" | "N-S";
  /** Normalized ridge shift across the room span: -1 is one edge, 0 centered, 1 the opposite edge. */
  ceilingRidgeOffset?: number;
  ceilingFlatPeakWidth?: number;
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
  ceilingType?: "none" | "flat" | "vaulted" | "vault_flat_peak" | "tray";
  ceilingLowHeight?: number;
  ceilingPeakHeight?: number;
  ceilingRidgeDirection?: "E-W" | "N-S";
  /** Normalized ridge shift across the room span: -1 is one edge, 0 centered, 1 the opposite edge. */
  ceilingRidgeOffset?: number;
  ceilingFlatPeakWidth?: number;
  ceilingTrayOffset?: number;
  ceilingTrayShape?: "rectangular" | "clipped";
  ceilingTrayMode?: "follow_room" | "smart_box" | "double_box" | "custom";
  ceilingTraySteps?: number;
  ceilingGeometryApproved?: boolean;
  floorType?: "none" | "slab" | "framed";
  ceilingLoadArea?: number;
  floorLoadArea?: number;
  roomType?: TakeoffRoomType;
  roomTypeSuggestionDismissedKey?: string;
  peopleOverride?: number;
  applianceWattsOverride?: number;
  components?: TakeoffRoomComponent[];
  envelopeCompilerPreviewDisabled?: boolean;
  verticalLinks?: TakeoffVerticalSpaceLink[];
  polygon?: TakeoffPoint[];
  areaAdjustment?: number;
};

export type TakeoffVerticalSpaceLink = {
  id: string;
  type: "open_to_above";
  targetFloorId?: string;
  previousCeilingHeight?: number;
  envelopeMode?: "volume_only" | "review" | "generate_wall_extensions";
  ceilingAreaMode?: "existing_room_ceiling" | "manual" | "connected_volume";
  ceilingAreaOverride?: number;
  transitionWallAreaOverride?: number;
};

export type TakeoffConnectedVolumeFootprintRole = "lower" | "upper" | "ceiling" | "transition";

export type TakeoffConnectedVolumeFootprint = {
  id: string;
  floorId: string;
  role: TakeoffConnectedVolumeFootprintRole;
  roomIds?: string[];
  polygon?: TakeoffPoint[];
  areaOverride?: number;
  label?: string;
};

export type TakeoffConnectedVolumeComponent = {
  id: string;
  surface: "ceiling" | "wall";
  assembly: string;
  area: number;
  direction?: TakeoffRoomComponent["direction"];
  label?: string;
  adjacency?: TakeoffWallAdjacency;
  boundary?: TakeoffBoundaryType;
};

export type TakeoffConnectedVolume = {
  id: string;
  name: string;
  assignedRoomId?: string;
  reportingFloorId?: string;
  envelopeMode?: "review" | "generate_wall_extensions" | "manual_components";
  footprints: TakeoffConnectedVolumeFootprint[];
  components?: TakeoffConnectedVolumeComponent[];
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
  floorToFloorHeightUserSet?: boolean;
  bandJoistEnabled?: boolean;
  bandJoistHeight?: number;
  bandJoistHeightUserSet?: boolean;
  floorAlignmentSnapEnabled?: boolean;
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
    rotationDeg?: number;
    mirroredX?: boolean;
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
  dimensionInputMode?: "decimal" | "feet-inches";
  mechanicalVentilation?: boolean;
  ventilationCfm?: number;
  frontDoorFaces: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  componentSchedule?: TakeoffComponentDefinition[];
  floors: TakeoffFloor[];
  connectedVolumes?: TakeoffConnectedVolume[];
};

export type TakeoffSurfaceTreatmentSuggestion = {
  surface: "floor" | "ceiling";
  action: "none" | "partial" | "full";
  roomArea: number;
  conditionedArea: number;
  exposedArea: number;
  adjacentFloorName?: string;
  assembly?: string;
  label?: string;
  adjacency?: TakeoffWallAdjacency;
  boundary?: TakeoffBoundaryType;
  loadComponents?: Array<{
    area: number;
    assembly?: string;
    label?: string;
    adjacency?: TakeoffWallAdjacency;
    boundary?: TakeoffBoundaryType;
    panelPolygons?: TakeoffPoint[][];
  }>;
  panelPolygons?: TakeoffPoint[][];
  conditionedPanelPolygons?: TakeoffPoint[][];
};

export type TakeoffWallComponentGeometrySuggestion = {
  action: "remove" | "resize";
  componentId: string;
  direction?: TakeoffRoomComponent["direction"];
  area?: number;
  assembly?: string;
  adjacency?: TakeoffWallAdjacency;
  label?: string;
};

export type TakeoffGlassTreatmentSuggestion = {
  action: "shade";
  componentId: string;
  direction?: TakeoffRoomComponent["direction"];
  solarDirection: "Shaded";
  label?: string;
};

export type TakeoffInternalGainSuggestion = {
  action: "set-overrides";
  roomType: TakeoffRoomType;
  people: number;
  applianceWatts: number;
  label?: string;
};

export type TakeoffOpenToAboveEnvelopeSuggestion = {
  action: "generate-wall-extensions";
  linkId: string;
  addedHeight: number;
  estimatedWallArea: number;
  label?: string;
};

export type TakeoffVerticalMergeSuggestion = {
  action: "create-connected-volume";
  sourceFloorId: string;
  sourceRoomId: string;
  targetFloorId: string;
  targetRoomId: string;
  defaultReportingFloorId: string;
  overlapArea: number;
  label?: string;
};

export type TakeoffValidationIssue = {
  severity: "error" | "warning";
  message: string;
  issueType?: "room-type-suggestion" | "boundary-candidate" | "surface-treatment-suggestion" | "wall-component-geometry-suggestion" | "glass-treatment-suggestion" | "internal-gain-suggestion" | "open-to-above-envelope-suggestion" | "vertical-merge-suggestion";
  boundaryCandidateId?: string;
  surfaceTreatmentSuggestion?: TakeoffSurfaceTreatmentSuggestion;
  wallComponentGeometrySuggestion?: TakeoffWallComponentGeometrySuggestion;
  glassTreatmentSuggestion?: TakeoffGlassTreatmentSuggestion;
  internalGainSuggestion?: TakeoffInternalGainSuggestion;
  openToAboveEnvelopeSuggestion?: TakeoffOpenToAboveEnvelopeSuggestion;
  verticalMergeSuggestion?: TakeoffVerticalMergeSuggestion;
  target?: {
    type: "room" | "unassigned";
    roomId?: string;
    regionId?: string;
  };
};
