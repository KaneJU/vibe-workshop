// 打造基準測試（借鏡微軟 LLMR 的做法：固定一組題目，每次改規格書或驗收程式就重跑，用數字比較）。
// 把題目丟給一台正在跑的工坊，記下成功與否、花多久、驗收跑幾輪、有幾則提醒，並把每個成品拍成照片。
// 再「試用」每個成品：不管是哪一版做的，都用現在的驗收程式重驗（編出來的 API、裝置試開、開車時輪子轉不轉），
// 有操作鉤子的再按一次 ⚡，看有沒有反應。
// 會用 Codex 額度，所以要明確打開：
//   WITH_CODEX=1 BASE=http://localhost:5311 DATA_DIR=/tmp/vw-test-data LABEL=new npm run bench
//   SET=hard 換成會動、會互動的難題；舊版伺服器的工作資料夾不在這個 repo 時，用 JOBS_DIR 指過去
// 結果在 tests/out/bench-<LABEL>.json 和 tests/out/bench-<LABEL>-<題號>.png
// 被 OpenAI 擋下（429、模型滿載、額度用完）的題目標成「擋下」，不算成績；ONLY=4,5 只重跑那幾題，併回同一份結果。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { createSnapshotter } from '../fabricator/snapshotter.mjs';
import { createRuntime } from '../public/runtime.mjs';

if (process.env.WITH_CODEX !== '1') {
  console.error('基準測試會用掉 Codex 額度：確定要跑請加 WITH_CODEX=1');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:5311';
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-test-data';
const JOBS_DIR = process.env.JOBS_DIR || path.join(ROOT, 'jobs');
const LABEL = process.env.LABEL || 'run';
const ONLY = (process.env.ONLY || '').split(',').map(Number).filter(Boolean);
const BLOCKED_RE = /429|too many requests|at capacity|overloaded|usage limit|額度用完|一直很忙/i;
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：基準測試會在工具箱裡加東西，請對測試用資料夾（預設 :5311）跑。');
  process.exit(2);
}
const OUT = path.join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });

export const PROMPT_SETS = {
  // 日常題：做不做得出來、像不像
  everyday: [
    '一隻坐著的柴犬',
    '一張四隻腳的木頭餐桌，上面放一個花瓶',
    '一台可以開的消防車',
    '做一個左納烏風扇裝置，紅色的、比工具箱裡那個大一點',
    '把這裡變成黃昏的沙漠',
    '用藍光能量方塊疊一座金字塔',
  ],
  // 難題：要會動、會互動（開、飛、戴、裝置、規則）
  hard: [
    '一台可以開的推土機，按 ⚡ 鏟子會升起來',
    '做一個左納烏噴射裝置，黏在東西上按一下會往上噴兩秒',
    '一架可以飛的直升機，螺旋槳會一直轉',
    '戴在手上的雷射槍，按 ⚡ 會射出一道紅光',
    '做一個比工具箱裡大一號的左納烏輪子，四個裝在木板上要能開',
    '加一條規則：東西碰到木板就會被彈飛',
  ],
};
const PROMPTS = PROMPT_SETS[process.env.SET || 'everyday'];
if (!PROMPTS) {
  console.error(`沒有這組題目：${process.env.SET}（可選 ${Object.keys(PROMPT_SETS).join('、')}）`);
  process.exit(2);
}

const api = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};
const t0 = Date.now();
const jobs = [];
for (const [i, prompt] of PROMPTS.entries()) {
  if (ONLY.length && !ONLY.includes(i + 1)) continue;
  const r = await api('POST', '/api/generate', { prompt, mode: 'create', selection: [], scene: [], player: [0, 1.6, 4] });
  jobs.push({ i, prompt, id: r.job.id });
}
const results = new Map();
while (results.size < jobs.length && Date.now() - t0 < 30 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 4000));
  for (const j of jobs) {
    if (results.has(j.id)) continue;
    const s = await api('GET', `/api/jobs/${j.id}`);
    if (!['done', 'error', 'cancelled'].includes(s.status)) continue;
    const made = s.part || s.module || null;
    results.set(j.id, {
      n: j.i + 1,
      prompt: j.prompt,
      ok: s.status === 'done',
      blocked: s.status !== 'done' && BLOCKED_RE.test([s.error, ...(s.log || [])].join('\n')),
      seconds: Math.round(s.elapsedMs / 1000),
      kind: s.module ? s.module.type : s.part ? 'part' : null,
      name: made?.name || null,
      id: made?.id || null,
      warnings: s.warnings || [],
      error: s.error ? String(s.error).split('\n')[0].slice(0, 200) : null,
      ...(s.stats || {}),
    });
    const r = results.get(j.id);
    console.log(`${r.ok ? '✅' : r.blocked ? '⛔' : '❌'} ${r.n}. ${r.prompt} → ${r.name || r.error}（${r.seconds} 秒${r.validateRuns ? `，驗收 ${r.validateRuns} 輪` : ''}${r.snapshots ? `，看圖 ${r.snapshots} 次` : ''}${r.warnings.length ? `，${r.warnings.length} 則提醒` : ''}）`);
  }
}

