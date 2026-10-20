// 物理測試（以 iPhone 為準，借鏡王國之淚）：掉落、究極手（抓、升降、丟）、黏合（抓著按 🔗、多選黏合、搖一搖拆下）、
// 裝置（風扇推、氣球吊、輪子＋操縱桿駕駛）、時光倒轉、車子撞開東西、世界模組改重力、重新整理後還黏著、關掉物理回到原本的疊放。
// 會改動場景，只能對測試用資料夾跑（同 smoke.mjs）：
//   rm -rf /tmp/vw-test-data && DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
//   npm run test:physics      截圖輸出到 tests/out/
import { readFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
const BASE = process.env.LAN_BASE || `http://${lanIp}:5311`;
if (/:5310\b/.test(BASE) && process.env.ALLOW_MAIN !== '1') {
  console.error('拒絕執行：這個測試會改動場景，請對測試用資料夾（預設 :5311）跑。');
  process.exit(2);
}
const DATA_DIR = process.env.DATA_DIR || '/tmp/vw-test-data';
const KEY = readFileSync(path.join(DATA_DIR, 'access-key'), 'utf8').trim();
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const f2 = (v) => Number(v).toFixed(2);

const browser = await chromium.launch({
  args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ ...devices['iPhone 15'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
await page.addInitScript(() => {
  localStorage.setItem('vw_help_seen', '1');
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((list) => {
      for (const r of list) for (const n of r.addedNodes) if (n.classList?.contains('toast')) (window.__toasts ||= []).push(n.textContent);
    }).observe(document.body, { childList: true, subtree: true });
  });
});
const cdp = await context.newCDPSession(page);
const ws = (fn, arg) => page.evaluate(fn, arg);
// 每個 touch 事件要列出「目前所有按著的手指」；id 固定，第二隻手指才分得出來
const touch = (type, pts) =>
  cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 1, radiusX: 4, radiusY: 4, force: 1 })),
  });
const center = async (sel) => {
  const b = await page.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width / 2 };
};
const waitFor = async (fn, arg, timeout = 15000) => {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 100 });
    return true;
  } catch {
    return false;
  }
};
const pos = (id) =>
  ws((id) => {
    const o = window.__ws.instances.get(id).object;
    return { x: o.position.x, y: o.position.y, z: o.position.z };
  }, id);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// 從工具箱拿一個（用程式，比點選單快）→ 搬到指定位置（物理引擎會跟過去）
async function spawn(name, at, yaw = 0) {
  return ws(
    ({ name, at, yaw }) => {
      const w = window.__ws;
      const part = [...w.library].reverse().find((p) => p.name === name && !p.hidden);
      if (!part) return null;
      w.spawnFromLibrary(part.id);
      const id = [...w.selection][0];
      const o = w.instances.get(id).object;
      if (at) {
        o.position.set(at[0], at[1], at[2]);
        o.rotation.set(0, yaw, 0);
      }
      return id;
    },
    { name, at, yaw },
  );
}
const look = (x, z, dist = 5.5, h = 3.2) =>
  ws(
    ({ x, z, dist, h }) => {
      const w = window.__ws;
      w.camera.position.set(x, h, z + dist);
      w.controls.target.set(x, 0.4, z);
      w.controls.update();
    },
    { x, z, dist, h },
  );
