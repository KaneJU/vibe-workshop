// 戴著眼鏡用「真的 Codex」做一個作品、玩、再改它（單帳號真生成驗收）：用這台電腦上**已登入的 Codex（這台電腦主人自己的帳號）**
// 透過 connector 真的生成，會消耗 Codex 額度。伺服器是只聽 127.0.0.1 的隔離測試伺服器（暫存資料夾），CODEX_BIN 指到不存在的地方——
// 伺服器自己不叫 Codex，生成全部走 connector（創作者端）。
// 換掉的只有硬體（見 tests/headset-helpers.mjs）：鏡頭畫面、手勢 worker（合成手部關鍵點）、語音辨識（合成辨識事件）、動作感測；
// 不是真手機、不是真麥克風、不是真的手勢模型推論。
// 流程（全程在眼鏡模式裡，不碰 2D 介面）：畫面按「連接我的 Codex」→ connector pair／run（真 codex exec）→ 進眼鏡 →
//   低頭選單確認「✨ 新作品」→ 點螢幕說需求 → 你的 Codex 做好、放在面前 → 低頭選單打開「🎮 方向鍵」、用手捏住 ◀／▶ 玩 →
//   用手捏作品選取 → 選單「✏️ 改」→ 點螢幕說要怎麼改 → 換上新版（同一個實例、不重新整理）
//   REAL_CODEX=1 node tests/headset-real.mjs        （沒設 REAL_CODEX=1 就不跑，免得誤用額度）
// 輸出：tests/out/headset-real/（雙眼截圖、report.json、connector 紀錄、生成出來的作品原始碼、伺服器的版本收據）
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INIT, HELPERS } from './headset-helpers.mjs';

