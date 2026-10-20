#!/usr/bin/env node
// Vibe 工坊「創作世界」connector：在**創作者自己的電腦**上執行，用創作者自己已登入的 Codex CLI 生成作品包，再送到遊戲伺服器。
//   node connector/vibe-connector.mjs pair <伺服器網址> <配對碼> [--label 名稱] [--state 檔案]
//   node connector/vibe-connector.mjs run [<伺服器網址>] [--state 檔案] [--codex 路徑] [--fixture 資料夾] [--once] [--max-attempts 3]
// 協定見 docs/creation-sdk.md 第 4 節；給 Codex 的規格書、範例與本機自查在 connector/template/（每個工作複製一份到暫存資料夾）。
// - 只用 Node 內建模組（Node 20 以上），不用安裝任何東西。
// - 不讀任何 Codex／OpenAI 憑證：只是用創作者自己的環境（環境變數原樣繼承）執行 `codex exec`，登入與額度由 Codex CLI 自己處理。
// - 送給伺服器的只有：配對碼與標籤、token（Authorization 標頭）、進度摘要、作品包（manifest.json＋main.js）、
//   來源紀錄（工具版本、方式、第幾版、耗時）、失敗原因。不送主機名稱、帳號、email、本機路徑、CODEX_HOME；
//   進度和作品包送出前還會再掃一次，擋下看起來像本機資訊或金鑰的內容。
// - 生成出來的程式 connector 自己不執行：Codex 在它的沙盒裡跑 check.mjs，最後的關卡是伺服器的零權限影子試跑。
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, createWriteStream, existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(HERE, 'template');
export const STATE_DIR = path.join(os.homedir(), '.vibe-connector');
export const LIMITS = { manifestBytes: 4 * 1024, mainBytes: 64 * 1024 };
export const CODEX_TIMEOUT_MS = 10 * 60 * 1000;
export const BUSY_WAITS_MS = [30_000, 60_000]; // OpenAI 回「太忙」時等多久再自動重跑（不算一輪；跟伺服器的打造一樣）
const POLL_WAIT_S = 25;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_LABEL = '我的 Codex';
const TOKEN_RE = /^[\w-]{20,200}$/;
const SCRIPT = path.relative(process.cwd(), fileURLToPath(import.meta.url)) || 'vibe-connector.mjs';

const USAGE = `Vibe 工坊 connector：用你自己的 Codex 替「創作世界」生成作品

  配對（在遊戲裡按「連接我的 Codex」拿到配對碼，10 分鐘有效）：
    node ${SCRIPT} pair <伺服器網址> <配對碼> [--label 名稱] [--state 檔案]

  開始接工作（Ctrl+C 結束）：
    node ${SCRIPT} run [<伺服器網址>] [--codex codex 路徑] [--max-attempts 3] [--once] [--state 檔案]

  協定測試（不叫 Codex，直接送資料夾裡的 manifest.json＋main.js；有 attempt2/ 的話第 2 輪改送它）：
    node ${SCRIPT} run <伺服器網址> --fixture connector/fixtures/good --once`;

export class UsageError extends Error {}

const defaultLog = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
const clip = (s, n) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};
const oneLine = (s, n) => clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------- 參數、伺服器網址、配對資料 ----------------

export function parseArgs(argv) {
  const out = { _: [] };
  const withValue = { '--label': 'label', '--state': 'state', '--codex': 'codex', '--fixture': 'fixture', '--max-attempts': 'maxAttempts' };
  const flags = { '--once': 'once', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const key = eq > 0 ? a.slice(0, eq) : a;
    if (withValue[key]) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[(i += 1)];
      if (v === undefined || v === '') throw new UsageError(`${key} 後面要接值`);
      out[withValue[key]] = v;
    } else if (flags[a]) out[flags[a]] = true;
    else if (a.startsWith('-')) throw new UsageError(`不認得的選項 ${a}`);
    else out._.push(a);
  }
  return out;
}

