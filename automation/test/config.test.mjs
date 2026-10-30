import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, engine, work, loadPolicy, loadCatalog, parseYaml, validateRequest, checkTransition, effectiveAccess, terraformValues, requestYaml, repositoryRules } from '../scripts/config.mjs';
import { authorizePlan } from '../scripts/plan-policy.mjs';

const execute = promisify(execFile);
const policy = await loadPolicy();
const request = {
  name: 'coach',
  description: 'QEMU teaching and development resources',
  visibility: 'public',
  topics: ['qemu'],
  access: { users: { zevorn: 'admin' }, teams: { 'ai_infra-pigpig-runrun': 'maintain' } },
};

test('plan policy module parses and exports its entry points', async () => {
  const module = await import('../scripts/plan-policy.mjs');
  assert.equal(typeof module.authorizePlan, 'function');
  assert.equal(typeof module.describeIntents, 'function');
});

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

test('ruleset overrides stay scoped to the named repository', async () => {
  assert.deepEqual(repositoryRules(request), { admin_bypass: 'none' });
  const gw100 = { ...request, name: 'gw100-gem5', ruleset: { admin_bypass: 'pull_request' } };
  assert.deepEqual(repositoryRules(gw100), { admin_bypass: 'pull_request' });
  await validateRequest(gw100, policy, 'repositories/gw100-gem5.yaml');
  await assert.rejects(validateRequest({ ...gw100, ruleset: { admin_bypass: 'sometimes' } }, policy, 'repositories/gw100-gem5.yaml'), /admin_bypass|allowed/);
  await assert.rejects(validateRequest({ ...gw100, mode: 'existing', repository_id: 1 }, policy, 'repositories/gw100-gem5.yaml'), /branch rules|ruleset/);
  const values = terraformValues({ coach: request, 'gw100-gem5': gw100 }, policy);
  assert.deepEqual(values.repositories.coach.ruleset, { admin_bypass: 'none' });
  assert.deepEqual(values.repositories['gw100-gem5'].ruleset, { admin_bypass: 'pull_request' });
});

test('plan authorization accepts the expected ruleset admin bypass', () => {
  const gw100 = { ...request, name: 'gw100-gem5', ruleset: { admin_bypass: 'pull_request' } };
  const rules = [{ deletion: true, non_fast_forward: true, pull_request: [{ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true }] }];
  const conditions = [{ ref_name: [{ include: ['~DEFAULT_BRANCH'], exclude: [] }] }];
  const plan = {
    resource_changes: [{
      address: 'github_repository_ruleset.managed["gw100-gem5"]',
      type: 'github_repository_ruleset',
      name: 'managed',
      index: 'gw100-gem5',
      change: {
        actions: ['update'],
        before: { repository: 'gw100-gem5', name: 'review-default-branch', enforcement: 'active', target: 'branch', conditions, rules, bypass_actors: [] },
        after: { repository: 'gw100-gem5', name: 'review-default-branch', enforcement: 'active', target: 'branch', conditions, rules, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }] },
      },
    }],
  };
  const intents = authorizePlan(plan, { 'gw100-gem5': gw100 }, policy, ['gw100-gem5']);
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].after.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]);
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
  checkTransition({ coach: request }, { coach: updated }, policy);
  assert.deepEqual(effectiveAccess(updated, policy).teams, {});
  assert.throws(() => checkTransition({ coach: request }, {}, policy), /removing or renaming/);
  assert.throws(() => checkTransition({ coach: request }, { coach: { ...request, template: { owner: 'gevico', repository: 'coach' } } }, policy), /immutable/);
});

test('new repositories choose no license or one from the policy allowed list', async () => {
  checkTransition({}, { coach: request }, policy);
  const licensed = { ...request, license: 'lgpl-2.1' };
  await validateRequest(licensed, policy, 'coach.yaml');
  checkTransition({}, { coach: licensed }, policy);
  assert.throws(() => checkTransition({}, { coach: { ...request, license: 'agpl-3.0' } }, policy), /not allowed by policy/);
  await assert.rejects(validateRequest({ ...request, license: 'lgpl-3.0' }, policy, 'coach.yaml'), /allowed values/);
  checkTransition({ coach: licensed }, { coach: { ...licensed, topics: ['qemu', 'plugins'] } }, { ...policy, allowed_licenses: ['mit'] });
  const { stdout } = await execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'request', '--name', 'coach', '--description', request.description, '--maintainer', 'zevorn', '--license', 'lgpl-2.1'], { cwd: root });
  assert.equal(parseYaml(stdout, 'coach.yaml').license, 'lgpl-2.1');
  await assert.rejects(execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'request', '--name', 'coach', '--description', request.description, '--maintainer', 'zevorn', '--license', 'agpl-3.0'], { cwd: root }), /not allowed by policy/);
  await fs.mkdir(path.join(work, 'tests'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(work, 'tests/policy-'));
  try {
    await fs.writeFile(path.join(directory, 'policy.yml'), requestYaml({ ...policy, allowed_licenses: ['mit', 'wtfpl'] }));
    await assert.rejects(loadPolicy(directory), /allowed_licenses/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('catalog loading rejects symlinked requests and unrelated files', async () => {
  await fs.mkdir(path.join(work, 'tests'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(work, 'tests/catalog-'));
  await fs.mkdir(path.join(directory, 'repositories'));
  const file = path.join(directory, 'repositories/coach.yaml');
  try {
    await fs.writeFile(file, requestYaml(request));
    assert.deepEqual((await loadCatalog(directory)).catalog.coach, request);
    const output = path.join(directory, 'rendered.json');
    await execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'render', '--directory', path.relative(root, directory), '--output', path.relative(root, output)], { cwd: engine, env: { ...process.env, GIT_CONFIG: '/dev/null' } });
    const rendered = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(rendered.repositories.coach.description, request.description);
    assert.deepEqual(rendered.repositories.coach.teams, request.access.teams);
    await fs.writeFile(path.join(directory, 'repositories/README.md'), '# Repository requests\n');
    await assert.rejects(loadCatalog(directory), /ordinary/);
    await fs.unlink(path.join(directory, 'repositories/README.md'));
    await fs.mkdir(path.join(directory, 'repositories/docs'));
    await assert.rejects(loadCatalog(directory), /ordinary/);
    await fs.rmdir(path.join(directory, 'repositories/docs'));
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

test('a checkout without declarations has an empty catalog and retains its organization policy', async () => {
  await fs.mkdir(path.join(work, 'tests'), { recursive: true });
  const directory = await fs.mkdtemp(path.join(work, 'tests/empty-catalog-'));
  try {
    const loaded = await loadCatalog(directory);
    assert.deepEqual(loaded.catalog, {});
    assert.equal(loaded.policy.organization, 'gevico');
    assert.deepEqual(loaded.policy.administrator_users, policy.administrator_users);
    const output = path.join(directory, 'rendered.json');
    await execute(process.execPath, [path.join(engine, 'scripts/repos.mjs'), 'render', '--directory', path.relative(root, directory), '--output', path.relative(root, output)], { cwd: engine, env: { ...process.env, GIT_CONFIG: '/dev/null' } });
    const rendered = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(rendered.organization, 'gevico');
    assert.deepEqual(rendered.repositories, {});
    assert.equal(rendered.require_pull_request_reviews, policy.require_pull_request_reviews);
    await assert.rejects(loadCatalog(path.join(directory, 'missing-root')), /ENOENT/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
