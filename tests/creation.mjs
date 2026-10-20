// 創作世界端到端（瀏覽器＋伺服器＋沙盒），用「協定測試 connector」：測試自己扮演創作者的 connector（配對、拿工作、交作品包），
// 交的是測試裡寫好的作品程式（fixture），**不是真的 Codex 生成**；真 Codex 生成另外用 connector/vibe-connector.mjs 做、分開報告。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾、CODEX_BIN 不存在），Chromium（SwiftShader）：
// 1 用說的建立新作品（合成辨識事件）→ 自己的 connector 做 → 影子試跑 → 放在面前 → 真的點擊遊玩、按鍵；邊玩邊再說一句修改
// 2 改作品：stateSchema 變了要 migrate → 不重新整理換版、分數保留；環境相關的壞版換上後出錯 → 退回舊版與切換當下的狀態
// 3 A→B→C：每層都能建立作品、返回、重開；C 的作品帶回 A 再放；同作品兩個實例互不污染
// 4 深鏈 12 層：只有目前這層在執行（Worker／實例數不隨深度增加）
// 5 connector 關掉：做好的作品照樣能玩
// 6 語音：合成的辨識事件（不是真麥克風）→ 中間結果只顯示、最終結果只建一個工作；說到一半換世界，工作仍綁在開口那一層
// 7 連續換版 6 次：舊版 Worker 都收掉、畫面物件數穩定
// 8 眼鏡模式裡創作：捏住作品＝點它、點一下螢幕開始說話（合成手部關鍵點、合成辨識事件）
// 9 真 Codex 生成過的作品（fixture）：快速點按、遊戲結束後重來
// 10 原子換版：同一條作品線兩個實例，第 2 個候選起不來 → 兩個都不換、狀態與存檔不動、資源回收；修好後一起換；
//    觀察期內出錯 → 全部退回；亂數狀態跟著存檔接續
//   node tests/creation.mjs        輸出 tests/out/creation/
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'creation');
mkdirSync(OUT, { recursive: true });
const PORT = 5381;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-create-e2e-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), kind: '協定測試（fixture connector，非真 Codex）', checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: 'ignore' });
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}

// ---------------- 作品（fixture） ----------------
const ORB = `vibe.define({
  init(p) { return { hits: 0, t: 0, x: 0 }; },
  tick(s, dt, input) {
    s.t += dt;
    if (input.keys.left) s.x -= dt * 2;
    if (input.keys.right) s.x += dt * 2;
  },
  view(s) {
    return [
      { id: 'base', shape: 'cylinder', pos: [0, 0.05, 0], size: [1, 0.1], color: '#1b3a52' },
      { id: 'orb', shape: 'sphere', pos: [s.x, 1 + Math.sin(s.t * 2) * 0.2, 0], size: [0.45], color: '#33ccff', emissive: '#0a3344' },
      { id: 'score', shape: 'text', pos: [0, 2.2, 0], size: [0.3], text: '命中 ' + s.hits, color: '#ffffff' },
    ];
  },
  hud(s) { return ['命中 ' + s.hits, 'x ' + s.x.toFixed(2)]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; },
});`;
// v2：加上連擊（stateSchema 2，要 migrate；保留原本的 hits）
const ORB2 = ORB.replace("init(p) { return { hits: 0, t: 0, x: 0 }; }", 'init(p) { return { hits: 0, t: 0, x: 0, combo: 0 }; }')
  .replace("hud(s) { return ['命中 ' + s.hits, 'x ' + s.x.toFixed(2)]; }", "hud(s) { return ['命中 ' + s.hits, '連擊 ' + s.combo, 'v2']; }")
  .replace("onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; }", "onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') { s.hits += 1; s.combo += 1; } },\n  migrate(old, from) { return { ...old, combo: 0 }; }")
  .replace("color: '#33ccff'", "color: '#ff9933'");
