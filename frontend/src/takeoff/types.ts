export type TakeoffAuthoringMode = "pdf_trace" | "image_trace" | "grid_manual";

export type TakeoffPoint = {
  x: number;
  y: number;
};

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
};

export type TakeoffAdjacentSpaceKind = "garage" | "attic" | "crawl" | "exterior";

export type TakeoffAdjacentSpace = {
  id: string;
  name: string;
  kind: TakeoffAdjacentSpaceKind;
  x: number;
  y: number;
  width: number;
  depth: number;
  polygon?: TakeoffPoint[];
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
  floorType?: "none" | "slab" | "framed";
  ceilingLoadArea?: number;
  floorLoadArea?: number;
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
  knownFeet: number;
};

export type TakeoffFloor = {
  id: string;
  name: string;
  authoringMode: TakeoffAuthoringMode;
  designGrid: {
    width: number;
    depth: number;
  };
  scale: {
    feetPerGrid: number;
    gridSnapInches: number;
  };
  reference?: {
    filename: string;
    kind: "pdf" | "image";
    assetId?: number;
    storagePath?: string;
    mimeType?: string;
    sizeBytes?: number;
    downloadUrl?: string;
    signedUrl?: string;
    crop?: {
      x: number;
      y: number;
      width: number;
      depth: number;
    };
  };
  calibration: {
    lines: TakeoffScaleLine[];
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
  attributedSlices?: Array<{
    id: string;
    roomId: string;
    cells: Array<{ x: number; y: number; width: number; depth: number }>;
  }>;
};

export type TakeoffProject = {
  schemaVersion: "takeoff.v1";
  name: string;
  frontDoorFaces: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  componentSchedule?: TakeoffComponentDefinition[];
  floors: TakeoffFloor[];
};

export type TakeoffValidationIssue = {
  severity: "error" | "warning";
  message: string;
  target?: {
    type: "room" | "unassigned";
    roomId?: string;
    regionId?: string;
  };
};
