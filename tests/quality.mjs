// 自動畫質（public/quality.mjs＋app.js）：
//   A. 規則本身（Node、假的每格時間，可重複）：一直慢 → 降到底；變快 → 一階一階升回最高、影子回來；
//      卡在中間（升上去就慢）→ 失敗後等更久、失敗 2 次就不再試（不會一直跳）；22–40 ms 的格不會升。
//   B. 真的瀏覽器、真的遊戲房（慢 → 快）：用這台機器的 GPU，CDP 把 CPU 放慢 150 倍讓每格變慢 → 比賽中一階一階降到
//      0.75（很慢時一次降好幾階；關影子那一步等比賽結束才做）→ 結算時關影子 → 拿掉放慢 → 升回最高解析度、影子打開；重開影子時 shader 數量不增加。
//   C. 軟體繪圖（SwiftShader，很慢的裝置的代表）的手機畫面：「降級過渡」和「穩定之後」分開量；
//      每次換階的那一格花多久、當下 shader 數量有沒有變（有變＝那一格在編譯）；第二回合再量一次穩定狀態。
//   node tests/quality.mjs        （自己開只聽 127.0.0.1 的測試伺服器 5323、暫存資料夾；只讀狀態，不改遊戲）
//   ONLY=A|B|C 只跑一段；結果寫到 tests/out/quality/
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuality, levelsFor } from '../public/quality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'quality');
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const fmt = (l) => `${l.pr}${l.shadows ? '＋影子' : ''}`;

