import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createStrapiDataMasterProvisioningDependencies,
  parseDataMasterProvisioningArguments,
  runDataMasterProvisioning,
  runDataMasterProvisioningCli,
} from '../scripts/provision-datamaster-role';
import { DATAMASTER_ROLE, buildDataMasterPermissions } from '../src/domain/datamaster-rbac';

test('le provisionnement DataMaster reste en dry-run et exige une confirmation explicite', () => {
  assert.deepEqual(parseDataMasterProvisioningArguments([]), {
    apply: false,
    confirmed: false,
  });
  assert.throws(
    () => parseDataMasterProvisioningArguments(['--apply']),
    /--confirm-apply/,
  );
  assert.deepEqual(
    parseDataMasterProvisioningArguments(['--apply', '--confirm-apply']),
    { apply: true, confirmed: true },
  );
  assert.throws(
    () => parseDataMasterProvisioningArguments(['--confirm-apply']),
    /uniquement avec --apply/,
  );
});

test('le dry-run décrit les restrictions sans créer de rôle ni modifier de permission', async () => {
  const roles = [
    { id: 1, name: 'Super Admin', code: 'strapi-super-admin', description: 'Super Admin' },
    { id: 2, name: 'Editor', code: 'strapi-editor', description: 'Editor' },
  ];
  const permissionsByRole = new Map<number, any[]>([[2, [
    {
      action: 'plugin::content-manager.explorer.read',
      subject: 'api::reference-route.reference-route',
      properties: { fields: ['name'] },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::article.article',
      properties: { fields: ['title'] },
      conditions: [],
    },
  ]]]);

  const report = await runDataMasterProvisioning({ apply: false }, {
    listRoles: async () => roles,
    listPermissions: async (roleId) => permissionsByRole.get(Number(roleId)) ?? [],
    normalizePermissions: async (permissions) => permissions,
    allFieldsForSubject: () => ['allField'],
    createRole: async () => assert.fail('Le dry-run ne doit pas créer de rôle.'),
    updateRole: async () => assert.fail('Le dry-run ne doit pas modifier de rôle.'),
    assignPermissions: async () => assert.fail('Le dry-run ne doit pas modifier les permissions.'),
  });

  assert.deepEqual(report, {
    mode: 'dry-run',
    matrixVersion: 1,
    changesRequired: true,
    dataMaster: {
      role: 'create',
      permissions: 'replace',
    },
    editorialRoles: [
      { code: 'strapi-editor', name: 'Editor', permissions: 'restrict' },
    ],
    superAdminRolesSkipped: 1,
    userAssignmentsChanged: false,
  });
});

test('un apply crée et restreint une seule fois puis devient idempotent', async () => {
  const roles: any[] = [
    { id: 1, name: 'Super Admin', code: 'strapi-super-admin', description: 'Super Admin' },
    { id: 2, name: 'Editor', code: 'strapi-editor', description: 'Editor' },
  ];
  const permissionsByRole = new Map<number, any[]>([[2, [
    {
      action: 'plugin::content-manager.explorer.read',
      subject: 'api::route-anchor.route-anchor',
      properties: { fields: ['validationStatus'] },
      conditions: [],
    },
    {
      action: 'plugin::content-manager.explorer.update',
      subject: 'api::article.article',
      properties: { fields: ['title'] },
      conditions: [],
    },
  ]]]);
  const writes = { creates: 0, updates: 0, assignments: 0 };
  const dependencies = {
    listRoles: async () => roles,
    listPermissions: async (roleId: number | string) => permissionsByRole.get(Number(roleId)) ?? [],
    normalizePermissions: async (permissions: any[]) => permissions,
    allFieldsForSubject: () => ['allField'],
    createRole: async (attributes: any) => {
      writes.creates += 1;
      const role = { id: 3, ...attributes };
      roles.push(role);
      return role;
    },
    updateRole: async (roleId: number | string, attributes: any) => {
      writes.updates += 1;
      const role = roles.find((candidate) => candidate.id === roleId);
      Object.assign(role, attributes);
      return role;
    },
    assignPermissions: async (roleId: number | string, permissions: any[]) => {
      writes.assignments += 1;
      permissionsByRole.set(Number(roleId), structuredClone(permissions));
    },
  };

  const first = await runDataMasterProvisioning({ apply: true }, dependencies);
  assert.equal(first.changesRequired, true);
  assert.deepEqual(writes, { creates: 1, updates: 0, assignments: 2 });
  assert.equal(permissionsByRole.get(2)?.some((permission) => (
    permission.subject === 'api::route-anchor.route-anchor'
  )), false);

  const second = await runDataMasterProvisioning({ apply: true }, dependencies);
  assert.equal(second.changesRequired, false);
  assert.deepEqual(second.dataMaster, { role: 'unchanged', permissions: 'unchanged' });
  assert.deepEqual(second.editorialRoles, [
    { code: 'strapi-editor', name: 'Editor', permissions: 'unchanged' },
  ]);
  assert.deepEqual(writes, { creates: 1, updates: 0, assignments: 2 });
});

