import type { Core } from '@strapi/strapi';

export async function withSchemaLock<T>(connection: Core.Strapi['db']['connection'], synchronize: () => Promise<T>): Promise<T> {
  return connection.transaction(async (transaction) => {
    // GTHS: separate from the publication and catalogue advisory lock keys.
    // The transaction releases the lock on both success and failure.
    await transaction.raw('SELECT pg_advisory_xact_lock(?)', [0x47544853]);
    return synchronize();
  });
}
