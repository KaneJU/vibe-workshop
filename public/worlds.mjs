// 世界模組管理（瀏覽器）：載入 /world/<id>.js、啟用／停用、換版失敗退回上一版、安全模式、存狀態、畫「世界」分頁。
import { createWorldHost } from './worldhost.mjs';

const TYPE_LABEL = { environment: '環境', rule: '規則' };

export function createWorldManager({ THREE, root, env, objects, supportBelow, player, vehicle, physics, hudEl, listEl, safeBtn, resetBtn, toast, api, forceSafe }) {
  let modules = [];
  let state = { environment: null, rules: [], safeMode: false };
  const loaded = new Map();
  const huds = new Map();

  function renderHud() {
    const lines = [...huds.values()].filter(Boolean);
    hudEl.hidden = lines.length === 0;
    hudEl.textContent = lines.join('　·　');
  }

  const host = createWorldHost({
    THREE,
    root,
    env,
    objects,
    supportBelow,
    player,
    vehicle,
    physics,
    hud: (id, text) => {
      if (text) huds.set(id, text);
      else huds.delete(id);
      renderHud();
    },
    toast,
    onError: (rec, err, why) => handleError(rec, err, why),
    now: () => performance.now(),
  });

  const byId = (id) => modules.find((m) => m.id === id);
  async function load(id) {
    if (!loaded.has(id)) loaded.set(id, await import(`/world/${id}.js`));
    return loaded.get(id);
  }
  function save() {
    api('PUT', '/api/world-state', state).catch((e) => toast(`⚠️ 世界狀態存檔失敗：${e.message}`));
  }
  function markInactive(id) {
    state.rules = state.rules.filter((x) => x !== id);
    if (state.environment === id) state.environment = null;
  }
  function markActive(rec) {
    if (rec.type === 'environment') state.environment = rec.id;
    else if (!state.rules.includes(rec.id)) state.rules.push(rec.id);
  }

  async function enable(rec, { quiet = false, persist = true } = {}) {
    if (state.safeMode) {
      toast('🛡️ 安全模式中，先關掉安全模式才能啟用世界模組');
      return false;
    }
    let mod;
    try {
      mod = await load(rec.id);
    } catch (e) {
      console.error(e);
      toast(`⚠️ 載入「${rec.name}」失敗`);
      return false;
    }
    // 要讓位的：原本的環境（環境只能一個）＋ replaces 指定的舊版
    const out = [];
    if (rec.type === 'environment' && state.environment && state.environment !== rec.id) out.push(state.environment);
    if (rec.replaces && host.isActive(rec.replaces) && !out.includes(rec.replaces)) out.push(rec.replaces);
    for (const id of out) host.uninstall(id);
    const res = host.install(rec, mod);
    if (!res.ok) {
      // 新的裝不起來 → 把剛剛讓位的裝回去，世界回到原本的樣子
      for (const id of out) {
        const old = byId(id);
        if (old) host.install(old, await load(id));
      }
      toast(`⚠️「${rec.name}」啟動失敗，已退回原本的樣子（${res.error}）`);
      render();
      return false;
    }
    for (const id of out) markInactive(id);
    markActive(rec);
    if (persist) save();
    render();
    if (!quiet) toast(`🌍 ${TYPE_LABEL[rec.type]}「${rec.name}」已啟用`);
    return true;
  }

  function disable(id, { quiet = false } = {}) {
    const rec = byId(id);
    host.uninstall(id);
    markInactive(id);
    save();
    render();
    if (!quiet && rec) toast(`已停用${TYPE_LABEL[rec.type]}「${rec.name}」`);
  }

  async function handleError(rec, err, why) {
    console.error(`世界模組「${rec.name}」`, err);
    markInactive(rec.id);
    const label = why === 'slow' ? '太耗效能' : '出錯了';
    const prev = rec.replaces && byId(rec.replaces);
    if (prev && !state.safeMode) {
      const res = host.install(prev, await load(prev.id));
      if (res.ok) {
        markActive(prev);
        save();
        render();
        toast(`⚠️「${rec.name}」${label}，已退回上一版「${prev.name}」`);
        return;
      }
    }
    save();
    render();
    toast(`⚠️「${rec.name}」${label}，已自動停用（世界其他部分不受影響）`);
  }

  async function restoreActive() {
    const ids = [state.environment, ...state.rules].filter(Boolean);
    state.environment = null;
    state.rules = [];
    for (const id of ids) {
      const rec = byId(id);
      if (rec && !rec.hidden) await enable(rec, { quiet: true, persist: false });
    }
    save();
  }

  async function setSafeMode(on) {
    if (on) {
      const keep = { environment: state.environment, rules: [...state.rules] };
      host.uninstallAll();
      state = { ...keep, safeMode: true }; // 記住原本開了哪些，關掉安全模式時裝回來
      save();
      render();
      toast('🛡️ 安全模式：所有世界模組都先停掉了');
    } else {
      state.safeMode = false;
      await restoreActive();
      render();
      toast('已關閉安全模式，世界模組恢復');
    }
  }

  function render() {
    safeBtn.textContent = state.safeMode ? '🛡️ 安全模式：開' : '🛡️ 安全模式：關';
    safeBtn.classList.toggle('on', state.safeMode);
    resetBtn.disabled = !state.environment || state.safeMode;
    const visible = modules.filter((m) => !m.hidden);
    if (!visible.length) {
      listEl.innerHTML =
        '<div class="muted">還沒有世界模組。試著說「把這裡變成月球表面」或「加上重力」，Codex 會判斷要做成環境還是規則。</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const m of [...visible].reverse()) {
      const on = host.isActive(m.id);
      const card = document.createElement('div');
      card.className = `wmod${on ? ' on' : ''}`;
      card.dataset.id = m.id;
      card.innerHTML =
        '<div class="name"><span class="n"></span><span class="tags"><span class="badge"></span>' +
        '<button class="rm" title="從列表移除">×</button></span></div><div class="desc"></div>' +
        '<button class="toggle"></button>';
      card.querySelector('.n').textContent = m.name;
      const badge = card.querySelector('.badge');
      badge.textContent = TYPE_LABEL[m.type] || m.type;
      badge.classList.add(m.type);
      card.querySelector('.desc').textContent = m.description || '';
      const toggle = card.querySelector('.toggle');
      toggle.textContent = on ? '使用中 · 停用' : '啟用';
      toggle.classList.toggle('primary', !on);
      toggle.onclick = () => (host.isActive(m.id) ? disable(m.id) : enable(m));
      card.querySelector('.rm').onclick = async () => {
        if (!window.confirm(`把「${m.name}」從列表移除？`)) return;
        if (host.isActive(m.id)) disable(m.id, { quiet: true });
        try {
          await api('POST', `/api/world/${m.id}/hide`, {});
          m.hidden = true;
          render();
        } catch (e) {
          toast(`⚠️ ${e.message}`);
        }
      };
      listEl.appendChild(card);
    }
  }

  safeBtn.onclick = () => setSafeMode(!state.safeMode);
  resetBtn.onclick = () => state.environment && disable(state.environment);

  return {
    host,
    get modules() {
      return modules;
    },
    get state() {
      return state;
    },
    get hasRules() {
      return !state.safeMode && state.rules.length > 0;
    },
    async init(list, worldState) {
      modules = list || [];
      state = { environment: null, rules: [], safeMode: false, ...(worldState || {}) };
      if (forceSafe) state.safeMode = true; // 網址加 ?safe=1：先不裝任何模組（模組把頁面弄壞時的逃生口）
      if (!state.safeMode) await restoreActive();
      render();
    },
    // Codex 剛做好的世界模組：放進列表並立刻啟用
    async add(rec) {
      if (!byId(rec.id)) modules.push(rec);
      render();
      return enable(rec);
    },
    enable,
    disable,
    setSafeMode,
    update: (dt, t) => host.update(dt, t),
    // 給測試用：直接裝一個記憶體裡的模組（不經過伺服器、不存檔）
    async installRaw(rec, modObj) {
      loaded.set(rec.id, modObj);
      if (!byId(rec.id)) modules.push(rec);
      return enable(rec, { persist: false, quiet: true });
    },
  };
}
