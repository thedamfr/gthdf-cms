import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATAMASTER_PERMISSION_MATRIX_VERSION,
  DATAMASTER_ROLE,
  DATAMASTER_TECHNICAL_SUBJECTS,
  buildDataMasterPermissions,
  restrictEditorialRolePermissions,
} from '../src/domain/datamaster-rbac';

test('la matrice DataMaster versionnée accorde uniquement les actions techniques prévues', () => {
  assert.equal(DATAMASTER_PERMISSION_MATRIX_VERSION, 4);
  assert.deepEqual(DATAMASTER_ROLE, {
    name: 'DataMaster',
    description: 'Contrôle et qualification des données techniques du catalogue d’itinéraires, sans administration générale de Strapi.',
  });

  const permissions = buildDataMasterPermissions(() => ['allField']);
  const actionsBySubject = Object.fromEntries(DATAMASTER_TECHNICAL_SUBJECTS.map((subject) => [
    subject,
    permissions
      .filter((permission) => permission.subject === subject)
      .map((permission) => permission.action)
      .sort(),
  ]));

  assert.deepEqual(actionsBySubject, {
    'api::reference-route.reference-route': [
      'plugin::content-manager.explorer.publish',
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ],
    'api::route-city.route-city': [
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ],
    'api::route-anchor.route-anchor': [
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ],
    'api::itinerary-revision.itinerary-revision': [
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ],
    'api::catalogue-run.catalogue-run': [
      'plugin::content-manager.explorer.read',
    ],
    'api::itinerary-slug-redirect.itinerary-slug-redirect': [
      'plugin::content-manager.explorer.create',
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ],
  });
  assert.equal(permissions.some((permission) => permission.action.endsWith('.delete')), false);
});

test('DataMaster ne peut modifier que les champs humains de revue et de publication', () => {
  const permissions = buildDataMasterPermissions(() => ['allField']);
  const updateFields = (subject: string) => permissions.find((permission) => (
    permission.subject === subject
    && permission.action === 'plugin::content-manager.explorer.update'
  ))?.properties.fields;

  assert.deepEqual(updateFields('api::reference-route.reference-route'), [
    'name',
    'catalogueEnabled',
    'notes',
  ]);
  assert.deepEqual(updateFields('api::route-city.route-city'), [
    'qualificationStatus',
    'qualifiedAt',
    'reviewNote',
  ]);
  assert.deepEqual(updateFields('api::route-anchor.route-anchor'), ['validationStatus']);
  assert.deepEqual(updateFields('api::itinerary-revision.itinerary-revision'), [
    'warningApproved',
    'warningApprovedAt',
    'warningApprovedBy',
  ]);

  assert.deepEqual(updateFields('api::city-itinerary.city-itinerary'), [
    'activeRevision',
    'reviewStatus',
    'publicationNext',
    'seoStatus',
    'featuredOnCityPages',
    'editorialOrder',
  ]);
  assert.deepEqual(updateFields('api::city.city'), [
    'municipalityKey',
    'countryCode',
    'municipalityCode',
    'administrativeArea',
    'coordinateSource',
  ]);
  assert.deepEqual(updateFields('api::global.global'), ['publishCityItinerariesToNext']);

  const itineraryActions = permissions
    .filter((permission) => permission.subject === 'api::city-itinerary.city-itinerary')
    .map((permission) => permission.action)
    .sort();
  assert.deepEqual(itineraryActions, [
    'plugin::content-manager.explorer.publish',
    'plugin::content-manager.explorer.read',
    'plugin::content-manager.explorer.update',
  ]);
});