const screenOf = (id, where) => ws(({ id, where }) => window.__ws.screenOf(id, where), { id, where });
// 一指拖曳：按住 → 分段移動 → （可選）停住做事 → 放開
async function dragTouch(from, to, { steps = 10, stepMs = 30, during, release = true } = {}) {
  await touch('touchStart', [{ x: from.x, y: from.y }]);
  for (let i = 1; i <= steps; i += 1) {
    await touch('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    await sleep(stepMs);
  }
  if (during) await during();
  if (release) await touch('touchEnd', []);
}
const sizeOf = (name) => ws((name) => [...window.__ws.library].reverse().find((p) => p.name === name)?.size, name);

// ---- 進場：新的工坊預設就開著物理 ----
await page.goto(`${BASE}/?key=${KEY}`);
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
const ready = await waitFor(() => window.__ws.physics.ready, null, 30000);
const btn = await page.textContent('#physBtn');
check('打開就載入物理引擎（Rapier），🍎 物理：開', ready && btn.includes('開'), `${btn}，${JSON.stringify(await ws(() => window.__ws.physics.stats()))}`);
const devicesInBox = await ws(() => ['風扇', '火箭', '氣球', '輪子', '彈簧', '操縱桿', '木板'].filter((n) => window.__ws.library.some((p) => p.name === n)));
check('工具箱裡有左納烏裝置', devicesInBox.length === 7, devicesInBox.join('、'));
// 無頭瀏覽器用軟體算圖，場景裡上千個 mesh 只跑得到每秒個位數格：先把原本的東西藏起來（不存檔、重新整理就回來），
// 測試主要用構造簡單的木板
await ws(() => {
  for (const i of window.__ws.instances.values()) i.object.visible = false;
});
const PL = await sizeOf('木板');

// ---- 掉落與疊放 ----
await look(5, 0);
const cubeA = await spawn('木板', [5, 2.2, 0]);
const fell = await waitFor((id) => {
  const w = window.__ws;
  const b = w.physics.bodyOf(w.instances.get(id));
  return b && b.sleeping && Math.abs(w.instances.get(id).object.position.y) < 0.03;
}, cubeA);
check('從 2 m 高放開 → 掉到地上停住（睡著）', fell, `y=${f2((await pos(cubeA)).y)}`);
const cubeB = await spawn('木板', [5.15, 1.4, 0.2], 0.3);
const stacked = await waitFor(
  ({ a, b }) => {
    const w = window.__ws;
    const top = w.worldBox(w.instances.get(a)).max.y;
    const o = w.instances.get(b).object;
    return w.physics.bodyOf(w.instances.get(b))?.sleeping && Math.abs(o.position.y - top) < 0.04;
  },
  { a: cubeA, b: cubeB },
);
check('掉在另一個上面 → 疊住不倒', stacked, `上面那個 y=${f2((await pos(cubeB)).y)}`);
await page.screenshot({ path: path.join(OUT, 'p01-stack.png') });

// ---- 究極手：抓起來、升降、放下 ----
await look(8, 0);
const cubeC = await spawn('木板', [8, 0, 0]);
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, cubeC, 5000);
const c0 = await pos(cubeC);
const s0 = await screenOf(cubeC);
let liftedY = 0;
let hudShown = false;
let upGain = 0;
await dragTouch(s0, { x: s0.x + 90, y: s0.y + 10 }, {
  release: false,
  during: async () => {
    await sleep(600);
    liftedY = (await pos(cubeC)).y;
    hudShown = await ws(() => !document.querySelector('#holdHud').hidden && !!window.__ws.holding);
    // 第二隻手指按住 ▲
    const up = await center('#holdUp');
    const finger = { x: s0.x + 90, y: s0.y + 10, id: 1 };
    await touch('touchStart', [finger, { x: up.x, y: up.y, id: 2 }]);
    await sleep(900);
    await touch('touchEnd', [{ x: up.x, y: up.y, id: 2 }]); // touchEnd 列的是「放開的那隻手指」
    await sleep(1200); // 等它跟上手指、停穩，放手才不會被甩出去
    upGain = (await pos(cubeC)).y - liftedY;
  },
});
check('究極手：拖曳就抓起來、離地飄著，出現究極手按鈕', liftedY > 0.12 && hudShown, `離地 ${f2(liftedY)} m`);
check('抓著時另一指按 ▲ → 升高', upGain > 0.4, `升高 ${f2(upGain)} m`);
await page.screenshot({ path: path.join(OUT, 'p02-ultrahand.png') });
await touch('touchEnd', []);
const dropped = await waitFor((id) => {
  const w = window.__ws;
  return w.physics.bodyOf(w.instances.get(id))?.sleeping && w.instances.get(id).object.position.y < 0.05;
}, cubeC);
const c1 = await pos(cubeC);
check('放手 → 掉回地上，位置換了', dropped && flat(c0, c1) > 0.4 && !(await ws(() => window.__ws.holding)), `移動 ${f2(flat(c0, c1))} m`);

