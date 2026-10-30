import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { root, loadCatalog, loadPolicy, validateRequest, requestYaml, terraformValues, writeJson, repositoryStatus, requestPath, checkTransition } from './config.mjs';
import { github, inspectCatalog, findRepository } from './github.mjs';
import { existingRequest } from './onboarding.mjs';
import { resolveMirror } from './mirror.mjs';

function assignment(value) {
  const [identity, role, extra] = value.split(':');
  const aliases = { read: 'pull', write: 'push' };
  if (!identity || !role || extra) throw new Error('Use identity:role for permissions');
  return [identity, aliases[role] ?? role];
}

async function main() {
  const [command = 'validate', ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    directory: { type: 'string' },
    online: { type: 'boolean', default: false },
    output: { type: 'string' },
    name: { type: 'string' },
    status: { type: 'string' },
    fork: { type: 'string' },
    mirror: { type: 'string' },
    'default-branch-only': { type: 'boolean', default: false },
    'readme-template': { type: 'string' },
    license: { type: 'string' },
    'remove-user': { type: 'string', multiple: true, default: [] },
    'remove-team': { type: 'string', multiple: true, default: [] },
    description: { type: 'string' },
    visibility: { type: 'string', default: 'public' },
    maintainer: { type: 'string', multiple: true, default: [] },
    user: { type: 'string', multiple: true, default: [] },
    team: { type: 'string', multiple: true, default: [] },
    topic: { type: 'string', multiple: true, default: [] },
    template: { type: 'string' },
    'json-file': { type: 'string' },
  } });
  if (command === 'request') {
    const policy = await loadPolicy();
    const request = values['json-file'] ? JSON.parse(await fs.readFile(path.resolve(root, values['json-file']), 'utf8')) : {
      name: values.name,
      description: values.description,
      visibility: values.visibility,
      topics: values.topic,
      access: {
        users: Object.fromEntries([
          ...values.maintainer.map((user) => [user, policy.administrator_users.includes(user.toLowerCase()) ? 'admin' : 'maintain']),
          ...values.user.map(assignment),
        ]),
        teams: Object.fromEntries(values.team.map(assignment)),
      },
      ...(values.template ? { template: { owner: values.template.split('/')[0], repository: values.template.split('/')[1] } } : {}),
      ...(values['readme-template'] ? { readme_template: values['readme-template'] } : {}),
      ...(values.license ? { license: values.license } : {}),
    };
    if (values.fork && values.mirror) throw new Error('Use either --fork or --mirror');
    if (values.mirror) Object.assign(request, { mode: 'mirror', ...(await resolveMirror(values.mirror, policy)) });
    if (values.fork) {
      const [owner, repository, extra] = values.fork.split('/');
      if (!owner || !repository || extra) throw new Error('--fork requires owner/repository');
      const source = await findRepository(github(), owner, repository);
      if (!source) throw new Error('Fork source is unavailable');
      request.mode = 'fork';
      request.default_branch = source.default_branch;
      request.fork = { owner, repository, source_repository_id: source.id, default_branch_only: values['default-branch-only'] };
    }
    await validateRequest(request, policy, `${request.name}.yaml`);
    const { catalog } = await loadCatalog();
    if (catalog[request.name]) throw new Error(`${request.name} already has a request; edit the existing file`);
    checkTransition(catalog, { ...catalog, [request.name]: request }, policy);
    process.stdout.write(requestYaml(request));
    return;
  }
  const { catalog, policy } = await loadCatalog(values.directory ? path.resolve(root, values.directory) : root);
  if (command === 'existing') {
    if (!values.name) throw new Error('existing requires --name');
    const previous = catalog[values.name];
    const request = previous ? structuredClone(previous) : await existingRequest(github(), values.name, policy);
    if ((request.mode ?? 'create') !== 'existing') throw new Error('Use the existing declaration to update a repository already managed in another mode');
    for (const assignmentValue of values.user) {
      const [identity, role] = assignment(assignmentValue);
      request.access.users[identity] = role;
    }
    for (const assignmentValue of values.team) {
      const [identity, role] = assignment(assignmentValue);
      request.access.teams[identity] = role;
    }
    for (const identity of values['remove-user']) delete request.access.users[identity];
    for (const identity of values['remove-team']) delete request.access.teams[identity];
    await validateRequest(request, policy, requestPath(request));
    if (previous) checkTransition(catalog, { ...catalog, [request.name]: request }, policy);
    process.stdout.write(requestYaml(request));
    return;
  }
  if (command === 'lifecycle') {
    const previous = catalog[values.name];
    if (!previous) throw new Error('lifecycle requires --name matching an existing declaration');
    if (!['active', 'archived', 'deleted'].includes(values.status)) throw new Error('lifecycle requires --status active, archived or deleted');
    if (repositoryStatus(previous) === 'deleted') throw new Error(`${previous.name}: a deleted declaration is immutable`);
    const client = github();
    const repository = await findRepository(client, policy.organization, previous.name);
    if (!repository || (previous.repository_id && previous.repository_id !== repository.id)) throw new Error(`${previous.name}: the existing repository ID could not be verified`);
    const request = { ...previous, status: values.status, repository_id: repository.id };
    await validateRequest(request, policy, requestPath(request));
    checkTransition(catalog, { ...catalog, [request.name]: request }, policy);
    process.stdout.write(requestYaml(request));
    return;
  }
  if (command === 'validate') {
    if (values.online) await inspectCatalog(github(), catalog, policy);
    console.log(`Validated ${Object.keys(catalog).length} repository request(s) for ${policy.organization}.`);
    return;
  }
  if (command === 'render') {
    if (!values.output) throw new Error('render requires --output');
    await writeJson(path.resolve(root, values.output), terraformValues(catalog, policy));
    console.log(`Rendered Terraform input: ${values.output}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
