import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { createRuntime } from './runtime.mjs';
import { createControlEngine, guessMode, MODES } from './control.mjs';
import { createWorldManager } from './worlds.mjs';
import { createPhysics, PHYS } from './physics.mjs';
import { createAdventure, buildTitleScene, ADVENTURE_PARTS } from './adventure.mjs';

const $ = (sel) => document.querySelector(sel);
// 三種畫面：首頁（/）、冒險（/?play）、自由工坊（/?ws；舊網址帶 physics、safe 參數的也直接進工坊）
const params = new URLSearchParams(window.location.search);
const MODE = params.has('play') ? 'play' : params.has('ws') || params.has('physics') || params.has('safe') ? 'workshop' : 'title';
document.body.classList.add(`mode-${MODE}`);
let adventure = null;
let titleScene = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r3 = (v) => Math.round(v * 1000) / 1000;
const T0 = performance.now();
const now = () => (performance.now() - T0) / 1000;

// ---------------- 場景 ----------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.xr.enabled = true;
$('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05080f);
scene.fog = new THREE.Fog(0x05080f, 20, 48);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.65;

// 相機掛在 rig 底下：桌面模式 rig 在原點；進 VR 時把 rig 移到相機站的位置
const rig = new THREE.Group();
scene.add(rig);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.03, 200);
camera.position.set(0, 1.75, 4.6);
rig.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.7, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.5;
controls.maxDistance = 30;
controls.update();

