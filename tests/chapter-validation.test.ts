import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateChapterForPublication,
  validatePublishedChapterOrder,
  validatePublishedChapterRemoval,
} from '../src/domain/chapter-validation.ts';

test('validateChapterForPublication requires at least two city passages', () => {
  assert.throws(
    () => validateChapterForPublication({
      title: 'Chapitre test',
      cityPassages: [{ role: 'start', city: { documentId: 'city-1' } }],
    }),
    /au moins deux passages de ville/
  );
});

test('validateChapterForPublication requires exactly one start and one end', () => {
  assert.throws(
    () => validateChapterForPublication({
      title: 'Chapitre test',
      cityPassages: [
        { role: 'start', city: { documentId: 'city-1' } },
        { role: 'start', city: { documentId: 'city-2' } },
      ],
    }),
    /exactement un départ et une arrivée/
  );
});

test('validateChapterForPublication enforces roles from first to last passage', () => {
  assert.throws(
    () => validateChapterForPublication({
      title: 'Chapitre test',
      cityPassages: [
        { role: 'intermediate', city: { documentId: 'city-2' } },
        { role: 'start', city: { documentId: 'city-1' } },
        { role: 'end', city: { documentId: 'city-3' } },
      ],
    }),
    /premier passage doit être le départ/
  );
});

test('validateChapterForPublication requires a city on every passage', () => {
  assert.throws(
    () => validateChapterForPublication({
      title: 'Chapitre test',
      cityPassages: [
        { role: 'start', city: { documentId: 'city-1' } },
        { role: 'end' },
      ],
    }),
    /chaque passage doit référencer une ville/i
  );
});

test('validateChapterForPublication accepts up to six featured intermediates', () => {
  assert.doesNotThrow(() => validateChapterForPublication({
    title: 'Chapitre test',
    cityPassages: [
      { role: 'start', featured: false, city: { documentId: 'city-start' } },
      ...Array.from({ length: 6 }, (_, index) => ({
        role: 'intermediate',
        featured: true,
        city: { documentId: `city-${index + 1}` },
      })),
      { role: 'end', featured: false, city: { documentId: 'city-end' } },
    ],
  }));
});

test('validateChapterForPublication rejects more than six featured intermediates', () => {
  assert.throws(
    () => validateChapterForPublication({
      title: 'Chapitre test',
      cityPassages: [
        { role: 'start', featured: false, city: { documentId: 'city-start' } },
        ...Array.from({ length: 7 }, (_, index) => ({
          role: 'intermediate',
          featured: true,
          city: { documentId: `city-${index + 1}` },
        })),
        { role: 'end', featured: false, city: { documentId: 'city-end' } },
      ],
    }),
    /au maximum six passages intermédiaires mis en avant/
  );
});

test('validatePublishedChapterOrder accepts a shuffled contiguous published set', () => {
  assert.doesNotThrow(() => validatePublishedChapterOrder([
    {
      documentId: 'chapter-3',
      slug: 'hirson-a-soissons',
      title: 'Hirson à Soissons',
      displayOrder: 3,
    },
    {
      documentId: 'chapter-1',
      slug: 'lille-a-arras',
      title: 'Lille à Arras',
      displayOrder: 1,
    },
    {
      documentId: 'chapter-2',
      slug: 'arras-a-conde-sur-l-escaut',
      title: "Arras à Condé-sur-l'Escaut",
      displayOrder: 2,
    },
  ]));
});

test('validatePublishedChapterOrder requires a positive integer with a chapter label', () => {
  assert.throws(
    () => validatePublishedChapterOrder([{
      documentId: 'chapter-1',
      slug: 'lille-a-arras',
      title: 'Lille à Arras',
      displayOrder: undefined,
    }]),
    (error: unknown) => {
      assert.match(String(error), /entier positif/);
      assert.match(String(error), /Lille à Arras/);
      assert.match(String(error), /lille-a-arras/);
      return true;
    }
  );
});

test('validatePublishedChapterOrder reports conflicting chapters for a duplicate order', () => {
  assert.throws(
    () => validatePublishedChapterOrder([
      {
        documentId: 'chapter-1',
        slug: 'lille-a-arras',
        title: 'Lille à Arras',
        displayOrder: 1,
      },
      {
        documentId: 'chapter-2',
        slug: 'arras-a-conde-sur-l-escaut',
        title: "Arras à Condé-sur-l'Escaut",
        displayOrder: 1,
      },
    ]),
    (error: unknown) => {
      assert.match(String(error), /ordre d’affichage 1/i);
      assert.match(String(error), /Lille à Arras/);
      assert.match(String(error), /Arras à Condé-sur-l'Escaut/);
      return true;
    }
  );
});

test('validatePublishedChapterOrder reports missing and out-of-sequence values', () => {
  assert.throws(
    () => validatePublishedChapterOrder([
      {
        documentId: 'chapter-1',
        slug: 'lille-a-arras',
        title: 'Lille à Arras',
        displayOrder: 1,
      },
      {
        documentId: 'chapter-3',
        slug: 'hirson-a-soissons',
        title: 'Hirson à Soissons',
        displayOrder: 3,
      },
    ]),
    (error: unknown) => {
      assert.match(String(error), /valeur manquante[^:]*: 2/i);
      assert.match(String(error), /hors séquence[^:]*: 3/i);
      assert.match(String(error), /Hirson à Soissons/);
      return true;
    }
  );
});

test('validatePublishedChapterRemoval accepts removing the highest published order', () => {
  assert.doesNotThrow(() => validatePublishedChapterRemoval([
    { documentId: 'chapter-1', title: 'Chapitre 1', displayOrder: 1 },
    { documentId: 'chapter-2', title: 'Chapitre 2', displayOrder: 2 },
    { documentId: 'chapter-3', title: 'Chapitre 3', displayOrder: 3 },
  ], 'chapter-3'));
});

test('validatePublishedChapterRemoval reports the removed chapter and resulting gap', () => {
  assert.throws(
    () => validatePublishedChapterRemoval([
      { documentId: 'chapter-1', title: 'Chapitre 1', displayOrder: 1 },
      { documentId: 'chapter-2', title: 'Chapitre 2', displayOrder: 2 },
      { documentId: 'chapter-3', title: 'Chapitre 3', displayOrder: 3 },
    ], 'chapter-2'),
    (error: unknown) => {
      assert.match(String(error), /impossible de retirer/i);
      assert.match(String(error), /Chapitre 2/);
      assert.match(String(error), /valeur manquante[^:]*: 2/i);
      return true;
    }
  );
});

test('validatePublishedChapterRemoval ignores a document without a published version', () => {
  assert.doesNotThrow(() => validatePublishedChapterRemoval([
    { documentId: 'chapter-1', title: 'Chapitre 1', displayOrder: 1 },
    { documentId: 'chapter-3', title: 'Chapitre 3', displayOrder: 3 },
  ], 'draft-only-chapter'));
});
