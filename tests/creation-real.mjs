// 創作世界「單帳號真生成」驗收：用這台電腦上**已登入的 Codex（這台電腦主人自己的帳號）**透過 connector 真的生成，會消耗 Codex 額度。
// 伺服器照樣是只聽 127.0.0.1 的隔離測試伺服器（暫存資料夾），而且 CODEX_BIN 指到不存在的地方——證明伺服器自己不叫 Codex，
// 生成全部走 connector（創作者端）。流程走真的介面：
//   畫面按「連接我的 Codex」→ 用畫面上的配對碼執行 connector pair → connector run（真 codex exec）→
//   畫面打字說需求 → 等作品做好放到面前 → 真的點擊／按鍵玩 → 選取它說「改…」→ 換版（狀態保留）→ 存檔 → 重新整理重開
//   REAL_CODEX=1 node tests/creation-real.mjs        （沒設 REAL_CODEX=1 就不跑，免得誤用額度）
// 輸出：tests/out/creation-real/（截圖、report.json、connector 紀錄、生成出來的作品原始碼）
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.REAL_CODEX !== '1') {
  console.log('這個測試會用真的 Codex（消耗額度）：要跑請加 REAL_CODEX=1');
  process.exit(0);
}
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'creation-real');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 5391);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-create-real-'));
const STATE = path.join(DATA, 'connector-state.json');
const INTENT = process.env.INTENT || '做一個「接星星」小遊戲：天上會一直掉下不同顏色的星星，用左右方向鍵移動底下的籃子接住，接到金色星星加 3 分、其他加 1 分，漏掉 3 顆就結束，可以按空白鍵重新開始；HUD 顯示分數和剩下的機會';
const MODIFY = process.env.MODIFY || '把這個改成：每接到 5 顆星星會升一級，升級後星星掉得更快，HUD 多顯示等級；原本的分數要保留';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), kind: '單帳號真生成（這台電腦主人的 Codex，經 connector）', intent: INTENT, modify: MODIFY, checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: 'ignore' });
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}
const connLog = createWriteStream(path.join(OUT, 'connector.log'));
let connector = null;
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(60000);
  await page.goto(`${BASE}/?create`);
  await page.waitForFunction(() => window.__ws?.creation?.state().world?.id === 'root');
  // 配對：畫面上的配對碼 → connector pair
  await page.click('#cPairBtn');
  await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#cPairCode')?.textContent.trim()));
  const code = (await page.locator('#cPairCode').innerText()).trim();
  const pair = spawn(process.execPath, ['connector/vibe-connector.mjs', 'pair', BASE, code, '--label', '驗收用 connector', '--state', STATE], { cwd: ROOT });
  pair.stdout.pipe(connLog, { end: false });
  pair.stderr.pipe(connLog, { end: false });
  const pairCode = await new Promise((r) => pair.on('close', r));
  check('畫面配對碼 → connector pair 成功', pairCode === 0);
  await page.click('#cPairClose');
  connector = spawn(process.execPath, ['connector/vibe-connector.mjs', 'run', BASE, '--state', STATE], { cwd: ROOT });
  connector.stdout.pipe(connLog, { end: false });
  connector.stderr.pipe(connLog, { end: false });
  await page.waitForFunction(() => document.querySelector('#cConn')?.textContent.includes('已連上'), null, { timeout: 40000 }).catch(() => {});

  // 新玩法：真的介面打字送出
  const t0 = Date.now();
  await page.fill('#cInput', INTENT);
  await page.click('#cSend');
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 1 || window.__ws.creation.state().jobs.some((j) => j.status === 'failed'), null, { timeout: 15 * 60 * 1000, polling: 2000 });
  let s = await page.evaluate(() => window.__ws.creation.state());
  const job1 = s.jobs[0];
  const jr = await page.evaluate(async (id) => (await fetch(`/api/create/${id}`)).json(), job1.id);
  report.notes.job1 = jr.job;
  check('真 Codex 生成的新玩法做好並放在面前', s.live.length === 1 && jr.job.status === 'built', `${Math.round((Date.now() - t0) / 1000)} 秒、${jr.job.attempts} 輪、來源 ${JSON.stringify(jr.job.provenance)}`);
  if (s.live.length !== 1) throw new Error(`生成失敗：${JSON.stringify(jr.job.messages)}`);
  const L = s.live[0];
  report.notes.package1 = { lineage: L.lineage, version: L.version, name: L.name, code: await (await fetch(`${BASE}/pkg/${L.lineage}/${L.version}/main.js`)).text(), manifest: await (await fetch(`${BASE}/pkg/${L.lineage}/${L.version}/manifest.json`)).json() };
  writeFileSync(path.join(OUT, `v${L.version}-main.js`), report.notes.package1.code);
  await page.evaluate((id) => window.__ws.creation.select(id), L.id);
  await sleep(1500);
  const hudA = (await page.evaluate(() => window.__ws.creation.state())).live[0].hud.join(' | ');
  // 真的玩：按方向鍵左右移動一陣子、按空白鍵、點畫面上的實體
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight');
    await sleep(600);
    await page.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight');
  }
  await page.keyboard.press('Space');
  await sleep(1500);
  const hudB = (await page.evaluate(() => window.__ws.creation.state())).live[0].hud.join(' | ');
  await page.screenshot({ path: path.join(OUT, '01-generated-play.png') });
  check('玩得動：遊玩後 HUD 有變化（作品的規則在沙盒裡跑）', hudA !== hudB, `${hudA} → ${hudB}`);
  report.notes.hud = { before: hudA, after: hudB };

  // 修正：選取它，說「改…」
  await page.click('#cMode');
  const t1 = Date.now();
  await page.fill('#cInput', MODIFY);
  await page.click('#cSend');
  await page.waitForFunction((v) => window.__ws.creation.state().live[0]?.version > v || window.__ws.creation.state().jobs.some((j) => j.kind === 'modify' && ['failed', 'conflict'].includes(j.status)), L.version, { timeout: 15 * 60 * 1000, polling: 2000 });
  s = await page.evaluate(() => window.__ws.creation.state());
  const job2 = s.jobs.find((j) => j.kind === 'modify');
  const jr2 = await page.evaluate(async (id) => (await fetch(`/api/create/${id}`)).json(), job2.id);
  report.notes.job2 = jr2.job;
  check('真 Codex 修改後不重新整理換上新版（同一個實例、同一頁）', s.live[0].version > L.version && s.live[0].id === L.id && (await page.evaluate(() => performance.getEntriesByType('navigation').length)) === 1, `${Math.round((Date.now() - t1) / 1000)} 秒、${jr2.job.attempts} 輪、v${L.version} → v${s.live[0].version}`);
  const L2 = s.live[0];
  report.notes.package2 = { version: L2.version, code: await (await fetch(`${BASE}/pkg/${L2.lineage}/${L2.version}/main.js`)).text() };
  writeFileSync(path.join(OUT, `v${L2.version}-main.js`), report.notes.package2.code);
  await sleep(4000);
  const hudC = (await page.evaluate(() => window.__ws.creation.state())).live[0].hud.join(' | ');
  report.notes.hudAfterSwap = hudC;
  check('換版後仍在玩、沒有退回（觀察期過）', !(await page.evaluate(() => window.__ws.creation.state())).live[0].broken && (await page.evaluate(() => window.__ws.creation.state())).live[0].version === L2.version, hudC);
  await page.screenshot({ path: path.join(OUT, '02-modified.png') });
  // 存檔、重開
  await page.evaluate(() => window.__ws.creation.saveWorld());
  await page.reload();
  await page.waitForFunction(() => window.__ws?.creation?.state().live.length === 1);
  await sleep(1000);
  s = await page.evaluate(() => window.__ws.creation.state());
  check('存檔後重新整理：作品與版本還在', s.live[0].version === L2.version && s.live[0].lineage === L.lineage, s.live[0].hud.join(' | '));
  // connector 關掉：照樣能玩
  connector.kill('SIGINT');
  await sleep(1500);
  const hudD = s.live[0].hud.join(' | ');
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.down('ArrowLeft');
    await sleep(500);
    await page.keyboard.up('ArrowLeft');
  }
  await page.keyboard.press('Space');
  await sleep(1500);
  const hudE = (await page.evaluate(() => window.__ws.creation.state())).live[0].hud.join(' | ');
  check('connector／Codex 關掉後，做好的作品照樣能玩', hudD !== hudE || !(await page.evaluate(() => window.__ws.creation.state())).live[0].broken, `${hudD} → ${hudE}`);
  check('頁面沒有錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('流程沒有例外', false, e.stack || e.message);
} finally {
  connector?.kill('SIGINT');
  await browser.close();
  server.kill();
  await sleep(300);
  connLog.end();
  rmSync(DATA, { recursive: true, force: true });
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過（輸出：${OUT}）`);
process.exit(failed.length ? 1 : 0);