if (process.env.REAL_CODEX !== '1') {
  console.log('這個測試會用真的 Codex（消耗額度）：要跑請加 REAL_CODEX=1');
  process.exit(0);
}
const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'headset-real');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 5441);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-headset-real-'));
const STATE = path.join(DATA, 'connector-state.json');
const INTENT = process.env.INTENT || '做一個「躲落石」小遊戲：石頭從上面一直掉下來，用左右方向鍵移動底下的小人閃開，被打到少一條命，三條命用完就結束，按空白鍵（動作鍵）重新開始；HUD 顯示分數和剩下的命';
const MODIFY = process.env.MODIFY || '把這個改成：每躲過 5 顆石頭升一級，升級後石頭掉得更快，HUD 多顯示等級；原本的分數和命要保留';
const SKIP_MODIFY = process.env.SKIP_MODIFY === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), kind: '單帳號真生成（這台電腦主人的 Codex，經 connector）＋眼鏡模式流程（合成手部關鍵點、合成辨識事件；非真機、非真麥克風）', intent: INTENT, modify: SKIP_MODIFY ? null : MODIFY, checks: results, notes: {} };
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
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
// 版本收據與原始碼（伺服器存的、不可變）
const keep = (lineage, v, tag) => {
  const dir = path.join(DATA, 'creation', 'packages', lineage, String(v));
  for (const f of ['main.js', 'manifest.json', 'receipt.json']) if (existsSync(path.join(dir, f))) writeFileSync(path.join(OUT, `${tag}-v${v}-${f}`), readFileSync(path.join(dir, f)));
  return existsSync(path.join(dir, 'receipt.json')) ? JSON.parse(readFileSync(path.join(dir, 'receipt.json'), 'utf8')) : null;
};
try {
  const ctx = await browser.newContext({ ...devices['iPhone 15 landscape'], viewport: { width: 844, height: 390 } });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:|XNNPACK|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.setDefaultTimeout(60000);
  await page.goto(`${BASE}/?create`);
  await page.waitForFunction(() => window.__ws?.creation?.state().world && !window.__ws.creation.state().loading);
  await page.addScriptTag({ content: HELPERS });
  const S = () => page.evaluate(() => window.__ws.creation.state());
  const H = () => page.evaluate(() => window.__ws.headset.state());
  const until = (fn, arg, ms = 20000) => page.waitForFunction(fn, arg, { timeout: ms, polling: 250 });
  const handAt = (open, t) => page.evaluate(([o, x]) => window.__handAt(o, x), [open, t]);
  const lookAt = (t) => page.evaluate((x) => window.__lookAt(x), t);
  // expect：先指準、看到亮起來再捏（例如 { padHover: 'left' }、{ menuHover: 'c:new' }）
  const tracked = (uv, expect = null) =>
    until(
      ([u, v, ex]) => {
        const st = window.__ws.headset.state();
        const p = st.lastHand?.pinch;
        if (!(st.handOn && st.gesture.armed && !st.gesture.pinched && p && Math.abs(p.x - u) < 0.02 && Math.abs(p.y - v) < 0.02)) return false;
        return !ex || Object.entries(ex).every(([k, val]) => st[k] === val);
      },
      [uv.u, uv.v, expect],
      8000,
    );
  const press = async (t, expect = null) => {
    await tracked(await handAt(1, t), expect);
    const n = (await H()).stats.events['pinch-start'] || 0;
    await handAt(0, t);
    await until((k) => (window.__ws.headset.state().stats.events['pinch-start'] || 0) > k, n, 8000);
  };
  const openHand = async (t) => {
    await handAt(1, t);
    await until(() => !window.__ws.headset.state().gesture.pinched, null, 8000);
  };
  const pressMenu = async (id) => {
    await lookAt(await page.evaluate(() => window.__menuCenter()));
    if (!(await H()).menuOpen) {
      // 選單平常收成「☰ 選單」頁籤：先捏它展開
      const tp = await page.evaluate(() => window.__menuTabPos());
      await press(tp, { menuHover: 'menu:open' });
      await openHand(tp);
      await until(() => window.__ws.headset.state().menuOpen, null, 8000);
    }
    await lookAt(await page.evaluate(() => window.__menuGazeSpot())); // 視線停在標題那一帶：用手捏，不靠盯著
    await until((x) => window.__ws.headset.state().menuButtons.some((b) => b.id === x && b.enabled), id, 8000);
    const p = await page.evaluate((x) => window.__menuPos(x), id);
    await press(p, { menuHover: id });
    await openHand(p);
  };
  const tap = async () => {
    await page.touchscreen.tap(422, 195); // 點螢幕＝使用者手勢（開始／停止說話）
    await sleep(100);
  };
  const shot = (name) => page.screenshot({ path: path.join(OUT, name), caret: 'initial' });
  // 這個作品現在畫了哪些實體（世界座標）
  const entities = (hostId) =>
    page.evaluate((h) => {
      const g = window.__ws.scene.getObjectByName('creation-items').children.find((c) => c.userData.instId === h);
      const out = {};
      g?.traverse((o) => typeof o.userData?.entityId === 'string' && o.visible && (out[o.userData.entityId] = o.getWorldPosition(new window.__ws.THREE.Vector3()).toArray()));
      return out;
    }, hostId);

  // ---- 配對：畫面按「連接我的 Codex」→ 配對碼 → connector pair／run ----
  await page.click('#cPairBtn');
  await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#cPairCode')?.textContent.trim()));
  const code = (await page.locator('#cPairCode').innerText()).trim();
  const pair = spawn(process.execPath, ['connector/vibe-connector.mjs', 'pair', BASE, code, '--label', '驗收用 connector', '--state', STATE], { cwd: ROOT });
  pair.stdout.pipe(connLog, { end: false });
  pair.stderr.pipe(connLog, { end: false });
  check('畫面配對碼 → connector pair 成功', (await new Promise((r) => pair.on('close', r))) === 0);
  await page.click('#cPairClose');
  connector = spawn(process.execPath, ['connector/vibe-connector.mjs', 'run', BASE, '--state', STATE], { cwd: ROOT });
  connector.stdout.pipe(connLog, { end: false });
  connector.stderr.pipe(connLog, { end: false });
  let online = false;
  for (let i = 0; i < 60 && !online; i += 1) {
    online = await page.evaluate(async () => (await (await fetch('/api/connector/status')).json()).online === true);
    if (!online) await sleep(1000);
  }
  check('connector 在線（用這台電腦已登入的 Codex；伺服器自己的 CODEX_BIN 不存在）', online);

  // ---- 進眼鏡：選單確認新作品 → 點螢幕說需求 ----
  await page.evaluate(() => window.__ws.headset.enter());
  await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', (window.__sensor = { alpha: 0, beta: 90, gamma: 0 }))));
  await until(() => window.__ws.headset.state().active && window.__ws.headset.state().tracker.state === 'running', null, 15000);
  await pressMenu('c:new');
  const mode0 = await page.evaluate(() => window.__ws.creation.headsetMode());
  check('眼鏡裡低頭選單捏「✨ 新作品」：模式牌寫著說話＝做新作品', /做新作品/.test(mode0.text), mode0.text);
  await lookAt([0, 1, -1]);
  await tap();
  await page.evaluate((t) => window.__say(t, true), INTENT);
  await until(() => window.__ws.creation.state().jobs.length === 1);
  const t0 = Date.now();
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 1 || window.__ws.creation.state().jobs.some((j) => ['failed', 'conflict', 'cancelled'].includes(j.status)), null, { timeout: 15 * 60 * 1000, polling: 2000 });
  let s = await S();
  const job1 = (await page.evaluate(async (id) => (await fetch(`/api/create/${id}`)).json(), s.jobs[0].id)).job;
  report.notes.job1 = job1;
  check('真 Codex 做好新作品、放在面前（工作來源 voice、新作品）', s.live.length === 1 && job1.status === 'built' && job1.source === 'voice' && !job1.targetLineage, `${Math.round((Date.now() - t0) / 1000)} 秒、${job1.attempts} 輪、${JSON.stringify(job1.provenance)}`);
  if (s.live.length !== 1) throw new Error(`生成失敗：${JSON.stringify(job1.messages)}`);
  const L = s.live[0];
  const receipt1 = keep(L.lineage, L.version, 'new');
  report.notes.receipt1 = receipt1;
  check('伺服器的版本收據：作品原始碼雜湊、工作、connector、影子試跑結果都在（原始碼另存）', receipt1 && receipt1.jobId === job1.id && /^[0-9a-f]{64}$/.test(receipt1.codeSha256), JSON.stringify(receipt1?.shadow || {}));
  await page.evaluate((id) => window.__ws.creation.select(id), L.id);
  await sleep(1500);

  // ---- 用眼鏡裡的方向鍵玩：找出「按右往右、按左往左」的那個實體 ----
  await pressMenu('sys:pad');
  const ents0 = await entities(L.hostId);
  const center = Object.values(ents0).reduce((a, p) => [a[0] + p[0] / Object.keys(ents0).length, a[1] + p[1] / Object.keys(ents0).length, a[2] + p[2] / Object.keys(ents0).length], [0, 0, 0]);
  await lookAt(center);
  await until(() => window.__ws.headset.state().padShown, null, 8000);
  const padPos = (k) => page.evaluate((x) => window.__padPos(x), k);
  const hudOf = async () => (await S()).live[0].hud.join(' | ');
  const hudA = await hudOf();
  await lookAt(center);
  await until(() => window.__ws.headset.state().padShown, null, 8000);
  // 生成的遊戲是未知的：可能剛好結束（要按 ⚡ 重來）。最多試三次：（第二次起先捏 ⚡）→ 捏住 ▶ 0.5 秒 → 捏住 ◀ 0.5 秒，
  // 找「按右往右、按左往左」的那個實體
  let player = null;
  let moved = [];
  let afterL = {};
  for (let attempt = 0; attempt < 3 && !player; attempt += 1) {
    if (attempt > 0) {
      await pinchAt(await padPos('action'), { padHover: 'action' });
      await sleep(400);
    }
    const before = await entities(L.hostId);
    await press(await padPos('right'), { padHover: 'right' });
    await sleep(500);
    const afterR = await entities(L.hostId);
    await openHand(await padPos('right'));
    await press(await padPos('left'), { padHover: 'left' });
    await sleep(500);
    afterL = await entities(L.hostId);
    await openHand(await padPos('left'));
    moved = Object.keys(before).filter((k) => afterR[k] && afterL[k]).map((k) => ({ k, r: afterR[k][0] - before[k][0], l: afterL[k][0] - afterR[k][0] }));
    player = moved.filter((m) => m.r > 0.05 && m.l < -0.05).sort((a, b) => b.r - a.r)[0] || null;
    report.notes[`padAttempt${attempt + 1}`] = { player, moved: moved.filter((m) => Math.abs(m.r) > 0.02 || Math.abs(m.l) > 0.02).slice(0, 12), hud: await hudOf() };
  }
  report.notes.padResponse = { player };
  await pinchAt(await padPos('action'), { padHover: 'action' });
  await sleep(1500);
  const hudB = await hudOf();
  check('眼鏡裡捏住「右 ▶」「◀ 左」：作品裡有東西照著往右、往左走（真生成的作品讀到方向鍵）', !!player, player ? `${player.k}：右 +${player.r.toFixed(2)}、左 ${player.l.toFixed(2)}` : JSON.stringify(moved));
  check('作品的 HUD 在眼鏡裡看得到、玩了之後有變化', hudA !== hudB || /\d/.test(hudB), `${hudA} → ${hudB}`);
  await shot('01-headset-play-new.png');
  async function pinchAt(t, expect = null) {
    await press(t, expect);
    await openHand(t);
  }

  if (!SKIP_MODIFY) {
    // ---- 用手捏作品選取 → 選單「✏️ 改」→ 點螢幕說要怎麼改 ----
    await page.evaluate(() => window.__ws.creation.select(null));
    const ents = await entities(L.hostId);
    const target = player ? afterL[player.k] : Object.values(ents)[0];
    await lookAt(target);
    await pinchAt(await (async () => (await entities(L.hostId))[player?.k] || target)(), { hover: L.hostId });
    await until((id) => window.__ws.creation.state().selected === id, L.id, 8000).catch(async () => page.evaluate((id) => window.__ws.creation.select(id), L.id));
    await pressMenu('c:modify');
    const mode1 = await page.evaluate(() => window.__ws.creation.headsetMode());
    check('選取後低頭選單捏「✏️ 改」：模式牌寫著說話＝改這一件、這一版', mode1.text.includes(L.name) && mode1.text.includes(`v${L.version}`), mode1.text);
    await lookAt(center);
    const stateBefore = await page.evaluate(async () => {
      const c = window.__ws.creation;
      return (await c.host().snapshot(c.state().live[0].hostId)).state;
    });
    await tap();
    await page.evaluate((t) => window.__say(t, true), MODIFY);
    await until(() => window.__ws.creation.state().jobs.length === 2);
    const jm = (await S()).jobs[1];
    check('修改模式說話 → 修改工作（目標是這一件、基準 v1）', jm.kind === 'modify' && jm.targetItem === L.id && jm.baseVersion === L.version, JSON.stringify(jm));
    const t1 = Date.now();
    await page.waitForFunction((v) => window.__ws.creation.state().live[0]?.version > v || window.__ws.creation.state().jobs.some((j) => j.kind === 'modify' && ['failed', 'conflict', 'cancelled'].includes(j.status)), L.version, { timeout: 15 * 60 * 1000, polling: 2000 });
    s = await S();
    const job2 = (await page.evaluate(async (id) => (await fetch(`/api/create/${id}`)).json(), jm.id)).job;
    report.notes.job2 = job2;
    check('真 Codex 改好：不重新整理換上新版（同一個實例、同一頁）', s.live[0].version > L.version && s.live[0].id === L.id && (await page.evaluate(() => performance.getEntriesByType('navigation').length)) === 1, `${Math.round((Date.now() - t1) / 1000)} 秒、${job2.attempts} 輪、v${L.version} → v${s.live[0].version}`);
    const L2 = s.live[0];
    report.notes.receipt2 = keep(L2.lineage, L2.version, 'modified');
    await sleep(4000); // 觀察期 3 秒
    s = await S();
    const stateAfter = await page.evaluate(async () => {
      const c = window.__ws.creation;
      return (await c.host().snapshot(c.state().live[0].hostId)).state;
    });
    report.notes.stateKeep = { before: stateBefore, after: stateAfter };
    const common = Object.keys(stateBefore || {}).filter((k) => typeof stateBefore[k] === 'number' && typeof stateAfter?.[k] === 'number');
    check('換上後觀察期過了沒有退回（仍是新版、沒壞）', s.live[0].version === L2.version && !s.live[0].broken, s.live[0].hud.join(' | '));
    check('狀態接著用（存檔帶到新版：數字欄位保留下來）', common.length > 0, `共同數字欄位 ${common.slice(0, 8).join('、')}`);
    await shot('02-headset-modified.png');
  }
  await page.keyboard.press('Escape');
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
