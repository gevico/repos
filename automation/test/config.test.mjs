import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, engine, work, loadPolicy, loadCatalog, parseYaml, validateRequest, checkTransition, effectiveAccess, terraformValues, requestYaml } from '../scripts/config.mjs';

const execute = promisify(execFile);
const policy = await loadPolicy();
const request = {
  name: 'coach',
  description: 'QEMU teaching and development resources',
  visibility: 'public',
  topics: ['qemu'],
  access: { users: { zevorn: 'admin' }, teams: { 'ai_infra-pigpig-runrun': 'maintain' } },
};

test('request rendering preserves user, team and topic intent through YAML and Terraform input', async () => {
  const { stdout } = await execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'request', '--name', 'coach', '--description', request.description, '--maintainer', 'zevorn', '--team', 'ai_infra-pigpig-runrun:maintain', '--topic', 'qemu'], { cwd: root });
  const rendered = parseYaml(stdout, 'coach.yaml');
  assert.deepEqual(rendered, request);
  await validateRequest(rendered, policy, 'coach.yaml');
  const values = terraformValues({ coach: rendered }, policy);
  assert.equal(values.organization, 'gevico');
  assert.deepEqual(values.repositories.coach.users, { zevorn: 'admin' });
  assert.deepEqual(values.repositories.coach.teams, { 'ai_infra-pigpig-runrun': 'maintain' });
  assert.equal(values.repositories.coach.template, null);
});

test('configuration rejects ambiguous YAML and permission policy changes', async () => {
  assert.throws(() => parseYaml('name: coach\nname: repos\n', 'coach.yaml'), /unique|duplicat/i);
  assert.throws(() => parseYaml('access: &access {}\nalias: *access\n', 'coach.yaml'), /alias/i);
  await assert.rejects(validateRequest({ ...request, name: 'repos' }, policy, 'repos.yaml'), /reserved/);
  await assert.rejects(validateRequest(request, policy, 'other.yaml'), /filename/);
  await assert.rejects(validateRequest({ ...request, visibility: 'private' }, policy, 'coach.yaml'), /branch protection/);
  await assert.rejects(validateRequest({ ...request, command: 'execute' }, policy, 'coach.yaml'), /additional properties/);
  await assert.rejects(validateRequest({ ...request, access: { users: { zevorn: 'maintain' }, teams: {} } }, policy, 'coach.yaml'), /retain admin/);
  await assert.rejects(validateRequest({ ...request, access: { users: { zevorn: 'admin', Zevorn: 'admin' }, teams: {} } }, policy, 'coach.yaml'), /duplicate GitHub user/);
});

test('managed identity remains stable while explicit team permissions can be revoked', async () => {
  const updated = { ...request, access: { users: { zevorn: 'admin' }, teams: {} } };
  checkTransition({ coach: request }, { coach: updated });
  assert.deepEqual(effectiveAccess(updated, policy).teams, {});
  assert.throws(() => checkTransition({ coach: request }, {}), /removing or renaming/);
  assert.throws(() => checkTransition({ coach: request }, { coach: { ...request, template: { owner: 'gevico', repository: 'coach' } } }), /immutable/);
});

test('catalog loading rejects symlinked requests and unrelated files', async () => {
  await fs.mkdir(path.join(work, 'tests'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(work, 'tests/catalog-'));
  await fs.mkdir(path.join(directory, 'repositories'));
  const file = path.join(directory, 'repositories/coach.yaml');
  try {
    await fs.writeFile(file, requestYaml(request));
    await fs.writeFile(path.join(directory, 'repositories/README.md'), '# Repository requests\n');
    await fs.mkdir(path.join(directory, 'repositories/docs'));
    await fs.writeFile(path.join(directory, 'repositories/docs/requesting.md'), '# Requesting a repository\n');
    assert.deepEqual((await loadCatalog(directory)).catalog.coach, request);
    const output = path.join(directory, 'rendered.json');
    await execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'render', '--directory', path.relative(root, directory), '--output', path.relative(root, output)], { cwd: engine });
    const rendered = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(rendered.repositories.coach.description, request.description);
    assert.deepEqual(rendered.repositories.coach.teams, request.access.teams);
    await fs.rename(file, path.join(directory, 'original.yaml'));
    await fs.symlink(path.join(directory, 'original.yaml'), file);
    await assert.rejects(loadCatalog(directory), /ordinary/);
    await fs.unlink(file);
    await fs.writeFile(path.join(directory, 'repositories/run.sh'), 'exit 0\n');
    await assert.rejects(loadCatalog(directory), /ordinary/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
