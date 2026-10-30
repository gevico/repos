import fs from 'node:fs/promises';
import path from 'node:path';
import { setSecret } from '@actions/core';
import { work, mirrorSource, repositoryMode, repositoryStatus, stableJson } from './config.mjs';
import { run } from './runtime.mjs';
import { github, findRepository } from './github.mjs';

const pushLimit = 2 * 1024 * 1024;
const batch = 500;

// Source URLs are request data: git runs without user configuration, redirects, prompts or non-HTTPS transports.
function environment(token = null) {
  const config = [['http.followRedirects', 'false']];
  if (token) {
    const credential = Buffer.from(`x-access-token:${token}`).toString('base64');
    if (process.env.GITHUB_ACTIONS) setSecret(credential);
    config.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${credential}`]);
  }
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LC_ALL: 'C',
    GIT_ALLOW_PROTOCOL: 'https', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
  };
}

function git(args, token = null) {
  return run('git', args, { cwd: '/', env: environment(token) });
}

export function parseRefs(text) {
  let head = null;
  const refs = {};
  for (const line of text.split('\n').filter(Boolean)) {
    const [value, name] = line.split('\t');
    if (name === 'HEAD' && value.startsWith('ref: refs/heads/')) head = value.slice('ref: refs/heads/'.length);
    else if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) && /^refs\/(?:heads|tags)\//.test(name) && !name.endsWith('^{}')) refs[name] = value;
  }
  return { head, refs };
}

export async function listRefs(url, token = null) {
  return parseRefs(await git(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'], token));
}

async function githubSource(client, source, label) {
  const repository = await findRepository(client, source.owner, source.repository);
  if (!repository || repository.visibility !== 'public' || repository.full_name.toLowerCase() !== `${source.owner}/${source.repository}`.toLowerCase()) throw new Error(`${label}: the GitHub mirror source must be a public repository at its current name`);
  if (repository.size > pushLimit) throw new Error(`${label}: the mirror source exceeds the GitHub 2 GiB push limit`);
  return repository;
}

export async function resolveMirror(url, policy) {
  const source = mirrorSource(url, policy, '--mirror');
  const mirror = { url };
  if (source.host === 'github.com') mirror.source_repository_id = (await githubSource(github(), source, '--mirror')).id;
  const { head, refs } = await listRefs(url);
  if (!head || !refs[`refs/heads/${head}`]) throw new Error('--mirror: the source does not advertise its default branch');
  return { default_branch: head, mirror };
}

export async function mirrorSnapshot(client, request, policy) {
  const source = mirrorSource(request.mirror.url, policy, request.name);
  if (source.host === 'github.com' && (await githubSource(client, source, request.name)).id !== request.mirror.source_repository_id) throw new Error(`${request.name}: mirror source ID differs from the approved request`);
  const { head, refs } = await listRefs(request.mirror.url);
  if (head !== request.default_branch || !refs[`refs/heads/${head}`]) throw new Error(`${request.name}: the source default branch differs from ${request.default_branch}`);
  return { url: request.mirror.url, default_branch: head, refs };
}

export function describeMirrors(snapshots) {
  return Object.entries(snapshots).map(([name, { url, default_branch, refs }]) => {
    const count = (prefix) => Object.keys(refs).filter((ref) => ref.startsWith(prefix)).length;
    return `- COPY \`${url}\` to \`${name}\`: ${count('refs/heads/')} branch(es), ${count('refs/tags/')} tag(s); default branch \`${default_branch}\` at \`${refs[`refs/heads/${default_branch}`]}\``;
  }).join('\n');
}

// The default branch is pushed alone first so the empty repository adopts it.
export function refspecs({ refs, default_branch }) {
  const primary = `refs/heads/${default_branch}`;
  const rest = Object.keys(refs).filter((name) => name !== primary).sort();
  const groups = [[`${refs[primary]}:${primary}`]];
  for (let index = 0; index < rest.length; index += batch) groups.push(rest.slice(index, index + batch).map((name) => `${refs[name]}:${name}`));
  return groups;
}