// v3：在伺服器試跑時沒事，但玩家站得遠（真實世界）就出錯——換上後才發現，要退回 v2
const ORB3 = ORB2.replace('s.t += dt;', "s.t += dt; if (Math.abs(input.player.z) > 6 && s.t > 0.5) throw new Error('玩家太遠時爆炸');").replace("'v2'", "'v3'");
// 收到「瀏覽器換版試跑失敗」的診斷後，connector 交的修正版（不再爆炸）
const ORB3FIX = ORB2.replace("'v2'", "'v3fix'");
const TOWER = `vibe.define({
  init() { return { level: 1 }; },
  tick(s) {},
  view(s) { const out = []; for (let i = 0; i < s.level; i++) out.push({ id: 'b' + i, shape: 'box', pos: [0, 0.25 + i * 0.5, 0], size: [0.8, 0.45, 0.8], color: i % 2 ? '#ffcc33' : '#33ff99' }); return out; },
  hud(s) { return ['塔高 ' + s.level]; },
  onEvent(s, ev) { if (ev.type === 'click') s.level = Math.min(12, s.level + 1); },
});`;
const STAR = TOWER.replace(/塔高/g, '星星').replace("'#ffcc33'", "'#ff66cc'");
const VARIANT = (n) => ORB2.replace("'v2'", `'v${n}'`).replace("color: '#ff9933'", `color: '#${(0x224466 + n * 0x111111).toString(16).slice(0, 6)}'`);
// 原子換版用：倍率版（stateSchema 3，保留 hits）、用亂數的作品（亂數接續）
const ORB_MULT = ORB2.replace("'v2'", "'mult'").replace('s.hits += 1; s.combo += 1;', 's.hits += 2; s.combo += 1;').replace('migrate(old, from) { return { ...old, combo: 0 }; }', 'migrate(old, from) { return { combo: 0, ...old, mult: 2 }; }');
const DICE = `vibe.define({
  init() { return { draws: [] }; },
  tick(s) { s.draws.push(Math.floor(vibe.random() * 1e6)); if (s.draws.length > 8) s.draws.shift(); },
  view(s) { return [{ id: 'die', shape: 'box', pos: [0, 0.4, 0], size: [0.6, 0.6, 0.6], color: '#ffffff' }]; },
  hud(s) { return ['骰 ' + (s.draws[s.draws.length - 1] ?? '-')]; },
});`;
const DICE2 = DICE.replace("color: '#ffffff'", "color: '#ffdd55'").replace("hud(s) { return ['骰 '", "hud(s) { return ['骰2 '");
// 真 Codex 生成過的作品（原樣，見 tests/fixtures/creation/catch-stars/README.md）
const CATCH = readFileSync(path.join(HERE, 'fixtures', 'creation', 'catch-stars', 'main.js'), 'utf8');
const PLAN = [
  [/倍率/, ['點球', ORB_MULT, 3]],
  [/骰子2/, ['骰子', DICE2, 1]],
  [/骰子/, ['骰子', DICE, 1]],
  [/接星星/, ['接星星', CATCH, 1]],
  [/點球/, ['點球', ORB, 1]],
  [/連擊/, ['點球', ORB2, 2]],
  [/遠/, ['點球', ORB3, 2]],
  [/疊塔/, ['疊塔', TOWER, 1]],
  [/星星/, ['星星塔', STAR, 1]],
  [/顏色(\d+)/, null],
];

