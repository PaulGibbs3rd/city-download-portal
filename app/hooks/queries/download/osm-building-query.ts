import Extent from "@arcgis/core/geometry/Extent.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import SpatialReference from "@arcgis/core/geometry/SpatialReference.js";
import { project } from "@arcgis/core/geometry/support/webMercatorUtils.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";

export interface OsmBuilding {
  id: string;
  footprint: Polygon;
  height: number;
  part?: boolean;
  minHeight?: number;
  roof?: OsmRoof;
}

export interface OsmRoof {
  shape: "gabled" | "hipped" | "pyramidal" | "skillion";
  height: number;
  angle: number;
  direction?: number;
  across: boolean;
  includedInHeight: boolean;
}

type OsmTags = Record<string, string | number | null | undefined>;

const replicaTags = {
  height: "height", "building:levels": "building_levels", min_height: "min_height",
  "building:min_level": "building_min_level", "roof:shape": "roof_shape", "roof:height": "roof_height",
  "roof:levels": "roof_levels", "roof:angle": "roof_angle", "roof:direction": "roof_direction",
  "roof:orientation": "roof_orientation",
};

const northAmericaBuildings = "https://services6.arcgis.com/Do88DoK2xjTUCXd1/ArcGIS/rest/services/OSM_NA_Buildings/FeatureServer/0";
const globalOverpass = "https://overpass.private.coffee/api/interpreter";
const maxSourceMeters = 1500;

interface OsmPoint { lat: number; lon: number }
interface OsmMember { type: "way" | "node" | "relation"; ref: number; role: string; geometry?: OsmPoint[] }
interface OsmElement {
  id: number;
  type: "way" | "relation";
  geometry?: OsmPoint[];
  members?: OsmMember[];
  tags?: Record<string, string>;
}

function meters(value?: string | number) {
  const text = String(value ?? "").trim();
  const feetAndInches = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/.exec(text);
  if (feetAndInches) return Number(feetAndInches[1]) * 0.3048 + Number(feetAndInches[2] ?? 0) * 0.0254;
  const scalar = /^(\d+(?:\.\d+)?)\s*(m|ft|feet)?$/i.exec(text);
  return scalar ? Number(scalar[1]) * (/^(ft|feet)$/i.test(scalar[2] ?? "") ? 0.3048 : 1) : 0;
}

export function osmBuildingHeight(height?: string | number, levels?: string | number) {
  const levelCount = Number(levels);
  return meters(height) || (Number.isFinite(levelCount) && levelCount > 0 ? levelCount * 3 : 8);
}

function positive(value: OsmTags[string]) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function roofDirection(value: OsmTags[string]) {
  if (value == null || String(value).trim() === "") return undefined;
  const directions = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const cardinal = directions.indexOf(String(value).trim().toUpperCase());
  if (cardinal >= 0) return cardinal * 22.5;
  const bearing = Number(value);
  return Number.isFinite(bearing) && bearing >= 0 && bearing <= 360 ? bearing : undefined;
}

export function readOsmBuildingTags(tags: OsmTags, detail = true): Omit<OsmBuilding, "id" | "footprint"> {
  const taggedHeight = meters(tags.height ?? undefined);
  const height = osmBuildingHeight(tags.height ?? undefined, tags["building:levels"] ?? undefined);
  if (!detail) return { height };

  const part = Boolean(tags["building:part"] && tags["building:part"] !== "no");
  const rawMinimum = meters(tags.min_height ?? undefined) || positive(tags["building:min_level"]) * 3;
  const total = taggedHeight ? height : Math.max(height, rawMinimum + 3);
  const minHeight = Math.min(rawMinimum, total - 0.1);
  const shape = tags["roof:shape"];
  if (shape !== "gabled" && shape !== "hipped" && shape !== "pyramidal" && shape !== "skillion") {
    return { height: total, part, minHeight };
  }

  const angle = positive(tags["roof:angle"]);
  return {
    height: total, part, minHeight,
    roof: {
      shape,
      height: meters(tags["roof:height"] ?? undefined) || positive(tags["roof:levels"]) * 3,
      angle: angle > 0 && angle < 90 ? angle : 30,
      direction: roofDirection(tags["roof:direction"]),
      across: tags["roof:orientation"] === "across",
      includedInHeight: taggedHeight > 0,
    },
  };
}

