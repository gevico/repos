import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadPolicy, validateRequest, checkTransition, loadCatalog, requestYaml, requestPath, terraformValues, effectiveAccess, work } from '../scripts/config.mjs';

const policy = await loadPolicy();
await fs.mkdir(path.join(work, 'tests'), { recursive: true });
const demo = {
  name: 'demo', description: '仓库创建流程测试', visibility: 'public', topics: [],
  access: { users: { zevorn: 'admin' }, teams: {} },
};
const registeredId = 1418263004;

test('lifecycle declarations preserve identity and permissions through directory moves and tombstones', async () => {
  const archived = { ...demo, status: 'archived', repository_id: registeredId };
  const deleted = { ...archived, status: 'deleted' };
  await validateRequest(archived, policy, requestPath(archived));
  assert.deepEqual(checkTransition({ demo }, { demo: archived }, policy), { lifecycle: true });
  assert.equal(terraformValues({ demo: archived }, policy).repositories.demo.archived, true);
  assert.deepEqual(terraformValues({ demo: deleted }, policy).repositories, {});
  assert.deepEqual(checkTransition({ demo: archived }, { demo: deleted }, policy), { lifecycle: true });
  await assert.rejects(validateRequest(archived, policy, 'repositories/demo.yaml'), /directory/);
  await assert.rejects(validateRequest({ ...demo, status: 'archived' }, policy, 'repositories/archive/demo.yaml'), /repository_id/);
  assert.throws(() => checkTransition({ demo: archived }, { demo: { ...archived, repository_id: registeredId + 1 } }, policy), /immutable/);
  assert.throws(() => checkTransition({ demo }, { demo: { ...archived, access: { users: { zevorn: 'admin', bbbbbq: 'push' }, teams: {} } } }, policy), /preserve/);
  assert.throws(() => checkTransition({ demo: deleted }, { demo: archived }, policy), /immutable/);
  assert.throws(() => checkTransition({ demo: archived }, {}, policy), /removing or renaming/);
});

test('catalog recognizes the fixed archive directory and rejects duplicate identities and nested content', async () => {
  const directory = await fs.mkdtemp(path.join(work, 'tests/lifecycle-'));
  try {
    await fs.mkdir(path.join(directory, 'repositories/archive'), { recursive: true });
    const archived = { ...demo, status: 'archived', repository_id: registeredId };
    await fs.writeFile(path.join(directory, requestPath(archived)), requestYaml(archived));
    assert.deepEqual((await loadCatalog(directory)).catalog, { demo: archived });
    await fs.writeFile(path.join(directory, 'repositories/demo.yaml'), requestYaml(demo));
    await assert.rejects(loadCatalog(directory), /duplicate/);
    await fs.unlink(path.join(directory, 'repositories/demo.yaml'));
    await fs.mkdir(path.join(directory, 'repositories/archive/nested'));
    await assert.rejects(loadCatalog(directory), /ordinary/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('existing access requests retain protected admins and reject incompatible initialization settings', async () => {
  const existing = { ...demo, name: 'GW100', mode: 'existing', repository_id: 1380073834, default_branch: 'master', description: '', access: { users: { zevorn: 'admin' }, teams: {} } };
  await validateRequest(existing, policy, requestPath(existing));
  checkTransition({}, { GW100: existing }, policy);
  assert.deepEqual(effectiveAccess(existing, policy).users, { zevorn: 'admin', bbbbbq: 'admin' });
  await assert.rejects(validateRequest({ ...existing, access: { users: { zevorn: 'admin', bbbbbq: 'push' }, teams: {} } }, policy, requestPath(existing)), /retain admin/);
  await assert.rejects(validateRequest({ ...existing, readme_template: 'project' }, policy, requestPath(existing)), /initialize new/);
  assert.throws(() => checkTransition({ GW100: existing }, { GW100: { ...existing, mode: 'create' } }, policy), /mode is immutable/);
  assert.throws(() => checkTransition({ demo }, { demo: { ...demo, status: 'archived', repository_id: registeredId }, GW100: existing }, policy), /separately/);
});
