import {
  ALGORITHM_VERSION,
  hashCanonical,
  recomposeRouteAnchorPosition,
  type CatalogueAnchor,
  type CatalogueRouteSegment,
} from './catalogue-core';

const SHA_256 = /^[a-f0-9]{64}$/i;
const KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type UnknownRecord = Record<string, any>;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireKeyPart(label: string, value: unknown): string {
  if (!nonEmptyString(value) || !KEY_PART.test(value)) {
    throw new Error(`${label} est invalide pour une clé métier.`);
  }
  return value;
}

function requireCompositeKey(label: string, value: unknown): string {
  if (
    !nonEmptyString(value)
    || !value.split(':').every((part) => KEY_PART.test(part))
  ) {
    throw new Error(`${label} est invalide pour une clé métier composite.`);
  }
  return value;
}

function requireSha256(label: string, value: unknown): string {
  if (!nonEmptyString(value) || !SHA_256.test(value)) {
    throw new Error(`L’empreinte ${label} est absente ou invalide.`);
  }
  return value.toLowerCase();
}

function relationIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (!value || typeof value !== 'object') return null;
  const relation = value as UnknownRecord;
  if (typeof relation.documentId === 'string' && relation.documentId.trim()) return relation.documentId;
  if (typeof relation.id === 'number' && Number.isInteger(relation.id) && relation.id > 0) return String(relation.id);
  if ('connect' in relation) return relationIdentifier(relation.connect);
  if ('set' in relation) return relationIdentifier(relation.set);
  if (Array.isArray(value)) return relationIdentifier(value[0]);
  return null;
}

function hasMedia(value: unknown): boolean {
  return relationIdentifier(value) !== null
    || (typeof value === 'object' && value !== null && nonEmptyString((value as UnknownRecord).url));
}

export function buildRouteCityKey(routeKey: string, municipalityKey: string): string {
  return `${requireKeyPart('routeKey', routeKey)}:${requireKeyPart('municipalityKey', municipalityKey)}`;
}

export function buildAnchorSemanticKey(
  routeKey: string,
  municipalityKey: string,
  occurrenceIndex: number,
): string {
  if (!Number.isSafeInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new Error('occurrenceIndex doit être un entier positif ou nul.');
  }
  return `${buildRouteCityKey(routeKey, municipalityKey)}:occurrence:${occurrenceIndex}`;
}

export function buildAnchorKey(anchorSemanticKey: string, sourceHash: string): string {
  if (!nonEmptyString(anchorSemanticKey) || !anchorSemanticKey.includes(':occurrence:')) {
    throw new Error('anchorSemanticKey est invalide.');
  }
  return `${anchorSemanticKey}:${requireSha256('sourceHash', sourceHash)}`;
}

export function buildBusinessKey(
  routeKey: string,
  firstMunicipalityKey: string,
  secondMunicipalityKey: string,
): string {
  const route = requireKeyPart('routeKey', routeKey);
  const cities = [
    requireKeyPart('municipalityKey', firstMunicipalityKey),
    requireKeyPart('municipalityKey', secondMunicipalityKey),
  ].sort((first, second) => first.localeCompare(second));
  if (cities[0] === cities[1]) throw new Error('Une paire métier doit contenir deux communes distinctes.');
  return `${route}:${cities[0]}:${cities[1]}`;
}

export function buildRevisionKey(
  businessKey: string,
  sourceHash: string,
  algorithmVersion: string,
): string {
  if (!nonEmptyString(businessKey) || !nonEmptyString(algorithmVersion)) {
    throw new Error('La businessKey et la version d’algorithme sont requises.');
  }
  return `${businessKey}:${requireSha256('sourceHash', sourceHash)}:${algorithmVersion}`;
}

export function validateAnchorIdentity(value: {
  anchorSemanticKey?: unknown;
  anchorKey?: unknown;
  sourceHash?: unknown;
  occurrenceIndex?: unknown;
  routeCity?: UnknownRecord;
}): void {
  if (!Number.isSafeInteger(value.occurrenceIndex) || Number(value.occurrenceIndex) < 0) {
    throw new Error('occurrenceIndex est invalide.');
  }
  if (!nonEmptyString(value.anchorSemanticKey)) throw new Error('anchorSemanticKey est requis.');
  const expected = buildAnchorKey(value.anchorSemanticKey, requireSha256('sourceHash', value.sourceHash));
  if (value.anchorKey !== expected) {
    throw new Error('anchorKey doit contenir anchorSemanticKey puis le sourceHash exact.');
  }
  if (value.routeCity?.route?.routeKey && value.routeCity?.city?.municipalityKey) {
    const semantic = buildAnchorSemanticKey(
      value.routeCity.route.routeKey,
      value.routeCity.city.municipalityKey,
      Number(value.occurrenceIndex),
    );
    if (value.anchorSemanticKey !== semantic) {
      throw new Error('anchorSemanticKey doit correspondre exactement aux relations route/ville et à occurrenceIndex.');
    }
  }
}