test('les valeurs par défaut omises par Strapi ne créent pas de dérive permanente', async () => {
  const existingPermissions = buildDataMasterPermissions(() => ['allField']).map((permission) => ({
    action: permission.action,
    subject: permission.subject,
    properties: permission.properties,
  }));

  const report = await runDataMasterProvisioning({ apply: false }, {
    listRoles: async () => [{
      id: 3,
      name: DATAMASTER_ROLE.name,
      code: 'gthdf-datamaster',
      description: DATAMASTER_ROLE.description,
    }],
    listPermissions: async () => existingPermissions,
    normalizePermissions: async (permissions) => permissions,
    allFieldsForSubject: () => ['allField'],
    createRole: async () => assert.fail('Le rôle existe déjà.'),
    updateRole: async () => assert.fail('Les métadonnées sont déjà exactes.'),
    assignPermissions: async () => assert.fail('Le dry-run ne doit rien modifier.'),
  });

  assert.equal(report.changesRequired, false);
  assert.deepEqual(report.dataMaster.permissions, 'unchanged');
});

test('le code stable retrouve et renomme un rôle DataMaster ayant dérivé', async () => {
  const roles = [{
    id: 3,
    name: 'Catalogue Manager',
    code: 'gthdf-datamaster',
    description: 'Ancienne description',
  }];
  const updates: Array<{ roleId: number | string; attributes: Record<string, string> }> = [];

  const report = await runDataMasterProvisioning({ apply: true }, {
    listRoles: async () => roles,
    listPermissions: async () => [],
    normalizePermissions: async (permissions) => permissions,
    allFieldsForSubject: () => ['allField'],
    createRole: async () => assert.fail('Le rôle au code stable ne doit pas être recréé.'),
    updateRole: async (roleId, attributes) => {
      updates.push({ roleId, attributes });
      return { ...roles[0], ...attributes };
    },
    assignPermissions: async () => undefined,
  });

  assert.deepEqual(report.dataMaster.role, 'update');
  assert.deepEqual(report.editorialRoles, []);
  assert.deepEqual(updates, [{
    roleId: 3,
    attributes: {
      name: 'DataMaster',
      description: 'Contrôle et qualification des données techniques du catalogue d’itinéraires, sans administration générale de Strapi.',
    },
  }]);
});

test('deux rôles candidats DataMaster sont refusés sans mutation', async () => {
  const noWrite = async () => assert.fail('Une identité DataMaster ambiguë ne doit rien modifier.');

  await assert.rejects(
    () => runDataMasterProvisioning({ apply: true }, {
      listRoles: async () => [
        { id: 3, name: 'Catalogue Manager', code: 'gthdf-datamaster' },
        { id: 4, name: 'DataMaster', code: 'datamaster-manuel' },
      ],
      listPermissions: async () => [],
      normalizePermissions: async (permissions) => permissions,
      allFieldsForSubject: () => ['allField'],
      createRole: noWrite,
      updateRole: noWrite,
      assignPermissions: noWrite,
    }),
    /plusieurs rôles candidats DataMaster/,
  );
});

