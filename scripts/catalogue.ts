#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  parseControlledCatalogueDataset,
  type CatalogueDatasetFiles,
} from '../src/domain/catalogue-dataset';
import { validateCataloguePlan, type CataloguePlan } from '../src/domain/catalogue-job';
import { parseVersionedBoundarySnapshot } from '../src/domain/catalogue-boundaries';
import {
  buildCataloguePlanFromStrapi,
  executeCataloguePlanOnStrapi,
} from './catalogue/strapi-adapter';
import { buildCatalogueMediaGcDryRun } from './catalogue/catalogue-maintenance';
import {
  scopeCataloguePlan,
  type CatalogueTargetScope,
} from './catalogue/catalogue-scope';

type Command = 'import' | 'anchors' | 'calculate' | 'apply' | 'resume' | 'archive-check' | 'media-gc';

type Options = {
  command: Command;
  apply: boolean;
  confirmHash: string | null;
  confirmRemote: boolean;
  datasetDirectory: string;
  boundariesDirectory: string;
  reportPath: string;
  routeKey: string;
  operator: string;
  remote: boolean;
  cleverApp: string;
  allowSelfSignedTls: boolean;
  target: CatalogueTargetScope;
  help: boolean;
};

type CatalogueStrapiLoaderDependencies = {
  compileStrapi: () => Promise<unknown>;
  createStrapi: (context: unknown) => any;
  transformContentTypesToModels: (contentTypes: unknown[], identifiers: unknown) => unknown[];
};

export type CatalogueStrapiRuntime = {
  app: any;
  readOnly: boolean;
  destroy: () => Promise<void>;
};

function sqlWithoutLeadingComments(sql: string): string {
  return sql.replace(/^\s*(?:(?:--[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/\s*))*/g, '').trimStart();
}

function hasAdditionalSqlStatement(sql: string): boolean {
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  let statementEnded = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === quote && next === quote) {
        index += 1;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === '-' && next === '-') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      if (statementEnded) return true;
      quote = character;
      continue;
    }
    if (character === ';') {
      statementEnded = true;
      continue;
    }
    if (statementEnded && !/\s/.test(character)) return true;
  }
  return false;
}

function readOnlySqlKeyword(sql: string): string {
  return /^([a-z]+)/i.exec(sqlWithoutLeadingComments(sql))?.[1]?.toLowerCase() ?? '';
}

export function assertCatalogueReadOnlySql(sql: unknown): void {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('Requête SQL vide interdite pendant un dry-run catalogue.');
  if (hasAdditionalSqlStatement(sql)) {
    throw new Error('Requête SQL multi-statements interdite pendant un dry-run catalogue.');
  }
  const keyword = readOnlySqlKeyword(sql);
  const normalized = sqlWithoutLeadingComments(sql);
  const mutatesReadOnlyMode = /\bread\s+write\b/i.test(normalized)
    || /\bset_config\b/i.test(normalized)
    || (['set', 'reset'].includes(keyword) && /\b(?:default_)?transaction_read_only\b/i.test(normalized));
  if (mutatesReadOnlyMode) {
    throw new Error('Toute mutation du mode transactionnel read-only est interdite pendant un dry-run catalogue.');
  }
  const readOnlyCte = keyword === 'with'
    && /\bselect\b/i.test(normalized)
    && !/\b(?:insert\s+into|update\s+[^,;]+\s+set|delete\s+from|merge\s+into)\b/i.test(normalized);
  const safeSessionSet = keyword === 'set'
    && /^\s*set\s+(?:search_path|time\s+zone|timezone|application_name)\b/i.test(normalized);
  const safeBegin = keyword === 'begin'
    && /^\s*begin(?:\s+(?:work|transaction))?(?:\s+read\s+only)?\s*;?\s*$/i.test(normalized);
  // SET est limité aux paramètres de connexion nécessaires à Strapi. La
  // barrière PostgreSQL default_transaction_read_only reste active en plus de
  // ce diagnostic Knex fail-closed.
  if (!readOnlyCte && !safeSessionSet && !safeBegin && ![
    'select', 'show', 'commit', 'rollback', 'savepoint', 'release',
  ].includes(keyword)) {
    throw new Error(`Écriture ou DDL SQL interdite pendant un dry-run catalogue (${keyword || 'requête inconnue'}).`);
  }
}

