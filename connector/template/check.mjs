#!/usr/bin/env node
// 作品包本機自查（vibe-pkg/1）：node check.mjs [作品資料夾] [--base 舊版資料夾]
// Codex 在工作資料夾裡直接跑 `node check.mjs`；創作者也可以拿來檢查任何一個作品資料夾（裡面要有 manifest.json、main.js）。
// 順序跟伺服器的影子試跑（server/shadow-harness.js）一樣：
//   載入 main.js → 有舊版就先跑舊版 90 步、存檔、（stateSchema 變了）migrate、新版接著跑 120 步 →
//   新的實例 init → 300 步 tick（假輸入：方向鍵輪流按、偶爾 action、玩家繞著走；每 5 步看 view／hud；偶爾點實體或按鍵；每 60 步存檔再讀回）。
// 另外多查：manifest 格式、禁用的 API、最上層的可變變數、輸入有沒有作用、存檔重開（新的執行環境）後能不能接著跑。
// 舊版從哪裡來：--base 資料夾，或作品資料夾裡 job.json 的 target（修改既有作品時 connector 會放進去）。
// ⚠ 這不是安全邊界：用 Node 內建 vm 在同一個程序裡跑（vm 擋不住惡意程式），只是讓錯誤早點出現、訊息清楚；
//   真正的關卡是伺服器的 Deno 零權限影子試跑，和瀏覽器的 sandbox iframe／Worker。
import vm from 'node:vm';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const LIMIT = {
  manifestBytes: 4 * 1024,
  codeBytes: 64 * 1024,
  stateBytes: 64 * 1024,
  entitiesDefault: 120,
  entitiesMax: 300,
  idChars: 40,
  textChars: 40,
  hudLines: 4,
  hudChars: 60,
  posAbs: 50,
  sizeMax: 20,
  tickMsAvg: 4, // 平均每步 tick 的上限（跟伺服器一樣）
  callMs: 1000, // 單次呼叫超過就當成卡住
  tickMsTotal: 4000, // 全部 tick 加起來超過就提早停
};
const STEPS = 300; // 新實例試跑步數（跟伺服器一樣）
const PREV_STEPS = 90; // 換版測試：舊版先跑幾步再存檔
const AFTER_STEPS = 120; // 換版測試：新版接著跑幾步
const RESTORE_AT = 150; // 存檔重開測試：第幾步存檔
const RESTORE_STEPS = 60; // 存檔重開後接著跑幾步
const SIZE_LEN = { box: 3, sphere: 1, cylinder: 2, cone: 2, torus: 2, plane: 2, text: 1 };
const SIZE_HINT = { box: '[寬, 高, 深]', sphere: '[半徑]', cylinder: '[半徑, 高]', cone: '[半徑, 高]', torus: '[半徑, 管徑]', plane: '[寬, 高]', text: '[字高]' };
const ENTITY_KEYS = new Set(['id', 'shape', 'pos', 'rot', 'size', 'color', 'emissive', 'opacity', 'text']);
const DEFINE_KEYS = ['init', 'tick', 'view', 'hud', 'onEvent', 'migrate', 'snapshot', 'dispose'];
const MANIFEST_KEYS = new Set(['format', 'name', 'description', 'stateSchema', 'budgets']);
const HEX = /^#[0-9a-fA-F]{6}$/;

