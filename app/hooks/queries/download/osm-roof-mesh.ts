import MeshVertexAttributes from "@arcgis/core/geometry/support/MeshVertexAttributes.js";
import type Mesh from "@arcgis/core/geometry/Mesh.js";
import { clipMeshToFootprint, getMeshPerimeter } from "./clip-footprint-mesh";
import type { ExportFootprint } from "./hexagon-footprint";
import type { OsmBuilding } from "./osm-building-query";

interface HeightPlane { x: number; y: number; offset: number }

function roofAxes(rings: number[][][], direction: number | undefined, across: boolean) {
  if (direction !== undefined) {
    const angle = direction * Math.PI / 180;
    return { ux: Math.cos(angle), uy: -Math.sin(angle) };
  }
  let ux = 1;
  let uy = 0;
  let longest = 0;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const x = ring[i][0] - ring[i - 1][0];
      const y = ring[i][1] - ring[i - 1][1];
      const length = Math.hypot(x, y);
      if (length > longest) {
        longest = length;
        ux = x / length;
        uy = y / length;
      }
    }
  }
  return across ? { ux: -uy, uy: ux } : { ux, uy };
}

function roofPlanes(rings: number[][][], roof: NonNullable<OsmBuilding["roof"]>, tolerance: number) {
  const { ux, uy } = roofAxes(rings, roof.direction, roof.across);
  const vx = -uy;
  const vy = ux;
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const u = x * ux + y * uy;
      const v = x * vx + y * vy;
      uMin = Math.min(uMin, u);
      uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
  }
  const halfU = (uMax - uMin) / 2;
  const halfV = (vMax - vMin) / 2;
  if (!(halfU > tolerance && halfV > tolerance)) return null;
  const pitchRun = roof.shape === "skillion" ? halfV * 2
    : roof.shape === "gabled" ? halfV : Math.min(halfU, halfV);
  const rise = roof.height || Math.tan(roof.angle * Math.PI / 180) * pitchRun;
  const uRun = roof.shape === "hipped" ? pitchRun : halfU;
  const vRun = roof.shape === "hipped" ? pitchRun : halfV;
  const slopes = (x: number, y: number, min: number, max: number, run: number): HeightPlane[] => [
    { x: x / run, y: y / run, offset: -min / run },
    { x: -x / run, y: -y / run, offset: max / run },
  ];
  const planes = roof.shape === "skillion" ? slopes(vx, vy, vMin, vMax, pitchRun).slice(1)
    : roof.shape === "gabled" ? slopes(vx, vy, vMin, vMax, vRun)
      : [...slopes(ux, uy, uMin, uMax, uRun), ...slopes(vx, vy, vMin, vMax, vRun)];
  return { planes, rise };
}

function perimeterLength(mesh: Mesh) {
  const perimeter = getMeshPerimeter(mesh, () => new Error("The roof could not be joined along its ridges."));
  const position = mesh.vertexAttributes.position;
  return perimeter.reduce((sum, [a, b]) =>
    sum + Math.hypot(position[a * 3] - position[b * 3], position[a * 3 + 1] - position[b * 3 + 1]), 0);
}

export function createDetailedOsmRoof(
  surface: Mesh, rings: number[][][], building: OsmBuilding, grade: number, footprint: ExportFootprint, signal?: AbortSignal,
) {
  const roof = building.roof;
  if (!roof) return null;
  const tolerance = footprint.tolerance;
  const profile = roofPlanes(rings, roof, tolerance);
  if (!profile || !Number.isFinite(profile.rise) || profile.rise <= 0) return null;
  const { planes } = profile;
  const rise = roof.includedInHeight
    ? Math.min(profile.rise, building.height - (building.minHeight ?? 0) - 0.05)
    : profile.rise;
  const eave = grade + building.height - (roof.includedInHeight ? rise : 0);
  const vertices: number[] = [];
  const faces: number[] = [];
  const vertexIndex = new Map<string, number>();

  for (const plane of planes) {
    // Each roof face is where its height is the lowest of all slope equations.
    const boundaries = planes.filter(other => other !== plane).map(other => {
      const x = other.x - plane.x;
      const y = other.y - plane.y;
      const length = Math.hypot(x, y);
      return { x: x / length, y: y / length, offset: (other.offset - plane.offset) / length };
    });
    const patch = clipMeshToFootprint(surface, { ...footprint, planes: boundaries }, true, signal);
    if (!patch) continue;
    const coordinates = patch.vertexAttributes.position;
    const indices: number[] = [];
    for (let i = 0; i < coordinates.length; i += 3) {
      const x = coordinates[i];
      const y = coordinates[i + 1];
      const key = `${Math.round(x / tolerance)}:${Math.round(y / tolerance)}`;
      let index = vertexIndex.get(key);
      if (index === undefined) {
        index = vertices.length / 3;
        vertexIndex.set(key, index);
        const fraction = Math.max(0, Math.min(1, plane.x * x + plane.y * y + plane.offset));
        vertices.push(x, y, eave + rise * fraction);
      }
      indices.push(index);
    }
    for (const { faces: triangles } of patch.components ?? []) {
      for (let i = 0; triangles && i < triangles.length; i += 3) {
        const [a, b, c] = [indices[triangles[i]], indices[triangles[i + 1]], indices[triangles[i + 2]]];
        if (a !== b && b !== c && a !== c) faces.push(a, b, c);
      }
    }
  }

  if (!faces.length) return null;
  const component = surface.components![0].clone();
  component.faces = Uint32Array.from(faces);
  const detailed = surface.clone();
  detailed.components = [component];
  detailed.vertexAttributes = new MeshVertexAttributes({ position: Float64Array.from(vertices) });
  try {
    // A crack or T-junction along a ridge adds perimeter inside the footprint.
    if (Math.abs(perimeterLength(detailed) - perimeterLength(surface)) <= tolerance * vertices.length) return detailed;
  } catch {
    // Keep the footprint printable with a flat cap if its mapped geometry cannot be joined.
  }
  return null;
}
