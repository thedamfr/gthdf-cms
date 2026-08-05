import assert from 'node:assert/strict';
import test from 'node:test';

import { validateChapterForPublication } from '../src/domain/chapter-validation.ts';

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
