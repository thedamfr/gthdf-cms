import { createHash } from 'node:crypto';

import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const ALGORITHM_VERSION = Object.freeze({
  catalogue: 'catalogue-city-itinerary-v1',
  wgs84: 'vincenty-wgs84-v1',
  projection: 'segment-projection-v1',
  elevation: 'metric-resample-25m-smooth-100m-v1',
  serialization: 'catalogue-gpx-no-time-v1',
  simplification: 'douglas-peucker-metric-v1',
});

export const ROUTE_ELIGIBILITY_THRESHOLD_METRES = 60_000;
export const DIRECT_ELIGIBILITY_THRESHOLD_METRES = 40_000;

const SHA_256 = /^[a-f0-9]{64}$/i;
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const FORBIDDEN_XML_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const WGS84_SEMI_MAJOR_METRES = 6_378_137;
const WGS84_FLATTENING = 1 / 298.257_223_563;
const WGS84_SEMI_MINOR_METRES = WGS84_SEMI_MAJOR_METRES * (1 - WGS84_FLATTENING);
const MEAN_EARTH_RADIUS_METRES = 6_371_008.8;
const RADIANS = Math.PI / 180;
const EXACT_JUNCTION_TOLERANCE_METRES = 1;
const JUNCTION_REPORT_TOLERANCE_METRES = 2;
const RESAMPLE_INTERVAL_METRES = 25;
const SMOOTHING_WINDOW_METRES = 100;
const MINIMUM_ELEVATION_COVERAGE = 0.95;
const MAXIMUM_INTERPOLATED_GAP_METRES = 250;
export const ANCHOR_RECOMPOSITION_TOLERANCE_METRES = 0.01;

export type GpxPoint = {
  latitude: number;
  longitude: number;
  elevation?: number;
};

export type GpxSegment = {
  trackIndex: number;
  segmentIndex: number;
  points: GpxPoint[];
};

export type GpxDocument = {
  tracks: Array<{ trackIndex: number; segments: GpxSegment[] }>;
  pointCount: number;
};

export type GpxJunctionStatus = 'proposed' | 'exact' | 'accepted_gap' | 'blocked' | 'stale';

export type CatalogueJunction = {
  status: GpxJunctionStatus;
  gapMetres: number;
  nextSourceSha256: string;
  reviewNote?: string | null;
};

export type CatalogueRouteSegment = {
  index: number;
  chapterKey: string;
  sourceSha256: string;
  document: GpxDocument;
  junctionAfter: CatalogueJunction;
};

export type CatalogueAnchor = {
  anchorKey: string;
  routeSegmentIndex: number;
  sourceSha256: string;
  trackIndex: number;
  segmentIndex: number;
  pointIndex: number;
  fraction: number;
  chainageMetres: number;
  projectedLatitude: number;
  projectedLongitude: number;
  status: 'proposed' | 'validated' | 'ambiguous' | 'stale' | 'rejected';
};

export class CatalogueContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CatalogueContractError';
    this.code = code;
  }
}

type XmlNode = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL_NUMBER.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assertCoordinate(point: Pick<GpxPoint, 'latitude' | 'longitude'>): void {
  if (
    !Number.isFinite(point.latitude)
    || !Number.isFinite(point.longitude)
    || point.latitude < -90
    || point.latitude > 90
    || point.longitude < -180
    || point.longitude > 180
  ) {
    throw new RangeError('Une coordonnée WGS84 est invalide.');
  }
}

function haversineMetres(
  first: Pick<GpxPoint, 'latitude' | 'longitude'>,
  second: Pick<GpxPoint, 'latitude' | 'longitude'>,
): number {
  const latitudeDelta = (second.latitude - first.latitude) * RADIANS;
  const longitudeDelta = (second.longitude - first.longitude) * RADIANS;
  const firstLatitude = first.latitude * RADIANS;
  const secondLatitude = second.latitude * RADIANS;
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * MEAN_EARTH_RADIUS_METRES
    * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export type Wgs84DistanceResult = {
  metres: number;
  method: 'vincenty' | 'haversine_fallback';
  converged: boolean;
};

/**
 * Port fidèle du noyau PRD03 : inverse de Vincenty sur l’ellipsoïde WGS84.
 * Les rares paires quasi-antipodales non convergentes utilisent explicitement
 * Haversine et portent cette information dans le rapport via `method`.
 */
export function distanceWgs84Result(
  first: Pick<GpxPoint, 'latitude' | 'longitude'>,
  second: Pick<GpxPoint, 'latitude' | 'longitude'>,
): Wgs84DistanceResult {
  assertCoordinate(first);
  assertCoordinate(second);
  if (first.latitude === second.latitude && first.longitude === second.longitude) {
    return { metres: 0, method: 'vincenty', converged: true };
  }

  const reducedLatitudeFirst = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(first.latitude * RADIANS),
  );
  const reducedLatitudeSecond = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(second.latitude * RADIANS),
  );
  const sineFirst = Math.sin(reducedLatitudeFirst);
  const cosineFirst = Math.cos(reducedLatitudeFirst);
  const sineSecond = Math.sin(reducedLatitudeSecond);
  const cosineSecond = Math.cos(reducedLatitudeSecond);
  const longitudeDifference = (second.longitude - first.longitude) * RADIANS;
  let lambda = longitudeDifference;
  let sineSigma = 0;
  let cosineSigma = 0;
  let sigma = 0;
  let sineAlpha = 0;
  let cosineSquaredAlpha = 0;
  let cosineDoubleSigmaMidpoint = 0;
  let converged = false;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const sineLambda = Math.sin(lambda);
    const cosineLambda = Math.cos(lambda);
    sineSigma = Math.sqrt(
      (cosineSecond * sineLambda) ** 2
      + (cosineFirst * sineSecond - sineFirst * cosineSecond * cosineLambda) ** 2,
    );
    if (sineSigma === 0) return { metres: 0, method: 'vincenty', converged: true };
    cosineSigma = sineFirst * sineSecond + cosineFirst * cosineSecond * cosineLambda;
    sigma = Math.atan2(sineSigma, cosineSigma);
    sineAlpha = cosineFirst * cosineSecond * sineLambda / sineSigma;
    cosineSquaredAlpha = 1 - sineAlpha ** 2;
    cosineDoubleSigmaMidpoint = cosineSquaredAlpha === 0
      ? 0
      : cosineSigma - 2 * sineFirst * sineSecond / cosineSquaredAlpha;
    const correction = WGS84_FLATTENING / 16
      * cosineSquaredAlpha
      * (4 + WGS84_FLATTENING * (4 - 3 * cosineSquaredAlpha));
    const nextLambda = longitudeDifference
      + (1 - correction) * WGS84_FLATTENING * sineAlpha * (
        sigma + correction * sineSigma * (
          cosineDoubleSigmaMidpoint
          + correction * cosineSigma * (-1 + 2 * cosineDoubleSigmaMidpoint ** 2)
        )
      );
    if (Math.abs(nextLambda - lambda) <= 1e-12) {
      lambda = nextLambda;
      converged = true;
      break;
    }
    lambda = nextLambda;
  }

  if (!converged) {
    return {
      metres: haversineMetres(first, second),
      method: 'haversine_fallback',
      converged: false,
    };
  }

  const squaredU = cosineSquaredAlpha
    * (WGS84_SEMI_MAJOR_METRES ** 2 - WGS84_SEMI_MINOR_METRES ** 2)
    / WGS84_SEMI_MINOR_METRES ** 2;
  const coefficientA = 1 + squaredU / 16_384
    * (4_096 + squaredU * (-768 + squaredU * (320 - 175 * squaredU)));
  const coefficientB = squaredU / 1_024
    * (256 + squaredU * (-128 + squaredU * (74 - 47 * squaredU)));
  const deltaSigma = coefficientB * sineSigma * (
    cosineDoubleSigmaMidpoint + coefficientB / 4 * (
      cosineSigma * (-1 + 2 * cosineDoubleSigmaMidpoint ** 2)
      - coefficientB / 6 * cosineDoubleSigmaMidpoint
        * (-3 + 4 * sineSigma ** 2)
        * (-3 + 4 * cosineDoubleSigmaMidpoint ** 2)
    )
  );
  return {
    metres: WGS84_SEMI_MINOR_METRES * coefficientA * (sigma - deltaSigma),
    method: 'vincenty',
    converged: true,
  };
}

