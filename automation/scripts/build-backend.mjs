import fs from 'node:fs/promises';
import path from 'node:path';
import { engine, work, writeJson } from './config.mjs';
import { run } from './runtime.mjs';

export async function buildBackend() {
  const env = { ...process.env, TMPDIR: path.join(work, 'tmp'), GOTMPDIR: path.join(work, 'tmp'), GOCACHE: path.join(work, 'go-build'), GOMODCACHE: path.join(work, 'go-mod') };
  await fs.mkdir(env.TMPDIR, { recursive: true });
  await fs.mkdir(path.join(work, 'bin'), { recursive: true });
  const module = JSON.parse(await run('go', ['mod', 'download', '-json', 'github.com/plumber-cd/terraform-backend-git@v0.1.12'], { env }));
  if (module.Error) throw new Error(module.Error);
  const source = path.join(work, 'backend-source-v0.1.12');
  await fs.cp(module.Dir, source, { recursive: true, force: false });
  const overlay = path.join(work, 'backend-overlay.json');
  await writeJson(overlay, { Replace: { [path.join(source, 'storages/git/git.go')]: path.join(engine, 'backend/git.go') } });
  const binary = path.join(work, 'bin/terraform-backend-git');
  await run('go', ['build', '-mod=readonly', '-overlay', overlay, '-o', binary, '.'], { cwd: source, env });
  console.log('Built terraform-backend-git v0.1.12 with repository commit identity and Signed-off-by');
  return binary;
}

if (process.argv[1] === path.join(engine, 'scripts/build-backend.mjs')) {
  buildBackend().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