export type PublishedAnchorRouteSegment = CatalogueRouteSegment & {
  chapterDocumentId: string;
};

function requiredFiniteAnchorNumber(label: string, value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    throw new Error(`${label} est requis pour recomposer l’ancre.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} est invalide pour recomposer l’ancre.`);
  return parsed;
}

export function validateAnchorAgainstPublishedRoute(
  value: UnknownRecord,
  route: readonly PublishedAnchorRouteSegment[],
  city: { latitude?: unknown; longitude?: unknown },
): void {
  if (value.validationStatus !== 'validated') return;
  if (value.sourceDirection !== 'ab') throw new Error('Une ancre catalogue validée doit référencer la source AB publiée.');
  if (value.algorithmVersion !== ALGORITHM_VERSION.projection) {
    throw new Error(`Une ancre catalogue validée doit utiliser ${ALGORITHM_VERSION.projection}.`);
  }
  const routeSegmentIndex = requiredFiniteAnchorNumber('sourceSegmentIndex', value.sourceSegmentIndex);
  const segment = route[routeSegmentIndex];
  if (!Number.isSafeInteger(routeSegmentIndex) || !segment || segment.index !== routeSegmentIndex) {
    throw new Error('sourceSegmentIndex ne référence aucun chapitre publié du parcours.');
  }
  const chapterDocumentId = relationIdentifier(value.chapter);
  if (!chapterDocumentId || chapterDocumentId !== segment.chapterDocumentId) {
    throw new Error('La relation chapter ne correspond pas au segment du parcours publié.');
  }
  const anchor: CatalogueAnchor = {
    anchorKey: String(value.anchorKey ?? ''),
    routeSegmentIndex,
    sourceSha256: requireSha256('sourceHash', value.sourceHash),
    trackIndex: requiredFiniteAnchorNumber('trackIndex', value.trackIndex),
    segmentIndex: requiredFiniteAnchorNumber('sourceTrackSegmentIndex', value.sourceTrackSegmentIndex),
    pointIndex: requiredFiniteAnchorNumber('sourcePointIndex', value.sourcePointIndex),
    fraction: requiredFiniteAnchorNumber('sourceFraction', value.sourceFraction),
    chainageMetres: requiredFiniteAnchorNumber('chainageMetres', value.chainageMetres),
    projectedLatitude: requiredFiniteAnchorNumber('projectedLatitude', value.projectedLatitude),
    projectedLongitude: requiredFiniteAnchorNumber('projectedLongitude', value.projectedLongitude),
    status: 'validated',
  };
  recomposeRouteAnchorPosition({
    route,
    anchor,
    cityPoint: {
      latitude: requiredFiniteAnchorNumber('city.latitude', city.latitude),
      longitude: requiredFiniteAnchorNumber('city.longitude', city.longitude),
    },
    storedDistanceToTraceMetres: requiredFiniteAnchorNumber(
      'distanceToTraceMetres',
      value.distanceToTraceMetres,
    ),
  });
}

export function validateRouteCityIdentity(value: UnknownRecord): void {
  const routeKey = value.route?.routeKey;
  const municipalityKey = value.city?.municipalityKey;
  const expected = buildRouteCityKey(routeKey, municipalityKey);
  if (value.routeCityKey !== expected) {
    throw new Error('routeCityKey doit correspondre exactement aux relations route et city.');
  }
}

export function computeEvaluationHash(input: {
  routeFingerprint: unknown;
  routeCities: Array<{ routeCityKey: string; fingerprint: unknown }>;
  algorithmVersion: string;
  routeThresholdMetres?: number;
  directThresholdMetres?: number;
}): string {
  const routeFingerprint = requireSha256('du parcours', input.routeFingerprint);
  if (!nonEmptyString(input.algorithmVersion)) throw new Error('La version d’algorithme est requise.');
  if (!Array.isArray(input.routeCities) || input.routeCities.length !== 2) {
    throw new Error('Deux empreintes RouteCity sont requises pour une évaluation.');
  }
  const routeCities = input.routeCities.map((routeCity) => ({
    routeCityKey: requireCompositeKey('routeCityKey', routeCity.routeCityKey),
    fingerprint: requireSha256(`de ${routeCity.routeCityKey}`, routeCity.fingerprint),
  })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey));
  return hashCanonical({
    version: 1,
    routeFingerprint,
    routeCities,
    algorithmVersion: input.algorithmVersion,
    routeThresholdMetres: input.routeThresholdMetres ?? 60_000,
    directThresholdMetres: input.directThresholdMetres ?? 40_000,
  });
}

