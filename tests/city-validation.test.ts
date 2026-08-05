import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAlternativeNames,
  validateCityCoordinates,
  validateCityForPublication,
  validateStableCityIdentity,
} from '../src/domain/city-validation.ts';

test('normalizeAlternativeNames trims every alternative name', () => {
  assert.deepEqual(
    normalizeAlternativeNames(['  St Omer ', 'Saint-Omer']),
    ['St Omer', 'Saint-Omer']
  );
});

test('normalizeAlternativeNames rejects empty alternative names', () => {
  assert.throws(
    () => normalizeAlternativeNames(['Saint-Omer', '   ']),
    /ne peut pas être vide/
  );
});

test('normalizeAlternativeNames rejects duplicates regardless of case or accents', () => {
  assert.throws(
    () => normalizeAlternativeNames(['Saint-Omer', 'saint-ômer']),
    /dupliqué/
  );
});

test('normalizeAlternativeNames rejects non-string values', () => {
  assert.throws(
    () => normalizeAlternativeNames(['Saint-Omer', 62500]),
    /uniquement des textes/
  );
});

test('validateCityCoordinates rejects a partial coordinate pair', () => {
  assert.throws(
    () => validateCityCoordinates({ latitude: 50.75 }),
    /latitude et la longitude doivent être renseignées ensemble/
  );
});

test('validateCityCoordinates rejects coordinates outside geographic bounds', () => {
  assert.throws(
    () => validateCityCoordinates({ latitude: 91, longitude: 2.25 }),
    /latitude doit être comprise entre -90 et 90/
  );
});

test('validateCityCoordinates requires provenance for a coordinate pair', () => {
  assert.throws(
    () => validateCityCoordinates({ latitude: 50.75, longitude: 2.25 }),
    /provenance des coordonnées est obligatoire/
  );
});

test('validateCityCoordinates requires source, date and method in provenance', () => {
  assert.throws(
    () => validateCityCoordinates({
      latitude: 50.75,
      longitude: 2.25,
      coordinateSource: { source: 'IGN' },
    }),
    /source, date et méthode/
  );
});

test('validateCityForPublication requires the stable municipality identity', () => {
  assert.throws(
    () => validateCityForPublication({ name: 'Saint-Omer', slug: 'saint-omer' }),
    /municipalityKey, countryCode et municipalityCode/
  );
});

test('validateCityForPublication requires an uppercase ISO alpha-2 country code', () => {
  assert.throws(
    () => validateCityForPublication({
      name: 'Saint-Omer',
      slug: 'saint-omer',
      municipalityKey: 'FR-62765',
      countryCode: 'France',
      municipalityCode: '62765',
    }),
    /code pays doit utiliser deux lettres majuscules/
  );
});

test('validateCityForPublication keeps municipalityKey aligned with country and code', () => {
  assert.throws(
    () => validateCityForPublication({
      name: 'Saint-Omer',
      slug: 'saint-omer',
      municipalityKey: 'FR-99999',
      countryCode: 'FR',
      municipalityCode: '62765',
    }),
    /clé commune doit être FR-62765/
  );
});

test('validateStableCityIdentity rejects a slug change after publication', () => {
  assert.throws(
    () => validateStableCityIdentity(
      { slug: 'saint-omer', municipalityKey: 'FR-62765' },
      { slug: 'saint-omer-ville', municipalityKey: 'FR-62765' }
    ),
    /slug d’une ville déjà publiée est immuable/
  );
});

test('validateStableCityIdentity rejects a municipality key change after publication', () => {
  assert.throws(
    () => validateStableCityIdentity(
      { slug: 'saint-omer', municipalityKey: 'FR-62765' },
      { slug: 'saint-omer', municipalityKey: 'FR-99999' }
    ),
    /clé commune d’une ville déjà publiée est immuable/
  );
});
