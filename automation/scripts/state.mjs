import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { root, work, digest } from './config.mjs';
import { run } from './runtime.mjs';
import { github } from './github.mjs';
import { encryptReview, decryptReview } from './reviews.mjs';

export class StateStore {
  static async open(state = 'gevico/repos/terraform.tfstate') {
    const token = process.env.GH_TOKEN;
    const identity = process.env.STATE_AGE_KEY;
    const recipient = process.env.STATE_AGE_RECIPIENT;
    if (!token || !identity || !recipient) throw new Error('GH_TOKEN, STATE_AGE_KEY and STATE_AGE_RECIPIENT must be configured');
    if (process.env.STATE_GIT_NAME) await run('git', ['config', 'user.name', process.env.STATE_GIT_NAME]);
    if (process.env.STATE_GIT_EMAIL) await run('git', ['config', 'user.email', process.env.STATE_GIT_EMAIL]);
    await run('git', ['config', 'user.name']);
    await run('git', ['config', 'user.email']);
    await fs.mkdir(path.join(work, 'backend'), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(work, 'backend/session-'));
    const keyFile = path.join(temporary, 'age-key.txt');
    await fs.writeFile(keyFile, `${identity.trim()}\n`, { mode: 0o600 });
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.search = new URLSearchParams({ type: 'git', repository: 'https://github.com/gevico/repos-state.git', ref: 'main', state }).toString();
    const password = randomBytes(32).toString('hex');
    const env = {
      ...process.env, TMPDIR: temporary, GIT_USERNAME: 'x-access-token', GIT_PASSWORD: token,
      TF_BACKEND_GIT_HTTP_USERNAME: 'terraform', TF_BACKEND_GIT_HTTP_PASSWORD: password,
      TF_BACKEND_HTTP_ENCRYPTION_PROVIDER: 'sops', TF_BACKEND_HTTP_SOPS_AGE_RECIPIENTS: recipient,
      SOPS_AGE_KEY_FILE: keyFile,
      TF_HTTP_ADDRESS: url.href, TF_HTTP_LOCK_ADDRESS: url.href, TF_HTTP_UNLOCK_ADDRESS: url.href,
      TF_HTTP_USERNAME: 'terraform', TF_HTTP_PASSWORD: password,
    };
    const child = spawn(path.join(work, 'bin/terraform-backend-git'), ['--address', `127.0.0.1:${port}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const store = new StateStore();
    Object.assign(store, { child, env, url, temporary, client: github(token), headers: { Authorization: `Basic ${Buffer.from(`terraform:${password}`).toString('base64')}` } });
    let failure;
    child.on('error', (error) => { failure = error; });
    child.once('close', () => { store.exited = true; });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => { store.log = `${store.log ?? ''}${data}`.slice(-6000); });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (failure || child.exitCode !== null) throw failure ?? new Error(store.log || 'Git state backend terminated');
        try {
          await store.terraformState();
          return store;
        } catch (error) {
          if (error.cause?.code !== 'ECONNREFUSED') throw error;
          await delay(100);
        }
      }
      throw new Error('Git state backend did not start');
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async terraformState() {
    const response = await fetch(this.url, { headers: this.headers, signal: AbortSignal.timeout(60_000) });
    if (response.status !== 200 && response.status !== 204) throw new Error(`Git state read failed (${response.status}): ${this.log ?? ''}`);
    const data = response.status === 204 ? null : await response.json();
    const names = new Set();
    for (const resource of data?.resources ?? []) {
      if (resource.type === 'github_repository') for (const instance of resource.instances ?? []) names.add(instance.index_key);
    }
    return { names, version: data ? digest(data) : null, serial: data?.serial ?? 0, lineage: data?.lineage ?? null };
  }

  async close() {
    if (!this.exited && this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise((resolve) => { this.child.once('close', resolve); this.child.kill('SIGTERM'); });
    }
    await fs.rm(this.temporary, { recursive: true, force: true });
  }

  async get(key, optional = false) {
    try {
      const { data } = await this.client.rest.repos.getContent({ owner: 'gevico', repo: 'repos-state', path: `records/${key}.age`, ref: 'main' });
      if (data.type !== 'file') throw new Error('Git state record must be an ordinary file');
      const { data: blob } = await this.client.rest.git.getBlob({ owner: 'gevico', repo: 'repos-state', file_sha: data.sha });
      if (blob.encoding !== 'base64') throw new Error('Git record blob must use base64 encoding');
      return { data: await decryptReview(Buffer.from(blob.content, 'base64')), version: data.sha };
    } catch (error) {
      if (optional && error.status === 404) return null;
      throw error;
    }
  }

  async put(key, data) {
    const existing = await this.get(key, true);
    const name = (await run('git', ['config', 'user.name'])).trim();
    const email = (await run('git', ['config', 'user.email'])).trim();
    await this.client.rest.repos.createOrUpdateFileContents({ owner: 'gevico', repo: 'repos-state', path: `records/${key}.age`, branch: 'main', message: `Record ${key}\n\nSigned-off-by: ${name} <${email}>`, author: { name, email }, ...(existing ? { sha: existing.version } : {}), content: Buffer.from(await encryptReview(data)).toString('base64') });
  }
}
