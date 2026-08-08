import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCataloguePlan,
  CatalogueOperationError,
  finalizeCataloguePlan,
  type CatalogueApplyAdapter,
  type CatalogueRunRecord,
} from '../src/domain/catalogue-job';

const SOURCE_HASH = 'a'.repeat(64);
const INPUT_HASH = 'b'.repeat(64);

function report() {
  return finalizeCataloguePlan({
    version: 1 as const,
    mode: 'calculate' as const,
    codeVersion: 'test-code',
    algorithmVersion: 'test-algorithm',
    inputHash: INPUT_HASH,
    scope: { sourceInputHash: SOURCE_HASH },
    summary: { operations: 2 },
    operations: [{ key: 'one' }, { key: 'two' }],
  });
}

class MemoryAdapter implements CatalogueApplyAdapter<{ key: string }> {
  run: CatalogueRunRecord | null = null;
  owner: string | null = null;
  sourceHash = SOURCE_HASH;
  applied: string[] = [];
  checkpoints: Array<{ status: string; cursor: number }> = [];
  heartbeatCount = 0;
  sourceReadCount = 0;
  verifyRunStateCount = 0;
  failOn: string | null = null;

  async readCurrentInputHash() { return INPUT_HASH; }
  async readCurrentSourceInputHash() {
    this.sourceReadCount += 1;
    return this.sourceHash;
  }
  async verifyRunState() {
    this.verifyRunStateCount += 1;
  }
  async acquireLock(input: any) {
    if (this.owner) return false;
    this.owner = input.ownerKey;
    return true;
  }
  async heartbeatLock(input: any) {
    assert.equal(input.ownerKey, this.owner);
    this.heartbeatCount += 1;
  }
  async releaseLock(input: any) {
    assert.equal(input.ownerKey, this.owner);
    this.owner = null;
  }
  async beginOrResumeRun(input: any) {
    if (!this.run) this.run = {
      runKey: input.runKey,
      status: 'running',
      cursor: 0,
      counters: {},
      fresh: true,
    };
    else this.run = { ...this.run, fresh: false };
    return this.run;
  }
  async checkpointRun(input: any) {
    assert.equal(input.ownerKey, this.owner);
    this.checkpoints.push({ status: input.status, cursor: input.cursor });
    this.run = {
      runKey: input.runKey,
      status: input.status,
      cursor: input.cursor,
      counters: input.counters,
      fresh: false,
    };
  }
  async applyOperation(input: any) {
    if (this.failOn === input.operation.key) throw new Error(`failure:${input.operation.key}`);
    this.applied.push(input.operation.key);
    return 'created' as const;
  }
}

test('le leaseOwner est propre à l’invocation et la reprise repart exactement du curseur', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  adapter.failOn = 'two';
  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  }), /failure:two/);
  assert.deepEqual(adapter.applied, ['one']);
  assert.equal(adapter.run?.cursor, 1);
  const firstOwnerWasReleased = adapter.owner === null;
  assert.equal(firstOwnerWasReleased, true);

  adapter.failOn = null;
  const resumed = await applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  });
  assert.deepEqual(adapter.applied, ['one', 'two']);
  assert.equal(resumed.status, 'succeeded');
  assert.equal(resumed.cursor, 2);
});

test('la vérification initiale longue est couverte par le heartbeat du lease', async () => {
  const adapter = new MemoryAdapter();
  const originalRead = adapter.readCurrentInputHash.bind(adapter);
  adapter.readCurrentInputHash = async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return originalRead();
  };
  const plan = report();
  await applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
    leaseMilliseconds: 10_000,
    heartbeatIntervalMilliseconds: 5,
  });
  assert.ok(adapter.heartbeatCount > 0);
});

test('un second apply stale ne corrompt jamais le run succeeded historique', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  adapter.run = {
    runKey: `catalogue:${plan.reportHash}`,
    status: 'succeeded',
    cursor: 2,
    counters: { created: 2 },
    fresh: false,
  };
  adapter.sourceHash = 'c'.repeat(64);
  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  }), /source ont changé|source ont changé|source/);
  assert.equal(adapter.run.status, 'succeeded');
  assert.deepEqual(adapter.checkpoints, []);
});

test('un second apply succeeded relit les sources et les artefacts sans réappliquer', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  adapter.run = {
    runKey: `catalogue:${plan.reportHash}`,
    status: 'succeeded',
    cursor: 2,
    counters: { created: 2 },
    fresh: false,
  };
  const result = await applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(adapter.sourceReadCount, 1);
  assert.equal(adapter.verifyRunStateCount, 1);
  assert.deepEqual(adapter.applied, []);
  assert.deepEqual(adapter.checkpoints, []);
});

