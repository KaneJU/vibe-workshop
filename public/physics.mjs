// 物理引擎（借鏡《薩爾達傳說：王國之淚》）
// - 真的剛體：東西會掉、會倒、會滾、會被撞開（Rapier，WebAssembly，iPhone 上也跑得動）
// - 究極手：抓起來（離地飄著）、拖著走、轉 45°、翻面，放手可以丟出去；靠近別的東西按 🔗 黏上；抓著搖一搖拆下來
// - 黏合：黏在一起的東西是同一個剛體；存成零件再拿出來也照樣能動（像王國之淚的建造藍圖）
// - 左納烏式裝置：風扇、火箭、氣球、輪子、彈簧、操縱桿（零件在 meta.json 宣告 device）
// - 時光倒轉：選一個東西按 ⏪，它沿著剛才的路線倒退回去
//
// 形狀與裝置規格（PHYS、DEVICE_KINDS、collectPieces、hullDesc…）瀏覽器和 Node 驗收共用；
// createPhysics() 是瀏覽器裡的引擎本體，不碰 DOM。

export const PHYS = {
  gravity: -9.81,
  density: 150, // kg/m³（輕木頭）：沒寫 mass 的零件用碰撞形狀的體積推算
  friction: 0.7,
  bounce: 0.05,
  linearDamping: 0.15,
  poweredDamping: 0.8, // 裝置出力中（風扇、火箭）或掛著氣球：空氣阻力大一點，速度才不會一直加上去
  angularDamping: 0.35,
  balloonRise: 3, // 氣球最快每秒升 3 公尺
  hz: 60,
  maxSubsteps: 6,
  maxPointsPerPiece: 400,
  maxPieces: 24, // 一個零件最多拆成幾塊碰撞形狀（太多就合成一塊）
  maxDevices: 16,
  settleSeconds: 1.2, // 剛出現或被瞬移的東西，這段時間內速度有上限（卡在一起時才不會炸開）
  settleSpeed: 6,
  maxSpeed: 60,
  holdLift: 0.2, // 究極手抓起來時先離地這麼高
  holdMaxSpeed: 14,
  throwMax: 14,
  glueReach: 0.12, // 兩個東西相距這麼近才能黏
  balloonCeiling: 12, // 氣球升到這個高度就不再往上
  thrustCeiling: 40,
  bounds: { radius: 150, minY: -30, maxY: 200 },
  recallSeconds: 10,
  recallHz: 15,
};

// 裝置：force 的單位是牛頓（彈簧是牛頓秒的衝量）；dir 是「把整台東西往哪推」（零件自己的座標）
export const DEVICE_KINDS = {
  fan: { label: '風扇', force: 250, mass: 8, dir: [0, 0, 1] },
  rocket: { label: '火箭', force: 1200, mass: 10, dir: [0, 0, 1], burst: 2.2, cooldown: 1.2 },
  balloon: { label: '氣球', force: 400, mass: 1, dir: [0, 1, 0] },
  wheel: { label: '輪子', force: 400, mass: 6, speed: 5 },
  spring: { label: '彈簧', force: 250, mass: 3, dir: [0, 1, 0] },
  steer: { label: '操縱桿', force: 0, mass: 5 },
};
export const DEVICE_FORCE_RANGE = {
  fan: [20, 4000],
  rocket: [100, 12000],
  balloon: [10, 4000],
  wheel: [50, 5000],
  spring: [20, 3000],
  steer: [0, 0],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// 輪子彼此不碰撞（並排黏很多顆、或兩台車的輪子擦過時才不會互相卡死）；輪子照樣碰地面和其他東西
const WHEEL_GROUPS = (0x0002 << 16) | (0xffff & ~0x0002);

export function normalizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  const kind = String(d.kind || '').toLowerCase();
  const spec = DEVICE_KINDS[kind];
  if (!spec) return null;
  const out = { kind };
  if (kind !== 'steer') out.force = clamp(Number.isFinite(d.force) ? d.force : spec.force, ...DEVICE_FORCE_RANGE[kind]);
  if (kind === 'wheel') out.speed = clamp(Number.isFinite(d.speed) ? d.speed : spec.speed, 0.5, 30);
  const v = d.direction;
  if (spec.dir && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) && Math.hypot(...v) > 0.01) {
    const n = Math.hypot(...v);
    out.direction = v.map((x) => x / n);
  }
  return out;
}

export function normalizePhysics(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  if (Number.isFinite(p.mass)) out.mass = clamp(p.mass, 0.1, 20000);
  if (Number.isFinite(p.friction)) out.friction = clamp(p.friction, 0, 2);
  if (Number.isFinite(p.bounce)) out.bounce = clamp(p.bounce, 0, 1);
  if (p.fixed === true) out.fixed = true;
  return Object.keys(out).length ? out : null;
}

// 只是特效的 mesh（光暈、光束、全息投影、粒子）不擋東西
function isGhost(THREE, mat) {
  const list = Array.isArray(mat) ? mat : [mat];
  return list.every((m) => {
    if (!m || m.visible === false) return true;
    const op = Number.isFinite(m.opacity) ? m.opacity : 1;
    if (m.blending === THREE.AdditiveBlending) return true;
    if (m.transparent && op < 0.5) return true;
    if (m.transparent && m.depthWrite === false && op < 0.8) return true;
    return false;
  });
}

