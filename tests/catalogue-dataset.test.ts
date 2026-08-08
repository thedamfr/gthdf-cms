import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCatalogueThresholdQaCsv,
  type CatalogueThresholdClassification,
} from '../src/domain/catalogue-dataset';

const HEADERS = [
  'ID produit',
  'ID commune A',
  'Pays A',
  'Code commune A',
  'Code INSEE A',
  'Ville A',
  'ID commune B',
  'Pays B',
  'Code commune B',
  'Code INSEE B',
  'Ville B',
  'Slug',
  'Titre produit',
  'Distance itinéraire (m)',
  'Distance vol d’oiseau (m)',
  'Retenu comme produit',
  'Itinéraire < 60 km',
  'Vol d’oiseau < 40 km',
  'Marge seuil itinéraire (m)',
  'Marge seuil vol d’oiseau (m)',
  'À ±250 m du seuil itinéraire',
  'À ±250 m du seuil vol d’oiseau',
  'Classification',
  'Chapitre ancre A',
  'Chapitre ancre B',
  'Chaînage ancre A (m)',
  'Chaînage ancre B (m)',
  'Plus court chemin via origine',
  'Pas echantillonnage m',
  'Commerce proche A',
  'Commerce proche B',
  'Commerce A → trace (m)',
  'Commerce B → trace (m)',
  'Contrôle qualité',
  'Source trace GPX',
] as const;

type FixtureRow = Record<(typeof HEADERS)[number], string | number | boolean>;

function classification(eligibleByRoute: boolean, eligibleByDirect: boolean): CatalogueThresholdClassification {
  if (eligibleByRoute && eligibleByDirect) return 'Les deux critères';
  if (eligibleByRoute) return 'Itinéraire uniquement';
  if (eligibleByDirect) return 'Vol d’oiseau uniquement';
  return 'Non retenu';
}

function fixtureRow(index: number, distanceMetres: number, directMetres: number): FixtureRow {
  const municipalityCodeA = String(10_000 + index);
  const municipalityCodeB = String(20_000 + index);
  const municipalityKeyA = `FR-${municipalityCodeA}`;
  const municipalityKeyB = `FR-${municipalityCodeB}`;
  const eligibleByRoute = distanceMetres < 60_000;
  const eligibleByDirect = directMetres < 40_000;
  const routeMargin = 60_000 - distanceMetres;
  const directMargin = 40_000 - directMetres;
  return {
    'ID produit': `${municipalityKeyA}__${municipalityKeyB}`,
    'ID commune A': municipalityKeyA,
    'Pays A': 'FR',
    'Code commune A': municipalityCodeA,
    'Code INSEE A': municipalityCodeA,
    'Ville A': `Ville A ${index}`,
    'ID commune B': municipalityKeyB,
    'Pays B': 'FR',
    'Code commune B': municipalityCodeB,
    'Code INSEE B': municipalityCodeB,
    'Ville B': `Ville B ${index}`,
    Slug: `qa-${index}`,
    'Titre produit': `QA ${index}`,
    'Distance itinéraire (m)': distanceMetres,
    'Distance vol d’oiseau (m)': directMetres,
    'Retenu comme produit': eligibleByRoute || eligibleByDirect,
    'Itinéraire < 60 km': eligibleByRoute,
    'Vol d’oiseau < 40 km': eligibleByDirect,
    'Marge seuil itinéraire (m)': routeMargin,
    'Marge seuil vol d’oiseau (m)': directMargin,
    'À ±250 m du seuil itinéraire': Math.abs(routeMargin) <= 250,
    'À ±250 m du seuil vol d’oiseau': Math.abs(directMargin) <= 250,
    Classification: classification(eligibleByRoute, eligibleByDirect),
    'Chapitre ancre A': 'Chapitre A',
    'Chapitre ancre B': 'Chapitre B',
    'Chaînage ancre A (m)': 1_000 + index,
    'Chaînage ancre B (m)': 2_000 + index,
    'Plus court chemin via origine': false,
    'Pas echantillonnage m': 10,
    'Commerce proche A': 'Commerce A',
    'Commerce proche B': 'Commerce B',
    'Commerce A → trace (m)': 12.5,
    'Commerce B → trace (m)': 25,
    'Contrôle qualité': 'Cas de seuil contrôlé',
    'Source trace GPX': 'https://cms.gthf.fr',
  };
}

function controlledQaRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (let index = 0; index < 4; index += 1) rows.push(fixtureRow(rows.length, 59_900, 39_900));
  for (let index = 0; index < 3; index += 1) rows.push(fixtureRow(rows.length, 59_900, 40_251));
  for (let index = 0; index < 30; index += 1) rows.push(fixtureRow(rows.length, 60_251, 39_900));
  rows.push(fixtureRow(rows.length, 60_000, 40_000));
  for (let index = 1; index < 33; index += 1) rows.push(fixtureRow(rows.length, 60_251, 40_251));
  return rows;
}

function escapeCsv(value: string | number | boolean): string {
  const serialized = String(value);
  return /[",\n]/.test(serialized) ? `"${serialized.replace(/"/g, '""')}"` : serialized;
}

function csvBytes(rows: FixtureRow[]): Uint8Array {
  const csv = [
    HEADERS.join(','),
    ...rows.map((row) => HEADERS.map((header) => escapeCsv(row[header])).join(',')),
  ].join('\n');
  return new TextEncoder().encode(csv);
}

test('la QA seuils est typée, classée et conserve les marges strictes ±250 m', () => {
  const rows = parseCatalogueThresholdQaCsv(csvBytes(controlledQaRows()), 70);
  const retained = rows.filter((row) => row.retained);
  const classifications = Object.fromEntries([
    'Les deux critères',
    'Itinéraire uniquement',
    'Vol d’oiseau uniquement',
    'Non retenu',
  ].map((value) => [value, rows.filter((row) => row.classification === value).length]));

  assert.equal(rows.length, 70);
  assert.equal(retained.length, 37);
  assert.equal(rows.length - retained.length, 33);
  assert.deepEqual(classifications, {
    'Les deux critères': 4,
    'Itinéraire uniquement': 3,
    'Vol d’oiseau uniquement': 30,
    'Non retenu': 33,
  });

  const exactThreshold = rows.find((row) => row.slug === 'qa-37');
  assert.ok(exactThreshold);
  assert.equal(exactThreshold.eligibleByRoute, false);
  assert.equal(exactThreshold.eligibleByDirect, false);
  assert.equal(exactThreshold.retained, false);
  assert.equal(exactThreshold.routeMarginMetres, 0);
  assert.equal(exactThreshold.directMarginMetres, 0);
  assert.equal(exactThreshold.withinRouteThresholdMargin, true);
  assert.equal(exactThreshold.withinDirectThresholdMargin, true);
});

test('la QA seuils rejette une classification ou une marge incohérente', () => {
  const wrongClassification = controlledQaRows();
  wrongClassification[0].Classification = 'Non retenu';
  assert.throws(
    () => parseCatalogueThresholdQaCsv(csvBytes(wrongClassification), 70),
    /seuils, marges, rétention ou classification incohérents/,
  );

  const wrongMargin = controlledQaRows();
  wrongMargin[0]['Marge seuil itinéraire (m)'] = 99;
  assert.throws(
    () => parseCatalogueThresholdQaCsv(csvBytes(wrongMargin), 70),
    /seuils, marges, rétention ou classification incohérents/,
  );
});

test('la QA contrôlée refuse une répartition différente de 37 retenus et 33 exclus', () => {
  const rows = controlledQaRows();
  rows[36] = fixtureRow(36, 60_251, 40_251);
  assert.throws(
    () => parseCatalogueThresholdQaCsv(csvBytes(rows), 70),
    /37 retenus et 33 exclus; reçu 70\/36\/34/,
  );
});
