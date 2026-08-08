#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALGORITHM_VERSION,
  distanceWgs84Metres,
  hashCanonical,
  sha256Hex,
} from '../src/domain/catalogue-core';
import {
  buildAnchorKey,
  buildAnchorSemanticKey,
  buildBusinessKey,
  buildRevisionKey,
  buildRouteCityKey,
  computeArtifactIntegrityHash,
} from '../src/domain/catalogue-validation';
import { runAsCatalogueSystemMutation } from '../src/index';

const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ITINERARY_UID = 'api::city-itinerary.city-itinerary';
const REVISION_UID = 'api::itinerary-revision.itinerary-revision';
const ROUTE_UID = 'api::reference-route.reference-route';
const GLOBAL_UID = 'api::global.global';
const CITY_UID = 'api::city.city';
const CHAPTER_UID = 'api::chapter.chapter';
const ROUTE_CITY_UID = 'api::route-city.route-city';
const ANCHOR_UID = 'api::route-anchor.route-anchor';
const RUN_UID = 'api::catalogue-run.catalogue-run';
const REDIRECT_UID = 'api::itinerary-slug-redirect.itinerary-slug-redirect';
const FIXTURE_ROUTE_KEY = 'prd04-recette-locale';
const FIXTURE_ALGORITHM = 'catalogue-recipe-local-v2';
const FIXTURE_BUCKET = 'gthdf-catalogue-media';
const FIXTURE_MINIO_PORT = '59000';
export const LOCAL_FIXTURE_SLUG = 'ville-recette-a-a-ville-recette-b';
export const LOCAL_FIXTURE_REDIRECT_SLUG = 'ancienne-ville-recette-a-a-ville-recette-b';
const FIXTURE_ROUTE_VERTICES = Object.freeze([
  { latitude: 49.92, longitude: 4.08, elevation: 100 },
  { latitude: 49.92, longitude: 4.088, elevation: 104 },
  { latitude: 49.925, longitude: 4.095, elevation: 110 },
  { latitude: 49.932, longitude: 4.095, elevation: 112 },
  { latitude: 49.938, longitude: 4.089, elevation: 108 },
  { latitude: 49.94, longitude: 4.08, elevation: 105 },
  { latitude: 49.938, longitude: 4.071, elevation: 102 },
  { latitude: 49.932, longitude: 4.065, elevation: 98 },
  { latitude: 49.925, longitude: 4.065, elevation: 96 },
  { latitude: 49.92, longitude: 4.072, elevation: 98 },
] as const);

type FixturePoint = {
  latitude: number;
  longitude: number;
  elevation: number;
};

export type LocalFixtureChapterSource = {
  index: number;
  text: string;
  bytes: Uint8Array;
  sha256: string;
  start: FixturePoint;
  end: FixturePoint;
};

export type LocalFixtureAnchorSeed = {
  sourceSegmentIndex: number;
  sourcePointIndex: number;
  sourceFraction: 0;
  chainageMetres: number;
  projectedLatitude: number;
  projectedLongitude: number;
};

