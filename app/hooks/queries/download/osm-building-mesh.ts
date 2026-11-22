import Mesh from "@arcgis/core/geometry/Mesh.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { createElevationSampler, createFromPolygon } from "@arcgis/core/geometry/support/meshUtils.js";
import MeshMaterial from "@arcgis/core/geometry/support/MeshMaterial.js";
import MeshVertexAttributes from "@arcgis/core/geometry/support/MeshVertexAttributes.js";
import { intersectionExecute } from "@arcgis/core/geometry/operators/intersectionOperator.js";
import { differenceExecute } from "@arcgis/core/geometry/operators/differenceOperator.js";
import { unionExecuteMany } from "@arcgis/core/geometry/operators/unionOperator.js";
import { ExportColors } from "~/symbology/symbology";
import { meshInFootprintSpace, type ExportFootprint } from "./hexagon-footprint";
import { extrudeMeshSurface, getMeshPerimeter } from "./clip-footprint-mesh";
import type { OsmBuilding } from "./osm-building-query";
import { createDetailedOsmRoof } from "./osm-roof-mesh";

export async function createOsmBuildingMeshes(
  buildings: OsmBuilding[],
  footprint: ExportFootprint,
  sampledTerrain: Mesh,
  signal?: AbortSignal,
) {
  if (buildings.length === 0) return [];

  // All XY coordinates in this plane are already local meters. The projected SR
  // lets the planar operators and elevation sampler consume those coordinates.
  const planar = SpatialReference.WebMercator;
  const clockwise = [...footprint.corners].reverse();
  const mask = new Polygon({ spatialReference: planar, rings: [[...clockwise, clockwise[0]]] });
  const terrain = new Mesh({
    spatialReference: planar,
    vertexAttributes: sampledTerrain.vertexAttributes,
    components: sampledTerrain.components,
  });
  const elevation = await createElevationSampler(terrain);
  const meshes: Mesh[] = [];
  const material = new MeshMaterial({ color: ExportColors.feature() });

  const footprints: { building: OsmBuilding; polygon: Polygon; clipped: Polygon }[] = [];
  for (const building of buildings) {
    signal?.throwIfAborted();
    const rings = building.footprint.rings;
    const input = new Mesh({
      spatialReference: building.footprint.spatialReference,
      vertexAttributes: new MeshVertexAttributes({
        position: Float64Array.from(rings.flatMap(ring => ring.flatMap(([x, y]) => [x, y, 0]))),
      }),
    });
    const local = (await meshInFootprintSpace(input, footprint, signal)).vertexAttributes.position;
    let offset = 0;
    const polygon = new Polygon({
      spatialReference: planar,
      rings: rings.map(ring => ring.map(() => {
        const xy = [local[offset], local[offset + 1]];
        offset += 3;
        return xy;
      })),
    });

    // Keep the full footprint for roof placement and cut its triangles to the export boundary.
    const clipped = intersectionExecute(polygon, mask);
    if (clipped?.type === "polygon") footprints.push({ building, polygon, clipped: clipped as Polygon });
  }

  const groundParts = footprints.filter(({ building }) => building.part && !building.minHeight).map(({ clipped }) => clipped);
  const groundCoverage = groundParts.length ? unionExecuteMany(groundParts) : null;
  const outlines = footprints.filter(({ building }) => !building.part).map(({ polygon }) => {
    const extent = polygon.extent!;
    return { polygon, area: extent.width * extent.height };
  }).sort((a, b) => a.area - b.area);
  for (const { building, polygon, clipped } of footprints) {
    signal?.throwIfAborted();
    // Preserve the uncovered outline and let ground-level parts define their own building volumes.
    const floor = !building.part && groundCoverage ? differenceExecute(clipped, groundCoverage) : clipped;
    if (floor?.type !== "polygon") continue;
    const roof = await createFromPolygon(floor as Polygon);
    const positions = roof?.vertexAttributes.position;
    if (!positions?.length || !roof.components?.length) continue;

    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
      const z = elevation.elevationAt(positions[index], positions[index + 1]);
      if (z != null && Number.isFinite(z)) {
        lowest = Math.min(lowest, z);
        highest = Math.max(highest, z);
      }
    }
    if (!Number.isFinite(lowest)) continue;

    // Parts of one building share a datum. Sampling each footprint independently on a
    // slope can separate a raised piece from an adjoining part with the same tagged height.
    const center = building.part ? polygon.centroid : null;
    const parent = center ? outlines.find(outline => outline.polygon.contains(center)) : undefined;
    const parentCenter = parent?.polygon.centroid;
    const sharedGrade = parentCenter ? elevation.elevationAt(parentCenter.x, parentCenter.y) : undefined;
    const grade = sharedGrade != null && Number.isFinite(sharedGrade) ? sharedGrade : highest;
    const top = positions.slice();
    for (let index = 2; index < top.length; index += 3) top[index] = grade + building.height;
    const name = `OpenStreetMap building ${building.id}`;
    const components = roof.components.map(component => {
      const faces = component.faces ?? [];
      const upwards: number[] = [];
      for (let index = 0; index < faces.length; index += 3) {
        const [a, b, c] = [faces[index], faces[index + 1], faces[index + 2]];
        const ax = top[a * 3], ay = top[a * 3 + 1];
        const winding = (top[b * 3] - ax) * (top[c * 3 + 1] - ay) - (top[b * 3 + 1] - ay) * (top[c * 3] - ax);
        if (winding > 0) upwards.push(a, b, c);
        else if (winding < 0) upwards.push(a, c, b);
      }
      return { faces: Uint32Array.from(upwards), material, shading: "flat" as const, name };
    }).filter(component => component.faces.length);
    if (!components.length) continue;

    const flat = new Mesh({
      spatialReference: sampledTerrain.spatialReference,
      vertexSpace: sampledTerrain.vertexSpace,
      vertexAttributes: new MeshVertexAttributes({ position: top }),
      components,
    });
    const surface = createDetailedOsmRoof(flat, polygon.rings, building, grade, footprint, signal) ?? flat;
    const perimeter = getMeshPerimeter(surface, () => new Error(`Could not close the footprint for ${name}.`));
    if (!perimeter.length) continue;
    // Ground floors extend into terrain. Raised parts retain their mapped clearance.
    const bottom = building.minHeight ? grade + building.minHeight : Math.min(grade, lowest) - 0.25;
    meshes.push(extrudeMeshSurface(surface, perimeter, bottom, `${name} walls`));
  }

  return meshes;
}