// 只是提示（伺服器和瀏覽器會真的擋）：在去掉註解與字串之後的程式裡找
const FORBIDDEN = [
  [/\bimport\s*\(/, 'import()：不能載入其他程式，全部寫在 main.js'],
  [/(?<![.\w$])require\s*\(/, 'require()：沒有模組系統，全部寫在 main.js'],
  [/(?<![.\w$])(?:fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\b/, '連網／載入程式（fetch、XMLHttpRequest、WebSocket、importScripts）：作品不能連網'],
  [/(?<![.\w$])eval\s*\(|\bnew\s+Function\b|(?<![.\w$])Function\s*\(/, 'eval／new Function：不能把字串當程式執行'],
  [/(?<![.\w$])(?:setTimeout|setInterval|setImmediate|requestAnimationFrame|queueMicrotask)\b/, '計時器：時間請用 tick 的 dt 自己累計（存在 state 裡）'],
  [/(?<![.\w$])(?:async|await|Promise)\b/, '非同步（async／await／Promise）：每個函式都要同步做完'],
  [/(?<![.\w$])(?:document|window|globalThis|self|navigator|location|localStorage|sessionStorage|indexedDB|postMessage|Worker|process|Deno)\b(?!\s*:)/, '頁面／執行環境的全域物件（document、window、globalThis、self、localStorage…）：作品只能用 vibe 和標準 JavaScript'],
  [/\bMath\s*\.\s*random\b/, 'Math.random：隨機請用 vibe.random()（每個實例有自己的種子，存檔重開一致）'],
];
const DISCOURAGED = [[/(?<![.\w$])Date\b/, 'Date：時間請用 input.t 或自己累計 dt——用現實時間會讓存檔重開、換版後的結果對不上']];

const USAGE = `用法：node check.mjs [作品資料夾（預設：目前資料夾）] [--base 舊版作品資料夾]
  作品資料夾裡要有 manifest.json 和 main.js；有 job.json 的 target（修改既有作品）時，會自動拿它當舊版做換版測試。`;

const errors = [];
const warnings = [];
const passed = [];
const warned = new Set();
const newStats = () => ({ ticks: 0, tickMs: 0, tickMax: 0, entitiesMax: 0, hudMax: 0, events: 0 });
const stats = newStats(); // 新實例那 300 步的統計
let maxStateBytes = 0;

class Stop extends Error {} // 試跑中斷（後面的步驟要靠前面的 state，所以第一個執行期錯誤就停）
const fail = (msg) => {
  throw new Stop(msg);
};
const warn = (msg, key = msg) => {
  if (warned.has(key)) return;
  warned.add(key);
  warnings.push(msg);
};
const kb = (n) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);
const short = (v, n = 80) => {
  let s;
  try {
    s = JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? `‹${x}›` : x)); // NaN、Infinity 照原樣顯示
  } catch {
    s = String(v);
  }
  s = s === undefined ? 'undefined' : s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? '陣列' : typeof v);

// ---------------- 靜態檢查 ----------------

// 把註解、字串、樣板字串的內容換成空白（保留換行，行號才對得上），免得字串裡的字被當成程式
function stripCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (c !== '`' && src[i] === '\n') break; // 沒關好的字串：交給語法檢查
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

// 最上層（不在任何 { } ( ) [ ] 裡）的 let／var
function topLevelVars(bare) {
  const out = [];
  let depth = 0;
  let line = 1;
  for (let i = 0; i < bare.length; i += 1) {
    const c = bare[i];
    if (c === '\n') line += 1;
    else if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (depth === 0 && (c === 'l' || c === 'v') && !/[\w$.]/.test(bare[i - 1] || ' ')) {
      const m = /^(let|var)\s+([A-Za-z_$][\w$]*|[{[])/.exec(bare.slice(i, i + 80));
      if (m) out.push({ line, kw: m[1], name: m[2] });
    }
  }
  return out;
}

function staticChecks(code) {
  const errs = [];
  const ie = /^[ \t]*(import|export)\b/m.exec(code);
  if (ie) errs.push(`main.js 第 ${lineAt(code, ie.index)} 行用 ${ie[1]} 開頭：main.js 是一般腳本，不能有 import／export（伺服器連註解、字串裡行首的 import／export 也會擋）`);
  if (!/\bvibe\.define\s*\(/.test(code)) errs.push('main.js 要呼叫 vibe.define({ init, tick, view, … })');
  const bare = stripCode(code);
  for (const [re, why] of FORBIDDEN) {
    const m = re.exec(bare);
    if (m) errs.push(`main.js 第 ${lineAt(bare, m.index)} 行：${why}`);
  }
  for (const [re, why] of DISCOURAGED) {
    const m = re.exec(bare);
    if (m) warn(`main.js 第 ${lineAt(bare, m.index)} 行：${why}`);
  }
  for (const v of topLevelVars(bare)) {
    errs.push(`main.js 第 ${v.line} 行：最上層的 ${v.kw} ${v.name}——同一版的所有實例共用這個模組，它也不會跟著存檔；會變的資料放進 state，常數用 const`);
  }
  return errs;
}

function checkManifest(m) {
  const errs = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest.json 要是一個 JSON 物件'];
  if (m.format !== 'vibe-pkg/1') errs.push(`manifest.json：format 要是 "vibe-pkg/1"（現在是 ${short(m.format)}）`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) errs.push(`manifest.json：name 要是 1–40 字的字串（現在是 ${short(m.name)}）`);
  if (m.description != null && (typeof m.description !== 'string' || m.description.length > 200)) errs.push('manifest.json：description 要是 200 字以內的字串');
  if (m.description == null || !String(m.description).trim()) warn('manifest.json：建議寫 description（一句話說明怎麼玩）');
  if (!Number.isInteger(m.stateSchema) || m.stateSchema < 1 || m.stateSchema > 1000) errs.push(`manifest.json：stateSchema 要是 1 以上的整數（現在是 ${short(m.stateSchema)}）`);
  if (m.budgets != null) {
    if (typeof m.budgets !== 'object' || Array.isArray(m.budgets)) errs.push('manifest.json：budgets 要是物件，例如 { "entities": 120 }');
    else if (m.budgets.entities != null && !(Number.isInteger(m.budgets.entities) && m.budgets.entities > 0 && m.budgets.entities <= LIMIT.entitiesMax)) errs.push(`manifest.json：budgets.entities 要是 1–${LIMIT.entitiesMax} 的整數`);
  } else warn(`manifest.json：沒寫 budgets.entities，實體上限用預設 ${LIMIT.entitiesDefault}`);
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) warn(`manifest.json：不認得的欄位 ${k}（伺服器不會用到；版本號、作品線由伺服器指派）`);
  return errs;
}

const budgetOf = (m) => Math.min(LIMIT.entitiesMax, Number.isFinite(m?.budgets?.entities) ? m.budgets.entities : LIMIT.entitiesDefault);

// ---------------- 在 vm 裡跑 ----------------

function makeRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    get: () => a,
    set: (v) => {
      a = v >>> 0;
    },
  };
}

// 傳進作品的資料（input、事件、讀回的存檔）都在作品自己的 realm 裡用 JSON.parse 做出來，跟真的執行環境一樣是普通物件
const HELPER = `globalThis.__check = {
  call: function (d, n, s, j) { var a = JSON.parse(j); if (s !== undefined) a.unshift(s); return d[n].apply(d, a); },
  parse: function (j) { return JSON.parse(j); }
};`;
const CALL = new vm.Script('__check.call(__args.d, __args.n, __args.s, __args.j)', { filename: 'check-call' });
const PARSE = new vm.Script('__check.parse(__args.j)', { filename: 'check-parse' });

function errText(e) {
  if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return `超過 ${LIMIT.callMs} ms 還沒結束（無限迴圈或太重的計算？）`;
  const isObj = e !== null && typeof e === 'object';
  const name = isObj && e.name ? e.name : 'Error';
  const msg = isObj && 'message' in e ? e.message : String(e);
  const m = String((isObj && e.stack) || '').match(/main\.js:(\d+):(\d+)/);
  return `${name}：${String(msg).slice(0, 240)}${m ? `（main.js 第 ${m[1]} 行第 ${m[2]} 欄）` : ''}`;
}

// 跟伺服器、瀏覽器一樣包成一個函式：'use strict'、vibe 是參數（作品看不到外殼的變數）；lineOffset 讓行號對回 main.js
function compile(code, label) {
  try {
    return new vm.Script(`(function (vibe) { 'use strict';\n${code}\n})(globalThis.__vibe);`, { filename: 'main.js', lineOffset: -1 });
  } catch (e) {
    const m = String(e.stack || '').match(/main\.js:(\d+)/);
    return fail(`${label}main.js 有語法錯誤：${e.message}${m ? `（第 ${m[1]} 行）` : ''}`);
  }
}

function instantiate(script, label) {
  const rng = makeRng(12345);
  let def = null;
  let calls = 0;
  const sink = () => {};
  const sandbox = {
    __vibe: {
      define(d) {
        calls += 1;
        def = d;
      },
      random: () => rng.next(),
    },
    console: { log: sink, info: sink, warn: sink, error: sink, debug: sink },
  };
  // 字串不能當程式（跟瀏覽器沙盒沒有 unsafe-eval 一樣）
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(HELPER, ctx);
  try {
    script.runInContext(ctx, { timeout: LIMIT.callMs });
  } catch (e) {
    fail(`${label}載入 main.js 時出錯：${errText(e)}`);
  }
  delete sandbox.__vibe;
  if (calls !== 1) fail(`${label}main.js 要剛好呼叫一次 vibe.define(...)（實際 ${calls} 次）`);
  if (!def || typeof def !== 'object') fail(`${label}vibe.define 要傳入一個物件：vibe.define({ init, tick, view, … })`);
  for (const k of ['init', 'tick', 'view']) if (typeof def[k] !== 'function') fail(`${label}vibe.define 缺少 ${k}() 函式`);
  for (const k of ['hud', 'onEvent', 'migrate', 'snapshot', 'dispose']) if (def[k] != null && typeof def[k] !== 'function') fail(`${label}vibe.define 的 ${k} 要是函式`);
  for (const k of Object.keys(def)) {
    if (!DEFINE_KEYS.includes(k)) warn(`vibe.define 有不認得的欄位 ${k}：執行環境不會呼叫它（共用的小函式請寫成最上層的 function）`, `define-${k}`);
  }
  return { def, ctx, sandbox, rng, label };
}

function invoke(inst, name, state, args, where) {
  inst.sandbox.__args = { d: inst.def, n: name, s: state, j: JSON.stringify(args) };
  const t0 = performance.now();
  try {
    const value = CALL.runInContext(inst.ctx, { timeout: LIMIT.callMs });
    return { value, ms: performance.now() - t0 };
  } catch (e) {
    return fail(`${inst.label}${where}出錯：${errText(e)}`);
  } finally {
    inst.sandbox.__args = undefined;
  }
}

function inParse(inst, json) {
  inst.sandbox.__args = { j: json };
  try {
    return PARSE.runInContext(inst.ctx);
  } finally {
    inst.sandbox.__args = undefined;
  }
}

function asState(value, what) {
  if (value === null || typeof value !== 'object') fail(`${what}要是一個物件（state），實際是 ${kindOf(value)}——要嘛直接改 state 不回傳，要嘛回傳新的 state 物件`);
  if (typeof value.then === 'function') fail(`${what}是 Promise：函式要同步做完，不能用 async`);
  return value;
}

// 存檔只能存 JSON：找出第一個存不進去（或存了會變樣）的東西
function jsonHazard(v, p, seen = new Set(), count = { n: 0 }) {
  if ((count.n += 1) > 50000) return null;
  const t = typeof v;
  if (t === 'function') return `${p} 是函式`;
  if (t === 'symbol' || t === 'bigint') return `${p} 是 ${t}`;
  if (t === 'number' && !Number.isFinite(v)) return `${p} 是 ${v}（存檔後會變成 null）`;
  if (v === null || t !== 'object') return null;
  if (seen.has(v)) return `${p} 繞回自己（循環參照）`;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      if (v[i] === undefined) return `${p}[${i}] 是 undefined（存檔後會變成 null）`;
      const h = jsonHazard(v[i], `${p}[${i}]`, seen, count);
      if (h) return h;
    }
  } else {
    const tag = Object.prototype.toString.call(v).slice(8, -1);
    if (tag !== 'Object') return `${p} 是 ${tag}（存檔只能存一般物件、陣列、數字、字串、true／false、null）`;
    const proto = Object.getPrototypeOf(v);
    if (proto !== null && Object.getPrototypeOf(proto) !== null) return `${p} 是 class 的實例（存檔後會變成一般物件，方法全部消失）`;
    for (const k of Object.keys(v)) {
      const h = jsonHazard(v[k], `${p}.${k}`, seen, count);
      if (h) return h;
    }
  }
  seen.delete(v);
  return null;
}