function fixtureGpxText(index: number, start: FixturePoint, end: FixturePoint): string {
  const point = (value: FixturePoint) => (
    `<trkpt lat="${value.latitude.toFixed(7)}" lon="${value.longitude.toFixed(7)}"><ele>${value.elevation.toFixed(2)}</ele></trkpt>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GTHF ${FIXTURE_ALGORITHM}" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>PRD04 recette chapitre ${index + 1}</name></metadata><trk><name>PRD04 recette chapitre ${index + 1}</name><trkseg>${point(start)}${point(end)}</trkseg></trk></gpx>\n`;
}

export function buildLocalFixtureRouteArtifacts(): {
  sources: LocalFixtureChapterSource[];
  anchors: [LocalFixtureAnchorSeed, LocalFixtureAnchorSeed];
  itineraryPoints: [FixturePoint, FixturePoint, FixturePoint];
  distanceMetres: number;
  directDistanceMetres: number;
} {
  const encoder = new TextEncoder();
  const sources = FIXTURE_ROUTE_VERTICES.map((start, index) => {
    const end = FIXTURE_ROUTE_VERTICES[(index + 1) % FIXTURE_ROUTE_VERTICES.length];
    const text = fixtureGpxText(index, start, end);
    const bytes = encoder.encode(text);
    return {
      index,
      text,
      bytes,
      sha256: sha256Hex(bytes),
      start: { ...start },
      end: { ...end },
    };
  });
  const [departure, intermediate, arrival] = FIXTURE_ROUTE_VERTICES;
  const firstLegMetres = distanceWgs84Metres(departure, intermediate);
  const secondLegMetres = distanceWgs84Metres(intermediate, arrival);
  return {
    sources,
    anchors: [
      {
        sourceSegmentIndex: 0,
        sourcePointIndex: 0,
        sourceFraction: 0,
        chainageMetres: 0,
        projectedLatitude: departure.latitude,
        projectedLongitude: departure.longitude,
      },
      {
        sourceSegmentIndex: 1,
        sourcePointIndex: 1,
        sourceFraction: 0,
        chainageMetres: firstLegMetres + secondLegMetres,
        projectedLatitude: arrival.latitude,
        projectedLongitude: arrival.longitude,
      },
    ],
    itineraryPoints: [
      { ...departure },
      { ...intermediate },
      { ...arrival },
    ],
    distanceMetres: firstLegMetres + secondLegMetres,
    directDistanceMetres: distanceWgs84Metres(departure, arrival),
  };
}

type RecipeOptions = {
  apply: boolean;
  confirmed: boolean;
  businessKey: string | null;
};

function recipeDebug(message: string): void {
  if (process.env.CATALOGUE_RECIPE_DEBUG === '1') {
    process.stderr.write(`[catalogue-recipe] ${message}\n`);
  }
}

export function parseRecipeArguments(argv: string[]): RecipeOptions {
  const options: RecipeOptions = { apply: false, confirmed: false, businessKey: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--confirm-local-recipe') options.confirmed = true;
    else if (argument === '--business-key') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--business-key exige une valeur.');
      options.businessKey = value;
      index += 1;
    } else if (argument === '--dry-run') options.apply = false;
    else throw new Error(`Option recette inconnue : ${argument}.`);
  }
  if (options.apply && !options.confirmed) {
    throw new Error('La recette locale exige --apply --confirm-local-recipe.');
  }
  if (!options.apply && options.confirmed) {
    throw new Error('--confirm-local-recipe est interdit en dry-run.');
  }
  return options;
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

export function assertLocalRecipeStorageEnvironment(environment = process.env): void {
  if (environment.CELLAR_ADDON_HOST || environment.CELLAR_ADDON_KEY_ID || environment.CELLAR_ADDON_KEY_SECRET) {
    throw new Error('La recette refuse toute configuration Cellar distante.');
  }
  if (environment.AWS_BUCKET !== FIXTURE_BUCKET) {
    throw new Error(`La recette exige le bucket MinIO local ${FIXTURE_BUCKET}.`);
  }

  let endpoint: URL;
  let cdn: URL;
  try {
    endpoint = new URL(environment.AWS_ENDPOINT ?? '');
    cdn = new URL(environment.AWS_CDN_URL ?? '');
  } catch {
    throw new Error('La recette exige des URL MinIO locales explicites.');
  }
  const endpointHost = normalizedHostname(endpoint.hostname);
  const cdnHost = normalizedHostname(cdn.hostname);
  if (
    endpoint.protocol !== 'http:'
    || endpoint.username
    || endpoint.password
    || !LOCAL_DATABASE_HOSTS.has(endpointHost)
    || endpoint.port !== FIXTURE_MINIO_PORT
    || !['', '/'].includes(endpoint.pathname)
    || endpoint.search
    || endpoint.hash
  ) {
    throw new Error(`La recette exige MinIO en HTTP loopback sur le port ${FIXTURE_MINIO_PORT}.`);
  }
  if (
    cdn.protocol !== 'http:'
    || cdn.username
    || cdn.password
    || !LOCAL_DATABASE_HOSTS.has(cdnHost)
    || cdn.port !== FIXTURE_MINIO_PORT
    || cdn.origin !== endpoint.origin
    || cdn.pathname.replace(/\/+$/, '') !== `/${FIXTURE_BUCKET}`
    || cdn.search
    || cdn.hash
  ) {
    throw new Error(`La recette exige le CDN MinIO loopback du bucket ${FIXTURE_BUCKET}.`);
  }
}

export function assertLocalRecipeEnvironment(environment = process.env): void {
  if (environment.NODE_ENV === 'production') {
    throw new Error('La recette catalogue est interdite avec NODE_ENV=production.');
  }
  if (environment.DATABASE_CLIENT !== 'postgres') {
    throw new Error('La recette exige explicitement DATABASE_CLIENT=postgres.');
  }
  for (const configuredUri of [environment.POSTGRESQL_ADDON_URI, environment.DATABASE_URL]) {
    if (!configuredUri) continue;
    let parsed: URL;
    try {
      parsed = new URL(configuredUri);
    } catch {
      throw new Error('La recette refuse une URI de base impossible à vérifier.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('La recette exige une URI PostgreSQL TCP explicite.');
    }
    if (!LOCAL_DATABASE_HOSTS.has(normalizedHostname(parsed.hostname))) {
      throw new Error(`La recette refuse la base non locale ${parsed.hostname}.`);
    }
  }
  for (const configuredHost of [environment.POSTGRESQL_ADDON_HOST, environment.DATABASE_HOST]) {
    if (!configuredHost) continue;
    const host = configuredHost;
    if (host.startsWith('/') || host.includes('\\')) {
      throw new Error('La recette refuse une socket/chemin de base non explicitement local.');
    }
    if (!LOCAL_DATABASE_HOSTS.has(normalizedHostname(host))) {
      throw new Error(`La recette refuse la base non locale ${host}.`);
    }
  }
  if (environment.CLEVER_APP_ID || environment.CLEVER_APPLICATION_ID) {
    throw new Error('La recette refuse un environnement Clever distant.');
  }
  assertLocalRecipeStorageEnvironment(environment);
}

export function configureLocalRecipeConnectionPool(environment = process.env): void {
  const configuredMaximum = Number(environment.DATABASE_POOL_MAX);
  if (!Number.isSafeInteger(configuredMaximum) || configuredMaximum < 10) {
    // Les publications D&P et leurs relations peuplées utilisent plusieurs
    // lectures parallèles. Trois connexions (défaut historique) peuvent créer
    // une famine du pool pendant ce script local autonome.
    environment.DATABASE_POOL_MAX = '10';
  }
}

type RecipePool = {
  numUsed(): number;
  numPendingAcquires(): number;
  numPendingCreates(): number;
  numPendingValidations(): number;
};

type RecipePoolIdleOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableSamples?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

function recipePool(app: any): RecipePool {
  const pool = app?.db?.connection?.client?.pool;
  for (const metric of [
    'numUsed',
    'numPendingAcquires',
    'numPendingCreates',
    'numPendingValidations',
  ]) {
    if (typeof pool?.[metric] !== 'function') {
      throw new Error(`Le pool PostgreSQL local n’expose pas la métrique ${metric}.`);
    }
  }
  return pool as RecipePool;
}

/**
 * Strapi 5.51 programme le deep-populate des événements Documents dans un
 * callback onCommit dont la promesse n’est pas attendue par le framework.
 * Une commande autonome doit donc laisser ces lectures finir avant de fermer
 * Knex, sinon app.destroy() peut vider le pool sous XtoOne.populateValue.
 */
export async function waitForLocalRecipeDatabaseIdle(
  app: any,
  options: RecipePoolIdleOptions = {},
): Promise<void> {
  const pool = recipePool(app);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const stableSamples = options.stableSamples ?? 3;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => (
    new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  ));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Le timeout d’attente du pool local doit être un entier positif.');
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('L’intervalle d’attente du pool local doit être un entier positif ou nul.');
  }
  if (!Number.isSafeInteger(stableSamples) || stableSamples < 2) {
    throw new Error('Le pool local doit être observé inactif au moins deux fois de suite.');
  }

  const deadline = now() + timeoutMs;
  let consecutiveIdleSamples = 0;
  do {
    // Toujours céder au moins un tour : les callbacks onCommit démarrent juste
    // après la résolution de l’opération Documents qui les a programmés.
    await sleep(pollIntervalMs);
    const active = pool.numUsed()
      + pool.numPendingAcquires()
      + pool.numPendingCreates()
      + pool.numPendingValidations();
    consecutiveIdleSamples = active === 0 ? consecutiveIdleSamples + 1 : 0;
    if (consecutiveIdleSamples >= stableSamples) return;
  } while (now() < deadline);

  throw new Error(
    `Le pool PostgreSQL local est resté actif plus de ${timeoutMs} ms après la recette.`,
  );
}

