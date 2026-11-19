export type NodeRole = "cell" | "button" | "menu" | "toolbar" | "input" | "window" | "unknown";

const ROLES: Record<string, true> = {
  cell: true,
  button: true,
  menu: true,
  toolbar: true,
  input: true,
  window: true,
  unknown: true,
};

export interface StateNode {
  id: string;
  role: NodeRole;
  name: string;
  value: string;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  visible: boolean;
}

export interface AppFacts {
  documentPath: string | null;
  dirty: boolean;
  focusedNodeId: string | null;
}

export interface AppState {
  stateVersion: number;
  capturedAt: string;
  facts: AppFacts;
  nodes: StateNode[];
}

export function serializeState(state: AppState): string {
  return JSON.stringify(state);
}

export function deserializeState(json: string): AppState {
  return parseAppState(JSON.parse(json));
}

function fail(what: string): never {
  throw new Error(`invalid AppState: ${what}`);
}

export function parseAppState(raw: unknown): AppState {
  if (typeof raw !== "object" || raw === null) fail("not an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.stateVersion !== "number" || !Number.isInteger(r.stateVersion) || r.stateVersion < 0)
    fail("stateVersion must be a non-negative integer");
  if (typeof r.capturedAt !== "string") fail("capturedAt must be a string");
  const facts = r.facts;
  if (typeof facts !== "object" || facts === null) fail("facts must be an object");
  const f = facts as Record<string, unknown>;
  if (f.documentPath !== null && typeof f.documentPath !== "string") fail("facts.documentPath");
  if (typeof f.dirty !== "boolean") fail("facts.dirty");
  if (f.focusedNodeId !== null && typeof f.focusedNodeId !== "string") fail("facts.focusedNodeId");
  if (!Array.isArray(r.nodes)) fail("nodes must be an array");
  const nodes = r.nodes.map(parseStateNode);
  return {
    stateVersion: r.stateVersion,
    capturedAt: r.capturedAt,
    facts: {
      documentPath: f.documentPath as string | null,
      dirty: f.dirty as boolean,
      focusedNodeId: f.focusedNodeId as string | null,
    },
    nodes,
  };
}

function parseStateNode(raw: unknown): StateNode {
  if (typeof raw !== "object" || raw === null) fail("node must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of ["id", "role", "name", "value"] as const) {
    if (typeof r[k] !== "string") fail(`node.${k} must be a string`);
  }
  if (typeof r.enabled !== "boolean" || typeof r.visible !== "boolean") fail("node flags");
  const b = r.bounds;
  if (typeof b !== "object" || b === null) fail("node.bounds");
  const bb = b as Record<string, unknown>;
  for (const k of ["x", "y", "width", "height"] as const) {
    if (typeof bb[k] !== "number" || !Number.isFinite(bb[k])) fail(`node.bounds.${k}`);
  }
  const role = r.role as string;
  if (!ROLES[role]) fail(`unknown role ${role}`);
  return {
    id: r.id as string,
    role: role as NodeRole,
    name: r.name as string,
    value: r.value as string,
    bounds: {
      x: bb.x as number,
      y: bb.y as number,
      width: bb.width as number,
      height: bb.height as number,
    },
    enabled: r.enabled as boolean,
    visible: r.visible as boolean,
  };
}

export function findNode(state: AppState, id: string): StateNode | undefined {
  return state.nodes.find((n) => n.id === id);
}
