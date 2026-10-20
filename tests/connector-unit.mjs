// 創作世界 connector 的測試（不用真的遊戲伺服器、不叫真的 Codex、不花額度、不連外）：
// - template/check.mjs：兩個範例、fixtures（good 過、bad-then-fixed 第一版不過／attempt2 過、v2-migrate 從 good 的存檔遷移），和一批故意壞掉的作品
// - 純函式：組 codex exec 指令與任務說明、job.json、fixture 選檔（第 1／2 輪）、額度用完／沒登入／太忙的分類與訊息、本機資訊過濾、事件摘要
// - 整個流程：假的 codex 執行檔（node 腳本，寫出 main.js／manifest.json）＋ 127.0.0.1 上的假伺服器（jobs／progress／package／fail，
//   作品包用 check.mjs 當「影子試跑」）——配對、長輪詢、進度、送作品包、照診斷重修、修改既有作品、各種失敗回報、配對失效、
//   連不上時退避重試、工作被取消、Ctrl+C 乾淨結束；也確認送出去的東西裡沒有主機名稱、帳號、家目錄、CODEX_HOME
//   node tests/connector-unit.mjs
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as C from '../connector/vibe-connector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR = path.join(ROOT, 'connector', 'vibe-connector.mjs');
const CHECK = path.join(ROOT, 'connector', 'template', 'check.mjs');
const EX = path.join(ROOT, 'connector', 'template', 'examples');
const FX = path.join(ROOT, 'connector', 'fixtures');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'vibe-connector-test-'));
const TOKEN = 'tok_test_0123456789abcdefghij';
const NODE = process.execPath;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => {
  console.log('❌ 測試超過 3 分鐘還沒跑完，強制結束');
  process.exit(1);
}, 180_000);
watchdog.unref();

// ---------------- 小工具 ----------------

