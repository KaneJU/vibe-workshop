// 「做遊戲 → 找朋友一起玩」完整鏈路：兩個各自獨立的瀏覽器（手機 390×844 觸控、電腦 1280×800 滑鼠）
//   手機：首頁 → 🎮 遊戲房 → 做一個射靶遊戲（換顏色、射速、標靶數、勝利條件）→ 開房間
//   電腦：首頁 → 🎮 遊戲房 → 點正在開的房間加入
//   房主開始 → 兩邊第一人稱拿能量槍，拖曳畫面瞄準、按 ⚡ 射靶 → 計分同步 → 先到 3 分結束 → 兩邊結算一樣
//   房主「改規則再玩」→ 限時、會動的靶 → 再玩一回合 → 時間到、兩邊結算一樣
//   電腦重新整理（斷線重連，分數身分保留）→ 按離開 → 手機看到他離開
//   手機重新打開遊戲房 → 遊戲定義是改過的新規則、記得上一回合結果（保存重開）
// 全程真的輸入（觸控／滑鼠拖曳、點按鈕）；只讀狀態來找標靶在畫面哪裡、等事件發生。
// 對測試用伺服器跑（只聽本機）：
//   rm -rf /tmp/vw-room-data
//   DATA_DIR=/tmp/vw-room-data PORT=5313 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
//   BASE=http://127.0.0.1:5313 DATA_DIR=/tmp/vw-room-data npm run test:coplay      截圖：tests/out/coplay-*.png
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const BASE = process.env.BASE || 'http://127.0.0.1:5313';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：請對測試用伺服器跑（預設 :5313）。');
  process.exit(2);
}
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-room-data';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digest = (f) => (existsSync(f) ? crypto.createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16) : 'missing');
const WATCH = ['scene.json', 'library.json', 'worlds.json', 'world-state.json'];
const integrity = () => Object.fromEntries(WATCH.map((f) => [f, digest(path.join(DATA_DIR, f))]));
const jobDirs = () => (existsSync(path.join(ROOT, 'jobs')) ? readdirSync(path.join(ROOT, 'jobs')).sort() : []);
const api = async (url) => (await fetch(BASE + url)).json();

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
// 先打開一次自由工坊（讓它把自己的檔案寫好），再記指紋
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
const jobsBefore = jobDirs();

// 一個玩家（獨立的瀏覽器 context：各自的 cookie、localStorage、連線）
async function client(kind) {
  const mobile = kind === 'mobile';
  const ctx = await browser.newContext(mobile ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const c = { kind, mobile, ctx, page, errors: [], writes: [] };
  page.on('pageerror', (e) => c.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && c.errors.push(`console: ${m.text()}`));
  page.on('request', (r) => r.method() !== 'GET' && c.writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
  const cdp = mobile ? await ctx.newCDPSession(page) : null;
  c.shot = (n) => page.screenshot({ path: path.join(OUT, `coplay-${mobile ? 'm' : 'd'}-${n}.png`) });
  c.st = () => page.evaluate(() => window.__ws?.game);
  c.waitFor = async (fn, arg, timeout = 20000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 100 });
      return true;
    } catch {
      return false;
    }
  };
  c.tap = async (sel) => {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    if (mobile) await loc.tap();
    else await loc.click();
  };
  c.press = async (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] }) : (await page.mouse.move(p.x, p.y), page.mouse.down()));
  c.move = (p) => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] }) : page.mouse.move(p.x, p.y));
  c.lift = () => (mobile ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }) : page.mouse.up());
  c.size = mobile ? { w: 390, h: 844 } : { w: 1280, h: 800 };
  return c;
}