// ---- 丟出去 ----
const s1 = await screenOf(cubeC);
await touch('touchStart', [{ x: s1.x, y: s1.y }]);
for (let i = 1; i <= 4; i += 1) {
  await touch('touchMove', [{ x: s1.x, y: s1.y - i * 3 }]);
  await sleep(40);
}
await sleep(800);
const beforeThrow = await pos(cubeC);
for (let i = 1; i <= 10; i += 1) {
  await touch('touchMove', [{ x: s1.x + i * 22, y: s1.y - 12 - i * 5 }]);
  await sleep(45);
}
const atRelease = await pos(cubeC);
await touch('touchEnd', []);
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, cubeC, 12000);
const landed = await pos(cubeC);
check('拖著快速移動時放手 → 保留速度、往前多飛一段', flat(landed, beforeThrow) > flat(atRelease, beforeThrow) + 0.15, `放手時 ${f2(flat(atRelease, beforeThrow))} m → 落地 ${f2(flat(landed, beforeThrow))} m`);

// ---- 黏合：抓著靠近按 🔗 ----
await look(0, 6, 5);
const plank = await spawn('木板', [0, 0, 6]);
const plankSize = await sizeOf('木板');
const fanSize = await sizeOf('風扇');
const fan = await spawn('風扇', [0, plankSize[1] + 0.25, 6 - plankSize[2] / 2 + fanSize[2] / 2 + 0.02]);
await sleep(1500);
const sf = await screenOf(fan);
let candidate = false;
let glueOk = false;
await dragTouch(sf, { x: sf.x + 2, y: sf.y + 8 }, {
  steps: 4,
  release: false,
  during: async () => {
    // 另一指按住 ▼ 把風扇壓到木板上，等黃色的黏合線出現
    const finger = { x: sf.x + 2, y: sf.y + 8, id: 1 };
    const dn = await center('#holdDown');
    await touch('touchStart', [finger, { x: dn.x, y: dn.y, id: 2 }]);
    for (let i = 0; i < 40 && !candidate; i += 1) {
      await sleep(150);
      candidate = await ws(() => !!window.__ws.physics.glueCandidate && !document.querySelector('#holdGlue').disabled);
    }
    await touch('touchEnd', [{ x: dn.x, y: dn.y, id: 2 }]);
    await sleep(100);
    const g = await center('#holdGlue');
    await touch('touchStart', [finger, { x: g.x, y: g.y, id: 2 }]);
    await sleep(60);
    await touch('touchEnd', [{ x: g.x, y: g.y, id: 2 }]);
    await sleep(400);
    glueOk = await ws(({ a, b }) => {
      const w = window.__ws;
      const A = w.instances.get(a);
      return !!A.glue && A.glue === w.instances.get(b).glue;
    }, { a: plank, b: fan });
  },
});
await page.screenshot({ path: path.join(OUT, 'p03-glue.png') });
await touch('touchEnd', []);
check('抓著風扇靠到木板上 → 🔗 亮起來', candidate);
check('另一指按 🔗 → 風扇和木板黏成一體', glueOk);
await sleep(1500);
const body = await ws((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id)), plank);
check('黏起來的是同一個剛體、帶著風扇裝置', body?.members.length === 2 && body.devices.includes('fan'), JSON.stringify({ members: body?.members.length, devices: body?.devices, mass: Math.round(body?.mass) }));

// ---- ⚡ 啟動：風扇把整台推走 ----
await ws((id) => window.__ws.selectOnly(id), plank);
await page.waitForTimeout(300);
const p0 = await pos(plank);
// 風扇在木板上的位置（木板自己的座標：整台會轉向，所以不能用世界座標比）
const relOf = () =>
  ws(({ a, b }) => {
    const w = window.__ws;
    const A = w.instances.get(a).object;
    return w.instances.get(b).object.position.clone().sub(A.position).applyQuaternion(A.quaternion.clone().invert()).toArray();
  }, { a: plank, b: fan });
const rel0 = await relOf();
await page.tap('#mobileBar [data-act=power]');
await waitFor(({ id, p }) => {
  const o = window.__ws.instances.get(id).object.position;
  return Math.hypot(o.x - p.x, o.z - p.z) > 1.5;
}, { id: plank, p: p0 }, 15000);
const p1 = await pos(plank);
const rel1 = await relOf();
check('按 ⚡ 啟動 → 風扇把木板推著走', flat(p0, p1) > 1.5, `移動 ${f2(flat(p0, p1))} m`);
check('黏著的東西一起走、相對位置不變', Math.hypot(...rel0.map((v, i) => v - rel1[i])) < 0.03);
await page.tap('#mobileBar [data-act=power]');