export function normalizeServer(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new UsageError('要給遊戲伺服器網址，例如 http://192.168.1.20:5310');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new UsageError(`看不懂這個伺服器網址：${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UsageError('伺服器網址要是 http:// 或 https:// 開頭');
  if (u.username || u.password) throw new UsageError('伺服器網址不要帶帳號密碼');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// 一台伺服器一個檔：~/.vibe-connector/<主機>_<埠>.json
export function stateFileFor(server, dir = STATE_DIR) {
  const u = new URL(normalizeServer(server));
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return path.join(dir, `${u.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, '_')}_${port}.json`);
}

// 配對資料只有自己讀得到（資料夾 0700、檔案 0600）；先寫暫存檔再換名，不會寫到一半
export async function saveState(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

export async function loadState(file) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new UsageError(`還沒配對（找不到 ${file}）：先在遊戲裡按「連接我的 Codex」拿配對碼，再執行 pair <伺服器網址> <配對碼>`);
    throw new UsageError(`配對資料 ${file} 壞了，請重新 pair`);
  }
  if (!data || typeof data.token !== 'string' || !TOKEN_RE.test(data.token) || typeof data.server !== 'string') throw new UsageError(`配對資料 ${file} 不完整，請重新 pair`);
  data.server = normalizeServer(data.server);
  try {
    if ((await fs.stat(file)).mode & 0o077) await fs.chmod(file, 0o600); // 被改成別人讀得到：收回來
  } catch {
    /* 不影響使用 */
  }
  return data;
}

export async function resolveRunTarget({ server, stateFile, stateDir = STATE_DIR }) {
  let file;
  if (stateFile) file = path.resolve(stateFile);
  else if (server) file = stateFileFor(server, stateDir);
  else {
    const list = (await fs.readdir(stateDir).catch(() => [])).filter((f) => f.endsWith('.json'));
    if (!list.length) throw new UsageError('還沒配對：先在遊戲裡按「連接我的 Codex」拿配對碼，再執行 pair <伺服器網址> <配對碼>');
    if (list.length > 1) throw new UsageError(`配對過好幾台伺服器，請指定要連哪一台（run <伺服器網址>）：${list.map((f) => f.replace(/\.json$/, '')).join('、')}`);
    file = path.join(stateDir, list[0]);
  }
  const state = await loadState(file);
  // token 只能送回配對的那台伺服器
  if (server && normalizeServer(server) !== state.server) throw new UsageError(`${file} 是配對 ${state.server} 的，不是 ${normalizeServer(server)}`);
  return { server: state.server, file, state };
}

// ---------------- 跟伺服器講話 ----------------

const netError = (e) => {
  const c = e?.cause;
  return c?.code ? `${c.code}${c.message && !String(c.message).includes(c.code) ? `：${c.message}` : ''}` : e?.message || String(e);
};

export function createApi(server, token) {
  const headers = { Accept: 'application/json', 'User-Agent': 'vibe-connector/1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  async function once(method, p, body, timeoutMs, signal) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒沒有回應`)), timeoutMs);
    const onAbort = () => ac.abort(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${server}${p}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
        redirect: 'manual', // 不跟著轉址走（token 只送給配對的那台）
      });
      const text = await res.text();
      if (res.status >= 300 && res.status < 400) throw new Error(`伺服器要求轉址（${res.status}）：請直接用轉址後的網址`);
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { status: res.status, data };
    } catch (e) {
      if (ac.signal.aborted && !signal?.aborted) throw new Error(ac.signal.reason?.message || '逾時');
      throw new Error(netError(e));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return {
    // retries：網路錯誤、502／503／504 時重送幾次（1、2、4… 秒後）
    async request(method, p, body, { timeoutMs = 30_000, signal, retries = 0 } = {}) {
      for (let n = 0; ; n += 1) {
        try {
          const r = await once(method, p, body, timeoutMs, signal);
          if (n < retries && [502, 503, 504].includes(r.status) && (await sleep(1000 * 2 ** n, signal))) continue;
          return r;
        } catch (e) {
          if (signal?.aborted || n >= retries) throw e;
          if (!(await sleep(1000 * 2 ** n, signal))) throw e;
        }
      }
    },
  };
}

function explainStatus(status) {
  if (status === 403) return '配對碼不對或已過期（10 分鐘有效），請在遊戲裡重新產生';
  if (status === 429) return '配對嘗試太多次，一分鐘後再試';
  if (status === 404) return '這台伺服器還不支援 connector（網址對嗎？伺服器版本太舊？）';
  if (status === 401) return '伺服器要通行碼：connector 的 API 應該不用，請確認伺服器版本';
  return `伺服器回了 ${status}`;
}

export async function pair({ server, code, label, stateFile, stateDir = STATE_DIR, log = defaultLog, timeoutMs = 15_000 }) {
  const url = normalizeServer(server);
  const file = stateFile ? path.resolve(stateFile) : stateFileFor(url, stateDir);
  const cleanCode = String(code ?? '').trim();
  if (!cleanCode) throw new UsageError('要給配對碼（在遊戲裡按「連接我的 Codex」會看到）');
  const cleanLabel = oneLine(label, 40) || DEFAULT_LABEL; // 預設不用電腦名稱（不送本機資訊）
  let r;
  try {
    r = await createApi(url, null).request('POST', '/api/connector/pair', { code: cleanCode, label: cleanLabel }, { timeoutMs });
  } catch (e) {
    log(`✗ 連不到 ${url}（${e.message}）：確認網址和埠號，以及這台電腦跟遊戲伺服器在同一個網路`);
    return 1;
  }
  const { token, creatorId, name } = r.data || {};
  if (r.status !== 200 || typeof token !== 'string' || !creatorId) {
    log(`✗ 配對失敗：${r.data?.error || explainStatus(r.status)}`);
    return 1;
  }
  if (!TOKEN_RE.test(token)) {
    log('✗ 配對失敗：伺服器回的 token 格式不對');
    return 1;
  }
  await saveState(file, { server: url, creatorId: String(creatorId), name: name ? String(name) : null, label: cleanLabel, token, pairedAt: new Date().toISOString() });
  log(`已連接：創作者 ${name ? `${name}（${creatorId}）` : creatorId}`);
  log(`配對資料存在 ${file}（只有你自己讀得到）。接著執行：node ${SCRIPT} run ${url}`);
  return 0;
}

// ---------------- 給 Codex 的工作 ----------------

function cleanTarget(t) {
  if (!t || typeof t !== 'object' || typeof t.code !== 'string') return null;
  return {
    lineage: String(t.lineage ?? ''),
    baseVersion: Number.isFinite(t.baseVersion) ? t.baseVersion : null,
    name: String(t.name ?? ''),
    manifest: t.manifest && typeof t.manifest === 'object' ? t.manifest : null,
    code: t.code,
  };
}

