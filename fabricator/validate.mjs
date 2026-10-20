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
      if (report.kind && report.kind !== 'part') {
        console.log(`  ${report.kind}: ${JSON.stringify(report.stats || {})}`);
      } else if (report.stats) {
        const s = report.stats;
        console.log(`  meshes=${s.meshes} triangles=${s.triangles} lights=${s.lights} animated=${s.updaters} spawns=${s.spawns}`);
      }
      if (report.physics) {
        const p = report.physics;
        console.log(`  physics: pieces=${p.pieces} mass=${p.mass}kg tilt=${p.tiltDeg}° slid=${p.slid}m${p.devices.length ? ` devices=${p.devices.join(',')}` : ''}`);
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

// 還沒做完就交：TODO／placeholder 註解、空的 onControl／onDevice／update
function checkUnfinished(src, warnings) {
  const comments = (src.match(/\/\*[\s\S]*?\*\/|\/\/.*$/gm) || []).join('\n');
  if (/\b(TODO|FIXME|TBD|XXX)\b|placeholder|stub|待補|稍後(再)?(實作|補)|之後再做/i.test(comments)) {
    warnings.push('註解裡還有 TODO／placeholder：把它做完再交');
  }
  const empty = src.match(/\b(onControl|onDevice|update)\s*=\s*(?:function\s*)?\([^)]*\)\s*(?:=>)?\s*\{\s*\}/);
  if (empty) warnings.push(`${empty[1]} 是空的：要嘛真的做點事，要嘛不要寫`);
}

function unknownApiErrors(seen, available) {
  return [...seen].map((name) => {
    const parent = name.slice(0, name.lastIndexOf('.'));
    const keys = available[parent];
    return `${name} 不存在${keys ? `（${parent} 只有：${keys.join('、')}）` : ''}`;
  });
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

  const physMod = context.paths?.physics ? await import(pathToFileURL(context.paths.physics).href) : null;
  const toolsMod = context.paths?.tools ? await import(pathToFileURL(context.paths.tools).href) : null; // 道具行為（能量槍、標靶）
  const hasPart = existsSync(path.join(dir, 'part.js'));
  const hasWorld = existsSync(path.join(dir, 'world.js'));
  if (hasPart && hasWorld) {
    errors.push('part.js 和 world.js 只能寫其中一個（零件寫 part.js；環境、規則寫 world.js）');
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
      if (meta.controls != null && !['drive', 'fly', 'wear'].includes(meta.controls)) {
        errors.push('meta.json 的 controls 只能是 drive / fly / wear（不能操作的東西就不要寫）');
      }
      if (meta.wearSlot != null && !['right_hand', 'left_hand', 'head'].includes(meta.wearSlot)) {
        errors.push('meta.json 的 wearSlot 只能是 right_hand / left_hand / head');
      }
      checkPhysicsMeta(meta, physMod, errors, warnings);
      checkToolMeta(meta, toolsMod, errors, warnings);
      const type = meta.type == null ? (hasWorld ? null : 'part') : meta.type;
      if (hasWorld && !['environment', 'rule'].includes(type)) {
        errors.push('寫了 world.js，meta.json 的 type 要是 "environment" 或 "rule"');
      }
      if (!hasWorld && type !== 'part') errors.push('寫了 part.js，meta.json 的 type 要是 "part"（或不寫）');
      meta.type = type;
      meta.name = name;
      report.meta = {
        type,
        replaces: hasWorld && meta.replaces ? String(meta.replaces) : null,
        name,
        description: String(meta.description || '').trim(),
        placement: meta.placement,
        controls: meta.controls || null,
        wearSlot: meta.controls === 'wear' ? meta.wearSlot || 'right_hand' : null,
        physics: physMod && !hasWorld ? physMod.normalizePhysics(meta.physics) : null,
        device: physMod && !hasWorld ? physMod.normalizeDevice(meta.device) : null,
        tool: toolsMod && !hasWorld ? toolsMod.normalizeTool(meta.tool) : null,
        target: toolsMod && !hasWorld ? toolsMod.normalizeTarget(meta.target) : null,
      };
    } catch (e) {
      errors.push(`meta.json 不是合法 JSON：${e.message}`);
    }
  }

  if (hasWorld) return checkWorld(dir, context, meta, errors, warnings, report, done);
  report.kind = 'part';

  // ---- part.js 靜態檢查 ----
  const partFile = path.join(dir, 'part.js');
  if (!existsSync(partFile)) {
    errors.push('找不到 part.js（環境、規則請寫 world.js）');
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
  checkUnfinished(src, warnings);
  if (!/export\s+default\b/.test(code)) errors.push('part.js 需要 export default function build(ctx) { ... }');
  if (/export\s+default\s+async/.test(code)) errors.push('build() 不能是 async，必須同步回傳 Object3D');
  if (errors.length) return done();

  // ---- 實際建構 ----
  const THREE = await import('three');
  const { createRuntime } = await import(pathToFileURL(context.paths.runtime).href);
  const player = { position: new THREE.Vector3(...(context.player?.position ?? [0, 1.6, 3])) };
  const rt = createRuntime({ THREE, player, strict: true });

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

  // ---- 操作鉤子試跑 60 幀（開車／飛行／穿戴時每格會被呼叫） ----
  const hook = built.object.userData?.onControl;
  if (hook !== undefined && typeof hook !== 'function') errors.push('userData.onControl 必須是函式');
  if (typeof hook === 'function') {
    const rootPos = built.object.position.clone();
    const wheels = [];
    built.object.traverse((o) => {
      // 名字像輪子的（渦輪、齒輪不算）
      if (o !== built.object && /^wheel|輪/i.test(o.name || '') && !/渦輪|齒輪|輪廓/.test(o.name)) wheels.push({ o, q: o.quaternion.clone() });
    });
    for (let f = 0; f < 60; f += 1) {
      const st = {
        mode: meta?.controls || 'drive',
        speed: Math.sin(f / 10) * 8,
        steer: Math.sin(f / 7),
        throttle: Math.cos(f / 9),
        lift: Math.sin(f / 5),
        action: f === 10,
        actionHeld: f >= 10 && f < 20,
        t: f / 60,
      };
      try {
        hook.call(built.object, st, 1 / 60);
      } catch (e) {
        errors.push(`userData.onControl() 執行錯誤：${e.message}`);
        break;
      }
    }
    if (!meta?.controls) warnings.push('有 onControl 但 meta.json 沒寫 controls，使用者按「操作」時要自己選模式');
    if (built.object.position.distanceTo(rootPos) > 1e-6) {
      warnings.push('onControl 搬動了整個零件：引擎會自己移動它，onControl 只動輪子、燈光這些細節');
    }
    const turning = (meta?.controls === 'drive' || meta?.controls === 'fly') && wheels.length;
    if (turning && !wheels.some((w) => Math.abs(w.o.quaternion.dot(w.q)) < 0.9999)) {
      warnings.push(`開車時輪子沒有轉：在 onControl 裡依 s.speed 轉 ${wheels.slice(0, 4).map((w) => w.o.name).join('、')}`);
    }
  } else if (meta?.controls && meta.controls !== 'wear') {
    warnings.push('controls 是 drive／fly 但沒有 userData.onControl，輪子不會轉、也沒有燈光細節');
  }

  // ---- 編出來的 API：讀了不存在的 ctx／THREE 成員 ----
  errors.push(...unknownApiErrors(built.unknownApi, { ctx: ['THREE', 'spawn', 'player', 'random', 'library'], 'ctx.player': ['position'] }));
  for (const name of built.unknownThree) warnings.push(`${name} 不存在（three.js r186 沒有這個）`);

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
  if (physMod && !errors.length) {
    try {
      await checkPhysics({ THREE, root, meta, library, physMod, built, errors, warnings, report, rt, candId });
    } catch (e) {
      warnings.push(`物理試放沒跑成（${e.message}），零件本身沒問題`);
    }
  }
  return done();
}