// ---- 氣球：黏在方塊上把它吊起來 ----
await look(-5, 2);
// 一個氣球拉得動約 40 公斤：木板 18 公斤 OK（1 公尺的能量方塊六十幾公斤就吊不動）
const crate = await spawn('木板', [-5, 0, 2]);
const balloon = await spawn('氣球', [-5, PL[1] + 0.05, 2]);
await ws(({ a, b }) => {
  const w = window.__ws;
  w.selectOnly(a);
  w.addToSelection(b);
  w.glueSelected();
}, { a: crate, b: balloon });
const rose = await waitFor((id) => window.__ws.instances.get(id).object.position.y > 1.2, crate, 15000);
check('「🔗 黏合」把氣球綁在木板上 → 木板被吊起來', rose, `y=${f2((await pos(crate)).y)}`);
await page.screenshot({ path: path.join(OUT, 'p04-balloon.png') });

// ---- 多選＋🔗 黏合、拖一個另一個跟著走、搖一搖拆下來 ----
await look(3, -5);
const d1 = await spawn('木板', [2.4, 0, -5]);
const d2 = await spawn('木板', [3.6, 0, -5]);
await sleep(1500);
// 沒有選取時動作列是收起來的：先選一個讓它出來，開「多選」，再清掉重新點
await ws((id) => window.__ws.selectOnly(id), d1);
await page.tap('#mobileBar [data-act=multi]');
await ws(() => window.__ws.clearSelection());
for (const id of [d1, d2]) {
  const s = await screenOf(id);
  await page.touchscreen.tap(s.x, s.y);
  await sleep(250);
}
await page.tap('#mobileBar [data-act=glue]');
await page.tap('#mobileBar [data-act=multi]');
const glued2 = await ws(({ a, b }) => {
  const w = window.__ws;
  return !!w.instances.get(a).glue && w.instances.get(a).glue === w.instances.get(b).glue;
}, { a: d1, b: d2 });
check('多選兩個 → 🔗 黏合', glued2);
const gap0 = dist(await pos(d1), await pos(d2));
const sd = await screenOf(d1);
await dragTouch(sd, { x: sd.x - 70, y: sd.y + 30 }, { release: true });
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, d1, 10000);
const gap1 = dist(await pos(d1), await pos(d2));
check('拖其中一個，另一個跟著走（距離不變）', Math.abs(gap1 - gap0) < 0.05, `${f2(gap0)} → ${f2(gap1)} m`);
const sd2 = await screenOf(d1);
await touch('touchStart', [{ x: sd2.x, y: sd2.y }]);
for (let i = 1; i <= 3; i += 1) {
  await touch('touchMove', [{ x: sd2.x, y: sd2.y - i * 4 }]);
  await sleep(30);
}
// 軟體算圖每秒只有幾格，同一格裡的觸控移動會被合併：每次甩動間隔久一點，才不會左右抵銷（真機 60 fps 沒這問題）
for (let k = 0; k < 6; k += 1) {
  await touch('touchMove', [{ x: sd2.x + 45, y: sd2.y - 12 }]);
  await sleep(140);
  await touch('touchMove', [{ x: sd2.x - 45, y: sd2.y - 12 }]);
  await sleep(140);
}
const shaken = await waitFor((id) => !window.__ws.instances.get(id).glue, d1, 3000);
await touch('touchEnd', []);
check('抓著搖一搖 → 拆下來', shaken, (await ws(() => window.__toasts?.slice(-1)[0])) || '');

