import { hashCanonical } from './catalogue-core';
import { randomUUID } from 'node:crypto';

const SHA_256 = /^[a-f0-9]{64}$/;
const FORBIDDEN_REPORT_KEYS = new Set([
  'bytes',
  'coordinates',
  'displayGeometry',
  'geometry',
  'geojson',
  'gpx',
  'gpxBase64',
  'payload',
  'points',
  'sequences',
  'xml',
]);

export type CatalogueJobMode = 'import' | 'anchors' | 'calculate' | 'apply' | 'resume';

export type CataloguePlan<Operation extends Record<string, unknown>> = {
  version: 1;
  mode: 'import' | 'anchors' | 'calculate';
  codeVersion: string;
  algorithmVersion: string;
  inputHash: string;
  scope: Record<string, unknown>;
  summary: Record<string, number>;
  operations: Operation[];
  generatedAt?: string;
  reportHash: string;
};

export type CatalogueRunStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export type CatalogueRunRecord = {
  runKey: string;
  status: CatalogueRunStatus;
  cursor: number;
  counters: Record<string, number>;
  fresh?: boolean;
};

export class CatalogueOperationError extends Error {
  readonly catalogueDetails: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(message: string, catalogueDetails: Record<string, unknown>, cause?: unknown) {
    super(message);
    this.name = 'CatalogueOperationError';
    this.catalogueDetails = catalogueDetails;
    this.cause = cause;
  }
}

export interface CatalogueApplyAdapter<Operation extends Record<string, unknown>> {
  readCurrentInputHash(): Promise<string>;
  readCurrentSourceInputHash?(): Promise<string>;
  acquireLock(input: {
    lockKey: string;
    runKey: string;
    ownerKey: string;
    acquiredAt: string;
    expiresAt: string;
  }): Promise<boolean>;
  heartbeatLock(input: {
    lockKey: string;
    runKey: string;
    ownerKey: string;
    heartbeatAt: string;
    expiresAt: string;
  }): Promise<void>;
  releaseLock(input: { lockKey: string; runKey: string; ownerKey: string }): Promise<void>;
  beginOrResumeRun(input: {
    runKey: string;
    report: CataloguePlan<Operation>;
    operator: string;
    startedAt: string;
    heartbeatAt: string;
    lockExpiresAt: string;
  }): Promise<CatalogueRunRecord>;
  /**
   * Revalide une fois par invocation les artefacts déjà créés par le plan.
   * Ce hook est notamment exécuté avant de rendre un second apply succeeded.
   */
  verifyRunState?(input: {
    report: CataloguePlan<Operation>;
    run: CatalogueRunRecord;
  }): Promise<void>;
  applyOperation(input: {
    operation: Operation;
    operationIndex: number;
    report: CataloguePlan<Operation>;
    run: CatalogueRunRecord;
    /** L’adapter doit comparer ce hash dans la même transaction que ses écritures DB. */
    expectedInputHash: string;
  }): Promise<'created' | 'reused' | 'reverified' | 'skipped'>;
  checkpointRun(input: {
    lockKey: string;
    runKey: string;
    ownerKey: string;
    status: CatalogueRunStatus;
    cursor: number;
    counters: Record<string, number>;
    heartbeatAt: string;
    lockExpiresAt?: string | null;
    completedAt?: string | null;
    errorSummary?: Record<string, unknown> | null;
  }): Promise<void>;
}

function requireSha256(label: string, value: unknown): string {
  if (typeof value !== 'string' || !SHA_256.test(value)) {
    throw new Error(`${label} doit être une empreinte SHA-256 minuscule.`);
  }
  return value;
}

function hashableReport<Operation extends Record<string, unknown>>(
  report: Omit<CataloguePlan<Operation>, 'reportHash'> | CataloguePlan<Operation>,
): Record<string, unknown> {
  const { generatedAt: _generatedAt, reportHash: _reportHash, ...hashable } = report as CataloguePlan<Operation>;
  return hashable;
}