const hemi = new THREE.HemisphereLight(0xcfeaff, 0x0a1020, 0.8);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(5, 9, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 40 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 72),
  new THREE.MeshStandardMaterial({ color: 0x0b1422, roughness: 0.92, metalness: 0.05 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(40, 80, 0x2fd6ff, 0x16384d);
grid.material.transparent = true;
grid.material.opacity = 0.3;
grid.material.depthWrite = false;
grid.position.y = 0.002;
scene.add(grid);
const pad = new THREE.Mesh(
  new THREE.RingGeometry(1.15, 1.2, 96),
  new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
);
pad.rotation.x = -Math.PI / 2;
pad.position.y = 0.004;
scene.add(pad);

const world = new THREE.Group(); // 所有使用者的物件（每個 instance 是 world 的直接子節點）
world.name = 'world';
scene.add(world);
const fx = new THREE.Group(); // 打造中的全息框
scene.add(fx);
const worldFx = new THREE.Group(); // 世界模組放進來的東西（天空、雨、賽道⋯）
worldFx.name = 'world-modules';
scene.add(worldFx);

// 預設環境：環境模組被拔掉時照這份還原
const envDefaults = {
  background: scene.background.clone(),
  fog: { color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far },
  hemi: { sky: hemi.color.clone(), ground: hemi.groundColor.clone(), intensity: hemi.intensity },
  sun: { color: sun.color.clone(), intensity: sun.intensity, position: sun.position.clone() },
  floor: { color: floor.material.color.clone(), roughness: floor.material.roughness, metalness: floor.material.metalness },
  exposure: renderer.toneMappingExposure,
  reflections: scene.environmentIntensity,
};
// 環境模組只能透過這組函式改天空、地面、燈光（記得住原狀才還原得回去）
const envAdapter = {
  background(c) {
    scene.background = c == null ? null : new THREE.Color(c);
  },
  fog(c, near = 20, far = 48) {
    scene.fog = c == null ? null : new THREE.Fog(new THREE.Color(c), near, far);
  },
  ground({ color, roughness, metalness, visible } = {}) {
    if (color != null) floor.material.color.set(color);
    if (Number.isFinite(roughness)) floor.material.roughness = roughness;
    if (Number.isFinite(metalness)) floor.material.metalness = metalness;
    if (visible != null) floor.visible = !!visible;
  },
  grid(v) {
    grid.visible = !!v;
  },
  pad(v) {
    pad.visible = !!v;
  },
  hemi({ sky, ground, intensity } = {}) {
    if (sky != null) hemi.color.set(sky);
    if (ground != null) hemi.groundColor.set(ground);
    if (Number.isFinite(intensity)) hemi.intensity = intensity;
  },
  sun({ color, intensity, position } = {}) {
    if (color != null) sun.color.set(color);
    if (Number.isFinite(intensity)) sun.intensity = intensity;
    if (Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)) sun.position.fromArray(position);
  },
  exposure(n) {
    if (Number.isFinite(n)) renderer.toneMappingExposure = n;
  },
  reflections(n) {
    if (Number.isFinite(n)) scene.environmentIntensity = n;
  },
  reset() {
    const d = envDefaults;
    scene.background = d.background.clone();
    scene.fog = new THREE.Fog(d.fog.color.clone(), d.fog.near, d.fog.far);
    hemi.color.copy(d.hemi.sky);
    hemi.groundColor.copy(d.hemi.ground);
    hemi.intensity = d.hemi.intensity;
    sun.color.copy(d.sun.color);
    sun.intensity = d.sun.intensity;
    sun.position.copy(d.sun.position);
    floor.material.color.copy(d.floor.color);
    floor.material.roughness = d.floor.roughness;
    floor.material.metalness = d.floor.metalness;
    floor.visible = true;
    grid.visible = true;
    pad.visible = true;
    renderer.toneMappingExposure = d.exposure;
    scene.environmentIntensity = d.reflections;
  },
};

// ---------------- 狀態 ----------------

const player = { position: new THREE.Vector3() };
const runtime = createRuntime({ THREE, player });
let library = [];
let loaded = false;
const instances = new Map(); // id -> { id, partId, object, restBox, updaters, bornAt }
const selection = new Set();
const selHelpers = new Map();
const undoStack = [];
const pendingJobs = new Map();
const isTouch = window.matchMedia('(hover: none)').matches;
let multiMode = false; // 手機沒有 Shift：開「多選」後，點物件是加入／移出選取
const engine = createControlEngine({
  THREE,
  scene,
  camera,
  controls,
  world,
  worldBox: (i) => worldBox(i),
  dropToSupport: (i) => dropToSupport(i),
  toast: (m) => toast(m),
  instancesList: () => [...instances.values()],
  pilot: (inst, input, dt) => phys.pilot(inst, input, dt),
});

// 物理引擎（借鏡王國之淚）：Rapier 剛體＋究極手＋黏合＋左納烏式裝置＋時光倒轉。
// Rapier 是 WebAssembly（約 1.6 MB），打開物理時才載入；載入失敗就維持原本的擺放模式。
const urlPhysics = new URLSearchParams(window.location.search).get('physics'); // ?physics=0／1：只影響這次開啟，不寫進存檔
let physicsOn = false;
const phys = createPhysics({
  THREE,
  loadRapier: async () => {
    const R = (await import('@dimforge/rapier3d-compat')).default;
    await R.init();
    return R;
  },
  instances: () => instances,
  partOf: (id) => runtime.parts.get(id),
  boxOf: (i) => worldBox(i),
  nameOf: (i) => partName(i.partId),
  controlled: () => (engine.active && engine.mode !== 'pilot' ? engine.session.inst : null),
  fxRoot: scene,
  camera,
  respawnAt: () => playerFloor().addScaledVector(forwardFlat(), 2).setY(1.5),
  onSettled: () => scheduleSave(),
  onMoving: () => scheduleSave(),
  toast: (m) => toast(m),
  now: () => performance.now(),
});

// 世界模組：環境（天空地面燈光天氣）與規則（重力、玩法、開車手感），由 Codex 寫、當場裝卸
function objectHandles() {
  const held = engine.session?.inst;
  return [...instances.values()].map((i) => ({
    id: i.id,
    name: partName(i.partId),
    object: i.object,
    box: () => worldBox(i),
    controlled: i === held,
    dragging: (!!drag && !!drag.moving?.includes(i)) || !!phys.holding?.members.includes(i),
  }));
}
function supportBelowHandle(h) {
  const inst = instances.get(h?.id);
  if (!inst) return 0;
  const b = worldBox(inst);
  const c = b.getCenter(new THREE.Vector3());
  return supportHeight(c.x, c.z, b.getSize(new THREE.Vector3()).multiplyScalar(0.5), new Set([inst]));
}
const worlds = createWorldManager({
  THREE,
  root: worldFx,
  env: envAdapter,
  objects: () => objectHandles(),
  supportBelow: (h) => supportBelowHandle(h),
  player: { position: player.position, forward: () => forwardFlat() },
  vehicle: engine.vehicle,
  physics: phys,
  hudEl: $('#worldHud'),
  listEl: $('#worldList'),
  safeBtn: $('#safeBtn'),
  resetBtn: $('#resetEnvBtn'),
  toast: (m) => toast(m),
  api: (...a) => api(...a),
  forceSafe: new URLSearchParams(window.location.search).has('safe'),
});

async function api(method, url, body, opts = {}) {
  // 首頁和冒險模式只准寫冒險存檔：自由工坊的場景、工具箱、世界模組、打造一律不碰
  if (MODE !== 'workshop' && method !== 'GET' && url !== '/api/adventure') throw new Error('冒險模式不會改動自由工坊');
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const newInstanceId = () => `i_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const partName = (id) => runtime.parts.get(id)?.name ?? '未知零件';
const partKind = (id) => runtime.parts.get(id)?.kind;

async function loadModule(id) {
  if (runtime.modules.has(id)) return true;
  try {
    runtime.registerModule(id, await import(`/parts/${id}.js`));
    return true;
  } catch (e) {
    console.error(e);
    toast(`⚠️ 零件程式載入失敗：${partName(id)}`);
    return false;
  }
}

// ---------------- 物件 ----------------

function addInstance(rec, { save = true } = {}) {
  const built = runtime.instantiate(rec.partId);
  const object = built.object;
  object.updateMatrixWorld(true);
  // 剛建好、動畫還沒跑之前的外框＝「靜止外框」，疊放與擺放都用它，才不會因為彈跳中途而算錯高度
  const restBox = new THREE.Box3().setFromObject(object);
  if (restBox.isEmpty()) restBox.set(new THREE.Vector3(-0.2, 0, -0.2), new THREE.Vector3(0.2, 0.4, 0.2));
  object.position.fromArray(rec.position);
  object.quaternion.fromArray(rec.quaternion);
  object.scale.fromArray(rec.scale);
  object.userData.instanceId = rec.id;
  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  world.add(object);
  const inst = {
    id: rec.id,
    partId: rec.partId,
    object,
    restBox,
    updaters: built.updaters,
    bornAt: now(),
    glue: typeof rec.glue === 'string' ? rec.glue : null, // 黏在一起的東西共用一個 glue id
  };
  instances.set(rec.id, inst);
  const problems = [...built.errors, ...built.warnings];
  if (problems.length) toast(`⚠️ ${partName(rec.partId)}：${problems[0]}`);
  if (save) scheduleSave();
  updateStatus();
  return inst;
}

function disposeObject(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose?.();
  });
}

function removeInstance(id, { save = true } = {}) {
  const inst = instances.get(id);
  if (!inst) return;
  deselect(id);
  inst.object.removeFromParent();
  disposeObject(inst.object);
  instances.delete(id);
  if (save) scheduleSave();
  updateStatus();
}

function worldBox(inst) {
  inst.object.updateMatrixWorld(true);
  return inst.restBox.clone().applyMatrix4(inst.object.matrixWorld);
}

function snapshot() {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  return [...instances.values()].map((i) => {
    const glue = i.glue ? { glue: i.glue } : {};
    const held = engine.savedTransformFor(i);
    if (held) {
      return { id: i.id, partId: i.partId, position: held.position.toArray(), quaternion: held.quaternion.toArray(), scale: held.scale.toArray(), ...glue };
    }
    i.object.updateMatrixWorld(true);
    i.object.matrixWorld.decompose(p, q, s);
    return { id: i.id, partId: i.partId, position: p.toArray(), quaternion: q.toArray(), scale: s.toArray(), ...glue };
  });
}

function pushUndo(state = JSON.stringify(snapshot())) {
  undoStack.push(state);
  if (undoStack.length > 80) undoStack.shift();
}

function undo() {
  const s = undoStack.pop();
  if (!s) return toast('沒有可以復原的動作');
  restore(JSON.parse(s));
  scheduleSave();
  toast('↶ 已復原');
}

function restore(list) {
  clearSelection();
  for (const id of [...instances.keys()]) removeInstance(id, { save: false });
  for (const rec of list) if (runtime.parts.has(rec.partId)) addInstance(rec, { save: false });
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 400);
}
async function saveNow(keepalive = false) {
  clearTimeout(saveTimer);
  if (!loaded) return; // 還沒載入完就存，會把存檔洗成空的
  try {
    if (MODE === 'play') {
      const data = adventure?.saveData();
      if (data) await api('PUT', '/api/adventure', { ...data, instances: snapshot() }, keepalive ? { keepalive: true } : {});
      return;
    }
    if (MODE !== 'workshop') return;
    const body = { instances: snapshot(), ...(urlPhysics === null ? { physics: physicsOn } : {}) };
    await api('PUT', '/api/scene', body, keepalive ? { keepalive: true } : {});
  } catch (e) {
    toast(`⚠️ 存檔失敗：${e.message}`);
  }
}
window.addEventListener('pagehide', () => saveNow(true));

// ---------------- 選取 ----------------

const selectedInstances = () => [...selection].map((id) => instances.get(id)).filter(Boolean);

function addToSelection(id) {
  const inst = instances.get(id);
  if (!inst || selection.has(id)) return;
  selection.add(id);
  if (MODE === 'workshop') {
    // 選取框是工坊的工具；冒險模式不畫（抓著的東西有究極手的綠光）
    const helper = new THREE.BoxHelper(inst.object, 0x38e1ff);
    helper.material.depthTest = false;
    helper.material.transparent = true;
    helper.renderOrder = 10;
    scene.add(helper);
    selHelpers.set(id, helper);
  }
  updateSelectionUI();
}
function deselect(id) {
  if (!selection.delete(id)) return;
  const h = selHelpers.get(id);
  if (h) {
    h.removeFromParent();
    h.geometry.dispose();
    h.material.dispose();
    selHelpers.delete(id);
  }
  updateSelectionUI();
}
function clearSelection() {
  for (const id of [...selection]) deselect(id);
}
// 黏在一起的東西是一體：點其中一個就整組選起來
const glueMembers = (inst) => (!inst ? [] : inst.glue ? [...instances.values()].filter((i) => i.glue === inst.glue) : [inst]);
function selectOnly(id) {
  clearSelection();
  for (const i of glueMembers(instances.get(id))) addToSelection(i.id);
}
function toggleSelect(id) {
  const group = glueMembers(instances.get(id));
  if (selection.has(id)) group.forEach((i) => deselect(i.id));
  else group.forEach((i) => addToSelection(i.id));
}

function updateSelectionUI() {
  const sel = selectedInstances();
  const info = $('#selInfo');
  if (!sel.length) info.textContent = isTouch ? '點物件選取（要選好幾個，先按上方「多選」）' : '點一下物件來選取（Shift＋點可多選）';
  else if (sel.length === 1) info.textContent = `已選：${partName(sel[0].partId)}`;
  else info.textContent = `已選 ${sel.length} 個：${[...new Set(sel.map((i) => partName(i.partId)))].slice(0, 4).join('、')}`;
  document.querySelectorAll('#selActions button, #mobileBar button').forEach((b) => {
    if (!['undo', 'multi'].includes(b.dataset.act)) b.disabled = !sel.length;
  });
  const hasCombo = sel.some((i) => partKind(i.partId) === 'composite');
  const hasGlue = sel.some((i) => i.glue);
  document.querySelectorAll('[data-act=ungroup]').forEach((b) => (b.disabled = !hasCombo && !hasGlue));
  document.querySelectorAll('[data-act=glue]').forEach((b) => (b.disabled = clustersOf(sel).length < 2));
  document.querySelectorAll('[data-act=recall]').forEach((b) => (b.disabled = !sel.length || !phys.ready));
  document.querySelectorAll('[data-act=power]').forEach((b) => (b.disabled = !phys.ready || !sel.some((i) => phys.hasDevices(i))));
  $('#mobileBar').classList.toggle('show', sel.length > 0 || multiMode);
  const canModify = sel.length === 1 && partKind(sel[0].partId) === 'generated';
  $('#modifyWrap').hidden = !canModify;
  if (!canModify) $('#modifyChk').checked = false;
}

function updateStatus() {
  const n = pendingJobs.size;
  $('#status').textContent = `物件 ${instances.size} · 零件 ${library.length}${n ? ` · 打造中 ${n}` : ''}`;
}

// ---------------- 點選、拖曳、疊放 ----------------

const raycaster = new THREE.Raycaster();
raycaster.params.Line.threshold = 0.02;
raycaster.params.Points.threshold = 0.02;
const downRay = new THREE.Raycaster();
downRay.params.Line.threshold = 0.005;
downRay.params.Points.threshold = 0.005;
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const FLOOR_PLANE = new THREE.Plane(UP, 0);
const pointer = new THREE.Vector2();

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
function instanceOf(obj) {
  let o = obj;
  while (o && o.parent !== world) o = o.parent;
  return o ? instances.get(o.userData.instanceId) : null;
}
// 看不見的東西（例如被彈指藏起來的）點不到、也不能當支撐面
function isShown(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
function pickFromRaycaster() {
  for (const h of raycaster.intersectObjects(world.children, true)) {
    if (!isShown(h.object)) continue;
    const inst = instanceOf(h.object);
    if (inst) return { inst, point: h.point };
  }
  return null;
}

// 在 (x, z) 這個位置、這麼大的底面，往下看最高的支撐面在哪（沒有東西就是地板 0）
function supportHeight(x, z, half, exclude) {
  const targets = [];
  for (const i of instances.values()) if (!exclude.has(i) && i.object.visible) targets.push(i.object);
  if (!targets.length) return 0;
  let best = 0;
  const probe = new THREE.Vector3();
  for (const [fx, fz] of [[0, 0], [0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) {
    downRay.set(probe.set(x + fx * half.x, 80, z + fz * half.z), DOWN);
    const hit = downRay.intersectObjects(targets, true)[0];
    if (hit && hit.point.y > best) best = hit.point.y;
  }
  return best;
}

function dropToSupport(inst) {
  const b = worldBox(inst);
  if (b.isEmpty()) return;
  const c = b.getCenter(new THREE.Vector3());
  const half = b.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  inst.object.position.y += supportHeight(c.x, c.z, half, new Set([inst])) - b.min.y;
}

let down = null;
let drag = null;

renderer.domElement.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0 || renderer.xr.isPresenting || engine.active) return;
    closeDrawers();
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    let hit = pickFromRaycaster();
    // 冒險模式：只有這一關要搬的東西抓得起來，其他的當作空白處（拖了轉視角）
    if (MODE === 'play' && hit && !adventure?.canGrab(hit.inst)) hit = null;
    down = { x: e.clientX, y: e.clientY, hit: hit?.inst || null };
    if (!hit) return; // 點在空白處：交給 OrbitControls 轉視角
    controls.enabled = false;
    if ((e.shiftKey || multiMode) && MODE === 'workshop') {
      toggleSelect(hit.inst.id);
      return;
    }
    if (!selection.has(hit.inst.id)) selectOnly(hit.inst.id);
    if (phys.ready) {
      // 究極手：拖動才抓起來（只是點一下＝選取）
      drag = { physics: true, inst: hit.inst, point: hit.point.clone(), started: false, before: JSON.stringify(snapshot()), pointerId: e.pointerId, trail: [] };
      renderer.domElement.setPointerCapture(e.pointerId);
      return;
    }
    const moving = selectedInstances();
    const box = worldBox(hit.inst);
    const bottom = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
    drag = {
      primary: hit.inst,
      moving,
      offset: hit.inst.object.position.clone().sub(bottom),
      half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5),
      before: JSON.stringify(snapshot()),
      started: false,
      pointerId: e.pointerId,
    };
    renderer.domElement.setPointerCapture(e.pointerId);
  },
  { capture: true },
);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.physics) {
    handOn(e);
    return;
  }
  if (!drag.started) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
    drag.started = true;
  }
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const exclude = new Set(drag.moving);
  const targets = [floor];
  for (const i of instances.values()) if (!exclude.has(i) && i.object.visible) targets.push(i.object);
  const hit = raycaster.intersectObjects(targets, true)[0];
  const p = hit ? hit.point.clone() : raycaster.ray.intersectPlane(FLOOR_PLANE, new THREE.Vector3());
  if (!p) return;
  const y = supportHeight(p.x, p.z, drag.half, exclude);
  const delta = new THREE.Vector3(p.x, y, p.z).add(drag.offset).sub(drag.primary.object.position);
  for (const inst of drag.moving) inst.object.position.add(delta);
});

function endPointer(e) {
  if (drag?.physics) {
    if (drag.started) {
      phys.release();
      pushUndo(drag.before);
      scheduleSave();
    }
    hideHoldHud();
    try {
      renderer.domElement.releasePointerCapture(drag.pointerId);
    } catch {
      /* 已釋放 */
    }
    drag = null;
  } else if (drag) {
    if (drag.started) {
      pushUndo(drag.before);
      scheduleSave();
    }
    try {
      renderer.domElement.releasePointerCapture(drag.pointerId);
    } catch {
      /* 已釋放 */
    }
    drag = null;
  } else if (down && !down.hit && !e.shiftKey && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) {
    clearSelection();
  }
  down = null;
  controls.enabled = true;
}
renderer.domElement.addEventListener('pointerup', endPointer);
renderer.domElement.addEventListener('pointercancel', endPointer);

// ---------------- 究極手（物理開著時的拖曳） ----------------
// 手指拖動＝抓起來（離地 20 公分飄著）、在同一個高度平面上移動；▲▼ 升降、⟲⟳ 轉 45°、⤾ 翻面；
// 碰到或靠近別的東西時 🔗 會亮，按下去就黏上；抓著搖一搖（左右來回甩）就把這一塊從黏著的整組拆下來；放手會順著手勢丟出去。

let holdLiftDir = 0;
function handOn(e) {
  if (!drag.started) {
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) return;
    drag.started = true;
    if (!phys.grab(drag.inst, drag.point)) {
      drag.physics = false; // 正在倒轉之類的：這次不抓
      drag = null;
      return;
    }
    drag.planeY = drag.point.y + PHYS.holdLift;
    drag.lift = 0;
    showHoldHud(e.clientX);
  }
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  drag.ray = raycaster.ray.clone();
  updateHoldTarget();
  // 畫面一卡，瀏覽器會把好幾個移動合併成一個事件；搖一搖要看合併前的每一個點，不然來回甩會被吃掉
  const evs = e.getCoalescedEvents?.() || [];
  for (const ce of evs.length ? evs : [e]) detectShake(ce);
}

function updateHoldTarget() {
  if (!drag?.ray) return;
  const y = Math.max(0.05, drag.planeY + drag.lift);
  drag.lift = y - drag.planeY;
  const cam = camera.getWorldPosition(new THREE.Vector3());
  let p = drag.ray.intersectPlane(new THREE.Plane(UP, -y), new THREE.Vector3());
  // 視線跟地面快要平行（或往上看）時交點會跑到很遠：限制在 25 公尺內
  if (!p || p.distanceTo(cam) > 25) {
    p = drag.ray.at(Math.min(drag.lastDist ?? 6, 25), new THREE.Vector3());
    p.y = y;
  }
  drag.lastDist = p.distanceTo(cam);
  phys.moveHold(p);
}

// 搖一搖：1.2 秒內來回甩 3 次以上
function zigzags(samples, key, minSwing = 30) {
  let count = 0;
  let dir = 0;
  let peak = samples[0]?.[key] ?? 0;
  const start = peak;
  for (const s of samples) {
    const v = s[key];
    if (dir === 0) {
      if (Math.abs(v - start) >= minSwing) {
        dir = Math.sign(v - start);
        peak = v;
      }
    } else if ((v - peak) * dir > 0) {
      peak = v;
    } else if (Math.abs(v - peak) >= minSwing) {
      count += 1;
      dir = -dir;
      peak = v;
    }
  }
  return count;
}
function detectShake(e) {
  const t = e.timeStamp || performance.now();
  drag.trail.push({ t, x: e.clientX, y: e.clientY });
  while (drag.trail.length && t - drag.trail[0].t > 1200) drag.trail.shift();
  if (drag.shaken || !drag.inst.glue) return;
  if (zigzags(drag.trail, 'x') + zigzags(drag.trail, 'y') >= 3) {
    drag.shaken = true;
    pushUndo();
    detachInst(drag.inst);
    toast(`🫨 把「${partName(drag.inst.partId)}」搖下來了`);
  }
}

function showHoldHud(x) {
  const hud = $('#holdHud');
  hud.hidden = false;
  hud.classList.toggle('left', x > window.innerWidth / 2); // 按鈕放在手指的另一邊，另一隻手按得到
  const hint = $('#holdHint');
  hint.classList.remove('fade');
  clearTimeout(showHoldHud.timer);
  showHoldHud.timer = setTimeout(() => hint.classList.add('fade'), 4000);
}
function hideHoldHud() {
  $('#holdHud').hidden = true;
  holdLiftDir = 0;
}
function refreshHoldHud() {
  if ($('#holdHud').hidden) return;
  $('#holdGlue').disabled = !phys.glueCandidate;
}

const newGlueId = () => `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
// 把這些東西（連同它們原本黏著的整組）黏成一組
function glueTogether(list) {
  const groups = new Set(list.map((i) => i.glue).filter(Boolean));
  const id = [...groups][0] || newGlueId();
  for (const inst of instances.values()) if (list.includes(inst) || (inst.glue && groups.has(inst.glue))) inst.glue = id;
  scheduleSave();
  return id;
}
function detachInst(inst) {
  const group = glueMembers(inst);
  if (group.length <= 2) group.forEach((i) => (i.glue = null));
  else inst.glue = null;
  selectOnly(inst.id);
  scheduleSave();
}
function glueHeld() {
  const h = phys.holding;
  const c = phys.glueCandidate;
  if (!h || !c) return toast('把它靠到另一個東西旁邊（出現黃色的線）再按 🔗');
  pushUndo();
  glueTogether([...h.members, ...c.members]);
  selectOnly(h.inst.id);
  toast('🔗 黏上了！現在是同一個東西');
}
function glueSelected() {
  const sel = selectedInstances();
  if (clustersOf(sel).length < 2) return toast('先選兩個以上的東西（手機先按「多選」）');
  pushUndo();
  glueTogether(sel);
  selectOnly(sel[0].id);
  toast(phys.ready ? `🔗 黏起來了（${sel.length} 個東西變成一體）` : `🔗 黏起來了（${sel.length} 個）；打開物理後會變成同一個剛體`);
}
function recallSelected() {
  const sel = selectedInstances();
  if (!sel.length) return toast('先選一個東西');
  if (!phys.ready) return toast('時光倒轉要先打開物理（🌍 世界分頁）');
  let ok = 0;
  let stopped = 0;
  for (const list of clustersOf(sel)) {
    const r = phys.recall(list[0]);
    if (r.ok && r.stopped) stopped += 1;
    else if (r.ok) ok += 1;
  }
  if (ok) toast('⏪ 時光倒轉！它會沿著剛才的路線退回去');
  else if (stopped) toast('⏸ 停止倒轉');
  else toast('它最近沒有動過，沒有路線可以倒轉');
}
function powerSelected() {
  const sel = selectedInstances();
  if (!phys.ready) return toast('裝置要先打開物理（🌍 世界分頁）');
  const results = [];
  for (const list of clustersOf(sel)) if (phys.hasDevices(list[0])) results.push(phys.activate(list[0]));
  if (!results.length) return toast('選取的東西上沒有裝置（風扇、輪子、火箭…）');
  toast(results.some((r) => r?.power) ? '⚡ 裝置啟動' : results.some((r) => r?.fired) ? '⚡ 發射！' : '裝置關閉');
}
async function setPhysics(on, { persist = true, quiet = false, wake = true } = {}) {
  physicsOn = on;
  renderPhysBtn();
  if (on) {
    try {
      await phys.setEnabled(true, { wake });
    } catch (e) {
      console.error(e);
      physicsOn = false;
      renderPhysBtn();
      toast(`⚠️ 物理引擎載入失敗：${e.message}`);
      return false;
    }
  } else {
    if (drag?.physics) drag = null;
    hideHoldHud();
    await phys.setEnabled(false);
  }
  updateSelectionUI();
  if (persist) scheduleSave();
  if (!quiet) toast(on ? '🍎 物理開啟：東西會掉、會倒；拖曳＝究極手，放手可以丟出去' : '物理關閉：回到原本的擺放方式');
  return true;
}
function renderPhysBtn() {
  const b = $('#physBtn');
  b.textContent = physicsOn ? '🍎 物理：開' : '🍎 物理：關';
  b.classList.toggle('on', physicsOn);
  document.body.classList.toggle('physics-on', physicsOn);
}

// ---------------- 調整動作 ----------------

function keepBottom(inst, mutate) {
  const before = worldBox(inst).min.y;
  mutate();
  inst.object.position.y += before - worldBox(inst).min.y;
}
// 選取分成「一組一組」：黏在一起的算一組，其餘各自一組
function clustersOf(sel) {
  const map = new Map();
  for (const i of sel) {
    const k = i.glue || i.id;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return [...map.values()];
}
function clusterBox(list) {
  const b = new THREE.Box3();
  for (const i of list) b.union(worldBox(i));
  return b;
}
function keepClusterBottom(list, mutate) {
  const before = clusterBox(list).min.y;
  mutate();
  const dy = before - clusterBox(list).min.y;
  for (const i of list) i.object.position.y += dy;
}
function rotateSelected(dir) {
  const sel = selectedInstances();
  if (!sel.length) return;
  pushUndo();
  const q = new THREE.Quaternion().setFromAxisAngle(UP, (dir * Math.PI) / 12);
  for (const list of clustersOf(sel)) {
    if (list.length === 1) {
      const i = list[0];
      keepBottom(i, () => i.object.rotateY((dir * Math.PI) / 12));
      continue;
    }
    const pivot = clusterBox(list).getCenter(new THREE.Vector3());
    keepClusterBottom(list, () => {
      for (const i of list) {
        i.object.position.sub(pivot).applyQuaternion(q).add(pivot);
        i.object.quaternion.premultiply(q);
      }
    });
  }
  scheduleSave();
}
function scaleSelected(f) {
  const sel = selectedInstances();
  if (!sel.length) return;
  pushUndo();
  for (const list of clustersOf(sel)) {
    const s = THREE.MathUtils.clamp(list[0].object.scale.x * f, 0.05, 50) / list[0].object.scale.x;
    const pivot = clusterBox(list).getCenter(new THREE.Vector3());
    keepClusterBottom(list, () => {
      for (const i of list) {
        if (list.length > 1) i.object.position.sub(pivot).multiplyScalar(s).add(pivot);
        i.object.scale.multiplyScalar(s);
      }
    });
  }
  scheduleSave();
}
function deleteSelected() {
  const sel = selectedInstances();
  if (!sel.length) return toast('先選取要刪除的物件');
  pushUndo();
  for (const i of sel) removeInstance(i.id, { save: false });
  scheduleSave();
}
function duplicateSelected(times = 1) {
  const sel = selectedInstances();
  if (!sel.length) return toast('先選取要複製的物件');
  pushUndo();
  const box = new THREE.Box3();
  for (const i of sel) box.union(worldBox(i));
  const step = box.getSize(new THREE.Vector3()).x + 0.15;
  const right = new THREE.Vector3();
  camera.getWorldDirection(right);
  right.cross(UP).setY(0).normalize();
  const created = [];
  for (let k = 1; k <= Math.min(times, 20); k += 1) {
    const glueMap = new Map();
    for (const i of sel) {
      if (i.glue && !glueMap.has(i.glue)) glueMap.set(i.glue, newGlueId());
      created.push(
        addInstance(
          {
            id: newInstanceId(),
            partId: i.partId,
            position: i.object.position.clone().addScaledVector(right, step * k).toArray(),
            quaternion: i.object.quaternion.toArray(),
            scale: i.object.scale.toArray(),
            glue: i.glue ? glueMap.get(i.glue) : null,
          },
          { save: false },
        ),
      );
    }
  }
  clearSelection();
  for (const c of created) addToSelection(c.id);
  scheduleSave();
}

async function groupSelected(name) {
  const sel = selectedInstances();
  if (!sel.length) return toast('先選取要組合的物件（Shift＋點可多選）');
  if (!name) {
    name = window.prompt('幫這個零件取個名字', sel.length === 1 ? `${partName(sel[0].partId)}組` : '新零件');
    if (!name) return;
  }
  name = name.trim();
  if (!name) return;
  const box = new THREE.Box3();
  for (const i of sel) box.union(worldBox(i));
  const base = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const children = sel.map((i) => ({
    partId: i.partId,
    position: i.object.position.clone().sub(base).toArray(),
    quaternion: i.object.quaternion.toArray(),
    scale: i.object.scale.toArray(),
  }));
  let rec;
  try {
    rec = await api('POST', '/api/composite', { name, children, size: box.getSize(new THREE.Vector3()).toArray() });
  } catch (e) {
    return toast(`⚠️ 存零件失敗：${e.message}`);
  }
  library.push(rec);
  runtime.addPart(rec);
  renderLibrary();
  if (rec.thumbPending) waitForThumb(rec);
  pushUndo();
  for (const i of sel) removeInstance(i.id, { save: false });
  const inst = addInstance(
    { id: newInstanceId(), partId: rec.id, position: base.toArray(), quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    { save: false },
  );
  selectOnly(inst.id);
  scheduleSave();
  toast(`🧩 已存成零件「${rec.name}」，工具箱裡可以再拿出來用`);
}

function ungroupSelected() {
  const glued = selectedInstances().filter((i) => i.glue);
  if (glued.length) {
    pushUndo();
    for (const i of glued) i.glue = null;
    scheduleSave();
    updateSelectionUI();
    toast(`✂️ 拆開了：${glued.length} 個東西不再黏在一起`);
    return;
  }
  const sel = selectedInstances().filter((i) => partKind(i.partId) === 'composite');
  if (!sel.length) return toast('選取的不是組合零件');
  pushUndo();
  const created = [];
  for (const inst of sel) {
    const part = runtime.parts.get(inst.partId);
    inst.object.updateMatrixWorld(true);
    for (const c of part.children) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3().fromArray(c.position),
        new THREE.Quaternion().fromArray(c.quaternion),
        new THREE.Vector3().fromArray(c.scale),
      );
      m.premultiply(inst.object.matrixWorld);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      m.decompose(p, q, s);
      created.push(
        addInstance(
          { id: newInstanceId(), partId: c.partId, position: p.toArray(), quaternion: q.toArray(), scale: s.toArray() },
          { save: false },
        ),
      );
    }
    removeInstance(inst.id, { save: false });
  }
  clearSelection();
  for (const c of created) addToSelection(c.id);
  scheduleSave();
  toast(`拆成 ${created.length} 個物件`);
}

// ---------------- 擺放 ----------------

const playerFloor = () => new THREE.Vector3(player.position.x, 0, player.position.z);
function forwardFlat() {
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  d.y = 0;
  if (d.lengthSq() < 1e-6) d.set(0, 0, -1);
  return d.normalize();
}
function overlapsXZ(p, r, self) {
  for (const i of instances.values()) {
    if (i === self) continue;
    const b = worldBox(i);
    const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x);
    const dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z);
    if (Math.hypot(dx, dz) < r) return true;
  }
  return false;
}
function frontSpot(inst) {
  const size = worldBox(inst).getSize(new THREE.Vector3());
  const r = Math.max(size.x, size.z) / 2 + 0.08;
  const fwd = forwardFlat();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const base = playerFloor().addScaledVector(fwd, 1.5 + r);
  for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
    const p = base.clone().addScaledVector(right, k * (2 * r + 0.1));
    if (!overlapsXZ(p, r, inst)) return p;
  }
  return base;
}
function placeInstance(inst, placement, anchorId) {
  const anchor = anchorId ? instances.get(anchorId) : null;
  if (placement === 'around_player') {
    // 原點放在使用者腳下，零件的 -Z 對齊使用者面向的方向（AGENTS.md 的約定）
    const fwd = forwardFlat();
    inst.object.position.copy(playerFloor());
    inst.object.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    inst.object.position.y -= worldBox(inst).min.y;
    return;
  }
  if (placement === 'on_selection' && anchor) {
    const b = worldBox(anchor);
    inst.object.quaternion.copy(anchor.object.quaternion);
    inst.object.position.set((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
  } else {
    inst.object.position.copy(frontSpot(inst));
    const p = inst.object.position;
    inst.object.rotation.set(0, Math.atan2(player.position.x - p.x, player.position.z - p.z), 0); // +Z 面向使用者
  }
  dropToSupport(inst);
}

// ---------------- 打造（Codex） ----------------

// 給 Codex 的場景說明：不只位置大小，也說「這是做什麼的」（借鏡微軟 LLMR：知道每個東西的用途，「讓它停下來」這種話才接得住）
function whatItIs(i) {
  const part = runtime.parts.get(i.partId);
  const yaw = new THREE.Euler().setFromQuaternion(i.object.quaternion, 'YXZ').y;
  return {
    description: String(part?.description || '').slice(0, 80),
    yawDeg: Math.round(THREE.MathUtils.radToDeg(yaw)),
    ...(part?.controls ? { controls: part.controls } : {}),
    ...(part?.device?.kind ? { device: part.device.kind } : {}),
    ...(i.updaters.length ? { animated: true } : {}),
    ...(i.glue ? { gluedTo: glueMembers(i).filter((m) => m !== i).map((m) => partName(m.partId)).slice(0, 6) } : {}),
  };
}
function describeInstance(i) {
  const b = worldBox(i);
  return {
    instanceId: i.id,
    partId: i.partId,
    name: partName(i.partId),
    kind: partKind(i.partId),
    size: b.getSize(new THREE.Vector3()).toArray().map(r3),
    position: i.object.position.toArray().map(r3),
    top: r3(b.max.y),
    ...whatItIs(i),
  };
}
function sceneSummary() {
  return [...instances.values()]
    .map((i) => ({ i, d: i.object.position.distanceTo(player.position) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 40)
    .map(({ i }) => {
      const b = worldBox(i);
      return {
        name: partName(i.partId),
        partId: i.partId,
        position: i.object.position.toArray().map(r3),
        size: b.getSize(new THREE.Vector3()).toArray().map(r3),
        ...whatItIs(i),
      };
    });
}

function handleLocalCommand(t) {
  let m;
  if (/^(開車|駕駛|開它|開走|開起來|drive( it)?)[。.!！]?$/i.test(t)) {
    openControl('drive');
    return true;
  }
  if (/^(起飛|飛行|飛起來|讓它飛|fly( it)?)[。.!！]?$/i.test(t)) {
    openControl('fly');
    return true;
  }
  if (/^(戴上|穿上|穿戴|戴起來|拿起來|wear( it)?|put (it )?on)[。.!！]?$/i.test(t)) {
    openControl('wear');
    return true;
  }
  if (/^(離開|下車|脫下|停止操作|exit|stop)[。.!！]?$/i.test(t)) {
    stopControl();
    return true;
  }
  if (/^((打開|開啟|開)物理|物理(開|打開|開啟)|physics on)[。.!！]?$/i.test(t)) {
    setPhysics(true);
    return true;
  }
  if (/^((關掉|關閉|關)物理|物理(關|關掉|關閉)|physics off)[。.!！]?$/i.test(t)) {
    setPhysics(false);
    return true;
  }
  if (/^(黏起來|黏在一起|黏合|黏上|glue( (it|them|these))?( together)?)[。.!！]?$/i.test(t)) {
    glueSelected();
    return true;
  }
  if (/^(時光)?(倒轉|回溯|倒帶)[。.!！]?$|^(rewind|recall)( it)?[.!]?$/i.test(t)) {
    recallSelected();
    return true;
  }
  if (/^(啟動|發動|開關裝置|activate|power( on| off)?)[。.!！]?$/i.test(t)) {
    powerSelected();
    return true;
  }
  // English: "save as part called turret" / "undo" / "delete" / "ungroup" / "duplicate 3"
  if ((m = t.match(/^(?:save|group)(?: (?:this|these|it|them|the stack))? as (?:a )?part(?: (?:called|named) ["']?(.+?)["']?)?[.!]?$/i))) {
    groupSelected(m[1]);
    return true;
  }
  if (/^(delete|remove)( it| this| these| selected)?[.!]?$/i.test(t)) {
    deleteSelected();
    return true;
  }
  if (/^(ungroup|split)( it| this)?[.!]?$/i.test(t)) {
    ungroupSelected();
    return true;
  }
  if ((m = t.match(/^(?:duplicate|copy)(?: it| this)?(?: (\d+)(?: times?)?)?[.!]?$/i))) {
    duplicateSelected(Number(m[1] || 1));
    return true;
  }
  if (
    (m = t.match(
      /^(?:把)?(?:這[些個疊堆組]?|選取的?)?(?:東西)?(?:存成|存為|做成|組成|變成)(?:一個)?零件(?:[，,、\s]*(?:叫做?|名為|命名為|取名為?)\s*[「『"]?(.+?)[」』"]?)?[。.!！]?$/,
    ))
  ) {
    groupSelected(m[1]);
    return true;
  }
  if (/^(復原|還原|上一步|undo)[。!！]?$/i.test(t)) {
    undo();
    return true;
  }
  if (/^(刪除|刪掉|移除)(它|這個|這些|選取的?)?[。!！]?$/.test(t)) {
    deleteSelected();
    return true;
  }
  if (/^(拆開|解散|分解)(它|這個)?[。!！]?$/.test(t)) {
    ungroupSelected();
    return true;
  }
  if ((m = t.match(/^複製(?:它|這個)?(?:\s*(\d+)\s*[個份次]?)?[。!！]?$/))) {
    duplicateSelected(Number(m[1] || 1));
    return true;
  }
  return false;
}

async function submitPrompt(raw) {
  const photo = photoData;
  // 只附照片、沒打字也可以：伺服器會當成「照這張照片做出來」
  const text = String(raw || '').trim();
  if (!text && !photo) return;
  $('#prompt').value = '';
  if (!photo && handleLocalCommand(text)) return;
  const sel = selectedInstances();
  const modify = $('#modifyChk').checked && sel.length === 1 && partKind(sel[0].partId) === 'generated';
  const body = {
    prompt: text,
    mode: modify ? 'modify' : 'create',
    basePartId: modify ? sel[0].partId : null,
    selection: sel.map(describeInstance),
    scene: sceneSummary(),
    player: player.position.toArray().map(r3),
    ...(photo ? { image: photo } : {}),
  };
  let res;
  try {
    res = await api('POST', '/api/generate', body);
  } catch (e) {
    if (text) $('#prompt').value = text; // 送不出去：字和照片都留著，可以再按一次
    return toast(`⚠️ ${e.message}`);
  }
  if (photo) setPhoto(null);
  const ctx = {
    job: res.job,
    modify,
    basePartId: body.basePartId,
    selectionIds: sel.map((i) => i.id),
    anchorId: sel[0]?.id || null,
    holo: createHologram(modify ? sel[0] : null),
    card: createJobCard(res.job, photo),
  };
  pendingJobs.set(res.job.id, ctx);
  if (isTouch) {
    $('#prompt').blur();
    toast('🔧 Codex 開始打造（約 20–60 秒，進度在 ☰）');
  }
  updateStatus();
  pollJob(ctx);
}

function createHologram(onInst) {
  const g = new THREE.Group();
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(0.7, 0.7, 0.7)),
    new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.8 }),
  );
  box.position.y = 0.35;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.012, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.7 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.6, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.25 }),
  );
  beam.position.y = 0.8;
  g.add(box, ring, beam);
  if (onInst) {
    const b = worldBox(onInst);
    g.position.set((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
    g.scale.setScalar(THREE.MathUtils.clamp(b.getSize(new THREE.Vector3()).length() / 1.2, 0.6, 2.5));
  } else {
    g.position.copy(playerFloor().addScaledVector(forwardFlat(), 1.9));
  }
  g.userData = { box, ring, beam, born: now() };
  fx.add(g);
  return g;
}
function animateHolograms(t) {
  for (const g of fx.children) {
    const { box, ring, beam, born } = g.userData;
    const k = t - born;
    box.rotation.y = k * 0.8;
    box.material.opacity = 0.45 + 0.35 * Math.abs(Math.sin(k * 2));
    ring.scale.setScalar(1 + 0.15 * Math.sin(k * 3));
    beam.material.opacity = 0.15 + 0.15 * Math.abs(Math.sin(k * 4));
  }
}
function removeHologram(g) {
  if (!g) return;
  g.removeFromParent();
  disposeObject(g);
}

function createJobCard(job, photo = null) {
  const jobsEl = $('#jobs');
  if (jobsEl.querySelector(':scope > .muted')) jobsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'job running';
  el.innerHTML =
    '<div class="jtitle"></div><div class="jline">準備中…</div><div class="jerr" hidden></div>' +
    '<button class="jcancel">取消</button>';
  el.querySelector('.jtitle').textContent = `${photo ? '📷 ' : ''}${job.mode === 'modify' ? '改造：' : ''}「${job.prompt}」`;
  if (photo) {
    addThumb(el, photo); // 做好之前先顯示照片，做好後換成成品的縮圖
    el._photo = photo; // 「再試一次」要帶同一張照片
  }
  el.querySelector('.jcancel').onclick = () =>
    api('POST', `/api/jobs/${job.id}/cancel`, {}).catch((e) => toast(e.message));
  jobsEl.prepend(el);
  return el;
}
function updateJobCard(card, job) {
  card.className = `job ${job.status}`;
  const secs = Math.round((job.elapsedMs || 0) / 1000);
  const last = job.log[job.log.length - 1] || '';
  const line = card.querySelector('.jline');
  if (job.status === 'queued') line.textContent = '⏳ 排隊中（同時最多做 2 個）';
  else if (job.status === 'running') line.textContent = `🔧 ${secs}s · ${last}`;
  else if (job.status === 'done') {
    const kind = job.module ? (job.module.type === 'environment' ? '🌍 環境：' : '🌍 規則：') : '';
    line.textContent = `✅ ${kind}${job.part?.name || job.module?.name}（${secs} 秒）`;
  }
  else if (job.status === 'cancelled') line.textContent = '🛑 已取消';
  else if (job.status === 'error') line.textContent = `⚠️ 失敗（${secs} 秒）`;
  const err = card.querySelector('.jerr');
  if (job.status === 'error') {
    err.hidden = false;
    err.textContent = job.error || '';
  }
  const made = job.part || job.module;
  if (job.status === 'done' && made?.thumb && !card.dataset.made) {
    card.dataset.made = '1';
    const t = card.querySelector('.thumb');
    if (t) t.src = `/thumbs/${made.id}.jpg`;
    else addThumb(card, `/thumbs/${made.id}.jpg`);
  }
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    card.querySelector('.jcancel')?.remove();
    if (job.status !== 'done' && !card.querySelector('.jretry')) {
      const retry = document.createElement('button');
      retry.className = 'jretry';
      retry.textContent = '再試一次';
      retry.onclick = () => {
        if (card._photo) setPhoto(card._photo);
        submitPrompt(job.prompt);
      };
      card.appendChild(retry);
    }
  }
}

async function pollJob(ctx) {
  let job = ctx.job;
  let failures = 0;
  for (;;) {
    await sleep(1000);
    try {
      job = await api('GET', `/api/jobs/${job.id}`);
      failures = 0;
    } catch (e) {
      failures += 1;
      if (failures < 6) continue;
      job = { ...job, status: 'error', error: `和伺服器失去聯絡：${e.message}` };
    }
    updateJobCard(ctx.card, job);
    if (job.status === 'done') {
      await finalizeJob(ctx, job);
      break;
    }
    if (job.status === 'error' || job.status === 'cancelled') {
      removeHologram(ctx.holo);
      if (job.status === 'error') toast(`⚠️ 打造失敗：${String(job.error || '').split('\n')[0].slice(0, 120)}`);
      break;
    }
  }
  pendingJobs.delete(ctx.job.id);
  updateStatus();
}

function replaceInstancePart(inst, newPartId) {
  const oldBottom = worldBox(inst).min.y;
  const rec = {
    id: inst.id,
    partId: newPartId,
    position: inst.object.position.toArray(),
    quaternion: inst.object.quaternion.toArray(),
    scale: inst.object.scale.toArray(),
    glue: inst.glue,
  };
  removeInstance(inst.id, { save: false });
  const n = addInstance(rec, { save: false });
  n.object.position.y += oldBottom - worldBox(n).min.y;
  return n;
}

async function finalizeJob(ctx, job) {
  if (job.module) {
    removeHologram(ctx.holo);
    await worlds.add(job.module);
    return;
  }
  const part = job.part;
  if (!runtime.parts.has(part.id)) {
    library.push(part);
    runtime.addPart(part);
  }
  await loadModule(part.id);
  renderLibrary();
  removeHologram(ctx.holo);
  if (ctx.modify) {
    const targets = ctx.selectionIds.map((id) => instances.get(id)).filter((i) => i && i.partId === ctx.basePartId);
    if (targets.length) {
      pushUndo();
      const replaced = targets.map((t) => replaceInstancePart(t, part.id));
      clearSelection();
      for (const r of replaced) addToSelection(r.id);
      scheduleSave();
      toast(`✨ 改造完成：${part.name}`);
      return;
    }
  }
  pushUndo();
  const inst = addInstance(
    { id: newInstanceId(), partId: part.id, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    { save: false },
  );
  placeInstance(inst, job.placement, ctx.anchorId);
  selectOnly(inst.id);
  scheduleSave();
  toast(`✨ ${part.name} 完成了`);
  if (job.warnings?.length) console.info('零件提醒', part.name, job.warnings);
}

// ---------------- 工具箱 ----------------

function renderLibrary() {
  const el = $('#library');
  const visible = library.filter((p) => !p.hidden);
  $('#libCount').textContent = visible.length ? `(${visible.length})` : '';
  updateStatus();
  if (!visible.length) {
    el.innerHTML = '<div class="muted">空的。說出你想要的東西，Codex 會幫你做。</div>';
    return;
  }
  // 同名的（例如改造過的新舊版）加上 #1、#2，照建立順序
  const total = {};
  for (const p of visible) total[p.name] = (total[p.name] || 0) + 1;
  const seen = {};
  const label = new Map();
  for (const p of visible) {
    seen[p.name] = (seen[p.name] || 0) + 1;
    label.set(p.id, total[p.name] > 1 ? `${p.name} #${seen[p.name]}` : p.name);
  }
  el.innerHTML = '';
  for (const p of [...visible].reverse()) {
    const item = document.createElement('div');
    item.className = 'part';
    item.title = `${p.prompt ? `指令：${p.prompt}\n` : ''}點一下放進場景`;
    item.innerHTML =
      '<div class="name"><span class="n"></span><span class="tags"><span class="badge"></span>' +
      '<button class="rm" title="從工具箱移除（場景裡已經放的不受影響）">×</button></span></div><div class="desc"></div>';
    item.querySelector('.n').textContent = label.get(p.id);
    const badge = item.querySelector('.badge');
    badge.textContent = p.kind === 'composite' ? '組合' : 'AI';
    if (p.kind === 'composite') badge.classList.add('combo');
    const size = (p.size || []).map((v) => Number(v).toFixed(2)).join(' × ');
    item.querySelector('.desc').textContent = `${p.description || ''}${size ? `（${size} m）` : ''}`;
    if (p.thumb) addThumb(item, `/thumbs/${p.id}.jpg`);
    item.onclick = () => spawnFromLibrary(p.id);
    item.querySelector('.rm').onclick = async (ev) => {
      ev.stopPropagation();
      if (!window.confirm(`把「${label.get(p.id)}」從工具箱移除？\n場景裡已經放的不會消失。`)) return;
      try {
        await api('POST', `/api/parts/${p.id}/hide`, {});
        p.hidden = true;
        renderLibrary();
      } catch (e) {
        toast(`⚠️ ${e.message}`);
      }
    };
    el.appendChild(item);
  }
}

// 縮圖（伺服器拍的斜角照）；載不到就拿掉，卡片照常顯示文字
function addThumb(card, src) {
  const img = document.createElement('img');
  img.className = 'thumb';
  img.loading = 'lazy';
  img.alt = '';
  img.src = src;
  img.onerror = () => {
    img.remove();
    card.classList.remove('has-thumb');
  };
  card.prepend(img);
  card.classList.add('has-thumb');
}

// 剛存的組合零件：縮圖在伺服器背景拍，拍好了再補上卡片
async function waitForThumb(rec) {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await api('GET', `/api/thumbs/${rec.id}`, null, { cache: 'no-store' }).catch(() => null);
    if (r?.ready) {
      rec.thumb = true;
      renderLibrary();
      return;
    }
  }
}

function spawnFromLibrary(partId) {
  if (!runtime.parts.has(partId)) return;
  closeDrawers();
  pushUndo();
  const inst = addInstance(
    { id: newInstanceId(), partId, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    { save: false },
  );
  const part = runtime.parts.get(partId);
  const anchor = selectedInstances().find((i) => i !== inst);
  if (part.placement === 'around_player') placeInstance(inst, 'around_player');
  else if (part.placement === 'on_selection' && anchor) placeInstance(inst, 'on_selection', anchor.id);
  else placeInstance(inst, 'front');
  selectOnly(inst.id);
  scheduleSave();
}

// ---------------- 語音 ----------------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
if (!SR || !window.isSecureContext) {
  $('#micBtn').hidden = true;
  $('#prompt').placeholder = '打字，或用鍵盤上的 🎙 聽寫…';
}
$('#micBtn').onclick = () => {
  if (recog) {
    recog.stop();
    return;
  }
  recog = new SR();
  recog.lang = 'zh-TW';
  recog.interimResults = true;
  recog.continuous = false;
  let finalText = '';
  recog.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    $('#prompt').value = finalText + interim;
  };
  recog.onerror = (ev) => toast(`語音辨識：${ev.error}`);
  recog.onend = () => {
    $('#micBtn').classList.remove('on');
    recog = null;
    if (finalText.trim()) submitPrompt(finalText);
  };
  recog.start();
  $('#micBtn').classList.add('on');
};

// ---------------- 照片：從相簿挑一張，叫 Codex 照著做 ----------------

let photoData = null; // 縮到 1280 px、重新編碼過的 JPEG（data URL）
let promptHint = null;
const PHOTO_MAX = 1280;
function setPhoto(data) {
  photoData = data;
  const chip = $('#photoChip');
  chip.hidden = !data;
  chip.querySelector('img').src = data || '';
  promptHint ??= $('#prompt').placeholder;
  $('#prompt').placeholder = data ? '要做成什麼？可以不寫，直接按打造' : promptHint;
}
async function loadPhoto(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // 重新畫一次再存成 JPEG：照片裡的拍攝地點、相機資訊不會跟著送出去
    setPhoto(c.toDataURL('image/jpeg', 0.85));
    if (!isTouch) $('#prompt').focus();
  } catch {
    toast('⚠️ 這張照片讀不了，換一張試試');
  } finally {
    URL.revokeObjectURL(url);
  }
}
$('#photoBtn').onclick = () => $('#photoInput').click();
$('#photoInput').onchange = (e) => {
  loadPhoto(e.target.files?.[0]);
  e.target.value = ''; // 同一張再選一次也會觸發
};
$('#photoChip .photo-x').onclick = () => setPhoto(null);

// ---------------- VR ----------------

const vrBtn = $('#vrBtn');
navigator.xr
  ?.isSessionSupported('immersive-vr')
  .then((ok) => {
    if (ok && MODE === 'workshop') vrBtn.hidden = false; // 冒險模式還不支援 VR
  })
  .catch(() => {});
let xrSession = null;
const savedCam = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
vrBtn.onclick = async () => {
  if (xrSession) {
    xrSession.end();
    return;
  }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    savedCam.pos.copy(camera.position);
    savedCam.quat.copy(camera.quaternion);
    const yaw = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
    rig.position.set(camera.position.x, 0, camera.position.z);
    rig.rotation.set(0, yaw, 0);
    await renderer.xr.setSession(session);
    xrSession = session;
    vrBtn.textContent = '離開 VR';
    session.addEventListener('end', () => {
      xrSession = null;
      vrBtn.textContent = '進入 VR';
      rig.position.set(0, 0, 0);
      rig.rotation.set(0, 0, 0);
      camera.position.copy(savedCam.pos);
      camera.quaternion.copy(savedCam.quat);
      controls.update();
    });
  } catch (e) {
    toast(`無法進入 VR：${e.message}`);
  }
};

