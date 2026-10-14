import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { root, parseYaml, validateRequest, loadPolicy, effectiveAccess, isRepositoryRequest } from './config.mjs';

const Client = Octokit.plugin(retry);
export function github(token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN) {
  if (!token && !process.env.GITHUB_ACTIONS) {
    try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { /* Authentication is reported below. */ }
  }
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required for GitHub access');
  return new Client({ auth: token, userAgent: 'gevico-repos', request: { headers: { 'X-GitHub-Api-Version': '2026-03-10' } }, retry: { retries: 3 } });
}

export async function findRepository(client, owner, repo) {
  try { return (await client.rest.repos.get({ owner, repo })).data; }
  catch (error) { if (error.status === 404) return null; throw error; }
}

export async function remoteCatalog(client, owner, repo, ref, directory) {
  const policy = await loadPolicy();
  const { data: tree } = await client.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' });
  if (tree.truncated) throw new Error('GitHub returned a truncated tree; request cannot be validated');
  const catalog = {};
  await fs.mkdir(path.join(directory, 'repositories'), { recursive: true });
  for (const entry of tree.tree.filter((item) => item.path.startsWith('repositories/'))) {
    if (entry.path === 'repositories/.gitkeep' && entry.type === 'blob' && entry.mode === '100644') continue;
    if (!isRepositoryRequest(entry.path) || entry.type !== 'blob' || entry.mode !== '100644') {
      throw new Error(`${entry.path}: request files must be ordinary YAML files`);
    }
    if (entry.size > 65_536) throw new Error(`${entry.path}: file exceeds 64 KiB`);
    const { data } = await client.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    if (data.encoding !== 'base64') throw new Error(`${entry.path}: unexpected blob encoding`);
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    const request = await validateRequest(parseYaml(text, entry.path), policy, path.basename(entry.path));
    catalog[request.name] = request;
    await fs.writeFile(path.join(directory, entry.path), text);
  }
  return { policy, catalog };
}

export async function inspectCatalog(client, catalog, policy, tracked = null) {
  const users = new Set();
  const teams = new Set();
  for (const request of Object.values(catalog)) {
    const access = effectiveAccess(request, policy);
    Object.keys(access.users).forEach((user) => users.add(user));
    Object.keys(access.teams).forEach((team) => teams.add(team));
    const repository = await findRepository(client, policy.organization, request.name);
    if (tracked && repository && !tracked.has(request.name)) throw new Error(`${request.name}: name already exists outside Terraform state; administrator import required`);
    if (repository?.archived) throw new Error(`${request.name}: archived repositories require administrator maintenance`);
    if (request.template) {
      const template = await findRepository(client, request.template.owner, request.template.repository);
      if (!template?.is_template) throw new Error(`${request.name}: initialization template is unavailable`);
    }
  }
  for (const user of users) await client.rest.users.getByUsername({ username: user });
  for (const team_slug of teams) await client.rest.teams.getByName({ org: policy.organization, team_slug });
}

