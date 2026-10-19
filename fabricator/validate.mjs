// 零件驗證器：Codex 每次寫完 part.js / meta.json 都要跑 `node validate.mjs`，印出 PASS 才算完成。
// 伺服器最後也會用 `node validate.mjs --json` 再驗一次（不信任模型自稱通過）。
//
// 實際的建構與動畫跑在 worker thread 裡，主執行緒負責計時：
// build() 或 update() 卡死（無限迴圈）時，10 秒後直接判失敗。

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const TIMEOUT_MS = 10_000;

if (isMainThread) {
  const jsonMode = process.argv.includes('--json');
  let printed = false;
  const finish = (report) => {
    if (printed) return;
    printed = true;
    if (jsonMode) {
      process.stdout.write(JSON.stringify(report) + '\n');
    } else {
      console.log(report.ok ? 'PASS' : 'FAIL');
      for (const e of report.errors || []) console.log(`  ✗ ${e}`);
      for (const w of report.warnings || []) console.log(`  ! ${w}`);
      if (report.size) {
        console.log(`  size (m): x=${report.size[0]} y=${report.size[1]} z=${report.size[2]}  minY=${report.min?.[1]}`);
      }
      if (report.stats) {
        const s = report.stats;
        console.log(`  meshes=${s.meshes} triangles=${s.triangles} lights=${s.lights} animated=${s.updaters} spawns=${s.spawns}`);
      }
    }
    process.exit(report.ok ? 0 : 1);
  };
  const worker = new Worker(SELF, { workerData: { dir: HERE } });
  const timer = setTimeout(() => {
    worker.terminate();
    finish({
      ok: false,
      errors: [`驗證逾時（超過 ${TIMEOUT_MS / 1000} 秒）：build() 或 update() 可能有無限迴圈或太重的運算`],
      warnings: [],
    });
  }, TIMEOUT_MS);
  worker.on('message', (report) => {
    clearTimeout(timer);
    finish(report);
  });
  worker.on('error', (err) => {
    clearTimeout(timer);
    finish({ ok: false, errors: [`驗證器內部錯誤：${err?.stack || err}`], warnings: [] });
  });
  worker.on('exit', (code) => {
    clearTimeout(timer);
    finish({ ok: false, errors: [`驗證 worker 意外結束（code ${code}）`], warnings: [] });
  });
} else {
  parentPort.postMessage(await runChecks(workerData.dir));
}