export function distanceWgs84Metres(
  first: Pick<GpxPoint, 'latitude' | 'longitude'>,
  second: Pick<GpxPoint, 'latitude' | 'longitude'>,
): number {
  return distanceWgs84Result(first, second).metres;
}

function readGpxPoint(value: unknown): GpxPoint {
  if (!isObject(value)) throw new CatalogueContractError('invalid_point', 'Un trkpt GPX est invalide.');
  const latitude = finiteNumber(value.lat);
  const longitude = finiteNumber(value.lon);
  const elevation = value.ele === undefined ? undefined : finiteNumber(value.ele);
  if (
    latitude === null || longitude === null
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180
  ) {
    throw new CatalogueContractError('invalid_coordinate', 'Une coordonnée GPX est invalide.');
  }
  if (elevation === null) {
    throw new CatalogueContractError('invalid_elevation', 'Une altitude GPX est invalide.');
  }
  if ('extensions' in value) {
    throw new CatalogueContractError('unsupported_extensions', 'Les extensions GPX ne sont pas qualifiées.');
  }
  return { latitude, longitude, ...(elevation === undefined ? {} : { elevation }) };
}

export function parseOfficialGpx(
  xml: string,
  limits: { maximumPoints?: number; maximumTracks?: number; maximumSegments?: number } = {},
): GpxDocument {
  if (FORBIDDEN_XML_DECLARATION.test(xml)) {
    throw new CatalogueContractError('unsafe_xml', 'DOCTYPE et ENTITY sont interdits.');
  }
  if (XMLValidator.validate(xml) !== true) {
    throw new CatalogueContractError('invalid_xml', 'La source GPX est invalide.');
  }
  const parsed = xmlParser.parse(xml) as XmlNode;
  if (!isObject(parsed) || !isObject(parsed.gpx)) {
    throw new CatalogueContractError('invalid_root', 'La source ne contient pas de document GPX.');
  }
  const gpx = parsed.gpx;
  if (gpx.wpt !== undefined || gpx.rte !== undefined || gpx.extensions !== undefined) {
    throw new CatalogueContractError('unsupported_content', 'Waypoints, routes et extensions ne sont pas qualifiés.');
  }
  const maximumPoints = limits.maximumPoints ?? 250_000;
  const maximumTracks = limits.maximumTracks ?? 16;
  const maximumSegments = limits.maximumSegments ?? 512;
  for (const limit of [maximumPoints, maximumTracks, maximumSegments]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Une limite GPX est invalide.');
  }
  const sourceTracks = asArray(gpx.trk).filter(isObject);
  if (sourceTracks.length === 0 || sourceTracks.length > maximumTracks) {
    throw new CatalogueContractError('invalid_track_count', 'Le nombre de traces GPX est invalide.');
  }
  let pointCount = 0;
  let segmentCount = 0;
  const tracks = sourceTracks.map((track, trackIndex) => {
    if ('extensions' in track) throw new CatalogueContractError('unsupported_extensions', 'Les extensions GPX ne sont pas qualifiées.');
    const sourceSegments = asArray(track.trkseg).filter(isObject);
    if (sourceSegments.length === 0) {
      throw new CatalogueContractError('missing_geometry', 'Une trace GPX ne contient aucune séquence.');
    }
    const segments = sourceSegments.map((segment, segmentIndex) => {
      if ('extensions' in segment) throw new CatalogueContractError('unsupported_extensions', 'Les extensions GPX ne sont pas qualifiées.');
      const points = asArray(segment.trkpt).map(readGpxPoint);
      if (points.length === 0) throw new CatalogueContractError('missing_geometry', 'Une séquence GPX est vide.');
      pointCount += points.length;
      segmentCount += 1;
      if (pointCount > maximumPoints || segmentCount > maximumSegments) {
        throw new CatalogueContractError('source_too_complex', 'La source GPX dépasse les limites.');
      }
      return { trackIndex, segmentIndex, points };
    });
    return { trackIndex, segments };
  });
  return { tracks, pointCount };
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Une valeur de hash doit être finie.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new TypeError('Une valeur de hash n’est pas sérialisable.');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function calculateEligibility(distanceMetres: number, directMetres: number): {
  eligible: boolean;
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
} {
  if (!Number.isFinite(distanceMetres) || distanceMetres < 0 || !Number.isFinite(directMetres) || directMetres < 0) {
    throw new RangeError('Les distances d’éligibilité sont invalides.');
  }
  const eligibleByRoute = distanceMetres < ROUTE_ELIGIBILITY_THRESHOLD_METRES;
  const eligibleByDirect = directMetres < DIRECT_ELIGIBILITY_THRESHOLD_METRES;
  return { eligible: eligibleByRoute || eligibleByDirect, eligibleByRoute, eligibleByDirect };
}

export function projectPointOnSegment(
  point: Pick<GpxPoint, 'latitude' | 'longitude'>,
  first: Pick<GpxPoint, 'latitude' | 'longitude'>,
  second: Pick<GpxPoint, 'latitude' | 'longitude'>,
): { fraction: number; point: GpxPoint; distanceMetres: number } {
  assertCoordinate(point);
  assertCoordinate(first);
  assertCoordinate(second);
  const meanLatitude = (point.latitude + first.latitude + second.latitude) / 3 * RADIANS;
  const scaleX = Math.cos(meanLatitude);
  const startX = first.longitude * scaleX;
  const startY = first.latitude;
  const endX = second.longitude * scaleX;
  const endY = second.latitude;
  const pointX = point.longitude * scaleX;
  const pointY = point.latitude;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX ** 2 + deltaY ** 2;
  const fraction = squaredLength === 0
    ? 0
    : Math.max(0, Math.min(1, ((pointX - startX) * deltaX + (pointY - startY) * deltaY) / squaredLength));
  const projected = {
    latitude: first.latitude + (second.latitude - first.latitude) * fraction,
    longitude: first.longitude + (second.longitude - first.longitude) * fraction,
  };
  return { fraction, point: projected, distanceMetres: distanceWgs84Metres(point, projected) };
}

function orderedGpxSegments(document: GpxDocument): GpxSegment[] {
  return document.tracks.flatMap((track) => track.segments);
}

function getAnchorSegment(document: GpxDocument, anchor: CatalogueAnchor): GpxSegment {
  const segment = orderedGpxSegments(document).find((candidate) => (
    candidate.trackIndex === anchor.trackIndex && candidate.segmentIndex === anchor.segmentIndex
  ));
  if (!segment) throw new CatalogueContractError('invalid_anchor', 'Le segment source de l’ancre est absent.');
  return segment;
}

function interpolatePoint(first: GpxPoint, second: GpxPoint, fraction: number): GpxPoint {
  return {
    latitude: first.latitude + (second.latitude - first.latitude) * fraction,
    longitude: first.longitude + (second.longitude - first.longitude) * fraction,
    ...(first.elevation === undefined || second.elevation === undefined
      ? {}
      : { elevation: first.elevation + (second.elevation - first.elevation) * fraction }),
  };
}

function materializeAnchorPoint(document: GpxDocument, anchor: CatalogueAnchor): GpxPoint {
  if (anchor.status !== 'validated') throw new CatalogueContractError('unavailable_anchor', 'Une ancre doit être validée.');
  if (!Number.isInteger(anchor.pointIndex) || anchor.pointIndex < 0 || !Number.isFinite(anchor.fraction) || anchor.fraction < 0 || anchor.fraction > 1) {
    throw new CatalogueContractError('invalid_anchor', 'Les indices de l’ancre sont invalides.');
  }
  const segment = getAnchorSegment(document, anchor);
  const first = segment.points[anchor.pointIndex];
  if (!first) throw new CatalogueContractError('invalid_anchor', 'Le point source de l’ancre est absent.');
  const projected = anchor.fraction === 0
    ? { ...first }
    : (() => {
      const second = segment.points[anchor.pointIndex + 1];
      if (!second) throw new CatalogueContractError('invalid_anchor', 'L’arête source de l’ancre est absente.');
      return interpolatePoint(first, second, anchor.fraction);
    })();
  if (distanceWgs84Metres(projected, {
    latitude: anchor.projectedLatitude,
    longitude: anchor.projectedLongitude,
  }) > 1) {
    throw new CatalogueContractError('inconsistent_anchor', 'La coordonnée d’ancre ne correspond pas à sa source.');
  }
  return projected;
}

export function recomposeAnchorInDocument(
  document: GpxDocument,
  anchor: CatalogueAnchor,
  toleranceMetres = ANCHOR_RECOMPOSITION_TOLERANCE_METRES,
): { point: GpxPoint; localChainageMetres: number } {
  const point = materializeAnchorPoint(document, anchor);
  if (distanceWgs84Metres(point, {
    latitude: anchor.projectedLatitude,
    longitude: anchor.projectedLongitude,
  }) > toleranceMetres) {
    throw new CatalogueContractError('inconsistent_anchor', 'La coordonnée d’ancre diverge de sa source recomposée.');
  }
  const segments = orderedGpxSegments(document);
  const targetOrdinal = segmentOrdinal(document, anchor);
  let localChainageMetres = 0;
  for (let ordinal = 0; ordinal < targetOrdinal; ordinal += 1) {
    localChainageMetres += sequenceDistance(segments[ordinal].points);
  }
  const target = segments[targetOrdinal];
  for (let pointIndex = 0; pointIndex < anchor.pointIndex; pointIndex += 1) {
    const first = target.points[pointIndex];
    const second = target.points[pointIndex + 1];
    if (!first || !second) throw new CatalogueContractError('invalid_anchor', 'Le point précédent de l’ancre est absent.');
    localChainageMetres += distanceWgs84Metres(first, second);
  }
  if (anchor.fraction > 0) {
    const first = target.points[anchor.pointIndex];
    const second = target.points[anchor.pointIndex + 1];
    if (!first || !second) throw new CatalogueContractError('invalid_anchor', 'La fraction de l’ancre ne référence aucune arête.');
    localChainageMetres += distanceWgs84Metres(first, second) * anchor.fraction;
  }
  return { point, localChainageMetres };
}

export function recomposeRouteAnchorPosition(input: {
  route: readonly CatalogueRouteSegment[];
  anchor: CatalogueAnchor;
  cityPoint?: Pick<GpxPoint, 'latitude' | 'longitude'>;
  storedDistanceToTraceMetres?: number;
  toleranceMetres?: number;
}): { point: GpxPoint; localChainageMetres: number; chainageMetres: number; distanceToTraceMetres?: number } {
  const toleranceMetres = input.toleranceMetres ?? ANCHOR_RECOMPOSITION_TOLERANCE_METRES;
  if (!Number.isFinite(toleranceMetres) || toleranceMetres < 0) {
    throw new CatalogueContractError('invalid_anchor_tolerance', 'La tolérance de recomposition d’ancre est invalide.');
  }
  validateRoutePosition(input.route, input.anchor);
  const segment = input.route[input.anchor.routeSegmentIndex];
  const recomposed = recomposeAnchorInDocument(segment.document, input.anchor, toleranceMetres);
  let chainageMetres = recomposed.localChainageMetres;
  for (let index = 0; index < input.anchor.routeSegmentIndex; index += 1) {
    chainageMetres += totalSequenceDistanceMetres(
      input.route[index].document.tracks.flatMap((track) => track.segments.map((part) => part.points)),
    );
  }
  if (!Number.isFinite(input.anchor.chainageMetres)
    || Math.abs(chainageMetres - input.anchor.chainageMetres) > toleranceMetres) {
    throw new CatalogueContractError(
      'inconsistent_anchor_chainage',
      `Le chaînage d’ancre diverge de ${Math.abs(chainageMetres - input.anchor.chainageMetres)} m de sa source.`,
    );
  }
  const distanceToTraceMetres = input.cityPoint
    ? distanceWgs84Metres(input.cityPoint, recomposed.point)
    : undefined;
  if (
    distanceToTraceMetres !== undefined
    && input.storedDistanceToTraceMetres !== undefined
    && (!Number.isFinite(input.storedDistanceToTraceMetres)
      || Math.abs(distanceToTraceMetres - input.storedDistanceToTraceMetres) > toleranceMetres)
  ) {
    throw new CatalogueContractError(
      'inconsistent_anchor_distance',
      'La distance communale de l’ancre ne correspond pas à sa position recomposée.',
    );
  }
  return {
    ...recomposed,
    chainageMetres,
    ...(distanceToTraceMetres === undefined ? {} : { distanceToTraceMetres }),
  };
}

function samePoint(first: GpxPoint, second: GpxPoint): boolean {
  return first.latitude === second.latitude
    && first.longitude === second.longitude
    && first.elevation === second.elevation;
}

function appendDistinct(points: GpxPoint[], point: GpxPoint): void {
  if (points.length === 0 || !samePoint(points[points.length - 1], point)) points.push({ ...point });
}

function segmentOrdinal(document: GpxDocument, anchor: CatalogueAnchor): number {
  const ordinal = orderedGpxSegments(document).findIndex((segment) => (
    segment.trackIndex === anchor.trackIndex && segment.segmentIndex === anchor.segmentIndex
  ));
  if (ordinal < 0) throw new CatalogueContractError('invalid_anchor', 'L’ancre ne référence aucune séquence.');
  return ordinal;
}

function sliceSingleSegment(segment: GpxSegment, start: CatalogueAnchor, end: CatalogueAnchor): GpxPoint[] {
  const points: GpxPoint[] = [];
  appendDistinct(points, materializeAnchorPoint({ tracks: [{ trackIndex: segment.trackIndex, segments: [segment] }], pointCount: segment.points.length }, start));
  const firstIndex = start.pointIndex + (start.fraction === 1 ? 2 : 1);
  const lastIndex = end.pointIndex - (end.fraction === 0 ? 1 : 0);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    if (segment.points[index]) appendDistinct(points, segment.points[index]);
  }
  appendDistinct(points, materializeAnchorPoint({ tracks: [{ trackIndex: segment.trackIndex, segments: [segment] }], pointCount: segment.points.length }, end));
  return points;
}