export function cleanDiagnostics(d) {
  const list = (Array.isArray(d) ? d : d == null ? [] : [d]).map((x) => clip(String(x ?? '').trim(), 600)).filter(Boolean);
  return list.length ? list.slice(0, 20) : null;
}

// 工作資料夾裡的 job.json（Codex 讀它；check.mjs 用 target 做換版測試）
export function buildJobJson(job, { round = 1, diagnostics = null } = {}) {
  const target = cleanTarget(job?.target);
  return {
    intent: String(job?.intent ?? ''),
    source: job?.source === 'voice' ? 'voice' : 'text',
    mode: target ? 'modify' : 'create',
    round,
    selected: (Array.isArray(job?.selected) ? job.selected : []).slice(0, 8).map((s) => ({ instId: s?.instId ?? null, lineage: s?.lineage ?? null, version: s?.version ?? null, name: String(s?.name ?? '') })),
    target,
    diagnostics: cleanDiagnostics(diagnostics),
  };
}

// 給 codex exec 的任務說明（規格細節在 AGENTS.md，這裡只說這一次要做什麼）
export function taskPrompt(job, { round = 1, diagnostics = null } = {}) {
  const target = cleanTarget(job?.target);
  const diag = cleanDiagnostics(diagnostics);
  const intent = oneLine(job?.intent, 600) || '（沒有內容）';
  return [
    '你是 Vibe 工坊「創作世界」的作品生成器：在創作者自己的電腦上，替他做一個能放進 3D 世界裡玩的小作品。完全照這個資料夾的 AGENTS.md 做。',
    `玩家${job?.source === 'voice' ? '用語音' : '打字'}說：「${intent}」`,
    target
      ? `模式：修改——這個資料夾的 main.js、manifest.json 現在是作品「${target.name}」v${target.baseVersion ?? '?'}（job.json 的 target 也有一份原文）。照玩家的話改它：沒被要求改的玩法和名稱都保留；state 的形狀變了就把 stateSchema 加 1 並寫 migrate(old, fromSchema)。`
      : '模式：新作品——從零做一個新的作品包。',
    '先讀 AGENTS.md 和 job.json，再打開 examples/ 裡最接近的範例參考寫法。',
    '只在這個資料夾寫 manifest.json 和 main.js（不要改其他檔案、不要讀這個資料夾以外的東西），然後執行 `node check.mjs`，修到最後一行印出「check 通過」為止。',
    ...(diag
      ? [
          `${round > 1 ? `這是第 ${round} 輪。` : ''}上一版沒通過檢查，job.json 的 diagnostics 是原因：${clip(diag.map((x) => x.replace(/\s+/g, ' ')).join('；'), 1500)}`,
          '先讀資料夾裡現在的 main.js、manifest.json，保留能用的部分，把這些問題修好，再跑 `node check.mjs` 到通過。',
        ]
      : []),
    '最後用一句話（跟玩家同一種語言）說你做了什麼。',
  ].join('\n');
}

export function buildCodexArgs(dir, prompt) {
  return ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', dir, '--json', '-o', path.join(dir, 'last-message.txt'), prompt];
}

// 協定測試：第 n 輪送 attempt<n>/（沒有就往前找，最後是資料夾本身）
export function fixtureDirFor(base, round) {
  for (let n = round; n >= 2; n -= 1) {
    const d = path.join(base, `attempt${n}`);
    if (existsSync(path.join(d, 'main.js')) || existsSync(path.join(d, 'manifest.json'))) return d;
  }
  return base;
}

