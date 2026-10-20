// 作品包影子試跑：在 Deno 裡、不給任何權限執行（讀寫檔、網路、環境變數、子程序都會被擋）。
// 這支檔案是受信任的外殼：玩家的作品程式不當主模組、不被靜態 import，只在執行期用 blob: 載入（零權限讀不到本機檔）。
// stdin：{ code, manifest, prev: null | { code, manifest } }
// stdout：{ ok, diagnostics: [中文說明], stats: { initMs, tickMsAvg, tickMsMax, entitiesMax, stateBytes, migrated } }
// 規則與 public/sandbox-host.mjs、docs/creation-sdk.md 一致；通過只代表「在假世界、有限步數內沒出錯、沒超預算」，不代表程式安全。
const SHAPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'text']);
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_STATE = 64 * 1024;
const out = { ok: false, diagnostics: [], stats: { initMs: 0, tickMsAvg: 0, tickMsMax: 0, entitiesMax: 0, stateBytes: 0, migrated: false } };
const fail = (m) => out.diagnostics.length < 20 && out.diagnostics.push(String(m).slice(0, 400));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 例外訊息＋作品程式裡的行號（blob URL 的那一段）
function where(e) {
  const m = String(e?.stack || '').match(/blob:[^\s)]*:(\d+):(\d+)/);
  return `${e?.name || 'Error'}：${String(e?.message ?? e).slice(0, 240)}${m ? `（main.js 第 ${m[1] - 1} 行第 ${m[2]} 欄）` : ''}`;
}

async function load(code, label) {
  let def = null;
  let calls = 0;
  globalThis.vibe = {
    define(d) {
      calls += 1;
      def = d;
    },
    random: rng(12345),
  };
  // 跟瀏覽器沙盒一樣包一層函式（作品看不到外殼的變數；頂層 await／import／export 在兩邊都一樣不能用）
  const url = URL.createObjectURL(new Blob([`(function (vibe) { 'use strict';\n${code}\n})(globalThis.vibe);`], { type: 'text/javascript' }));
  try {
    await import(url);
  } catch (e) {
    throw new Error(`${label}載入失敗：${where(e)}`);
  } finally {
    URL.revokeObjectURL(url);
  }
  if (calls !== 1) throw new Error(`${label}要剛好呼叫一次 vibe.define（實際 ${calls} 次）`);
  if (!def || typeof def !== 'object') throw new Error(`${label}的 vibe.define 要傳入一個物件`);
  for (const k of ['init', 'tick', 'view']) if (typeof def[k] !== 'function') throw new Error(`${label}缺少 ${k}() 函式`);
  for (const k of ['hud', 'onEvent', 'migrate', 'snapshot', 'dispose']) if (def[k] != null && typeof def[k] !== 'function') throw new Error(`${label}的 ${k} 要是函式`);
  return def;
}

function checkState(state, what) {
  if (state === null || typeof state !== 'object') throw new Error(`${what}要回傳一個物件（state），實際是 ${state === null ? 'null' : typeof state}`);
  let s;
  try {
    s = JSON.stringify(state);
  } catch (e) {
    throw new Error(`${what}的 state 不能轉成 JSON：${where(e)}`);
  }
  const bytes = new TextEncoder().encode(s).length;
  if (bytes > MAX_STATE) throw new Error(`${what}的 state 太大（${bytes} bytes，上限 ${MAX_STATE}）`);
  out.stats.stateBytes = Math.max(out.stats.stateBytes, bytes);
  return JSON.parse(s);
}

function checkView(list, budget, step) {
  if (!Array.isArray(list)) throw new Error(`view() 要回傳陣列（第 ${step} 步）`);
  if (list.length > budget) throw new Error(`view() 回傳 ${list.length} 個實體，超過上限 ${budget}（第 ${step} 步）`);
  const ids = new Set();
  for (const e of list) {
    const tag = `實體 ${JSON.stringify(e?.id)}（第 ${step} 步）`;
    if (!e || typeof e !== 'object') throw new Error(`view() 裡有不是物件的東西（第 ${step} 步）`);
    if (typeof e.id !== 'string' || !e.id || e.id.length > 40) throw new Error(`${tag}：id 要是 1–40 字的字串`);
    if (ids.has(e.id)) throw new Error(`${tag}：id 重複`);
    ids.add(e.id);
    if (!SHAPES.has(e.shape)) throw new Error(`${tag}：shape 只能是 ${[...SHAPES].join('、')}`);
    if (!Array.isArray(e.pos) || e.pos.length !== 3 || !e.pos.every((v) => Number.isFinite(v) && Math.abs(v) <= 50)) throw new Error(`${tag}：pos 要是 [x,y,z]，每個是 ±50 以內的數字`);
    if (e.rot != null && !(Array.isArray(e.rot) && e.rot.length === 3 && e.rot.every(Number.isFinite))) throw new Error(`${tag}：rot 要是 [x,y,z] 數字`);
    if (e.size != null && !(Array.isArray(e.size) && e.size.length >= 1 && e.size.length <= 3 && e.size.every((v) => Number.isFinite(v) && v > 0 && v <= 20))) throw new Error(`${tag}：size 要是 1–3 個 0–20 之間的正數`);
    for (const c of ['color', 'emissive']) if (e[c] != null && !HEX.test(e[c])) throw new Error(`${tag}：${c} 要是 #rrggbb`);
    if (e.opacity != null && !(Number.isFinite(e.opacity) && e.opacity >= 0 && e.opacity <= 1)) throw new Error(`${tag}：opacity 要在 0–1`);
    if (e.shape === 'text' && (typeof e.text !== 'string' || e.text.length > 40)) throw new Error(`${tag}：text 實體要有 40 字以內的 text`);
  }
  out.stats.entitiesMax = Math.max(out.stats.entitiesMax, list.length);
  return list;
}

