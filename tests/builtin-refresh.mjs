// 內建零件改版（能量槍第 2 版）：已經在用的工坊升級時，只換掉帶 builtinRev 的內建零件的程式與縮圖；
// 玩家自己組的零件（就算裡面用到能量槍）、場景、遊戲都不動；瀏覽器載入時網址帶版本號，不會一直拿到快取的舊版。
// 自己準備一個「舊版工坊」資料夾、自己開只聽本機的伺服器（5318），不碰別的資料：npm run test:builtin-refresh
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5318;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-builtin-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- 準備「舊版工坊」：範例資料＋舊版能量槍（第 1 版、沒有 builtinRev）＋玩家自組的組合零件與場景 ----
cpSync(path.join(ROOT, 'examples', 'starter'), DATA, { recursive: true });
const lib = JSON.parse(readFileSync(path.join(DATA, 'library.json'), 'utf8'));
const blaster = lib.parts.find((p) => p.id === 'p_vwblaster01');
delete blaster.builtinRev;
blaster.size = [0.06, 0.18, 0.318];
const OLD_JS = 'export default function build(ctx) { const g = new ctx.THREE.Group(); g.add(new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(0.05, 0.1, 0.3))); return g; } // 舊版\n';
writeFileSync(path.join(DATA, 'parts', 'p_vwblaster01.js'), OLD_JS);
const mine = { id: 'c_mineturret01', name: '我的砲台', kind: 'composite', description: '玩家自己組的', size: [1, 1, 1], children: [{ partId: 'p_vwblaster01', position: [0, 0.5, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, { partId: 'p_mvfvu5sya31395', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }], createdAt: '2026-10-20T00:00:00.000Z' };
lib.parts.push(mine);
writeFileSync(path.join(DATA, 'library.json'), JSON.stringify(lib, null, 2));
const scene = { instances: [{ id: 'i_mineturret01', partId: 'c_mineturret01', position: [1, 0, 2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }], physics: true };
writeFileSync(path.join(DATA, 'scene.json'), JSON.stringify(scene, null, 2));
const sceneBefore = sha(path.join(DATA, 'scene.json'));
const mineBefore = JSON.stringify(mine);
const othersBefore = JSON.stringify(lib.parts.filter((p) => p.id !== 'p_vwblaster01'));

// ---- 新版伺服器啟動（升級） ----
const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (c) => (log += c));
try {
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  const after = JSON.parse(readFileSync(path.join(DATA, 'library.json'), 'utf8'));
  const rec = after.parts.find((p) => p.id === 'p_vwblaster01');
  const starterJs = readFileSync(path.join(ROOT, 'examples', 'starter', 'parts', 'p_vwblaster01.js'), 'utf8');
  check('升級：舊版能量槍換成第 2 版程式（跟範例一模一樣）', readFileSync(path.join(DATA, 'parts', 'p_vwblaster01.js'), 'utf8') === starterJs && rec.builtinRev === 2, log.split('\n').find((l) => l.includes('內建零件換新版')) || '');
  check('能量槍的名字、id 不變；尺寸換成新版', rec.name === '能量槍' && rec.size.join() === '0.078,0.217,0.375');
  check('縮圖換成新版', sha(path.join(DATA, 'thumbs', 'p_vwblaster01.jpg')) === sha(path.join(ROOT, 'examples', 'starter', 'thumbs', 'p_vwblaster01.jpg')));
  check('玩家自己組的零件（裡面用到能量槍）一個字都沒變', JSON.stringify(after.parts.find((p) => p.id === 'c_mineturret01')) === mineBefore);
  check('其他零件都沒變', JSON.stringify(after.parts.filter((p) => p.id !== 'p_vwblaster01')) === othersBefore);
  check('場景沒變', sha(path.join(DATA, 'scene.json')) === sceneBefore);
  // 瀏覽器端：載入網址帶版本號（零件程式快取一年，不換網址會一直拿舊的）
  const state = await (await fetch(`${BASE}/api/state`)).json();
  check('工具箱回傳 builtinRev，瀏覽器會用 /parts/p_vwblaster01.js?v=2 載入', state.library.parts.find((p) => p.id === 'p_vwblaster01')?.builtinRev === 2 && readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8').includes('?v=${rev}'));
  const served = await (await fetch(`${BASE}/parts/p_vwblaster01.js?v=2`)).text();
  check('帶版本號的網址拿到的是新版', served === starterJs);
  // 再重開一次：已經是第 2 版就不會再動
  server.kill('SIGTERM');
  await sleep(800);
  const libSha = sha(path.join(DATA, 'library.json'));
  const again = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  check('再重開一次：已經是新版，工具箱檔案不會再被改', sha(path.join(DATA, 'library.json')) === libSha);
  again.kill('SIGTERM');
} finally {
  server.kill('SIGTERM');
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