function extractBetween(document: GpxDocument, start: CatalogueAnchor, end: CatalogueAnchor): GpxPoint[][] {
  const segments = orderedGpxSegments(document);
  const startOrdinal = segmentOrdinal(document, start);
  const endOrdinal = segmentOrdinal(document, end);
  const startPosition = start.pointIndex + start.fraction;
  const endPosition = end.pointIndex + end.fraction;
  if (startOrdinal > endOrdinal || (startOrdinal === endOrdinal && startPosition > endPosition)) {
    throw new CatalogueContractError('reverse_anchor_order', 'Les ancres sont inversées dans leur source.');
  }
  if (startOrdinal === endOrdinal) return [sliceSingleSegment(segments[startOrdinal], start, end)];
  const startSegment = segments[startOrdinal];
  const endSegment = segments[endOrdinal];
  const first: GpxPoint[] = [materializeAnchorPoint(document, start)];
  for (let index = start.pointIndex + (start.fraction === 1 ? 2 : 1); index < startSegment.points.length; index += 1) appendDistinct(first, startSegment.points[index]);
  const last: GpxPoint[] = [];
  const lastIndex = end.pointIndex - (end.fraction === 0 ? 1 : 0);
  for (let index = 0; index <= lastIndex; index += 1) appendDistinct(last, endSegment.points[index]);
  appendDistinct(last, materializeAnchorPoint(document, end));
  return [first, ...segments.slice(startOrdinal + 1, endOrdinal).map((segment) => segment.points.map((point) => ({ ...point }))), last]
    .filter((sequence) => sequence.length > 0);
}

