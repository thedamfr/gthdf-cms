import {
  DATAMASTER_PERMISSION_MATRIX_VERSION,
  DATAMASTER_ROLE,
  buildDataMasterPermissions,
  restrictEditorialRolePermissions,
  type ExistingAdminPermission,
} from '../src/domain/datamaster-rbac';
import { loadCatalogueStrapi } from './catalogue';

export type DataMasterProvisioningOptions = {
  apply: boolean;
  confirmed: boolean;
};

type RoleId = number | string;

export type AdminRoleRecord = {
  id: RoleId;
  name: string;
  code: string;
  description?: string | null;
};

export type DataMasterProvisioningDependencies = {
  listRoles(): Promise<AdminRoleRecord[]>;
  listPermissions(roleId: RoleId): Promise<ExistingAdminPermission[]>;
  normalizePermissions(permissions: ExistingAdminPermission[]): Promise<ExistingAdminPermission[]>;
  allFieldsForSubject(subject: string): readonly string[];
  createRole(attributes: { name: string; code: string; description: string }): Promise<AdminRoleRecord>;
  updateRole(roleId: RoleId, attributes: { name: string; description: string }): Promise<AdminRoleRecord>;
  assignPermissions(roleId: RoleId, permissions: ExistingAdminPermission[]): Promise<unknown>;
};

export type DataMasterProvisioningReport = {
  mode: 'dry-run' | 'apply';
  matrixVersion: number;
  changesRequired: boolean;
  dataMaster: {
    role: 'create' | 'update' | 'unchanged';
    permissions: 'replace' | 'unchanged';
  };
  editorialRoles: Array<{
    code: string;
    name: string;
    permissions: 'restrict' | 'unchanged';
  }>;
  superAdminRolesSkipped: number;
  userAssignmentsChanged: false;
};

type DataMasterProvisioningCliDependencies = {
  loadStrapi(readOnly: boolean): Promise<{ app: any; destroy(): Promise<void> }>;
  createDependencies(app: any): DataMasterProvisioningDependencies;
  writeOutput(value: string): void;
};

const DATAMASTER_ROLE_CODE = 'gthdf-datamaster';
const SUPER_ADMIN_ROLE_CODE = 'strapi-super-admin';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

function comparablePermission(permission: ExistingAdminPermission): Record<string, unknown> {
  return canonicalize({
    action: permission.action,
    subject: permission.subject ?? undefined,
    properties: permission.properties,
    conditions: permission.conditions,
    actionParameters: permission.actionParameters,
  }) as Record<string, unknown>;
}

function permissionsAreEqual(
  first: readonly ExistingAdminPermission[],
  second: readonly ExistingAdminPermission[],
): boolean {
  const serialize = (permission: ExistingAdminPermission) => JSON.stringify(comparablePermission(permission));
  return JSON.stringify(first.map(serialize).sort()) === JSON.stringify(second.map(serialize).sort());
}

function permissionInput(permission: ExistingAdminPermission): ExistingAdminPermission {
  return {
    action: permission.action,
    actionParameters: permission.actionParameters ?? {},
    subject: permission.subject ?? null,
    properties: permission.properties ?? {},
    conditions: Array.isArray(permission.conditions) ? permission.conditions : [],
  };
}

async function normalizePermissionInputs(
  permissions: readonly ExistingAdminPermission[],
  dependencies: DataMasterProvisioningDependencies,
): Promise<ExistingAdminPermission[]> {
  const normalized = await dependencies.normalizePermissions(permissions.map(permissionInput));
  return normalized.map(permissionInput);
}

