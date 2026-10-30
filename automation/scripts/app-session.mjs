import { setSecret } from '@actions/core';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { github } from './github.mjs';

export class AppSession {
  static async open(clientId = process.env.APP_CLIENT_ID, privateKey = process.env.APP_PRIVATE_KEY) {
    if (!clientId || !privateKey) throw new Error('APP_CLIENT_ID and APP_PRIVATE_KEY must be configured');
    if (process.env.GITHUB_ACTIONS) setSecret(privateKey);
    const app = new Octokit({ authStrategy: createAppAuth, auth: { appId: clientId, privateKey } });
    const { data: installation } = await app.rest.apps.getOrgInstallation({ org: 'gevico' });
    if (installation.account.login !== 'gevico' || installation.suspended_at || installation.repository_selection !== 'all') throw new Error('An active App installation covering all gevico repositories is required');
    const session = new AppSession();
    Object.assign(session, { app, installation, clients: [] });
    return session;
  }

  async token(mode = 'read', repositoryIds = null, { workflows = false } = {}) {
    if (!['read', 'write'].includes(mode) || (workflows && mode !== 'write')) throw new Error('Invalid App permission mode');
    if (mode === 'write' && this.installation.permissions.administration !== 'write') throw new Error('The App is not authorized to write repository administration');
    if (workflows && this.installation.permissions.workflows !== 'write') throw new Error('Mirror copies require the write App Workflows: write permission');
    const ids = repositoryIds === null ? null : [...new Set(repositoryIds)].sort((a, b) => a - b);
    if (ids && (!ids.length || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0))) throw new Error('Scoped installation tokens require 1 to 500 valid repository IDs');
    const permissions = { administration: mode, contents: mode, members: 'read', metadata: 'read', ...(workflows ? { workflows: 'write' } : {}) };
    const { data } = await this.app.rest.apps.createInstallationAccessToken({ installation_id: this.installation.id, permissions, ...(ids ? { repository_ids: ids } : {}) });
    if (process.env.GITHUB_ACTIONS) setSecret(data.token);
    const client = github(data.token);
    this.clients.push(client);
    for (const [permission, level] of Object.entries(permissions)) if (data.permissions[permission] !== level) throw new Error(`Unexpected App token permission: ${permission}`);
    if (ids) {
      const granted = (data.repositories ?? []).map((repository) => repository.id).sort((a, b) => a - b);
      if (data.repository_selection !== 'selected' || JSON.stringify(granted) !== JSON.stringify(ids)) throw new Error('App token repository scope differs from the authorized IDs');
    } else if (data.repository_selection !== 'all') throw new Error('A full installation read scope is required');
    return { client, token: data.token };
  }

  async close() {
    const results = await Promise.allSettled(this.clients.map((client) => client.rest.apps.revokeInstallationAccessToken()));
    for (const result of results) if (result.status === 'rejected' && ![401, 404].includes(result.reason.status)) console.error(`App token revocation failed: ${result.reason.message}`);
  }
}