function extractFromAnchorToEnd(document: GpxDocument, anchor: CatalogueAnchor): GpxPoint[][] {
  const segments = orderedGpxSegments(document);
  const ordinal = segmentOrdinal(document, anchor);
  const source = segments[ordinal];
  const first: GpxPoint[] = [materializeAnchorPoint(document, anchor)];
  for (let index = anchor.pointIndex + (anchor.fraction === 1 ? 2 : 1); index < source.points.length; index += 1) appendDistinct(first, source.points[index]);
  return [first, ...segments.slice(ordinal + 1).map((segment) => segment.points.map((point) => ({ ...point })))]
    .filter((sequence) => sequence.length > 0);
}

function extractFromStartToAnchor(document: GpxDocument, anchor: CatalogueAnchor): GpxPoint[][] {
  const segments = orderedGpxSegments(document);
  const ordinal = segmentOrdinal(document, anchor);
  const source = segments[ordinal];
  const last: GpxPoint[] = [];
  const lastIndex = anchor.pointIndex - (anchor.fraction === 0 ? 1 : 0);
  for (let index = 0; index <= lastIndex; index += 1) appendDistinct(last, source.points[index]);
  appendDistinct(last, materializeAnchorPoint(document, anchor));
  return [...segments.slice(0, ordinal).map((segment) => segment.points.map((point) => ({ ...point }))), last]
    .filter((sequence) => sequence.length > 0);
}