async function runChecks(dir) {
  const errors = [];
  const warnings = [];
  const report = { ok: false, errors, warnings };
  const done = () => {
    report.errors = [...new Set(errors)];
    report.warnings = [...new Set(warnings)];
    report.ok = report.errors.length === 0;
    return report;
  };

  let context = {};
  try {
    context = JSON.parse(readFileSync(path.join(dir, 'context.json'), 'utf8'));
  } catch {
    errors.push('讀不到 context.json');
    return done();
  }

  // ---- meta.json ----
  let meta = null;
  const metaFile = path.join(dir, 'meta.json');
  if (!existsSync(metaFile)) {
    errors.push('找不到 meta.json');
  } else {
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      const name = typeof meta.name === 'string' ? meta.name.trim() : '';
      if (!name) errors.push('meta.json 需要 name（短名稱，用使用者的語言）');
      else if ([...name].length > 32) errors.push('meta.json 的 name 太長（32 字以內）');
      if (typeof meta.description !== 'string' || !meta.description.trim()) {
        errors.push('meta.json 需要 description（一句話，用使用者的語言）');
      }
      const placements = ['front', 'on_selection', 'around_player'];
      if (meta.placement == null) meta.placement = 'front';
      if (!placements.includes(meta.placement)) errors.push(`meta.json 的 placement 只能是 ${placements.join(' / ')}`);
      if (meta.placement === 'on_selection' && !(context.selection || []).length) {
        warnings.push('placement 是 on_selection 但目前沒有選取物件，會改放在使用者前方');
      }
      meta.name = name;
      report.meta = { name, description: String(meta.description || '').trim(), placement: meta.placement };
    } catch (e) {
      errors.push(`meta.json 不是合法 JSON：${e.message}`);
    }
  }

  // ---- part.js 靜態檢查 ----
  const partFile = path.join(dir, 'part.js');
  if (!existsSync(partFile)) {
    errors.push('找不到 part.js');
    return done();
  }
  const src = readFileSync(partFile, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const banned = [
    [/^\s*import[\s{*]/m, 'part.js 不可以 import（three.js 請用 ctx.THREE）'],
    [/\bimport\s*\(/, '不可以動態 import()'],
    [/\brequire\s*\(/, '不可以 require()'],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, '不可以連網路'],
    [/\b(document|window|navigator|globalThis)\s*\./, '不可以使用 document / window / navigator / globalThis（如果只是變數名稱，請改名，例如 windowMesh）'],
    [/\beval\s*\(|new\s+Function\s*\(/, '不可以 eval / new Function'],
    [/\b(localStorage|sessionStorage|indexedDB)\b/, '不可以存取瀏覽器儲存空間'],
    [/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, '不可以用計時器，動畫請寫在 userData.update(dt, t)'],
    [/\bMath\.random\s*\(/, '不要用 Math.random()，請用 ctx.random()（每次重建外觀才會一致）'],
    [/\b(TextureLoader|GLTFLoader|FileLoader|ImageLoader|CanvasTexture|FontLoader)\b/, '不可以載入外部檔案或用 canvas 貼圖，只能用程序化幾何與材質'],
  ];
  for (const [re, msg] of banned) if (re.test(code)) errors.push(msg);
  if (!/export\s+default\b/.test(code)) errors.push('part.js 需要 export default function build(ctx) { ... }');
  if (/export\s+default\s+async/.test(code)) errors.push('build() 不能是 async，必須同步回傳 Object3D');
  if (errors.length) return done();

  // ---- 實際建構 ----
  const THREE = await import('three');
  const { createRuntime } = await import(pathToFileURL(context.paths.runtime).href);
  const player = { position: new THREE.Vector3(...(context.player?.position ?? [0, 1.6, 3])) };
  const rt = createRuntime({ THREE, player });

  let library = { parts: [] };
  try {
    library = JSON.parse(readFileSync(context.paths.libraryFile, 'utf8'));
  } catch {
    /* 空工具箱 */
  }
  rt.setLibrary(library.parts || []);
  for (const p of library.parts || []) {
    if (p.kind !== 'generated') continue;
    try {
      rt.registerModule(p.id, await import(pathToFileURL(path.join(context.paths.partsDir, `${p.id}.js`)).href));
    } catch (e) {
      warnings.push(`既有零件「${p.name}」載入失敗：${e.message}`);
    }
  }

  const candId = '__candidate__';
  rt.addPart({ id: candId, name: meta?.name || '新零件', kind: 'generated', size: [1, 1, 1], createdAt: '9999' });
  let mod;
  try {
    mod = await import(`${pathToFileURL(partFile).href}?v=${Date.now()}`);
  } catch (e) {
    errors.push(`part.js 無法載入（語法錯誤？）：${e.message}`);
    return done();
  }
  try {
    rt.registerModule(candId, mod);
  } catch (e) {
    errors.push(e.message);
    return done();
  }

  const built = rt.instantiate(candId);
  errors.push(...built.errors);
  for (const name of built.missingSpawns) {
    const names = (library.parts || []).filter((p) => !p.hidden).map((p) => p.name).join('、') || '（工具箱是空的）';
    errors.push(`ctx.spawn("${name}") 找不到這個零件。工具箱現有：${names}`);
  }
  warnings.push(...built.warnings.filter((w) => !w.startsWith('spawn 找不到')));
  if (built.object.userData.placeholder) {
    errors.push('build() 沒有產生物件（變成佔位方塊）');
    return done();
  }

  // ---- 動畫試跑 90 幀 ----
  let t = 0;
  for (let frame = 0; frame < 90; frame += 1) {
    t += 1 / 60;
    player.position.set(Math.sin(t) * 3, 1.6, Math.cos(t) * 3);
    for (const u of built.updaters) {
      if (u.dead) continue;
      try {
        u.fn.call(u.obj, 1 / 60, t);
      } catch (e) {
        u.dead = true;
        errors.push(`userData.update() 執行錯誤：${e.message}`);
      }
    }
  }

  // ---- 統計 ----
  const root = built.object;
  root.updateMatrixWorld(true);
  let meshes = 0;
  let triangles = 0;
  let lights = 0;
  let badNumbers = false;
  root.traverse((o) => {
    if (o.isLight) lights += 1;
    if (!(o.isMesh || o.isLine || o.isPoints)) return;
    meshes += 1;
    const g = o.geometry;
    const pos = g?.attributes?.position;
    if (!pos) return;
    if (o.isMesh) {
      const count = g.index ? g.index.count : pos.count;
      triangles += (count / 3) * (o.isInstancedMesh ? o.count : 1);
    }
    const arr = pos.array;
    for (let i = 0; i < Math.min(arr.length, 6000); i += 1) {
      if (!Number.isFinite(arr[i])) {
        badNumbers = true;
        break;
      }
    }
  });
  triangles = Math.round(triangles);

  const box = new THREE.Box3().setFromObject(root, true);
  const size = box.isEmpty() ? [0, 0, 0] : box.getSize(new THREE.Vector3()).toArray();
  const r3 = (v) => Math.round(v * 1000) / 1000;
  report.size = size.map(r3);
  report.min = box.isEmpty() ? [0, 0, 0] : box.min.toArray().map(r3);
  report.stats = { meshes, triangles, lights, updaters: built.updaters.length, spawns: built.spawns };

  if (meshes === 0) errors.push('沒有任何看得見的 mesh');
  if (badNumbers) errors.push('幾何座標裡有 NaN / Infinity');
  if (triangles > 200_000) errors.push(`三角形太多（${triangles}，上限 200,000）`);
  else if (triangles > 80_000) warnings.push(`三角形偏多（${triangles}），建議降到 60,000 以下`);
  if (meshes > 1500) errors.push(`mesh 太多（${meshes}），重複的零件請用 InstancedMesh 或合併幾何`);
  if (lights > 2) errors.push(`燈光太多（${lights} 個，上限 2），發光請用 emissive 材質`);
  else if (lights > 0) warnings.push('有真實燈光；發光效果優先用 emissive 材質（效能較好）');
  const maxDim = Math.max(...size);
  if (maxDim > 60) errors.push(`物件太大（最長邊 ${r3(maxDim)} m，上限 60 m）`);
  if (maxDim < 0.01) errors.push(`物件太小（最長邊 ${r3(maxDim)} m）`);
  if (!box.isEmpty() && Math.abs(box.min.y) > Math.max(0.02, size[1] * 0.05)) {
    warnings.push(`底部沒有貼齊 y=0（minY=${r3(box.min.y)}），原點應該在物件底部中心`);
  }
  if (!box.isEmpty()) {
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    if (Math.hypot(cx, cz) > Math.max(0.05, maxDim * 0.2) && meta?.placement !== 'around_player') {
      warnings.push(`物件沒有置中（中心在 x=${r3(cx)}, z=${r3(cz)}）`);
    }
  }
  return done();
}
