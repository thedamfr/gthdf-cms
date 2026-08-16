export const DATAMASTER_PERMISSION_MATRIX_VERSION = 4;

export const DATAMASTER_ROLE = Object.freeze({
  name: 'DataMaster',
  description: 'Contrôle et qualification des données techniques du catalogue d’itinéraires, sans administration générale de Strapi.',
});

export const DATAMASTER_TECHNICAL_SUBJECTS = Object.freeze([
  'api::reference-route.reference-route',
  'api::route-city.route-city',
  'api::route-anchor.route-anchor',
  'api::itinerary-revision.itinerary-revision',
  'api::catalogue-run.catalogue-run',
  'api::itinerary-slug-redirect.itinerary-slug-redirect',
] as const);

type ContentManagerAction = 'create' | 'read' | 'update' | 'publish';

export type AdminPermission = {
  action: `plugin::content-manager.explorer.${ContentManagerAction}`;
  subject: string;
  properties: { fields: string[] };
  conditions: string[];
};

export type ExistingAdminPermission = {
  action: string;
  subject?: string | null;
  properties?: {
    fields?: string[];
    [key: string]: unknown;
  };
  conditions?: unknown[];
  actionParameters?: unknown;
  [key: string]: unknown;
};

const TECHNICAL_ACTIONS: Record<(typeof DATAMASTER_TECHNICAL_SUBJECTS)[number], readonly ContentManagerAction[]> = {
  'api::reference-route.reference-route': ['read', 'update', 'publish'],
  'api::route-city.route-city': ['read', 'update'],
  'api::route-anchor.route-anchor': ['read', 'update'],
  'api::itinerary-revision.itinerary-revision': ['read', 'update'],
  'api::catalogue-run.catalogue-run': ['read'],
  'api::itinerary-slug-redirect.itinerary-slug-redirect': ['read', 'create', 'update'],
};

const MIXED_ACTIONS: Record<string, readonly ContentManagerAction[]> = {
  'api::chapter.chapter': ['read', 'update'],
  'api::city-itinerary.city-itinerary': ['read', 'update', 'publish'],
  'api::city.city': ['read', 'update'],
  'api::global.global': ['read', 'update'],
};

const DATAMASTER_UPDATE_FIELDS: Record<string, readonly string[]> = {
  'api::reference-route.reference-route': [
    'name',
    'catalogueEnabled',
    'notes',
  ],
  'api::route-city.route-city': [
    'qualificationStatus',
    'qualifiedAt',
    'reviewNote',
  ],
  'api::route-anchor.route-anchor': ['validationStatus'],
  'api::itinerary-revision.itinerary-revision': [
    'warningApproved',
    'warningApprovedAt',
    'warningApprovedBy',
  ],
  'api::city-itinerary.city-itinerary': [
    'activeRevision',
    'reviewStatus',
    'publicationNext',
    'seoStatus',
    'featuredOnCityPages',
    'editorialOrder',
  ],
  'api::city.city': [
    'municipalityKey',
    'countryCode',
    'municipalityCode',
    'administrativeArea',
    'coordinateSource',
  ],
  'api::global.global': ['publishCityItinerariesToNext'],
};

const EDITORIAL_ITINERARY_FIELDS = [
  'title',
  'introduction',
  'blocks',
  'seo',
] as const;

const RESTRICTED_CITY_FIELDS = [
  'municipalityKey',
  'countryCode',
  'municipalityCode',
  'administrativeArea',
  'coordinateSource',
] as const;

const RESTRICTED_GLOBAL_FIELDS = ['publishCityItinerariesToNext'] as const;

const RESTRICTED_CHAPTER_FIELDS = [
  'cityPassages.gpxAnchorAB',
  'cityPassages.gpxAnchorBA',
  'gpxJunctionAfterAB',
  'gpxJunctionAfterBA',
] as const;