// 瞄準：拖曳畫面讓標靶移到中間的準星（拖了之後看標靶實際移到哪，再修正；就像人看著畫面瞄）
async function aimAndFire(c, { maxMs = 15000 } = {}) {
  const t0 = Date.now();
  const cx = c.size.w / 2;
  const cy = c.size.h / 2;
  let gain = c.mobile ? 0.28 : 0.2;
  while (Date.now() - t0 < maxMs) {
    const s = await c.st();
    if (s.phase !== 'playing') return false;
    const ups = s.targets.filter((t) => t.up && t.visible);
    if (!ups.length) {
      await sleep(150);
      continue;
    }
    // 離準星最近的標靶（靶心大約在離地 0.95 公尺）
    const scr = await c.page.evaluate((list) => list.map((t) => ({ id: t.id, ...window.__ws.screenAt(t.pos[0], 0.95, t.pos[2]) })), ups);
    const vis = scr.filter((p) => !p.behind);
    const pick = (vis.length ? vis : scr).reduce((a, b) => (Math.hypot(a.x - cx, a.y - cy) <= Math.hypot(b.x - cx, b.y - cy) ? a : b));
    const dx = cx - pick.x;
    const dy = cy - pick.y;
    if (Math.hypot(dx, dy) < (c.mobile ? 12 : 16) && !pick.behind) {
      const before = (await c.st()).players.find((p) => p.id === s.me.playerId)?.score ?? 0;
      await c.tap('#btnAction');
      await c.waitFor((n) => {
        const g = window.__ws.game;
        return g.phase !== 'playing' || (g.players.find((p) => p.id === g.me.playerId)?.score ?? 0) > n;
      }, before, 2500);
      // 只有分數真的變多才算命中（回合剛好結束不算）
      const after = (await c.st()).players.find((p) => p.id === s.me.playerId)?.score ?? 0;
      return after > before;
    }
    // 拖一下（從畫面下半部空白處開始拖，避開按鈕）
    const sx = cx;
    const sy = c.size.h * 0.62;
    // 往右拖＝往右看（畫面往左移）：要把右邊的靶拉到中間，就往右拖
    const mx = Math.max(-160, Math.min(160, -dx * gain));
    const my = Math.max(-120, Math.min(120, -dy * gain));
    await c.press({ x: sx, y: sy });
    for (let i = 1; i <= 4; i += 1) {
      await c.move({ x: sx + (mx * i) / 4, y: sy + (my * i) / 4 });
      await sleep(16);
    }
    await c.lift();
    await sleep(260);
    // 看實際移了多少，調整拖曳的比例
    const after = await c.page.evaluate((t) => window.__ws.screenAt(t[0], 0.95, t[2]), ups.find((t) => t.id === pick.id).pos);
    const moved = Math.hypot(after.x - pick.x, after.y - pick.y);
    const wanted = Math.hypot(mx, my) / gain;
    if (moved > 1 && wanted > 1) {
      const ratio = moved / Math.hypot(mx, my); // 拖 1 px 畫面移幾 px
      gain = Math.max(0.05, Math.min(1.5, 0.8 / ratio));
    }
  }
  return false;
}

// 一直射，直到這一回合結束
async function playRound(c, label) {
  let hits = 0;
  let shotTaken = false;
  while ((await c.st()).phase === 'playing') {
    if (await aimAndFire(c)) hits += 1;
    if (!shotTaken && hits >= 1) {
      shotTaken = true;
      await c.shot(label);
    }
  }
  return hits;
}

const A = await client('mobile');
const B = await client('desktop');

// ---- 手機：首頁 → 遊戲房 → 做遊戲 ----
await A.page.goto(`${BASE}/`);
await A.page.waitForSelector('#title:not([hidden])');
await sleep(1500);
await A.shot('01-title');
check('[手機] 首頁有「🎮 遊戲房」大按鈕', await A.page.isVisible('#titleGames'));
await A.tap('#titleGames');
await A.page.waitForSelector('#gameHub:not([hidden])');
await sleep(800);
await A.shot('02-hub');
await A.tap('#gameNew');
await A.page.waitForSelector('#gameEditor:not([hidden])');
await sleep(1500);
// 用按鈕設定：粉紅色、射速快、3 個標靶、先拿到 3 分
await A.tap('.g-seg[data-name="tool.color"] button[data-v="#ff5ca8"]');
await A.tap('.g-seg[data-name="tool.rate"] button[data-v="fast"]');
await A.tap('.g-seg[data-name="targets.count"] button[data-v="3"]');
await A.tap('.g-seg[data-name="rule.type"] button[data-v="race"]');
await A.tap('.g-seg[data-name="rule.goal"] button[data-v="3"]');
await sleep(800);
await A.shot('03-editor');
const editing = (await A.st()).editing;
check('[手機] 編輯器：顏色、射速、標靶數、勝利條件都用按鈕選（不用打字）', editing.tool.color === '#ff5ca8' && editing.tool.rate === 'fast' && editing.targets.count === 3 && editing.rule.type === 'race' && editing.rule.goal === 3, JSON.stringify(editing));
const btnSizes = await A.page.evaluate(() => [...document.querySelectorAll('#gameEditor button')].filter((b) => b.offsetParent).map((b) => Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height)));
check('[手機] 編輯器的按鈕都 ≥ 44px', btnSizes.every((v) => v >= 44), `最小 ${Math.min(...btnSizes).toFixed(0)}px`);
await A.tap('#gameTry');
await A.waitFor(() => window.__ws?.game?.phase === 'lobby' && window.__ws.game.me);
await sleep(800);
let a = await A.st();
check('[手機] 開房間：成為房主、看到房號和規則', a.hostId === a.me.playerId && /^[A-Z]{4}$/.test(a.me.code) && a.ruleText === '先拿到 3 分的贏', `${a.me.code} ${a.ruleText}`);
const code = a.me.code;
const gameId = (await api('/api/games')).games.find((g) => g.tool.color === '#ff5ca8')?.id;