// meta.json 的 physics／device 格式
function checkToolMeta(meta, toolsMod, errors, warnings) {
  const t = meta.tool;
  if (t != null && toolsMod) {
    const kinds = Object.keys(toolsMod.TOOL_KINDS);
    if (typeof t !== 'object' || Array.isArray(t) || !kinds.includes(t.kind)) errors.push(`meta.json 的 tool 要是 { "kind": ${kinds.map((k) => `"${k}"`).join(' | ')} }`);
    else {
      for (const k of Object.keys(t)) if (!['kind', 'rate', 'speed', 'range', 'color', 'size', 'burst', 'spread'].includes(k)) warnings.push(`tool.${k} 不認得（只有 kind／rate／speed／range／color／size／burst／spread）`);
      if (t.color != null && !/^#[0-9a-f]{6}$/i.test(String(t.color))) errors.push('tool.color 要是 "#rrggbb"');
      if (meta.controls !== 'wear') warnings.push('道具（tool）通常要拿在手上：meta.json 加 "controls": "wear"');
    }
  }
  const g = meta.target;
  if (g != null && (typeof g !== 'object' || Array.isArray(g) || (g.points != null && !(Number.isFinite(g.points) && g.points >= 1 && g.points <= 100)))) {
    errors.push('meta.json 的 target 要是 { "points": 1–100 }');
  }
}

function checkPhysicsMeta(meta, physMod, errors, warnings) {
  const ph = meta.physics;
  if (ph != null) {
    if (typeof ph !== 'object' || Array.isArray(ph)) errors.push('meta.json 的 physics 要是物件，例如 { "mass": 20, "friction": 0.8 }');
    else {
      for (const k of Object.keys(ph)) if (!['mass', 'friction', 'bounce', 'fixed'].includes(k)) warnings.push(`physics.${k} 不認得（只有 mass／friction／bounce／fixed）`);
      if (ph.mass != null && !(Number.isFinite(ph.mass) && ph.mass >= 0.1 && ph.mass <= 20000)) errors.push('physics.mass 要是 0.1–20000 的數字（公斤）');
      if (ph.friction != null && !(Number.isFinite(ph.friction) && ph.friction >= 0 && ph.friction <= 2)) errors.push('physics.friction 要在 0–2');
      if (ph.bounce != null && !(Number.isFinite(ph.bounce) && ph.bounce >= 0 && ph.bounce <= 1)) errors.push('physics.bounce 要在 0–1');
      if (ph.fixed != null && typeof ph.fixed !== 'boolean') errors.push('physics.fixed 要是 true 或 false');
    }
  }
  const d = meta.device;
  if (d == null || !physMod) return;
  const kinds = Object.keys(physMod.DEVICE_KINDS);
  if (typeof d !== 'object' || Array.isArray(d) || !kinds.includes(d.kind)) {
    errors.push(`meta.json 的 device 要是 { "kind": ${kinds.map((k) => `"${k}"`).join(' | ')} }`);
    return;
  }
  const [lo, hi] = physMod.DEVICE_FORCE_RANGE[d.kind];
  if (d.force != null && d.kind !== 'steer' && !(Number.isFinite(d.force) && d.force >= lo && d.force <= hi)) {
    errors.push(`device.force（${d.kind}）要在 ${lo}–${hi}`);
  }
  if (d.speed != null && !(d.kind === 'wheel' && Number.isFinite(d.speed) && d.speed >= 0.5 && d.speed <= 30)) {
    errors.push('device.speed 只有輪子用，要在 0.5–30（公尺／秒）');
  }
  if (d.direction != null && !(Array.isArray(d.direction) && d.direction.length === 3 && d.direction.every(Number.isFinite) && Math.hypot(...d.direction) > 0.01)) {
    errors.push('device.direction 要是 [x, y, z]（零件自己的座標）');
  }
  for (const k of Object.keys(d)) if (!['kind', 'force', 'speed', 'direction'].includes(k)) warnings.push(`device.${k} 不認得（只有 kind／force／speed／direction）`);
}

// ---------------- 物理試放 ----------------
// 用跟瀏覽器同一套碰撞形狀（public/physics.mjs 的 collectPieces），放在地上跑 3 秒：
// 會不會倒、會不會穿過地板、裝置的形狀合不合理、onDevice 鉤子會不會出錯。
async function checkPhysics({ THREE, root, meta, library, physMod, built, errors, warnings, report, rt, candId }) {
  const { collectPieces, hullDesc, normalizeDevice, normalizePhysics, DEVICE_KINDS, PHYS } = physMod;
  const libDevice = new Map((library.parts || []).map((p) => [p.id, normalizeDevice(p.device)]));
  const myDevice = normalizeDevice(meta?.device);
  const deviceOf = (pid) => (pid === '__candidate__' ? myDevice : libDevice.get(pid) || null);
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  const pieces = collectPieces(THREE, root, { deviceOf });
  if (!pieces.length) {
    errors.push('沒有能碰撞的實體形狀：全部都是透明特效或標了 noCollide（至少要有一個實心的 mesh）');
    return;
  }
  const ph = normalizePhysics(meta?.physics) || {};
  const R = (await import('@dimforge/rapier3d-compat')).default;
  await R.init();
  const world = new R.World({ x: 0, y: PHYS.gravity, z: 0 });
  world.timestep = 1 / 60;
  const ground = world.createRigidBody(R.RigidBodyDesc.fixed());
  world.createCollider(R.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0).setFriction(0.8), ground);
  const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.02, 0).setLinearDamping(PHYS.linearDamping).setAngularDamping(PHYS.angularDamping));
  const totalBox = pieces.reduce((n, p) => n + Math.max(p.size.x * p.size.y * p.size.z, 1e-6), 0);
  for (const p of pieces) {
    const cd = hullDesc(R, p.points).setFriction(ph.friction ?? PHYS.friction).setRestitution(ph.bounce ?? PHYS.bounce);
    const vol = Math.max(p.size.x * p.size.y * p.size.z, 1e-6);
    if (Number.isFinite(ph.mass)) cd.setMass(Math.max(0.05, (ph.mass * vol) / totalBox));
    else if (p.device) cd.setMass(DEVICE_KINDS[p.device.kind].mass);
    else cd.setDensity(PHYS.density);
    world.createCollider(cd, body);
  }
  const mass = body.mass();
  let maxSpeed = 0;
  let bad = false;
  for (let f = 0; f < 180; f += 1) {
    world.step();
    const v = body.linvel();
    const t = body.translation();
    if (![v.x, v.y, v.z, t.x, t.y, t.z].every(Number.isFinite)) {
      bad = true;
      break;
    }
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
  }
  const t = body.translation();
  const r = body.rotation();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  const tiltDeg = Math.round((Math.acos(Math.min(1, Math.max(-1, up.y))) * 180) / Math.PI);
  const slid = Math.round(Math.hypot(t.x, t.z) * 100) / 100;
  world.free();
  const kinds = pieces.filter((p) => p.device).map((p) => p.device.kind);
  report.physics = { pieces: pieces.length, mass: Math.round(mass * 10) / 10, tiltDeg, slid, devices: kinds };
  if (bad) errors.push('物理試放時數值爆掉（NaN）：形狀可能退化成一條線或一個點');
  else if (t.y < -0.5) errors.push('物理試放時穿過了地板：碰撞形狀有問題');
  else if (maxSpeed > 30) errors.push(`物理試放時彈飛出去（${Math.round(maxSpeed)} m/s）`);
  const loose = ph.fixed || myDevice?.kind === 'wheel' || myDevice?.kind === 'balloon';
  if (!bad && !loose && tiltDeg > 25) {
    warnings.push(`放在地上會倒（傾斜 ${tiltDeg}°）：底座加寬或把重心放低；本來就該倒（例如球、棍子）就不用管`);
  }
  if (!bad && !loose && slid > 0.4) warnings.push(`放在地上會自己滾走（${slid} m）`);

  // 裝置：形狀與回饋
  if (myDevice) {
    const main = pieces[0];
    if (myDevice.kind === 'wheel') {
      const { x, y, z } = main.size;
      if (Math.abs(y - z) / Math.max(y, z) > 0.25) warnings.push(`輪子要是圓的：軸沿 X，在 YZ 平面是圓形（現在 y=${y.toFixed(2)}、z=${z.toFixed(2)}）`);
      if (x > Math.max(y, z)) warnings.push('輪子太厚了：X（輪軸方向）應該比直徑小');
    }
    if (myDevice.kind === 'balloon') {
      const lift = myDevice.force;
      if (mass * 9.81 >= lift) warnings.push(`氣球自己就太重（${mass.toFixed(1)} kg），浮力 ${lift} N 拉不動：physics.mass 設 1 左右`);
    }
    const hook = built.object.userData?.onDevice;
    if (hook !== undefined && typeof hook !== 'function') errors.push('userData.onDevice 必須是函式');
    if (typeof hook === 'function') {
      for (let f = 0; f < 60; f += 1) {
        const st = { kind: myDevice.kind, on: f >= 10, power: f >= 10 ? 1 : 0, firing: f >= 10 && f < 40, t: f / 60 };
        try {
          hook.call(built.object, st, 1 / 60);
        } catch (e) {
          errors.push(`userData.onDevice() 執行錯誤：${e.message}`);
          break;
        }
      }
    } else if (['fan', 'rocket', 'spring'].includes(myDevice.kind)) {
      warnings.push(`${DEVICE_KINDS[myDevice.kind].label}沒有 userData.onDevice：開關時看不出來（例如風扇葉片轉、火箭噴火）`);
    }
    await probeDevice({ THREE, R, physMod, rt, candId, meta, myDevice, errors, warnings, report });
  } else if (built.object.userData?.onDevice) {
    warnings.push('有 onDevice 但 meta.json 沒寫 device，鉤子不會被呼叫');
  }
}