// 每個成品拍一張照（用同一套拍照服務，舊版的成品也拍，才比得出來）
const lib = JSON.parse(readFileSync(path.join(DATA_DIR, 'library.json'), 'utf8'));
let worldsLib = { modules: [] };
try {
  worldsLib = JSON.parse(readFileSync(path.join(DATA_DIR, 'worlds.json'), 'utf8'));
} catch {
  /* 沒有世界模組 */
}
const snaps = createSnapshotter({ root: ROOT, partsDir: path.join(DATA_DIR, 'parts'), libraryFile: path.join(DATA_DIR, 'library.json') });
const fresh = [...results.values()];
let earlier = [];
if (ONLY.length) {
  try {
    earlier = JSON.parse(readFileSync(path.join(OUT, `bench-${LABEL}.json`), 'utf8')).results.filter((r) => !ONLY.includes(r.n));
  } catch {
    /* 第一次跑 */
  }
}
const list = [...earlier, ...fresh].sort((a, b) => a.n - b.n);
for (const r of fresh) {
  if (!r.ok || !r.id) continue;
  const out = path.join(OUT, `bench-${LABEL}-${r.n}.png`);
  if (r.kind === 'part' && lib.parts.some((p) => p.id === r.id)) await snaps.render({ partId: r.id, outGrid: out });
  else if (r.kind === 'environment' || r.kind === 'rule') await snaps.render({ file: path.join(DATA_DIR, 'world', `${r.id}.js`), kind: 'world', worldType: r.kind, outGrid: out });
  r.snapshot = path.relative(ROOT, out);
}
await snaps.close();

