export function normalizeAlternativeNames(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('Les noms alternatifs doivent être un tableau de textes.');
  }

  const seenNames = new Set<string>();

  return value.map((name) => {
    if (typeof name !== 'string') {
      throw new Error('Les noms alternatifs doivent contenir uniquement des textes.');
    }

    const normalizedName = name.trim();

    if (!normalizedName) {
      throw new Error('Un nom alternatif ne peut pas être vide.');
    }

    const comparisonKey = normalizedName
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('fr');

    if (seenNames.has(comparisonKey)) {
      throw new Error(`Le nom alternatif « ${normalizedName} » est dupliqué.`);
    }

    seenNames.add(comparisonKey);

    return normalizedName;
  });
}

type CityCoordinateInput = {
  latitude?: unknown;
  longitude?: unknown;
  coordinateSource?: unknown;
};

function hasCoordinate(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function validateCityCoordinates(data: CityCoordinateInput): void {
  const hasLatitude = hasCoordinate(data.latitude);
  const hasLongitude = hasCoordinate(data.longitude);

  if (hasLatitude !== hasLongitude) {
    throw new Error('La latitude et la longitude doivent être renseignées ensemble.');
  }

  if (!hasLatitude) {
    return;
  }

  const latitude = Number(data.latitude);
  const longitude = Number(data.longitude);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error('La latitude doit être comprise entre -90 et 90.');
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('La longitude doit être comprise entre -180 et 180.');
  }

  if (!data.coordinateSource || typeof data.coordinateSource !== 'object') {
    throw new Error('La provenance des coordonnées est obligatoire.');
  }

  const coordinateSource = data.coordinateSource as Record<string, unknown>;
  if (
    !isNonEmptyString(coordinateSource.source)
    || !isNonEmptyString(coordinateSource.date)
    || !isNonEmptyString(coordinateSource.method)
  ) {
    throw new Error('La provenance doit préciser une source, date et méthode.');
  }
}

type CityPublicationInput = {
  name?: unknown;
  slug?: unknown;
  municipalityKey?: unknown;
  countryCode?: unknown;
  municipalityCode?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateCityForPublication(data: CityPublicationInput): void {
  const hasStableIdentity = isNonEmptyString(data.municipalityKey)
    && isNonEmptyString(data.countryCode)
    && isNonEmptyString(data.municipalityCode);

  if (!hasStableIdentity) {
    throw new Error(
      'municipalityKey, countryCode et municipalityCode sont obligatoires pour publier une ville.'
    );
  }

  const municipalityKey = data.municipalityKey as string;
  const countryCode = data.countryCode as string;
  const municipalityCode = data.municipalityCode as string;

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error('Le code pays doit utiliser deux lettres majuscules (ISO 3166-1 alpha-2).');
  }

  const expectedMunicipalityKey = `${countryCode}-${municipalityCode.trim()}`;
  if (municipalityKey.trim() !== expectedMunicipalityKey) {
    throw new Error(`La clé commune doit être ${expectedMunicipalityKey}.`);
  }
}

type StableCityIdentity = {
  slug?: unknown;
  municipalityKey?: unknown;
};

export function validateStableCityIdentity(
  publishedCity: StableCityIdentity | null | undefined,
  nextCity: StableCityIdentity
): void {
  if (!publishedCity) {
    return;
  }

  if (
    isNonEmptyString(nextCity.slug)
    && nextCity.slug !== publishedCity.slug
  ) {
    throw new Error('Le slug d’une ville déjà publiée est immuable.');
  }

  if (
    isNonEmptyString(nextCity.municipalityKey)
    && nextCity.municipalityKey !== publishedCity.municipalityKey
  ) {
    throw new Error('La clé commune d’une ville déjà publiée est immuable.');
  }
}