export async function verifyCatalog(client, catalog, policy) {
  const result = [];
  for (const request of Object.values(catalog)) {
    const repository = await findRepository(client, policy.organization, request.name);
    if (!repository || repository.visibility !== request.visibility || repository.description !== request.description || repository.default_branch !== 'main') {
      throw new Error(`${request.name}: repository attributes do not match the approved request`);
    }
    const expected = effectiveAccess(request, policy);
    if (JSON.stringify([...(repository.topics ?? [])].sort()) !== JSON.stringify([...(request.topics ?? [])].sort())) throw new Error(`${request.name}: repository topics differ from the approved request`);
    const invitations = await client.paginate(client.rest.repos.listInvitations, { owner: policy.organization, repo: request.name });
    if (invitations.some((item) => !expected.users[item.invitee?.login.toLowerCase()])) throw new Error(`${request.name}: unexpected pending collaborator invitation`);
    const pending = [];
    for (const [username, role] of Object.entries(expected.users)) {
      const invitation = invitations.find((item) => item.invitee?.login.toLowerCase() === username.toLowerCase());
      if (invitation) {
        const requested = { pull: 'read', push: 'write' }[role] ?? role;
        if (![role, requested].includes(invitation.permissions)) throw new Error(`${request.name}: invitation role differs for ${username}`);
        pending.push(username);
      } else {
        const { data } = await client.rest.repos.getCollaboratorPermissionLevel({ owner: policy.organization, repo: request.name, username });
        const ranks = { none: 0, pull: 1, read: 1, triage: 2, push: 3, write: 3, maintain: 4, admin: 5 };
        if ((ranks[data.role_name] ?? ranks[data.permission] ?? 0) < ranks[role]) throw new Error(`${request.name}: insufficient effective permission for ${username}`);
      }
    }
    const actualTeams = await client.paginate(client.rest.repos.listTeams, { owner: policy.organization, repo: request.name });
    for (const [slug, role] of Object.entries(expected.teams)) {
      const team = actualTeams.find((item) => item.slug === slug);
      if (!team || team.permission !== role) throw new Error(`${request.name}: team permission differs for ${slug}`);
    }
    const actualUsers = await client.paginate(client.rest.repos.listCollaborators, { owner: policy.organization, repo: request.name, affiliation: 'direct' });
    const extraUsers = actualUsers.filter((user) => !expected.users[user.login.toLowerCase()]);
    if (extraUsers.length) throw new Error(`${request.name}: unexpected direct collaborator(s)`);
    for (const user of actualUsers) {
      const role = { read: 'pull', write: 'push' }[user.role_name] ?? user.role_name;
      if (role !== expected.users[user.login.toLowerCase()]) throw new Error(`${request.name}: direct permission differs for ${user.login}`);
    }
    const rulesets = await client.paginate(client.rest.repos.getRepoRulesets, { owner: policy.organization, repo: request.name });
    const ruleset = rulesets.find((item) => item.name === 'review-default-branch' && item.enforcement === 'active');
    if (!ruleset) throw new Error(`${request.name}: default branch ruleset is missing`);
    const { data: protection } = await client.rest.repos.getRepoRuleset({ owner: policy.organization, repo: request.name, ruleset_id: ruleset.id });
    const rules = protection.rules.map((rule) => rule.type);
    if (!rules.includes('deletion') || !rules.includes('non_fast_forward') || !protection.conditions?.ref_name?.include?.includes('~DEFAULT_BRANCH')) {
      throw new Error(`${request.name}: branch protection rules differ from the management policy`);
    }
    if (policy.require_pull_request_reviews) {
      const review = protection.rules.find((rule) => rule.type === 'pull_request');
      if (!review || review.parameters.required_approving_review_count !== 1 || !review.parameters.dismiss_stale_reviews_on_push || !review.parameters.require_last_push_approval) {
        throw new Error(`${request.name}: pull request review rules differ from the management policy`);
      }
    }
    result.push({ name: request.name, url: repository.html_url, id: repository.id, pending_invitations: pending });
  }
  return result;
}

export async function comment(client, owner, repo, number, body) {
  const marker = '<!-- gevico-repos -->';
  const existing = await client.paginate(client.rest.issues.listComments, { owner, repo, issue_number: number });
  const previous = existing.find((item) => item.body?.startsWith(marker) && item.user?.type === 'Bot');
  const text = `${marker}\n${body}`;
  if (previous) await client.rest.issues.updateComment({ owner, repo, comment_id: previous.id, body: text });
  else await client.rest.issues.createComment({ owner, repo, issue_number: number, body: text });
}

export async function status(client, owner, repo, sha, state, description, context) {
  await client.rest.repos.createCommitStatus({ owner, repo, sha, state, description: description.slice(0, 140), context, target_url: `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` });
}
