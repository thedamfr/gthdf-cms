'use strict';

const { createHash } = require('node:crypto');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const ALGORITHM_VERSION = 'gpx-anchor-v1';
const MAXIMUM_POINTS = 250000;
const MAXIMUM_CANDIDATES_PER_PASSAGE = 256;
const NEAREST_CANDIDATES_PER_PASSAGE = 32;
const MINIMUM_CANDIDATE_SEPARATION_METRES = 250;
const ORDER_EPSILON_METRES = 0.01;
const AMBIGUOUS_DISTANCE_DELTA_METRES = 25;
const AMBIGUOUS_CHAINAGE_DELTA_METRES = 250;
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const RADIANS = Math.PI / 180;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

function asArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function distanceWgs84Metres(first, second) {
  if (first.latitude === second.latitude && first.longitude === second.longitude) return 0;
  const firstReduced = Math.atan((1 - WGS84_F) * Math.tan(first.latitude * RADIANS));
  const secondReduced = Math.atan((1 - WGS84_F) * Math.tan(second.latitude * RADIANS));
  const sinFirst = Math.sin(firstReduced);
  const cosFirst = Math.cos(firstReduced);
  const sinSecond = Math.sin(secondReduced);
  const cosSecond = Math.cos(secondReduced);
  const longitudeDifference = (second.longitude - first.longitude) * RADIANS;
  let lambda = longitudeDifference;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 0;
  let cosDoubleSigma = 0;
  let converged = false;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosSecond * sinLambda) ** 2
      + (cosFirst * sinSecond - sinFirst * cosSecond * cosLambda) ** 2
    );
    if (sinSigma === 0) return 0;
    cosSigma = sinFirst * sinSecond + cosFirst * cosSecond * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cosFirst * cosSecond * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cosDoubleSigma = cosSqAlpha === 0
      ? 0
      : cosSigma - 2 * sinFirst * sinSecond / cosSqAlpha;
    const correction = WGS84_F / 16 * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const next = longitudeDifference + (1 - correction) * WGS84_F * sinAlpha * (
      sigma + correction * sinSigma * (
        cosDoubleSigma + correction * cosSigma * (-1 + 2 * cosDoubleSigma ** 2)
      )
    );
    if (Math.abs(next - lambda) <= 1e-12) {
      lambda = next;
      converged = true;
      break;
    }
    lambda = next;
  }

  if (!converged) {
    const latitudeDelta = (second.latitude - first.latitude) * RADIANS;
    const longitudeDelta = (second.longitude - first.longitude) * RADIANS;
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(first.latitude * RADIANS)
        * Math.cos(second.latitude * RADIANS)
        * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * 6371008.8 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  const squaredU = cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2) / WGS84_B ** 2;
  const coefficientA = 1 + squaredU / 16384
    * (4096 + squaredU * (-768 + squaredU * (320 - 175 * squaredU)));
  const coefficientB = squaredU / 1024
    * (256 + squaredU * (-128 + squaredU * (74 - 47 * squaredU)));
  const deltaSigma = coefficientB * sinSigma * (
    cosDoubleSigma + coefficientB / 4 * (
      cosSigma * (-1 + 2 * cosDoubleSigma ** 2)
      - coefficientB / 6
        * cosDoubleSigma
        * (-3 + 4 * sinSigma ** 2)
        * (-3 + 4 * cosDoubleSigma ** 2)
    )
  );
  return WGS84_B * coefficientA * (sigma - deltaSigma);
}

function readPoint(value) {
  if (!isObject(value)) throw new Error('Un point GPX est invalide.');
  const latitude = finiteNumber(value.lat);
  const longitude = finiteNumber(value.lon);
  const elevation = value.ele === undefined ? undefined : finiteNumber(value.ele);
  if (
    latitude === null || longitude === null
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180
    || (value.ele !== undefined && elevation === null)
  ) {
    throw new Error('Une coordonnée ou altitude GPX est invalide.');
  }
  if ('extensions' in value) throw new Error('Les extensions GPX ne sont pas qualifiées.');
  return { latitude, longitude, ...(elevation === undefined ? {} : { elevation }) };
}

function parseOfficialGpxBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('La source GPX doit être binaire.');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Les déclarations XML externes sont interdites.');
  if (XMLValidator.validate(xml) !== true) throw new Error('Le média GPX contient un XML invalide.');
  const parsed = parser.parse(xml);
  if (!isObject(parsed) || !isObject(parsed.gpx)) throw new Error('Le média ne contient pas de document GPX.');
  const gpx = parsed.gpx;
  if (gpx.wpt !== undefined || gpx.rte !== undefined || gpx.extensions !== undefined) {
    throw new Error('Le média GPX contient des structures non qualifiées.');
  }

  let pointCount = 0;
  let chainageMetres = 0;
  const segments = [];
  const tracks = asArray(gpx.trk).filter(isObject);
  tracks.forEach((track, trackIndex) => {
    if ('extensions' in track) throw new Error('Les extensions GPX ne sont pas qualifiées.');
    asArray(track.trkseg).filter(isObject).forEach((segment, segmentIndex) => {
      if ('extensions' in segment) throw new Error('Les extensions GPX ne sont pas qualifiées.');
      const points = asArray(segment.trkpt).map(readPoint);
      if (points.length === 0) throw new Error('Une séquence GPX ne contient aucun point.');
      pointCount += points.length;
      if (pointCount > MAXIMUM_POINTS) throw new Error('Le média GPX dépasse la limite de points.');
      const pointChainages = [chainageMetres];
      for (let index = 1; index < points.length; index += 1) {
        chainageMetres += distanceWgs84Metres(points[index - 1], points[index]);
        pointChainages.push(chainageMetres);
      }
      segments.push({ trackIndex, segmentIndex, points, pointChainages });
    });
  });
  if (segments.length === 0) throw new Error('Le média GPX ne contient aucune trace exploitable.');

  return {
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    pointCount,
    distanceMetres: chainageMetres,
    segments,
  };
}

function projectOnEdge(city, first, second) {
  const meanLatitude = (city.latitude + first.latitude + second.latitude) / 3 * RADIANS;
  const scaleX = Math.cos(meanLatitude);
  const startX = first.longitude * scaleX;
  const startY = first.latitude;
  const endX = second.longitude * scaleX;
  const endY = second.latitude;
  const cityX = city.longitude * scaleX;
  const cityY = city.latitude;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const squaredLength = deltaX ** 2 + deltaY ** 2;
  const fraction = squaredLength === 0
    ? 0
    : Math.max(0, Math.min(1,
      ((cityX - startX) * deltaX + (cityY - startY) * deltaY) / squaredLength
    ));
  return {
    fraction,
    projectedLatitude: first.latitude + (second.latitude - first.latitude) * fraction,
    projectedLongitude: first.longitude + (second.longitude - first.longitude) * fraction,
  };
}

function candidateKey(sourceSha256, candidate) {
  const payload = [
    sourceSha256,
    candidate.trackIndex,
    candidate.segmentIndex,
    candidate.pointIndex,
    candidate.fraction.toFixed(12),
  ].join(':');
  return createHash('sha256').update(payload).digest('hex');
}

function passageCandidates(source, passage) {
  const latitude = finiteNumber(passage.city?.latitude);
  const longitude = finiteNumber(passage.city?.longitude);
  if (
    latitude === null || longitude === null
    || latitude < -90 || latitude > 90
    || longitude < -180 || longitude > 180
  ) {
    throw new Error(`La ville ${passage.city?.name ?? passage.passageIndex} n’a pas de coordonnées complètes.`);
  }
  const city = { latitude, longitude };
  const candidates = [];

  for (const segment of source.segments) {
    if (segment.points.length === 1) {
      const only = segment.points[0];
      candidates.push({
        trackIndex: segment.trackIndex,
        segmentIndex: segment.segmentIndex,
        pointIndex: 0,
        fraction: 0,
        chainageMetres: segment.pointChainages[0],
        projectedLatitude: only.latitude,
        projectedLongitude: only.longitude,
        distanceToCityMetres: distanceWgs84Metres(city, only),
      });
      continue;
    }

    for (let pointIndex = 0; pointIndex < segment.points.length - 1; pointIndex += 1) {
      const first = segment.points[pointIndex];
      const second = segment.points[pointIndex + 1];
      const projection = projectOnEdge(city, first, second);
      const projected = {
        latitude: projection.projectedLatitude,
        longitude: projection.projectedLongitude,
      };
      candidates.push({
        trackIndex: segment.trackIndex,
        segmentIndex: segment.segmentIndex,
        pointIndex,
        fraction: projection.fraction,
        chainageMetres: segment.pointChainages[pointIndex]
          + distanceWgs84Metres(first, projected),
        projectedLatitude: projection.projectedLatitude,
        projectedLongitude: projection.projectedLongitude,
        distanceToCityMetres: distanceWgs84Metres(city, projected),
      });
    }
  }

  const orderedByDistance = candidates.sort((first, second) => (
    first.distanceToCityMetres - second.distanceToCityMetres
    || first.chainageMetres - second.chainageMetres
  ));
  const geographicallyDistinct = [];
  for (const candidate of orderedByDistance) {
    if (geographicallyDistinct.every((selected) => (
      Math.abs(selected.chainageMetres - candidate.chainageMetres)
        >= MINIMUM_CANDIDATE_SEPARATION_METRES
    ))) {
      geographicallyDistinct.push(candidate);
      if (
        geographicallyDistinct.length
        === MAXIMUM_CANDIDATES_PER_PASSAGE - NEAREST_CANDIDATES_PER_PASSAGE
      ) break;
    }
  }

  const selectedCandidates = [
    ...orderedByDistance.slice(0, NEAREST_CANDIDATES_PER_PASSAGE),
    ...geographicallyDistinct,
  ].filter((candidate, index, values) => (
    values.findIndex((item) => item === candidate) === index
  )).slice(0, MAXIMUM_CANDIDATES_PER_PASSAGE);

  return selectedCandidates
    .map((candidate) => ({
      ...candidate,
      candidateKey: candidateKey(source.sourceSha256, candidate),
    }));
}