// 每個工作一個暫存資料夾（0700）：規格書、自查、範例；修改既有作品時先放進舊版當起點
export async function prepareWorkdir(job, { templateDir = TEMPLATE_DIR, workRoot = os.tmpdir() } = {}) {
  const dir = await fs.mkdtemp(path.join(workRoot, 'vibe-job-'));
  await fs.copyFile(path.join(templateDir, 'AGENTS.md'), path.join(dir, 'AGENTS.md'));
  await fs.copyFile(path.join(templateDir, 'check.mjs'), path.join(dir, 'check.mjs'));
  await fs.cp(path.join(templateDir, 'examples'), path.join(dir, 'examples'), { recursive: true });
  const target = cleanTarget(job?.target);
  if (target) {
    if (target.manifest) await fs.writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(target.manifest, null, 2)}\n`);
    await fs.writeFile(path.join(dir, 'main.js'), target.code);
  }
  return dir;
}

// ---------------- Codex 的錯誤分類 ----------------

const QUOTA_RE = /usage[ _-]?limit|insufficient[_ ]quota|\bquota\b|out of credits|purchase more credits|billing/i;
const AUTH_RE = /not (?:logged|signed) in|codex login|log ?in (?:again|first)|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|authentication (?:failed|required|error)|missing (?:openai_api_key|api key|environment variable)|invalid[_ ]api[_ ]key|incorrect api key|token (?:has )?expired|refresh[_ ]token|re-?authenticate/i;
const BUSY_RE = /\b429\b|too many requests|rate[ _-]?limit|at capacity|overloaded|high demand|temporarily unavailable|service unavailable|stream disconnected|reconnecting|connection (?:reset|refused|closed)|timed? ?out\b|\b50[0234]\b|internal server error|bad gateway/i;

// 'quota'（額度用完）｜'auth'（沒登入／過期）｜'busy'（OpenAI 暫時太忙、連線斷掉）｜null（其他＝一般失敗）
export function classifyCodexFailure(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  if (QUOTA_RE.test(s)) return 'quota';
  if (AUTH_RE.test(s)) return 'auth';
  if (BUSY_RE.test(s)) return 'busy';
  return null;
}

// 送給伺服器的失敗原因（額度用完要跟一般失敗分清楚；不轉送 Codex 原文裡的帳號、方案資訊）
export function failureMessage(kind, { detail = '', bin = 'codex', code = null, what = '' } = {}) {
  switch (kind) {
    case 'quota': {
      const when = /try again (?:at|in) ([^.\n]{1,60})/i.exec(detail || '');
      return `你的 Codex 額度用完了（用的是創作者自己的 Codex 帳號）：等額度恢復再試${when ? `（Codex 說可以在 ${when[1].trim()} 再試）` : ''}。`;
    }
    case 'auth':
      return '這台電腦的 Codex 還沒登入或登入已過期：請在跑 connector 的電腦上執行 codex login，再重新送出一次。';
    case 'missing':
      return `找不到 Codex（${path.basename(String(bin))}）：請在跑 connector 的電腦安裝 Codex CLI 並執行 codex login，或用 --codex 指定路徑。`;
    case 'busy':
      return 'OpenAI 那邊一直很忙（不是描述的問題），過幾分鐘再試一次。';
    case 'timeout':
      return `Codex 超過 ${Math.round(CODEX_TIMEOUT_MS / 60000)} 分鐘還沒做完，已經停止這次生成：可以把需求說得簡單一點再試。`;
    case 'stopped':
      return '創作者電腦上的 connector 被停止了，這個工作沒有完成。';
    case 'leak':
      return `connector 沒有送出這一版：作品裡出現疑似這台電腦的本機資訊（${what}），為了保護創作者的資料先擋下來。請換個說法再試。`;
    default:
      return `Codex 沒有完成這次生成（結束碼 ${code ?? '?'}）${detail ? `：${oneLine(detail, 160)}` : ''}`;
  }
}

// ---------------- 本機資訊：不送出去 ----------------

const GENERIC_NAMES = new Set(['user', 'admin', 'root', 'test', 'guest', 'ubuntu', 'debian', 'runner', 'codex', 'player', 'game', 'vagrant', 'ec2-user', 'node', 'demo', 'default', 'owner', 'home', 'work', 'localhost', 'macbook', 'computer']);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const ACCOUNT_RE = /\b(?:org|proj|user|acct)[-_][A-Za-z0-9]{8,}\b/g; // OpenAI 的組織／專案／使用者 id（錯誤訊息裡可能有）
const SECRET_RES = [
  ['私密金鑰', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API 金鑰', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['登入權杖', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];

// 這台電腦的名字們：[說明, 值]
export function localNames(env = process.env) {
  const out = [];
  const home = os.homedir();
  if (home && home.length > 3) out.push(['家目錄路徑', home]);
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = env.USER || env.USERNAME || '';
  }
  if (user && user.length >= 4 && !GENERIC_NAMES.has(user.toLowerCase())) out.push(['使用者名稱', user]);
  const host = os.hostname().replace(/\.(local|lan|home)$/i, '');
  if (host.length >= 4 && !GENERIC_NAMES.has(host.toLowerCase())) out.push(['電腦名稱', host]);
  if (env.CODEX_HOME && env.CODEX_HOME.length > 3) out.push(['CODEX_HOME', env.CODEX_HOME]);
  return out;
}

// 找到就回傳是哪一類（不回傳值本身）
export function findLocalInfo(text, names = localNames()) {
  const s = String(text ?? '');
  for (const [what, value] of names) {
    const re = what === '使用者名稱' ? new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(value)}($|[^A-Za-z0-9_])`, 'i') : new RegExp(escapeRe(value), 'i');
    if (re.test(s)) return what;
  }
  for (const [what, re] of SECRET_RES) if (re.test(s)) return what;
  if (EMAIL_RE.test(s)) return 'email';
  return null;
}

// 進度、失敗訊息：工作資料夾換成「.」、家目錄換成「~」，其他本機名字、email、金鑰樣式、OpenAI 帳號 id 換成「…」
export function scrubText(text, { dirs = [], names = localNames() } = {}) {
  let s = String(text ?? '');
  const reps = [];
  for (const d of dirs) {
    if (!d) continue;
    reps.push([d, '.']);
    try {
      reps.push([realpathSync(d), '.']);
    } catch {
      /* 資料夾可能已經不在 */
    }
  }
  for (const [what, value] of names) if (what === '家目錄路徑') reps.push([value, '~']);
  reps.sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of reps) s = s.split(from).join(to);
  for (const [what, value] of names) if (what !== '家目錄路徑') s = s.replace(new RegExp(escapeRe(value), 'gi'), '…');
  for (const [, re] of SECRET_RES) s = s.replace(new RegExp(re.source, 'g'), '…');
  return s.replace(new RegExp(EMAIL_RE.source, 'g'), '…@…').replace(ACCOUNT_RE, '…');
}

// ---------------- 讀回作品包 ----------------

