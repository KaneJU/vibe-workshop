// 遊戲房伺服器測試（不開瀏覽器）：兩個各自獨立的玩家用 HTTP＋SSE 進同一個房間，
// 開始／命中／計分／結束要一致；改規則再玩；離開、斷線重連；兩個房間互不干擾；亂送的設定會被擋下。
// 對測試用伺服器跑（只聽本機）：
//   DATA_DIR=/tmp/vw-room-data PORT=5313 HOST=127.0.0.1 CODEX_BIN=/nonexistent/codex npm start &
//   BASE=http://127.0.0.1:5313 npm run test:rooms
const BASE = process.env.BASE || 'http://127.0.0.1:5313';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：請對測試用伺服器跑（預設 :5313）。');
  process.exit(2);
}
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}

// 一個玩家：加入房間、開著 SSE、記下最新狀態
async function player(code, name, token) {
  const j = await call('POST', `/api/rooms/${code}/join`, { name, token });
  if (!j.token) throw new Error(`join failed: ${JSON.stringify(j)}`);
  const me = { token: j.token, id: j.playerId, rejoined: j.rejoined, state: j.state, events: 0, ctrl: new AbortController() };
  const res = await fetch(`${BASE}/api/rooms/${code}/stream?token=${me.token}`, { signal: me.ctrl.signal });
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            me.state = JSON.parse(line.slice(6));
            me.events += 1;
          }
        }
      }
    } catch {
      /* 關掉了 */
    }
  })();
  me.act = (body) => call('POST', `/api/rooms/${code}/act`, { token: me.token, ...body });
  me.close = () => me.ctrl.abort();
  return me;
}
const until = async (fn, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};

// ---- 遊戲定義：存、讀、亂送的欄位被擋 ----
const created = await call('POST', '/api/games', { game: { name: '<b>測試賽</b>', rule: { type: 'race', goal: 3 }, targets: { count: 4 }, tool: { partId: 'p_nope', color: 'red', rate: 'turbo' }, evil: 'process.exit()' } });
const g = created.game;
check('建立遊戲：名稱去掉標籤、不認得的欄位丟掉、不存在的道具換回內建能量槍', g && g.name === 'b測試賽/b' && !('evil' in g) && g.tool.partId === 'p_vwblaster01' && g.tool.rate === 'normal' && g.tool.color === '#7cf8ff' && g.rule.goal === 3 && g.targets.count === 4, JSON.stringify(g));
const list = await call('GET', '/api/games');
check('遊戲列表看得到、也列出會射的道具', list.games.some((x) => x.id === g.id) && list.tools.some((t) => t.id === 'p_vwblaster01'), `道具 ${list.tools.map((t) => t.name).join('、')}`);

// ---- 開房間、兩個玩家加入 ----
const room = await call('POST', '/api/rooms', { gameId: g.id });
check('開房間 → 四個字的房號', /^[A-Z]{4}$/.test(room.code), room.code);
const A = await player(room.code, '小明');
const B = await player(room.code, '小華');
await until(() => A.state?.players?.length === 2 && B.state?.players?.length === 2);
check('兩個人都看到房裡有 2 位玩家', A.state.players.length === 2 && B.state.players.length === 2, A.state.players.map((p) => p.name).join('、'));
check('先進來的是房主；房主才能開始', A.state.hostId === A.id && (await B.act({ type: 'start' })).ok === false);
const rooms = await call('GET', '/api/rooms');
check('房間列表看得到這個房間（朋友不用打房號，點一下就能進）', rooms.rooms.some((r) => r.code === room.code && r.players === 2));

// ---- 開始：倒數 → 進行中，兩邊一致 ----
check('房主按開始', (await A.act({ type: 'start' })).ok);
await until(() => A.state.phase === 'countdown' && B.state.phase === 'countdown');
check('兩邊都進入倒數、開始時間一樣', A.state.startAt === B.state.startAt && A.state.startAt > Date.now() - 500, `${A.state.startAt}`);
check('倒數中打靶不算分', (await A.act({ type: 'hit', target: A.state.targets[0].id })).ok === false);
await until(() => A.state.phase === 'playing' && B.state.phase === 'playing', 6000);
check('倒數完兩邊同時進入比賽', A.state.phase === 'playing' && B.state.phase === 'playing');
const sameTargets = JSON.stringify(A.state.targets) === JSON.stringify(B.state.targets);
check('兩邊看到的標靶位置一模一樣（伺服器決定）', sameTargets && A.state.targets.length === 4);

