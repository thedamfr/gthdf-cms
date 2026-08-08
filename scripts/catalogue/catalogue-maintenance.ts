import { hashCanonical } from '../../src/domain/catalogue-core';

const REVISION_UID = 'api::itinerary-revision.itinerary-revision';
const BUSINESS_CAPTION = /^PRD04 ([a-f0-9]{64})$/;
const BUSINESS_NAME = /^([a-f0-9]{64})-[a-z0-9-]+\.(gpx|json)$/;

type Media = Record<string, any>;

export type CatalogueMediaGcCandidate = {
  mediaId: number | string | null;
  documentId: string | null;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  objectKey: string;
};

export type CatalogueMediaGcReport = {
  version: 1;
  mode: 'media_gc';
  dryRun: true;
  generatedAt: string;
  inputHash: string;
  reportHash: string;
  summary: {
    scannedMedia: number;
    catalogueMedia: number;
    referencedCatalogueMedia: number;
    orphanCandidates: number;
    orphanBytes: number;
  };
  candidates: CatalogueMediaGcCandidate[];
};

function objectKeyFromMediaUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url || /[\0\r\n]/.test(url)) return null;
  try {
    if (/^https?:\/\//i.test(url)) return new URL(url).pathname.replace(/^\/+/, '');
  } catch {
    return null;
  }
  return url.replace(/^\/+/, '');
}

function referenceKeys(media: Media | null | undefined, storedObjectKey?: unknown): string[] {
  const keys: string[] = [];
  if (media?.id !== null && media?.id !== undefined) keys.push(`id:${media.id}`);
  if (typeof media?.documentId === 'string' && media.documentId) keys.push(`document:${media.documentId}`);
  const objectKey = typeof storedObjectKey === 'string' && storedObjectKey
    ? storedObjectKey.replace(/^\/+/, '')
    : objectKeyFromMediaUrl(media?.url);
  if (objectKey) keys.push(`object:${objectKey}`);
  return keys;
}

function catalogueBusinessSha(media: Media): string | null {
  const caption = typeof media.caption === 'string' ? BUSINESS_CAPTION.exec(media.caption) : null;
  const name = typeof media.name === 'string' ? BUSINESS_NAME.exec(media.name) : null;
  if (!caption || !name || caption[1] !== name[1]) return null;
  if (name[2] === 'gpx' && media.mime !== 'application/gpx+xml') return null;
  if (name[2] === 'json' && media.mime !== 'application/json') return null;
  return caption[1];
}

export function selectOrphanCatalogueMedia(
  mediaFiles: readonly Media[],
  revisions: readonly Media[],
): {
  candidates: CatalogueMediaGcCandidate[];
  catalogueMedia: number;
  referencedCatalogueMedia: number;
} {
  const referenced = new Set<string>();
  for (const revision of revisions) {
    for (const key of referenceKeys(revision.generatedGpx, revision.generatedGpxObjectKey)) referenced.add(key);
    for (const key of referenceKeys(revision.displayGeometry, revision.displayGeometryObjectKey)) referenced.add(key);
  }
  let catalogueMedia = 0;
  let referencedCatalogueMedia = 0;
  const candidates: CatalogueMediaGcCandidate[] = [];
  for (const media of mediaFiles) {
    const sha256 = catalogueBusinessSha(media);
    const objectKey = objectKeyFromMediaUrl(media.url);
    if (!sha256 || !objectKey) continue;
    catalogueMedia += 1;
    const isReferenced = referenceKeys(media).some((key) => referenced.has(key));
    if (isReferenced) {
      referencedCatalogueMedia += 1;
      continue;
    }
    candidates.push({
      mediaId: media.id ?? null,
      documentId: typeof media.documentId === 'string' ? media.documentId : null,
      name: media.name,
      mime: media.mime,
      size: Number(media.size ?? 0),
      sha256,
      objectKey,
    });
  }
  candidates.sort((first, second) => first.objectKey.localeCompare(second.objectKey));
  return { candidates, catalogueMedia, referencedCatalogueMedia };
}

async function listRevisionDocuments(app: any): Promise<any[]> {
  const values: any[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const batch = await app.documents(REVISION_UID).findMany({
      sort: ['documentId:asc', 'id:asc'],
      pagination: { page, pageSize },
      fields: ['documentId', 'revisionKey', 'generatedGpxObjectKey', 'displayGeometryObjectKey'],
      populate: { generatedGpx: true, displayGeometry: true },
    });
    values.push(...batch);
    if (batch.length < pageSize) return values;
  }
}

async function listUploadFiles(app: any): Promise<any[]> {
  const values: any[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const batch = await app.db.query('plugin::upload.file').findMany({
      limit,
      offset,
      orderBy: { id: 'asc' },
    });
    values.push(...batch);
    if (batch.length < limit) return values;
  }
}

export async function buildCatalogueMediaGcDryRun(app: any): Promise<CatalogueMediaGcReport> {
  const [mediaFiles, revisions] = await Promise.all([
    listUploadFiles(app),
    listRevisionDocuments(app),
  ]);
  const selected = selectOrphanCatalogueMedia(mediaFiles, revisions);
  const inputHash = hashCanonical({
    version: 1,
    media: mediaFiles.map((media) => ({
      id: media.id ?? null,
      documentId: media.documentId ?? null,
      name: media.name ?? null,
      caption: media.caption ?? null,
      mime: media.mime ?? null,
      size: media.size ?? null,
      hash: media.hash ?? null,
      url: media.url ?? null,
      updatedAt: media.updatedAt ?? null,
    })),
    references: revisions.map((revision) => ({
      revisionKey: revision.revisionKey,
      generatedGpx: referenceKeys(revision.generatedGpx, revision.generatedGpxObjectKey),
      displayGeometry: referenceKeys(revision.displayGeometry, revision.displayGeometryObjectKey),
    })).sort((first, second) => String(first.revisionKey).localeCompare(String(second.revisionKey))),
  });
  const generatedAt = new Date().toISOString();
  const reportWithoutHash = {
    version: 1 as const,
    mode: 'media_gc' as const,
    dryRun: true as const,
    generatedAt,
    inputHash,
    summary: {
      scannedMedia: mediaFiles.length,
      catalogueMedia: selected.catalogueMedia,
      referencedCatalogueMedia: selected.referencedCatalogueMedia,
      orphanCandidates: selected.candidates.length,
      orphanBytes: selected.candidates.reduce((sum, media) => sum + media.size, 0),
    },
    candidates: selected.candidates,
  };
  const { generatedAt: _generatedAt, ...hashable } = reportWithoutHash;
  return {
    ...reportWithoutHash,
    reportHash: hashCanonical(hashable),
  };
}
