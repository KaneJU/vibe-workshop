// 創作世界的伺服器協定測試（協定測試：兩位「隔離 fixture 創作者」，不是兩個真的 Codex 帳號；也不叫 Codex）。
// 自己開只聽 127.0.0.1 的測試伺服器（暫存資料夾、CODEX_BIN 不存在），驗：
// 身分與工作歸屬（只拿得到、只能交付自己的工作）、配對碼一次性、同一句話只建一個工作、沒連 connector 不會改用主人的 Codex、
// 作品包格式檢查與 Deno 零權限影子試跑（壞的退回診斷、修好才收；無限迴圈被停；讀檔／連網／環境變數被擋）、
// 版本不可變且單調遞增、換 stateSchema 要 migrate、別人的作品線改了會分出自己的、瀏覽器回報壞版就標記不再拿來放、
// 世界：開子世界（樹狀、不會循環）、存檔帶 revision（衝突回 409）、深鏈超過 8 層照樣能開。
//   node tests/creation-protocol.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 5371;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(os.tmpdir(), 'vw-creation-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, CODEX_BIN: '/nonexistent/codex', CREATION_LEASE_MS: '1500', CREATION_HANDOVER_MS: '800' },
  stdio: 'ignore',
});
for (let i = 0; i < 80; i += 1) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await sleep(200);
}

// 一個「瀏覽器」：記住自己的 cookie
function browser() {
  let cookie = '';
  const fn = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json, text };
  };
  fn.cookie = () => cookie;
  return fn;
}
// connector：只有 token
const conn = (token) => async (method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 */
  }
  return { status: r.status, json };
};
const pkg = (name, code, schema = 1) => ({ manifest: { format: 'vibe-pkg/1', name, description: '測試', stateSchema: schema, budgets: { entities: 40 } }, files: { 'main.js': code }, provenance: { tool: 'fixture', via: 'fixture', attempt: 1, ms: 1 } });
const GOOD = `vibe.define({
  init() { return { hits: 0, t: 0 }; },
  tick(s, dt) { s.t += dt; },
  view(s) { return [{ id: 'orb', shape: 'sphere', pos: [Math.sin(s.t), 1, 0], size: [0.3], color: '#33ccff' }]; },
  hud(s) { return ['命中 ' + s.hits]; },
  onEvent(s, ev) { if (ev.type === 'click' && ev.target === 'orb') s.hits += 1; },
});`;
const BROKEN = GOOD.replace('s.t += dt;', 's.t += dt; if (s.t > 2) throw new Error("第二秒爆炸");');
const V2 = `vibe.define({
  init() { return { hits: 0, t: 0, combo: 0 }; },
  tick(s, dt) { s.t += dt; },
  view(s) { return [{ id: 'orb', shape: 'sphere', pos: [Math.sin(s.t), 1, 0], size: [0.3], color: '#ff9933' }]; },
  onEvent(s, ev) { if (ev.type === 'click') { s.hits += 1; s.combo += 1; } },
  migrate(old, from) { return { ...old, combo: 0 }; },
});`;

