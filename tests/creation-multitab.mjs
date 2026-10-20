// 創作世界：同一層在好幾個分頁／瀏覽器同時開著（協定測試：隔離的 fixture 創作者，不是兩個真帳號、也不叫 Codex）。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾；lease 6 秒、交接最多等 2 秒，測試才不用等太久）：
// - 同一位創作者兩個分頁 A1、A2，另一個瀏覽器（另一位創作者）B，三個都開根世界
// - 只有一個執行者在跑、存檔；其他只看，跟著伺服器通知同步（新作品、分數、換版）；不會互相 409 打架
// - 只看的分頁點作品＝接手：原執行者先存檔交出，分數不掉
// - 執行者斷線：lease 到期後別人接手；斷線的分頁回來時改成只看並同步成最新存檔（不覆蓋）
// - 執行中有人加作品／開傳送門：執行者併進來，自己正在跑的狀態不變
// - 手機方向鈕（觸控 pointerdown）和鍵盤一樣：只看的分頁按下去＝接手，按住就真的照著動，放開／pointercancel 就停；
//   眼鏡模式捏作品和點作品一樣（只看的分頁這一下拿來接手、不送給作品）
//   node tests/creation-multitab.mjs        輸出 tests/out/creation-multitab/
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'creation-multitab');
mkdirSync(OUT, { recursive: true });
const PORT = 5386;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-multitab-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), kind: '協定測試（fixture connector、隔離瀏覽器，非雙真帳號）', checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const startServer = async () => {
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex', CREATION_LEASE_MS: '6000', CREATION_HANDOVER_MS: '2000' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  return srv;
};
let server = await startServer();

const ORB = `vibe.define({
  init() { return { hits: 0, t: 0 }; },
  tick(s, dt) { s.t += dt; },
  view(s) { return [
    { id: 'base', shape: 'cylinder', pos: [0, 0.05, 0], size: [1, 0.1], color: '#1b3a52' },
    { id: 'orb', shape: 'sphere', pos: [0, 1, 0], size: [0.5], color: '#33ccff' },
  ]; },
  hud(s) { return ['命中 ' + s.hits]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; },
});`;
const ORB2 = ORB.replace("init() { return { hits: 0, t: 0 }; }", 'init() { return { hits: 0, t: 0, combo: 0 }; }')
  .replace("hud(s) { return ['命中 ' + s.hits]; }", "hud(s) { return ['命中 ' + s.hits, 'v2']; }")
  .replace("color: '#33ccff'", "color: '#ff9933'")
  .replace("onEvent(s, ev) {", "migrate(old) { return { ...old, combo: 0 }; },\n  onEvent(s, ev) {");