function fixtureBusinessKey(): string {
  return buildBusinessKey(FIXTURE_ROUTE_KEY, 'FR-PRD04-A', 'FR-PRD04-B');
}

function usableRevision(revision: any, expectedAlgorithm?: string): boolean {
  return Boolean(
    revision
    && (!expectedAlgorithm || revision.algorithmVersion === expectedAlgorithm)
    && ['ready', 'warning'].includes(revision.calculationStatus)
    && (revision.calculationStatus !== 'warning' || (
      revision.warningApproved === true
      && revision.warningApprovedAt
      && revision.warningApprovedBy
    ))
    && revision.artifactIntegrityStatus === 'verified'
    && /^[a-f0-9]{64}$/i.test(revision.artifactIntegrityHash ?? '')
    && /^[a-f0-9]{64}$/i.test(revision.lastVerifiedEvaluationHash ?? '')
    && revision.generatedGpx
    && revision.displayGeometry
    && (revision.eligibleByRoute === true || revision.eligibleByDirect === true)
  );
}

async function findCandidate(app: any, businessKey: string | null): Promise<{ itinerary: any; revision: any } | null> {
  const selectedBusinessKey = businessKey ?? fixtureBusinessKey();
  const filters = { businessKey: { $eq: selectedBusinessKey } };
  const expectedAlgorithm = selectedBusinessKey === fixtureBusinessKey()
    ? FIXTURE_ALGORITHM
    : undefined;
  const itineraries = await app.documents(ITINERARY_UID).findMany({
    status: 'draft',
    filters,
    pagination: { page: 1, pageSize: 100 },
    sort: ['businessKey:asc'],
    populate: {
      route: true,
      cityA: true,
      cityB: true,
      activeRevision: { populate: { generatedGpx: true, displayGeometry: true } },
      revisions: { populate: { generatedGpx: true, displayGeometry: true } },
    },
  });
  for (const itinerary of itineraries) {
    const revision = usableRevision(itinerary.activeRevision, expectedAlgorithm)
      ? itinerary.activeRevision
      : (itinerary.revisions ?? []).find((candidate: any) => usableRevision(candidate, expectedAlgorithm));
    if (revision) return { itinerary, revision };
  }
  return null;
}

