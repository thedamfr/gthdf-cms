#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

async function deleteDocument(documents, documentId) {
  if (!documentId) {
    return;
  }

  await documents.delete({ documentId });
}

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const cityDocuments = app.documents('api::city.city');
  const chapterDocuments = app.documents('api::chapter.chapter');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let incompleteCityDocumentId;
  let stableCityDocumentId;
  let invalidChapterDocumentId;
  let result;

  try {
    const incompleteCity = await cityDocuments.create({
      status: 'draft',
      data: {
        name: `Ville QA incomplète ${suffix}`,
        slug: `ville-qa-incomplete-${suffix}`,
        hasPublicPage: false,
      },
    });
    incompleteCityDocumentId = incompleteCity.documentId;

    await assert.rejects(
      () => cityDocuments.publish({ documentId: incompleteCity.documentId }),
      /municipalityKey, countryCode et municipalityCode/
    );

    const municipalityCode = `QA-${suffix}`;
    const stableCity = await cityDocuments.create({
      status: 'draft',
      data: {
        name: `Ville QA stable ${suffix}`,
        slug: `ville-qa-stable-${suffix}`,
        municipalityKey: `ZZ-${municipalityCode}`,
        countryCode: 'ZZ',
        municipalityCode,
        hasPublicPage: false,
      },
    });
    stableCityDocumentId = stableCity.documentId;
    await cityDocuments.publish({ documentId: stableCity.documentId });

    await assert.rejects(
      () => cityDocuments.update({
        documentId: stableCity.documentId,
        data: { slug: `ville-qa-modifiee-${suffix}` },
      }),
      /slug d’une ville déjà publiée est immuable/
    );

    const invalidChapter = await chapterDocuments.create({
      status: 'draft',
      data: {
        title: `Chapitre QA invalide ${suffix}`,
        slug: `chapitre-qa-invalide-${suffix}`,
        startStation: stableCity.name,
        endStation: 'Arrivée QA',
        distance: 1,
        introSentence: 'Chapitre temporaire pour la validation locale PRD 01.',
        cityPassages: [{
          role: 'start',
          featured: false,
          city: { documentId: stableCity.documentId },
        }],
      },
    });
    invalidChapterDocumentId = invalidChapter.documentId;

    await assert.rejects(
      () => chapterDocuments.publish({ documentId: invalidChapter.documentId }),
      /au moins deux passages de ville/
    );

    result = {
      incompleteCityPublication: 'rejected',
      publishedCitySlugChange: 'rejected',
      invalidChapterPublication: 'rejected',
    };
  } finally {
    try {
      await deleteDocument(chapterDocuments, invalidChapterDocumentId);
      await deleteDocument(cityDocuments, stableCityDocumentId);
      await deleteDocument(cityDocuments, incompleteCityDocumentId);
    } finally {
      await app.destroy();
    }
  }

  console.log(JSON.stringify({ ...result, cleanup: 'complete' }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