// ---------------- A. 規則本身 ----------------
// 模擬：每一階的每格時間（秒）由 frameAt(level, t) 決定，跑 seconds 秒
function simulate(max, frameAt, seconds) {
  const applied = [];
  const q = createQuality({ max, apply: (l) => applied.push(l) });
  let t = 0;
  while (t < seconds) {
    const dt = frameAt(q.state.level, t, q.levels);
    q.update(dt);
    t += dt;
  }
  return { q, applied, path: q.state.log.map((e) => `${e.t}s→${fmt(e)}`) };
}
if (!ONLY || ONLY === 'A') {
  console.log('— A. 規則（模擬每格時間）');
  check('手機（像素比 2）的階梯：2 → 1.5 → 1 → 0.75 → 0.75 關影子（影子最後才關）', levelsFor(2).map(fmt).join(' / ') === '2＋影子 / 1.5＋影子 / 1＋影子 / 0.75＋影子 / 0.75', levelsFor(2).map(fmt).join(' / '));
  check('電腦（像素比 1）的階梯：1 → 0.75 → 0.75 關影子', levelsFor(1).map(fmt).join(' / ') === '1＋影子 / 0.75＋影子 / 0.75', levelsFor(1).map(fmt).join(' / '));
  {
    // 一直很慢、而且降解析度也沒用（每格 120 ms，像 CPU 忙不過來）→ 降到最低就停
    const r = simulate(2, () => 0.12, 30);
    const last = r.q.state;
    check('一直慢（降解析度也沒用）→ 降到最低（0.75、影子關）就停，不再動', last.level === 4 && !last.shadows && last.pr === 0.75 && r.applied.length <= 4 && r.q.state.log.at(-1).t < 10, r.path.join('  '));
  }
  {
    // 畫素多就慢（每格時間 ∝ 解析度²，像 GPU／軟體繪圖忙不過來）：解析度 2 時每格 130 ms → 一次跳到預估 30 ms 內的那一階
    const r = simulate(2, (lv, t, levels) => 0.13 * (levels[lv].pr / 2) ** 2, 12);
    check('很慢（解析度 2 時每格 130 ms）：一次跳到 0.75，只換一次解析度（軟體繪圖每換一次卡 1–5 秒）', r.q.state.log[0]?.pr === 0.75 && r.q.state.log[0].shadows && r.q.state.log.filter((e) => e.why === 'slow').length === 1, r.path.join('  '));
    const r2 = simulate(2, (lv, t, levels) => 0.05 * (levels[lv].pr / 2) ** 2, 30);
    check('有點慢（解析度 2 時每格 50 ms）：只降一階到 1.5（預估 28 ms）就停', r2.applied.length === 1 && r2.q.state.pr === 1.5 && r2.q.state.shadows, r2.path.join('  '));
  }
  {
    // 前 20 秒很慢、之後很快（每格 10 ms）→ 升回最高、影子回來
    const r = simulate(2, (lv, t) => (t < 20 ? 0.12 : 0.01), 80);
    const last = r.q.state;
    check('慢 → 快：升回最高解析度、影子打開（升級的路徑也看得到）', last.level === 0 && last.pr === 2 && last.shadows && r.applied.some((l) => !l.shadows), r.path.join('  '));
    const ups = r.q.state.log.filter((e) => e.why === 'fast');
    const gaps = ups.slice(1).map((e, i) => e.t - ups[i].t);
    check('升級要先順 6 秒以上（每一階之間至少隔 6 秒）', ups.length === 4 && gaps.every((g) => g >= 6), `升級時間 ${ups.map((e) => e.t).join('、')} 秒`);
  }
  {
    // 卡在中間：解析度 1 以上就慢（50 ms），0.75 很快（12 ms）→ 試著升回 1、失敗、等更久、再失敗 → 不再試
    const r = simulate(2, (lv, t, levels) => (levels[lv].pr >= 1 ? 0.05 : 0.012), 240);
    const tries = r.q.state.log.filter((e) => e.why === 'fast');
    const gaps = [];
    const log = r.q.state.log;
    for (let i = 0; i < log.length; i += 1) if (log[i].why === 'fast' && i > 0) gaps.push(+(log[i].t - log[i - 1].t).toFixed(1));
    check('卡在中間（升上去就慢）：最多試 2 次就不再試，最後停在順的那一階', tries.length === 2 && r.q.state.pr === 0.75 && r.q.state.shadows, r.path.join('  '));
    check('第二次試要等比第一次久（6 秒 → 12 秒，遲滯＋退讓）', gaps.length === 2 && gaps[0] >= 6 && gaps[1] >= 12, `降下來之後等了 ${gaps.join('、')} 秒才再試`);
    check('240 秒內換階總次數有上限（不會一直跳）', r.applied.length <= 8, `${r.applied.length} 次`);
  }
  {
    // 一直慢，但前 40 秒是「比賽中」（不能開關影子）→ 解析度先降到 0.75，關影子那一步等到 40 秒才做
    const applied = [];
    let t = 0;
    const q = createQuality({ max: 2, apply: (l) => applied.push(l), canSwitchShadows: () => t >= 40 });
    let heldAt = null;
    while (t < 60) {
      q.update(0.12);
      t += 0.12;
      if (heldAt === null && q.state.pending) heldAt = t;
    }
    const off = q.state.log.find((e) => !e.shadows);
    check('比賽中不開關影子：解析度先降到 0.75，「關影子」先記著，比賽結束才做', heldAt !== null && heldAt < 40 && off && off.t >= 40 && !q.state.shadows, `${heldAt?.toFixed(1)} 秒決定要關影子 → ${off?.t} 秒（可以換的時候）才關`);
  }
  {
    // 每格 30 ms（22–40 ms 之間）：不降也不升
    const r = simulate(2, () => 0.03, 60);
    check('每格 30 ms（在中間地帶）：不降也不升', r.applied.length === 0, r.path.join('  ') || '沒有換');
  }
  {
    // 大部分很快、但三成的格 30 ms（一直有點卡）：不會升（中間的格會倒扣）
    const r = simulate(2, (lv, t) => (t < 10 ? 0.12 : Math.floor(t * 50) % 10 < 3 ? 0.03 : 0.012), 90);
    check('降級後「七成快、三成 30 ms」：不升上去（不會升了又掉）', r.q.state.log.every((e) => e.why === 'slow'), r.path.join('  '));
  }
}

