type CityPassage = {
  role?: unknown;
  featured?: unknown;
  city?: unknown;
};

type ChapterPublicationInput = {
  title?: unknown;
  cityPassages?: unknown;
};

export type PublishedChapterOrder = {
  documentId?: unknown;
  slug?: unknown;
  title?: unknown;
  displayOrder?: unknown;
};

export const MAX_FEATURED_INTERMEDIATES = 6;

function chapterLabel(chapter: ChapterPublicationInput): string {
  return typeof chapter.title === 'string' && chapter.title.trim()
    ? ` « ${chapter.title.trim()} »`
    : '';
}

function publishedChapterLabel(chapter: PublishedChapterOrder): string {
  const title = typeof chapter.title === 'string' && chapter.title.trim()
    ? `« ${chapter.title.trim()} »`
    : 'Chapitre sans titre';
  const identifier = typeof chapter.slug === 'string' && chapter.slug.trim()
    ? chapter.slug.trim()
    : typeof chapter.documentId === 'string' && chapter.documentId.trim()
      ? chapter.documentId.trim()
      : 'identifiant inconnu';

  return `${title} (${identifier})`;
}

export function validatePublishedChapterOrder(
  chapters: PublishedChapterOrder[]
): void {
  const chaptersByOrder = new Map<number, PublishedChapterOrder[]>();

  for (const chapter of chapters) {
    if (!Number.isInteger(chapter.displayOrder) || Number(chapter.displayOrder) < 1) {
      throw new Error(
        `${publishedChapterLabel(chapter)} doit avoir un ordre d’affichage entier positif avant publication.`
      );
    }

    const displayOrder = chapter.displayOrder as number;
    const matchingChapters = chaptersByOrder.get(displayOrder) ?? [];
    matchingChapters.push(chapter);
    chaptersByOrder.set(displayOrder, matchingChapters);
  }

  for (const [displayOrder, matchingChapters] of chaptersByOrder) {
    if (matchingChapters.length > 1) {
      throw new Error(
        `L’ordre d’affichage ${displayOrder} est utilisé par plusieurs chapitres : ${matchingChapters.map(publishedChapterLabel).join(', ')}.`
      );
    }
  }

  const expectedOrders = Array.from(
    { length: chapters.length },
    (_, index) => index + 1
  );
  const missingOrders = expectedOrders.filter((order) => !chaptersByOrder.has(order));
  const outOfSequenceOrders = [...chaptersByOrder.keys()]
    .filter((order) => order > chapters.length)
    .sort((left, right) => left - right);

  if (missingOrders.length > 0 || outOfSequenceOrders.length > 0) {
    const details = [
      ...(missingOrders.length > 0
        ? [`Valeur${missingOrders.length > 1 ? 's' : ''} manquante${missingOrders.length > 1 ? 's' : ''} : ${missingOrders.join(', ')}`]
        : []),
      ...(outOfSequenceOrders.length > 0
        ? [`Valeur${outOfSequenceOrders.length > 1 ? 's' : ''} hors séquence : ${outOfSequenceOrders.join(', ')}`]
        : []),
    ].join('. ');
    const affectedChapters = chapters
      .filter((chapter) => outOfSequenceOrders.includes(chapter.displayOrder as number))
      .map(publishedChapterLabel);

    throw new Error(
      `Les ordres d’affichage publiés doivent être contigus de 1 à ${chapters.length}. ${details}.${affectedChapters.length > 0 ? ` Chapitres concernés : ${affectedChapters.join(', ')}.` : ''}`
    );
  }
}

export function validatePublishedChapterRemoval(
  chapters: PublishedChapterOrder[],
  documentId: unknown
): void {
  if (typeof documentId !== 'string' || !documentId.trim()) {
    throw new Error('Le document à retirer doit avoir un identifiant stable.');
  }

  const removedChapters = chapters.filter((chapter) => chapter.documentId === documentId);
  if (removedChapters.length === 0) {
    return;
  }

  const remainingChapters = chapters.filter((chapter) => chapter.documentId !== documentId);

  try {
    validatePublishedChapterOrder(remainingChapters);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Impossible de retirer ${removedChapters.map(publishedChapterLabel).join(', ')} de l’ensemble publié. ${reason}`
    );
  }
}

export function validateChapterForPublication(chapter: ChapterPublicationInput): void {
  const passages = Array.isArray(chapter.cityPassages)
    ? chapter.cityPassages as CityPassage[]
    : [];

  if (passages.length < 2) {
    throw new Error(`Le chapitre${chapterLabel(chapter)} doit contenir au moins deux passages de ville.`);
  }

  const startCount = passages.filter((passage) => passage.role === 'start').length;
  const endCount = passages.filter((passage) => passage.role === 'end').length;

  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`Le chapitre${chapterLabel(chapter)} doit contenir exactement un départ et une arrivée.`);
  }

  if (passages[0]?.role !== 'start') {
    throw new Error(`Le premier passage doit être le départ du chapitre${chapterLabel(chapter)}.`);
  }

  if (passages[passages.length - 1]?.role !== 'end') {
    throw new Error(`Le dernier passage doit être l'arrivée du chapitre${chapterLabel(chapter)}.`);
  }

  if (passages.slice(1, -1).some((passage) => passage.role !== 'intermediate')) {
    throw new Error(`Les passages entre le départ et l'arrivée du chapitre${chapterLabel(chapter)} doivent être intermédiaires.`);
  }

  if (passages.some((passage) => !passage.city)) {
    throw new Error(`Chaque passage doit référencer une ville pour le chapitre${chapterLabel(chapter)}.`);
  }

  const featuredIntermediateCount = passages.filter((passage) => (
    passage.role === 'intermediate' && passage.featured === true
  )).length;

  if (featuredIntermediateCount > MAX_FEATURED_INTERMEDIATES) {
    throw new Error(
      `Le chapitre${chapterLabel(chapter)} peut contenir au maximum six passages intermédiaires mis en avant.`
    );
  }
}
