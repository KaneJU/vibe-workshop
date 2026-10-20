// 創作世界（瀏覽器端，/?create）：說需求或打字 → 你自己的 Codex（connector）→ 伺服器影子試跑 → 這裡在沙盒裡執行。
// - 作品只在 sandbox iframe 的 Worker 裡跑（sandbox-host.mjs），這頁只收資料（要畫什麼、HUD）
// - 世界可以一層一層往下開（傳送門），只有目前這一層在執行；進入子世界前先存檔、停掉這層，返回時從存檔恢復
// - 換版不重新整理：新版先用「舊版目前的存檔」在影子實例試跑 → 同一格切換 → 觀察 3 秒，出錯就退回舊版和切換當下的狀態
// - 說話時就記下「哪個世界、選了誰、要改哪一版」，說到一半換世界也不會改錯東西
// 規格：docs/creation-sdk.md
import { createSandboxHost } from './sandbox-host.mjs';
import { createVoice } from './voice.mjs';

const TICK = 1 / 30;
const SWAP_WATCH_MS = 3000;
const SAVE_EVERY_MS = 6000;
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
body.mode-create .panel, body.mode-create footer.hud.bottom, body.mode-create #mobileBar, body.mode-create #holdHud, body.mode-create #ctlHud, body.mode-create #selToggle, body.mode-create #libToggle { display: none !important; }
#cUi { position: fixed; inset: 0; pointer-events: none; z-index: 12; font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif; color: #d9f6ff; }
#cUi > * { pointer-events: auto; }
#cCrumb { position: fixed; top: calc(56px + env(safe-area-inset-top)); left: 12px; right: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#cCrumb .crumb { background: rgba(8,20,32,.82); border: 1px solid rgba(56,225,255,.35); border-radius: 999px; padding: 4px 10px; font-size: 13px; }
#cCrumb button, #cSide button, #cBar button, #cPair button, #cKeys button { font: inherit; color: #d9f6ff; background: #10263a; border: 1px solid rgba(56,225,255,.45); border-radius: 10px; padding: 7px 12px; }
#cCrumb button.primary, #cBar button.primary, #cPair button.primary { background: #1b8fb5; border-color: #38e1ff; font-weight: 700; }
#cSide { position: fixed; top: calc(96px + env(safe-area-inset-top)); right: 10px; width: 250px; max-height: calc(100vh - 220px); overflow: auto; background: rgba(6,16,26,.88); border: 1px solid rgba(56,225,255,.3); border-radius: 14px; padding: 10px; }
#cSide h3 { margin: 6px 0; font-size: 14px; color: #38e1ff; }
#cSide .lin { display: flex; align-items: center; gap: 6px; margin: 4px 0; font-size: 13px; }
#cSide .lin span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cSide .muted, #cBar .muted { color: #8fa7b8; font-size: 12px; }
#cHud { position: fixed; top: calc(96px + env(safe-area-inset-top)); left: 12px; max-width: 46vw; background: rgba(6,16,26,.82); border: 1px solid rgba(157,255,92,.35); border-radius: 12px; padding: 8px 12px; white-space: pre-line; }
#cHud:empty { display: none; }
#cBar { position: fixed; left: 10px; right: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); display: flex; gap: 6px; align-items: center; background: rgba(6,16,26,.9); border: 1px solid rgba(56,225,255,.35); border-radius: 14px; padding: 8px; }
#cBar input { flex: 1; min-width: 0; font: inherit; font-size: 16px; color: #e6f7ff; background: #071420; border: 1px solid rgba(56,225,255,.3); border-radius: 10px; padding: 9px 10px; }
#cBar #cMic.on { background: #b5361b; border-color: #ff8a6b; }
#cMode { white-space: nowrap; }
#cJob { position: fixed; left: 10px; right: 10px; bottom: calc(70px + env(safe-area-inset-bottom)); display: flex; gap: 8px; align-items: center; background: rgba(8,22,34,.92); border: 1px solid rgba(255,209,102,.45); border-radius: 12px; padding: 8px 12px; }
#cJob[hidden] { display: none; }
#cJob .txt { flex: 1; white-space: pre-line; }
#cPair { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: grid; place-items: center; }
#cPair[hidden] { display: none; }
#cPair .card { width: min(560px, 94vw); background: #08121f; border: 1px solid rgba(56,225,255,.45); border-radius: 16px; padding: 16px 18px; }
#cPair code, #cPair pre { background: #03101a; border: 1px solid rgba(56,225,255,.25); border-radius: 8px; padding: 6px 8px; display: block; white-space: pre-wrap; word-break: break-all; font-size: 13px; }
#cPair .code { font-size: 28px; letter-spacing: 4px; color: #fff36b; font-weight: 800; }
#cKeys { position: fixed; right: 10px; bottom: calc(130px + env(safe-area-inset-bottom)); display: grid; grid-template-columns: repeat(3, 46px); gap: 6px; }
#cKeys button { padding: 10px 0; font-size: 18px; }
@media (max-width: 760px) { #cSide { top: auto; bottom: calc(130px + env(safe-area-inset-bottom)); left: 10px; right: 160px; width: auto; max-height: 30vh; } #cHud { max-width: 60vw; } }
body.headset #cUi { display: none !important; }
`;

export function createCreation({ THREE, scene, camera, controls, renderer, toast = () => {}, isTouch = false, win = window, doc = document }) {
  const root = new THREE.Group();
  root.name = 'creation-items';
  scene.add(root);
  const portalsG = new THREE.Group();
  portalsG.name = 'creation-portals';
  scene.add(portalsG);
  const selRing = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.03, 8, 48), new THREE.MeshBasicMaterial({ color: 0x9dff5c }));
  selRing.rotation.x = Math.PI / 2;
  selRing.visible = false;
  scene.add(selRing);

  let host = null;
  let me = null;
  let world = null; // { id, parentId, name, revision, items, portals, path }
  const live = new Map(); // item.id → { item, hostId, key, lineage, version, name, broken }
  const pkgs = new Map(); // key → { code, manifest }
  let lineages = [];
  let selected = null;
  let mode = 'new'; // new｜modify
  const jobs = new Map(); // jobId → { job, kind, context, utteranceId, done }
  const huds = new Map(); // hostId → lines
  const errorsOf = new Map(); // hostId → message（換版觀察期用）
  const watching = new Map(); // lineage → { until, olds: [{ itemId, hostId, key, version, snap }], newKey, job }
  let simT = 0;
  let acc = 0;
  let lastSave = 0;
  let saving = null;
  let busy = false; // 進出世界中
  const keys = { left: false, right: false, up: false, down: false, action: false };
  const tappedAt = { left: -1e9, right: -1e9, up: -1e9, down: -1e9, action: -1e9 }; // 按下的時間：快速點按也至少算按住 120 ms（沙盒忙的那一步不會吃掉）
  const stats = { swaps: 0, rejected: 0, rollbacks: 0, enters: 0, saves: 0, conflicts: 0, placed: 0 };
  const listeners = [];
  const on = (el, ev, fn, opt) => {
    el.addEventListener(ev, fn, opt);
    listeners.push(() => el.removeEventListener(ev, fn, opt));
  };

  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
    return data;
  }

  // ---------------- 介面 ----------------
  const st = doc.createElement('style');
  st.textContent = CSS;
  doc.head.appendChild(st);
  const ui = doc.createElement('div');
  ui.id = 'cUi';
  ui.innerHTML = `
    <div id="cCrumb"></div>
    <div id="cHud"></div>
    <aside id="cSide">
      <h3>🔌 我的 Codex</h3>
      <div id="cConn" class="muted">檢查中…</div>
      <button id="cPairBtn">連接我的 Codex</button>
      <h3>🌀 這一層</h3>
      <button id="cChild">＋ 開一個子世界</button>
      <div id="cPortals" class="muted"></div>
      <h3>🧩 作品庫（大家做的）</h3>
      <div id="cLib" class="muted">載入中…</div>
    </aside>
    <div id="cJob" hidden><div class="txt"></div><button id="cJobCancel">取消</button></div>
    <div id="cBar">
      <button id="cMode" title="做一個新作品，或改選取的作品">✨ 新作品</button>
      <input id="cInput" placeholder="說或打你想玩的：例如「做一個會追著我跑的球，被追到就扣分」" autocomplete="off" />
      <button id="cMic" title="用說的（開始／說完）">🎙</button>
      <button id="cSend" class="primary">送出</button>
    </div>
    <div id="cKeys" ${isTouch ? '' : 'hidden'}>
      <span></span><button data-k="up">▲</button><span></span>
      <button data-k="left">◀</button><button data-k="action">⚡</button><button data-k="right">▶</button>
      <span></span><button data-k="down">▼</button><span></span>
    </div>
    <div id="cPair" hidden><div class="card">
      <h2>🔌 連接我的 Codex</h2>
      <p>作品是用<b>你自己的</b> Codex 做的（用你自己的登入和額度）；遊戲伺服器只收做好的作品程式，拿不到你的 Codex 登入。</p>
      <p>在<b>你的電腦</b>（要裝好 Node 20+，並已經 <code style="display:inline">codex login</code>）開終端機，到這個專案資料夾執行：</p>
      <pre id="cPairCmd"></pre>
      <p>配對碼（10 分鐘內有效）：<span class="code" id="cPairCode">……</span></p>
      <p class="muted">第一版需要電腦跑 connector，iPhone 不能單獨完成；做好的作品之後就算 connector 關掉也照樣能玩。</p>
      <button id="cPairClose" class="primary">好了</button>
    </div></div>`;
  doc.body.appendChild(ui);
  const $ = (s) => ui.querySelector(s);

  function setJobText(text, { cancel = false, warn = false } = {}) {
    const box = $('#cJob');
    box.hidden = !text;
    box.querySelector('.txt').textContent = text || '';
    box.style.borderColor = warn ? 'rgba(255,120,90,.7)' : 'rgba(255,209,102,.45)';
    lastStatus = text || '';
    $('#cJobCancel').hidden = !cancel;
    onStatus?.(text);
  }
  let onStatus = null; // 眼鏡模式的 HUD 也要知道

  function renderCrumb() {
    const c = $('#cCrumb');
    const parts = (world?.path || []).map((p, i, a) => `<span class="crumb">${i === a.length - 1 ? '📍 ' : ''}${esc(p.name)}</span>`).join('<span>›</span>');
    c.innerHTML = `${world?.parentId ? '<button id="cUp" class="primary">⬑ 回上一層</button>' : ''}${parts}<span class="crumb">第 ${world?.depth ?? 0} 層</span>`;
    c.querySelector('#cUp')?.addEventListener('click', () => goUp());
  }
  function renderLib() {
    const box = $('#cLib');
    if (!lineages.length) {
      box.innerHTML = '還沒有作品。說出你想玩的東西，用你的 Codex 做第一個！';
      return;
    }
    box.innerHTML = lineages
      .map((L) => `<div class="lin"><span title="${esc(L.creatorName)}">${esc(L.name)} <small>v${L.latestGood ?? L.latest} · ${esc(L.creatorName)}</small></span><button data-place="${L.id}">放一個</button></div>`)
      .join('');
    box.querySelectorAll('[data-place]').forEach((b) =>
      b.addEventListener('click', () => {
        const L = lineages.find((x) => x.id === b.dataset.place);
        if (L) placeNew(L.id, L.latestGood ?? L.latest).catch((e) => toast(`放不上去：${e.message}`));
      }),
    );
  }
  function renderPortals() {
    $('#cPortals').innerHTML = (world?.portals || []).map((p) => `<div class="lin"><span>🌀 ${esc(p.name)}</span><button data-enter="${p.world}">進入</button></div>`).join('') || '這層還沒有子世界';
    $('#cPortals').querySelectorAll('[data-enter]').forEach((b) => b.addEventListener('click', () => enter(b.dataset.enter)));
  }
  async function refreshConnector() {
    try {
      const s = await api('GET', '/api/connector/status');
      $('#cConn').textContent = s.online ? `已連上（${s.label || 'connector'}）：用你自己的 Codex` : s.paired ? '已配對，但 connector 沒在跑（在電腦上執行 run）' : '還沒連接：作品要用你自己的 Codex 做';
      me.connector = s;
    } catch {
      /* 離線 */
    }
  }
  function renderHud() {
    const box = $('#cHud');
    const L = selected && live.get(selected);
    if (!L) {
      box.textContent = '';
      return;
    }
    const lines = huds.get(L.hostId) || [];
    box.textContent = `${L.broken ? '⚠️ ' : ''}${L.name} v${L.version}${L.broken ? '（壞掉了，已停止）' : ''}\n${lines.join('\n')}`;
  }

  // ---------------- 作品與實例 ----------------
  const keyOf = (lineage, version) => `${lineage}@${version}`;
  async function loadPkg(lineage, version) {
    const key = keyOf(lineage, version);
    if (!pkgs.has(key)) {
      const [code, manifest] = await Promise.all([
        fetch(`/pkg/${lineage}/${version}/main.js`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`作品 ${key} 讀不到`)))),
        fetch(`/pkg/${lineage}/${version}/manifest.json`).then((r) => r.json()),
      ]);
      pkgs.set(key, { code, manifest });
    }
    const p = pkgs.get(key);
    const r = await host.load(key, p.code, p.manifest);
    if (r && r.ok === false) throw new Error(r.error || `作品 ${key} 載入失敗`);
    return { key, ...p };
  }
  function nextSpot() {
    const used = [...live.values()].map((x) => x.item.pos);
    for (let r = 0; r < 6; r += 1) {
      const n = Math.max(1, r * 6);
      for (let k = 0; k < n; k += 1) {
        const a = (k / n) * Math.PI * 2;
        const p = [Math.round(Math.sin(a) * r * 3.2 * 100) / 100, 0, Math.round(-Math.cos(a) * r * 3.2 * 100) / 100 - (r === 0 ? 0 : 0)];
        if (!used.some((u) => Math.hypot(u[0] - p[0], u[2] - p[2]) < 2.6)) return p;
      }
    }
    return [Math.random() * 10 - 5, 0, Math.random() * 10 - 5];
  }
  async function spawnItem(item, { fresh = false } = {}) {
    const { key, manifest } = await loadPkg(item.lineage, item.version);
    const hostId = `${item.id}@v${item.version}`;
    const r = await host.spawn(hostId, key, fresh || item.state == null ? { params: { seed: Math.floor(Math.random() * 1e9) } } : { state: item.state, fromSchema: item.schema ?? manifest.stateSchema, rng: item.rng ?? undefined });
    const name = manifest.name || item.lineage;
    live.set(item.id, { item, hostId, key, lineage: item.lineage, version: item.version, name, broken: !r.ok });
    host.setTransform(hostId, item.pos, item.rotY || 0);
    if (!r.ok) toast(`⚠️ ${name} v${item.version} 起不來：${r.error}`);
    return r.ok;
  }
  async function placeNew(lineage, version, worldId = world.id) {
    const item = { id: uid('i'), lineage, version, pos: nextSpot(), rotY: 0, state: null, schema: null };
    if (worldId !== world.id) {
      // 不在那一層：直接加進那一層的存檔（下次進去才執行）
      const w = (await api('GET', `/api/cworlds/${worldId}`)).world;
      await api('PUT', `/api/cworlds/${worldId}`, { baseRevision: w.revision, items: [...w.items, item] });
      toast(`「${lineages.find((l) => l.id === lineage)?.name || '新作品'}」放進〈${w.name}〉了`);
      return null;
    }
    world.items.push(item);
    await spawnItem(item, { fresh: true });
    select(item.id);
    stats.placed += 1;
    await saveWorld();
    return item.id;
  }
  function select(id) {
    selected = id && live.has(id) ? id : null;
    const L = selected && live.get(selected);
    selRing.visible = !!L;
    if (L) selRing.position.set(L.item.pos[0], 0.02, L.item.pos[2]);
    if (!selected && mode === 'modify') setMode('new');
    renderHud();
  }
  function setMode(m) {
    mode = m === 'modify' && selected ? 'modify' : 'new';
    $('#cMode').textContent = mode === 'modify' ? `✏️ 改「${live.get(selected)?.name || ''}」` : '✨ 新作品';
  }

  // ---------------- 世界：進入、返回、存檔 ----------------
  async function saveWorld() {
    if (!world || saving) return saving;
    saving = (async () => {
      try {
        for (const L of live.values()) {
          if (L.broken) continue;
          try {
            const s = await host.snapshot(L.hostId);
            L.item.state = s.state;
            L.item.schema = s.schema;
            L.item.rng = Number.isInteger(s.rng) ? s.rng : null; // 亂數接續（存檔重開一致）
          } catch {
            /* 這一次拿不到就沿用上次的 */
          }
        }
        const items = world.items.map((it) => ({ id: it.id, lineage: it.lineage, version: it.version, pos: it.pos, rotY: it.rotY || 0, state: it.state ?? null, schema: it.schema ?? null, rng: it.rng ?? null }));
        const r = await api('PUT', `/api/cworlds/${world.id}`, { baseRevision: world.revision, items });
        world.revision = r.revision;
        stats.saves += 1;
        lastSave = performance.now();
      } catch (e) {
        if (e.status === 409) {
          stats.conflicts += 1;
          toast('⚠️ 這一層剛被別人改過，重新載入這一層（你這幾秒的變化沒有存）');
          await enter(world.id, { save: false });
        } else toast(`⚠️ 存檔失敗：${e.message}`);
      } finally {
        saving = null;
      }
    })();
    return saving;
  }
  function unloadWorld() {
    for (const L of live.values()) host.kill(L.hostId);
    const keysNow = new Set([...live.values()].map((L) => L.key));
    live.clear();
    huds.clear();
    for (const k of keysNow) host.unload(k);
    for (const w of watching.values()) for (const o of w.olds) host.unload(o.key);
    watching.clear();
    for (const o of [...portalsG.children]) {
      portalsG.remove(o);
      o.traverse((x) => {
        x.geometry?.dispose?.();
        x.material?.map?.dispose?.();
        x.material?.dispose?.();
      });
    }
    select(null);
  }
  function buildPortals() {
    for (const p of world.portals || []) {
      const g = new THREE.Group();
      g.userData.portal = p.world;
      g.position.set(...p.pos);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.07, 12, 48), new THREE.MeshStandardMaterial({ color: 0x38e1ff, emissive: 0x1b8fb5, emissiveIntensity: 1.2 }));
      ring.position.y = 1.0;
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.74, 40), new THREE.MeshBasicMaterial({ color: 0x0b3a52, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
      disc.position.y = 1.0;
      const c = doc.createElement('canvas');
      c.width = 512;
      c.height = 96;
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(4,14,26,.85)';
      ctx.fillRect(0, 0, 512, 96);
      ctx.fillStyle = '#d9f6ff';
      ctx.font = "600 44px -apple-system, 'PingFang TC', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`🌀 ${p.name}`, 256, 50);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.3), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      label.position.y = 2.05;
      g.add(ring, disc, label);
      portalsG.add(g);
    }
  }
  async function enter(worldId, { save = true } = {}) {
    if (busy) return;
    busy = true;
    try {
      if (world && save) await saveWorld();
      const w = (await api('GET', `/api/cworlds/${worldId}`)).world;
      unloadWorld();
      world = w;
      for (const it of world.items) {
        try {
          await spawnItem(it);
        } catch (e) {
          toast(`⚠️ 載入 ${it.lineage} 失敗：${e.message}`);
        }
      }
      buildPortals();
      renderCrumb();
      renderPortals();
      stats.enters += 1;
      win.history.replaceState(null, '', worldId === 'root' ? '/?create' : `/?create&w=${encodeURIComponent(worldId)}`);
      applyPending();
    } finally {
      busy = false;
    }
  }
  function goUp() {
    if (world?.parentId) enter(world.parentId);
  }
  async function createChild() {
    const name = (win.prompt?.('子世界的名字', `${world.name} 的子世界`) || '').trim() || `${world.name} 的子世界`;
    await saveWorld();
    const pos = [((world.portals.length % 5) - 2) * 2.4, 0, -6];
    const r = await api('POST', '/api/cworlds', { parentId: world.id, name, pos, baseRevision: world.revision });
    world.revision = r.parent.revision;
    world.portals = r.parent.portals;
    for (const o of [...portalsG.children]) portalsG.remove(o);
    buildPortals();
    renderPortals();
    toast(`開好了：〈${r.world.name}〉，走進傳送門（或按「進入」）就能在裡面創作`);
    return r.world.id;
  }

  // ---------------- 創作：說／打 → 自己的 Codex → 換上 ----------------
  function captureContext() {
    const L = selected && live.get(selected);
    return {
      worldId: world.id,
      worldRevision: world.revision,
      selected: selected ? [selected] : [],
      targetLineage: mode === 'modify' && L ? L.lineage : null,
      baseVersion: mode === 'modify' && L ? L.version : null,
      targetItem: mode === 'modify' && L ? selected : null,
    };
  }
  async function submit(intent, { source = 'text', utteranceId = uid('utt'), context = captureContext() } = {}) {
    intent = String(intent || '').trim();
    if (!intent) return null;
    const r = await api('POST', '/api/create', { utteranceId, intent, source, worldId: context.worldId, selected: context.selected, targetLineage: context.targetLineage, baseVersion: context.baseVersion });
    if (!jobs.has(r.job.id)) jobs.set(r.job.id, { job: r.job, context, kind: context.targetLineage ? 'modify' : 'new', utteranceId, done: false });
    if (!r.connector?.paired) setJobText(`「${intent}」排隊中：還沒連接你自己的 Codex。按右邊「連接我的 Codex」，在你的電腦執行 connector 後就會開始做（不會借用別人的 Codex）`, { cancel: true, warn: true });
    else if (!r.connector.online) setJobText(`「${intent}」排隊中：你的 connector 沒在跑（在電腦上執行 run）`, { cancel: true, warn: true });
    else setJobText(`「${intent}」交給你的 Codex 了…`, { cancel: true });
    $('#cInput').value = '';
    pollJobs();
    return r.job;
  }
  let polling = false;
  async function pollJobs() {
    if (polling) return;
    polling = true;
    try {
      while ([...jobs.values()].some((j) => !j.done)) {
        for (const J of jobs.values()) {
          if (J.done) continue;
          let r;
          try {
            r = await api('GET', `/api/create/${J.job.id}`);
          } catch {
            continue;
          }
          const j = r.job;
          J.job = j;
          const last = j.messages?.[j.messages.length - 1]?.text || '';
          if (j.status === 'queued') setJobText(`「${j.intent}」排隊中${r.connector?.online ? '' : '（connector 沒在跑）'}${j.diagnostics ? `\n上次的問題：${j.diagnostics[0]}` : ''}`, { cancel: true, warn: !r.connector?.online });
          else if (j.status === 'working') setJobText(`你的 Codex 正在做「${j.intent}」…${last ? `\n${last}` : ''}`, { cancel: true });
          else if (j.status === 'needs-fix') setJobText(`第 ${j.attempts} 版沒通過試跑，你的 Codex 正在修…\n${(j.diagnostics || [])[0] || ''}`, { cancel: true });
          else if (j.status === 'built') {
            J.done = true;
            await onBuilt(J);
          } else if (['failed', 'cancelled', 'conflict'].includes(j.status)) {
            J.done = true;
            const why = j.status === 'conflict' ? (j.diagnostics || [])[0] : j.status === 'cancelled' ? '已取消' : `沒做成：${last || (j.diagnostics || [])[0] || ''}`;
            setJobText(`「${j.intent}」${why}`, { warn: j.status !== 'cancelled' });
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    } finally {
      polling = false;
    }
  }
  async function onBuilt(J) {
    const j = J.job;
    lineages = (await api('GET', '/api/lineages')).lineages;
    renderLib();
    const name = lineages.find((l) => l.id === j.lineage)?.name || '新作品';
    if (J.kind === 'new') {
      await placeNew(j.lineage, j.version, J.context.worldId);
      setJobText(`完成：「${name}」v${j.version}（你的 Codex，${j.attempts} 輪）${J.context.worldId === world.id ? '——已經放在你面前' : ''}`);
    } else if (J.context.worldId === world.id) {
      setJobText(`「${name}」v${j.version} 做好了：先試跑再換上…`);
      const r = await swapLineage(j.lineage, j.version, J);
      if (r?.ok && r.swapped) setJobText(`已換上「${name}」v${j.version}（狀態保留；3 秒內出錯會自動退回）`);
      else if (r?.ok) setJobText(`「${name}」v${j.version} 做好了（這一層沒有舊版要換）`);
    } else {
      addPending(J.context.worldId, j.lineage, j.version, j.id);
      setJobText(`「${name}」v${j.version} 做好了：回到原本那一層才會換上（說話時你在那一層）`);
    }
  }
  const PENDING = 'vw_create_pending';
  function addPending(worldId, lineage, version, jobId) {
    const list = JSON.parse(win.localStorage.getItem(PENDING) || '[]');
    list.push({ worldId, lineage, version, jobId });
    win.localStorage.setItem(PENDING, JSON.stringify(list.slice(-50)));
  }
  function applyPending() {
    const list = JSON.parse(win.localStorage.getItem(PENDING) || '[]');
    const mine = list.filter((x) => x.worldId === world.id);
    if (!mine.length) return;
    win.localStorage.setItem(PENDING, JSON.stringify(list.filter((x) => x.worldId !== world.id)));
    for (const p of mine) swapLineage(p.lineage, p.version, { job: { id: p.jobId } });
  }

  // 換版：影子試跑 → 同一格切換 → 觀察 → 收掉舊版（或退回）
  async function swapLineage(lineage, version, J) {
    const targets = [...live.values()].filter((L) => L.lineage === lineage && L.version < version && !L.broken);
    if (!targets.length) return { ok: true, swapped: 0 };
    let newPkg;
    try {
      newPkg = await loadPkg(lineage, version);
    } catch (e) {
      return reject(`新版讀不到：${e.message}`);
    }
    // 1. 影子試跑：用每個實例「現在的存檔」跑 migrate＋30 步（不畫、不影響世界）
    for (const L of targets) {
      const snap = await host.snapshot(L.hostId);
      const sid = `${L.item.id}@shadow${version}`;
      const r = await host.spawn(sid, newPkg.key, { state: snap.state, fromSchema: snap.schema, hidden: true });
      const t = r.ok ? await host.tickHidden(sid, 30, TICK) : r;
      host.kill(sid);
      if (!t.ok) return reject(`影子試跑沒過：${t.error}`);
    }
    // 2. 切換：拿最後的存檔交給新版（同一個實例 id、同一個位置；舊的先藏起來，新的出來再收）
    const olds = [];
    for (const L of targets) {
      const snap = await host.snapshot(L.hostId);
      const old = { itemId: L.item.id, hostId: L.hostId, key: L.key, version: L.version, snap };
      const g = root.children.find((c) => c.userData.instId === L.hostId);
      if (g) g.visible = false;
      const hostId = `${L.item.id}@v${version}`;
      const r = await host.spawn(hostId, newPkg.key, { state: snap.state, fromSchema: snap.schema, rng: snap.rng });
      if (!r.ok) {
        if (g) g.visible = true;
        return reject(`切換時起不來：${r.error}`);
      }
      host.setTransform(hostId, L.item.pos, L.item.rotY || 0);
      host.kill(L.hostId);
      Object.assign(L, { hostId, key: newPkg.key, version, name: newPkg.manifest.name || L.name });
      L.item.version = version;
      olds.push(old);
    }
    stats.swaps += 1;
    watching.set(lineage, { until: performance.now() + SWAP_WATCH_MS, olds, newKey: newPkg.key, job: J?.job, version });
    renderHud();
    saveWorld();
    toast(`🔁 換上 v${version}（狀態保留）`);
    return { ok: true, swapped: olds.length };

    function reject(message) {
      stats.rejected += 1;
      if (!live.size || ![...live.values()].some((L) => L.key === newPkg?.key)) newPkg && host.unload(newPkg.key);
      if (J?.job?.id) api('POST', `/api/create/${J.job.id}/runtime-fail`, { message }).then(() => {
        const JJ = jobs.get(J.job.id);
        if (JJ) {
          JJ.done = false;
          pollJobs();
        }
      }, () => {});
      setJobText(`新版 v${version} ${message}\n舊版照常在玩；已經請你的 Codex 修正`, { warn: true });
      return { ok: false, error: message };
    }
  }
  // 觀察期：新版出錯就退回舊版（切換當下的狀態）
  async function rollback(lineage, why) {
    const w = watching.get(lineage);
    if (!w) return;
    watching.delete(lineage);
    stats.rollbacks += 1;
    for (const o of w.olds) {
      const L = live.get(o.itemId);
      if (!L) continue;
      host.kill(L.hostId);
      await host.load(o.key, pkgs.get(o.key).code, pkgs.get(o.key).manifest);
      const r = await host.spawn(o.hostId, o.key, { state: o.snap.state, fromSchema: o.snap.schema });
      host.setTransform(o.hostId, L.item.pos, L.item.rotY || 0);
      Object.assign(L, { hostId: o.hostId, key: o.key, version: o.version, broken: !r.ok });
      L.item.version = o.version;
    }
    host.unload(w.newKey);
    // 診斷回到同一個工作：同一位創作者的 connector 會再修，修好會自動再換一次
    if (w.job?.id)
      api('POST', `/api/create/${w.job.id}/runtime-fail`, { message: why }).then(() => {
        const JJ = jobs.get(w.job.id);
        if (JJ) {
          JJ.done = false;
          pollJobs();
        }
      }, () => {});
    setJobText(`v${w.version} 換上後出錯（${why}），已退回 v${w.olds[0]?.version} 和換版當下的狀態`, { warn: true });
    saveWorld();
  }
  function finishWatches(now) {
    for (const [lineage, w] of watching) {
      if (now < w.until) continue;
      watching.delete(lineage);
      for (const o of w.olds) if (![...live.values()].some((L) => L.key === o.key)) host.unload(o.key); // 觀察期過了才放掉舊版 Worker
    }
  }

  // ---------------- 輸入 ----------------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = null;
  on(renderer.domElement, 'pointerdown', (e) => {
    downAt = { x: e.clientX, y: e.clientY };
  });
  on(renderer.domElement, 'pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
    downAt = null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    clickRay(ray);
  });
  function clickRay(rc, by = 'pointer') {
    const ph = rc.intersectObjects(portalsG.children, true)[0];
    const hit = host?.pick(rc);
    if (ph && (!hit || ph.distance <= (hit.distance ?? Infinity))) {
      let o = ph.object;
      while (o && !o.userData.portal) o = o.parent;
      if (o) enter(o.userData.portal);
      return { portal: o?.userData.portal };
    }
    if (!hit) {
      select(null);
      return null;
    }
    const itemId = [...live.values()].find((L) => L.hostId === hit.instId)?.item.id;
    if (itemId) select(itemId);
    host.event(hit.instId, { type: 'click', target: hit.entityId, by });
    return hit;
  }
  const KEYMAP = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ' ': 'action' };
  on(win, 'keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const k = KEYMAP[e.key];
    if (k) {
      keys[k] = true;
      tappedAt[k] = performance.now();
      e.preventDefault();
    }
  });
  on(win, 'keyup', (e) => {
    const k = KEYMAP[e.key];
    if (k) keys[k] = false;
  });
  ui.querySelectorAll('#cKeys [data-k]').forEach((b) => {
    const k = b.dataset.k;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      keys[k] = true;
      tappedAt[k] = performance.now();
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, () => (keys[k] = false));
  });

  // ---------------- 語音（接續工坊的 SpeechRecognition，見 voice.mjs） ----------------
  let voiceText = '';
  const voice = createVoice({
    onPartial: (u, text) => {
      voiceText = text;
      $('#cInput').value = text;
      setJobText(`🎙 聽到：${text}`, { cancel: true });
    },
    onState: (s) => {
      $('#cMic').classList.toggle('on', s === 'listening');
      onVoiceState?.(s);
    },
    onFinal: (u, text) => {
      voiceText = '';
      submit(text, { source: 'voice', utteranceId: u.id, context: u.context }).catch((e) => setJobText(`送不出去：${e.message}`, { warn: true }));
    },
    onError: (code, msg) => msg && setJobText(`🎙 ${msg}`, { warn: true }),
  });
  let onVoiceState = null;
  function toggleVoice() {
    if (voice.listening) voice.stop();
    else voice.start(captureContext());
    return voice.listening;
  }
  if (!voice.supported) $('#cMic').title = voice.reason === 'insecure' ? '語音要 https 或電腦本機；請改用打字' : '這個瀏覽器不支援語音；請改用打字';

  // ---------------- 按鈕 ----------------
  $('#cSend').onclick = () => submit($('#cInput').value).catch((e) => setJobText(`送不出去：${e.message}`, { warn: true }));
  $('#cInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      $('#cSend').click();
    }
  });
  $('#cMic').onclick = () => {
    if (!voice.supported) {
      setJobText(voice.reason === 'insecure' ? '🎙 語音要安全連線（https 或這台電腦本機），請改用打字' : '🎙 這個瀏覽器不支援語音，請改用打字', { warn: true });
      return;
    }
    toggleVoice();
  };
  $('#cMode').onclick = () => {
    if (!selected) {
      toast('先點一下要改的作品');
      return setMode('new');
    }
    setMode(mode === 'new' ? 'modify' : 'new');
  };
  $('#cJobCancel').onclick = () => {
    if (voice.listening) {
      voice.cancel();
      setJobText('');
      return;
    }
    for (const J of jobs.values()) if (!J.done) api('POST', `/api/create/${J.job.id}/cancel`, {}).catch(() => {});
  };
  $('#cChild').onclick = () => createChild().catch((e) => toast(`開不了子世界：${e.message}`));
  $('#cPairBtn').onclick = async () => {
    try {
      const r = await api('POST', '/api/connector/code', {});
      $('#cPairCode').textContent = r.code;
      const origin = win.location.origin;
      $('#cPairCmd').textContent = `node connector/vibe-connector.mjs pair ${origin} ${r.code}\nnode connector/vibe-connector.mjs run ${origin}`;
      $('#cPair').hidden = false;
    } catch (e) {
      toast(`拿不到配對碼：${e.message}`);
    }
  };
  $('#cPairClose').onclick = () => {
    $('#cPair').hidden = true;
    refreshConnector();
  };

  // ---------------- 每格 ----------------
  const local = new THREE.Vector3();
  function update(dt) {
    if (!host || !world || busy) return;
    acc = Math.min(acc + dt, 0.25);
    const now = performance.now();
    while (acc >= TICK) {
      acc -= TICK;
      simT += TICK;
      const inputs = {};
      const k = {};
      for (const n of Object.keys(keys)) k[n] = keys[n] || now - tappedAt[n] < 120;
      for (const L of live.values()) {
        if (L.broken) continue;
        local.copy(camera.position).sub(new THREE.Vector3(...L.item.pos));
        inputs[L.hostId] = { t: simT, keys: k, player: { x: local.x, y: local.y, z: local.z } };
      }
      host.tick(TICK, inputs);
    }
    finishWatches(now);
    if (now - lastSave > SAVE_EVERY_MS && live.size) saveWorld();
    if (selected) {
      const L = live.get(selected);
      if (L) selRing.position.set(L.item.pos[0], 0.02 + Math.sin(now / 300) * 0.01, L.item.pos[2]);
    }
    for (const g of portalsG.children) g.children[0].rotation.z += dt * 0.8;
  }

  async function init() {
    me = await api('POST', '/api/me', {});
    host = createSandboxHost({
      THREE,
      root,
      doc,
      onHud: (instId, lines) => {
        huds.set(instId, lines || []);
        if (selected && live.get(selected)?.hostId === instId) renderHud();
      },
      onError: (instId, message, info) => {
        const L = [...live.values()].find((x) => x.hostId === instId);
        if (!L) return;
        if (info?.fatal === false) {
          // 格式小問題（例如實體超量被截掉）：作品照常在跑，只提示一次
          toast(`⚠️ ${L.name}：${message}`);
          return;
        }
        const w = watching.get(L.lineage);
        if (w && L.version === w.version) {
          rollback(L.lineage, message);
          return;
        }
        L.broken = true;
        toast(`⚠️ ${L.name} v${L.version} 出錯，已停止：${message}`);
        renderHud();
      },
    });
    await host.ready();
    lineages = (await api('GET', '/api/lineages')).lineages;
    renderLib();
    refreshConnector();
    setInterval(refreshConnector, 15000);
    controls.target.set(0, 0.8, 0);
    camera.position.set(0, 3.2, 8.5);
    const w = new URLSearchParams(win.location.search).get('w') || 'root';
    await enter(w, { save: false }).catch(() => enter('root', { save: false }));
    on(win, 'pagehide', () => saveWorld());
  }

  // 眼鏡模式：手指著哪裡（實體或傳送門）、捏下去＝點它、HUD 上顯示說話與工作狀態
  const _pt = new THREE.Vector3();
  function pickRay(rc) {
    const hit = host?.pick(rc);
    const ph = rc.intersectObjects(portalsG.children, true)[0];
    if (ph && (!hit || ph.distance <= (hit.distance ?? Infinity))) {
      let o = ph.object;
      while (o && !o.userData.portal) o = o.parent;
      if (o) return { inst: { id: `portal:${o.userData.portal}`, name: '傳送門', portal: o.userData.portal }, point: ph.point.clone() };
    }
    if (!hit) return null;
    const L = [...live.values()].find((x) => x.hostId === hit.instId);
    return { inst: { id: hit.instId, name: L?.name || '作品', entityId: hit.entityId, itemId: L?.item.id }, point: Array.isArray(hit.point) ? new THREE.Vector3().fromArray(hit.point) : rc.ray.at(hit.distance ?? 3, _pt).clone() };
  }
  function pinch(hover) {
    if (!hover?.inst) return false;
    if (hover.inst.portal) {
      enter(hover.inst.portal);
      return true;
    }
    if (hover.inst.itemId) select(hover.inst.itemId);
    host.event(hover.inst.id, { type: 'click', target: hover.inst.entityId, by: 'hand' });
    return true;
  }
  let lastStatus = '';
  function headsetLines() {
    if (voice.listening) return [`🎙 聽到：${voiceText || '（說吧）'}`, '說完會自動送出；點一下螢幕停止'];
    return [lastStatus.split('\n')[0] || (voice.supported ? '點一下螢幕說出想玩的東西' : '這裡不能用語音（要 https）'), selected ? `選取：${live.get(selected)?.name || ''}（說「把這個改成…」）` : ''].filter(Boolean);
  }

  return {
    init,
    update,
    enter,
    pickRay,
    pinch,
    headsetLines,
    goUp,
    createChild,
    submit,
    placeNew,
    swapLineage,
    toggleVoice,
    clickRay,
    voice,
    select,
    setMode,
    saveWorld,
    get world() {
      return world;
    },
    get selected() {
      return selected;
    },
    set onStatus(fn) {
      onStatus = fn;
    },
    set onVoiceState(fn) {
      onVoiceState = fn;
    },
    get voiceText() {
      return voiceText;
    },
    // 測試／診斷
    state() {
      return {
        me,
        world: world && { id: world.id, name: world.name, depth: world.depth, revision: world.revision, portals: world.portals.length, items: world.items.length },
        live: [...live.values()].map((L) => ({ id: L.item.id, hostId: L.hostId, lineage: L.lineage, version: L.version, name: L.name, broken: L.broken, hud: huds.get(L.hostId) || [] })),
        jobs: [...jobs.values()].map((J) => ({ id: J.job.id, status: J.job.status, kind: J.kind, worldId: J.context.worldId, attempts: J.job.attempts, lineage: J.job.lineage, version: J.job.version })),
        watching: [...watching.keys()],
        host: host?.stats(),
        stats: { ...stats },
        selected,
        mode,
      };
    },
    host: () => host,
  };
}
