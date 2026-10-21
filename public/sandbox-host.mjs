// 創作世界：作品沙盒的父頁這一側（主執行緒）。見 docs/creation-sdk.md。
// 作品程式只在 /sandbox/runner.html（<iframe sandbox="allow-scripts">：不同源、CSP 不能連網、沒有 eval）裡的 Worker 執行；
// 這裡只收「資料」——實體清單、HUD 文字、存檔 JSON——逐項檢查之後才轉成 Three.js 物件，所以作品碰不到頁面、網路、存檔或別人的狀態。
//
//   import { createSandboxHost } from './sandbox-host.mjs';
//   const host = createSandboxHost({ THREE, root, onHud(instId, lines) {}, onError(instId, message, { fatal, kind }) {} });
//   await host.ready();
//   await host.load('lin_x@3', code, manifest);              // → { ok, error }；同一版本只建一次 Worker
//   await host.spawn('i1', 'lin_x@3', { params: { seed } });  // → { ok, error }
//   每幀：host.tick(dt, { i1: { t, keys, player } });          // 不用等；回覆到了才更新畫面
//
// onError 的第三個參數：fatal＝實例已經停了（例外 exception、逾時 timeout、Worker 亂送訊息 crash）；
// fatal 是 false 的是格式問題（format：實體超量被截、形狀不認得、座標超出範圍…），同一個實例同一類只報一次，實例照常執行
// ——呼叫的人不要把這種當成「實例停了」。onError／onHud 都在這一輪內部處理完之後才呼叫（回呼裡可以直接 kill／spawn），
// 而且只送給那時還在的實例。

export const SANDBOX_LIMITS = Object.freeze({
  entities: 300, // 每個實例最多幾個實體（另外還受 manifest.budgets.entities 限制）
  posRange: 50, // 實體座標 ±50 公尺
  sizeMin: 0.01,
  sizeMax: 20,
  idChars: 40,
  textChars: 40,
  hudLines: 4,
  hudChars: 60,
  snapshotBytes: 65536,
  codeChars: 512 * 1024,
  maxDt: 0.25, // 一步最多推進幾秒
  tickMs: 300, // Worker 一步超過這麼久沒回就整個停掉（在 runner 裡計時）
});

const RUNNER_URL = '/sandbox/runner.html';
const SHAPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane', 'text']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const KEY_RE = /^[A-Za-z0-9_.:@~-]{1,80}$/; // pkgKey、實例 id
const DEFAULT_SIZE = { box: [1, 1, 1], sphere: [0.5], cylinder: [0.5, 1], cone: [0.5, 1], torus: [0.5, 0.15], plane: [1, 1], text: [0.3] };
const DEFAULT_COLOR = '#c8d0da';
const DEFAULT_ENTITY_BUDGET = 120;
const TEXT_COLOR = '#ffffff';
const TEXT_CANVAS_H = 48; // 文字貼圖高度（px）；寬度取 64–1024 的 2 的次方，寬度不變就重畫在同一張貼圖上
const TEXT_FONT_PX = 34;
const TEXT_MAX_W = 1024;

const fin = (x) => (Number.isFinite(x) ? x : 0);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const validKey = (k) => typeof k === 'string' && KEY_RE.test(k);
const text = (s, n = 400) => (typeof s === 'string' ? s.slice(0, n) : '');
const intOf = (x) => (Number.isFinite(x) ? Math.trunc(x) : 0);
const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2]] : null);
// 錯誤訊息裡引用作品給的值：只取一小段、拿掉控制字元
function preview(v) {
  let s;
  try {
    s = typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : JSON.stringify(v);
  } catch {
    s = typeof v;
  }
  s = String(s ?? typeof v).replace(/[\u0000-\u001f\u007f]/g, '');
  return s.length > 24 ? `${s.slice(0, 24)}…` : s;
}
function own(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj instanceof Map) return obj.get(key);
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
function cleanInput(raw, t) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const k = r.keys && typeof r.keys === 'object' ? r.keys : {};
  const p = r.player && typeof r.player === 'object' ? r.player : {};
  return {
    t: Number.isFinite(r.t) ? r.t : t,
    keys: { left: !!k.left, right: !!k.right, up: !!k.up, down: !!k.down, action: !!k.action },
    player: { x: fin(p.x), y: fin(p.y), z: fin(p.z) },
  };
}
function cleanEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string' || !ev.type || ev.type.length > 24) return null;
  const out = { type: ev.type, target: typeof ev.target === 'string' ? ev.target.slice(0, SANDBOX_LIMITS.idChars) : '' };
  if (typeof ev.key === 'string') out.key = ev.key.slice(0, 24);
  if (typeof ev.by === 'string') out.by = ev.by.slice(0, 16); // 誰點的：pointer、hand…
  const point = vec3(ev.point);
  if (point) out.point = point;
  if (ev.player && typeof ev.player === 'object') out.player = { x: fin(ev.player.x), y: fin(ev.player.y), z: fin(ev.player.z) };
  if (Number.isFinite(ev.value)) out.value = ev.value;
  return out;
}
function cleanManifest(m) {
  const man = m && typeof m === 'object' ? m : {};
  const ent = man.budgets && typeof man.budgets === 'object' ? man.budgets.entities : undefined;
  return {
    stateSchema: Number.isInteger(man.stateSchema) && man.stateSchema >= 1 ? man.stateSchema : 1,
    // 沒寫就用 120（跟伺服器影子試跑 server/shadow-harness.js 一樣），最多 300
    entities: Number.isFinite(ent) ? clamp(Math.floor(ent), 1, SANDBOX_LIMITS.entities) : DEFAULT_ENTITY_BUDGET,
  };
}
// 存檔、參數：一律先轉成 JSON 再傳（沒辦法轉的、超過 64 KB 的不收）
function jsonCopy(v, label) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    return { error: `${label}不能轉成 JSON` };
  }
  if (typeof s !== 'string') return { error: `${label}不能轉成 JSON` };
  if (utf8Bytes(s) > SANDBOX_LIMITS.snapshotBytes) return { error: `${label}超過 64 KB` };
  return { value: JSON.parse(s) };
}

