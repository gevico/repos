import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { root, loadCatalog, loadPolicy, validateRequest, requestYaml, terraformValues, writeJson } from './config.mjs';
import { github, inspectCatalog } from './github.mjs';

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
    };
    await validateRequest(request, policy, `${request.name}.yaml`);
    try {
      await fs.access(path.join(root, 'repositories', `${request.name}.yaml`));
      throw new Error(`${request.name} already has a request; edit the existing file`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    process.stdout.write(requestYaml(request));
    return;
  }
  const { catalog, policy } = await loadCatalog(values.directory ? path.resolve(root, values.directory) : root);
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