// 只讀一般檔案（不跟著符號連結走：免得把資料夾外的檔案當成作品送出去）
export async function readPackage(dir, { names } = {}) {
  const problems = [];
  async function read(name, limit) {
    const file = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(file);
    } catch {
      problems.push(`沒有寫出 ${name}`);
      return null;
    }
    if (!st.isFile()) {
      problems.push(`${name} 要是一般檔案（不能是資料夾或捷徑）`);
      return null;
    }
    if (st.size > limit) {
      problems.push(`${name} 有 ${kb(st.size)}，超過上限 ${kb(limit)}：請精簡`);
      return null;
    }
    return fs.readFile(file, 'utf8');
  }
  const manifestText = await read('manifest.json', LIMITS.manifestBytes);
  const code = await read('main.js', LIMITS.mainBytes);
  let manifest = null;
  if (manifestText != null) {
    try {
      manifest = JSON.parse(manifestText);
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        problems.push('manifest.json 要是一個 JSON 物件');
        manifest = null;
      }
    } catch (e) {
      problems.push(`manifest.json 不是合法的 JSON：${e.message}`);
    }
  }
  if (code != null && !code.trim()) problems.push('main.js 是空的');
  if (problems.length) return { ok: false, diagnostics: problems };
  const leak = findLocalInfo(`${manifestText}\n${code}`, names);
  if (leak) return { ok: false, leak, diagnostics: [`作品裡出現疑似本機資訊（${leak}）`] };
  return { ok: true, manifest, code };
}

// ---------------- 執行 Codex ----------------

const RUNS_CHECK = /\bnode\s+(?:\.\/)?check\.mjs\b/;

// Codex 的指令常包成 `/bin/zsh -lc '…'`：只留裡面那段
function unwrapShell(cmd) {
  const s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')).trim();
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(s);
  return m ? m[2] : s;
}

// codex exec --json 的事件 → 一句給人看的進度（null＝不報）。錯誤只報分類，不轉送原文
export function summarizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const item = ev.item || {};
  if (ev.type === 'item.started' && item.type === 'command_execution') {
    const cmd = unwrapShell(item.command);
    return RUNS_CHECK.test(cmd) ? '🔍 Codex 正在跑 check.mjs…' : `⚙️ ${oneLine(cmd, 70)}`;
  }
  if (ev.type === 'item.completed' && item.type === 'command_execution' && RUNS_CHECK.test(unwrapShell(item.command))) {
    const out = String(item.aggregated_output ?? item.output ?? '');
    if (/^check 通過/m.test(out)) return '✅ check 通過';
    if (/^check 沒過/m.test(out)) return `🔧 check 沒過，修正中：${oneLine((out.match(/^✗ (.*)$/m) || [])[1], 70)}`;
    return null;
  }
  if (ev.type === 'item.completed' && item.type === 'file_change') {
    const files = [...new Set((item.changes || []).map((c) => path.basename(String(c?.path || ''))).filter(Boolean))];
    return files.length ? `📝 寫入 ${files.join('、')}` : null;
  }
  if (ev.type === 'item.completed' && item.type === 'agent_message') return `💬 ${oneLine(item.text, 120)}`;
  if (ev.type === 'turn.failed' || ev.type === 'error') {
    const msg = ev.type === 'error' ? ev.message : ev.error?.message;
    const kind = classifyCodexFailure(msg);
    if (kind === 'quota') return '⚠️ Codex 回報：額度用完了';
    if (kind === 'auth') return '⚠️ Codex 回報：沒有登入或登入過期';
    if (kind === 'busy') return '⚠️ OpenAI 那邊暫時很忙或連線不穩';
    return `⚠️ ${oneLine(msg, 120)}`;
  }
  return null;
}

// codex --version → provenance.tool（例如 "codex-cli 0.159.2"）；找不到就 null
export function toolName(versionOutput) {
  const first = String(versionOutput ?? '').trim().split('\n')[0].trim();
  if (!first) return null;
  const m = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(first);
  return clip(m ? `codex-cli ${m[1]}` : first.startsWith('codex-cli') ? first : `codex-cli ${first}`, 60);
}

export function codexTool(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) return null;
    return toolName(r.stdout);
  } catch {
    return null;
  }
}

// 跑一次 codex exec：stdout 的 JSONL 原樣存成 events.jsonl，每個事件交給 onEvent；逾時或 signal 中止就停掉它
export function runCodex({ bin, args, dir, timeoutMs = CODEX_TIMEOUT_MS, signal, onEvent }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const result = { code: null, signal: null, spawnError: null, timedOut: false, aborted: false, turnFailed: false, failure: '', errors: [], stderrTail: '', failureText: '' };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      // 判斷失敗原因：先看 turn.failed，再看 error 事件，最後才看 stderr 結尾
      result.failureText = result.failure || result.errors.at(-1) || result.stderrTail.slice(-2000);
      resolve(result);
    };
    let proc;
    try {
      proc = spawn(bin, args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      result.spawnError = e; // 參數本身不對（例如路徑是空的）
      done();
      return;
    }
    const events = createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' });
    events.on('error', () => {});
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      events.write(`${line}\n`);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // 不是 JSON 的行忽略
      }
      if (ev?.type === 'turn.failed') {
        result.turnFailed = true;
        result.failure = String(ev.error?.message ?? 'turn failed');
      } else if (ev?.type === 'error') result.errors.push(String(ev.message ?? ''));
      try {
        onEvent?.(ev);
      } catch {
        /* 回報進度出錯不影響 Codex */
      }
    };
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    proc.stderr.on('data', (chunk) => {
      result.stderrTail = (result.stderrTail + chunk.toString()).slice(-8000);
    });
    const kill = () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      }, 5000).unref();
    };
    timer = setTimeout(() => {
      result.timedOut = true;
      kill();
    }, timeoutMs);
    onAbort = () => {
      result.aborted = true;
      kill();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', (e) => {
      result.spawnError = e;
      events.end();
      done();
    });
    proc.on('close', async (code, sig) => {
      if (buf) handle(buf);
      result.code = code;
      result.signal = sig;
      events.end();
      await fs.writeFile(path.join(dir, 'stderr.txt'), result.stderrTail).catch(() => {});
      done();
    });
  });
}

