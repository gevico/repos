import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { parseDocument, stringify } from 'yaml';
import Mustache from 'mustache';

export const engine = path.resolve(import.meta.dirname, '..');
export const root = path.resolve(engine, '..');
export const work = path.join(root, '.work');

export function isRepositoryRequest(filename) {
  return /^repositories\/(?:archive\/)?[A-Za-z0-9_.-]+\.yaml$/.test(filename);
}

export function repositoryStatus(request) {
  return request.status ?? 'active';
}

export function repositoryMode(request) {
  return request.mode ?? 'create';
}

export function defaultBranch(request, policy) {
  return request.default_branch ?? policy.default_branch;
}

export function renderReadme(request) {
  if (!request.readme_template) return null;
  const template = readFileSync(path.join(engine, 'templates/readme', `${request.readme_template}.md`), 'utf8');
  return Mustache.render(template, { name: request.name, description: request.description, license: request.license, url: `https://github.com/gevico/${request.name}` });
}

export function requestPath(request) {
  return `repositories/${repositoryStatus(request) === 'active' ? '' : 'archive/'}${request.name}.yaml`;
}

export function parseYaml(text, label) {
  if (Buffer.byteLength(text) > 65_536) throw new Error(`${label}: file exceeds 64 KiB`);
  const document = parseDocument(text, { uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error(`${label}: ${[...document.errors, ...document.warnings].map((error) => error.message).join('; ')}`);
  }
  return document.toJS({ maxAliasCount: 0 });
}

export async function loadPolicy(directory = engine) {
  const policy = parseYaml(await fs.readFile(path.join(directory, 'policy.yml'), 'utf8'), 'policy.yml');
  if (policy.organization !== 'gevico' || policy.management_repository !== 'repos') {
    throw new Error('policy.yml must target gevico/repos');
  }
  if (!policy.administrator_users?.length && !policy.administrator_teams?.length) {
    throw new Error('policy.yml must define repository administrators');
  }
  for (const key of ['administrator_users', 'administrator_teams', 'allowed_teams', 'allowed_templates', 'allowed_mirror_hosts', 'allowed_licenses', 'reserved_names']) {
    if (!Array.isArray(policy[key]) || policy[key].some((item) => typeof item !== 'string')) {
      throw new Error(`policy.yml: ${key} must be an array of strings`);
    }
  }
  const licenses = JSON.parse(await fs.readFile(path.join(engine, 'schema/repository.schema.json'), 'utf8')).properties.license.enum;
  if (policy.allowed_licenses.some((key) => !licenses.includes(key))) throw new Error('policy.yml: allowed_licenses must use GitHub license keys from repository.schema.json');
  if (policy.default_branch !== 'main' || typeof policy.private_branch_protection !== 'boolean' || typeof policy.require_pull_request_reviews !== 'boolean') {
    throw new Error('policy.yml: invalid branch policy');
  }
  for (const [name, users] of Object.entries(policy.protected_repository_users ?? {})) if (!Array.isArray(users) || users.some((user) => typeof user !== 'string')) throw new Error(`policy.yml: invalid protected users for ${name}`);
  return policy;
}

export function mirrorSource(url, policy, label = 'mirror') {
  let source;
  try { source = new URL(url); } catch { throw new Error(`${label}: mirror url must be an absolute HTTPS URL`); }
  if (source.href !== url || source.protocol !== 'https:' || source.username || source.password || source.port || source.search || source.hash) throw new Error(`${label}: mirror url must be a canonical HTTPS URL without credentials, port, query or fragment`);
  if (!url.endsWith('.git')) throw new Error(`${label}: mirror url must be the source clone URL ending in .git`);
  if (!policy.allowed_mirror_hosts.includes(source.hostname)) throw new Error(`${label}: mirror host ${source.hostname} is not allowed by policy.yml`);
  if (source.hostname !== 'github.com') return { url, host: source.hostname };
  const match = source.pathname.match(/^\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\/([A-Za-z0-9_.-]+)\.git$/);
  if (!match || ['.', '..'].includes(match[2])) throw new Error(`${label}: GitHub mirror sources use https://github.com/owner/repository.git`);
  return { url, host: source.hostname, owner: match[1], repository: match[2] };
}

export async function validator() {
  const schema = JSON.parse(await fs.readFile(path.join(engine, 'schema/repository.schema.json'), 'utf8'));
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

export async function validateRequest(request, policy, filename) {
  const validate = await validator();
  if (!validate(request)) throw new Error(`${filename}: ${new Ajv().errorsText(validate.errors, { separator: '; ' })}`);
  const filenamePath = filename.includes('/') ? filename : `repositories/${filename}`;
  if (filenamePath !== requestPath(request)) throw new Error(`${filename}: filename and directory must match ${requestPath(request)}`);
  const mode = repositoryMode(request);
  if (policy.reserved_names.some((name) => name.toLowerCase() === request.name.toLowerCase())) throw new Error(`${filename}: reserved repository name`);
  if (mode !== 'existing' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.name)) throw new Error(`${filename}: new repository names must use lowercase letters, digits and hyphens`);
  if (mode !== 'existing' && !request.description.trim()) throw new Error(`${filename}: description must describe the repository purpose`);
  if (mode === 'existing' && !request.repository_id) throw new Error(`${filename}: existing repository requests require repository_id`);
  if ((mode === 'fork') !== Boolean(request.fork)) throw new Error(`${filename}: fork source is required only for mode fork`);
  if ((mode === 'mirror') !== Boolean(request.mirror)) throw new Error(`${filename}: mirror source is required only for mode mirror`);
  if (mode === 'mirror') {
    const source = mirrorSource(request.mirror.url, policy, filename);
    if ((source.host === 'github.com') !== Boolean(request.mirror.source_repository_id)) throw new Error(`${filename}: source_repository_id is required only for GitHub mirror sources`);
    if (!request.default_branch) throw new Error(`${filename}: mirror requests require the source default_branch`);
    if (request.readme_template) throw new Error(`${filename}: mirror repositories keep the source content; README templates initialize new repositories`);
  }
  if (request.template && mode !== 'create') throw new Error(`${filename}: repository templates require mode create`);
  if (request.license && (mode !== 'create' || request.template)) throw new Error(`${filename}: license selection requires a new repository without a repository template`);
  if (request.readme_template && mode === 'existing') throw new Error(`${filename}: existing requests manage access and lifecycle; README templates initialize new repositories`);
  if (request.default_branch && (request.default_branch.startsWith('/') || request.default_branch.includes('..') || request.default_branch.includes('\\') || request.default_branch.includes('\n'))) throw new Error(`${filename}: invalid default branch`);
  if (mode !== 'existing' && request.visibility === 'private' && !policy.private_branch_protection) {
    throw new Error(`${filename}: private repositories require an organization plan with branch protection; enable the verified capability in policy.yml`);
  }
  const maintainers = [...Object.values(request.access.users), ...Object.values(request.access.teams)];
  if (!maintainers.some((role) => ['maintain', 'admin'].includes(role))) throw new Error(`${filename}: assign a maintainer with maintain or admin permission`);
  const normalizedUsers = Object.keys(request.access.users).map((user) => user.toLowerCase());
  if (new Set(normalizedUsers).size !== normalizedUsers.length) throw new Error(`${filename}: duplicate GitHub user`);
  for (const team of Object.keys(request.access.teams)) {
    if (![...policy.allowed_teams, ...policy.administrator_teams].includes(team)) throw new Error(`${filename}: team ${team} is not allowed by policy.yml`);
  }
  if (request.template && !policy.allowed_templates.includes(`${request.template.owner}/${request.template.repository}`)) {
    throw new Error(`${filename}: template is not allowed by policy.yml`);
  }
  for (const [user, role] of Object.entries(request.access.users)) {
    if ([...policy.administrator_users, ...(policy.protected_repository_users?.[request.name] ?? [])].some((admin) => admin.toLowerCase() === user.toLowerCase()) && role !== 'admin') {
      throw new Error(`${filename}: administrator ${user} must retain admin permission`);
    }
  }
  for (const [team, role] of Object.entries(request.access.teams)) {
    if (policy.administrator_teams.includes(team) && role !== 'admin') throw new Error(`${filename}: administrator team ${team} must retain admin permission`);
  }
  return request;
}

export async function loadCatalog(directory = root, policyDirectory = engine) {
  const policy = await loadPolicy(policyDirectory);
  const catalog = {};
  let entries;
  try { entries = await fs.readdir(path.join(directory, 'repositories'), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('Catalog root must be a directory');
      return { policy, catalog };
    }
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.gitkeep' && entry.isFile()) continue;
    if (entry.name === 'archive' && entry.isDirectory()) {
      for (const archived of await fs.readdir(path.join(directory, 'repositories/archive'), { withFileTypes: true })) {
        const filename = `repositories/archive/${archived.name}`;
        if (!archived.isFile() || !isRepositoryRequest(filename)) throw new Error(`${filename}: only ordinary <name>.yaml files are accepted`);
        files.push(filename);
      }
      continue;
    }
    if (!entry.isFile() || !isRepositoryRequest(`repositories/${entry.name}`)) throw new Error(`repositories/${entry.name}: only ordinary <name>.yaml files are accepted`);
    files.push(`repositories/${entry.name}`);
  }
  for (const filename of files.sort()) {
    const document = parseYaml(await fs.readFile(path.join(directory, filename), 'utf8'), filename);
    const request = await validateRequest(document, policy, filename);
    if (Object.keys(catalog).some((name) => name.toLowerCase() === request.name.toLowerCase())) throw new Error(`${filename}: duplicate repository name`);
    catalog[request.name] = request;
  }
  return { policy, catalog };
}

export function effectiveAccess(request, policy) {
  const users = Object.fromEntries(Object.entries(request.access.users).map(([user, role]) => [user.toLowerCase(), role]));
  for (const user of [...policy.administrator_users, ...(policy.protected_repository_users?.[request.name] ?? [])]) users[user.toLowerCase()] = 'admin';
  const teams = { ...request.access.teams };
  for (const team of policy.administrator_teams) teams[team] = 'admin';
  return { users, teams };
}

export function checkTransition(before, after, policy) {
  let lifecycle = false;
  for (const name of Object.keys(before)) {
    if (!after[name]) throw new Error(`${name}: removing or renaming a managed repository is prohibited`);
    if (JSON.stringify(before[name].template ?? null) !== JSON.stringify(after[name].template ?? null)) throw new Error(`${name}: initialization template is immutable after registration`);
    const previous = before[name];
    const desired = after[name];
    if (repositoryMode(previous) !== repositoryMode(desired)) throw new Error(`${name}: repository mode is immutable`);
    for (const field of ['fork', 'mirror', 'readme_template', 'license', 'default_branch']) if (stableJson(previous[field] ?? null) !== stableJson(desired[field] ?? null)) throw new Error(`${name}: ${field} is immutable after registration`);
    if (previous.repository_id && previous.repository_id !== desired.repository_id) throw new Error(`${name}: repository_id is immutable after registration`);
    if (repositoryStatus(previous) === 'deleted' && stableJson(previous) !== stableJson(desired)) throw new Error(`${name}: a deleted declaration is immutable`);
    if (repositoryStatus(previous) !== repositoryStatus(desired)) lifecycle = true;
    if (repositoryStatus(previous) !== 'active' || repositoryStatus(desired) !== 'active') {
      const { status: oldStatus, repository_id: oldId, ...oldConfiguration } = previous;
      const { status: newStatus, repository_id: newId, ...newConfiguration } = desired;
      if (stableJson(oldConfiguration) !== stableJson(newConfiguration)) throw new Error(`${name}: lifecycle requests must preserve repository attributes and access`);
    }
  }
  for (const [name, request] of Object.entries(after)) {
    if (before[name]) continue;
    if (repositoryStatus(request) !== 'active' || (repositoryMode(request) !== 'existing' && request.repository_id)) throw new Error(`${name}: new declarations must be active and use repository_id only for mode existing`);
    // Registered repositories keep their license after the allowed list changes.
    if (request.license && !policy.allowed_licenses.includes(request.license)) throw new Error(`${name}: license ${request.license} is not allowed by policy.yml`);
  }
  if (lifecycle && changedNames(before, after).some((name) => !before[name] || repositoryStatus(before[name]) === repositoryStatus(after[name]))) throw new Error('Lifecycle requests must be submitted separately from creation or configuration changes');
  return { lifecycle };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

export function changedNames(before, after) {
  return Object.keys(after).filter((name) => digest(before[name] ?? null) !== digest(after[name]));
}

export function terraformValues(catalog, policy) {
  return {
    organization: policy.organization,
    repositories: Object.fromEntries(Object.entries(catalog).filter(([, request]) => repositoryStatus(request) !== 'deleted').map(([name, request]) => [name, {
      archived: repositoryStatus(request) === 'archived',
      mode: repositoryMode(request),
      default_branch: defaultBranch(request, policy),
      license: request.license ?? null,
      readme: renderReadme(request),
      description: request.description,
      visibility: request.visibility,
      topics: request.topics ?? [],
      template: request.template ?? null,
      ...effectiveAccess(request, policy),
    }])),
    require_pull_request_reviews: policy.require_pull_request_reviews,
  };
}

export function requestYaml(request) {
  return stringify(request, { lineWidth: 0, sortMapEntries: false });
}

export async function writeJson(filename, data) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(data, null, 2)}\n`);
}
