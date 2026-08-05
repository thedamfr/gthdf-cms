#!/usr/bin/env node

'use strict';

const { execFileSync } = require('node:child_process');
const {
  mkdirSync,
  writeFileSync,
} = require('node:fs');
const { dirname, resolve } = require('node:path');
const {
  validateRemoteMigrationSafety,
} = require('./migrate-cities.js');

const CHAPTER_UID = 'api::chapter.chapter';

const CHAPTER_DISPLAY_ORDERS = Object.freeze([
  { slug: 'lille-a-arras', displayOrder: 1 },
  { slug: 'arras-a-conde-sur-l-escaut', displayOrder: 2 },
  { slug: 'conde-sur-l-escaut-a-hirson', displayOrder: 3 },
  { slug: 'hirson-a-soissons', displayOrder: 4 },
  { slug: 'soissons-a-beauvais', displayOrder: 5 },
  { slug: 'beauvais-a-amiens', displayOrder: 6 },
  { slug: 'amiens-a-etaples', displayOrder: 7 },
  { slug: 'etaples-a-calais', displayOrder: 8 },
  { slug: 'calais-a-saint-omer', displayOrder: 9 },
  { slug: 'st-omer-lille', displayOrder: 10 },
]);

function parseDisplayOrderMigrationArguments(argv, cwd = process.cwd()) {
  const options = {
    apply: false,
    cleverApp: 'gthdf-cms',
    confirmRemote: false,
    help: false,
    remote: false,
    reportPath: resolve(cwd, '.tmp/chapter-display-order-migration-report.json'),
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
    if (argument === '--clever-app') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Une valeur est requise après --clever-app.');
      }
      options.cleverApp = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--report') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Une valeur est requise après --report.');
      }
      options.reportPath = resolve(cwd, value);
      index += 1;
      continue;
    }

    throw new Error(`Option inconnue : ${argument}`);
  }

  return options;
}

function flattenCleverEnvironment(payload) {
  const entries = [
    ...(Array.isArray(payload?.env) ? payload.env : []),
    ...(Array.isArray(payload?.fromAddons)
      ? payload.fromAddons.flatMap((addon) => Array.isArray(addon.env) ? addon.env : [])
      : []),
    ...(Array.isArray(payload?.fromDependencies)
      ? payload.fromDependencies.flatMap((dependency) => (
          Array.isArray(dependency.env) ? dependency.env : []
        ))
      : []),
  ];

  const environment = {};
  for (const entry of entries) {
    if (typeof entry?.name === 'string' && typeof entry.value === 'string') {
      environment[entry.name] = entry.value;
    }
  }
  return environment;
}