function runCheck(dir, ...extra) {
  const r = spawnSync(NODE, [CHECK, dir, ...extra], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}
function runCheckAsync(dir, ...extra) {
  return new Promise((resolve) => {
    execFile(NODE, [CHECK, dir, ...extra], { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => resolve({ status: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}
let pkgN = 0;
function writePkg({ code, manifest }) {
  const dir = path.join(TMP, `pkg${(pkgN += 1)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.js'), code);
  writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest ?? { format: 'vibe-pkg/1', name: '測試', description: '測試用', stateSchema: 1, budgets: { entities: 20 } }));
  return dir;
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const pkgFrom = (dir) => ({ manifest: readJson(path.join(dir, 'manifest.json')), code: readFileSync(path.join(dir, 'main.js'), 'utf8') });

// 本機資訊（送出去的任何東西裡都不該出現）
const HOME = os.homedir();
const USER = (() => {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
})();
const HOST = os.hostname().replace(/\.(local|lan|home)$/i, '');
const FAKE_CODEX_HOME = path.join(TMP, 'my-codex-home');

// ---------------- 假的 codex ----------------

// 照計畫檔（FAKE_CODEX_PLAN）的第 n 步行動：write（照某個資料夾寫出作品包）、quota、auth、busy、crash、nothing、slow
const FAKE_CODEX = path.join(TMP, 'fake-codex.mjs');
writeFileSync(
  FAKE_CODEX,
  `#!${NODE}
// 測試用的假 Codex（不花額度、不連外）
import { appendFileSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('codex-cli 9.9.9-test'); process.exit(0); }
const dir = argv[argv.indexOf('-C') + 1];
const lastFile = argv[argv.indexOf('-o') + 1];
const planFile = process.env.FAKE_CODEX_PLAN;
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const counter = planFile + '.n';
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
writeFileSync(counter, String(n + 1));
const step = plan[Math.min(n, plan.length - 1)];
const job = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ n, pid: process.pid, argv, cwd: process.cwd(), job, hadMain: existsSync(path.join(dir, 'main.js')), files: ['AGENTS.md', 'check.mjs', 'examples/color-match/main.js', 'examples/dodge-blocks/main.js'].filter((f) => existsSync(path.join(dir, f))), mark: process.env.FAKE_MARK ?? null, codexHome: process.env.CODEX_HOME ?? null }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 'fake' });
out({ type: 'turn.started' });
if (step.kind === 'write') {
  out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "/bin/zsh -lc 'cat " + dir + "/AGENTS.md'" } });
  cpSync(path.join(step.from, 'manifest.json'), path.join(dir, 'manifest.json'));
  cpSync(path.join(step.from, 'main.js'), path.join(dir, 'main.js'));
  if (step.append) appendFileSync(path.join(dir, 'main.js'), step.append);
  out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: path.join(dir, 'main.js'), kind: 'add' }, { path: path.join(dir, 'manifest.json'), kind: 'add' }] } });
  out({ type: 'item.started', item: { id: 'c2', type: 'command_execution', command: "/bin/zsh -lc 'node check.mjs'" } });
  out({ type: 'item.completed', item: { id: 'c2', type: 'command_execution', command: "/bin/zsh -lc 'node check.mjs'", aggregated_output: 'check：x\\ncheck 通過\\n', exit_code: 0 } });
  const say = step.say || '（假 Codex）照範例做好了';
  out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: say } });
  writeFileSync(lastFile, say);
  out({ type: 'turn.completed', usage: {} });
  process.exit(0);
}
if (step.kind === 'quota') {
  const m = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.";
  out({ type: 'error', message: m });
  out({ type: 'turn.failed', error: { message: m } });
  process.exit(1);
}
if (step.kind === 'auth') { process.stderr.write('Error: Not logged in. Please run \`codex login\` first.\\n'); process.exit(1); }
if (step.kind === 'busy') {
  out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' });
  out({ type: 'turn.failed', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } });
  process.exit(1);
}
if (step.kind === 'crash') { process.stderr.write('thread main panicked at core/src/exec.rs:12: something broke\\n'); process.exit(101); }
if (step.kind === 'nothing') { out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '我什麼都沒寫' } }); out({ type: 'turn.completed' }); process.exit(0); }
if (step.kind === 'slow') { out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'sleep 60' } }); setTimeout(() => process.exit(0), 60000); }
`,
  { mode: 0o755 },
);

let planN = 0;
// 設定這一次假 Codex 的行動；回傳 log 檔（每次被叫就記一行）
function plan(steps) {
  planN += 1;
  const planFile = path.join(TMP, `plan${planN}.json`);
  const logFile = path.join(TMP, `codex-log${planN}.jsonl`);
  writeFileSync(planFile, JSON.stringify(steps));
  writeFileSync(logFile, '');
  process.env.FAKE_CODEX_PLAN = planFile;
  process.env.FAKE_CODEX_LOG = logFile;
  return {
    calls: () =>
      readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

// ---------------- 假伺服器 ----------------

// 作品包的「影子試跑」：用 check.mjs 跑（修改既有作品時拿 job 的 target 當舊版）
async function shadowReply(body, job) {
  const dir = writePkg({ code: body.files?.['main.js'] ?? '', manifest: body.manifest });
  const extra = [];
  if (job?.target) {
    const base = path.join(TMP, `base${(pkgN += 1)}`);
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, 'main.js'), job.target.code);
    writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(job.target.manifest));
    extra.push('--base', base);
  }
  const r = await runCheckAsync(dir, ...extra);
  if (r.status === 0) return { ok: true, lineage: 'lin_test', version: (shadowReply.v = (shadowReply.v || 0) + 1) };
  return { ok: false, diagnostics: r.out.split('\n').filter((l) => l.startsWith('✗ ')).map((l) => l.slice(2)), status: 'needs-fix' };
}

function fakeServer({ jobs = [], reply = shadowReply, holdMs = 150, cancelAfterProgress = 0, port = 0 } = {}) {
  const s = { requests: [], progress: [], packages: [], fails: [], polls: [], queue: [...jobs], status: new Map(), jobsById: new Map() };
  const send = (res, code, obj) => {
    if (obj === undefined) {
      res.writeHead(code);
      return res.end();
    }
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      s.requests.push({ method: req.method, path: url.pathname, search: url.search, headers: { ...req.headers }, body });
      const json = () => {
        try {
          return JSON.parse(body || 'null');
        } catch {
          return null;
        }
      };
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: '需要 application/json' });
      if (url.pathname === '/api/connector/pair' && req.method === 'POST') {
        const b = json();
        if (b?.code !== 'ABC123') return send(res, 403, { error: '配對碼不對或已過期（10 分鐘），請在遊戲裡重新產生' });
        return send(res, 200, { token: TOKEN, creatorId: 'cr_test', name: '測試創作者' });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: '沒有配對或配對已失效' });
      if (url.pathname === '/api/connector/jobs' && req.method === 'GET') {
        s.polls.push(url.searchParams.get('wait'));
        const job = s.queue.shift();
        if (job) {
          s.status.set(job.id, 'working');
          s.jobsById.set(job.id, job);
          return send(res, 200, { job });
        }
        await sleep(holdMs);
        return send(res, 204);
      }
      const m = url.pathname.match(/^\/api\/connector\/jobs\/([\w-]+)\/(progress|package|fail)$/);
      if (m && req.method === 'POST') {
        const st = s.status.get(m[1]);
        if (!st) return send(res, 403, { error: '不是你的工作' });
        if (!['working', 'needs-fix'].includes(st)) return send(res, 409, { error: `工作已經是 ${st}` });
        const b = json();
        if (m[2] === 'progress') {
          s.progress.push(b?.message);
          if (cancelAfterProgress && s.progress.length >= cancelAfterProgress) s.status.set(m[1], 'cancelled');
          return send(res, 200, { ok: true });
        }
        if (m[2] === 'fail') {
          s.fails.push(b);
          s.status.set(m[1], 'failed');
          return send(res, 200, { ok: true });
        }
        s.packages.push(b);
        const r = await reply(b, s.jobsById.get(m[1]), s);
        s.status.set(m[1], r.ok ? 'built' : r.status || 'needs-fix');
        return send(res, 200, { ok: !!r.ok, lineage: r.lineage, version: r.version, diagnostics: r.diagnostics || null, conflict: !!r.conflict, status: r.ok ? 'built' : r.status || 'needs-fix' });
      }
      return send(res, 404, { error: 'unknown' });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      s.url = `http://127.0.0.1:${server.address().port}`;
      s.close = () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r())));
      resolve(s);
    });
  });
}

const job = (over = {}) => ({ id: `job_t${Math.random().toString(36).slice(2, 8)}`, intent: '做一個點顏色相符的球得分的遊戲', source: 'voice', worldId: 'root', selected: [], target: null, attempt: 1, diagnostics: null, ...over });

// 在這個程序裡跑 connector（收集輸出）
async function runIn(srv, opts = {}) {
  const lines = [];
  const code = await C.runConnector({ server: srv.url, token: TOKEN, codexBin: FAKE_CODEX, once: true, pollWaitS: 1, workRoot: TMP, busyWaitsMs: [50, 50], log: (m) => lines.push(String(m)), ...opts });
  return { code, out: lines.join('\n') };
}