export function computeArtifactIntegrityHash(input: {
  sourceHash: unknown;
  generatedGpxSha256: unknown;
  displayGeometrySha256: unknown;
}): string {
  return hashCanonical({
    version: 1,
    sourceHash: requireSha256('sourceHash', input.sourceHash),
    generatedGpxSha256: requireSha256('du GPX généré', input.generatedGpxSha256),
    displayGeometrySha256: requireSha256('de la géométrie d’affichage', input.displayGeometrySha256),
  });
}

export type PublishedPrd03Junction = {
  chapterDocumentId: string;
  direction: 'ab' | 'ba';
  status: 'proposed' | 'exact' | 'accepted_gap' | 'blocked' | 'stale';
  gapMetres: number;
  sourceSha256: string;
  nextSourceSha256: string;
  reviewNote?: string | null;
};

export function validateReferenceRouteForPublication(
  route: UnknownRecord,
  publishedPrd03Junctions: readonly PublishedPrd03Junction[],
): void {
  requireKeyPart('routeKey', route.routeKey);
  requireKeyPart('slug', route.slug);
  if (route.isLoop !== true || !Array.isArray(route.segments) || route.segments.length !== 10) {
    throw new Error('Le parcours publié doit être une boucle de dix segments ordonnés.');
  }
  const seenChapters = new Set<string>();
  for (const [index, segment] of route.segments.entries()) {
    const chapterDocumentId = relationIdentifier(segment.chapter);
    if (!chapterDocumentId || seenChapters.has(chapterDocumentId)) {
      throw new Error(`Le segment ${index + 1} référence un chapitre absent ou dupliqué.`);
    }
    seenChapters.add(chapterDocumentId);
    if (!['ab', 'ba'].includes(segment.direction)) throw new Error(`Le sens du segment ${index + 1} est invalide.`);
    const prd03 = publishedPrd03Junctions.find((junction) => (
      junction.chapterDocumentId === chapterDocumentId && junction.direction === segment.direction
    ));
    if (!prd03) throw new Error(`La jonction PRD03 publiée du segment ${index + 1} est absente.`);
    const note = nonEmptyString(segment.junctionNote) ? segment.junctionNote.trim() : null;
    const prd03Note = nonEmptyString(prd03.reviewNote) ? prd03.reviewNote.trim() : null;
    if (
      requireSha256(`source du segment ${index + 1}`, segment.sourceSha256) !== requireSha256(`source PRD03 du segment ${index + 1}`, prd03.sourceSha256)
      || requireSha256(`source suivante du segment ${index + 1}`, segment.nextSourceSha256) !== requireSha256(`source suivante PRD03 du segment ${index + 1}`, prd03.nextSourceSha256)
      ||
      segment.junctionAfterStatus !== prd03.status
      || segment.junctionAfterGapMetres !== prd03.gapMetres
      || note !== prd03Note
    ) {
      throw new Error(`La jonction du segment ${index + 1} doit reprendre exactement la décision PRD03 publiée.`);
    }
    if (route.catalogueEnabled === true && !['exact', 'accepted_gap'].includes(prd03.status)) {
      throw new Error(`Le catalogue ne peut pas être activé avec la jonction ${prd03.status} du segment ${index + 1}.`);
    }
  }
  if (route.catalogueEnabled === true) {
    requireSha256('du manifeste source', route.sourceManifestHash);
    requireSha256('courante du parcours', route.currentInputFingerprint);
  }
}

export function validateWarningApproval(revision: UnknownRecord): void {
  if (revision.calculationStatus === 'warning') {
    const approvalStarted = revision.warningApproved === true
      || nonEmptyString(revision.warningApprovedAt)
      || nonEmptyString(revision.warningApprovedBy);
    // Le job crée volontairement les warnings non approuvées. Elles restent
    // fermées jusqu’à une décision humaine complète et atomique.
    if (!approvalStarted) return;
    if (revision.warningApproved !== true) throw new Error('Une révision warning doit être explicitement approuvée.');
    if (!nonEmptyString(revision.warningApprovedAt)) throw new Error('Une date d’approbation est requise pour une révision warning.');
    if (!Number.isFinite(Date.parse(revision.warningApprovedAt))) throw new Error('La date d’approbation warning est invalide.');
    if (!nonEmptyString(revision.warningApprovedBy)) throw new Error('L’opérateur ayant approuvé la warning est requis.');
    return;
  }
  if (
    revision.calculationStatus === 'ready'
    && (revision.warningApproved === true || nonEmptyString(revision.warningApprovedAt) || nonEmptyString(revision.warningApprovedBy))
  ) {
    throw new Error('Une révision ready ne doit pas conserver une approbation warning.');
  }
}