// ---- 試用 1：用現在的驗收程式重驗 ----
function revalidate(r) {
  const isPart = r.kind === 'part';
  const rec = isPart ? lib.parts.find((p) => p.id === r.id) : worldsLib.modules.find((m) => m.id === r.id);
  const file = isPart ? 'part.js' : 'world.js';
  // 放在 jobs/ 底下，validate.mjs 才找得到專案的 node_modules（three、rapier）
  const dir = path.join(ROOT, 'jobs', `__bench_${LABEL}_${r.n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const src = rec?.jobId ? path.join(JOBS_DIR, rec.jobId) : null;
  if (src && existsSync(path.join(src, file)) && existsSync(path.join(src, 'meta.json'))) {
    cpSync(path.join(src, file), path.join(dir, file));
    cpSync(path.join(src, 'meta.json'), path.join(dir, 'meta.json'));
  } else {
    // 工作資料夾已經清掉：用工具箱裡的程式，meta 從工具箱紀錄還原
    cpSync(path.join(DATA_DIR, isPart ? 'parts' : 'world', `${r.id}.js`), path.join(dir, file));
    const keys = isPart ? ['name', 'description', 'placement', 'controls', 'wearSlot', 'physics', 'device'] : ['type', 'name', 'description', 'replaces'];
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(Object.fromEntries(keys.filter((k) => rec?.[k] != null).map((k) => [k, rec[k]]))));
  }
  cpSync(path.join(ROOT, 'fabricator', 'validate.mjs'), path.join(dir, 'validate.mjs'));
  writeFileSync(
    path.join(dir, 'context.json'),
    JSON.stringify({
      request: r.prompt,
      mode: 'create',
      selection: [],
      scene: [],
      player: { position: [0, 1.6, 3] },
      library: [],
      physics: { enabled: true },
      world: { environment: null, rules: [], library: [] },
      paths: {
        runtime: path.join(ROOT, 'public', 'runtime.mjs'),
        worldhost: path.join(ROOT, 'public', 'worldhost.mjs'),
        physics: path.join(ROOT, 'public', 'physics.mjs'),
        partsDir: path.join(DATA_DIR, 'parts'),
        libraryFile: path.join(DATA_DIR, 'library.json'),
      },
    }),
  );
  const res = spawnSync(process.execPath, ['validate.mjs', '--json'], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  let report;
  try {
    report = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    report = { ok: false, errors: [`驗收程式沒有回應：${(res.stderr || res.stdout).slice(-300)}`], warnings: [] };
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: !!report.ok, errors: report.errors || [], warnings: report.warnings || [] };
}

// ---- 試用 2：按 ⚡ 有沒有反應 ----
// 同一個零件做兩份，一份按 ⚡、一份不按，其他輸入和時間都一樣；之後兩份只要有任何東西不同（位置、顯示、顏色、亮度、多了物件）就算有反應
function signature(root) {
  const out = [];
  root.traverse((o) => {
    out.push(o.visible ? 1 : 0, ...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray());
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      out.push(m.opacity ?? 1, m.emissiveIntensity ?? 0, ...(m.emissive ? m.emissive.toArray() : []), ...(m.color ? m.color.toArray() : []));
    }
    if (o.isLight) out.push(o.intensity);
  });
  return out;
}
const sameSig = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-4);
let probeRt = null;
async function actionProbe(r) {
  const rec = lib.parts.find((p) => p.id === r.id);
  if (!rec) return null;
  if (!probeRt) {
    probeRt = createRuntime({ THREE, player: { position: new THREE.Vector3(0, 1.6, 3) } });
    probeRt.setLibrary(lib.parts);
    for (const p of lib.parts) {
      if (p.kind !== 'generated') continue;
      try {
        probeRt.registerModule(p.id, await import(pathToFileURL(path.join(DATA_DIR, 'parts', `${p.id}.js`)).href));
      } catch {
        /* 壞掉的舊零件略過 */
      }
    }
  }
  const A = probeRt.instantiate(r.id);
  const B = probeRt.instantiate(r.id);
  const ha = A.object.userData.onControl;
  const hb = B.object.userData.onControl;
  if (typeof ha !== 'function' || typeof hb !== 'function') return { hook: false };
  const mode = rec.controls || 'drive';
  let comparable = true;
  let reacted = false;
  try {
    for (let f = 0; f < 90; f += 1) {
      const base = { mode, speed: 0, steer: 0, throttle: 0, lift: 0, t: f / 60 };
      ha.call(A.object, { ...base, action: false, actionHeld: false }, 1 / 60);
      hb.call(B.object, { ...base, action: f === 20, actionHeld: f >= 20 && f < 40 }, 1 / 60);
      for (const X of [A, B]) for (const u of X.updaters) u.fn.call(u.obj, 1 / 60, f / 60);
      const same = sameSig(signature(A.object), signature(B.object));
      if (f < 20 && !same) comparable = false;
      if (f >= 20 && !same) reacted = true;
    }
  } catch (e) {
    return { hook: true, error: String(e?.message || e).slice(0, 200) };
  }
  return { hook: true, comparable, reacted };
}

for (const r of fresh) {
  if (!r.ok || !r.id) continue;
  const tryout = revalidate(r);
  if (r.kind === 'part') tryout.action = await actionProbe(r);
  r.tryout = tryout;
  const a = tryout.action;
  const act = !a?.hook ? '' : a.error ? `；⚡ 出錯：${a.error}` : !a.comparable ? '；⚡ 無法比較' : a.reacted ? '；⚡ 有反應' : '；⚡ 沒反應';
  console.log(`🔧 試用 ${r.n}. ${r.name}：${tryout.ok ? '通過現在的驗收' : `沒通過現在的驗收——${tryout.errors.join('；').slice(0, 300)}`}${tryout.warnings.length ? `（提醒：${tryout.warnings.join('；').slice(0, 300)}）` : ''}${act}`);
}

const done = list.filter((r) => r.ok).map((r) => r.seconds).sort((a, b) => a - b);
const summary = {
  label: LABEL,
  set: process.env.SET || 'everyday',
  at: new Date().toISOString(),
  passed: done.length,
  total: list.length,
  blocked: list.filter((r) => r.blocked).length,
  medianSeconds: done.length ? done[Math.floor(done.length / 2)] : null, // 只算成功的
  warnings: list.reduce((n, r) => n + r.warnings.length, 0),
  tryoutPassed: list.filter((r) => r.tryout?.ok).length, // 用現在的驗收重驗也過的
  results: list,
};
writeFileSync(path.join(OUT, `bench-${LABEL}.json`), JSON.stringify(summary, null, 2));
const counted = summary.total - summary.blocked;
console.log(
  `\n${LABEL}：${summary.passed}/${counted} 成功${summary.blocked ? `（另有 ${summary.blocked} 題被 OpenAI 擋下，不算）` : ''}，試用也過 ${summary.tryoutPassed} 件，成功的中位數 ${summary.medianSeconds} 秒，提醒共 ${summary.warnings} 則 → tests/out/bench-${LABEL}.json`,
);
