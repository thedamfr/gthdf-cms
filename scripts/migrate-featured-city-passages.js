#!/usr/bin/env node

'use strict';

const {
  mkdirSync,
  readFileSync,
  writeFileSync,
} = require('node:fs');
const { dirname, resolve } = require('node:path');
const {
  configureRemoteDatabaseEnvironment,
  validateRemoteMigrationSafety,
} = require('./migrate-cities.js');

const MAX_FEATURED_INTERMEDIATES = 6;

function parseFeaturedMigrationArguments(argv, cwd = process.cwd()) {
  const options = {
    apply: false,
    confirmRemote: false,
    help: false,
    remote: false,
    reportPath: resolve(cwd, '.tmp/featured-city-migration-report.json'),
    selectionPath: resolve(cwd, 'scripts/featured-city-passages.json'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--apply') {
      options.apply = true;
      continue;
    }
    if (argument === '--dry-run') {
      options.apply = false;
      continue;
    }
    if (argument === '--remote') {
      options.remote = true;
      continue;
    }
    if (argument === '--confirm-remote') {
      options.confirmRemote = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--selection' || argument === '--report') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Une valeur est requise après ${argument}.`);
      }
      index += 1;
      if (argument === '--selection') {
        options.selectionPath = resolve(cwd, value);
      } else {
        options.reportPath = resolve(cwd, value);
      }
      continue;
    }

    throw new Error(`Option inconnue : ${argument}`);
  }

  return options;
}

function loadFeaturedCitySelection(selectionPath) {
  const payload = JSON.parse(readFileSync(selectionPath, 'utf8'));
  if (payload.version !== 1 || !Array.isArray(payload.chapters)) {
    throw new Error('La sélection doit utiliser le format version 1.');
  }

  const chapterSlugs = new Set();
  return payload.chapters.map((chapter) => {
    const chapterSlug = String(chapter.chapterSlug ?? '').trim();
    const featuredCities = Array.isArray(chapter.featuredCities)
      ? chapter.featuredCities.map((city) => ({
        name: String(city.name ?? '').trim(),
        municipalityKey: String(city.municipalityKey ?? '').trim(),
      }))
      : [];

    if (!chapterSlug) {
      throw new Error('Chaque sélection doit préciser un chapterSlug.');
    }
    if (chapterSlugs.has(chapterSlug)) {
      throw new Error(`Le chapitre ${chapterSlug} est dupliqué dans la sélection.`);
    }
    chapterSlugs.add(chapterSlug);

    if (featuredCities.length > MAX_FEATURED_INTERMEDIATES) {
      throw new Error(`Le chapitre ${chapterSlug} peut sélectionner au maximum 6 villes.`);
    }

    const municipalityKeys = new Set();
    for (const city of featuredCities) {
      if (!city.name || !/^[A-Z]{2}-.+/.test(city.municipalityKey)) {
        throw new Error(`Une ville sélectionnée pour ${chapterSlug} est incomplète.`);
      }
      if (municipalityKeys.has(city.municipalityKey)) {
        throw new Error(
          `La ville ${city.municipalityKey} est dupliquée pour ${chapterSlug}.`
        );
      }
      municipalityKeys.add(city.municipalityKey);
    }

    return { chapterSlug, featuredCities };
  });
}

function buildFeaturedPassageUpdate(chapter, featuredMunicipalityKeys) {
  const passages = Array.isArray(chapter.cityPassages) ? chapter.cityPassages : [];
  const selectedKeys = new Set(featuredMunicipalityKeys);

  if (selectedKeys.size > MAX_FEATURED_INTERMEDIATES) {
    throw new Error('Un chapitre peut sélectionner au maximum 6 villes.');
  }

  for (const municipalityKey of selectedKeys) {
    const matchingPassages = passages.filter((passage) => (
      passage.role === 'intermediate'
      && passage.city?.municipalityKey === municipalityKey
    ));

    if (matchingPassages.length === 0) {
      throw new Error(
        `La ville ${municipalityKey} n’est pas un passage intermédiaire du chapitre.`
      );
    }
    if (matchingPassages.length > 1) {
      throw new Error(
        `La ville ${municipalityKey} correspond à plusieurs passages intermédiaires du chapitre.`
      );
    }
  }

  return passages.map((passage) => {
    const documentId = passage.city?.documentId;
    const municipalityKey = passage.city?.municipalityKey;
    if (!documentId || !municipalityKey) {
      throw new Error('Chaque passage doit exposer le documentId et la municipalityKey de sa ville.');
    }

    return {
      ...(passage.id !== undefined ? { id: passage.id } : {}),
      role: passage.role,
      featured: passage.role === 'intermediate' && selectedKeys.has(municipalityKey),
      ...(passage.note !== undefined ? { note: passage.note } : {}),
      city: { documentId },
    };
  });
}

function hasSameFeaturedState(currentPassages, proposedPassages) {
  return currentPassages.length === proposedPassages.length
    && currentPassages.every((passage, index) => (
      Boolean(passage.featured) === Boolean(proposedPassages[index]?.featured)
    ));
}

