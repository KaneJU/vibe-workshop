// 範例檢查：fabricator/examples/ 每一個都要通過真的驗收程式（範例壞掉，Codex 就會照著壞的寫）。
// 不用開伺服器、不花 Codex 額度：npm run test:examples
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'fabricator', 'examples');
const STARTER = path.join(ROOT, 'examples', 'starter');
let failed = 0;
for (const name of readdirSync(EXAMPLES).filter((n) => !n.includes('.'))) {
  // 放在 jobs/ 底下，validate.mjs 才找得到專案的 node_modules（three、rapier）
  const dir = path.join(ROOT, 'jobs', `__example_${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(EXAMPLES, name), dir, { recursive: true });
  cpSync(path.join(ROOT, 'fabricator', 'validate.mjs'), path.join(dir, 'validate.mjs'));
  writeFileSync(
    path.join(dir, 'context.json'),
    JSON.stringify({
      request: `example ${name}`,
      mode: 'create',
      selection: [],
      scene: [],
      player: { position: [0, 1.6, 3] },
      library: [],
      physics: { enabled: true },
      world: { environment: null, rules: [], library: [] },
      paths: {
        runtime: path.join(ROOT, 'public', 'runtime.mjs'),
        worldhost: path.join(ROOT, 'public', 'worldhost.mjs'),
        physics: path.join(ROOT, 'public', 'physics.mjs'),
        partsDir: path.join(STARTER, 'parts'),
        libraryFile: path.join(STARTER, 'library.json'),
      },
    }),
  );
  const res = spawnSync(process.execPath, ['validate.mjs', '--json'], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  let report = null;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    report = { ok: false, errors: [`驗收程式沒有回應：${(res.stderr || res.stdout).slice(-300)}`], warnings: [] };
  }
  const kind = existsSync(path.join(dir, 'world.js')) ? 'world.js' : 'part.js';
  console.log(`${report.ok ? '✅' : '❌'} ${name}（${kind}）${report.ok ? '' : ` — ${report.errors.join('；')}`}`);
  for (const w of report.warnings || []) console.log(`   ! ${w}`);
  if (!report.ok) failed += 1;
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 個範例沒通過` : '\n全部通過');
process.exit(failed ? 1 : 0);