const controllerFactory = new XRControllerModelFactory();
const tempMatrix = new THREE.Matrix4();
// VR 手把／手（捏）：物理開著時走究極手——東西跟著手把指到的那一點走、跟著手腕轉，放手順著手勢丟出去；
// 物理關著時才把東西掛在手把上（掛上去的話物理引擎會用世界座標去寫它的位置，兩邊打架）
const xrControllers = [];
function onXRSelectStart(e) {
  const ctrl = e.target;
  tempMatrix.identity().extractRotation(ctrl.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  const hit = pickFromRaycaster();
  if (!hit) return;
  pushUndo();
  selectOnly(hit.inst.id);
  if (phys.ready) {
    for (const c of xrControllers) c.userData.grab = null; // 一次只能抓一個（另一隻手放開）
    if (!phys.grab(hit.inst, hit.point)) return;
    ctrl.userData.grab = {
      inst: hit.inst,
      local: ctrl.worldToLocal(hit.point.clone()),
      ctrlQ0: ctrl.getWorldQuaternion(new THREE.Quaternion()),
      objQ0: phys.holdQuaternion,
    };
    return;
  }
  ctrl.attach(hit.inst.object);
  ctrl.userData.held = hit.inst;
}
function updateXRGrabs() {
  for (const ctrl of xrControllers) {
    const g = ctrl.userData.grab;
    if (!g) continue;
    if (!phys.holding) {
      ctrl.userData.grab = null; // 被別的東西接手了（例如抓著時關掉物理）
      continue;
    }
    phys.moveHold(ctrl.localToWorld(g.local.clone()));
    const turn = ctrl.getWorldQuaternion(new THREE.Quaternion()).multiply(g.ctrlQ0.clone().invert());
    phys.setHoldQuaternion(turn.multiply(g.objQ0));
  }
}
function onXRSelectEnd(e) {
  const ctrl = e.target;
  if (ctrl.userData.grab) {
    ctrl.userData.grab = null;
    phys.release();
    scheduleSave();
    return;
  }
  const inst = ctrl.userData.held;
  if (!inst) return;
  world.attach(inst.object);
  ctrl.userData.held = null;
  const yaw = new THREE.Euler().setFromQuaternion(inst.object.quaternion, 'YXZ').y;
  inst.object.rotation.set(0, yaw, 0); // 放手時擺正，再落到下方的支撐面
  dropToSupport(inst);
  scheduleSave();
}
for (let i = 0; i < 2; i += 1) {
  const ctrl = renderer.xr.getController(i);
  const ray = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x38e1ff }),
  );
  ray.scale.z = 4;
  ctrl.add(ray);
  ctrl.addEventListener('selectstart', onXRSelectStart);
  ctrl.addEventListener('selectend', onXRSelectEnd);
  xrControllers.push(ctrl);
  rig.add(ctrl);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerFactory.createControllerModel(grip));
  rig.add(grip);
}

