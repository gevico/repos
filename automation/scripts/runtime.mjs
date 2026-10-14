import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, engine, work, writeJson, terraformValues } from './config.mjs';

const execute = promisify(execFile);
export async function run(command, args, options = {}) {
  try {
    const result = await execute(command, args, { cwd: root, maxBuffer: 32 * 1024 * 1024, env: process.env, ...options });
    return result.stdout;
  } catch (error) {
    throw new Error(`${command} ${args[0] ?? ''} failed: ${(error.stderr || error.stdout || error.message).slice(-6000)}`);
  }
}

export async function prepareTerraform(catalog, policy, store) {
  const directory = path.join(work, 'terraform');
  await fs.mkdir(directory, { recursive: true });
  for (const filename of ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf', '.terraform.lock.hcl']) {
    await fs.copyFile(path.join(engine, 'terraform', filename), path.join(directory, filename));
  }
  await writeJson(path.join(directory, 'requests.auto.tfvars.json'), terraformValues(catalog, policy));
  await run('terraform', ['init', '-reconfigure', '-input=false', '-lockfile=readonly'], { cwd: directory, env: store.env });
  return { directory, env: store.env };
}

export async function terraformPlan({ directory, env }, { readOnly = false } = {}) {
  const plan = path.join(directory, 'request.tfplan');
  await run('terraform', ['plan', '-input=false', '-no-color', ...(readOnly ? ['-lock=false'] : ['-lock-timeout=5m']), `-out=${plan}`], { cwd: directory, env });
  return JSON.parse(await run('terraform', ['show', '-json', plan], { cwd: directory, env }));
}

export async function terraformApply({ directory, env }) {
  return run('terraform', ['apply', '-input=false', '-no-color', '-lock-timeout=5m', path.join(directory, 'request.tfplan')], { cwd: directory, env });
}
