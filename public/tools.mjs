// 道具行為：遊戲裡的道具不只是外觀，真的會「做事」——能量槍拿在手上會射、子彈會命中、標靶被打中會有反應。
// 零件在 meta.json 宣告（跟 device 一樣），任何零件都可以是道具；組合零件裡只要有一個道具零件，整組拿起來就能用。
//   "tool":   { "kind": "blaster", "rate": 4, "speed": 28, "range": 40, "color": "#7cf8ff", "size": 0.07, "burst": 1, "spread": 0 }
//   "target": { "points": 1 }
// 規格（TOOL_KINDS、normalizeTool、normalizeTarget）瀏覽器和 Node 驗收共用；createTools() 是瀏覽器裡的行為引擎，不碰 DOM。

export const TOOL_KINDS = {
  blaster: { label: '能量槍', rate: 4, speed: 28, range: 40, color: '#7cf8ff', size: 0.07, burst: 1, spread: 0 },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, a, b, d) => (Number.isFinite(v) ? clamp(v, a, b) : d);

export function normalizeTool(t) {
  if (!t || typeof t !== 'object') return null;
  const kind = String(t.kind || '').toLowerCase();
  const spec = TOOL_KINDS[kind];
  if (!spec) return null;
  return {
    kind,
    rate: num(t.rate, 0.5, 12, spec.rate), // 每秒最多幾發（按住 ⚡ 連射）
    speed: num(t.speed, 5, 80, spec.speed), // 子彈速度 m/s
    range: num(t.range, 5, 120, spec.range), // 射程 m
    color: /^#[0-9a-f]{6}$/i.test(String(t.color || '')) ? String(t.color).toLowerCase() : spec.color,
    size: num(t.size, 0.02, 0.3, spec.size), // 子彈半徑 m
    burst: Math.round(num(t.burst, 1, 5, spec.burst)), // 一次射幾發（散彈）
    spread: num(t.spread, 0, 0.2, spec.spread), // 散開角度（弧度）
  };
}

export function normalizeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  return { points: Math.round(num(t.points, 1, 100, 1)) };
}

// 零件（或組合零件裡的子零件）有沒有道具行為：回傳 { tool, partId } 或 null
export function findTool(partId, partOf, depth = 0) {
  const part = partOf(partId);
  if (!part || depth > 8) return null;
  const tool = normalizeTool(part.tool);
  if (tool) return { tool, partId };
  for (const c of part.children || []) {
    const found = findTool(c.partId, partOf, depth + 1);
    if (found) return found;
  }
  return null;
}

// ---------------- 瀏覽器：射擊、子彈、命中 ----------------

