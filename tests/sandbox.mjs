// 創作世界：瀏覽器端作品沙盒（public/sandbox/runner.html＋public/sandbox-host.mjs）測試。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾、Codex 不存在），不碰正式 5310；
// 另外開一個「誘餌」伺服器（127.0.0.1:5362）：沙盒裡只要有一個請求真的送出去，這裡就會記到。
//   1. 正常作品：同作品兩個實例各自 tick／event，狀態互不污染；view 變成 mesh（原地更新、點擊 pick）
//   2. 惡意作品：fetch、XHR、importScripts、eval、new Function、parent／cookie／localStorage、假造 postMessage… 全部失敗或被丟掉；
//      另外直接驗沙盒 iframe 本身（CSP＋不同源），並模擬「前置程式被突破、作品拿到真的 postMessage」時 runner 仍只轉送自己的實例
//   3. 無限迴圈：300 ms 逾時停掉那個 Worker、onError 收到、父頁 rAF 照跑、其他作品照常更新；卡住的 init／最外層也有時限
//   4. 格式錯誤：實體超量被截、怪 shape／超大座標被擋、壞顏色／大小／透明度被改成安全值；作品丟例外只停那個實例
//   5. snapshot → kill → 新版本 spawn（migrate、stateSchema 2）；同一格換版（原地更新）、換版失敗舊的照跑、影子試跑
//   6. 資源釋放：同一作品 load→spawn→tick→kill→unload 20 次，Worker 和 Three.js 資源回到基準；dispose 收乾淨
//   node tests/sandbox.mjs          輸出 tests/out/sandbox/（截圖、report.json）
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'sandbox');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), checks: results, notes: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const SW = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const PORT = 5361;
const CANARY_PORT = 5362;
const CANARY = `http://127.0.0.1:${CANARY_PORT}/leak`;

// ---------------- 測試用作品（main.js 的內容；不能有 import／export） ----------------
const COUNTER = `
// 計數器：每步 n+1，按著 action 一步 +100；點到 ball 就 clicks+1、球變紅
vibe.define({
  init(params) {
    return { n: 0, clicks: 0, seed: params.seed, r: vibe.random() };
  },
  tick(state, dt, input) {
    state.n += input.keys.action ? 100 : 1;
    state.lastT = input.t;
  },
  view(state) {
    return [
      { id: 'base', shape: 'box', pos: [0, 0.05, 0], size: [2, 0.1, 2], color: '#203040' },
      { id: 'ball', shape: 'sphere', pos: [0, 0.8, 0], size: [0.45], color: state.clicks ? '#ff3030' : '#30ff60' },
      { id: 'ring', shape: 'torus', pos: [0, 0.8, 0], rot: [Math.PI / 2, 0, 0], size: [0.7, 0.05], color: '#ffd166', emissive: '#332200' },
      { id: 'label', shape: 'text', pos: [0, 1.8, 0], size: [0.35], text: 'n=' + state.n, color: '#ffffff' },
    ];
  },
  hud(state) {
    return ['n ' + state.n, 'clicks ' + state.clicks];
  },
  onEvent(state, ev) {
    if (ev.type === 'click' && ev.target === 'ball') state.clicks += 1;
    state.by = ev.by;
  },
});
`;

// 惡意作品：在最外層、init、tick 都試著連網、讀秘密、跑動態程式、假造訊息；結果記在 state.log（存檔讀得到）
const EVIL = `
var log = [];
var secrets = [];
var CANARY = '${CANARY}';
function probe(tag, name, fn) {
  try {
    var r = fn();
    log.push(tag + name + ':ok:' + String(r).slice(0, 40));
    if (typeof r === 'string' && /SECRET/.test(r)) secrets.push(r);
  } catch (e) {
    log.push(tag + name + ':' + (e && e.name));
  }
}
function attack(tag) {
  probe(tag, 'fetch', function () { return fetch(CANARY + '?fetch=' + tag); });
  probe(tag, 'fetchSelf', function () { return self.fetch('/api/state?evil=' + tag); });
  probe(tag, 'fetchProto', function () {
    for (var o = self; o; o = Object.getPrototypeOf(o)) {
      var d = Object.getOwnPropertyDescriptor(o, 'fetch');
      if (d && typeof d.value === 'function') return d.value.call(self, CANARY + '?proto=' + tag);
    }
    throw new TypeError('no fetch anywhere');
  });
  probe(tag, 'xhr', function () { var x = new XMLHttpRequest(); x.open('GET', CANARY + '?xhr=' + tag, false); x.send(); return x.responseText; });
  probe(tag, 'importScripts', function () { return importScripts(CANARY + '?import=' + tag); });
  probe(tag, 'WebSocket', function () { return new WebSocket('ws://127.0.0.1:${CANARY_PORT}/ws'); });
  probe(tag, 'EventSource', function () { return new EventSource(CANARY + '?es=' + tag); });
  probe(tag, 'Worker', function () { return new Worker(CANARY + '?worker=' + tag); });
  probe(tag, 'blobURL', function () { return URL.createObjectURL(new Blob(['fetch("' + CANARY + '?blob")'])); });
  probe(tag, 'eval', function () { return eval('1 + 1'); });
  probe(tag, 'indirectEval', function () { return (0, globalThis.eval)('1 + 1'); });
  probe(tag, 'newFunction', function () { return new Function('return 1')(); });
  probe(tag, 'fnCtor', function () { return (function () {}).constructor('return 1')(); });
  probe(tag, 'asyncFnCtor', function () { return (async function () {}).constructor('return 1'); });
  probe(tag, 'timerString', function () { return setTimeout('1 + 1', 0); });
  probe(tag, 'parentDoc', function () { return parent.document.cookie; });
  probe(tag, 'localStorage', function () { return localStorage.getItem('vw_secret'); });
  probe(tag, 'cookie', function () { return document.cookie; });
  probe(tag, 'indexedDB', function () { return indexedDB.open('steal'); });
  probe(tag, 'caches', function () { return caches.keys(); });
  probe(tag, 'navigator', function () { return navigator.userAgent; });
  probe(tag, 'wasm', function () { return WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); });
  probe(tag, 'postMessage', function () { return self.postMessage({ id: 3, ok: true, out: [['A', { view: [{ id: 'forged', shape: 'box', pos: [0, 3, 0] }] }]] }); });
  probe(tag, 'postMessageProto', function () { var pm = Object.getPrototypeOf(self).postMessage || DedicatedWorkerGlobalScope.prototype.postMessage; return pm.call(self, 'forged'); });
  probe(tag, 'close', function () { return self.close(); });
  probe(tag, 'dispatchFake', function () { return self.dispatchEvent(new MessageEvent('message', { data: { id: 99, op: 'kill', inst: 'E' } })); });
  probe(tag, 'dynImport', function () {
    return import(CANARY + '?dynimport=' + tag).then(
      function () { log.push(tag + 'dynImport.async:ok'); },
      function (e) { log.push(tag + 'dynImport.async:' + (e && e.name)); });
  });
}
attack('top.');
vibe.define({
  init(params) {
    attack('init.');
    return { n: 0, log: log, secrets: secrets };
  },
  tick(state) {
    state.n += 1;
    if (state.n === 1) attack('tick.');
  },
  view(state) {
    return [{ id: 'skull', shape: 'cone', pos: [0, 0.6, 0], size: [0.5, 1.2], color: '#aa00ff' }];
  },
  hud(state) {
    return ['evil ' + state.n, 'secrets ' + state.secrets.join(',')].concat(state.log.filter(function (l) { return l.indexOf(':ok') >= 0; }).slice(0, 2));
  },
});
`;
const DANGEROUS = ['fetch', 'fetchSelf', 'fetchProto', 'xhr', 'importScripts', 'WebSocket', 'EventSource', 'Worker', 'blobURL', 'eval', 'indirectEval',
  'newFunction', 'fnCtor', 'asyncFnCtor', 'timerString', 'parentDoc', 'localStorage', 'cookie', 'indexedDB', 'caches', 'navigator', 'wasm',
  'postMessage', 'postMessageProto', 'close'];

