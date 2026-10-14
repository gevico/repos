import { parseArgs } from 'node:util';
import { github, findRepository } from './github.mjs';
import { loadPolicy } from './config.mjs';

const { values } = parseArgs({ options: { create: { type: 'boolean' }, configure: { type: 'boolean' }, check: { type: 'boolean' } } });

try {
  const client = github();
  const policy = await loadPolicy();
  const owner = policy.organization;
  const repo = policy.management_repository;
  const { data: org } = await client.rest.orgs.get({ org: owner });
  const { data: account } = await client.rest.users.getAuthenticated();
  const { data: membership } = await client.rest.orgs.getMembershipForUser({ org: owner, username: account.login });
  if (membership.role !== 'admin' || membership.state !== 'active') throw new Error('An active organization owner is required for initial configuration');
  let repository = await findRepository(client, owner, repo);
  if (!repository && values.create) {
    repository = (await client.rest.repos.createInOrg({ org: owner, name: repo, description: 'Repository requests and access management through pull requests and GitHub Actions', visibility: 'public', auto_init: false })).data;
    console.log(`Created ${repository.html_url}`);
  }
  if (!repository) throw new Error('gevico/repos is not present; use --create to create the management repository');
  if (repository.private || repository.fork || repository.archived) throw new Error('The management repository must be public, active, and owned directly by gevico');
  if (values.configure) {
    if (repository.default_branch !== 'main') throw new Error('Push the verified implementation to main before configuring protection');
    await client.rest.repos.update({ owner, repo, allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true });
    for (const environment_name of ['preview', 'production']) {
      await client.request('PUT /repos/{owner}/{repo}/environments/{environment_name}', { owner, repo, environment_name, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
      const { data: branches } = await client.request('GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', { owner, repo, environment_name });
      if (!branches.branch_policies.some((item) => item.name === 'main')) await client.request('POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies', { owner, repo, environment_name, name: 'main', type: 'branch' });
    }
    const existing = await client.paginate(client.rest.repos.getRepoRulesets, { owner, repo });
    const ruleset = existing.find((item) => item.name === 'review-repository-requests');
    const configuration = {
      owner, repo, name: 'review-repository-requests', target: 'branch', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: true, required_review_thread_resolution: true, allowed_merge_methods: ['squash'] } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Validate', integration_id: 15368 }, { context: 'request/check' }], strict_required_status_checks_policy: true } },
      ],
    };
    if (ruleset) await client.rest.repos.updateRepoRuleset({ ...configuration, ruleset_id: ruleset.id });
    else await client.rest.repos.createRepoRuleset(configuration);
    console.log('Configured main review rules and the preview/production deployment environments.');
  }
  console.log(JSON.stringify({ repository: repository.html_url, organization_plan: org.plan?.name, organization_default_permission: org.default_repository_permission, administrator: account.login }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
