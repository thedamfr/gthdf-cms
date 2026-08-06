type AnchorDirection = 'AB' | 'BA';

type GpxBuilderAnchor = {
  status?: unknown;
  sourceSha256?: unknown;
  trackIndex?: unknown;
  segmentIndex?: unknown;
  pointIndex?: unknown;
  fraction?: unknown;
  chainageMetres?: unknown;
  projectedLatitude?: unknown;
  projectedLongitude?: unknown;
  distanceToCityMetres?: unknown;
  algorithmVersion?: unknown;
};

type GpxBuilderPassage = {
  gpxAnchorAB?: unknown;
  gpxAnchorBA?: unknown;
};

type GpxBuilderJunction = {
  status?: unknown;
  sourceSha256?: unknown;
  nextSourceSha256?: unknown;
  gapMetres?: unknown;
  reviewNote?: unknown;
};

export type GpxBuilderChapter = {
  documentId?: unknown;
  title?: unknown;
  slug?: unknown;
  displayOrder?: unknown;
  gpxFileAB?: unknown;
  gpxFileBA?: unknown;
  cityPassages?: unknown;
  gpxJunctionAfterAB?: unknown;
  gpxJunctionAfterBA?: unknown;
};

type ValidatedChapterContract = {
  sourceSha256AB: string;
  sourceSha256BA: string;
  junctionAfterAB: GpxBuilderJunction;
  junctionAfterBA: GpxBuilderJunction;
};

const SHA_256 = /^[a-f0-9]{64}$/i;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function chapterLabel(chapter: GpxBuilderChapter): string {
  if (typeof chapter.title === 'string' && chapter.title.trim()) {
    return ` « ${chapter.title.trim()} »`;
  }
  return '';
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || !DECIMAL.test(value.trim())) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasMediaReference(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'string') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(hasMediaReference);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const relation = value as Record<string, unknown>;
  if ('set' in relation) {
    return hasMediaReference(relation.set);
  }
  if ('connect' in relation) {
    return hasMediaReference(relation.connect);
  }
  if ('disconnect' in relation) {
    return false;
  }
  return typeof relation.id === 'number'
    || typeof relation.documentId === 'string'
    || typeof relation.url === 'string';
}

function anchorForDirection(
  passage: GpxBuilderPassage,
  direction: AnchorDirection
): GpxBuilderAnchor | null {
  const value = direction === 'AB' ? passage.gpxAnchorAB : passage.gpxAnchorBA;
  return typeof value === 'object' && value !== null
    ? value as GpxBuilderAnchor
    : null;
}

function validateAnchor(
  anchor: GpxBuilderAnchor | null,
  direction: AnchorDirection,
  passageIndex: number,
  chapter: GpxBuilderChapter
): { sourceSha256: string; chainageMetres: number } {
  if (!anchor || anchor.status !== 'validated') {
    throw new Error(
      `Le passage ${passageIndex + 1} du chapitre${chapterLabel(chapter)} doit avoir un ancrage ${direction} validé.`
    );
  }

  if (typeof anchor.sourceSha256 !== 'string' || !SHA_256.test(anchor.sourceSha256)) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède une empreinte SHA-256 invalide.`);
  }
  for (const [field, value] of [
    ['trackIndex', anchor.trackIndex],
    ['segmentIndex', anchor.segmentIndex],
    ['pointIndex', anchor.pointIndex],
  ] as const) {
    if (!Number.isInteger(value) || Number(value) < 0) {
      throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède un ${field} invalide.`);
    }
  }

  const fraction = finiteNumber(anchor.fraction);
  const chainageMetres = finiteNumber(anchor.chainageMetres);
  const latitude = finiteNumber(anchor.projectedLatitude);
  const longitude = finiteNumber(anchor.projectedLongitude);
  const distanceToCityMetres = finiteNumber(anchor.distanceToCityMetres);

  if (fraction === null || fraction < 0 || fraction > 1) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède une fraction invalide.`);
  }
  if (chainageMetres === null || chainageMetres < 0) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède un chaînage invalide.`);
  }
  if (latitude === null || latitude < -90 || latitude > 90) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède une latitude invalide.`);
  }
  if (longitude === null || longitude < -180 || longitude > 180) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède une longitude invalide.`);
  }
  if (distanceToCityMetres === null || distanceToCityMetres < 0) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} possède une distance de contrôle invalide.`);
  }
  if (typeof anchor.algorithmVersion !== 'string' || !anchor.algorithmVersion.trim()) {
    throw new Error(`L’ancrage ${direction} du passage ${passageIndex + 1} doit préciser sa version d’algorithme.`);
  }

  return {
    sourceSha256: anchor.sourceSha256.toLowerCase(),
    chainageMetres,
  };
}

function validateDirectionAnchors(
  passages: GpxBuilderPassage[],
  direction: AnchorDirection,
  chapter: GpxBuilderChapter
): string {
  const anchors = passages.map((passage, index) => (
    validateAnchor(anchorForDirection(passage, direction), direction, index, chapter)
  ));
  const sourceHashes = new Set(anchors.map((anchor) => anchor.sourceSha256));
  if (sourceHashes.size !== 1) {
    throw new Error(`Tous les ancrages ${direction} du chapitre${chapterLabel(chapter)} doivent référencer le même GPX.`);
  }

  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1].chainageMetres;
    const current = anchors[index].chainageMetres;
    const ordered = direction === 'AB' ? current > previous : current < previous;
    if (!ordered) {
      throw new Error(
        `Les ancrages ${direction} du chapitre${chapterLabel(chapter)} ne suivent pas l’ordre des passages.`
      );
    }
  }

  return anchors[0].sourceSha256;
}

function validateJunction(
  value: unknown,
  direction: AnchorDirection,
  sourceSha256: string,
  chapter: GpxBuilderChapter
): GpxBuilderJunction {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Le chapitre${chapterLabel(chapter)} doit qualifier sa jonction ${direction}.`);
  }
  const junction = value as GpxBuilderJunction;
  if (junction.status !== 'exact' && junction.status !== 'accepted_gap') {
    throw new Error(`La jonction ${direction} du chapitre${chapterLabel(chapter)} doit être exacte ou explicitement acceptée.`);
  }
  if (
    typeof junction.sourceSha256 !== 'string'
    || junction.sourceSha256.toLowerCase() !== sourceSha256
    || typeof junction.nextSourceSha256 !== 'string'
    || !SHA_256.test(junction.nextSourceSha256)
  ) {
    throw new Error(`La jonction ${direction} du chapitre${chapterLabel(chapter)} référence une empreinte invalide.`);
  }
  const gapMetres = finiteNumber(junction.gapMetres);
  if (gapMetres === null || gapMetres < 0) {
    throw new Error(`La jonction ${direction} du chapitre${chapterLabel(chapter)} possède un écart invalide.`);
  }
  if (
    junction.status === 'accepted_gap'
    && (typeof junction.reviewNote !== 'string' || !junction.reviewNote.trim())
  ) {
    throw new Error(`La jonction ${direction} acceptée du chapitre${chapterLabel(chapter)} doit être justifiée.`);
  }
  return junction;
}

