// 冒險模式「小紅的信號塔」完整通關測試：手機（390×844 觸控）和電腦（1280×800 滑鼠）各從首頁一路玩到結算、再玩一次。
// 全程用真的輸入（觸控／滑鼠拖曳、點按鈕、推搖桿）；只「讀」狀態來找東西在畫面哪裡，不呼叫跳關或改存檔。
// 也驗：兩種以上的救援、重新整理後接著玩、再玩一次的範圍、自由工坊的場景／工具箱／世界模組完全沒被動到、沒有任何 AI 打造工作。
// 會寫冒險存檔，只能對測試用資料夾跑（伺服器只聽本機）：
//   rm -rf /tmp/vw-adv-data
//   DATA_DIR=/tmp/vw-adv-data PORT=5312 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &   （Codex 故意設成不存在）
//   npm run test:adventure            截圖輸出到 tests/out/adv-*.png；ONLY=mobile 或 ONLY=desktop 只跑一種
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const BASE = process.env.BASE || 'http://127.0.0.1:5312';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會寫冒險存檔，請對測試用資料夾（預設 :5312）跑。');
  process.exit(2);
}
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-adv-data';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });
const ONLY = process.env.ONLY || '';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (v) => Number(v).toFixed(2);
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const digest = (f) => (existsSync(f) ? crypto.createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16) : 'missing');
const WATCH = ['scene.json', 'library.json', 'worlds.json', 'world-state.json'];
const integrity = () => Object.fromEntries(WATCH.map((f) => [f, digest(path.join(DATA_DIR, f))]));
const jobDirs = () => (existsSync(path.join(ROOT, 'jobs')) ? readdirSync(path.join(ROOT, 'jobs')).sort() : []);
const api = async (url) => (await fetch(BASE + url)).json();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });

// ---- 先在自由工坊放好「原本的作品」，記下指紋 ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
  await page.goto(`${BASE}/?ws`);
  await page.waitForFunction(() => window.__ws?.loaded === true && window.__ws.physics.ready, null, { timeout: 30000 });
  await sleep(2500);
  await ctx.close();
  await sleep(800);
}
const before = integrity();
const stateBefore = await api('/api/state');
const sceneBefore = JSON.stringify(stateBefore.scene.instances);
const libBefore = stateBefore.library.parts.map((p) => p.id).join(',');
const jobsBefore = jobDirs();
console.log('自由工坊指紋', JSON.stringify(before), `物件 ${stateBefore.scene.instances.length}、零件 ${stateBefore.library.parts.length}`);

// ---------------- 一次完整通關 ----------------

