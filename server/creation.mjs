// 創作世界（伺服器端）：生成與運行分開——伺服器不叫 Codex。
// 創作者在自己電腦跑 connector（用自己的 Codex 登入）→ 送來作品包 → 這裡驗格式、在 Deno 零權限沙盒影子試跑 →
// 存成不可變版本 → 瀏覽器在 sandbox iframe 的 Worker 裡執行。規格見 docs/creation-sdk.md。
// - 身分：「這台瀏覽器的創作者」（cookie vw_creator＝id.祕密，伺服器只存雜湊），不是帳號，也不經手任何 OpenAI／Codex 憑證
// - connector 用配對碼換 token（只回一次，伺服器只存雜湊）；只拿得到、只能交付自己這位創作者的工作
// - 沒有連上 connector：工作留在佇列並提示，**不會改用伺服器主人的 Codex**
// - 世界是樹（只能在目前這層開子世界，不會有循環）；存檔是引用（作品線＋版本＋狀態），進入哪層才執行哪層
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.join(HERE, 'shadow-harness.js');
const LIMITS = {
  code: 64 * 1024,
  manifest: 4 * 1024,
  state: 64 * 1024,
  itemsPerWorld: 200,
  worldsPerCreator: 2000,
  worldsTotal: 20000,
  intent: 600,
  attempts: 6,
  jobsKept: 400,
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = (prefix, n = 6) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(n).toString('hex')}`;
const clampStr = (s, n) => String(s ?? '').slice(0, n);
const isVec3 = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isFinite(v) && Math.abs(v) <= 500);

export function createCreation({ dataDir, log = () => {}, denoBin = process.env.DENO_BIN || '/opt/homebrew/bin/deno' }) {
  const DIR = path.join(dataDir, 'creation');
  const PKG_DIR = path.join(DIR, 'packages');
  const STATE_FILE = path.join(DIR, 'state.json');
  let st = null; // { creators, connectors, codes, jobs, lineages, worlds }
  let saveTimer = null;
  const waiters = new Map(); // creatorId → Set(resolve)
  const pairFails = []; // 配對碼猜錯的時間（擋暴力猜碼：每分鐘最多 20 次）
  const lastSeen = new Map(); // creatorId → { at, label }
  // 同一層世界可以同時在好幾個分頁／瀏覽器開著：只有拿到「執行權」（lease）的那一個在跑作品、存檔；
  // 其他的只看（跟著伺服器的存檔同步）。誰要動手（點、說話、放作品）就先接手：伺服器通知目前的執行者存檔、交出，再交給接手的人。
  // 執行者斷線：lease 到期（預設 15 秒沒續）就能被接手，從最後的存檔接著跑。所有變動都用 revision 事件（SSE）通知同一層的其他分頁。
  const LEASE_MS = Number(process.env.CREATION_LEASE_MS) || 15000;
  const HANDOVER_MS = Number(process.env.CREATION_HANDOVER_MS) || 3000;
  const leases = new Map(); // worldId → { clientId, creatorId, until, pending: { to, creatorId, at } | null }
  const listeners = new Map(); // worldId → Set({ res, clientId, creatorId })
  const validClient = (c) => typeof c === 'string' && /^[\w-]{8,64}$/.test(c);
  function leaseOf(worldId) {
    const L = leases.get(worldId);
    if (L && L.until < Date.now()) {
      leases.delete(worldId);
      return null;
    }
    return L || null;
  }
  const leaseInfo = (worldId) => {
    const L = leaseOf(worldId);
    return L ? { clientId: L.clientId, until: L.until, pending: L.pending?.to || null } : null;
  };
  function broadcast(worldId, type, data) {
    const set = listeners.get(worldId);
    if (!set) return;
    const msg = `event: ${type}\ndata: ${JSON.stringify({ ...data, world: worldId, at: Date.now() })}\n\n`;
    for (const l of set) {
      try {
        l.res.write(msg);
      } catch {
        /* 斷了：close 事件會清掉 */
      }
    }
  }
  function grant(worldId, clientId, creatorId, extra = {}) {
    leases.set(worldId, { clientId, creatorId, until: Date.now() + LEASE_MS, pending: null });
    broadcast(worldId, 'lease', { clientId, revision: st.worlds[worldId]?.revision ?? 0, ...extra });
  }
  const presence = (worldId) => broadcast(worldId, 'presence', { n: listeners.get(worldId)?.size || 0, clients: [...(listeners.get(worldId) || [])].map((l) => l.clientId) });

  async function load() {
    await fs.mkdir(PKG_DIR, { recursive: true });
    try {
      st = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    } catch {
      st = null;
    }
    st ??= {};
    st.creators ??= {};
    st.connectors ??= {};
    st.codes ??= {};
    st.jobs ??= [];
    st.lineages ??= {};
    st.worlds ??= {};
    st.worlds.root ??= { id: 'root', parentId: null, name: '根世界', creatorId: null, revision: 0, items: [], portals: [], createdAt: Date.now() };
    // 伺服器重開：做到一半的工作回到佇列（connector 會再拿）
    for (const j of st.jobs) if (j.status === 'working') j.status = 'queued';
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(st));
    await fs.rename(tmp, STATE_FILE);
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().catch((e) => log('creation save failed', e.message)), 200);
  }
  const ready = load();

  // ---------------- 身分 ----------------
  function cookie(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function creatorOf(req) {
    const [id, secret] = cookie(req, 'vw_creator').split('.');
    const c = id && st.creators[id];
    return c && secret && c.secretHash === sha(secret) ? c : null;
  }
  function connectorOf(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer ([\w-]{20,200})$/);
    if (!m) return null;
    const k = st.connectors[sha(m[1])];
    if (!k || !st.creators[k.creatorId]) return null;
    return k;
  }
  const publicCreator = (c) => ({ creatorId: c.id, name: c.name });
  function connectorStatus(creatorId) {
    const s = lastSeen.get(creatorId);
    const paired = Object.values(st.connectors).some((k) => k.creatorId === creatorId);
    return { paired, online: !!s && Date.now() - s.at < 40000, label: s?.label || null, lastSeen: s?.at || null };
  }

  // ---------------- 工作 ----------------
  const publicJob = (j) => ({
    id: j.id,
    status: j.status,
    intent: j.intent,
    source: j.source,
    worldId: j.worldId,
    selected: j.selected,
    targetLineage: j.targetLineage,
    baseVersion: j.baseVersion,
    lineage: j.lineage || null,
    version: j.version || null,
    attempts: j.attempts,
    diagnostics: j.diagnostics || null,
    messages: j.messages.slice(-6),
    provenance: j.provenance || null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  });
  function touch(j, status) {
    if (status) j.status = status;
    j.updatedAt = Date.now();
    save();
  }
  function wake(creatorId) {
    const set = waiters.get(creatorId);
    if (!set) return;
    waiters.delete(creatorId);
    for (const r of set) r();
  }
  // connector 中途掛掉：做到一半的工作 10 分鐘沒有進度就放回佇列（同一位創作者的 connector 回來會再拿）
  function nextJobFor(creatorId) {
    for (const j of st.jobs) if (j.creatorId === creatorId && (j.status === 'working' || j.status === 'needs-fix') && Date.now() - j.updatedAt > 10 * 60 * 1000) touch(j, 'queued');
    return st.jobs.find((j) => j.creatorId === creatorId && j.status === 'queued') || null;
  }
  // 給 connector 的工作內容：要改哪個作品就附上那一版的原始碼（同一位創作者的工作才拿得到）
  async function jobForConnector(j) {
    let target = null;
    if (j.targetLineage) {
      const L = st.lineages[j.targetLineage];
      const v = j.baseVersion || L?.latest;
      if (L && v) {
        const dir = path.join(PKG_DIR, L.id, String(v));
        target = {
          lineage: L.id,
          baseVersion: v,
          name: L.name,
          manifest: JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')),
          code: await fs.readFile(path.join(dir, 'main.js'), 'utf8'),
        };
      }
    }
    return { id: j.id, intent: j.intent, source: j.source, worldId: j.worldId, selected: j.selected, target, attempt: j.attempts + 1, diagnostics: j.diagnostics || null };
  }

  // ---------------- 作品包：格式檢查＋影子試跑 ----------------
  function checkManifest(m) {
    const errs = [];
    if (!m || typeof m !== 'object') return ['manifest.json 要是物件'];
    if (m.format !== 'vibe-pkg/1') errs.push('manifest.format 要是 "vibe-pkg/1"');
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) errs.push('manifest.name 要是 1–40 字');
    if (m.description != null && (typeof m.description !== 'string' || m.description.length > 200)) errs.push('manifest.description 最多 200 字');
    if (!Number.isInteger(m.stateSchema) || m.stateSchema < 1 || m.stateSchema > 1000) errs.push('manifest.stateSchema 要是 1 以上的整數');
    if (m.budgets != null && (typeof m.budgets !== 'object' || (m.budgets.entities != null && !(Number.isInteger(m.budgets.entities) && m.budgets.entities > 0 && m.budgets.entities <= 300)))) errs.push('manifest.budgets.entities 要是 1–300 的整數');
    return errs;
  }
  // 程式格式（給創作者看的提示，不是安全邊界——安全靠 Deno 零權限與瀏覽器沙盒）
  function checkCode(code) {
    const errs = [];
    if (typeof code !== 'string' || !code.trim()) return ['main.js 是空的'];
    if (code.length > LIMITS.code) errs.push(`main.js 太大（上限 ${LIMITS.code / 1024} KB）`);
    if (/^\s*(import|export)\b/m.test(code)) errs.push('main.js 不能有 import／export：用 vibe.define({...})');
    if (!/\bvibe\.define\s*\(/.test(code)) errs.push('main.js 要呼叫 vibe.define({...})');
    return errs;
  }
  function shadowRun(payload) {
    return new Promise((resolve) => {
      const work = path.join(os.tmpdir(), `vw-shadow-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const denoDir = path.join(work, 'deno');
      const done = (r) => {
        fs.rm(work, { recursive: true, force: true }).catch(() => {});
        resolve(r);
      };
      fs.mkdir(denoDir, { recursive: true }).then(() => {
        const child = spawn('/bin/sh', ['-c', 'ulimit -t 4; exec "$0" run --no-prompt --no-remote --no-npm --no-config --no-lock --cached-only --v8-flags=--max-old-space-size=128 "$1"', denoBin, HARNESS], {
          cwd: work,
          env: { PATH: '/usr/bin:/bin', HOME: work, DENO_DIR: denoDir, DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill('SIGKILL');
        }, 9000);
        child.stdout.on('data', (d) => {
          if (out.length < 256 * 1024) out += d;
        });
        child.stderr.on('data', (d) => {
          if (err.length < 8 * 1024) err += d;
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          done({ ok: false, diagnostics: [`影子試跑沒辦法啟動（${e.message}）：伺服器要安裝 Deno`], stats: {} });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          try {
            const r = JSON.parse(out.trim().split('\n').pop());
            done({ ...r, exit: code });
          } catch {
            const why = killed ? '超過 9 秒還沒跑完' : code === 152 || signal === 'SIGXCPU' ? 'CPU 時間超過 4 秒（可能是無限迴圈或太重的計算）' : code === 133 || /out of memory|heap/i.test(err) ? '記憶體超過上限' : `試跑程序異常結束（${code ?? signal}）`;
            done({ ok: false, diagnostics: [`影子試跑失敗：${why}`], stats: {}, exit: code });
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(payload));
      }, (e) => done({ ok: false, diagnostics: [`影子試跑暫存資料夾建立失敗：${e.message}`], stats: {} }));
    });
  }

  async function readVersion(lineage, v) {
    const dir = path.join(PKG_DIR, lineage, String(v));
    return { manifest: JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')), code: await fs.readFile(path.join(dir, 'main.js'), 'utf8') };
  }

  async function acceptPackage(job, k, body) {
    const manifest = body?.manifest;
    const code = body?.files?.['main.js'];
    if (JSON.stringify(manifest ?? null).length > LIMITS.manifest) return { ok: false, diagnostics: ['manifest.json 太大'] };
    const errs = [...checkManifest(manifest), ...checkCode(code)];
    if (errs.length) return { ok: false, diagnostics: errs };
    // 要改的作品線：自己的就加新版本；別人的就分出一條自己的（不改到別人的作品線）
    let L = job.targetLineage ? st.lineages[job.targetLineage] : null;
    // 衝突：這個需求送出之後，這條作品線又多了比基準更新、而且能用的版本（例如同一位創作者在另一台裝置也改了）→ 不覆蓋，請以新版為基礎重來；
    // 送出之前就有的新版不算（例如先「退回上一版」、再明確改那一版）；壞掉的新版不算；沒有時間紀錄的舊資料一律當成衝突
    const newer = L && job.baseVersion ? L.versions.filter((x) => x.v > job.baseVersion && !x.broken && (x.at ?? Infinity) > job.createdAt).map((x) => x.v) : [];
    if (newer.length) {
      return { ok: false, conflict: true, diagnostics: [`作品「${L.name}」在你生成的時候已經更新到 v${Math.max(...newer)}（你改的是 v${job.baseVersion}）；請以新版為基礎重新說一次`] };
    }
    // 影子試跑的「上一版存檔」用這次改的基準版本（實例正在跑的那一版），沒有基準才用最新版
    const prevV = L && job.baseVersion && L.versions.some((x) => x.v === job.baseVersion) ? job.baseVersion : L?.latest;
    const prev = L ? await readVersion(L.id, prevV) : null;
    const shadow = await shadowRun({ code, manifest, prev });
    if (!shadow.ok) return { ok: false, diagnostics: shadow.diagnostics?.length ? shadow.diagnostics : ['影子試跑沒有通過'], shadow };
    if (L && L.creatorId !== job.creatorId) {
      const fork = { id: rid('lin', 4), name: clampStr(manifest.name, 40), creatorId: job.creatorId, forkOf: { lineage: L.id, version: L.latest }, versions: [], latest: 0, createdAt: Date.now() };
      st.lineages[fork.id] = fork;
      L = fork;
    }
    if (!L) {
      L = { id: rid('lin', 4), name: clampStr(manifest.name, 40), creatorId: job.creatorId, forkOf: null, versions: [], latest: 0, createdAt: Date.now() };
      st.lineages[L.id] = L;
    }
    const v = L.latest + 1;
    const dir = path.join(PKG_DIR, L.id, String(v));
    await fs.mkdir(dir, { recursive: true });
    const manifestText = JSON.stringify(manifest, null, 2);
    await fs.writeFile(path.join(dir, 'main.js'), code);
    await fs.writeFile(path.join(dir, 'manifest.json'), manifestText);
    const receipt = {
      lineage: L.id,
      version: v,
      codeSha256: sha(code),
      manifestSha256: sha(manifestText),
      creatorId: job.creatorId,
      jobId: job.id,
      connector: k.id,
      provenance: sanitizeProvenance(body.provenance),
      shadow: shadow.stats,
      builtAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
    L.versions.push({ v, stateSchema: manifest.stateSchema, name: clampStr(manifest.name, 40), codeSha256: receipt.codeSha256, jobId: job.id, at: Date.now() });
    L.latest = v;
    L.name = clampStr(manifest.name, 40);
    return { ok: true, lineage: L.id, version: v, shadow: shadow.stats };
  }
  // 來源紀錄只留工具名稱、方式、輪數、耗時（不收帳號、主機名稱、路徑）
  function sanitizeProvenance(p) {
    if (!p || typeof p !== 'object') return null;
    return { tool: clampStr(p.tool, 60), via: clampStr(p.via, 20), attempt: Number.isFinite(p.attempt) ? p.attempt : null, ms: Number.isFinite(p.ms) ? Math.round(p.ms) : null };
  }

  // 可以拿來放新實例的版本：最新且沒被瀏覽器回報壞掉的
  const latestGood = (L) => [...L.versions].reverse().find((x) => !x.broken)?.v ?? null;

  // ---------------- 世界 ----------------
  function worldPath(w) {
    const out = [];
    for (let x = w, n = 0; x && n < 100000; x = st.worlds[x.parentId], n += 1) out.unshift({ id: x.id, name: x.name });
    return out;
  }
  const publicWorld = (w) => ({ id: w.id, parentId: w.parentId, name: w.name, creatorId: w.creatorId, revision: w.revision, items: w.items, portals: w.portals, path: worldPath(w), depth: worldPath(w).length - 1 });
  function cleanItems(items) {
    if (!Array.isArray(items) || items.length > LIMITS.itemsPerWorld) return { error: `每個世界最多 ${LIMITS.itemsPerWorld} 個作品` };
    const out = [];
    const ids = new Set();
    for (const it of items) {
      if (!it || typeof it.id !== 'string' || !/^i_[\w-]{1,40}$/.test(it.id) || ids.has(it.id)) return { error: '作品實例 id 不對' };
      ids.add(it.id);
      const L = st.lineages[it.lineage];
      if (!L || !L.versions.some((x) => x.v === it.version)) return { error: `找不到作品 ${it.lineage}@${it.version}` };
      if (!isVec3(it.pos)) return { error: '位置不對' };
      let state = null;
      if (it.state != null) {
        const s = JSON.stringify(it.state);
        if (s.length > LIMITS.state) return { error: `存檔太大（${it.id}）` };
        state = JSON.parse(s);
      }
      out.push({ id: it.id, lineage: it.lineage, version: it.version, pos: it.pos.map((v) => Math.round(v * 1000) / 1000), rotY: Number.isFinite(it.rotY) ? it.rotY : 0, state, schema: Number.isInteger(it.schema) ? it.schema : null, rng: Number.isInteger(it.rng) ? it.rng : null });
    }
    return { items: out };
  }

  // ---------------- HTTP ----------------
  // 回傳 true＝處理了。send(res, status, body, headers)、readBody(req, limit)
  async function handle(req, res, url, { send, readBody }) {
    await ready;
    const p = url.pathname;
    let m;
    // 作品版本檔（不可變）：/pkg/<lineage>/<version>/main.js|manifest.json
    if (req.method === 'GET' && (m = p.match(/^\/pkg\/(lin_[a-z0-9]+)\/(\d+)\/(main\.js|manifest\.json)$/))) {
      const L = st.lineages[m[1]];
      if (!L || !L.versions.some((x) => x.v === Number(m[2]))) return send(res, 404, 'not found'), true;
      const body = await fs.readFile(path.join(PKG_DIR, m[1], m[2], m[3]), 'utf8');
      res.writeHead(200, { 'Content-Type': m[3].endsWith('.js') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
      return true;
    }
    if (!p.startsWith('/api/me') && !p.startsWith('/api/connector/') && !p.startsWith('/api/create') && !p.startsWith('/api/lineages') && !p.startsWith('/api/cworlds')) return false;

    // ---- connector（用配對碼／Bearer token 認證，不用瀏覽器 cookie） ----
    if (p === '/api/connector/pair' && req.method === 'POST') {
      while (pairFails.length && Date.now() - pairFails[0] > 60000) pairFails.shift();
      if (pairFails.length >= 20) return send(res, 429, { error: '配對嘗試太多次，一分鐘後再試' }), true;
      const body = await readBody(req, 4096);
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const c = st.codes[code];
      if (!c || c.expiresAt < Date.now()) {
        pairFails.push(Date.now());
        return send(res, 403, { error: '配對碼不對或已過期（10 分鐘），請在遊戲裡重新產生' }), true;
      }
      delete st.codes[code];
      const token = crypto.randomBytes(24).toString('base64url');
      const k = { id: rid('con', 3), creatorId: c.creatorId, label: clampStr(body.label, 40) || 'connector', createdAt: Date.now() };
      st.connectors[sha(token)] = k;
      await saveNow();
      log(`創作世界：創作者 ${c.creatorId} 連上 connector ${k.id}`);
      return send(res, 200, { token, creatorId: c.creatorId, name: st.creators[c.creatorId]?.name }), true;
    }
    if (p.startsWith('/api/connector/') && p !== '/api/connector/code' && p !== '/api/connector/status') {
      const k = connectorOf(req);
      if (!k) return send(res, 401, { error: '沒有配對或配對已失效' }), true;
      lastSeen.set(k.creatorId, { at: Date.now(), label: k.label });
      if (p === '/api/connector/jobs' && req.method === 'GET') {
        const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000;
        let j = nextJobFor(k.creatorId);
        if (!j && wait) {
          await new Promise((resolve) => {
            const set = waiters.get(k.creatorId) || new Set();
            const done = () => {
              clearTimeout(t);
              set.delete(done);
              resolve();
            };
            const t = setTimeout(done, wait);
            set.add(done);
            waiters.set(k.creatorId, set);
            req.on('close', done);
          });
          lastSeen.set(k.creatorId, { at: Date.now(), label: k.label });
          j = nextJobFor(k.creatorId);
        }
        if (!j) return res.writeHead(204, { 'Cache-Control': 'no-store' }), res.end(), true;
        touch(j, 'working');
        j.connector = k.id;
        return send(res, 200, { job: await jobForConnector(j) }), true;
      }
      if ((m = p.match(/^\/api\/connector\/jobs\/(job_[a-z0-9]+)\/(progress|package|fail)$/)) && req.method === 'POST') {
        const j = st.jobs.find((x) => x.id === m[1]);
        // 只能碰自己這位創作者的工作
        if (!j || j.creatorId !== k.creatorId) return send(res, 403, { error: '不是你的工作' }), true;
        const body = await readBody(req, 200 * 1024);
        // 網路重送：同一個工作、同樣的程式 → 回原本的版本（不重複建版本）
        if (m[2] === 'package' && j.status === 'built' && j.lineage) {
          const ver = st.lineages[j.lineage]?.versions.find((x) => x.v === j.version);
          if (ver && typeof body?.files?.['main.js'] === 'string' && ver.codeSha256 === sha(body.files['main.js'])) return send(res, 200, { ok: true, lineage: j.lineage, version: j.version, diagnostics: null, conflict: false, status: 'built', duplicate: true }), true;
        }
        if (!['working', 'needs-fix', 'queued'].includes(j.status)) return send(res, 409, { error: `工作已經是 ${j.status}` }), true;
        if (m[2] === 'progress') {
          j.messages.push({ at: Date.now(), text: clampStr(body.message, 200) });
          if (j.messages.length > 30) j.messages.splice(0, j.messages.length - 30);
          touch(j, 'working');
          return send(res, 200, { ok: true }), true;
        }
        if (m[2] === 'fail') {
          j.messages.push({ at: Date.now(), text: clampStr(body.message, 300) });
          j.failReason = body.quota ? 'quota' : 'connector';
          touch(j, 'failed');
          return send(res, 200, { ok: true }), true;
        }
        j.attempts += 1;
        const r = await acceptPackage(j, k, body);
        j.provenance = sanitizeProvenance(body.provenance);
        if (r.ok) {
          j.lineage = r.lineage;
          j.version = r.version;
          j.diagnostics = null;
          j.messages.push({ at: Date.now(), text: `完成：${st.lineages[r.lineage].name} v${r.version}` });
          touch(j, 'built');
          log(`創作世界：工作 ${j.id} → ${r.lineage}@${r.version}`);
        } else if (r.conflict) {
          j.diagnostics = r.diagnostics;
          touch(j, 'conflict');
        } else {
          j.diagnostics = r.diagnostics;
          j.messages.push({ at: Date.now(), text: `第 ${j.attempts} 版沒通過試跑` });
          touch(j, j.attempts >= LIMITS.attempts ? 'failed' : 'needs-fix');
        }
        return send(res, 200, { ok: r.ok, lineage: r.lineage, version: r.version, diagnostics: r.diagnostics || null, conflict: !!r.conflict, status: j.status }), true;
      }
      return send(res, 404, { error: 'unknown connector api' }), true;
    }

    // ---- 瀏覽器（創作者 cookie） ----
    if (p === '/api/me' && req.method === 'POST') {
      let c = creatorOf(req);
      const body = await readBody(req, 4096);
      const headers = {};
      if (!c) {
        const secret = crypto.randomBytes(18).toString('base64url');
        c = { id: rid('cr', 3), name: clampStr(body.name, 24) || `創作者${Object.keys(st.creators).length + 1}`, secretHash: sha(secret), createdAt: Date.now() };
        st.creators[c.id] = c;
        await saveNow();
        headers['Set-Cookie'] = `vw_creator=${c.id}.${secret}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`;
      } else if (body.name) {
        c.name = clampStr(body.name, 24);
        save();
      }
      return send(res, 200, { ...publicCreator(c), connector: connectorStatus(c.id) }, headers), true;
    }
    const me = creatorOf(req);
    if (p === '/api/lineages' && req.method === 'GET') {
      const list = Object.values(st.lineages)
        .filter((L) => L.latest > 0)
        .map((L) => ({ id: L.id, name: L.name, creatorId: L.creatorId, creatorName: st.creators[L.creatorId]?.name || '?', latest: L.latest, latestGood: latestGood(L), forkOf: L.forkOf, versions: L.versions.map((x) => ({ v: x.v, stateSchema: x.stateSchema, name: x.name, at: x.at, broken: !!x.broken })) }));
      return send(res, 200, { lineages: list }), true;
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/cworlds\/([\w-]+)$/))) {
      const w = st.worlds[m[1]];
      return w ? send(res, 200, { world: publicWorld(w), lease: leaseInfo(w.id) }) : send(res, 404, { error: '找不到這個世界' }), true;
    }
    if (!me) return send(res, 401, { error: '先建立創作者身分（POST /api/me）' }), true;

    if (p === '/api/connector/code' && req.method === 'POST') {
      for (const [code, c] of Object.entries(st.codes)) if (c.expiresAt < Date.now()) delete st.codes[code];
      const code = crypto.randomBytes(5).toString('base64').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6).padEnd(6, 'X');
      st.codes[code] = { creatorId: me.id, expiresAt: Date.now() + 10 * 60 * 1000 };
      save();
      return send(res, 200, { code, expiresAt: st.codes[code].expiresAt }), true;
    }
    if (p === '/api/connector/status' && req.method === 'GET') return send(res, 200, connectorStatus(me.id)), true;

    if (p === '/api/create' && req.method === 'POST') {
      const body = await readBody(req, 16 * 1024);
      const utteranceId = clampStr(body.utteranceId, 64);
      if (!/^[\w-]{8,64}$/.test(utteranceId)) return send(res, 400, { error: 'utteranceId 不對' }), true;
      // 同一句話（同一個 utteranceId）只建一個工作：語音的最終結果重複送、網路重送都不會生兩次
      const dup = st.jobs.find((j) => j.creatorId === me.id && j.utteranceId === utteranceId);
      if (dup) return send(res, 200, { job: publicJob(dup), duplicate: true, connector: connectorStatus(me.id) }), true;
      const intent = clampStr(body.intent, LIMITS.intent).trim();
      if (!intent) return send(res, 400, { error: '要說或打一點內容' }), true;
      const w = st.worlds[body.worldId];
      if (!w) return send(res, 400, { error: '找不到這個世界' }), true;
      const target = body.targetLineage ? st.lineages[body.targetLineage] : null;
      if (body.targetLineage && !target) return send(res, 400, { error: '找不到要改的作品' }), true;
      const selected = (Array.isArray(body.selected) ? body.selected : []).slice(0, 8).map((s) => {
        const it = w.items.find((x) => x.id === s);
        return it ? { instId: it.id, lineage: it.lineage, version: it.version, name: st.lineages[it.lineage]?.name || '' } : null;
      }).filter(Boolean);
      const j = {
        id: rid('job', 4),
        creatorId: me.id,
        utteranceId,
        intent,
        source: body.source === 'voice' ? 'voice' : 'text',
        worldId: w.id,
        selected,
        targetLineage: target?.id || null,
        baseVersion: target ? Number(body.baseVersion) || target.latest : null,
        status: 'queued',
        attempts: 0,
        diagnostics: null,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      st.jobs.push(j);
      if (st.jobs.length > LIMITS.jobsKept) st.jobs.splice(0, st.jobs.length - LIMITS.jobsKept);
      save();
      wake(me.id);
      return send(res, 200, { job: publicJob(j), connector: connectorStatus(me.id) }), true;
    }
    if ((m = p.match(/^\/api\/create\/(job_[a-z0-9]+)(?:\/(cancel|runtime-fail))?$/))) {
      const j = st.jobs.find((x) => x.id === m[1]);
      if (!j || j.creatorId !== me.id) return send(res, 404, { error: '找不到這個工作' }), true;
      if (req.method === 'GET' && !m[2]) return send(res, 200, { job: publicJob(j), connector: connectorStatus(me.id) }), true;
      if (req.method === 'POST' && m[2] === 'cancel') {
        if (!['built', 'failed'].includes(j.status)) touch(j, 'cancelled');
        return send(res, 200, { job: publicJob(j) }), true;
      }
      if (req.method === 'POST' && m[2] === 'runtime-fail') {
        // 瀏覽器換版試跑沒過：舊版照常在玩；診斷回到同一個工作，交給同一位創作者的 connector 再修（以壞掉的那版為基礎）
        const body = await readBody(req, 8 * 1024);
        if (j.status !== 'built' || !j.lineage) return send(res, 409, { error: '工作不是剛完成的狀態' }), true;
        const ver = st.lineages[j.lineage]?.versions.find((x) => x.v === j.version);
        if (ver) ver.broken = true; // 版本本身不刪（不可變、留紀錄），只是不再拿來放新的實例
        j.diagnostics = [`瀏覽器換版試跑失敗（v${j.version}）：${clampStr(body.message, 400)}`];
        j.targetLineage = j.lineage;
        j.baseVersion = j.version;
        j.messages.push({ at: Date.now(), text: '換版試跑沒過，退回舊版、重新修正' });
        touch(j, 'queued');
        wake(me.id);
        return send(res, 200, { job: publicJob(j) }), true;
      }
    }
    // 同一層的即時通知（SSE）：revision（有人存檔／加作品／加傳送門）、lease（誰在跑）、handover（有人要接手）、presence（幾個分頁開著）
    if (req.method === 'GET' && (m = p.match(/^\/api\/cworlds\/([\w-]+)\/events$/))) {
      const w = st.worlds[m[1]];
      const client = url.searchParams.get('client');
      if (!w || !validClient(client)) return send(res, 400, { error: '世界或 client 不對' }), true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`retry: 1500\nevent: hello\ndata: ${JSON.stringify({ world: w.id, revision: w.revision, lease: leaseInfo(w.id) })}\n\n`);
      const l = { res, clientId: client, creatorId: me.id };
      const set = listeners.get(w.id) || new Set();
      set.add(l);
      listeners.set(w.id, set);
      presence(w.id);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        set.delete(l);
        if (!set.size) listeners.delete(w.id);
        presence(w.id);
      });
      return true;
    }
    if (p === '/api/cworlds' && req.method === 'POST') {
      const body = await readBody(req, 4096);
      const parent = st.worlds[body.parentId];
      if (!parent) return send(res, 400, { error: '找不到上一層世界' }), true;
      const mine = Object.values(st.worlds).filter((w) => w.creatorId === me.id).length;
      if (mine >= LIMITS.worldsPerCreator || Object.keys(st.worlds).length >= LIMITS.worldsTotal) return send(res, 429, { error: '世界數量到上限了' }), true;
      // 開子世界只是在上一層「加一個傳送門」：伺服器直接合併、通知上一層的其他分頁（不需要上一層的執行權，也不會覆蓋誰）
      const w = { id: rid('w', 4), parentId: parent.id, name: clampStr(body.name, 24) || `子世界 ${parent.portals.length + 1}`, creatorId: me.id, revision: 0, items: [], portals: [], createdAt: Date.now() };
      st.worlds[w.id] = w;
      parent.portals.push({ id: rid('p', 3), world: w.id, name: w.name, pos: isVec3(body.pos) ? body.pos : [parent.portals.length * 2.2 - 3, 0, -4] });
      parent.revision += 1;
      await saveNow();
      broadcast(parent.id, 'revision', { revision: parent.revision, by: validClient(body.client) ? body.client : null, reason: 'portal' });
      return send(res, 200, { world: publicWorld(w), parent: publicWorld(parent) }), true;
    }
    if (req.method === 'PUT' && (m = p.match(/^\/api\/cworlds\/([\w-]+)$/))) {
      const w = st.worlds[m[1]];
      if (!w) return send(res, 404, { error: '找不到這個世界' }), true;
      const body = await readBody(req, LIMITS.itemsPerWorld * (LIMITS.state + 512));
      const client = validClient(body.client) ? body.client : null;
      // 執行權：別的分頁正在跑這一層 → 不收（不靜默覆蓋）；沒人跑 → 存檔的人順便拿到
      const L = leaseOf(w.id);
      if (L && L.clientId !== client) return send(res, 409, { error: '這一層正由另一個分頁執行，你這邊只能看；要動手請先接手', notLeader: true, leader: L.clientId, revision: w.revision }), true;
      if (body.baseRevision !== w.revision) return send(res, 409, { error: '這個世界剛被改過（別人加了作品或傳送門）', revision: w.revision }), true;
      const r = cleanItems(body.items);
      if (r.error) return send(res, 400, { error: r.error }), true;
      w.items = r.items;
      w.revision += 1;
      w.updatedAt = Date.now();
      if (client) {
        if (L) L.until = Date.now() + LEASE_MS;
        else leases.set(w.id, { clientId: client, creatorId: me.id, until: Date.now() + LEASE_MS, pending: null });
      }
      save();
      broadcast(w.id, 'revision', { revision: w.revision, by: client, reason: clampStr(body.reason, 20) || 'save' });
      return send(res, 200, { revision: w.revision, lease: leaseInfo(w.id) }), true;
    }
    // 放一個作品到某一層（不必是自己正在跑的那層）：伺服器直接加進去、通知那一層的分頁；正在跑那層的分頁會把它併進來
    if (req.method === 'POST' && (m = p.match(/^\/api\/cworlds\/([\w-]+)\/items$/))) {
      const w = st.worlds[m[1]];
      if (!w) return send(res, 404, { error: '找不到這個世界' }), true;
      const body = await readBody(req, LIMITS.state + 4096);
      if (w.items.some((i) => i.id === body.item?.id)) return send(res, 409, { error: '這個實例已經在了' }), true;
      const r = cleanItems([...w.items, body.item]);
      if (r.error) return send(res, 400, { error: r.error }), true;
      w.items = r.items;
      w.revision += 1;
      save();
      broadcast(w.id, 'revision', { revision: w.revision, by: validClient(body.client) ? body.client : null, reason: 'append', itemId: body.item.id });
      return send(res, 200, { revision: w.revision }), true;
    }
    // 執行權：claim＝沒人跑才拿；take＝要動手：有人在跑就請他存檔交出（最多等 HANDOVER_MS，沒回應就直接接手）；renew；release
    if (req.method === 'POST' && (m = p.match(/^\/api\/cworlds\/([\w-]+)\/lease$/))) {
      const w = st.worlds[m[1]];
      if (!w) return send(res, 404, { error: '找不到這個世界' }), true;
      const body = await readBody(req, 2048);
      const client = body.client;
      if (!validClient(client)) return send(res, 400, { error: 'client 不對' }), true;
      const L = leaseOf(w.id);
      const mine = L && L.clientId === client;
      if (body.action === 'renew') {
        if (!mine) return send(res, 200, { leader: false, lease: leaseInfo(w.id), revision: w.revision }), true;
        L.until = Date.now() + LEASE_MS;
        return send(res, 200, { leader: true, pending: L.pending?.to || null, revision: w.revision }), true;
      }
      if (body.action === 'release') {
        if (mine) {
          if (L.pending) grant(w.id, L.pending.to, L.pending.creatorId, { from: client });
          else {
            leases.delete(w.id);
            broadcast(w.id, 'lease', { clientId: null, revision: w.revision, from: client });
          }
        }
        return send(res, 200, { leader: false, lease: leaseInfo(w.id), revision: w.revision }), true;
      }
      if (body.action === 'claim' || body.action === 'take') {
        if (!L || mine) {
          if (!mine) grant(w.id, client, me.id);
          else L.until = Date.now() + LEASE_MS;
          return send(res, 200, { leader: true, revision: w.revision }), true;
        }
        if (body.action === 'claim') return send(res, 200, { leader: false, lease: leaseInfo(w.id), revision: w.revision }), true;
        // take：請目前的執行者存檔交出
        if (L.pending?.to !== client) {
          L.pending = { to: client, creatorId: me.id, at: Date.now() };
          broadcast(w.id, 'handover', { from: L.clientId, to: client });
          setTimeout(() => {
            const now = leaseOf(w.id);
            if (now && now.pending?.to === client && now.clientId === L.clientId) grant(w.id, client, me.id, { from: L.clientId, forced: true });
          }, HANDOVER_MS);
        }
        return send(res, 200, { leader: false, pending: true, lease: leaseInfo(w.id), revision: w.revision }), true;
      }
      return send(res, 400, { error: 'action 要是 claim／take／renew／release' }), true;
    }
    return send(res, 404, { error: 'unknown creation api' }), true;
  }

  return {
    handle,
    ready,
    flush: saveNow,
    // 給測試／診斷：不含祕密
    stats() {
      return { creators: Object.keys(st.creators).length, connectors: Object.keys(st.connectors).length, jobs: st.jobs.length, lineages: Object.keys(st.lineages).length, worlds: Object.keys(st.worlds).length };
    },
    get denoAvailable() {
      return existsSync(denoBin);
    },
  };
}