function refreshSummary(report) {
  report.summary = {
    chaptersSelected: report.chapters.length,
    chaptersReady: report.chapters.filter((chapter) => chapter.status === 'ready').length,
    chaptersUpdated: report.chapters.filter((chapter) => chapter.status === 'updated').length,
    chaptersUnchanged: report.chapters.filter((chapter) => chapter.status === 'unchanged').length,
    chaptersBlocked: report.chapters.filter((chapter) => chapter.status === 'blocked').length,
    errors: report.errors.length,
  };
}

async function runFeaturedCityMigration({
  adapter,
  selection,
  apply = false,
  generatedAt = new Date().toISOString(),
}) {
  const report = {
    generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    summary: {},
    chapters: [],
    errors: [],
  };
  const chapters = await adapter.listChapters();
  const plans = [];

  for (const selectedChapter of selection) {
    const matches = chapters.filter((chapter) => chapter.slug === selectedChapter.chapterSlug);
    const chapterReport = {
      slug: selectedChapter.chapterSlug,
      status: 'blocked',
      beforeFeaturedMunicipalityKeys: [],
      targetFeaturedMunicipalityKeys: selectedChapter.featuredCities.map(
        (city) => city.municipalityKey
      ),
    };
    report.chapters.push(chapterReport);

    if (matches.length !== 1) {
      const message = matches.length === 0
        ? 'Chapitre brouillon introuvable.'
        : 'Plusieurs chapitres brouillons partagent ce slug.';
      report.errors.push({ chapterSlug: selectedChapter.chapterSlug, message });
      continue;
    }

    const chapter = matches[0];
    const currentPassages = Array.isArray(chapter.cityPassages)
      ? chapter.cityPassages
      : [];
    chapterReport.documentId = chapter.documentId;
    chapterReport.title = chapter.title;
    chapterReport.beforeFeaturedMunicipalityKeys = currentPassages
      .filter((passage) => passage.role === 'intermediate' && passage.featured)
      .map((passage) => passage.city?.municipalityKey)
      .filter(Boolean);

    let proposedPassages;
    try {
      proposedPassages = buildFeaturedPassageUpdate(
        chapter,
        chapterReport.targetFeaturedMunicipalityKeys
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ chapterSlug: selectedChapter.chapterSlug, message });
      continue;
    }

    if (hasSameFeaturedState(currentPassages, proposedPassages)) {
      chapterReport.status = 'unchanged';
      continue;
    }

    chapterReport.status = 'ready';
    plans.push({ chapter, chapterReport, proposedPassages });
  }

  if (apply) {
    for (const plan of plans) {
      try {
        await adapter.updateChapter(plan.chapter.documentId, plan.proposedPassages);
        plan.chapterReport.status = 'updated';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        plan.chapterReport.status = 'blocked';
        report.errors.push({ chapterSlug: plan.chapter.slug, message });
      }
    }
  }

  refreshSummary(report);
  return report;
}

function createStrapiAdapter(strapi) {
  const chapterDocuments = strapi.documents('api::chapter.chapter');

  return {
    listChapters: () => chapterDocuments.findMany({
      status: 'draft',
      fields: ['documentId', 'slug', 'title'],
      populate: {
        cityPassages: {
          populate: {
            city: {
              fields: ['documentId', 'name', 'municipalityKey'],
            },
          },
        },
      },
      pagination: { start: 0, limit: 10000 },
    }),
    updateChapter: (documentId, cityPassages) => chapterDocuments.update({
      documentId,
      data: { cityPassages },
    }),
  };
}

function writeMigrationReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printHelp() {
  console.log(`Migration des villes mises en avant

Usage : npm run migrate:featured-cities -- [options]

Options :
  --selection <fichier>  Sélection JSON v1 (défaut : scripts/featured-city-passages.json)
  --report <fichier>     Rapport JSON (défaut : .tmp/featured-city-migration-report.json)
  --apply                Met à jour uniquement les brouillons de chapitre
  --dry-run              Force le mode lecture seule (comportement par défaut)
  --remote               Utilise les variables POSTGRESQL_ADDON_*_REMOTE
  --confirm-remote       Second verrou obligatoire avec --remote --apply
  --help                 Affiche cette aide

Le script ne crée, ne supprime et ne publie aucun document.`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseFeaturedMigrationArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  validateRemoteMigrationSafety(options);
  if (options.remote) {
    const target = configureRemoteDatabaseEnvironment();
    console.log(`Base distante ciblée : ${target.host} / ${target.database}`);
  }

  const selection = loadFeaturedCitySelection(options.selectionPath);
  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let report;
  try {
    report = await runFeaturedCityMigration({
      adapter: createStrapiAdapter(app),
      selection,
      apply: options.apply,
    });
  } finally {
    await app.destroy();
  }

  report.source = {
    selectionPath: options.selectionPath,
    selectedChapters: selection.length,
  };
  writeMigrationReport(options.reportPath, report);

  console.log(JSON.stringify({
    mode: report.mode,
    reportPath: options.reportPath,
    summary: report.summary,
  }, null, 2));

  return options.apply && report.summary.chaptersBlocked > 0 ? 2 : 0;
}

module.exports = {
  MAX_FEATURED_INTERMEDIATES,
  buildFeaturedPassageUpdate,
  createStrapiAdapter,
  hasSameFeaturedState,
  loadFeaturedCitySelection,
  parseFeaturedMigrationArguments,
  runFeaturedCityMigration,
  writeMigrationReport,
};

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
