export type TakeoffAuthoringMode = "pdf_trace" | "image_trace" | "grid_manual";

export type TakeoffPoint = {
  x: number;
  y: number;
};

export type TakeoffRectRoom = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  ceilingHeight: number;
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
  };
  conditionedPerimeter: {
    width: number;
    depth: number;
  };
  exteriorPolygon: TakeoffPoint[];
  perimeterLocked: boolean;
  rooms: TakeoffRectRoom[];
};

export type TakeoffProject = {
  schemaVersion: "takeoff.v1";
  name: string;
  frontDoorFaces: "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";
  floors: TakeoffFloor[];
};

export type TakeoffValidationIssue = {
  severity: "error" | "warning";
  message: string;
};