function chooseOrderedCandidates(candidateSets) {
  const costs = [];
  const previousIndexes = [];
  costs[0] = candidateSets[0].map((candidate) => candidate.distanceToCityMetres);
  previousIndexes[0] = candidateSets[0].map(() => -1);

  for (let passageIndex = 1; passageIndex < candidateSets.length; passageIndex += 1) {
    costs[passageIndex] = candidateSets[passageIndex].map(() => Number.POSITIVE_INFINITY);
    previousIndexes[passageIndex] = candidateSets[passageIndex].map(() => -1);
    candidateSets[passageIndex].forEach((candidate, candidateIndex) => {
      candidateSets[passageIndex - 1].forEach((previous, previousIndex) => {
        if (previous.chainageMetres + ORDER_EPSILON_METRES > candidate.chainageMetres) return;
        const nextCost = costs[passageIndex - 1][previousIndex] + candidate.distanceToCityMetres;
        if (nextCost < costs[passageIndex][candidateIndex]) {
          costs[passageIndex][candidateIndex] = nextCost;
          previousIndexes[passageIndex][candidateIndex] = previousIndex;
        }
      });
    });
  }

  const lastCosts = costs[costs.length - 1];
  let selectedIndex = lastCosts.reduce(
    (best, value, index) => value < lastCosts[best] ? index : best,
    0
  );
  if (!Number.isFinite(lastCosts[selectedIndex])) {
    throw new Error('Aucune série d’ancrages ne respecte l’ordre des passages.');
  }
  const selected = new Array(candidateSets.length);
  for (let passageIndex = candidateSets.length - 1; passageIndex >= 0; passageIndex -= 1) {
    selected[passageIndex] = candidateSets[passageIndex][selectedIndex];
    selectedIndex = previousIndexes[passageIndex][selectedIndex];
  }
  return selected;
}

function proposeOrderedAnchors({ bytes, source, passages }) {
  if (!Array.isArray(passages) || passages.length < 2) {
    throw new Error('Au moins deux passages ordonnés sont requis.');
  }
  const parsedSource = source ?? parseOfficialGpxBytes(bytes);
  const candidateSets = passages.map((passage) => passageCandidates(parsedSource, passage));
  const selected = chooseOrderedCandidates(candidateSets);
  const anchors = selected.map((candidate, index) => {
    const ambiguityReasons = [];
    if (candidate.distanceToCityMetres > 1000) ambiguityReasons.push('distance_to_city_over_1000m');
    if (candidateSets[index].some((alternative) => (
      alternative.candidateKey !== candidate.candidateKey
      && alternative.distanceToCityMetres <= candidate.distanceToCityMetres + AMBIGUOUS_DISTANCE_DELTA_METRES
      && Math.abs(alternative.chainageMetres - candidate.chainageMetres)
        >= AMBIGUOUS_CHAINAGE_DELTA_METRES
    ))) {
      ambiguityReasons.push('competing_distant_occurrence');
    }
    return {
      passageIndex: passages[index].passageIndex,
      cityName: passages[index].city?.name ?? null,
      status: 'proposed',
      sourceSha256: parsedSource.sourceSha256,
      trackIndex: candidate.trackIndex,
      segmentIndex: candidate.segmentIndex,
      pointIndex: candidate.pointIndex,
      fraction: candidate.fraction,
      chainageMetres: candidate.chainageMetres,
      projectedLatitude: candidate.projectedLatitude,
      projectedLongitude: candidate.projectedLongitude,
      distanceToCityMetres: candidate.distanceToCityMetres,
      algorithmVersion: ALGORITHM_VERSION,
      candidateKey: candidate.candidateKey,
      ambiguityReasons,
      candidates: [
        candidate,
        ...candidateSets[index].filter((item) => item.candidateKey !== candidate.candidateKey),
      ].slice(0, 8),
    };
  });

  return {
    algorithmVersion: ALGORITHM_VERSION,
    sourceSha256: parsedSource.sourceSha256,
    pointCount: parsedSource.pointCount,
    distanceMetres: parsedSource.distanceMetres,
    anchors,
  };
}

module.exports = {
  ALGORITHM_VERSION,
  candidateKey,
  distanceWgs84Metres,
  parseOfficialGpxBytes,
  proposeOrderedAnchors,
};
