// Vibe 工坊伺服器
// - 提供網頁（public/）、three.js（node_modules/three）、生成的零件程式（data/parts/*.js）
// - 接打造指令 → 開一個工作資料夾 → 派 Codex（codex exec）寫零件 → 自己再驗一次 → 放進工具箱
// - 保存場景與工具箱（data/scene.json、data/library.json）
// 預設只聽 127.0.0.1。HOST=0.0.0.0 時開放區網（給 iPhone 用），但區網來的連線一律要通行碼
// （data/access-key；第一次用 ?key= 打開會存成 cookie），免得同網段的其他裝置叫 Codex、花額度。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs, createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5310);
const HOST = process.env.HOST || '127.0.0.1';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_MODEL = process.env.CODEX_MODEL || ''; // 空白＝用 ~/.codex/config.toml 的預設
const NODE_BIN = process.execPath;
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'); // 測試時指到複本
const PARTS_DIR = path.join(DATA_DIR, 'parts');
const JOBS_DIR = path.join(ROOT, 'jobs');
const LIB_FILE = path.join(DATA_DIR, 'library.json');
const SCENE_FILE = path.join(DATA_DIR, 'scene.json');
const WORLD_DIR = path.join(DATA_DIR, 'world'); // 世界模組程式（環境、規則）
const WORLDS_FILE = path.join(DATA_DIR, 'worlds.json');
const WORLD_STATE_FILE = path.join(DATA_DIR, 'world-state.json');
const MAX_CONCURRENT = 2;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;

await fs.mkdir(PARTS_DIR, { recursive: true });
await fs.mkdir(WORLD_DIR, { recursive: true });
await fs.mkdir(JOBS_DIR, { recursive: true });

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;
const isVec = (a, n) => Array.isArray(a) && a.length === n && a.every((v) => Number.isFinite(v));
const log = (...args) => console.log(new Date().toISOString(), ...args);

// 第一次啟動（還沒有工具箱）時，放入範例零件與場景，打開就有東西可以玩
const STARTER_DIR = path.join(ROOT, 'examples', 'starter');
if (!existsSync(LIB_FILE) && existsSync(path.join(STARTER_DIR, 'library.json'))) {
  await fs.cp(STARTER_DIR, DATA_DIR, { recursive: true });
  log('首次啟動：已載入範例工坊（examples/starter）');
}

if (!existsSync(WORLDS_FILE) && existsSync(path.join(STARTER_DIR, 'worlds.json'))) {
  await fs.copyFile(path.join(STARTER_DIR, 'worlds.json'), WORLDS_FILE);
  if (existsSync(path.join(STARTER_DIR, 'world'))) await fs.cp(path.join(STARTER_DIR, 'world'), WORLD_DIR, { recursive: true });
  log('已載入示範世界模組（examples/starter/worlds.json）');
}

const KEY_FILE = path.join(DATA_DIR, 'access-key');
let ACCESS_KEY;
try {
  ACCESS_KEY = (await fs.readFile(KEY_FILE, 'utf8')).trim();
} catch {
  ACCESS_KEY = '';
}
if (!/^[a-f0-9]{16,}$/.test(ACCESS_KEY)) {
  ACCESS_KEY = crypto.randomBytes(8).toString('hex');
  await fs.writeFile(KEY_FILE, `${ACCESS_KEY}\n`, { mode: 0o600 });
}

const LOCAL_NAME = (() => {
  try {
    return execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim().toLowerCase();
  } catch {
    return os.hostname().toLowerCase().replace(/\.local$/, '');
  }
})();
const lanAddresses = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((ni) => ni && ni.family === 'IPv4' && !ni.internal)
    .map((ni) => ni.address);