// ---------------- 操作模式（開車／飛行／穿戴） ----------------

let controlTarget = null; // 等使用者在選單選模式的物件

function openControl(mode) {
  if (renderer.xr.isPresenting) return toast('VR 裡還不能用操作模式');
  const groups = engine.active ? [[engine.session.inst]] : clustersOf(selectedInstances());
  if (groups.length !== 1) return toast('先選一個物件，再按「▶ 操作」');
  const inst = groups[0][0];
  // 黏了風扇、輪子、火箭的東西：用駕駛模式（物理推動，搖桿轉向）
  if (phys.ready && (mode === 'pilot' || (!mode && phys.hasDevices(inst)))) return startControl(inst, 'pilot');
  if (inst.glue && (mode === 'wear' || (!mode && guessMode(runtime.parts.get(inst.partId)) === 'wear'))) {
    return toast('黏在一起的東西不能戴，先按「拆開」');
  }
  const chosen = mode || guessMode(runtime.parts.get(inst.partId));
  if (chosen) return startControl(inst, chosen);
  controlTarget = inst;
  $('#ctlChooser').hidden = false;
}

function startControl(inst, mode, { remember = false } = {}) {
  const part = runtime.parts.get(inst.partId);
  if (engine.active) stopControl();
  pushUndo();
  closeDrawers();
  clearSelection();
  $('#prompt').blur();
  engine.start(inst, mode, part);
  document.body.classList.add('controlling');
  $('#ctlHud').hidden = false;
  const n = glueMembers(inst).length;
  $('#ctlLabel').textContent = `${MODES[mode]}：${partName(inst.partId)}${n > 1 ? ` 等 ${n} 件` : ''}`;
  $('#btnUp').hidden = mode !== 'fly';
  $('#btnDown').hidden = mode !== 'fly';
  $('#btnSpin').hidden = mode !== 'wear';
  $('#ctlSwitch').hidden = mode === 'pilot';
  const hint = $('#ctlHint');
  hint.classList.remove('fade');
  clearTimeout(startControl.hintTimer);
  startControl.hintTimer = setTimeout(() => hint.classList.add('fade'), 5000);
  hint.textContent = {
    drive: isTouch ? '左下搖桿：往上是油門、往下倒車、左右轉彎' : 'W／S 油門倒車、A／D 轉彎、空白鍵動作、Esc 離開',
    fly: isTouch ? '搖桿控制方向，▲▼ 升降' : 'WASD 方向、E 升 Q 降、空白鍵動作、Esc 離開',
    wear: isTouch ? '搖桿走路，拖曳畫面看四周，⚡ 是動作' : 'WASD 走路、拖曳看四周、空白鍵動作、Esc 離開',
    pilot: isTouch
      ? '搖桿往上＝裝置出力、左右轉向；⚡ 開關裝置（火箭、彈簧按一下就發動）'
      : 'W／S 出力倒退、A／D 轉向；空白鍵開關裝置（火箭、彈簧按一下就發動）；Esc 離開',
  }[mode];
  // 使用者自己選的模式記在零件上，下次按「操作」就直接用
  if (remember && part && part.controls !== mode) {
    api('POST', `/api/parts/${part.id}/controls`, { controls: mode })
      .then(() => (part.controls = mode))
      .catch(() => {});
  }
}

