// 戴著眼鏡也能創作（瀏覽器端到端）：創作世界裡進眼鏡模式，用低頭選單（凝視／捏合）、點螢幕說話、頭戴方向鍵完成整個閉環。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存 DATA_DIR、CODEX_BIN 不存在），作品由「協定測試 connector」（測試自己）交——不是真 Codex。
// 測試替身（都只在測試頁面裡，不改產品）：
//   - 鏡頭：canvas.captureStream 的假畫面（不是 iPhone 後鏡頭）；手勢 worker：假的，回傳測試指定的「合成手部關鍵點」
//     ——走的是真的 handtrack → hands 狀態機 → headset 路徑，但不代表真的模型推論（那在 tests/headset.mjs 用假鏡頭＋真模型驗）
//   - 語音：假的 SpeechRecognition（測試推中間／最終結果；記錄 start 時有沒有使用者手勢、abort 了幾次）——不是真麥克風
//   - 動作感測：測試送 deviceorientation 事件（WebKit 沒有建構子就補一個）
// 驗：
//   A 新作品／修改語意：捏選取不會變修改；選單「✏️ 改」才進修改；模式牌一直寫著說話會做什麼；改選別的作品回到新作品；改完狀態保留
//   B 開口就固定目標：說到一半改選別的、換到子世界，工作仍綁開口時的那一層、那一件
//   C 取消與去重：取消不送出（之後晚到的結果也不送）；中間結果不派工；同一句只一個工作
//   D 生命週期：說到一半離開眼鏡（Esc／長按／選單）、切到背景 → 這句丟掉，回來不補送
//   E 選單捏合不穿透：選單（按鈕或空隙）擋在作品前面時，捏下去只按選單、作品收不到點擊
//   F 方向鍵：捏住＝按住、滑動換鍵、張開放開；追丟、離開、換層、切背景、收起方向鍵都放開；只看的分頁按方向鍵＝接手（有載入中，完成後才動）
//   G 真生成過的「接星星」（fixture）用頭戴方向鍵玩到得分，再到子世界放同一個作品、用同一套方向鍵玩
//   H 子世界 A→B→C 全程用選單（預設名字、不跳打字視窗）、在 C 用說的做作品、回到 A 從作品庫放出 C 的作品；進出時有載入中
//   I 反覆進出 5 次：鏡頭串流、手勢 worker、語音、事件監聽、場景物件、GPU 資源都回到原來
//   J 裝盒前檢查：每項實測才通過（不是 https 就全部打勾）、驗收摘要只有數字與狀態（沒有 token、配對碼、聽到的字）
//   K 對位檢查：量出鏡頭偏移差、套用、重設；鏡頭前後距離改了，手的射線照樣對準
//   BROWSER=webkit node tests/headset-create.mjs   只跑 WebKit 子集（A C D E F I J）；WebKit 桌面引擎不等於 iPhone Safari
//   node tests/headset-create.mjs        輸出 tests/out/headset-create/（截圖、report.json）
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INIT, HELPERS } from './headset-helpers.mjs';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const pw = await import(PW);
const BROWSER = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', BROWSER === 'webkit' ? 'headset-create-webkit' : 'headset-create');
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || (BROWSER === 'webkit' ? 5436 : 5431));
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-headset-create-'));
const ALL = BROWSER === 'webkit' ? 'ACDEFIJ' : 'ABCDEFGHIJK';
const SECTIONS = new Set((process.env.SECTIONS || ALL).toUpperCase().split(''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), browser: BROWSER, kind: '協定測試（fixture connector、合成手部關鍵點、假鏡頭畫面、合成辨識事件；非真機、非真語音、非真 Codex）', checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex', CREATION_LEASE_MS: '6000', CREATION_HANDOVER_MS: '2000' },
  stdio: 'ignore',
});
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}

// ---------------- 作品（fixture） ----------------
const KEYS = `vibe.define({
  init() { return { x: 0, z: 0, act: 0, wasAct: false, hits: 0, keys: '' }; },
  tick(s, dt, input) {
    const k = input.keys;
    if (k.left) s.x -= dt * 1.5;
    if (k.right) s.x += dt * 1.5;
    if (k.up) s.z -= dt * 1.5;
    if (k.down) s.z += dt * 1.5;
    s.x = Math.max(-2, Math.min(2, s.x));
    s.z = Math.max(-2, Math.min(2, s.z));
    if (k.action && !s.wasAct) s.act += 1;
    s.wasAct = !!k.action;
    s.keys = (k.left ? 'L' : '') + (k.right ? 'R' : '') + (k.up ? 'U' : '') + (k.down ? 'D' : '') + (k.action ? 'A' : '');
  },
  view(s) { return [
    { id: 'pad', shape: 'box', pos: [0, 0.05, 0], size: [4.4, 0.1, 4.4], color: '#14304a' },
    { id: 'cube', shape: 'box', pos: [s.x, 0.4, s.z], size: [0.6, 0.6, 0.6], color: '#ffcc33' },
    { id: 'label', shape: 'text', pos: [0, 1.4, 0], size: [0.25], text: '方向方塊', color: '#ffffff' },
  ]; },
  hud(s) { return ['x ' + s.x.toFixed(2) + ' z ' + s.z.toFixed(2), '動作 ' + s.act + ' 按著 ' + (s.keys || '-'), '點方塊 ' + s.hits]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'cube') s.hits += 1; },
});`;
const KEYS2 = KEYS.replace("color: '#ffcc33'", "color: '#ff4433'").replace("'點方塊 ' + s.hits]", "'點方塊 ' + s.hits, '紅色 v2']");
const ORB = `vibe.define({
  init() { return { hits: 0 }; },
  tick(s) {},
  view(s) { return [
    { id: 'base', shape: 'cylinder', pos: [0, 0.05, 0], size: [1, 0.1], color: '#1b3a52' },
    { id: 'orb', shape: 'sphere', pos: [0, 1, 0], size: [0.5], color: '#33ccff' },
  ]; },
  hud(s) { return ['命中 ' + s.hits]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; },
});`;
const TOWER = `vibe.define({
  init() { return { level: 1 }; },
  tick(s) {},
  view(s) { const out = []; for (let i = 0; i < s.level; i++) out.push({ id: 'b' + i, shape: 'box', pos: [0, 0.25 + i * 0.5, 0], size: [0.8, 0.45, 0.8], color: i % 2 ? '#ffcc33' : '#33ff99' }); return out; },
  hud(s) { return ['塔高 ' + s.level]; },
  onEvent(s, ev) { if (ev.type === 'click') s.level = Math.min(12, s.level + 1); },
});`;
const STAR = TOWER.replace(/塔高/g, '星星').replace("'#ffcc33'", "'#ff66cc'");
const CATCH = readFileSync(path.join(HERE, 'fixtures', 'creation', 'catch-stars', 'main.js'), 'utf8');
const PROGRAMS = { 方向方塊: [KEYS, 1], 點球: [ORB, 1], 疊塔: [TOWER, 1], 星星塔: [STAR, 1], 接星星: [CATCH, 1] };

// ---------------- 協定測試 connector（就是測試自己） ----------------
let token = null;
let connectorOn = true;
const handled = [];
async function connectorLoop() {
  while (connectorOn) {
    if (!token) {
      await sleep(150);
      continue;
    }
    const r = await fetch(`${BASE}/api/connector/jobs?wait=2`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || r.status !== 200) continue;
    const { job } = await r.json();
    let name;
    let code;
    let schema = 1;
    if (job.target?.lineage) {
      name = job.target.name || '方向方塊';
      code = name === '方向方塊' ? KEYS2 : (PROGRAMS[name] || [TOWER])[0].replace("'#33ff99'", "'#ff4433'");
    } else {
      name = /接星星/.test(job.intent) ? '接星星' : /方向/.test(job.intent) ? '方向方塊' : /點球/.test(job.intent) ? '點球' : /星星塔/.test(job.intent) ? '星星塔' : '疊塔';
      [code, schema] = PROGRAMS[name];
    }
    if (process.env.SLOW_CONNECTOR) await sleep(Number(process.env.SLOW_CONNECTOR));
    const res = await fetch(`${BASE}/api/connector/jobs/${job.id}/package`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { format: 'vibe-pkg/1', name, description: 'fixture', stateSchema: schema, budgets: { entities: 80 } }, files: { 'main.js': code }, provenance: { tool: 'fixture', via: 'fixture', attempt: job.attempt, ms: 1 } }),
    }).then((x) => x.json());
    handled.push({ id: job.id, intent: job.intent, worldId: job.worldId, source: job.source, target: job.target?.lineage || null, baseVersion: job.target?.baseVersion ?? null, ok: res.ok, version: res.version, name });
  }
}
const loop = connectorLoop();

