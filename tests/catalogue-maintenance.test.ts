import assert from 'node:assert/strict';
import test from 'node:test';

import { selectOrphanCatalogueMedia } from '../scripts/catalogue/catalogue-maintenance';

const GPX_SHA = 'a'.repeat(64);
const JSON_SHA = 'b'.repeat(64);

test('media-gc protège toute relation par id/documentId/object key et ne sélectionne que les médias PRD04 sûrs', () => {
  const media = [
    {
      id: 1,
      documentId: 'media-gpx',
      name: `${GPX_SHA}-route.gpx`,
      caption: `PRD04 ${GPX_SHA}`,
      mime: 'application/gpx+xml',
      size: 10,
      url: '/catalogue/referenced.gpx',
    },
    {
      id: 2,
      documentId: 'media-json',
      name: `${JSON_SHA}-route.json`,
      caption: `PRD04 ${JSON_SHA}`,
      mime: 'application/json',
      size: 20,
      url: '/catalogue/orphan.json',
    },
    {
      id: 3,
      documentId: 'ordinary-media',
      name: 'photo.jpg',
      caption: null,
      mime: 'image/jpeg',
      size: 30,
      url: '/ordinary/photo.jpg',
    },
  ];
  const selected = selectOrphanCatalogueMedia(media, [{
    generatedGpx: { id: 1, documentId: 'media-gpx', url: '/catalogue/referenced.gpx' },
    generatedGpxObjectKey: 'catalogue/referenced.gpx',
  }]);
  assert.equal(selected.catalogueMedia, 2);
  assert.equal(selected.referencedCatalogueMedia, 1);
  assert.deepEqual(selected.candidates, [{
    mediaId: 2,
    documentId: 'media-json',
    name: `${JSON_SHA}-route.json`,
    mime: 'application/json',
    size: 20,
    sha256: JSON_SHA,
    objectKey: 'catalogue/orphan.json',
  }]);
});

test('media-gc ignore par prudence un faux caption ou un MIME incohérent', () => {
  const selected = selectOrphanCatalogueMedia([{
    id: 4,
    name: `${GPX_SHA}-route.gpx`,
    caption: `PRD04 ${GPX_SHA}`,
    mime: 'application/json',
    size: 10,
    url: '/catalogue/not-a-gpx.gpx',
  }], []);
  assert.equal(selected.catalogueMedia, 0);
  assert.deepEqual(selected.candidates, []);
});