function buildVisitIndexes(segmentCount: number, start: CatalogueAnchor, end: CatalogueAnchor): { indexes: number[]; usesLoopOrigin: boolean } {
  if (start.routeSegmentIndex === end.routeSegmentIndex && end.chainageMetres >= start.chainageMetres) {
    return { indexes: [start.routeSegmentIndex], usesLoopOrigin: false };
  }
  const indexes = [start.routeSegmentIndex];
  let current = start.routeSegmentIndex;
  for (let visit = 0; visit < segmentCount; visit += 1) {
    current = (current + 1) % segmentCount;
    indexes.push(current);
    if (current === end.routeSegmentIndex) {
      return { indexes, usesLoopOrigin: end.chainageMetres <= start.chainageMetres };
    }
  }
  throw new CatalogueContractError('invalid_selection', 'La portion dépasse une boucle.');
}

function validateRoutePosition(route: readonly CatalogueRouteSegment[], anchor: CatalogueAnchor): void {
  const segment = route[anchor.routeSegmentIndex];
  if (!segment || segment.index !== anchor.routeSegmentIndex) {
    throw new CatalogueContractError('invalid_anchor', 'L’ancre référence un segment de parcours absent.');
  }
  if (anchor.sourceSha256.toLowerCase() !== segment.sourceSha256.toLowerCase()) {
    throw new CatalogueContractError('stale_anchor', 'L’ancre référence une autre version GPX.');
  }
}

export type RouteArcResult = {
  sequences: GpxPoint[][];
  chapterKeys: string[];
  chapters: Array<{ chapterKey: string; distanceMetres: number }>;
  usesLoopOrigin: boolean;
  warnings: Array<{
    code: 'accepted_gap';
    afterChapterSlug: string;
    beforeChapterSlug: string;
    gapMetres: number;
    reviewNote?: string | null;
  }>;
};

export function extractRouteArc(
  route: readonly CatalogueRouteSegment[],
  start: CatalogueAnchor,
  end: CatalogueAnchor,
): RouteArcResult {
  if (route.length === 0 || route.length > 100) throw new CatalogueContractError('invalid_route', 'Le parcours est vide ou trop grand.');
  validateRoutePosition(route, start);
  validateRoutePosition(route, end);
  const { indexes, usesLoopOrigin } = buildVisitIndexes(route.length, start, end);
  const sequences: GpxPoint[][] = [];
  const warnings: RouteArcResult['warnings'] = [];
  const chapters: RouteArcResult['chapters'] = [];

  indexes.forEach((routeIndex, visitIndex) => {
    const segment = route[routeIndex];
    const isFirst = visitIndex === 0;
    const isLast = visitIndex === indexes.length - 1;
    const incoming = isFirst && isLast
      ? extractBetween(segment.document, start, end)
      : isFirst
        ? extractFromAnchorToEnd(segment.document, start)
        : isLast
          ? extractFromStartToAnchor(segment.document, end)
          : orderedGpxSegments(segment.document).map((item) => item.points.map((point) => ({ ...point })));
    if (incoming.length === 0) throw new CatalogueContractError('missing_geometry', 'Une portion source est vide.');
    chapters.push({
      chapterKey: segment.chapterKey,
      distanceMetres: totalSequenceDistanceMetres(incoming),
    });
    if (isFirst) {
      sequences.push(...incoming);
      return;
    }
    const previous = route[indexes[visitIndex - 1]];
    const junction = previous.junctionAfter;
    if (junction.nextSourceSha256.toLowerCase() !== segment.sourceSha256.toLowerCase()) {
      throw new CatalogueContractError('stale_junction', 'Une jonction référence une autre version GPX.');
    }
    const previousSequence = sequences.at(-1);
    const previousPoint = previousSequence?.at(-1);
    const nextPoint = incoming[0]?.[0];
    if (!previousSequence || !previousPoint || !nextPoint) throw new CatalogueContractError('missing_geometry', 'Une jonction ne possède pas ses extrémités.');
    const actualGapMetres = distanceWgs84Metres(previousPoint, nextPoint);
    if (!Number.isFinite(junction.gapMetres) || Math.abs(junction.gapMetres - actualGapMetres) > JUNCTION_REPORT_TOLERANCE_METRES) {
      throw new CatalogueContractError('stale_junction', 'L’écart de jonction ne correspond plus aux sources.');
    }
    if (junction.status === 'exact') {
      if (actualGapMetres > EXACT_JUNCTION_TOLERANCE_METRES) throw new CatalogueContractError('invalid_junction', 'Une jonction exacte ne l’est plus.');
      previousSequence.push(...(samePoint(previousPoint, nextPoint) ? incoming[0].slice(1) : incoming[0]));
      sequences.push(...incoming.slice(1));
      return;
    }
    if (junction.status === 'accepted_gap') {
      sequences.push(...incoming);
      warnings.push({
        code: 'accepted_gap',
        afterChapterSlug: previous.chapterKey,
        beforeChapterSlug: segment.chapterKey,
        gapMetres: actualGapMetres,
        reviewNote: junction.reviewNote,
      });
      return;
    }
    throw new CatalogueContractError('blocked_junction', 'La portion traverse une jonction indisponible.');
  });

  return {
    sequences,
    chapterKeys: indexes.map((index) => route[index].chapterKey)
      .filter((key, index, all) => all.indexOf(key) === index),
    chapters,
    usesLoopOrigin,
    warnings,
  };
}