// ---------------- 測試伺服器 ----------------
let server = null;
let browser = null;
const PORT = 5323;
const BASE = `http://127.0.0.1:${PORT}`;
async function startServer() {
  const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-quality-'));
  server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex' }, stdio: 'ignore' });
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${BASE}/api/games`).then((r) => r.ok, () => false)) return;
    await sleep(200);
  }
  throw new Error('測試伺服器沒起來');
}
const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

// 開一個房間、真的按「開始比賽」、拿槍看向靶場；之後每格記錄（只讀）：時間、間隔、解析度、影子、shader 數量、畫質階
async function openGame(page, seconds) {
  const g = (await post('/api/games', { game: { rule: { type: 'timed', seconds } } })).game;
  const room = await post('/api/rooms', { gameId: g.id });
  await page.goto(`${BASE}/?room=${room.code}`);
  await page.waitForFunction(() => window.__ws?.game?.phase === 'lobby', null, { timeout: 90000 });
  await page.locator('#gameCardBtns button:has-text("開始比賽")').first().click();
  await page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 90000 });
  await page.evaluate(() => {
    const w = window.__ws;
    window.__fr = [];
    let last = performance.now();
    const f = (t) => {
      const q = w.quality;
      window.__fr.push([+t.toFixed(1), +(t - last).toFixed(1), q.renderer.pixelRatio, q.renderer.shadows, q.renderer.programs, q.level, q.inPlay]);
      last = t;
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}
// 拿槍站在原地看向靶場（拍照、量效能都用同一個方向；只轉鏡頭）
const lookDownRange = (page) =>
  page.evaluate(() => {
    const w = window.__ws;
    const c = w.camera;
    const d = new w.THREE.Vector3(c.position.x, 1.25, -9).sub(c.position).normalize();
    w.controls.target.copy(c.position).addScaledVector(d, 0.1);
    w.controls.update();
  });
const frames = (page, from = 0) => page.evaluate((from) => window.__fr.filter((x) => x[0] >= from), from);
function stat(fr) {
  const d = fr.map((x) => x[1]).sort((a, b) => a - b);
  if (!d.length) return null;
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
  return { frames: d.length, fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), p50_ms: q(0.5), p95_ms: q(0.95), max_ms: d[d.length - 1], over_33ms: d.filter((v) => v > 33.4).length };
}
// 每次換階：哪一格、換成什麼、換了之後 1 秒內開始的格裡最長的一格（卡住的那一格會畫很久才結束）、shader 數量前後
function transitions(fr) {
  const out = [];
  for (let i = 1; i < fr.length; i += 1) {
    if (fr[i][5] === fr[i - 1][5]) continue;
    const t = fr[i][0];
    const next = fr.filter((x) => x[0] > t && x[0] - x[1] <= t + 1000);
    const longest = next.reduce((a, b) => (b[1] > a[1] ? b : a), next[0] || fr[i]);
    out.push({ at_ms: t, to: `${fr[i][2]}${fr[i][3] ? '＋影子' : ''}`, in_play: fr[i][6], programs_before: fr[i - 1][4], programs_after: longest ? longest[4] : fr[i][4], longest_next_1s_ms: longest ? longest[1] : null });
  }
  return out;
}

try {
  if (!ONLY || ONLY === 'B' || ONLY === 'C') {
    await startServer();
    const { chromium, devices } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');

    // ---------------- B. 真的瀏覽器：慢 → 快 ----------------
    if (!ONLY || ONLY === 'B') {
      console.log('— B. 遊戲房（GPU、手機 390×844）：CPU 放慢 → 恢復');
      // 新版 headless（channel: 'chromium'）：影格節奏跟一般視窗一樣（舊的 headless shell 不放慢也只有約 20 fps，量不出「變快」）
      browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
      const ctx = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
      await openGame(page, 30);
      await lookDownRange(page);
      await sleep(3000);
      const start = await page.evaluate(() => window.__ws.quality);
      check('開始：最高畫質（解析度 2、影子開）', start.renderer.pixelRatio === 2 && start.renderer.shadows && start.level === 0, JSON.stringify(start.renderer));
      const cdp = await ctx.newCDPSession(page);
      const tSlow = await page.evaluate(() => performance.now());
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 150 });
      // 比賽中：降到 0.75（還有影子），「關影子」先記著
      const held = await page.waitForFunction(() => window.__ws.quality.pending !== null, null, { timeout: 60000, polling: 250 }).then(() => true, () => false);
      const mid = await page.evaluate(() => ({ q: window.__ws.quality, phase: window.__ws.game.phase }));
      check('CPU 放慢、比賽中：解析度降到 0.75（很慢時一次降好幾階），影子還開著、「關影子」等比賽結束', held && mid.phase === 'playing' && mid.q.renderer.pixelRatio === 0.75 && mid.q.renderer.shadows === true && mid.q.pending && !mid.q.pending.shadows, `${mid.q.log.map((e) => `${fmt(e)}(${e.why})`).join(' → ')}；等著：${mid.q.pending ? fmt(mid.q.pending) : '—'}（${mid.phase}）`);
      // 比賽結束（30 秒）→ 結算時才關影子
      const reachedBottom = await page.waitForFunction(() => window.__ws.quality.level === 4, null, { timeout: 60000, polling: 250 }).then(() => true, () => false);
      const bottom = await page.evaluate(() => ({ q: window.__ws.quality, phase: window.__ws.game.phase }));
      check('比賽結束後（結算畫面）才關影子：最低一階（0.75、影子關）', reachedBottom && bottom.phase === 'ended' && bottom.q.renderer.pixelRatio === 0.75 && !bottom.q.renderer.shadows, `${bottom.phase}：${JSON.stringify(bottom.q.renderer)}`);
      const programsLow = bottom.q.renderer.programs;
      const tFast = await page.evaluate(() => performance.now());
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const recovered = await page.waitForFunction(() => window.__ws.quality.level === 0, null, { timeout: 120000, polling: 250 }).then(() => true, () => false);
      await sleep(8000); // 升回最高之後再看 8 秒：不會又掉下去
      const top = await page.evaluate(() => window.__ws.quality);
      const fr = await frames(page, tSlow);
      const steps = transitions(fr);
      check('恢復之後：升回最高解析度（2）而且影子打開（renderer 的實際狀態）', recovered && top.renderer.pixelRatio === 2 && top.renderer.shadows === true && top.level === 0, JSON.stringify(top.renderer));
      const ups = top.log.filter((e) => e.why === 'fast');
      check('升級一階一階來、每階之間至少 6 秒（遲滯）', ups.length === 4 && ups.slice(1).every((e, i) => e.t - ups[i].t >= 6), ups.map((e) => `${fmt(e)}@${e.t}s`).join(' → '));
      const afterTop = top.log.filter((e) => e.t > ups.at(-1).t);
      check('升回最高後 8 秒內沒有又降下去（不抖動）', afterTop.length === 0, afterTop.map((e) => fmt(e)).join(' ') || '沒有');
      const shadowOn = steps.find((x) => x.to === '0.75＋影子' && x.at_ms > tFast);
      check('影子重新打開時 shader 數量沒有增加（用之前編好的，不重編）', shadowOn && shadowOn.programs_after === shadowOn.programs_before, shadowOn ? `${shadowOn.programs_before} → ${shadowOn.programs_after}，之後 1 秒最長一格 ${shadowOn.longest_next_1s_ms} ms` : '沒看到');
      check('過程中沒有 JS 錯誤', errors.length === 0, errors.join(' | '));
      writeFileSync(
        path.join(OUT, 'B-slow-to-fast.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            renderer: 'GPU（ANGLE Metal、新版 headless），CPU 用 CDP 放慢 150 倍再恢復',
            view: '390×844（iPhone 15 模擬）',
            round: '限時 30 秒',
            throttled_at_s: 0,
            unthrottled_at_s: +((tFast - tSlow) / 1000).toFixed(1),
            programsAtBottom: programsLow,
            log: top.log,
            transitions: steps.map((x) => ({ ...x, at_s: +((x.at_ms - tSlow) / 1000).toFixed(1) })),
            timeline: fr.filter((_, i) => i % 5 === 0).map((x) => ({ t_s: +((x[0] - tSlow) / 1000).toFixed(2), frame_ms: x[1], pixelRatio: x[2], shadows: x[3], programs: x[4], level: x[5] })),
          },
          null,
          2,
        ),
      );
      await ctx.close();
      await browser.close();
      browser = null;
    }

    // ---------------- C. 軟體繪圖：過渡 vs 穩定 ----------------
    if (!ONLY || ONLY === 'C') {
      console.log('— C. 遊戲房（SwiftShader 軟體繪圖、手機 390×844、自動畫質）：降級過渡和穩定分開量');
      browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'] });
      const ctx = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
      await openGame(page, 60);
      await lookDownRange(page);
      const t0 = await page.evaluate(() => performance.now());
      // 等到 6 秒都沒有再換階（最多 40 秒），之後量 6 秒＝比賽中的穩定狀態
      const settle = async (limitMs) => {
        let lastChange = Date.now();
        let lastLevel = -1;
        const until = Date.now() + limitMs;
        while (Date.now() < until) {
          const lv = await page.evaluate(() => window.__ws.quality.level);
          if (lv !== lastLevel) {
            lastLevel = lv;
            lastChange = Date.now();
          }
          if (Date.now() - lastChange > 6000) break;
          await sleep(250);
        }
        return page.evaluate(() => performance.now());
      };
      const settled = await settle(40000);
      await sleep(6000);
      const steadyEnd = await page.evaluate(() => performance.now());
      const q1 = await page.evaluate(() => ({ q: window.__ws.quality, phase: window.__ws.game.phase }));
      // 第一回合結束 → 結算畫面（如果有等著關影子，會在這時候關）
      await page.waitForFunction(() => window.__ws.game.phase === 'ended', null, { timeout: 90000, polling: 250 });
      const tEnded = await page.evaluate(() => performance.now());
      await sleep(4000);
      const qEnded = await page.evaluate(() => window.__ws.quality);
      // 第二回合：真的按「再玩一次」，開始後量 6 秒
      await page.locator('#gameCardBtns button:has-text("再玩一次")').first().tap();
      await page.waitForFunction(() => window.__ws.game.phase === 'playing', null, { timeout: 60000, polling: 250 });
      await lookDownRange(page);
      await sleep(2500);
      const r2start = await page.evaluate(() => performance.now());
      await sleep(6000);
      const fr = await frames(page, t0);
      const q2 = await page.evaluate(() => window.__ws.quality);
      const steps = transitions(fr);
      const inRange = (a, b) => fr.filter((x) => x[0] >= a && x[0] < b);
      const res = {
        at: new Date().toISOString(),
        renderer: 'SwiftShader（CPU 軟體繪圖，headless shell、不限影格，跟 perf-scene 一樣）',
        view: '390×844（iPhone 15 模擬）',
        round1: {
          transition: { from_s: 0, to_s: +((settled - t0) / 1000).toFixed(1), ...stat(inRange(t0, settled)) },
          steady_in_play: { from_s: +((settled - t0) / 1000).toFixed(1), seconds: 6, ...stat(inRange(settled, steadyEnd)), phase: q1.phase, pixelRatio: q1.q.renderer.pixelRatio, shadows: q1.q.renderer.shadows, programs: q1.q.renderer.programs, pending: q1.q.pending },
        },
        results_screen: { from_s: +((tEnded - t0) / 1000).toFixed(1), ...stat(inRange(tEnded, tEnded + 4000)), pixelRatio: qEnded.renderer.pixelRatio, shadows: qEnded.renderer.shadows, programs: qEnded.renderer.programs },
        round2_steady: { from_s: +((r2start - t0) / 1000).toFixed(1), seconds: 6, ...stat(inRange(r2start, r2start + 6000)), pixelRatio: q2.renderer.pixelRatio, shadows: q2.renderer.shadows, programs: q2.renderer.programs },
        steps: steps.map((x) => ({ ...x, at_s: +((x.at_ms - t0) / 1000).toFixed(1) })),
        long_frames_over_300ms: fr.filter((x) => x[1] > 300).map((x) => ({ at_s: +((x[0] - t0) / 1000).toFixed(1), frame_ms: x[1], programs: x[4], level: x[5] })),
        log: q2.log,
      };
      writeFileSync(path.join(OUT, 'C-swiftshader-transition-vs-steady.json'), JSON.stringify(res, null, 2));
      console.log('   第一回合 過渡  ', JSON.stringify(res.round1.transition));
      console.log('   第一回合 穩定  ', JSON.stringify(res.round1.steady_in_play));
      console.log('   結算畫面       ', JSON.stringify(res.results_screen));
      console.log('   第二回合 穩定  ', JSON.stringify(res.round2_steady));
      for (const x of res.steps) console.log(`   換階 ${x.at_s}s → ${x.to}：shader ${x.programs_before}→${x.programs_after}，之後 1 秒最長一格 ${x.longest_next_1s_ms} ms`);
      console.log('   超過 0.3 秒的格', JSON.stringify(res.long_frames_over_300ms));
      const playSteps = res.steps.filter((x) => x.in_play);
      const restSteps = res.steps.filter((x) => !x.in_play);
      check('軟體繪圖、比賽中：換階都只換解析度、沒有編譯 shader（數量不變），比賽中的穩定期沒有超過 0.5 秒的停頓', playSteps.length > 0 && playSteps.every((x) => x.programs_after === x.programs_before) && res.round1.steady_in_play.max_ms < 500, `比賽中換階 ${playSteps.map((x) => `${x.to}@${x.at_s}s`).join(' → ')}；穩定期最長一格 ${res.round1.steady_in_play.max_ms} ms`);
      check('關影子（要編譯 shader 的那一步）在比賽外做（結算畫面）', restSteps.some((x) => x.to === '0.75' && x.programs_after > x.programs_before) && q2.renderer.shadows === false, restSteps.map((x) => `${x.to}@${x.at_s}s：shader ${x.programs_before}→${x.programs_after}、之後最長一格 ${x.longest_next_1s_ms} ms`).join('；') || '沒有');
      check('第二回合：穩定、沒有編譯（shader 數量不變）、沒有超過 0.5 秒的停頓', res.round2_steady.max_ms < 500 && q2.renderer.programs === qEnded.renderer.programs, `${fmt({ pr: q2.renderer.pixelRatio, shadows: q2.renderer.shadows })}：${res.round2_steady.fps} fps、p50 ${res.round2_steady.p50_ms} ms、最長 ${res.round2_steady.max_ms} ms`);
      check('過程中沒有 JS 錯誤', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通過`);
process.exit(failed ? 1 : 0);
