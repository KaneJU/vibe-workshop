// 工坊煙霧測試：用真的瀏覽器操作一輪（拿零件、拖曳疊放、存成零件、刪除復原、重新整理還在）
// WITH_CODEX=1 時再從輸入框走一次完整打造＋改造（會用到 Codex 額度）。
// 這個測試會清空場景，所以只能對「測試用資料夾」跑，不要對正在用的工坊（:5310）跑。
// 空資料夾第一次啟動會自動載入 examples/starter（測試用到的零件都在裡面）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm test        截圖輸出到 tests/out/
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright'; // devDependency；需要先 npx playwright install chromium
const { chromium } = await import(PW);
const BASE = process.env.BASE || 'http://localhost:5311';
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會清空場景，請對資料複本（預設 :5311）跑。');
  process.exit(2);
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('dialog', (d) => d.accept('能量塔'));
await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));

const ws = (fn, arg) => page.evaluate(fn, arg);
const count = () => ws(() => window.__ws.instances.size);
const card = (name) =>
  page.locator('.part').filter({ has: page.locator('.n', { hasText: new RegExp(`^${name}( #\\d+)?$`) }) }).first();
const libNames = () => ws(() => window.__ws.library.map((p) => `${p.name}:${p.kind}`));

await page.goto(BASE);
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
check('頁面載入、伺服器連線', true, await page.textContent('#status'));

// 清空場景（測試從乾淨開始）
await ws(() => {
  window.__ws.instances.forEach((_, id) => window.__ws.addToSelection(id));
});
await page.keyboard.press('Delete');
check('清空場景', (await count()) === 0, `剩 ${await count()} 個`);

// 從工具箱拿兩個能量方塊
await card('藍光能量方塊').click();
await card('藍光能量方塊').click();
await page.waitForTimeout(300);
const [A, B] = await ws(() => [...window.__ws.instances.keys()]);
check('工具箱點兩下 → 場景出現 2 個方塊', (await count()) === 2);

// 把 B 拖到 A 上面
const from = await ws((id) => window.__ws.screenOf(id, 'center'), B);
const to = await ws((id) => window.__ws.screenOf(id, 'top'), A);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
for (let i = 1; i <= 20; i += 1) {
  await page.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
  await page.waitForTimeout(16);
}
await page.mouse.up();
const stack = await ws(
  ([a, b]) => {
    const w = window.__ws;
    const ba = w.worldBox(w.instances.get(a));
    const bb = w.worldBox(w.instances.get(b));
    return { aTop: ba.max.y, bBottom: bb.min.y, dx: Math.abs((ba.min.x + ba.max.x) / 2 - (bb.min.x + bb.max.x) / 2) };
  },
  [A, B],
);
check(
  '拖曳疊放：B 疊在 A 上面',
  stack.bBottom > stack.aTop - 0.12 && stack.bBottom < stack.aTop + 0.05 && stack.dx < 0.6,
  `A 頂 ${stack.aTop.toFixed(3)} m／B 底 ${stack.bBottom.toFixed(3)} m／水平差 ${stack.dx.toFixed(2)} m`,
);
await page.screenshot({ path: path.join(OUT, '01-stacked.png') });

// Shift＋點 A 加入選取，再用「直接說的指令」存成零件
const aPt = await ws((id) => {
  const w = window.__ws;
  const b = w.worldBox(w.instances.get(id));
  const p = new w.THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y + (b.max.y - b.min.y) * 0.3, b.max.z - 0.01);
  p.project(w.camera);
  return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
}, A);
await page.keyboard.down('Shift');
await page.mouse.click(aPt.x, aPt.y);
await page.keyboard.up('Shift');
check('Shift＋點 → 選取 2 個', (await ws(() => window.__ws.selection.size)) === 2);
await page.fill('#prompt', '把這疊存成零件，叫能量塔');
await page.press('#prompt', 'Enter');
await page.waitForTimeout(800);
const libAfterGroup = await libNames();
check(
  '說「把這疊存成零件，叫能量塔」→ 工具箱多了組合零件',
  libAfterGroup.includes('能量塔:composite') && (await count()) === 1,
  libAfterGroup.join('、'),
);

// 刪除再復原
await page.press('#prompt', 'Escape');
await page.keyboard.press('Delete');
const afterDel = await count();
await page.keyboard.press('Meta+z');
await page.waitForTimeout(200);
check('Delete 刪除後 ⌘Z 復原', afterDel === 0 && (await count()) === 1, `刪後 ${afterDel}／復原後 ${await count()}`);