type JunctionSelection = { afterSegmentIndex: number; status: GpxJunctionStatus };

function crossedJunctions(
  segmentCount: number,
  departure: CatalogueAnchor,
  arrival: CatalogueAnchor,
  junctions: readonly JunctionSelection[],
): JunctionSelection[] {
  const directSame = departure.routeSegmentIndex === arrival.routeSegmentIndex
    && arrival.chainageMetres >= departure.chainageMetres;
  if (directSame) return [];
  const byIndex = new Map(junctions.map((junction) => [junction.afterSegmentIndex, junction]));
  const crossed: JunctionSelection[] = [];
  let current = departure.routeSegmentIndex;
  for (let count = 0; count < segmentCount; count += 1) {
    const junction = byIndex.get(current);
    if (!junction) throw new CatalogueContractError('missing_junction', `La jonction après le segment ${current} est absente.`);
    crossed.push(junction);
    current = (current + 1) % segmentCount;
    if (current === arrival.routeSegmentIndex) return crossed;
  }
  throw new CatalogueContractError('invalid_selection', 'La sélection dépasse une boucle.');
}

export type ShortestArcSelection = {
  departure: CatalogueAnchor;
  arrival: CatalogueAnchor;
  distanceMetres: number;
  usesLoopOrigin: boolean;
  acceptedGapCount: number;
  sequenceCount: number;
};

export function selectShortestArc(input: {
  anchorsA: readonly CatalogueAnchor[];
  anchorsB: readonly CatalogueAnchor[];
  routeLengthMetres: number;
  junctions: readonly JunctionSelection[];
  /** Compteur exact obtenu en matérialisant les trkseg de ce candidat. */
  sequenceCountForCandidate: (departure: CatalogueAnchor, arrival: CatalogueAnchor) => number;
}): ShortestArcSelection {
  if (!Number.isFinite(input.routeLengthMetres) || input.routeLengthMetres <= 0) throw new RangeError('La longueur de boucle est invalide.');
  if (input.anchorsA.length === 0 || input.anchorsB.length === 0) throw new CatalogueContractError('missing_anchor', 'Chaque ville doit posséder une ancre validée.');
  const segmentCount = input.junctions.length;
  const candidates: ShortestArcSelection[] = [];

  for (const anchorA of input.anchorsA) {
    for (const anchorB of input.anchorsB) {
      for (const [departure, arrival] of [[anchorA, anchorB], [anchorB, anchorA]] as const) {
        if (departure.status !== 'validated' || arrival.status !== 'validated') continue;
        const delta = arrival.chainageMetres - departure.chainageMetres;
        const distanceMetres = delta >= 0 ? delta : input.routeLengthMetres + delta;
        const crossed = crossedJunctions(segmentCount, departure, arrival, input.junctions);
        if (crossed.some((junction) => !['exact', 'accepted_gap'].includes(junction.status))) continue;
        const sequenceCount = input.sequenceCountForCandidate(departure, arrival);
        if (!Number.isSafeInteger(sequenceCount) || sequenceCount < 1) {
          throw new CatalogueContractError('invalid_sequence_count', 'Le nombre exact de séquences du candidat est invalide.');
        }
        candidates.push({
          departure,
          arrival,
          distanceMetres,
          usesLoopOrigin: delta < 0,
          acceptedGapCount: crossed.filter((junction) => junction.status === 'accepted_gap').length,
          sequenceCount,
        });
      }
    }
  }
  if (candidates.length === 0) throw new CatalogueContractError('blocked_pair', 'Aucun arc disponible ne relie ces villes.');
  const tolerance = 1e-9;
  return candidates.sort((first, second) => {
    const distanceDifference = first.distanceMetres - second.distanceMetres;
    if (Math.abs(distanceDifference) > tolerance) return distanceDifference;
    return first.acceptedGapCount - second.acceptedGapCount
      || first.sequenceCount - second.sequenceCount
      || first.departure.anchorKey.localeCompare(second.departure.anchorKey)
      || first.arrival.anchorKey.localeCompare(second.arrival.anchorKey);
  })[0];
}

function sequenceDistance(points: readonly Pick<GpxPoint, 'latitude' | 'longitude'>[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distanceWgs84Metres(points[index - 1], points[index]);
  return total;
}

type ElevationSample = { distance: number; elevation?: number };

function interpolateShortElevationGaps(sequence: readonly GpxPoint[]): GpxPoint[] {
  const points = sequence.map((point) => ({ ...point }));
  let previousKnown = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].elevation === undefined) continue;
    if (previousKnown >= 0 && index - previousKnown > 1) {
      const distances = [0];
      for (let cursor = previousKnown + 1; cursor <= index; cursor += 1) {
        distances.push(distances.at(-1)! + distanceWgs84Metres(points[cursor - 1], points[cursor]));
      }
      const gap = distances.at(-1)!;
      if (gap > 0 && gap <= MAXIMUM_INTERPOLATED_GAP_METRES) {
        const first = points[previousKnown].elevation!;
        const last = points[index].elevation!;
        for (let cursor = previousKnown + 1; cursor < index; cursor += 1) {
          points[cursor].elevation = first + (last - first) * distances[cursor - previousKnown] / gap;
        }
      }
    }
    previousKnown = index;
  }
  return points;
}

