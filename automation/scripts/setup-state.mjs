import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { generateX25519Identity, identityToRecipient } from 'age-encryption';
import { github, findRepository } from './github.mjs';
import { work, loadPolicy } from './config.mjs';
import { run } from './runtime.mjs';

async function setSecret(environment, identity) {
  await new Promise((resolve, reject) => {
    const child = execFile('gh', ['secret', 'set', 'STATE_AGE_KEY', '--repo', 'gevico/repos', '--env', environment], (error) => error ? reject(new Error('Unable to save STATE_AGE_KEY with gh')) : resolve());
    child.stdin.end(identity);
  });
}

async function setup() {
  const client = github();
  const policy = await loadPolicy();
  const { data: user } = await client.rest.users.getAuthenticated();
  const { data: membership } = await client.rest.orgs.getMembershipForUser({ org: policy.organization, username: user.login });
  if (membership.role !== 'admin' || membership.state !== 'active') throw new Error('An active organization owner is required');
  const name = (await run('git', ['config', 'user.name'])).trim();
  const email = (await run('git', ['config', 'user.email'])).trim();
  let repository = await findRepository(client, 'gevico', 'repos-state');
  if (!repository) repository = (await client.rest.repos.createInOrg({ org: 'gevico', name: 'repos-state', description: 'Encrypted Terraform state and approved repository automation records', private: true, auto_init: false })).data;
  if (!repository.private || repository.archived || repository.fork) throw new Error('repos-state must be a private active organization repository');
  try { await client.rest.repos.getBranch({ owner: 'gevico', repo: 'repos-state', branch: 'main' }); }
  catch (error) {
    if (error.status !== 404) throw error;
    await client.rest.repos.createOrUpdateFileContents({ owner: 'gevico', repo: 'repos-state', path: 'README.md', branch: 'main', message: `Initialize repository automation state\n\nSigned-off-by: ${name} <${email}>`, author: { name, email }, content: Buffer.from('# Repository automation state\n\nPrivate storage for SOPS/age-encrypted Terraform state and age-encrypted approval and execution records. Managed by gevico/repos GitHub Actions.\n').toString('base64') });
    await client.rest.repos.update({ owner: 'gevico', repo: 'repos-state', default_branch: 'main' });
  }
  await fs.mkdir(work, { recursive: true });
  const filename = path.join(work, 'state-age-key.txt');
  let identity;
  try { identity = (await fs.readFile(filename, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const variables = await client.paginate(client.rest.actions.listRepoVariables, { owner: 'gevico', repo: 'repos' });
    if (variables.some((item) => item.name === 'STATE_AGE_RECIPIENT')) throw new Error('Restore the existing age identity to .work/state-age-key.txt before updating state secrets');
    identity = await generateX25519Identity();
    await fs.writeFile(filename, `${identity}\n`, { mode: 0o600 });
  }
  const recipient = await identityToRecipient(identity);
  const variables = await client.paginate(client.rest.actions.listRepoVariables, { owner: 'gevico', repo: 'repos' });
  const previous = variables.find((item) => item.name === 'STATE_AGE_RECIPIENT');
  if (previous && previous.value !== recipient) throw new Error('Existing state encryption recipient differs; restore the matching identity');
  for (const environment of ['preview', 'production']) await setSecret(environment, identity);
  for (const [key, value] of Object.entries({ STATE_AGE_RECIPIENT: recipient, STATE_GIT_NAME: name, STATE_GIT_EMAIL: email })) {
    if (variables.some((item) => item.name === key)) await client.rest.actions.updateRepoVariable({ owner: 'gevico', repo: 'repos', name: key, value });
    else await client.rest.actions.createRepoVariable({ owner: 'gevico', repo: 'repos', name: key, value });
  }
  console.log('Configured private gevico/repos-state, environment age secrets and state variables');
  console.log(`Keep a secure backup of ${filename}`);
}
setup().catch((error) => { console.error(error.message); process.exitCode = 1; });