function defaultCatalogueStrapiLoaderDependencies(): CatalogueStrapiLoaderDependencies {
  const { compileStrapi, createStrapi } = require('@strapi/strapi');
  const coreDirectory = dirname(require.resolve('@strapi/core'));
  // Strapi n’exporte pas ce helper. La version 5.51.1 est verrouillée et son
  // bootstrap utilise exactement ce module CJS pour initialiser les métadonnées.
  const { transformContentTypesToModels } = require(join(
    coreDirectory,
    'utils/transform-content-types-to-models.js',
  ));
  return { compileStrapi, createStrapi, transformContentTypesToModels };
}

export async function loadCatalogueStrapi(
  readOnly: boolean,
  dependencies: CatalogueStrapiLoaderDependencies = defaultCatalogueStrapiLoaderDependencies(),
): Promise<CatalogueStrapiRuntime> {
  const previousPgOptions = process.env.PGOPTIONS;
  const restorePgOptions = () => {
    if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousPgOptions;
  };
  if (readOnly) {
    process.env.PGOPTIONS = [previousPgOptions?.trim(), '-c default_transaction_read_only=on']
      .filter(Boolean)
      .join(' ');
  }
  let app: any;
  try {
    const appContext = await dependencies.compileStrapi();
    app = dependencies.createStrapi(appContext);
  } catch (error) {
    if (readOnly) restorePgOptions();
    throw error;
  }
  if (!readOnly) {
    await app.load();
    return { app, readOnly: false, destroy: () => app.destroy() };
  }

  let connection: any;
  const rejectMutation = (query: { sql?: unknown }) => assertCatalogueReadOnlySql(query?.sql);
  try {
    connection = app.db.connection;
    connection.on('query', rejectMutation);
    await app.register();
    const models = [
      ...dependencies.transformContentTypesToModels(
        [...Object.values(app.contentTypes), ...Object.values(app.components)],
        app.db.metadata.identifiers,
      ),
      ...app.get('models').get(),
    ];
    await app.db.init({ models });
  } catch (error) {
    connection?.off?.('query', rejectMutation);
    try {
      if (typeof app.db?.destroy === 'function') await app.db.destroy();
    } catch {
      // L'erreur d'initialisation d'origine reste prioritaire.
    }
    restorePgOptions();
    throw error;
  }
  return {
    app,
    readOnly: true,
    destroy: async () => {
      try {
        // Ne pas appeler app.destroy(): les lifecycles bootstrap n’ont pas été
        // exécutés et des hooks destroy de plugins pourraient écrire en base.
        await app.db.destroy();
      } finally {
        connection.off('query', rejectMutation);
        restorePgOptions();
      }
    },
  };
}

function catalogueSourceFiles(root: string): string[] {
  const selectedRoots = [
    resolve(root, 'src'),
    resolve(root, 'scripts/catalogue'),
    resolve(root, 'scripts/catalogue.ts'),
    resolve(root, 'package.json'),
    resolve(root, 'config/plugins.ts'),
  ];
  const files: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(resolve(path, entry));
    } else if (/\.(?:ts|js|json)$/.test(path)) files.push(path);
  };
  selectedRoots.forEach(visit);
  return files.sort();
}