function validateRevisionForPublicUse(revision: UnknownRecord): void {
  if (!['ready', 'warning'].includes(revision.calculationStatus)) {
    throw new Error('La révision active doit être ready ou warning approuvée.');
  }
  if (revision.calculationStatus === 'warning' && revision.warningApproved !== true) {
    throw new Error('Une révision warning doit être explicitement approuvée avant usage public.');
  }
  validateWarningApproval(revision);
  if (revision.eligibleByRoute !== true && revision.eligibleByDirect !== true) {
    throw new Error('La révision active ne respecte aucun critère d’éligibilité.');
  }
  if (!hasMedia(revision.generatedGpx) || !hasMedia(revision.displayGeometry)) {
    throw new Error('Les deux artefacts calculés sont requis.');
  }
  const expectedIntegrity = computeArtifactIntegrityHash({
    sourceHash: revision.sourceHash,
    generatedGpxSha256: revision.generatedGpxSha256,
    displayGeometrySha256: revision.displayGeometrySha256,
  });
  if (revision.artifactIntegrityStatus !== 'verified' || revision.artifactIntegrityHash !== expectedIntegrity) {
    throw new Error('L’intégrité binaire des artefacts n’est pas vérifiée.');
  }
  requireSha256('de dernière revérification', revision.lastVerifiedEvaluationHash);
}

export function isCatalogueRevisionPubliclyCurrent(itinerary: UnknownRecord): boolean {
  try {
    if (itinerary.reviewStatus !== 'approved' || itinerary.publicationNext !== true) return false;
    const currentEvaluationHash = requireSha256('courante de l’itinéraire', itinerary.currentEvaluationHash);
    if (!itinerary.activeRevision || typeof itinerary.activeRevision !== 'object') return false;
    validateRevisionForPublicUse(itinerary.activeRevision);
    return itinerary.activeRevision.lastVerifiedEvaluationHash === currentEvaluationHash;
  } catch {
    return false;
  }
}

export function validateCityItineraryForPublication(itinerary: UnknownRecord): void {
  if (itinerary.publicationNext !== true) return;
  if (itinerary.reviewStatus !== 'approved') throw new Error('Un itinéraire publié vers Next doit être approuvé.');
  const currentHash = requireSha256('courante de l’itinéraire', itinerary.currentEvaluationHash);
  if (!nonEmptyString(itinerary.title) || !nonEmptyString(itinerary.slug)) {
    throw new Error('Le titre et le slug sont requis avant publication vers Next.');
  }
  const routeKey = itinerary.route?.routeKey;
  const municipalityA = itinerary.cityA?.municipalityKey;
  const municipalityB = itinerary.cityB?.municipalityKey;
  const expectedBusinessKey = buildBusinessKey(routeKey, municipalityA, municipalityB);
  if (itinerary.businessKey !== expectedBusinessKey) throw new Error('La businessKey ne correspond pas à la paire triée.');
  if (itinerary.route?.catalogueEnabled !== true) throw new Error('Le parcours doit être activé pour le catalogue.');
  const revision = itinerary.activeRevision;
  if (!revision || typeof revision !== 'object') throw new Error('Une révision active est requise.');
  validateRevisionForPublicUse(revision);
  if (revision.lastVerifiedEvaluationHash !== currentHash) {
    throw new Error('La révision active ne correspond pas à l’empreinte courante.');
  }
  const departureKey = revision.departure?.municipalityKey;
  const arrivalKey = revision.arrival?.municipalityKey;
  if (buildBusinessKey(routeKey, departureKey, arrivalKey) !== expectedBusinessKey) {
    throw new Error('La direction de révision ne correspond pas à la paire métier.');
  }
  const revisionBusinessKey = revision.itinerary?.businessKey;
  if (revisionBusinessKey && revisionBusinessKey !== itinerary.businessKey) {
    throw new Error('La révision active appartient à un autre itinéraire.');
  }
}