// ---- 電腦：首頁 → 遊戲房 → 點房間加入（不用打房號） ----
await B.page.goto(`${BASE}/`);
await B.page.waitForSelector('#title:not([hidden])');
await B.tap('#titleGames');
await B.page.waitForSelector('#gameHub:not([hidden])');
await B.waitFor((code) => !!document.querySelector(`.g-item.join[data-code="${code}"]`), code, 10000);
await B.shot('01-hub-room-listed');
await B.tap(`.g-item.join[data-code="${code}"]`);
await B.waitFor(() => window.__ws?.game?.phase === 'lobby' && window.__ws.game.players.length === 2);
await A.waitFor(() => window.__ws.game.players.length === 2 && window.__ws.game.players.every((p) => p.connected));
await sleep(800);
a = await A.st();
let b = await B.st();
check('[兩邊] 第二個人點房間就加入：兩邊都看到 2 位玩家', a.players.length === 2 && b.players.length === 2 && b.me.code === code, a.players.map((p) => p.name).join('、'));
check('[電腦] 不是房主：看到「等房主開始」', b.hostId !== b.me.playerId && (await B.page.isVisible('#gameCardBtns button.waiting')));
await A.shot('04-lobby');
await B.shot('02-lobby');

// ---- 開始：倒數 → 比賽 ----
await A.tap('#gameCardBtns button:has-text("開始比賽")');
const bothPlaying = await Promise.all([A.waitFor(() => window.__ws.game.phase === 'playing', null, 15000), B.waitFor(() => window.__ws.game.phase === 'playing', null, 15000)]);
check('[兩邊] 房主按開始 → 兩邊一起倒數、一起開始', bothPlaying.every(Boolean));
await sleep(600);
a = await A.st();
b = await B.st();
check('[兩邊] 兩邊都拿著能量槍、看到一樣的標靶', a.holding && b.holding && JSON.stringify(a.targets.map((t) => t.id)) === JSON.stringify(b.targets.map((t) => t.id)), `${a.targets.length} 個標靶`);
await sleep(1200);
const seen = await Promise.all([A.st(), B.st()]);
check('[兩邊] 看得到對方（人偶站在對方的位置）', seen[0].others.length === 1 && seen[1].others.length === 1, JSON.stringify(seen.map((s) => s.others)));
await A.shot('05-playing');
await B.shot('03-playing');

// ---- 兩個人一起射，先到 3 分 ----
const [ha, hb] = await Promise.all([playRound(A, '06-hit'), playRound(B, '04-hit')]);
await Promise.all([A.waitFor(() => window.__ws.game.phase === 'ended'), B.waitFor(() => window.__ws.game.phase === 'ended')]);
await sleep(800);
a = await A.st();
b = await B.st();
check('[兩邊] 用拖曳瞄準＋⚡ 真的打中標靶、伺服器計分', ha + hb >= 3, `手機命中 ${ha}、電腦命中 ${hb}`);
const top = a.results?.[0];
check('[兩邊] 先拿到 3 分 → 比賽結束（目標達成）', a.reason === 'goal' && top?.score >= 3 && a.winner === top.id, JSON.stringify(a.results));
check('[兩邊] 兩邊的結算一模一樣', JSON.stringify(a.results) === JSON.stringify(b.results) && a.winner === b.winner);
await A.shot('07-results');
await B.shot('05-results');

