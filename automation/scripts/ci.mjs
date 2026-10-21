import fs from 'node:fs/promises';
import path from 'node:path';
import { root, engine, work, loadCatalog, loadPolicy, checkTransition, changedNames, digest, writeJson, isRepositoryRequest, repositoryMode, repositoryStatus, renderReadme, defaultBranch } from './config.mjs';
import { github, remoteCatalog, inspectCatalog, verifyCatalog, comment, status } from './github.mjs';
import { StateStore } from './state.mjs';
import { prepareTerraform, terraformPlan, terraformApply } from './runtime.mjs';
import { authorizePlan, describeIntents } from './plan-policy.mjs';
import { saveReview, loadReview } from './reviews.mjs';
import { AppSession } from './app-session.mjs';
import { importTargets, initializeForks, verifyForkSource } from './onboarding.mjs';
import { ForkCredentialError, reportForkCredentialIssue } from './credentials.mjs';
import { mirrorSnapshot, describeMirrors, initializeMirrors, verifyMirrorCopy } from './mirror.mjs';

const command = process.argv[2];
let pullRequest;
let control;
let store;
let session;
let readToken;

async function readSession() {
  session = await AppSession.open();
  const reader = await session.token('read');
  readToken = reader.token;
  process.env.GH_TOKEN = reader.token;
  process.env.GITHUB_TOKEN = reader.token;
  return reader.client;
}

function requireLifecycleMigration(state, lifecycle) {
  if (lifecycle && Object.values(state.repositories).some((repository) => repository.archive_on_destroy !== false)) throw new Error('Lifecycle requests require the completed archive_on_destroy=false state migration');
}

async function initialFiles(client, catalog, review) {
  for (const name of review?.changed ?? []) {
    const request = catalog[name];
    if (!review.intents.some((intent) => intent.name === name && intent.type === 'github_repository' && intent.actions[0] === 'create')) continue;
    if (request.readme_template) {
      const { data } = await client.rest.repos.getContent({ owner: 'gevico', repo: name, path: 'README.md', ref: defaultBranch(request, await loadPolicy()) });
      const { data: blob } = await client.rest.git.getBlob({ owner: 'gevico', repo: name, file_sha: data.sha });
      if (Buffer.from(blob.content, 'base64').toString('utf8') !== renderReadme(request)) throw new Error(`${name}: initialized README does not match the approved template`);
    }
    if (request.license) {
      const { data } = await client.rest.licenses.getForRepo({ owner: 'gevico', repo: name });
      if (data.license?.key !== request.license) throw new Error(`${name}: initialized license differs from the approved selection`);
    }
    if (repositoryMode(request) === 'mirror') await verifyMirrorCopy(client, readToken, name, review.mirrors[name]);
  }
}

async function input() {
  const policy = await loadPolicy();
  if (process.env.GITHUB_REPOSITORY !== `${policy.organization}/${policy.management_repository}`) throw new Error('Workflow must run in gevico/repos');
  const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  return { event, policy, owner: policy.organization, repo: policy.management_repository };
}