// ---------------- 實體檢查 ----------------
// raw 來自作品（已經過 runner 整理成純資料，但值本身不可信）。不合格的整個略過；選用欄位不合格就改用預設值。
// warn(key, message)：同一類問題由呼叫的人決定只報一次
function validateEntity(raw, warn) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('entity', `view() 裡有不是物件的實體（${preview(raw)}），已略過`);
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !id.length || id.length > SANDBOX_LIMITS.idChars) {
    warn('id', `實體 id 要是 1–${SANDBOX_LIMITS.idChars} 字的字串（收到 ${preview(id)}），已略過`);
    return null;
  }
  const shape = raw.shape;
  if (typeof shape !== 'string' || !SHAPES.has(shape)) {
    warn('shape', `實體「${preview(id)}」的 shape ${preview(shape)} 不支援（只能用 ${[...SHAPES].join('、')}），已略過`);
    return null;
  }
  const pos = vec3(raw.pos);
  if (!pos || pos.some((v) => Math.abs(v) > SANDBOX_LIMITS.posRange)) {
    warn('pos', `實體「${preview(id)}」的 pos 要是三個 ±${SANDBOX_LIMITS.posRange} 以內的數字（收到 ${preview(raw.pos)}），已略過`);
    return null;
  }
  const spec = { id, shape, pos, rot: [0, 0, 0], size: DEFAULT_SIZE[shape].slice(), color: '', emissive: '', opacity: 1, text: '' };
  if (raw.rot !== undefined && raw.rot !== null) {
    const r = vec3(raw.rot);
    if (r && r.every((v) => Math.abs(v) <= 1000)) spec.rot = r;
    else warn('rot', `實體「${preview(id)}」的 rot 要是三個數字（弧度），已忽略`);
  }
  if (raw.size !== undefined && raw.size !== null) {
    const a = typeof raw.size === 'number' ? [raw.size] : raw.size;
    if (!Array.isArray(a) || !a.length || !a.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      warn('size', `實體「${preview(id)}」的 size 要是數字陣列（收到 ${preview(raw.size)}），改用預設大小`);
    } else {
      const full = fillSize(shape, a);
      const clamped = full.map((v) => clamp(v, SANDBOX_LIMITS.sizeMin, SANDBOX_LIMITS.sizeMax));
      if (clamped.some((v, i) => v !== full[i])) warn('size-range', `實體「${preview(id)}」的 size 超出 ${SANDBOX_LIMITS.sizeMin}–${SANDBOX_LIMITS.sizeMax}，已夾在範圍內`);
      spec.size = clamped;
    }
  }
  for (const key of ['color', 'emissive']) {
    const c = raw[key];
    if (c === undefined || c === null) continue;
    if (typeof c === 'string' && COLOR_RE.test(c)) spec[key] = c.toLowerCase();
    else warn(key, `實體「${preview(id)}」的 ${key} 要是 #rrggbb（收到 ${preview(c)}），改用預設值`);
  }
  if (raw.opacity !== undefined && raw.opacity !== null) {
    if (typeof raw.opacity === 'number' && Number.isFinite(raw.opacity)) {
      spec.opacity = clamp(raw.opacity, 0, 1);
      if (spec.opacity !== raw.opacity) warn('opacity', `實體「${preview(id)}」的 opacity 要在 0–1 之間，已夾在範圍內`);
    } else {
      warn('opacity', `實體「${preview(id)}」的 opacity 要是 0–1 的數字，改用 1`);
    }
  }
  if (shape === 'text') {
    let t = raw.text;
    if (t === undefined || t === null) t = '';
    if (typeof t !== 'string') {
      warn('text', `實體「${preview(id)}」的 text 要是字串`);
      t = '';
    }
    const chars = Array.from(t);
    if (chars.length > SANDBOX_LIMITS.textChars) {
      warn('text-long', `實體「${preview(id)}」的文字超過 ${SANDBOX_LIMITS.textChars} 字，已截掉`);
      t = chars.slice(0, SANDBOX_LIMITS.textChars).join('');
    }
    spec.text = t;
  }
  return spec;
}
// 補齊 size：box [寬, 高, 深]（只給一個＝正方體）、cylinder／cone [半徑, 高]、torus [半徑, 管徑]、plane [寬, 高]、sphere／text 一個數
function fillSize(shape, a) {
  switch (shape) {
    case 'box': return [a[0], a[1] ?? a[0], a[2] ?? a[0]];
    case 'cylinder':
    case 'cone': return [a[0], a[1] ?? a[0] * 2];
    case 'torus': return [a[0], a[1] ?? a[0] * 0.3];
    case 'plane': return [a[0], a[1] ?? a[0]];
    default: return [a[0]];
  }
}
// 一整份 view：先截到上限，再逐項檢查；回傳合格的實體（id 不重複）
function collectSpecs(view, total, limit, warn) {
  if (!Array.isArray(view)) {
    warn('view', 'view() 要回傳實體陣列（這一步畫面沒有更新）');
    return null;
  }
  const count = Number.isFinite(total) && total >= 0 ? Math.max(total, view.length) : view.length;
  if (count > limit) warn('budget', `view() 回傳 ${count} 個實體，超過上限 ${limit} 個，多的已截掉`);
  const specs = [];
  const seen = new Set();
  const n = Math.min(view.length, limit);
  for (let i = 0; i < n; i += 1) {
    const spec = validateEntity(view[i], warn);
    if (!spec) continue;
    if (seen.has(spec.id)) {
      warn('dup', `實體 id「${preview(spec.id)}」重複，後面的已略過`);
      continue;
    }
    seen.add(spec.id);
    specs.push(spec);
  }
  return specs;
}

