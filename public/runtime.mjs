// 零件組裝核心：瀏覽器（app.js）和 Node 驗證（validate.mjs）共用同一份，
// 確保「驗證通過」和「工坊裡看到的」是同一套組裝規則。
//
// 零件有兩種：
//   generated — Codex 寫的 part.js（export default function build(ctx)）
//   composite — 使用者把幾個物件疊好後「存成零件」，記錄子零件與相對位置
// 兩種都能互相套用（ctx.spawn / composite.children），套層有上限避免無限遞迴。

export const LIMITS = { maxDepth: 8, maxSpawns: 600 };

export function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACEHOLDER_COLORS = { missing: 0x8a8f98, depth: 0xffc23d, budget: 0xffc23d, error: 0xff4d5e };

export function makePlaceholder(THREE, kind = 'missing') {
  const group = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
  geo.translate(0, 0.2, 0);
  const mat = new THREE.MeshBasicMaterial({ color: PLACEHOLDER_COLORS[kind] ?? 0x8a8f98, wireframe: true });
  group.add(new THREE.Mesh(geo, mat));
  group.userData.placeholder = kind;
  return group;
}

export function createRuntime({ THREE, player }) {
  const parts = new Map(); // id -> part record
  const modules = new Map(); // id -> build function

  function libraryView() {
    return [...parts.values()].map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      size: p.size,
      description: p.description,
    }));
  }

  function resolve(ref) {
    if (ref == null) return null;
    const key = String(ref).trim();
    if (parts.has(key)) return key;
    let found = null;
    for (const p of parts.values()) if (p.name === key) found = p.id; // 同名取最新
    if (found) return found;
    const lower = key.toLowerCase();
    for (const p of parts.values()) if (String(p.name).toLowerCase() === lower) found = p.id;
    return found;
  }

  function build(id, state, seed) {
    const rec = parts.get(id);
    if (!rec) {
      state.warnings.push(`找不到零件 ${id}`);
      return makePlaceholder(THREE, 'missing');
    }
    if (state.depth > LIMITS.maxDepth) {
      if (!state.depthWarned) state.warnings.push(`套層超過 ${LIMITS.maxDepth} 層，更深的部分先不做`);
      state.depthWarned = true;
      return makePlaceholder(THREE, 'depth');
    }
    state.spawns += 1;
    if (state.spawns > LIMITS.maxSpawns) {
      if (!state.budgetWarned) state.warnings.push(`物件超過 ${LIMITS.maxSpawns} 個，後面的先不做`);
      state.budgetWarned = true;
      return makePlaceholder(THREE, 'budget');
    }

    let obj;
    if (rec.kind === 'composite') {
      obj = new THREE.Group();
      (rec.children || []).forEach((c, i) => {
        state.depth += 1;
        const child = build(c.partId, state, (seed + (i + 1) * 7919) >>> 0);
        state.depth -= 1;
        child.position.fromArray(c.position);
        child.quaternion.fromArray(c.quaternion);
        child.scale.fromArray(c.scale);
        obj.add(child);
      });
    } else {
      const fn = modules.get(id);
      if (!fn) {
        state.warnings.push(`零件「${rec.name}」的程式還沒載入`);
        return makePlaceholder(THREE, 'missing');
      }
      let spawnIndex = 0;
      const ctx = {
        THREE,
        player,
        random: mulberry32(seed),
        get library() {
          return (state.libraryCache ??= libraryView());
        },
        spawn(ref) {
          const target = resolve(ref);
          if (!target) {
            state.warnings.push(`spawn 找不到「${ref}」`);
            state.missingSpawns.push(String(ref));
            return null;
          }
          spawnIndex += 1;
          state.depth += 1;
          try {
            return build(target, state, (seed ^ Math.imul(spawnIndex, 2654435761)) >>> 0);
          } finally {
            state.depth -= 1;
          }
        },
      };
      try {
        const out = fn(ctx);
        obj = out?.isObject3D ? out : out?.object?.isObject3D ? out.object : null;
        if (!obj) throw new Error('build() 必須回傳 THREE.Object3D');
        if (!out.isObject3D && typeof out.update === 'function' && !obj.userData.update) {
          obj.userData.update = out.update;
        }
      } catch (e) {
        state.errors.push(`${rec.name}：${e?.message || e}`);
        obj = makePlaceholder(THREE, 'error');
      }
    }
    obj.userData.partId = id;
    return obj;
  }

  function collectUpdaters(root) {
    const list = [];
    root.traverse((o) => {
      if (typeof o.userData?.update === 'function') list.push({ obj: o, fn: o.userData.update, dead: false });
    });
    return list;
  }

  return {
    THREE,
    player,
    parts,
    modules,
    LIMITS,
    resolve,
    setLibrary(list) {
      parts.clear();
      for (const p of list) parts.set(p.id, p);
    },
    addPart(rec) {
      parts.set(rec.id, rec);
    },
    registerModule(id, mod) {
      const fn = typeof mod === 'function' ? mod : mod?.default;
      if (typeof fn !== 'function') throw new Error('part.js 必須 export default function build(ctx)');
      modules.set(id, fn);
    },
    instantiate(id, { seed } = {}) {
      const state = {
        depth: 0,
        spawns: 0,
        warnings: [],
        errors: [],
        missingSpawns: [],
        libraryCache: null,
      };
      const object = build(id, state, seed ?? hashString(id));
      return {
        object,
        updaters: collectUpdaters(object),
        warnings: state.warnings,
        errors: state.errors,
        missingSpawns: state.missingSpawns,
        spawns: state.spawns,
      };
    },
  };
}