// 一輪 Codex：OpenAI 太忙就等一下自動重跑（不算一輪）
async function codexRound({ dir, prompt, ctx, halt, progress }) {
  const args = buildCodexArgs(dir, prompt);
  for (let waits = 0; ; waits += 1) {
    await fs.rm(path.join(dir, 'last-message.txt'), { force: true });
    const res = await runCodex({ bin: ctx.codexBin, args, dir, timeoutMs: ctx.codexTimeoutMs, signal: halt, onEvent: (ev) => progress(summarizeEvent(ev)) });
    // 在終端機按 Ctrl+C 時 Codex 也會直接收到 SIGINT，可能比我們先結束
    if (res.aborted || halt?.aborted || res.signal === 'SIGINT') return { kind: 'stopped' };
    if (res.spawnError) return res.spawnError.code === 'ENOENT' ? { kind: 'missing', bin: ctx.codexBin } : { kind: 'general', detail: `無法啟動 Codex：${res.spawnError.message}` };
    if (res.timedOut) return { kind: 'timeout' };
    const last = await fs.readFile(path.join(dir, 'last-message.txt'), 'utf8').catch(() => '');
    if (last.trim()) ctx.log(`  Codex：${oneLine(last, 200)}`);
    if (res.code === 0 && !res.turnFailed) return { kind: 'ok' };
    const kind = classifyCodexFailure(res.failureText) || 'general';
    if (kind === 'busy' && waits < ctx.busyWaitsMs.length) {
      const wait = ctx.busyWaitsMs[waits];
      progress(`⏳ OpenAI 那邊暫時太忙，${Math.round(wait / 1000)} 秒後自動再試（不用重送）`);
      if (!(await sleep(wait, halt))) return { kind: 'stopped' };
      continue;
    }
    const lines = String(res.failureText || '').trim().split('\n').filter((l) => l.trim());
    return { kind, code: res.code, detail: lines.at(-1) || '' };
  }
}

// ---------------- 一個工作 ----------------

