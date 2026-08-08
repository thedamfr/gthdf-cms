import {
  distanceWgs84Metres,
  hashCanonical,
  projectPointOnSegment,
  sha256Hex,
  type GpxDocument,
  type GpxPoint,
} from './catalogue-core';

type LinearRing = number[][];
type PolygonCoordinates = LinearRing[];

export type AdministrativeGeometry =
  | { type: 'Polygon'; coordinates: PolygonCoordinates }
  | { type: 'MultiPolygon'; coordinates: PolygonCoordinates[] };

export type BoundarySnapshotFeature = {
  municipalityKey: string;
  geometry: AdministrativeGeometry;
  source?: string;
  sourceDate?: string;
  license?: string;
  sourceSha256?: string;
};

export type BoundarySnapshot = {
  version: 1;
  manifestHash: string;
  hashMode?: 'canonical' | 'file_sha256';
  sources?: unknown[];
  features: BoundarySnapshotFeature[];
};

function ringsForGeometry(geometry: AdministrativeGeometry): PolygonCoordinates[] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error('La géométrie administrative doit être Polygon ou MultiPolygon.');
}

function pointInRing(longitude: number, latitude: number, ring: LinearRing): boolean {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current, current += 1) {
    const first = ring[current];
    const second = ring[previous];
    if (!first || !second || first.length < 2 || second.length < 2) continue;
    const intersects = (first[1] > latitude) !== (second[1] > latitude)
      && longitude < (second[0] - first[0]) * (latitude - first[1])
        / ((second[1] - first[1]) || Number.EPSILON) + first[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnRingBoundary(longitude: number, latitude: number, ring: LinearRing): boolean {
  const point = [longitude, latitude];
  for (let index = 1; index < ring.length; index += 1) {
    if (Math.abs(orientation(ring[index - 1], point, ring[index])) <= 1e-12
      && onSegment(ring[index - 1], point, ring[index])) return true;
  }
  return false;
}

export function pointInAdministrativeGeometry(
  point: Pick<GpxPoint, 'latitude' | 'longitude'>,
  geometry: AdministrativeGeometry,
): boolean {
  return ringsForGeometry(geometry).some((polygon) => {
    if (polygon.some((ring) => pointOnRingBoundary(point.longitude, point.latitude, ring))) return true;
    if (!polygon[0] || !pointInRing(point.longitude, point.latitude, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(point.longitude, point.latitude, hole));
  });
}

function orientation(a: number[], b: number[], c: number[]): number {
  return (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
}

function onSegment(a: number[], b: number[], c: number[]): boolean {
  return b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0])
    && b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);
}

function segmentsIntersect(a: number[], b: number[], c: number[], d: number[]): boolean {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  if ((first > 0) !== (second > 0) && (third > 0) !== (fourth > 0)) return true;
  const tolerance = 1e-12;
  return (Math.abs(first) <= tolerance && onSegment(a, c, b))
    || (Math.abs(second) <= tolerance && onSegment(a, d, b))
    || (Math.abs(third) <= tolerance && onSegment(c, a, d))
    || (Math.abs(fourth) <= tolerance && onSegment(c, b, d));
}

function edgePoint(first: GpxPoint, second: GpxPoint, fraction: number): GpxPoint {
  return {
    latitude: first.latitude + (second.latitude - first.latitude) * fraction,
    longitude: first.longitude + (second.longitude - first.longitude) * fraction,
  };
}

function intersectionFractions(a: number[], b: number[], c: number[], d: number[]): number[] {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const cross = rx * sy - ry * sx;
  const qpx = c[0] - a[0];
  const qpy = c[1] - a[1];
  if (Math.abs(cross) <= 1e-15) {
    if (Math.abs(qpx * ry - qpy * rx) > 1e-12) return [];
    const squared = rx * rx + ry * ry;
    if (squared === 0) return [];
    return [
      (qpx * rx + qpy * ry) / squared,
      ((d[0] - a[0]) * rx + (d[1] - a[1]) * ry) / squared,
    ].filter((fraction) => fraction >= 0 && fraction <= 1);
  }
  const fraction = (qpx * sy - qpy * sx) / cross;
  const otherFraction = (qpx * ry - qpy * rx) / cross;
  return fraction >= -1e-12 && fraction <= 1 + 1e-12
    && otherFraction >= -1e-12 && otherFraction <= 1 + 1e-12
    ? [Math.max(0, Math.min(1, fraction))]
    : [];
}

function edgeFractionsInsideGeometry(
  first: GpxPoint,
  second: GpxPoint,
  geometry: AdministrativeGeometry,
): Array<{ startFraction: number; endFraction: number }> {
  const edgeStart = [first.longitude, first.latitude];
  const edgeEnd = [second.longitude, second.latitude];
  const fractions = [0, 1];
  for (const polygon of ringsForGeometry(geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        fractions.push(...intersectionFractions(edgeStart, edgeEnd, ring[index - 1], ring[index]));
      }
    }
  }
  const unique = [...new Set(fractions.map((fraction) => Math.round(fraction * 1e12) / 1e12))]
    .sort((firstFraction, secondFraction) => firstFraction - secondFraction);
  const portions: Array<{ startFraction: number; endFraction: number }> = [];
  for (let index = 0; index < unique.length - 1; index += 1) {
    const startFraction = unique[index];
    const endFraction = unique[index + 1];
    if (endFraction - startFraction <= 1e-12) continue;
    const midpoint = edgePoint(first, second, (startFraction + endFraction) / 2);
    if (pointInAdministrativeGeometry(midpoint, geometry)) portions.push({ startFraction, endFraction });
  }
  return portions;
}

