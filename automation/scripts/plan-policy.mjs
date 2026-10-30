import { effectiveAccess, stableJson, repositoryStatus, repositoryMode, defaultBranch, renderReadme, repositoryRules } from './config.mjs';

const fields = {
  github_repository: ['name', 'description', 'visibility', 'topics', 'archived', 'archive_on_destroy', 'repo_id'],
  github_branch_default: ['repository', 'branch'],
  github_repository_collaborators: ['repository', 'user', 'team'],
  github_repository_ruleset: ['repository', 'name', 'enforcement', 'target', 'conditions', 'rules', 'bypass_actors'],
  github_repository_file: ['repository', 'branch', 'file', 'content', 'repository_id'],
};

function projection(type, value) {
  if (value === null || value === undefined) return null;
  const result = Object.fromEntries(fields[type].map((field) => [field, value[field] ?? null]));
  if (type === 'github_repository_collaborators') {
    result.user = Object.fromEntries((value.user ?? []).map((item) => [item.username.toLowerCase(), item.permission]));
    result.team = Object.fromEntries((value.team ?? []).map((item) => [item.team_id, item.permission]));
  }
  if (type === 'github_repository') {
    result.topics = [...(result.topics ?? [])].sort();
    result.archive_on_destroy = value.archive_on_destroy ?? false;
  }
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
      bypass_actors: (value.bypass_actors ?? []).map((item) => ({ actor_id: item.actor_id, actor_type: item.actor_type, bypass_mode: item.bypass_mode })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
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

export function authorizePlan(plan, catalog, policy, allowedNames, approval = null, { allowMigration = false, lifecycle = false, initializedIds = {} } = {}) {
  const intents = [];
  for (const resource of plan.resource_changes ?? []) {
    const actions = resource.change.actions;
    const importing = resource.change.importing?.id;
    if (actions.every((action) => ['no-op', 'read'].includes(action)) && !importing) continue;
    if (!fields[resource.type] || typeof resource.index !== 'string') throw new Error(`Unexpected Terraform resource: ${resource.address}`);
    if (actions.length !== 1 || !['create', 'update', 'delete', ...(importing ? ['no-op'] : [])].includes(actions[0])) throw new Error(`Resource replacement or unexpected action is prohibited: ${resource.address}`);
    const name = resource.index;
    if (!catalog[name]) throw new Error(`Unapproved change outside this request: ${name}`);
    const request = catalog[name];
    const expectedResource = resource.type === 'github_repository_file' ? 'readme' : resource.type === 'github_repository' && repositoryMode(request) === 'existing' ? 'existing' : 'managed';
    if (resource.name !== expectedResource) throw new Error(`Unexpected Terraform resource: ${resource.address}`);
    if (importing && (!['existing', 'fork', 'mirror'].includes(repositoryMode(request)) || importing !== name || resource.type === 'github_repository_file')) throw new Error(`Unexpected import target: ${resource.address}`);
    const rawBefore = resource.change.before;
    const rawAfter = resource.change.after;
    const migration = allowMigration && resource.type === 'github_repository' && actions[0] === 'update' && rawBefore.archive_on_destroy === true && (rawAfter.archive_on_destroy ?? false) === false &&
      stableJson({ ...rawBefore, archive_on_destroy: rawAfter.archive_on_destroy }) === stableJson(rawAfter);
    if (!migration && !allowedNames.includes(name)) throw new Error(`Unapproved change outside this request: ${name}`);
    const before = projection(resource.type, resource.change.before);
    const after = projection(resource.type, resource.change.after);
    if (actions[0] === 'delete') {
      if (repositoryStatus(request) !== 'deleted' || !request.repository_id || !before || after) throw new Error(`Deletion requires an explicit deleted declaration: ${name}`);
      if (resource.type === 'github_repository') {
        if (before.name !== name || before.repo_id !== request.repository_id || before.archive_on_destroy !== false) throw new Error(`Deletion target or saved deletion policy differs: ${name}`);
      } else if (before.repository !== name || (resource.type === 'github_repository_file' && (before.file !== 'README.md' || before.repository_id !== request.repository_id))) throw new Error(`Deletion of an unrelated resource is prohibited: ${name}`);
    } else {
      if (!after || repositoryStatus(request) === 'deleted') throw new Error(`Missing desired active or archived state: ${resource.address}`);
      if (resource.type === 'github_repository' && actions[0] === 'update') {
        const allowed = new Set(['description', 'visibility', 'topics', 'archived', 'archive_on_destroy']);
        for (const key of new Set([...Object.keys(rawBefore), ...Object.keys(rawAfter)])) {
          if (!allowed.has(key) && stableJson(rawBefore[key] ?? null) !== stableJson(rawAfter[key] ?? null)) throw new Error(`Unapproved repository attribute ${key}: ${name}`);
        }
      }
      if (lifecycle && !migration && (resource.type !== 'github_repository' || actions[0] !== 'update' || stableJson({ ...rawBefore, archived: rawAfter.archived }) !== stableJson(rawAfter))) throw new Error(`Lifecycle requests can only change the repository archive flag: ${name}`);
      if (repositoryStatus(request) === 'archived' && !migration && (resource.type !== 'github_repository' || actions[0] !== 'update' || stableJson({ ...rawBefore, archived: true }) !== stableJson(rawAfter))) throw new Error(`Archived repository configuration must remain unchanged: ${name}`);
    if (resource.type === 'github_repository') {
      if (repositoryMode(request) !== 'existing') {
        for (const key of ['description', 'visibility']) if (after[key] !== request[key]) throw new Error(`Unexpected ${key} for ${name}`);
        if (stableJson(after.topics ?? []) !== stableJson([...(request.topics ?? [])].sort())) throw new Error(`Unexpected repository topics for ${name}`);
      }
      if (after.name !== name) throw new Error(`Unexpected repository name for ${name}`);
      if (after.archived !== (repositoryStatus(request) === 'archived') || after.archive_on_destroy !== false || (request.repository_id && after.repo_id !== request.repository_id)) throw new Error(`Unexpected repository lifecycle attributes for ${name}`);
    }
    if (resource.type === 'github_branch_default' && (after.repository !== name || after.branch !== defaultBranch(request, policy))) throw new Error(`Unexpected default branch for ${name}`);
    if (resource.type === 'github_repository_file' && (actions[0] !== 'create' || after.repository !== name || after.branch !== defaultBranch(request, policy) || after.file !== 'README.md' || after.content !== renderReadme(request))) throw new Error(`Unexpected README initialization for ${name}`);
    if (resource.type === 'github_repository_collaborators') {
      const expected = effectiveAccess(request, policy);
      if (after.repository !== name || stableJson(after.user) !== stableJson(expected.users) || stableJson(after.team) !== stableJson(expected.teams)) throw new Error(`Unexpected permission changes for ${name}`);
    }
    if (resource.type === 'github_repository_ruleset') {
      const expected = repositoryRules(request);
      const expectedBypass = expected.admin_bypass === 'none' ? [] : [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: expected.admin_bypass }];
      if (after.repository !== name || after.name !== 'review-default-branch' || after.enforcement !== 'active' || after.target !== 'branch' || stableJson(after.include) !== stableJson(['~DEFAULT_BRANCH']) || after.exclude.length || !after.deletion || !after.non_fast_forward || after.review_count !== (policy.require_pull_request_reviews ? 1 : 0) || (policy.require_pull_request_reviews && (!after.dismiss_stale_reviews || !after.require_last_push_approval)) || stableJson(after.bypass_actors) !== stableJson(expectedBypass)) throw new Error(`Unexpected ruleset for ${name}`);
    }
    }
    const intent = { address: resource.address, type: resource.type, name, actions, before, after, ...(importing ? { importing } : {}) };
    if (approval && !migration) {
      const reviewed = approval.find((item) => item.address === intent.address);
      const initialized = ['fork', 'mirror'].includes(repositoryMode(request)) && initializedIds[name] && reviewed?.actions[0] === 'create' && (resource.type !== 'github_repository' || after.repo_id === initializedIds[name]);
      const comparable = initialized && resource.type === 'github_repository' ? { ...after, repo_id: reviewed.after.repo_id } : after;
      const reviewedAfter = reviewed?.after && resource.type === 'github_repository' ? { ...reviewed.after, topics: [...(reviewed.after.topics ?? [])].sort() } : reviewed?.after;
      if (!reviewed || (!initialized && stableJson(reviewed.actions) !== stableJson(actions)) || stableJson(reviewedAfter) !== stableJson(comparable) || (!initialized && (!consistentPartial(before, reviewed.before, reviewedAfter) || (importing && reviewed.importing !== importing)))) throw new Error(`Live changes differ from the reviewed plan: ${name}; refresh the PR preview`);
    }
    intents.push(intent);
  }
  return intents;
}

export function describeIntents(intents) {
  if (!intents.length) return 'The approved configuration already matches GitHub.';
  return intents.map((item) => {
    const operation = item.type === 'github_repository' && item.actions[0] === 'delete' ? 'PERMANENTLY DELETE' : item.type === 'github_repository' && item.before?.archived !== item.after?.archived && item.actions[0] === 'update' ? (item.after.archived ? 'ARCHIVE' : 'RESTORE') : item.actions.join('/');
    return `- ${operation} \`${item.name}\`: ${item.type.replace('github_', '')}${item.before?.repo_id ? ` (repository ID: ${item.before.repo_id})` : ''}`;
  }).join('\n');
}