// 回傳 { ok, outcome: 'built'|'failed'|'conflict'|'gone'|'stopped'|'auth'|'invalid', dir, … }
export async function processJob(job, ctx) {
  const { api, log } = ctx;
  const started = Date.now();
  const id = String(job?.id ?? '');
  if (!/^[\w-]{1,80}$/.test(id)) {
    log('⚠ 伺服器給的工作沒有合法的 id，略過');
    return { ok: false, outcome: 'invalid' };
  }
  const target = cleanTarget(job.target);
  const serverAttempt = Number.isInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1;
  log(`📥 收到工作 ${id}：「${oneLine(job.intent, 80)}」（${target ? `修改「${target.name}」v${target.baseVersion ?? '?'}` : '新作品'}${serverAttempt > 1 ? `，伺服器那邊第 ${serverAttempt} 版` : ''}）`);

  const halt = new AbortController(); // 停掉這個工作：Ctrl+C、工作被取消、配對失效
  const onStop = () => halt.abort();
  if (ctx.signal?.aborted) onStop();
  else ctx.signal?.addEventListener('abort', onStop, { once: true });
  let gone = null; // 伺服器說這個工作不歸我們了（取消、已經結束、不是你的）
  let authLost = false;
  let dir = null;
  const jobPath = (what) => `/api/connector/jobs/${encodeURIComponent(id)}/${what}`;
  const noteStatus = (r) => {
    if (r.status === 401) authLost = true;
    else if ([403, 404, 409, 410].includes(r.status)) gone = r.data?.error || `伺服器回 ${r.status}`;
    if (authLost || gone) halt.abort();
  };

  // 進度：照順序送、只送摘要；送不到不影響生成
  let chain = Promise.resolve();
  let last = '';
  const progress = (msg) => {
    const text = clip(scrubText(msg, { dirs: [dir] }), 200);
    if (!msg || !text || text === last) return;
    last = text;
    log(`  ${text}`);
    chain = chain.then(async () => {
      if (gone || authLost) return;
      try {
        noteStatus(await api.request('POST', jobPath('progress'), { message: text }, { timeoutMs: 15_000 }));
      } catch {
        /* 進度只是參考 */
      }
    });
  };

  const finish = async (outcome, extra = {}) => {
    await chain;
    ctx.signal?.removeEventListener('abort', onStop);
    if (outcome === 'gone') log(`⚠ 伺服器說這個工作已經不用做了（${gone}），停止`);
    if (dir && outcome !== 'built') log(`  工作資料夾留著方便查看：${dir}`);
    return { ok: outcome === 'built', outcome, dir, ...extra };
  };
  const failJob = async (kind, message) => {
    await chain;
    if (authLost) return finish('auth');
    if (gone) return finish('gone');
    const text = clip(scrubText(message, { dirs: [dir] }), 300);
    log(`✗ ${text}`);
    try {
      const r = await api.request('POST', jobPath('fail'), { message: text, quota: kind === 'quota' }, { timeoutMs: 15_000, retries: 2 });
      if (r.status === 401) authLost = true;
    } catch (e) {
      log(`  （失敗原因沒送到伺服器：${e.message}）`);
    }
    return finish(authLost ? 'auth' : kind === 'stopped' ? 'stopped' : 'failed', { kind, message: text });
  };
  const stopped = () => (authLost ? finish('auth') : gone ? finish('gone') : failJob('stopped', failureMessage('stopped')));

  try {
    if (!ctx.fixtureDir && !ctx.tool) ctx.tool = codexTool(ctx.codexBin); // 啟動時沒找到 Codex，後來才裝好
    dir = await prepareWorkdir(job, ctx);
    log(`  工作資料夾：${dir}`);
    let diagnostics = cleanDiagnostics(job.diagnostics);
    let sent = 0;
    for (let round = 1; round <= ctx.maxAttempts; round += 1) {
      if (halt.signal.aborted) return stopped();
      await fs.writeFile(path.join(dir, 'job.json'), `${JSON.stringify(buildJobJson(job, { round, diagnostics }), null, 2)}\n`);
      if (ctx.fixtureDir) {
        const src = fixtureDirFor(ctx.fixtureDir, round);
        await fs.copyFile(path.join(src, 'manifest.json'), path.join(dir, 'manifest.json'));
        await fs.copyFile(path.join(src, 'main.js'), path.join(dir, 'main.js'));
        progress(`🧪 協定測試：第 ${round} 輪送 fixture「${[path.basename(ctx.fixtureDir), path.relative(ctx.fixtureDir, src)].filter(Boolean).join('/')}」`);
      } else {
        progress(round === 1 && !diagnostics ? '🧠 Codex 開始設計…' : `🔁 第 ${round} 輪：Codex 照診斷修正…`);
        const res = await codexRound({ dir, prompt: taskPrompt(job, { round, diagnostics }), ctx, halt: halt.signal, progress });
        if (res.kind === 'stopped' || halt.signal.aborted) return stopped();
        if (res.kind !== 'ok') return failJob(res.kind, failureMessage(res.kind, res));
      }

      const pkg = await readPackage(dir);
      if (!pkg.ok) {
        if (pkg.leak) return failJob('leak', failureMessage('leak', { what: pkg.leak }));
        diagnostics = pkg.diagnostics; // 作品包不完整：不送，直接進下一輪
        progress(`🔧 作品包不完整：${diagnostics[0]}`);
        continue;
      }
      // 修改既有作品卻原封不動（Codex 沒改到）：不送一個一模一樣的新版本
      if (!ctx.fixtureDir && target && pkg.code === target.code && JSON.stringify(pkg.manifest) === JSON.stringify(target.manifest)) {
        diagnostics = ['main.js 和 manifest.json 跟舊版一模一樣：請照玩家的要求修改'];
        progress(`🔧 ${diagnostics[0]}`);
        continue;
      }
      if (halt.signal.aborted) return stopped();
      const attempt = serverAttempt + sent;
      const provenance = ctx.fixtureDir ? { tool: 'fixture', via: 'fixture', attempt, ms: Date.now() - started } : { tool: ctx.tool || 'codex-cli', via: 'exec', attempt, ms: Date.now() - started };
      progress(`📦 送出作品包「${oneLine(pkg.manifest.name, 40)}」，等伺服器試跑…`);
      await chain;
      let r;
      try {
        // 不帶 halt：已經在送了就等伺服器回覆（伺服器會試跑幾秒）
        r = await api.request('POST', jobPath('package'), { manifest: pkg.manifest, files: { 'main.js': pkg.code }, provenance }, { timeoutMs: 120_000, retries: 3 });
      } catch (e) {
        return failJob('general', `作品包送不到伺服器（${e.message}）`);
      }
      sent += 1;
      noteStatus(r);
      if (authLost) return finish('auth');
      if (gone) return finish('gone');
      if (r.status !== 200 || !r.data) return failJob('general', `伺服器收作品包時出錯（${r.status}${r.data?.error ? `：${r.data.error}` : ''}）`);
      if (r.data.ok) {
        log(`✅ 完成：「${pkg.manifest.name}」→ ${r.data.lineage} v${r.data.version}（${Math.round((Date.now() - started) / 1000)} 秒）`);
        return finish('built', { lineage: r.data.lineage, version: r.data.version });
      }
      diagnostics = cleanDiagnostics(r.data.diagnostics) || ['伺服器沒有通過這一版（沒有附診斷）'];
      if (r.data.conflict) {
        log(`⚠ ${diagnostics[0]}`);
        return finish('conflict', { diagnostics });
      }
      if (r.data.status === 'failed') {
        log(`✗ 伺服器那邊已經試太多版，這個工作結束：${diagnostics[0]}`);
        return finish('failed', { diagnostics });
      }
      progress(`🔧 第 ${attempt} 版沒通過伺服器試跑：${diagnostics[0]}`);
    }
    return failJob('general', `試了 ${ctx.maxAttempts} 輪還是沒通過：${diagnostics?.[0] || '（沒有診斷）'}`);
  } catch (e) {
    if (halt.signal.aborted) return stopped();
    return failJob('general', `connector 出錯：${e.message}`);
  }
}

// ---------------- 一直接工作 ----------------