const launcher = pw[BROWSER];
const browser = await launcher.launch(BROWSER === 'chromium' ? { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] } : {});
const device = BROWSER === 'webkit' ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true } : { ...pw.devices['iPhone 15 landscape'], viewport: { width: 844, height: 390 } };
const errors = [];
const dialogs = [];
async function newPage(ctx, url = `${BASE}/?create`) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${BROWSER}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || /^INFO:|XNNPACK|Failed to load resource/.test(m.text())) return;
    const where = m.location()?.url || '';
    // Playwright（WebKit）截圖時會往每個 frame 塞樣式；作品沙盒的 CSP（style-src 'none'）擋下並報錯——是測試工具的雜訊（也證明沙盒 CSP 有效），另外記下、不算頁面錯誤
    if (/\/sandbox\/runner\.html/.test(where) && /Refused to apply a stylesheet/.test(m.text())) {
      report.notes.sandboxCspBlockedToolStyles = (report.notes.sandboxCspBlockedToolStyles || 0) + 1;
      return;
    }
    errors.push(`console: ${m.text()} @ ${where}:${m.location()?.lineNumber ?? ''}`);
  });
  page.on('dialog', (d) => {
    dialogs.push({ type: d.type(), message: d.message(), at: Date.now() });
    d.accept(d.type() === 'prompt' ? '' : undefined);
  });
  page.setDefaultTimeout(30000);
  await page.goto(url);
  await page.waitForFunction(() => window.__ws?.creation?.state().world && !window.__ws.creation.state().loading);
  await page.addScriptTag({ content: HELPERS });
  return page;
}
try {
  // RECORD=1：把整段操作錄成影片（tests/out/…/video/*.webm），留雙眼介面與真實操作流程的證據
  const ctx = await browser.newContext({ ...device, ...(process.env.RECORD ? { recordVideo: { dir: path.join(OUT, 'video'), size: { width: 844, height: 390 } } } : {}) });
  await ctx.addInitScript(INIT);
  const page = await newPage(ctx);
  const S = () => page.evaluate(() => window.__ws.creation.state());
  const H = () => page.evaluate(() => window.__ws.headset.state());
  const until = (fn, arg, ms = 20000) =>
    page.waitForFunction(fn, arg, { timeout: ms }).catch(async (e) => {
      const hs = await H();
      const st = await S();
      console.log('等待逾時：', JSON.stringify({ world: st.world, role: st.role, connState: st.connState, loading: st.loadingWhy, live: st.live.map((L) => `${L.name}@v${L.version}`), jobs: st.jobs.slice(-3).map((J) => `${J.intent}:${J.status}:${J.kind}`), jobText: await page.evaluate(() => document.querySelector('#cJob .txt')?.textContent) }), '\nheadset：', JSON.stringify({ menuPage: hs.menuPage, menuHover: hs.menuHover, padHover: hs.padHover, padHold: hs.padHold, hover: hs.hover, handOn: hs.handOn, gesture: hs.gesture, lastHand: hs.lastHand, menuFocus: hs.menuFocus, menuOpen: hs.menuOpen, tracker: hs.tracker, video: hs.video, liveTracks: hs.liveTracks, events: hs.stats.events, menu: hs.stats.menu, eye: hs.eye, cameraQuat: hs.cameraQuat }),
        '\n手：', JSON.stringify(await page.evaluate(() => ({ last: window.__lastHandAt, fake: window.__fakeHands.length, now: Math.round(performance.now()), visibility: document.visibilityState, hasFocus: document.hasFocus() }))), '\nconnector：', JSON.stringify(handled).slice(0, 600), '\n錯誤：', errors.slice(0, 5).join(' | '));
      throw e;
    });
  const frames = (n = 3) => page.evaluate((k) => window.__frames(k), n);
  const lookAt = (t) => page.evaluate((x) => window.__lookAt(x), t);
  const handAt = (open, t, extra) => page.evaluate(([o, x, e]) => window.__handAt(o, x, e), [open, t, extra]);
  // 張開（等狀態機「上膛」）→ 捏住（等到真的出現 pinch-start）→（release＝張開，等到放開）：照狀態走，不靠固定秒數
  // 等「這隻手（在新位置）」真的被追到、上膛：手一下跳很遠時狀態機會當成新的一隻手，要重新張開
  // expect：要指到什麼才捏（像真人一樣：先指準、看到亮起來再捏），例如 { padHover: 'left' }、{ menuHover: 'c:new' }
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
  // 手移到新位置（uv＝__handAt 回傳的畫面位置）之後每 25 ms 記一次，直到新位置被追到、指到 id 再穩 300 ms（或 ms 到）：
  // [經過 ms, 手勢狀態, 追丟次數, 重新找到次數, 收到幾筆辨識, 新位置被追到了沒, 有沒有手, 射線和目標方向的夾角°, 有沒有指到]
  // 用來分辨「射線算錯」（停穩了還差很多）和「還沒追上」（還沒看到新位置／夾角一直在縮小）
  const aimTimeline = (target, id, uv, ms = 3000) =>
    page.evaluate(async ([tw, hid, u, v, lim]) => {
      const THREE = window.__ws.THREE;
      const hs = window.__ws.headset;
      const s0 = hs.state();
      const ev0 = { ...s0.stats.events };
      const res0 = s0.tracker.results;
      const t0 = performance.now();
      const rows = [];
      let firstHover = null;
      for (;;) {
        const st = hs.state();
        const t = Math.round(performance.now() - t0);
        const p = st.lastHand?.pinch;
        const fresh = !!(p && Math.abs(p.x - u) < 0.02 && Math.abs(p.y - v) < 0.02);
        let err = null;
        if (st.pinch) {
          const eye = new THREE.Vector3().fromArray(st.eye);
          const a = new THREE.Vector3().fromArray(st.pinch).sub(eye).normalize();
          err = +THREE.MathUtils.radToDeg(a.angleTo(new THREE.Vector3().fromArray(tw).sub(eye).normalize())).toFixed(2);
        }
        const on = fresh && st.handOn && st.hover === hid;
        rows.push([t, st.gesture.status, (st.stats.events.lost || 0) - (ev0.lost || 0), (st.stats.events.acquire || 0) - (ev0.acquire || 0), st.tracker.results - res0, fresh ? 1 : 0, st.handOn ? 1 : 0, err, on ? 1 : 0]);
        if (on && firstHover === null) firstHover = t;
        if ((firstHover !== null && t - firstHover > 300) || t > lim) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const last = rows[rows.length - 1];
      const at400 = rows.filter((r) => r[0] <= 400).pop() || rows[0];
      const firstFresh = rows.find((r) => r[5])?.[0] ?? null;
      // 重新找到手的那一格：新手要馬上有射線（不被同一筆的「追丟」清掉）、而且從它自己的位置開始（不從舊手滑過來）
      const re = rows.find((r) => r[3] >= 1 && r[5]);
      const reacquire = re ? { t: re[0], handOn: !!re[6], err: re[7] } : null;
      return { firstHover, firstFresh, hz: hs.state().tracker.hz, settledErr: last[7], at400: { hover: !!at400[8], fresh: !!at400[5], handOn: !!at400[6], err: at400[7], results: at400[4] }, lost: last[2], acquire: last[3], reacquire, rows };
    }, [target, id, uv.u, uv.v, ms]);
  const aimText = (a) =>
    `新位置第 ${a.firstFresh ?? '—'} ms 被追到、第 ${a.firstHover ?? '—'} ms 指到（辨識 ${a.hz} Hz；追丟 ${a.lost}、重新找到 ${a.acquire} 次${a.reacquire ? `，重新找到那一格有手 ${a.reacquire.handOn}、夾角 ${a.reacquire.err}°` : ''}）；400 ms 時${a.at400.hover ? '已' : '還沒'}指到（新位置${a.at400.fresh ? '已' : '還沒'}追到、有手 ${a.at400.handOn}、夾角 ${a.at400.err}°、收到 ${a.at400.results} 筆）；最後夾角 ${a.settledErr}°`;
  async function press(target, extra, expect = null) {
    await tracked(await handAt(1, target, extra), expect);
    const n = (await H()).stats.events['pinch-start'] || 0;
    await handAt(0, target, extra);
    await until((k) => (window.__ws.headset.state().stats.events['pinch-start'] || 0) > k, n, 6000);
  }
  async function openHand(target, extra) {
    await handAt(1, target, extra);
    await until(() => !window.__ws.headset.state().gesture.pinched, null, 6000);
  }
  // 捏著慢慢移動（真的手是連續移動的，不會一格跳過大半個畫面）
  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  async function slide(from, to, { steps = 6, open = 0, ms = 90 } = {}) {
    for (let i = 1; i <= steps; i += 1) {
      await handAt(open, lerp3(from, to, i / steps));
      await sleep(ms);
    }
  }
  async function pinchAt(target, { holdMs = 0, release = true, expect = null } = {}) {
    await press(target, undefined, expect);
    if (holdMs) await sleep(holdMs);
    if (release) await openHand(target);
  }
  const menuPos = (id) => page.evaluate((x) => window.__menuPos(x), id);
  // 低頭看選單，用手捏一個按鈕（不等視線停留）
  // 選單平常收成「☰ 選單」頁籤：先捏它展開，再捏按鈕
  async function openMenu() {
    if ((await H()).menuOpen) return;
    await pinchAt(await page.evaluate(() => window.__menuTabPos()), { expect: { menuHover: 'menu:open' } });
    await until(() => window.__ws.headset.state().menuOpen, null, 5000);
  }
  async function pressMenu(id, { look = true } = {}) {
    if (look) await lookAt(await page.evaluate(() => window.__menuCenter()));
    await openMenu();
    await lookAt(await page.evaluate(() => window.__menuGazeSpot())); // 視線停在標題那一帶：用手捏，不靠盯著
    await until((x) => window.__ws.headset.state().menuButtons.some((b) => b.id === x), id, 5000);
    const p = await menuPos(id);
    await pinchAt(p, { expect: { menuHover: id } });
    return p;
  }
  const lookAtItem = async (hostId, ent) => lookAt(await page.evaluate(([h, e]) => window.__entityPos(h, e), [hostId, ent]));
  // 跟使用者一樣從畫面上的按鈕進（🥽 → 開始；裝盒前檢查那張卡），不直接呼叫 enter()
  const enterHeadset = async () => {
    await page.locator('#hsBtn').click();
    await page.locator('#hsGo').click();
    await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', (window.__sensor = { alpha: 0, beta: 90, gamma: 0 }))));
    await until(() => window.__ws.headset.state().active && window.__ws.headset.state().tracker.state === 'running', null, 10000);
    await page.evaluate(() => window.__noHand());
    await frames(4);
  };
  const exitHeadset = async () => {
    await page.keyboard.press('Escape');
    await until(() => !window.__ws.headset.active);
  };
  const tap = async () => {
    // 點一下螢幕（眼鏡模式的覆蓋層）：真的指標事件＝使用者手勢
    if (BROWSER === 'webkit') await page.mouse.click(422, 195);
    else await page.touchscreen.tap(422, 195);
    await sleep(80);
  };
  // caret: 'initial'：Playwright 預設會往每個 frame 塞一段藏游標的樣式，作品沙盒的 CSP（style-src 'none'）會擋下並報錯
  const shot = (name) => (process.env.NO_SHOTS ? Promise.resolve() : page.screenshot({ path: path.join(OUT, name), caret: 'initial' }));

  // ---- 配對（畫面上的配對碼 → 協定測試 connector） ----
  const code = await page.evaluate(async () => (await (await fetch('/api/connector/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).code);
  token = (await fetch(`${BASE}/api/connector/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: '測試 connector' }) }).then((r) => r.json())).token;
  check('協定測試 connector 配對好（測試自己扮演創作者的 connector）', !!token);
  // 先在 2D 介面放一個「方向方塊」（打字送出）
  await page.fill('#cInput', '做一個用方向鍵移動的方塊');
  await page.click('#cSend');
  await until(() => window.__ws.creation.state().live.some((L) => L.name === '方向方塊') && window.__ws.creation.state().host.meshes > 0);
  let s = await S();
  const cubeId = s.live.find((L) => L.name === '方向方塊').id;
  const cubeHost = () => page.evaluate((id) => window.__ws.creation.state().live.find((L) => L.id === id)?.hostId, cubeId);
  const cubeHud = () => page.evaluate((id) => window.__ws.creation.state().live.find((L) => L.id === id)?.hud.join(' ') || '', cubeId);
  const cubeX = async () => Number((await cubeHud()).match(/x (-?[\d.]+)/)?.[1]);
  report.notes.cube = cubeId;
  // 這一層還沒有某個作品就用打字做一個（各段可以單獨跑）
  async function ensureItem(name, intent) {
    if (!(await S()).live.some((L) => L.name === name)) {
      await page.evaluate(() => window.__ws.creation.setMode('new')); // 模式是明確的：前面的段落可能留在「修改」
      const wasHs = await page.evaluate(() => window.__ws.headset.active);
      if (wasHs) await page.evaluate((t) => window.__ws.creation.submit(t), intent);
      else {
        await page.fill('#cInput', intent);
        await page.click('#cSend');
      }
      await until((n) => window.__ws.creation.state().live.some((L) => L.name === n), name, 30000);
    }
    return (await S()).live.find((L) => L.name === name);
  }

  // ======================= A 新作品／修改語意 =======================
  if (SECTIONS.has('A')) {
    await page.evaluate(() => window.__ws.creation.select(null));
    await enterHeadset();
    check('眼鏡模式（創作世界）：鏡頭（假畫面）在跑、手勢 worker（假）起來了、2D 介面藏起來', (await H()).tracker.state === 'running' && (await page.evaluate(() => window.__workers.created)) >= 1 && (await page.evaluate(() => getComputedStyle(document.querySelector('#cUi')).display)) === 'none');
    check('選單一開始收成「☰ 選單」小頁籤（不擋地上的作品）', !(await H()).menuOpen);
    await lookAt(await page.evaluate(() => window.__menuCenter()));
    await openMenu();
    const main = (await H()).menuButtons.map((b) => b.id);
    check('低頭選單第一頁：新作品／改選取的／說話／取消需求／子世界／回上一層／方向鍵／更多', ['c:new', 'c:modify', 'c:voice', 'c:cancel', 'page:world', 'c:up', 'sys:pad', 'page:more'].every((id) => main.includes(id)), main.join(','));
    await lookAtItem(await cubeHost(), 'cube');
    await pinchAt(await page.evaluate(async (h) => window.__entityPos(h, 'cube'), await cubeHost()));
    await until((id) => window.__ws.creation.state().selected === id, cubeId, 5000);
    s = await S();
    const modeA = await page.evaluate(() => window.__ws.creation.headsetMode());
    const linesA = await page.evaluate(() => window.__ws.creation.headsetLines());
    check('捏一下作品＝選取＋點它，但模式還是「新作品」（不會自己變修改）；模式牌寫著說話會做新作品', s.selected === cubeId && s.mode === 'new' && /做新作品/.test(modeA.text), `${modeA.text}｜${linesA.join('／')}`);
    check('HUD 不再說「把這個改成…」：寫著要改它就低頭選「✏️ 改」', linesA.some((l) => l.includes('✏️ 改')) && !linesA.join('').includes('把這個改成'), linesA.join('／'));
    check('作品自己的 HUD（分數、狀態）在眼鏡裡看得到', /方向方塊/.test((await page.evaluate(() => window.__ws.creation.headsetGame()))?.[0] || '') && (await page.evaluate(() => window.__ws.creation.headsetGame())).some((l) => /x -?\d/.test(l)));
    await shot('a1-selected-new-mode.png');
    // 說一句（新作品）
    const jobs0 = s.jobs.length;
    await tap();
    check('點一下螢幕＝開始說話（是使用者手勢）', (await page.evaluate(() => window.__srLog.gestureStarts)) >= 1 && (await S()).voice.listening);
    await page.evaluate(() => window.__say('做一個疊', false));
    await page.evaluate(() => window.__say('做一個疊塔', true));
    await until((n) => window.__ws.creation.state().jobs.length === n + 1, jobs0);
    let j = (await S()).jobs.at(-1);
    check('模式是新作品時說「做一個疊塔」→ 新作品工作（沒有要改的目標）', j.kind === 'new' && !j.targetLineage && j.source === 'voice', JSON.stringify(j));
    // 等疊塔真的放好（放好會自動選取新作品）再去選方塊
    await until(() => window.__ws.creation.state().live.some((L) => L.name === '疊塔') && window.__ws.creation.state().live.find((L) => L.name === '疊塔').id === window.__ws.creation.state().selected, null, 30000);
    // 選單「✏️ 改」→ 修改模式
    await page.evaluate(() => window.__ws.creation.select(window.__ws.creation.state().live.find((L) => L.name === '方向方塊').id));
    await pressMenu('c:modify');
    s = await S();
    const modeB = await page.evaluate(() => window.__ws.creation.headsetMode());
    check('低頭選單捏「✏️ 改」→ 進修改模式，模式牌寫著改哪一件、哪一版', s.mode === 'modify' && s.modeTarget === cubeId && /改「方向方塊」v1/.test(modeB.text), modeB.text);
    await shot('a2-menu-modify.png');
    await lookAtItem(await cubeHost(), 'cube');
    // 讓方塊先有狀態（按幾下動作鍵）：改完要保留
    await page.keyboard.down('ArrowRight');
    await sleep(500);
    await page.keyboard.up('ArrowRight');
    await sleep(500); // 放開之後等它停穩（HUD 晚一步更新）
    const xBefore = await cubeX();
    await tap();
    const ctx = (await S()).voice.current?.context;
    check('開口那一刻記下：哪一層、改哪一件、哪一版', ctx?.mode === 'modify' && ctx.targetItem === cubeId && ctx.baseVersion === 1 && ctx.worldId === 'root', JSON.stringify(ctx));
    await page.evaluate(() => window.__say('把它改成紅色', true));
    await until((n) => window.__ws.creation.state().jobs.length === n + 2, jobs0);
    j = (await S()).jobs.at(-1);
    check('修改模式說話 → 修改工作（目標作品線、v1、那一個實例）', j.kind === 'modify' && j.targetItem === cubeId && j.baseVersion === 1 && !!j.targetLineage, JSON.stringify(j));
    await until((id) => window.__ws.creation.state().live.find((L) => L.id === id)?.version === 2, cubeId, 30000);
    await sleep(400);
    const xAfter = await cubeX();
    check('改好不用重新整理就換上 v2，位置（狀態）保留', Math.abs(xAfter - xBefore) < 0.05 && /紅色 v2/.test(await cubeHud()), `x ${xBefore} → ${xAfter}；${await cubeHud()}`);
    check('換版後還在修改模式，目標版本跟著變成 v2', /改「方向方塊」v2/.test((await page.evaluate(() => window.__ws.creation.headsetMode())).text));
    // 改選別的作品 → 回到新作品
    const towerHost = (await S()).live.find((L) => L.name === '疊塔').hostId;
    await lookAtItem(towerHost, 'b0');
    await pinchAt(await page.evaluate((h) => window.__entityPos(h, 'b0'), towerHost));
    await until(() => window.__ws.creation.state().live.find((L) => L.id === window.__ws.creation.state().selected)?.name === '疊塔', null, 5000);
    s = await S();
    check('正在改方塊時改選疊塔 → 回到新作品（不會悄悄改成改疊塔）', s.mode === 'new' && s.modeTarget === null, `mode ${s.mode}`);
    // 版本退回（更多 → 退回上一版）
    await page.evaluate((id) => window.__ws.creation.select(id), cubeId);
    await pressMenu('page:more');
    await until(() => window.__ws.headset.state().menuPage === 'more', null, 5000);
    const xR = await cubeX();
    await pressMenu('c:revert', { look: false });
    await until((id) => window.__ws.creation.state().live.find((L) => L.id === id)?.version === 1, cubeId, 15000);
    await sleep(300);
    check('選單「↶ 退回 v1」：這一層的方塊換回 v1，位置（狀態）保留', Math.abs((await cubeX()) - xR) < 0.05 && !/紅色 v2/.test(await cubeHud()), await cubeHud());
    await pressMenu('page:main', { look: false });
    // 退回 v1 之後再改：明確以 v1 為基準（送出前就有的 v2 不算衝突）→ v3 換上、狀態保留
    await pressMenu('c:modify', { look: false });
    await lookAtItem(await cubeHost(), 'cube');
    const nR = (await S()).jobs.length;
    await tap();
    await page.evaluate(() => window.__say('把它改成紅色', true));
    await until((n) => window.__ws.creation.state().jobs.length === n + 1, nR);
    const jR = (await S()).jobs.at(-1);
    await until((id) => window.__ws.creation.state().live.find((L) => L.id === id)?.version === 3, cubeId, 30000);
    check('退回 v1 後再改：以 v1 為基準做出 v3 並換上（不是衝突），狀態保留', jR.baseVersion === 1 && Math.abs((await cubeX()) - xR) < 0.05 && /紅色 v2/.test(await cubeHud()), `${JSON.stringify({ base: jR.baseVersion })}｜${await cubeHud()}`);
    await exitHeadset();
  }

  // ======================= B 開口就固定目標 =======================
  if (SECTIONS.has('B')) {
    await ensureItem('疊塔', '做一個疊塔');
    await enterHeadset();
    // B1：改方塊時開口 → 說到一半改選疊塔 → 工作仍然改方塊
    await page.evaluate((id) => window.__ws.creation.select(id), cubeId);
    await page.evaluate(() => window.__ws.creation.setMode('modify'));
    const n0 = (await S()).jobs.length;
    await tap();
    await page.evaluate(() => window.__say('把這個改', false));
    const towerId = (await S()).live.find((L) => L.name === '疊塔').id;
    await page.evaluate((id) => window.__ws.creation.select(id), towerId);
    await page.evaluate(() => window.__say('把這個改成紅色', true));
    await until((n) => window.__ws.creation.state().jobs.length === n + 1, n0);
    const jb = (await S()).jobs.at(-1);
    check('說到一半改選別的作品：工作仍然改開口時的方塊（不會改錯）', jb.kind === 'modify' && jb.targetItem === cubeId, JSON.stringify(jb));
    await until(() => window.__ws.creation.state().jobs.at(-1).status === 'built');
    // B2：在根世界開口（新作品）→ 說到一半進子世界 → 做好的作品放回根世界，不是子世界
    await page.evaluate(() => window.__ws.creation.select(null));
    const kid = await page.evaluate(() => window.__ws.creation.createChild({ ask: false }));
    const rootItems0 = (await page.evaluate(async () => (await (await fetch('/api/cworlds/root')).json()).world.items.length));
    await tap();
    await page.evaluate(() => window.__say('做一個點', false));
    await page.evaluate((w) => window.__ws.creation.enter(w), kid);
    await until((w) => window.__ws.creation.state().world.id === w && !window.__ws.creation.state().loading, kid);
    await page.evaluate(() => window.__say('做一個點球', true));
    await until(() => window.__ws.creation.state().jobs.at(-1).status === 'built', null, 20000);
    // 工作一變成 built 畫面就看得到，之後才取作品庫、把作品送進根世界（onBuilt → placeNew）：照伺服器上的數量等它放進去（最多 10 秒），
    // 不固定等 600 ms（審查環境負載高時 600 ms 不夠，2cfc2c7 的獨立驗收出現過「根 2→2」）
    const jw = (await S()).jobs.at(-1);
    const placed = await page.evaluate(async (n0) => {
      const t0 = performance.now();
      let n = n0;
      while (performance.now() - t0 < 10000) {
        n = (await (await fetch('/api/cworlds/root')).json()).world.items.length;
        if (n !== n0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { n, ms: Math.round(performance.now() - t0) };
    }, rootItems0);
    await sleep(300); // 放進去之後再看一下：不會多放一個、子世界也不會多
    const rootItems1 = await page.evaluate(async () => (await (await fetch('/api/cworlds/root')).json()).world.items.length);
    check('說到一半進子世界：新作品放回開口時的根世界（子世界沒有多東西）', jw.worldId === 'root' && placed.n === rootItems0 + 1 && rootItems1 === rootItems0 + 1 && (await S()).live.length === 0, `job ${jw.worldId}；根 ${rootItems0}→${rootItems1}（built 之後 ${placed.ms} ms 放進去）；子世界 ${(await S()).live.length}`);
    await page.evaluate(() => window.__ws.creation.goUp());
    await until(() => window.__ws.creation.state().world.id === 'root' && !window.__ws.creation.state().loading);
    await exitHeadset();
  }

  // ======================= C 取消與去重 =======================
  if (SECTIONS.has('C')) {
    await enterHeadset();
    const n0 = (await S()).jobs.length;
    await tap();
    for (const t of ['做', '做一', '做一個', '做一個會', '做一個會跳']) await page.evaluate((x) => window.__say(x, false), t);
    await sleep(200);
    check('中間結果只顯示、不派工', (await S()).jobs.length === n0 && (await page.evaluate(() => window.__ws.creation.headsetLines()))[0].includes('做一個會跳'));
    const srCancelled = await page.evaluate(() => (window.__srOld = window.__sr, 1));
    await pressMenu('c:cancel');
    await sleep(200);
    check('低頭選單「✕ 取消需求」→ 這句當場丟掉（停止聽）', !(await S()).voice.listening && (await S()).stats.voiceDropped.user >= 1);
    await page.evaluate(() => window.__say('做一個會跳的球', true, window.__srOld)); // 瀏覽器晚到的最終結果
    await sleep(800);
    check('取消後才到的最終結果：不送出', (await S()).jobs.length === n0, `jobs ${n0} → ${(await S()).jobs.length}`);
    void srCancelled;
    // 去重：同一句的最終結果重送、onend 重送 → 只一個工作；用同一個 utteranceId 再送一次 → 伺服器回同一個工作
    await tap();
    await page.evaluate(() => {
      window.__say('做一個疊塔', true);
      window.__say('做一個疊塔', true);
      setTimeout(() => window.__sr.onend?.(), 40);
    });
    await until((n) => window.__ws.creation.state().jobs.length === n + 1, n0);
    await sleep(500);
    const jobs = (await S()).jobs;
    const dup = await page.evaluate(async () => {
      const u = 'dup-test-utterance-1';
      const a = await window.__ws.creation.submit('做一個疊塔', { utteranceId: u });
      const b = await window.__ws.creation.submit('做一個疊塔', { utteranceId: u });
      return [a.id, b.id];
    });
    check('同一句（最終結果與 onend 重送）只建一個工作；同一個 utteranceId 重送 → 同一個工作', jobs.length === n0 + 1 && dup[0] === dup[1], `jobs +${jobs.length - n0}；${dup.join(' = ')}`);
    await until(() => window.__ws.creation.state().jobs.every((J) => ['built', 'failed', 'cancelled', 'conflict'].includes(J.status)), null, 30000);
    // 「說話」按鈕（凝視／捏合，不是使用者手勢）：麥克風沒允許 → 請他點螢幕、不偷開
    const st0 = await page.evaluate(() => window.__srLog.starts);
    await pressMenu('c:voice');
    await sleep(200);
    check('選單「🎙 說話」不是使用者手勢、麥克風也還沒允許 → 不偷開，提示點螢幕', (await page.evaluate(() => window.__srLog.starts)) === st0 && !(await S()).voice.listening);
    await exitHeadset();
  }

  // ======================= D 生命週期 =======================
  if (SECTIONS.has('D')) {
    for (const how of ['escape', 'long-press', 'menu', 'background', 'pagehide']) {
      await enterHeadset();
      const n0 = (await S()).jobs.length;
      const ab0 = await page.evaluate(() => window.__srLog.aborts);
      await tap();
      await page.evaluate(() => window.__say('做一個會轉的', false));
      await page.evaluate(() => (window.__srOld = window.__sr));
      if (how === 'escape') await page.keyboard.press('Escape');
      else if (how === 'long-press') {
        await page.mouse.move(422, 195);
        await page.mouse.down();
        await sleep(1350);
        await page.mouse.up();
      } else if (how === 'menu') {
        await pressMenu('page:more');
        await pressMenu('sys:exit', { look: false });
      } else if (how === 'background' || how === 'pagehide') {
        await page.evaluate((ev) => {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          if (ev === 'pagehide') window.dispatchEvent(new Event('pagehide'));
          else document.dispatchEvent(new Event('visibilitychange'));
        }, how);
      }
      await sleep(300);
      const lst = (await S()).voice.listening;
      const aborted = (await page.evaluate(() => window.__srLog.aborts)) - ab0;
      if (how === 'background' || how === 'pagehide') {
        await sleep(500);
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await page.evaluate(() => window.__say('做一個會轉的圈', true, window.__srOld)); // 回來後才到的最終結果
      await sleep(900);
      const n1 = (await S()).jobs.length;
      const text = await page.evaluate(() => document.querySelector('#cJob .txt').textContent);
      const dropped = (await S()).stats.voiceDropped;
      // pagehide 在測試裡只是模擬（頁面其實還在）：它也會交出執行權，之後的提示會被「改成只看」蓋掉，所以看計數
      const said = how === 'pagehide' ? dropped.background >= 2 : /丟掉/.test(text);
      check(`說到一半${{ escape: '按 Esc 離開眼鏡', 'long-press': '長按螢幕離開眼鏡', menu: '用選單「✕ 離開眼鏡」', background: '切到背景', pagehide: '頁面被收起（pagehide）' }[how]} → 這句當場丟掉、回來不補送`, !lst && aborted >= 1 && n1 === n0 && said, `listening ${lst} aborts +${aborted} jobs ${n0}→${n1}｜${text}｜${JSON.stringify(dropped)}`);
      if (await page.evaluate(() => window.__ws.headset.active)) await exitHeadset();
      if (how === 'pagehide') {
        // 模擬的 pagehide 交出了執行權：按一下方向鍵拿回來（後面的段落要當執行者）
        await page.keyboard.press('ArrowUp');
        await until(() => window.__ws.creation.state().role === 'leader' && !window.__ws.creation.state().loading, null, 15000);
      }
    }
  }

  // ======================= E 選單捏合不穿透 =======================
  if (SECTIONS.has('E')) {
    const orb = await ensureItem('點球', '做一個點球');
    const hits = async () => Number((await S()).live.find((L) => L.id === orb.id).hud[0].match(/\d+/)[0]);
    await enterHeadset();
    await lookAtItem(orb.hostId, 'orb');
    // 先證明：手指著球、捏下去會點到它（命中 +1）
    const h0 = await hits();
    await pinchAt(await page.evaluate((h) => window.__entityPos(h, 'orb'), orb.hostId));
    await until(([id, n]) => Number(window.__ws.creation.state().live.find((L) => L.id === id).hud[0].match(/\d+/)[0]) > n, [orb.id, h0], 5000).catch(() => {});
    const h1 = await hits();
    check('對照：選單不擋的時候，捏球會點到它', h1 === h0 + 1, `${h0} → ${h1}`);
    // 把選單移到眼睛和球中間：「🎙 說話」按鈕剛好擋在球前面（只動測試場景裡選單的位置）
    const placeMenuBlocking = (btn) =>
      page.evaluate(
        ([h, id]) => {
          const ws = window.__ws;
          const THREE = ws.THREE;
          const eye = new THREE.Vector3().fromArray(ws.headset.state().eye);
          const orbP = new THREE.Vector3().fromArray(window.__entityPos(h, 'orb'));
          const P = eye.clone().lerp(orbP, 0.45);
          const m = ws.scene.getObjectByName('headset-menu');
          m.position.copy(P);
          m.lookAt(eye);
          m.updateMatrixWorld(true);
          if (id) {
            let b = null;
            m.traverse((c) => c.userData.buttonId === id && (b = c));
            const Q = b.getWorldPosition(new THREE.Vector3());
            m.position.add(P.clone().sub(Q));
            m.updateMatrixWorld(true);
          }
          return orbP.toArray();
        },
        [orb.hostId, btn],
      );
    // 先低頭把選單展開（捏「☰ 選單」），再把它移到球前面
    await lookAt(await page.evaluate(() => window.__menuCenter()));
    await openMenu();
    const orbP = await placeMenuBlocking('c:new');
    await page.evaluate((id) => window.__ws.creation.select(id), orb.id);
    await page.evaluate(() => window.__ws.creation.setMode('modify'));
    // 頭往上看一點（視線不碰到選單，免得「盯著」也會按下去）；手照樣指著球的方向
    await lookAt([orbP[0], orbP[1] + 0.5, orbP[2]]);
    await tracked(await handAt(1, orbP));
    await sleep(250);
    const hv = await H();
    check('手指著球、但「✨ 新作品」按鈕擋在前面：指到的是選單按鈕，不是球', hv.menuHover === 'c:new' && hv.hover === null, `menuHover ${hv.menuHover} hover ${hv.hover}`);
    await shot('e1-menu-blocks-world.png');
    const pinch0 = hv.stats.menu.pinch;
    await press(orbP);
    await openHand(orbP);
    await sleep(200);
    const after = await H();
    check('捏下去：按到「✨ 新作品」（模式回到新作品），球沒有被點到', after.stats.menu.pinch === pinch0 + 1 && after.stats.menu.last?.id === 'c:new' && (await S()).mode === 'new' && (await hits()) === h1, `menu pinch +${after.stats.menu.pinch - pinch0}；命中 ${h1} → ${await hits()}`);
    // 選單的空隙（底板）擋在前面：捏下去什麼都不做，也不穿過去
    await placeMenuBlocking(null);
    await tracked(await handAt(1, orbP));
    await sleep(250);
    const hv2 = await H();
    const blocked0 = hv2.stats.menu.blocked;
    await press(orbP);
    await openHand(orbP);
    await sleep(200);
    check('選單按鈕之間的空隙（底板）擋在球前面：捏下去不穿透（球沒被點到）', hv2.menuHover === 'plate' && (await H()).stats.menu.blocked === blocked0 + 1 && (await hits()) === h1, `menuHover ${hv2.menuHover}；命中 ${await hits()}`);
    await page.evaluate(() => window.__ws.headset.recenter()); // 選單放回原位
    // 視線和手都離開選單 3 秒：自己收回小頁籤
    await lookAt(await page.evaluate(() => window.__menuCenter()));
    await openMenu();
    const openBefore = (await H()).menuOpen;
    await page.evaluate(() => window.__noHand());
    await lookAt(await page.evaluate((h) => window.__entityPos(h, 'orb'), orb.hostId));
    await until(() => !window.__ws.headset.state().menuOpen, null, 6000).catch(() => {});
    check('展開的選單：視線和手都離開 3 秒就收回「☰ 選單」頁籤', openBefore && !(await H()).menuOpen);
    await exitHeadset();
  }

  // ======================= F 方向鍵 =======================
  if (SECTIONS.has('F')) {
    // 同場景證據（每一步記一次）：按鍵、執行權／載入中、runner 的實例狀態與累積時間 t（有在跑就會一直加）、看門狗逾時數、
    // 方塊位置、眼鏡裡看到的 HUD、伺服器上的存檔（leader 每幾秒存一次，會落後一點）
    const fTrace = (report.notes.fTrace = []);
    const trace = async (label, pg = page) => {
      const row = await pg.evaluate(async ([id, lb]) => {
        const c = window.__ws.creation;
        const s = c.state();
        const L = s.live.find((x) => x.id === id);
        const inst = c.host().instances().find((i) => i.id === L?.hostId);
        let saved = null;
        try {
          const w = (await (await fetch(`/api/cworlds/${s.world.id}`)).json()).world;
          const st = w.items.find((it) => it.id === id)?.state;
          saved = st ? { x: st.x, keys: st.keys, act: st.act } : null;
        } catch {
          saved = 'read-failed';
        }
        return {
          label: lb, at: Math.round(performance.now()), role: s.role, loading: s.loadingWhy || (s.loading ? 'yes' : ''), keys: Object.entries(s.keys).filter(([, v]) => v).map(([k]) => k).join('+') || '-',
          inst: inst ? { status: inst.status, t: +inst.t.toFixed(2), error: inst.error || '' } : null, timeouts: s.host?.timeouts ?? null, workers: s.host?.workers ?? null,
          hud: L?.hud.join(' ') || '', headsetHud: (c.headsetGame() || []).join(' / '), saved, saves: s.stats.saves,
        };
      }, [cubeId, label]);
      fTrace.push(row);
      return row;
    };
    await enterHeadset();
    await page.evaluate((id) => window.__ws.creation.select(id), cubeId);
    check('方向鍵一開始是收起來的', !(await H()).padVisible);
    await pressMenu('sys:pad');
    await lookAtItem(await cubeHost(), 'cube');
    await until(() => window.__ws.headset.state().padShown, null, 5000);
    // 前提：方塊真的在這個分頁的 runner 裡跑（leader、沒在載入、實例 running、看門狗沒停過任何作品）——否則後面「不會動」不是方向鍵的問題
    const f0 = await trace('F 開始');
    await sleep(300);
    const fT0 = await trace('F 開始＋0.3 秒');
    check('F 前提：方塊在這個分頁的 runner 裡跑著（leader、沒在載入、實例 running、累積時間在加、看門狗 0 次逾時）',
      f0.role === 'leader' && !f0.loading && f0.inst?.status === 'running' && fT0.inst?.t > f0.inst.t && f0.timeouts === 0,
      `${f0.role} 載入「${f0.loading}」 ${JSON.stringify(f0.inst)} → t ${fT0.inst?.t}；逾時 ${f0.timeouts}；HUD ${f0.hud}`);
    const padPos = (k) => page.evaluate((x) => window.__padPos(x), k);
    const menuOpacity = await page.evaluate(() => {
      const ops = [];
      window.__ws.scene.getObjectByName('headset-menu').traverse((c) => c.userData.buttonId && c.material && ops.push(c.material.opacity));
      return Math.max(...ops);
    });
    check('方向鍵開著、沒在看選單：選單變淡（捏在上面只提示、不會按到）', menuOpacity < 0.5 && !(await H()).menuFocus, `opacity ${menuOpacity}`);
    const holdPad = async (k) => {
      await press(await padPos(k), undefined, { padHover: k });
      await until((x) => window.__ws.headset.state().padHold === x, k, 4000);
    };
    // 按著 key 的期間，等作品 HUD 上的 x 走了 dx（最多 5 秒）；記下牆鐘時間、這個實例在 runner 裡前進的時間 t（作品自己的時間）、
    // 期間按鍵有沒有一直是這一個（不會跳回別的鍵）。dx 照作品的速度（每秒 1.5）換算，大約是 0.2 秒的作品時間
    const moveWhileHeld = (key, dx) =>
      page.evaluate(async ([id, k, d]) => {
        const c = window.__ws.creation;
        const xOf = () => Number((c.state().live.find((L) => L.id === id)?.hud[0] || '').match(/x (-?[\d.]+)/)?.[1]);
        const tOf = () => c.host().instances().find((i) => i.id === c.state().live.find((L) => L.id === id)?.hostId)?.t ?? NaN;
        const x0 = xOf();
        const t0 = tOf();
        const w0 = performance.now();
        let other = 0;
        let x = x0;
        while (performance.now() - w0 < 5000) {
          const keys = c.state().keys;
          if (!keys[k] || Object.entries(keys).some(([n, v]) => v && n !== k)) other += 1;
          x = xOf();
          if (d < 0 ? x <= x0 + d : x >= x0 + d) break;
          await new Promise((r) => setTimeout(r, 30));
        }
        const ms = Math.round(performance.now() - w0);
        const simT = +(tOf() - t0).toFixed(2);
        const ok = (d < 0 ? x <= x0 + d : x >= x0 + d) && other === 0;
        return { ok, ms, simT, other, text: `按著 ${ms} ms 走了 ${(x - x0).toFixed(2)}；作品時間 +${simT} s${other ? `；期間按鍵不對 ${other} 次` : ''}` };
      }, [cubeId, key, dx]);
    // 捏住「◀ 左」→ 按住
    const x0 = await cubeX();
    await handAt(1, await padPos('left'));
    await until(() => window.__ws.headset.state().padHover === 'left', null, 6000);
    check('手指著「◀ 左」：提示捏住＝按住', (await H()).padHover === 'left');
    await shot('f1-pad-hover.png');
    await holdPad('left');
    // 按住期間照狀態等方塊走 0.3（最多 5 秒）：機器忙的時候同樣的牆鐘時間裡作品跑得比較少步，不用固定秒數判斷
    const mvL = await moveWhileHeld('left', -0.3);
    const kHeld = (await S()).keys;
    const x1 = await cubeX();
    await trace('捏住「◀ 左」走了 0.3');
    check('捏住「◀ 左」＝按住左：方塊往左走', kHeld.left && x1 < x0 - 0.3 && mvL.ok, `x ${x0} → ${x1}（${mvL.text}）；keys ${JSON.stringify(kHeld)}`);
    await shot('f2-pad-hold-left.png');
    // 捏著慢慢滑到「右 ▶」（經過中間的 ⚡＝暫時不按）→ 換成右
    await slide(await padPos('left'), await padPos('right'), { steps: 8 });
    await until(() => window.__ws.headset.state().padHold === 'right', null, 4000);
    const xr = await cubeX();
    const mvR = await moveWhileHeld('right', 0.3);
    const kSlide = (await S()).keys;
    const x2 = await cubeX();
    await trace('捏著滑到「右 ▶」走了 0.3');
    check('捏著滑到「右 ▶」：換成按右（左放開；滑過中間的 ⚡ 沒按到動作）', kSlide.right && !kSlide.left && x2 > xr + 0.29 && mvR.ok && !/動作 [1-9]/.test(await cubeHud()), `換到右時 x ${xr} → ${x2}（${mvR.text}）；${await cubeHud()}`);
    // 張開手 → 放開
    await openHand(await padPos('right'));
    await sleep(100);
    const kOpen = (await S()).keys;
    const x3 = await cubeX();
    await sleep(500);
    await trace('張開手 0.5 秒');
    check('張開手指：全部放開、方塊停住', !Object.values(kOpen).some(Boolean) && Math.abs((await cubeX()) - x3) < 0.02, JSON.stringify(kOpen));
    // 捏著滑出方向鍵：放開
    await holdPad('left');
    const cubeP = await page.evaluate(async (h) => window.__entityPos(h, 'cube'), await cubeHost());
    await slide(await padPos('left'), cubeP, { steps: 6 });
    await until(() => !window.__ws.headset.state().padHold, null, 4000);
    check('捏著滑出方向鍵：放開（要再捏一次才會按）', !(await S()).keys.left && (await H()).stats.pad.releases['slide-off'] >= 1, JSON.stringify((await H()).stats.pad.releases));
    await openHand(cubeP);
    // ⚡ 動作：捏一下
    const act0 = Number((await cubeHud()).match(/動作 (\d+)/)[1]);
    await pinchAt(await padPos('action'), { expect: { padHover: 'action' } });
    await sleep(300);
    await trace('捏一下「⚡ 動作」');
    check('捏一下「⚡ 動作」＝按一下動作鍵', Number((await cubeHud()).match(/動作 (\d+)/)[1]) === act0 + 1, await cubeHud());
    // 主執行緒連續卡住兩次（接手時重新載入作品實測 984＋859 ms），而且這段期間辨識結果都還沒回來（假辨識延遲 3 秒）：
    // 手其實一直在，按著的鍵不能被當成追丟放掉——卡住的時間不算「沒看到手」
    await holdPad('left');
    const stallLost0 = (await H()).stats.pad.releases.lost || 0;
    const sent0 = (await H()).tracker.framesSent;
    await page.evaluate(() => (window.__fakeHandDelayMs = 3000));
    await until((n) => window.__ws.headset.state().tracker.framesSent > n, sent0, 3000); // 下一筆辨識（3 秒才回）已經送出
    const stallRes = await page.evaluate(async () => {
      const busy = (ms) => {
        const t = performance.now();
        while (performance.now() - t < ms) { /* 長任務 */ }
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      busy(900);
      await frame();
      busy(900);
      await frame();
      await frame();
      const st = window.__ws.headset.state();
      return { left: window.__ws.creation.state().keys.left, padHold: st.padHold, lost: st.stats.pad.releases.lost || 0, status: st.gesture.status };
    });
    await page.evaluate(() => (window.__fakeHandDelayMs = 3));
    check('主執行緒連續卡住兩次（各 0.9 秒、期間辨識結果還沒回來）：手一直在，按著的「◀ 左」不會被當成追丟放開', stallRes.left && stallRes.padHold === 'left' && stallRes.lost === stallLost0, JSON.stringify(stallRes));
    await openHand(await padPos('left'));
    await until(() => !window.__ws.headset.state().padHold && !window.__ws.creation.state().keys.left, null, 8000);
    // 追丟：按住左 → 手不見 → 寬限後放開
    await holdPad('left');
    const lostHeld = (await S()).keys.left;
    await page.evaluate(() => window.__noHand());
    await until(() => !window.__ws.creation.state().keys.left, null, 3000).catch(() => {});
    const kLost = (await S()).keys;
    const xl = await cubeX();
    await sleep(500);
    await trace('按住左時追丟手');
    check('按住左時追丟手：寬限過後放開，方塊不會一直走', lostHeld && !kLost.left && Math.abs((await cubeX()) - xl) < 0.02 && (await H()).stats.pad.releases.lost >= 1, JSON.stringify((await H()).stats.pad.releases));
    await sleep(400);
    // 離開眼鏡時正按著 → 放開
    await holdPad('left');
    const heldBeforeExit = (await S()).keys.left;
    await page.keyboard.press('Escape');
    await until(() => !window.__ws.headset.active);
    const kExit = (await S()).keys;
    await trace('按住左時離開眼鏡');
    check('按住左時離開眼鏡：全部放開', heldBeforeExit && !Object.values(kExit).some(Boolean), JSON.stringify(kExit));
    // 切到背景時按著 → 放開；換層時按著 → 放開
    await enterHeadset();
    await pressMenu('sys:pad');
    await lookAtItem(await cubeHost(), 'cube');
    await until(() => window.__ws.headset.state().padShown, null, 5000);
    await holdPad('left');
    const held2 = (await S()).keys.left;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(200);
    const kBg = (await S()).keys;
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    check('按住左時切到背景：全部放開', held2 && !Object.values(kBg).some(Boolean), JSON.stringify(kBg));
    await until(() => window.__ws.headset.state().tracker.state === 'running', null, 8000);
    await page.evaluate(() => window.__noHand());
    await sleep(500);
    await holdPad('left');
    const held3 = (await S()).keys.left;
    const child = await page.evaluate(() => window.__ws.creation.createChild({ ask: false }));
    await page.evaluate((w) => window.__ws.creation.enter(w), child);
    await sleep(50);
    const kEnter = (await S()).keys;
    await until((w) => window.__ws.creation.state().world.id === w && !window.__ws.creation.state().loading, child);
    await sleep(200);
    check('按住左時換到子世界：一換層就全部放開（新的一層不會被「按著」），眼鏡的方向鍵也跟著放開', held3 && !kEnter.left && (await S()).stats.keyReleases.enter >= 1 && !(await H()).padHold && (await H()).stats.pad.releases.external >= 1, `${JSON.stringify((await S()).stats.keyReleases)}｜pad ${JSON.stringify((await H()).stats.pad.releases)}`);
    await page.evaluate(() => window.__noHand());
    await sleep(600);
    await page.evaluate(() => window.__ws.creation.goUp());
    await until(() => window.__ws.creation.state().world.id === 'root' && !window.__ws.creation.state().loading);
    await exitHeadset();
    // 只看的分頁：眼鏡裡按住方向鍵＝接手（有「接手中」，接手完才動）
    const page2 = await newPage(ctx);
    await page2.bringToFront();
    await page2.waitForFunction(() => window.__ws.creation.state().live.length > 0);
    // 讓 page2 先接手（點方塊）→ 原本的 page 變成只看
    await page2.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })));
    await page2.waitForFunction(() => window.__ws.creation.state().role === 'leader', null, { timeout: 15000 });
    await page2.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp' })));
    await page.bringToFront();
    await until(() => window.__ws.creation.state().role === 'follower', null, 10000);
    await enterHeadset();
    await page.evaluate((id) => window.__ws.creation.select(id), cubeId);
    // 只看的分頁戴著眼鏡：另一個分頁每 1.5 秒存一次，這邊跟著同步——版本沒變的作品要在原地照存檔更新（不新建畫面物件），
    // 不然每次都整個拆掉重建、重新編譯著色器（軟體繪圖下每次卡約 700 ms，畫面剩 5 fps、手追不到）
    const probe = await page.evaluate(async () => {
      const hs = window.__ws.headset;
      const c = window.__ws.creation;
      const lt = [];
      let ob = null;
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        ob = new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]); });
        ob.observe({ type: 'longtask' });
      }
      const s0 = hs.state().tracker;
      const c0 = c.state();
      const t0 = performance.now();
      let frames = 0;
      await new Promise((res) => {
        const f = () => {
          frames += 1;
          if (performance.now() - t0 < 5000) requestAnimationFrame(f);
          else res();
        };
        requestAnimationFrame(f);
      });
      ob?.disconnect();
      const s1 = hs.state().tracker;
      const c1 = c.state();
      return { role: c1.role, frames, results: s1.results - s0.results, stale: s1.stale - s0.stale, resyncs: c1.stats.resyncs - c0.stats.resyncs, restarts: c1.stats.restarts - c0.stats.restarts, meshesCreated: c1.host.createdMeshes - c0.host.createdMeshes, items: c1.live.length, longTasks: ob ? lt : 'unsupported' };
    });
    report.notes.followerProbe = probe;
    check('只看的分頁戴著眼鏡跟著存檔同步：版本沒變的作品原地照存檔更新（不新建畫面物件、不整個重建）', probe.role === 'follower' && probe.resyncs >= 1 && probe.restarts > 0 && probe.restarts >= (probe.resyncs - 1) * probe.items && probe.meshesCreated === 0,
      `5 秒內同步 ${probe.resyncs} 次、原地更新 ${probe.restarts} 件、新建 mesh ${probe.meshesCreated}；畫面 ${probe.frames} 格、辨識 ${probe.results} 筆（過期 ${probe.stale}）；長任務 ${JSON.stringify(probe.longTasks)}`);
    await pressMenu('sys:pad');
    await lookAtItem(await cubeHost(), 'cube');
    await until(() => window.__ws.headset.state().padShown, null, 5000);
    const fx0 = await page2.evaluate((id) => Number(window.__ws.creation.state().live.find((L) => L.id === id).hud[0].match(/x (-?[\d.]+)/)[1]), cubeId);
    const roleBefore = (await S()).role;
    const tk0 = (await S()).stats.loadings.takeover || 0;
    await trace('只看的分頁：接手前');
    await press(await padPos('right'), undefined, { padHover: 'right' });
    await until(() => window.__ws.creation.state().role === 'leader' && !window.__ws.creation.state().loading, null, 15000);
    // 按著的方向在接手完成後照著動（兩個分頁＋雙眼在軟體繪圖下很慢：等它真的動，不靠固定秒數）
    await until(([id, x0]) => Number(window.__ws.creation.state().live.find((L) => L.id === id)?.hud[0].match(/x (-?[\d.]+)/)?.[1]) > x0 + 0.2, [cubeId, fx0], 10000).catch(() => {});
    const tk1 = (await S()).stats.loadings.takeover || 0;
    const fx1 = await cubeX();
    await trace('只看的分頁：按住右接手後');
    await openHand(await padPos('right'));
    check('只看的分頁在眼鏡裡按住「右 ▶」＝接手：接手時標「接手中」（載入狀態），接手完照按住的方向動（從最新存檔接著），放開就停', roleBefore === 'follower' && tk1 === tk0 + 1 && fx1 > fx0 + 0.2 && !(await S()).keys.right, `接手 ${tk0} → ${tk1}；x ${fx0} → ${fx1}；keys ${JSON.stringify((await S()).keys)}；放開 ${JSON.stringify((await S()).stats.keyReleases)}／${JSON.stringify((await H()).stats.pad.releases)}`);
    await page.evaluate(() => window.__noHand());
    // page2 變成只看：同步重建時也標載入中（resync；只看的分頁在背景、計時器被節流，所以看計數）
    const r0 = (await page2.evaluate(() => window.__ws.creation.state().stats.loadings.resync)) || 0;
    await page.keyboard.down('ArrowLeft');
    await sleep(2500);
    await page.keyboard.up('ArrowLeft');
    await page2.waitForTimeout(1800);
    const p2 = await page2.evaluate(() => window.__ws.creation.state());
    check('只看的分頁跟著存檔同步重建時，也標「載入中」（原因 resync）、重建完就清掉', p2.role === 'follower' && (p2.stats.loadings.resync || 0) > r0 && !p2.loading, `resync ${r0} → ${p2.stats.loadings.resync}`);
    await exitHeadset();
    await page2.close();
    await until(() => window.__ws.creation.state().role === 'leader', null, 15000);
    const fEnd = await trace('F 結束');
    const fDead = fTrace.filter((r) => r.inst && r.inst.status !== 'running');
    check('F 全程：方塊沒有被看門狗停掉（每一步實例都 running、這個分頁的逾時 0）', !fDead.length && fEnd.timeouts === 0, fDead.length ? JSON.stringify(fDead[0]) : `${fTrace.length} 步都 running；逾時 ${fEnd.timeouts}`);
  }

  // ======================= G 真生成過的接星星 =======================
  if (SECTIONS.has('G')) {
    await ensureItem('接星星', '做一個接星星小遊戲');
    const playCatch = async (label) => {
      const L = (await S()).live.find((x) => x.name === '接星星');
      await page.evaluate((id) => window.__ws.creation.select(id), L.id);
      const hudOf = async () => (await S()).live.find((x) => x.id === L.id)?.hud || [];
      const scoreOf = async () => Number((await hudOf())[0]?.match(/分數 (\d+)/)?.[1] ?? 0);
      if (!(await H()).padOn) await pressMenu('sys:pad');
      await lookAt(await page.evaluate((h) => window.__entityPos(h, 'basket'), L.hostId));
      await until(() => window.__ws.headset.state().padShown, null, 5000);
      const hints = (await hudOf()).join(' ');
      const s0 = await scoreOf();
      const padP = (k) => page.evaluate((x) => window.__padPos(x), k);
      let pinched = false;
      let cur = null; // 捏著時現在在哪一顆（left／right；null＝中間不按）
      const t0 = Date.now();
      let moves = 0;
      let sMove = null; // 第一次用方向鍵時的分數：之後還要再接到星星才算（星星剛好掉進原地的籃子不算）
      const trail = [];
      (report.notes.catchTrail ??= {})[label] = trail;
      while (Date.now() - t0 < 45000 && !(sMove != null && (await scoreOf()) > sMove)) {
        const hud = await hudOf();
        if (/遊戲結束/.test(hud.join(' '))) {
          if (pinched) await openHand(await padP(cur || 'action'));
          pinched = false;
          await pinchAt(await padP('action'), { expect: { padHover: 'action' } }); // ⚡ 重新開始
          continue;
        }
        const stars = await page.evaluate((h) => window.__entities(h, 'star').filter((e) => !e.id.includes('tip')), L.hostId);
        const basket = await page.evaluate((h) => window.__entityPos(h, 'basket'), L.hostId);
        if (!stars.length || !basket) {
          await sleep(120);
          continue;
        }
        stars.sort((a, b) => a.pos[1] - b.pos[1]);
        const dx = stars[0].pos[0] - basket[0];
        const want = Math.abs(dx) < 0.12 ? null : dx < 0 ? 'left' : 'right';
        // 記錄（沒接到時查得到原因）：經過秒數、籃子 x、最低那顆星 x／y、想按的鍵、現在按著的鍵、HUD 第一行
        trail.push([((Date.now() - t0) / 1000).toFixed(1), +basket[0].toFixed(2), +stars[0].pos[0].toFixed(2), +stars[0].pos[1].toFixed(2), want || '-', cur || '-', hud[0] || '']);
        if (trail.length > 80) trail.shift();
        if (!pinched) {
          if (want) {
            await press(await padP(want), undefined, { padHover: want }); // 捏住方向鍵
            pinched = true;
            cur = want;
            moves += 1;
            if (sMove == null) sMove = await scoreOf();
          }
        } else if (want !== cur) {
          await slide(await padP(cur || 'action'), await padP(want || 'action'), { steps: 3, ms: 70 }); // 捏著滑過去
          cur = want;
          if (want) moves += 1;
          if (want && sMove == null) sMove = await scoreOf();
        }
        await sleep(80);
      }
      if (pinched) await openHand(await padP(cur || 'action'));
      await sleep(300);
      const s1 = await scoreOf();
      check(`${label}：用眼鏡裡的方向鍵移動籃子接到星星（用方向鍵之後分數 ${sMove ?? '—'} → ${s1}，方向鍵 ${moves} 次）`, sMove != null && s1 > sMove && moves > 0, (await hudOf()).join('｜'));
      return { hints, s0, s1 };
    };
    await enterHeadset();
    const r1 = await playCatch('真生成過的「接星星」（fixture 原樣）在根世界');
    check('接星星自己的 HUD 在眼鏡裡看得到（分數、剩下機會、操作說明）', /分數/.test(r1.hints) && /方向鍵/.test(r1.hints), r1.hints);
    await shot('g1-catch-stars-headset.png');
    // 到子世界放同一個作品、用同一套方向鍵玩
    await pressMenu('page:world');
    await pressMenu('c:child', { look: false });
    await until(() => window.__ws.creation.state().world && window.__ws.headset.state().menuButtons.some((b) => b.id.startsWith('c:enter:')), null, 8000);
    const enterId = (await H()).menuButtons.find((b) => b.id.startsWith('c:enter:')).id;
    await pressMenu(enterId, { look: false });
    await until((w) => window.__ws.creation.state().world.id === w && !window.__ws.creation.state().loading, enterId.slice(8));
    await pressMenu('page:world');
    await pressMenu('page:place', { look: false });
    const placeId = (await H()).menuButtons.find((b) => b.id.startsWith('c:place:') && b.label.includes('接星星'))?.id;
    check('子世界裡的「🧩 放作品」看得到接星星', !!placeId, (await H()).menuButtons.map((b) => b.label).join(','));
    await pressMenu(placeId, { look: false });
    await until(() => window.__ws.creation.state().live.some((L) => L.name === '接星星'), null, 10000);
    await playCatch('同一個接星星放進子世界，用同一套方向鍵玩');
    await shot('g2-catch-stars-child-world.png');
    await pressMenu('c:up');
    await until(() => window.__ws.creation.state().world.id === 'root' && !window.__ws.creation.state().loading);
    await exitHeadset();
  }

  // ======================= H 子世界 A→B→C =======================
  if (SECTIONS.has('H')) {
    const d0 = dialogs.length;
    await enterHeadset();
    const loadingSamples = [];
    const goChild = async () => {
      const before = (await S()).world;
      await pressMenu('page:world');
      await pressMenu('c:child', { look: false });
      await until((n) => window.__ws.creation.state().world.portals === n + 1, before.portals, 8000);
      await sleep(200);
      const btn = (await H()).menuButtons.find((b) => b.id.startsWith('c:enter:'));
      await page.evaluate(() => {
        window.__ls = [];
        window.__lsT = setInterval(() => window.__ls.push([window.__ws.creation.state().loading, window.__ws.creation.headsetMode().text]), 4);
      });
      await pressMenu(btn.id, { look: false });
      await until((w) => window.__ws.creation.state().world.id === w && !window.__ws.creation.state().loading, btn.id.slice(8));
      loadingSamples.push(await page.evaluate(() => (clearInterval(window.__lsT), window.__ls)));
      return { label: btn.label, world: (await S()).world };
    };
    const B = await goChild();
    const C = await goChild();
    check('A→B→C 全程用低頭選單開子世界、進入（預設名字、不跳打字視窗）', B.world.depth === 1 && C.world.depth === 2 && dialogs.length === d0 && /第1層/.test(B.world.name) && /第2層/.test(C.world.name), `${B.world.name} → ${C.world.name}；dialogs ${dialogs.length - d0}`);
    check('進入子世界途中標「載入中」，模式牌寫著在載入', loadingSamples.every((ls) => ls.some(([l, t]) => l && /載入/.test(t))), loadingSamples.map((ls) => ls.filter(([l]) => l).length).join(','));
    await shot('h1-world-c-menu.png');
    // 在 C 用說的做一個作品
    const n0 = (await S()).jobs.length;
    await lookAt([0, 1, -1]);
    await tap();
    await page.evaluate(() => window.__say('做一個星星塔', true));
    await until((n) => window.__ws.creation.state().jobs.length === n + 1, n0);
    await until(() => window.__ws.creation.state().live.some((L) => L.name === '星星塔'), null, 20000);
    const starLin = (await S()).live.find((L) => L.name === '星星塔').lineage;
    check('在 C 層戴著用說的做出「星星塔」（放在 C）', (await S()).world.depth === 2);
    // 回 A
    await pressMenu('c:up');
    await until(() => window.__ws.creation.state().world.depth === 1 && !window.__ws.creation.state().loading);
    await pressMenu('c:up');
    await until(() => window.__ws.creation.state().world.id === 'root' && !window.__ws.creation.state().loading);
    await pressMenu('page:world');
    await pressMenu('page:place', { look: false });
    const first = (await H()).menuButtons.find((b) => b.id.startsWith('c:place:'));
    check('回到 A 打開「🧩 放作品」：C 層剛做的星星塔在第一個', first?.id === `c:place:${starLin}`, first?.label);
    await shot('h2-place-inner-work.png');
    const cnt0 = (await S()).live.filter((L) => L.lineage === starLin).length;
    await pressMenu(first.id, { look: false });
    await until(([lin, n]) => window.__ws.creation.state().live.filter((L) => L.lineage === lin).length === n + 1, [starLin, cnt0], 10000);
    check('從 A 放出 C 的作品（取回內層作品）：同一個作品庫、A 多一個實例', true);
    await exitHeadset();
  }

  // ======================= I 反覆進出 =======================
  if (SECTIONS.has('I')) {
    await page.evaluate(() => window.__ws.creation.select(null));
    const base = await page.evaluate(() => ({ listeners: window.__listenerCounts(), mem: { ...window.__ws.renderer.info.memory } }));
    for (let i = 0; i < 5; i += 1) {
      await enterHeadset();
      await pressMenu('sys:pad');
      await tap();
      await page.evaluate(() => window.__say('做一個', false));
      await exitHeadset();
    }
    await sleep(500);
    const after = await page.evaluate(() => ({
      listeners: window.__listenerCounts(),
      mem: { ...window.__ws.renderer.info.memory },
      tracks: window.__trackStates(),
      workers: window.__workers,
      leftovers: ['headset-menu', 'headset-hud', 'headset-hand', 'headset-align', 'headset-pad'].filter((n) => window.__ws.scene.getObjectByName(n)),
      body: document.body.className,
      overlay: !!document.querySelector('.hs-overlay'),
      listening: window.__ws.creation.state().voice.listening,
      keys: window.__ws.creation.state().keys,
    }));
    const same = JSON.stringify(after.listeners) === JSON.stringify(base.listeners);
    check('反覆進出 5 次：鏡頭串流全部關掉（readyState ended）', after.tracks.every((t) => t === 'ended'), after.tracks.join(','));
    check('反覆進出 5 次：手勢 worker 開幾個就關幾個', after.workers.created === after.workers.terminated && after.workers.created >= 5, JSON.stringify(after.workers));
    check('反覆進出 5 次：語音沒有在聽、方向鍵沒有按著', !after.listening && !Object.values(after.keys).some(Boolean));
    check('反覆進出 5 次：window／document 的事件監聽回到原來', same, `前 ${JSON.stringify(base.listeners)}\n後 ${JSON.stringify(after.listeners)}`);
    check('反覆進出 5 次：選單、HUD、手、對位、方向鍵物件都移除，畫面覆蓋層也拿掉', !after.leftovers.length && !/headset/.test(after.body) && !after.overlay, after.leftovers.join(','));
    check('反覆進出 5 次：GPU 資源（geometry／texture）回到原來', after.mem.geometries <= base.mem.geometries + 2 && after.mem.textures <= base.mem.textures + 2, `前 ${JSON.stringify(base.mem)} 後 ${JSON.stringify(after.mem)}`);
    report.notes.cleanup = { base, after };
  }

  // ======================= J 裝盒前檢查 =======================
  if (SECTIONS.has('J')) {
    await page.evaluate(() => window.__ws.headset.open());
    await page.locator('#hsReady').waitFor();
    await until(() => document.querySelector('#hsReady li[data-k="handModel"]')?.dataset.s !== 'untested', null, 8000);
    const statusOf = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#hsReady li[data-k]')].map((li) => [li.dataset.k, li.dataset.s])));
    let st = await statusOf();
    check('裝盒前檢查：本機 http（安全來源）只讓「安全連線」通過，語音、鏡頭、動作感測、左右眼都還是「未測」', st.secure === 'pass' && st.voice === 'untested' && st.camera === 'untested' && st.motion === 'untested' && st.eyes === 'untested', JSON.stringify(st));
    check('裝盒前檢查：結論寫「還不能說準備好」', /還不能說準備好/.test(await page.locator('#hsReady .hs-verdict').innerText()));
    await shot('j1-ready-untested.png');
    // 語音：在 click 裡開始（使用者手勢）→ 合成辨識事件
    const g0 = await page.evaluate(() => window.__srLog.gestureStarts);
    await page.locator('#hsReady button[data-act="voice"]').click();
    await sleep(100);
    await page.evaluate(() => window.__say('做一顆會跳的球', false));
    await sleep(120);
    await page.evaluate(() => window.__say('做一顆會跳的球', true));
    await sleep(300);
    // 鏡頭預覽
    await page.locator('#hsReady button[data-act="camera"]').click();
    await until(() => document.querySelector('#hsReady li[data-k="camera"]')?.dataset.s !== 'untested', null, 8000);
    const preview = await page.evaluate(() => !!document.querySelector('#hsReady video.hs-preview')?.videoWidth);
    // 動作感測：按鈕後送幾筆感測
    await page.locator('#hsReady button[data-act="motion"]').click();
    for (let i = 0; i < 8; i += 1) {
      await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 80, gamma: -5 })));
      await sleep(60);
    }
    await sleep(1400);
    await page.locator('#hsReady input[data-act="eyes"]').check();
    st = await statusOf();
    check('語音實測（點按鈕＝使用者手勢，合成辨識事件）→ 通過，記下延遲', st.voice === 'pass' && (await page.evaluate(() => window.__srLog.gestureStarts)) === g0 + 1, await page.locator('#hsReady li[data-k="voice"] .hs-ct').innerText());
    check('鏡頭實測：有預覽畫面、量到解析度與每秒張數 → 通過', st.camera === 'pass' && preview, await page.locator('#hsReady li[data-k="camera"] .hs-ct').innerText());
    check('動作感測實測：收到感測事件 → 通過；左右眼要人看（人工確認）', st.motion === 'pass' && st.eyes === 'manual', JSON.stringify(st));
    check('創作者 connector：在線（協定測試 connector 正在拿工作）', st.connector === 'pass', JSON.stringify(st));
    await shot('j2-ready-measured.png');
    await page.locator('#hsSummary').click();
    const sumText = await page.locator('#hsSummaryBox pre').innerText();
    const sum = await page.evaluate(() => window.__ws.headset.readySummary());
    const raw = JSON.stringify(sum) + sumText;
    const cookie = await page.evaluate(() => document.cookie);
    const me = (await S()).me;
    const forbidden = [token, code, me.creatorId, '做一顆會跳的球', '測試 connector', cookie && cookie.split('=')[1]].filter(Boolean);
    check('驗收摘要：有裝置／瀏覽器、設定、權限、實測延遲；沒有 token、配對碼、創作者 id、connector 名稱、聽到的字', !!sum.device.browser && sum.checks.voice.measured.firstResultMs != null && sum.settings.cam.offsetZ != null && forbidden.every((f) => !raw.includes(f)), `browser ${sum.device.browser} ${sum.device.browserVersion}；未測 ${sum.untested.join('、')}`);
    check('驗收摘要：明寫「未確認是不是真手機＋紙盒」，不把瀏覽器量到的當真機證據', /未確認/.test(sum.realDevice));
    report.notes.readySummary = sum;
    writeFileSync(path.join(OUT, 'ready-summary.json'), JSON.stringify(sum, null, 2));
    writeFileSync(path.join(OUT, 'ready-summary.txt'), sumText);
    const tracksBefore = await page.evaluate(() => window.__trackStates().filter((t) => t === 'live').length);
    await page.locator('#hsGo').click();
    await until(() => window.__ws.headset.state().active);
    await sleep(300);
    const previewTracks = await page.evaluate(() => window.__trackStates());
    check('按「開始」：預覽用的鏡頭先關掉（讓給手勢辨識），只剩手勢辨識那一條', tracksBefore >= 1 && previewTracks.filter((t) => t === 'live').length <= 1, previewTracks.join(','));
    await exitHeadset();
  }

  // ======================= K 對位檢查 =======================
  if (SECTIONS.has('K')) {
    await page.evaluate(() => window.__ws.headset.setSettings({ cam: { offsetX: 0, offsetY: 0, offsetZ: 0.07 } }));
    await enterHeadset();
    await pressMenu('page:more');
    await pressMenu('sys:align', { look: false });
    await until(() => window.__ws.headset.state().aligning, null, 5000);
    // 看前面、手放在目標右邊 3 公分、下面 2 公分（模擬鏡頭偏移沒對好），捏住 1 秒
    await lookAt([0, 1.2, -5]);
    const target = await page.evaluate(() => {
      const THREE = window.__ws.THREE;
      return new THREE.Vector3(0, -0.1, -0.4).applyQuaternion(window.__ws.camera.quaternion).add(window.__ws.camera.position).toArray();
    });
    // 模擬「真的鏡頭在設定值左邊 3 公分、上面 2 公分」：手真的放在目標上，鏡頭看到的方向＝目標 −（設定偏移 − 誤差）
    const e = [0.03, -0.02, 0];
    const camTarget = await page.evaluate(([t, ex]) => {
      const THREE = window.__ws.THREE;
      const cam = window.__ws.headset.settings.cam;
      const h = new THREE.Vector3(0 - cam.offsetX + ex[0], -0.1 - cam.offsetY + ex[1], -0.4 + cam.offsetZ + ex[2]); // 手在鏡頭座標
      // 換成「從眼睛看過去、穿過這個鏡頭方向」的世界座標點（給 __handAt 反解：它照設定偏移算）
      const eyeP = h.clone().add(new THREE.Vector3(cam.offsetX, cam.offsetY, -cam.offsetZ));
      return eyeP.applyQuaternion(window.__ws.camera.quaternion).add(window.__ws.camera.position).toArray();
    }, [target, e]);
    void camTarget;
    // __handAt 會讓捏點落在「眼睛→點」的射線上、深度是合成手的大小決定的；這裡改用鏡頭方向直接放（模擬單眼遠近估錯）
    const uvFor = () =>
      page.evaluate(async (ex) => {
        const { intrinsics } = await import('/hands.mjs');
        const cam = window.__ws.headset.settings.cam;
        const intr = intrinsics(640, 480, cam.hfovDeg, cam.rotation);
        const h = { x: 0 - cam.offsetX + ex[0], y: -0.1 - cam.offsetY + ex[1], z: -0.4 + cam.offsetZ + ex[2] };
        return { u: 0.5 + h.x / -h.z / (2 * intr.tanX), v: 0.5 - h.y / -h.z / (2 * intr.tanY) };
      }, e);
    const handImage = async (open) => {
      const { u, v } = await uvFor();
      return page.evaluate(([o, uu, vv]) => window.__handImage(o, uu, vv), [open, u, v]);
    };
    await tracked(await handImage(1));
    const n0 = (await H()).stats.events['pinch-start'] || 0;
    await handImage(0);
    await until((k) => (window.__ws.headset.state().stats.events['pinch-start'] || 0) > k, n0, 6000);
    await until(() => window.__ws.headset.state().aligning?.result, null, 5000).catch(() => {});
    await handImage(1);
    await until(() => !window.__ws.headset.state().gesture.pinched, null, 6000);
    const al = (await H()).aligning;
    check('對位檢查：量出鏡頭偏移差（左右 3、上下 2 公分；遠近估錯不影響）', al?.result && Math.abs(al.result.err.x - 0.03) < 0.004 && Math.abs(al.result.err.y + 0.02) < 0.004, JSON.stringify(al?.result));
    await shot('k1-align.png');
    await pressMenu('sys:align-apply', { look: true });
    const cam1 = await page.evaluate(() => window.__ws.headset.settings.cam);
    check('套用：左右、上下偏移照量到的差改（存在這台裝置）', Math.abs(cam1.offsetX + 0.03) < 0.006 && Math.abs(cam1.offsetY - 0.02) < 0.006 && JSON.parse(await page.evaluate(() => localStorage.getItem('vw_headset'))).cam.offsetX === cam1.offsetX, `${JSON.stringify(cam1)}｜menu ${JSON.stringify((await H()).stats.menu)}｜${JSON.stringify((await H()).menuButtons)}｜align ${JSON.stringify((await H()).aligning)}`);
    await pressMenu('sys:align-reset', { look: false });
    const cam2 = await page.evaluate(() => window.__ws.headset.settings.cam);
    check('重設：鏡頭偏移回到預設（0／0／0.07）', cam2.offsetX === 0 && cam2.offsetY === 0 && cam2.offsetZ === 0.07);
    await pressMenu('sys:align-done', { look: false });
    // 鏡頭前後距離改成 12 公分：手的射線照樣對準作品（合成手依新的偏移反解）；在乾淨的子世界只放一個作品（前面的段落在根世界開了好幾個傳送門）
    await page.evaluate(() => window.__ws.headset.setSettings({ cam: { offsetZ: 0.12, offsetY: 0.03 } }));
    const someLin = (await S()).live.find((L) => L.name === '方向方塊') || (await S()).live[0];
    const kWorld = await page.evaluate(() => window.__ws.creation.createChild({ ask: false }));
    await page.evaluate((w) => window.__ws.creation.enter(w), kWorld);
    await until((w) => window.__ws.creation.state().world.id === w && !window.__ws.creation.state().loading, kWorld);
    await page.evaluate(([lin, v]) => window.__ws.creation.placeNew(lin, v), [someLin.lineage, someLin.version]);
    await until(() => window.__ws.creation.state().live.length === 1 && window.__ws.creation.state().host.meshes > 0);
    const orb = (await S()).live[0];
    const ent = orb.name === '點球' ? 'orb' : orb.name === '方向方塊' ? 'cube' : 'b0';
    await lookAtItem(orb.hostId, ent);
    const orbPos = await page.evaluate(([h, e]) => window.__entityPos(h, e), [orb.hostId, ent]);
    const orbUv = await handAt(1, orbPos);
    // 不固定等 400 ms：記下射線一路怎麼追上（辨識慢的時候 400 ms 可能還沒追上，那是延遲、不是偏移算錯）
    const aim = await aimTimeline(orbPos, orb.hostId, orbUv);
    report.notes.kAim = aim;
    const reacqOk = (a) => a.acquire === 0 || (a.reacquire?.handOn && a.reacquire.err < 0.5);
    check('鏡頭前後 12 公分、上 3 公分：手指著作品照樣指得到（射線用新的鏡頭位置；停穩後夾角 < 0.5°）', aim.firstHover !== null && aim.settledErr < 0.5 && reacqOk(aim), aimText(aim));
    // 辨識降到約 7 Hz（審查環境量到的速度）：手先移到旁邊（被追到），再一下跳回作品——
    // 跳太遠時狀態機當成新的一隻手（追丟寬限 300 ms 後重新找到），射線要等那之後才會指到
    const side = await page.evaluate(([p]) => {
      const THREE = window.__ws.THREE;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(window.__ws.camera.quaternion);
      return new THREE.Vector3().fromArray(p).addScaledVector(right, 0.9).toArray();
    }, [orbPos]);
    await tracked(await handAt(1, side));
    await page.evaluate(() => (window.__fakeHandDelayMs = 140));
    await sleep(500);
    const slow = await aimTimeline(orbPos, orb.hostId, await handAt(1, orbPos), 4000);
    await page.evaluate(() => (window.__fakeHandDelayMs = 3));
    report.notes.kAimSlow = slow;
    check('辨識只有約 7 Hz、手一下跳回作品：重新找到手的那一格就有射線、從新位置開始（夾角 < 0.5°），3 秒內指到', slow.acquire >= 1 && reacqOk(slow) && slow.firstHover !== null && slow.firstHover < 3000 && slow.settledErr < 0.5, aimText(slow));
    await page.evaluate(() => window.__ws.headset.setSettings({ cam: { offsetX: 0, offsetY: 0, offsetZ: 0.07 } }));
    await page.evaluate(() => window.__ws.creation.goUp());
    await until(() => window.__ws.creation.state().world.id === 'root' && !window.__ws.creation.state().loading);
    await exitHeadset();
  }

  // 這個測試的作品都不會卡住：看門狗要是停過任何一個，就是誤判（主執行緒被長任務卡住時，準時的回覆還在排隊）
  const hostEnd = (await S()).host;
  check('整段沒有作品被看門狗停掉（這個分頁的逾時 0）', hostEnd?.timeouts === 0, JSON.stringify(hostEnd));
  check('頁面沒有錯誤', errors.length === 0, errors.slice(0, 4).join(' | '));
  check('眼鏡流程中沒有跳出任何打字視窗', dialogs.length === 0, JSON.stringify(dialogs));
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  connectorOn = false;
  await loop.catch(() => {});
  report.notes.connectorHandled = handled;
  await browser.close();
  server.kill();
  await sleep(200);
  rmSync(DATA, { recursive: true, force: true });
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通過（${BROWSER}）`);
  process.exit(pass === results.length ? 0 : 1);
}
