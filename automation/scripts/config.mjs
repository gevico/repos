import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { parseDocument, stringify } from 'yaml';

export const engine = path.resolve(import.meta.dirname, '..');
export const root = path.resolve(engine, '..');
export const work = path.join(root, '.work');

export function isRepositoryRequest(filename) {
  return /^repositories\/[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/.test(filename);
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
  for (const key of ['administrator_users', 'administrator_teams', 'allowed_teams', 'allowed_templates', 'reserved_names']) {
    if (!Array.isArray(policy[key]) || policy[key].some((item) => typeof item !== 'string')) {
      throw new Error(`policy.yml: ${key} must be an array of strings`);
    }
  }
  if (policy.default_branch !== 'main' || typeof policy.private_branch_protection !== 'boolean' || typeof policy.require_pull_request_reviews !== 'boolean') {
    throw new Error('policy.yml: invalid branch policy');
  }
  return policy;
}

export async function validator() {
  const schema = JSON.parse(await fs.readFile(path.join(engine, 'schema/repository.schema.json'), 'utf8'));
  return new Ajv({ allErrors: true, strict: true }).compile(schema);
}

export async function validateRequest(request, policy, filename) {
  const validate = await validator();
  if (!validate(request)) throw new Error(`${filename}: ${new Ajv().errorsText(validate.errors, { separator: '; ' })}`);
  if (filename !== `${request.name}.yaml`) throw new Error(`${filename}: filename must match ${request.name}.yaml`);
  if (policy.reserved_names.includes(request.name)) throw new Error(`${filename}: reserved repository name`);
  if (!request.description.trim()) throw new Error(`${filename}: description must describe the repository purpose`);
  if (request.visibility === 'private' && !policy.private_branch_protection) {
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
    if (policy.administrator_users.some((admin) => admin.toLowerCase() === user.toLowerCase()) && role !== 'admin') {
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
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.gitkeep' && entry.isFile()) continue;
    if (!entry.isFile() || !isRepositoryRequest(`repositories/${entry.name}`)) throw new Error(`repositories/${entry.name}: only ordinary <name>.yaml files are accepted`);
    const document = parseYaml(await fs.readFile(path.join(directory, 'repositories', entry.name), 'utf8'), entry.name);
    const request = await validateRequest(document, policy, entry.name);
    if (catalog[request.name]) throw new Error(`${entry.name}: duplicate repository name`);
    catalog[request.name] = request;
  }
  return { policy, catalog };
}

export function effectiveAccess(request, policy) {
  const users = Object.fromEntries(Object.entries(request.access.users).map(([user, role]) => [user.toLowerCase(), role]));
  for (const user of policy.administrator_users) users[user.toLowerCase()] = 'admin';
  const teams = { ...request.access.teams };
  for (const team of policy.administrator_teams) teams[team] = 'admin';
  return { users, teams };
}

export function checkTransition(before, after) {
  for (const name of Object.keys(before)) {
    if (!after[name]) throw new Error(`${name}: removing or renaming a managed repository is prohibited`);
    if (JSON.stringify(before[name].template ?? null) !== JSON.stringify(after[name].template ?? null)) throw new Error(`${name}: initialization template is immutable after registration`);
  }
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
    repositories: Object.fromEntries(Object.entries(catalog).map(([name, request]) => [name, {
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