export async function runConnector(opts) {
  const {
    server,
    token,
    codexBin = 'codex',
    fixtureDir = null,
    once = false,
    maxAttempts = 3,
    signal = new AbortController().signal,
    log = defaultLog,
    pollWaitS = POLL_WAIT_S,
    backoffMaxMs = BACKOFF_MAX_MS,
    codexTimeoutMs = CODEX_TIMEOUT_MS,
    busyWaitsMs = BUSY_WAITS_MS,
    templateDir = TEMPLATE_DIR,
    workRoot = os.tmpdir(),
  } = opts;
  // 有路徑的 --codex 先變成絕對路徑（Codex 是在工作資料夾裡啟動的）；只有名字的照 PATH 找
  const bin = /[\\/]/.test(codexBin) ? path.resolve(codexBin) : codexBin;
  const api = createApi(server, token);
  const ctx = { api, log, codexBin: bin, fixtureDir, maxAttempts, signal, codexTimeoutMs, busyWaitsMs, templateDir, workRoot, tool: null };
  if (fixtureDir) log(`協定測試模式：不叫 Codex，直接送 ${fixtureDir} 的 manifest.json＋main.js`);
  else {
    ctx.tool = codexTool(bin);
    if (ctx.tool) log(`使用 ${ctx.tool}——這台電腦上你自己的 Codex 登入與額度`);
    else log(`⚠ 找不到 Codex（${bin}）：請安裝 Codex CLI 並執行 codex login，或用 --codex 指定路徑。收到的工作會回報「找不到 Codex」`);
  }
  log(`已連上 ${server}，等待工作中…（Ctrl+C 結束）`);
  let backoff = 0;
  const retryLater = async (why) => {
    backoff = backoff ? Math.min(backoffMaxMs, backoff * 2) : 1000;
    log(`${why}，${backoff / 1000} 秒後再試`);
    await sleep(backoff, signal);
  };
  while (!signal.aborted) {
    const t0 = Date.now();
    let r;
    try {
      r = await api.request('GET', `/api/connector/jobs?wait=${pollWaitS}`, undefined, { timeoutMs: (pollWaitS + 15) * 1000, signal });
    } catch (e) {
      if (signal.aborted) break;
      await retryLater(`連不到伺服器（${e.message}）`);
      continue;
    }
    if (r.status === 401) {
      log('配對失效，請重新 pair');
      log(`（在遊戲裡重新產生配對碼，再執行：node ${SCRIPT} pair ${server} <配對碼>）`);
      return 1;
    }
    if (r.status === 204 || (r.status === 200 && !r.data?.job)) {
      if (backoff) log('伺服器連上了，等待工作中…');
      backoff = 0;
      if (Date.now() - t0 < 1000) await sleep(1000, signal); // 伺服器沒有等就回：不要一直問
      continue;
    }
    if (r.status !== 200) {
      await retryLater(`伺服器回 ${r.status}${r.data?.error ? `（${r.data.error}）` : ''}`);
      continue;
    }
    backoff = 0;
    const result = await processJob(r.data.job, ctx);
    if (result.outcome === 'auth') {
      log('配對失效，請重新 pair');
      return 1;
    }
    if (once) return result.ok ? 0 : 1;
    if (!signal.aborted) log('等待下一個工作…');
  }
  log('connector 已停止');
  return 0;
}

// ---------------- 指令列 ----------------

function parseMaxAttempts(v) {
  if (v === undefined) return 3;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new UsageError('--max-attempts 要是 1–10 的整數');
  return n;
}

export async function main(argv = process.argv.slice(2), { log = defaultLog, print = console.log, stateDir = STATE_DIR } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log(`✗ ${e.message}`);
    print(USAGE);
    return 2;
  }
  const cmd = args._[0];
  if (args.help || !cmd) {
    print(USAGE);
    return args.help ? 0 : 2;
  }
  try {
    if (cmd === 'pair') {
      const [, server, code] = args._;
      if (!server || !code) throw new UsageError('pair 要給伺服器網址和配對碼：pair <伺服器網址> <配對碼>');
      return await pair({ server, code, label: args.label, stateFile: args.state, stateDir, log });
    }
    if (cmd === 'run') {
      const maxAttempts = parseMaxAttempts(args.maxAttempts);
      let fixtureDir = null;
      if (args.fixture) {
        fixtureDir = path.resolve(args.fixture);
        if (!existsSync(path.join(fixtureDir, 'manifest.json')) || !existsSync(path.join(fixtureDir, 'main.js'))) throw new UsageError(`--fixture ${args.fixture} 裡要有 manifest.json 和 main.js`);
      }
      const { server, file, state } = await resolveRunTarget({ server: args._[1], stateFile: args.state, stateDir });
      log(`創作者 ${state.name ? `${state.name}（${state.creatorId}）` : state.creatorId}，配對資料：${file}`);
      const ac = new AbortController();
      let stops = 0;
      const onSignal = () => {
        stops += 1;
        if (stops > 1) process.exit(130);
        log('收到停止訊號：收尾中…（再按一次 Ctrl+C 立刻結束）');
        ac.abort();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      try {
        return await runConnector({ server, token: state.token, codexBin: args.codex || 'codex', fixtureDir, once: !!args.once, maxAttempts, signal: ac.signal, log });
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    }
    throw new UsageError(`不認得的指令 ${cmd}（只有 pair、run）`);
  } catch (e) {
    if (e instanceof UsageError) {
      log(`✗ ${e.message}`);
      return 2;
    }
    log(`✗ ${e?.stack || e}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1] || '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const code = await main();
  // 等輸出寫完再結束（stdout 是管線時寫入是非同步的）
  process.stdout.write('', () => process.exit(code));
}