// 把零件拆成碰撞形狀：自己的 mesh 一塊、每個 ctx.spawn／組合進來的子零件各一塊（裝置整塊不再拆）。
// 點雲用零件自己的座標（還沒乘上縮放），每塊最多 PHYS.maxPointsPerPiece 點，外加每個 mesh 在 xyz 六個方向的極值點，
// 圓的東西才會是圓的（會滾）。deviceOf(partId) 回傳該零件的裝置規格或 null。
export function collectPieces(THREE, root, { deviceOf = () => null } = {}) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const main = { node: root, partId: root.userData?.partId ?? null, device: deviceOf(root.userData?.partId), meshes: [] };
  const pieces = [main];
  const visit = (o, piece, ghost) => {
    for (const c of o.children) {
      const g = ghost || c.visible === false || c.userData?.noCollide === true;
      let p = piece;
      if (c.userData?.partId != null && !piece.device) {
        p = { node: c, partId: c.userData.partId, device: deviceOf(c.userData.partId), meshes: [] };
        pieces.push(p);
      }
      if (c.isMesh && !g && c.geometry?.attributes?.position && !isGhost(THREE, c.material)) p.meshes.push(c);
      visit(c, p, g);
    }
  };
  visit(root, main, root.userData?.noCollide === true);

  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const im = new THREE.Matrix4();
  const out = [];
  for (const piece of pieces) {
    if (!piece.meshes.length) continue;
    let total = 0;
    for (const mesh of piece.meshes) total += mesh.isInstancedMesh ? 8 * Math.min(mesh.count, 48) : mesh.geometry.attributes.position.count;
    const pts = [];
    for (const mesh of piece.meshes) {
      m.multiplyMatrices(inv, mesh.matrixWorld);
      const pos = mesh.geometry.attributes.position;
      if (mesh.isInstancedMesh) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox;
        const step = Math.max(1, Math.ceil(mesh.count / 48));
        for (let i = 0; i < mesh.count; i += step) {
          mesh.getMatrixAt(i, im);
          im.premultiply(m);
          for (let k = 0; k < 8; k += 1) {
            v.set(k & 1 ? bb.max.x : bb.min.x, k & 2 ? bb.max.y : bb.min.y, k & 4 ? bb.max.z : bb.min.z).applyMatrix4(im);
            pts.push(v.x, v.y, v.z);
          }
        }
        continue;
      }
      const n = pos.count;
      const take = Math.max(8, Math.round((PHYS.maxPointsPerPiece * n) / Math.max(total, 1)));
      const stride = Math.max(1, Math.floor(n / take));
      const ext = [0, 0, 0, 0, 0, 0];
      const extV = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
      for (let i = 0; i < n; i += 1) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        if (x < extV[0]) (extV[0] = x), (ext[0] = i);
        if (x > extV[1]) (extV[1] = x), (ext[1] = i);
        if (y < extV[2]) (extV[2] = y), (ext[2] = i);
        if (y > extV[3]) (extV[3] = y), (ext[3] = i);
        if (z < extV[4]) (extV[4] = z), (ext[4] = i);
        if (z > extV[5]) (extV[5] = z), (ext[5] = i);
        if (i % stride === 0) {
          v.set(x, y, z).applyMatrix4(m);
          pts.push(v.x, v.y, v.z);
        }
      }
      for (const i of ext) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        pts.push(v.x, v.y, v.z);
      }
    }
    const points = new Float32Array(pts);
    if (points.length < 12 || !points.every(Number.isFinite)) continue;
    const box = new THREE.Box3();
    for (let i = 0; i < points.length; i += 3) box.expandByPoint(v.set(points[i], points[i + 1], points[i + 2]));
    out.push({
      node: piece.node,
      partId: piece.partId,
      device: piece.device || null,
      points,
      center: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()),
      nodeMatrix: new THREE.Matrix4().multiplyMatrices(inv, piece.node.matrixWorld),
    });
  }
  // 太多塊：不是裝置的合成一塊（只留外形），裝置保留
  if (out.length > PHYS.maxPieces) {
    const keep = out.filter((p) => p.device).slice(0, PHYS.maxDevices);
    const rest = out.filter((p) => !keep.includes(p));
    if (rest.length) {
      const all = [];
      const stride = Math.max(1, Math.ceil(rest.reduce((n, p) => n + p.points.length / 3, 0) / (PHYS.maxPointsPerPiece * 2)));
      let k = 0;
      for (const p of rest) {
        for (let i = 0; i < p.points.length; i += 3, k += 1) if (k % stride === 0) all.push(p.points[i], p.points[i + 1], p.points[i + 2]);
      }
      const points = new Float32Array(all);
      const box = new THREE.Box3();
      for (let i = 0; i < points.length; i += 3) box.expandByPoint(v.set(points[i], points[i + 1], points[i + 2]));
      keep.unshift({
        node: root,
        partId: root.userData?.partId ?? null,
        device: null,
        points,
        center: box.getCenter(new THREE.Vector3()),
        size: box.getSize(new THREE.Vector3()),
        nodeMatrix: new THREE.Matrix4(),
      });
    }
    return keep;
  }
  return out;
}

export function transformPoints(src, matrix) {
  const e = matrix.elements;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

// 凸包碰撞形狀；點雲扁平（例如一片平面）算不出凸包時退回外框盒子，最薄 1 公分
export function hullDesc(RAPIER, points) {
  let d = null;
  try {
    d = RAPIER.ColliderDesc.convexHull(points);
  } catch {
    d = null;
  }
  if (d) return d;
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    x0 = Math.min(x0, points[i]);
    x1 = Math.max(x1, points[i]);
    y0 = Math.min(y0, points[i + 1]);
    y1 = Math.max(y1, points[i + 1]);
    z0 = Math.min(z0, points[i + 2]);
    z1 = Math.max(z1, points[i + 2]);
  }
  return RAPIER.ColliderDesc.cuboid(Math.max((x1 - x0) / 2, 0.005), Math.max((y1 - y0) / 2, 0.005), Math.max((z1 - z0) / 2, 0.005)).setTranslation(
    (x0 + x1) / 2,
    (y0 + y1) / 2,
    (z0 + z1) / 2,
  );
}

// ---------------- 瀏覽器裡的引擎 ----------------

