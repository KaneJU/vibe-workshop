// 創作世界：作品沙盒看門狗遇到「父頁主執行緒被長任務卡住」（例如進眼鏡時編譯著色器）的時序測試。
// runner iframe 可能和父頁共用主執行緒（Safari 一定是）：卡住的期間作品準時送來的回覆進不來，
// 會排在父頁卡住之前送進來的訊息後面。看門狗要分得出「作品真的沒回」和「回覆還在排隊」。
//   1. 父頁送出一步／一個事件 → 下一幀照常送一則 → 主執行緒卡 600、900 ms：作品 80 ms 就回覆，不算逾時、狀態有前進
//   2. 連續兩個長任務（200 ms＋600 ms），作品 250 ms 才回覆（時限內）：不算逾時
//   3. 真的卡住（無限迴圈）：父頁卡住之後照樣停掉（timeout、onError fatal）
//   4. 父頁不卡：一步 250 ms 不停、一步 400 ms（超過 300 ms）照樣停
// 每個情境最後都照真實畫面每幀送一步（rAF）；runner 是隱藏的 iframe，裡面的計時器可能晚 100 ms 才叫。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾、Codex 不存在），不碰正式 5310。
//   node tests/sandbox-stall.mjs                Chromium＋WebKit
//   BROWSER=webkit node tests/sandbox-stall.mjs 只跑一個
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const pw = await import(PW);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'out', 'sandbox-stall');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = { at: new Date().toISOString(), checks: results, runs: {} };
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const SW = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
const PORT = 5363;
const BROWSERS = process.env.BROWSER ? [process.env.BROWSER] : ['chromium', 'webkit'];

// ---------------- 測試用作品（忙迴圈＝作品自己算得久，但在時限內） ----------------
const busy = (ms) => `const t0 = Date.now(); while (Date.now() - t0 < ${ms}) {}`;
const box = (color) => `[{ id: 'b', shape: 'box', pos: [0, 0.5, 0], size: [0.5, 0.5, 0.5], color: '${color}' }]`;
const SLOW_EVENT = `vibe.define({ init() { return { n: 0, e: 0 }; }, tick(s) { s.n += 1; }, view() { return ${box('#33ccff')}; }, onEvent(s) { ${busy(80)} s.e += 1; } });`;
const tickTaking = (ms) => `vibe.define({ init() { return { n: 0 }; }, tick(s) { if (s.n >= 2) { ${busy(ms)} } s.n += 1; }, view() { return ${box('#ff9933')}; } });`;
const SPIN = `vibe.define({ init() { return { n: 0 }; }, tick(s) { s.n += 1; if (s.n >= 3) { for (;;) {} } }, view() { return ${box('#ff3333')}; } });`;

// ---------------- 伺服器 ----------------
const data = mkdtempSync(path.join(os.tmpdir(), 'vw-sandbox-stall-'));
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: data, CODEX_BIN: '/nonexistent/codex' },
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 80 && !up; i += 1) {
  up = await fetch(`${base}/api/state`).then((r) => r.ok, () => false);
  if (!up) await sleep(200);
}