let hostCache = { at: 0, set: new Set() };
function allowedHosts() {
  // 只接受「指名這台機器」的 Host（防 DNS rebinding）；IP 可能被 DHCP 換掉，所以每 30 秒重算
  if (Date.now() - hostCache.at < 30_000) return hostCache.set;
  const set = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `${LOCAL_NAME}.local:${PORT}`]);
  for (const ip of lanAddresses()) set.add(`${ip}:${PORT}`);
  hostCache = { at: Date.now(), set };
  return set;
}
const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
const isPrivate = (addr) => {
  const a = String(addr).replace(/^::ffff:/, '');
  return /^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || /^(fe80:|fc|fd)/i.test(a);
};
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const cookieValue = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
};
const KEY_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vibe 工坊</title><body style="background:#05080f;color:#d9f6ff;font-family:-apple-system,sans-serif;padding:28px;line-height:1.7">
<h2 style="color:#38e1ff;letter-spacing:.1em">VIBE 工坊</h2><p>需要通行碼：請用帶 <code>?key=</code> 的連結打開一次，之後這個裝置就會記住。</p>
<p>Access key required: open the link that ends with <code>?key=…</code> once and this device will remember it.</p></body>`;

const library = await readJson(LIB_FILE, { parts: [] });
let scene = await readJson(SCENE_FILE, { instances: [] });
const partById = (id) => library.parts.find((p) => p.id === id);
const worlds = await readJson(WORLDS_FILE, { modules: [] });
let worldState = await readJson(WORLD_STATE_FILE, { environment: null, rules: [], safeMode: false });
const worldById = (id) => worlds.modules.find((m) => m.id === id);

// ---------------- 打造工作（Codex） ----------------

const jobs = new Map();
const queue = [];
let running = 0;

function addLog(job, line) {
  job.log.push({ at: Date.now(), line });
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}

function publicJob(job) {
  const now = Date.now();
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    mode: job.mode,
    elapsedMs: job.startedAt ? (job.finishedAt || now) - job.startedAt : 0,
    queuedMs: job.startedAt ? 0 : now - job.createdAt,
    log: job.log.slice(-12).map((l) => l.line),
    part: job.part,
    module: job.module,
    placement: job.placement,
    error: job.error,
    warnings: job.warnings,
  };
}

function enqueue(job) {
  jobs.set(job.id, job);
  queue.push(job);
  addLog(job, running >= MAX_CONCURRENT ? '⏳ 排隊中…' : '🚀 準備開工');
  pump();
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    if (job.status === 'cancelled') continue;
    running += 1;
    runJob(job)
      .catch((err) => {
        if (job.status === 'cancelled') return;
        job.status = 'error';
        job.error = String(err?.message || err).slice(0, 1200);
        job.finishedAt = Date.now();
        addLog(job, `⚠️ ${job.error.split('\n')[0]}`);
        log('job failed', job.id, job.error.split('\n')[0]);
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function buildContext(job) {
  return {
    request: job.prompt,
    mode: job.mode,
    selection: job.selection,
    scene: job.scene,
    player: { position: job.player },
    library: library.parts.filter((p) => !p.hidden).map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      description: p.description,
      size: p.size,
    })),
    base_part: job.mode === 'modify' ? 'base_part.js' : null,
    world: worldSummary(),
    paths: {
      runtime: path.join(PUBLIC_DIR, 'runtime.mjs'),
      worldhost: path.join(PUBLIC_DIR, 'worldhost.mjs'),
      partsDir: PARTS_DIR,
      libraryFile: LIB_FILE,
    },
  };
}

function worldSummary() {
  const brief = (m) => m && { id: m.id, type: m.type, name: m.name, description: m.description };
  const env = worldState.safeMode ? null : worldById(worldState.environment);
  const rules = worldState.safeMode ? [] : worldState.rules.map(worldById).filter(Boolean);
  return {
    environment: brief(env) || null,
    rules: rules.map(brief),
    library: worlds.modules.filter((m) => !m.hidden).map(brief),
    activeSources: 'world_active/<id>.js',
  };
}

function taskPrompt(job) {
  const modeLine =
    job.mode === 'modify'
      ? `Mode: modify — the selected part's current code is in base_part.js; write a full updated part.js.`
      : `Mode: create — build a new part.`;
  return [
    `You are the fabricator of the "Vibe 工坊" (Vibe Workshop). Follow AGENTS.md exactly.`,
    `The user, standing inside the workshop, said: 「${job.prompt}」`,
    modeLine,
    `Read context.json. First decide whether this is a part, an environment or a rule (see AGENTS.md).`,
    `Write part.js or world.js plus meta.json in this directory, then run \`node validate.mjs\` and fix until it prints PASS.`,
  ].join('\n');
}

