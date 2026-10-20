// 世界模組宿主：瀏覽器（worlds.mjs）和 Node 驗收（validate.mjs）共用同一份。
// 世界模組＝Codex 寫的 world.js：export default function install(world) { ...; return { update, dispose } }
// 宿主負責：給模組一組受控的 API、記下它放進場景的每樣東西、出錯或太耗效能就自動拔掉並清乾淨，
// 所以模組寫壞只會壞它自己，世界其他部分照常運作。

import { mulberry32, hashString } from './runtime.mjs';

export const WORLD_LIMITS = { maxFrameMs: 8, warmupFrames: 90, toastGapMs: 2000 };
export const ENV_METHODS = ['background', 'fog', 'ground', 'grid', 'pad', 'hemi', 'sun', 'exposure', 'reflections'];
// 沒有物理引擎時給模組的介面：什麼都不做，但呼叫不會出錯
const NO_PHYSICS = Object.freeze({
  enabled: false,
  gravity: () => -9.81,
  material: () => {},
  push: () => {},
  velocity: () => [0, 0, 0],
  setVelocity: () => {},
});

function disposeTree(obj) {
  obj.traverse?.((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose?.();
  });
}

export function createWorldHost({ THREE, root, env, objects, supportBelow, player, vehicle, physics, hud, toast, onError, now }) {
  const active = new Map(); // id -> entry

  // 拔掉出錯的模組，再通知外層（外層決定要不要退回上一版）
  function fail(entry, err, why) {
    uninstall(entry.rec.id);
    onError?.(entry.rec, err, why);
  }

  // 模組交給引擎的函式（例如開車時的鉤子）也要包起來：出錯就整個模組拔掉
  function guard(entry, fn) {
    return (...args) => {
      if (!active.has(entry.rec.id)) return undefined;
      try {
        return fn(...args);
      } catch (e) {
        fail(entry, e, 'error');
        return undefined;
      }
    };
  }

  function makeApi(entry) {
    const { rec } = entry;
    const envApi = {};
    for (const m of ENV_METHODS) {
      envApi[m] = (...args) => {
        if (rec.type !== 'environment') {
          entry.envRefused += 1; // 規則模組不能改環境（環境只能有一個主人，拔掉時才還原得回去）
          return;
        }
        env[m](...args);
      };
    }
    let lastToast = -Infinity;
    return {
      THREE,
      add(o) {
        if (o && o.isObject3D) {
          root.add(o);
          entry.added.add(o);
        }
        return o;
      },
      remove(o) {
        if (!entry.added.has(o)) return;
        o.removeFromParent();
        entry.added.delete(o);
        disposeTree(o);
      },
      env: envApi,
      objects: () => objects(),
      supportBelow: (h) => supportBelow(h),
      player: { position: player.position, forward: () => player.forward() },
      vehicle: {
        tune: (partial) => vehicle.tune(rec.id, partial),
        onUpdate: (fn) => {
          if (typeof fn === 'function') vehicle.onUpdate(rec.id, guard(entry, fn));
        },
      },
      physics: physics ? physics.apiFor(rec.id) : NO_PHYSICS,
      hud: (text) => hud(rec.id, text == null ? '' : String(text).slice(0, 80)),
      toast: (text) => {
        const t = now();
        if (t - lastToast < WORLD_LIMITS.toastGapMs) return;
        lastToast = t;
        toast(String(text).slice(0, 120));
      },
      random: mulberry32(hashString(rec.id)),
    };
  }

  function install(rec, mod) {
    if (active.has(rec.id)) uninstall(rec.id);
    const fn = typeof mod === 'function' ? mod : mod?.default;
    if (typeof fn !== 'function') return { ok: false, error: 'world.js 必須 export default function install(world)' };
    const entry = { rec, added: new Set(), ret: {}, ms: 0, frames: 0, startedAt: null, envRefused: 0 };
    active.set(rec.id, entry);
    entry.api = makeApi(entry);
    try {
      const out = fn(entry.api);
      entry.ret = out && typeof out === 'object' ? out : {};
    } catch (e) {
      uninstall(rec.id);
      return { ok: false, error: e?.message || String(e) };
    }
    return { ok: true };
  }

  function uninstall(id) {
    const entry = active.get(id);
    if (!entry) return false;
    active.delete(id);
    try {
      entry.ret?.dispose?.();
    } catch {
      /* 收尾出錯也照樣清乾淨 */
    }
    for (const o of entry.added) {
      o.removeFromParent();
      disposeTree(o);
    }
    entry.added.clear();
    vehicle.clear(id);
    physics?.clearModule(id); // 模組改的重力、摩擦力跟著拔掉
    hud(id, '');
    if (entry.rec.type === 'environment') env.reset();
    return true;
  }

  function update(dt, t) {
    for (const entry of [...active.values()]) {
      if (!active.has(entry.rec.id)) continue;
      const upd = entry.ret.update;
      if (typeof upd !== 'function') continue;
      if (entry.startedAt === null) entry.startedAt = t;
      const t0 = now();
      try {
        upd.call(entry.ret, dt, t - entry.startedAt);
      } catch (e) {
        fail(entry, e, 'error');
        continue;
      }
      const ms = now() - t0;
      entry.frames += 1;
      entry.ms = entry.frames === 1 ? ms : entry.ms * 0.9 + ms * 0.1;
      if (entry.frames > WORLD_LIMITS.warmupFrames && entry.ms > WORLD_LIMITS.maxFrameMs) {
        fail(entry, new Error(`每一格要花 ${entry.ms.toFixed(1)} ms`), 'slow');
      }
    }
  }

  return {
    install,
    uninstall,
    uninstallAll() {
      for (const id of [...active.keys()]) uninstall(id);
    },
    update,
    isActive: (id) => active.has(id),
    activeIds: () => [...active.keys()],
    entry: (id) => active.get(id),
  };
}