async function request() {
  const { event, owner, repo } = await input();
  control = github(process.env.CONTROL_TOKEN);
  const number = event.pull_request?.number ?? Number(event.inputs?.pull_request);
  if (!number) throw new Error('A pull request number is required');
  pullRequest = (await control.rest.pulls.get({ owner, repo, pull_number: number })).data;
  if (pullRequest.state !== 'open' || pullRequest.base.ref !== 'main') throw new Error('Request must be an open PR targeting main');
  const head = pullRequest.head.sha;
  await status(control, owner, repo, head, 'pending', 'Validating repository request', 'request/check');
  const files = await control.paginate(control.rest.pulls.listFiles, { owner, repo, pull_number: number });
  const requests = files.filter((file) => isRepositoryRequest(file.filename) || isRepositoryRequest(file.previous_filename ?? ''));
  if (!requests.length) {
    await status(control, owner, repo, head, 'success', 'Maintenance PR; repository requests unchanged', 'request/check');
    return;
  }
  if (files.some((file) => !isRepositoryRequest(file.filename) && !(file.filename === 'repositories/.gitkeep' && file.status === 'removed'))) throw new Error('Repository requests must be submitted separately from management code, policy or documentation changes');
  if (process.env.GITHUB_SHA !== pullRequest.base.sha) throw new Error('Trusted workflow source differs from the current PR base; rerun Request on main');
  if (process.env.AUTOMATION_ENABLED !== 'true') throw new Error('Organization automation is not configured; administrator must complete automation/docs/setup.md');
  const reader = await readSession();
  const before = await remoteCatalog(control, owner, repo, pullRequest.base.sha, path.join(work, 'base'));
  const after = await remoteCatalog(control, owner, repo, head, path.join(work, 'head'));
  const { lifecycle } = checkTransition(before.catalog, after.catalog, after.policy);
  const changed = changedNames(before.catalog, after.catalog);
  store = await StateStore.open();
  const applied = await store.get('applied.json', true);
  if (applied?.data.sha !== pullRequest.base.sha) throw new Error('The base commit has not finished applying; rerun preview after Apply succeeds');
  const stateBefore = await store.terraformState();
  requireLifecycleMigration(stateBefore, lifecycle);
  const ids = await inspectCatalog(reader, after.catalog, after.policy, stateBefore, applied.data.repositories);
  if (lifecycle && ids.length + 1 > 500) throw new Error('Lifecycle execution exceeds the GitHub installation token repository limit');
  for (const name of changed) if (repositoryMode(after.catalog[name]) === 'fork') {
    await verifyForkSource(reader, after.catalog[name]);
    if (!before.catalog[name] && after.catalog[name].fork.owner.toLowerCase() !== 'gevico' && process.env.FORK_ENABLED !== 'true') throw new Error('External Fork requests require configured production FORK_USER_TOKEN and FORK_ENABLED=true');
  }
  const mirrorNames = changed.filter((name) => !before.catalog[name] && repositoryMode(after.catalog[name]) === 'mirror');
  if (mirrorNames.length && process.env.MIRROR_ENABLED !== 'true') throw new Error('Mirror requests require the write App Workflows permission and MIRROR_ENABLED=true');
  const mirrors = {};
  for (const name of mirrorNames) mirrors[name] = await mirrorSnapshot(reader, after.catalog[name], after.policy);
  const imports = await importTargets(reader, after.catalog, stateBefore);
  const directory = await prepareTerraform(after.catalog, after.policy, store, imports);
  const plan = await terraformPlan(directory, { readOnly: true });
  const intents = authorizePlan(plan, after.catalog, after.policy, changed, null, { lifecycle });
  const stateAfter = await store.terraformState();
  if (stateBefore.version !== stateAfter.version) throw new Error('Terraform state changed during preview; rerun request validation');
  const latest = (await control.rest.pulls.get({ owner, repo, pull_number: number })).data;
  if (latest.head.sha !== head || latest.base.sha !== pullRequest.base.sha) throw new Error('Pull request changed during preview; rerun validation');
  const lock = await fs.readFile(path.join(engine, 'terraform/.terraform.lock.hcl'), 'utf8');
  const review = { number, head, base: pullRequest.base.sha, config_digest: digest(after.catalog), policy_digest: digest(after.policy), lock_digest: digest(lock), state_version: stateBefore.version, changed, lifecycle, intents,
    repository_ids: Object.fromEntries(changed.filter((name) => after.catalog[name].repository_id).map((name) => [name, after.catalog[name].repository_id])),
    forks: Object.fromEntries(changed.filter((name) => !before.catalog[name] && repositoryMode(after.catalog[name]) === 'fork').map((name) => [name, after.catalog[name].fork])), mirrors };
  await saveReview(review);
  const copies = describeMirrors(mirrors);
  await comment(control, owner, repo, number, `### Repository request\n\nCommit: \`${head}\`\n\n${describeIntents(intents)}${copies ? `\n\n${copies}` : ''}\n\nMerge this PR after the configuration and these changes have been approved.`);
  await status(control, owner, repo, head, 'success', 'Repository configuration and execution preview validated', 'request/check');
}