try {
  const A = browser();
  const B = browser();
  const meA = (await A('POST', '/api/me', { name: '甲' })).json;
  const meB = (await B('POST', '/api/me', { name: '乙' })).json;
  check('兩個瀏覽器各自是不同的創作者', meA.creatorId && meB.creatorId && meA.creatorId !== meB.creatorId);
  check('還沒有 connector：狀態顯示未配對', meA.connector.paired === false);

  // 沒連 connector 就送需求：工作留在佇列，不會改用主人的 Codex
  const j0 = (await A('POST', '/api/create', { utteranceId: 'utt-a-0001', intent: '做一顆會跑的球', source: 'text', worldId: 'root', selected: [] })).json;
  await sleep(1500);
  const j0s = (await A('GET', `/api/create/${j0.job.id}`)).json;
  check('沒有 connector：工作停在 queued，提示未配對（沒有 fallback）', j0s.job.status === 'queued' && j0s.connector.paired === false);
  check('伺服器沒有為這個工作開 jobs/ 資料夾或叫 Codex', !readdirSync(path.join(ROOT, 'jobs')).some((d) => d.includes(j0.job.id)));
  const again = (await A('POST', '/api/create', { utteranceId: 'utt-a-0001', intent: '做一顆會跑的球', source: 'voice', worldId: 'root' })).json;
  check('同一個 utteranceId 再送一次：回同一個工作（不重複生成）', again.duplicate === true && again.job.id === j0.job.id);
  await A('POST', `/api/create/${j0.job.id}/cancel`, {});

  // 配對
  const codeA = (await A('POST', '/api/connector/code', {})).json.code;
  const pa = await conn(null)('POST', '/api/connector/pair', { code: codeA, label: '甲的電腦' });
  check('甲用配對碼換到 connector token', pa.status === 200 && pa.json.token && pa.json.creatorId === meA.creatorId);
  const reuse = await conn(null)('POST', '/api/connector/pair', { code: codeA, label: '偷用' });
  check('配對碼用過就失效', reuse.status === 403);
  const codeB = (await B('POST', '/api/connector/code', {})).json.code;
  const pb = await conn(null)('POST', '/api/connector/pair', { code: codeB, label: '乙的電腦' });
  const KA = conn(pa.json.token);
  const KB = conn(pb.json.token);
  check('沒有 token 的 connector 拿不到工作', (await conn(null)('GET', '/api/connector/jobs')).status === 401);

  // 工作歸屬
  const ja = (await A('POST', '/api/create', { utteranceId: 'utt-a-0002', intent: '做一個點球得分的遊戲', source: 'voice', worldId: 'root' })).json.job;
  const gotB = await KB('GET', '/api/connector/jobs?wait=1');
  check('乙的 connector 拿不到甲的工作', gotB.status === 204);
  const gotA = await KA('GET', '/api/connector/jobs?wait=1');
  check('甲的 connector 拿到甲的工作（含語音來源）', gotA.status === 200 && gotA.json.job.id === ja.id && gotA.json.job.source === 'voice');
  check('乙不能替甲的工作交作品包', (await KB('POST', `/api/connector/jobs/${ja.id}/package`, pkg('偷交', GOOD))).status === 403);
  check('乙看不到甲的工作狀態', (await B('GET', `/api/create/${ja.id}`)).status === 404);

  // 壞版本 → 診斷回同一個工作；修好才收
  const bad = (await KA('POST', `/api/connector/jobs/${ja.id}/package`, pkg('點球', BROKEN))).json;
  check('第一版第二秒會丟例外：影子試跑沒過，回傳診斷（含行號）', bad.ok === false && bad.status === 'needs-fix' && /第二秒爆炸/.test(bad.diagnostics.join()) && /main\.js 第 \d+ 行/.test(bad.diagnostics.join()), bad.diagnostics?.[0]);
  const good = (await KA('POST', `/api/connector/jobs/${ja.id}/package`, pkg('點球', GOOD))).json;
  check('修好的版本通過 → 新作品線 v1', good.ok && good.version === 1 && /^lin_/.test(good.lineage));
  const jaDone = (await A('GET', `/api/create/${ja.id}`)).json.job;
  check('工作變成 built，記錄來源（fixture、第 2 輪）', jaDone.status === 'built' && jaDone.attempts === 2 && jaDone.provenance.tool === 'fixture');
  const L1 = good.lineage;
  const code1 = await fetch(`${BASE}/pkg/${L1}/1/main.js`);
  check('版本檔可讀、不可變快取、以純文字提供（主頁面不能直接當腳本執行）', code1.ok && (await code1.text()) === GOOD && /immutable/.test(code1.headers.get('cache-control')) && /text\/plain/.test(code1.headers.get('content-type')) && code1.headers.get('x-content-type-options') === 'nosniff');

  // 惡意作品：讀檔、環境變數、子程序、連網都被 Deno 擋（在 init 裡收集結果，然後故意讓 view 失敗把結果帶出來）
  const jEvil = (await A('POST', '/api/create', { utteranceId: 'utt-a-evil1', intent: '惡意測試', source: 'text', worldId: 'root' })).json.job;
  await KA('GET', '/api/connector/jobs?wait=1');
  const EVIL = `const r = [];
for (const f of [() => Deno.readTextFileSync('/etc/hosts'), () => Deno.env.get('HOME'), () => new Deno.Command('ls').outputSync()]) { try { f(); r.push('LEAK'); } catch (e) { r.push(e.name); } }
vibe.define({ init() { return { r }; }, tick() {}, view(s) { throw new Error('結果' + JSON.stringify(s.r)); } });`;
  const evil = (await KA('POST', `/api/connector/jobs/${jEvil.id}/package`, pkg('惡意', EVIL))).json;
  const msg = evil.diagnostics?.join() || '';
  check('作品在影子試跑裡讀檔／讀環境變數／開子程序全部被擋（NotCapable），作品被退回', !evil.ok && /NotCapable/.test(msg) && !/LEAK/.test(msg), msg.slice(0, 160));
  const SPIN = 'vibe.define({ init() { return {}; }, tick() { for (;;) {} }, view() { return []; } });';
  const t0 = Date.now();
  const spin = (await KA('POST', `/api/connector/jobs/${jEvil.id}/package`, pkg('卡住', SPIN))).json;
  check('無限迴圈：影子試跑被停掉（CPU 上限），回傳原因', !spin.ok && /CPU|秒/.test(spin.diagnostics.join()) && Date.now() - t0 < 12000, `${Date.now() - t0} ms：${spin.diagnostics?.[0]}`);
  const fmt = (await KA('POST', `/api/connector/jobs/${jEvil.id}/package`, pkg('格式', 'import x from "y";\nexport default 1;'))).json;
  check('格式錯誤（import／export、沒有 vibe.define）直接回診斷', !fmt.ok && /import／export/.test(fmt.diagnostics.join()));
  await A('POST', `/api/create/${jEvil.id}/cancel`, {});

  // 改作品：stateSchema 1 → 2 要 migrate；同一條作品線 v2
  const jm = (await A('POST', '/api/create', { utteranceId: 'utt-a-mod01', intent: '加上連擊', source: 'voice', worldId: 'root', targetLineage: L1, baseVersion: 1 })).json.job;
  const gm = (await KA('GET', '/api/connector/jobs?wait=1')).json.job;
  check('改作品的工作附上原本 v1 的程式給 connector', gm.id === jm.id && gm.target?.lineage === L1 && gm.target.code === GOOD);
  const noMig = (await KA('POST', `/api/connector/jobs/${jm.id}/package`, pkg('點球', V2.replace(/\n\s*migrate\(old, from\).*\n/, '\n'), 2))).json;
  check('stateSchema 變了卻沒寫 migrate：退回', !noMig.ok && /migrate/.test(noMig.diagnostics.join()));
  const v2 = (await KA('POST', `/api/connector/jobs/${jm.id}/package`, pkg('點球', V2, 2))).json;
  check('有 migrate：用 v1 真的跑出來的存檔試遷移 → 通過，同一條作品線 v2', v2.ok && v2.lineage === L1 && v2.version === 2);
  check('v1 原檔沒被改（不可變）', (await (await fetch(`${BASE}/pkg/${L1}/1/main.js`)).text()) === GOOD);

  // 衝突：基於舊版（v1）的修改晚到
  const jc = (await A('POST', '/api/create', { utteranceId: 'utt-a-conf1', intent: '改顏色', source: 'text', worldId: 'root', targetLineage: L1, baseVersion: 1 })).json.job;
  await KA('GET', '/api/connector/jobs?wait=1');
  const conf = (await KA('POST', `/api/connector/jobs/${jc.id}/package`, pkg('點球', GOOD))).json;
  check('基於 v1 的修改在 v2 之後才交：回報衝突，不覆蓋', !conf.ok && conf.conflict && conf.status === 'conflict');

  // 乙改甲的作品：分出乙自己的作品線（甲的不動）
  const jb = (await B('POST', '/api/create', { utteranceId: 'utt-b-fork1', intent: '我也要改', source: 'text', worldId: 'root', targetLineage: L1, baseVersion: 2 })).json.job;
  const gb = (await KB('GET', '/api/connector/jobs?wait=1')).json.job;
  const fork = (await KB('POST', `/api/connector/jobs/${gb.id}/package`, pkg('乙的點球', V2, 2))).json;
  const libs = (await A('GET', '/api/lineages')).json.lineages;
  const Lfork = libs.find((l) => l.id === fork.lineage);
  check('乙改甲的作品 → 分出乙自己的作品線（記錄來源），甲的作品線仍是 v2', fork.ok && fork.lineage !== L1 && Lfork.creatorId === meB.creatorId && Lfork.forkOf.lineage === L1 && libs.find((l) => l.id === L1).latest === 2);
  check('作品庫共用：甲看得到乙的作品', libs.some((l) => l.creatorId === meB.creatorId));
  void jb;

  // 瀏覽器回報 v2 換版試跑失敗 → v2 標成壞掉、工作回到同一位創作者的佇列
  const rf = (await A('POST', `/api/create/${jm.id}/runtime-fail`, { message: 'tick 第 40 步出錯' })).json.job;
  const lib2 = (await A('GET', '/api/lineages')).json.lineages.find((l) => l.id === L1);
  check('瀏覽器回報 v2 壞掉：v2 標記 broken、新實例改用 v1，工作重新排隊', rf.status === 'queued' && lib2.versions.find((x) => x.v === 2).broken && lib2.latestGood === 1);
  const again2 = (await KA('GET', '/api/connector/jobs?wait=1')).json.job;
  check('修正工作回到甲的 connector，附上壞掉的 v2 與瀏覽器診斷', again2.id === jm.id && again2.target.baseVersion === 2 && /瀏覽器換版試跑失敗/.test(again2.diagnostics.join()));

  // 世界：開子世界、存檔 revision、深鏈
  const root = (await A('GET', '/api/cworlds/root')).json.world;
  const wb = (await A('POST', '/api/cworlds', { parentId: 'root', name: 'B 世界', baseRevision: root.revision })).json;
  const wc = (await A('POST', '/api/cworlds', { parentId: wb.world.id, name: 'C 世界' })).json;
  const rootNow = (await A('GET', '/api/cworlds/root')).json.world;
  check('A→B→C：每層記住自己的上一層，上一層有傳送門', wc.world.path.map((x) => x.name).join('/') === '根世界/B 世界/C 世界' && rootNow.portals.some((p) => p.world === wb.world.id) && wb.parent.revision === root.revision + 1);
  const put1 = await A('PUT', `/api/cworlds/${wc.world.id}`, { baseRevision: 0, items: [{ id: 'i_c1', lineage: L1, version: 1, pos: [0, 0, -2], state: { hits: 3, t: 1 }, schema: 1 }, { id: 'i_c2', lineage: L1, version: 1, pos: [2, 0, -2], state: { hits: 9, t: 4 }, schema: 1 }] });
  check('C 層存兩個同作品實例（各自的狀態）', put1.status === 200 && put1.json.revision === 1);
  const stale = await A('PUT', `/api/cworlds/${wc.world.id}`, { baseRevision: 0, items: [] });
  check('用舊的 revision 存檔 → 409（不靜默覆蓋）', stale.status === 409 && stale.json.revision === 1);
  const cBack = (await A('GET', `/api/cworlds/${wc.world.id}`)).json.world;
  check('讀回 C 層：兩個實例狀態互不污染', cBack.items.find((i) => i.id === 'i_c1').state.hits === 3 && cBack.items.find((i) => i.id === 'i_c2').state.hits === 9);
  const badItem = await A('PUT', `/api/cworlds/${wc.world.id}`, { baseRevision: 1, items: [{ id: 'i_x', lineage: 'lin_nope', version: 1, pos: [0, 0, 0] }] });
  check('放不存在的作品版本 → 400', badItem.status === 400);
  let parent = 'root';
  const chain = [];
  for (let d = 1; d <= 12; d += 1) {
    const r = (await A('POST', '/api/cworlds', { parentId: parent, name: `第 ${d} 層` })).json.world;
    chain.push(r);
    parent = r.id;
  }
  check('同一個機制連開 12 層子世界（超過舊的 8 層），路徑與深度正確', chain[11].depth === 12 && chain[11].path.length === 13, `depth ${chain[11].depth}`);

  // 同一層多個分頁：執行權（lease）、接手、即時通知（SSE）——協定測試
  const wid = wc.world.id;
  const events = [];
  const sse = async (who, client) => {
    const ctl = new AbortController();
    const cookieOf = who === 'A' ? A : B;
    // 借 browser() 的 cookie：再送一次 /api/me 拿不到 cookie，所以直接用 fetch＋手動 cookie
    const r = await fetch(`${BASE}/api/cworlds/${wid}/events?client=${client}`, { headers: { Cookie: cookieOf.cookie() }, signal: ctl.signal });
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of r.body) {
          buf += dec.decode(chunk);
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = block.match(/^event: (\w+)$/m)?.[1];
            const data = block.match(/^data: (.*)$/m)?.[1];
            if (ev) events.push({ who, ev, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        /* 中止 */
      }
    })();
    return () => ctl.abort();
  };
  const cA = 'tab_aaaaaaaa1';
  const cB = 'tab_bbbbbbbb1';
  const stopA = await sse('A', cA);
  const stopB = await sse('B', cB);
  await sleep(200);
  const lease = (who, client, action) => who('POST', `/api/cworlds/${wid}/lease`, { client, action });
  const lA = (await lease(A, cA, 'claim')).json;
  const lB = (await lease(B, cB, 'claim')).json;
  check('lease：第一個 claim 成為執行者，第二個只看', lA.leader === true && lB.leader === false && lB.lease?.clientId === cA);
  const curRev = (await A('GET', `/api/cworlds/${wid}`)).json.world.revision;
  const putB = await B('PUT', `/api/cworlds/${wid}`, { baseRevision: curRev, items: [], client: cB });
  check('只看的分頁存檔 → 409（notLeader），不覆蓋執行中的存檔', putB.status === 409 && putB.json.notLeader === true);
  const putA = await A('PUT', `/api/cworlds/${wid}`, { baseRevision: curRev, items: cBack.items, client: cA, reason: 'save' });
  await sleep(200);
  check('執行者存檔成功 → 同一層的其他分頁收到 revision 通知（附存檔的人）', putA.status === 200 && events.some((e) => e.who === 'B' && e.ev === 'revision' && e.data.by === cA && e.data.revision === putA.json.revision));
  const tk = (await lease(B, cB, 'take')).json;
  await sleep(200);
  check('take：有人在跑 → 先排隊，伺服器通知執行者交出（handover）', tk.pending === true && events.some((e) => e.who === 'A' && e.ev === 'handover' && e.data.to === cB));
  await lease(A, cA, 'release');
  await sleep(200);
  check('執行者存好後 release → 執行權交給排隊的分頁（大家都收到 lease 通知）', events.some((e) => e.ev === 'lease' && e.data.clientId === cB && e.data.from === cA) && (await lease(A, cA, 'renew')).json.leader === false);
  // 執行者不回應：時間到強制交接
  const tk2 = (await lease(A, cA, 'take')).json;
  await sleep(1200);
  check('執行者不回應 handover：等 HANDOVER_MS 後強制交給接手的人（forced）', tk2.pending === true && events.some((e) => e.ev === 'lease' && e.data.clientId === cA && e.data.forced === true));
  // 斷線：lease 不續就到期，別人 claim 得到
  await sleep(1700);
  check('執行者不續 lease（斷線）→ 到期後別人 claim 得到', (await lease(B, cB, 'claim')).json.leader === true);
  // 追加作品：不需要執行權，伺服器合併並通知
  const before = (await A('GET', `/api/cworlds/${wid}`)).json.world;
  const app = await A('POST', `/api/cworlds/${wid}/items`, { item: { id: 'i_append1', lineage: L1, version: 1, pos: [4, 0, 0], state: null, schema: null }, client: cA });
  await sleep(200);
  const after = (await A('GET', `/api/cworlds/${wid}`)).json.world;
  check('追加作品（不需要執行權）：伺服器合併、revision+1、通知其他分頁（reason append），原本的實例狀態不動', app.status === 200 && after.items.length === before.items.length + 1 && after.revision === before.revision + 1 && events.some((e) => e.who === 'B' && e.ev === 'revision' && e.data.reason === 'append') && after.items.find((i) => i.id === 'i_c1').state.hits === 3);
  check('同一個實例 id 不能追加兩次', (await A('POST', `/api/cworlds/${wid}/items`, { item: { id: 'i_append1', lineage: L1, version: 1, pos: [4, 0, 0] }, client: cA })).status === 409);
  check('presence：開著的分頁數會通知（2 個）', events.some((e) => e.ev === 'presence' && e.data.n === 2));
  stopA();
  stopB();
  check('沒有創作者身分不能開世界、不能送需求', (await browser()('POST', '/api/cworlds', { parentId: 'root' })).status === 401);
} catch (e) {
  check('測試流程沒有例外', false, e.stack || e.message);
} finally {
  server.kill();
  await sleep(200);
  rmSync(DATA, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