test('les objets orphelins structurés sont persistés dans le checkpoint d’échec', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  adapter.applyOperation = async () => {
    throw new CatalogueOperationError('upload puis rollback', {
      operationKey: 'one',
      revisionKey: 'revision:one',
      orphanObjectKeys: ['catalogue/orphan.gpx'],
    });
  };
  let capturedErrorSummary: Record<string, unknown> | null = null;
  const checkpoint = adapter.checkpointRun.bind(adapter);
  adapter.checkpointRun = async (input: any) => {
    capturedErrorSummary = input.errorSummary ?? null;
    await checkpoint(input);
  };
  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  }), /upload puis rollback/);
  assert.deepEqual(capturedErrorSummary, {
    name: 'CatalogueOperationError',
    message: 'upload puis rollback',
    operationKey: 'one',
    revisionKey: 'revision:one',
    orphanObjectKeys: ['catalogue/orphan.gpx'],
  });
});

test('une reprise après commit puis crash avant checkpoint réexécute op0 par CAS idempotent', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  const committed = new Set<string>();
  const attempts: string[] = [];
  adapter.applyOperation = async (input: any) => {
    attempts.push(input.operation.key);
    if (committed.has(input.operation.key)) return 'reused' as const;
    committed.add(input.operation.key);
    return 'created' as const;
  };
  let remainingCheckpointFailures = 2;
  const checkpoint = adapter.checkpointRun.bind(adapter);
  adapter.checkpointRun = async (input: any) => {
    if (remainingCheckpointFailures > 0) {
      remainingCheckpointFailures -= 1;
      throw new Error('checkpoint unavailable');
    }
    await checkpoint(input);
  };
  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  }), /checkpoint unavailable/);
  assert.deepEqual([...committed], ['one']);
  assert.equal(adapter.run?.cursor, 0);

  const resumed = await applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  });
  assert.deepEqual(attempts, ['one', 'one', 'two']);
  assert.deepEqual(resumed.counters, { created: 1, reused: 1, reverified: 0, skipped: 0 });
  assert.equal(resumed.status, 'succeeded');
});

test('un second apply refuse un post-état muté sans altérer le run succeeded', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  adapter.run = {
    runKey: `catalogue:${plan.reportHash}`,
    status: 'succeeded',
    cursor: 2,
    counters: { created: 2 },
    fresh: false,
  };
  adapter.verifyRunState = async () => {
    throw new Error('post-state mutated');
  };
  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'qa',
  }), /post-state mutated/);
  assert.equal(adapter.run.status, 'succeeded');
  assert.deepEqual(adapter.applied, []);
  assert.deepEqual(adapter.checkpoints, []);
});

test('un worker qui perd son lease ne peut pas écraser le run succeeded du repreneur', async () => {
  const adapter = new MemoryAdapter();
  const plan = report();
  let firstOwner: string | null = null;
  const acquireLock = adapter.acquireLock.bind(adapter);
  adapter.acquireLock = async (input: any) => {
    const acquired = await acquireLock(input);
    firstOwner = input.ownerKey;
    return acquired;
  };
  adapter.heartbeatLock = async (input: any) => {
    assert.equal(input.ownerKey, firstOwner);
    // Le worker B a repris le lease expiré et terminé le même run pendant que
    // le worker A revenait de son opération déjà commitée.
    adapter.owner = 'worker-b';
    adapter.run = {
      runKey: input.runKey,
      status: 'succeeded',
      cursor: plan.operations.length,
      counters: { created: plan.operations.length },
      fresh: false,
    };
    throw new Error('Le verrou catalogue a expiré ou changé de propriétaire.');
  };
  adapter.checkpointRun = async (input: any) => {
    if (input.ownerKey !== adapter.owner) {
      throw new Error('Le checkpoint catalogue est refusé : le lease a expiré ou changé de propriétaire.');
    }
    throw new Error('Le worker A ne doit jamais atteindre un checkpoint autorisé.');
  };
  adapter.releaseLock = async () => {
    // Comme l’adapter PostgreSQL, une release par l’ancien owner est un no-op.
  };

  await assert.rejects(() => applyCataloguePlan({
    adapter,
    report: plan,
    confirmationHash: plan.reportHash,
    operator: 'worker-a',
  }), /checkpoint catalogue est refusé/);
  assert.equal(firstOwner !== adapter.owner, true);
  assert.equal(adapter.run?.status, 'succeeded');
  assert.equal(adapter.run?.cursor, plan.operations.length);
  assert.deepEqual(adapter.run?.counters, { created: plan.operations.length });
});