// ---------------- 裝置實測 ----------------
// 用工坊真正的物理引擎（public/physics.mjs）把裝置開一開：風扇／火箭有沒有往宣告的方向推、氣球會不會浮、
// 彈簧會不會彈、四個輪子裝上木板開不開得動、操縱桿裝上車會不會翻。只出提醒，不擋交件。
async function probeDevice({ THREE, R, physMod, rt, candId, meta, myDevice, errors, warnings, report }) {
  const { createPhysics, collectPieces, DEVICE_KINDS } = physMod;
  const label = DEVICE_KINDS[myDevice.kind].label;
  const parts = new Map([
    [candId, { id: candId, name: meta?.name || 'candidate', device: meta?.device, physics: meta?.physics }],
    ['__plank__', { id: '__plank__', name: 'probe plank' }],
    ['__raft__', { id: '__raft__', name: 'probe raft', physics: { mass: 4, friction: 0.6 } }],
    ['__wheel__', { id: '__wheel__', name: 'probe wheel', device: { kind: 'wheel' }, physics: { mass: 6, friction: 1.2 } }],
  ]);
  const instances = new Map();
  const mat = new THREE.MeshStandardMaterial();
  // 物理引擎靠 userData.partId 認出零件（和它的裝置），測試用的木板、輪子也要掛上
  const box = (w, h, d, partId = '__plank__') => {
    const g = new THREE.Group();
    g.userData.partId = partId;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.y = h / 2;
    g.add(m);
    return g;
  };
  const probeWheel = () => {
    const g = new THREE.Group();
    g.userData.partId = '__wheel__';
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 20), mat);
    m.rotation.z = Math.PI / 2;
    m.position.y = 0.3;
    g.add(m);
    return g;
  };
  let n = 0;
  const add = (partId, object, pos, glue = null) => {
    object.position.set(...pos);
    object.updateMatrixWorld(true);
    const restBox = new THREE.Box3().setFromObject(object).applyMatrix4(object.matrixWorld.clone().invert());
    const inst = { id: `probe${(n += 1)}`, partId, object, restBox, glue };
    instances.set(inst.id, inst);
    return inst;
  };
  const phys = createPhysics({
    THREE,
    loadRapier: async () => R,
    instances: () => instances,
    partOf: (id) => parts.get(id),
    boxOf: (i) => {
      i.object.updateMatrixWorld(true);
      return i.restBox.clone().applyMatrix4(i.object.matrixWorld);
    },
    nameOf: () => label,
    controlled: () => null,
    fxRoot: null,
    camera: null,
    respawnAt: () => new THREE.Vector3(0, 1, 0),
    onSettled: () => {},
    onMoving: () => {},
    toast: () => {},
    now: () => performance.now(),
  });
  const r2 = (v) => Math.round(v * 100) / 100;
  const run = (sec, each) => {
    for (let i = 0; i < Math.round(sec * 60); i += 1) {
      each?.();
      phys.update(1 / 60);
    }
  };
  const candidate = () => rt.instantiate(candId).object;
  await phys.setEnabled(true, { wake: true });
  const kind = myDevice.kind;
  if (kind === 'fan' || kind === 'rocket') {
    const dir = new THREE.Vector3(...(myDevice.direction || DEVICE_KINDS[kind].dir)).normalize();
    // 出力點＝裝置碰撞外形的中心；它偏離零件中軸（垂直於推力方向）多遠，就會把東西扭多大力
    const piece = collectPieces(THREE, candidate(), { deviceOf: (id) => (id === candId ? myDevice : null) }).find((p) => p.device);
    const off = piece ? new THREE.Vector3(piece.center.x, 0, piece.center.z) : new THREE.Vector3();
    off.sub(dir.clone().multiplyScalar(off.dot(dir)));
    const offCm = Math.round(off.length() * 100);
    if (Math.abs(dir.y) < 0.7) {
      // 往水平推：單獨放在地上點火 2 秒，看有沒有往 direction 走
      const inst = add(candId, candidate(), [0, 0, 0]);
      run(0.5);
      const p0 = inst.object.position.clone();
      phys.activate(inst);
      run(2);
      const d = inst.object.position.clone().sub(p0);
      report.probe = { kind, moved: r2(d.length()), along: r2(d.dot(dir)), offCenterCm: offCm };
      if (d.length() < 0.3) warnings.push(`${label}啟動 2 秒只動了 ${r2(d.length())} m：force 太小，或碰撞形狀卡在地上`);
      else if (d.dot(dir) < 0.5 * d.length()) {
        const u = d.clone().normalize();
        warnings.push(`${label}推的方向不對：宣告往 [${dir.toArray().map(r2)}]，實際往 [${u.toArray().map(r2)}]（風扇葉片、噴口要朝 −Z，或改 device.direction）`);
      }
    } else {
      // 往上推（噴射背包、升空器）：單獨點火本來就會翻滾，看不出好壞。照使用者的用法，
      // 黏在一塊輕木筏正中間點火，看前 0.8 秒有沒有往上走、木筏會不會翻
      const raft = add('__raft__', box(1.6, 0.1, 1.0, '__raft__'), [0, 0, 0], 'g_probe');
      const inst = add(candId, candidate(), [0, 0.1, 0], 'g_probe');
      run(0.5);
      const p0 = raft.object.position.clone();
      phys.activate(inst);
      let tilt = 0;
      const up = new THREE.Vector3();
      const Y = new THREE.Vector3(0, 1, 0);
      run(0.8, () => {
        up.set(0, 1, 0).applyQuaternion(raft.object.quaternion);
        tilt = Math.max(tilt, up.angleTo(Y));
      });
      const d = raft.object.position.clone().sub(p0);
      const tiltDeg = Math.round(THREE.MathUtils.radToDeg(tilt));
      report.probe = { kind, glued: true, moved: r2(d.length()), along: r2(d.dot(dir)), tilt: tiltDeg, offCenterCm: offCm };
      if (tiltDeg > 35) {
        // 翻過去（> 90°）＝黏在任何東西上都會把它掀翻，裝置等於壞了：一定要修
        (tiltDeg > 90 ? errors : warnings).push(
          `${label}黏在木筏正中間點火，0.8 秒內木筏就${tiltDeg > 90 ? '翻過去了' : '歪了'}（${tiltDeg}°）：推力沒有通過中心${offCm >= 1 ? `（出力點偏離零件中軸 ${offCm} cm）` : ''}。` +
            '出力點是碰撞外形的中心：把噴口／機身做在零件正中間、前後左右對稱，不對稱的裝飾做成不碰撞（userData.noCollide = true）',
        );
      } else if (d.dot(dir) < 0.3) {
        warnings.push(`${label}黏在木筏上點火 0.8 秒只往 [${dir.toArray().map(r2)}] 走了 ${r2(d.dot(dir))} m：force 太小，舉不起東西`);
      }
    }
  } else if (kind === 'balloon') {
    const inst = add(candId, candidate(), [0, 0, 0]);
    run(3);
    const y = inst.object.position.y;
    report.probe = { kind, rose: r2(y) };
    if (y < 1) warnings.push(`氣球放開 3 秒只升到 ${r2(y)} m：太重或浮力太小`);
  } else if (kind === 'spring') {
    const inst = add(candId, candidate(), [0, 0, 0]);
    run(0.5);
    phys.activate(inst);
    let top = 0;
    run(1.2, () => (top = Math.max(top, inst.object.position.y)));
    report.probe = { kind, jumped: r2(top) };
    if (top < 0.3) warnings.push(`彈簧按下去只彈起 ${r2(top)} m`);
  } else if (kind === 'wheel' || kind === 'steer') {
    // 木板＋四個輪子（輪子用候選或測試輪）＋（操縱桿時放在木板上），黏成一台車開一開
    const wheel = kind === 'wheel' ? candidate : probeWheel;
    const sample = wheel();
    const wb = new THREE.Box3().setFromObject(sample);
    const ws = wb.getSize(new THREE.Vector3());
    const r = Math.max(ws.y, ws.z) / 2;
    const plankY = Math.max(0.05, r - 0.04);
    const plank = add('__plank__', box(1.2, 0.08, 1.0), [0, plankY, 0], 'g_probe');
    for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      add(kind === 'wheel' ? candId : '__wheel__', wheel(), [x * (0.6 + ws.x / 2 + 0.03), 0, z * 0.32], 'g_probe');
    }
    if (kind === 'steer') add(candId, candidate(), [0, plankY + 0.08, -0.2], 'g_probe');
    run(0.8);
    const p0 = plank.object.position.clone();
    run(2, () => phys.pilot(plank, { x: 0, y: 1 }, 1 / 60));
    const drove = plank.object.position.clone().sub(p0);
    run(1.5, () => phys.pilot(plank, { x: 1, y: 0.6 }, 1 / 60));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(plank.object.quaternion).y;
    report.probe = { kind, drove: r2(drove.length()), forward: r2(drove.z), upright: r2(up) };
    if (kind === 'wheel' && drove.z < 0.5) {
      warnings.push(`四個這種輪子裝上木板，往前開 2 秒只走了 ${r2(drove.z)} m：輪子要是圓的、軸沿 X、原點在輪胎底部`);
    }
    if (up < 0.8) warnings.push(`裝上這個${label}的車翻了（傾斜 ${Math.round((Math.acos(Math.max(-1, Math.min(1, up))) * 180) / Math.PI)}°）：太重或太高`);
  }
  await phys.setEnabled(false);
}