type BoundaryRouteSegment = {
  index: number;
  sourceSha256: string;
  document: GpxDocument;
  chainageOffsetMetres: number;
  breakBefore: boolean;
};

type TraceEdge = {
  routeSegmentIndex: number;
  sourceSha256: string;
  trackIndex: number;
  segmentIndex: number;
  pointIndex: number;
  first: GpxPoint;
  second: GpxPoint;
  chainageMetres: number;
  lengthMetres: number;
  breakBefore: boolean;
};

type TracePortion = {
  edge: TraceEdge;
  startFraction: number;
  endFraction: number;
};

export type BoundaryPrimaryAnchor = {
  routeSegmentIndex: number;
  sourceSha256: string;
  trackIndex: number;
  segmentIndex: number;
  pointIndex: number;
  fraction: number;
  chainageMetres: number;
  projectedLatitude: number;
  projectedLongitude: number;
  distanceToTraceMetres: number;
};

function flattenTraceEdges(routeSegments: readonly BoundaryRouteSegment[]): TraceEdge[] {
  const edges: TraceEdge[] = [];
  for (const routeSegment of routeSegments) {
    let localChainage = 0;
    let firstEdgeOfRouteSegment = true;
    for (const track of routeSegment.document.tracks) {
      for (const segment of track.segments) {
        for (let pointIndex = 0; pointIndex < segment.points.length - 1; pointIndex += 1) {
          const first = segment.points[pointIndex];
          const second = segment.points[pointIndex + 1];
          const lengthMetres = distanceWgs84Metres(first, second);
          edges.push({
            routeSegmentIndex: routeSegment.index,
            sourceSha256: routeSegment.sourceSha256,
            trackIndex: track.trackIndex,
            segmentIndex: segment.segmentIndex,
            pointIndex,
            first,
            second,
            chainageMetres: routeSegment.chainageOffsetMetres + localChainage,
            lengthMetres,
            breakBefore: firstEdgeOfRouteSegment ? routeSegment.breakBefore : pointIndex === 0,
          });
          firstEdgeOfRouteSegment = false;
          localChainage += lengthMetres;
        }
      }
    }
  }
  return edges;
}