export async function fetchSnapshot(directory, snapshot, label) {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await git(['init', '--bare', '--quiet', '--template=', directory]);
  await git(['--git-dir', directory, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', snapshot.url, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
  const fetched = Object.fromEntries((await git(['--git-dir', directory, 'for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').filter(Boolean).map((line) => line.split(' ')));
  for (const [ref, sha] of Object.entries(snapshot.refs)) {
    if (fetched[ref] === sha) continue;
    try { await git(['--git-dir', directory, 'cat-file', '-e', sha]); }
    catch { throw new Error(`${label}: the source no longer contains the reviewed ${ref} at ${sha}; nothing was pushed`); }
  }
}

async function copy(name, snapshot, token) {
  const directory = path.join(work, 'mirror', name);
  try {
    await fetchSnapshot(directory, snapshot, name);
    for (const group of refspecs(snapshot)) await git(['--git-dir', directory, 'push', '--quiet', '--no-verify', `https://github.com/gevico/${name}.git`, ...group], token);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function initializeMirrors(reader, writer, token, catalog, changed, snapshots, store, approvalKey) {
  const initialized = {};
  const state = await store.terraformState();
  for (const name of changed) {
    const request = catalog[name];
    if (repositoryMode(request) !== 'mirror' || repositoryStatus(request) !== 'active' || state.names.has(name)) continue;
    const snapshot = snapshots[name];
    if (snapshot?.url !== request.mirror.url || snapshot.default_branch !== request.default_branch || !snapshot.refs[`refs/heads/${snapshot.default_branch}`]) throw new Error(`${name}: the approved review has no matching mirror source snapshot`);
    const key = `mirrors/${approvalKey}/${name}.json`;
    const recorded = (await store.get(key, true))?.data;
    let phase = recorded?.phase;
    let repository = await findRepository(reader, 'gevico', name);
    if (repository && !recorded?.id) throw new Error(`${name}: an existing repository is not registered to this approved mirror request`);
    if (repository && recorded.id !== repository.id) throw new Error(`${name}: mirror initialization record has a different repository ID`);
    if (!repository) {
      if (recorded?.id) throw new Error(`${name}: the initialized mirror is missing; automatic recreation is prohibited`);
      await store.put(key, { name, url: snapshot.url, phase: 'requested', requested_at: new Date().toISOString() });
      const { data } = await writer.rest.repos.createInOrg({ org: 'gevico', name, description: request.description, visibility: request.visibility, auto_init: false });
      if (data.fork || data.full_name.toLowerCase() !== `gevico/${name}`.toLowerCase()) throw new Error(`${name}: repository creation returned an unexpected target`);
      await store.put(key, { name, url: snapshot.url, id: data.id, phase: 'created', created_at: new Date().toISOString() });
      repository = data;
      phase = 'created';
    }
    if (phase !== 'copied') {
      await writer.rest.actions.setGithubActionsPermissionsRepository({ owner: 'gevico', repo: name, enabled: false });
      await copy(name, snapshot, token);
      await writer.rest.repos.update({ owner: 'gevico', repo: name, default_branch: snapshot.default_branch });
      await store.put(key, { name, url: snapshot.url, id: repository.id, phase: 'copied', copied_at: new Date().toISOString() });
    }
    initialized[name] = repository.id;
  }
  return initialized;
}

export async function verifyMirrorCopy(client, token, name, snapshot) {
  const { refs } = await listRefs(`https://github.com/gevico/${name}.git`, token);
  if (stableJson(refs) !== stableJson(snapshot.refs)) throw new Error(`${name}: copied branches and tags differ from the reviewed source snapshot`);
  const { data } = await client.rest.actions.getGithubActionsPermissionsRepository({ owner: 'gevico', repo: name });
  if (data.enabled !== false) throw new Error(`${name}: GitHub Actions must be disabled after mirror initialization`);
}