// ---------------- 世界模組（環境／規則）驗收 ----------------
// 用跟瀏覽器同一個宿主（public/worldhost.mjs），配一個假的世界：3 個物件（一個正在被開、一個浮在半空）、
// 會記錄呼叫的環境介面、開車鉤子。裝上去 → 跑 3 秒 → 跑開車鉤子 1 秒 → 拔掉，看有沒有出錯、留垃圾、太耗效能。
async function checkWorld(dir, context, meta, errors, warnings, report, done) {
  const file = path.join(dir, 'world.js');
  const src = readFileSync(file, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const banned = [
    [/^\s*import[\s{*]/m, 'world.js 不可以 import（three.js 請用 world.THREE）'],
    [/\bimport\s*\(/, '不可以動態 import()'],
    [/\brequire\s*\(/, '不可以 require()'],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, '不可以連網路'],
    [/\b(document|window|navigator|globalThis)\s*\./, '不可以使用 document / window / navigator / globalThis（如果只是變數名稱，請改名）'],
    [/\beval\s*\(|new\s+Function\s*\(/, '不可以 eval / new Function'],
    [/\b(localStorage|sessionStorage|indexedDB)\b/, '不可以存取瀏覽器儲存空間'],
    [/\b(setTimeout|setInterval|requestAnimationFrame)\s*\(/, '不可以用計時器，請寫在 update(dt, t)'],
    [/\bMath\.random\s*\(/, '不要用 Math.random()，請用 world.random()'],
    [/\b(TextureLoader|GLTFLoader|FileLoader|ImageLoader|CanvasTexture|FontLoader)\b/, '不可以載入外部檔案或用 canvas 貼圖'],
  ];
  for (const [re, msg] of banned) if (re.test(code)) errors.push(msg);
  checkUnfinished(src, warnings);
  if (!/export\s+default\b/.test(code)) errors.push('world.js 需要 export default function install(world) { ... }');
  if (meta?.replaces) {
    const activeIds = [context.world?.environment?.id, ...(context.world?.rules || []).map((r) => r.id)].filter(Boolean);
    if (!activeIds.includes(meta.replaces)) {
      errors.push(`replaces 必須是目前啟用中的模組 id（現在啟用中：${activeIds.join('、') || '沒有'}）`);
    }
  }
  if (errors.length) return done();

  const THREE = await import('three');
  const { createWorldHost, ENV_METHODS } = await import(pathToFileURL(context.paths.worldhost).href);
  const root = new THREE.Group();
  const envCalls = [];
  const isColor = (c) => c === null || typeof c === 'number' || (typeof c === 'string' && c.length < 40);
  const env = {};
  for (const m of ENV_METHODS) {
    env[m] = (...args) => {
      envCalls.push(m);
      const [a, b, c] = args;
      if ((m === 'background' || m === 'fog') && !isColor(a)) warnings.push(`world.env.${m}() 的顏色格式怪怪的`);
      if (m === 'fog' && a != null && !(Number.isFinite(b ?? 20) && Number.isFinite(c ?? 48) && (b ?? 20) < (c ?? 48))) {
        warnings.push('world.env.fog(color, near, far) 的 near 要小於 far');
      }
      if (m === 'sun' && a?.position && !(Array.isArray(a.position) && a.position.length === 3)) warnings.push('world.env.sun({ position }) 要是 [x, y, z]');
    };
  }
  env.reset = () => envCalls.push('reset');
  const box3 = (o) => new THREE.Box3().setFromObject(o);
  const mk = (id, name, x, y = 0) => {
    const o = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    m.position.y = 0.5;
    o.add(m);
    o.position.set(x, y, 0);
    return { id, name, object: o, box: () => box3(o), controlled: false, dragging: false };
  };
  const handles = [mk('o1', '測試方塊', 0), mk('o2', '測試卡丁車', 3), mk('o3', '浮在半空的機器人', -3, 2)];
  handles[1].controlled = true;
  const player = { position: new THREE.Vector3(0, 1.6, 4), forward: () => new THREE.Vector3(0, 0, -1) };
  const hooks = [];
  const tunes = {};
  const vehicle = {
    tune: (_id, partial) => Object.assign(tunes, partial),
    onUpdate: (_id, fn) => hooks.push(fn),
    clear: () => {},
  };
  const huds = [];
  const runtimeErrors = [];
  const physCalls = [];
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  const fakePhysics = {
    get enabled() {
      return true;
    },
    gravity(y) {
      physCalls.push('gravity');
      if (y != null && !Number.isFinite(y)) runtimeErrors.push('world.physics.gravity(y) 要給數字（公尺／秒²，向下是負的）');
      return Number.isFinite(y) ? y : -9.81;
    },
    material(o) {
      physCalls.push('material');
      if (o && typeof o !== 'object') runtimeErrors.push('world.physics.material({ friction, bounce }) 要給物件');
    },
    push(h, v) {
      physCalls.push('push');
      if (!h || !vec3(v)) runtimeErrors.push('world.physics.push(handle, [vx, vy, vz]) 要給物件和三個數字');
    },
    velocity() {
      physCalls.push('velocity');
      return [0, 0, 0];
    },
    setVelocity(h, v) {
      physCalls.push('setVelocity');
      if (!h || !vec3(v)) runtimeErrors.push('world.physics.setVelocity(handle, [vx, vy, vz]) 要給物件和三個數字');
    },
  };
  const host = createWorldHost({
    THREE,
    root,
    env,
    objects: () => handles,
    supportBelow: () => 0,
    player,
    vehicle,
    physics: { apiFor: () => fakePhysics, clearModule: () => {} },
    hud: (_id, text) => text && huds.push(text),
    toast: () => {},
    onError: (_rec, e, why) => runtimeErrors.push(`${why === 'slow' ? '太耗效能' : '執行時出錯'}：${e?.message || e}`),
    now: () => performance.now(),
    strictApi: true,
  });
  const rec = { id: '__candidate__', type: meta?.type, name: meta?.name || '新模組' };
  let mod;
  try {
    mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`);
  } catch (e) {
    errors.push(`world.js 無法載入（語法錯誤？）：${e.message}`);
    return done();
  }
  const res = host.install(rec, mod);
  if (!res.ok) {
    errors.push(`install(world) 執行錯誤：${res.error}`);
    return done();
  }
  const entry = host.entry(rec.id);
  let t = 0;
  for (let f = 0; f < 180 && host.isActive(rec.id); f += 1) {
    t += 1 / 60;
    player.position.x = Math.sin(t) * 2;
    host.update(1 / 60, t);
  }
  if (host.isActive(rec.id) && hooks.length) {
    for (let f = 0; f < 60 && host.isActive(rec.id); f += 1) {
      const st = {
        mode: 'drive',
        object: handles[1].object,
        speed: 6 + Math.sin(f / 9) * 3,
        yaw: f * 0.01,
        moveYaw: f * 0.01,
        alt: 0,
        input: { x: Math.sin(f / 7), y: 1, lift: 0, action: f === 10 },
        t: f / 60,
      };
      for (const h of [...hooks]) h(st, 1 / 60);
      const bad = ['speed', 'yaw', 'moveYaw', 'alt'].find((k) => !Number.isFinite(st[k]));
      if (bad) {
        errors.push(`vehicle.onUpdate 把 ${bad} 改成了不是數字`);
        break;
      }
    }
  }
  errors.push(...runtimeErrors);
  if (entry?.unknownApi.size) {
    const api = entry.api;
    errors.push(
      ...unknownApiErrors(entry.unknownApi, {
        world: Object.keys(api),
        'world.env': Object.keys(api.env),
        'world.player': Object.keys(api.player),
        'world.vehicle': Object.keys(api.vehicle),
        'world.physics': ['enabled', ...Object.keys(api.physics).filter((k) => k !== 'enabled')],
      }),
    );
  }

  let meshes = 0;
  let triangles = 0;
  let points = 0;
  let lights = 0;
  root.traverse((o) => {
    if (o.isLight) lights += 1;
    if (o.isPoints) points += o.geometry?.attributes?.position?.count || 0;
    if (o.isMesh) {
      meshes += 1;
      const g = o.geometry;
      const pos = g?.attributes?.position;
      if (pos) triangles += ((g.index ? g.index.count : pos.count) / 3) * (o.isInstancedMesh ? o.count : 1);
    }
  });
  // 環境：中間 28 公尺內地面要平（物件和車子都走在 y = 0，隆起的地形會讓車子陷進去）
  let bump = 0;
  if (meta?.type === 'environment') {
    root.updateMatrixWorld(true);
    const meshesOnly = [];
    root.traverse((o) => {
      if (o.isMesh) meshesOnly.push(o);
    });
    const ray = new THREE.Raycaster();
    const DOWN = new THREE.Vector3(0, -1, 0);
    const probe = new THREE.Vector3();
    for (const r of [0, 2, 5, 8, 12, 16, 20, 24, 27]) {
      const n = r === 0 ? 1 : Math.max(8, Math.round(r * 1.5));
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * Math.PI * 2;
        ray.set(probe.set(Math.cos(a) * r, 3, Math.sin(a) * r), DOWN); // 從 3 公尺高往下看（雲、天空不算）
        ray.far = 3.5;
        const hit = ray.intersectObjects(meshesOnly, false)[0];
        if (hit && hit.point.y > bump) bump = hit.point.y;
      }
    }
    if (bump > 0.1) errors.push(`中間 28 公尺內的地面隆起到 ${bump.toFixed(2)} m；物件和車子走在 y = 0，這範圍要平（坑可以往下凹，山和石頭放遠一點）`);
  }

  const added = entry ? entry.added.size : 0;
  const hookCount = hooks.length;
  const envRefused = entry ? entry.envRefused : 0;
  const hasUpdate = typeof entry?.ret?.update === 'function';
  host.uninstall(rec.id);
  if (root.children.length) warnings.push('拔掉之後場景裡還留著東西（請一律用 world.add 放東西）');

  const envUsed = envCalls.filter((c) => c !== 'reset').length;
  if (lights > 4) errors.push(`燈光太多（${lights} 個，上限 4）`);
  if (triangles > 150_000) errors.push(`三角形太多（${Math.round(triangles)}，上限 150,000）`);
  if (points > 30_000) errors.push(`粒子太多（${points}，上限 30,000）`);
  if (meta?.type === 'environment' && envUsed === 0 && added === 0) errors.push('環境模組沒有改任何環境設定，也沒有放任何東西');
  if (meta?.type === 'rule' && envRefused) warnings.push('規則模組呼叫了 world.env，會被忽略；要改天空、地面請做成環境模組');
  if (meta?.type === 'rule' && !hasUpdate && hookCount === 0 && Object.keys(tunes).length === 0 && added === 0 && !physCalls.length) {
    warnings.push('這個規則好像什麼都沒做');
  }
  report.kind = meta?.type;
  report.stats = {
    added,
    meshes,
    triangles: Math.round(triangles),
    points,
    lights,
    envCalls: envUsed,
    vehicleHooks: hookCount,
    tuning: Object.keys(tunes),
    hud: huds.length > 0,
    physics: [...new Set(physCalls)],
    centerBump: Math.round(bump * 100) / 100,
  };
  return done();
}