export function proposeBoundaryAnchors(input: {
  cityPoint: Pick<GpxPoint, 'latitude' | 'longitude'>;
  expectedOccurrences: number;
  routeSegments: readonly BoundaryRouteSegment[];
  geometry: AdministrativeGeometry;
  firstOccurrenceHint?: {
    routeSegmentIndex: number;
    chainageMetres: number;
    toleranceMetres?: number;
  };
  primaryAnchors?: readonly BoundaryPrimaryAnchor[];
  initialAmbiguityReasons?: readonly string[];
}): {
  status: 'proposed' | 'ambiguous';
  ambiguityReasons: string[];
  occurrences: Array<{
    occurrenceIndex: number;
    sourceSegmentIndex: number;
    sourceHash: string;
    trackIndex: number;
    segmentIndex: number;
    pointIndex: number;
    sourceFraction: number;
    chainageMetres: number;
    projectedLatitude: number;
    projectedLongitude: number;
    distanceToTraceMetres: number;
    selectionOrigin: 'computed' | 'prd03_primary';
  }>;
} {
  if (!Number.isSafeInteger(input.expectedOccurrences) || input.expectedOccurrences < 1) {
    throw new Error('Le nombre attendu d’occurrences est invalide.');
  }
  const edges = flattenTraceEdges(input.routeSegments);
  const runs: TracePortion[][] = [];
  let current: TracePortion[] = [];
  const flush = () => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  for (const edge of edges) {
    if (edge.breakBefore) flush();
    const portions = edgeFractionsInsideGeometry(edge.first, edge.second, input.geometry);
    if (portions.length === 0) {
      flush();
      continue;
    }
    portions.forEach((portion, portionIndex) => {
      if (portionIndex > 0 || (current.length > 0 && portion.startFraction > 1e-12)) flush();
      current.push({ edge, ...portion });
      if (portion.endFraction < 1 - 1e-12) flush();
    });
  }
  flush();

  const ambiguityReasons: string[] = [...(input.initialAmbiguityReasons ?? [])];
  const primaryByRun = new Map<number, BoundaryPrimaryAnchor[]>();
  for (const primary of input.primaryAnchors ?? []) {
    const matches = runs.map((run, runIndex) => ({ run, runIndex })).filter(({ run }) => run.some((portion) => (
      portion.edge.routeSegmentIndex === primary.routeSegmentIndex
      && portion.edge.sourceSha256.toLowerCase() === primary.sourceSha256.toLowerCase()
      && portion.edge.trackIndex === primary.trackIndex
      && portion.edge.segmentIndex === primary.segmentIndex
      && portion.edge.pointIndex === primary.pointIndex
      && primary.fraction >= portion.startFraction - 1e-12
      && primary.fraction <= portion.endFraction + 1e-12
      && pointInAdministrativeGeometry({
        latitude: primary.projectedLatitude,
        longitude: primary.projectedLongitude,
      }, input.geometry)
    )));
    if (matches.length !== 1) {
      ambiguityReasons.push(`Ancre PRD03 à ${primary.chainageMetres} m rapprochée de ${matches.length} passage(s) administratif(s).`);
      continue;
    }
    const values = primaryByRun.get(matches[0].runIndex) ?? [];
    values.push(primary);
    primaryByRun.set(matches[0].runIndex, values);
  }

  const occurrences = runs.map((run, runIndex) => {
    const candidates = run.map((portion) => {
      const first = edgePoint(portion.edge.first, portion.edge.second, portion.startFraction);
      const second = edgePoint(portion.edge.first, portion.edge.second, portion.endFraction);
      const clippedProjection = projectPointOnSegment(input.cityPoint, first, second);
      const fraction = portion.startFraction
        + (portion.endFraction - portion.startFraction) * clippedProjection.fraction;
      return {
        portion,
        fraction,
        projection: {
          point: edgePoint(portion.edge.first, portion.edge.second, fraction),
          distanceMetres: clippedProjection.distanceMetres,
        },
        chainageMetres: portion.edge.chainageMetres + portion.edge.lengthMetres * fraction,
      };
    }).sort((first, second) => (
      first.projection.distanceMetres - second.projection.distanceMetres
      || first.chainageMetres - second.chainageMetres
    ));
    const primaries = primaryByRun.get(runIndex) ?? [];
    if (primaries.length > 1) ambiguityReasons.push(`Le passage ${runIndex + 1} correspond à plusieurs ancres PRD03.`);
    let selected = candidates[0];
    let selectedPrimary = primaries.length === 1 ? primaries[0] : null;
    if (!selectedPrimary && input.firstOccurrenceHint && runIndex === 0) {
      const hinted = candidates.filter((candidate) => (
        candidate.portion.edge.routeSegmentIndex === input.firstOccurrenceHint!.routeSegmentIndex
      )).sort((first, second) => (
        Math.abs(first.chainageMetres - input.firstOccurrenceHint!.chainageMetres)
        - Math.abs(second.chainageMetres - input.firstOccurrenceHint!.chainageMetres)
        || first.projection.distanceMetres - second.projection.distanceMetres
      ));
      if (hinted[0]) selected = hinted[0];
    }
    if (!selectedPrimary && candidates.some((candidate) => (
      candidate !== selected
      && candidate.projection.distanceMetres <= selected.projection.distanceMetres + 1
      && Math.abs(candidate.chainageMetres - selected.chainageMetres) >= 10
    ))) ambiguityReasons.push(`Le passage ${runIndex + 1} possède des projections concurrentes à moins de 1 m.`);
    for (let firstIndex = 0; firstIndex < run.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 2; secondIndex < run.length; secondIndex += 1) {
        const first = run[firstIndex];
        const second = run[secondIndex];
        if (segmentsIntersect(
          [edgePoint(first.edge.first, first.edge.second, first.startFraction).longitude, edgePoint(first.edge.first, first.edge.second, first.startFraction).latitude],
          [edgePoint(first.edge.first, first.edge.second, first.endFraction).longitude, edgePoint(first.edge.first, first.edge.second, first.endFraction).latitude],
          [edgePoint(second.edge.first, second.edge.second, second.startFraction).longitude, edgePoint(second.edge.first, second.edge.second, second.startFraction).latitude],
          [edgePoint(second.edge.first, second.edge.second, second.endFraction).longitude, edgePoint(second.edge.first, second.edge.second, second.endFraction).latitude],
        )) ambiguityReasons.push(`Le passage ${runIndex + 1} contient un croisement ou lacet non univoque.`);
      }
    }
    const edge = selected.portion.edge;
    return {
      occurrenceIndex: runIndex,
      sourceSegmentIndex: selectedPrimary?.routeSegmentIndex ?? edge.routeSegmentIndex,
      sourceHash: selectedPrimary?.sourceSha256 ?? edge.sourceSha256,
      trackIndex: selectedPrimary?.trackIndex ?? edge.trackIndex,
      segmentIndex: selectedPrimary?.segmentIndex ?? edge.segmentIndex,
      pointIndex: selectedPrimary?.pointIndex ?? edge.pointIndex,
      sourceFraction: selectedPrimary?.fraction ?? selected.fraction,
      chainageMetres: selectedPrimary?.chainageMetres ?? selected.chainageMetres,
      projectedLatitude: selectedPrimary?.projectedLatitude ?? selected.projection.point.latitude,
      projectedLongitude: selectedPrimary?.projectedLongitude ?? selected.projection.point.longitude,
      distanceToTraceMetres: selectedPrimary?.distanceToTraceMetres ?? selected.projection.distanceMetres,
      selectionOrigin: selectedPrimary ? 'prd03_primary' as const : 'computed' as const,
    };
  }).sort((first, second) => first.chainageMetres - second.chainageMetres)
    .map((occurrence, occurrenceIndex) => ({ ...occurrence, occurrenceIndex }));
  if (occurrences.length !== input.expectedOccurrences) {
    ambiguityReasons.push(`${input.expectedOccurrences} occurrence(s) attendue(s), ${occurrences.length} calculée(s).`);
  }
  if (input.firstOccurrenceHint && occurrences[0]) {
    const tolerance = input.firstOccurrenceHint.toleranceMetres ?? 10;
    if (occurrences[0].sourceSegmentIndex !== input.firstOccurrenceHint.routeSegmentIndex) {
      ambiguityReasons.push('Le premier chapitre diverge du XLSX contrôlé.');
    }
    if (Math.abs(occurrences[0].chainageMetres - input.firstOccurrenceHint.chainageMetres) > tolerance) {
      ambiguityReasons.push(`Le premier chaînage diverge du XLSX de plus de ${tolerance} m.`);
    }
  }
  return {
    status: ambiguityReasons.length === 0 ? 'proposed' : 'ambiguous',
    ambiguityReasons: [...new Set(ambiguityReasons)],
    occurrences,
  };
}