function stopControl() {
  if (!engine.active) return;
  const inst = engine.session.inst;
  engine.stop();
  joyReset();
  document.body.classList.remove('controlling');
  $('#ctlHud').hidden = true;
  if (instances.has(inst.id)) selectOnly(inst.id);
  scheduleSave();
}

// 搖桿：手指在圓盤裡拖曳 → x（左右）、y（往上為正）
const joy = $('#joy');
const knob = $('#joyKnob');
let joyId = null;
function joyMove(e) {
  const r = joy.getBoundingClientRect();
  let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    dx /= len;
    dy /= len;
  }
  engine.input.x = dx;
  engine.input.y = -dy;
  knob.style.transform = `translate(${dx * r.width * 0.32}px, ${dy * r.height * 0.32}px)`;
}
function joyReset() {
  joyId = null;
  engine.input.x = 0;
  engine.input.y = 0;
  knob.style.transform = '';
}
joy.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  joyId = e.pointerId;
  joy.setPointerCapture(e.pointerId);
  joyMove(e);
});
joy.addEventListener('pointermove', (e) => {
  if (e.pointerId === joyId) joyMove(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  joy.addEventListener(type, (e) => {
    if (e.pointerId === joyId) joyReset();
  });
}

// 按住才有作用的按鈕（升、降、動作）
function holdButton(el, down, up) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('on');
    down();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    el.addEventListener(type, () => {
      el.classList.remove('on');
      up();
    });
  }
}
holdButton($('#btnUp'), () => (engine.input.lift = 1), () => (engine.input.lift = 0));
holdButton($('#btnDown'), () => (engine.input.lift = -1), () => (engine.input.lift = 0));
holdButton($('#btnAction'), () => engine.pressAction(true), () => engine.pressAction(false));
$('#btnSpin').onclick = () => engine.spinWorn(Math.PI / 6);
$('#ctlExit').onclick = () => stopControl();
$('#ctlSwitch').onclick = () => {
  controlTarget = engine.session?.inst || null;
  $('#ctlChooser').hidden = false;
};
document.querySelectorAll('#ctlChooser [data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    $('#ctlChooser').hidden = true;
    if (controlTarget && instances.has(controlTarget.id)) startControl(controlTarget, b.dataset.mode, { remember: true });
    controlTarget = null;
  }),
);
$('#ctlCancel').onclick = () => {
  $('#ctlChooser').hidden = true;
  controlTarget = null;
};