const IMMUTABLE_REVISION_FIELDS = [
  'revisionKey',
  'itinerary',
  'run',
  'departure',
  'arrival',
  'departureAnchor',
  'arrivalAnchor',
  'distanceMetres',
  'asTheCrowFliesMetres',
  'elevationGainMetres',
  'elevationLossMetres',
  'elevationAvailable',
  'eligibleByRoute',
  'eligibleByDirect',
  'detourRatio',
  'usesLoopOrigin',
  'junctionWarnings',
  'chaptersOnRoute',
  'citiesOnRoute',
  'generatedGpx',
  'generatedGpxSha256',
  'generatedGpxObjectKey',
  'displayGeometry',
  'displayGeometrySha256',
  'displayGeometryObjectKey',
  'sourceHash',
  'algorithmVersion',
] as const;

function comparable(value: unknown): string {
  if (value === undefined) return '__undefined__';
  if (value && typeof value === 'object') {
    const identifier = relationIdentifier(value);
    if (identifier) return `relation:${identifier}`;
  }
  return JSON.stringify(value);
}

export function validateRevisionImmutability(
  previous: UnknownRecord | null | undefined,
  next: UnknownRecord,
): void {
  if (!previous || !nonEmptyString(previous.revisionKey)) return;
  for (const field of IMMUTABLE_REVISION_FIELDS) {
    if (next[field] === undefined) continue;
    if (comparable(previous[field]) !== comparable(next[field])) {
      throw new Error(`Le champ calculé ${field} d’une révision prête est immuable.`);
    }
  }
}

export const SYSTEM_MANAGED_FIELDS: Record<string, readonly string[]> = Object.freeze({
  'api::reference-route.reference-route': [
    'routeKey',
    'slug',
    'isLoop',
    'algorithmVersion',
    'segments',
    'sourceManifestHash',
    'currentInputFingerprint',
    'routeCities',
    'itineraries',
  ],
  'api::route-city.route-city': [
    'routeCityKey',
    'route',
    'city',
    'expectedOccurrences',
    'qualificationEvidence',
    'qualificationSourceHash',
    'currentInputFingerprint',
    'anchors',
  ],
  'api::route-anchor.route-anchor': [
    'anchorKey',
    'anchorSemanticKey',
    'routeCity',
    'occurrenceIndex',
    'chapter',
    'sourceSegmentIndex',
    'trackIndex',
    'sourceTrackSegmentIndex',
    'sourcePointIndex',
    'sourceFraction',
    'chainageMetres',
    'projectedLatitude',
    'projectedLongitude',
    'distanceToTraceMetres',
    'sourceHash',
    'algorithmVersion',
    'origin',
    'sourceDirection',
    'calculationReport',
  ],
  'api::city-itinerary.city-itinerary': [
    'businessKey',
    'slug',
    'route',
    'cityA',
    'cityB',
    'currentEvaluationHash',
    'revisions',
  ],
  'api::itinerary-revision.itinerary-revision': [
    'revisionKey',
    'itinerary',
    'run',
    'departure',
    'arrival',
    'departureAnchor',
    'arrivalAnchor',
    'distanceMetres',
    'asTheCrowFliesMetres',
    'elevationGainMetres',
    'elevationLossMetres',
    'elevationAvailable',
    'eligibleByRoute',
    'eligibleByDirect',
    'detourRatio',
    'usesLoopOrigin',
    'junctionWarnings',
    'chaptersOnRoute',
    'citiesOnRoute',
    'generatedGpx',
    'calculationStatus',
    'generatedGpxSha256',
    'generatedGpxObjectKey',
    'displayGeometry',
    'displayGeometrySha256',
    'displayGeometryObjectKey',
    'sourceHash',
    'lastVerifiedEvaluationHash',
    'lastVerifiedRun',
    'algorithmVersion',
    'artifactIntegrityStatus',
    'artifactIntegrityHash',
    'calculationReport',
  ],
  'api::catalogue-run.catalogue-run': [
    'runKey',
    'mode',
    'scope',
    'operator',
    'startedAt',
    'completedAt',
    'heartbeatAt',
    'lockExpiresAt',
    'leaseOwner',
    'codeVersion',
    'inputHash',
    'reportHash',
    'status',
    'cursor',
    'counters',
    'errorSummary',
    'report',
  ],
});

export function validateNoManualSystemFieldMutation(uid: string, data: UnknownRecord): void {
  const fields = SYSTEM_MANAGED_FIELDS[uid] ?? [];
  const changed = fields.filter((field) => Object.prototype.hasOwnProperty.call(data, field));
  if (changed.length > 0) {
    throw new Error(`Les champs système ${changed.join(', ')} sont modifiés uniquement par le job catalogue.`);
  }
}
