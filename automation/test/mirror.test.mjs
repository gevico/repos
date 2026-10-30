import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy, validateRequest, checkTransition, terraformValues } from '../scripts/config.mjs';
import { authorizePlan } from '../scripts/plan-policy.mjs';
import { parseRefs, refspecs, listRefs } from '../scripts/mirror.mjs';

const policy = await loadPolicy();
const mirror = {
  name: 'qemu-mirror', mode: 'mirror', description: 'QEMU 上游代码镜像', visibility: 'public', topics: ['qemu'], default_branch: 'master',
  mirror: { url: 'https://gitlab.com/qemu-project/qemu.git' }, access: { users: { zevorn: 'admin' }, teams: {} },
};

test('mirror requests bind an allowed HTTPS source and exclude initialization templates', async () => {
  await validateRequest(mirror, policy, 'qemu-mirror.yaml');
  await validateRequest({ ...mirror, mirror: { url: 'https://github.com/octocat/Hello-World.git', source_repository_id: 1296269 } }, policy, 'qemu-mirror.yaml');
  for (const url of ['https://git.kernel.org/pub/scm/git/git.git', 'https://gitee.com/openharmony/docs.git']) await validateRequest({ ...mirror, mirror: { url } }, policy, 'qemu-mirror.yaml');
  const rejects = (request, pattern) => assert.rejects(validateRequest(request, policy, 'qemu-mirror.yaml'), pattern);
  await rejects({ ...mirror, mirror: { url: 'https://example.com/qemu.git' } }, /not allowed/);
  await rejects({ ...mirror, mirror: { url: 'https://gitlab.com/qemu-project/qemu' } }, /ending in \.git/);
  await rejects({ ...mirror, mirror: { url: 'https://gitlab.com/../qemu.git' } }, /canonical/);
  for (const url of ['http://gitlab.com/qemu.git', 'https://user@gitlab.com/qemu.git', 'https://gitlab.com:8443/qemu.git', 'https://gitlab.com/qemu.git?ref=x', 'https://GitLab.com/qemu.git', 'file:///srv/qemu.git']) await rejects({ ...mirror, mirror: { url } }, /pattern/);
  await rejects({ ...mirror, mirror: { url: 'https://github.com/octocat/Hello-World.git' } }, /source_repository_id/);
  await rejects({ ...mirror, mirror: { ...mirror.mirror, source_repository_id: 1 } }, /source_repository_id/);
  await rejects({ ...mirror, mirror: { url: 'https://github.com/octocat.git', source_repository_id: 1 } }, /owner\/repository/);
  await rejects({ ...mirror, default_branch: undefined }, /default_branch/);
  await rejects({ ...mirror, readme_template: 'project' }, /README/);
  await rejects({ ...mirror, license: 'mit' }, /license selection/);
  await rejects({ ...mirror, mirror: undefined }, /mirror source/);
  await rejects({ ...mirror, mode: 'create' }, /mirror source/);
});

test('mirror sources are immutable and render as uninitialized managed repositories', () => {
  assert.throws(() => checkTransition({ 'qemu-mirror': mirror }, { 'qemu-mirror': { ...mirror, mirror: { url: 'https://gitee.com/qemu/qemu.git' } } }, policy), /mirror is immutable/);
  checkTransition({ 'qemu-mirror': mirror }, { 'qemu-mirror': { ...mirror, access: { users: { zevorn: 'admin', bbbbbq: 'maintain' }, teams: {} } } }, policy);
  const values = terraformValues({ 'qemu-mirror': mirror }, policy).repositories['qemu-mirror'];
  assert.equal(values.mode, 'mirror');
  assert.equal(values.readme, null);
  assert.equal(values.license, null);
  assert.equal(values.default_branch, 'master');
});

test('source snapshots keep branches and tags, skip peeled and hidden refs, and push the default branch first', () => {
  const sha = (digit) => digit.repeat(40);
  const { head, refs } = parseRefs(['ref: refs/heads/master\tHEAD', `${sha('1')}\tHEAD`, `${sha('1')}\trefs/heads/master`, `${sha('2')}\trefs/heads/'test'`, `${sha('3')}\trefs/tags/v1.0`, `${sha('4')}\trefs/tags/v1.0^{}`, `${sha('5')}\trefs/pull/1/head`, ''].join('\n'));
  assert.equal(head, 'master');
  assert.deepEqual(refs, { 'refs/heads/master': sha('1'), "refs/heads/'test'": sha('2'), 'refs/tags/v1.0': sha('3') });
  const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`refs/tags/v${index}`, sha('3')]));
  const groups = refspecs({ default_branch: 'master', refs: { ...many, 'refs/heads/master': sha('1') } });
  assert.deepEqual(groups[0], [`${sha('1')}:refs/heads/master`]);
  assert.deepEqual(groups.slice(1).map((group) => group.length), [500, 500, 1]);
});

test('source access refuses transports other than HTTPS', async () => {
  await assert.rejects(listRefs('file:///nonexistent/source.git'), /not allowed/);
  await assert.rejects(listRefs('ext::sh -c true'), /not allowed/);
});

test('mirror plans move from reviewed creation to import of the initialized repository ID', () => {
  const name = 'qemu-mirror';
  const catalog = { [name]: mirror };
  const repository = { name, description: mirror.description, visibility: 'public', topics: ['qemu'], archived: false, archive_on_destroy: false };
  const branch = { repository: name, branch: 'master' };
  const collaborators = { repository: name, user: [{ username: 'zevorn', permission: 'admin' }], team: [] };
  const ruleset = { repository: name, name: 'review-default-branch', enforcement: 'active', target: 'branch', bypass_actors: [], conditions: [{ ref_name: [{ include: ['~DEFAULT_BRANCH'], exclude: [] }] }],
    rules: [{ deletion: true, non_fast_forward: true, pull_request: [{ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true }] }] };
  const change = (type, actions, before, after, importing = false) => ({ address: `${type}.managed["${name}"]`, type, name: 'managed', index: name, change: { actions, before, after, ...(importing ? { importing: { id: name } } : {}) } });
  const intents = authorizePlan({ resource_changes: [
    change('github_repository', ['create'], null, repository),
    change('github_branch_default', ['create'], null, branch),
    change('github_repository_collaborators', ['create'], null, collaborators),
    change('github_repository_ruleset', ['create'], null, ruleset),
  ] }, catalog, policy, [name]);
  assert.equal(intents.length, 4);
  const id = 1234;
  const execution = { resource_changes: [
    change('github_repository', ['update'], { ...repository, topics: [], archive_on_destroy: null, repo_id: id }, { ...repository, repo_id: id }, true),
    change('github_branch_default', ['no-op'], branch, branch, true),
    change('github_repository_collaborators', ['update'], { repository: name, user: [], team: [] }, collaborators, true),
    change('github_repository_ruleset', ['create'], null, ruleset),
  ] };
  assert.equal(authorizePlan(execution, catalog, policy, [name], intents, { initializedIds: { [name]: id } }).length, 4);
  assert.throws(() => authorizePlan(execution, catalog, policy, [name], intents), /reviewed plan/);
  assert.throws(() => authorizePlan(execution, catalog, policy, [name], intents, { initializedIds: { [name]: id + 1 } }), /reviewed plan/);
  assert.throws(() => authorizePlan(execution, { [name]: { ...mirror, mode: 'create', mirror: undefined } }, policy, [name], intents, { initializedIds: { [name]: id } }), /import target/);
});