// ---- 房主改規則再玩：限時 20 秒、會動的靶 ----
await A.tap('#gameCardBtns button:has-text("改規則")');
await A.page.waitForSelector('#gameCardTitle:has-text("改規則")');
await A.tap('#gameCard .g-seg[data-name="rule.type"] button[data-v="timed"]');
await A.tap('#gameCard .g-seg[data-name="rule.seconds"] button[data-v="30"]');
await A.tap('#gameCard .g-seg[data-name="targets.moving"] button[data-v="true"]');
await A.shot('08-rules');
await A.tap('#gameCardBtns button:has-text("套用")');
const newRule = '30 秒內分數最高的贏（會動的靶 2 分）';
await Promise.all([A.waitFor((r) => window.__ws.game.ruleText === r, newRule), B.waitFor((r) => window.__ws.game.ruleText === r, newRule)]);
a = await A.st();
b = await B.st();
check('[兩邊] 房主在介面上改規則 → 兩邊都看到新規則', a.ruleText === newRule && b.ruleText === newRule && b.phase === 'lobby', b.ruleText);
const savedRule = (await api('/api/games')).games.find((g) => g.id === gameId);
check('新規則存回遊戲定義', savedRule?.rule.type === 'timed' && savedRule.rule.seconds === 30 && savedRule.targets.moving === true);
await B.shot('06-new-rules');

// ---- 電腦重新整理（斷線重連）：身分保留、手機看到他回來 ----
const bId = b.me.playerId;
await B.page.reload();
await B.waitFor((id) => window.__ws?.game?.me?.playerId === id && window.__ws.game.phase === 'lobby', bId, 30000);
await A.waitFor((id) => window.__ws.game.players.find((p) => p.id === id)?.connected === true, bId, 10000);
b = await B.st();
check('[電腦] 重新整理 → 用同一個身分回到房間', b.me.playerId === bId && b.players.length === 2);

// ---- 第二回合：限時、會動的靶；時間到才結束 ----
await A.tap('#gameCardBtns button:has-text("開始比賽")');
await Promise.all([A.waitFor(() => window.__ws.game.phase === 'playing', null, 15000), B.waitFor(() => window.__ws.game.phase === 'playing', null, 15000)]);
const t0 = Date.now();
// 救援：手機用搖桿走遠了 → 按「↺ 回原位」回到出生點、面向標靶
const camPos = () => A.page.evaluate(() => window.__ws.camera.position.toArray());
const spawn = await camPos();
const joy = await A.page.locator('#joy').boundingBox();
await A.press({ x: joy.x + joy.width / 2, y: joy.y + joy.height / 2 });
await A.move({ x: joy.x + joy.width / 2 + 30, y: joy.y + 5 });
await sleep(1500);
await A.lift();
const wandered = await camPos();
const away = Math.hypot(wandered[0] - spawn[0], wandered[2] - spawn[2]);
await A.tap('#gameReset');
await sleep(400);
const back = await camPos();
const home = Math.hypot(back[0] - spawn[0], back[2] - spawn[2]);
check('[手機] 用搖桿走遠 → 按「↺ 回原位」回到出生點（比賽繼續）', away > 0.5 && home < 0.2, `走了 ${away.toFixed(1)} m → 回來後離出生點 ${home.toFixed(2)} m`);
const [ha2, hb2] = await Promise.all([playRound(A, '09-round2'), playRound(B, '07-round2')]);
await Promise.all([A.waitFor(() => window.__ws.game.phase === 'ended', null, 40000), B.waitFor(() => window.__ws.game.phase === 'ended', null, 40000)]);
const lasted = (Date.now() - t0) / 1000;
await sleep(800);
a = await A.st();
b = await B.st();
check('[兩邊] 新規則真的改變玩法：限時 30 秒到才結束（不是先到 3 分）', a.reason === 'time' && lasted >= 25, `玩了 ${lasted.toFixed(0)} 秒，命中 ${ha2}＋${hb2}`);
const movingHits = a.results.reduce((n, r) => n + r.hits, 0);
check(
  `[兩邊] 會動的靶一個 2 分${movingHits ? '' : '（這回合沒人打中會動的靶：2 分規則另由 test:rooms 驗證）'}`,
  a.results.every((r) => r.score === r.hits * 2),
  `${movingHits} 次命中：${JSON.stringify(a.results.map((r) => [r.name, r.score, r.hits]))}`,
);
check('[兩邊] 第二回合結算也一模一樣', JSON.stringify(a.results) === JSON.stringify(b.results) && a.winner === b.winner);
await A.shot('10-results2');
await B.shot('08-results2');