function samePoint(a: OsmPoint, b: OsmPoint) {
  return a.lat === b.lat && a.lon === b.lon;
}

function isNorthAmericanExtent(bounds: Extent) {
  return bounds.xmin >= -172 && bounds.xmax <= -49 && bounds.ymin >= 25 && bounds.ymax <= 83;
}

function overpassEndpoint(bounds: Extent) {
  // The regional Overpass instances use Geofabrik extracts. Use the global
  // endpoint for selections near continental boundaries or in other regions.
  if (isNorthAmericanExtent(bounds)) {
    return "https://ovp.dresel.systems/api-na/interpreter";
  }
  if (bounds.xmin >= -13 && bounds.xmax <= 40 && bounds.ymin >= 37 && bounds.ymax <= 72) {
    return "https://ovp.dresel.systems/api/interpreter";
  }
  if (bounds.xmin >= 68 && bounds.xmax <= 150 && bounds.ymin >= 5 && bounds.ymax <= 55) {
    return "https://ovp.dresel.systems/api-as/interpreter";
  }
  if (bounds.xmin >= -82 && bounds.xmax <= -34 && bounds.ymax <= 12 && bounds.ymin >= -57) {
    return "https://ovp.dresel.systems/api-sa/interpreter";
  }
  return globalOverpass;
}