// ---------------- 協定測試 connector（就是測試自己） ----------------
let token = null;
let connectorOn = true;
const handled = [];
async function connectorLoop() {
  while (connectorOn) {
    if (!token) {
      await sleep(200);
      continue;
    }
    const r = await fetch(`${BASE}/api/connector/jobs?wait=2`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (!r || r.status !== 200) continue;
    const { job } = await r.json();
    let pick = null;
    if (/遠/.test(job.intent) && job.diagnostics?.some((d) => d.includes('瀏覽器換版試跑失敗'))) pick = ['點球', ORB3FIX, 2];
    for (const [re, v] of pick ? [] : PLAN) {
      const m = job.intent.match(re);
      if (m) {
        pick = v || ['點球', VARIANT(Number(m[1])), 2];
        break;
      }
    }
    if (!pick) pick = ['點球', ORB, 1];
    const [name, code, schema] = pick;
    const res = await fetch(`${BASE}/api/connector/jobs/${job.id}/package`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest: { format: 'vibe-pkg/1', name, description: 'fixture', stateSchema: schema, budgets: { entities: 40 } }, files: { 'main.js': code }, provenance: { tool: 'fixture', via: 'fixture', attempt: job.attempt, ms: 1 } }),
    }).then((x) => x.json());
    handled.push({ id: job.id, intent: job.intent, worldId: job.worldId, source: job.source, target: job.target?.lineage || null, ok: res.ok, version: res.version });
  }
}
const loop = connectorLoop();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // MediaPipe 的 WASM 把 INFO 寫到 console.error（眼鏡模式的手勢 worker），不算錯誤
  page.on('console', (m) => m.type() === 'error' && !/^INFO:|XNNPACK/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.on('dialog', (d) => d.accept(d.message().includes('名字') ? (page.__nextName || '子世界') : undefined));
  // 合成的語音辨識（不是真麥克風）：測試從外面推中間結果與最終結果
  await page.addInitScript(() => {
    if (window.top !== window) return; // Playwright 也會把這段注入沙盒 iframe：那裡沒有 localStorage，也不需要假語音
    localStorage.setItem('vw_help_seen', '1');
    class FakeSR {
      constructor() {
        window.__sr = this;
      }
      start() {
        window.__srStarted = (window.__srStarted || 0) + 1;
      }
      stop() {
        setTimeout(() => this.onend?.(), 10);
      }
      abort() {
        setTimeout(() => this.onend?.(), 10);
      }
    }
    window.SpeechRecognition = FakeSR;
    window.__say = (text, isFinal) => {
      const r = Object.assign([{ transcript: text }], { isFinal });
      window.__sr.onresult({ resultIndex: 0, results: [r] });
      if (isFinal) setTimeout(() => window.__sr.onend?.(), 20);
    };
  });
  page.setDefaultTimeout(60000);
  await page.goto(`${BASE}/?create`);
  await page.waitForFunction(() => window.__ws?.creation?.state().world?.id === 'root');
  const S = () => page.evaluate(() => window.__ws.creation.state());
  check('創作世界載入：根世界、沙盒就緒、還沒有 connector', (await S()).world.id === 'root' && (await page.locator('#cConn').innerText()).includes('還沒連接'));

  // 配對：按「連接我的 Codex」→ 畫面上的配對碼 → connector 配對
  await page.click('#cPairBtn');
  await page.waitForFunction(() => /^[A-Z0-9]{6}$/.test(document.querySelector('#cPairCode')?.textContent.trim()));
  const code = (await page.locator('#cPairCode').innerText()).trim();
  const pr = await fetch(`${BASE}/api/connector/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, label: '測試 connector' }) }).then((r) => r.json());
  token = pr.token;
  check('畫面上的配對碼可以讓 connector 配對（指令也顯示在畫面上）', !!token && (await page.locator('#cPairCmd').innerText()).includes('vibe-connector.mjs pair'));
  await page.click('#cPairClose');

  // waitJob(條件) 或 waitJob(條件, 毫秒)；條件要用參數時：waitJob(條件, { arg, ms })
  const waitJob = (pred, opt = 30000) =>
    page.waitForFunction(pred, typeof opt === 'object' ? opt.arg : null, { timeout: typeof opt === 'object' ? opt.ms ?? 30000 : opt }).catch(async (e) => {
      console.log('等待逾時，現在的狀態：', JSON.stringify(await S()).slice(0, 1500), '\nconnector 處理過：', JSON.stringify(handled).slice(0, 800), '\n頁面錯誤：', errors.slice(0, 5).join(' | '), '\n工作提示：', await page.locator('#cJob .txt').innerText().catch(() => ''));
      throw e;
    });
  // 1 用說的建立（合成的辨識事件：按 🎙 → 中間結果 → 最終結果）
  await page.click('#cMic');
  await page.evaluate(() => window.__say('做一個點', false));
  await page.evaluate(() => window.__say('做一個點球得分的遊戲', true));
  await waitJob(() => window.__ws.creation.state().live.length === 1 && window.__ws.creation.state().host.meshes > 0);
  let s = await S();
  check('說需求（合成辨識事件）→ 自己的 connector 做好 → 影子試跑 → 放在面前（沙盒裡執行、畫出實體）', s.live[0].name === '點球' && s.live[0].version === 1 && s.host.workers === 1 && handled[0]?.source === 'voice', JSON.stringify(s.host));
  const L1 = s.live[0].lineage;
  // 真的點擊：把 orb 投影到螢幕上點
  const orbXY = () =>
    page.evaluate(() => {
      const ws = window.__ws;
      const root = ws.scene.getObjectByName('creation-items');
      let m = null;
      root.traverse((o) => o.userData?.entityId === 'orb' && o.visible && o.parent?.visible !== false && (m = o));
      if (!m) return null;
      const p = m.getWorldPosition(new ws.THREE.Vector3()).project(ws.camera);
      const r = ws.renderer.domElement.getBoundingClientRect();
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    });
  for (let i = 0; i < 3; i += 1) {
    const p = await orbXY();
    await page.mouse.click(p.x, p.y);
    await sleep(250);
  }
  await page.keyboard.down('ArrowRight');
  await sleep(600);
  await page.keyboard.up('ArrowRight');
  await sleep(300);
  s = await S();
  const hud1 = s.live[0].hud.join(' ');
  check('真的點擊與按鍵：命中數增加、方向鍵移動（作品的規則在沙盒裡跑）', /命中 [1-9]/.test(hud1) && !/x 0\.00/.test(hud1), hud1);
  await page.screenshot({ path: path.join(OUT, '01-new-game.png') });

  // 2 改作品（migrate）
  const hitsBefore = Number(s.live[0].hud[0].match(/\d+/)[0]);
  await page.evaluate(() => window.__ws.creation.select(window.__ws.creation.state().live[0].id));
  await page.click('#cMode');
  // 一邊玩（一直按著方向鍵）一邊再說一句修改
  await page.keyboard.down('ArrowLeft');
  await page.click('#cMic');
  await page.evaluate(() => window.__say('加上連擊', true));
  await waitJob(() => window.__ws.creation.state().live[0]?.version === 2 && window.__ws.creation.state().live[0].hud.join(' ').includes('v2'));
  await page.keyboard.up('ArrowLeft');
  s = await S();
  check('邊玩邊再說「加上連擊」→ v2（stateSchema 1→2 經 migrate）不重新整理換上，分數保留', s.live[0].version === 2 && Number(s.live[0].hud[0].match(/\d+/)[0]) >= hitsBefore && s.stats.swaps === 1 && handled[1]?.source === 'voice' && handled[1]?.target === L1, s.live[0].hud.join(' '));
  check('換版沒有重新整理頁面、沒有清空世界', (await page.evaluate(() => performance.getEntriesByType('navigation').length)) === 1 && s.live.length === 1);
  await sleep(3500);
  check('觀察期過後舊版 Worker 收掉', (await S()).host.workers === 1, JSON.stringify((await S()).host));
  // 壞版：換上後才出錯 → 退回 v2 與切換當下的狀態
  const before3 = (await S()).live[0].hud.join(' ');
  await page.fill('#cInput', '玩家站遠一點也要能玩');
  await page.click('#cSend');
  await waitJob(() => window.__ws.creation.state().stats.rollbacks + window.__ws.creation.state().stats.rejected >= 1, 40000);
  await sleep(500);
  s = await S();
  check('環境相關的壞版 v3：被擋下或換上後出錯 → 舊版 v2 照常在玩、分數沒歸零', s.live[0].version === 2 && !s.live[0].broken && Number(s.live[0].hud[0].match(/\d+/)[0]) >= hitsBefore, `rollbacks ${s.stats.rollbacks} rejected ${s.stats.rejected} hud ${s.live[0].hud.join(' ')}（之前 ${before3}）`);
  // 診斷回到同一位創作者的 connector → 修正版 v4 → 自動再換一次（分數還在）
  await waitJob(() => window.__ws.creation.state().live[0]?.hud.join(' ').includes('v3fix'), 40000);
  s = await S();
  const lin = (await fetch(`${BASE}/api/lineages`).then((r) => r.json())).lineages.find((l) => l.id === L1);
  check('壞掉的 v3 在作品庫標成 broken；診斷回到同一位創作者的 connector 修好 v4 → 自動換上、分數還在', lin.versions.find((x) => x.v === 3)?.broken && s.live[0].version === 4 && lin.latestGood === 4 && Number(s.live[0].hud[0].match(/\d+/)[0]) >= hitsBefore && handled.filter((h) => /遠/.test(h.intent)).length === 2, `${s.live[0].hud.join(' ')}；作品線 ${lin.versions.map((x) => `v${x.v}${x.broken ? '(壞)' : ''}`).join(' ')}`);
  await sleep(3500);

  // 3 A→B→C
  page.__nextName = 'B 世界';
  await page.click('#cChild');
  await page.waitForFunction(() => window.__ws.creation.state().world.portals === 1);
  const bId = await page.evaluate(() => document.querySelector('#cPortals [data-enter]').dataset.enter);
  await page.click(`#cPortals [data-enter="${bId}"]`);
  await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, bId);
  s = await S();
  check('進入 B：上一層停掉（B 裡沒有實例、Worker 收掉）、麵包屑顯示 根世界/B', s.live.length === 0 && s.host.workers === 0 && (await page.locator('#cCrumb').innerText()).includes('B 世界'), JSON.stringify(s.host));
  await page.fill('#cInput', '做一個疊塔'); // 文字備援（打字）
  await page.click('#cSend');
  await waitJob(() => window.__ws.creation.state().live.length === 1);
  check('B 層也能建立作品', (await S()).live[0].name === '疊塔');
  page.__nextName = 'C 世界';
  await page.click('#cChild');
  await page.waitForFunction(() => window.__ws.creation.state().world.portals === 1);
  const cId = await page.evaluate(() => document.querySelector('#cPortals [data-enter]').dataset.enter);
  await page.evaluate((id) => window.__ws.creation.enter(id), cId);
  await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, cId);
  await page.fill('#cInput', '做一個星星塔');
  await page.click('#cSend');
  await waitJob(() => window.__ws.creation.state().live.length === 1);
  s = await S();
  const starLin = s.live[0].lineage;
  check('C 層（第 2 層）也能建立作品', s.live[0].name === '星星塔' && s.world.depth === 2);
  // 點一下星星塔讓狀態改變，返回再重開
  await page.evaluate(() => {
    const c = window.__ws.creation;
    const L = c.state().live[0];
    c.host().event(L.hostId, { type: 'click', target: 'b0' });
    c.host().event(L.hostId, { type: 'click', target: 'b0' });
  });
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '02-world-c.png') });
  await page.click('#cUp');
  await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, bId);
  await page.click('#cUp');
  await page.waitForFunction(() => window.__ws.creation.state().world.id === 'root');
  s = await S();
  check('C → B → A 返回：A 的作品從存檔恢復（修正後的 v4、分數還在）', s.live.length === 1 && s.live[0].version === 4 && Number(s.live[0].hud[0]?.match(/\d+/)?.[0] ?? -1) >= hitsBefore, s.live[0]?.hud.join(' '));
  // 重開 C
  await page.goto(`${BASE}/?create&w=${cId}`);
  await page.waitForFunction((id) => window.__ws?.creation?.state().world?.id === id, cId);
  await sleep(800);
  s = await S();
  check('重新整理後直接重開 C：星星塔的狀態還在（3 層）', s.live[0]?.hud.join(' ').includes('星星 3'), s.live[0]?.hud.join(' '));
  // C 的作品帶回 A：放兩個，互不污染
  await page.evaluate(() => window.__ws.creation.enter('root'));
  await page.waitForFunction(() => window.__ws.creation.state().world.id === 'root');
  await page.click(`#cLib [data-place="${starLin}"]`);
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 2);
  await page.click(`#cLib [data-place="${starLin}"]`);
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 3);
  await page.evaluate((lin) => {
    const c = window.__ws.creation;
    const a = c.state().live.filter((x) => x.lineage === lin)[0];
    for (let i = 0; i < 4; i += 1) c.host().event(a.hostId, { type: 'click', target: 'b0' });
  }, starLin);
  await sleep(500);
  s = await S();
  const stars = s.live.filter((x) => x.lineage === starLin).map((x) => x.hud.join(' '));
  check('C 做的作品帶回 A 放兩個：同一版本、各自狀態（一個點了 4 下、一個沒動）', stars.length === 2 && stars.includes('星星 5') && stars.includes('星星 1'), stars.join(' / '));
  await page.screenshot({ path: path.join(OUT, '03-root-reuse.png') });

  // 4 深鏈 12 層：只有目前這層在執行
  const depthStats = [];
  for (let d = 1; d <= 12; d += 1) {
    page.__nextName = `第 ${d} 層`;
    const childId = await page.evaluate(() => window.__ws.creation.createChild());
    await page.evaluate((id) => window.__ws.creation.enter(id), childId);
    await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, childId);
    if (d === 9) {
      await page.evaluate((lin) => window.__ws.creation.placeNew(lin, 1), starLin);
      await page.waitForFunction(() => window.__ws.creation.state().live.length === 1);
    }
    const x = await S();
    depthStats.push({ depth: x.world.depth, live: x.live.length, workers: x.host.workers, meshes: x.host.meshes });
  }
  report.notes.deepChain = depthStats;
  check('深鏈 12 層（第 9 層還建立作品）：每一層執行中的實例／Worker 只有那一層的（不隨深度累積）', depthStats.every((x) => x.workers <= 1 && x.live <= 1) && depthStats[11].depth === 12, JSON.stringify(depthStats.map((x) => `${x.depth}:${x.live}/${x.workers}`)));
  for (let d = 12; d >= 1; d -= 1) {
    await page.click('#cUp');
    await page.waitForFunction((n) => window.__ws.creation.state().world.depth === n, d - 1);
  }
  s = await S();
  check('從第 12 層一層一層返回根世界：作品都在', s.world.id === 'root' && s.live.length === 3);

  // 5 connector 關掉：照樣能玩
  connectorOn = false;
  await loop;
  const offBefore = (await S()).live.find((x) => x.lineage === L1).hud.join(' ');
  for (let i = 0; i < 2; i += 1) {
    const p = await orbXY();
    await page.mouse.click(p.x, p.y);
    await sleep(250);
  }
  const offAfter = (await S()).live.find((x) => x.lineage === L1).hud.join(' ');
  check('connector（Codex）斷開：做好的作品照樣能玩（點擊有反應）', offBefore !== offAfter, `${offBefore} → ${offAfter}`);
  connectorOn = true;
  const loop2 = connectorLoop();

  // 6 語音（合成辨識事件）：開口時在 C，說到一半回到 A → 工作仍綁在 C；中間結果不生成；只建一個工作
  await page.evaluate((id) => window.__ws.creation.enter(id), cId);
  await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, cId);
  const jobsBefore = (await S()).jobs.length;
  await page.click('#cMic');
  await page.evaluate(() => window.__say('做一個', false));
  await page.evaluate(() => window.__say('做一個疊', false));
  check('語音中間結果只顯示（不送出）', (await S()).jobs.length === jobsBefore && (await page.locator('#cJob .txt').innerText()).includes('聽到'));
  await page.evaluate(() => window.__ws.creation.enter('root'));
  await page.waitForFunction(() => window.__ws.creation.state().world.id === 'root');
  await page.evaluate(() => window.__say('做一個疊塔', true));
  await page.waitForFunction((n) => window.__ws.creation.state().jobs.length === n + 1, jobsBefore);
  await sleep(2500);
  s = await S();
  const vj = s.jobs[s.jobs.length - 1];
  check('最終結果只建一個工作，來源標成語音、綁在開口那一層（C），不是現在這層', s.jobs.length === jobsBefore + 1 && vj.worldId === cId && handled.some((h) => h.id === vj.id && h.source === 'voice' && h.worldId === cId), JSON.stringify(vj));
  check('做好的作品放進 C（現在在 A，A 沒有多東西）', s.live.length === 3);

  // 7 連續換版 6 次：資源回收
  await page.evaluate(() => {
    const c = window.__ws.creation;
    const L = c.state().live.find((x) => x.name === '點球');
    c.select(L.id);
    c.setMode('modify');
  });
  const base = (await S()).host;
  for (let n = 5; n <= 10; n += 1) {
    await page.evaluate((n) => window.__ws.creation.submit(`換顏色${n}`), n);
    await page.waitForFunction((n) => window.__ws.creation.state().live.find((x) => x.name === '點球')?.hud.join(' ').includes(`v${n}`), n, { timeout: 30000 });
    await sleep(3300);
  }
  const after = (await S()).host;
  report.notes.swapResources = { base, after };
  check('連續換版 6 次：舊版 Worker 收掉、實體與 geometry 數量不累積', after.workers <= base.workers && after.meshes <= base.meshes + 2 && after.geometries <= base.geometries + 4, `workers ${base.workers}→${after.workers} meshes ${base.meshes}→${after.meshes} geometries ${base.geometries}→${after.geometries}`);
  // 10 原子換版（review 退件的情境）：同一條作品線兩個實例，第 2 個候選起不來 → 兩個都留在舊版、狀態不動、沒有半套存檔
  await page.evaluate(() => window.__ws.creation.setMode('new'));
  const orbLin = (await S()).live.find((x) => x.name === '點球').lineage;
  await page.evaluate((lin) => window.__ws.creation.placeNew(lin, window.__ws.creation.state().live.find((x) => x.lineage === lin).version), orbLin);
  await page.waitForFunction((lin) => window.__ws.creation.state().live.filter((x) => x.lineage === lin).length === 2, orbLin);
  const twins = async () => (await S()).live.filter((x) => x.lineage === orbLin);
  const [t1] = await twins();
  await page.evaluate((id) => { const c = window.__ws.creation; for (let i = 0; i < 3; i += 1) c.host().event(id, { type: 'click', target: 'orb' }); }, t1.hostId);
  await sleep(500);
  const before10 = (await twins()).map((x) => ({ id: x.id, v: x.version, hud: x.hud[0] }));
  const workers10 = (await S()).host.workers;
  // 跟獨立驗收的重現一樣：讓 host.spawn 對「新版的第 2 個正式候選」回 ok:false（影子試跑的不算）
  await page.evaluate(() => {
    const h = window.__ws.creation.host();
    const original = h.spawn.bind(h);
    let n = 0;
    h.__origSpawn = original;
    h.spawn = async (id, key, opts) => {
      if (!opts?.hidden && /@v\d+$/.test(id) && ++n === 2) return { ok: false, error: '（測試注入）第 2 個正式候選起不來' };
      return original(id, key, opts);
    };
  });
  await page.evaluate(() => { const c = window.__ws.creation; c.select(c.state().live.find((x) => x.name === '點球').id); c.setMode('modify'); });
  const rej0 = (await S()).stats.rejected;
  await page.evaluate(() => window.__ws.creation.submit('加上分數倍率'));
  await waitJob((n) => window.__ws.creation.state().stats.rejected > n, { arg: rej0 });
  await page.evaluate(() => {
    const h = window.__ws.creation.host();
    h.spawn = h.__origSpawn;
  });
  await sleep(400);
  const after10 = (await twins()).map((x) => ({ id: x.id, v: x.version, hud: x.hud[0] }));
  const s10 = await S();
  const saved10 = (await fetch(`${BASE}/api/cworlds/root`).then((r) => r.json())).world.items.filter((i) => i.lineage === orbLin);
  check('原子換版：第 2 個候選起不來 → 兩個實例都留在舊版、分數不動、沒有觀察中的半套', JSON.stringify(after10) === JSON.stringify(before10) && !s10.watching.length && s10.live.every((x) => !x.hostId.includes('@shadow')), `${JSON.stringify(before10)} → ${JSON.stringify(after10)}`);
  check('原子換版失敗：候選與新版 Worker 清掉（資源回到原本）、存檔裡兩個都還是舊版', s10.host.workers === workers10 && saved10.length === 2 && saved10.every((i) => i.version === before10[0].v), `workers ${workers10}→${s10.host.workers}；存檔 ${saved10.map((i) => 'v' + i.version).join(',')}`);
  // 同一個工作修好（connector 再交一次）→ 這次兩個一起換上，各自分數保留
  await waitJob((v) => window.__ws.creation.state().live.filter((x) => x.name === '點球').every((x) => x.version > v), { arg: before10[0].v, ms: 40000 });
  await sleep(600);
  const after10b = await twins();
  check('修好後兩個實例一起換上新版（同一版、各自分數保留）', after10b.length === 2 && new Set(after10b.map((x) => x.version)).size === 1 && after10b.every((x, i) => Number(x.hud[0].match(/\d+/)[0]) >= Number(before10[i].hud.match(/\d+/)[0])), after10b.map((x) => `v${x.version} ${x.hud[0]}`).join(' / '));
  await sleep(3300);
  // 觀察期內多實例出錯 → 全部退回
  const rb0 = (await S()).stats.rollbacks;
  const pre11 = (await twins()).map((x) => ({ v: x.version, hud: x.hud[0] }));
  await page.evaluate(() => window.__ws.creation.submit('玩家站遠一點也要能玩'));
  await waitJob((n) => window.__ws.creation.state().stats.rollbacks > n, { arg: rb0, ms: 40000 });
  await sleep(500);
  const post11 = (await twins()).map((x) => ({ v: x.version, hud: x.hud[0], broken: x.broken }));
  check('觀察期內新版出錯 → 兩個實例全部退回上一版與換版當下的分數', post11.length === 2 && post11.every((x, i) => x.v === pre11[i].v && !x.broken && Number(x.hud.match(/\d+/)[0]) >= Number(pre11[i].hud.match(/\d+/)[0])), `${JSON.stringify(pre11)} → ${JSON.stringify(post11)}`);
  await waitJob((v) => window.__ws.creation.state().live.filter((x) => x.name === '點球').every((x) => x.version > v && x.hud.join(' ').includes('v3fix')), { arg: pre11[0].v, ms: 40000 });
  await sleep(3300);
  check('觀察期過後只剩新版 Worker（舊版與退回過的版本都收掉）', (await S()).host.workers <= workers10, `workers ${(await S()).host.workers}`);
  // 亂數接續：同一份存檔＋亂數狀態，舊版與新版接著抽到的數字一樣；存檔也記下亂數狀態
  await page.evaluate(() => window.__ws.creation.setMode('new'));
  await page.evaluate(() => window.__ws.creation.submit('擲骰子'));
  await waitJob(() => window.__ws.creation.state().live.some((x) => x.name === '骰子'));
  await sleep(800);
  const rngCheck = await page.evaluate(async () => {
    const c = window.__ws.creation;
    const h = c.host();
    const L = c.state().live.find((x) => x.name === '骰子');
    const snap = await h.snapshot(L.hostId);
    const key = L.hostId.split('@')[0] && `${L.lineage}@${L.version}`;
    await h.spawn('ref_a', key, { state: snap.state, fromSchema: snap.schema, rng: snap.rng, hidden: true });
    await h.spawn('ref_b', key, { state: snap.state, fromSchema: snap.schema, rng: snap.rng, hidden: true });
    await h.tickHidden('ref_a', 5, 1 / 30);
    await h.tickHidden('ref_b', 5, 1 / 30);
    const a = (await h.snapshot('ref_a')).state.draws.slice(-5);
    const b = (await h.snapshot('ref_b')).state.draws.slice(-5);
    h.kill('ref_a');
    h.kill('ref_b');
    return { rng: snap.rng, a, b };
  });
  check('亂數接續：同一份存檔帶亂數狀態重建，接下來抽到的數字完全一樣', Number.isInteger(rngCheck.rng) && JSON.stringify(rngCheck.a) === JSON.stringify(rngCheck.b), JSON.stringify(rngCheck));
  await page.evaluate(() => window.__ws.creation.saveWorld());
  const diceSaved = (await fetch(`${BASE}/api/cworlds/root`).then((r) => r.json())).world.items.find((i) => i.state?.draws);
  check('存檔裡有亂數狀態（重開後接著抽）', Number.isInteger(diceSaved?.rng), `rng ${diceSaved?.rng}`);

  // 9 真 Codex 生成過的作品（fixture）：快速點按也收得到（按下至少維持 120 ms），遊戲結束後點一下空白鍵能重來
  await page.evaluate(() => window.__ws.creation.setMode('new'));
  await page.fill('#cInput', '接星星');
  await page.click('#cSend');
  await waitJob(() => window.__ws.creation.state().live.some((x) => x.name === '接星星'));
  const catchState = () => page.evaluate(async () => {
    const c = window.__ws.creation;
    const L = c.state().live.find((x) => x.name === '接星星');
    return (await c.host().snapshot(L.hostId)).state;
  });
  const x0 = (await catchState()).x;
  await page.keyboard.press('ArrowLeft'); // 很快的一下
  await sleep(400);
  const x1 = (await catchState()).x;
  check('真生成的接星星：很快點一下方向鍵也會動（按鍵不會被 30 次／秒的步進吃掉）', x1 < x0, `x ${x0} → ${x1}`);
  let over = false;
  for (let i = 0; i < 60 && !over; i += 1) {
    await sleep(1000);
    over = (await catchState()).over;
  }
  if (over) {
    await page.keyboard.press('Space');
    await sleep(500);
    const st9 = await catchState();
    check('真生成的接星星：遊戲結束後快速點一下空白鍵就重來（剩下機會 3）', !st9.over && st9.lives === 3, JSON.stringify({ over: st9.over, lives: st9.lives }));
  } else check('真生成的接星星：60 秒內沒有結束（跳過重來檢查）', true, '沒有等到遊戲結束');

  // 8 眼鏡模式裡創作：捏住作品＝點它（合成的手部關鍵點，只算接線測試）；點一下螢幕開始說話（合成辨識事件），HUD 顯示聽到的字
  await page.evaluate(() => {
    window.__hand = async (open, target) => {
      const { analyzeHand, intrinsics } = await import('/hands.mjs');
      const THREE = window.__ws.THREE;
      const st = window.__ws.headset.state();
      const cam = window.__ws.headset.settings.cam;
      const make = (cx, cy) => {
        const lm = new Float32Array(63);
        const world = new Float32Array(63);
        const set = (i, x, y) => { lm.set([cx + x * 0.22, cy + y * 0.22, 0], i * 3); world.set([x * 0.09, -y * 0.09, 0], i * 3); };
        set(0, 0, 0.5); set(5, -0.25, -0.4); set(9, 0, -0.5); set(13, 0.2, -0.45); set(17, 0.38, -0.35);
        const gap = 0.12 + open * 0.68;
        set(8, -0.3, -1.05); set(4, -0.3 - gap * 0.8, -1.05 + gap * 0.6);
        for (const i of [1, 2, 3, 6, 7, 10, 11, 12, 14, 15, 16, 18, 19, 20]) set(i, 0, 0);
        return { lm, world, handedness: 'Right', score: 0.95 };
      };
      const a = analyzeHand(make(0.5, 0.5), { ...cam, width: 640, height: 480 });
      const intr = intrinsics(640, 480, cam.hfovDeg, cam.rotation);
      const eye = new THREE.Vector3().fromArray(st.eye);
      const c = new THREE.Vector3().fromArray(target).sub(eye).applyQuaternion(new THREE.Quaternion().fromArray(st.cameraQuat).invert());
      const d = a.pinchDepth;
      const u = 0.5 + ((c.x / -c.z) * (d + 0.07) - cam.offsetX) / (2 * intr.tanX * d);
      const v = 0.5 - ((c.y / -c.z) * (d + 0.07)) / (2 * intr.tanY * d);
      window.__ws.headset.injectResult({ hands: [make(0.5 + (u - a.pinch.x), 0.5 + (v - a.pinch.y))] });
    };
    window.__frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    // 轉頭看向某一點（模擬動作感測；依當下螢幕角度反解 headpose 的公式，見 tests/headset.mjs）
    window.__lookAt = async (target) => {
      const { deviceQuaternion, yawOf, screenAngle } = await import('/headpose.mjs');
      const THREE = window.__ws.THREE;
      const A = screenAngle(window);
      const st = window.__ws.headset.state();
      const d = new THREE.Vector3().fromArray(target).sub(new THREE.Vector3().fromArray(st.eye)).normalize();
      let offset = 0;
      if (window.__sensor) offset = yawOf(THREE, new THREE.Quaternion().fromArray(st.cameraQuat)) - yawOf(THREE, deviceQuaternion(THREE, window.__sensor.alpha, window.__sensor.beta, window.__sensor.gamma, A));
      const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.asin(d.y), Math.atan2(-d.x, -d.z) - offset, 0, 'YXZ'));
      const q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
      const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (-A * Math.PI) / 180);
      const e = new THREE.Euler().setFromQuaternion(want.multiply(q0.invert()).multiply(q1.invert()), 'YXZ');
      window.__sensor = { alpha: (e.y * 180) / Math.PI, beta: (e.x * 180) / Math.PI, gamma: (-e.z * 180) / Math.PI };
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor));
      window.__sensorTimer ??= setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', window.__sensor)), 50);
    };
  });
  await page.evaluate(() => window.__ws.headset.enter());
  await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', (window.__sensor = { alpha: 0, beta: 90, gamma: 0 }))));
  await page.evaluate(() => window.__frames(3));
  await page.waitForFunction(() => window.__ws.headset.active);
  // 在一個乾淨的子世界只放一個點球（根世界前面放了很多東西，射線會被擋住）：瞄它的 orb、讀它的命中數
  const orbL = (await S()).live.find((x) => x.name === '點球');
  page.__nextName = '眼鏡測試';
  const hsWorld = await page.evaluate(() => window.__ws.creation.createChild());
  await page.evaluate((id) => window.__ws.creation.enter(id), hsWorld);
  await page.waitForFunction((id) => window.__ws.creation.state().world.id === id, hsWorld);
  await page.evaluate(([lin, v]) => window.__ws.creation.placeNew(lin, v), [orbL.lineage, orbL.version]);
  await page.waitForFunction(() => window.__ws.creation.state().live.length === 1);
  const aimId = (await S()).live[0].hostId;
  const orbPos = () =>
    page.evaluate((id) => {
      const root = window.__ws.scene.getObjectByName('creation-items');
      const g = root.children.find((c) => c.userData.instId === id);
      let m = null;
      g.traverse((o) => o.userData?.entityId === 'orb' && (m = o));
      return m.getWorldPosition(new window.__ws.THREE.Vector3()).toArray();
    }, aimId);
  const hitsOf = async () => Number((await S()).live.find((x) => x.hostId === aimId).hud[0].match(/\d+/)[0]);
  const h0 = await hitsOf();
  await page.evaluate(async (t) => window.__lookAt(t), await orbPos()); // 先轉頭看它（後鏡頭只看得到前方 ±32°）
  await page.evaluate(() => window.__frames(3));
  for (let i = 0; i < 7; i += 1) {
    await page.evaluate((t) => window.__hand(1, t), await orbPos());
    await page.evaluate(() => window.__frames(3));
  }
  const hov = (await page.evaluate(() => window.__ws.headset.state())).hover;
  for (let i = 0; i < 6; i += 1) {
    await page.evaluate((t) => window.__hand(0, t), await orbPos());
    await page.evaluate(() => window.__frames(3));
    if ((await hitsOf()) > h0) break;
  }
  await sleep(300);
  check('眼鏡模式（合成手部關鍵點）：手指著作品、捏下去＝點它（不是抓物理）', (await hitsOf()) > h0 && /@v/.test(hov || ''), `hover ${hov}；命中 ${h0} → ${await hitsOf()}`);
  const started0 = await page.evaluate(() => window.__srStarted || 0);
  const jobsB4 = (await S()).jobs.length;
  await page.mouse.click(640, 400); // 點一下螢幕（使用者手勢）＝開始說話
  await page.evaluate(() => window.__say('做一個疊', false));
  await sleep(200);
  const hsLines = await page.evaluate(() => window.__ws.creation.headsetLines());
  check('眼鏡模式：點一下螢幕開始說話，頭戴 HUD 顯示聽到的字（合成辨識事件）', (await page.evaluate(() => window.__srStarted || 0)) === started0 + 1 && hsLines[0].includes('做一個疊'), hsLines.join(' / '));
  await page.evaluate(() => window.__say('做一個疊塔', true));
  await page.waitForFunction((n) => window.__ws.creation.state().jobs.length === n + 1, jobsB4);
  check('眼鏡模式：說完只送出一個工作（來源 voice）', (await S()).jobs.length === jobsB4 + 1);
  await page.screenshot({ path: path.join(OUT, '04-headset-create.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__ws.headset.active);

  connectorOn = false;
  await loop2;
  check('頁面沒有錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
  report.notes.connectorHandled = handled;
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  connectorOn = false;
  await browser.close();
  server.kill();
  await sleep(200);
  rmSync(DATA, { recursive: true, force: true });
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過（輸出：${OUT}）`);
process.exit(failed.length ? 1 : 0);
