// 遊戲房（伺服器端）：玩家自己做的遊戲（遊戲定義）＋大家一起玩的房間。
// - 遊戲定義是宣告式的設定（用哪個道具、幾個標靶、怎樣算贏），存在 DATA_DIR/games.json；伺服器只解讀這些設定，不執行玩家提供的程式。
// - 房間在記憶體裡：誰在房裡、分數、倒數、計時、標靶在哪都由伺服器決定，再用 SSE 推給每個人，大家看到的一樣。
// - 命中由射擊的人那台判斷，伺服器確認合理（遊戲進行中、標靶還立著、沒有射太快）才加分。
import crypto from 'node:crypto';

export const RULE_LIMITS = { goal: [1, 50], seconds: [15, 300], targets: [1, 10] };
const RATES = { slow: 2, normal: 4, fast: 7 }; // 每秒最多幾發
const COLORS = ['#7cf8ff', '#ff5ca8', '#ffd166', '#9dff5c', '#b48cff', '#ff8a3d'];
const PLAYER_COLORS = ['#38e1ff', '#ff5ca8', '#ffd166', '#9dff5c', '#b48cff', '#ff8a3d', '#ffffff', '#5cffd6'];
const CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXY'; // 房號：不用 0/O、1/I/L、B/8 這些容易看錯的字
const MAX_ROOMS = 30;
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;
const RACE_MAX_MS = 5 * 60 * 1000; // 「先到 N 分」最多玩 5 分鐘
const GRACE_MS = 60 * 1000; // 斷線一分鐘內回來，分數還在
const ROOM_IDLE_MS = 10 * 60 * 1000; // 沒人連著 10 分鐘就收掉
const TARGET_DOWN_MS = 1000;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const int = (v, [a, b], d) => (Number.isFinite(Number(v)) ? Math.round(clamp(Number(v), a, b)) : d);
const cleanName = (s, max, d) => {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, max);
  return t || d;
};

// ---------------- 遊戲定義 ----------------

export const BUILTIN_TOOL = 'p_vwblaster01';
export const BUILTIN_TARGET = 'p_vwtarget01';

export function defaultGame() {
  return {
    name: '射靶大賽',
    tool: { partId: BUILTIN_TOOL, color: COLORS[0], rate: 'normal' },
    arena: 'range',
    targets: { count: 5, moving: false },
    rule: { type: 'race', goal: 5, seconds: 60 },
  };
}

// 只收認得的欄位、數字夾在範圍內；道具一定要是工具箱裡真的會射的零件
export function cleanGame(input, { hasTool }) {
  const d = defaultGame();
  const g = input && typeof input === 'object' ? input : {};
  const toolIn = g.tool && typeof g.tool === 'object' ? g.tool : {};
  const partId = typeof toolIn.partId === 'string' && hasTool(toolIn.partId) ? toolIn.partId : d.tool.partId;
  const ruleIn = g.rule && typeof g.rule === 'object' ? g.rule : {};
  const tIn = g.targets && typeof g.targets === 'object' ? g.targets : {};
  return {
    name: cleanName(g.name, 20, d.name),
    tool: {
      partId,
      color: /^#[0-9a-f]{6}$/i.test(String(toolIn.color || '')) ? String(toolIn.color).toLowerCase() : d.tool.color,
      rate: RATES[toolIn.rate] ? toolIn.rate : d.tool.rate,
    },
    arena: g.arena === 'ring' ? 'ring' : 'range',
    targets: { count: int(tIn.count, RULE_LIMITS.targets, d.targets.count), moving: tIn.moving === true },
    rule: {
      type: ruleIn.type === 'timed' ? 'timed' : 'race',
      goal: int(ruleIn.goal, RULE_LIMITS.goal, d.rule.goal),
      seconds: int(ruleIn.seconds, RULE_LIMITS.seconds, d.rule.seconds),
    },
  };
}

export function describeRule(game) {
  const r = game.rule;
  const pts = game.targets.moving ? '（會動的靶 2 分）' : '';
  return r.type === 'timed' ? `${r.seconds} 秒內分數最高的贏${pts}` : `先拿到 ${r.goal} 分的贏${pts}`;
}

// ---------------- 房間 ----------------