test('les rôles éditoriaux perdent les données techniques sans perdre leurs autres permissions', () => {
  const permissions = [
    {
      action: 'plugin::content-manager.explorer.read',
      subject: 'api::reference-route.reference-route',
      properties: { fields: ['name'] },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.read',
      subject: 'api::city-itinerary.city-itinerary',
      properties: {
        fields: [
          'title',
          'introduction',
          'blocks.shared.rich-text.body',
          'seo.metaTitle',
          'businessKey',
          'activeRevision',
        ],
      },
      conditions: ['admin::is-creator'],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::city-itinerary.city-itinerary',
      properties: { fields: ['title', 'publicationNext', 'seo.metaDescription'] },
      conditions: ['admin::is-creator'],
    },
    {
      action: 'plugin::content-manager.explorer.publish',
      subject: 'api::city-itinerary.city-itinerary',
      properties: { fields: [] },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::city.city',
      properties: {
        fields: [
          'name',
          'shortDescription',
          'fromLabel',
          'toLabel',
          'municipalityKey',
          'countryCode',
        ],
      },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::global.global',
      properties: { fields: ['siteName', 'publishCityItinerariesToNext'] },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::article.article',
      properties: { fields: ['title', 'content'] },
      conditions: ['admin::is-creator'],
      actionParameters: { locale: 'fr' },
    },
  ];

  const restricted = restrictEditorialRolePermissions(permissions, () => []);

  assert.equal(restricted.some((permission) => (
    permission.subject === 'api::reference-route.reference-route'
  )), false);
  assert.equal(restricted.some((permission) => (
    permission.subject === 'api::city-itinerary.city-itinerary'
    && permission.action === 'plugin::content-manager.explorer.publish'
  )), false);

  const itineraryRead = restricted.find((permission) => (
    permission.subject === 'api::city-itinerary.city-itinerary'
    && permission.action === 'plugin::content-manager.explorer.read'
  ));
  assert.deepEqual(itineraryRead?.properties?.fields, [
    'title',
    'introduction',
    'blocks.shared.rich-text.body',
    'seo.metaTitle',
  ]);
  assert.deepEqual(itineraryRead?.conditions, ['admin::is-creator']);

  const itineraryUpdate = restricted.find((permission) => (
    permission.subject === 'api::city-itinerary.city-itinerary'
    && permission.action === 'plugin::content-manager.explorer.update'
  ));
  assert.deepEqual(itineraryUpdate?.properties?.fields, ['title', 'seo.metaDescription']);

  assert.deepEqual(restricted.find((permission) => permission.subject === 'api::city.city')?.properties?.fields, [
    'name',
    'shortDescription',
    'fromLabel',
    'toLabel',
  ]);
  assert.deepEqual(restricted.find((permission) => permission.subject === 'api::global.global')?.properties?.fields, [
    'siteName',
  ]);
  assert.deepEqual(restricted.find((permission) => permission.subject === 'api::article.article'), permissions.at(-1));
});

test('une liste de champs explicitement vide ne gagne aucun droit éditorial', () => {
  const restricted = restrictEditorialRolePermissions([{
    action: 'plugin::content-manager.explorer.update',
    subject: 'api::city-itinerary.city-itinerary',
    properties: { fields: [] },
    conditions: [],
  }], () => ['title', 'introduction', 'blocks.shared.rich-text.body', 'seo.metaTitle']);

  assert.deepEqual(restricted, []);
});

test('les ancrages et jonctions GPX de Chapter sont réservés à DataMaster', () => {
  const chapterFields = [
    'title',
    'slug',
    'displayOrder',
    'gpxFileAB',
    'gpxFileBA',
    'cityPassages.city',
    'cityPassages.role',
    'cityPassages.note',
    'cityPassages.gpxAnchorAB.status',
    'cityPassages.gpxAnchorAB.sourceSha256',
    'cityPassages.gpxAnchorAB.reviewNote',
    'cityPassages.gpxAnchorBA.status',
    'cityPassages.gpxAnchorBA.reviewNote',
    'gpxJunctionAfterAB.status',
    'gpxJunctionAfterAB.sourceSha256',
    'gpxJunctionAfterAB.reviewNote',
    'gpxJunctionAfterBA.status',
    'gpxJunctionAfterBA.reviewNote',
  ];
  const permissions = buildDataMasterPermissions((subject) => (
    subject === 'api::chapter.chapter' ? chapterFields : ['allField']
  ));
  assert.deepEqual(permissions
    .filter((permission) => permission.subject === 'api::chapter.chapter')
    .map((permission) => permission.action)
    .sort(), [
    'plugin::content-manager.explorer.read',
    'plugin::content-manager.explorer.update',
  ]);
  const chapterUpdate = permissions.find((permission) => (
    permission.subject === 'api::chapter.chapter'
    && permission.action === 'plugin::content-manager.explorer.update'
  ));

  assert.deepEqual(chapterUpdate?.properties.fields, [
    'cityPassages.gpxAnchorAB.status',
    'cityPassages.gpxAnchorAB.reviewNote',
    'cityPassages.gpxAnchorBA.status',
    'cityPassages.gpxAnchorBA.reviewNote',
    'gpxJunctionAfterAB.status',
    'gpxJunctionAfterAB.reviewNote',
    'gpxJunctionAfterBA.status',
    'gpxJunctionAfterBA.reviewNote',
  ]);

  const restricted = restrictEditorialRolePermissions([
    'create',
    'read',
    'update',
  ].map((action) => ({
    action: `plugin::content-manager.explorer.${action}`,
    subject: 'api::chapter.chapter',
    properties: { fields: chapterFields },
    conditions: [],
  })), () => chapterFields);

  const expectedEditorialFields = [
    'title',
    'slug',
    'displayOrder',
    'gpxFileAB',
    'gpxFileBA',
    'cityPassages.city',
    'cityPassages.role',
    'cityPassages.note',
  ];
  assert.equal(restricted.length, 3);
  for (const permission of restricted) {
    assert.deepEqual(permission.properties.fields, expectedEditorialFields);
  }
});
