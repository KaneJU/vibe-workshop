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

  // ---- 操作鉤子試跑 60 幀（開車／飛行／穿戴時每格會被呼叫） ----
  const hook = built.object.userData?.onControl;
  if (hook !== undefined && typeof hook !== 'function') errors.push('userData.onControl 必須是函式');
  if (typeof hook === 'function') {
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
  } else if (meta?.controls && meta.controls !== 'wear') {
    warnings.push('controls 是 drive／fly 但沒有 userData.onControl，輪子不會轉、也沒有燈光細節');
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
  if (physMod && !errors.length) {
    try {
      await checkPhysics({ THREE, root, meta, library, physMod, built, errors, warnings, report });
    } catch (e) {
      warnings.push(`物理試放沒跑成（${e.message}），零件本身沒問題`);
    }
  }
  return done();
}

// meta.json 的 physics／device 格式
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
async function checkPhysics({ THREE, root, meta, library, physMod, built, errors, warnings, report }) {
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
  } else if (built.object.userData?.onDevice) {
    warnings.push('有 onDevice 但 meta.json 沒寫 device，鉤子不會被呼叫');
  }
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