// 模擬前置程式被突破：測試在 runner 那頁（用 DevTools 協定）偷偷在 Worker 原始碼最前面加一行，讓作品拿到真的 postMessage
const LEAKY = `
// LEAKY_PROBE
var lastId = 0;
self.addEventListener('message', function (e) { if (e.data && typeof e.data.id === 'number') lastId = e.data.id; });
function bytes(o) { return new TextEncoder().encode(JSON.stringify(o)).buffer; }
vibe.define({
  init(params) { return { n: 0, mode: params.mode }; },
  tick(s) {
    s.n += 1;
    if (s.n !== 2) return;
    if (s.mode === 'raw') self.__leak({ id: lastId + 1, ok: true, out: [['A', { view: [{ id: 'forged', shape: 'box', pos: [0, 3, 0] }], total: 1, hud: ['HACKED'] }]] });
    if (s.mode === 'steal') {
      var b = bytes({ id: lastId + 1, ok: true, out: [
        ['A', { view: [{ id: 'forged', shape: 'box', pos: [0, 3, 0] }], total: 1, hud: ['HACKED'] }],
        ['L2', { view: [{ id: 'mine', shape: 'box', pos: [0, 1, 0], color: '#123456' }], total: 1, hud: ['own forged'] }],
      ] });
      self.__leak(b, [b]);
    }
    if (s.mode === 'huge') { var big = new ArrayBuffer(16 * 1024 * 1024); self.__leak(big, [big]); }
  },
  view(s) { return [{ id: 'cube', shape: 'box', pos: [0, 0.5, 0], color: '#888888' }]; },
  hud(s) { return ['leaky ' + s.n]; },
});
`;

const SPIN = `
vibe.define({
  init() { return { n: 0 }; },
  tick(s) {
    s.n += 1;
    if (s.n >= 4) { for (;;) {} }
  },
  view(s) { return [{ id: 'cube', shape: 'box', pos: [0, 0.5, 0], color: '#ff8800' }]; },
  hud(s) { return ['spin ' + s.n]; },
});
`;
const SPIN_INIT = `vibe.define({ init() { for (;;) {} }, tick() {}, view() { return []; } });`;
const SPIN_TOP = `for (;;) {}\nvibe.define({ init() { return {}; }, tick() {}, view() { return []; } });`;

const BAD = `
vibe.define({
  init() { return { k: 0 }; },
  tick(s) { s.k += 1; },
  view(s) {
    var out = [
      { id: 'ok1', shape: 'box', pos: [0, 0.5, 0], color: '#00ff00' },
      { id: 'pyr', shape: 'pyramid', pos: [0, 0, 0] },
      { id: 'far', shape: 'box', pos: [1e6, 0, 0] },
      { id: 'nan', shape: 'box', pos: [NaN, 0, 0] },
      { id: 'short', shape: 'box', pos: [0, 0] },
      { id: 'x'.repeat(60), shape: 'box', pos: [0, 0, 0] },
      { id: 'ok1', shape: 'sphere', pos: [1, 1, 1] },
      42,
      null,
      { id: 'red', shape: 'box', pos: [1, 0.5, 0], color: 'red' },
      { id: 'css', shape: 'box', pos: [1.5, 0.5, 0], color: 'url(javascript:alert(1))' },
      { id: 'big', shape: 'sphere', pos: [2, 0.5, 0], size: [1000] },
      { id: 'tiny', shape: 'box', pos: [2.5, 0.5, 0], size: [0, -1, 1e-9] },
      { id: 'ghost', shape: 'box', pos: [3, 0.5, 0], opacity: 5 },
      { id: 'label', shape: 'text', pos: [0, 2, 0], text: '長'.repeat(100), color: '#ffffff' },
      { id: 'objcolor', shape: 'box', pos: [3.5, 0.5, 0], color: { toString: function () { return '#ffffff'; } } },
    ];
    for (var i = 0; i < 50; i += 1) out.push({ id: 'b' + i, shape: 'box', pos: [(i % 10) - 5, 0.1, -2 - Math.floor(i / 10)], size: [0.2, 0.2, 0.2] });
    return out;
  },
  hud() { return ['x'.repeat(100), 'b', 'c', 'd', 'e', 'f']; },
});
`;
const WEIRD = `
vibe.define({
  init() { return {}; },
  tick() {},
  view() { return { not: 'an array' }; },
  hud() { return 12345; },
});
`;
const BOOM = `
vibe.define({
  init(params) { return { n: 0, safe: !!params.safe }; },
  tick(s) {
    s.n += 1;
    if (!s.safe && s.n === 3) {
      var o = null;
      return o.boom;
    }
  },
  view(s) { return [{ id: 'c', shape: 'cylinder', pos: [0, 0.5, 0], size: [0.3, 1], color: s.safe ? '#00aaff' : '#ff0000' }]; },
  hud(s) { return ['boom ' + s.n]; },
});
`;
const BOOM_LINE = BOOM.split('\n').findIndex((l) => l.includes('o.boom')) + 1;

// 載不起來的作品：父頁要拿到看得懂的原因（附 main.js 行號）
const LOAD_FAILS = {
  syntax: { code: 'vibe.define({\n  init() { return {}; },\n  tick() { if ( },\n  view() { return []; },\n});', expect: /無法執行.*（main\.js 第 3 行）/ },
  importStmt: { code: "import x from '/sandbox-host.mjs';\nvibe.define({ init() { return {}; }, tick() {}, view() { return []; } });", expect: /無法執行.*import/ },
  topThrow: { code: "var a = 1;\nthrow new Error('最外層壞掉');\n", expect: /最外層出錯.*最外層壞掉.*（main\.js 第 2 行）/ },
  noDefine: { code: 'var x = 1;', expect: /沒有呼叫 vibe\.define/ },
  missingView: { code: 'vibe.define({ init() { return {}; }, tick() {} });', expect: /少了 view\(\)/ },
  twice: { code: 'var d = { init() { return {}; }, tick() {}, view() { return []; } };\nvibe.define(d);\nvibe.define(d);', expect: /只能呼叫一次/ },
};
const INIT_UNDEFINED = 'vibe.define({ init() {}, tick() {}, view() { return []; } });';

const MIG1 = `
vibe.define({
  init() { return { score: 0, v: 1 }; },
  tick(s) { s.score += 1; },
  view(s) {
    return [
      { id: 'pad', shape: 'box', pos: [0, 0.05, 0], size: [1.2, 0.1, 1.2], color: '#3366ff' },
      { id: 'score', shape: 'text', pos: [0, 1.2, 0], size: [0.3], text: 'v1 ' + s.score },
    ];
  },
  hud(s) { return ['v1 score ' + s.score]; },
});
`;
const MIG2 = `
vibe.define({
  init() { return { score: 0, combo: 0, v: 2 }; },
  tick(s) { s.score += 1; s.combo += 2; },
  view(s) {
    return [
      { id: 'pad', shape: 'box', pos: [0, 0.05, 0], size: [1.2, 0.1, 1.2], color: '#ff3366' },
      { id: 'score', shape: 'text', pos: [0, 1.2, 0], size: [0.3], text: 'v2 ' + s.score + '/' + s.combo },
    ];
  },
  hud(s) { return ['v2 score ' + s.score + ' combo ' + s.combo]; },
  migrate(old, from) { return Object.assign({}, old, { combo: 0, v: 2, migratedFrom: from }); },
});
`;
const MIG3 = `
vibe.define({
  init() { return {}; },
  tick() {},
  view() { return []; },
  migrate(old, from) { throw new Error('migrate 壞掉了'); },
});
`;

const CYCLE = `
vibe.define({
  init() { return { n: 0 }; },
  tick(s) { s.n += 1; },
  view(s) {
    return [
      { id: 'a', shape: 'box', pos: [0, 0.5, 0] },
      { id: 'b', shape: 'sphere', pos: [1, 0.5, 0], size: [0.3] },
      { id: 'c', shape: 'cylinder', pos: [-1, 0.5, 0] },
      { id: 'd', shape: 'cone', pos: [0, 1.5, 0] },
      { id: 'e', shape: 'torus', pos: [0, 2.5, 0], size: [0.4, 0.1] },
      { id: 'f', shape: 'plane', pos: [0, 0.01, 0], rot: [-Math.PI / 2, 0, 0], size: [3, 3] },
      { id: 'g', shape: 'text', pos: [0, 3, 0], text: '第 ' + s.n + ' 步' },
    ];
  },
  hud(s) { return ['cycle ' + s.n]; },
});
`;