function loadCleverEnvironment(cleverApp, runner = execFileSync) {
  let rawPayload;
  try {
    rawPayload = runner('clever', [
      'env',
      '--app',
      cleverApp,
      '--format',
      'json',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (error) {
    throw new Error(
      `Impossible de lire les variables Clever de l'application ${cleverApp}.`,
      { cause: error }
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (error) {
    throw new Error('La CLI Clever a renvoyé un JSON invalide.', { cause: error });
  }

  return flattenCleverEnvironment(payload);
}

function requiredCleverValue(environment, name) {
  const value = String(environment[name] ?? '').trim();
  if (!value) {
    throw new Error(`Variable Clever requise manquante : ${name}.`);
  }
  return value;
}

function configureCleverRemoteDatabaseEnvironment({
  cleverApp,
  environment = process.env,
  runner = execFileSync,
}) {
  const cleverEnvironment = loadCleverEnvironment(cleverApp, runner);
  Object.assign(environment, cleverEnvironment);

  const directUri = String(cleverEnvironment.POSTGRESQL_ADDON_DIRECT_URI ?? '').trim();
  const directHost = String(cleverEnvironment.POSTGRESQL_ADDON_DIRECT_HOST ?? '').trim();
  const directPort = String(cleverEnvironment.POSTGRESQL_ADDON_DIRECT_PORT ?? '').trim();

  environment.DATABASE_CLIENT = 'postgres';
  environment.DATABASE_SSL = 'true';
  environment.DATABASE_SSL_REJECT_UNAUTHORIZED = 'false';
  delete environment.DATABASE_URL;

  if (directUri) {
    const parsed = new URL(directUri);
    environment.POSTGRESQL_ADDON_URI = directUri;
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, ''),
    };
  }

  if (!directHost || !directPort) {
    throw new Error(
      'La CLI Clever ne fournit pas de connexion PostgreSQL DIRECT utilisable depuis le poste local.'
    );
  }

  delete environment.POSTGRESQL_ADDON_URI;
  environment.POSTGRESQL_ADDON_HOST = directHost;
  environment.POSTGRESQL_ADDON_PORT = directPort;
  environment.POSTGRESQL_ADDON_DB = requiredCleverValue(
    cleverEnvironment,
    'POSTGRESQL_ADDON_DB'
  );
  environment.POSTGRESQL_ADDON_USER = requiredCleverValue(
    cleverEnvironment,
    'POSTGRESQL_ADDON_USER'
  );
  environment.POSTGRESQL_ADDON_PASSWORD = requiredCleverValue(
    cleverEnvironment,
    'POSTGRESQL_ADDON_PASSWORD'
  );

  return {
    host: directHost,
    database: environment.POSTGRESQL_ADDON_DB,
  };
}

function validateDisplayOrderMapping(mapping) {
  if (!Array.isArray(mapping) || mapping.length === 0) {
    throw new Error('Le mapping des ordres de chapitre est vide.');
  }

  const slugs = new Set();
  const orders = new Set();

  for (const entry of mapping) {
    if (!entry || typeof entry.slug !== 'string' || !entry.slug.trim()) {
      throw new Error('Chaque ordre de chapitre doit préciser un slug.');
    }
    if (!Number.isInteger(entry.displayOrder) || entry.displayOrder < 1) {
      throw new Error(`L’ordre de ${entry.slug} doit être un entier positif.`);
    }
    if (slugs.has(entry.slug)) {
      throw new Error(`Le slug ${entry.slug} est dupliqué dans le mapping.`);
    }
    if (orders.has(entry.displayOrder)) {
      throw new Error(`L’ordre ${entry.displayOrder} est dupliqué dans le mapping.`);
    }
    slugs.add(entry.slug);
    orders.add(entry.displayOrder);
  }

  const missingOrders = Array.from(
    { length: mapping.length },
    (_, index) => index + 1
  ).filter((order) => !orders.has(order));

  if (missingOrders.length > 0) {
    throw new Error(`Le mapping doit être contigu ; ordres manquants : ${missingOrders.join(', ')}.`);
  }
}

function refreshSummary(report) {
  report.summary = {
    chaptersMapped: report.chapters.length,
    chaptersReady: report.chapters.filter((chapter) => chapter.status === 'ready').length,
    chaptersUpdated: report.chapters.filter((chapter) => chapter.status === 'updated').length,
    chaptersUnchanged: report.chapters.filter((chapter) => chapter.status === 'unchanged').length,
    chaptersBlocked: report.chapters.filter((chapter) => chapter.status === 'blocked').length,
    errors: report.errors.length,
  };
}

function versionDisplayOrders(versions) {
  const draft = versions.find((version) => !version.publishedAt);
  const published = versions.find((version) => Boolean(version.publishedAt));

  return {
    draft: draft?.displayOrder ?? null,
    published: published?.displayOrder ?? null,
  };
}

async function runChapterDisplayOrderMigration({
  adapter,
  apply = false,
  generatedAt = new Date().toISOString(),
  mapping = CHAPTER_DISPLAY_ORDERS,
}) {
  validateDisplayOrderMapping(mapping);

  const report = {
    generatedAt,
    mode: apply ? 'apply' : 'dry-run',
    summary: {},
    chapters: [],
    errors: [],
  };
  const versions = await adapter.listChapterVersions();
  const mappedSlugs = new Set(mapping.map((entry) => entry.slug));
  const plans = [];

  const unexpectedVersions = versions.filter((version) => !mappedSlugs.has(version.slug));
  const unexpectedDocuments = new Map();
  for (const version of unexpectedVersions) {
    const key = version.documentId ?? `slug:${version.slug}`;
    if (!unexpectedDocuments.has(key)) {
      unexpectedDocuments.set(key, version);
    }
  }
  for (const version of unexpectedDocuments.values()) {
    const message = `Le chapitre ${version.slug ?? version.documentId ?? 'inconnu'} est absent du mapping PRD 02.`;
    report.chapters.push({
      documentId: version.documentId,
      slug: version.slug,
      status: 'blocked',
      targetDisplayOrder: null,
    });
    report.errors.push({ chapterSlug: version.slug, message });
  }

  for (const target of mapping) {
    const matchingVersions = versions.filter((version) => version.slug === target.slug);
    const documentIds = new Set(
      matchingVersions.map((version) => version.documentId).filter(Boolean)
    );
    const chapterReport = {
      slug: target.slug,
      status: 'blocked',
      targetDisplayOrder: target.displayOrder,
      beforeDisplayOrder: versionDisplayOrders(matchingVersions),
    };
    report.chapters.push(chapterReport);

    if (documentIds.size !== 1) {
      const message = documentIds.size === 0
        ? 'Chapitre introuvable.'
        : 'Plusieurs documents partagent ce slug.';
      report.errors.push({ chapterSlug: target.slug, message });
      continue;
    }

    const documentId = [...documentIds][0];
    const documentVersions = matchingVersions.filter((version) => (
      version.documentId === documentId
    ));
    const draftVersions = documentVersions.filter((version) => !version.publishedAt);
    const publishedVersions = documentVersions.filter((version) => Boolean(version.publishedAt));
    chapterReport.documentId = documentId;
    chapterReport.title = documentVersions[0]?.title;

    if (draftVersions.length !== 1 || publishedVersions.length !== 1) {
      const missingVersions = [
        ...(draftVersions.length !== 1 ? ['une version brouillon unique'] : []),
        ...(publishedVersions.length !== 1 ? ['une version publiée unique'] : []),
      ];
      const message = `Le chapitre doit posséder ${missingVersions.join(' et ')} avant migration.`;
      report.errors.push({ chapterSlug: target.slug, message });
      continue;
    }

    if (documentVersions.every((version) => version.displayOrder === target.displayOrder)) {
      chapterReport.status = 'unchanged';
      continue;
    }

    chapterReport.status = 'ready';
    plans.push({
      documentId,
      displayOrder: target.displayOrder,
      expectedVersionCount: documentVersions.length,
      chapterReport,
    });
  }

  if (apply && report.errors.length === 0 && plans.length > 0) {
    try {
      await adapter.applyDisplayOrders(plans.map((plan) => ({
        documentId: plan.documentId,
        displayOrder: plan.displayOrder,
        expectedVersionCount: plan.expectedVersionCount,
      })));
      for (const plan of plans) {
        plan.chapterReport.status = 'updated';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const plan of plans) {
        plan.chapterReport.status = 'blocked';
      }
      report.errors.push({ message: `Aucune modification conservée : ${message}` });
    }
  }

  refreshSummary(report);
  return report;
}

function createStrapiAdapter(strapi) {
  const chapterQuery = strapi.db.query(CHAPTER_UID);

  return {
    listChapterVersions: () => chapterQuery.findMany({
      select: [
        'id',
        'documentId',
        'slug',
        'title',
        'displayOrder',
        'publishedAt',
      ],
      orderBy: [{ slug: 'asc' }, { publishedAt: 'asc' }],
    }),
    applyDisplayOrders: (updates) => strapi.db.transaction(async () => {
      for (const update of updates) {
        const result = await strapi.db.query(CHAPTER_UID).updateMany({
          where: { documentId: update.documentId },
          data: { displayOrder: update.displayOrder },
        });
        const updatedCount = Number(result?.count ?? 0);

        if (updatedCount !== update.expectedVersionCount) {
          throw new Error(
            `${update.documentId} : ${updatedCount} version(s) modifiée(s) au lieu de ${update.expectedVersionCount}.`
          );
        }
      }
    }),
  };
}

function writeMigrationReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function printHelp() {
  console.log(`Migration de l’ordre public des chapitres

Usage : npm run migrate:chapter-display-order -- [options]

Options :
  --report <fichier>  Rapport JSON (défaut : .tmp/chapter-display-order-migration-report.json)
  --apply             Met à jour displayOrder sur les versions brouillon et publiée
  --dry-run           Force le mode lecture seule (comportement par défaut)
  --remote            Lit l’accès PostgreSQL DIRECT avec la CLI Clever
  --clever-app <app>  Application Clever source (défaut : gthdf-cms)
  --confirm-remote    Second verrou obligatoire avec --remote --apply
  --help              Affiche cette aide

Le mapping des dix slugs est versionné dans le script. La mise à jour est
transactionnelle, ne republie aucun document et ne modifie aucun autre champ.`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDisplayOrderMigrationArguments(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  validateRemoteMigrationSafety(options);
  if (options.remote) {
    const target = configureCleverRemoteDatabaseEnvironment({
      cleverApp: options.cleverApp,
    });
    console.log(`Base distante ciblée : ${target.host} / ${target.database}`);
  }

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let report;
  try {
    report = await runChapterDisplayOrderMigration({
      adapter: createStrapiAdapter(app),
      apply: options.apply,
    });
  } finally {
    await app.destroy();
  }

  report.source = {
    mapping: CHAPTER_DISPLAY_ORDERS,
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
  CHAPTER_DISPLAY_ORDERS,
  configureCleverRemoteDatabaseEnvironment,
  createStrapiAdapter,
  flattenCleverEnvironment,
  loadCleverEnvironment,
  parseDisplayOrderMigrationArguments,
  runChapterDisplayOrderMigration,
  validateDisplayOrderMapping,
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