export function validateBoundarySnapshot(
  snapshot: BoundarySnapshot,
  requiredMunicipalityKeys: readonly string[],
): void {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.features)) {
    throw new Error('Le snapshot administratif doit utiliser le format version 1.');
  }
  const seen = new Set<string>();
  for (const feature of snapshot.features) {
    if (typeof feature.municipalityKey !== 'string' || !feature.municipalityKey.trim()) {
      throw new Error('Un snapshot administratif contient une municipalityKey invalide.');
    }
    if (seen.has(feature.municipalityKey)) throw new Error(`La commune ${feature.municipalityKey} est dupliquée dans le snapshot.`);
    seen.add(feature.municipalityKey);
    ringsForGeometry(feature.geometry);
  }
  const missing = [...new Set(requiredMunicipalityKeys)].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(`Snapshot administratif incomplet : ${missing.length} commune(s) absente(s), dont ${missing.slice(0, 10).join(', ')}.`);
  }
  if (!/^[a-f0-9]{64}$/i.test(snapshot.manifestHash)) throw new Error('Le manifestHash du snapshot est invalide.');
  if (snapshot.hashMode !== 'file_sha256') {
    const computedHash = hashCanonical({
      version: snapshot.version,
      sources: snapshot.sources ?? [],
      features: snapshot.features,
    });
    if (computedHash !== snapshot.manifestHash) throw new Error('Le manifestHash du snapshot ne correspond pas à son contenu canonique.');
  }
}