async function apply() {
  const { policy, owner, repo } = await input();
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Apply is restricted to main');
  if (process.env.AUTOMATION_ENABLED !== 'true') throw new Error('Organization automation is not configured; administrator must complete automation/docs/setup.md');
  const reader = await readSession();
  control = github(process.env.CONTROL_TOKEN);
  const sha = process.env.GITHUB_SHA;
  const commit = (await control.rest.repos.getCommit({ owner, repo, ref: sha })).data;
  const latest = (await control.rest.repos.getCommit({ owner, repo, ref: 'main' })).data.sha;
  if (sha !== latest) throw new Error('This run targets an outdated commit; rerun the latest main workflow');
  const { catalog } = await loadCatalog();
  store = await StateStore.open();
  const state = await store.terraformState();
  const applied = await store.get('applied.json', true);
  const commits = await control.paginate(control.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: sha });
  pullRequest = commits.find((item) => item.merged_at && item.merge_commit_sha === sha && item.base.ref === 'main');
  if (pullRequest) pullRequest = (await control.rest.pulls.get({ owner, repo, pull_number: pullRequest.number })).data;
  if (!pullRequest && Object.keys(catalog).length) throw new Error('A merged pull request is required to change repositories');
  let review;
  let transition = { lifecycle: false };
  const files = pullRequest ? await control.paginate(control.rest.pulls.listFiles, { owner, repo, pull_number: pullRequest.number }) : [];
  if (pullRequest && files.some((file) => isRepositoryRequest(file.filename) || isRepositoryRequest(file.previous_filename ?? ''))) {
    const base = commit.parents[0]?.sha;
    if (!base) throw new Error('Merged commit must have an approved base commit');
    const before = await remoteCatalog(control, owner, repo, base, path.join(work, 'base'));
    transition = checkTransition(before.catalog, catalog, policy);
    const changed = changedNames(before.catalog, catalog);
    if (changed.length) {
      const saved = await store.get(`reviews/${pullRequest.number}/${pullRequest.head.sha}.json`, true);
      review = saved?.data ?? await loadReview(control, owner, repo, pullRequest.number, pullRequest.head.sha, base);
      const lock = await fs.readFile(path.join(engine, 'terraform/.terraform.lock.hcl'), 'utf8');
      if (review.number !== pullRequest.number || review.head !== pullRequest.head.sha || review.base !== base || review.source_sha !== base || review.config_digest !== digest(catalog) || review.policy_digest !== digest(policy) || review.lock_digest !== digest(lock) || Boolean(review.lifecycle) !== transition.lifecycle) throw new Error('Merged configuration differs from the validated PR');
      if (applied?.data.sha !== review.base && applied?.data.sha !== sha) throw new Error('The preceding approved commit has not finished applying');
    }
  }
  requireLifecycleMigration(state, transition.lifecycle);
  const records = [...(applied?.data.repositories ?? [])];
  for (const [mode, requests] of [['fork', review?.forks], ['mirror', review?.mirrors]]) for (const name of Object.keys(requests ?? {})) {
    const initialization = await store.get(`${mode}s/${pullRequest.number}/${pullRequest.head.sha}/${name}.json`, true);
    if (initialization?.data.id && !records.some((item) => item.name === name)) records.push({ name, id: initialization.data.id, origin: `${mode}-init` });
  }
  const ids = await inspectCatalog(reader, catalog, policy, state, records);
  const stateRepository = (await reader.rest.repos.get({ owner, repo: 'repos-state' })).data;
  await store.close(); store = null;
  const writer = await session.token('write', transition.lifecycle ? [...ids, stateRepository.id] : null, { workflows: Object.keys(review?.mirrors ?? {}).length > 0 });
  process.env.GH_TOKEN = writer.token;
  process.env.GITHUB_TOKEN = writer.token;
  store = await StateStore.open();
  if ((await store.terraformState()).version !== state.version) throw new Error('Terraform state changed while preparing execution; rerun Apply');
  if (review) await store.put(`reviews/${pullRequest.number}/${pullRequest.head.sha}.json`, review);
  const approvalKey = review ? `${pullRequest.number}/${pullRequest.head.sha}` : null;
  const initializedIds = review ? {
    ...await initializeForks(reader, writer.client, catalog, review.changed, store, approvalKey),
    ...await initializeMirrors(reader, writer.client, writer.token, catalog, review.changed, review.mirrors ?? {}, store, approvalKey),
  } : {};
  const currentState = await store.terraformState();
  const imports = await importTargets(reader, catalog, currentState);
  const directory = await prepareTerraform(catalog, policy, store, imports);
  const plan = await terraformPlan(directory);
  authorizePlan(plan, catalog, policy, review?.changed ?? [], review?.intents ?? [], { allowMigration: !review, lifecycle: transition.lifecycle, initializedIds });
  await inspectCatalog(reader, catalog, policy, currentState, [...records, ...Object.entries(initializedIds).filter(([name]) => !records.some((item) => item.name === name)).map(([name, id]) => ({ name, id, origin: `${repositoryMode(catalog[name])}-init` }))]);
  await terraformApply(directory);
  const result = await verifyCatalog(reader, catalog, policy);
  if (applied?.data.sha !== sha) await initialFiles(reader, catalog, review);
  await store.put('applied.json', { sha, repositories: result, applied_at: new Date().toISOString(), run_id: process.env.GITHUB_RUN_ID });
  await writeJson(path.join(work, 'result.json'), result);
  const report = result.length ? result.map((item) => `- ${item.status === 'deleted' ? `\`${item.name}\`` : `[${item.name}](${item.url})`}: ${item.status}, repository ID ${item.id}${item.pending_invitations.length ? ` — pending invitations: ${item.pending_invitations.join(', ')}` : ''}`).join('\n') : 'The management repository is initialized. No target repositories are registered.';
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Repository verification\n\n${report}\n`);
  if (pullRequest) await comment(control, owner, repo, pullRequest.number, `### Repository verification succeeded\n\nApplied commit: \`${sha}\`\n\n${report}`);
  const open = await control.paginate(control.rest.pulls.list, { owner, repo, state: 'open', base: 'main' });
  for (const pr of open) {
    await control.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: 'request.yml', ref: 'main', inputs: { pull_request: String(pr.number) } });
  }
}

async function verify() {
  const { catalog, policy } = await loadCatalog();
  console.log(JSON.stringify(await verifyCatalog(github(), catalog, policy), null, 2));
}

try {
  await fs.mkdir(path.join(work, 'tmp'), { recursive: true });
  if (command === 'request') await request();
  else if (command === 'apply') await apply();
  else if (command === 'verify') await verify();
  else throw new Error(`Unknown CI command: ${command}`);
} catch (error) {
  console.error(error.message);
  if (error instanceof ForkCredentialError && control) await reportForkCredentialIssue(control, error);
  if (pullRequest && control) {
    const policy = await loadPolicy();
    if (command === 'request') await status(control, policy.organization, policy.management_repository, pullRequest.head.sha, 'failure', error.message, 'request/check').catch(() => {});
    await comment(control, policy.organization, policy.management_repository, pullRequest.number, `### ${command === 'request' ? 'Request validation' : 'Repository automation'} failed\n\n${error.message}\n\nInspect the Actions run and [recovery guide](https://github.com/gevico/repos/blob/main/automation/docs/operations.md).`).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (store) await store.close();
  if (session) await session.close();
}