export async function runDataMasterProvisioning(
  options: Pick<DataMasterProvisioningOptions, 'apply'>,
  dependencies: DataMasterProvisioningDependencies,
): Promise<DataMasterProvisioningReport> {
  const roles = await dependencies.listRoles();
  const superAdminRoles = roles.filter((role) => role.code === SUPER_ADMIN_ROLE_CODE);
  if (superAdminRoles.some((role) => role.name === DATAMASTER_ROLE.name)) {
    throw new Error('Le rôle Super Admin porte déjà le nom DataMaster ; aucune permission ne sera modifiée.');
  }
  const dataMasterCandidates = roles.filter((role) => (
    role.code === DATAMASTER_ROLE_CODE
    || (role.code !== SUPER_ADMIN_ROLE_CODE && role.name === DATAMASTER_ROLE.name)
  ));
  if (dataMasterCandidates.length > 1) {
    throw new Error('L’environnement contient plusieurs rôles candidats DataMaster ; aucune permission ne sera modifiée.');
  }
  const [dataMasterRole] = dataMasterCandidates;
  const ordinaryRoles = roles.filter((role) => (
    role.code !== SUPER_ADMIN_ROLE_CODE && role.id !== dataMasterRole?.id
  ));
  const superAdminRolesSkipped = superAdminRoles.length;

  const desiredDataMasterPermissions = await normalizePermissionInputs(
    buildDataMasterPermissions(dependencies.allFieldsForSubject),
    dependencies,
  );
  const existingDataMasterPermissions = dataMasterRole
    ? await dependencies.listPermissions(dataMasterRole.id)
    : [];
  const dataMasterPermissionsAction = dataMasterRole
    && permissionsAreEqual(existingDataMasterPermissions, desiredDataMasterPermissions)
    ? 'unchanged'
    : 'replace';
  const dataMasterMetadataMatches = dataMasterRole
    && dataMasterRole.name === DATAMASTER_ROLE.name
    && dataMasterRole.description === DATAMASTER_ROLE.description;
  const dataMasterRoleAction = !dataMasterRole
    ? 'create'
    : dataMasterMetadataMatches
      ? 'unchanged'
      : 'update';

  const editorialRolePlans = await Promise.all(ordinaryRoles.map(async (role) => {
    const existingPermissions = await dependencies.listPermissions(role.id);
    const restrictedPermissions = await normalizePermissionInputs(
      restrictEditorialRolePermissions(existingPermissions, dependencies.allFieldsForSubject),
      dependencies,
    );
    return {
      role,
      restrictedPermissions,
      action: permissionsAreEqual(existingPermissions, restrictedPermissions)
        ? 'unchanged' as const
        : 'restrict' as const,
    };
  }));

  const changesRequired = dataMasterRoleAction !== 'unchanged'
    || dataMasterPermissionsAction !== 'unchanged'
    || editorialRolePlans.some((plan) => plan.action === 'restrict');

  if (options.apply && changesRequired) {
    const effectiveDataMasterRole = dataMasterRole ?? await dependencies.createRole({
      ...DATAMASTER_ROLE,
      code: DATAMASTER_ROLE_CODE,
    });
    if (dataMasterRoleAction === 'update') {
      await dependencies.updateRole(effectiveDataMasterRole.id, {
        name: DATAMASTER_ROLE.name,
        description: DATAMASTER_ROLE.description,
      });
    }
    if (dataMasterPermissionsAction === 'replace') {
      await dependencies.assignPermissions(effectiveDataMasterRole.id, desiredDataMasterPermissions);
    }
    for (const plan of editorialRolePlans) {
      if (plan.action === 'restrict') {
        await dependencies.assignPermissions(plan.role.id, plan.restrictedPermissions);
      }
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    matrixVersion: DATAMASTER_PERMISSION_MATRIX_VERSION,
    changesRequired,
    dataMaster: {
      role: dataMasterRoleAction,
      permissions: dataMasterPermissionsAction,
    },
    editorialRoles: editorialRolePlans.map((plan) => ({
      code: plan.role.code,
      name: plan.role.name,
      permissions: plan.action,
    })),
    superAdminRolesSkipped,
    userAssignmentsChanged: false,
  };
}

export function createStrapiDataMasterProvisioningDependencies(
  app: any,
): DataMasterProvisioningDependencies {
  const roleService = app.service('admin::role');
  const permissionService = app.service('admin::permission');
  const contentTypeService = app.service('admin::content-type');

  return {
    listRoles: () => roleService.find({}, []),
    listPermissions: (roleId) => permissionService.findMany({
      where: { role: { id: roleId } },
      populate: ['role'],
    }),
    normalizePermissions: async (permissions) => {
      const normalized = await roleService.hooks.willValidateUpdatePermissions.call(permissions);
      if (!Array.isArray(normalized)) {
        throw new Error('La normalisation Strapi des permissions n’a pas retourné une liste.');
      }
      return normalized;
    },
    allFieldsForSubject: (subject) => {
      const contentType = app.contentTypes[subject];
      if (!contentType) throw new Error(`Content-type Strapi introuvable : ${subject}.`);
      return contentTypeService.getNestedFields(contentType, { components: app.components });
    },
    createRole: (attributes) => roleService.create(attributes),
    updateRole: (roleId, attributes) => roleService.update({ id: roleId }, attributes),
    assignPermissions: (roleId, permissions) => roleService.assignPermissions(roleId, permissions),
  };
}

export function parseDataMasterProvisioningArguments(
  argv: readonly string[],
): DataMasterProvisioningOptions {
  const options: DataMasterProvisioningOptions = {
    apply: false,
    confirmed: false,
  };

  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--confirm-apply') options.confirmed = true;
    else throw new Error(`Option inconnue : ${argument}`);
  }

  if (options.apply && !options.confirmed) {
    throw new Error('L’application exige --apply --confirm-apply après revue du dry-run.');
  }
  if (!options.apply && options.confirmed) {
    throw new Error('--confirm-apply est accepté uniquement avec --apply.');
  }

  return options;
}

export async function runDataMasterProvisioningCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: DataMasterProvisioningCliDependencies = {
    loadStrapi: loadCatalogueStrapi,
    createDependencies: createStrapiDataMasterProvisioningDependencies,
    writeOutput: (value) => process.stdout.write(value),
  },
): Promise<number> {
  const options = parseDataMasterProvisioningArguments(argv);
  const runtime = await dependencies.loadStrapi(!options.apply);
  try {
    const report = await runDataMasterProvisioning(
      options,
      dependencies.createDependencies(runtime.app),
    );
    dependencies.writeOutput(`${JSON.stringify({
      ...report,
      ...(!options.apply ? {
        nextCommand: 'npm run provision:datamaster -- --apply --confirm-apply',
      } : {}),
    }, null, 2)}\n`);
    return 0;
  } finally {
    await runtime.destroy();
  }
}

if (require.main === module) {
  const keepAlive = setInterval(() => undefined, 60_000);
  runDataMasterProvisioningCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }).finally(() => {
    clearInterval(keepAlive);
  });
}