// ---- 輪子＋操縱桿：黏成小車，用搖桿駕駛 ----
await look(0, 12, 6, 3.5);
const wheelSize = await sizeOf('輪子');
const r = wheelSize[1] / 2;
const plank2 = await spawn('木板', [0, r * 0.9, 12]);
const ph = plankSize[1];
const wx = plankSize[0] / 2 + wheelSize[0] / 2 + 0.03;
const wz = plankSize[2] / 2 - 0.1;
const wheels = [];
for (const [x, z] of [[-wx, wz], [wx, wz], [-wx, -wz], [wx, -wz]]) wheels.push(await spawn('輪子', [x, 0, 12 + z]));
const stick = await spawn('操縱桿', [0, r * 0.9 + ph, 12]);
await ws((ids) => {
  const w = window.__ws;
  w.selectOnly(ids[0]);
  for (const id of ids.slice(1)) w.addToSelection(id);
  w.glueSelected();
}, [plank2, ...wheels, stick]);
await sleep(2000);
const cart = await ws((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id)), plank2);
check('木板＋4 輪子＋操縱桿黏成一台車（輪子各自會轉）', cart?.members.length === 6 && cart.wheels === 4, JSON.stringify({ members: cart?.members.length, wheels: cart?.wheels }));
await ws((id) => window.__ws.selectOnly(id), plank2);
await page.tap('#mobileBar [data-act=control]');
await page.waitForTimeout(500);
const label = await page.textContent('#ctlLabel');
check('▶ 操作 → 有裝置的東西進入「駕駛」', label.includes('駕駛'), label);
const joy = await center('#joy');
const q0 = await pos(plank2);
const yaw = () =>
  ws((id) => {
    const w = window.__ws;
    const f = w.physics.frame(w.instances.get(id)).forward;
    return Math.atan2(f.x, f.z);
  }, plank2);
await touch('touchStart', [{ x: joy.x, y: joy.y }]);
await touch('touchMove', [{ x: joy.x, y: joy.y - joy.r }]);
await waitFor(({ id, p }) => {
  const o = window.__ws.instances.get(id).object.position;
  return Math.hypot(o.x - p.x, o.z - p.z) > 2;
}, { id: plank2, p: q0 }, 15000);
const q1 = await pos(plank2);
check('搖桿往上 → 車子自己開（輪子馬達）', flat(q0, q1) > 2, `${f2(flat(q0, q1))} m`);
await page.screenshot({ path: path.join(OUT, 'p05-pilot.png') });
const y0 = await yaw();
await touch('touchMove', [{ x: joy.x + joy.r * 0.8, y: joy.y - joy.r * 0.6 }]);
const turned = await waitFor(
  ({ id, y0 }) => {
    const w = window.__ws;
    const f = w.physics.frame(w.instances.get(id)).forward;
    const d = Math.atan2(Math.sin(Math.atan2(f.x, f.z) - y0), Math.cos(Math.atan2(f.x, f.z) - y0));
    return Math.abs(d) > 0.6;
  },
  { id: plank2, y0 },
  15000,
);
const y1 = await yaw();
await touch('touchEnd', []);
const upright = await ws((id) => new window.__ws.THREE.Vector3(0, 1, 0).applyQuaternion(window.__ws.instances.get(id).object.quaternion).y, plank2);
check('往右推 → 轉彎，有操縱桿不會翻車', turned && upright > 0.85, `轉了 ${Math.round((Math.abs(y1 - y0) * 180) / Math.PI)}°，up=${f2(upright)}`);
await page.tap('#ctlExit');
await page.waitForTimeout(300);

// ---- 時光倒轉 ----
await look(-8, -3);
const rc = await spawn('木板', [-8, 0, -3]);
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, rc, 6000);
const home = await pos(rc);
const sr = await screenOf(rc);
await dragTouch(sr, { x: sr.x + 110, y: sr.y - 40 }, { steps: 12, stepMs: 40 });
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, rc, 10000);
const away = await pos(rc);
await ws((id) => window.__ws.selectOnly(id), rc);
await page.waitForTimeout(200);
await page.tap('#mobileBar [data-act=recall]');
const recalling = await ws((id) => window.__ws.physics.isRecalling(window.__ws.instances.get(id)), rc);
await page.screenshot({ path: path.join(OUT, 'p06-recall.png') });
await waitFor((id) => !window.__ws.physics.isRecalling(window.__ws.instances.get(id)), rc, 20000);
await waitFor((id) => window.__ws.physics.bodyOf(window.__ws.instances.get(id))?.sleeping, rc, 8000);
const back = await pos(rc);
check('⏪ 倒轉 → 沿原路退回原來的位置', recalling && flat(back, home) < 0.35 && flat(away, home) > 0.8, `移走 ${f2(flat(away, home))} m → 倒轉後離原處 ${f2(flat(back, home))} m`);