// 照方向鍵移動的方塊（測觸控方向鈕接手後是不是真的能控制）
const MOVER = `vibe.define({
  init() { return { x: 0, taps: 0 }; },
  tick(s, dt, input) { if (input.keys.right) s.x += dt; if (input.keys.left) s.x -= dt; },
  view(s) { return [
    { id: 'base', shape: 'box', pos: [0, 0.05, 0], size: [3, 0.1, 1], color: '#203040' },
    { id: 'puck', shape: 'sphere', pos: [Math.max(-1.4, Math.min(1.4, s.x)), 0.4, 0], size: [0.3], color: '#ffd166' },
  ]; },
  hud(s) { return ['x ' + s.x.toFixed(3), '點 ' + s.taps]; },
  onEvent(s, ev) { if (ev.type === 'click') s.taps += 1; },
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
    const [code, schema, name] = /移動/.test(job.intent) ? [MOVER, 1, '方塊'] : /連擊/.test(job.intent) ? [ORB2, 2, '點球'] : [ORB, 1, '點球'];
    await fetch(`${BASE}/api/connector/jobs/${job.id}/package`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { format: 'vibe-pkg/1', name, description: 'fixture', stateSchema: schema, budgets: { entities: 20 } }, files: { 'main.js': code }, provenance: { tool: 'fixture', via: 'fixture' } }),
    });
  }
}
const loop = connectorLoop();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(ctx, name) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:|XNNPACK|Failed to load resource|ERR_INTERNET_DISCONNECTED|net::/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
  page.on('dialog', (d) => d.accept(d.message().includes('名字') ? '旁邊的世界' : undefined));
  page.setDefaultTimeout(60000);
  await page.goto(`${BASE}/?create`);
  await page.waitForFunction(() => window.__ws?.creation?.state().world?.id === 'root' && window.__ws.creation.state().role !== 'none');
  return page;
}
const S = (p) => p.evaluate(() => window.__ws.creation.state());
const hits = async (p) => Number((await S(p)).live[0]?.hud?.[0]?.match(/\d+/)?.[0] ?? -1);
const serverHits = async () => {
  const w = (await fetch(`${BASE}/api/cworlds/root`).then((r) => r.json())).world;
  return w.items.map((i) => i.state?.hits ?? null);
};
const clickOrb = (p) =>
  p.evaluate(() => {
    const ws = window.__ws;
    const root = ws.scene.getObjectByName('creation-items');
    let m = null;
    root.traverse((o) => o.userData?.entityId === 'orb' && (m = o));
    const v = m.getWorldPosition(new ws.THREE.Vector3()).project(ws.camera);
    const r = ws.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  });
const until = (p, fn, arg, ms = 15000) => p.waitForFunction(fn, arg, { timeout: ms });

try {
  const ctxX = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const ctxY = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await ctxX.addInitScript(() => window.top === window && localStorage.setItem('vw_help_seen', '1'));
  await ctxY.addInitScript(() => window.top === window && localStorage.setItem('vw_help_seen', '1'));
  const A1 = await open(ctxX, 'A1');
  const A2 = await open(ctxX, 'A2');
  const B = await open(ctxY, 'B');
  const [a1, a2, b] = [await S(A1), await S(A2), await S(B)];
  check('同一層開三個（同創作者兩分頁＋另一個瀏覽器）：第一個執行、其他兩個只看', a1.role === 'leader' && a2.role === 'follower' && b.role === 'follower' && a1.me.creatorId === a2.me.creatorId && a1.me.creatorId !== b.me.creatorId, `${a1.role}/${a2.role}/${b.role}`);
  check('只看的分頁有清楚提示（點畫面或放作品就接手）', (await A2.locator('#cCrumb').innerText()).includes('只看'));

  // 配對（A1 的畫面）並做一個作品
  await A1.click('#cPairBtn');
  await A1.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#cPairCode')?.textContent.trim()));
  const code = (await A1.locator('#cPairCode').innerText()).trim();
  token = (await fetch(`${BASE}/api/connector/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => r.json())).token;
  await A1.click('#cPairClose');
  await A1.evaluate(() => window.__ws.creation.submit('做一個點球'));
  await until(A1, () => window.__ws.creation.state().live.length === 1);
  await until(A2, () => window.__ws.creation.state().live.length === 1);
  await until(B, () => window.__ws.creation.state().live.length === 1);
  check('執行者放了新作品 → 另外兩個分頁收到伺服器通知、出現同一個作品（不用重新整理）', true);

  // 執行者玩：分數同步給只看的分頁
  for (let i = 0; i < 3; i += 1) {
    const p = await clickOrb(A1);
    await A1.mouse.click(p.x, p.y);
    await sleep(200);
  }
  await until(A2, () => window.__ws.creation.state().live[0]?.hud?.[0] === '命中 3', null, 10000);
  await until(B, () => window.__ws.creation.state().live[0]?.hud?.[0] === '命中 3', null, 10000);
  check('執行者的分數（命中 3）同步到同創作者的另一個分頁與另一個瀏覽器', (await hits(A2)) === 3 && (await hits(B)) === 3);
  await sleep(5000);
  const [s1, s2, s3] = [await S(A1), await S(A2), await S(B)];
  report.notes.steady = { A1: s1.stats, A2: s2.stats, B: s3.stats };
  check('穩定共存：執行者存檔沒有衝突，只看的分頁從不存檔（不會互相 409 重新載入）', s1.stats.conflicts === 0 && s2.stats.saves === 0 && s3.stats.saves === 0 && s1.stats.saves >= 3, `A1 saves ${s1.stats.saves} conflicts ${s1.stats.conflicts}；A2 saves ${s2.stats.saves}；B saves ${s3.stats.saves}`);

  // 執行者換版：其他分頁跟著換上（伺服器通知），分數保留
  await A1.evaluate(() => {
    const c = window.__ws.creation;
    c.select(c.state().live[0].id);
    c.setMode('modify');
    return c.submit('加上連擊');
  });
  await until(A1, () => window.__ws.creation.state().live[0]?.version === 2, null, 20000);
  await until(A2, () => window.__ws.creation.state().live[0]?.version === 2, null, 15000);
  await until(B, () => window.__ws.creation.state().live[0]?.version === 2, null, 15000);
  check('執行者換版 v2 → 只看的分頁收到通知一起換上 v2、分數保留、沒重新整理', (await hits(A2)) === 3 && (await hits(B)) === 3 && (await A2.evaluate(() => performance.getEntriesByType('navigation').length)) === 1, `${(await S(A2)).live[0].hud.join(' ')}`);

  // 同創作者另一個分頁接手：A1 先存檔交出，分數不掉
  const p2 = await clickOrb(A2);
  await A2.mouse.click(p2.x, p2.y);
  await until(A2, () => window.__ws.creation.state().role === 'leader', null, 8000);
  await until(A1, () => window.__ws.creation.state().role === 'follower', null, 8000);
  check('只看的分頁點作品＝接手：原執行者存檔交出、角色互換、分數沒掉（命中 3）', (await hits(A2)) === 3 && (await S(A1)).stats.handovers === 1, `A1 handovers ${(await S(A1)).stats.handovers} A2 takeovers ${(await S(A2)).stats.takeovers}`);
  for (let i = 0; i < 2; i += 1) {
    const p = await clickOrb(A2);
    await A2.mouse.click(p.x, p.y);
    await sleep(200);
  }
  await until(A1, () => window.__ws.creation.state().live[0]?.hud?.[0] === '命中 5', null, 10000);
  check('接手後新的執行者繼續玩（命中 5），原來的分頁跟著同步', (await hits(A1)) === 5);

  // 執行者斷線：lease 到期後另一個瀏覽器接手；斷線的分頁回來改成只看、同步成最新存檔
  await sleep(2000); // 讓 A2 把命中 5 存好
  await ctxX.setOffline(true);
  const offAt = Date.now();
  await sleep(7500); // lease 6 秒到期
  const pb = await clickOrb(B);
  await B.mouse.click(pb.x, pb.y);
  await until(B, () => window.__ws.creation.state().role === 'leader', null, 8000);
  check('執行者（A2）斷線 6 秒後 lease 到期，另一個瀏覽器（B）點一下就接手，從最後存檔接著（命中 5）', (await hits(B)) === 5, `斷線後 ${Math.round((Date.now() - offAt) / 1000)} 秒`);
  for (let i = 0; i < 3; i += 1) {
    const p = await clickOrb(B);
    await B.mouse.click(p.x, p.y);
    await sleep(200);
  }
  // 存檔的頻率：有別的分頁在看時約 1.5 秒、沒有時 6 秒（斷線的分頁可能還沒被算掉）——最多等 10 秒
  for (let i = 0; i < 20 && (await serverHits())[0] !== 8; i += 1) await sleep(500);
  check('B 繼續玩（命中 8）並存檔', (await hits(B)) === 8 && (await serverHits())[0] === 8, `server ${JSON.stringify(await serverHits())}`);
  await ctxX.setOffline(false);
  await until(A2, () => window.__ws.creation.state().role === 'follower' && window.__ws.creation.state().connState === 'ok', null, 15000);
  await until(A2, () => window.__ws.creation.state().live[0]?.hud?.[0] === '命中 8', null, 10000);
  await sleep(2500);
  const a2s = await S(A2);
  check('斷線的分頁回來：發現已被接手 → 改成只看、同步成最新存檔（命中 8），沒有用自己的舊狀態覆蓋', a2s.role === 'follower' && a2s.stats.demotions >= 1 && (await serverHits())[0] >= 8 && (await hits(A1)) >= 8, `A2 demotions ${a2s.stats.demotions} reconnects ${a2s.stats.reconnects}；server ${JSON.stringify(await serverHits())}`);

  // 執行中有人加作品、開傳送門：執行者（B）併進來，自己的狀態不變、不會被降級
  const lin = (await S(B)).live[0].lineage;
  const before = await hits(B);
  await A1.evaluate(async (lin) => {
    const r = await fetch('/api/cworlds/root/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { id: 'i_from_a1_tab', lineage: lin, version: 2, pos: [3, 0, 0], state: null, schema: null }, client: 'tab_test_a1_external' }) });
    return r.status;
  }, lin);
  await until(B, () => window.__ws.creation.state().live.length === 2, null, 10000);
  await A1.evaluate(() => window.__ws.creation.createChild());
  await until(B, () => window.__ws.creation.state().world.portals === 1, null, 10000);
  await sleep(2500);
  const bs = await S(B);
  check('B 執行中，別的分頁加了作品與傳送門 → B 併進來（2 個作品、1 個傳送門），自己的分數沒變、沒被降級', bs.role === 'leader' && bs.live.length === 2 && bs.world.portals === 1 && (await hits(B)) >= before && bs.stats.merges >= 2 && bs.stats.demotions === 0, `merges ${bs.stats.merges} conflicts ${bs.stats.conflicts}`);
  const sw = (await fetch(`${BASE}/api/cworlds/root`).then((r) => r.json())).world;
  check('伺服器存檔：兩個作品、一個傳送門、B 的分數都在（沒有誰被靜默覆蓋）', sw.items.length === 2 && sw.portals.length === 1 && sw.items.find((i) => i.lineage === lin && i.state?.hits >= 8), JSON.stringify(sw.items.map((i) => ({ id: i.id, v: i.version, hits: i.state?.hits ?? null }))));
  // 伺服器重開（所有分頁的即時連線都斷）：自動重連，執行者繼續當執行者（存檔比伺服器新），只看的分頁重新同步
  await sleep(1500); // 讓 B 的存檔寫進硬碟
  const hitsBeforeRestart = await hits(B);
  server.kill();
  await sleep(800);
  server = await startServer();
  await until(B, () => window.__ws.creation.state().stats.reconnects >= 1 && window.__ws.creation.state().connState === 'ok', null, 20000);
  await until(A1, () => window.__ws.creation.state().stats.reconnects >= 1, null, 20000);
  await sleep(3000);
  const [rb, ra1, ra2] = [await S(B), await S(A1), await S(A2)];
  check('伺服器重開：三個分頁自動重連；B 重新拿回執行權繼續跑、A1／A2 仍只看並同步（命中沒掉）', rb.role === 'leader' && ra1.role === 'follower' && ra2.role === 'follower' && (await hits(B)) >= hitsBeforeRestart && (await hits(A1)) >= hitsBeforeRestart, `reconnects B ${rb.stats.reconnects} A1 ${ra1.stats.reconnects} A2 ${ra2.stats.reconnects}；命中 B ${await hits(B)} A1 ${await hits(A1)}`);
  await B.screenshot({ path: path.join(OUT, 'b-leader.png') });
  await A1.screenshot({ path: path.join(OUT, 'a1-follower.png') });

  // 手機方向鈕（觸控）：在乾淨的子世界，A1 執行、A2 只看（同一位創作者），放一個照方向鍵移動的方塊
  const tw = await A1.evaluate(() => window.__ws.creation.createChild());
  await A1.evaluate((id) => window.__ws.creation.enter(id), tw);
  await A2.evaluate((id) => window.__ws.creation.enter(id), tw);
  await A1.evaluate(() => window.__ws.creation.submit('做一個會照方向鍵移動的方塊'));
  await until(A1, () => window.__ws.creation.state().live[0]?.name === '方塊', null, 20000);
  await until(A2, () => window.__ws.creation.state().live[0]?.name === '方塊', null, 10000);
  const xOf = async (p) => Number((await S(p)).live[0]?.hud?.[0]?.match(/-?\d+\.\d+/)?.[0] ?? NaN);
  const tapsOf = async (p) => Number((await S(p)).live[0]?.hud?.[1]?.match(/\d+/)?.[0] ?? NaN);
  const frames = (p, n = 20) => p.evaluate((k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n); // 讓遊戲迴圈跑 n 格（不是等固定秒數）
  const key = (p, k) => p.locator(`#cKeys [data-k="${k}"]`);
  const [t1, t2] = [await S(A1), await S(A2)];
  check('子世界：A1 執行、A2 只看，只看的提示寫著「按方向鍵」也會接手', t1.role === 'leader' && t2.role === 'follower' && (await A2.locator('#cCrumb').innerText()).includes('按方向鍵'), `${t1.role}/${t2.role}`);
  // 只看的 A2 按住「▶」：接手（A1 先存檔交出），接手後按住的方向真的在動
  await key(A2, 'right').dispatchEvent('pointerdown');
  await until(A2, () => window.__ws.creation.state().role === 'leader', null, 8000);
  await until(A1, () => window.__ws.creation.state().role === 'follower', null, 8000);
  await until(A2, () => Number(window.__ws.creation.state().live[0]?.hud?.[0]?.match(/-?\d+\.\d+/)?.[0]) > 0.3, null, 8000);
  const [h1, h2] = [await S(A1), await S(A2)];
  check('只看的分頁按手機方向鈕（pointerdown）＝接手：A1 存檔交出、A2 接手，按住的「▶」真的讓方塊往右走', h2.stats.takeovers === t2.stats.takeovers + 1 && h1.stats.handovers === t1.stats.handovers + 1 && (await xOf(A2)) > 0.3, `A2 takeovers ${t2.stats.takeovers}→${h2.stats.takeovers}；A1 handovers ${t1.stats.handovers}→${h1.stats.handovers}；x ${await xOf(A2)}`);
  await key(A2, 'right').dispatchEvent('pointerup');
  await frames(A2, 5); // 放開前已經送出去的那一步先回來
  const xUp = await xOf(A2);
  await frames(A2);
  check('放開（pointerup）就停：之後 20 格 x 不再變', (await xOf(A2)) === xUp, `${xUp} → ${await xOf(A2)}`);
  await key(A2, 'left').dispatchEvent('pointerdown');
  await until(A2, (x0) => Number(window.__ws.creation.state().live[0]?.hud?.[0]?.match(/-?\d+\.\d+/)?.[0]) < x0 - 0.2, xUp, 8000);
  await key(A2, 'left').dispatchEvent('pointercancel');
  await frames(A2, 5);
  const xCancel = await xOf(A2);
  await frames(A2);
  check('執行中直接控制（不用再接手）；手指被系統取消（pointercancel）也會停', (await xOf(A2)) === xCancel && xCancel < xUp, `${xUp} → ${xCancel} → ${await xOf(A2)}`);
  await until(A1, (x) => window.__ws.creation.state().live[0]?.hud?.[0] === 'x ' + x.toFixed(3), xCancel, 10000);
  check('只看的 A1 跟著同步到 A2 的位置', (await xOf(A1)) === xCancel, `A1 x ${await xOf(A1)}`);
  // 只看的 A1 很快點一下「▶」：這一下拿來接手（不會讓方塊動），從 A2 交出的存檔接著跑
  const a1Take0 = (await S(A1)).stats.takeovers;
  await key(A1, 'right').dispatchEvent('pointerdown');
  await key(A1, 'right').dispatchEvent('pointerup');
  await until(A1, () => window.__ws.creation.state().role === 'leader', null, 8000);
  await frames(A1);
  check('只看的分頁很快點一下方向鈕：只拿來接手（方塊沒動），從最新存檔接著（x 一樣）', (await S(A1)).stats.takeovers === a1Take0 + 1 && (await xOf(A1)) === xCancel, `x ${xCancel} → ${await xOf(A1)}`);
  // 眼鏡模式捏作品：只看的分頁（A2）捏下去＝接手，這一下不送給作品；接手後再捏才算點到
  await until(A2, () => window.__ws.creation.state().role === 'follower', null, 8000);
  const tapsBefore = await tapsOf(A1);
  const pinchArg = await A2.evaluate(() => {
    const L = window.__ws.creation.state().live[0];
    return { inst: { id: L.hostId, name: L.name, entityId: 'puck', itemId: L.id } };
  });
  await A2.evaluate((h) => window.__ws.creation.pinch(h), pinchArg);
  await until(A2, () => window.__ws.creation.state().role === 'leader', null, 8000);
  const tapsAfterTake = await tapsOf(A2);
  const pinchArg2 = await A2.evaluate(() => {
    const L = window.__ws.creation.state().live[0];
    return { inst: { id: L.hostId, name: L.name, entityId: 'puck', itemId: L.id } };
  });
  await A2.evaluate((h) => window.__ws.creation.pinch(h), pinchArg2);
  await until(A2, (n) => window.__ws.creation.state().live[0]?.hud?.[1] === '點 ' + (n + 1), tapsAfterTake, 5000);
  check('眼鏡模式：只看的分頁捏作品＝接手（這一下不送給作品），接手後再捏才算點到', tapsAfterTake === tapsBefore && (await tapsOf(A2)) === tapsBefore + 1, `點 ${tapsBefore} → 接手後 ${tapsAfterTake} → 再捏 ${await tapsOf(A2)}`);
  await A2.screenshot({ path: path.join(OUT, 'a2-touch-leader.png') });
  check('三個頁面都沒有錯誤', errors.length === 0, errors.slice(0, 4).join(' | '));
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