// ---- 命中計分 ----
const t1 = A.state.targets[0].id;
const h1 = await A.act({ type: 'hit', target: t1 });
const h1b = await B.act({ type: 'hit', target: t1 });
check('小明打中 +1；同一個靶倒下後小華打不到', h1.ok && h1.score === 1 && h1b.ok === false, JSON.stringify([h1, h1b]));
check('射太快（不合理的連續命中）會被擋', (await A.act({ type: 'hit', target: A.state.targets[1].id })).ok === false);
await sleep(300);
await B.act({ type: 'hit', target: B.state.targets[1].id });
await until(() => B.state.players.find((p) => p.id === B.id)?.score === 1 && A.state.players.find((p) => p.id === B.id)?.score === 1);
check('小華打中 → 兩邊的計分板都更新', A.state.players.find((p) => p.id === B.id).score === 1 && B.state.players.find((p) => p.id === A.id).score === 1);
await until(() => A.state.targets.find((t) => t.id === t1)?.up === true, 3000);
check('倒下的靶一秒後換個位置重新立起來（兩邊一樣）', A.state.targets.find((t) => t.id === t1).up && JSON.stringify(A.state.targets) === JSON.stringify(B.state.targets));
// 小明連打到 3 分 → 贏
for (let i = 0; i < 6 && A.state.phase === 'playing'; i += 1) {
  await sleep(300);
  const up = A.state.targets.find((t) => t.up);
  if (up) await A.act({ type: 'hit', target: up.id });
  await sleep(80);
}
await until(() => A.state.phase === 'ended' && B.state.phase === 'ended');
check('小明先拿到 3 分 → 比賽結束（目標達成）', A.state.phase === 'ended' && A.state.reason === 'goal' && A.state.winner === A.id);
check('兩邊的結算一模一樣', JSON.stringify(A.state.results) === JSON.stringify(B.state.results), JSON.stringify(A.state.results));
const saved1 = (await call('GET', '/api/games')).games.find((x) => x.id === g.id);
check('結算存回遊戲定義（玩過次數、上一次結果）', saved1.plays === 1 && saved1.last?.results?.[0]?.id === A.id);

// ---- 改規則再玩：改成限時 15 秒 ----
check('非房主不能改規則', (await B.act({ type: 'rules', game: { rule: { type: 'timed', seconds: 15 } } })).ok === false);
const rr = await A.act({ type: 'rules', game: { rule: { type: 'timed', seconds: 15 }, targets: { count: 3, moving: true } } });
await until(() => B.state.game.rule.type === 'timed');
check('房主改成「限時 15 秒、3 個會動的靶」→ 兩邊都看到新規則', rr.ok && B.state.game.rule.seconds === 15 && B.state.targets.length === 3 && B.state.targets.every((t) => t.moving && t.points === 2), B.state.ruleText);
const saved2 = (await call('GET', '/api/games')).games.find((x) => x.id === g.id);
check('新規則存回遊戲定義（重開還在）', saved2.rule.type === 'timed' && saved2.rule.seconds === 15 && saved2.targets.moving === true);
await A.act({ type: 'start' });
await until(() => A.state.phase === 'playing' && B.state.phase === 'playing', 6000);
check('再玩一次：分數歸零', A.state.players.every((p) => p.score === 0));
await sleep(200);
await B.act({ type: 'hit', target: B.state.targets[0].id });
await until(() => A.state.players.find((p) => p.id === B.id)?.score === 2);
check('會動的靶一個 2 分', A.state.players.find((p) => p.id === B.id).score === 2);

// ---- 斷線重連、離開 ----
B.close();
await until(() => A.state.players.find((p) => p.id === B.id)?.connected === false, 5000);
check('小華斷線 → 小明那邊看到「斷線」，分數還在', A.state.players.find((p) => p.id === B.id).connected === false && A.state.players.find((p) => p.id === B.id).score === 2 && A.state.log.some((l) => l.text.includes('斷線')));
const B2 = await player(room.code, '小華', B.token);
await until(() => A.state.players.find((p) => p.id === B.id)?.connected === true, 5000);
check('小華用同一個身分連回來 → 同一個玩家、分數保留', B2.rejoined && B2.id === B.id && A.state.players.find((p) => p.id === B.id).score === 2 && A.state.log.some((l) => l.text.includes('回來了')));
await until(() => A.state.phase === 'ended', 20000);
check('時間到 → 結束；分數高的小華贏', A.state.reason === 'time' && A.state.winner === B.id && JSON.stringify(A.state.results) === JSON.stringify(B2.state.results), JSON.stringify(A.state.results));
const lv = await B2.act({ type: 'leave' });
await until(() => A.state.players.length === 1);
check('小華按離開 → 房裡剩小明一個，看到「離開了」', lv.ok && A.state.players.length === 1 && A.state.log.some((l) => l.text.includes('離開了')));

// ---- 房間隔離 ----
const room2 = await call('POST', '/api/rooms', { gameId: g.id });
const C = await player(room2.code, '小美');
await C.act({ type: 'start' });
await until(() => C.state.phase === 'countdown');
check('另一個房間的人看不到這個房間，也不會影響它', !C.state.players.some((p) => p.id === A.id && p.name === '小明') && A.state.phase === 'ended' && !A.state.players.some((p) => p.name === '小美'));
check('拿別的房間的身分不能在這裡動作', (await call('POST', `/api/rooms/${room.code}/act`, { token: C.token, type: 'start' })).status === 403);
check('亂猜的房號進不去', (await call('POST', '/api/rooms/ZZZZ/join', {})).status === 404);

A.close();
B2.close();
C.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