export function assertReportIsMetadataOnly(value: unknown, path = 'report'): void {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new Error(`${path} ne doit contenir aucun octet d’artefact.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertReportIsMetadataOnly(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string' && (value.length > 2_048 || /^\s*<\?xml/i.test(value))) {
    throw new Error(`${path} contient une charge utile trop longue ou XML.`);
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_REPORT_KEYS.has(key)) {
      throw new Error(`${path}.${key} est interdit dans un rapport catalogue.`);
    }
    assertReportIsMetadataOnly(child, `${path}.${key}`);
  }
}

export function finalizeCataloguePlan<Operation extends Record<string, unknown>>(
  report: Omit<CataloguePlan<Operation>, 'reportHash'>,
): CataloguePlan<Operation> {
  requireSha256('inputHash', report.inputHash);
  assertReportIsMetadataOnly(report);
  const reportHash = hashCanonical(hashableReport(report));
  return { ...report, reportHash };
}

export function validateCataloguePlan<Operation extends Record<string, unknown>>(
  report: CataloguePlan<Operation>,
): void {
  if (report.version !== 1 || !['import', 'anchors', 'calculate'].includes(report.mode)) {
    throw new Error('Le rapport catalogue ne respecte pas le format version 1.');
  }
  requireSha256('inputHash', report.inputHash);
  requireSha256('reportHash', report.reportHash);
  assertReportIsMetadataOnly(report);
  const actual = hashCanonical(hashableReport(report));
  if (actual !== report.reportHash) {
    throw new Error('Le hash du rapport catalogue ne correspond pas exactement à son contenu.');
  }
}

export function requireApplyConfirmation<Operation extends Record<string, unknown>>(
  report: CataloguePlan<Operation>,
  confirmationHash: string | null | undefined,
): void {
  validateCataloguePlan(report);
  if (!confirmationHash || confirmationHash.toLowerCase() !== report.reportHash) {
    throw new Error(`L’application exige --confirm-hash ${report.reportHash}.`);
  }
}

function iso(clock: () => Date): string {
  return clock().toISOString();
}

function expiry(clock: () => Date, leaseMilliseconds: number): string {
  return new Date(clock().getTime() + leaseMilliseconds).toISOString();
}

function errorSummary(error: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  };
  if (error instanceof CatalogueOperationError) {
    assertReportIsMetadataOnly(error.catalogueDetails, 'errorSummary');
    Object.assign(summary, error.catalogueDetails);
  }
  return summary;
}

/**
 * Applique un plan déjà relu. Chaque opération est idempotente dans l’adapter,
 * puis le curseur est persisté. Le hash d’entrée est revérifié avant chaque
 * unité courte : une mutation concurrente ferme l’application immédiatement.
 */
export async function applyCataloguePlan<Operation extends Record<string, unknown>>(input: {
  adapter: CatalogueApplyAdapter<Operation>;
  report: CataloguePlan<Operation>;
  confirmationHash: string;
  operator: string;
  signal?: AbortSignal;
  clock?: () => Date;
  leaseMilliseconds?: number;
  heartbeatIntervalMilliseconds?: number;
  lockKey?: string;
}): Promise<CatalogueRunRecord> {
  requireApplyConfirmation(input.report, input.confirmationHash);
  if (!input.operator.trim()) throw new Error('Un opérateur explicite est requis.');
  const clock = input.clock ?? (() => new Date());
  const leaseMilliseconds = input.leaseMilliseconds ?? 120_000;
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 10_000) {
    throw new Error('La durée de bail doit être un entier d’au moins dix secondes.');
  }
  const lockKey = input.lockKey ?? 'catalogue-apply-v1';
  const heartbeatIntervalMilliseconds = input.heartbeatIntervalMilliseconds
    ?? Math.min(30_000, Math.max(1_000, Math.floor(leaseMilliseconds / 3)));
  if (heartbeatIntervalMilliseconds >= leaseMilliseconds) {
    throw new Error('L’intervalle de heartbeat doit rester inférieur à la durée du bail.');
  }
  const runKey = `catalogue:${input.report.reportHash}`;
  const ownerKey = randomUUID();
  const acquiredAt = iso(clock);
  let lockExpiresAt = expiry(clock, leaseMilliseconds);
  const acquired = await input.adapter.acquireLock({ lockKey, runKey, ownerKey, acquiredAt, expiresAt: lockExpiresAt });
  if (!acquired) throw new Error('Un autre job catalogue détient encore le verrou d’application.');

  // Keep the lease alive for the whole critical section, including loading a
  // resumable run and the potentially expensive initial input verification.
  // Limiting heartbeats to applyOperation would let a fresh run lose its lock
  // before operation zero on a large catalogue.
  let periodicHeartbeatError: unknown;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight || periodicHeartbeatError) return;
    const heartbeatAt = iso(clock);
    lockExpiresAt = expiry(clock, leaseMilliseconds);
    heartbeatInFlight = input.adapter.heartbeatLock({
      lockKey,
      runKey,
      ownerKey,
      heartbeatAt,
      expiresAt: lockExpiresAt,
    }).catch((error) => { periodicHeartbeatError = error; })
      .finally(() => { heartbeatInFlight = null; });
  }, heartbeatIntervalMilliseconds);
  const assertHeartbeat = async (): Promise<void> => {
    if (heartbeatInFlight) await heartbeatInFlight;
    if (periodicHeartbeatError) throw periodicHeartbeatError;
  };

  let run: CatalogueRunRecord | null = null;
  let currentCursor = 0;
  let currentCounters: Record<string, number> = {};
  try {
    run = await input.adapter.beginOrResumeRun({
      runKey,
      report: input.report,
      operator: input.operator,
      startedAt: acquiredAt,
      heartbeatAt: acquiredAt,
      lockExpiresAt,
    });
    await assertHeartbeat();
    const expectedSourceHash = input.report.scope.sourceInputHash;
    if (
      typeof expectedSourceHash === 'string'
      && input.adapter.readCurrentSourceInputHash
      && await input.adapter.readCurrentSourceInputHash() !== expectedSourceHash
    ) throw new Error('Les octets ou métadonnées source ont changé depuis le dry-run exact.');
    await assertHeartbeat();
    if (run.status === 'succeeded') {
      if (input.adapter.verifyRunState) {
        await input.adapter.verifyRunState({ report: input.report, run });
        await assertHeartbeat();
      }
      return run;
    }
    if (run.fresh === true && await input.adapter.readCurrentInputHash() !== input.report.inputHash) {
      throw new Error('Les entrées courantes ont changé depuis le dry-run ; application refusée.');
    }
    await assertHeartbeat();
    if (input.adapter.verifyRunState) {
      await input.adapter.verifyRunState({ report: input.report, run });
      await assertHeartbeat();
    }
    const counters = { created: 0, reused: 0, reverified: 0, skipped: 0, ...(run.counters ?? {}) };
    currentCursor = run.cursor;
    currentCounters = counters;
    for (let operationIndex = currentCursor; operationIndex < input.report.operations.length; operationIndex += 1) {
      if (input.signal?.aborted) {
        const heartbeatAt = iso(clock);
        await input.adapter.checkpointRun({
          lockKey,
          runKey,
          ownerKey,
          status: 'interrupted',
          cursor: operationIndex,
          counters,
          heartbeatAt,
          lockExpiresAt: null,
          completedAt: heartbeatAt,
          errorSummary: { message: 'Interruption demandée par le signal.' },
        });
        return { ...run, status: 'interrupted', cursor: operationIndex, counters };
      }
      // La comparaison de source doit être répétée par l’adapter sous la même
      // transaction/CAS que l’écriture. Un read séparé ici laisserait une
      // fenêtre de course et empêcherait les plans dont les sorties évoluent
      // légitimement au fil du curseur (import/anchors/revisions).
      let result: 'created' | 'reused' | 'reverified' | 'skipped';
      result = await input.adapter.applyOperation({
        operation: input.report.operations[operationIndex],
        operationIndex,
        report: input.report,
        run,
        expectedInputHash: input.report.inputHash,
      });
      await assertHeartbeat();
      counters[result] = (counters[result] ?? 0) + 1;
      currentCursor = operationIndex + 1;
      run = { ...run, cursor: currentCursor, counters };
      const heartbeatAt = iso(clock);
      lockExpiresAt = expiry(clock, leaseMilliseconds);
      await input.adapter.heartbeatLock({ lockKey, runKey, ownerKey, heartbeatAt, expiresAt: lockExpiresAt });
      await input.adapter.checkpointRun({
        lockKey,
        runKey,
        ownerKey,
        status: 'running',
        cursor: currentCursor,
        counters,
        heartbeatAt,
        lockExpiresAt,
      });
    }
    const completedAt = iso(clock);
    await input.adapter.checkpointRun({
      lockKey,
      runKey,
      ownerKey,
      status: 'succeeded',
      cursor: input.report.operations.length,
      counters,
      heartbeatAt: completedAt,
      lockExpiresAt: null,
      completedAt,
      errorSummary: null,
    });
    return { ...run, status: 'succeeded', cursor: input.report.operations.length, counters };
  } catch (error) {
    if (run && run.status !== 'succeeded') {
      const completedAt = iso(clock);
      await input.adapter.checkpointRun({
        lockKey,
        runKey,
        ownerKey,
        status: 'failed',
        cursor: currentCursor,
        counters: currentCounters,
        heartbeatAt: completedAt,
        lockExpiresAt: null,
        completedAt,
        errorSummary: errorSummary(error),
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (heartbeatInFlight) await heartbeatInFlight;
    await input.adapter.releaseLock({ lockKey, runKey, ownerKey });
  }
}

export async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<Result>,
): Promise<Result[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new Error('La concurrence catalogue doit rester comprise entre 1 et 3.');
  }
  const results = new Array<Result>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}
