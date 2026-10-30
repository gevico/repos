import { setTimeout as delay } from 'node:timers/promises';
import { findRepository } from './github.mjs';
import { effectiveAccess, repositoryMode, repositoryStatus } from './config.mjs';
import { forkUserClient } from './credentials.mjs';

export async function existingRequest(client, name, policy) {
  const repository = await findRepository(client, policy.organization, name);
  if (!repository || repository.archived) throw new Error(`${name}: an active existing repository is required`);
  const users = await client.paginate(client.rest.repos.listCollaborators, { owner: policy.organization, repo: repository.name, affiliation: 'direct' });
  const teams = await client.paginate(client.rest.repos.listTeams, { owner: policy.organization, repo: repository.name });
  const invitations = await client.paginate(client.rest.repos.listInvitations, { owner: policy.organization, repo: repository.name });
  const role = (value) => ({ read: 'pull', write: 'push' }[value] ?? value);
  const request = { name: repository.name, mode: 'existing', repository_id: repository.id, description: repository.description ?? '', visibility: repository.visibility,
    default_branch: repository.default_branch, topics: repository.topics ?? [], access: {
      users: Object.fromEntries([...users.map((user) => [user.login, role(user.role_name)]), ...invitations.map((invitation) => [invitation.invitee.login, role(invitation.permissions)])]),
      teams: Object.fromEntries(teams.map((team) => [team.slug, role(team.permission)])),
    } };
  request.access = effectiveAccess(request, policy);
  return request;
}

export async function importTargets(client, catalog, state) {
  const imports = { repository: {}, existing: {}, collaborators: {}, branch: {} };
  for (const request of Object.values(catalog)) {
    if (repositoryStatus(request) === 'deleted') continue;
    const mode = repositoryMode(request);
    if (!['existing', 'fork', 'mirror'].includes(mode)) continue;
    const repository = await findRepository(client, 'gevico', request.name);
    if (!repository) {
      if (mode === 'existing') throw new Error(`${request.name}: existing repository is unavailable`);
      continue;
    }
    const name = request.name;
    const resourceName = mode === 'existing' ? 'existing' : 'managed';
    if (!state.addresses.has(`github_repository.${resourceName}[${JSON.stringify(name)}]`)) imports[mode === 'existing' ? 'existing' : 'repository'][name] = name;
    if (!state.addresses.has(`github_repository_collaborators.managed[${JSON.stringify(name)}]`)) imports.collaborators[name] = name;
    if (mode !== 'existing' && !state.addresses.has(`github_branch_default.managed[${JSON.stringify(name)}]`)) imports.branch[name] = name;
  }
  return imports;
}

export async function verifyForkSource(client, request) {
  const source = await findRepository(client, request.fork.owner, request.fork.repository);
  if (!source || source.id !== request.fork.source_repository_id || source.visibility !== request.visibility) throw new Error(`${request.name}: Fork source ID or visibility differs from the approved request`);
  if (source.private) throw new Error(`${request.name}: gevico on GitHub Free only supports public Fork requests`);
  return source;
}

export async function initializeForks(reader, writer, catalog, changed, store, approvalKey) {
  const created = {};
  for (const name of changed) {
    const request = catalog[name];
    if (repositoryMode(request) !== 'fork' || repositoryStatus(request) !== 'active') continue;
    const source = await verifyForkSource(reader, request);
    const key = `forks/${approvalKey}/${name}.json`;
    const recorded = await store.get(key, true);
    let repository = await findRepository(reader, 'gevico', name);
    if (repository && !recorded && !(await store.terraformState()).names.has(name)) throw new Error(`${name}: an existing Fork is not registered to this approved request`);
    if (recorded && repository && recorded.data.id !== repository.id) throw new Error(`${name}: Fork initialization record has a different repository ID`);
    if (!repository) {
      if (recorded?.data.id) throw new Error(`${name}: the initialized Fork is missing; automatic recreation is prohibited`);
      const client = request.fork.owner.toLowerCase() === 'gevico' ? writer : await forkUserClient();
      await store.put(key, { name, source_id: source.id, phase: 'requested', requested_at: new Date().toISOString() });
      const { data } = await client.rest.repos.createFork({ owner: request.fork.owner, repo: request.fork.repository, organization: 'gevico', name, default_branch_only: request.fork.default_branch_only ?? false });
      if (!data.fork || data.full_name.toLowerCase() !== `gevico/${name}`.toLowerCase()) throw new Error(`${name}: Fork API returned an unexpected target`);
      await store.put(key, { name, source_id: source.id, id: data.id, phase: 'created', created_at: new Date().toISOString() });
      for (let attempt = 0; attempt < 60; attempt++) {
        repository = await findRepository(reader, 'gevico', name);
        if (repository?.id === data.id) {
          try { await reader.rest.repos.getBranch({ owner: 'gevico', repo: name, branch: repository.default_branch }); break; }
          catch (error) { if (![404, 409].includes(error.status)) throw error; }
        }
        if (attempt === 59) throw new Error(`${name}: Fork initialization did not finish; rerun this approved Apply`);
        await delay(2000);
      }
    }
    if (!repository.fork || (repository.source?.id ?? repository.parent?.id) !== (source.source?.id ?? source.id)) throw new Error(`${name}: repository is not a Fork of the approved source network`);
    created[name] = repository.id;
  }
  return created;
}
