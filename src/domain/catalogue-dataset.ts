import { parse } from 'csv-parse/sync';

import { hashCanonical, sha256Hex } from './catalogue-core';

const SHA_256 = /^[a-f0-9]{64}$/;
export const CONTROLLED_DATASET_MANIFEST_SHA256 = '9f046a459d9a6fb8271e06c586b7969e88021c5d482b67db6bae5644774503be';
export const CONTROLLED_DATASET_XLSX_SHA256 = 'dc7c251553907bf98ea444f79840cc52f9b702989353b241eaa083bb24d240a2';
const EXPECTED_SHEETS = new Set(['Synthèse', 'Villes', 'Produits', 'QA seuils', 'Chapitres', 'Méthode']);
const ROUTE_THRESHOLD_METRES = 60_000;
const DIRECT_THRESHOLD_METRES = 40_000;
const THRESHOLD_QA_MARGIN_METRES = 250;
const EXPECTED_THRESHOLD_QA_RETAINED = 37;
const EXPECTED_THRESHOLD_QA_EXCLUDED = 33;

export type CatalogueDatasetCity = {
  municipalityKey: string;
  countryCode: string;
  municipalityCode: string;
  name: string;
  administrativeArea: string;
  longitude: number;
  latitude: number;
  coordinateSource: Record<string, unknown>;
  expectedOccurrences: number;
  firstChapterLabel: string;
  firstChainageMetres: number;
  qualificationEvidence: Record<string, unknown>;
};

export type CatalogueDatasetChapter = {
  slug: string;
  label: string;
  sourceSha256: string;
  distanceMetres: number;
};

export type CatalogueDatasetProduct = {
  productId: string;
  municipalityKeyA: string;
  municipalityKeyB: string;
  slug: string;
  title: string;
  distanceMetres: number;
  directMetres: number;
  retained: boolean;
};

export type CatalogueThresholdClassification =
  | 'Les deux critères'
  | 'Itinéraire uniquement'
  | 'Vol d’oiseau uniquement'
  | 'Non retenu';

export type CatalogueDatasetThresholdQaRow = CatalogueDatasetProduct & {
  countryCodeA: string;
  municipalityCodeA: string;
  inseeCodeA: string | null;
  cityNameA: string;
  countryCodeB: string;
  municipalityCodeB: string;
  inseeCodeB: string | null;
  cityNameB: string;
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
  routeMarginMetres: number;
  directMarginMetres: number;
  withinRouteThresholdMargin: boolean;
  withinDirectThresholdMargin: boolean;
  classification: CatalogueThresholdClassification;
  anchorChapterA: string;
  anchorChapterB: string;
  anchorChainageMetresA: number;
  anchorChainageMetresB: number;
  shortestPathViaOrigin: boolean;
  samplingStepMetres: number;
  nearbyShopA: string;
  nearbyShopB: string;
  shopDistanceToTraceMetresA: number;
  shopDistanceToTraceMetresB: number;
  qualityControl: string;
  sourceTraceGpx: string;
};

export type ControlledCatalogueDataset = {
  datasetHash: string;
  sourceSha256: string;
  manifest: Record<string, any>;
  cities: CatalogueDatasetCity[];
  chapters: CatalogueDatasetChapter[];
  products: CatalogueDatasetProduct[];
  thresholdQa: CatalogueDatasetThresholdQaRow[];
};

export type CatalogueDatasetFiles = Record<string, Uint8Array>;

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function requiredString(row: Record<string, unknown>, field: string, context: string): string {
  const value = String(row[field] ?? '').trim();
  if (!value) throw new Error(`${context} : colonne « ${field} » absente ou vide.`);
  return value;
}

function optionalString(row: Record<string, unknown>, field: string): string | null {
  const value = String(row[field] ?? '').trim();
  return value || null;
}

