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

export function createTools({ THREE, scene, camera, engine, partOf, hittables, onFire, onHit, now = () => performance.now() / 1000 }) {
  const shots = [];
  const sparks = [];
  const ray = new THREE.Raycaster();
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  let cool = 0;
  let fired = 0; // 總共射了幾發（測試和統計用）
  let override = null; // 遊戲設定改過的道具參數（顏色、射速）
  let enabled = true;

  // 正在拿著（穿戴）的東西是不是道具
  function heldTool() {
    if (!engine.active || engine.mode !== 'wear') return null;
    const inst = engine.session.inst;
    const found = findTool(inst.partId, partOf);
    if (!found) return null;
    return { inst, tool: { ...found.tool, ...(override || {}) } };
  }

  // 槍口在哪：零件標了 userData.muzzle 就用它，不然用外框最前面
  function muzzleOf(obj, target) {
    let m = null;
    obj.traverse((o) => {
      if (!m && o.userData?.muzzle?.isObject3D) m = o.userData.muzzle;
    });
    if (m) return m.getWorldPosition(target);
    const box = new THREE.Box3().setFromObject(obj);
    return box.getCenter(target);
  }

  function projectileMesh(tool) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(tool.size, 12, 8), new THREE.MeshBasicMaterial({ color: tool.color }));
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(tool.size * 2.2, 12, 8),
      new THREE.MeshBasicMaterial({ color: tool.color, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const trail = new THREE.Mesh(
      new THREE.CylinderGeometry(tool.size * 0.6, 0.001, tool.size * 9, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: tool.color, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    trail.rotation.x = -Math.PI / 2;
    trail.position.z = -tool.size * 4.5;
    g.add(core, glow, trail);
    return g;
  }

  // 射一發：從槍口飛向準星（畫面中央）對到的那一點
  function fire(held, { remote = false, from = null, to = null } = {}) {
    const tool = held.tool;
    const start = from ? new THREE.Vector3(...from) : muzzleOf(held.inst.object, new THREE.Vector3());
    let aim;
    if (to) aim = new THREE.Vector3(...to);
    else {
      ray.setFromCamera({ x: 0, y: 0 }, camera);
      const hits = ray.intersectObjects(hittables().map((h) => h.object), true);
      aim = hits[0] ? hits[0].point.clone() : ray.ray.at(tool.range, new THREE.Vector3());
    }
    const dirs = [];
    const base = aim.clone().sub(start).normalize();
    for (let i = 0; i < tool.burst; i += 1) {
      const d = base.clone();
      if (tool.spread > 0 && tool.burst > 1) {
        d.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * tool.spread * 2);
        d.y += (Math.random() - 0.5) * tool.spread;
        d.normalize();
      }
      dirs.push(d);
    }
    for (const d of dirs) {
      const mesh = projectileMesh(tool);
      mesh.position.copy(start);
      mesh.lookAt(start.clone().add(d));
      scene.add(mesh);
      shots.push({ mesh, pos: start.clone(), dir: d, speed: tool.speed, left: tool.range, remote, tool });
    }
    if (!remote) {
      fired += 1;
      held.inst.object.traverse((o) => typeof o.userData?.onFire === 'function' && safe(() => o.userData.onFire()));
      onFire?.({ from: start.toArray(), to: start.clone().addScaledVector(base, Math.min(start.distanceTo(aim) + 1, tool.range)).toArray(), color: tool.color });
    }
  }

  function safe(fn) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }

  function burstFx(at, color) {
    for (let i = 0; i < 14; i += 1) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 6, 4),
        new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.position.copy(at);
      m.userData = { v: new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4), life: 0.5 + Math.random() * 0.3 };
      scene.add(m);
      sparks.push(m);
    }
  }

  function dispose(o) {
    o.removeFromParent();
    o.traverse((c) => {
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    });
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
    const targets = shots.length ? hittables() : [];
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
          let o = list[0].object;
          const owner = targets.find((h) => {
            for (let p = o; p; p = p.parent) if (p === h.object) return true;
            return false;
          });
          if (owner) hit = { owner, point: list[0].point };
        }
        ray.far = Infinity;
      }
      s.pos.copy(_b);
      s.left -= step;
      s.mesh.position.copy(s.pos);
      if (hit) {
        burstFx(hit.point, s.tool.color);
        hit.owner.object.traverse((o) => typeof o.userData?.onHit === 'function' && safe(() => o.userData.onHit()));
        onHit?.({ ...hit.owner, point: hit.point.toArray(), dir: s.dir.toArray(), tool: s.tool });
      }
      if (hit || s.left <= 1e-4 || s.pos.y < -0.5) {
        if (!hit && s.pos.y < 0.05) burstFx(s.pos, s.tool.color);
        dispose(s.mesh);
        shots.splice(i, 1);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i -= 1) {
      const m = sparks[i];
      const u = m.userData;
      u.life -= dt;
      u.v.y -= 9 * dt;
      m.position.addScaledVector(u.v, dt);
      m.material.opacity = Math.max(0, u.life * 2);
      if (u.life <= 0) {
        dispose(m);
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
      const mesh = projectileMesh(tool);
      mesh.position.copy(a);
      mesh.lookAt(b);
      scene.add(mesh);
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
  };
}