test('l’adapter Strapi utilise uniquement les services admin de rôles et permissions', async () => {
  const requestedServices: string[] = [];
  const role = { id: 4, name: 'Editor', code: 'strapi-editor', description: 'Editor' };
  const permissions = [{
    action: 'plugin::content-manager.explorer.update',
    subject: 'api::city.city',
    properties: { fields: ['name', 'municipalityKey'] },
    conditions: [],
  }];
  const assigned: Array<{ roleId: number | string; permissions: any[] }> = [];
  const services: Record<string, any> = {
    'admin::role': {
      find: async () => [role],
      create: async (attributes: any) => ({ id: 5, ...attributes }),
      update: async ({ id }: any, attributes: any) => ({ id, ...attributes }),
      assignPermissions: async (roleId: number | string, nextPermissions: any[]) => {
        assigned.push({ roleId, permissions: nextPermissions });
      },
      hooks: {
        willValidateUpdatePermissions: {
          call: async (nextPermissions: any[]) => nextPermissions,
        },
      },
    },
    'admin::permission': {
      findMany: async () => permissions,
    },
    'admin::content-type': {
      getNestedFields: (contentType: any) => Object.keys(contentType.attributes),
    },
  };
  const app = {
    contentTypes: {
      'api::city.city': { attributes: { name: {}, municipalityKey: {} } },
    },
    components: {},
    service: (name: string) => {
      requestedServices.push(name);
      return services[name];
    },
  };

  const dependencies = createStrapiDataMasterProvisioningDependencies(app as any);
  assert.deepEqual(await dependencies.listRoles(), [role]);
  assert.deepEqual(await dependencies.listPermissions(4), permissions);
  assert.deepEqual(dependencies.allFieldsForSubject('api::city.city'), ['name', 'municipalityKey']);
  await dependencies.assignPermissions(4, permissions);

  assert.deepEqual(assigned, [{ roleId: 4, permissions }]);
  assert.equal(requestedServices.some((name) => name.includes('user')), false);
  assert.equal(requestedServices.some((name) => name.includes('api-token')), false);
});

test('la CLI ouvre Strapi en lecture seule par défaut et le ferme après le rapport', async () => {
  const events: string[] = [];
  let output = '';
  const noWrite = async () => assert.fail('Le dry-run CLI ne doit rien écrire.');

  const exitCode = await runDataMasterProvisioningCli([], {
    loadStrapi: async (readOnly) => {
      events.push(readOnly ? 'load-read-only' : 'load-write');
      return {
        app: {},
        destroy: async () => { events.push('destroy'); },
      };
    },
    createDependencies: () => ({
      listRoles: async () => [],
      listPermissions: async () => [],
      normalizePermissions: async (permissions) => permissions,
      allFieldsForSubject: () => ['allField'],
      createRole: noWrite,
      updateRole: noWrite,
      assignPermissions: noWrite,
    }),
    writeOutput: (value) => { output += value; },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, ['load-read-only', 'destroy']);
  assert.deepEqual(JSON.parse(output), {
    mode: 'dry-run',
    matrixVersion: 1,
    changesRequired: true,
    dataMaster: { role: 'create', permissions: 'replace' },
    editorialRoles: [],
    superAdminRolesSkipped: 0,
    userAssignmentsChanged: false,
    nextCommand: 'npm run provision:datamaster -- --apply --confirm-apply',
  });
});

test('un Super Admin renommé DataMaster est refusé sans aucune mutation', async () => {
  const noWrite = async () => assert.fail('Le Super Admin ne doit jamais être modifié.');
  await assert.rejects(
    () => runDataMasterProvisioning({ apply: true }, {
      listRoles: async () => [{
        id: 1,
        name: 'DataMaster',
        code: 'strapi-super-admin',
        description: 'Super Admin',
      }],
      listPermissions: async () => [],
      normalizePermissions: async (permissions) => permissions,
      allFieldsForSubject: () => ['allField'],
      createRole: noWrite,
      updateRole: noWrite,
      assignPermissions: noWrite,
    }),
    /Super Admin.*DataMaster/,
  );
});

test('les remplacements de permissions ne réinjectent aucune métadonnée de base', async () => {
  let editorAssignment: any[] | undefined;
  await runDataMasterProvisioning({ apply: true }, {
    listRoles: async () => [
      { id: 1, name: 'Super Admin', code: 'strapi-super-admin', description: 'Super Admin' },
      { id: 2, name: 'Editor', code: 'strapi-editor', description: 'Editor' },
    ],
    listPermissions: async (roleId) => Number(roleId) === 2 ? [{
      id: 99,
      action: 'plugin::content-manager.explorer.update',
      actionParameters: {},
      subject: 'api::city.city',
      properties: { fields: ['name', 'municipalityKey'] },
      conditions: [],
      role: { id: 2 },
      apiToken: null,
    }] : [],
    normalizePermissions: async (permissions) => permissions,
    allFieldsForSubject: () => ['allField'],
    createRole: async (attributes) => ({ id: 3, ...attributes }),
    updateRole: async () => assert.fail('Aucune mise à jour de rôle attendue.'),
    assignPermissions: async (roleId, permissions) => {
      if (Number(roleId) === 2) editorAssignment = permissions;
    },
  });

  assert.deepEqual(editorAssignment, [{
    action: 'plugin::content-manager.explorer.update',
    actionParameters: {},
    subject: 'api::city.city',
    properties: { fields: ['name'] },
    conditions: [],
  }]);
});