// 存檔再讀回（useSnapshot：照執行環境存檔的方式先叫 snapshot()）
function saveRestore(inst, state, what, useSnapshot = true) {
  let snap = state;
  if (useSnapshot && inst.def.snapshot) snap = asState(invoke(inst, 'snapshot', state, [], `${what}的 snapshot()`).value, `${inst.label}${what}的 snapshot() 回傳值`);
  const hz = jsonHazard(snap, 'state');
  if (hz) fail(`${inst.label}${what}：${hz}——state 只能放 JSON 資料`);
  let json;
  try {
    json = JSON.stringify(snap);
  } catch (e) {
    fail(`${inst.label}${what}：state 不能轉成 JSON：${errText(e)}`);
  }
  const bytes = Buffer.byteLength(json);
  if (bytes > LIMIT.stateBytes) fail(`${inst.label}${what}：存檔 ${kb(bytes)}，超過上限 64 KB（陣列要有數量上限、用完的東西要清掉）`);
  maxStateBytes = Math.max(maxStateBytes, bytes);
  return { json, state: inParse(inst, json) };
}

function vec3(v, abs) {
  return Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && (abs == null || Math.abs(x) <= abs));
}

function checkView(list, budget, where) {
  if (!Array.isArray(list)) fail(`${where}view() 要回傳陣列（實體清單），實際是 ${kindOf(list)}`);
  if (list.length > budget) fail(`${where}view() 回傳 ${list.length} 個實體，超過上限 ${budget}（manifest.budgets.entities，最多 ${LIMIT.entitiesMax}）：東西要有數量上限`);
  const ids = new Set();
  list.forEach((e, idx) => {
    const tag = `${where}view() 第 ${idx} 個實體${e && typeof e.id === 'string' ? ` "${e.id}"` : ''}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) fail(`${tag}：要是物件 { id, shape, pos, … }，實際是 ${kindOf(e)}`);
    if (typeof e.id !== 'string' || !e.id || e.id.length > LIMIT.idChars) fail(`${tag}：id 要是 1–${LIMIT.idChars} 字的字串（現在是 ${short(e.id)}）`);
    if (ids.has(e.id)) fail(`${tag}：id 重複（同一步裡每個實體的 id 要唯一）`);
    ids.add(e.id);
    if (!Object.hasOwn(SIZE_LEN, e.shape)) fail(`${tag}：shape 只能是 ${Object.keys(SIZE_LEN).join('、')}（現在是 ${short(e.shape)}）`);
    if (!vec3(e.pos, LIMIT.posAbs)) fail(`${tag}：pos 要是 [x, y, z]，每個是 ±${LIMIT.posAbs} 以內的有限數字（現在是 ${short(e.pos)}）`);
    if (e.rot != null && !vec3(e.rot)) fail(`${tag}：rot 要是 [x, y, z] 三個有限數字（弧度）（現在是 ${short(e.rot)}）`);
    if (e.size != null && !(Array.isArray(e.size) && e.size.length === SIZE_LEN[e.shape] && e.size.every((v) => Number.isFinite(v) && v > 0 && v <= LIMIT.sizeMax))) {
      fail(`${tag}：${e.shape} 的 size 是 ${SIZE_HINT[e.shape]}，每個是 0–${LIMIT.sizeMax} 之間的正數（現在是 ${short(e.size)}）`);
    }
    for (const c of ['color', 'emissive']) if (e[c] != null && !(typeof e[c] === 'string' && HEX.test(e[c]))) fail(`${tag}：${c} 要是 "#rrggbb"（現在是 ${short(e[c])}）`);
    if (e.opacity != null && !(Number.isFinite(e.opacity) && e.opacity >= 0 && e.opacity <= 1)) fail(`${tag}：opacity 要是 0–1 的數字（現在是 ${short(e.opacity)}）`);
    if (e.shape === 'text') {
      if (typeof e.text !== 'string' || e.text.length > LIMIT.textChars) fail(`${tag}：text 實體要有 ${LIMIT.textChars} 字以內的 text（現在是 ${short(e.text)}）`);
    } else if (e.text != null) warn(`實體欄位 text 只有 shape: 'text' 會用到（例如 ${tag}）`, 'text-on-shape');
    for (const k of Object.keys(e)) if (!ENTITY_KEYS.has(k)) warn(`實體有不認得的欄位 ${k}（會被忽略；能用的是 ${[...ENTITY_KEYS].join('、')}）`, `ekey-${k}`);
  });
  return [...ids];
}

function checkHud(lines, where) {
  if (lines == null) return 0;
  if (!Array.isArray(lines)) fail(`${where}hud() 要回傳字串陣列（最多 ${LIMIT.hudLines} 行），實際是 ${kindOf(lines)}`);
  if (lines.length > LIMIT.hudLines) fail(`${where}hud() 回傳 ${lines.length} 行，最多 ${LIMIT.hudLines} 行`);
  lines.forEach((l, k) => {
    if (typeof l !== 'string') fail(`${where}hud() 第 ${k + 1} 行要是字串，實際是 ${kindOf(l)}`);
    if (l.length > LIMIT.hudChars) fail(`${where}hud() 第 ${k + 1} 行有 ${l.length} 字，每行最多 ${LIMIT.hudChars} 字：「${l.slice(0, 20)}…」`);
  });
  return lines.length;
}

// 假輸入：跟伺服器一樣方向鍵輪流按、偶爾 action、玩家繞著走（idle＝完全不操作）
function inputAt(i, mode) {
  const t = i / 30;
  if (mode === 'idle') return { t, keys: { left: false, right: false, up: false, down: false, action: false }, player: { x: 0, y: 1.6, z: 4 } };
  return {
    t,
    keys: { left: (i >> 4) % 4 === 0, right: (i >> 4) % 4 === 2, up: (i >> 5) % 2 === 0, down: (i >> 6) % 3 === 1, action: i % 37 < 3 },
    player: { x: Math.sin(t) * 2, y: 1.6, z: 4 + Math.cos(t) },
  };
}

// 事件：play＝跟伺服器一樣每 23 步一次（七成點實體、三成按鍵）；poke＝每 5 步輪流點一個實體
function eventAt(i, mode, ids) {
  if (mode === 'idle' || !ids.length) return null;
  if (mode === 'poke') return i % 5 === 0 ? { type: 'click', target: ids[(i / 5) % ids.length], by: 'pointer' } : null;
  if (i % 23 !== 0) return null;
  return (i / 23) % 10 < 7 ? { type: 'click', target: ids[(i * 7) % ids.length], by: 'pointer' } : { type: 'key', key: 'action', down: true };
}

const safeJson = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
};

// stat：要記錄耗時、實體數…的那一份統計（null＝不記）；firstView：先看一次 view（接著存檔跑時，事件才點得到東西）
function simulate(inst, state, from, steps, { budget, mode = 'play', record = null, stat = null, firstView = false }) {
  const L = inst.label;
  let ids = firstView ? checkView(invoke(inst, 'view', state, [], `第 ${from} 步的 view()`).value, budget, `${L}第 ${from} 步：`) : [];
  for (let i = from + 1; i <= from + steps; i += 1) {
    const r = invoke(inst, 'tick', state, [1 / 30, inputAt(i, mode)], `tick() 第 ${i} 步`);
    if (stat) {
      stat.ticks += 1;
      stat.tickMs += r.ms;
      stat.tickMax = Math.max(stat.tickMax, r.ms);
      if (stat.tickMs > LIMIT.tickMsTotal) fail(`${L}tick() 太慢：${stat.ticks} 步就花了 ${Math.round(stat.tickMs)} ms（平均每步要在 ${LIMIT.tickMsAvg} ms 以內）`);
    }
    if (r.value !== undefined) state = asState(r.value, `${L}tick() 第 ${i} 步的回傳值`);
    if (i % 5 === 0 || i === from + steps) {
      const before = safeJson(state);
      ids = checkView(invoke(inst, 'view', state, [], `第 ${i} 步的 view()`).value, budget, `${L}第 ${i} 步：`);
      const lines = inst.def.hud ? checkHud(invoke(inst, 'hud', state, [], `第 ${i} 步的 hud()`).value, `${L}第 ${i} 步：`) : 0;
      if (before !== null && safeJson(state) !== before) warn('view()／hud() 改到了 state：它們只能讀，改變要在 tick／onEvent 裡做', 'view-mutates');
      if (stat) {
        stat.hudMax = Math.max(stat.hudMax, lines);
        stat.entitiesMax = Math.max(stat.entitiesMax, ids.length);
      }
    }
    const ev = eventAt(i, mode, ids);
    if (ev && inst.def.onEvent) {
      const r2 = invoke(inst, 'onEvent', state, [ev], `第 ${i} 步的 onEvent(${short(ev)})`);
      if (r2.value !== undefined) state = asState(r2.value, `${L}onEvent() 第 ${i} 步的回傳值`);
      if (stat) stat.events += 1;
    }
    if (i % 60 === 0) state = saveRestore(inst, state, `第 ${i} 步存檔`).state;
    if (record && i % 10 === 0) record.push(safeJson(state));
  }
  return state;
}

function freshInstance(script, label) {
  const inst = instantiate(script, label);
  const s = asState(invoke(inst, 'init', undefined, [{ seed: 1 }], 'init({ seed: 1 })').value, `${label}init() 的回傳值`);
  return { inst, state: saveRestore(inst, s, 'init() 之後', false).state };
}

// 換版：舊版先跑出一份真的存檔，stateSchema 變了就用新版的 migrate 轉，再用新版接著跑
function migrationCheck(script, manifest, base) {
  const from = base.manifest?.stateSchema;
  const to = manifest.stateSchema;
  if (Number.isInteger(from) && to < from) fail(`stateSchema 從 ${from} 變成 ${to}：只能不變或變大`);
  let old;
  try {
    const bscript = compile(base.code, '舊版 ');
    const bi = instantiate(bscript, '舊版 ');
    let s = asState(invoke(bi, 'init', undefined, [{ seed: 7 }], 'init({ seed: 7 })').value, '舊版 init() 的回傳值');
    s = saveRestore(bi, s, 'init() 之後', false).state;
    s = simulate(bi, s, 0, PREV_STEPS, { budget: budgetOf(base.manifest) });
    old = saveRestore(bi, s, `第 ${PREV_STEPS} 步存檔`);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    warn(`舊版本身在本機試跑出錯，略過換版測試（${e.message}）`);
    return;
  }
  const inst = instantiate(script, '（接續舊版存檔）');
  let state = inParse(inst, old.json);
  let how;
  if (from !== to) {
    if (!inst.def.migrate) fail(`stateSchema 從 ${from} 變成 ${to}，要寫 migrate(old, fromSchema) 把舊存檔轉成新的 state`);
    state = asState(invoke(inst, 'migrate', state, [from], `migrate(舊存檔, ${from})`).value, '（接續舊版存檔）migrate() 的回傳值');
    state = saveRestore(inst, state, 'migrate() 之後', false).state;
    how = `migrate ${from} → ${to}`;
  } else how = `stateSchema 沒變（${to}），新版直接拿舊存檔`;
  const st = newStats();
  simulate(inst, state, 0, AFTER_STEPS, { budget: budgetOf(manifest), stat: st });
  if (st.tickMs / st.ticks > LIMIT.tickMsAvg) fail(`（接續舊版存檔）tick() 太慢：平均每步 ${(st.tickMs / st.ticks).toFixed(2)} ms（上限 ${LIMIT.tickMsAvg} ms）`);
  passed.push(`✓ 換版：舊版「${base.manifest?.name ?? '?'}」跑 ${PREV_STEPS} 步存檔 → ${how} → 新版接著跑 ${AFTER_STEPS} 步沒問題`);
}

function readPackageDir(dir, label) {
  const out = { manifest: null, code: null };
  const mf = path.join(dir, 'manifest.json');
  const cf = path.join(dir, 'main.js');
  if (!existsSync(mf)) errors.push(`${label}沒有 manifest.json`);
  else {
    const text = readFileSync(mf, 'utf8');
    if (Buffer.byteLength(text) > LIMIT.manifestBytes) errors.push(`${label}manifest.json 有 ${kb(Buffer.byteLength(text))}，上限 4 KB`);
    try {
      out.manifest = JSON.parse(text);
    } catch (e) {
      errors.push(`${label}manifest.json 不是合法的 JSON：${e.message}`);
    }
  }
  if (!existsSync(cf)) errors.push(`${label}沒有 main.js`);
  else {
    out.code = readFileSync(cf, 'utf8');
    if (Buffer.byteLength(out.code) > LIMIT.codeBytes) errors.push(`${label}main.js 有 ${kb(Buffer.byteLength(out.code))}，上限 64 KB`);
    if (!out.code.trim()) errors.push(`${label}main.js 是空的`);
  }
  return out;
}

// 舊版：--base 資料夾，或 job.json 的 target（connector 放進來的、正在修改的那一版）
function findBase(dir, baseArg) {
  if (baseArg) {
    const before = errors.length;
    const b = readPackageDir(path.resolve(baseArg), '舊版（--base）');
    if (errors.length > before || !b.manifest || !b.code) return null;
    return { ...b, from: path.relative(process.cwd(), path.resolve(baseArg)) || '.' };
  }
  const jf = path.join(dir, 'job.json');
  if (!existsSync(jf)) return null;
  try {
    const job = JSON.parse(readFileSync(jf, 'utf8'));
    const t = job?.target;
    if (t && typeof t.code === 'string' && t.manifest && typeof t.manifest === 'object') return { manifest: t.manifest, code: t.code, from: 'job.json 的 target' };
  } catch {
    warn('job.json 讀不懂，略過換版測試');
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  let dirArg = null;
  let baseArg = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--base') baseArg = args[(i += 1)];
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(USAGE);
      return 0;
    } else if (!dirArg && !args[i].startsWith('-')) dirArg = args[i];
    else {
      console.log(`✗ 看不懂的參數：${args[i]}\n${USAGE}`);
      return 2;
    }
  }
  if (args.includes('--base') && !baseArg) {
    console.log(`✗ --base 後面要接舊版作品資料夾\n${USAGE}`);
    return 2;
  }
  const dir = path.resolve(dirArg || '.');
  const { manifest, code } = readPackageDir(dir, '');
  if (manifest) errors.push(...checkManifest(manifest));
  if (code) errors.push(...staticChecks(code));
  const name = typeof manifest?.name === 'string' ? manifest.name : '?';
  console.log(`check：${name}（${path.relative(process.cwd(), dir) || '.'}）`);

  if (manifest && code) {
    const budget = budgetOf(manifest);
    try {
      const script = compile(code, '');
      const base = findBase(dir, baseArg);
      if (base) migrationCheck(script, manifest, base);

      // 新的實例：跟伺服器一樣的 300 步
      const main = freshInstance(script, '');
      let state = simulate(main.inst, main.state, 0, STEPS, { budget, stat: stats });
      const avg = stats.ticks ? stats.tickMs / stats.ticks : 0;
      if (avg > LIMIT.tickMsAvg) fail(`tick() 太慢：平均每步 ${avg.toFixed(2)} ms（上限 ${LIMIT.tickMsAvg} ms）`);
      passed.push(
        `✓ init＋${STEPS} 步 tick：平均 ${avg.toFixed(3)} ms／步（上限 ${LIMIT.tickMsAvg} ms，最慢 ${stats.tickMax.toFixed(2)} ms）、` +
          `實體最多 ${stats.entitiesMax} 個（上限 ${budget}）、${main.inst.def.hud ? `hud 最多 ${stats.hudMax} 行、` : ''}事件 ${stats.events} 次、存檔最大 ${kb(maxStateBytes)}（上限 64 KB）`,
      );

      // 能不能玩：完全不操作 vs. 一直按鍵、點實體，state 要有不一樣的時候
      const idle = freshInstance(script, '（不操作）');
      const poke = freshInstance(script, '（一直操作）');
      const rIdle = [];
      const rPoke = [];
      simulate(idle.inst, idle.state, 0, STEPS, { budget, mode: 'idle', record: rIdle });
      simulate(poke.inst, poke.state, 0, STEPS, { budget, mode: 'poke', record: rPoke });
      if (rIdle.every((s, k) => s === rPoke[k])) {
        errors.push(`輸入沒有作用：按方向鍵／action、點實體 ${STEPS} 步，state 跟完全不操作時一模一樣。作品要能玩：方向鍵或 action 要改變東西，或點到實體（onEvent 的 click）要有反應`);
      } else passed.push('✓ 輸入有作用：按鍵、點實體會改變 state');

      // 存檔重開：在新的執行環境（最上層變數、閉包都重來）從存檔接著跑
      const a = freshInstance(script, '');
      const sa = simulate(a.inst, a.state, 0, RESTORE_AT, { budget, mode: 'poke' });
      const saved = saveRestore(a.inst, sa, `第 ${RESTORE_AT} 步存檔`);
      const b = instantiate(script, '（存檔重開後）');
      b.rng.set(a.inst.rng.get());
      const ra = [];
      const rb = [];
      simulate(a.inst, saved.state, RESTORE_AT, RESTORE_STEPS, { budget, mode: 'poke', record: ra, firstView: true });
      try {
        simulate(b, inParse(b, saved.json), RESTORE_AT, RESTORE_STEPS, { budget, mode: 'poke', record: rb, firstView: true });
      } catch (e) {
        if (e instanceof Stop) fail(`${e.message}——從存檔恢復時，state 以外的東西（最上層變數、閉包）都會重來，遊戲需要的資料都要放在 state`);
        throw e;
      }
      if (ra.some((s, k) => s !== rb[k])) {
        warn('存檔重開後接著跑，結果跟沒重開時不一樣：是不是有東西放在 state 以外（最上層的物件、閉包），或用了 Date？遊戲需要的資料都要放在 state');
      } else passed.push(`✓ 存檔重開：第 ${RESTORE_AT} 步的存檔在新的執行環境接著跑 ${RESTORE_STEPS} 步，結果一致`);

      if (main.inst.def.dispose) invoke(main.inst, 'dispose', state, [], 'dispose()');
      state = null;
    } catch (e) {
      if (e instanceof Stop) errors.push(e.message);
      else errors.push(`check 自己出錯了（請回報）：${e?.stack || e}`);
    }
  }

  for (const p of passed) console.log(p);
  for (const w of warnings) console.log(`! ${w}`);
  for (const e of errors) console.log(`✗ ${e}`);
  if (errors.length) {
    console.log(`check 沒過：${errors.length} 個錯誤（✗）。修好再跑一次 node check.mjs`);
    return 1;
  }
  console.log('check 通過');
  return 0;
}

process.exitCode = main();