async function uploadFixtureMedia(app: any, input: {
  name: string;
  mime: 'application/gpx+xml' | 'application/json';
  bytes: Uint8Array;
}): Promise<any> {
  const existing = await app.db.query('plugin::upload.file').findOne({ where: { name: input.name } });
  if (existing) return existing;
  const directory = await mkdtemp(join(tmpdir(), 'gthdf-catalogue-recipe-'));
  const filepath = join(directory, input.name);
  try {
    await writeFile(filepath, input.bytes, { flag: 'wx' });
    const result = await app.plugin('upload').service('upload').upload({
      files: {
        filepath,
        originalFileName: input.name,
        size: input.bytes.byteLength,
        mimetype: input.mime,
      },
      data: { fileInfo: { name: input.name, caption: 'PRD04 fixture locale — ne jamais copier en production' } },
    });
    return Array.isArray(result) ? result[0] : result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function requireLocalFixtureMediaId(media: any, label: string): number {
  if (!Number.isSafeInteger(media?.id) || media.id <= 0) {
    throw new Error(`Le média local ${label} ne possède pas d’id numérique Strapi.`);
  }
  return media.id;
}

export async function ensureLocalFixtureRedirect(app: any, itinerary: any): Promise<any> {
  if (!itinerary?.documentId) {
    throw new Error('La redirection locale exige le documentId de son itinéraire cible.');
  }
  const redirects = app.documents(REDIRECT_UID);
  const existing = (await redirects.findMany({
    filters: { oldSlug: { $eq: LOCAL_FIXTURE_REDIRECT_SLUG } },
    pagination: { page: 1, pageSize: 1 },
  }))[0];
  const data = {
    oldSlug: LOCAL_FIXTURE_REDIRECT_SLUG,
    itinerary: itinerary.documentId,
    enabled: true,
    reason: 'Fixture locale PRD04 pour vérifier la redirection permanente.',
  };
  return existing
    ? redirects.update({ documentId: existing.documentId, data })
    : redirects.create({ data });
}

async function ensureFixtureGlobal(app: any): Promise<any> {
  const existing = await app.db.query(GLOBAL_UID).findOne({ where: {} });
  if (existing) return existing;
  return app.documents(GLOBAL_UID).create({ data: {
    siteName: 'GTHF — recette locale PRD04',
    siteDescription: 'Configuration locale synthétique, interdite en production.',
    gpxBuilderEnabled: false,
    publishCityItinerariesToNext: false,
  } });
}

async function ensureFixtureCity(app: any, suffix: 'A' | 'B', latitude: number, longitude: number): Promise<any> {
  const municipalityKey = `FR-PRD04-${suffix}`;
  const existing = (await app.documents(CITY_UID).findMany({
    status: 'draft',
    filters: { municipalityKey: { $eq: municipalityKey } },
    pagination: { page: 1, pageSize: 1 },
  }))[0];
  if (existing) {
    const published = (await app.documents(CITY_UID).findMany({
      status: 'published', filters: { documentId: { $eq: existing.documentId } }, pagination: { page: 1, pageSize: 1 },
    }))[0];
    if (!published) await app.documents(CITY_UID).publish({ documentId: existing.documentId });
    return existing;
  }
  const city = await app.documents(CITY_UID).create({ status: 'draft', data: {
    name: `Ville recette ${suffix}`,
    slug: `ville-recette-prd04-${suffix.toLowerCase()}`,
    municipalityKey,
    countryCode: 'FR',
    municipalityCode: `PRD04-${suffix}`,
    administrativeArea: 'Fixture locale',
    latitude,
    longitude,
    coordinateSource: { source: 'fixture locale PRD04', date: '2026-08-07', method: 'coordonnées synthétiques' },
    hasPublicPage: true,
    shortDescription: 'Ville synthétique créée uniquement pour la recette locale PRD04.',
  } });
  await app.documents(CITY_UID).publish({ documentId: city.documentId });
  return city;
}

async function ensureFixtureChapters(
  app: any,
  cityA: any,
  cityB: any,
  sources: readonly LocalFixtureChapterSource[],
): Promise<Array<any>> {
  const sourceMedia: any[] = [];
  for (const source of sources) {
    sourceMedia.push(await uploadFixtureMedia(app, {
      name: `${source.sha256}-prd04-chapter-${source.index + 1}.gpx`,
      mime: 'application/gpx+xml',
      bytes: source.bytes,
    }));
  }
  const chapters: any[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const nextSource = sources[(index + 1) % sources.length];
    const slug = `prd04-recette-chapitre-${index + 1}`;
    let chapter = (await app.documents(CHAPTER_UID).findMany({
      status: 'draft', filters: { slug: { $eq: slug } }, pagination: { page: 1, pageSize: 1 },
    }))[0];
    const data = {
      title: `PRD04 recette — chapitre ${index + 1}`,
      slug,
      startStation: `Point recette ${index + 1}`,
      endStation: `Point recette ${(index + 1) % sources.length + 1}`,
      distance: Math.max(1, Math.round(distanceWgs84Metres(source.start, source.end) / 1_000)),
      displayOrder: index + 1,
      introSentence: 'Chapitre synthétique réservé à la recette locale PRD04.',
      cityPassages: [
        { city: cityA.documentId, role: 'start', featured: false },
        { city: cityB.documentId, role: 'end', featured: false },
      ],
      gpxFileAB: requireLocalFixtureMediaId(sourceMedia[index], `GPX chapitre ${index + 1}`),
      gpxJunctionAfterAB: {
        status: 'exact',
        sourceSha256: source.sha256,
        nextSourceSha256: nextSource.sha256,
        gapMetres: 0,
        reviewNote: 'Fixture locale déterministe',
      },
    };
    chapter = chapter
      ? await app.documents(CHAPTER_UID).update({ documentId: chapter.documentId, status: 'draft', data })
      : await app.documents(CHAPTER_UID).create({ status: 'draft', data });
    // Republier systématiquement répare une exécution interrompue ou une
    // ancienne version de fixture sans GPX, tout en gardant le même documentId.
    await app.documents(CHAPTER_UID).publish({ documentId: chapter.documentId });
    chapters.push({
      ...chapter,
      sourceSha256: source.sha256,
      nextSourceSha256: nextSource.sha256,
    });
  }
  return chapters;
}

export async function restoreLocalFixtureFingerprints(
  app: any,
  routeDocumentId: string,
  routeFingerprint: string,
  routeCities: any[],
): Promise<void> {
  await app.db.query(ROUTE_UID).updateMany({
    where: { documentId: routeDocumentId },
    data: { currentInputFingerprint: routeFingerprint },
  });
  for (const routeCity of routeCities) {
    await app.db.query(ROUTE_CITY_UID).update({
      where: { id: routeCity.id },
      data: { currentInputFingerprint: hashCanonical({ fixture: routeCity.routeCityKey, version: 2 }) },
    });
  }
}

async function createLocalFixture(app: any): Promise<{ itinerary: any; revision: any }> {
  return runAsCatalogueSystemMutation(async () => {
    recipeDebug('création/réparation de la fixture');
    const artifacts = buildLocalFixtureRouteArtifacts();
    const global = await ensureFixtureGlobal(app);
    const cityA = await ensureFixtureCity(
      app,
      'A',
      artifacts.itineraryPoints[0].latitude,
      artifacts.itineraryPoints[0].longitude,
    );
    const cityB = await ensureFixtureCity(
      app,
      'B',
      artifacts.itineraryPoints[2].latitude,
      artifacts.itineraryPoints[2].longitude,
    );
    const chapters = await ensureFixtureChapters(app, cityA, cityB, artifacts.sources);
    recipeDebug('chapitres et GPX publiés');
    const routeFingerprint = hashCanonical({
      fixture: FIXTURE_ROUTE_KEY,
      version: 2,
      sourceSha256: artifacts.sources.map((source) => source.sha256),
    });
    let route = (await app.documents(ROUTE_UID).findMany({
      status: 'draft', filters: { routeKey: { $eq: FIXTURE_ROUTE_KEY } }, pagination: { page: 1, pageSize: 1 },
    }))[0];
    const routeData = {
      name: 'Boucle recette locale PRD04',
      routeKey: FIXTURE_ROUTE_KEY,
      slug: FIXTURE_ROUTE_KEY,
      isLoop: true,
      catalogueEnabled: true,
      algorithmVersion: FIXTURE_ALGORITHM,
      sourceManifestHash: hashCanonical({
        fixture: 'manifest',
        version: 2,
        sourceSha256: artifacts.sources.map((source) => source.sha256),
      }),
      currentInputFingerprint: routeFingerprint,
      notes: 'Fixture synthétique locale. Ne jamais exporter.',
      segments: chapters.map((chapter) => ({
        chapter: chapter.documentId,
        direction: 'ab',
        sourceSha256: chapter.sourceSha256,
        nextSourceSha256: chapter.nextSourceSha256,
        junctionAfterStatus: 'exact',
        junctionAfterGapMetres: 0,
        junctionNote: 'Fixture locale déterministe',
      })),
    };
    route = route
      ? await app.documents(ROUTE_UID).update({ documentId: route.documentId, status: 'draft', data: routeData })
      : await app.documents(ROUTE_UID).create({ status: 'draft', data: routeData });
    recipeDebug('parcours draft écrit');
    await app.documents(ROUTE_UID).publish({ documentId: route.documentId });
    recipeDebug('parcours publié');

    const routeCities: any[] = [];
    const anchors: any[] = [];
    for (const [index, city] of [cityA, cityB].entries()) {
      const anchorSeed = artifacts.anchors[index];
      const routeCityKey = buildRouteCityKey(FIXTURE_ROUTE_KEY, city.municipalityKey);
      let routeCity = await app.db.query(ROUTE_CITY_UID).findOne({ where: { routeCityKey } });
      const routeCityFingerprint = hashCanonical({ fixture: routeCityKey, version: 2 });
      const routeCityData = {
        routeCityKey,
        route: route.documentId,
        city: city.documentId,
        qualificationStatus: 'validated',
        qualificationSourceHash: routeFingerprint,
        qualifiedAt: '2026-08-07T00:00:00.000Z',
        expectedOccurrences: 1,
        qualificationEvidence: { fixture: true },
        currentInputFingerprint: routeCityFingerprint,
      };
      routeCity = routeCity
        ? await app.documents(ROUTE_CITY_UID).update({ documentId: routeCity.documentId, data: routeCityData })
        : await app.documents(ROUTE_CITY_UID).create({ data: routeCityData });
      const source = artifacts.sources[anchorSeed.sourceSegmentIndex];
      const sourceHash = source.sha256;
      const semanticKey = buildAnchorSemanticKey(FIXTURE_ROUTE_KEY, city.municipalityKey, 0);
      const anchorKey = buildAnchorKey(semanticKey, sourceHash);
      let anchor = await app.db.query(ANCHOR_UID).findOne({ where: { anchorKey } });
      const anchorData = {
        anchorKey,
        anchorSemanticKey: semanticKey,
        routeCity: routeCity.documentId,
        occurrenceIndex: 0,
        chapter: chapters[anchorSeed.sourceSegmentIndex].documentId,
        sourceSegmentIndex: anchorSeed.sourceSegmentIndex,
        trackIndex: 0,
        sourceTrackSegmentIndex: 0,
        sourcePointIndex: anchorSeed.sourcePointIndex,
        sourceFraction: anchorSeed.sourceFraction,
        chainageMetres: anchorSeed.chainageMetres,
        projectedLatitude: anchorSeed.projectedLatitude,
        projectedLongitude: anchorSeed.projectedLongitude,
        distanceToTraceMetres: 0,
        sourceHash,
        algorithmVersion: ALGORITHM_VERSION.projection,
        validationStatus: 'validated',
        origin: 'computed',
        sourceDirection: 'ab',
        calculationReport: { fixture: true },
      };
      anchor = anchor
        ? await app.documents(ANCHOR_UID).update({ documentId: anchor.documentId, data: anchorData })
        : await app.documents(ANCHOR_UID).create({ data: anchorData });
      routeCities.push(routeCity);
      anchors.push(anchor);
    }
    recipeDebug('RouteCity et ancres validées');

    // RouteCity/RouteAnchor are catalogue source mutations and deliberately
    // invalidate all public fingerprints. The local fixture is already fully
    // materialised, so restore the exact synthetic fingerprints only after
    // the final source mutation, on both ReferenceRoute D&P versions.
    await restoreLocalFixtureFingerprints(app, route.documentId, routeFingerprint, routeCities);

    const businessKey = buildBusinessKey(FIXTURE_ROUTE_KEY, cityA.municipalityKey, cityB.municipalityKey);
    const sourceHash = hashCanonical({
      fixture: businessKey,
      version: 2,
      routeFingerprint,
      sourceSha256: artifacts.sources.slice(0, 2).map((source) => source.sha256),
    });
    const evaluationHash = hashCanonical({
      fixture: businessKey,
      evaluation: 2,
      routeFingerprint,
      routeCityFingerprints: routeCities.map((routeCity) => (
        hashCanonical({ fixture: routeCity.routeCityKey, version: 2 })
      )),
    });
    const revisionKey = buildRevisionKey(businessKey, sourceHash, FIXTURE_ALGORITHM);
    const pointXml = (point: FixturePoint) => (
      `<trkpt lat="${point.latitude.toFixed(7)}" lon="${point.longitude.toFixed(7)}"><ele>${point.elevation.toFixed(2)}</ele></trkpt>`
    );
    const gpxText = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GTHF ${FIXTURE_ALGORITHM}" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Ville recette A vers Ville recette B</name></metadata><trk><name>Ville recette A vers Ville recette B</name><trkseg>${artifacts.itineraryPoints.map(pointXml).join('')}</trkseg></trk></gpx>\n`;
    const firstChapterDistanceMetres = distanceWgs84Metres(
      artifacts.itineraryPoints[0],
      artifacts.itineraryPoints[1],
    );
    const secondChapterDistanceMetres = artifacts.distanceMetres - firstChapterDistanceMetres;
    const displayText = `${JSON.stringify({
      version: 1,
      revisionKey,
      algorithmVersion: FIXTURE_ALGORITHM,
      sequences: [{
        coordinates: artifacts.itineraryPoints.map((point) => [
          point.longitude,
          point.latitude,
          point.elevation,
        ]),
      }],
      elevationProfile: [{ sequenceIndex: 0, points: [
        { distanceMetres: 0, elevationMetres: 100 },
        { distanceMetres: firstChapterDistanceMetres, elevationMetres: 104 },
        { distanceMetres: artifacts.distanceMetres, elevationMetres: 110 },
      ] }],
    })}\n`;
    const gpxBytes = new TextEncoder().encode(gpxText);
    const displayBytes = new TextEncoder().encode(displayText);
    const generatedGpxSha256 = sha256Hex(gpxBytes);
    const displayGeometrySha256 = sha256Hex(displayBytes);
    const [gpxMedia, displayMedia] = await Promise.all([
      uploadFixtureMedia(app, { name: `${generatedGpxSha256}-recette-locale.gpx`, mime: 'application/gpx+xml', bytes: gpxBytes }),
      uploadFixtureMedia(app, { name: `${displayGeometrySha256}-recette-locale.json`, mime: 'application/json', bytes: displayBytes }),
    ]);
    let run = await app.db.query(RUN_UID).findOne({ where: { runKey: 'catalogue:recipe-local-v2' } });
    if (!run) run = await app.documents(RUN_UID).create({ data: {
      runKey: 'catalogue:recipe-local-v2',
      mode: 'apply',
      scope: { localOnly: true, recipe: true, businessKey },
      operator: 'catalogue-recipe-local',
      startedAt: '2026-08-07T00:00:00.000Z',
      completedAt: '2026-08-07T00:00:00.000Z',
      heartbeatAt: '2026-08-07T00:00:00.000Z',
      codeVersion: FIXTURE_ALGORITHM,
      inputHash: sourceHash,
      reportHash: evaluationHash,
      status: 'succeeded',
      cursor: '1',
      counters: { created: 1 },
      report: { version: 2, localOnly: true },
    } });
    let itinerary = (await app.documents(ITINERARY_UID).findMany({
      status: 'draft', filters: { businessKey: { $eq: businessKey } }, pagination: { page: 1, pageSize: 1 },
    }))[0];
    if (!itinerary) itinerary = await app.documents(ITINERARY_UID).create({ status: 'draft', data: {
      businessKey,
      title: 'Ville recette A – Ville recette B à vélo',
      slug: LOCAL_FIXTURE_SLUG,
      route: route.documentId,
      cityA: cityA.documentId,
      cityB: cityB.documentId,
      reviewStatus: 'approved',
      publicationNext: false,
      seoStatus: 'noindex',
      featuredOnCityPages: false,
      currentEvaluationHash: evaluationHash,
      introduction: 'Itinéraire synthétique local pour vérifier le rendu PRD04 via Tailscale.',
    } });
    let revision = await app.db.query(REVISION_UID).findOne({ where: { revisionKey } });
    if (!revision) revision = await app.documents(REVISION_UID).create({ data: {
      revisionKey,
      itinerary: itinerary.documentId,
      run: run.documentId,
      departure: cityA.documentId,
      arrival: cityB.documentId,
      departureAnchor: anchors[0].documentId,
      arrivalAnchor: anchors[1].documentId,
      distanceMetres: artifacts.distanceMetres,
      asTheCrowFliesMetres: artifacts.directDistanceMetres,
      elevationGainMetres: 10,
      elevationLossMetres: 0,
      elevationAvailable: true,
      eligibleByRoute: true,
      eligibleByDirect: true,
      detourRatio: artifacts.distanceMetres / artifacts.directDistanceMetres,
      usesLoopOrigin: false,
      junctionWarnings: [],
      chaptersOnRoute: [
        { chapter: chapters[0].documentId, routeOrder: 0, distanceMetres: firstChapterDistanceMetres, direction: 'ab' },
        { chapter: chapters[1].documentId, routeOrder: 1, distanceMetres: secondChapterDistanceMetres, direction: 'ab' },
      ],
      citiesOnRoute: [
        { city: cityA.documentId, routeOrder: 0, occurrenceIndex: 0, chainageFromDepartureMetres: 0 },
        { city: cityB.documentId, routeOrder: 1, occurrenceIndex: 0, chainageFromDepartureMetres: artifacts.distanceMetres },
      ],
      generatedGpx: requireLocalFixtureMediaId(gpxMedia, 'GPX itinéraire'),
      generatedGpxSha256,
      generatedGpxObjectKey: String(gpxMedia.url).replace(/^\/+/, ''),
      displayGeometry: requireLocalFixtureMediaId(displayMedia, 'géométrie itinéraire'),
      displayGeometrySha256,
      displayGeometryObjectKey: String(displayMedia.url).replace(/^\/+/, ''),
      sourceHash,
      lastVerifiedEvaluationHash: evaluationHash,
      lastVerifiedRun: run.documentId,
      algorithmVersion: FIXTURE_ALGORITHM,
      calculationStatus: 'ready',
      warningApproved: false,
      artifactIntegrityStatus: 'verified',
      artifactIntegrityHash: computeArtifactIntegrityHash({ sourceHash, generatedGpxSha256, displayGeometrySha256 }),
      calculationReport: { version: 2, fixture: true },
    } });
    recipeDebug('révision prête');
    itinerary = await app.documents(ITINERARY_UID).update({
      documentId: itinerary.documentId,
      status: 'draft',
      data: {
        activeRevision: revision.documentId,
        reviewStatus: 'approved',
        publicationNext: true,
        seoStatus: 'noindex',
        currentEvaluationHash: evaluationHash,
      },
    });
    await app.documents(ITINERARY_UID).publish({ documentId: itinerary.documentId });
    await ensureLocalFixtureRedirect(app, itinerary);
    recipeDebug('itinéraire publié');
    await app.documents(GLOBAL_UID).update({
      documentId: global.documentId,
      data: { publishCityItinerariesToNext: true },
    });
    return { itinerary, revision };
  });
}

export async function runCatalogueRecipe(argv = process.argv.slice(2)): Promise<number> {
  const options = parseRecipeArguments(argv);
  assertLocalRecipeEnvironment();
  configureLocalRecipeConnectionPool();
  const { compileStrapi, createStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';
  let operationError: unknown = null;
  try {
    let candidate = await findCandidate(app, options.businessKey);
    if (!candidate && !options.apply) {
      const businessKey = buildBusinessKey(FIXTURE_ROUTE_KEY, 'FR-PRD04-A', 'FR-PRD04-B');
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        action: 'create_local_fixture',
        localOnly: true,
        seoStatus: 'noindex',
        businessKey,
        slug: LOCAL_FIXTURE_SLUG,
        redirectSlug: LOCAL_FIXTURE_REDIRECT_SLUG,
        nextCommand: 'npm run catalogue:recipe -- --apply --confirm-local-recipe',
      }, null, 2)}\n`);
      return 0;
    }
    const createdFixture = !candidate;
    if (!candidate) candidate = await createLocalFixture(app);
    const { itinerary, revision } = candidate;
    const result = {
      mode: options.apply ? 'apply' : 'dry-run',
      businessKey: itinerary.businessKey,
      slug: itinerary.slug,
      redirectSlug: LOCAL_FIXTURE_REDIRECT_SLUG,
      revisionKey: revision.revisionKey,
      calculationStatus: revision.calculationStatus,
      routeKey: itinerary.route?.routeKey ?? (createdFixture ? FIXTURE_ROUTE_KEY : undefined),
    };
    if (createdFixture) {
      process.stdout.write(`${JSON.stringify({ ...result, status: 'published-local', seoStatus: 'noindex' }, null, 2)}\n`);
      return 0;
    }
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({
        ...result,
        nextCommand: `npm run catalogue:recipe -- --apply --confirm-local-recipe --business-key ${itinerary.businessKey}`,
      }, null, 2)}\n`);
      return 0;
    }
    if (!itinerary.route?.documentId) throw new Error('Le parcours de la révision locale est absent.');
    const publishedRoute = await app.db.query(ROUTE_UID).findOne({
      where: { documentId: itinerary.route.documentId, publishedAt: { $ne: null } },
    });
    const routeFingerprint = itinerary.route.currentInputFingerprint ?? publishedRoute?.currentInputFingerprint;
    if (!routeFingerprint) throw new Error('Le parcours doit porter currentInputFingerprint avant la recette.');
    const routeDocuments = app.documents(ROUTE_UID);
    await runAsCatalogueSystemMutation(() => routeDocuments.update({
      documentId: itinerary.route.documentId,
      status: 'draft',
      data: { catalogueEnabled: true, currentInputFingerprint: routeFingerprint },
    }));
    await routeDocuments.publish({ documentId: itinerary.route.documentId });

    const global = await app.db.query(GLOBAL_UID).findOne({ where: {} });
    if (!global) throw new Error('Le Global Strapi local est absent; créez les réglages du site avant la recette.');
    await app.documents(GLOBAL_UID).update({
      documentId: global.documentId,
      data: { publishCityItinerariesToNext: true },
    });

    const itineraryDocuments = app.documents(ITINERARY_UID);
    await runAsCatalogueSystemMutation(() => itineraryDocuments.update({
      documentId: itinerary.documentId,
      status: 'draft',
      data: {
        activeRevision: revision.documentId,
        reviewStatus: 'approved',
        publicationNext: true,
        seoStatus: 'noindex',
        currentEvaluationHash: revision.lastVerifiedEvaluationHash,
      },
    }));
    await itineraryDocuments.publish({ documentId: itinerary.documentId });
    await ensureLocalFixtureRedirect(app, itinerary);
    process.stdout.write(`${JSON.stringify({ ...result, status: 'published-local' }, null, 2)}\n`);
    return 0;
  } catch (error) {
    operationError = error;
    recipeDebug(`échec: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw error;
  } finally {
    let shutdownError: unknown = null;
    try {
      await waitForLocalRecipeDatabaseIdle(app);
    } catch (error) {
      shutdownError = error;
    }
    try {
      await app.destroy();
    } catch (error) {
      shutdownError ??= error;
    }
    if (shutdownError) {
      // Ne jamais masquer l’erreur métier initiale avec l’annulation d’une
      // connexion encore en attente pendant la fermeture de Strapi.
      if (!operationError) throw shutdownError;
    }
  }
}

if (require.main === module) {
  runCatalogueRecipe().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