// 啟動 connector 指令列（子程序）
function startCli(args, { env = {} } = {}) {
  const child = spawn(NODE, [CONNECTOR, ...args], { env: { ...process.env, TMPDIR: TMP, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.on('close', (code, sig) => resolve({ code, sig })));
  return {
    child,
    out: () => out,
    exited,
    async waitFor(re, ms = 15_000) {
      const t0 = Date.now();
      while (!re.test(out)) {
        if (Date.now() - t0 > ms) return false;
        await sleep(50);
      }
      return true;
    },
  };
}

// 這台假伺服器的配對資料（跟真的 pair 寫出來的一樣）
let stateN = 0;
function stateFor(srv) {
  const file = path.join(TMP, 'state', `srv${(stateN += 1)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ server: srv.url, creatorId: 'cr_test', name: '測試創作者', label: '我的 Codex', token: TOKEN }), { mode: 0o600 });
  return file;
}

// 送給伺服器的所有內容（除了 Authorization 標頭）裡有沒有本機資訊
function leaks(srv) {
  const blob = srv.requests.map((r) => `${r.method} ${r.path}${r.search}\n${JSON.stringify({ ...r.headers, authorization: undefined })}\n${r.body}`).join('\n');
  const found = [];
  if (HOME.length > 3 && blob.includes(HOME)) found.push('家目錄');
  if (USER.length >= 4 && new RegExp(`\\b${USER}\\b`, 'i').test(blob)) found.push('帳號');
  if (HOST.length >= 4 && blob.toLowerCase().includes(HOST.toLowerCase())) found.push('主機名稱');
  if (blob.includes(FAKE_CODEX_HOME)) found.push('CODEX_HOME');
  if (blob.includes(TMP)) found.push('暫存路徑');
  return found;
}

// ================= 1. check.mjs =================
console.log('— check.mjs（本機自查）');
for (const name of ['color-match', 'dodge-blocks']) {
  const r = runCheck(path.join(EX, name));
  check(`範例 ${name} 通過 check`, r.status === 0 && /^check 通過$/m.test(r.out), r.status === 0 ? '' : r.out.slice(-300));
}
{
  const g = runCheck(path.join(FX, 'good'));
  check('fixtures/good 通過', g.status === 0 && /check 通過/.test(g.out));
  const b = runCheck(path.join(FX, 'bad-then-fixed'));
  check('fixtures/bad-then-fixed 第一版不過：tick 第 1 步丟例外，訊息有步數、行號', b.status === 1 && /tick\(\) 第 1 步出錯：TypeError/.test(b.out) && /main\.js 第 \d+ 行/.test(b.out), b.out.split('\n').find((l) => l.startsWith('✗')));
  const f = runCheck(path.join(FX, 'bad-then-fixed', 'attempt2'));
  check('fixtures/bad-then-fixed/attempt2（修好的）通過', f.status === 0);
  const v = runCheck(path.join(FX, 'v2-migrate'));
  check('fixtures/v2-migrate 單獨通過', v.status === 0);
  const m = runCheck(path.join(FX, 'v2-migrate'), '--base', path.join(FX, 'good'));
  check('v2-migrate 能從 good 的存檔遷移（舊版跑 90 步存檔 → migrate 1 → 2 → 新版接著跑）', m.status === 0 && /migrate 1 → 2/.test(m.out), m.out.split('\n').find((l) => l.includes('換版')));
  const back = runCheck(path.join(FX, 'good'), '--base', path.join(FX, 'v2-migrate'));
  check('stateSchema 變小（2 → 1）不過', back.status === 1 && /只能不變或變大/.test(back.out));
  // job.json 的 target 自動當舊版
  const d = path.join(TMP, 'with-job');
  cpSync(path.join(FX, 'v2-migrate'), d, { recursive: true });
  writeFileSync(path.join(d, 'job.json'), JSON.stringify({ target: { ...pkgFrom(path.join(FX, 'good')), lineage: 'lin_x', baseVersion: 1, name: '接星星' } }));
  const j = runCheck(d);
  check('工作資料夾裡有 job.json 的 target：自動做換版測試', j.status === 0 && /job|換版/.test(j.out) && /migrate 1 → 2/.test(j.out));
}
{
  const base = (body = {}) => `vibe.define({
  init() { return { x: 0, n: 0 }; },
  tick(s, dt, input) { if (input.keys.left) s.x -= dt; ${body.tick || ''} },
  view(s) { return ${body.view || "[{ id: 'a', shape: 'box', pos: [s.x, 0.5, 0] }]"}; },
});`;
  const bad = [
    ['行首 import', { code: `import x from './y.js';\n${base()}` }, /用 import 開頭/],
    ['Math.random', { code: base({ tick: 's.n = Math.random();' }) }, /Math\.random：隨機請用 vibe\.random/],
    ['最上層的 let（實例共用、不會存檔）', { code: `let hits = 0;\n${base({ tick: 'hits++;' })}` }, /最上層的 let hits/],
    ['實體超過 budgets.entities', { code: base({ view: "Array.from({ length: 30 }, (_, i) => ({ id: 'e' + i, shape: 'box', pos: [0, 0, 0] }))" }) }, /回傳 30 個實體，超過上限 20/],
    ['顏色不是 #rrggbb', { code: base({ view: "[{ id: 'a', shape: 'box', pos: [0, 0, 0], color: 'red' }]" }) }, /color 要是 "#rrggbb"/],
    ['sphere 的 size 長度不對', { code: base({ view: "[{ id: 'a', shape: 'sphere', pos: [0, 1, 0], size: [0.2, 0.2, 0.2] }]" }) }, /sphere 的 size 是 \[半徑\]/],
    ['state 裡放函式', { code: base({ tick: 's.cb = () => 1;' }) }, /state\.cb 是函式/],
    ['輸入沒有作用（只會轉的裝飾）', { code: "vibe.define({ init() { return { a: 0 }; }, tick(s, dt) { s.a += dt; }, view(s) { return [{ id: 'r', shape: 'torus', pos: [0, 1, 0], rot: [0, s.a, 0] }]; } });" }, /輸入沒有作用/],
    ['stateSchema 變了卻沒有 migrate', { code: base(), manifest: { format: 'vibe-pkg/1', name: '測試', description: 'x', stateSchema: 2, budgets: { entities: 20 } }, base: true }, /要寫 migrate/],
    ['存檔重開後才會壞（資料放在 state 以外）', { code: "const cache = {};\nvibe.define({ init() { cache.grid = [1, 2, 3]; return { x: 0 }; }, tick(s, dt, input) { if (input.keys.left) s.x += cache.grid.length; }, view(s) { return [{ id: 'a', shape: 'box', pos: [0, 1, 0] }]; } });" }, /存檔重開後.*出錯/],
    ['onEvent 收到按鍵事件沒檢查型別', { code: base().replace('view(s)', "onEvent(s, ev) { if (ev.target.startsWith('a')) s.n++; },\n  view(s)") }, /onEvent\(\{"type":"key"/],
  ];
  for (const [name, pkg, re] of bad) {
    const dir = writePkg(pkg);
    const extra = pkg.base ? ['--base', writePkg({ code: base() })] : [];
    const r = runCheck(dir, ...extra);
    check(`check 擋下：${name}`, r.status === 1 && re.test(r.out), r.out.split('\n').find((l) => l.startsWith('✗')) || r.out.slice(-200));
  }
  const t0 = Date.now();
  const loop = runCheck(writePkg({ code: base({ tick: 'if (input.t > 1) { while (true) {} }' }) }));
  check('check 擋下：無限迴圈（1 秒逾時，不會卡住）', loop.status === 1 && /超過 1000 ms 還沒結束/.test(loop.out) && Date.now() - t0 < 10_000, `${Date.now() - t0} ms`);
}

// ================= 2. 純函式 =================
console.log('\n— 指令、任務說明、分類');
{
  const dir = '/tmp/vibe-job-abc';
  const args = C.buildCodexArgs(dir, '任務');
  check('codex exec 參數照規格', JSON.stringify(args) === JSON.stringify(['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'workspace-write', '-C', dir, '--json', '-o', path.join(dir, 'last-message.txt'), '任務']));

  const p1 = C.taskPrompt(job());
  check('任務說明（新作品）：讀 AGENTS.md、job.json，寫 manifest.json＋main.js，跑 node check.mjs 到通過', ['AGENTS.md', 'job.json', 'manifest.json', 'main.js', '`node check.mjs`', 'check 通過', '做一個點顏色相符的球得分的遊戲', '新作品'].every((w) => p1.includes(w)) && !p1.includes('修改'));
  check('任務說明不會以 - 開頭（不會被當成 codex 的選項）', !p1.startsWith('-'));
  const t = { lineage: 'lin_a', baseVersion: 3, name: '接星星', manifest: { format: 'vibe-pkg/1', name: '接星星', stateSchema: 1 }, code: 'vibe.define({})' };
  const p2 = C.taskPrompt(job({ target: t }));
  check('任務說明（修改）：說明舊版、保留玩法、stateSchema 加 1＋migrate', ['修改', '「接星星」v3', '保留', 'stateSchema', 'migrate'].every((w) => p2.includes(w)));
  const p3 = C.taskPrompt(job(), { round: 2, diagnostics: ['tick() 第 37 步出錯：TypeError'] });
  check('任務說明（第 2 輪）：附上診斷、要先修好', p3.includes('第 2 輪') && p3.includes('tick() 第 37 步出錯') && p3.includes('修好'));

  const jj = C.buildJobJson(job({ target: t, selected: [{ instId: 'i_1', lineage: 'lin_a', version: 3, name: '接星星', extra: 'x' }] }), { round: 2, diagnostics: ['壞了'] });
  check('job.json：intent、mode、selected、target 原文、上一輪診斷（不放 worldId、id）', jj.mode === 'modify' && jj.target.code === t.code && jj.target.manifest.name === '接星星' && jj.diagnostics[0] === '壞了' && jj.round === 2 && jj.selected[0].extra === undefined && !('worldId' in jj) && !('id' in jj));
  check('job.json（新作品）：mode create、diagnostics null', C.buildJobJson(job()).mode === 'create' && C.buildJobJson(job()).diagnostics === null);

  const bf = path.join(FX, 'bad-then-fixed');
  check('fixture 選檔：第 1 輪送資料夾本身、第 2 輪送 attempt2/、第 3 輪沿用 attempt2/', C.fixtureDirFor(bf, 1) === bf && C.fixtureDirFor(bf, 2) === path.join(bf, 'attempt2') && C.fixtureDirFor(bf, 3) === path.join(bf, 'attempt2'));
  check('fixture 選檔：沒有 attempt2/ 時每輪都送同一份', C.fixtureDirFor(path.join(FX, 'good'), 2) === path.join(FX, 'good'));

  const cases = [
    ["You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM.", 'quota'],
    ['insufficient_quota: You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Error: Not logged in. Please run `codex login`.', 'auth'],
    ['unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', 'auth'],
    ['exceeded retry limit, last status: 429 Too Many Requests', 'busy'],
    ['stream disconnected before completion: error sending request', 'busy'],
    ['thread main panicked at core/src/exec.rs:12: something broke', null],
    ['Error: The model `gpt-9` does not exist or you do not have access to it.', null],
    ['', null],
  ];
  const wrong = cases.filter(([s, k]) => C.classifyCodexFailure(s) !== k);
  check('Codex 錯誤分類：額度用完／沒登入／太忙／一般', !wrong.length, wrong.map(([s]) => s.slice(0, 30)).join('；'));
  const q = C.failureMessage('quota', { detail: cases[0][0] });
  check('額度用完的訊息：說是額度用完、附上何時能再試、不轉送方案資訊', q.includes('額度用完') && q.includes('3:05 PM') && !/Pro|Upgrade/.test(q), q);
  const g = C.failureMessage('general', { code: 101, detail: 'something broke' });
  check('一般失敗的訊息：不會說成額度用完', !g.includes('額度') && g.includes('101') && g.includes('something broke'), g);
  check('沒登入、找不到 Codex、太忙的訊息也不提額度', ['auth', 'missing', 'busy', 'timeout', 'stopped'].every((k) => !C.failureMessage(k).includes('額度')));
  check('找不到 Codex 的訊息只放執行檔名稱（不放本機路徑）', C.failureMessage('missing', { bin: `${HOME}/bin/codex` }).includes('（codex）') && !C.failureMessage('missing', { bin: `${HOME}/bin/codex` }).includes(HOME));

  check('伺服器網址：補 http://、去掉結尾斜線', C.normalizeServer('192.168.1.20:5310/') === 'http://192.168.1.20:5310' && C.normalizeServer('https://vibe.example/') === 'https://vibe.example');
  let threw = false;
  try {
    C.normalizeServer('ftp://x');
  } catch {
    threw = true;
  }
  check('伺服器網址：不是 http(s) 就拒絕', threw);
  check('配對資料檔名：~/.vibe-connector/<主機>_<埠>.json', C.stateFileFor('http://192.168.1.20:5310') === path.join(HOME, '.vibe-connector', '192.168.1.20_5310.json') && path.basename(C.stateFileFor('https://Vibe.Example')) === 'vibe.example_443.json' && path.basename(C.stateFileFor('localhost')) === 'localhost_80.json');
  const a = C.parseArgs(['run', 'http://x:1', '--codex', '/c', '--once', '--max-attempts=2', '--fixture', 'f']);
  check('指令列參數', a._[1] === 'http://x:1' && a.codex === '/c' && a.once && a.maxAttempts === '2' && a.fixture === 'f');
  check('codex --version → provenance.tool', C.toolName('codex-cli 0.159.2\n') === 'codex-cli 0.159.2' && C.toolName('0.160.0') === 'codex-cli 0.160.0');

  const names = C.localNames({ ...process.env, CODEX_HOME: FAKE_CODEX_HOME });
  check('本機資訊過濾：家目錄路徑、email、金鑰樣式會被擋', C.findLocalInfo(`// ${HOME}/x`, names) === '家目錄路徑' && C.findLocalInfo('const a = "someone@example.com";', names) === 'email' && C.findLocalInfo('const k = "sk-abcdefghijklmnopqrstuvwxyz123456";', names) === 'API 金鑰' && C.findLocalInfo(`const p = "${FAKE_CODEX_HOME}/auth.json";`, names) === 'CODEX_HOME');
  const clean = [path.join(EX, 'color-match'), path.join(EX, 'dodge-blocks'), path.join(FX, 'good'), path.join(FX, 'v2-migrate'), path.join(FX, 'bad-then-fixed'), path.join(FX, 'bad-then-fixed', 'attempt2')].filter((d) => C.findLocalInfo(readFileSync(path.join(d, 'main.js'), 'utf8') + readFileSync(path.join(d, 'manifest.json'), 'utf8'), names));
  check('本機資訊過濾：範例和 fixtures 都不會被誤擋', !clean.length, clean.join('、'));
  const wd = path.join(TMP, 'vibe-job-xyz');
  const sc = C.scrubText(`cat ${wd}/AGENTS.md; ls ${HOME}/Desktop; mail me@example.com; organization org-AbCdEf123456`, { dirs: [wd], names });
  check('進度訊息：工作資料夾→「.」、家目錄→「~」、email、OpenAI 帳號 id 遮掉', sc === 'cat ./AGENTS.md; ls ~/Desktop; mail …@…; organization …', sc);

  check("事件摘要：開始跑 check.mjs", C.summarizeEvent({ type: 'item.started', item: { type: 'command_execution', command: "/bin/zsh -lc 'node check.mjs'" } }) === '🔍 Codex 正在跑 check.mjs…');
  check('事件摘要：check 通過／沒過', C.summarizeEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'node check.mjs', aggregated_output: 'check 通過\n' } }) === '✅ check 通過' && /^🔧 check 沒過，修正中：tick\(\) 第 3 步/.test(C.summarizeEvent({ type: 'item.completed', item: { type: 'command_execution', command: 'node check.mjs', aggregated_output: '✗ tick() 第 3 步出錯\ncheck 沒過：1 個錯誤\n' } })));
  check('事件摘要：寫檔只報檔名', C.summarizeEvent({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: '/tmp/x/main.js' }, { path: '/tmp/x/manifest.json' }] } }) === '📝 寫入 main.js、manifest.json');
  const qe = C.summarizeEvent({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro)" } });
  check('事件摘要：額度錯誤只報分類，不轉送 Codex 原文', qe === '⚠️ Codex 回報：額度用完了', qe);

  // 讀回作品包
  const okDir = path.join(TMP, 'readpkg-ok');
  cpSync(path.join(FX, 'good'), okDir, { recursive: true });
  const rp = await C.readPackage(okDir, { names });
  check('讀回作品包：manifest 解析成物件、main.js 原文', rp.ok && rp.manifest.name === '接星星' && rp.code.includes('vibe.define'));
  const lnDir = path.join(TMP, 'readpkg-link');
  mkdirSync(lnDir, { recursive: true });
  cpSync(path.join(FX, 'good', 'manifest.json'), path.join(lnDir, 'manifest.json'));
  symlinkSync(path.join(FX, 'good', 'main.js'), path.join(lnDir, 'main.js'));
  const rl = await C.readPackage(lnDir, { names });
  check('讀回作品包：main.js 是符號連結就不讀（不會把資料夾外的檔案送出去）', !rl.ok && /一般檔案/.test(rl.diagnostics.join()));
  const bigDir = path.join(TMP, 'readpkg-big');
  mkdirSync(bigDir, { recursive: true });
  cpSync(path.join(FX, 'good', 'manifest.json'), path.join(bigDir, 'manifest.json'));
  writeFileSync(path.join(bigDir, 'main.js'), `vibe.define({});\n//${'x'.repeat(70 * 1024)}`);
  const rb = await C.readPackage(bigDir, { names });
  check('讀回作品包：main.js 超過 64 KB 不送、變成下一輪的診斷', !rb.ok && /超過上限 64\.0 KB/.test(rb.diagnostics.join()));
}