export function resolveCatalogueCodeVersion(
  root = process.cwd(),
  environment = process.env,
): string {
  const explicit = environment.CATALOGUE_CODE_VERSION?.trim();
  if (explicit) {
    if (!/^[A-Za-z0-9._:+-]{7,120}$/.test(explicit)) throw new Error('CATALOGUE_CODE_VERSION est invalide.');
    return explicit;
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Le commit Git courant est introuvable.');
  const hash = createHash('sha256');
  for (const path of catalogueSourceFiles(root)) {
    hash.update(relative(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return `commit:${commit}:src:${hash.digest('hex')}`;
}

function valueAfter(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Une valeur est requise après ${option}.`);
  return value;
}

export function parseCatalogueArguments(
  argv: string[],
  cwd = process.cwd(),
  environment = process.env,
): Options {
  const command = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'calculate') as Command;
  if (!['import', 'anchors', 'calculate', 'apply', 'resume', 'archive-check', 'media-gc'].includes(command)) {
    throw new Error(`Commande catalogue inconnue : ${command}.`);
  }
  const start = argv[0] === command ? 1 : 0;
  const defaultMode = command === 'apply' || command === 'resume' ? 'calculate' : command;
  const options: Options = {
    command,
    apply: command === 'apply' || command === 'resume',
    confirmHash: null,
    confirmRemote: false,
    datasetDirectory: environment.CATALOGUE_DATASET_DIR
      ? resolve(cwd, environment.CATALOGUE_DATASET_DIR)
      : '',
    boundariesDirectory: resolve(cwd, 'data/catalogue/boundaries'),
    reportPath: resolve(cwd, `.tmp/catalogue-${defaultMode}-report.json`),
    routeKey: 'gthf-main-loop',
    operator: environment.USER || 'catalogue-operator',
    remote: false,
    cleverApp: 'gthdf-cms',
    allowSelfSignedTls: false,
    target: {
      businessKeys: [],
      municipalityKeys: [],
      chapterSlugs: [],
      anchorKeys: [],
    },
    help: false,
  };
  for (let index = start; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--remote') options.remote = true;
    else if (argument === '--confirm-remote') options.confirmRemote = true;
    else if (argument === '--allow-self-signed-tls') options.allowSelfSignedTls = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if ([
      '--confirm-hash', '--dataset', '--boundaries', '--report', '--route-key', '--operator', '--clever-app',
      '--business-key', '--municipality-key', '--chapter-slug', '--anchor-key',
    ].includes(argument)) {
      const value = valueAfter(argv, index, argument);
      index += 1;
      if (argument === '--confirm-hash') options.confirmHash = value.toLowerCase();
      else if (argument === '--dataset') options.datasetDirectory = resolve(cwd, value);
      else if (argument === '--boundaries') options.boundariesDirectory = resolve(cwd, value);
      else if (argument === '--report') options.reportPath = resolve(cwd, value);
      else if (argument === '--route-key') options.routeKey = value;
      else if (argument === '--operator') options.operator = value;
      else if (argument === '--business-key') options.target.businessKeys.push(value);
      else if (argument === '--municipality-key') options.target.municipalityKeys.push(value);
      else if (argument === '--chapter-slug') options.target.chapterSlugs.push(value);
      else if (argument === '--anchor-key') options.target.anchorKeys.push(value);
      else options.cleverApp = value;
    } else throw new Error(`Option inconnue : ${argument}.`);
  }
  if ((command === 'archive-check' || command === 'media-gc') && options.apply) {
    throw new Error(`${command} est une commande de contrôle strictement dry-run.`);
  }
  if (options.apply && !options.confirmHash) {
    throw new Error('Toute application exige --confirm-hash <SHA-256 du dry-run>.');
  }
  if (!options.apply && (options.confirmHash || options.confirmRemote)) {
    throw new Error('Les confirmations ne sont acceptées qu’avec apply/resume ou --apply.');
  }
  if (options.remote && options.apply && !options.confirmRemote) {
    throw new Error('Une application distante exige aussi --confirm-remote.');
  }
  if (!options.remote && options.confirmRemote) throw new Error('--confirm-remote exige --remote.');
  const hasTarget = Object.values(options.target).some((values) => values.length > 0);
  if ((command === 'apply' || command === 'resume') && hasTarget) {
    throw new Error('Le ciblage doit être figé dans le rapport avant apply/resume.');
  }
  if (command === 'media-gc' && hasTarget) {
    throw new Error('media-gc inventorie tous les médias catalogue et n’accepte pas de ciblage.');
  }
  if (!options.help && command !== 'media-gc' && !options.datasetDirectory) {
    throw new Error('Le dataset contrôlé doit être fourni par --dataset ou CATALOGUE_DATASET_DIR.');
  }
  return options;
}

function controlledChild(root: string, relativePath: string): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error(`Chemin de dataset interdit : ${relativePath}.`);
  const target = resolve(root, relativePath);
  const child = relative(root, target);
  if (child.startsWith('..') || isAbsolute(child)) throw new Error(`Le fichier ${relativePath} sort du dataset contrôlé.`);
  return target;
}

export async function loadControlledDatasetDirectory(directory: string) {
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, any>;
  const paths = new Set<string>([
    'manifest.json',
    String(manifest.source?.file ?? ''),
    ...(manifest.sheets ?? []).map((sheet: Record<string, unknown>) => String(sheet.csv ?? '')),
  ]);
  const files: CatalogueDatasetFiles = {};
  for (const path of paths) files[path] = await readFile(controlledChild(directory, path));
  return parseControlledCatalogueDataset(files);
}

async function loadBoundarySnapshot(directory: string, municipalityKeys: string[]) {
  const [geoJsonText, manifestText] = await Promise.all([
    readFile(resolve(directory, 'municipalities.wgs84.geojson'), 'utf8'),
    readFile(resolve(directory, 'manifest.json'), 'utf8'),
  ]);
  return parseVersionedBoundarySnapshot(geoJsonText, manifestText, municipalityKeys);
}

async function writeReport(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8' });
}

async function readReport(path: string): Promise<CataloguePlan<any>> {
  const report = JSON.parse(await readFile(path, 'utf8')) as CataloguePlan<any>;
  validateCataloguePlan(report);
  return report;
}

function configureRemote(options: Options): void {
  if (!options.remote) return;
  const { configureCleverRemoteDatabaseEnvironment } = require('./clever-remote-database.js');
  configureCleverRemoteDatabaseEnvironment({
    cleverApp: options.cleverApp,
    allowSelfSignedTls: options.allowSelfSignedTls,
    environment: process.env,
  });
}

export function assertCatalogueDatabaseTarget(options: Pick<Options, 'remote' | 'confirmRemote' | 'apply'>, environment = process.env): void {
  const configuredUri = environment.POSTGRESQL_ADDON_URI || environment.DATABASE_URL;
  let host = environment.POSTGRESQL_ADDON_HOST || environment.DATABASE_HOST || '';
  if (configuredUri) {
    let parsed: URL;
    try {
      parsed = new URL(configuredUri);
    } catch {
      throw new Error('La cible DB est impossible à identifier; job catalogue refusé.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('La cible DB catalogue doit être une URI PostgreSQL TCP explicite.');
    }
    host = parsed.hostname;
  }
  const isLocal = !host || ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
  if (!isLocal && !options.remote) {
    throw new Error(`La base ${host} est distante : utilisez explicitement --remote${options.apply ? ' --confirm-remote' : ''}.`);
  }
  if (isLocal && options.remote && options.apply && !options.confirmRemote) {
    throw new Error('Une application marquée distante exige --confirm-remote.');
  }
  if (environment.NODE_ENV === 'production' && !options.remote) {
    throw new Error('NODE_ENV=production exige --remote et, pour apply, --confirm-remote.');
  }
}

export function catalogueUsage(): string {
  return `Catalogue PRD04 — dry-run strict par défaut

  npm run catalogue:import
  npm run catalogue:anchors
  npm run catalogue:calculate
  npm run catalogue:archive-check
  npm run catalogue:media-gc
  npm run catalogue:apply -- --report .tmp/catalogue-calculate-report.json --confirm-hash <sha> --operator <nom>
  npm run catalogue:resume -- --report .tmp/catalogue-calculate-report.json --confirm-hash <sha> --operator <nom>

Options :
  --dataset <répertoire>      Dataset contrôlé obligatoire (ou CATALOGUE_DATASET_DIR)
  --boundaries <répertoire>   Snapshot officiel GeoJSON + manifeste
  --route-key <clé>           Défaut : gthf-main-loop
  --business-key <clé>        Cible répétable d’itinéraire
  --municipality-key <clé>    Cible répétable de ville
  --chapter-slug <slug>       Cible répétable de chapitre
  --anchor-key <clé>          Cible répétable d’ancre
  --report <fichier>          Rapport local, sans octets ni géométries
  --apply                     Applique exactement le plan recalculé
  --confirm-hash <sha>        Hash du dry-run obligatoire
  --operator <nom>            Opérateur auditable
  --remote --confirm-remote   Cible distante explicite (jamais implicite)

Import/anchors produisent des brouillons/propositions. Ils ne publient rien,
n’activent aucun flag et ne valident jamais une proposition géographique.
archive-check ne conserve que les archives candidates dans son rapport.
media-gc inventorie les objets PRD04 non référencés sans jamais les supprimer.
`;
}

export async function runCatalogueCli(argv = process.argv.slice(2)): Promise<number> {
  const options = parseCatalogueArguments(argv);
  if (options.help) {
    process.stdout.write(catalogueUsage());
    return 0;
  }
  const codeVersion = resolveCatalogueCodeVersion();
  assertCatalogueDatabaseTarget(options);
  configureRemote(options);
  const runtime = await loadCatalogueStrapi(!options.apply);
  const { app } = runtime;
  app.log.level = 'error';
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (options.command === 'media-gc') {
      const gcReport = await buildCatalogueMediaGcDryRun(app);
      await writeReport(options.reportPath, gcReport);
      process.stdout.write(`${JSON.stringify({
        mode: 'media-gc-dry-run',
        reportPath: options.reportPath,
        reportHash: gcReport.reportHash,
        inputHash: gcReport.inputHash,
        summary: gcReport.summary,
        deletionPerformed: false,
      }, null, 2)}\n`);
      return 0;
    }
    const dataset = await loadControlledDatasetDirectory(options.datasetDirectory);
    const boundarySnapshot = await loadBoundarySnapshot(
      options.boundariesDirectory,
      dataset.cities.map((city) => city.municipalityKey),
    );
    let report: CataloguePlan<any>;
    if (options.command === 'apply' || options.command === 'resume') {
      report = await readReport(options.reportPath);
    } else {
      const fullReport = await buildCataloguePlanFromStrapi({
        app,
        dataset,
        boundarySnapshot,
        routeKey: options.routeKey,
        codeVersion,
        mode: options.command === 'archive-check' ? 'calculate' : options.command,
      });
      report = scopeCataloguePlan(fullReport, options.target, {
        archiveOnly: options.command === 'archive-check',
      });
      await writeReport(options.reportPath, report);
    }
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        reportPath: options.reportPath,
        reportHash: report.reportHash,
        inputHash: report.inputHash,
        summary: report.summary,
        ...(options.command === 'archive-check' ? {
          control: 'archive-check',
          applySupported: false,
        } : {
          nextCommand: `npm run catalogue:apply -- --report ${options.reportPath} --confirm-hash ${report.reportHash} --operator <nom>`,
        }),
      }, null, 2)}\n`);
      return Number(report.summary.conflicts ?? 0) > 0 ? 2 : 0;
    }
    if (report.reportHash !== options.confirmHash) {
      throw new Error(`Le hash confirmé ne correspond pas au rapport exact ${report.reportHash}.`);
    }
    if (report.scope.intent === 'archive_check') {
      throw new Error('Un rapport archive-check est informatif et ne peut pas être appliqué.');
    }
    if (report.codeVersion !== codeVersion) {
      throw new Error(`Le rapport appartient au code ${report.codeVersion}, pas au code courant ${codeVersion}.`);
    }
    const run = await executeCataloguePlanOnStrapi({
      app,
      dataset,
      boundarySnapshot,
      routeKey: String(report.scope.routeKey ?? options.routeKey),
      codeVersion,
      report,
      confirmationHash: options.confirmHash!,
      operator: options.operator,
      signal: abortController.signal,
    });
    process.stdout.write(`${JSON.stringify({
      mode: options.command === 'resume' ? 'resume' : 'apply',
      reportHash: report.reportHash,
      runKey: run.runKey,
      status: run.status,
      cursor: run.cursor,
      counters: run.counters,
    }, null, 2)}\n`);
    return run.status === 'succeeded' ? 0 : 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await runtime.destroy();
  }
}

if (require.main === module) {
  // Une Promise en attente ne garde pas, à elle seule, l'event loop Node active.
  // Le timer évite donc un faux succès silencieux tant que la CLI n'est pas terminée.
  const keepAlive = setInterval(() => undefined, 60_000);
  runCatalogueCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }).finally(() => {
    clearInterval(keepAlive);
  });
}