function summarizeEvent(ev) {
  const item = ev.item || {};
  const short = (s, n = 90) => {
    const str = String(s ?? '').replace(/\s+/g, ' ').trim();
    return str.length > n ? `${str.slice(0, n)}…` : str;
  };
  if (ev.type === 'item.started' && item.type === 'command_execution') {
    const cmd = short(item.command, 70);
    return /validate\.mjs/.test(cmd) ? '🔍 Codex 正在驗證零件…' : `⚙️ ${cmd}`;
  }
  if (ev.type === 'item.completed' && item.type === 'command_execution' && /validate\.mjs/.test(item.command || '')) {
    const out = String(item.aggregated_output || item.output || '');
    if (/^PASS/m.test(out)) return '✅ 驗證通過';
    if (/^FAIL/m.test(out)) return `🔧 驗證沒過，修正中：${short((out.match(/✗ (.*)/) || [])[1] || '', 60)}`;
  }
  if (ev.type === 'item.completed' && item.type === 'file_change') {
    const files = (item.changes || []).map((c) => path.basename(c.path || '')).filter(Boolean);
    return files.length ? `📝 寫入 ${files.join('、')}` : null;
  }
  if (ev.type === 'item.completed' && item.type === 'agent_message') return `💬 ${short(item.text, 120)}`;
  if (ev.type === 'turn.failed') return `⚠️ ${short(ev.error?.message, 160)}`;
  if (ev.type === 'error') return `⚠️ ${short(ev.message, 160)}`;
  return null;
}

function runCodex(job, dir) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', dir, '--json'];
  if (CODEX_MODEL) args.push('-m', CODEX_MODEL);
  args.push('-o', path.join(dir, 'last-message.txt'), taskPrompt(job));
  return new Promise((resolve, reject) => {
    const proc = spawn(CODEX_BIN, args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    job.proc = proc;
    let buf = '';
    let stderrTail = '';
    const events = [];
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        events.push(line);
        try {
          const msg = summarizeEvent(JSON.parse(line));
          if (msg) addLog(job, msg);
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      addLog(job, '⏰ 超過 8 分鐘，停止這次打造');
      proc.kill('SIGTERM');
    }, JOB_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`無法啟動 Codex：${err.message}`));
    });
    proc.on('close', async (code, signal) => {
      clearTimeout(timer);
      job.proc = null;
      await fs.writeFile(path.join(dir, 'events.jsonl'), events.join('\n')).catch(() => {});
      await fs.writeFile(path.join(dir, 'stderr.txt'), stderrTail).catch(() => {});
      resolve({ code, signal, stderrTail });
    });
  });
}

function runValidator(dir) {
  return new Promise((resolve) => {
    const proc = spawn(NODE_BIN, ['validate.mjs', '--json'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop();
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ ok: false, errors: [`驗證器沒有回應：${(err || out).slice(-500)}`], warnings: [] });
      }
    });
  });
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  const dir = path.join(JOBS_DIR, job.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'fabricator', 'AGENTS.md'), path.join(dir, 'AGENTS.md'));
  await fs.copyFile(path.join(ROOT, 'fabricator', 'validate.mjs'), path.join(dir, 'validate.mjs'));
  if (job.mode === 'modify') {
    await fs.copyFile(path.join(PARTS_DIR, `${job.basePartId}.js`), path.join(dir, 'base_part.js'));
  }
  const ctxData = buildContext(job);
  const activeIds = [ctxData.world.environment?.id, ...ctxData.world.rules.map((r) => r.id)].filter(Boolean);
  if (activeIds.length) {
    await fs.mkdir(path.join(dir, 'world_active'), { recursive: true });
    for (const id of activeIds) {
      await fs.copyFile(path.join(WORLD_DIR, `${id}.js`), path.join(dir, 'world_active', `${id}.js`)).catch(() => {});
    }
  }
  await writeJson(path.join(dir, 'context.json'), ctxData);
  addLog(job, '🧠 Codex 開始設計…');
  log('job start', job.id, job.mode, job.prompt);

  const result = await runCodex(job, dir);
  if (job.status === 'cancelled') return;

  addLog(job, '🔍 最後檢查…');
  const report = await runValidator(dir);
  if (!report.ok) {
    const hint = result.code !== 0 ? `\nCodex 結束碼 ${result.code}：${result.stderrTail.slice(-400)}` : '';
    throw new Error(`零件沒有通過檢查：${(report.errors || []).join('；')}${hint}`);
  }

  if (report.kind === 'environment' || report.kind === 'rule') {
    const worldId = newId('w');
    await fs.copyFile(path.join(dir, 'world.js'), path.join(WORLD_DIR, `${worldId}.js`));
    const mod = {
      id: worldId,
      type: report.kind,
      name: report.meta.name,
      description: report.meta.description,
      prompt: job.prompt,
      replaces: report.meta.replaces || null,
      stats: report.stats,
      jobId: job.id,
      createdAt: new Date().toISOString(),
    };
    worlds.modules.push(mod);
    await writeJson(WORLDS_FILE, worlds);
    job.module = mod;
    job.warnings = report.warnings || [];
    job.status = 'done';
    job.finishedAt = Date.now();
    addLog(job, `✅ 完成：${mod.type === 'environment' ? '環境' : '規則'}「${mod.name}」`);
    log('job done', job.id, mod.type, mod.name, `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`);
    return;
  }

  const partId = newId('p');
  await fs.copyFile(path.join(dir, 'part.js'), path.join(PARTS_DIR, `${partId}.js`));
  const record = {
    id: partId,
    name: report.meta.name,
    kind: 'generated',
    description: report.meta.description,
    prompt: job.prompt,
    size: report.size,
    placement: report.meta.placement,
    controls: report.meta.controls || null,
    wearSlot: report.meta.wearSlot || null,
    stats: report.stats,
    basedOn: job.basePartId || null,
    jobId: job.id,
    createdAt: new Date().toISOString(),
  };
  library.parts.push(record);
  await writeJson(LIB_FILE, library);
  job.part = record;
  job.placement = report.meta.placement;
  job.warnings = report.warnings || [];
  job.status = 'done';
  job.finishedAt = Date.now();
  addLog(job, `✅ 完成：${record.name}`);
  log('job done', job.id, record.name, `${Math.round((job.finishedAt - job.startedAt) / 1000)}s`);
}

