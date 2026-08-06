#!/usr/bin/env node

'use strict';

const { execFileSync } = require('node:child_process');

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

function parseCleverDirectDatabaseUri(directUri) {
  let parsed;
  try {
    parsed = new URL(directUri);
  } catch {
    throw new Error('URI PostgreSQL DIRECT invalide fournie par la CLI Clever.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('L’URI DIRECT fournie par Clever doit utiliser un protocole PostgreSQL.');
  }
  if (!parsed.hostname) {
    throw new Error('L’URI PostgreSQL DIRECT fournie par Clever ne contient aucun hôte.');
  }
  if (!parsed.username || !parsed.password) {
    throw new Error('L’URI PostgreSQL DIRECT fournie par Clever ne contient pas d’identifiants complets.');
  }

  let database;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).trim();
  } catch {
    throw new Error('Le nom de base de l’URI PostgreSQL DIRECT Clever est invalide.');
  }
  if (!database || database.includes('/')) {
    throw new Error('L’URI PostgreSQL DIRECT fournie par Clever ne contient aucun nom de base valide.');
  }

  return {
    database,
    host: parsed.hostname,
  };
}

function configureCleverRemoteDatabaseEnvironment({
  allowSelfSignedTls = false,
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
  environment.DATABASE_SSL_REJECT_UNAUTHORIZED = allowSelfSignedTls ? 'false' : 'true';
  delete environment.DATABASE_URL;

  if (directUri) {
    const target = parseCleverDirectDatabaseUri(directUri);
    environment.POSTGRESQL_ADDON_URI = directUri;
    return target;
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

module.exports = {
  configureCleverRemoteDatabaseEnvironment,
  flattenCleverEnvironment,
  loadCleverEnvironment,
  parseCleverDirectDatabaseUri,
};