// 決定性的亂數：同一個房間、同一回合，每台看到的標靶位置都一樣
function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ARENAS = {
  // 靶場：大家站在 z=0 的射擊線，標靶在前方 7–13 公尺
  range: {
    spawn: (i) => [(i % 2 ? 1 : -1) * (1.2 + Math.floor(i / 2) * 1.6), 0, 1.5],
    place: (r) => [-5 + r() * 10, 0, -7 - r() * 6],
  },
  // 競技場：大家在中間，標靶圍一圈（半徑 7–10 公尺）
  ring: {
    spawn: (i) => [Math.cos(i * 2.4) * 1.2, 0, Math.sin(i * 2.4) * 1.2],
    place: (r) => {
      const a = r() * Math.PI * 2;
      const d = 7 + r() * 3;
      return [Math.sin(a) * d, 0, -Math.cos(a) * d];
    },
  },
};

export function createRooms({ log = () => {}, hasTool, onEnded = () => {} }) {
  const rooms = new Map();
  const now = () => Date.now();

  function newCode() {
    for (let i = 0; i < 50; i += 1) {
      let c = '';
      for (let k = 0; k < 4; k += 1) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    throw new Error('房間太多了');
  }

  function note(room, text) {
    room.log.push({ t: now(), text });
    if (room.log.length > 8) room.log.shift();
    room.dirty = true;
  }

  function layout(room) {
    const r = rng(`${room.code}:${room.round}:layout`);
    const arena = ARENAS[room.game.arena];
    room.targets = [];
    for (let i = 0; i < room.game.targets.count; i += 1) {
      const [x, y, z] = arena.place(r);
      room.targets.push({ id: `t${i + 1}`, x: round2(x), y, z: round2(z), up: true, downUntil: 0, moving: room.game.targets.moving, phase: round2(r() * Math.PI * 2), points: room.game.targets.moving ? 2 : 1, n: 0 });
    }
  }
  function respawn(room, t) {
    t.n += 1;
    const r = rng(`${room.code}:${room.round}:${t.id}:${t.n}`);
    const [x, , z] = ARENAS[room.game.arena].place(r);
    t.x = round2(x);
    t.z = round2(z);
    t.phase = round2(r() * Math.PI * 2);
    t.up = true;
  }

  const players = (room) => [...room.players.values()];
  const connected = (p) => p.streams.size > 0;

  function publicState(room) {
    return {
      code: room.code,
      seq: room.seq,
      now: now(),
      phase: room.phase,
      round: room.round,
      startAt: room.startAt,
      endAt: room.endAt,
      gameId: room.gameId,
      game: room.game,
      ruleText: describeRule(room.game),
      hostId: room.hostId,
      players: players(room).map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, hits: p.hits, connected: connected(p), host: p.id === room.hostId, pose: p.pose })),
      targets: room.targets.map(({ id, x, y, z, up, moving, phase, points }) => ({ id, x, y, z, up, moving, phase, points })),
      results: room.results,
      reason: room.reason,
      winner: room.winner,
      log: room.log.slice(-6),
      shots: room.shots.filter((s) => now() - s.t < 700).map(({ id, by, from, to, color }) => ({ id, by, from, to, color })),
    };
  }

  function send(res, payload) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      /* 連線已斷，close 事件會清掉 */
    }
  }
  function broadcast(room) {
    room.seq += 1;
    room.dirty = false;
    room.sentAt = now();
    const payload = JSON.stringify(publicState(room));
    for (const p of room.players.values()) for (const res of p.streams) send(res, payload);
  }

  function create(gameId, game) {
    if (rooms.size >= MAX_ROOMS) {
      // 收掉最久沒人的房間
      const idle = [...rooms.values()].filter((r) => !players(r).some(connected)).sort((a, b) => a.lastActive - b.lastActive)[0];
      if (idle) rooms.delete(idle.code);
      else throw new Error('房間太多了，稍後再試');
    }
    const code = newCode();
    const room = {
      code,
      gameId,
      game: JSON.parse(JSON.stringify(game)),
      phase: 'lobby',
      round: 0,
      players: new Map(),
      hostId: null,
      targets: [],
      startAt: 0,
      endAt: 0,
      results: null,
      reason: null,
      winner: null,
      log: [],
      shots: [],
      seq: 0,
      dirty: true,
      sentAt: 0,
      posesDirty: false,
      createdAt: now(),
      lastActive: now(),
    };
    layout(room);
    rooms.set(code, room);
    log('room create', code, game.name);
    return room;
  }

  function join(code, { name, token }) {
    const room = rooms.get(code);
    if (!room) throw Object.assign(new Error('找不到這個房間（可能已經關了）'), { status: 404 });
    room.lastActive = now();
    const existing = typeof token === 'string' ? players(room).find((p) => safeEq(p.token, token)) : null;
    if (existing) {
      existing.leftAt = 0;
      return { room, player: existing, rejoined: true };
    }
    if (room.players.size >= MAX_PLAYERS) throw Object.assign(new Error('房間滿了（最多 8 人）'), { status: 409 });
    const used = new Set(players(room).map((p) => p.color));
    const n = room.nextNo = (room.nextNo || 0) + 1;
    const player = {
      id: `p${n}`,
      name: cleanName(name, 12, `玩家 ${n}`),
      color: PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0],
      token: crypto.randomBytes(12).toString('hex'),
      score: 0,
      hits: 0,
      streams: new Set(),
      pose: { p: ARENAS[room.game.arena].spawn(room.players.size), yaw: 0, pitch: 0 },
      joinedAt: now(),
      lastSeen: now(),
      lastHit: 0,
      acts: [],
      offlineSince: 0,
    };
    room.players.set(player.id, player);
    if (!room.hostId) room.hostId = player.id;
    note(room, `${player.name} 進來了`);
    return { room, player, rejoined: false };
  }

  function stream(code, token, req, res) {
    const room = rooms.get(code);
    const player = room && players(room).find((p) => safeEq(p.token, token));
    if (!player) return false;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hi\n\n');
    const wasOffline = !connected(player) && player.offlineSince;
    player.streams.add(res);
    player.offlineSince = 0;
    player.lastSeen = now();
    room.lastActive = now();
    if (wasOffline) note(room, `${player.name} 回來了`);
    send(res, JSON.stringify(publicState(room)));
    room.dirty = true;
    req.on('close', () => {
      player.streams.delete(res);
      if (!connected(player) && room.players.has(player.id)) {
        player.offlineSince = now();
        note(room, `${player.name} 斷線了（一分鐘內回來，分數還在）`);
      }
    });
    return true;
  }

  function leave(room, player, why = 'left') {
    room.players.delete(player.id);
    for (const res of player.streams) {
      try {
        res.end();
      } catch {
        /* 已斷 */
      }
    }
    player.streams.clear();
    note(room, why === 'timeout' ? `${player.name} 太久沒回來，離開了` : `${player.name} 離開了`);
    if (room.hostId === player.id) {
      const next = players(room).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = next ? next.id : null;
      if (next) note(room, `${next.name} 變成房主`);
    }
    // 只剩一個人時還在比賽：照樣繼續（他可以打完）；沒人了就停
    if (!room.players.size && room.phase !== 'ended') {
      room.phase = 'lobby';
    }
  }

  function start(room) {
    room.round += 1;
    for (const p of room.players.values()) {
      p.score = 0;
      p.hits = 0;
      p.lastHit = 0;
    }
    layout(room);
    room.results = null;
    room.reason = null;
    room.winner = null;
    room.shots = [];
    room.phase = 'countdown';
    room.startAt = now() + COUNTDOWN_MS;
    room.endAt = room.startAt + (room.game.rule.type === 'timed' ? room.game.rule.seconds * 1000 : RACE_MAX_MS);
    note(room, `第 ${room.round} 回合：${describeRule(room.game)}`);
  }

  function finish(room, reason) {
    room.phase = 'ended';
    room.reason = reason;
    const list = players(room).sort((a, b) => b.score - a.score || b.hits - a.hits || a.joinedAt - b.joinedAt);
    let rank = 0;
    let prev = null;
    room.results = list.map((p, i) => {
      if (p.score !== prev) rank = i + 1;
      prev = p.score;
      return { id: p.id, name: p.name, color: p.color, score: p.score, hits: p.hits, rank };
    });
    const top = room.results[0];
    room.winner = top && top.score > 0 && !(room.results[1] && room.results[1].score === top.score) ? top.id : null;
    note(room, room.winner ? `🏆 ${top.name} 贏了！` : '平手！');
    try {
      onEnded(room.gameId, { at: new Date().toISOString(), round: room.round, reason, rule: describeRule(room.game), results: room.results });
    } catch (e) {
      log('onEnded error', e.message);
    }
  }

  // 玩家送來的動作（都要帶自己的 token）
  function act(code, token, body) {
    const room = rooms.get(code);
    const player = room && players(room).find((p) => safeEq(p.token, token));
    if (!player) throw Object.assign(new Error('不在這個房間裡'), { status: 403 });
    const t = now();
    player.lastSeen = t;
    room.lastActive = t;
    // 每人每秒最多 40 個動作，多的丟掉
    player.acts = player.acts.filter((x) => t - x < 1000);
    if (player.acts.length >= 40) return { ok: false, why: 'rate' };
    player.acts.push(t);
    const isHost = room.hostId === player.id;
    switch (body?.type) {
      case 'pose': {
        const p = body.p;
        if (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)) {
          player.pose = { p: p.map((v) => round2(clamp(v, -60, 60))), yaw: round2(Number(body.yaw) || 0), pitch: round2(clamp(Number(body.pitch) || 0, -1.6, 1.6)) };
          room.posesDirty = true;
        }
        return { ok: true };
      }
      case 'shot': {
        const ok = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
        if (room.phase !== 'playing' || !ok(body.from) || !ok(body.to)) return { ok: false };
        room.shots.push({ id: `${player.id}-${t}`, by: player.id, from: body.from.map(round2), to: body.to.map(round2), color: room.game.tool.color, t });
        room.shots = room.shots.filter((s) => t - s.t < 700).slice(-24);
        room.posesDirty = true;
        return { ok: true };
      }
      case 'hit': {
        if (room.phase !== 'playing' || t < room.startAt) return { ok: false, why: 'not playing' };
        const target = room.targets.find((x) => x.id === body.target);
        if (!target || !target.up) return { ok: false, why: 'target down' };
        const minGap = 1000 / (RATES[room.game.tool.rate] * 1.25);
        if (t - player.lastHit < minGap) return { ok: false, why: 'too fast' };
        player.lastHit = t;
        target.up = false;
        target.downUntil = t + TARGET_DOWN_MS;
        player.score += target.points;
        player.hits += 1;
        note(room, `${player.name} 打中了 +${target.points}`);
        if (room.game.rule.type === 'race' && player.score >= room.game.rule.goal) finish(room, 'goal');
        return { ok: true, score: player.score };
      }
      case 'start': {
        if (!isHost) return { ok: false, why: '只有房主可以開始' };
        if (room.phase === 'countdown' || room.phase === 'playing') return { ok: false, why: '已經開始了' };
        start(room);
        return { ok: true };
      }
      case 'rules': {
        if (!isHost) return { ok: false, why: '只有房主可以改規則' };
        if (room.phase === 'countdown' || room.phase === 'playing') return { ok: false, why: '比賽中不能改規則' };
        const next = cleanGame({ ...room.game, ...body.game, tool: { ...room.game.tool, ...(body.game?.tool || {}) } }, { hasTool });
        room.game = next;
        layout(room);
        room.phase = 'lobby'; // 回到房間大廳，大家看到新規則再開始
        note(room, `規則改成：${describeRule(next)}`);
        return { ok: true, game: next };
      }
      case 'rename': {
        player.name = cleanName(body.name, 12, player.name);
        room.dirty = true;
        return { ok: true };
      }
      case 'leave': {
        leave(room, player);
        return { ok: true };
      }
      default:
        return { ok: false, why: 'unknown' };
    }
  }

  // 每 100 毫秒：倒數、計時、標靶重生、斷線太久的人、推送狀態
  function tick() {
    const t = now();
    for (const room of [...rooms.values()]) {
      if (room.phase === 'countdown' && t >= room.startAt) {
        room.phase = 'playing';
        note(room, '開始！');
      }
      if (room.phase === 'playing') {
        for (const target of room.targets) {
          if (!target.up && t >= target.downUntil) {
            respawn(room, target);
            room.dirty = true;
          }
        }
        if (t >= room.endAt) finish(room, 'time');
      }
      for (const p of players(room)) {
        if (!connected(p) && p.offlineSince && t - p.offlineSince > GRACE_MS) leave(room, p, 'timeout');
      }
      if (!players(room).some(connected) && t - room.lastActive > ROOM_IDLE_MS) {
        rooms.delete(room.code);
        log('room closed (idle)', room.code);
        continue;
      }
      // 有變化就推；姿勢每 100 毫秒推一次；沒事也每 2 秒推一次（對時、保持連線）
      if (room.dirty || room.posesDirty || t - room.sentAt > 2000) {
        room.posesDirty = false;
        broadcast(room);
      }
    }
  }
  const timer = setInterval(tick, 100);
  timer.unref?.();

  return {
    create,
    join,
    stream,
    act,
    get: (code) => rooms.get(code) || null,
    state: (code) => (rooms.has(code) ? publicState(rooms.get(code)) : null),
    list() {
      return [...rooms.values()]
        .filter((r) => players(r).some(connected) || now() - r.createdAt < 5 * 60 * 1000)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({ code: r.code, name: r.game.name, ruleText: describeRule(r.game), players: players(r).filter(connected).length, phase: r.phase, host: r.players.get(r.hostId)?.name || null }));
    },
    // 測試／關機用
    stop() {
      clearInterval(timer);
    },
  };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
function safeEq(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}