// ================= 3. 整個流程（假 codex＋假伺服器） =================
console.log('\n— 配對與一輪工作（指令列）');
const STATE = path.join(TMP, 'state', 'paired.json');
{
  const srv = await fakeServer();
  const bad = startCli(['pair', srv.url, 'WRONG1', '--state', STATE]);
  const be = await bad.exited;
  check('配對碼不對：結束碼 1、說明要重新產生', be.code === 1 && /配對碼不對或已過期/.test(bad.out()) && !existsSync(STATE));
  const p = startCli(['pair', srv.url, ' ABC123 ', '--state', STATE]);
  const pe = await p.exited;
  const st = existsSync(STATE) ? readJson(STATE) : {};
  check('pair：印「已連接：創作者 …」、存下 token', pe.code === 0 && /已連接：創作者 測試創作者（cr_test）/.test(p.out()) && st.token === TOKEN && st.server === srv.url);
  check('pair：配對資料權限 0600、不印 token', existsSync(STATE) && (statSync(STATE).mode & 0o777) === 0o600 && !p.out().includes(TOKEN), existsSync(STATE) ? (statSync(STATE).mode & 0o777).toString(8) : '沒有檔案');
  const pairReq = srv.requests.find((r) => r.path === '/api/connector/pair' && r.body.includes('ABC123'));
  const pb = JSON.parse(pairReq?.body || '{}');
  check('pair 送的只有配對碼和標籤（預設標籤不是電腦名稱）', Object.keys(pb).sort().join() === 'code,label' && pb.code === 'ABC123' && pb.label === '我的 Codex' && !leaks(srv).length, JSON.stringify(pb));
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job({ id: 'job_cli1' })] });
  const log = plan([{ kind: 'write', from: path.join(EX, 'color-match'), say: `做好了（暫存在 ${HOME}/scratch，主機 ${HOST}）` }]);
  const r = startCli(['run', srv.url, '--state', stateFor(srv), '--codex', FAKE_CODEX, '--once'], { env: { FAKE_MARK: 'inherited', CODEX_HOME: FAKE_CODEX_HOME } });
  const e = await r.exited;
  const calls = log.calls();
  const c0 = calls[0] || {};
  const pkg = srv.packages[0] || {};
  const done = e.code === 0 && srv.packages.length === 1 && /✅ 完成/.test(r.out());
  check('run --once：收到工作 → 叫 codex → 送作品包 → 完成，結束碼 0', done, done ? '' : r.out().slice(-300));
  check('長輪詢：GET /api/connector/jobs?wait=25，帶 Bearer token', srv.polls[0] === '25' && srv.requests.filter((q) => q.path.startsWith('/api/connector/jobs')).every((q) => q.headers.authorization === `Bearer ${TOKEN}`));
  const wd = c0.cwd ? realpathSync(c0.cwd) : '';
  const expect = c0.argv ? C.buildCodexArgs(c0.argv[6], c0.argv.at(-1)) : [];
  check('codex 用規格裡的參數執行，工作資料夾＝-C 的資料夾＝執行時的 cwd', JSON.stringify(c0.argv) === JSON.stringify(expect) && c0.argv?.[9] === path.join(c0.argv[6], 'last-message.txt') && realpathSync(c0.argv[6]) === wd);
  check('工作資料夾裡有 AGENTS.md、check.mjs、examples/、job.json', c0.files?.length === 4 && c0.job?.intent === '做一個點顏色相符的球得分的遊戲' && c0.job?.mode === 'create' && c0.hadMain === false);
  check('任務說明（最後一個參數）要 Codex 讀 AGENTS.md、job.json 並跑 node check.mjs', /AGENTS\.md/.test(c0.argv?.at(-1)) && /node check\.mjs/.test(c0.argv?.at(-1)));
  check('環境變數原樣繼承（創作者自己的 Codex 設定與登入）', c0.mark === 'inherited' && c0.codexHome === FAKE_CODEX_HOME);
  check('events.jsonl：Codex 的 JSONL 存在工作資料夾', existsSync(path.join(wd, 'events.jsonl')) && readFileSync(path.join(wd, 'events.jsonl'), 'utf8').includes('"turn.completed"'));
  check('作品包：manifest 是物件、files["main.js"] 是原文', pkg.manifest?.name === '顏色配對球' && pkg.files?.['main.js'] === readFileSync(path.join(EX, 'color-match', 'main.js'), 'utf8'));
  check('provenance：{ tool: "codex-cli <版本>", via: "exec", attempt, ms }', pkg.provenance?.tool === 'codex-cli 9.9.9-test' && pkg.provenance?.via === 'exec' && pkg.provenance?.attempt === 1 && Number.isFinite(pkg.provenance?.ms) && Object.keys(pkg.provenance).length === 4, JSON.stringify(pkg.provenance));
  check('進度只送摘要（不是原始 JSONL）', srv.progress.includes('🔍 Codex 正在跑 check.mjs…') && srv.progress.includes('✅ check 通過') && srv.progress.some((m) => m.startsWith('📝 寫入 main.js')) && !srv.progress.some((m) => m.includes('"type"')), srv.progress.join(' | '));
  check('送出去的東西裡沒有主機名稱、帳號、家目錄、CODEX_HOME、本機暫存路徑', !leaks(srv).length, leaks(srv).join('、'));
  await srv.close();
}
{
  const srv = await fakeServer();
  const bogus = path.join(TMP, 'state', 'revoked.json');
  mkdirSync(path.dirname(bogus), { recursive: true });
  writeFileSync(bogus, JSON.stringify({ server: srv.url, token: 'tok_revoked_000000000000000000', creatorId: 'cr_x' }), { mode: 0o600 });
  const r = startCli(['run', srv.url, '--state', bogus, '--codex', FAKE_CODEX]);
  const e = await r.exited;
  check('配對失效（401）：印「配對失效，請重新 pair」並結束', e.code === 1 && /配對失效，請重新 pair/.test(r.out()));
  const other = startCli(['run', 'http://127.0.0.1:9', '--state', STATE]);
  const oe = await other.exited;
  check('配對資料是別台伺服器的：拒絕（token 不送給別台）', oe.code === 2 && /是配對 .* 的，不是/.test(other.out()));
  await srv.close();
}

