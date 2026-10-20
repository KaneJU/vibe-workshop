// 「照照片做」測試：模擬 iPhone 從區網連進來，按 📷 選一張相簿照片（1600×1200，裡面寫了假的拍攝地點），
// 不打字直接按打造 → 伺服器收到縮小、拿掉地點的照片，Codex 被叫時附上照片 → 成品進工具箱。
// 自己開一台用假 Codex 的伺服器（:5314、暫存資料夾），不花額度、不碰任何工坊：npm run test:photo
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium, devices } = await import(PW);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'photo-gps.jpg');
const PORT = 5314;
const lanIp = Object.values(os.networkInterfaces())
  .flat()
  .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
const BASE = process.env.LAN_BASE || `http://${lanIp}:${PORT}`; // LAN_BASE=http://127.0.0.1:5314 TEST_HOST=127.0.0.1：只聽本機
const LOCAL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'vw-photo-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// JPEG 的寬高（SOF 區段）
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: process.env.TEST_HOST || '0.0.0.0', DATA_DIR, CODEX_BIN: path.join(ROOT, 'tests', 'fake-codex.mjs') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c));
server.stderr.on('data', (c) => (serverLog += c));
const jobIds = [];
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
try {
  for (let i = 0; i < 60 && !existsSync(path.join(DATA_DIR, 'access-key')); i += 1) await sleep(200);
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${LOCAL}/api/state`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  const KEY = readFileSync(path.join(DATA_DIR, 'access-key'), 'utf8').trim();

  const context = await browser.newContext({ ...devices['iPhone 15'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.addInitScript(() => localStorage.setItem('vw_help_seen', '1'));
  await page.goto(`${BASE}/?ws&key=${KEY}`); // 自由工坊
  await page.waitForFunction(() => window.__ws?.loaded === true, null, { timeout: 30000 });
  check('iPhone 畫面上有 📷 按鈕', await page.isVisible('#photoBtn'));

  // 按 📷 → 選照片（iPhone 會跳出「照片圖庫／拍照／選擇檔案」，這裡直接給檔案）
  const chooser = page.waitForEvent('filechooser');
  await page.tap('#photoBtn');
  await (await chooser).setFiles(FIXTURE);
  await page.waitForSelector('#photoChip:not([hidden])', { timeout: 5000 }).catch(() => {});
  const chip = await page.evaluate(async () => {
    const img = document.querySelector('#photoChip img');
    await img.decode().catch(() => {});
    return { shown: !document.querySelector('#photoChip').hidden, jpeg: img.src.startsWith('data:image/jpeg;base64,'), w: img.naturalWidth, h: img.naturalHeight, hint: document.querySelector('#prompt').placeholder };
  });
  check('選了照片 → 輸入框前面出現縮圖', chip.shown && chip.jpeg, chip.hint);
  check('照片先在手機上縮小（最長邊 1280 px、比例不變）', chip.w === 1280 && chip.h === 960, `${chip.w}×${chip.h}`);

  // 不打字直接按打造
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/generate'));
  await page.tap('#sendBtn');
  const job = (await (await sent).json()).job;
  jobIds.push(job.id);
  check('不打字直接按打造 → 指令變成「照這張照片做出來」', job.prompt === '照這張照片做出來' && job.photo === true, job.prompt);
  const card = await page.evaluate(() => {
    const c = document.querySelector('#jobs .job');
    return { title: c?.querySelector('.jtitle')?.textContent, thumb: c?.querySelector('.thumb')?.src?.slice(0, 22), chipHidden: document.querySelector('#photoChip').hidden };
  });
  check('打造中的卡片上看得到照片，輸入框的照片收起來', card.title?.startsWith('📷') && card.thumb === 'data:image/jpeg;base64' && card.chipHidden, card.title);

  await page.waitForFunction(() => document.querySelector('#jobs .job')?.classList.contains('done'), null, { timeout: 60000 }).catch(() => {});
  const done = await page.evaluate(() => ({
    done: document.querySelector('#jobs .job')?.classList.contains('done'),
    thumb: document.querySelector('#jobs .job .thumb')?.getAttribute('src'),
    lib: window.__ws.library.length,
  }));
  check('做好了 → 卡片換成成品縮圖、工具箱多一個', done.done && /^\/thumbs\//.test(done.thumb || ''), done.thumb);

  // 伺服器那邊：照片存在工作資料夾、拿掉了地點資訊；Codex 被叫的時候有附照片
  const dir = path.join(ROOT, 'jobs', job.id);
  const ref = existsSync(path.join(dir, 'reference.jpg')) ? readFileSync(path.join(dir, 'reference.jpg')) : null;
  const size = ref && jpegSize(ref);
  check('照片存成工作資料夾裡的 reference.jpg（1280×960）', !!ref && size?.w === 1280 && size?.h === 960, size ? `${size.w}×${size.h}，${Math.round(ref.length / 1024)} KB` : '沒有檔案');
  check('照片裡的拍攝地點、相機資訊都拿掉了', !!ref && !ref.includes('Exif') && !ref.includes('TestCam'));
  const args = JSON.parse(readFileSync(path.join(dir, 'codex-args.json'), 'utf8'));
  const iAt = args.indexOf('-i');
  check('叫 Codex 時附上照片（-i reference.jpg，放在其他選項前面）', iAt === 1 && args[2] === path.join(dir, 'reference.jpg') && args[3].startsWith('--'), args.slice(0, 4).join(' '));
  check('任務單和 context.json 都提到照片', /reference\.jpg/.test(args[args.length - 1]) && JSON.parse(readFileSync(path.join(dir, 'context.json'), 'utf8')).photo === 'reference.jpg');

  // 直接打 API（不經過手機縮圖）：原始照片也會被拿掉地點；不是 JPEG、太大都會被擋
  const raw = readFileSync(FIXTURE);
  const post = (body) => fetch(`${LOCAL}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const r1 = await post({ prompt: '一個馬克杯', image: `data:image/jpeg;base64,${raw.toString('base64')}` });
  const j1 = (await r1.json()).job;
  jobIds.push(j1.id);
  let ref1 = null;
  for (let i = 0; i < 50 && !ref1; i += 1) {
    await sleep(200);
    const f = path.join(ROOT, 'jobs', j1.id, 'reference.jpg');
    if (existsSync(f)) ref1 = readFileSync(f);
  }
  check('直接送原始照片 → 伺服器存檔前也拿掉地點資訊', r1.ok && !!ref1 && !ref1.includes('Exif') && jpegSize(ref1)?.w === 1600);
  const r2 = await post({ prompt: 'x', image: 'data:image/png;base64,iVBORw0KGgo=' });
  const big = Buffer.alloc(3.5 * 1024 * 1024, 7);
  big[0] = 0xff;
  big[1] = 0xd8;
  const r3 = await post({ prompt: 'x', image: `data:image/jpeg;base64,${big.toString('base64')}` });
  check('不是 JPEG、超過 3 MB → 擋下來並說明', r2.status === 400 && r3.status === 400, `${r2.status} ${(await r2.json()).error}／${r3.status} ${(await r3.json()).error}`);

  check('過程中沒有任何錯誤', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check('測試跑完', false, e.message);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(500);
  for (const id of jobIds) rmSync(path.join(ROOT, 'jobs', id), { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
if (failed.length) console.log(serverLog.split('\n').slice(-8).join('\n'));
console.log(`\n${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length ? 1 : 0);