function fillQualifiedElevationEdges(sequence: readonly GpxPoint[]): GpxPoint[] {
  const points = interpolateShortElevationGaps(sequence);
  const firstKnown = points.findIndex((point) => point.elevation !== undefined);
  if (firstKnown < 0) return points;
  let lastKnown = points.length - 1;
  while (lastKnown >= 0 && points[lastKnown].elevation === undefined) lastKnown -= 1;
  for (let index = 0; index < firstKnown; index += 1) points[index].elevation = points[firstKnown].elevation;
  for (let index = lastKnown + 1; index < points.length; index += 1) points[index].elevation = points[lastKnown].elevation;
  return points;
}

function resampleElevation(sequence: readonly GpxPoint[]): ElevationSample[] {
  if (sequence.length === 0) return [];
  if (sequence.length === 1) return [{ distance: 0, elevation: sequence[0].elevation }];
  const cumulative = [0];
  for (let index = 1; index < sequence.length; index += 1) cumulative.push(cumulative[index - 1] + distanceWgs84Metres(sequence[index - 1], sequence[index]));
  const total = cumulative.at(-1)!;
  const targets: number[] = [];
  for (let distance = 0; distance < total; distance += RESAMPLE_INTERVAL_METRES) targets.push(distance);
  if (targets.at(-1) !== total) targets.push(total);
  let edge = 0;
  return targets.map((target) => {
    while (edge < cumulative.length - 2 && cumulative[edge + 1] < target) edge += 1;
    const length = cumulative[edge + 1] - cumulative[edge];
    const fraction = length === 0 ? 0 : (target - cumulative[edge]) / length;
    const first = sequence[edge];
    const second = sequence[edge + 1];
    return {
      distance: target,
      elevation: first.elevation === undefined || second.elevation === undefined
        ? undefined
        : first.elevation + (second.elevation - first.elevation) * fraction,
    };
  });
}

function smoothKnownRuns(samples: readonly ElevationSample[]): number[][] {
  const runs: ElevationSample[][] = [];
  let current: ElevationSample[] = [];
  for (const sample of samples) {
    if (sample.elevation === undefined) {
      if (current.length) runs.push(current);
      current = [];
    } else current.push(sample);
  }
  if (current.length) runs.push(current);
  const radius = SMOOTHING_WINDOW_METRES / 2;
  return runs.map((run) => {
    const prefix = [0];
    for (const sample of run) prefix.push(prefix.at(-1)! + sample.elevation!);
    let left = 0;
    let right = 0;
    return run.map((sample) => {
      while (run[left]?.distance < sample.distance - radius) left += 1;
      while (right + 1 < run.length && run[right + 1].distance <= sample.distance + radius) right += 1;
      return (prefix[right + 1] - prefix[left]) / (right - left + 1);
    });
  });
}

export function computeElevationMetrics(sequences: readonly (readonly GpxPoint[])[]): {
  distanceMetres: number;
  elevationAvailable: boolean;
  elevationCoverageRatio: number;
  elevationGainMetres: number | null;
  elevationLossMetres: number | null;
} {
  let distanceMetres = 0;
  let coveredDistance = 0;
  let maximumGap = 0;
  for (const sequence of sequences) {
    let currentGap = 0;
    for (let index = 1; index < sequence.length; index += 1) {
      const distance = distanceWgs84Metres(sequence[index - 1], sequence[index]);
      distanceMetres += distance;
      if (sequence[index - 1].elevation !== undefined && sequence[index].elevation !== undefined) {
        coveredDistance += distance;
        maximumGap = Math.max(maximumGap, currentGap);
        currentGap = 0;
      } else currentGap += distance;
    }
    maximumGap = Math.max(maximumGap, currentGap);
  }
  const elevationCoverageRatio = distanceMetres === 0 ? 0 : coveredDistance / distanceMetres;
  const elevationAvailable = distanceMetres > 0
    && elevationCoverageRatio >= MINIMUM_ELEVATION_COVERAGE
    && maximumGap <= MAXIMUM_INTERPOLATED_GAP_METRES;
  if (!elevationAvailable) {
    return { distanceMetres, elevationAvailable: false, elevationCoverageRatio, elevationGainMetres: null, elevationLossMetres: null };
  }
  let elevationGainMetres = 0;
  let elevationLossMetres = 0;
  for (const sequence of sequences) {
    for (const run of smoothKnownRuns(resampleElevation(interpolateShortElevationGaps(sequence)))) {
      for (let index = 1; index < run.length; index += 1) {
        const difference = run[index] - run[index - 1];
        if (difference > 0) elevationGainMetres += difference;
        else elevationLossMetres += Math.abs(difference);
      }
    }
  }
  return { distanceMetres, elevationAvailable: true, elevationCoverageRatio, elevationGainMetres, elevationLossMetres };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Une valeur GPX doit être finie.');
  return value.toFixed(decimals).replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
}