// 一個情境：載入作品、熱身兩步，接著照 plan 送訊息、讓父頁主執行緒卡住，最後看作品還在不在
// plan.first：'event' 或 'tick'（卡住前送出、作品要算一陣子的那個請求）；plan.stalls：依序卡住幾毫秒（中間讓出一次事件迴圈）
async function scenario(page, name, code, plan) {
  return page.evaluate(async ({ name, code, plan }) => {
    const T = window.__T;
    const host = T.host;
    const pkg = `${name}@1`;
    await host.load(pkg, code, {});
    await host.spawn(name, pkg, {});
    for (let i = 0; i < 2; i += 1) await host.tick(1 / 30, {});
    const timeouts0 = host.stats().timeouts;
    const errStart = T.errors.length;
    const stall = (ms) => {
      const t = performance.now();
      while (performance.now() - t < ms) { /* 父頁的長任務 */ }
    };
    const tPost = performance.now();
    const pending = plan.first === 'event' ? host.event(name, { type: 'poke' }) : host.tick(1 / 30, {});
    await new Promise((r) => setTimeout(r, 20)); // runner 已經把請求交給 Worker，作品正在算
    let tEnd = 0;
    for (let i = 0; i < plan.stalls.length; i += 1) {
      if (i) await new Promise((r) => setTimeout(r, 0));
      host.tick(1 / 30, {}); // 下一幀照常送一則（在途的版本這一步跳過，但訊息照送）
      stall(plan.stalls[i]);
      tEnd = performance.now();
    }
    // 之後照真實畫面每幀送一步（runner 隱藏 iframe 裡的計時器可能晚 100 ms 才叫，平常靠父頁每幀的訊息順便檢查逾時）
    await new Promise((resolve) => {
      const t0 = performance.now();
      const frame = () => {
        host.tick(1 / 60, {});
        if (performance.now() - t0 < (plan.settleMs || 600)) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
    const res = await Promise.race([pending.then((x) => x ?? 'ok'), new Promise((r) => setTimeout(() => r('等超過 3 秒'), 3000))]);
    await host.tick(1 / 60, {});
    const me = host.instances().find((i) => i.id === name);
    const err = T.errors.slice(errStart).find((e) => e.id === name) || null;
    const state = me?.status === 'running' ? (await host.snapshot(name)).state : null;
    const out = {
      timeoutsAdded: host.stats().timeouts - timeouts0,
      status: me?.status || '',
      error: me?.error || '',
      onError: err && { kind: err.kind, fatal: err.fatal, message: err.message },
      killedAfterPostMs: err ? Math.round(err.at - tPost) : null,
      killedAfterStallMs: err && tEnd ? Math.round(err.at - tEnd) : null,
      reply: typeof res === 'object' ? { ok: res.ok, error: res.error || '' } : res,
      state,
    };
    host.kill(name);
    host.unload(pkg);
    return out;
  }, { name, code, plan });
}

try {
  check('測試伺服器起來（127.0.0.1、暫存資料夾）', up, base);
  for (const which of BROWSERS) {
    const browser = await pw[which].launch(which === 'chromium' ? { args: SW } : {});
    try {
      const page = await (await browser.newContext({ viewport: { width: 800, height: 500 } })).newPage();
      page.setDefaultTimeout(60000);
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.goto(`${base}/legal.html`);
      await page.evaluate(async () => {
        const THREE = await import('/vendor/three/build/three.module.js');
        const { createSandboxHost } = await import('/sandbox-host.mjs');
        const T = (window.__T = { errors: [] });
        T.host = createSandboxHost({
          THREE,
          root: new THREE.Group(),
          onError: (id, message, info) => T.errors.push({ id, message, kind: info?.kind, fatal: info?.fatal, at: performance.now() }),
        });
        await T.host.ready();
      });
      const run = {};
      for (const ms of [600, 900]) {
        run[`event${ms}`] = await scenario(page, `ev${ms}`, SLOW_EVENT, { first: 'event', stalls: [ms] });
        run[`tick${ms}`] = await scenario(page, `tk${ms}`, tickTaking(80), { first: 'tick', stalls: [ms] });
      }
      run.twice = await scenario(page, 'tw', tickTaking(250), { first: 'tick', stalls: [200, 600] });
      for (const ms of [600, 900]) run[`spin${ms}`] = await scenario(page, `sp${ms}`, SPIN, { first: 'tick', stalls: [ms] });
      run.slow250 = await scenario(page, 's250', tickTaking(250), { first: 'tick', stalls: [], settleMs: 900 });
      run.slow400 = await scenario(page, 's400', tickTaking(400), { first: 'tick', stalls: [], settleMs: 900 });
      run.pageErrors = pageErrors;
      report.runs[which] = run;
      const B = `[${which}]`;
      const kept = (r, n) => r.timeoutsAdded === 0 && r.status === 'running' && !r.onError && r.state && r.state.n >= n;
      const desc = (r) => `timeouts +${r.timeoutsAdded} ${r.status}${r.error ? `（${r.error}）` : ''} 狀態 ${JSON.stringify(r.state)}`;
      for (const ms of [600, 900]) {
        const ev = run[`event${ms}`];
        const tk = run[`tick${ms}`];
        check(`${B} 1. 父頁卡 ${ms} ms：作品 80 ms 就回的事件不算逾時、事件有生效`, kept(ev, 2) && ev.state?.e === 1 && ev.reply?.ok === true, desc(ev));
        check(`${B} 1. 父頁卡 ${ms} ms：作品 80 ms 就算完的一步不算逾時、這一步有算進去`, kept(tk, 3), desc(tk));
      }
      check(`${B} 2. 連續兩個長任務（200＋600 ms）：作品 250 ms 回覆（時限內）不算逾時`, kept(run.twice, 3), desc(run.twice));
      for (const ms of [600, 900]) {
        const sp = run[`spin${ms}`];
        check(`${B} 3. 父頁卡 ${ms} ms 時作品真的卡住（無限迴圈）：照樣停掉、onError 收到 fatal timeout`,
          sp.timeoutsAdded === 1 && sp.status === 'dead' && sp.onError?.kind === 'timeout' && sp.onError?.fatal === true && sp.killedAfterStallMs !== null && sp.killedAfterStallMs < 1000,
          `${sp.status}：${sp.error}；卡住結束後 ${sp.killedAfterStallMs} ms 停掉`);
      }
      check(`${B} 4. 父頁不卡：一步 250 ms（時限內）不停`, kept(run.slow250, 3), desc(run.slow250));
      check(`${B} 4. 父頁不卡：一步 400 ms（超過 300 ms 時限）照樣停掉`,
        run.slow400.timeoutsAdded === 1 && run.slow400.status === 'dead' && run.slow400.onError?.kind === 'timeout' && run.slow400.killedAfterPostMs >= 280 && run.slow400.killedAfterPostMs < 1000,
        `送出後 ${run.slow400.killedAfterPostMs} ms 停掉：${run.slow400.error}`);
      check(`${B} 頁面沒有未捕捉的錯誤`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    } finally {
      await browser.close();
    }
  }
} catch (err) {
  check('測試流程沒有中斷', false, err?.stack || err);
} finally {
  srv.kill();
  await sleep(200);
  rmSync(data, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  report.summary = { total: results.length, failed };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${results.length - failed}/${results.length} 通過`);
  process.exitCode = failed ? 1 : 0;
}