function finite(row: Record<string, unknown>, field: string, context: string): number {
  const value = Number(row[field]);
  if (!Number.isFinite(value)) throw new Error(`${context} : colonne « ${field} » non numérique.`);
  return value;
}

function integer(row: Record<string, unknown>, field: string, context: string): number {
  const value = finite(row, field, context);
  if (!Number.isSafeInteger(value)) throw new Error(`${context} : colonne « ${field} » non entière.`);
  return value;
}

function bool(row: Record<string, unknown>, field: string, context: string): boolean {
  const value = requiredString(row, field, context);
  if (value !== 'true' && value !== 'false') throw new Error(`${context} : colonne « ${field} » doit valoir true ou false.`);
  return value === 'true';
}

function controlledInventoryCount(manifest: Record<string, any>, field: string): number {
  const value = manifest.inventory?.[field];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Le manifeste contrôlé doit définir inventory.${field} comme entier positif ou nul.`);
  }
  return value;
}

function parseCsv(bytes: Uint8Array, label: string): Array<Record<string, string>> {
  try {
    return parse(Buffer.from(bytes), { bom: true, columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    throw new Error(`Le CSV contrôlé ${label} est invalide.${detail}`);
  }
}

function requireFile(files: CatalogueDatasetFiles, path: string): Uint8Array {
  const bytes = files[path];
  if (!bytes) throw new Error(`Le fichier contrôlé ${path} est absent.`);
  return bytes;
}

function assertControlledFile(path: string, bytes: Uint8Array, expected: Record<string, any>): void {
  if (expected.bytes !== bytes.byteLength || expected.sha256 !== sha256Hex(bytes)) {
    throw new Error(`Le fichier ${path} ne correspond pas au manifeste (taille/SHA-256).`);
  }
}

function readCities(rows: Array<Record<string, string>>, sourceSha256: string): CatalogueDatasetCity[] {
  const seen = new Set<string>();
  const cities = rows.map((row, index) => {
    const context = `Villes ligne ${index + 2}`;
    const municipalityKey = requiredString(row, 'ID commune', context);
    const countryCode = requiredString(row, 'Pays', context);
    const municipalityCode = requiredString(row, 'Code commune', context);
    if (municipalityKey !== `${countryCode}-${municipalityCode}` || !['FR', 'BE'].includes(countryCode)) {
      throw new Error(`${context} : identité administrative incohérente (${municipalityKey}).`);
    }
    if (seen.has(municipalityKey)) throw new Error(`${context} : municipalityKey dupliquée.`);
    seen.add(municipalityKey);
    const expectedOccurrences = integer(row, 'Nombre de passages', context);
    const latitude = finite(row, 'Latitude ancre', context);
    const longitude = finite(row, 'Longitude ancre', context);
    if (expectedOccurrences < 1 || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      throw new Error(`${context} : occurrences ou coordonnées invalides.`);
    }
    const osmIds = String(row['Identifiants OSM'] ?? '').split(';').map((value) => value.trim()).filter(Boolean);
    return {
      municipalityKey,
      countryCode,
      municipalityCode,
      name: requiredString(row, 'Ville', context),
      administrativeArea: requiredString(row, 'Département / province', context),
      longitude,
      latitude,
      coordinateSource: {
        datasetSha256: sourceSha256,
        label: requiredString(row, 'Source ancre communale', context),
        sourceUrl: requiredString(row, 'Source commune', context),
        importedValueOnly: true,
      },
      expectedOccurrences,
      firstChapterLabel: requiredString(row, 'Premier chapitre', context),
      firstChainageMetres: finite(row, 'Chaînage premier passage (m)', context),
      qualificationEvidence: {
        version: 1,
        datasetSha256: sourceSha256,
        admissibleShopCount: integer(row, 'Commerces admissibles', context),
        bakeryCount: integer(row, 'Boulangeries', context),
        convenienceCount: integer(row, 'Supérettes', context),
        supermarketCount: integer(row, 'Supermarchés', context),
        nearestShopDistanceToTraceMetres: finite(row, 'Commerce → trace (m)', context),
        shopSourceUrl: requiredString(row, 'Source commerces', context),
        osmIds,
        onlyPetrolStation: bool(row, 'Uniquement station-service', context),
        overTwoKilometresWarning: bool(row, 'Alerte commerce > 2 km', context),
      },
    };
  });
  if (cities.length !== 223) throw new Error(`L’inventaire doit contenir 223 communes, reçu ${cities.length}.`);
  const occurrenceCount = cities.reduce((sum, city) => sum + city.expectedOccurrences, 0);
  if (occurrenceCount !== 449) throw new Error(`L’inventaire doit annoncer 449 occurrences, reçu ${occurrenceCount}.`);
  const french = cities.filter((city) => city.countryCode === 'FR').length;
  const belgian = cities.filter((city) => city.countryCode === 'BE').length;
  if (french !== 217 || belgian !== 6) throw new Error(`L’inventaire doit contenir 217 FR et 6 BE, reçu ${french} FR/${belgian} BE.`);
  return cities.sort((first, second) => first.municipalityKey.localeCompare(second.municipalityKey));
}

function readChapters(rows: Array<Record<string, string>>): CatalogueDatasetChapter[] {
  const seen = new Set<string>();
  const chapters = rows.map((row, index) => {
    const context = `Chapitres ligne ${index + 2}`;
    const slug = requiredString(row, 'Slug chapitre', context);
    const sourceSha256 = requiredString(row, 'SHA-256 GPX', context).toLowerCase();
    if (!SHA_256.test(sourceSha256) || seen.has(slug)) throw new Error(`${context} : slug dupliqué ou SHA-256 invalide.`);
    seen.add(slug);
    const distanceMetres = finite(row, 'Distance GPX (m)', context);
    if (distanceMetres <= 0) throw new Error(`${context} : distance GPX invalide.`);
    return { slug, label: requiredString(row, 'Chapitre', context), sourceSha256, distanceMetres };
  });
  if (chapters.length !== 10) throw new Error(`Le parcours contrôlé doit contenir dix chapitres, reçu ${chapters.length}.`);
  return chapters;
}

function readProducts(rows: Array<Record<string, string>>, expectedCount: number): CatalogueDatasetProduct[] {
  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  const products = rows.map((row, index) => {
    const context = `Produits ligne ${index + 2}`;
    const productId = requiredString(row, 'ID produit', context);
    const municipalityKeyA = requiredString(row, 'ID commune A', context);
    const municipalityKeyB = requiredString(row, 'ID commune B', context);
    const pair = [municipalityKeyA, municipalityKeyB].sort().join('__');
    if (seenIds.has(productId) || seenPairs.has(pair) || municipalityKeyA === municipalityKeyB) {
      throw new Error(`${context} : identifiant ou paire dupliqué/invalide.`);
    }
    seenIds.add(productId);
    seenPairs.add(pair);
    return {
      productId,
      municipalityKeyA,
      municipalityKeyB,
      slug: requiredString(row, 'Slug', context),
      title: requiredString(row, 'Titre produit', context),
      distanceMetres: finite(row, 'Distance itinéraire (m)', context),
      directMetres: finite(row, 'Distance vol d’oiseau (m)', context),
      retained: bool(row, 'Retenu comme produit', context),
    };
  });
  if (products.length !== expectedCount || products.some((product) => !product.retained)) {
    throw new Error(`Le référentiel produit doit contenir exactement les ${expectedCount} paires retenues annoncées par le manifeste.`);
  }
  return products.sort((first, second) => first.productId.localeCompare(second.productId));
}

function thresholdClassification(eligibleByRoute: boolean, eligibleByDirect: boolean): CatalogueThresholdClassification {
  if (eligibleByRoute && eligibleByDirect) return 'Les deux critères';
  if (eligibleByRoute) return 'Itinéraire uniquement';
  if (eligibleByDirect) return 'Vol d’oiseau uniquement';
  return 'Non retenu';
}

function nearlyEqual(first: number, second: number): boolean {
  return Math.abs(first - second) <= 1e-6;
}

function readThresholdQa(rows: Array<Record<string, string>>): CatalogueDatasetThresholdQaRow[] {
  const classifications = new Set<CatalogueThresholdClassification>([
    'Les deux critères',
    'Itinéraire uniquement',
    'Vol d’oiseau uniquement',
    'Non retenu',
  ]);
  const seenIds = new Set<string>();
  const qaRows = rows.map((row, index) => {
    const context = `QA seuils ligne ${index + 2}`;
    const productId = requiredString(row, 'ID produit', context);
    const municipalityKeyA = requiredString(row, 'ID commune A', context);
    const municipalityKeyB = requiredString(row, 'ID commune B', context);
    const countryCodeA = requiredString(row, 'Pays A', context);
    const municipalityCodeA = requiredString(row, 'Code commune A', context);
    const countryCodeB = requiredString(row, 'Pays B', context);
    const municipalityCodeB = requiredString(row, 'Code commune B', context);
    if (seenIds.has(productId) || municipalityKeyA === municipalityKeyB) {
      throw new Error(`${context} : identifiant dupliqué ou paire invalide.`);
    }
    if (
      municipalityKeyA !== `${countryCodeA}-${municipalityCodeA}`
      || municipalityKeyB !== `${countryCodeB}-${municipalityCodeB}`
      || !['FR', 'BE'].includes(countryCodeA)
      || !['FR', 'BE'].includes(countryCodeB)
    ) {
      throw new Error(`${context} : identité administrative incohérente.`);
    }
    seenIds.add(productId);

    const distanceMetres = finite(row, 'Distance itinéraire (m)', context);
    const directMetres = finite(row, 'Distance vol d’oiseau (m)', context);
    const retained = bool(row, 'Retenu comme produit', context);
    const eligibleByRoute = bool(row, 'Itinéraire < 60 km', context);
    const eligibleByDirect = bool(row, 'Vol d’oiseau < 40 km', context);
    const routeMarginMetres = finite(row, 'Marge seuil itinéraire (m)', context);
    const directMarginMetres = finite(row, 'Marge seuil vol d’oiseau (m)', context);
    const withinRouteThresholdMargin = bool(row, 'À ±250 m du seuil itinéraire', context);
    const withinDirectThresholdMargin = bool(row, 'À ±250 m du seuil vol d’oiseau', context);
    const classification = requiredString(row, 'Classification', context) as CatalogueThresholdClassification;
    if (!classifications.has(classification)) {
      throw new Error(`${context} : classification inconnue « ${classification} ».`);
    }

    const expectedEligibleByRoute = distanceMetres < ROUTE_THRESHOLD_METRES;
    const expectedEligibleByDirect = directMetres < DIRECT_THRESHOLD_METRES;
    const expectedRouteMargin = ROUTE_THRESHOLD_METRES - distanceMetres;
    const expectedDirectMargin = DIRECT_THRESHOLD_METRES - directMetres;
    const expectedClassification = thresholdClassification(expectedEligibleByRoute, expectedEligibleByDirect);
    if (
      eligibleByRoute !== expectedEligibleByRoute
      || eligibleByDirect !== expectedEligibleByDirect
      || retained !== (expectedEligibleByRoute || expectedEligibleByDirect)
      || !nearlyEqual(routeMarginMetres, expectedRouteMargin)
      || !nearlyEqual(directMarginMetres, expectedDirectMargin)
      || withinRouteThresholdMargin !== (Math.abs(expectedRouteMargin) <= THRESHOLD_QA_MARGIN_METRES)
      || withinDirectThresholdMargin !== (Math.abs(expectedDirectMargin) <= THRESHOLD_QA_MARGIN_METRES)
      || classification !== expectedClassification
    ) {
      throw new Error(`${context} : seuils, marges, rétention ou classification incohérents.`);
    }

    const samplingStepMetres = finite(row, 'Pas echantillonnage m', context);
    if (distanceMetres < 0 || directMetres < 0 || samplingStepMetres <= 0) {
      throw new Error(`${context} : distance ou pas d’échantillonnage invalide.`);
    }
    return {
      productId,
      municipalityKeyA,
      municipalityKeyB,
      countryCodeA,
      municipalityCodeA,
      inseeCodeA: optionalString(row, 'Code INSEE A'),
      cityNameA: requiredString(row, 'Ville A', context),
      countryCodeB,
      municipalityCodeB,
      inseeCodeB: optionalString(row, 'Code INSEE B'),
      cityNameB: requiredString(row, 'Ville B', context),
      slug: requiredString(row, 'Slug', context),
      title: requiredString(row, 'Titre produit', context),
      distanceMetres,
      directMetres,
      retained,
      eligibleByRoute,
      eligibleByDirect,
      routeMarginMetres,
      directMarginMetres,
      withinRouteThresholdMargin,
      withinDirectThresholdMargin,
      classification,
      anchorChapterA: requiredString(row, 'Chapitre ancre A', context),
      anchorChapterB: requiredString(row, 'Chapitre ancre B', context),
      anchorChainageMetresA: finite(row, 'Chaînage ancre A (m)', context),
      anchorChainageMetresB: finite(row, 'Chaînage ancre B (m)', context),
      shortestPathViaOrigin: bool(row, 'Plus court chemin via origine', context),
      samplingStepMetres,
      nearbyShopA: requiredString(row, 'Commerce proche A', context),
      nearbyShopB: requiredString(row, 'Commerce proche B', context),
      shopDistanceToTraceMetresA: finite(row, 'Commerce A → trace (m)', context),
      shopDistanceToTraceMetresB: finite(row, 'Commerce B → trace (m)', context),
      qualityControl: requiredString(row, 'Contrôle qualité', context),
      sourceTraceGpx: requiredString(row, 'Source trace GPX', context),
    };
  });
  return qaRows.sort((first, second) => first.productId.localeCompare(second.productId));
}

/** Parse et vérifie les cas de bord contrôlés autour des seuils catalogue. */
export function parseCatalogueThresholdQaCsv(
  bytes: Uint8Array,
  expectedRowCount: number,
): CatalogueDatasetThresholdQaRow[] {
  if (!Number.isSafeInteger(expectedRowCount) || expectedRowCount < 0) {
    throw new Error('Le nombre de lignes QA attendu doit être un entier positif ou nul.');
  }
  const rows = readThresholdQa(parseCsv(bytes, 'QA seuils'));
  const retained = rows.filter((row) => row.retained).length;
  const excluded = rows.length - retained;
  if (
    rows.length !== expectedRowCount
    || retained !== EXPECTED_THRESHOLD_QA_RETAINED
    || excluded !== EXPECTED_THRESHOLD_QA_EXCLUDED
  ) {
    throw new Error(
      `La QA seuils doit contenir ${expectedRowCount} cas, dont ${EXPECTED_THRESHOLD_QA_RETAINED} retenus et ${EXPECTED_THRESHOLD_QA_EXCLUDED} exclus; reçu ${rows.length}/${retained}/${excluded}.`,
    );
  }
  return rows;
}

/** Vérifie les octets exportés et transforme le XLSX en contrat runtime JSON/CSV. */
export function parseControlledCatalogueDataset(files: CatalogueDatasetFiles): ControlledCatalogueDataset {
  const manifestBytes = requireFile(files, 'manifest.json');
  if (sha256Hex(manifestBytes) !== CONTROLLED_DATASET_MANIFEST_SHA256) {
    throw new Error('Le manifeste ne correspond pas au lot PRD04 versionné. Toute évolution exige une nouvelle constante auditée.');
  }
  const manifest = JSON.parse(text(manifestBytes)) as Record<string, any>;
  if (manifest.schemaVersion !== 1 || manifest.dataset !== 'GTHF_villes_et_produits_SEO') {
    throw new Error('Le manifeste du dataset catalogue est inconnu.');
  }
  const sourcePath = String(manifest.source?.file ?? '');
  if (manifest.source?.sha256 !== CONTROLLED_DATASET_XLSX_SHA256) {
    throw new Error('Le SHA-256 du classeur ne correspond pas au classeur PRD04 audité.');
  }
  const sourceBytes = requireFile(files, sourcePath);
  assertControlledFile(sourcePath, sourceBytes, manifest.source);
  const sheets = new Map<string, Record<string, any>>();
  if (
    !Array.isArray(manifest.sheets)
    || manifest.sheets.length !== EXPECTED_SHEETS.size
    || manifest.sheets.some((sheet: Record<string, unknown>) => !EXPECTED_SHEETS.has(String(sheet.sheet)))
  ) {
    throw new Error('Le manifeste doit contenir exactement les six feuilles PRD04 attendues.');
  }
  for (const sheet of manifest.sheets ?? []) {
    const path = String(sheet.csv ?? '');
    const bytes = requireFile(files, path);
    assertControlledFile(path, bytes, sheet);
    if (Array.isArray(sheet.headers)) {
      const rows = parseCsv(bytes, sheet.sheet);
      if (rows.length !== sheet.records || Object.keys(rows[0] ?? {}).join('\u0000') !== sheet.headers.join('\u0000')) {
        throw new Error(`La feuille ${sheet.sheet} ne respecte pas ses en-têtes ou son inventaire contrôlé.`);
      }
    }
    sheets.set(sheet.sheet, { ...sheet, bytes });
  }
  const citiesSheet = sheets.get('Villes');
  const productsSheet = sheets.get('Produits');
  const chaptersSheet = sheets.get('Chapitres');
  const thresholdQaSheet = sheets.get('QA seuils');
  if (!citiesSheet || !productsSheet || !chaptersSheet || !thresholdQaSheet) {
    throw new Error('Les feuilles Villes, Produits, QA seuils et Chapitres sont requises.');
  }
  const expectedProducts = controlledInventoryCount(manifest, 'products');
  const expectedThresholdQaRows = controlledInventoryCount(manifest, 'thresholdQaRows');
  const cities = readCities(parseCsv(citiesSheet.bytes, 'Villes'), manifest.source.sha256);
  const chapters = readChapters(parseCsv(chaptersSheet.bytes, 'Chapitres'));
  const products = readProducts(parseCsv(productsSheet.bytes, 'Produits'), expectedProducts);
  const thresholdQa = parseCatalogueThresholdQaCsv(thresholdQaSheet.bytes, expectedThresholdQaRows);
  if (
    manifest.inventory?.cities !== cities.length
    || manifest.inventory?.products !== products.length
    || manifest.inventory?.chapters !== chapters.length
    || manifest.inventory?.thresholdQaRows !== thresholdQa.length
    || thresholdQaSheet.records !== thresholdQa.length
    || sheets.get('Méthode')?.records !== manifest.inventory?.methodRules
  ) {
    throw new Error('Les inventaires calculés ne correspondent pas au manifeste.');
  }
  const fileHashes = [...sheets.values()].map((sheet) => ({
    sheet: sheet.sheet,
    sha256: sheet.sha256,
    bytes: sheet.bytes.byteLength,
  })).sort((first, second) => first.sheet.localeCompare(second.sheet));
  return {
    datasetHash: hashCanonical({ version: 1, sourceSha256: manifest.source.sha256, fileHashes }),
    sourceSha256: manifest.source.sha256,
    manifest,
    cities,
    chapters,
    products,
    thresholdQa,
  };
}