// ---------------- HTTP ----------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

async function serveFile(res, baseDir, rel, cache = 'no-cache') {
  const file = path.resolve(baseDir, `.${path.posix.normalize(`/${rel}`)}`);
  if (!file.startsWith(baseDir + path.sep) && file !== baseDir) return send(res, 403, 'forbidden');
  try {
    const st = await fs.stat(file);
    const target = st.isDirectory() ? path.join(file, 'index.html') : file;
    await fs.access(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': cache,
    });
    createReadStream(target).pipe(res);
  } catch {
    send(res, 404, 'not found');
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanTransform(c) {
  return {
    partId: String(c.partId),
    position: c.position.map(round3),
    quaternion: c.quaternion.map((v) => Math.round(v * 1e6) / 1e6),
    scale: c.scale.map(round3),
  };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: '需要 application/json' });
  }

  if (req.method === 'GET' && p === '/api/state') {
    return send(res, 200, { library, scene, worlds, worldState, limits: { maxConcurrent: MAX_CONCURRENT } });
  }

  if (req.method === 'PUT' && p === '/api/scene') {
    const body = await readBody(req);
    if (!Array.isArray(body.instances)) return send(res, 400, { error: 'instances 必須是陣列' });
    const instances = [];
    for (const it of body.instances) {
      if (!it || typeof it.id !== 'string' || !partById(it.partId)) continue;
      if (!isVec(it.position, 3) || !isVec(it.quaternion, 4) || !isVec(it.scale, 3)) continue;
      instances.push({ id: it.id, ...cleanTransform(it) });
    }
    scene = { instances, savedAt: new Date().toISOString() };
    await writeJson(SCENE_FILE, scene);
    return send(res, 200, { ok: true, count: instances.length });
  }

  if (req.method === 'POST' && p === '/api/composite') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 30);
    if (!name) return send(res, 400, { error: '零件需要名稱' });
    if (!Array.isArray(body.children) || !body.children.length) return send(res, 400, { error: '沒有子零件' });
    const children = [];
    for (const c of body.children) {
      if (!partById(c.partId)) return send(res, 400, { error: `找不到零件 ${c.partId}` });
      if (!isVec(c.position, 3) || !isVec(c.quaternion, 4) || !isVec(c.scale, 3)) {
        return send(res, 400, { error: '子零件位置格式錯誤' });
      }
      children.push(cleanTransform(c));
    }
    const names = [...new Set(children.map((c) => partById(c.partId).name))];
    const record = {
      id: newId('c'),
      name,
      kind: 'composite',
      description: String(body.description || `由 ${children.length} 個零件組成：${names.slice(0, 6).join('、')}`).slice(0, 200),
      size: isVec(body.size, 3) ? body.size.map(round3) : [1, 1, 1],
      children,
      createdAt: new Date().toISOString(),
    };
    library.parts.push(record);
    await writeJson(LIB_FILE, library);
    log('composite', record.id, name, children.length);
    return send(res, 200, record);
  }

  if (req.method === 'POST' && p === '/api/generate') {
    const body = await readBody(req);
    const prompt = String(body.prompt || '').trim().slice(0, 1000);
    if (!prompt) return send(res, 400, { error: '請說要打造什麼' });
    const mode = body.mode === 'modify' ? 'modify' : 'create';
    const base = mode === 'modify' ? partById(body.basePartId) : null;
    if (mode === 'modify' && (!base || base.kind !== 'generated')) {
      return send(res, 400, { error: '只能改造 AI 打造的零件（組合零件請先拆開）' });
    }
    const job = {
      id: newId('job'),
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      prompt,
      mode,
      basePartId: base?.id || null,
      selection: Array.isArray(body.selection) ? body.selection.slice(0, 20) : [],
      scene: Array.isArray(body.scene) ? body.scene.slice(0, 60) : [],
      player: isVec(body.player, 3) ? body.player.map(round3) : [0, 1.6, 3],
      log: [],
      part: null,
      placement: null,
      error: null,
      warnings: [],
      proc: null,
    };
    enqueue(job);
    return send(res, 200, { job: publicJob(job) });
  }

  let m;
  if (req.method === 'GET' && (m = p.match(/^\/api\/jobs\/([\w-]+)$/))) {
    const job = jobs.get(m[1]);
    return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'job not found' });
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/jobs\/([\w-]+)\/cancel$/))) {
    const job = jobs.get(m[1]);
    if (!job) return send(res, 404, { error: 'job not found' });
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      addLog(job, '🛑 已取消');
      job.proc?.kill('SIGTERM');
    }
    return send(res, 200, publicJob(job));
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/parts\/([\w-]+)\/controls$/))) {
    // 使用者在「要怎麼操作它？」選的模式，記在零件上
    const part = partById(m[1]);
    if (!part) return send(res, 404, { error: '找不到零件' });
    const body = await readBody(req);
    if (body.controls !== null && !['drive', 'fly', 'wear'].includes(body.controls)) {
      return send(res, 400, { error: 'controls 只能是 drive / fly / wear / null' });
    }
    part.controls = body.controls;
    await writeJson(LIB_FILE, library);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'PUT' && p === '/api/world-state') {
    // 哪個環境、哪些規則啟用中（由瀏覽器決定，伺服器只記）
    const body = await readBody(req);
    const env = worldById(body.environment);
    const rules = [...new Set(Array.isArray(body.rules) ? body.rules : [])]
      .filter((id) => worldById(id)?.type === 'rule')
      .slice(0, 30);
    worldState = {
      environment: env && env.type === 'environment' ? env.id : null,
      rules,
      safeMode: body.safeMode === true,
      savedAt: new Date().toISOString(),
    };
    await writeJson(WORLD_STATE_FILE, worldState);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/world\/([\w-]+)\/hide$/))) {
    const mod = worldById(m[1]);
    if (!mod) return send(res, 404, { error: '找不到世界模組' });
    mod.hidden = true;
    await writeJson(WORLDS_FILE, worlds);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/parts\/([\w-]+)\/hide$/))) {
    // 從工具箱移除＝隱藏：場景裡已放的、其他零件引用到的都照常能用
    const part = partById(m[1]);
    if (!part) return send(res, 404, { error: '找不到零件' });
    part.hidden = true;
    await writeJson(LIB_FILE, library);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden host');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const remote = req.socket.remoteAddress || '';
    if (!isLoopback(remote)) {
      if (!isPrivate(remote)) return send(res, 403, 'forbidden');
      const given = url.searchParams.get('key');
      if (given && safeEqual(given, ACCESS_KEY)) {
        url.searchParams.delete('key');
        res.writeHead(302, {
          'Set-Cookie': `vw_key=${ACCESS_KEY}; Path=/; Max-Age=31536000; SameSite=Strict; HttpOnly`,
          Location: `${url.pathname}${url.search}`,
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      if (!safeEqual(cookieValue(req, 'vw_key'), ACCESS_KEY)) {
        return send(res, 401, KEY_PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
      }
    }
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    if (p.startsWith('/vendor/three/')) return serveFile(res, THREE_DIR, p.slice('/vendor/three/'.length), 'max-age=86400');
    const pm = p.match(/^\/parts\/([a-z]_[a-z0-9]+)\.js$/);
    if (pm) return serveFile(res, PARTS_DIR, `${pm[1]}.js`, 'max-age=31536000, immutable');
    const wm = p.match(/^\/world\/(w_[a-z0-9]+)\.js$/);
    if (wm) return serveFile(res, WORLD_DIR, `${wm[1]}.js`, 'max-age=31536000, immutable');
    return serveFile(res, PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
  } catch (err) {
    log('request error', req.method, req.url, err?.message);
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  log(`Vibe 工坊 http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    log(`區網：${lanAddresses().map((ip) => `http://${ip}:${PORT}`).join('、')}、http://${LOCAL_NAME}.local:${PORT}（要通行碼，見 data/access-key）`);
  }
});