// ---------------- 伺服器 ----------------
const tmpDirs = [];
let srv = null;
async function startServer() {
  const data = mkdtempSync(path.join(os.tmpdir(), 'vw-sandbox-'));
  tmpDirs.push(data);
  srv = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, CODEX_BIN: '/nonexistent/codex' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 80; i += 1) {
    if (await fetch(`${base}/api/state`).then((r) => r.ok, () => false)) return base;
    await sleep(200);
  }
  throw new Error(`測試伺服器 ${PORT} 沒有起來`);
}
// 誘餌：記下每一個送到這裡的請求（包括 WebSocket 升級）
const canaryHits = [];
const canary = http.createServer((req, res) => {
  canaryHits.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/javascript' });
  res.end('/* canary */');
});
canary.on('upgrade', (req, socket) => {
  canaryHits.push(`UPGRADE ${req.url}`);
  socket.destroy();
});
function cleanup() {
  srv?.kill();
  canary.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

const browser = await chromium.launch({ args: SW });
try {
  await new Promise((r) => canary.listen(CANARY_PORT, '127.0.0.1', r));
  const base = await startServer();
  const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // 惡意作品被 CSP 擋下時瀏覽器會印「Refused to …」：那是預期中的，不算錯誤
  page.on('console', (m) => m.type() === 'error' && !/Content Security Policy|Refused to/.test(m.text()) && consoleErrors.push(m.text().slice(0, 200)));
  // 網路：Playwright 也會回報被 CSP 擋下的嘗試（之後觸發 requestfailed），和 Worker 的 blob: 程式（不是網路）；
  // 真的送出去的請求一定會收到回應，所以「有回應的請求」才算數
  const requests = [];
  const responses = [];
  const failures = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => responses.push(r.url()));
  page.on('requestfailed', (r) => failures.push({ url: r.url(), error: r.failure()?.errorText || '' }));
  const workerLog = { opened: 0, closed: 0, closes: [] };
  page.on('worker', (w) => {
    workerLog.opened += 1;
    w.on('close', () => {
      workerLog.closed += 1;
      workerLog.closes.push(Date.now());
    });
  });
  const liveWorkers = async (expect, ms = 5000) => {
    // Worker 結束要一點時間才會反映到 DevTools（卡在忙迴圈的要等 Chromium 約 2 秒後強制停止）：最多等 ms
    const t0 = Date.now();
    while (Date.now() - t0 < ms && page.workers().length !== expect) await sleep(50);
    return page.workers().length;
  };

  await page.goto(`${base}/legal.html`);
  // 父頁的秘密：作品如果讀得到，就會出現在 HUD／存檔裡
  await page.evaluate(() => {
    document.cookie = 'vw_secret=COOKIE_SECRET_123; path=/';
    localStorage.setItem('vw_secret', 'LS_SECRET_456');
  });
  const control = await page.evaluate((url) => fetch(`${url}?control`).then((r) => r.status, (e) => e.name), CANARY);
  check('誘餌伺服器正常（沒有沙盒的父頁連得到，表示「沙盒 0 次」不是假的）', control === 200 && canaryHits.length === 1, `${control} ${canaryHits.join(',')}`);
  canaryHits.length = 0;

  await page.evaluate(async () => {
    const THREE = await import('/vendor/three/build/three.module.js');
    const { createSandboxHost } = await import('/sandbox-host.mjs');
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:10';
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(960, 540, false);
    renderer.shadowMap.enabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1220');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(5, 10, 6);
    sun.castShadow = true;
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#1a2333' }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const camera = new THREE.PerspectiveCamera(50, 960 / 540, 0.1, 200);
    camera.position.set(0, 7, 14);
    camera.lookAt(0, 1, -1);
    const root = new THREE.Group();
    scene.add(root);
    const T = (window.__T = { THREE, scene, root, camera, renderer, huds: {}, hudLog: [], errors: [] });
    T.mkHost = () => createSandboxHost({
      THREE,
      root,
      onHud: (id, lines) => {
        T.huds[id] = lines;
        T.hudLog.push({ id, lines, at: performance.now() });
      },
      onError: (id, message, info) => {
        T.errors.push({ id, message, ...info, at: performance.now(), wall: Date.now() });
        T.onErrorHook?.(id, message, info);
      },
    });
    T.host = T.mkHost();
    T.render = () => renderer.render(scene, camera);
    T.group = (id) => root.children.find((g) => g.userData.instId === id) || null;
    T.ent = (id, eid) => T.group(id)?.children.find((o) => o.userData.entityId === eid) || null;
    T.keys = (o = {}) => ({ left: false, right: false, up: false, down: false, action: false, ...o });
    T.ticks = async (n, inputs = {}) => {
      for (let i = 0; i < n; i += 1) await T.host.tick(1 / 30, inputs);
    };
    await T.host.ready();
  });
  const setupRequests = requests.length;
  const iframeInfo = await page.evaluate(() => {
    const f = document.querySelector('iframe');
    return { sandbox: f?.getAttribute('sandbox'), hidden: f?.hidden, src: f?.src };
  });
  check('host.ready()：建立 <iframe sandbox="allow-scripts">（沒有 allow-same-origin）、隱藏', iframeInfo.sandbox === 'allow-scripts' && iframeInfo.hidden === true && iframeInfo.src.endsWith('/sandbox/runner.html'), JSON.stringify(iframeInfo));
  const runnerHead = await fetch(`${base}/sandbox/runner.html`).then((r) => r.headers.get('content-security-policy'));
  check('runner.html 回應帶 CSP：sandbox、connect-src none、只放行雜湊和 blob（沒有 unsafe-eval／unsafe-inline）',
    /sandbox allow-scripts/.test(runnerHead) && /connect-src 'none'/.test(runnerHead) && /script-src 'sha256-[^']+' blob:/.test(runnerHead) && !/unsafe/.test(runnerHead), runnerHead.slice(0, 120));

  // ======================= 1. 正常作品 =======================
  const r1 = await page.evaluate(async (code) => {
    const T = window.__T;
    const host = T.host;
    const man = { format: 'vibe-pkg/1', name: '計數器', stateSchema: 1, budgets: { entities: 50 } };
    const out = {};
    out.load = await host.load('counter@1', code, man);
    out.load2 = await host.load('counter@1', code, man);
    out.spawnA = await host.spawn('A', 'counter@1', { params: { seed: 1 } });
    out.spawnB = await host.spawn('B', 'counter@1', { params: { seed: 2 } });
    out.spawnDup = await host.spawn('A', 'counter@1', {});
    host.setTransform('A', [-3, 0, 0], 0);
    host.setTransform('B', [3, 0, 0], 0.5);
    out.workers = host.stats().workers;
    const created0 = host.stats().createdMeshes;
    const ring0 = T.ent('A', 'ring');
    const label0 = T.ent('A', 'label');
    for (let i = 0; i < 5; i += 1) {
      await host.tick(1 / 30, { A: { keys: T.keys({ action: true }), player: { x: 1, y: 1.6, z: 5 } }, B: { keys: T.keys(), player: { x: -1, y: 1.6, z: 5 } } });
    }
    out.createdDuringTicks = host.stats().createdMeshes - created0;
    out.sameObjects = T.ent('A', 'ring') === ring0 && T.ent('A', 'label') === label0;
    // 從鏡頭打一條射線到 A 的球 → pick → 送 click
    T.root.updateWorldMatrix(true, true);
    const p = T.ent('A', 'ball').getWorldPosition(new T.THREE.Vector3());
    const rc = new T.THREE.Raycaster(T.camera.position.clone(), p.clone().sub(T.camera.position).normalize());
    rc.camera = T.camera;
    out.pick = host.pick(rc);
    out.pickMiss = host.pick(new T.THREE.Raycaster(new T.THREE.Vector3(0, 40, 0), new T.THREE.Vector3(0, 1, 0)));
    out.event = await host.event(out.pick?.instId, { type: 'click', target: out.pick?.entityId, by: 'pointer', junk: { big: 'x'.repeat(1000) } });
    out.eventBad = await host.event('A', { nope: 1 });
    await host.tick(1 / 30, {});
    out.sa = await host.snapshot('A');
    out.sb = await host.snapshot('B');
    out.colorA = T.ent('A', 'ball').material.color.getHexString();
    out.colorB = T.ent('B', 'ball').material.color.getHexString();
    out.labelA = T.ent('A', 'label').userData.text;
    out.labelType = T.ent('A', 'label').type;
    out.ids = T.group('A').children.map((o) => o.userData.entityId);
    out.groupInst = T.group('A').userData.instId;
    out.counts = [T.group('A').children.length, T.group('B').children.length];
    out.posA = T.group('A').position.toArray();
    out.rotB = T.group('B').rotation.y;
    out.ballScale = T.ent('A', 'ball').scale.toArray();
    out.huds = { A: T.huds.A, B: T.huds.B };
    out.stats = host.stats();
    out.errors = T.errors.slice();
    T.render();
    out.gpu = { geometries: T.renderer.info.memory.geometries, textures: T.renderer.info.memory.textures, calls: T.renderer.info.render.calls };
    return out;
  }, COUNTER);
  report.notes.normal = r1;
  check('1. 載入作品、同一版本載入兩次只有一個 Worker；兩個實例共用', r1.load.ok && r1.load2.ok && r1.spawnA.ok && r1.spawnB.ok && r1.workers === 1, JSON.stringify({ load: r1.load, workers: r1.workers }));
  check('1. 同一個實例 id 不能再 spawn 同一個版本', r1.spawnDup.ok === false, r1.spawnDup.error);
  check('1. 兩個實例狀態互不污染（A 按著 action、被點一次；B 沒有）', r1.sa.state.n === 501 && r1.sa.state.clicks === 1 && r1.sb.state.n === 6 && r1.sb.state.clicks === 0 && r1.sa.schema === 1,
    `A ${JSON.stringify(r1.sa.state)} B ${JSON.stringify(r1.sb.state)}`);
  check('1. 每個實例自己的 vibe.random 種子（seed 1 ≠ seed 2）', typeof r1.sa.state.r === 'number' && r1.sa.state.r !== r1.sb.state.r, `${r1.sa.state.r} / ${r1.sb.state.r}`);
  check('1. input.t 是實例自己的累計秒數', Math.abs(r1.sa.state.lastT - 0.2) < 1e-6, r1.sa.state.lastT);
  check('1. view 變成 Three.js 物件：每實例一個 Group（userData.instId），每個實體 userData.entityId', r1.groupInst === 'A' && r1.counts.join() === '4,4' && r1.ids.join() === 'base,ball,ring,label' && r1.labelType === 'Sprite' && r1.stats.meshes === 8,
    `${r1.ids.join(',')} meshes ${r1.stats.meshes}`);
  check('1. 同一 id 原地更新（tick 5 次沒有新建任何 mesh、物件還是同一個）', r1.createdDuringTicks === 0 && r1.sameObjects, `新建 ${r1.createdDuringTicks}`);
  check('1. 換顏色改材質：A 的球被點後變紅、B 還是綠', r1.colorA === 'ff3030' && r1.colorB === '30ff60', `${r1.colorA} / ${r1.colorB}`);
  check('1. 文字實體跟著狀態更新', r1.labelA === 'n=501', r1.labelA);
  check('1. pick：射線打到 A 的球；打空回 null', r1.pick?.instId === 'A' && r1.pick?.entityId === 'ball' && r1.pickMiss === null, JSON.stringify(r1.pick));
  check('1. 事件只轉送認得的欄位（type、target、by…）；格式不對直接拒絕', r1.event.ok && r1.sa.state.by === 'pointer' && r1.eventBad.ok === false, `by=${r1.sa.state.by}；${r1.eventBad.error}`);
  check('1. HUD 各自回報', r1.huds.A?.join('|') === 'n 501|clicks 1' && r1.huds.B?.join('|') === 'n 6|clicks 0', JSON.stringify(r1.huds));
  check('1. setTransform 生效、size 用 scale（球半徑 0.45）', r1.posA.join() === '-3,0,0' && Math.abs(r1.rotB - 0.5) < 1e-9 && r1.ballScale.every((v) => Math.abs(v - 0.45) < 1e-9));
  check('1. 沒有任何錯誤回報', r1.errors.length === 0, JSON.stringify(r1.errors).slice(0, 200));
  check('1. 真的畫得出來（WebGL 上有幾何和文字貼圖）', r1.gpu.geometries >= 4 && r1.gpu.textures >= 2 && r1.gpu.calls >= 8, JSON.stringify(r1.gpu));
  await page.screenshot({ path: path.join(OUT, 'sandbox-01-normal.png'), clip: { x: 0, y: 0, width: 960, height: 540 } });

  // ======================= 2. 惡意作品 =======================
  const r2 = await page.evaluate(async (code) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    out.load = await host.load('evil@1', code, { name: 'evil', stateSchema: 1 });
    out.spawn = await host.spawn('E', 'evil@1', {});
    host.setTransform('E', [0, 0, -3], 0);
    await T.ticks(4);
    await new Promise((r) => setTimeout(r, 600)); // 等非同步的嘗試（動態 import）有結果
    await T.ticks(2);
    out.snap = await host.snapshot('E');
    out.hudE = T.huds.E;
    out.allHud = JSON.stringify(T.hudLog);
    out.inst = host.instances().find((i) => i.id === 'E');
    out.forged = !!T.ent('A', 'forged') || !!T.ent('E', 'forged');
    out.instA = host.instances().find((i) => i.id === 'A');
    out.errorsE = T.errors.filter((e) => e.id === 'E');
    out.parentCookie = document.cookie;
    out.parentLs = localStorage.getItem('vw_secret');
    return out;
  }, EVIL);
  const evilLog = r2.snap?.state?.log || [];
  report.notes.evilLog = evilLog;
  check('2. 惡意作品照樣能載入、執行（攻擊失敗不影響它自己）', r2.load.ok && r2.spawn.ok && r2.inst?.status === 'running' && r2.snap.state.n === 6, JSON.stringify(r2.inst));
  const tags = ['top.', 'init.', 'tick.'];
  const leaked = [];
  for (const tag of tags) for (const name of DANGEROUS) {
    const entry = evilLog.find((l) => l.startsWith(`${tag}${name}:`));
    if (!entry || entry.startsWith(`${tag}${name}:ok`)) leaked.push(entry || `${tag}${name}:沒有紀錄`);
  }
  check(`2. 最外層／init／tick 的 ${DANGEROUS.length} 種嘗試（fetch、XHR、importScripts、WebSocket、eval、new Function、parent、cookie、localStorage、postMessage…）全部失敗`,
    leaked.length === 0 && evilLog.length >= tags.length * DANGEROUS.length, leaked.join(' | ') || `${evilLog.length} 筆紀錄`);
  const dyn = evilLog.filter((l) => l.includes('dynImport.async'));
  check('2. 動態 import() 載入外部程式失敗', dyn.length === 3 && dyn.every((l) => !l.endsWith(':ok')), dyn.join(', '));
  check('2. 讀不到父頁的 cookie／localStorage（HUD 和存檔裡都沒有秘密）', r2.snap.state.secrets.length === 0 && !/COOKIE_SECRET|LS_SECRET/.test(r2.allHud) && !/COOKIE_SECRET|LS_SECRET/.test(JSON.stringify(r2.snap)),
    `secrets ${JSON.stringify(r2.snap.state.secrets)}`);
  check('2. 父頁的 cookie／localStorage 原封不動', r2.parentCookie.includes('COOKIE_SECRET_123') && r2.parentLs === 'LS_SECRET_456');
  check('2. 假造 postMessage 失敗、假造的 kill 指令被忽略（E 還在跑）、別人的實例沒被塞東西', !r2.forged && r2.inst.status === 'running' && r2.instA.status === 'running' && r2.errorsE.length === 0,
    evilLog.filter((l) => /postMessage|dispatchFake/.test(l)).slice(0, 3).join(', '));

  // 直接驗沙盒 iframe 這一層（不靠前置程式）：用 DevTools 協定在 runner 那頁執行
  const fr = page.frames().find((f) => f.url().endsWith('/sandbox/runner.html'));
  const direct = await fr.evaluate(async ({ canary, canaryPort }) => {
    const res = { origin: self.origin };
    try { res.cookie = document.cookie; } catch (e) { res.cookie = e.name; }
    try { res.localStorage = localStorage.getItem('vw_secret'); } catch (e) { res.localStorage = e.name; }
    try { res.parentDoc = parent.document.cookie; } catch (e) { res.parentDoc = e.name; }
    try { res.parentLs = parent.localStorage.getItem('vw_secret'); } catch (e) { res.parentLs = e.name; }
    res.fetchSelf = await fetch('/api/state').then(() => 'ok', (e) => e.name);
    res.fetchCanary = await fetch(`${canary}?frame`).then(() => 'ok', (e) => e.name);
    // 沒有前置程式保護的 blob Worker：只剩 CSP（從 iframe 繼承）擋
    const src = `
      const r = {};
      const t = (k, f) => { try { f(); r[k] = 'ok'; } catch (e) { r[k] = e.name; } };
      t('eval', () => eval('1'));
      t('newFunction', () => new Function('return 1')());
      t('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', '${canary}?wxhr', false); x.send(); });
      t('importScripts', () => importScripts('${canary}?wimport'));
      // WebSocket 被 CSP 擋時不會當場丟例外，而是之後觸發 error：要等結果
      const ws = new Promise((res) => {
        let s;
        try { s = new WebSocket('ws://127.0.0.1:${canaryPort}/ws'); } catch (e) { res(e.name); return; }
        s.onopen = () => res('ok');
        s.onerror = () => res('error-event');
        setTimeout(() => res('timeout'), 3000);
      });
      Promise.all([
        fetch('${canary}?wfetch').then(() => 'ok', (e) => e.name),
        import('${canary}?wdyn').then(() => 'ok', (e) => e.name),
        WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => 'ok', (e) => e.name),
        ws,
      ]).then(([f, d, w, s]) => { r.fetch = f; r.dynImport = d; r.wasm = w; r.WebSocket = s; postMessage(r); });
    `;
    const url = URL.createObjectURL(new Blob([src]));
    const w = new Worker(url);
    res.worker = await new Promise((resolve) => {
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => resolve(`error ${e.message}`);
      setTimeout(() => resolve('timeout'), 8000);
    });
    w.terminate();
    URL.revokeObjectURL(url);
    return res;
  }, { canary: CANARY, canaryPort: CANARY_PORT });
  report.notes.directFrame = direct;
  check('2. 沙盒 iframe 本身：origin 是 "null"，讀 cookie／localStorage／parent.document 都是 SecurityError',
    direct.origin === 'null' && ['cookie', 'localStorage', 'parentDoc', 'parentLs'].every((k) => direct[k] === 'SecurityError'), JSON.stringify(direct).slice(0, 160));
  check('2. 沙盒 iframe 本身：fetch 回自己的伺服器、連誘餌都被 CSP 擋', direct.fetchSelf === 'TypeError' && direct.fetchCanary === 'TypeError');
  const dw = direct.worker && typeof direct.worker === 'object' ? direct.worker : {};
  check('2. 沒有前置程式的 blob Worker（只靠繼承來的 CSP）：eval／new Function／XHR／importScripts／WebSocket／fetch／動態 import／WebAssembly 全部失敗',
    ['eval', 'newFunction', 'xhr', 'importScripts', 'WebSocket', 'fetch', 'dynImport', 'wasm'].every((k) => dw[k] && dw[k] !== 'ok' && dw[k] !== 'timeout'), JSON.stringify(direct.worker));

  // 模擬前置程式被突破：作品拿到真的 postMessage 之後亂送（raw 物件、假造別人的實例、16 MB）
  await fr.evaluate(() => {
    const RealBlob = window.Blob;
    window.__RealBlob = RealBlob;
    window.Blob = function Blob(parts, opts) {
      if (Array.isArray(parts) && typeof parts[0] === 'string' && parts[0].includes('LEAKY_PROBE')) parts = ['self.__leak = self.postMessage.bind(self);\n', ...parts];
      return new RealBlob(parts, opts);
    };
  });
  const r2b = await page.evaluate(async (code) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    const modes = ['raw', 'steal', 'huge'];
    for (let i = 0; i < modes.length; i += 1) {
      out[`load${i + 1}`] = await host.load(`leaky@${i + 1}`, code, {});
      out[`spawn${i + 1}`] = await host.spawn(`L${i + 1}`, `leaky@${i + 1}`, { params: { mode: modes[i] } });
    }
    const aBefore = T.huds.A.join('|');
    await T.ticks(4);
    await new Promise((r) => setTimeout(r, 200));
    await T.ticks(2);
    out.insts = host.instances().filter((i) => /^L/.test(i.id)).map((i) => ({ id: i.id, status: i.status, error: i.error }));
    out.errors = T.errors.filter((e) => /^L/.test(e.id)).map((e) => ({ id: e.id, kind: e.kind, fatal: e.fatal, message: e.message }));
    out.forgedInA = !!T.ent('A', 'forged');
    out.hackedHud = T.hudLog.some((h) => h.id !== 'L2' && h.lines.some((l) => l.includes('HACKED')));
    out.l2Mine = !!T.ent('L2', 'mine');
    out.aStatus = host.instances().find((i) => i.id === 'A').status;
    out.aMoved = T.huds.A.join('|') !== aBefore;
    out.workers = host.stats().workers;
    return out;
  }, LEAKY);
  await fr.evaluate(() => {
    window.Blob = window.__RealBlob;
  });
  report.notes.compromised = r2b;
  const crashed = (id) => r2b.insts.find((i) => i.id === id)?.status === 'dead' && r2b.errors.some((e) => e.id === id && e.kind === 'crash' && e.fatal);
  check('2. 模擬前置程式被突破：送 raw 物件、送不認得的回覆、送 16 MB → runner 把那幾個 Worker 停掉並回報 crash',
    r2b.load1.ok && r2b.spawn1.ok && crashed('L1') && crashed('L2') && crashed('L3'), JSON.stringify(r2b.errors.map((e) => `${e.id}:${e.kind}`)));
  check('2. 假造的回覆只轉送「屬於那個 Worker」的實例：別人的實例（A）沒被塞實體、HUD 沒被改，A 照常更新',
    !r2b.forgedInA && !r2b.hackedHud && r2b.aStatus === 'running' && r2b.aMoved, `L2 自己的假實體 ${r2b.l2Mine ? '有' : '沒有'}套用（屬於自己，照樣逐項檢查）`);

  // ======================= 3. 無限迴圈 =======================
  const closedBefore = workerLog.closed;
  const r3 = await page.evaluate(async ({ spin, spinInit, spinTop }) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    // 對照組：沒有卡住的作品時，這台機器上 1 秒有幾次 rAF（headless＋軟體繪圖本來就不一定到 60）
    out.baseline = await new Promise((resolve) => {
      let n = 0;
      const t0 = performance.now();
      const f = () => {
        n += 1;
        host.tick(1 / 60, {});
        if (performance.now() - t0 < 1000) requestAnimationFrame(f);
        else resolve(n);
      };
      requestAnimationFrame(f);
    });
    await host.tick(1 / 60, {}); // 等最後一個在途的回來
    out.load = await host.load('spin@1', spin, {});
    out.spawn = await host.spawn('S', 'spin@1', {});
    host.setTransform('S', [0, 0, 3], 0);
    out.workers0 = host.stats().workers;
    out.timeouts0 = host.stats().timeouts;
    const errStart = T.errors.length;
    const aBefore = (await host.snapshot('A')).state.n;
    // rAF 驅動：每幀 tick 一次（不等），量 1.5 秒
    const t0 = performance.now();
    let frames = 0;
    let firstSecond = 0;
    await new Promise((resolve) => {
      const loop = () => {
        const now = performance.now();
        frames += 1;
        if (now - t0 <= 1000) firstSecond += 1;
        host.tick(1 / 60, {});
        if (now - t0 < 1500) requestAnimationFrame(loop);
        else resolve();
      };
      requestAnimationFrame(loop);
    });
    const sErr = T.errors.slice(errStart).find((e) => e.id === 'S');
    const sHuds = T.hudLog.filter((h) => h.id === 'S');
    const lastGood = sHuds.length ? sHuds[sHuds.length - 1] : null;
    out.lastGoodHud = lastGood?.lines;
    out.sErr = sErr || null;
    out.latency = sErr && lastGood ? Math.round(sErr.at - lastGood.at) : -1;
    out.frames = frames;
    out.firstSecond = firstSecond;
    out.aDuringStall = sErr && lastGood ? T.hudLog.filter((h) => h.id === 'A' && h.at > lastGood.at && h.at < sErr.at).length : 0;
    out.aBefore = aBefore;
    out.aAfter = (await host.snapshot('A')).state.n;
    out.stats = host.stats();
    out.s = host.instances().find((i) => i.id === 'S');
    out.sTick = await host.tick(1 / 30, {}).then(() => 'ok');
    out.sEvent = await host.event('S', { type: 'click', target: 'cube' });
    out.sSnap = await host.snapshot('S').then(() => 'ok', (e) => e.message);
    // 卡住的 init、卡住的最外層：spawn／load 也有時限
    let t = performance.now();
    out.loadInit = await host.load('spin-init@1', spinInit, {});
    out.spawnInit = await host.spawn('SI', 'spin-init@1', {});
    out.spawnInitMs = Math.round(performance.now() - t);
    out.siExists = host.instances().some((i) => i.id === 'SI');
    t = performance.now();
    out.loadTop = await host.load('spin-top@1', spinTop, {});
    out.loadTopMs = Math.round(performance.now() - t);
    out.statsEnd = host.stats();
    return out;
  }, { spin: SPIN, spinInit: SPIN_INIT, spinTop: SPIN_TOP });
  report.notes.spin = r3;
  check('3. 卡住的作品：300 ms 左右逾時、onError 收到（fatal、timeout）', r3.sErr?.fatal === true && r3.sErr?.kind === 'timeout' && r3.latency >= 280 && r3.latency < 1000,
    `最後一次正常回覆 → 逾時通知 ${r3.latency} ms；${r3.sErr?.message}`);
  check('3. 該 Worker 被停掉（stats.workers 少 1、timeouts +1、實例標成 dead）', r3.stats.workers === r3.workers0 - 1 && r3.stats.timeouts === r3.timeouts0 + 1 && r3.s?.status === 'dead',
    `workers ${r3.workers0}→${r3.stats.workers} timeouts ${r3.timeouts0}→${r3.stats.timeouts} ${r3.s?.status}`);
  check('3. 父頁 requestAnimationFrame 照跑（1 秒內 > 10 次）', r3.firstSecond > 10, `有卡住的作品時 1 秒 ${r3.firstSecond} 次（1.5 秒 ${r3.frames} 次）；對照組（沒有卡住的）1 秒 ${r3.baseline} 次`);
  check('3. 其他作品的實例照常更新（S 卡住的那段時間 A 每一幀都有更新）', r3.aDuringStall >= 3 && r3.aAfter - r3.aBefore >= Math.floor(r3.frames * 0.8),
    `卡住期間 A 更新 ${r3.aDuringStall} 次；1.5 秒 ${r3.frames} 幀裡 A 前進 ${r3.aAfter - r3.aBefore} 步`);
  check('3. 停掉的實例：之後的 tick／event／snapshot 安全地被拒絕', r3.sTick === 'ok' && r3.sEvent.ok === false && /停止/.test(r3.sSnap), `${r3.sEvent.error} / ${r3.sSnap}`);
  check('3. init 卡住 → spawn 在時限內失敗、Worker 停掉', r3.loadInit.ok && r3.spawnInit.ok === false && r3.spawnInitMs < 2500 && !r3.siExists, `${r3.spawnInitMs} ms：${r3.spawnInit.error}`);
  check('3. 最外層卡住 → load 在時限內失敗', r3.loadTop.ok === false && r3.loadTopMs < 5000 && r3.statsEnd.workers === r3.stats.workers, `${r3.loadTopMs} ms：${r3.loadTop.error}`);
  const nowWorkers = await liveWorkers(r3.statsEnd.workers, 6000);
  // terminate() 之後瀏覽器真的把執行緒收掉要多久：S 逾時之後第一個結束的 Worker 就是它
  const sClose = r3.sErr ? workerLog.closes.find((t) => t >= r3.sErr.wall) : undefined;
  report.notes.spinThreadStopMs = sClose ? sClose - r3.sErr.wall : null;
  check('3. 瀏覽器裡真的 Worker 數量＝host 的帳（被停掉的確實結束了）', nowWorkers === r3.statsEnd.workers && workerLog.closed >= closedBefore + 3,
    `DevTools 看到 ${nowWorkers} 個；結束 ${workerLog.closed - closedBefore} 個；卡住的 S 在 terminate() 之後 ${report.notes.spinThreadStopMs ?? '?'} ms 執行緒才真的結束（Chromium 對忙迴圈約 2 秒後強制停止）`);
  await page.evaluate(() => window.__T.render());
  await page.screenshot({ path: path.join(OUT, 'sandbox-03-after-timeout.png'), clip: { x: 0, y: 0, width: 960, height: 540 } });

  // ======================= 4. 格式錯誤、例外 =======================
  const r4 = await page.evaluate(async ({ bad, weird, boom }) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    const errStart = T.errors.length;
    out.load = await host.load('bad@1', bad, { budgets: { entities: 20 } });
    out.spawn = await host.spawn('F', 'bad@1', {});
    host.setTransform('F', [-6, 0, -4], 0);
    await T.ticks(5);
    const g = T.group('F');
    out.ids = g.children.map((o) => o.userData.entityId).sort();
    out.maxAbs = Math.max(...g.children.map((o) => Math.max(...o.position.toArray().map(Math.abs))));
    const e = (id) => T.ent('F', id);
    out.bigScale = e('big').scale.toArray();
    out.tinyScale = e('tiny').scale.toArray();
    out.colors = { red: e('red').material.color.getHexString(), css: e('css').material.color.getHexString(), obj: e('objcolor').material.color.getHexString(), ok1: e('ok1').material.color.getHexString() };
    out.ghost = { opacity: e('ghost').material.opacity, transparent: e('ghost').material.transparent };
    out.labelLen = Array.from(e('label').userData.text).length;
    out.hud = T.huds.F;
    const errs = T.errors.slice(errStart).filter((x) => x.id === 'F');
    out.errs = errs.map((x) => ({ kind: x.kind, fatal: x.fatal, message: x.message }));
    out.inst = host.instances().find((i) => i.id === 'F');
    // view 不是陣列、hud 回傳數字
    out.loadW = await host.load('weird@1', weird, {});
    out.spawnW = await host.spawn('W', 'weird@1', {});
    await T.ticks(2);
    out.w = { children: T.group('W').children.length, hud: T.huds.W, errs: T.errors.filter((x) => x.id === 'W').map((x) => x.message), inst: host.instances().find((i) => i.id === 'W') };
    // 作品丟例外：只停那個實例，同一個 Worker 的另一個實例照常
    out.loadX = await host.load('boom@1', boom, {});
    out.x1 = await host.spawn('X1', 'boom@1', {});
    out.x2 = await host.spawn('X2', 'boom@1', { params: { safe: true } });
    host.setTransform('X1', [6, 0, -4], 0);
    host.setTransform('X2', [7.5, 0, -4], 0);
    await T.ticks(6);
    out.x1Inst = host.instances().find((i) => i.id === 'X1');
    out.x2Snap = await host.snapshot('X2');
    out.x1Errs = T.errors.filter((x) => x.id === 'X1').map((x) => ({ kind: x.kind, fatal: x.fatal, message: x.message }));
    out.x1Snap = await host.snapshot('X1').then(() => 'ok', (err) => err.message);
    out.x1Mesh = !!T.ent('X1', 'c');
    T.render();
    return out;
  }, { bad: BAD, weird: WEIRD, boom: BOOM });
  report.notes.format = r4;
  const expectIds = ['b0', 'b1', 'b2', 'b3', 'big', 'css', 'ghost', 'label', 'objcolor', 'ok1', 'red', 'tiny'];
  check('4. 實體超量被截到 budgets.entities（20 個裡不合格的略過，剩 12 個）', r4.ids.join() === expectIds.join(), r4.ids.join(','));
  const fmt = (re) => r4.errs.filter((x) => x.kind === 'format' && x.fatal === false && re.test(x.message));
  check('4. 超量只回報一次（tick 5 次）', fmt(/超過上限 20/).length === 1, fmt(/超過上限/).map((x) => x.message).join(' | '));
  check('4. 怪 shape、超大／NaN／缺維度的座標、太長的 id、重複 id、不是物件的實體都被擋並回報', fmt(/pyramid/).length === 1 && fmt(/pos/).length === 1 && fmt(/id 要是/).length === 1 && fmt(/重複/).length === 1 && fmt(/不是物件/).length === 1 && r4.maxAbs <= 50,
    r4.errs.map((x) => x.message).join(' | ').slice(0, 300));
  check('4. size 夾在 0.01–20、opacity 夾在 0–1', r4.bigScale.every((v) => v === 20) && r4.tinyScale.every((v) => v === 0.01) && r4.ghost.opacity === 1 && r4.ghost.transparent === false,
    `${r4.bigScale} / ${r4.tinyScale} / ${JSON.stringify(r4.ghost)}`);
  check('4. 顏色必須 #rrggbb（"red"、CSS url()、物件都改用預設色）', r4.colors.red === 'c8d0da' && r4.colors.css === 'c8d0da' && r4.colors.obj === 'c8d0da' && r4.colors.ok1 === '00ff00', JSON.stringify(r4.colors));
  check('4. 文字最多 40 字、HUD 最多 4 行 × 60 字', r4.labelLen === 40 && r4.hud.length === 4 && Array.from(r4.hud[0]).length === 60, `${r4.labelLen} 字；HUD ${r4.hud.length} 行、第一行 ${Array.from(r4.hud[0]).length} 字`);
  check('4. 格式問題不會停掉實例（fatal 是 false，照常執行）', r4.inst.status === 'running' && r4.errs.every((x) => x.fatal === false));
  check('4. view() 不是陣列：回報一次、不更新畫面；hud() 回傳數字當成空的', r4.spawnW.ok && r4.w.children === 0 && r4.w.errs.length === 1 && /陣列/.test(r4.w.errs[0]) && Array.isArray(r4.w.hud) && r4.w.hud.length === 0 && r4.w.inst.status === 'running',
    JSON.stringify(r4.w));
  check(`4. 作品丟例外：那個實例標成壞掉（fatal、附 main.js 行號 ${BOOM_LINE}），同一個 Worker 的另一個實例照常`,
    r4.x1Inst.status === 'broken' && r4.x1Errs.length === 1 && r4.x1Errs[0].fatal && r4.x1Errs[0].kind === 'exception' && r4.x1Errs[0].message.includes(`第 ${BOOM_LINE} 行`) && r4.x2Snap.state.n === 6,
    `${r4.x1Errs[0]?.message}；X2 n=${r4.x2Snap.state.n}`);
  check('4. 壞掉的實例不能存檔、畫面留在最後一格', /出錯/.test(r4.x1Snap) && r4.x1Mesh, r4.x1Snap);
  await page.screenshot({ path: path.join(OUT, 'sandbox-04-format.png'), clip: { x: 0, y: 0, width: 960, height: 540 } });

  // 載入失敗：語法錯誤、import、最外層丟例外、沒有 define／缺函式／define 兩次、init 沒回傳狀態
  const r4b = await page.evaluate(async ({ fails, initUndefined }) => {
    const T = window.__T;
    const host = T.host;
    const out = { workers0: host.stats().workers, loads: {} };
    for (const [name, f] of Object.entries(fails)) out.loads[name] = await host.load(`fail-${name}@1`, f.code, {});
    out.initLoad = await host.load('init-undef@1', initUndefined, {});
    out.initSpawn = await host.spawn('IU', 'init-undef@1', {});
    out.iuExists = host.instances().some((i) => i.id === 'IU');
    out.unloadIU = host.unload('init-undef@1');
    out.workers1 = host.stats().workers;
    return out;
  }, { fails: Object.fromEntries(Object.entries(LOAD_FAILS).map(([k, v]) => [k, { code: v.code }])), initUndefined: INIT_UNDEFINED });
  report.notes.loadFails = r4b;
  const badLoads = Object.entries(LOAD_FAILS).filter(([name, f]) => r4b.loads[name]?.ok !== false || !f.expect.test(r4b.loads[name].error));
  check('4. 載不起來的作品：語法錯誤、import、最外層例外、沒有 define、缺 view、define 兩次 → load 失敗並說明原因（附行號）', badLoads.length === 0,
    badLoads.map(([n]) => `${n}: ${r4b.loads[n]?.error}`).join(' | ') || Object.values(r4b.loads).map((l) => l.error).join(' | ').slice(0, 260));
  check('4. init() 沒回傳狀態 → spawn 失敗、不留實例', r4b.initLoad.ok && r4b.initSpawn.ok === false && /init\(\) 要回傳/.test(r4b.initSpawn.error) && !r4b.iuExists && r4b.unloadIU, r4b.initSpawn.error);
  check('4. 載入失敗不留 Worker（host 的帳和瀏覽器裡的一樣）', r4b.workers1 === r4b.workers0 && (await liveWorkers(r4b.workers1)) === r4b.workers1, `${r4b.workers0}→${r4b.workers1}；DevTools ${page.workers().length}`);

  // 呼叫的人在 onError 回呼裡直接 kill 那個實例（creation.mjs 換版退回就是這樣）：host 不能被弄壞
  const r4c = await page.evaluate(async () => {
    const T = window.__T;
    const host = T.host;
    const before = host.stats();
    const errStart = T.errors.length;
    T.onErrorHook = (id) => {
      if (id === 'R') host.kill('R');
    };
    let spawn;
    try {
      spawn = await host.spawn('R', 'bad@1', {}); // 一建立就有格式問題 → onError → 回呼裡 kill
      await T.ticks(2);
    } catch (err) {
      spawn = { ok: false, error: `丟出例外：${err.message}` };
    }
    T.onErrorHook = null;
    return { spawn, exists: host.instances().some((i) => i.id === 'R'), group: !!T.group('R'), before, after: host.stats(), errs: T.errors.slice(errStart).filter((e) => e.id === 'R').length };
  });
  check('4. onError 回呼裡直接 kill 那個實例（像換版退回）：host 不會壞、資源收乾淨、之後不再回報', r4c.spawn.ok && !r4c.exists && !r4c.group && r4c.after.meshes === r4c.before.meshes && r4c.after.materials === r4c.before.materials && r4c.errs === 1,
    `${JSON.stringify(r4c.spawn)}；回報 ${r4c.errs} 次；meshes ${r4c.before.meshes}→${r4c.after.meshes}`);

  // ======================= 5. 存檔、換版、migrate、影子試跑 =======================
  const r5 = await page.evaluate(async ({ mig1, mig2, mig3 }) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    out.l1 = await host.load('mig@1', mig1, { stateSchema: 1 });
    out.s1 = await host.spawn('M', 'mig@1', {});
    await T.ticks(5);
    out.snap1 = await host.snapshot('M');
    const w0 = host.stats().workers;
    out.unloadBusy = host.unload('mig@1'); // 還有實例：不關
    out.kill = host.kill('M');
    out.unload1 = host.unload('mig@1');
    out.workersDrop = w0 - host.stats().workers;
    out.l2 = await host.load('mig@2', mig2, { stateSchema: 2 });
    out.s2 = await host.spawn('M', 'mig@2', { state: out.snap1.state, fromSchema: out.snap1.schema });
    await T.ticks(3);
    out.snap2 = await host.snapshot('M');
    out.hudM = T.huds.M;
    // 同一個 schema：不叫 migrate
    out.s2b = await host.spawn('M2', 'mig@2', { state: { score: 1, combo: 1, v: 2 }, fromSchema: 2 });
    out.snapM2 = await host.snapshot('M2');
    // 同一格換版：H 先跑舊版
    out.l1b = await host.load('mig@1', mig1, { stateSchema: 1 });
    out.sH = await host.spawn('H', 'mig@1', {});
    host.setTransform('H', [4, 0, 2], 0);
    await T.ticks(2);
    const before = { group: T.group('H'), pad: T.ent('H', 'pad'), score: T.ent('H', 'score') };
    out.before = { pad: before.pad.material.color.getHexString(), text: before.score.userData.text };
    const created0 = host.stats().createdMeshes;
    const snapH = await host.snapshot('H');
    out.snapH = snapH;
    // 影子先試跑（不畫）
    const meshes0 = host.stats().meshes;
    out.shadow = await host.spawn('H~shadow', 'mig@2', { state: snapH.state, fromSchema: snapH.schema, hidden: true });
    out.shadowRun = await host.tickHidden('H~shadow', 30, 1 / 30);
    out.shadowMeshes = host.stats().meshes - meshes0;
    out.shadowGroup = !!T.group('H~shadow');
    out.shadowSnap = await host.snapshot('H~shadow');
    out.shadowKill = host.kill('H~shadow');
    // 換版（同一個 instId、新的 pkgKey、舊狀態＋fromSchema）
    out.swap = await host.spawn('H', 'mig@2', { state: snapH.state, fromSchema: snapH.schema });
    out.sameObjects = T.group('H') === before.group && T.ent('H', 'pad') === before.pad && T.ent('H', 'score') === before.score;
    out.after = { pad: T.ent('H', 'pad').material.color.getHexString(), text: T.ent('H', 'score').userData.text };
    out.createdOnSwap = host.stats().createdMeshes - created0;
    out.instH = host.instances().find((i) => i.id === 'H');
    out.unloadOld = host.unload('mig@1'); // 舊版已經沒有實例
    await T.ticks(2);
    out.snapH2 = await host.snapshot('H');
    // 換版失敗：舊的照常跑
    out.l3 = await host.load('mig@3', mig3, { stateSchema: 3 });
    out.swapBad = await host.spawn('H', 'mig@3', { state: out.snapH2.state, fromSchema: 2 });
    await T.ticks(2);
    out.instHBad = host.instances().find((i) => i.id === 'H');
    out.snapH3 = await host.snapshot('H');
    out.unloadBad = host.unload('mig@3');
    out.errorsH = T.errors.filter((e) => e.id.startsWith('H') || e.id.startsWith('M'));
    T.render();
    return out;
  }, { mig1: MIG1, mig2: MIG2, mig3: MIG3 });
  report.notes.migrate = r5;
  check('5. snapshot → { state, schema }', r5.snap1.state.score === 5 && r5.snap1.state.v === 1 && r5.snap1.schema === 1, JSON.stringify(r5.snap1));
  check('5. kill 之後才能 unload（還有實例時 unload 回 false），unload 關掉 Worker', r5.unloadBusy === false && r5.kill === true && r5.unload1 === true && r5.workersDrop === 1);
  check('5. 用存檔 spawn 新版本（stateSchema 2）：經過 migrate、狀態延續', r5.s2.ok && r5.snap2.schema === 2 && r5.snap2.state.score === 8 && r5.snap2.state.combo === 6 && r5.snap2.state.migratedFrom === 1 && r5.hudM?.[0] === 'v2 score 8 combo 6',
    JSON.stringify(r5.snap2));
  check('5. schema 相同就不叫 migrate', r5.s2b.ok && r5.snapM2.state.migratedFrom === undefined && r5.snapM2.state.score === 1);
  check('5. 影子實例：不畫（沒有 Group、mesh 數不變），連跑 30 步回報 maxEntities', r5.shadow.ok && r5.shadowRun.ok && r5.shadowRun.steps === 30 && r5.shadowRun.maxEntities === 2 && r5.shadowRun.warnings.length === 0 && r5.shadowMeshes === 0 && !r5.shadowGroup,
    JSON.stringify(r5.shadowRun));
  check('5. 影子實例的狀態＝舊存檔經 migrate 再跑 30 步', r5.shadowSnap.state.score === r5.snapH.state.score + 30 && r5.shadowSnap.state.migratedFrom === 1 && r5.shadowKill === true, JSON.stringify(r5.shadowSnap.state));
  check('5. 同一格換版：同一個 Group、同 id 的 mesh／文字原地更新（沒有新建）、顏色和文字換成新版', r5.swap.ok && r5.sameObjects && r5.createdOnSwap === 0 && r5.before.pad === '3366ff' && r5.after.pad === 'ff3366' && /^v2 /.test(r5.after.text) && r5.instH.pkg === 'mig@2',
    `${r5.before.pad}→${r5.after.pad}、${r5.before.text}→${r5.after.text}`);
  check('5. 換版後舊版本沒有實例了，可以 unload；新版接著跑', r5.unloadOld === true && r5.snapH2.state.score === r5.snapH.state.score + 2 && r5.snapH2.state.combo === 4, JSON.stringify(r5.snapH2.state));
  check('5. 換版失敗（migrate 丟例外）：回報原因，舊版照常跑', r5.swapBad.ok === false && /migrate 壞掉了/.test(r5.swapBad.error) && r5.instHBad.pkg === 'mig@2' && r5.instHBad.status === 'running' && r5.snapH3.state.score === r5.snapH2.state.score + 2 && r5.unloadBad === true,
    r5.swapBad.error);
  check('5. 這一段沒有錯誤回報', r5.errorsH.length === 0, JSON.stringify(r5.errorsH).slice(0, 200));
  await page.screenshot({ path: path.join(OUT, 'sandbox-05-swap.png'), clip: { x: 0, y: 0, width: 960, height: 540 } });

  // ======================= 6. 資源釋放 =======================
  const r6 = await page.evaluate(async (code) => {
    const T = window.__T;
    const host = T.host;
    const out = {};
    for (const i of host.instances()) host.kill(i.id);
    for (const key of ['counter@1', 'evil@1', 'leaky@1', 'leaky@2', 'leaky@3', 'spin@1', 'spin-init@1', 'bad@1', 'weird@1', 'boom@1', 'init-undef@1', 'mig@1', 'mig@2', 'mig@3']) host.unload(key);
    await new Promise((r) => setTimeout(r, 300));
    T.render();
    out.base = host.stats();
    out.gpuBase = { geometries: T.renderer.info.memory.geometries, textures: T.renderer.info.memory.textures };
    out.peak = { workers: 0, meshes: 0, textures: 0, geometries: 0 };
    out.fails = [];
    for (let i = 0; i < 20; i += 1) {
      const l = await host.load('cycle@1', code, { stateSchema: 1 });
      const s = await host.spawn('C', 'cycle@1', {});
      host.setTransform('C', [0, 0, 0], i * 0.3);
      await T.ticks(2);
      T.render();
      const st = host.stats();
      for (const k of Object.keys(out.peak)) out.peak[k] = Math.max(out.peak[k], st[k]);
      const k = host.kill('C');
      const u = host.unload('cycle@1');
      if (!l.ok || !s.ok || !k || !u) out.fails.push({ i, l, s, k, u });
    }
    await new Promise((r) => setTimeout(r, 300));
    T.render();
    out.after = host.stats();
    out.gpuAfter = { geometries: T.renderer.info.memory.geometries, textures: T.renderer.info.memory.textures };
    out.rootChildren = T.root.children.length;
    return out;
  }, CYCLE);
  report.notes.release = r6;
  const zero = (s) => s.workers === 0 && s.instances === 0 && s.entities === 0 && s.meshes === 0 && s.geometries === 0 && s.materials === 0 && s.textures === 0;
  check('6. 收掉前面全部之後：host 的帳全部歸零', zero(r6.base), JSON.stringify(r6.base));
  check('6. 瀏覽器裡的 Worker 也真的全部結束', (await liveWorkers(0)) === 0, `${page.workers().length} 個`);
  check('6. 同一作品 load→spawn→tick→kill→unload 20 次都成功（每次 1 個 Worker、7 個實體）', r6.fails.length === 0 && r6.peak.workers === 1 && r6.peak.meshes === 7 && r6.peak.textures === 1 && r6.peak.geometries === 6,
    `${JSON.stringify(r6.peak)} 失敗 ${r6.fails.length}`);
  check('6. 20 次之後：workers 回到 0、mesh／geometry／material／texture 回到基準', zero(r6.after) && r6.after.createdMeshes - r6.base.createdMeshes === 140 && r6.after.createdMeshes === r6.after.disposedMeshes && r6.rootChildren === 0,
    JSON.stringify(r6.after));
  check('6. WebGL 端的幾何和貼圖也回到基準（真的釋放了 GPU 資源）', r6.gpuAfter.geometries === r6.gpuBase.geometries && r6.gpuAfter.textures === r6.gpuBase.textures, `${JSON.stringify(r6.gpuBase)} → ${JSON.stringify(r6.gpuAfter)}`);
  check('6. 瀏覽器裡沒有殘留的 Worker', (await liveWorkers(0)) === 0, `開過 ${workerLog.opened} 個、結束 ${workerLog.closed} 個`);

  // dispose：還有實例在跑的時候整個關掉
  const r7 = await page.evaluate(async (code) => {
    const T = window.__T;
    T.host.dispose();
    const host = (T.host = T.mkHost());
    await host.ready();
    await host.load('counter@1', code, {});
    await host.spawn('D1', 'counter@1', {});
    await host.spawn('D2', 'counter@1', {});
    await T.ticks(2);
    const before = host.stats();
    const iframesBefore = document.querySelectorAll('iframe').length;
    host.dispose();
    const after = host.stats();
    const late = await host.spawn('D3', 'counter@1', {}).catch((e) => ({ ok: false, error: e.message }));
    return { before, after, iframesBefore, iframes: document.querySelectorAll('iframe').length, rootChildren: T.root.children.length, late, tickAfter: await host.tick(1 / 30, {}).then(() => 'ok') };
  }, COUNTER);
  report.notes.dispose = r7;
  check('dispose：iframe 移除、實例的 Three.js 資源全部釋放、之後的呼叫安全地失敗', r7.iframesBefore === 1 && r7.iframes === 0 && r7.before.meshes === 8 && zero(r7.after) && r7.rootChildren === 0 && r7.late.ok === false && r7.tickAfter === 'ok',
    JSON.stringify({ before: r7.before.meshes, after: r7.after, late: r7.late.error }));
  check('dispose：iframe 裡的 Worker 跟著結束', (await liveWorkers(0)) === 0, `${page.workers().length} 個`);

  // ======================= 網路與錯誤總檢查 =======================
  await sleep(500);
  check('誘餌伺服器沒有收到任何來自沙盒的請求', canaryHits.length === 0, canaryHits.join(', ') || '0 次');
  const runnerUrl = `${base}/sandbox/runner.html`;
  const later = requests.slice(setupRequests);
  const answered = responses.filter((u) => later.includes(u) && u !== runnerUrl && !u.startsWith('blob:'));
  const attempts = later.filter((u) => u !== runnerUrl && !u.startsWith('blob:'));
  const blocked = attempts.filter((u) => failures.some((f) => f.url === u));
  report.notes.network = { attempts, failures: failures.filter((f) => !f.url.startsWith('blob:')), answered, workerScripts: later.filter((u) => u.startsWith('blob:')).length };
  check('設定完成之後，除了 runner.html（和 Worker 的 blob: 程式）沒有任何請求真的送出去', answered.length === 0 && blocked.length === attempts.length && responses.filter((u) => u === runnerUrl).length === 2,
    answered.join(', ') || `沙盒裡的 ${attempts.length} 次嘗試全部在瀏覽器內被擋（${[...new Set(failures.filter((f) => !f.url.startsWith('blob:')).map((f) => f.error))].join('、') || '沒有'}）`);
  check('沒有頁面錯誤', pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].slice(0, 3).join(' | '));
  report.notes.workers = workerLog;
  await ctx.close();
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  await browser.close();
  cleanup();
}
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過（輸出：${OUT}）`);
process.exit(failed.length ? 1 : 0);
