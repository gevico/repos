import { effectiveAccess, stableJson } from './config.mjs';

const fields = {
  github_repository: ['name', 'description', 'visibility', 'topics'],
  github_branch_default: ['repository', 'branch'],
  github_repository_collaborators: ['repository', 'user', 'team'],
  github_repository_ruleset: ['repository', 'name', 'enforcement', 'target', 'conditions', 'rules', 'bypass_actors'],
};

function projection(type, value) {
  if (value === null || value === undefined) return null;
  const result = Object.fromEntries(fields[type].map((field) => [field, value[field] ?? null]));
  if (type === 'github_repository_collaborators') {
    result.user = Object.fromEntries((value.user ?? []).map((item) => [item.username.toLowerCase(), item.permission]));
    result.team = Object.fromEntries((value.team ?? []).map((item) => [item.team_id, item.permission]));
  }
  if (type === 'github_repository' && result.topics) result.topics.sort();
  if (type === 'github_repository_ruleset') {
    const rules = value.rules?.[0];
    const review = rules?.pull_request?.[0];
    return {
      repository: value.repository,
      name: value.name,
      enforcement: value.enforcement,
      target: value.target,
      include: value.conditions?.[0]?.ref_name?.[0]?.include ?? [],
      exclude: value.conditions?.[0]?.ref_name?.[0]?.exclude ?? [],
      deletion: rules?.deletion ?? false,
      non_fast_forward: rules?.non_fast_forward ?? false,
      review_count: review?.required_approving_review_count ?? 0,
      dismiss_stale_reviews: review?.dismiss_stale_reviews_on_push ?? false,
      require_last_push_approval: review?.require_last_push_approval ?? false,
    };
  }
  return result;
}

function consistentPartial(current, before, after) {
  if (stableJson(current) === stableJson(before) || stableJson(current) === stableJson(after)) return true;
  if (!current || Array.isArray(current) || typeof current !== 'object') return false;
  if (!before || typeof before !== 'object') before = {};
  if (!after || typeof after !== 'object') after = {};
  return [...new Set([...Object.keys(current), ...Object.keys(before), ...Object.keys(after)])]
    .every((key) => consistentPartial(current[key] ?? null, before[key] ?? null, after[key] ?? null));
}

export function authorizePlan(plan, catalog, policy, allowedNames, approval = null) {
  const intents = [];
  for (const resource of plan.resource_changes ?? []) {
    const actions = resource.change.actions;
    if (actions.every((action) => ['no-op', 'read'].includes(action))) continue;
    if (!fields[resource.type] || resource.name !== 'managed' || typeof resource.index !== 'string') throw new Error(`Unexpected Terraform resource: ${resource.address}`);
    if (actions.includes('delete')) throw new Error(`Repository deletion or resource replacement is prohibited: ${resource.address}`);
    const name = resource.index;
    if (!allowedNames.includes(name) || !catalog[name]) throw new Error(`Unapproved change outside this request: ${name}`);
    const before = projection(resource.type, resource.change.before);
    const after = projection(resource.type, resource.change.after);
    if (!after) throw new Error(`Missing desired state: ${resource.address}`);
    const request = catalog[name];
    if (resource.type === 'github_repository') {
      for (const key of ['description', 'visibility']) if (after[key] !== request[key]) throw new Error(`Unexpected ${key} for ${name}`);
      if (after.name !== name || stableJson(after.topics ?? []) !== stableJson([...(request.topics ?? [])].sort())) throw new Error(`Unexpected repository attributes for ${name}`);
    }
    if (resource.type === 'github_branch_default' && (after.repository !== name || after.branch !== 'main')) throw new Error(`Unexpected default branch for ${name}`);
    if (resource.type === 'github_repository_collaborators') {
      const expected = effectiveAccess(request, policy);
      if (after.repository !== name || stableJson(after.user) !== stableJson(expected.users) || stableJson(after.team) !== stableJson(expected.teams)) throw new Error(`Unexpected permission changes for ${name}`);
    }
    if (resource.type === 'github_repository_ruleset' && (after.repository !== name || after.name !== 'review-default-branch' || after.enforcement !== 'active' || after.target !== 'branch' || stableJson(after.include) !== stableJson(['~DEFAULT_BRANCH']) || after.exclude.length || !after.deletion || !after.non_fast_forward || after.review_count !== (policy.require_pull_request_reviews ? 1 : 0) || (policy.require_pull_request_reviews && (!after.dismiss_stale_reviews || !after.require_last_push_approval)))) throw new Error(`Unexpected ruleset for ${name}`);
    const intent = { address: resource.address, type: resource.type, name, actions, before, after };
    if (approval) {
      const reviewed = approval.find((item) => item.address === intent.address);
      if (!reviewed || stableJson(reviewed.after) !== stableJson(after) || !consistentPartial(before, reviewed.before, reviewed.after)) throw new Error(`Live changes differ from the reviewed plan: ${name}; refresh the PR preview`);
    }
    intents.push(intent);
  }
  return intents;
}

export function describeIntents(intents) {
  if (!intents.length) return 'The approved configuration already matches GitHub.';
  return intents.map((item) => `- ${item.actions.join('/')} \`${item.name}\`: ${item.type.replace('github_', '')}`).join('\n');
}