// 電腦鍵盤：WASD／方向鍵、空白鍵動作、E 升 Q 降、Esc 離開
const heldKeys = new Set();
function controlKey(e, down) {
  const k = e.key.toLowerCase();
  if (down && k === 'escape') {
    stopControl();
    return;
  }
  const map = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right', e: 'rise', q: 'sink', ' ': 'action' };
  const name = map[k];
  if (!name) return;
  e.preventDefault();
  if (down) heldKeys.add(name);
  else heldKeys.delete(name);
  if (name === 'action') engine.pressAction(down);
  if (joyId !== null) return; // 正在用搖桿就不蓋掉
  engine.input.x = (heldKeys.has('right') ? 1 : 0) - (heldKeys.has('left') ? 1 : 0);
  engine.input.y = (heldKeys.has('up') ? 1 : 0) - (heldKeys.has('down') ? 1 : 0);
  engine.input.lift = (heldKeys.has('rise') ? 1 : 0) - (heldKeys.has('sink') ? 1 : 0);
}
window.addEventListener('keyup', (e) => {
  if (engine.active) controlKey(e, false);
});

// ---------------- 介面事件 ----------------

window.addEventListener('keydown', (e) => {
  if (engine.active) {
    controlKey(e, true);
    return;
  }
  // 冒險模式不用工坊的快捷鍵（刪除、複製、存成零件…），Esc 是暫停選單
  if (MODE !== 'workshop') {
    if (e.key === 'Escape') adventure?.onEscape();
    return;
  }
  if (e.target.closest?.('input, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (drag?.physics && drag.started) {
    const right = new THREE.Vector3().crossVectors(forwardFlat(), UP).normalize();
    if (k === 'q') phys.rotateHold(UP, Math.PI / 4);
    else if (k === 'e') phys.rotateHold(UP, -Math.PI / 4);
    else if (k === 'r') phys.rotateHold(right, Math.PI / 2);
    else if (k === 'g' || k === ' ') glueHeld();
    else if (k === 'arrowup' || k === 'arrowdown') {
      drag.lift += k === 'arrowup' ? 0.15 : -0.15;
      updateHoldTarget();
    } else return;
    e.preventDefault();
    return;
  }
  if (mod && k === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (mod && k === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if (k === 'q') rotateSelected(1);
  else if (k === 'e') rotateSelected(-1);
  else if (k === 'r') scaleSelected(1.1);
  else if (k === 'f') scaleSelected(1 / 1.1);
  else if (k === 'g') groupSelected();
  else if (k === 't') recallSelected();
  else if (k === 'l') glueSelected();
  else if (k === ' ' && selection.size) {
    e.preventDefault();
    powerSelected();
  } else if (e.key === 'Escape') clearSelection();
  else if (e.key === '/') {
    e.preventDefault();
    $('#prompt').focus();
  }
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submitPrompt(e.target.value);
  }
});
$('#sendBtn').onclick = () => submitPrompt($('#prompt').value);
const WORKSHOP_ACTIONS = {
  group: () => groupSelected(),
  ungroup: ungroupSelected,
  dup: () => duplicateSelected(),
  rotL: () => rotateSelected(1),
  rotR: () => rotateSelected(-1),
  bigger: () => scaleSelected(1.1),
  smaller: () => scaleSelected(1 / 1.1),
  del: deleteSelected,
  undo,
  control: () => openControl(),
  glue: glueSelected,
  recall: recallSelected,
  power: powerSelected,
  multi: () => {
    multiMode = !multiMode;
    document.querySelectorAll('[data-act=multi]').forEach((b) => b.classList.toggle('on', multiMode));
    updateSelectionUI();
    toast(multiMode ? '多選：點物件加入或移出選取，選好按「存成零件」' : '已關閉多選');
  },
};
const ACTIONS = MODE === 'workshop' ? WORKSHOP_ACTIONS : {}; // 冒險模式的按鈕藏起來了；就算按到也不做事
document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => ACTIONS[b.dataset.act]?.()));
const leftPanel = $('.panel.left');
const rightPanel = $('.panel.right');
function closeDrawers() {
  leftPanel.classList.remove('open');
  rightPanel.classList.remove('open');
}
$('#libToggle').onclick = () => {
  rightPanel.classList.toggle('open');
  leftPanel.classList.remove('open');
};
$('#selToggle').onclick = () => {
  leftPanel.classList.toggle('open');
  rightPanel.classList.remove('open');
};
document.querySelectorAll('.panel.right [data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.panel.right [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('#tab-parts').hidden = b.dataset.tab !== 'parts';
    $('#tab-world').hidden = b.dataset.tab !== 'world';
  }),
);
holdButton($('#holdUp'), () => (holdLiftDir = 1), () => (holdLiftDir = 0));
holdButton($('#holdDown'), () => (holdLiftDir = -1), () => (holdLiftDir = 0));
// 另一隻手指還按著畫面時，瀏覽器不一定會送 click：究極手的按鈕一按下就生效
function pressButton(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (el.disabled) return;
    el.classList.add('on');
    fn();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, () => el.classList.remove('on'));
}
pressButton($('#holdRotL'), () => phys.rotateHold(UP, Math.PI / 4));
pressButton($('#holdRotR'), () => phys.rotateHold(UP, -Math.PI / 4));
pressButton($('#holdFlip'), () => phys.rotateHold(new THREE.Vector3().crossVectors(forwardFlat(), UP).normalize(), Math.PI / 2));
pressButton($('#holdGlue'), () => glueHeld());
$('#physBtn').onclick = () => setPhysics(!physicsOn);
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (!drag?.physics || !drag.started) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    drag.lift += -Math.sign(e.deltaY) * 0.12;
    updateHoldTarget();
  },
  { passive: false, capture: true },
);
$('#helpBtn').onclick = () => ($('#help').hidden = false);
$('#helpClose').onclick = () => ($('#help').hidden = true);
function fitCamera() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = camera.aspect < 0.75 ? 82 : 60; // 手機直拿畫面窄，視角放寬才看得到兩側
  camera.updateProjectionMatrix();
}
fitCamera();
window.addEventListener('resize', () => {
  fitCamera();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------- 主迴圈 ----------------

let lastT = now();
let lastWorldSave = 0;
renderer.setAnimationLoop(() => {
  const t = now();
  const dt = Math.min(t - lastT, 0.1);
  lastT = t;
  camera.getWorldPosition(player.position);
  for (const inst of instances.values()) {
    if (!inst.updaters.length) continue;
    const lt = t - inst.bornAt;
    for (const u of inst.updaters) {
      if (u.dead) continue;
      try {
        u.fn.call(u.obj, dt, lt);
      } catch (err) {
        u.dead = true;
        console.error(err);
        toast(`⚠️ ${partName(inst.partId)} 的動作出錯，已停止它的動畫`);
      }
    }
  }
  engine.update(dt);
  adventure?.update(dt, t); // 在物理之前：吸附、救援搬動的東西這一格就讓物理跟過去
  if (titleScene) {
    titleScene.update(dt, t);
    const a = t * 0.12;
    camera.position.set(Math.sin(a) * 6.2, 2.4, Math.cos(a) * 6.2);
    controls.target.set(0, 0.6, 0);
  }
  worlds.update(dt, t);
  if (renderer.xr.isPresenting) updateXRGrabs();
  if (holdLiftDir && drag?.physics && drag.started) {
    drag.lift += holdLiftDir * 1.5 * dt;
    updateHoldTarget();
  }
  if (phys.enabled) {
    phys.update(dt);
    refreshHoldHud();
  }
  if (worlds.hasRules && t - lastWorldSave > 5) {
    lastWorldSave = t;
    scheduleSave();
  }
  for (const h of selHelpers.values()) h.update();
  animateHolograms(t);
  pad.material.opacity = 0.4 + 0.15 * Math.sin(t * 1.5);
  if (!renderer.xr.isPresenting && !engine.ownsCamera) controls.update();
  renderer.render(scene, camera);
});

// ---------------- 啟動 ----------------

// 冒險和首頁只載入用得到的內建零件（組合零件的子零件也要）
async function loadPartsFor(ids) {
  const need = new Set();
  const visit = (id) => {
    const p = runtime.parts.get(id);
    if (!p || need.has(id)) return;
    need.add(id);
    for (const c of p.children || []) visit(c.partId);
  };
  ids.forEach(visit);
  await Promise.all([...need].filter((id) => partKind(id) === 'generated').map((id) => loadModule(id)));
}

const goTo = async (url) => {
  await saveNow();
  window.location.href = url;
};

// 首頁：開始／繼續冒險、自由工坊（背景是小紅和能量塔在轉，不載入任何存檔、不寫任何東西）
async function initTitle() {
  $('#title').hidden = false;
  envAdapter.pad(false);
  try {
    const [state, adv] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/adventure')]);
    library = state.library.parts || [];
    runtime.setLibrary(library);
    await loadPartsFor([...ADVENTURE_PARTS, 'c_mvfwneiy081798']);
    titleScene = buildTitleScene({ THREE, scene, runtime });
    const p = adv.adventure?.progress;
    const names = ['點亮能量塔', '組裝探險車', '開到信號塔'];
    if (p && p.level <= 3 && !(p.level === 1 && p.step === 'intro')) {
      $('#titlePlay').textContent = `▶ 繼續冒險（第 ${p.level} 關：${names[p.level - 1]}）`;
      $('#titleRestart').hidden = false;
    } else if (p && p.level > 3) {
      $('#titlePlay').textContent = '▶ 再玩一次冒險';
      const best = p.best;
      if (best) {
        $('#titleSave').hidden = false;
        $('#titleSave').textContent = `🏆 已通關 ${p.clears} 次 · 最佳 ${'★'.repeat(best.stars)} ${Math.floor(best.total / 60)}:${String(Math.round(best.total) % 60).padStart(2, '0')}`;
      }
    }
    if (p && p.level > 3) $('#titlePlay').dataset.fresh = '1';
  } catch (e) {
    $('#titleSave').hidden = false;
    $('#titleSave').textContent = `連不到工坊伺服器：${e.message}`;
  }
}
$('#titlePlay').onclick = () => (window.location.href = $('#titlePlay').dataset.fresh ? '/?play&new' : '/?play');
$('#titleRestart').onclick = () => (window.location.href = '/?play&new');
$('#titleFree').onclick = () => (window.location.href = '/?ws');

// 冒險：只用內建零件，進度和場景存在 adventure.json；物理一定開著，世界模組一律不載入
async function initPlay() {
  $('#status').textContent = '冒險載入中…';
  envAdapter.pad(false);
  try {
    const [state, adv] = await Promise.all([api('GET', '/api/state'), api('GET', '/api/adventure')]);
    library = state.library.parts || [];
    runtime.setLibrary(library);
    await loadPartsFor(ADVENTURE_PARTS);
    const fresh = params.has('new');
    if (fresh) window.history.replaceState(null, '', '/?play'); // 重新整理時不要又從頭開始
    const saved = fresh ? null : adv.adventure;
    for (const rec of saved?.instances || []) if (runtime.parts.has(rec.partId)) addInstance(rec, { save: false });
    adventure = createAdventure({
      THREE,
      scene,
      camera,
      controls,
      renderer,
      runtime,
      instances,
      phys,
      engine,
      isTouch,
      addInstance,
      removeInstance,
      worldBox,
      glueTogether,
      glueMembers,
      newInstanceId,
      startControl,
      stopControl,
      saveNow,
      toast: (m, ms) => toast(m, ms),
      goTo,
    });
    physicsOn = true;
    renderPhysBtn();
    if (!(await setPhysics(true, { persist: false, quiet: true, wake: false }))) throw new Error('物理引擎載入失敗，請重新整理');
    loaded = true;
    await adventure.init(fresh ? { progress: adv.adventure?.progress || null, fresh: true } : saved, { fresh });
    if (!localStorage.getItem('vw_help_seen')) localStorage.setItem('vw_help_seen', '1'); // 之後進工坊不用再跳說明
  } catch (e) {
    console.error(e);
    $('#advHud').hidden = false;
    $('#advTitle').textContent = '冒險載入失敗';
    $('#advText').textContent = e.message;
  }
}

async function init() {
  camera.getWorldPosition(player.position);
  if (MODE === 'title') return initTitle();
  if (MODE === 'play') return initPlay();
  try {
    const state = await api('GET', '/api/state');
    library = state.library.parts || [];
    runtime.setLibrary(library);
    await Promise.all(library.filter((p) => p.kind === 'generated').map((p) => loadModule(p.id)));
    for (const rec of state.scene.instances || []) if (runtime.parts.has(rec.partId)) addInstance(rec, { save: false });
    loaded = true;
    physicsOn = urlPhysics !== null ? urlPhysics === '1' : state.scene.physics !== false;
    renderPhysBtn();
    // 重新打開頁面時東西先「睡著」：保留原本的擺法，碰到才開始受物理影響
    if (physicsOn) setPhysics(true, { persist: false, quiet: true, wake: false });
    await worlds.init(state.worlds?.modules || [], state.worldState || {});
    renderLibrary();
    updateSelectionUI();
    updateStatus();
    if (!localStorage.getItem('vw_help_seen')) {
      $('#help').hidden = false;
      localStorage.setItem('vw_help_seen', '1');
    }
  } catch (e) {
    $('#status').textContent = `連不到工坊伺服器：${e.message}`;
  }
}
init();

// 給自動測試用
window.__ws = {
  THREE,
  renderer,
  scene,
  camera,
  controls,
  instances,
  selection,
  runtime,
  get library() {
    return library;
  },
  get loaded() {
    return loaded;
  },
  submitPrompt,
  groupSelected,
  ungroupSelected,
  undo,
  snapshot,
  selectOnly,
  addToSelection,
  clearSelection,
  spawnFromLibrary,
  worldBox,
  addThumb,
  engine,
  worlds,
  envAdapter,
  openControl,
  startControl,
  stopControl,
  physics: phys,
  setPhysics,
  saveNow,
  get physicsOn() {
    return physicsOn;
  },
  glueSelected,
  recallSelected,
  powerSelected,
  glueMembers,
  get holding() {
    return phys.holding;
  },
  mode: MODE,
  // 冒險模式的狀態（只讀；自動測試用來找東西在哪，不提供跳關）
  get adventure() {
    return adventure ? adventure.state() : null;
  },
  screenOf(id, where = 'center') {
    const b = worldBox(instances.get(id));
    const p = b.getCenter(new THREE.Vector3());
    if (where === 'top') p.y = b.max.y - 0.01;
    p.project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  },
  // 世界座標 → 螢幕座標（測試用來找「要拖到哪裡」）
  screenAt(x, y, z) {
    const p = new THREE.Vector3(x, y, z).project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height, behind: p.z > 1 };
  },
};
