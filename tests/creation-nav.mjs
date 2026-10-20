// 創作世界：一層一層進出時「到了」的定義（協定測試：fixture connector、隔離瀏覽器，不叫 Codex）。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾）：
// - 根世界放 3 個點球（各自命中 2／1／0），往下開 12 層（第 9 層也放一個），再按「回上一層」一層一層回來
// - 每次作品起來（host.spawn）都記下當時公開的狀態：作品還沒全部起來時，state().loading 一定要是 true，
//   「回上一層」要停用、麵包屑標「載入中」（不會按了沒反應）
// - 測試只等「這一層 loading 結束」，不靠 sleep；到了就檢查這一層的作品全部在、命中數和下去前一樣
//   node tests/creation-nav.mjs        輸出 tests/out/creation-nav/
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'creation-nav');
mkdirSync(OUT, { recursive: true });
const PORT = 5388;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-nav-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), kind: '協定測試（fixture connector、隔離瀏覽器，非真 Codex）', checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' },
  stdio: 'ignore',
});
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}

const ORB = `vibe.define({
  init() { return { hits: 0 }; },
  tick(s, dt) {},
  view(s) { return [
    { id: 'base', shape: 'cylinder', pos: [0, 0.05, 0], size: [1, 0.1], color: '#1b3a52' },
    { id: 'orb', shape: 'sphere', pos: [0, 1, 0], size: [0.5], color: '#33ccff' },
  ]; },
  hud(s) { return ['命中 ' + s.hits]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; },
});`;
let token = null;
let connectorOn = true;
async function connectorLoop() {
  while (connectorOn) {
    if (!token) {
      await sleep(200);
      continue;
    }
    const r = await fetch(`${BASE}/api/connector/jobs?wait=2`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || r.status !== 200) continue;
    const { job } = await r.json();
    await fetch(`${BASE}/api/connector/jobs/${job.id}/package`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { format: 'vibe-pkg/1', name: '點球', description: 'fixture', stateSchema: 1, budgets: { entities: 20 } }, files: { 'main.js': ORB }, provenance: { tool: 'fixture', via: 'fixture' } }),
    });
  }
}
const loop = connectorLoop();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const S = (p) => p.evaluate(() => window.__ws.creation.state());
// 「到了」：這一層的世界公開了、而且載入結束（作品都起來了）——等這個，不等固定秒數
const arrived = (p, depth) => p.waitForFunction((n) => {
  const s = window.__ws.creation.state();
  return s.world?.depth === n && !s.loading;
}, depth);
const hitsOf = (s) => Object.fromEntries(s.live.map((x) => [x.id, Number(x.hud[0]?.match(/\d+/)?.[0] ?? -1)]));

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctx.addInitScript(() => window.top === window && localStorage.setItem('vw_help_seen', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:|XNNPACK|Failed to load resource|net::/.test(m.text()) && errors.push(`console: ${m.text()}`));
  let nextName = '';
  page.on('dialog', (d) => d.accept(nextName || undefined));
  page.setDefaultTimeout(30000);
  await page.goto(`${BASE}/?create`);
  await page.waitForFunction(() => window.__ws?.creation?.state().world?.id === 'root' && window.__ws.creation.state().role === 'leader');

  // 配對 fixture connector，做一個點球；根世界放 3 個，各點不同次數
  await page.click('#cPairBtn');
  await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#cPairCode')?.textContent.trim()));
  const code = (await page.locator('#cPairCode').innerText()).trim();
  token = (await fetch(`${BASE}/api/connector/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => r.json())).token;
  await page.click('#cPairClose');
  await page.evaluate(() => window.__ws.creation.submit('做一個點球'));
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 1);
  const lin = (await S(page)).live[0].lineage;
  await page.evaluate((l) => window.__ws.creation.placeNew(l, 1), lin);
  await page.evaluate((l) => window.__ws.creation.placeNew(l, 1), lin);
  await page.evaluate(() => {
    const c = window.__ws.creation;
    const L = c.state().live;
    for (const [i, n] of [[0, 2], [1, 1]]) for (let k = 0; k < n; k += 1) c.host().event(L[i].hostId, { type: 'click', target: 'orb' });
  });
  await page.waitForFunction(() => window.__ws.creation.state().live.map((x) => x.hud[0]).join('|') === '命中 2|命中 1|命中 0');
  const rootHits = hitsOf(await S(page));

  // 往下 12 層（第 9 層放一個、點一下）
  const chain = ['root'];
  for (let d = 1; d <= 12; d += 1) {
    nextName = `第 ${d} 層`;
    const id = await page.evaluate(() => window.__ws.creation.createChild());
    await page.evaluate((x) => window.__ws.creation.enter(x), id);
    await arrived(page, d);
    chain.push(id);
    if (d === 9) {
      await page.evaluate((l) => window.__ws.creation.placeNew(l, 1), lin);
      await page.evaluate(() => {
        const c = window.__ws.creation;
        c.host().event(c.state().live[0].hostId, { type: 'click', target: 'orb' });
      });
      await page.waitForFunction(() => window.__ws.creation.state().live[0]?.hud[0] === '命中 1');
    }
  }
  check('往下開到第 12 層', (await S(page)).world.depth === 12 && (await S(page)).world.id === chain[12]);

  // 每次作品起來都記下公開的狀態（審查用的 host.spawn 包裝，不改產品程式）
  await page.evaluate(() => {
    const c = window.__ws.creation;
    const h = c.host();
    const orig = h.spawn;
    window.__navLog = [];
    const snap = (at) => {
      const s = c.state();
      const up = document.querySelector('#cUp');
      window.__navLog.push({ at, depth: s.world?.depth, live: s.live.length, items: s.world?.items, loading: s.loading, up: up ? (up.disabled ? 'disabled' : 'enabled') : 'none', crumbLoading: document.querySelector('#cCrumb').textContent.includes('載入中') });
    };
    h.spawn = async (...a) => {
      snap('spawn');
      const r = await orig(...a);
      snap('spawned');
      return r;
    };
  });

  // 按「回上一層」一層一層回到根世界：每一層等到「到了」才檢查、才按下一次
  const back = [];
  for (let d = 12; d >= 1; d -= 1) {
    await page.click('#cUp');
    await arrived(page, d - 1);
    const s = await S(page);
    back.push({ depth: s.world.depth, ok: s.world.id === chain[d - 1], live: s.live.length, items: s.world.items, hud: s.live.map((x) => x.hud[0]) });
  }
  report.notes.back = back;
  check('每按一次只回一層、回到的是下去時的那一層（12→0，沒有跳層或停住）', back.every((b, i) => b.ok && b.depth === 11 - i), back.map((b) => `${b.depth}${b.ok ? '' : '✗'}`).join(','));
  check('每一層「到了」的時候，這層的作品全部都在（實例數＝存檔裡的作品數）', back.every((b) => b.live === b.items), back.map((b) => `${b.depth}:${b.live}/${b.items}`).join(' '));
  const lvl9 = back.find((b) => b.depth === 9);
  check('第 9 層回來時作品在、命中數和離開前一樣（命中 1）', lvl9?.live === 1 && lvl9.hud[0] === '命中 1', JSON.stringify(lvl9));
  const s = await S(page);
  check('從第 12 層一層一層返回根世界：作品都在', s.world.id === 'root' && s.live.length === 3, `live ${s.live.length}/${s.world.items} loading ${s.loading}`);
  check('根世界 3 個作品的命中數和下去前一樣（2／1／0，沒有掉資料）', JSON.stringify(hitsOf(s)) === JSON.stringify(rootHits), `${JSON.stringify(rootHits)} → ${JSON.stringify(hitsOf(s))}`);

  const log = await page.evaluate(() => window.__navLog);
  report.notes.spawnLog = log;
  const partial = log.filter((x) => x.live < x.items);
  check('作品還沒全部起來的時候（已記錄 ' + partial.length + ' 次），狀態一定標著 loading（world 先換、作品後到不會被當成「到了」）', partial.length > 0 && partial.every((x) => x.loading === true), JSON.stringify(partial.filter((x) => x.loading !== true).slice(0, 3)));
  const loadingRows = log.filter((x) => x.loading === true);
  check('載入中：「回上一層」停用、麵包屑標「載入中」（不會按了沒反應）', loadingRows.length > 0 && loadingRows.every((x) => x.up !== 'enabled' && x.crumbLoading), JSON.stringify(log.filter((x) => x.loading !== true || x.up === 'enabled' || !x.crumbLoading).slice(0, 3)));
  check('到了之後「回上一層」可以按、麵包屑不再顯示載入中', await page.evaluate(async () => {
    const c = window.__ws.creation;
    await c.enter(c.state().world.id === 'root' ? document.querySelector('#cPortals [data-enter]').dataset.enter : 'root');
    const up = document.querySelector('#cUp');
    return !c.state().loading && up && !up.disabled && !document.querySelector('#cCrumb').textContent.includes('載入中');
  }));
  await page.screenshot({ path: path.join(OUT, 'nav-after.png') });
  check('頁面沒有錯誤', errors.length === 0, errors.slice(0, 4).join(' | '));
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  connectorOn = false;
  await loop.catch(() => {});
  await browser.close();
  server.kill();
  await sleep(200);
  rmSync(DATA, { recursive: true, force: true });
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過（輸出：${OUT}）`);
process.exit(failed.length ? 1 : 0);