console.log('\n— 修正、修改、失敗（在測試程序裡跑 connector）');
{
  // 第 1 輪壞、伺服器回診斷 → 第 2 輪 Codex 看到診斷、修好
  const srv = await fakeServer({ jobs: [job()] });
  const log = plan([
    { kind: 'write', from: path.join(FX, 'bad-then-fixed') },
    { kind: 'write', from: path.join(FX, 'bad-then-fixed', 'attempt2') },
  ]);
  const r = await runIn(srv);
  const calls = log.calls();
  const fixed = r.code === 0 && srv.packages.length === 2 && calls.length === 2 && calls[1].job.diagnostics?.some((d) => /tick\(\) 第 1 步出錯/.test(d)) && calls[1].job.round === 2 && calls[0].cwd === calls[1].cwd && calls[1].hadMain;
  check('第一版沒過 → 診斷放進 job.json → 同一個資料夾再叫一次 Codex → 第二版通過', fixed, fixed ? '' : r.out.slice(-300));
  check('第二輪的任務說明帶診斷；provenance.attempt 1 → 2', /第 2 輪/.test(calls[1]?.argv.at(-1)) && srv.packages.map((p) => p.provenance.attempt).join() === '1,2');
  await srv.close();
}
{
  // 修改既有作品：舊版先放進工作資料夾，Codex 交 v2（stateSchema 2＋migrate），伺服器用舊版做換版試跑
  const target = { lineage: 'lin_star', baseVersion: 1, name: '接星星', ...pkgFrom(path.join(FX, 'good')) };
  const srv = await fakeServer({ jobs: [job({ intent: '加上連擊和最高分', target, attempt: 3 })] });
  const log = plan([{ kind: 'write', from: path.join(FX, 'v2-migrate') }]);
  const r = await runIn(srv);
  const c0 = log.calls()[0] || {};
  check('修改既有作品：工作資料夾先放舊版 main.js、job.json mode modify', c0.hadMain === true && c0.job.mode === 'modify' && c0.job.target.code === target.code && /修改/.test(c0.argv.at(-1)));
  check('修改既有作品：v2 通過換版試跑；provenance.attempt 接著伺服器的第 3 版', r.code === 0 && srv.packages[0]?.manifest.stateSchema === 2 && srv.packages[0]?.provenance.attempt === 3);
  await srv.close();
}
{
  // 修改既有作品，Codex 卻什麼都沒改：不送一模一樣的新版本，下一輪帶診斷
  const target = { lineage: 'lin_star', baseVersion: 1, name: '接星星', ...pkgFrom(path.join(FX, 'good')) };
  const srv = await fakeServer({ jobs: [job({ intent: '加上連擊', target })] });
  const log = plan([{ kind: 'nothing' }, { kind: 'write', from: path.join(FX, 'v2-migrate') }]);
  const r = await runIn(srv);
  check('修改既有作品卻原封不動 → 不送，下一輪帶「跟舊版一模一樣」', r.code === 0 && srv.packages.length === 1 && srv.packages[0].manifest.stateSchema === 2 && log.calls()[1]?.job.diagnostics?.some((d) => /跟舊版一模一樣/.test(d)));
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()], reply: async () => ({ ok: false, diagnostics: ['假的診斷：永遠不過'] }) });
  plan([{ kind: 'write', from: path.join(FX, 'good') }]);
  const r = await runIn(srv, { maxAttempts: 3 });
  check('最多 --max-attempts 輪：3 版都沒過 → POST fail', r.code === 1 && srv.packages.length === 3 && srv.fails.length === 1 && /試了 3 輪/.test(srv.fails[0]?.message) && srv.fails[0]?.quota === false);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()] });
  plan([{ kind: 'quota' }]);
  const r = await runIn(srv);
  const f = srv.fails[0] || {};
  check('額度用完 → POST fail「額度用完」＋ quota: true，不送作品包', r.code === 1 && /額度用完/.test(f.message) && f.quota === true && !srv.packages.length, f.message);
  check('額度用完：進度裡也不轉送 Codex 的方案資訊', !srv.progress.some((m) => /Upgrade|Pro|chatgpt\.com/.test(m)), srv.progress.join(' | '));
  await srv.close();
}
for (const [kind, re, name] of [
  ['crash', /Codex 沒有完成這次生成（結束碼 101）/, '一般失敗（Codex 當掉）'],
  ['auth', /還沒登入或登入已過期.*codex login/, '沒登入'],
]) {
  const srv = await fakeServer({ jobs: [job()] });
  plan([{ kind }]);
  const r = await runIn(srv);
  const f = srv.fails[0] || {};
  check(`${name} → POST fail，不說成額度用完`, r.code === 1 && re.test(f.message) && !/額度/.test(f.message) && f.quota === false, f.message);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()] });
  const r = await runIn(srv, { codexBin: path.join(TMP, 'no-such-codex') });
  check('找不到 codex 執行檔 → POST fail「找不到 Codex」', r.code === 1 && /找不到 Codex（no-such-codex）/.test(srv.fails[0]?.message) && srv.fails[0]?.quota === false, srv.fails[0]?.message);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()] });
  const log = plan([{ kind: 'busy' }, { kind: 'write', from: path.join(FX, 'good') }]);
  const r = await runIn(srv);
  check('OpenAI 太忙 → 等一下自動重跑（不算一輪），然後完成', r.code === 0 && log.calls().length === 2 && srv.progress.some((m) => /暫時太忙/.test(m)) && !srv.fails.length && srv.packages[0]?.provenance.attempt === 1);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()] });
  const log = plan([{ kind: 'nothing' }, { kind: 'write', from: path.join(FX, 'good') }]);
  const r = await runIn(srv);
  check('Codex 沒寫出檔案 → 不送，下一輪帶「沒有寫出 manifest.json」', r.code === 0 && srv.packages.length === 1 && log.calls()[1]?.job.diagnostics?.some((d) => /沒有寫出 manifest\.json/.test(d)));
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()] });
  plan([{ kind: 'write', from: path.join(FX, 'good'), append: `\n// 偷看：${HOME}/.ssh/id_rsa\n` }]);
  const r = await runIn(srv);
  check('作品裡出現本機資訊 → 不送作品包、POST fail（訊息不含那個值）', r.code === 1 && !srv.packages.length && /本機資訊（家目錄路徑）/.test(srv.fails[0]?.message) && !leaks(srv).length);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job({ target: { lineage: 'lin_a', baseVersion: 1, name: '接星星', ...pkgFrom(path.join(FX, 'good')) } })], reply: async () => ({ ok: false, conflict: true, status: 'conflict', diagnostics: ['作品「接星星」在你生成的時候已經更新到 v2'] }) });
  plan([{ kind: 'write', from: path.join(FX, 'v2-migrate') }]);
  const r = await runIn(srv);
  check('衝突（作品已被更新）→ 停止，不再重修、不送 fail', r.code === 1 && srv.packages.length === 1 && !srv.fails.length && /已經更新到 v2/.test(r.out));
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job()], cancelAfterProgress: 1 });
  const log = plan([{ kind: 'slow' }]);
  const t0 = Date.now();
  const r = await runIn(srv);
  const pid = log.calls()[0]?.pid;
  await sleep(300);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  check('工作在伺服器被取消（progress 回 409）→ 停掉 Codex、不送作品包也不送 fail', r.code === 1 && !alive && !srv.packages.length && !srv.fails.length && Date.now() - t0 < 10_000 && /不用做了/.test(r.out), `${Date.now() - t0} ms`);
  await srv.close();
}
{
  // fixture 模式：不叫 Codex；第 1 輪送壞的、第 2 輪送 attempt2/
  const srv = await fakeServer({ jobs: [job()] });
  const log = plan([{ kind: 'crash' }]);
  const r = await runIn(srv, { fixtureDir: path.join(FX, 'bad-then-fixed') });
  const p = srv.packages;
  check('--fixture：不叫 Codex，第 1 輪送第一版（伺服器回診斷）、第 2 輪送 attempt2/（通過）', r.code === 0 && !log.calls().length && p.length === 2 && !p[0].files['main.js'].includes('function press') && p[1].files['main.js'].includes('function press'));
  check("--fixture：provenance { tool: 'fixture', via: 'fixture' }", p.every((x) => x.provenance.tool === 'fixture' && x.provenance.via === 'fixture') && p.map((x) => x.provenance.attempt).join() === '1,2');
  await srv.close();
}