export function createTools({ THREE, scene, camera, engine, partOf, hittables, onFire, onHit, sfx = null }) {
  const shots = [];
  const sparks = [];
  const ray = new THREE.Raycaster();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  let cool = 0;
  let fired = 0; // 總共射了幾發（測試和統計用）
  let override = null; // 遊戲設定改過的道具參數（顏色、射速）
  let enabled = true;

  // ---- 共用資源：幾何一份、每種顏色一組材質；子彈、火花、閃光用完放回池子重用（連射不會一直配新記憶體） ----
  const GEO = {
    core: new THREE.SphereGeometry(1, 12, 8),
    glow: new THREE.SphereGeometry(1, 12, 8),
    trail: new THREE.CylinderGeometry(0.001, 0.6, 9, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -4.5), // 頭粗、往後變細
    spark: new THREE.BoxGeometry(1, 1, 1),
    ring: new THREE.TorusGeometry(1, 0.08, 6, 32),
  };
  const mats = new Map();
  function matsFor(color) {
    let m = mats.get(color);
    if (!m) {
      const add = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
      m = {
        core: new THREE.MeshBasicMaterial({ color }),
        glow: new THREE.MeshBasicMaterial({ color, opacity: 0.35, ...add }),
        trail: new THREE.MeshBasicMaterial({ color, opacity: 0.5, ...add }),
        spark: new THREE.MeshBasicMaterial({ color, ...add }),
        flash: new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, ...add }),
        debris: new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.8 }),
      };
      mats.set(color, m);
    }
    return m;
  }
  const shotPool = [];
  function acquireShot(tool) {
    const m = matsFor(tool.color);
    let g = shotPool.pop();
    if (!g) {
      g = new THREE.Group();
      g.add(new THREE.Mesh(GEO.core), new THREE.Mesh(GEO.glow), new THREE.Mesh(GEO.trail));
      g.children.forEach((c) => (c.frustumCulled = false));
    }
    const [core, glow, trail] = g.children;
    core.material = m.core;
    glow.material = m.glow;
    trail.material = m.trail;
    core.scale.setScalar(tool.size);
    glow.scale.setScalar(tool.size * 2.2);
    trail.scale.setScalar(tool.size);
    scene.add(g);
    return g;
  }
  const fxPool = [];
  function acquireFx(geo, mat) {
    const m = fxPool.pop() || new THREE.Mesh(geo, mat);
    m.geometry = geo;
    m.material = mat;
    m.rotation.set(0, 0, 0);
    scene.add(m);
    return m;
  }

  // 正在拿著（穿戴）的東西是不是道具
  function heldTool() {
    if (!engine.active || engine.mode !== 'wear') return null;
    const inst = engine.session.inst;
    const found = findTool(inst.partId, partOf);
    if (!found) return null;
    return { inst, tool: { ...found.tool, ...(override || {}) } };
  }

  // 槍口在哪：零件標了 userData.muzzle 就用它，不然用外框中心
  function muzzleOf(obj, target) {
    let m = null;
    obj.traverse((o) => {
      if (!m && o.userData?.muzzle?.isObject3D) m = o.userData.muzzle;
    });
    if (m) return m.getWorldPosition(target);
    return new THREE.Box3().setFromObject(obj).getCenter(target);
  }

  // 射一發：從槍口飛向準星（畫面中央）對到的那一點
  function fire(held) {
    const tool = held.tool;
    const start = muzzleOf(held.inst.object, new THREE.Vector3());
    ray.setFromCamera({ x: 0, y: 0 }, camera);
    const hits = ray.intersectObjects(hittables().map((h) => h.object), true);
    const aim = hits[0] ? hits[0].point.clone() : ray.ray.at(tool.range, new THREE.Vector3());
    const base = aim.clone().sub(start).normalize();
    for (let i = 0; i < tool.burst; i += 1) {
      const d = base.clone();
      if (tool.spread > 0 && tool.burst > 1) {
        d.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * tool.spread * 2);
        d.y += (Math.random() - 0.5) * tool.spread;
        d.normalize();
      }
      const mesh = acquireShot(tool);
      mesh.position.copy(start);
      mesh.lookAt(start.clone().add(d));
      shots.push({ mesh, pos: start.clone(), dir: d, speed: tool.speed, left: tool.range, remote: false, tool });
    }
    fired += 1;
    // 槍口閃光：一團很亮、很短的光（用發光貼片，不加燈，手機上不會多算光照）
    const flash = acquireFx(GEO.glow, matsFor(tool.color).flash);
    flash.position.copy(start);
    flash.userData = { kind: 'flash', life: 0.07, max: 0.07 };
    flash.scale.setScalar(0.05);
    sparks.push(flash);
    sfx?.fire();
    held.inst.object.traverse((o) => typeof o.userData?.onFire === 'function' && safe(() => o.userData.onFire()));
    onFire?.({ from: start.toArray(), to: start.clone().addScaledVector(base, Math.min(start.distanceTo(aim) + 1, tool.range)).toArray(), color: tool.color });
  }

  function safe(fn) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }

  // 命中：一團火花、一個白色閃光、幾片碎屑往外噴（數量有上限，用完收回）
  function impactFx(at, color, normal = null) {
    const m = matsFor(color);
    const flash = acquireFx(GEO.glow, m.flash);
    flash.position.copy(at);
    flash.userData = { kind: 'flash', life: 0.2, max: 0.2 };
    flash.scale.setScalar(0.06);
    sparks.push(flash);
    // 衝擊波：一圈光環朝鏡頭擴散
    const ring = acquireFx(GEO.ring, m.spark);
    ring.position.copy(at);
    ring.lookAt(camera.getWorldPosition(new THREE.Vector3()));
    ring.userData = { kind: 'ring', life: 0.3, max: 0.3 };
    ring.scale.setScalar(0.08);
    sparks.push(ring);
    const n = sparks.length > 120 ? 4 : 12;
    for (let i = 0; i < n; i += 1) {
      const sp = acquireFx(GEO.spark, i < 4 ? m.debris : m.spark);
      sp.position.copy(at);
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3 + 0.5, (Math.random() - 0.5) * 4);
      if (normal) v.addScaledVector(normal, 2);
      const size = i < 4 ? 0.06 : 0.045;
      sp.scale.setScalar(size);
      sp.userData = { kind: i < 4 ? 'debris' : 'spark', v, w: new THREE.Vector3(Math.random() * 12, Math.random() * 12, 0), life: 0.5 + Math.random() * 0.35, size };
      sparks.push(sp);
    }
  }

  function releaseShot(s) {
    s.mesh.removeFromParent();
    if (shotPool.length < 64) shotPool.push(s.mesh);
  }
  function releaseFx(m) {
    m.removeFromParent();
    if (fxPool.length < 160) fxPool.push(m);
  }

  function update(dt) {
    // 按 ⚡（或空白鍵）開火；按住連射
    const held = enabled ? heldTool() : null;
    cool = Math.max(0, cool - dt);
    if (held && cool === 0 && (engine.input.actionPressed || engine.input.actionHeld)) {
      fire(held);
      cool = 1 / held.tool.rate;
    }
    // 子彈：這一格從 a 飛到 b，中間碰到東西就算命中
    const targets = shots.some((s) => !s.remote) ? hittables() : [];
    for (let i = shots.length - 1; i >= 0; i -= 1) {
      const s = shots[i];
      const step = Math.min(s.speed * dt, s.left);
      _a.copy(s.pos);
      _b.copy(s.pos).addScaledVector(s.dir, step);
      let hit = null;
      if (!s.remote && targets.length) {
        ray.set(_a, s.dir);
        ray.far = step + s.tool.size;
        const list = ray.intersectObjects(targets.map((h) => h.object), true);
        if (list[0]) {
          const o = list[0].object;
          const owner = targets.find((h) => {
            for (let p = o; p; p = p.parent) if (p === h.object) return true;
            return false;
          });
          if (owner) hit = { owner, point: list[0].point, normal: list[0].face?.normal?.clone().transformDirection(o.matrixWorld) || null };
        }
        ray.far = Infinity;
      }
      s.pos.copy(_b);
      s.left -= step;
      s.mesh.position.copy(s.pos);
      if (hit) {
        impactFx(hit.point, s.tool.color, hit.normal);
        sfx?.hit();
        hit.owner.object.traverse((o) => typeof o.userData?.onHit === 'function' && safe(() => o.userData.onHit()));
        onHit?.({ ...hit.owner, point: hit.point.toArray(), dir: s.dir.toArray(), tool: s.tool });
      }
      if (hit || s.left <= 1e-4 || s.pos.y < -0.5) {
        if (!hit && s.pos.y < 0.05) impactFx(s.pos, s.tool.color);
        if (s.remote && s.left <= 1e-4) impactFx(s.pos, s.tool.color);
        releaseShot(s);
        shots.splice(i, 1);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const m = sparks[i];
      const u = m.userData;
      u.life -= dt;
      if (u.kind === 'flash') {
        const k = Math.max(0, u.life / u.max);
        m.scale.setScalar(0.06 + (1 - k) * 0.5 * k * 4);
      } else if (u.kind === 'ring') {
        const k = Math.max(0, u.life / u.max);
        m.scale.setScalar(0.08 + (1 - k) * 0.7);
      } else {
        u.v.y -= 9 * dt;
        m.position.addScaledVector(u.v, dt);
        if (m.position.y < 0.01) {
          m.position.y = 0.01;
          u.v.multiplyScalar(0.4);
          u.v.y = Math.abs(u.v.y) * 0.3;
        }
        m.rotation.x += u.w.x * dt;
        m.rotation.y += u.w.y * dt;
        m.scale.setScalar(u.size * Math.min(1, u.life * 3));
      }
      if (u.life <= 0) {
        releaseFx(m);
        sparks.splice(i, 1);
      }
    }
  }

  return {
    update,
    heldTool,
    // 別人射的子彈：只畫出來（命中由射的人那邊判定，伺服器確認）
    remoteShot({ from, to, color }) {
      if (!Array.isArray(from) || !Array.isArray(to)) return;
      const tool = { ...TOOL_KINDS.blaster, color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : TOOL_KINDS.blaster.color };
      const a = new THREE.Vector3(...from);
      const b = new THREE.Vector3(...to);
      const d = b.clone().sub(a);
      const len = d.length();
      if (!(len > 0.01)) return;
      d.normalize();
      const mesh = acquireShot(tool);
      mesh.position.copy(a);
      mesh.lookAt(b);
      shots.push({ mesh, pos: a, dir: d, speed: tool.speed, left: Math.min(len, tool.range), remote: true, tool });
    },
    // 遊戲設定改了道具（顏色、射速）：也把槍的發光部分換顏色
    setOverride(o, obj) {
      override = o ? { ...o } : null;
      if (obj && o?.color) {
        obj.traverse((m) => {
          for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) {
            if (!mat.userData?.toolGlow) continue;
            mat.color.set(o.color);
            if (mat.emissive) mat.emissive.set(o.color);
          }
        });
      }
    },
    set enabled(v) {
      enabled = !!v;
    },
    get count() {
      return shots.length;
    },
    get fired() {
      return fired;
    },
    // 檢查資源有沒有一直累積（測試用）
    get pooled() {
      return { shots: shots.length, sparks: sparks.length, shotPool: shotPool.length, fxPool: fxPool.length, colors: mats.size };
    },
  };
}