// ---- 電腦離開房間 ----
await B.tap('#gameCardBtns button:has-text("離開房間")');
await B.page.waitForSelector('#gameHub:not([hidden])', { timeout: 15000 });
await A.waitFor(() => window.__ws.game.players.length === 1, null, 10000);
a = await A.st();
check('[兩邊] 電腦按「離開房間」→ 回到遊戲房大廳；手機的房裡剩 1 人', a.players.length === 1 && a.players[0].id === a.me.playerId);

// ---- 保存重開：手機重新打開遊戲房 ----
await A.page.goto(`${BASE}/?games`);
await A.page.waitForSelector('#gameHub:not([hidden])');
await A.waitFor((id) => !!document.querySelector(`.g-item.game[data-id="${id}"]`), gameId, 10000);
const card = await A.page.textContent(`.g-item.game[data-id="${gameId}"]`);
await A.shot('11-hub-reopen');
check('[手機] 重新打開：遊戲還在、是改過的新規則、記得上一回合結果與玩過次數', card.includes('30 秒內分數最高的贏') && card.includes('上次') && card.includes('玩過 2 回合'), card.replace(/\s+/g, ' ').slice(0, 120));
await A.tap(`.g-item.game[data-id="${gameId}"] [data-act=edit]`);
await A.page.waitForSelector('#gameEditor:not([hidden])');
await sleep(800);
const reopened = (await A.st()).editing;
check('[手機] 打開編輯器：設定都在（粉紅、快、3 個會動的靶、限時 30 秒）', reopened.tool.color === '#ff5ca8' && reopened.tool.rate === 'fast' && reopened.targets.count === 3 && reopened.targets.moving && reopened.rule.type === 'timed' && reopened.rule.seconds === 30);
// 複製一份來改（遊戲定義可以重用）
await A.tap('#gameEditorBack');
await A.page.waitForSelector('#gameHub:not([hidden])');
await A.waitFor((id) => !!document.querySelector(`.g-item.game[data-id="${id}"]`), gameId, 10000);
await A.tap(`.g-item.game[data-id="${gameId}"] [data-act=copy]`);
const copied = await A.waitFor(() => [...document.querySelectorAll('.g-item.game')].some((el) => el.textContent.includes('（複本）')), null, 10000);
const copies = (await api('/api/games')).games.filter((g) => g.name.includes('（複本）'));
check('[手機] 📋 複製 → 多一個「（複本）」遊戲，規則跟原本一樣、可以另外改', copied && copies.length === 1 && copies[0].id !== gameId && copies[0].rule.seconds === 30, copies.map((g) => g.name).join('、'));

// ---- 隔離與 AI ----
const after = integrity();
const changed = WATCH.filter((f) => before[f] !== after[f]);
check('自由工坊的 scene／library／worlds／world-state 一個位元都沒變', changed.length === 0, changed.join('、'));
check('0 個 AI 打造工作（測試伺服器的 Codex 本來就不存在）', jobDirs().filter((j) => !jobsBefore.includes(j)).length === 0);
for (const c of [A, B]) {
  const bad = c.writes.filter((w) => !/^(POST|PUT) \/api\/(games|rooms)/.test(w));
  check(`[${c.mobile ? '手機' : '電腦'}] 只寫遊戲與房間（沒有動到工坊）`, bad.length === 0, bad.slice(0, 3).join('、') || `${c.writes.length} 次寫入`);
  check(`[${c.mobile ? '手機' : '電腦'}] 沒有 JS 錯誤`, c.errors.length === 0, c.errors.slice(0, 2).join(' | '));
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
