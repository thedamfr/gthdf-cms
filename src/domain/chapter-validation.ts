type CityPassage = {
  role?: unknown;
  featured?: unknown;
  city?: unknown;
};

type ChapterPublicationInput = {
  title?: unknown;
  cityPassages?: unknown;
};

export const MAX_FEATURED_INTERMEDIATES = 6;

function chapterLabel(chapter: ChapterPublicationInput): string {
  return typeof chapter.title === 'string' && chapter.title.trim()
    ? ` « ${chapter.title.trim()} »`
    : '';
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