export function createSandboxHost({ THREE, root, doc = globalThis.document, onHud, onError, runnerUrl = RUNNER_URL } = {}) {
  if (!THREE || !root) throw new Error('createSandboxHost 需要 THREE 和 root');
  let iframe = null;
  let port = null;
  let readyPromise = null;
  let helloWaiter = null;
  let readyFail = null;
  let disposed = false;
  let ridSeq = 0;
  let tickSeq = 0;
  let measureCtx = null;
  const pending = new Map(); // rid → { resolve }
  const pkgs = new Map(); // pkgKey → { key, manifest, status: loading|ready, loading, inFlight, inFlightAt, pendingDt, waiters }
  const insts = new Map(); // 實例 id → 見 newInstance
  const geoCache = new Map(); // 幾何 key → { geo, refs }（單位大小的幾何，大小用 mesh.scale）
  const live = { meshes: 0, geometries: 0, materials: 0, textures: 0 };
  const counters = { createdMeshes: 0, disposedMeshes: 0, timeouts: 0 };

  // onError／onHud 一律等這一輪內部處理完才呼叫（呼叫的人可能在回呼裡 kill／spawn），而且只送給那時還在的實例
  function deliver(rec, fn) {
    queueMicrotask(() => {
      if (disposed || insts.get(rec.id) !== rec) return;
      try {
        fn();
      } catch (err) {
        console.error('[sandbox] 回呼出錯', err);
      }
    });
  }
  function report(rec, message, info) {
    deliver(rec, () => onError?.(rec.id, message, info));
  }

  // ---------------- 和 runner 之間 ----------------
  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('作品沙盒已經關閉'));
        return;
      }
      const frame = doc.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts'); // 不給 allow-same-origin：不同源，讀不到這頁
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.setAttribute('title', '作品沙盒');
      frame.hidden = true;
      frame.style.display = 'none';
      iframe = frame;
      const done = (err) => {
        clearTimeout(timer);
        helloWaiter = null;
        readyFail = null;
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => done(new Error('作品沙盒沒有回應（/sandbox/runner.html 載入失敗？）')), 10000);
      helloWaiter = () => done(null);
      readyFail = done;
      frame.addEventListener('load', () => {
        if (disposed || port || iframe !== frame || !frame.contentWindow) return;
        const ch = new MessageChannel();
        port = ch.port1;
        port.onmessage = onRunner;
        // runner 是不同源（origin "null"），只能用 '*'；port 只交給這個 iframe 一次
        frame.contentWindow.postMessage({ type: 'init' }, '*', [ch.port2]);
      });
      frame.src = runnerUrl;
      (doc.body || doc.documentElement).appendChild(frame);
    });
    return readyPromise;
  }

  // runner 送來的也當不可信資料：每個欄位用之前都先檢查型別
  function onRunner(e) {
    const m = e.data;
    if (disposed || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'hello':
        helloWaiter?.();
        break;
      case 'reply': {
        const p = pending.get(m.rid);
        if (p) {
          pending.delete(m.rid);
          p.resolve(m);
        }
        break;
      }
      case 'tick':
        onTick(m);
        break;
      case 'timeout':
      case 'crash':
        onWorkerGone(m);
        break;
      default:
        break;
    }
  }

  function post(msg) {
    if (!port || disposed) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (err) {
      console.error('[sandbox] 傳給 runner 失敗', err);
      return false;
    }
  }

  // 一問一答；waitMs 只是保險（runner 自己有看門狗，正常不會等到這麼久）
  function request(msg, waitMs) {
    if (!port || disposed) return Promise.resolve({ ok: false, error: '作品沙盒還沒準備好' });
    ridSeq += 1;
    const rid = ridSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(rid)) resolve({ ok: false, error: '作品沙盒沒有回應' });
      }, waitMs);
      pending.set(rid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      if (!post({ ...msg, rid })) {
        pending.delete(rid);
        clearTimeout(timer);
        resolve({ ok: false, error: '傳給作品沙盒失敗' });
      }
    });
  }

  function releaseTickWaiters(pkg) {
    pkg.inFlight = 0;
    const w = pkg.waiters;
    pkg.waiters = [];
    for (const f of w) f();
  }

  // ---------------- 作品版本 ----------------
  async function load(pkgKey, code, manifest) {
    if (!validKey(pkgKey)) return { ok: false, error: '作品版本代號格式不對' };
    if (typeof code !== 'string' || code.length > SANDBOX_LIMITS.codeChars) return { ok: false, error: '作品程式格式不對或太大' };
    try {
      await ready();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const have = pkgs.get(pkgKey);
    if (have) return have.loading;
    const pkg = { key: pkgKey, gen: 0, manifest: cleanManifest(manifest), status: 'loading', loading: null, inFlight: 0, inFlightAt: 0, pendingDt: 0, waiters: [] };
    pkgs.set(pkgKey, pkg);
    pkg.loading = request({ op: 'load', pkg: pkgKey, code, manifest: pkg.manifest }, 15000).then((res) => {
      if (pkgs.get(pkgKey) !== pkg) return { ok: false, error: '作品版本已經卸載' };
      if (res.ok !== true) {
        pkgs.delete(pkgKey);
        return { ok: false, error: text(res.error) || '作品載入失敗' };
      }
      pkg.status = 'ready';
      pkg.gen = res.gen;
      return { ok: true, error: '' };
    });
    return pkg.loading;
  }

  // 還有實例在用就不關（回傳 false）
  function unload(pkgKey) {
    const pkg = pkgs.get(pkgKey);
    if (!pkg) return true;
    for (const rec of insts.values()) if (rec.pkg === pkgKey) return false;
    pkgs.delete(pkgKey);
    releaseTickWaiters(pkg);
    post({ op: 'unload', pkg: pkgKey });
    return true;
  }

  // ---------------- 實例 ----------------
  function newInstance(id, pkgKey, hidden) {
    return {
      id, pkg: pkgKey, hidden, status: 'starting', error: '', schema: 1, limit: SANDBOX_LIMITS.entities,
      group: null, ents: new Map(), reported: new Set(), hudKey: null, swapping: false, t: 0, pos: [0, 0, 0], rotY: 0,
    };
  }
  function ensureGroup(rec) {
    if (rec.group) return rec.group;
    const g = new THREE.Group();
    g.name = `sandbox:${rec.id}`;
    g.userData.instId = rec.id;
    g.position.fromArray(rec.pos);
    g.rotation.set(0, rec.rotY, 0);
    root.add(g);
    rec.group = g;
    return g;
  }
  function warnOnce(rec, key, message) {
    if (rec.reported.has(key)) return;
    rec.reported.add(key);
    if (!rec.hidden) report(rec, message, { fatal: false, kind: 'format' });
  }
  function markBroken(rec, message, kind = 'exception') {
    if (rec.status === 'broken' || rec.status === 'dead') return;
    rec.status = kind === 'exception' ? 'broken' : 'dead';
    rec.error = text(message) || '作品出錯';
    if (!rec.hidden) report(rec, rec.error, { fatal: true, kind });
  }

  // spawn 到已經存在的 instId＝換版：先在新版本的 Worker 建好，成功才在同一格切換（同一個 Group、同 id 的實體原地更新），
  // 舊版本 Worker 裡的實例接著 dispose；失敗的話舊的照常跑。同一個版本只能用來復原已經出錯／停止的實例。
  async function spawn(instId, pkgKey, opts = {}) {
    if (!validKey(instId)) return { ok: false, error: '實例 id 格式不對' };
    try {
      await ready();
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let pkg = pkgs.get(pkgKey);
    if (pkg && pkg.status === 'loading') {
      await pkg.loading;
      pkg = pkgs.get(pkgKey);
    }
    if (!pkg || pkg.status !== 'ready') return { ok: false, error: `作品版本 ${pkgKey} 還沒載入` };
    const o = opts && typeof opts === 'object' ? opts : {};
    const hidden = !!o.hidden;
    const prev = insts.get(instId);
    if (prev && (prev.hidden || hidden || prev.status === 'starting' || prev.swapping)) return { ok: false, error: `實例 ${instId} 已經在使用` };
    // 同一個版本：只有已經出錯／停止的實例可以重新開始（例如從存檔復原）；正在跑的不能被重設——
    // 除非明講 restart（只看的分頁照新存檔更新）：在原地從那份存檔重新開始，畫面上的物件沿用（不拆掉重建，不用重新編譯著色器）
    if (prev && prev.pkg === pkgKey && prev.status === 'running' && o.restart !== true) return { ok: false, error: `實例 ${instId} 已經在跑這個版本（要重新開始請先 kill）` };
    const hasState = o.state !== undefined && o.state !== null;
    let state = null;
    if (hasState) {
      const c = jsonCopy(o.state, '狀態');
      if (c.error) return { ok: false, error: c.error };
      state = c.value;
    }
    const p = jsonCopy(o.params && typeof o.params === 'object' ? o.params : {}, '參數');
    if (p.error) return { ok: false, error: p.error };
    const msg = {
      op: 'spawn', pkg: pkgKey, inst: instId, hidden, hasState, state, params: p.value,
      fromSchema: Number.isInteger(o.fromSchema) ? o.fromSchema : null,
      rng: Number.isInteger(o.rng) ? o.rng : null,
    };
    let rec = prev;
    const sameVersion = !!prev && prev.pkg === pkgKey;
    if (!rec) {
      rec = newInstance(instId, pkgKey, hidden);
      insts.set(instId, rec);
    } else {
      rec.swapping = true;
      // 同一個版本重新開始（例如從存檔復原）：Worker 裡舊的那份先移除
      if (sameVersion && rec.status !== 'dead') post({ op: 'kill', pkg: pkgKey, inst: instId });
    }
    const res = await request(msg, 10000);
    if (insts.get(instId) !== rec) {
      // 等待期間被 kill 掉了
      if (res.ok === true) post({ op: 'kill', pkg: pkgKey, inst: instId });
      return { ok: false, error: '實例已經被移除' };
    }
    rec.swapping = false;
    if (res.ok !== true) {
      const error = text(res.error) || '建立實例失敗';
      if (!prev) insts.delete(instId);
      else if (sameVersion) markBroken(rec, error);
      return { ok: false, error };
    }
    const oldPkg = prev ? prev.pkg : null;
    const oldAlive = prev ? prev.status !== 'dead' : false;
    rec.pkg = pkgKey;
    rec.schema = pkg.manifest.stateSchema;
    rec.limit = pkg.manifest.entities;
    rec.status = 'running';
    rec.error = '';
    rec.reported.clear();
    if (prev && !sameVersion && oldAlive && pkgs.has(oldPkg)) post({ op: 'kill', pkg: oldPkg, inst: instId });
    if (!hidden) {
      ensureGroup(rec);
      applyView(rec, res.view, res.total);
      applyHud(rec, res.hud);
    }
    return { ok: true, error: '' };
  }

  function kill(instId) {
    const rec = insts.get(instId);
    if (!rec) return false;
    insts.delete(instId);
    disposeVisuals(rec);
    if (rec.status !== 'dead' && pkgs.has(rec.pkg)) post({ op: 'kill', pkg: rec.pkg, inst: instId });
    return true;
  }

  function setTransform(instId, pos, rotY = 0) {
    const rec = insts.get(instId);
    if (!rec) return false;
    const p = vec3(pos);
    if (p) rec.pos = p;
    if (Number.isFinite(rotY)) rec.rotY = rotY;
    if (rec.group) {
      rec.group.position.fromArray(rec.pos);
      rec.group.rotation.set(0, rec.rotY, 0);
    }
    return true;
  }

  // 每幀呼叫、不用等。同一個作品版本同時只有一個 tick 在途；還沒回來的版本這一步跳過，時間累積到下一步（最多 0.25 秒）。
  // 回傳的 Promise 在這次送出的都回來（或 Worker 停掉）時完成，可以不理。
  function tick(dt, inputs) {
    if (disposed || !port) return Promise.resolve();
    const step = Number.isFinite(dt) ? clamp(dt, 0, SANDBOX_LIMITS.maxDt) : 0;
    const groups = new Map();
    for (const rec of insts.values()) {
      if (rec.hidden || rec.status !== 'running') continue;
      let list = groups.get(rec.pkg);
      if (!list) groups.set(rec.pkg, (list = []));
      list.push(rec);
    }
    const now = performance.now();
    const batches = [];
    const waits = [];
    for (const [key, list] of groups) {
      const pkg = pkgs.get(key);
      if (!pkg || pkg.status !== 'ready') continue;
      if (pkg.inFlight && now - pkg.inFlightAt > 5000) releaseTickWaiters(pkg); // 回覆遺失（不該發生）：放掉，下一步重送
      if (pkg.inFlight) {
        pkg.pendingDt = Math.min(SANDBOX_LIMITS.maxDt, pkg.pendingDt + step);
        continue;
      }
      const d = Math.min(SANDBOX_LIMITS.maxDt, step + pkg.pendingDt);
      pkg.pendingDt = 0;
      const frames = list.map((rec) => {
        rec.t += d;
        return [rec.id, cleanInput(own(inputs, rec.id), rec.t)];
      });
      tickSeq += 1;
      pkg.inFlight = tickSeq;
      pkg.inFlightAt = now;
      batches.push({ pkg: key, seq: tickSeq, dt: d, frames });
      waits.push(new Promise((r) => pkg.waiters.push(r)));
    }
    // 就算這一步沒有要跑的也送一則：runner 收到訊息時會順便檢查有沒有逾時的 Worker
    post({ op: 'tick', batches });
    return waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  }

  function onTick(m) {
    const pkg = pkgs.get(m.pkg);
    if (!pkg || !m.seq || m.seq !== pkg.inFlight) return; // 過期的回覆
    if (Array.isArray(m.out)) {
      for (const pair of m.out) {
        if (!Array.isArray(pair)) continue;
        const rec = insts.get(pair[0]);
        const r = pair[1];
        if (!rec || rec.pkg !== m.pkg || rec.hidden || rec.status !== 'running' || !r || typeof r !== 'object') continue;
        if (typeof r.error === 'string') {
          markBroken(rec, r.error);
          continue;
        }
        applyView(rec, r.view, r.total);
        applyHud(rec, r.hud);
      }
    }
    releaseTickWaiters(pkg);
  }

  // runner 把某個版本的 Worker 停掉了（逾時、亂送訊息）：那個版本的實例全部停止，畫面留在最後一格直到 kill
  function onWorkerGone(m) {
    const pkg = pkgs.get(m.pkg);
    if (!pkg || pkg.status !== 'ready' || m.gen !== pkg.gen) return; // 舊的那個 Worker（這個版本後來重新載入過）的通知：不管
    pkgs.delete(m.pkg);
    if (m.type === 'timeout') counters.timeouts += 1;
    const message = text(m.error) || (m.type === 'timeout' ? '作品沒有回應，已停止' : '作品出錯，已停止');
    for (const rec of insts.values()) {
      if (rec.pkg !== m.pkg || rec.status === 'dead') continue;
      const was = rec.status;
      rec.status = 'dead';
      rec.error = message;
      if (!rec.hidden && was !== 'broken' && was !== 'starting') report(rec, message, { fatal: true, kind: m.type });
    }
    releaseTickWaiters(pkg);
  }

  // 影子試跑：在 Worker 裡連跑 n 步（不畫），最後一步的畫面也照正式規則檢查一次（不建立任何 Three.js 物件）
  async function tickHidden(instId, n = 30, dt = 1 / 30, input) {
    const rec = insts.get(instId);
    if (!rec || rec.status !== 'running') return { ok: false, error: rec ? `實例目前是 ${rec.status}` : '沒有這個實例', steps: 0, maxEntities: 0, snapshotBytes: 0, warnings: [] };
    const steps = Number.isFinite(n) ? clamp(Math.trunc(n), 1, 600) : 30;
    const d = Number.isFinite(dt) ? clamp(dt, 0, SANDBOX_LIMITS.maxDt) : 1 / 30;
    const pkgKey = rec.pkg;
    const res = await request({ op: 'run', pkg: pkgKey, inst: instId, n: steps, dt: d, t0: rec.t, input: cleanInput(input, rec.t) }, SANDBOX_LIMITS.tickMs + steps * 30 + 10000);
    const out = {
      ok: res.ok === true,
      error: res.ok === true ? '' : text(res.error) || '試跑失敗',
      steps: intOf(res.steps),
      maxEntities: intOf(res.maxEntities),
      snapshotBytes: intOf(res.snapshotBytes),
      warnings: [],
    };
    if (insts.get(instId) !== rec || rec.pkg !== pkgKey) return { ...out, ok: false, error: out.error || '實例已經被移除' };
    if (out.ok) {
      rec.t += steps * d;
      const warns = new Map();
      const w = (key, message) => warns.has(key) || warns.set(key, message);
      if (out.maxEntities > rec.limit) w('budget-max', `試跑中 view() 最多回傳 ${out.maxEntities} 個實體，超過上限 ${rec.limit} 個`);
      collectSpecs(res.view, res.total, rec.limit, w);
      out.warnings = [...warns.values()];
    } else if (res.broken === true) {
      markBroken(rec, out.error);
    }
    return out;
  }

  function event(instId, ev) {
    const rec = insts.get(instId);
    if (!rec || rec.status !== 'running') return Promise.resolve({ ok: false, error: '實例沒有在執行' });
    const clean = cleanEvent(ev);
    if (!clean) return Promise.resolve({ ok: false, error: '事件格式不對（要有 type 字串）' });
    const pkgKey = rec.pkg;
    return request({ op: 'event', pkg: pkgKey, inst: instId, ev: clean }, 10000).then((res) => {
      if (res.ok !== true && res.broken === true && insts.get(instId) === rec && rec.pkg === pkgKey) markBroken(rec, res.error);
      return { ok: res.ok === true, error: res.ok === true ? '' : text(res.error) };
    });
  }

  // → { state, schema, rng }；失敗（實例停了、存檔超過 64 KB、不是 JSON）會丟 Error
  async function snapshot(instId) {
    const rec = insts.get(instId);
    if (!rec) throw new Error(`沒有實例 ${instId}`);
    if (rec.status !== 'running') throw new Error(`實例 ${instId} 已經${rec.status === 'broken' ? '出錯' : '停止'}，沒辦法存檔`);
    const res = await request({ op: 'snapshot', pkg: rec.pkg, inst: instId }, 10000);
    if (res.ok !== true) throw new Error(text(res.error) || '存檔失敗');
    if (typeof res.json !== 'string' || utf8Bytes(res.json) > SANDBOX_LIMITS.snapshotBytes) throw new Error('存檔超過 64 KB');
    let state;
    try {
      state = JSON.parse(res.json);
    } catch {
      throw new Error('存檔不是合法的 JSON');
    }
    return { state, schema: rec.schema, rng: Number.isInteger(res.rng) ? res.rng : undefined };
  }

  // ---------------- 畫面：實體 → Three.js ----------------
  function applyView(rec, view, total) {
    if (!rec.group) return;
    const specs = collectSpecs(view, total, rec.limit, (key, message) => warnOnce(rec, key, message));
    if (!specs) return; // 格式不對：保留上一格的畫面
    const seen = new Set();
    for (const spec of specs) {
      if (!rec.group) return; // 處理到一半實例被移除了
      seen.add(spec.id);
      upsert(rec, spec);
    }
    for (const [id, ent] of rec.ents) {
      if (seen.has(id)) continue;
      removeEntity(ent);
      rec.ents.delete(id);
    }
  }
  function applyHud(rec, hud) {
    if (hud === null || hud === undefined) return; // 作品沒有 hud()
    const lines = (Array.isArray(hud) ? hud : []).slice(0, SANDBOX_LIMITS.hudLines).map((s) => (typeof s === 'string' ? Array.from(s).slice(0, SANDBOX_LIMITS.hudChars).join('') : ''));
    const key = lines.join('\n');
    if (key === rec.hudKey) return;
    rec.hudKey = key;
    deliver(rec, () => onHud?.(rec.id, lines));
  }

  function upsert(rec, spec) {
    const isText = spec.shape === 'text';
    let ent = rec.ents.get(spec.id);
    if (ent && ent.isText !== isText) {
      removeEntity(ent);
      rec.ents.delete(spec.id);
      ent = null;
    }
    if (!ent) {
      ent = isText ? createText(spec) : createSolid(spec);
      ent.obj.name = spec.id;
      ent.obj.userData.entityId = spec.id;
      rec.group.add(ent.obj);
      rec.ents.set(spec.id, ent);
    } else if (isText) {
      updateText(ent, spec);
    } else {
      updateSolid(ent, spec);
    }
    ent.obj.position.fromArray(spec.pos);
    if (!isText) ent.obj.rotation.set(spec.rot[0], spec.rot[1], spec.rot[2]);
  }

  // 幾何是單位大小、同一種形狀共用（參考計數），大小用 mesh.scale；換形狀（或 torus 的管徑比例）才換 geometry
  function geoKey(spec) {
    if (spec.shape !== 'torus') return spec.shape;
    const ratio = clamp(Math.round((spec.size[1] / spec.size[0]) * 100) / 100, 0.01, 2);
    return `torus:${ratio.toFixed(2)}`;
  }
  function buildGeometry(key) {
    switch (key) {
      case 'box': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(1, 24, 16);
      case 'cylinder': return new THREE.CylinderGeometry(1, 1, 1, 24);
      case 'cone': return new THREE.ConeGeometry(1, 1, 24);
      case 'plane': return new THREE.PlaneGeometry(1, 1);
      default: return new THREE.TorusGeometry(1, Number(key.slice(6)), 12, 32);
    }
  }
  function acquireGeometry(key) {
    let g = geoCache.get(key);
    if (!g) {
      g = { geo: buildGeometry(key), refs: 0 };
      geoCache.set(key, g);
      live.geometries += 1;
    }
    g.refs += 1;
    return g.geo;
  }
  function releaseGeometry(key) {
    const g = geoCache.get(key);
    if (!g) return;
    g.refs -= 1;
    if (g.refs <= 0) {
      g.geo.dispose();
      geoCache.delete(key);
      live.geometries -= 1;
    }
  }
  function scaleOf(spec) {
    const s = spec.size;
    switch (spec.shape) {
      case 'box': return [s[0], s[1], s[2]];
      case 'sphere':
      case 'torus': return [s[0], s[0], s[0]];
      case 'cylinder':
      case 'cone': return [s[0], s[1], s[0]];
      case 'plane': return [s[0], s[1], 1];
      default: return [1, 1, 1];
    }
  }
  function setOpacity(ent, o) {
    if (o === ent.opacity) return;
    const nowT = o < 1;
    if (ent.mat.transparent !== nowT) {
      ent.mat.transparent = nowT;
      ent.mat.depthWrite = !nowT;
      ent.mat.needsUpdate = true;
    }
    ent.mat.opacity = o;
    ent.opacity = o;
  }
  function createSolid(spec) {
    const key = geoKey(spec);
    const mat = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, roughness: 0.55, metalness: 0.05 });
    live.materials += 1;
    const mesh = new THREE.Mesh(acquireGeometry(key), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    live.meshes += 1;
    counters.createdMeshes += 1;
    const ent = { isText: false, obj: mesh, mat, geoKey: key, color: null, emissive: null, opacity: 1 };
    updateSolid(ent, spec);
    return ent;
  }
  function updateSolid(ent, spec) {
    const key = geoKey(spec);
    if (key !== ent.geoKey) {
      ent.obj.geometry = acquireGeometry(key);
      releaseGeometry(ent.geoKey);
      ent.geoKey = key;
    }
    const side = spec.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide;
    if (ent.mat.side !== side) {
      ent.mat.side = side;
      ent.mat.needsUpdate = true;
    }
    const color = spec.color || DEFAULT_COLOR;
    if (color !== ent.color) {
      ent.mat.color.set(color);
      ent.color = color;
    }
    const emissive = spec.emissive || '#000000';
    if (emissive !== ent.emissive) {
      ent.mat.emissive.set(emissive);
      ent.emissive = emissive;
    }
    setOpacity(ent, spec.opacity);
    ent.obj.scale.fromArray(scaleOf(spec));
  }

  // 文字：CanvasTexture 的 Sprite（永遠面向鏡頭）
  const fontOf = (px) => `bold ${px}px system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif`;
  function createText(spec) {
    const mat = new THREE.SpriteMaterial({ transparent: true, depthWrite: false });
    live.materials += 1;
    const sprite = new THREE.Sprite(mat);
    live.meshes += 1;
    counters.createdMeshes += 1;
    const ent = { isText: true, obj: sprite, mat, tex: null, canvas: null, text: null, color: null, opacity: 1, aspect: 1 };
    updateText(ent, spec);
    return ent;
  }
  function updateText(ent, spec) {
    const color = spec.color || TEXT_COLOR;
    if (spec.text !== ent.text || color !== ent.color) drawText(ent, spec.text, color);
    if (ent.opacity !== spec.opacity) {
      ent.mat.opacity = spec.opacity;
      ent.opacity = spec.opacity;
    }
    const h = spec.size[0];
    ent.obj.scale.set(h * ent.aspect, h, 1);
    ent.obj.userData.text = spec.text;
  }
  function drawText(ent, str, color) {
    measureCtx ??= doc.createElement('canvas').getContext('2d');
    measureCtx.font = fontOf(TEXT_FONT_PX);
    const need = Math.ceil(measureCtx.measureText(str).width) + 16;
    const width = clamp(2 ** Math.ceil(Math.log2(Math.max(need, 1))), 64, TEXT_MAX_W);
    // 寬度一樣就重畫在同一張貼圖上；寬度變了換一張新的（WebGL2 的貼圖配置好之後不能改大小）
    if (!ent.canvas || ent.canvas.width !== width) {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = TEXT_CANVAS_H;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      if (ent.tex) {
        ent.tex.dispose();
        live.textures -= 1;
      }
      live.textures += 1;
      ent.tex = tex;
      ent.canvas = canvas;
      ent.mat.map = tex;
      ent.mat.needsUpdate = true;
    }
    const ctx = ent.canvas.getContext('2d');
    const k = need > width ? width / need : 1; // 太長就縮小字
    ctx.clearRect(0, 0, width, TEXT_CANVAS_H);
    ctx.font = fontOf(Math.max(8, Math.floor(TEXT_FONT_PX * k)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, 6 * k);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeText(str, width / 2, TEXT_CANVAS_H / 2);
    ctx.fillStyle = color;
    ctx.fillText(str, width / 2, TEXT_CANVAS_H / 2);
    ent.tex.needsUpdate = true;
    ent.text = str;
    ent.color = color;
    ent.aspect = width / TEXT_CANVAS_H;
  }

  function removeEntity(ent) {
    ent.obj.removeFromParent();
    if (ent.isText) {
      if (ent.tex) {
        ent.tex.dispose();
        live.textures -= 1;
        ent.tex = null;
      }
      ent.canvas = null;
    } else {
      releaseGeometry(ent.geoKey);
    }
    ent.mat.dispose();
    live.materials -= 1;
    live.meshes -= 1;
    counters.disposedMeshes += 1;
  }
  function disposeVisuals(rec) {
    for (const ent of rec.ents.values()) removeEntity(ent);
    rec.ents.clear();
    if (rec.group) {
      rec.group.removeFromParent();
      rec.group = null;
    }
  }

  // ---------------- 查詢 ----------------
  // 點擊：raycaster 打到哪個實例的哪個實體（文字 Sprite 要 raycaster.camera 才打得到，例如用 setFromCamera 設好的）
  function pick(raycaster) {
    if (!raycaster || typeof raycaster.intersectObjects !== 'function') return null;
    const list = [];
    for (const rec of insts.values()) {
      if (rec.hidden || !rec.group || !rec.group.visible) continue;
      for (const ent of rec.ents.values()) {
        if (!ent.obj.visible || (ent.isText && !raycaster.camera)) continue;
        list.push(ent.obj);
      }
    }
    if (!list.length) return null;
    root.updateWorldMatrix(true, true);
    for (const hit of raycaster.intersectObjects(list, false)) {
      const entityId = hit.object.userData.entityId;
      const instId = hit.object.parent?.userData.instId;
      if (typeof entityId === 'string' && typeof instId === 'string') return { instId, entityId, point: hit.point.toArray(), distance: hit.distance };
    }
    return null;
  }
  function instances() {
    return [...insts.values()].map((r) => ({ id: r.id, pkg: r.pkg, hidden: r.hidden, status: r.status, error: r.error, entities: r.ents.size, t: r.t }));
  }
  function stats() {
    let entities = 0;
    for (const r of insts.values()) entities += r.ents.size;
    return { workers: pkgs.size, instances: insts.size, entities, ...live, ...counters };
  }

  // 移除 iframe（裡面的 Worker 跟著結束）、釋放所有 geometry／material／texture
  function dispose() {
    if (disposed) return;
    disposed = true;
    readyFail?.(new Error('作品沙盒已經關閉'));
    for (const rec of insts.values()) disposeVisuals(rec);
    insts.clear();
    for (const pkg of pkgs.values()) releaseTickWaiters(pkg);
    pkgs.clear();
    for (const p of pending.values()) p.resolve({ ok: false, error: '作品沙盒已經關閉' });
    pending.clear();
    for (const g of geoCache.values()) {
      g.geo.dispose();
      live.geometries -= 1;
    }
    geoCache.clear();
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
    if (iframe) {
      iframe.remove();
      iframe = null;
    }
  }

  return { ready, load, unload, spawn, kill, setTransform, tick, tickHidden, event, snapshot, pick, instances, stats, dispose };
}