// 從工具箱拿出組合零件與能量環
await card('能量塔').click();
await page.waitForTimeout(300);
check('工具箱拿出「能量塔」（組合零件）', (await count()) === 2);
await card('八方能量環').click();
await page.waitForTimeout(500);
const ring = await ws(() => {
  const w = window.__ws;
  const id = [...w.selection][0];
  const b = w.worldBox(w.instances.get(id));
  const c = b.getCenter(new w.THREE.Vector3());
  const cam = w.camera.getWorldPosition(new w.THREE.Vector3());
  return { id, dist: Math.hypot(c.x - cam.x, c.z - cam.z), minY: b.min.y };
});
check('八方能量環圍繞在使用者四周', ring.dist < 0.5 && Math.abs(ring.minY) < 0.02, `中心離使用者 ${ring.dist.toFixed(2)} m`);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '02-ring.png') });

// 重新整理，東西還在
const idsBefore = (await ws(() => [...window.__ws.instances.keys()])).sort().join(',');
await page.waitForTimeout(700); // 等自動存檔
await page.reload();
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
const idsAfter = (await ws(() => [...window.__ws.instances.keys()])).sort().join(',');
check('重新整理後物件都還在', idsBefore === idsAfter && idsAfter.length > 0, `${(await count())} 個`);

// 移掉能量環，留下乾淨畫面
await ws((id) => window.__ws.selectOnly(id), ring.id);
await page.keyboard.press('Delete');

if (process.env.WITH_CODEX === '1') {
  const waitJob = async (n) => {
    await page.waitForFunction((k) => document.querySelectorAll('.job.done, .job.error').length >= k, n, {
      timeout: 420000,
      polling: 1000,
    });
    return page.evaluate(() => {
      const el = document.querySelector('.job');
      return { cls: el.className, text: el.innerText };
    });
  };
  const doneBefore = await page.evaluate(() => document.querySelectorAll('.job.done, .job.error').length);
  const t0 = Date.now();
  await page.fill('#prompt', '做一個小機器人，頭會一直轉向我');
  await page.press('#prompt', 'Enter');
  await page.waitForTimeout(1500);
  check('輸入框送出 → 出現打造卡片', (await page.locator('.job.running').count()) === 1);
  const j1 = await waitJob(doneBefore + 1);
  const robot = await ws(() => {
    const w = window.__ws;
    const id = [...w.selection][0];
    const inst = w.instances.get(id);
    return id ? { id, partId: inst.partId, name: w.runtime.parts.get(inst.partId)?.name } : null;
  });
  check('Codex 打造完成並放進場景', j1.cls.includes('done') && !!robot, `${robot?.name}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '03-robot.png') });

  if (robot) {
    const t1 = Date.now();
    await page.check('#modifyChk');
    await page.fill('#prompt', '把它改成紅色的，眼睛改成綠色');
    await page.press('#prompt', 'Enter');
    const j2 = await waitJob(doneBefore + 2);
    const after = await ws((id) => {
      const w = window.__ws;
      const inst = w.instances.get(id);
      const part = inst && w.runtime.parts.get(inst.partId);
      return inst ? { partId: inst.partId, basedOn: part?.basedOn, name: part?.name } : null;
    }, robot.id);
    check(
      '改造：同一個位置換成新版本',
      j2.cls.includes('done') && after && after.partId !== robot.partId && after.basedOn === robot.partId,
      `${after?.name}（${Math.round((Date.now() - t1) / 1000)} 秒）`,
    );
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, '04-modified.png') });
  }
}

// 工具箱移除（×）：只隱藏，不影響場景
page.removeAllListeners('dialog');
page.on('dialog', (d) => d.accept());
const visibleBefore = await page.locator('.part').count();
const instBefore = await count();
await card('能量塔').hover();
await card('能量塔').locator('.rm').click();
await page.waitForTimeout(300);
check(
  '工具箱 × 移除：卡片少一張、場景物件不變',
  (await page.locator('.part').count()) === visibleBefore - 1 && (await count()) === instBefore,
  `卡片 ${visibleBefore}→${await page.locator('.part').count()}`,
);

const realErrors = errors.filter((e) => !/favicon/.test(e));
check('沒有瀏覽器錯誤', realErrors.length === 0, realErrors.slice(0, 5).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