const DATAMASTER_NESTED_UPDATE_FIELDS: Record<string, readonly string[]> = {
  'api::chapter.chapter': [
    'cityPassages.gpxAnchorAB.status',
    'cityPassages.gpxAnchorAB.reviewNote',
    'cityPassages.gpxAnchorBA.status',
    'cityPassages.gpxAnchorBA.reviewNote',
    'gpxJunctionAfterAB.status',
    'gpxJunctionAfterAB.reviewNote',
    'gpxJunctionAfterBA.status',
    'gpxJunctionAfterBA.reviewNote',
  ],
};

function fieldMatchesRoot(field: string, root: string): boolean {
  return field === root || field.startsWith(`${root}.`);
}

function permissionFields(
  permission: ExistingAdminPermission,
  allFieldsForSubject: (subject: string) => readonly string[],
): string[] {
  const configuredFields = permission.properties?.fields;
  if (Array.isArray(configuredFields)) {
    return configuredFields;
  }
  return permission.subject ? [...allFieldsForSubject(permission.subject)] : [];
}

function withFields<T extends ExistingAdminPermission>(permission: T, fields: string[]): T {
  return {
    ...permission,
    properties: {
      ...(permission.properties ?? {}),
      fields,
    },
  };
}

export function restrictEditorialRolePermissions<T extends ExistingAdminPermission>(
  permissions: readonly T[],
  allFieldsForSubject: (subject: string) => readonly string[],
): T[] {
  const technicalSubjects = new Set<string>(DATAMASTER_TECHNICAL_SUBJECTS);

  return permissions.flatMap((permission) => {
    const subject = permission.subject;
    if (!subject) return [permission];
    if (technicalSubjects.has(subject)) return [];

    if (subject === 'api::city-itinerary.city-itinerary') {
      if (![
        'plugin::content-manager.explorer.read',
        'plugin::content-manager.explorer.update',
      ].includes(permission.action)) return [];
      const fields = permissionFields(permission, allFieldsForSubject).filter((field) => (
        EDITORIAL_ITINERARY_FIELDS.some((root) => fieldMatchesRoot(field, root))
      ));
      return fields.length > 0 ? [withFields(permission, fields)] : [];
    }

    const isFieldAction = [
      'plugin::content-manager.explorer.create',
      'plugin::content-manager.explorer.read',
      'plugin::content-manager.explorer.update',
    ].includes(permission.action);
    if (!isFieldAction) return [permission];

    const restrictedFields = subject === 'api::chapter.chapter'
      ? RESTRICTED_CHAPTER_FIELDS
      : subject === 'api::city.city'
        ? RESTRICTED_CITY_FIELDS
        : subject === 'api::global.global'
          ? RESTRICTED_GLOBAL_FIELDS
          : null;
    if (!restrictedFields) return [permission];

    const fields = permissionFields(permission, allFieldsForSubject).filter((field) => (
      !restrictedFields.some((root) => fieldMatchesRoot(field, root))
    ));
    return fields.length > 0 ? [withFields(permission, fields)] : [];
  });
}

export function buildDataMasterPermissions(
  allFieldsForSubject: (subject: string) => readonly string[],
): AdminPermission[] {
  const actionsBySubject: Record<string, readonly ContentManagerAction[]> = {
    ...TECHNICAL_ACTIONS,
    ...MIXED_ACTIONS,
  };

  return Object.entries(actionsBySubject).flatMap(([subject, actions]) => (
    actions.map((action) => {
      const allFields = allFieldsForSubject(subject);
      const nestedUpdateFields = DATAMASTER_NESTED_UPDATE_FIELDS[subject];
      return {
        action: `plugin::content-manager.explorer.${action}` as const,
        subject,
        properties: {
          fields: action === 'update' && DATAMASTER_UPDATE_FIELDS[subject]
            ? [...DATAMASTER_UPDATE_FIELDS[subject]]
            : action === 'update' && nestedUpdateFields
              ? allFields.filter((field) => nestedUpdateFields.includes(field))
              : action === 'publish'
                ? []
                : [...allFields],
        },
        conditions: [],
      };
    })
  ));
}