export function validateGpxBuilderChapter(
  chapter: GpxBuilderChapter
): ValidatedChapterContract {
  if (!hasMediaReference(chapter.gpxFileAB) || !hasMediaReference(chapter.gpxFileBA)) {
    throw new Error(`Le chapitre${chapterLabel(chapter)} doit disposer des deux médias GPX officiels.`);
  }
  const passages = Array.isArray(chapter.cityPassages)
    ? chapter.cityPassages as GpxBuilderPassage[]
    : [];
  if (passages.length < 2) {
    throw new Error(`Le chapitre${chapterLabel(chapter)} doit contenir au moins deux passages qualifiés.`);
  }

  const sourceSha256AB = validateDirectionAnchors(passages, 'AB', chapter);
  const sourceSha256BA = validateDirectionAnchors(passages, 'BA', chapter);
  const junctionAfterAB = validateJunction(
    chapter.gpxJunctionAfterAB,
    'AB',
    sourceSha256AB,
    chapter
  );
  const junctionAfterBA = validateJunction(
    chapter.gpxJunctionAfterBA,
    'BA',
    sourceSha256BA,
    chapter
  );

  return { sourceSha256AB, sourceSha256BA, junctionAfterAB, junctionAfterBA };
}

export function validateGpxBuilderRoute(chapters: GpxBuilderChapter[]): void {
  if (chapters.length === 0) {
    throw new Error('Le GPX Builder ne peut pas être activé sans chapitre publié.');
  }
  const seenDisplayOrders = new Set<number>();
  const sortable = chapters.map((chapter) => {
    const displayOrder = finiteNumber(chapter.displayOrder);
    if (
      displayOrder === null
      || !Number.isInteger(displayOrder)
      || displayOrder < 1
      || seenDisplayOrders.has(displayOrder)
    ) {
      throw new Error(
        `Le chapitre${chapterLabel(chapter)} doit avoir un ordre d’affichage valide et unique.`
      );
    }
    seenDisplayOrders.add(displayOrder);
    return { chapter, displayOrder };
  });
  const ordered = sortable
    .sort((first, second) => first.displayOrder - second.displayOrder)
    .map(({ chapter }) => chapter);
  const contracts = ordered.map(validateGpxBuilderChapter);

  for (let index = 0; index < ordered.length; index += 1) {
    const nextAb = contracts[(index + 1) % contracts.length];
    const nextBa = contracts[(index - 1 + contracts.length) % contracts.length];
    if (
      String(contracts[index].junctionAfterAB.nextSourceSha256).toLowerCase()
      !== nextAb.sourceSha256AB
    ) {
      throw new Error(`La jonction AB après${chapterLabel(ordered[index])} ne cible pas le chapitre suivant.`);
    }
    if (
      String(contracts[index].junctionAfterBA.nextSourceSha256).toLowerCase()
      !== nextBa.sourceSha256BA
    ) {
      throw new Error(`La jonction BA après${chapterLabel(ordered[index])} ne cible pas le chapitre précédent.`);
    }
  }
}
