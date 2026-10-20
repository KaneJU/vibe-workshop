// 打造基準測試（借鏡微軟 LLMR 的做法：固定一組題目，每次改規格書或驗收程式就重跑，用數字比較）。
// 把題目丟給一台正在跑的工坊，記下成功與否、花多久、驗收跑幾輪、有幾則提醒，並把每個成品拍成照片。
// 會用 Codex 額度，所以要明確打開：
//   WITH_CODEX=1 BASE=http://localhost:5311 DATA_DIR=/tmp/vw-test-data LABEL=new npm run bench
// 結果在 tests/out/bench-<LABEL>.json 和 tests/out/bench-<LABEL>-<題號>.png
// 被 OpenAI 擋下（429、模型滿載、額度用完）的題目標成「擋下」，不算成績；ONLY=4,5 只重跑那幾題，併回同一份結果。
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshotter } from '../fabricator/snapshotter.mjs';

if (process.env.WITH_CODEX !== '1') {
  console.error('基準測試會用掉 Codex 額度：確定要跑請加 WITH_CODEX=1');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:5311';
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-test-data';
const LABEL = process.env.LABEL || 'run';
const ONLY = (process.env.ONLY || '').split(',').map(Number).filter(Boolean);
const BLOCKED_RE = /429|too many requests|at capacity|overloaded|usage limit|額度用完|一直很忙/i;
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：基準測試會在工具箱裡加東西，請對測試用資料夾（預設 :5311）跑。');
  process.exit(2);
}
const OUT = path.join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });

export const PROMPTS = [
  '一隻坐著的柴犬',
  '一張四隻腳的木頭餐桌，上面放一個花瓶',
  '一台可以開的消防車',
  '做一個左納烏風扇裝置，紅色的、比工具箱裡那個大一點',
  '把這裡變成黃昏的沙漠',
  '用藍光能量方塊疊一座金字塔',
];

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
const done = list.filter((r) => r.ok).map((r) => r.seconds).sort((a, b) => a - b);
const summary = {
  label: LABEL,
  at: new Date().toISOString(),
  passed: done.length,
  total: list.length,
  blocked: list.filter((r) => r.blocked).length,
  medianSeconds: done.length ? done[Math.floor(done.length / 2)] : null, // 只算成功的
  warnings: list.reduce((n, r) => n + r.warnings.length, 0),
  results: list,
};
writeFileSync(path.join(OUT, `bench-${LABEL}.json`), JSON.stringify(summary, null, 2));
const counted = summary.total - summary.blocked;
console.log(
  `\n${LABEL}：${summary.passed}/${counted} 成功${summary.blocked ? `（另有 ${summary.blocked} 題被 OpenAI 擋下，不算）` : ''}，成功的中位數 ${summary.medianSeconds} 秒，提醒共 ${summary.warnings} 則 → tests/out/bench-${LABEL}.json`,
);