export function parseVersionedBoundarySnapshot(
  geoJsonText: string,
  manifestText: string,
  requiredMunicipalityKeys: readonly string[],
): BoundarySnapshot {
  const manifest = JSON.parse(manifestText) as Record<string, any>;
  const expectedHash = manifest?.snapshot?.sha256;
  const expectedBytes = manifest?.snapshot?.bytes;
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? '')) {
    throw new Error('Le manifeste des limites ne contient pas de SHA-256 valide.');
  }
  const actualBytes = new TextEncoder().encode(geoJsonText).byteLength;
  if (sha256Hex(geoJsonText) !== expectedHash || actualBytes !== expectedBytes) {
    throw new Error('Les octets du snapshot administratif ne correspondent pas à son manifeste.');
  }
  const geoJson = JSON.parse(geoJsonText) as Record<string, any>;
  if (geoJson.type !== 'FeatureCollection' || !Array.isArray(geoJson.features)) {
    throw new Error('Le snapshot administratif doit être une FeatureCollection GeoJSON.');
  }
  const snapshot: BoundarySnapshot = {
    version: 1,
    manifestHash: expectedHash,
    hashMode: 'file_sha256',
    sources: manifest.sources ?? [],
    features: geoJson.features.map((feature: Record<string, any>) => ({
      municipalityKey: feature?.properties?.municipalityKey,
      geometry: feature?.geometry,
      source: feature?.properties?.sourceName,
      sourceDate: manifest.generatedAt,
      sourceSha256: expectedHash,
    })),
  };
  validateBoundarySnapshot(snapshot, requiredMunicipalityKeys);
  if (snapshot.features.length !== manifest?.snapshot?.featureCount) {
    throw new Error('Le nombre de communes du snapshot ne correspond pas au manifeste.');
  }
  return snapshot;
}