console.log('\n— 連線與結束');
{
  // 伺服器一開始連不上：退避重試，伺服器起來後接到工作
  const probe = http.createServer();
  const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
  await new Promise((resolve) => probe.close(resolve));
  plan([{ kind: 'write', from: path.join(FX, 'good') }]);
  let srv = null;
  const later = sleep(1500).then(async () => (srv = await fakeServer({ jobs: [job()], port })));
  const t0 = Date.now();
  const r = await runIn({ url: `http://127.0.0.1:${port}` });
  await later;
  check('連不到伺服器 → 1、2… 秒退避重試，伺服器起來後照常接工作', r.code === 0 && /連不到伺服器（ECONNREFUSED/.test(r.out) && /1 秒後再試/.test(r.out) && srv?.packages.length === 1, `${Date.now() - t0} ms`);
  await srv?.close();
}
{
  const srv = await fakeServer({ holdMs: 300 });
  const r = startCli(['run', srv.url, '--state', stateFor(srv), '--codex', FAKE_CODEX]);
  const ready = await r.waitFor(/等待工作中/);
  await sleep(400);
  const t0 = Date.now();
  r.child.kill('SIGINT');
  const e = await r.exited;
  check('Ctrl+C（等工作時）→ 乾淨結束，結束碼 0', ready && e.code === 0 && /connector 已停止/.test(r.out()) && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  await srv.close();
}
{
  const srv = await fakeServer({ jobs: [job({ id: 'job_sigint' })] });
  const log = plan([{ kind: 'slow' }]);
  const r = startCli(['run', srv.url, '--state', stateFor(srv), '--codex', FAKE_CODEX, '--once']);
  let started = false;
  for (let i = 0; i < 200 && !started; i += 1) {
    started = log.calls().length > 0;
    await sleep(50);
  }
  await sleep(200);
  r.child.kill('SIGINT');
  const e = await r.exited;
  const pid = log.calls()[0]?.pid;
  await sleep(300);
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  check('Ctrl+C（Codex 做到一半）→ 停掉 Codex、回報工作沒完成、結束', started && !alive && e.code !== null && /connector 被停止了/.test(srv.fails[0]?.message || '') && !srv.packages.length, srv.fails[0]?.message);
  await srv.close();
}

clearTimeout(watchdog);
rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