export function createPhysics({
  THREE,
  loadRapier,
  instances, // () => Map(id -> inst)
  partOf, // (partId) => part record
  boxOf, // (inst) => world Box3
  nameOf, // (inst) => 名稱
  controlled, // () => 正在被開／戴的 inst（引擎直接移動它），或 null
  fxRoot,
  camera,
  respawnAt, // () => Vector3：飛太遠時拉回的位置
  onSettled, // 動完、全部睡著 → 存檔
  onMoving, // 一直在動時每 5 秒 → 存檔
  toast,
  now,
}) {
  let R = null;
  let rapierPromise = null;
  let world = null;
  let enabled = false;
  let firstSync = true;
  let acc = 0;
  let simTime = 0;
  let stepMs = 0;
  const bodies = new Map(); // key -> rec
  const byInst = new Map(); // inst.id -> rec
  const byCollider = new Map(); // collider handle -> rec
  const moduleOverrides = new Map(); // 世界模組 id -> { gravity, friction, bounce }
  const pinned = new Set(); // 釘住的物件 id（冒險模式的組裝台）：連同黏著的整組先固定不動，裝零件時車身才不會被推走、倒下
  const braked = new Set(); // 自動煞車的物件 id（冒險模式的車）：輪子沒出力時煞住
  let hold = null;
  let wasMoving = false;
  let lastMovingSave = 0;
  const brokenHooks = new WeakSet();

  const UP = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);
  const IDENTITY = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _m2 = new THREE.Matrix4();

  const partPhys = (partId) => normalizePhysics(partOf(partId)?.physics) || {};
  const deviceOf = (partId) => (partId == null ? null : normalizeDevice(partOf(partId)?.device));
  const piecesOf = (inst) => (inst.physPieces ??= collectPieces(THREE, inst.object, { deviceOf }));
  const keyOf = (inst) => (inst.glue ? `g:${inst.glue}` : `i:${inst.id}`);

  function globals() {
    let gravity = PHYS.gravity;
    let friction = null;
    let bounce = null;
    for (const o of moduleOverrides.values()) {
      if (Number.isFinite(o.gravity)) gravity = o.gravity;
      if (Number.isFinite(o.friction)) friction = o.friction;
      if (Number.isFinite(o.bounce)) bounce = o.bounce;
    }
    return { gravity, friction, bounce };
  }
  function applyGlobals() {
    if (!world) return;
    const g = globals();
    world.gravity = { x: 0, y: g.gravity, z: 0 };
    for (const rec of bodies.values()) {
      for (const c of rec.colliders) {
        c.setFriction(g.friction ?? c.userData_friction);
        c.setRestitution(g.bounce ?? c.userData_bounce);
      }
      rec.body.wakeUp();
    }
  }

  // ---- 物件 → 剛體 ----

  function capture(inst) {
    const o = inst.object;
    return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
  }
  function changed(inst, last) {
    const o = inst.object;
    return (
      Math.abs(o.position.x - last.p.x) > 1e-6 ||
      Math.abs(o.position.y - last.p.y) > 1e-6 ||
      Math.abs(o.position.z - last.p.z) > 1e-6 ||
      Math.abs(o.quaternion.x - last.q.x) > 1e-7 ||
      Math.abs(o.quaternion.y - last.q.y) > 1e-7 ||
      Math.abs(o.quaternion.z - last.q.z) > 1e-7 ||
      Math.abs(o.quaternion.w - last.q.w) > 1e-7 ||
      Math.abs(o.scale.x - last.s.x) > 1e-9 ||
      Math.abs(o.scale.y - last.s.y) > 1e-9 ||
      Math.abs(o.scale.z - last.s.z) > 1e-9
    );
  }
  function scaleChanged(inst, last) {
    const s = inst.object.scale;
    return Math.abs(s.x - last.s.x) > 1e-9 || Math.abs(s.y - last.s.y) > 1e-9 || Math.abs(s.z - last.s.z) > 1e-9;
  }
  const bodyMatrix = (body, target = new THREE.Matrix4()) => {
    const t = body.translation();
    const r = body.rotation();
    return target.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), ONE);
  };

  function create(key, list, { asleep = false } = {}) {
    const anchor = list[0];
    for (const inst of list) inst.object.updateMatrixWorld(true);
    anchor.object.matrixWorld.decompose(_p, _q, _s);
    const P = _p.clone();
    const Q = _q.clone();
    const bodyMat = new THREE.Matrix4().compose(P, Q, ONE);
    const bodyInv = bodyMat.clone().invert();
    const g = globals();
    const single = list.length === 1;
    const fixed = (single && partPhys(anchor.partId).fixed === true) || list.some((i) => pinned.has(i.id));
    const desc = (fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(P.x, P.y, P.z)
      .setRotation({ x: Q.x, y: Q.y, z: Q.z, w: Q.w })
      .setLinearDamping(PHYS.linearDamping)
      .setAngularDamping(PHYS.angularDamping);
    if (asleep) desc.setSleeping(true);
    const body = world.createRigidBody(desc);
    const rec = {
      key,
      body,
      fixed,
      members: [],
      colliders: [],
      devices: [],
      wheelBodies: [],
      joints: [],
      power: false,
      held: false,
      mode: fixed ? 'fixed' : 'dynamic', // dynamic | fixed | controlled | recall
      settleUntil: asleep ? 0 : simTime + PHYS.settleSeconds,
      history: [],
      lastSample: -1,
      recall: null,
      hasSteer: false,
      visible: true,
      ms: 0,
    };
    for (const inst of list) {
      const rel = new THREE.Matrix4().multiplyMatrices(bodyInv, inst.object.matrixWorld);
      const member = { inst, rel, last: capture(inst), driver: null };
      rec.members.push(member);
      const pieces = piecesOf(inst);
      const ph = partPhys(inst.partId);
      inst.object.matrixWorld.decompose(_p, _q, _s);
      const scl = _s.clone();
      const volScale = Math.abs(scl.x * scl.y * scl.z);
      const totalBox = pieces.reduce((n, p) => n + Math.max(p.size.x * p.size.y * p.size.z, 1e-6), 0);
      for (const piece of pieces) {
        const dev = piece.device;
        // 輪子跟別的東西黏在一起時要自己轉：另外做一個剛體，用轉軸關節接到車身
        if (dev?.kind === 'wheel' && !(single && pieces.length === 1)) {
          addWheel(rec, member, piece, bodyMat);
          continue;
        }
        const pts = transformPoints(piece.points, rel);
        let cd;
        if (dev?.kind === 'wheel') {
          // 單獨一個輪子：圓柱，軸沿零件的 X
          const radius = (Math.max(piece.size.y, piece.size.z) / 2) * Math.max(scl.y, scl.z);
          const half = Math.max((piece.size.x / 2) * scl.x, 0.01);
          const c = piece.center.clone().applyMatrix4(rel);
          const axisQ = new THREE.Quaternion().setFromUnitVectors(UP, _v.set(1, 0, 0).applyMatrix4(_m.extractRotation(rel)).normalize());
          cd = R.ColliderDesc.cylinder(half, Math.max(radius, 0.02)).setTranslation(c.x, c.y, c.z).setRotation({ x: axisQ.x, y: axisQ.y, z: axisQ.z, w: axisQ.w });
        } else {
          cd = hullDesc(R, pts);
        }
        const friction = ph.friction ?? (dev?.kind === 'wheel' ? 1.2 : PHYS.friction);
        const bounce = ph.bounce ?? PHYS.bounce;
        cd.setFriction(g.friction ?? friction).setRestitution(g.bounce ?? bounce);
        const boxVol = Math.max(piece.size.x * piece.size.y * piece.size.z, 1e-6);
        if (Number.isFinite(ph.mass)) cd.setMass(Math.max(0.05, (ph.mass * volScale * boxVol) / totalBox));
        else if (dev) cd.setMass(Math.max(0.05, DEVICE_KINDS[dev.kind].mass * volScale));
        else cd.setDensity(PHYS.density);
        const col = world.createCollider(cd, body);
        col.userData_friction = friction;
        col.userData_bounce = bounce;
        rec.colliders.push(col);
        byCollider.set(col.handle, rec);
        if (dev) addDevice(rec, member, piece, dev);
      }
    }
    if (!rec.colliders.length) body.setAdditionalMass(1, false);
    if (!fixed) {
      // 小東西丟快了容易穿過地板：開連續碰撞
      const b = new THREE.Box3();
      for (const inst of list) b.union(boxOf(inst));
      const size = b.getSize(_v);
      if (Math.min(size.x, size.y, size.z) < 0.25) body.enableCcd(true);
    }
    for (const inst of list) byInst.set(inst.id, rec);
    bodies.set(key, rec);
    return rec;
  }

  function addDevice(rec, member, piece, dev) {
    if (rec.devices.length >= PHYS.maxDevices) return null;
    const spec = DEVICE_KINDS[dev.kind];
    const nodeInBody = new THREE.Matrix4().multiplyMatrices(member.rel, piece.nodeMatrix);
    const rot = new THREE.Matrix4().extractRotation(nodeInBody);
    const d = {
      kind: dev.kind,
      member,
      node: piece.node,
      force: dev.force ?? spec.force,
      speed: dev.speed ?? spec.speed,
      point: piece.center.clone().applyMatrix4(member.rel), // 出力點（車身座標）
      dir: new THREE.Vector3(...(dev.direction || spec.dir || [0, 0, 1])).applyMatrix4(rot).normalize(),
      fwd: new THREE.Vector3(0, 0, 1).applyMatrix4(rot).normalize(),
      up: new THREE.Vector3(0, 1, 0).applyMatrix4(rot).normalize(),
      on: false,
      firing: 0,
      cool: 0,
      t: 0,
    };
    if (dev.kind === 'steer') rec.hasSteer = true;
    rec.devices.push(d);
    return d;
  }

  function addWheel(rec, member, piece, bodyMat) {
    const nodeInBody = new THREE.Matrix4().multiplyMatrices(member.rel, piece.nodeMatrix);
    nodeInBody.decompose(_p, _q, _s);
    const rot = new THREE.Matrix4().extractRotation(nodeInBody);
    const center = piece.center.clone().applyMatrix4(member.rel); // 車身座標
    const axle = new THREE.Vector3(1, 0, 0).applyMatrix4(rot).normalize();
    const radius = Math.max(0.03, (Math.max(piece.size.y, piece.size.z) / 2) * Math.max(_s.y, _s.z));
    const worldCenter = center.clone().applyMatrix4(bodyMat);
    const br = rec.body.rotation();
    const wb = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(worldCenter.x, worldCenter.y, worldCenter.z)
        .setRotation(br)
        .setAngularDamping(0.05)
        .setLinearDamping(0.05),
    );
    const spec = DEVICE_KINDS.wheel;
    const ph = partPhys(piece.partId);
    const col = world.createCollider(
      R.ColliderDesc.ball(radius)
        .setFriction(ph.friction ?? 1.2)
        .setRestitution(0)
        .setMass(Math.max(0.2, ph.mass ?? spec.mass))
        .setCollisionGroups(WHEEL_GROUPS),
      wb,
    );
    col.userData_friction = ph.friction ?? 1.2;
    col.userData_bounce = 0;
    byCollider.set(col.handle, rec);
    const joint = world.createImpulseJoint(
      R.JointData.revolute({ x: center.x, y: center.y, z: center.z }, { x: 0, y: 0, z: 0 }, { x: axle.x, y: axle.y, z: axle.z }),
      rec.body,
      wb,
      true,
    );
    joint.setContactsEnabled(false);
    // 輪子的外觀跟著輪子剛體：node 的世界矩陣＝輪子剛體 × wheelRel
    const nodeWorld = new THREE.Matrix4().multiplyMatrices(bodyMat, nodeInBody);
    const wheelMat = bodyMatrix(wb);
    const wheelRel = wheelMat.invert().multiply(nodeWorld);
    const d = addDevice(rec, member, piece, deviceOf(piece.partId) || { kind: 'wheel' });
    rec.wheelBodies.push(wb);
    rec.joints.push(joint);
    if (d) Object.assign(d, { wheelBody: wb, joint, wheelRel, axle, radius, collider: col, isRoot: piece.node === member.inst.object });
    if (piece.node === member.inst.object) member.driver = d;
  }

  function destroy(rec) {
    if (hold?.rec === rec) hold.stale = true;
    for (const j of rec.joints) world.removeImpulseJoint(j, false);
    for (const wb of rec.wheelBodies) world.removeRigidBody(wb);
    for (const c of rec.colliders) byCollider.delete(c.handle);
    for (const d of rec.devices) if (d.collider) byCollider.delete(d.collider.handle);
    world.removeRigidBody(rec.body);
    for (const m of rec.members) if (byInst.get(m.inst.id) === rec) byInst.delete(m.inst.id);
    bodies.delete(rec.key);
    clearRecallFx(rec);
  }

  function sameMembers(rec, list) {
    if (rec.members.length !== list.length) return false;
    for (let i = 0; i < list.length; i += 1) if (!rec.members.some((m) => m.inst === list[i])) return false;
    return true;
  }

  // 每一格：照目前的物件與黏合關係，補建／重建／拆掉剛體
  function sync() {
    const want = new Map();
    for (const inst of instances().values()) {
      const key = keyOf(inst);
      let list = want.get(key);
      if (!list) want.set(key, (list = []));
      list.push(inst);
    }
    for (const [key, rec] of [...bodies]) {
      const list = want.get(key);
      if (!list || !sameMembers(rec, list)) destroy(rec);
    }
    for (const [key, list] of want) {
      if (bodies.has(key)) continue;
      try {
        create(key, list, { asleep: firstSync });
      } catch (e) {
        console.error('physics create', e);
      }
    }
    firstSync = false;
    if (hold?.stale) rebindHold();
  }

  // ---- 被移動（按鈕、復原、規則模組）→ 剛體跟過去 ----

  function teleport(rec, bodyMat) {
    // 輪子剛體跟著車身一起搬（不然關節會把它們硬扯過來）
    const delta = bodyMat.clone().multiply(bodyMatrix(rec.body, new THREE.Matrix4()).invert());
    for (const wb of rec.wheelBodies) {
      bodyMatrix(wb, _m).premultiply(delta).decompose(_p, _q, _s);
      wb.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, true);
      wb.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      wb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      wb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    bodyMat.decompose(_p, _q, _s);
    rec.body.setTranslation({ x: _p.x, y: _p.y, z: _p.z }, true);
    rec.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    if (rec.mode === 'dynamic') {
      rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    rec.settleUntil = simTime + PHYS.settleSeconds;
    rec.history.length = 0;
    for (const m of rec.members) m.last = capture(m.inst);
  }

  function rebuild(rec) {
    const list = rec.members.map((m) => m.inst);
    const wasHeld = hold?.rec === rec;
    const power = rec.power;
    destroy(rec);
    const n = create(rec.key, list);
    n.power = power;
    if (wasHeld) rebindHold();
    return n;
  }

  function checkExternal(rec, ctl) {
    const moved = rec.members.filter((m) => m.inst !== ctl && changed(m.inst, m.last));
    if (!moved.length) return rec;
    if (moved.some((m) => scaleChanged(m.inst, m.last)) || rec.wheelBodies.length) return rebuild(rec);
    // 全部一起被移動（剛性移動）→ 瞬移；只動了其中幾個 → 照新的相對位置重新黏
    let target = null;
    for (const m of rec.members) {
      if (m.inst === ctl) continue;
      m.inst.object.updateMatrixWorld(true);
      const b = _m2.copy(m.rel).invert().premultiply(m.inst.object.matrixWorld);
      if (!target) target = b.clone();
      else {
        const e1 = target.elements;
        const e2 = b.elements;
        for (let i = 0; i < 16; i += 1) if (Math.abs(e1[i] - e2[i]) > 1e-4) return rebuild(rec);
      }
    }
    if (target) teleport(rec, target);
    return rec;
  }

  // ---- 每格更新 ----

  function setMode(rec, mode) {
    if (rec.mode === mode) return;
    const T = R.RigidBodyType;
    if (mode === 'controlled' || mode === 'recall') rec.body.setBodyType(T.KinematicPositionBased, true);
    else if (mode === 'fixed') rec.body.setBodyType(T.Fixed, true);
    else {
      rec.body.setBodyType(T.Dynamic, true);
      rec.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rec.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      rec.settleUntil = simTime + 0.4;
    }
    rec.mode = mode;
  }

  function writeBack(rec, ctl) {
    if (rec.mode === 'fixed' && !rec.held) return;
    const sleeping = rec.body.isSleeping() && !rec.wheelBodies.length;
    if (sleeping && rec.wroteAsleep) return;
    rec.wroteAsleep = sleeping;
    const bm = bodyMatrix(rec.body, _m);
    for (const m of rec.members) {
      if (m.inst === ctl) continue;
      const o = m.inst.object;
      if (m.driver?.wheelBody) {
        _m2.multiplyMatrices(bodyMatrix(m.driver.wheelBody, new THREE.Matrix4()), m.driver.wheelRel);
      } else {
        _m2.multiplyMatrices(bm, m.rel);
      }
      // 物件掛在別的節點底下（不是直接在世界裡）時，換算成相對父節點的位置，不然會整個跳走
      const parent = o.parent;
      if (parent && !parent.matrixWorld.equals(IDENTITY)) {
        parent.updateMatrixWorld(true);
        _m2.premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
      }
      _m2.decompose(o.position, o.quaternion, _s); // 縮放不從剛體算回來（浮點誤差會讓它慢慢飄）
      o.updateMatrixWorld(true);
      m.last = capture(m.inst);
    }
    // 子零件裡的輪子：換算成相對父節點的位置
    for (const d of rec.devices) {
      if (!d.wheelBody || d.isRoot || d.member.inst === ctl) continue;
      const parent = d.node.parent;
      if (!parent) continue;
      parent.updateMatrixWorld(true);
      _m2.multiplyMatrices(bodyMatrix(d.wheelBody, new THREE.Matrix4()), d.wheelRel);
      _m2.premultiply(new THREE.Matrix4().copy(parent.matrixWorld).invert());
      _m2.decompose(d.node.position, d.node.quaternion, d.node.scale);
    }
  }

  function bodyWorldDir(rec, local, target) {
    const r = rec.body.rotation();
    return target.copy(local).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }
  function bodyWorldPoint(rec, local, target) {
    const t = rec.body.translation();
    const r = rec.body.rotation();
    return target.copy(local).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_p.set(t.x, t.y, t.z));
  }

  // 輪子往哪邊滾＝輪軸 × 上（輪子一直在轉，不能用它自己的 +Z）
  function wheelForward(rec, d, target) {
    const ax = bodyWorldDir(rec, d.axle, target);
    return target.set(-ax.z, 0, ax.x); // ax × (0, 1, 0)
  }
  // 整台東西的「前方」（世界座標、水平）：操縱桿 > 輪子 > 風扇／火箭 > 第一個零件的 +Z
  function forwardWorld(rec, target = new THREE.Vector3()) {
    const steer = rec.devices.find((d) => d.kind === 'steer');
    const wheel = rec.devices.find((d) => d.kind === 'wheel' && d.axle);
    const thrust = rec.devices.find((d) => d.kind === 'fan' || d.kind === 'rocket');
    if (steer) bodyWorldDir(rec, steer.fwd, target);
    else if (wheel) wheelForward(rec, wheel, target);
    else if (thrust) bodyWorldDir(rec, thrust.dir, target);
    else bodyWorldDir(rec, new THREE.Vector3(0, 0, 1).applyMatrix4(_m.extractRotation(rec.members[0].rel)), target);
    target.y = 0;
    if (target.lengthSq() < 1e-6) target.set(0, 0, 1);
    return target.normalize();
  }

  function runDevices(rec, dt) {
    const body = rec.body;
    if (!rec.devices.length || rec.mode === 'recall') return;
    body.resetForces(false);
    body.resetTorques(false);
    let thrusting = false;
    const pilot = rec.pilotInput;
    const throttle = pilot ? pilot.y : 0;
    let F = null;
    let Rt = null;
    let com = null;
    if (pilot) {
      F = forwardWorld(rec);
      Rt = new THREE.Vector3().crossVectors(F, UP);
      const c = body.worldCom();
      com = new THREE.Vector3(c.x, c.y, c.z);
    }
    const t = body.translation();
    for (const d of rec.devices) {
      d.t += dt;
      if (d.cool > 0) d.cool = Math.max(0, d.cool - dt);
      const pt = bodyWorldPoint(rec, d.point, _v2);
      let power = 0;
      if (d.kind === 'balloon') {
        // 一直有浮力，升到天花板附近就不再往上
        const k = clamp((PHYS.balloonCeiling - pt.y) / 3, 0, 1);
        power = 1;
        body.addForceAtPoint({ x: 0, y: d.force * k, z: 0 }, pt, true);
      } else if (d.kind === 'fan') {
        power = Math.max(rec.power ? 1 : 0, pilot ? Math.max(0, throttle) : 0);
        if (power > 0.02) {
          thrusting = true;
          const dir = bodyWorldDir(rec, d.dir, _v);
          const k = clamp((PHYS.thrustCeiling - t.y) / 5, 0, 1) * power * d.force;
          body.addForceAtPoint({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, pt, true);
        }
      } else if (d.kind === 'rocket') {
        if (d.firing > 0) {
          power = 1;
          thrusting = true;
          d.firing = Math.max(0, d.firing - dt);
          if (d.firing === 0) d.cool = DEVICE_KINDS.rocket.cooldown;
          const dir = bodyWorldDir(rec, d.dir, _v);
          const k = clamp((PHYS.thrustCeiling - t.y) / 5, 0, 1) * d.force;
          body.addForceAtPoint({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, pt, true);
        }
      } else if (d.kind === 'wheel' && d.joint) {
        let factor = rec.power ? 1 : 0;
        if (pilot) {
          const wf = wheelForward(rec, d, _v);
          const align = (wf.x * F.x + wf.z * F.z) / Math.max(Math.hypot(wf.x, wf.z), 1e-6);
          const base = Math.abs(throttle) > 0.1 ? throttle : rec.power ? 1 : 0;
          const wc = d.wheelBody.translation();
          const side = Math.sign((wc.x - com.x) * Rt.x + (wc.z - com.z) * Rt.z) || 0;
          factor = Math.abs(align) < 0.3 ? 0 : clamp(base - pilot.x * side * 0.8, -1, 1) * Math.sign(align);
        }
        power = Math.abs(factor);
        if (power > 0.02) {
          d.joint.configureMotorVelocity((factor * d.speed) / d.radius, 20);
          d.joint.setMotorMaxForce(d.force * d.radius);
        } else if (braked.size && rec.members.some((m) => braked.has(m.inst.id))) {
          // 自動煞車（冒險模式的車）：沒出力時輪子慢慢停下來，不會一路滑走
          d.joint.configureMotorVelocity(0, 20);
          d.joint.setMotorMaxForce(d.force * d.radius * 0.6);
        } else {
          d.joint.configureMotorVelocity(0, 0);
        }
        d.wheelBody.wakeUp();
      }
      d.on = power > 0.02;
      const hook = d.node.userData?.onDevice;
      if (typeof hook === 'function' && !brokenHooks.has(hook)) {
        try {
          hook.call(d.node, { kind: d.kind, on: d.on, power, firing: d.firing > 0, t: d.t }, dt);
        } catch (e) {
          brokenHooks.add(hook);
          console.error(e);
          toast(`⚠️ 裝置「${nameOf(d.member.inst)}」的動畫出錯，已停用動畫（裝置照常運作）`);
        }
      }
    }
    const damp = thrusting || rec.devices.some((d) => d.kind === 'balloon') ? PHYS.poweredDamping : PHYS.linearDamping;
    if (damp !== rec.damp) {
      rec.damp = damp;
      body.setLinearDamping(damp);
    }
    if (pilot) pilotAssist(rec, pilot, dt);
  }

  // 駕駛時的轉向（像操縱桿）：左右推搖桿就轉；有操縱桿時還會幫忙保持水平
  function pilotAssist(rec, input, dt) {
    const body = rec.body;
    const w = body.angvel();
    const strong = rec.hasSteer;
    const target = -input.x * (strong ? 2 : 1.3);
    if (Math.abs(input.x) > 0.05 || strong) {
      w.y += (target - w.y) * Math.min(1, (strong ? 8 : 4) * dt);
    }
    if (strong) {
      const steer = rec.devices.find((d) => d.kind === 'steer');
      const up = bodyWorldDir(rec, steer.up, _v);
      const axis = _v2.crossVectors(up, UP);
      const s = axis.length();
      if (s > 1e-4) {
        const angle = Math.asin(Math.min(1, s));
        axis.multiplyScalar((angle / s) * 4 * dt);
        w.x += axis.x;
        w.z += axis.z;
      }
      const k = 1 - Math.min(1, 3 * dt);
      w.x *= k;
      w.z *= k;
    }
    body.setAngvel(w, true);
  }

  function activate(rec) {
    if (!rec.devices.length) return null;
    rec.power = !rec.power;
    const fired = [];
    for (const d of rec.devices) {
      if (d.kind === 'rocket' && d.cool === 0 && d.firing === 0) {
        d.firing = DEVICE_KINDS.rocket.burst;
        fired.push(d);
      }
      if (d.kind === 'spring') {
        const dir = bodyWorldDir(rec, d.dir, _v);
        const pt = bodyWorldPoint(rec, d.point, _v2);
        rec.body.applyImpulseAtPoint({ x: dir.x * d.force, y: dir.y * d.force, z: dir.z * d.force }, pt, true);
        d.t = 0;
        fired.push(d);
      }
    }
    rec.body.wakeUp();
    return { power: rec.power, fired: fired.length };
  }

  // ---- 究極手 ----

  function comOf(rec) {
    const c = rec.body.worldCom();
    return new THREE.Vector3(c.x, c.y, c.z);
  }

  function beginHold(rec, inst, point) {
    rec.held = true;
    if (rec.mode === 'fixed') rec.body.setBodyType(R.RigidBodyType.KinematicVelocityBased, true);
    rec.body.setGravityScale(0, true);
    rec.body.wakeUp();
    const r = rec.body.rotation();
    const com = comOf(rec);
    return {
      rec,
      inst,
      finger: point.clone(),
      offset: com.clone().sub(point), // 手指 → 重心（世界座標，不跟著轉）
      targetQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      samples: [{ t: simTime, p: com.clone() }],
      cand: null,
      stale: false,
    };
  }

  function rebindHold() {
    const h = hold;
    if (!h) return;
    const rec = byInst.get(h.inst.id);
    if (!rec) {
      hold = null;
      clearHoldFx();
      return;
    }
    hold = beginHold(rec, h.inst, h.finger); // 黏上／拆下之後剛體換了一個，旋轉目標從現在的姿勢重新算
  }

  function driveHold(dt) {
    const h = hold;
    const body = h.rec.body;
    const com = comOf(h.rec);
    const target = _v.copy(h.finger).add(h.offset);
    const v = target.sub(com).multiplyScalar(1 / 0.09);
    if (v.length() > PHYS.holdMaxSpeed) v.setLength(PHYS.holdMaxSpeed);
    body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    const r = body.rotation();
    const qErr = _q.copy(h.targetQ).multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
    if (qErr.w < 0) qErr.set(-qErr.x, -qErr.y, -qErr.z, -qErr.w);
    const angle = 2 * Math.acos(clamp(qErr.w, -1, 1));
    const s = Math.sqrt(Math.max(1 - qErr.w * qErr.w, 0));
    const w = s > 1e-5 ? _v2.set(qErr.x / s, qErr.y / s, qErr.z / s).multiplyScalar(Math.min(angle / 0.12, 10)) : _v2.set(0, 0, 0);
    body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    h.samples.push({ t: simTime, p: com });
    while (h.samples.length > 2 && simTime - h.samples[0].t > 0.12) h.samples.shift();
  }

  function groupBox(rec) {
    const b = new THREE.Box3();
    for (const m of rec.members) b.union(boxOf(m.inst));
    return b;
  }
  function boxGap(a, b) {
    const dx = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x);
    const dy = Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y);
    const dz = Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z);
    return Math.hypot(dx, dy, dz);
  }

  function findGlueCandidate() {
    const h = hold;
    const hb = groupBox(h.rec);
    let best = null;
    let bestGap = PHYS.glueReach;
    // 先看真正碰到的
    for (const c of h.rec.colliders) {
      world.contactPairsWith(c, (c2) => {
        const other = byCollider.get(c2.handle);
        if (other && other !== h.rec && other.visible) {
          best = other;
          bestGap = 0;
        }
      });
      if (best) break;
    }
    if (!best) {
      for (const rec of bodies.values()) {
        if (rec === h.rec || !rec.visible) continue;
        const gap = boxGap(hb, groupBox(rec));
        if (gap < bestGap) {
          bestGap = gap;
          best = rec;
        }
      }
    }
    if (!best) return null;
    const ob = groupBox(best);
    const a = hb.getCenter(new THREE.Vector3());
    const pA = ob.clampPoint(a, new THREE.Vector3());
    const pB = hb.clampPoint(pA, new THREE.Vector3());
    return { rec: best, inst: best.members[0].inst, a: pB, b: pA };
  }

  // ---- 時光倒轉 ----

  function recordHistory(rec) {
    if (rec.mode !== 'dynamic' || rec.recall) return;
    if (rec.body.isSleeping() && !rec.held) return;
    if (simTime - rec.lastSample < 1 / PHYS.recallHz) return;
    rec.lastSample = simTime;
    const t = rec.body.translation();
    const r = rec.body.rotation();
    const last = rec.history[rec.history.length - 1];
    if (last && Math.hypot(last.p[0] - t.x, last.p[1] - t.y, last.p[2] - t.z) < 0.002 && Math.abs(last.q[3] - r.w) < 1e-4) return;
    rec.history.push({ p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] });
    if (rec.history.length > PHYS.recallSeconds * PHYS.recallHz) rec.history.shift();
  }

  function runRecall(rec, dt) {
    const rc = rec.recall;
    if (rc.hang > 0) {
      rc.hang -= dt;
      if (rc.hang <= 0) endRecall(rec);
      return;
    }
    rc.pos -= dt * PHYS.recallHz;
    if (rc.pos <= 0) {
      rc.pos = 0;
      rc.hang = 0.6; // 倒回起點後在空中停一下，再交還給物理
    }
    const i = Math.floor(rc.pos);
    const f = rc.pos - i;
    const a = rec.history[i];
    const b = rec.history[Math.min(i + 1, rec.history.length - 1)];
    const p = _v.set(a.p[0] + (b.p[0] - a.p[0]) * f, a.p[1] + (b.p[1] - a.p[1]) * f, a.p[2] + (b.p[2] - a.p[2]) * f);
    const q = _q.set(...a.q).slerp(new THREE.Quaternion(...b.q), f);
    setKinematicTarget(rec, p, q);
    updateRecallFx(rec, i);
  }

  // 被開著／倒轉中的東西（運動學剛體）：這一格要從哪裡移到哪裡。畫面卡的時候一格會補好幾個小步，
  // 移動要平均分到每一步；全部擠在第一步，等於瞬間移動一大段，會直接穿過東西而不是把它推開
  function setKinematicTarget(rec, p, q) {
    const t = rec.body.translation();
    const r = rec.body.rotation();
    rec.kin = {
      fromP: new THREE.Vector3(t.x, t.y, t.z),
      fromQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      toP: p.clone(),
      toQ: q.clone(),
    };
  }
  function applyKinematic(k, n) {
    for (const rec of bodies.values()) {
      if (!rec.kin) continue;
      const f = (k + 1) / n;
      const p = _v.copy(rec.kin.fromP).lerp(rec.kin.toP, f);
      const q = _q.copy(rec.kin.fromQ).slerp(rec.kin.toQ, f);
      rec.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      rec.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  function endRecall(rec) {
    rec.recall = null;
    rec.history.length = 0;
    setMode(rec, rec.fixed ? 'fixed' : 'dynamic');
    clearRecallFx(rec);
  }

  // ---- 特效（究極手的綠光、黏合預覽、倒轉路徑） ----

  const fx = { aura: [], beam: null, glue: null, glueDot: null };
  const auraMat = () => {
    const m = new THREE.LineBasicMaterial({ color: 0x9dff5c, transparent: true, opacity: 0.95, depthTest: false });
    return m;
  };
  function syncHoldFx() {
    if (!hold || !fxRoot) return clearHoldFx();
    const members = hold.rec.members;
    while (fx.aura.length < members.length) {
      const h = new THREE.BoxHelper(members[fx.aura.length].inst.object, 0x9dff5c);
      h.material = auraMat();
      h.renderOrder = 11;
      fxRoot.add(h);
      fx.aura.push(h);
    }
    while (fx.aura.length > members.length) {
      const h = fx.aura.pop();
      h.removeFromParent();
      h.geometry.dispose();
      h.material.dispose();
    }
    fx.aura.forEach((h, i) => {
      h.object = members[i].inst.object;
      h.update();
      h.material.opacity = 0.65 + 0.3 * Math.sin(simTime * 9);
    });
    if (!fx.beam) {
      fx.beam = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: 0x9dff5c, transparent: true, opacity: 0.8, depthTest: false }),
      );
      fx.beam.renderOrder = 11;
      fx.beam.frustumCulled = false;
      fxRoot.add(fx.beam);
    }
    if (camera) {
      const hand = camera.getWorldPosition(new THREE.Vector3());
      const dir = camera.getWorldDirection(new THREE.Vector3());
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
      hand.addScaledVector(dir, 0.6).addScaledVector(UP, -0.35).addScaledVector(right, 0.22);
      const pos = fx.beam.geometry.attributes.position;
      pos.setXYZ(0, hand.x, hand.y, hand.z);
      const c = groupBox(hold.rec).getCenter(new THREE.Vector3());
      pos.setXYZ(1, c.x, c.y, c.z);
      pos.needsUpdate = true;
    }
    const cand = hold.cand;
    if (cand) {
      if (!fx.glue) {
        fx.glue = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
          new THREE.LineBasicMaterial({ color: 0xfff36b, depthTest: false }),
        );
        fx.glue.frustumCulled = false;
        fx.glue.renderOrder = 12;
        fx.glueDot = new THREE.Mesh(
          new THREE.SphereGeometry(0.05, 14, 10),
          new THREE.MeshBasicMaterial({ color: 0xfff36b, transparent: true, opacity: 0.85, depthTest: false }),
        );
        fx.glueDot.renderOrder = 12;
        fxRoot.add(fx.glue, fx.glueDot);
      }
      const pos = fx.glue.geometry.attributes.position;
      pos.setXYZ(0, cand.a.x, cand.a.y, cand.a.z);
      pos.setXYZ(1, cand.b.x, cand.b.y, cand.b.z);
      pos.needsUpdate = true;
      fx.glueDot.position.copy(cand.a).add(cand.b).multiplyScalar(0.5);
      fx.glueDot.scale.setScalar(1 + 0.35 * Math.sin(simTime * 10));
      fx.glue.visible = fx.glueDot.visible = true;
    } else if (fx.glue) {
      fx.glue.visible = fx.glueDot.visible = false;
    }
  }
  function clearHoldFx() {
    for (const h of fx.aura) {
      h.removeFromParent();
      h.geometry.dispose();
      h.material.dispose();
    }
    fx.aura = [];
    for (const k of ['beam', 'glue', 'glueDot']) {
      if (!fx[k]) continue;
      fx[k].removeFromParent();
      fx[k].geometry.dispose();
      fx[k].material.dispose();
      fx[k] = null;
    }
  }
  function updateRecallFx(rec, upto) {
    if (!fxRoot) return;
    if (!rec.recallLine) {
      rec.recallLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0xffb640, dashSize: 0.12, gapSize: 0.07, transparent: true, opacity: 0.9, depthTest: false }),
      );
      rec.recallLine.frustumCulled = false;
      rec.recallLine.renderOrder = 11;
      rec.recallAura = rec.members.map((m) => {
        const h = new THREE.BoxHelper(m.inst.object, 0xffb640);
        h.material.depthTest = false;
        h.renderOrder = 11;
        fxRoot.add(h);
        return h;
      });
      fxRoot.add(rec.recallLine);
    }
    const pts = rec.history.slice(0, upto + 1).map((h) => new THREE.Vector3(...h.p));
    if (pts.length < 2) pts.push(pts[0] || new THREE.Vector3());
    rec.recallLine.geometry.dispose();
    rec.recallLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    rec.recallLine.computeLineDistances();
    for (const h of rec.recallAura) h.update();
  }
  function clearRecallFx(rec) {
    if (rec.recallLine) {
      rec.recallLine.removeFromParent();
      rec.recallLine.geometry.dispose();
      rec.recallLine.material.dispose();
      rec.recallLine = null;
    }
    for (const h of rec.recallAura || []) {
      h.removeFromParent();
      h.geometry.dispose();
      h.material.dispose();
    }
    rec.recallAura = null;
  }

  // ---- 主迴圈 ----

  function update(dt) {
    if (!enabled || !world) return;
    const t0 = now();
    sync();
    const ctl = controlled();
    for (let rec of [...bodies.values()]) {
      // 被藏起來（彈指）的東西暫時不參與碰撞
      const vis = rec.members.every((m) => m.inst.object.visible);
      if (vis !== rec.visible) {
        rec.visible = vis;
        rec.body.setEnabled(vis);
        for (const wb of rec.wheelBodies) wb.setEnabled(vis);
      }
      const isCtl = !!ctl && rec.members.some((m) => m.inst === ctl);
      if (isCtl) {
        if (rec.held) release();
        if (rec.recall) endRecall(rec);
        const cm = rec.members.find((m) => m.inst === ctl);
        if (scaleChanged(ctl, cm.last)) {
          rec = rebuild(rec);
          continue;
        }
        setMode(rec, 'controlled');
        ctl.object.updateMatrixWorld(true);
        const b = _m2.copy(rec.members.find((m) => m.inst === ctl).rel).invert().premultiply(ctl.object.matrixWorld);
        b.decompose(_p, _q, _s);
        setKinematicTarget(rec, _p, _q);
        cm.last = capture(ctl);
        rec.history.length = 0;
        continue;
      }
      if (rec.mode === 'controlled') setMode(rec, rec.fixed ? 'fixed' : 'dynamic');
      rec = checkExternal(rec, null);
      if (rec.recall) runRecall(rec, dt);
      else runDevices(rec, dt);
    }
    if (hold && !hold.stale) {
      driveHold(dt);
      hold.cand = findGlueCandidate();
    }
    // 固定時間步長（1/60 秒），一格最多補 6 步（約 10 fps），再卡就寧可慢動作也不要爆炸
    acc = Math.min(acc + dt, PHYS.maxSubsteps / PHYS.hz);
    const n = Math.floor((acc + 1e-6) * PHYS.hz);
    for (let k = 0; k < n; k += 1) {
      applyKinematic(k, n);
      world.step();
      acc -= 1 / PHYS.hz;
      simTime += 1 / PHYS.hz;
    }
    if (n) for (const rec of bodies.values()) rec.kin = null;
    let moving = false;
    for (const rec of bodies.values()) {
      rec.pilotInput = null;
      const body = rec.body;
      if (rec.mode === 'dynamic' && !body.isSleeping()) {
        const v = body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        const cap = simTime < rec.settleUntil && !rec.held ? PHYS.settleSpeed : PHYS.maxSpeed;
        if (sp > cap) body.setLinvel({ x: (v.x * cap) / sp, y: (v.y * cap) / sp, z: (v.z * cap) / sp }, true);
        else if (v.y > PHYS.balloonRise && rec.devices.some((d) => d.kind === 'balloon')) body.setLinvel({ x: v.x, y: PHYS.balloonRise, z: v.z }, true);
        moving = true;
        const p = body.translation();
        const r = Math.hypot(p.x, p.z);
        if (p.y < PHYS.bounds.minY || p.y > PHYS.bounds.maxY || r > PHYS.bounds.radius || !Number.isFinite(p.x + p.y + p.z)) {
          const at = respawnAt();
          teleport(rec, new THREE.Matrix4().compose(at, new THREE.Quaternion(), ONE));
          toast(`「${nameOf(rec.members[0].inst)}」飛太遠了，拉回你前面`);
        }
      }
      writeBack(rec, ctl);
      recordHistory(rec);
    }
    if (hold) syncHoldFx();
    if (wasMoving && !moving) onSettled?.();
    if (moving && simTime - lastMovingSave > 5) {
      lastMovingSave = simTime;
      onMoving?.();
    }
    wasMoving = moving;
    const ms = now() - t0;
    stepMs = stepMs * 0.9 + ms * 0.1;
  }

  function release() {
    const h = hold;
    hold = null;
    clearHoldFx();
    if (!h || h.stale || !bodies.has(h.rec.key)) return;
    const rec = h.rec;
    rec.held = false;
    rec.body.setGravityScale(1, true);
    if (rec.fixed) {
      rec.body.setBodyType(R.RigidBodyType.Fixed, true);
      for (const m of rec.members) m.last = capture(m.inst);
      return;
    }
    // 放手：用最後 0.1 秒手的速度丟出去
    const a = h.samples[0];
    const b = h.samples[h.samples.length - 1];
    const span = b.t - a.t;
    const v = span > 0.02 ? b.p.clone().sub(a.p).multiplyScalar(1 / span) : new THREE.Vector3();
    if (v.length() > PHYS.throwMax) v.setLength(PHYS.throwMax);
    if (v.length() < 0.6) v.set(0, 0, 0);
    rec.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    const w = rec.body.angvel();
    rec.body.setAngvel({ x: w.x * 0.3, y: w.y * 0.3, z: w.z * 0.3 }, true);
  }

  // wake：使用者自己按開物理時，浮在空中的東西要掉下來；重新載入頁面時先「睡著」，碰到才動（保留原本的擺法）
  async function setEnabled(on, { wake = false } = {}) {
    if (on) {
      if (!R) {
        rapierPromise ??= loadRapier();
        R = await rapierPromise;
      }
      if (world) return true;
      world = new R.World({ x: 0, y: globals().gravity, z: 0 });
      world.timestep = 1 / PHYS.hz;
      const ground = world.createRigidBody(R.RigidBodyDesc.fixed());
      world.createCollider(R.ColliderDesc.cuboid(400, 0.5, 400).setTranslation(0, -0.5, 0).setFriction(0.8), ground);
      enabled = true;
      firstSync = !wake;
      acc = 0;
      sync();
      return true;
    }
    enabled = false;
    hold = null;
    clearHoldFx();
    for (const rec of [...bodies.values()]) clearRecallFx(rec);
    bodies.clear();
    byInst.clear();
    byCollider.clear();
    if (world) world.free();
    world = null;
    return false;
  }

  const recOfHandle = (h) => (h ? byInst.get(h.id) : null);
  function frameOf(rec) {
    const box = groupBox(rec);
    return { center: box.getCenter(new THREE.Vector3()), forward: forwardWorld(rec), size: box.getSize(new THREE.Vector3()), power: rec.power };
  }

  return {
    PHYS,
    get enabled() {
      return enabled;
    },
    get ready() {
      return enabled && !!world;
    },
    setEnabled,
    update,
    // 究極手
    grab(inst, point) {
      if (!enabled) return false;
      sync();
      const rec = byInst.get(inst.id);
      if (!rec || rec.recall || rec.mode === 'controlled') return false;
      if (hold) release();
      hold = beginHold(rec, inst, point);
      return true;
    },
    moveHold(point) {
      if (hold) hold.finger.copy(point);
    },
    rotateHold(axis, angle) {
      if (!hold) return;
      hold.targetQ.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
    },
    // VR：東西跟著手腕轉（目標姿勢直接給）
    get holdQuaternion() {
      return hold ? hold.targetQ.clone() : new THREE.Quaternion();
    },
    setHoldQuaternion(q) {
      if (hold) hold.targetQ.copy(q);
    },
    release,
    get holding() {
      return hold && !hold.stale ? { inst: hold.inst, members: hold.rec.members.map((m) => m.inst), finger: hold.finger.clone() } : null;
    },
    get glueCandidate() {
      return hold?.cand ? { inst: hold.cand.inst, members: hold.cand.rec.members.map((m) => m.inst) } : null;
    },
    // 裝置
    hasDevices(inst) {
      const rec = byInst.get(inst.id);
      if (rec) return rec.devices.some((d) => d.kind !== 'balloon');
      return piecesOf(inst).some((p) => p.device && p.device.kind !== 'balloon');
    },
    devicesOf(inst) {
      const rec = byInst.get(inst.id);
      return rec ? rec.devices.map((d) => ({ kind: d.kind, on: d.on, firing: d.firing > 0 })) : [];
    },
    activate(inst) {
      const rec = byInst.get(inst.id);
      return rec ? activate(rec) : null;
    },
    pilot(inst, input, dt) {
      const rec = byInst.get(inst.id);
      if (!rec) return null;
      rec.pilotInput = { x: input.x, y: input.y };
      if (input.actionPressed) activate(rec);
      rec.body.wakeUp();
      return frameOf(rec);
    },
    // 整台東西的中心、前方、大小（駕駛鏡頭和測試用，不影響操作）
    frame(inst) {
      const rec = byInst.get(inst.id);
      return rec ? frameOf(rec) : null;
    },
    // 時光倒轉
    recall(inst) {
      const rec = byInst.get(inst.id);
      if (!rec) return { ok: false, why: 'none' };
      if (rec.recall) {
        endRecall(rec);
        return { ok: true, stopped: true };
      }
      if (rec.history.length < 2) return { ok: false, why: 'still' };
      if (hold?.rec === rec) release();
      setMode(rec, 'recall');
      rec.recall = { pos: rec.history.length - 1, hang: 0 };
      return { ok: true };
    },
    isRecalling(inst) {
      return !!byInst.get(inst.id)?.recall;
    },
    // 釘住／放開（冒險模式的組裝台）：釘住時整組是固定剛體，放開後照常受重力
    pin(inst, on = true) {
      if (on) pinned.add(inst.id);
      else pinned.delete(inst.id);
      const rec = byInst.get(inst.id);
      if (!rec) return;
      const want = rec.members.some((m) => pinned.has(m.inst.id)) || (rec.members.length === 1 && partPhys(rec.members[0].inst.partId).fixed === true);
      if (want === rec.fixed) return;
      rec.fixed = want;
      if (!rec.held && !rec.recall && rec.mode !== 'controlled') setMode(rec, want ? 'fixed' : 'dynamic');
      rec.body.wakeUp();
    },
    setBrake(inst, on = true) {
      if (on) braked.add(inst.id);
      else braked.delete(inst.id);
    },
    // 查詢
    bodyOf(inst) {
      const rec = byInst.get(inst.id);
      if (!rec) return null;
      const t = rec.body.translation();
      const v = rec.body.linvel();
      return {
        key: rec.key,
        mode: rec.mode,
        held: rec.held,
        sleeping: rec.body.isSleeping(),
        mass: rec.body.mass(),
        position: [t.x, t.y, t.z],
        velocity: [v.x, v.y, v.z],
        colliders: rec.colliders.length,
        wheels: rec.wheelBodies.length,
        devices: rec.devices.map((d) => d.kind),
        power: rec.power,
        history: rec.history.length,
        members: rec.members.map((m) => m.inst.id),
      };
    },
    stats() {
      let colliders = 0;
      for (const r of bodies.values()) colliders += r.colliders.length + r.wheelBodies.length;
      return { bodies: bodies.size, colliders, ms: Math.round(stepMs * 100) / 100, gravity: globals().gravity };
    },
    wake() {
      for (const r of bodies.values()) r.body.wakeUp();
    },
    // 世界模組用的物理介面（模組拔掉時覆寫自動消失）
    apiFor(id) {
      const ov = () => {
        if (!moduleOverrides.has(id)) moduleOverrides.set(id, {});
        return moduleOverrides.get(id);
      };
      return {
        get enabled() {
          return enabled;
        },
        gravity(y) {
          if (Number.isFinite(y)) {
            ov().gravity = clamp(y, -40, 10);
            applyGlobals();
          }
          return globals().gravity;
        },
        material({ friction, bounce } = {}) {
          const o = ov();
          if (Number.isFinite(friction)) o.friction = clamp(friction, 0, 2);
          if (Number.isFinite(bounce)) o.bounce = clamp(bounce, 0, 1);
          applyGlobals();
        },
        push(handle, v) {
          const rec = recOfHandle(handle);
          if (!rec || rec.mode !== 'dynamic' || rec.held || !Array.isArray(v) || !v.every(Number.isFinite)) return;
          const cur = rec.body.linvel();
          const nv = new THREE.Vector3(cur.x + v[0], cur.y + v[1], cur.z + v[2]);
          if (nv.length() > 30) nv.setLength(30);
          rec.body.setLinvel({ x: nv.x, y: nv.y, z: nv.z }, true);
        },
        velocity(handle) {
          const rec = recOfHandle(handle);
          if (!rec) return [0, 0, 0];
          const v = rec.body.linvel();
          return [v.x, v.y, v.z];
        },
        setVelocity(handle, v) {
          const rec = recOfHandle(handle);
          if (!rec || rec.mode !== 'dynamic' || rec.held || !Array.isArray(v) || !v.every(Number.isFinite)) return;
          const nv = new THREE.Vector3(...v);
          if (nv.length() > 30) nv.setLength(30);
          rec.body.setLinvel({ x: nv.x, y: nv.y, z: nv.z }, true);
        },
      };
    },
    clearModule(id) {
      if (moduleOverrides.delete(id)) applyGlobals();
    },
  };
}