// ---- 開車撞開東西 ----
await look(10, 8, 6);
const kart = await spawn('氮氣卡丁車', [10, 0, 6]);
const box = await spawn('木板', [10, 0, 9.5], Math.PI / 2);
await sleep(1200);
const b0 = await pos(box);
await ws((id) => {
  const w = window.__ws;
  w.startControl(w.instances.get(id), 'drive');
  w.engine.input.y = 1;
}, kart);
await waitFor(({ id, p }) => {
  const o = window.__ws.instances.get(id).object.position;
  return Math.hypot(o.x - p.x, o.z - p.z) > 0.5;
}, { id: box, p: b0 }, 12000);
await ws(() => {
  window.__ws.engine.input.y = 0;
  window.__ws.stopControl();
});
const b1 = await pos(box);
check('開卡丁車撞過去 → 木板被撞開', flat(b0, b1) > 0.5, `木板移動 ${f2(flat(b0, b1))} m`);

// ---- 世界模組：改重力 ----
await look(14, 0);
await ws(() =>
  window.__ws.worlds.installRaw(
    { id: 'w_lowg', type: 'rule', name: '低重力' },
    { default: (world) => { world.physics.gravity(-1.6); return {}; } },
  ),
);
const g1 = await ws(() => window.__ws.physics.stats().gravity);
const moonCube = await spawn('木板', [14, 3, 0]);
await sleep(1200);
const yMoon = (await pos(moonCube)).y;
await ws(() => window.__ws.worlds.disable('w_lowg', { quiet: true }));
const g2 = await ws(() => window.__ws.physics.stats().gravity);
check('規則模組 world.physics.gravity(-1.6) → 掉得很慢；拔掉就恢復', g1 === -1.6 && yMoon > 1.5 && g2 === -9.81, `重力 ${g1} → ${g2}，1.2 秒後 y=${f2(yMoon)}`);

// ---- 存檔：重新整理後還黏著、位置還在 ----
const beforeReload = await pos(fan);
await ws(() => window.__ws.saveNow());
await page.reload();
await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
await waitFor(() => window.__ws.physics.ready, null, 30000);
const after = await ws(({ plank, fan }) => {
  const w = window.__ws;
  const a = w.instances.get(plank);
  const b = w.instances.get(fan);
  return { glued: !!a?.glue && a.glue === b?.glue, fan: b && { x: b.object.position.x, y: b.object.position.y, z: b.object.position.z }, cart: w.glueMembers(a).length };
}, { plank, fan });
check('重新整理 → 還黏著、位置還在', after.glued && after.fan && flat(after.fan, beforeReload) < 0.1, JSON.stringify(after));

// ---- 關掉物理：回到原本的疊放 ----
await page.tap('#libToggle');
await page.waitForTimeout(500);
await page.tap('.panel.right [data-tab=world]');
await page.waitForTimeout(200);
await page.tap('#physBtn');
await page.waitForTimeout(400);
const off = await ws(() => ({ on: window.__ws.physicsOn, enabled: window.__ws.physics.enabled, bar: getComputedStyle(document.querySelector('#mobileBar [data-act=recall]')).display }));
check('🍎 物理：關 → 引擎停掉、⏪ ⚡ 按鈕收起來', !off.on && !off.enabled && off.bar === 'none', JSON.stringify(off));
await page.tap('#libToggle');
await page.waitForTimeout(400);
await look(-3, -9);
const t1 = await spawn('木板', [-3.8, 0, -9]);
const t2 = await spawn('木板', [-2.2, 0, -9]);
const st2 = await screenOf(t2);
const st1 = await screenOf(t1, 'top');
await dragTouch(st2, st1, { steps: 12 });
await sleep(400);
const classic = await ws(({ a, b }) => {
  const w = window.__ws;
  return { top: w.worldBox(w.instances.get(a)).max.y, y: w.instances.get(b).object.position.y };
}, { a: t1, b: t2 });
check('沒有物理時，拖到別的東西上面照樣疊上去', Math.abs(classic.y - classic.top) < 0.03, `y=${f2(classic.y)}，下面頂端 ${f2(classic.top)}`);
await ws(() => window.__ws.setPhysics(true, { quiet: true }));
const back2 = await waitFor(() => window.__ws.physics.ready, null, 10000);
const ms = await ws(() => window.__ws.physics.stats());
check('再打開物理 → 引擎回來，每格物理不到 4 ms', back2 && ms.ms < 4, JSON.stringify(ms));

check('過程中沒有任何錯誤', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
