import fs from 'node:fs/promises';
import path from 'node:path';
import { root, work, loadCatalog, loadPolicy, checkTransition, changedNames, digest, writeJson, isRepositoryDocumentation } from './config.mjs';
import { github, remoteCatalog, inspectCatalog, verifyCatalog, comment, status } from './github.mjs';
import { StateStore } from './state.mjs';
import { prepareTerraform, terraformPlan, terraformApply, run } from './runtime.mjs';
import { authorizePlan, describeIntents } from './plan-policy.mjs';

const command = process.argv[2];
let pullRequest;
let control;

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
  const requests = files.filter((file) => file.filename.startsWith('repositories/') && !isRepositoryDocumentation(file.filename));
  if (!requests.length) {
    await status(control, owner, repo, head, 'success', 'Maintenance PR; repository requests unchanged', 'request/check');
    return;
  }
  if (files.some((file) => !file.filename.startsWith('repositories/') || isRepositoryDocumentation(file.filename))) throw new Error('Repository requests must be submitted separately from management code, policy or documentation changes');
  if (requests.some((file) => ['removed', 'renamed'].includes(file.status))) throw new Error('Removing or renaming repository requests is prohibited');
  if (process.env.AUTOMATION_ENABLED !== 'true') throw new Error('Organization automation is not configured; administrator must complete docs/setup.md');
  const reader = github();
  const before = await remoteCatalog(control, owner, repo, pullRequest.base.sha, path.join(work, 'base'));
  const after = await remoteCatalog(control, owner, repo, head, path.join(work, 'head'));
  checkTransition(before.catalog, after.catalog);
  const changed = changedNames(before.catalog, after.catalog);
  const store = new StateStore();
  const applied = await store.get('applied.json', true);
  if (applied?.data.sha !== pullRequest.base.sha) throw new Error('The base commit has not finished applying; refresh this PR after the preceding workflow succeeds');
  const stateBefore = await store.terraformState();
  await inspectCatalog(reader, after.catalog, after.policy, stateBefore.names);
  const directory = await prepareTerraform(after.catalog, after.policy);
  const plan = await terraformPlan(directory, { readOnly: true });
  const intents = authorizePlan(plan, after.catalog, after.policy, changed);
  const stateAfter = await store.terraformState();
  if (stateBefore.version !== stateAfter.version) throw new Error('Terraform state changed during preview; rerun request validation');
  const latest = (await control.rest.pulls.get({ owner, repo, pull_number: number })).data;
  if (latest.head.sha !== head || latest.base.sha !== pullRequest.base.sha) throw new Error('Pull request changed during preview; rerun validation');
  const lock = await fs.readFile(path.join(root, 'terraform/.terraform.lock.hcl'), 'utf8');
  const review = { number, head, base: pullRequest.base.sha, config_digest: digest(after.catalog), policy_digest: digest(after.policy), lock_digest: digest(lock), state_version: stateBefore.version, changed, intents };
  await store.put(`reviews/${number}/${head}.json`, review);
  await comment(control, owner, repo, number, `### Repository request\n\nCommit: \`${head}\`\n\n${describeIntents(intents)}\n\nMerge this PR after the configuration and these changes have been approved.`);
  await status(control, owner, repo, head, 'success', 'Repository configuration and execution preview validated', 'request/check');
}

async function apply() {
  const { event, policy, owner, repo } = await input();
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Apply is restricted to main');
  if (process.env.AUTOMATION_ENABLED !== 'true') throw new Error('Organization automation is not configured; administrator must complete docs/setup.md');
  const client = github();
  control = github(process.env.CONTROL_TOKEN);
  const sha = process.env.GITHUB_SHA;
  const commit = (await control.rest.repos.getCommit({ owner, repo, ref: sha })).data;
  const latest = (await control.rest.repos.getCommit({ owner, repo, ref: 'main' })).data.sha;
  if (sha !== latest) throw new Error('This run targets an outdated commit; rerun the latest main workflow');
  const { catalog } = await loadCatalog();
  const store = new StateStore();
  const state = await store.terraformState();
  const applied = await store.get('applied.json', true);
  const commits = await control.paginate(control.rest.repos.listPullRequestsAssociatedWithCommit, { owner, repo, commit_sha: sha });
  pullRequest = commits.find((item) => item.merged_at && item.merge_commit_sha === sha && item.base.ref === 'main');
  if (pullRequest) pullRequest = (await control.rest.pulls.get({ owner, repo, pull_number: pullRequest.number })).data;
  if (!pullRequest && Object.keys(catalog).length) throw new Error('A merged pull request is required to change repositories');
  let review;
  if (pullRequest) {
    const base = commit.parents[0]?.sha;
    if (!base) throw new Error('Merged commit must have an approved base commit');
    const before = await remoteCatalog(control, owner, repo, base, path.join(work, 'base'));
    checkTransition(before.catalog, catalog);
    const changed = changedNames(before.catalog, catalog);
    if (changed.length) {
      review = (await store.get(`reviews/${pullRequest.number}/${pullRequest.head.sha}.json`)).data;
      const lock = await fs.readFile(path.join(root, 'terraform/.terraform.lock.hcl'), 'utf8');
      if (review.base !== base || review.config_digest !== digest(catalog) || review.policy_digest !== digest(policy) || review.lock_digest !== digest(lock)) throw new Error('Merged configuration differs from the validated PR');
      if (applied?.data.sha !== review.base && applied?.data.sha !== sha) throw new Error('The preceding approved commit has not finished applying');
    }
  }
  await inspectCatalog(client, catalog, policy, state.names);
  const directory = await prepareTerraform(catalog, policy);
  const plan = await terraformPlan(directory);
  const intents = authorizePlan(plan, catalog, policy, review?.changed ?? [], review?.intents ?? []);
  if (intents.length) await terraformApply(directory);
  const result = await verifyCatalog(client, catalog, policy);
  await store.put('applied.json', { sha, repositories: result, applied_at: new Date().toISOString(), run_id: process.env.GITHUB_RUN_ID });
  await writeJson(path.join(work, 'result.json'), result);
  const report = result.length ? result.map((item) => `- [${item.name}](${item.url})${item.pending_invitations.length ? ` — pending invitations: ${item.pending_invitations.join(', ')}` : ''}`).join('\n') : 'The management repository is initialized. No target repositories are registered.';
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
  if (pullRequest && control) {
    const policy = await loadPolicy();
    if (command === 'request') await status(control, policy.organization, policy.management_repository, pullRequest.head.sha, 'failure', error.message, 'request/check').catch(() => {});
    await comment(control, policy.organization, policy.management_repository, pullRequest.number, `### ${command === 'request' ? 'Request validation' : 'Repository automation'} failed\n\n${error.message}\n\nInspect the Actions run and [recovery guide](https://github.com/gevico/repos/blob/main/docs/operations.md).`).catch(() => {});
  }
  process.exitCode = 1;
}
