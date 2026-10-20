// 拍照服務（伺服器端）：用無頭瀏覽器把零件或世界模組拍成一張四格圖，給 Codex 用看圖工具檢查自己做的東西，
// 也順便產生工具箱的縮圖。Codex 在沙盒裡開不了瀏覽器，所以由伺服器代拍（見 fabricator/snapshot.mjs 的紙條交接）。
// 這台沒有 Playwright／Chromium 時一律回 { ok: false, unavailable: true }，打造流程照常進行。

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0b1422}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script></head>
<body><div id="wrap" style="position:relative;width:1024px;height:1024px"><canvas id="c" width="1024" height="1024"></canvas>
<canvas id="t" width="1024" height="1024" style="position:absolute;left:0;top:0"></canvas></div>
<script type="module">
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const q = new URLSearchParams(location.search);
const fail = (e) => { window.__error = String(e && (e.stack || e.message) || e).slice(0, 600); };
window.addEventListener('error', (e) => fail(e.error || e.message));
try {
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setScissorTest(true);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080f);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.65;
  const hemi = new THREE.HemisphereLight(0xcfeaff, 0x0a1020, 0.8);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(5, 9, 6);
  scene.add(hemi, sun);
  const t2d = document.getElementById('t').getContext('2d');
  t2d.font = 'bold 24px sans-serif';
  const cam = new THREE.PerspectiveCamera(35, 1, 0.02, 2000);
  const shot = (i, label) => {
    const x = (i % 2) * 512, y = (1 - Math.floor(i / 2)) * 512;
    renderer.setViewport(x, y, 512, 512);
    renderer.setScissor(x, y, 512, 512);
    renderer.render(scene, cam);
    const tx = (i % 2) * 512, ty = Math.floor(i / 2) * 512;
    t2d.fillStyle = 'rgba(0,0,0,0.6)';
    t2d.fillRect(tx + 8, ty + 8, t2d.measureText(label).width + 20, 36);
    t2d.fillStyle = '#9feaff';
    t2d.fillText(label, tx + 18, ty + 34);
  };
  const player = { position: new THREE.Vector3(0, 1.6, 4) };
  const info = {};
  if (q.get('kind') === 'world') {
    // 世界模組：照工坊預設的天空、地面、燈光，裝上模組跑 2 秒，從使用者的位置往四個方向看
    const { createWorldHost } = await import('/worldhost.mjs');
    scene.fog = new THREE.Fog(0x05080f, 20, 48);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(30, 72), new THREE.MeshStandardMaterial({ color: 0x0b1422, roughness: 0.92, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2;
    const grid = new THREE.GridHelper(40, 80, 0x2fd6ff, 0x16384d);
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    scene.add(floor, grid);
    const env = {
      background: (c) => (scene.background = c == null ? null : new THREE.Color(c)),
      fog: (c, near = 20, far = 48) => (scene.fog = c == null ? null : new THREE.Fog(new THREE.Color(c), near, far)),
      ground: ({ color, roughness, metalness, visible } = {}) => {
        if (color != null) floor.material.color.set(color);
        if (Number.isFinite(roughness)) floor.material.roughness = roughness;
        if (Number.isFinite(metalness)) floor.material.metalness = metalness;
        if (visible != null) floor.visible = !!visible;
      },
      grid: (v) => (grid.visible = !!v),
      pad: () => {},
      hemi: ({ sky, ground, intensity } = {}) => {
        if (sky != null) hemi.color.set(sky);
        if (ground != null) hemi.groundColor.set(ground);
        if (Number.isFinite(intensity)) hemi.intensity = intensity;
      },
      sun: ({ color, intensity, position } = {}) => {
        if (color != null) sun.color.set(color);
        if (Number.isFinite(intensity)) sun.intensity = intensity;
        if (Array.isArray(position) && position.length === 3) sun.position.fromArray(position);
      },
      exposure: (n) => Number.isFinite(n) && (renderer.toneMappingExposure = n),
      reflections: (n) => Number.isFinite(n) && (scene.environmentIntensity = n),
      reset: () => {},
    };
    const root = new THREE.Group();
    scene.add(root);
    const mk = (id, x, color) => {
      const o = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshStandardMaterial({ color }));
      m.position.y = 0.3;
      o.add(m);
      o.position.set(x, 0, 0);
      scene.add(o);
      return { id, name: id, object: o, box: () => new THREE.Box3().setFromObject(o), controlled: false, dragging: false };
    };
    const handles = [mk('sample-a', -1.2, 0x38e1ff), mk('sample-b', 1.2, 0xffb640)];
    const errors = [];
    const host = createWorldHost({
      THREE, root, env, objects: () => handles, supportBelow: () => 0, player: { position: player.position, forward: () => new THREE.Vector3(0, 0, -1) },
      vehicle: { tune() {}, onUpdate() {}, clear() {} }, physics: null, hud() {}, toast() {},
      onError: (_r, e) => errors.push(String(e && e.message || e)), now: () => performance.now(),
    });
    const res = host.install({ id: '__candidate__', type: q.get('type') || 'environment', name: 'candidate' }, await import('/candidate.js'));
    if (!res.ok) throw new Error(res.error);
    for (let f = 0; f < 120; f += 1) host.update(1 / 60, f / 60);
    if (errors.length) throw new Error(errors[0]);
    cam.fov = 70;
    cam.updateProjectionMatrix();
    const dirs = [['LOOKING FORWARD (-Z)', 0, -0.12], ['LOOKING RIGHT (+X)', -Math.PI / 2, -0.12], ['LOOKING BACK (+Z)', Math.PI, -0.12], ['LOOKING UP (sky)', 0, 0.85]];
    dirs.forEach(([label, yaw, pitch], i) => {
      cam.position.copy(player.position);
      cam.rotation.set(pitch, yaw, 0, 'YXZ');
      shot(i, label);
    });
  } else {
    // 零件：工具箱的零件都先載入（ctx.spawn 會用到），正面、右側、上方、斜角各拍一張
    const { createRuntime } = await import('/runtime.mjs');
    const lib = await (await fetch('/lib.json')).json();
    const rt = createRuntime({ THREE, player });
    rt.setLibrary(lib.parts || []);
    for (const p of lib.parts || []) {
      if (p.kind !== 'generated' || p.id === q.get('id')) continue;
      try { rt.registerModule(p.id, await import('/parts/' + p.id + '.js')); } catch (e) { /* 壞掉的舊零件略過 */ }
    }
    let id = q.get('id');
    if (q.get('candidate') === '1') {
      id = '__candidate__';
      rt.addPart({ id, name: 'candidate', kind: 'generated', size: [1, 1, 1] });
      rt.registerModule(id, await import('/candidate.js'));
    } else if (rt.parts.get(id)?.kind === 'generated') {
      rt.registerModule(id, await import('/parts/' + id + '.js'));
    }
    const built = rt.instantiate(id);
    if (built.errors.length) throw new Error(built.errors[0]);
    const obj = built.object;
    for (let f = 0; f < 60; f += 1) for (const u of built.updaters) { try { u.fn.call(u.obj, 1 / 60, f / 60); } catch (e) { /* 動畫錯誤驗收會抓 */ } }
    scene.add(obj);
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const cells = Math.max(2, Math.ceil(Math.max(size.x, size.z) * 1.6));
    scene.add(new THREE.GridHelper(cells, cells * 2, 0x2fd6ff, 0x16384d));
    const r = Math.max(size.length() / 2, 0.05);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(35 / 2))) * 1.05;
    const views = [['FRONT (+Z)', [0, 0.15, 1]], ['RIGHT SIDE (+X)', [1, 0.15, 0]], ['TOP (front at bottom)', [0, 1, 0]], ['3/4 VIEW · grid 0.5 m', [0.8, 0.6, 1]]];
    views.forEach(([label, d], i) => {
      cam.position.copy(center).addScaledVector(new THREE.Vector3(...d).normalize(), dist);
      cam.up.set(0, 1, 0);
      if (label.startsWith('TOP')) cam.up.set(0, 0, -1);
      cam.lookAt(center);
      shot(i, label);
    });
    info.size = size.toArray().map((v) => Math.round(v * 1000) / 1000);
  }
  // 縮圖：取斜角（零件）或往前看（世界）那一格，縮成 192×192 的 JPEG，不帶文字
  const tc = document.createElement('canvas');
  tc.width = tc.height = 192;
  const quadrant = q.get('kind') === 'world' ? [0, 0] : [512, 512];
  tc.getContext('2d').drawImage(canvas, quadrant[0], quadrant[1], 512, 512, 0, 0, 192, 192);
  window.__thumb = tc.toDataURL('image/jpeg', 0.82);
  window.__info = info;
  window.__done = true;
} catch (e) {
  fail(e);
}
</script></body></html>`;

export function createSnapshotter({ root, partsDir, libraryFile, log = () => {} }) {
  let browserP = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  const THREE_DIR = path.join(root, 'node_modules', 'three');

  async function browser() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const b = await browserP?.catch(() => null);
      browserP = null;
      await b?.close().catch(() => {});
    }, 3 * 60 * 1000); // 閒置三分鐘就關掉，不佔記憶體
    if (!browserP) {
      browserP = (async () => {
        const { chromium } = await import('playwright');
        // Playwright 預設會攔下 SIGTERM（只關瀏覽器、不結束程式），伺服器就關不掉；改由伺服器自己收尾
        return chromium.launch({
          args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
          handleSIGTERM: false,
          handleSIGINT: false,
          handleSIGHUP: false,
        });
      })();
      browserP.catch(() => (browserP = null));
    }
    return browserP;
  }

  // file：候選的 part.js／world.js；或 partId：工具箱裡已經有的零件（產生縮圖用）
  async function renderOnce({ file = null, partId = null, kind = 'part', worldType = 'environment', outGrid = null, outThumb = null }) {
    let b;
    try {
      b = await browser();
    } catch (e) {
      return { ok: false, unavailable: true, error: `這台沒有可以拍照的瀏覽器（npx playwright install chromium）：${String(e.message).split('\n')[0]}` };
    }
    const page = await b.newPage({ viewport: { width: 1024, height: 1024 } });
    try {
      const lib = JSON.stringify(JSON.parse(readFileSync(libraryFile, 'utf8')));
      // 拍照的頁面只能拿工坊自己的檔案；其他網址一律擋掉（候選程式還沒驗收，不讓它連出去）
      await page.route('**/*', (route) => route.abort());
      await page.route('http://snap.local/**', (route) => {
        const p = decodeURIComponent(new URL(route.request().url()).pathname);
        const js = 'text/javascript; charset=utf-8';
        try {
          if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE });
          if (p.startsWith('/three/')) {
            const f = path.resolve(THREE_DIR, `.${p.slice(6)}`);
            if (!f.startsWith(THREE_DIR + path.sep)) return route.fulfill({ status: 403, body: '' });
            return route.fulfill({ status: 200, contentType: js, body: readFileSync(f) });
          }
          if (p === '/runtime.mjs' || p === '/worldhost.mjs') return route.fulfill({ status: 200, contentType: js, body: readFileSync(path.join(root, 'public', p.slice(1))) });
          if (p === '/lib.json') return route.fulfill({ status: 200, contentType: 'application/json', body: lib });
          if (p === '/candidate.js' && file) return route.fulfill({ status: 200, contentType: js, body: readFileSync(file) });
          const m = p.match(/^\/parts\/([a-z]_[a-z0-9]+)\.js$/);
          if (m) return route.fulfill({ status: 200, contentType: js, body: readFileSync(path.join(partsDir, `${m[1]}.js`)) });
        } catch {
          return route.fulfill({ status: 404, body: '' });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      const qs = new URLSearchParams({ kind, type: worldType, ...(file ? { candidate: '1' } : { id: partId }) });
      await page.goto(`http://snap.local/?${qs}`);
      await page.waitForFunction(() => window.__done || window.__error, null, { timeout: 25_000 });
      const err = await page.evaluate(() => window.__error || null);
      if (err) return { ok: false, error: err };
      if (outGrid) await page.locator('#wrap').screenshot({ path: outGrid });
      if (outThumb) {
        const dataUrl = await page.evaluate(() => window.__thumb);
        writeFileSync(outThumb, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
      }
      return { ok: true, ...(await page.evaluate(() => window.__info || {})) };
    } catch (e) {
      return { ok: false, error: String(e.message).split('\n')[0] };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    // 一次只拍一張（共用同一個瀏覽器）
    render(opts) {
      const run = queue.then(() => renderOnce(opts));
      queue = run.catch(() => {});
      return run;
    },
    async close() {
      clearTimeout(idleTimer);
      const b = await browserP?.catch(() => null);
      browserP = null;
      await b?.close().catch(() => {});
    },
  };
}
