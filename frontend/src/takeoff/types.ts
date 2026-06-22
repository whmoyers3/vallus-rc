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
  direction?: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  label?: string;
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
};