function checkHud(lines, step) {
  if (lines == null) return;
  if (!Array.isArray(lines) || lines.length > 4 || !lines.every((l) => typeof l === 'string' && l.length <= 60)) throw new Error(`hud() 要回傳最多 4 行、每行 60 字以內的字串陣列（第 ${step} 步）`);
}

// 跑 n 步：假輸入（方向鍵輪流按、玩家繞圈走），每 5 步看一次 view／hud，偶爾點一下實體
function run(def, state, n, budget, label) {
  const r = rng(99);
  let tickTotal = 0;
  let lastIds = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / 30;
    const input = {
      t,
      keys: { left: (i >> 4) % 4 === 0, right: (i >> 4) % 4 === 2, up: (i >> 5) % 2 === 0, down: false, action: i % 37 < 3 },
      player: { x: Math.sin(t) * 2, y: 1.6, z: 4 + Math.cos(t) },
    };
    const t0 = performance.now();
    let next;
    try {
      next = def.tick(state, 1 / 30, input);
    } catch (e) {
      throw new Error(`${label}tick() 第 ${i} 步出錯：${where(e)}`);
    }
    const ms = performance.now() - t0;
    tickTotal += ms;
    out.stats.tickMsMax = Math.max(out.stats.tickMsMax, ms);
    if (next !== undefined) state = next;
    if (i % 5 === 0 || i === n) {
      try {
        lastIds = checkView(def.view(state), budget, i).map((e) => e.id);
        if (def.hud) checkHud(def.hud(state), i);
      } catch (e) {
        throw new Error(`${label}${e.message.startsWith('view()') || e.message.startsWith('實體') || e.message.startsWith('hud()') ? e.message : `view()/hud() 第 ${i} 步出錯：${where(e)}`}`);
      }
    }
    if (def.onEvent && i % 23 === 0 && lastIds.length) {
      const ev = r() < 0.7 ? { type: 'click', target: lastIds[Math.floor(r() * lastIds.length)], by: 'pointer' } : { type: 'key', key: 'action', down: true };
      try {
        const n2 = def.onEvent(state, ev);
        if (n2 !== undefined) state = n2;
      } catch (e) {
        throw new Error(`${label}onEvent(${ev.type}) 第 ${i} 步出錯：${where(e)}`);
      }
    }
    if (i % 60 === 0) state = checkState(def.snapshot ? def.snapshot(state) : state, `${label}snapshot()（第 ${i} 步）`);
  }
  out.stats.tickMsAvg = Math.max(out.stats.tickMsAvg, tickTotal / n);
  return state;
}

try {
  const input = JSON.parse(await new Response(Deno.stdin.readable).text());
  const m = input.manifest || {};
  const budget = Math.min(300, Number.isFinite(m.budgets?.entities) ? m.budgets.entities : 120);
  let def = await load(String(input.code || ''), '');
  let state;
  let ps = null;
  const pm = input.prev?.manifest || {};
  if (input.prev?.code) {
    // 換版：先用上一版跑出一份真實的存檔，再交給新版（stateSchema 不同就一定要有 migrate）。
    // 上一版自己就跑不過（例如壞掉的那一版）：略過換版測試，不讓新版永遠過不了
    try {
      const pdef = await load(String(input.prev.code), '上一版');
      ps = checkState(pdef.init({ seed: 7 }), '上一版 init()');
      ps = run(pdef, ps, 90, Math.min(300, pm.budgets?.entities ?? 120), '上一版 ');
      ps = checkState(pdef.snapshot ? pdef.snapshot(ps) : ps, '上一版 snapshot()');
    } catch (e) {
      out.stats.prevSkipped = String(e.message || e).slice(0, 200);
      ps = null;
    }
    out.stats.tickMsAvg = 0;
    out.stats.tickMsMax = 0;
    def = await load(String(input.code || ''), ''); // 重新載入新版（上一版載入時換掉了 globalThis.vibe）
  }
  if (ps) {
    globalThis.vibe.random = rng(12345);
    if (pm.stateSchema !== m.stateSchema) {
      if (!def.migrate) throw new Error(`stateSchema 從 ${pm.stateSchema} 變成 ${m.stateSchema}，要寫 migrate(old, fromSchema) 把舊存檔轉過來`);
      try {
        state = checkState(def.migrate(ps, pm.stateSchema), 'migrate()');
      } catch (e) {
        throw new Error(e.message.startsWith('migrate()') ? e.message : `migrate() 出錯：${where(e)}`);
      }
      out.stats.migrated = true;
    } else state = ps;
    state = run(def, state, 120, budget, '（接續上一版存檔）');
  }
  const t0 = performance.now();
  let fresh;
  try {
    fresh = def.init({ seed: 1 });
  } catch (e) {
    throw new Error(`init() 出錯：${where(e)}`);
  }
  out.stats.initMs = performance.now() - t0;
  fresh = checkState(fresh, 'init()');
  fresh = run(def, fresh, 300, budget, '');
  if (out.stats.tickMsAvg > 4) throw new Error(`tick() 太慢：平均每步 ${out.stats.tickMsAvg.toFixed(1)} ms（上限 4 ms）`);
  try {
    def.dispose?.(fresh);
  } catch (e) {
    throw new Error(`dispose() 出錯：${where(e)}`);
  }
  out.ok = true;
} catch (e) {
  fail(e?.message || e);
}
console.log(JSON.stringify(out));