export function serializeCatalogueGpx(input: {
  departureName: string;
  arrivalName: string;
  revisionKey: string;
  sourceHash: string;
  algorithmVersion: string;
  sequences: readonly (readonly GpxPoint[])[];
}): string {
  if (!SHA_256.test(input.sourceHash)) throw new RangeError('Le sourceHash GPX est invalide.');
  const sequences = input.sequences.filter((sequence) => sequence.length > 0);
  if (sequences.length === 0) throw new RangeError('Un GPX catalogue doit contenir une séquence.');
  const routeName = `${input.departureName} → ${input.arrivalName} sur le GTHF`;
  const description = `Portion officielle du GTHF. Révision ${input.revisionKey}; source ${input.sourceHash}; algorithme ${input.algorithmVersion}. Les horodatages sources sont omis.`;
  const trkseg = sequences.map((sequence) => `    <trkseg>\n${sequence.map((point) => {
    const elevation = point.elevation === undefined ? '' : `\n        <ele>${formatNumber(point.elevation, 3)}</ele>`;
    return `      <trkpt lat="${formatNumber(point.latitude, 8)}" lon="${formatNumber(point.longitude, 8)}">${elevation}\n      </trkpt>`;
  }).join('\n')}\n    </trkseg>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GTHF Catalogue" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${escapeXml(routeName)}</name>
    <desc>${escapeXml(description)}</desc>
  </metadata>
  <trk>
    <name>${escapeXml(routeName)}</name>
${trkseg}
  </trk>
</gpx>`;
  parseOfficialGpx(xml, {
    maximumPoints: sequences.reduce((sum, sequence) => sum + sequence.length, 0),
    maximumTracks: 1,
    maximumSegments: sequences.length,
  });
  return xml;
}

function pointToLocalMetres(point: GpxPoint, origin: GpxPoint): [number, number] {
  const latitudeScale = Math.PI * MEAN_EARTH_RADIUS_METRES / 180;
  const longitudeScale = latitudeScale * Math.cos(origin.latitude * RADIANS);
  return [(point.longitude - origin.longitude) * longitudeScale, (point.latitude - origin.latitude) * latitudeScale];
}

function perpendicularDistanceMetres(point: GpxPoint, first: GpxPoint, second: GpxPoint): number {
  const [px, py] = pointToLocalMetres(point, first);
  const [sx, sy] = pointToLocalMetres(second, first);
  const squaredLength = sx ** 2 + sy ** 2;
  if (squaredLength === 0) return Math.hypot(px, py);
  const fraction = Math.max(0, Math.min(1, (px * sx + py * sy) / squaredLength));
  return Math.hypot(px - fraction * sx, py - fraction * sy);
}

function simplifySequence(points: readonly GpxPoint[], toleranceMetres: number): GpxPoint[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const keep = new Set([0, points.length - 1]);
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [firstIndex, lastIndex] = stack.pop()!;
    let maximumDistance = -1;
    let maximumIndex = -1;
    for (let index = firstIndex + 1; index < lastIndex; index += 1) {
      const distance = perpendicularDistanceMetres(points[index], points[firstIndex], points[lastIndex]);
      if (distance > maximumDistance) {
        maximumDistance = distance;
        maximumIndex = index;
      }
    }
    if (maximumDistance > toleranceMetres && maximumIndex > firstIndex) {
      keep.add(maximumIndex);
      stack.push([firstIndex, maximumIndex], [maximumIndex, lastIndex]);
    }
  }
  return [...keep].sort((a, b) => a - b).map((index) => ({ ...points[index] }));
}

export function simplifySequences(
  sequences: readonly (readonly GpxPoint[])[],
  toleranceMetres = 10,
): GpxPoint[][] {
  if (!Number.isFinite(toleranceMetres) || toleranceMetres < 0) throw new RangeError('La tolérance de simplification est invalide.');
  return sequences.map((sequence) => simplifySequence(sequence, toleranceMetres));
}

export function buildDisplayGeometry(input: {
  revisionKey: string;
  algorithmVersion: string;
  sequences: readonly (readonly GpxPoint[])[];
  toleranceMetres?: number;
  elevationAvailable?: boolean;
}): {
  version: 1;
  revisionKey: string;
  algorithmVersion: string;
  sequences: Array<{ coordinates: Array<[number, number] | [number, number, number]> }>;
  elevationProfile: Array<{
    sequenceIndex: number;
    points: Array<{ distanceMetres: number; elevationMetres: number }>;
  }> | null;
} {
  const elevationMetrics = computeElevationMetrics(input.sequences);
  if (
    input.elevationAvailable !== undefined
    && input.elevationAvailable !== elevationMetrics.elevationAvailable
  ) {
    throw new CatalogueContractError('inconsistent_elevation_status', 'Le statut altitude ne correspond pas au noyau métrique.');
  }
  const elevationAvailable = input.elevationAvailable ?? elevationMetrics.elevationAvailable;
  const profileSequences = elevationAvailable
    ? input.sequences.map(fillQualifiedElevationEdges)
    : input.sequences.map((sequence) => sequence.map((point) => ({ ...point })));
  if (elevationAvailable && profileSequences.some((sequence) => sequence.some((point) => point.elevation === undefined))) {
    throw new CatalogueContractError('incomplete_elevation_profile', 'Une séquence qualifiée ne peut pas produire un profil complet.');
  }
  const simplified = simplifySequences(profileSequences, input.toleranceMetres ?? 10);
  let distanceMetres = 0;
  const elevationProfile: Array<{
    sequenceIndex: number;
    points: Array<{ distanceMetres: number; elevationMetres: number }>;
  }> = [];
  for (const [sequenceIndex, sequence] of profileSequences.entries()) {
    const points: Array<{ distanceMetres: number; elevationMetres: number }> = [];
    for (let index = 0; index < sequence.length; index += 1) {
      if (index > 0) distanceMetres += distanceWgs84Metres(sequence[index - 1], sequence[index]);
      if (sequence[index].elevation !== undefined) {
        const previous = points.at(-1);
        if (previous && distanceMetres <= previous.distanceMetres) previous.elevationMetres = sequence[index].elevation!;
        else points.push({ distanceMetres, elevationMetres: sequence[index].elevation! });
      }
    }
    elevationProfile.push({ sequenceIndex, points });
  }
  return {
    version: 1,
    revisionKey: input.revisionKey,
    algorithmVersion: input.algorithmVersion,
    sequences: simplified.map((sequence) => ({
      coordinates: sequence.map((point) => point.elevation === undefined
        ? [point.longitude, point.latitude]
        : [point.longitude, point.latitude, point.elevation!]),
    })),
    elevationProfile: elevationAvailable ? elevationProfile : null,
  };
}

export function totalSequenceDistanceMetres(sequences: readonly (readonly GpxPoint[])[]): number {
  return sequences.reduce((sum, sequence) => sum + sequenceDistance(sequence), 0);
}