function makeRings(members: OsmMember[], role: "outer" | "inner") {
  const pending = members
    .filter(member => member.type === "way" && (member.role === role || (role === "outer" && member.role === "")))
    .flatMap(member => member.geometry && member.geometry.length >= 2 ? [member.geometry.slice()] : []);
  const rings: OsmPoint[][] = [];
  while (pending.length) {
    const ring = pending.pop()!;
    while (!samePoint(ring[0], ring[ring.length - 1])) {
      const last = ring[ring.length - 1];
      const next = pending.findIndex(points => samePoint(last, points[0]) || samePoint(last, points[points.length - 1]));
      if (next === -1) break;
      const [points] = pending.splice(next, 1);
      if (!samePoint(last, points[0])) points.reverse();
      ring.push(...points.slice(1));
    }
    if (ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function orientedRing(points: OsmPoint[], clockwise: boolean) {
  if (points.length < 4 || !samePoint(points[0], points[points.length - 1])) return [];
  const ring = points.map(({ lon, lat }) => [lon, lat]);
  const [originX, originY] = ring[0];
  let signedArea = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = ring[i - 1];
    const [nextX, nextY] = ring[i];
    signedArea += (x - originX) * (nextY - originY) - (nextX - originX) * (y - originY);
  }
  if (!Number.isFinite(signedArea) || signedArea === 0) return [];
  return (signedArea < 0) === clockwise ? ring : ring.reverse();
}

export function readOverpassBuildings(elements: OsmElement[], detail = true): OsmBuilding[] {
  const buildings: OsmBuilding[] = [];
  const relationOuterWays = new Set<number>();
  for (const element of elements) {
    if (element.type !== "relation") continue;
    const members = element.members ?? [];
    const outer = makeRings(members, "outer").map(points => orientedRing(points, true)).filter(ring => ring.length);
    if (!outer.length) continue;
    const inner = makeRings(members, "inner").map(points => orientedRing(points, false)).filter(ring => ring.length);
    for (const member of members) {
      if (member.type === "way" && member.role !== "inner") relationOuterWays.add(member.ref);
    }
    buildings.push({
      id: `relation/${element.id}`,
      footprint: new Polygon({ spatialReference: SpatialReference.WGS84, rings: [...outer, ...inner] }),
      ...readOsmBuildingTags(element.tags ?? {}, detail),
    });
  }
  for (const element of elements) {
    if (element.type !== "way" || relationOuterWays.has(element.id)) continue;
    const ring = orientedRing(element.geometry ?? [], true);
    if (ring.length) buildings.push({
      id: `way/${element.id}`,
      footprint: new Polygon({ spatialReference: SpatialReference.WGS84, rings: [ring] }),
      ...readOsmBuildingTags(element.tags ?? {}, detail),
    });
  }
  return buildings;
}

export async function queryOsmBuildings(extent: Extent, signal: AbortSignal, detail = true) {
  const bounds = project(extent, SpatialReference.WGS84) as Extent | null;
  if (bounds == null || bounds.xmin < -180 || bounds.xmax > 180 || bounds.xmin >= bounds.xmax || bounds.ymin >= bounds.ymax) {
    throw new Error("Choose a selection within a single world wrap to download OpenStreetMap buildings.");
  }
  const lat = (bounds.ymin + bounds.ymax) / 2;
  if (bounds.height * 111320 > maxSourceMeters || bounds.width * 111320 * Math.cos(lat * Math.PI / 180) > maxSourceMeters) {
    throw new Error("Select an area under 1.5 km across to download OpenStreetMap buildings.");
  }

  // The replica has roof tags but separate building parts come from Overpass.
  if (isNorthAmericanExtent(bounds)) {
    const layer = new FeatureLayer({ url: northAmericaBuildings });
    try {
      await layer.load({ signal });
      const query = layer.createQuery();
      query.geometry = bounds;
      query.spatialRelationship = "intersects";
      query.where = "building <> 'no'";
      // Query the matching IDs first so the per-response record limit cannot cut the selection short.
      const ids = await layer.queryObjectIds(query, { signal });
      const pageSize = Math.min(layer.capabilities.query.maxRecordCount || 250, 250);
      const page = layer.createQuery();
      page.returnGeometry = true;
      page.outSpatialReference = SpatialReference.WGS84;
      page.outFields = detail ? ["osm_id", ...Object.values(replicaTags)] : ["osm_id", "height", "building_levels"];
      const buildings: OsmBuilding[] = [];
      for (let start = 0; start < ids.length; start += pageSize) {
        signal.throwIfAborted();
        page.objectIds = ids.slice(start, start + pageSize);
        const result = await layer.queryFeatures(page, { signal });
        if (result.exceededTransferLimit) {
          throw new Error("The building service returned an incomplete page. Retry or select a smaller area.");
        }
        for (const feature of result.features) {
          if (feature.geometry?.type !== "polygon") continue;
          buildings.push({
            id: String(feature.attributes.osm_id ?? feature.getObjectId()),
            footprint: feature.geometry as Polygon,
            ...readOsmBuildingTags(Object.fromEntries(
              Object.entries(replicaTags).map(([tag, field]) => [tag, feature.attributes[field]])
            ), detail),
          });
        }
      }
      if (!detail) return { buildings };
      try {
        const parts = await queryOverpass(bounds, signal, "parts");
        return { buildings: [...buildings, ...parts] };
      } catch {
        signal.throwIfAborted();
        return { buildings, partsUnavailable: true };
      }
    } finally {
      layer.destroy();
    }
  }

  return { buildings: await queryOverpass(bounds, signal, detail ? "all" : "outlines") };
}

async function queryOverpass(bounds: Extent, signal: AbortSignal, mode: "parts" | "all" | "outlines") {
  const bbox = [bounds.ymin, bounds.xmin, bounds.ymax, bounds.xmax].map(value => value.toFixed(7)).join(",");
  const tags = mode === "all" ? ["building", "building:part"] : [mode === "parts" ? "building:part" : "building"];
  const selectors = tags.map(tag => {
    const filter = `["${tag}"]["${tag}"!="no"](${bbox});`;
    return `way${filter}relation["type"="multipolygon"]${filter}`;
  });
  const query = `[out:json][timeout:18];(${selectors.join("")});out geom;`;
  const response = await fetch(`${overpassEndpoint(bounds)}?${new URLSearchParams({ data: query })}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  }).catch(() => {
    signal.throwIfAborted();
    throw new Error("OpenStreetMap building data is temporarily unavailable. Retry this selection.");
  });
  if (!response.ok) throw new Error("OpenStreetMap building data is temporarily unavailable. Retry this selection.");
  const data = await response.json() as { elements?: OsmElement[]; remark?: string };
  if (!data.elements || data.remark) throw new Error("OpenStreetMap returned an incomplete response. Retry this selection.");
  return readOverpassBuildings(data.elements, mode !== "outlines");
}