async function playthrough(kind) {
  const mobile = kind === 'mobile';
  const tag = mobile ? 'm' : 'd';
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  const requests = [];
  page.on('request', (r) => r.method() !== 'GET' && requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  const cdp = mobile ? await ctx.newCDPSession(page) : null;
  const shot = (name) => page.screenshot({ path: path.join(OUT, `adv-${tag}-${name}.png`) });
  const st = () => page.evaluate(() => window.__ws?.adventure);
  const waitFor = async (fn, arg, timeout = 20000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 100 });
      return true;
    } catch {
      return false;
    }
  };
  const screenAt = (p) => page.evaluate((p) => window.__ws.screenAt(p[0], p[1], p[2]), p);
  const screenOf = (id) => page.evaluate((id) => window.__ws.screenOf(id), id);
  const centerOf = (id) => page.evaluate((id) => window.__ws.worldBox(window.__ws.instances.get(id)).getCenter(new window.__ws.THREE.Vector3()).toArray(), id);
  // 輸入：手機用觸控（CDP），電腦用滑鼠
  const press = async (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] }) : (await page.mouse.move(p.x, p.y), page.mouse.down()));
  const move = (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] }) : page.mouse.move(p.x, p.y));
  const lift = () => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : page.mouse.up());
  const tap = async (sel) => {
    await page.locator(sel).first().waitFor({ state: 'visible', timeout: 15000 });
    if (mobile) await page.locator(sel).first().tap();
    else await page.locator(sel).first().click();
  };
  const tapText = async (text) => tap(`#advCardBtns button:has-text("${text}")`);
  // 觸控目標至少 44×44 CSS px
  const targetSizes = async (sels) => {
    const bad = [];
    for (const sel of sels) {
      for (const el of await page.locator(sel).all()) {
        if (!(await el.isVisible())) continue;
        const b = await el.boundingBox();
        if (b && (b.width < 44 || b.height < 44)) bad.push(`${sel} ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    return bad;
  };

  // 像人一樣拖：按住東西 → 看著它往目標移動、一路修正 → 停住 → 放手。
  // 東西浮在手指下方的高度平面上，所以不能直接拖到地上目標的螢幕位置，要看東西實際在哪裡再調
  async function dragTo(id, target, { tol = 0.25, stop = null, maxSteps = 60 } = {}) {
    let finger = null;
    let grabbed = false;
    for (const nudge of [0, 12, -12]) {
      const p = await screenOf(id);
      finger = { x: p.x, y: p.y + nudge };
      await press(finger);
      finger = { x: finger.x + 6, y: finger.y - 6 };
      await move(finger);
      await sleep(150);
      if ((await st()).held === id) {
        grabbed = true;
        break;
      }
      await lift(); // 沒抓到（點到旁邊）：換個位置再按一次
      await sleep(300);
    }
    if (!grabbed) return false;
    for (let i = 0; i < maxSteps; i += 1) {
      const c = await centerOf(id);
      const dx = target[0] - c[0];
      const dz = target[2] - c[2];
      if (Math.hypot(dx, dz) < tol || (stop && (await stop(c)))) break;
      const k = Math.min(1, 1.2 / Math.max(Math.hypot(dx, dz), 1e-6)); // 一步最多 1.2 公尺
      const a = await screenAt(c);
      const b = await screenAt([c[0] + dx * k, c[1], c[2] + dz * k]);
      finger = { x: finger.x + (b.x - a.x) * 0.85, y: finger.y + (b.y - a.y) * 0.85 };
      await move(finger);
      await sleep(110);
    }
    await sleep(450); // 停住再放手（不然會順著手勢丟出去）
    await lift();
    await sleep(400);
    return true;
  }
  // 甩出去：抓起來快速一甩就放手
  async function fling(id, dx, dy) {
    const p = await screenOf(id);
    await press(p);
    for (let i = 1; i <= 6; i += 1) {
      await move({ x: p.x + (dx * i) / 6, y: p.y + (dy * i) / 6 });
      await sleep(16);
    }
    await lift();
  }

  const t0 = Date.now();
  // ---- 首頁 ----
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#title:not([hidden])', { timeout: 15000 });
  await waitFor(() => !!window.__ws?.camera, null, 15000);
  await sleep(1200);
  await shot('01-title');
  const titleText = await page.textContent('#titlePlay');
  check(`[${kind}] 首頁有大大的開始／繼續按鈕（遊戲房、新手教學）與自由工坊`, (await page.isVisible('#titleGames')) && (await page.isVisible('#titlePlay')) && (await page.isVisible('#titleFree')), titleText.trim());
  const titleBad = await targetSizes(['#titleGames', '#titlePlay', '#titleFree', '#titleRestart']);
  check(`[${kind}] 首頁按鈕夠大（≥44px）`, titleBad.length === 0, titleBad.join('；'));

  // ---- 開始：有舊進度就用首頁的「從第 1 關重新開始」（這顆按鈕也一起測） ----
  if (await page.isVisible('#titleRestart')) await tap('#titleRestart');
  else await tap('#titlePlay');
  await waitFor(() => window.__ws?.adventure?.level >= 1, null, 30000);
  await sleep(800);
  let s = await st();
  if (s.card === 'intro') {
    await shot('02-intro');
    check(`[${kind}] 開場：小紅說明三個任務，一個「出發」按鈕`, (await page.textContent('#advCardTitle')).includes('小紅'));
    await tapText('出發');
  }
  await waitFor(() => window.__ws.adventure.step === 'play' && !window.__ws.adventure.card);
  s = await st();
  check(`[${kind}] 進入第 1 關`, s.level === 1 && s.step === 'play', `${s.level}/${s.step}`);
  await sleep(1300); // 鏡頭就位
  await shot('03-level1');
  const hudBad = await targetSizes(['#advMenu', '#advRescue:not([hidden])']);
  check(`[${kind}] 冒險畫面的按鈕夠大（≥44px）`, hudBad.length === 0, hudBad.join('；'));
  const goal1 = await page.textContent('#advText');
  check(`[${kind}] 畫面只講現在要做的事`, /拖到發光的充電座/.test(goal1), goal1);

  // ---- 第 1 關：救援①（亂丟方塊 → 歸位），然後搬到充電座 ----
  const L = s.layout;
  const cubeId = s.ids.cube;
  if (mobile) {
    await fling(cubeId, -160, 140);
    await sleep(1800);
    const flung = await centerOf(cubeId);
    s = await st();
    const firstGrabMs = await page.evaluate(() => window.__advFirstGrab);
    check(`[${kind}] 第一次有效互動（抓起方塊）在 60 秒內`, Date.now() - t0 < 60000 && firstGrabMs > 0, `${((Date.now() - t0) / 1000).toFixed(1)} 秒內（含載入）`);
    check(`[${kind}] 救援①前：方塊被甩離起點`, flat(flung, L.L1.cube) > 0.6, `離起點 ${f2(flat(flung, L.L1.cube))} m`);
    await tap('#advRescue');
    await sleep(900);
    const back = await centerOf(cubeId);
    s = await st();
    check(`[${kind}] 救援①：按「🔄 方塊歸位」→ 方塊回到起點（不是充電座）`, flat(back, L.L1.cube) < 0.3 && flat(back, L.L1.pad) > 1 && s.rescues === 1 && s.step === 'play', `離起點 ${f2(flat(back, L.L1.cube))} m，救援 ${s.rescues} 次`);
  }
  await dragTo(cubeId, L.L1.pad, { tol: 0.35 });
  const cleared1 = await waitFor(() => window.__ws.adventure.step === 'clear', null, 15000);
  s = await st();
  check(`[${kind}] 把能量方塊拖到充電座 → 吸附、能量塔點亮、第 1 關完成`, cleared1 && s.level === 1, `${s.level}/${s.step}`);
  await sleep(500);
  await shot('04-level1-clear');
  await waitFor(() => window.__ws.adventure.card === 'clear', null, 8000);
  await shot('05-clear-card');
  await tapText('下一關');

  // ---- 第 2 關：把 4 個輪子＋操縱桿拖到木板旁邊 ----
  await waitFor(() => window.__ws.adventure.level === 2 && window.__ws.adventure.step === 'play' && !window.__ws.adventure.card);
  await sleep(1500);
  await shot('06-level2');
  s = await st();
  check(`[${kind}] 第 2 關：木板在組裝台上，旁邊有 4 個輪子和 1 個操縱桿`, s.loose.length === 5 && s.sockets.length === 5 && s.attached.length === 0, `散件 ${s.loose.length}`);
  async function attachOne() {
    s = await st();
    const part = s.loose[0]; // 依序一個一個拿
    const free = s.sockets.filter((k) => k.free && k.kind === part.kind);
    const sock = free.reduce((a, b) => (flat(a.pos, part.center) <= flat(b.pos, part.center) ? a : b));
    const n = s.attached.length;
    await dragTo(part.id, sock.pos, { tol: 0.4, stop: async (c) => flat(c, s.board.center) < 1.1 });
    const ok = await waitFor((n) => window.__ws.adventure.attached.length > n && !window.__ws.adventure.anim, n, 6000);
    return { ok, part };
  }
  for (let i = 0; i < 2; i += 1) {
    const r = await attachOne();
    s = await st();
    check(`[${kind}] 拖${r.part.kind === 'steer' ? '操縱桿' : '輪子'}到木板旁邊 → 自動吸附、黏上（${s.attached.length}/5）`, r.ok && s.board.members === s.attached.length + 1, `車身 ${s.board.members} 件`);
  }
  if (mobile) {
    // 救援②：把一個零件甩到遠處 → 零件歸位
    s = await st();
    const victim = s.loose[0];
    const vp = await screenOf(victim.id);
    await fling(victim.id, (vp.x < 195 ? -1 : 1) * 170, 50); // 往外側甩（遠離車身）
    await sleep(1800);
    const away = await centerOf(victim.id);
    await tap('#advRescue');
    await sleep(900);
    s = await st();
    const home = s.loose.find((p) => p.id === victim.id);
    const slot = Object.keys(s.ids).find((k) => s.ids[k] === victim.id);
    check(`[${kind}] 救援②：零件被甩走 → 按「🔄 零件歸位」→ 回到原位，已裝的不受影響`, home && flat(home.center, L.L2.tray[slot]) < 0.6 && s.attached.length === 2 && s.rescues === 2, `甩到離原位 ${f2(flat(away, L.L2.tray[slot]))} m → 歸位後 ${f2(flat(home.center, L.L2.tray[slot]))} m；已裝 ${s.attached.length}`);
    // 重新整理：組到一半也接得下去
    await page.reload();
    await waitFor(() => window.__ws?.adventure?.level === 2, null, 30000);
    await sleep(1500);
    s = await st();
    check(`[${kind}] 重新整理 → 還在第 2 關、已裝的 2 個還黏在車上`, s.level === 2 && s.step === 'play' && s.attached.length === 2 && s.board.members === 3 && s.loose.length === 3, `${s.level}/${s.step}，已裝 ${s.attached.length}、車身 ${s.board.members} 件`);
  }
  while ((await st()).attached.length < 5) {
    const before = (await st()).attached.length;
    const r = await attachOne();
    if (!r.ok && (await st()).attached.length === before) {
      check(`[${kind}] 組裝卡住`, false, JSON.stringify((await st()).loose));
      break;
    }
  }
  const built = await waitFor(() => window.__ws.adventure.step === 'built', null, 8000);
  s = await st();
  check(`[${kind}] 五個零件都裝好 → 變成一台車（同一個剛體、4 個馬達輪）`, built && s.board.members === 6, `車身 ${s.board.members} 件`);
  await sleep(1200);
  await shot('07-built');
  const mainLabel = await page.textContent('#advMain');
  check(`[${kind}] 出現大大的「⚡ 啟動引擎」`, mainLabel.includes('啟動引擎') && (await targetSizes(['#advMain'])).length === 0, mainLabel);
  const startZ = s.board.center[2];
  await tap('#advMain');
  const tested = await waitFor(() => window.__ws.adventure.step === 'clear', null, 25000);
  s = await st();
  check(`[${kind}] 按 ⚡ → 馬達真的把車開過起跑線（第 2 關完成）`, tested && s.board.center[2] < L.L2.lineZ, `開了 ${f2(startZ - s.board.center[2])} m`);
  await sleep(1800);
  s = await st();
  check(`[${kind}] 開過線之後自動關馬達、煞車`, !s.board.power, `power=${s.board.power}`);
  await waitFor(() => window.__ws.adventure.card === 'clear', null, 8000);
  await shot('08-level2-clear');
  await tapText('下一關');

  // ---- 第 3 關：開到信號塔 ----
  await waitFor(() => window.__ws.adventure.level === 3 && !window.__ws.adventure.card);
  await sleep(1400);
  await shot('09-level3');
  check(`[${kind}] 第 3 關：大大的「▶ 開車出發」`, (await page.textContent('#advMain')).includes('開車'));
  await tap('#advMain');
  await waitFor(() => window.__ws.adventure.engine === 'pilot', null, 8000);
  await sleep(500);
  const ctlBad = await targetSizes(['#joy', '#btnAction', '#ctlExit', '#advRescue:not([hidden])']);
  check(`[${kind}] 開車畫面：搖桿、⚡、離開、救援都夠大`, ctlBad.length === 0, ctlBad.join('；'));
  const joyBox = await page.locator('#joy').boundingBox();
  const joy = { x: joyBox.x + joyBox.width / 2, y: joyBox.y + joyBox.height / 2, r: joyBox.width / 2 };
  let holding = false;
  // 開車機器人：只看車子在哪、朝哪、下一個目標在哪，推搖桿（和人看著畫面開車一樣）
  async function drive({ until, timeout = 90000, label }) {
    const tEnd = Date.now() + timeout;
    let shots = 0;
    let iter = 0;
    while (Date.now() < tEnd) {
      iter += 1;
      s = await st();
      if (await until(s)) break;
      if (s.engine !== 'pilot') {
        if (holding) {
          await lift();
          holding = false;
        }
        if (s.step !== 'play') break;
        await tap('#advMain');
        await sleep(400);
        continue;
      }
      const c = s.board.center;
      const f = s.board.forward;
      const tg = s.nextTarget;
      const want = Math.atan2(tg[0] - c[0], tg[2] - c[2]);
      const head = Math.atan2(f[0], f[2]);
      const err = Math.atan2(Math.sin(want - head), Math.cos(want - head));
      const x = Math.max(-1, Math.min(1, -err * 1.6));
      const y = Math.abs(err) > 1.1 ? 0.35 : 0.85;
      const p = { x: joy.x + x * joy.r * 0.85, y: joy.y - y * joy.r * 0.85 };
      if (!holding) {
        await press({ x: joy.x, y: joy.y });
        holding = true;
      }
      await move(p);
      if (label && shots === 0 && iter >= 12) {
        shots += 1;
        await shot(label);
      }
      await sleep(90);
    }
    if (holding) {
      await move({ x: joy.x, y: joy.y });
      await lift();
      holding = false;
    }
  }
  await drive({ until: (s) => s.cps >= 1, label: '10-driving' });
  s = await st();
  check(`[${kind}] 用搖桿開車穿過能量環 1`, s.cps >= 1, `cps=${s.cps}`);
  if (mobile) {
    // 救援③：翻車（測試直接把車翻過來，模擬撞翻）→ 按「🔄 翻正」
    await page.evaluate(() => {
      const w = window.__ws;
      const a = w.adventure;
      const board = w.instances.get(a.ids.board);
      const members = w.glueMembers(board);
      const T = w.THREE;
      const c = new T.Vector3(...a.board.center);
      const flip = new T.Matrix4().makeTranslation(c.x, 1.2, c.z).multiply(new T.Matrix4().makeRotationZ(Math.PI)).multiply(new T.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      for (const m of members) {
        m.object.updateMatrixWorld(true);
        const mw = flip.clone().multiply(m.object.matrixWorld);
        const s = new T.Vector3();
        mw.decompose(m.object.position, m.object.quaternion, s);
      }
    });
    const flipped = await waitFor(() => window.__ws.adventure.trouble === 'flip', null, 10000);
    await sleep(300);
    const rescueLabel = await page.textContent('#advRescue');
    await shot('11-flipped');
    check(`[${kind}] 翻車 → 偵測到、救援鍵變「🔄 翻正」並閃動`, flipped && rescueLabel.includes('翻正'), rescueLabel);
    await tap('#advRescue');
    await sleep(1500);
    s = await st();
    check(`[${kind}] 救援③：按「🔄 翻正」→ 車子正過來，進度保留`, s.board.up > 0.85 && s.cps >= 1 && s.step === 'play', `up=${f2(s.board.up)}，cps=${s.cps}，救援 ${s.rescues} 次`);
    // 重新整理：開到一半也接得下去
    await page.reload();
    await waitFor(() => window.__ws?.adventure?.level === 3, null, 30000);
    await sleep(1500);
    s = await st();
    check(`[${kind}] 重新整理 → 還在第 3 關、能量環 1 還算數、按鈕變「▶ 繼續開車」`, s.level === 3 && s.cps >= 1 && (await page.textContent('#advMain')).includes('繼續開車'), `cps=${s.cps}`);
    // 救援④：回到檢查點
    await tap('#advMain');
    await waitFor(() => window.__ws.adventure.engine === 'pilot', null, 8000);
    await tap('#advRescue');
    await sleep(1200);
    s = await st();
    check(`[${kind}] 救援④：按「🔄 回到檢查點」→ 車子回到能量環 1、面向下一個目標`, flat(s.board.center, L.L3.cps[0]) < 1.2, `離能量環 1 ${f2(flat(s.board.center, L.L3.cps[0]))} m`);
  }
  await drive({ until: (s) => s.cps >= 2 });
  s = await st();
  check(`[${kind}] 穿過能量環 2`, s.cps >= 2, `cps=${s.cps}`);
  await drive({ until: (s) => s.step === 'clear' || s.level === 4, label: '12-final-stretch' });
  const arrived = await waitFor(() => window.__ws.adventure.step === 'clear' || window.__ws.adventure.level === 4, null, 5000);
  s = await st();
  check(`[${kind}] 開到信號塔 → 第 3 關完成`, arrived, `${s.level}/${s.step}`);
  await sleep(800);
  await shot('13-arrived');

  // ---- 結算 ----
  const done = await waitFor(() => window.__ws.adventure.card === 'done', null, 10000);
  await sleep(400);
  await shot('14-results');
  const resultText = await page.textContent('#advCard');
  s = await st();
  check(`[${kind}] 結算：總時間、各關時間、救援次數、星星、再玩一次／去自由工坊`, done && /總時間/.test(resultText) && /★/.test(resultText) && /再玩一次/.test(resultText) && /自由工坊/.test(resultText), resultText.replace(/\s+/g, ' ').slice(0, 140));
  const cardBad = await targetSizes(['#advCardBtns button']);
  check(`[${kind}] 結算按鈕夠大`, cardBad.length === 0, cardBad.join('；'));
  const advSaved = await api('/api/adventure');
  check(`[${kind}] 冒險存檔：已通關、記下成績`, advSaved.adventure?.progress?.level === 4 && advSaved.adventure.progress.clears >= 1 && advSaved.adventure.progress.last?.total > 0, JSON.stringify(advSaved.adventure?.progress?.last));

  // ---- 冒險模式不能改到自由工坊（就算有人呼叫工坊的功能也一樣） ----
  const guard = await page.evaluate(async () => {
    const w = window.__ws;
    const n0 = w.library.length;
    await w.submitPrompt('給我一台飛天車');
    w.selectOnly(w.adventure.ids.cube);
    await w.groupSelected('不該存在的零件');
    w.clearSelection();
    await new Promise((r) => setTimeout(r, 600));
    return { n0, n1: w.library.length, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-3) };
  });
  check(`[${kind}] 冒險模式擋住打造（AI）與存成零件`, guard.n0 === guard.n1 && guard.toasts.some((t) => t.includes('冒險模式不會改動自由工坊')), JSON.stringify(guard.toasts));

  // ---- 再玩一次 ----
  const clearsBefore = (await api('/api/adventure')).adventure.progress.clears;
  await tapText('再玩一次');
  await waitFor(() => window.__ws.adventure.level === 1 && window.__ws.adventure.step === 'play' && !window.__ws.adventure.card, null, 10000);
  await sleep(1500);
  s = await st();
  const cube2 = await centerOf(s.ids.cube);
  const saved2 = await api('/api/adventure');
  check(
    `[${kind}] 再玩一次 → 回到第 1 關：方塊在起點、時間歸零、場上只剩第 1 關的東西；通關紀錄保留`,
    s.level === 1 && flat(cube2, L.L1.cube) < 0.3 && s.times.every((t) => t < 3) && !s.board && saved2.adventure.progress.clears === clearsBefore && saved2.adventure.instances.length === 1,
    `通關 ${saved2.adventure.progress.clears} 次，冒險物件 ${saved2.adventure.instances.length} 個`,
  );
  await shot('15-replay');
  // 暫停選單 → 回首頁：顯示「繼續冒險」
  await tap('#advMenu');
  await waitFor(() => window.__ws.adventure.card === 'menu', null, 5000);
  await shot('16-menu');
  await tapText('回首頁');
  await page.waitForSelector('#title:not([hidden])', { timeout: 15000 });
  await waitFor(() => /繼續新手教學|再玩一次/.test(document.querySelector('#titlePlay').textContent), null, 10000);
  const again = await page.textContent('#titlePlay');
  check(`[${kind}] 回首頁 → 按鈕變成「繼續新手教學」`, again.includes('繼續新手教學'), again.trim());
  const posts = requests.filter((r) => !r.startsWith('PUT /api/adventure'));
  check(`[${kind}] 整個冒險只寫冒險存檔（PUT /api/adventure），沒有其他寫入`, posts.length === 0, posts.slice(0, 5).join('、') || `PUT /api/adventure × ${requests.length}`);
  check(`[${kind}] 沒有 JS 錯誤`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

if (ONLY !== 'desktop') await playthrough('mobile');
if (ONLY !== 'mobile') {
  // 電腦版從頭玩：用首頁的「從第 1 關重新開始」
  await playthrough('desktop');
}

// ---- 自由工坊完全沒被動到 ----
await sleep(800);
const after = integrity();
const changed = WATCH.filter((f) => before[f] !== after[f]);
check('自由工坊的 scene.json、library.json、worlds.json、world-state.json 一個位元都沒變', changed.length === 0, changed.length ? `變了：${changed.join('、')}` : JSON.stringify(after));
const stateAfter = await api('/api/state');
check('伺服器上的工坊場景與工具箱跟開始前一樣', JSON.stringify(stateAfter.scene.instances) === sceneBefore && stateAfter.library.parts.map((p) => p.id).join(',') === libBefore, `物件 ${stateAfter.scene.instances.length}、零件 ${stateAfter.library.parts.length}`);
const newJobs = jobDirs().filter((j) => !jobsBefore.includes(j));
check('0 個 AI 打造工作（jobs/ 沒有新資料夾；測試伺服器的 Codex 本來就不存在）', newJobs.length === 0, newJobs.join('、'));
// 回到自由工坊：原本的作品都在
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
  await page.goto(`${BASE}/?ws`);
  await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
  const n = await page.evaluate(() => window.__ws.instances.size);
  await page.screenshot({ path: path.join(OUT, 'adv-w-workshop-after.png') });
  check('冒險之後打開自由工坊：原本的物件一個不少', n === stateBefore.scene.instances.length, `${n} 個`);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
