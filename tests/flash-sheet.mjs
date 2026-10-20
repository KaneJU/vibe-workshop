// 開火前後逐格抽圖：從錄影精確取出第 n 格（25 fps，第 n 格＝n/25 秒），每格存一張 PNG，
// 再排成一張有標時間、白色比例的對照圖（方便人一次看完一發子彈從開火到命中的每一格）。
//   node tests/flash-sheet.mjs <影片.webm> <開始秒> <結束秒> <輸出資料夾> [名稱] [逐格數據.csv]
// 逐格數據（tests/flash-frames.mjs 產生）有給的話，每格標上「接近白色像素比例」。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = await import(PW);
const [file, a, b, outDir, name = path.basename(process.argv[2] || '', '.webm'), csv] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('用法：node tests/flash-sheet.mjs <影片.webm> <開始秒> <結束秒> <輸出資料夾> [名稱] [逐格數據.csv]');
  process.exit(2);
}
const FPS = 25;
const n0 = Math.round(Number(a) * FPS);
const n1 = Math.round(Number(b) * FPS);
mkdirSync(outDir, { recursive: true });
const white = new Map();
if (csv && existsSync(csv)) {
  for (const line of readFileSync(csv, 'utf8').trim().split('\n').slice(1)) {
    const [i, , w] = line.split(',');
    white.set(Number(i), Number(w));
  }
}
// 精確抽格：用畫格編號選，不靠 seek（seek 可能落在前後一格）
const tmp = path.join(outDir, `.tmp-${name}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select='between(n\\,${n0}\\,${n1})'`, '-vsync', '0', '-start_number', String(n0), path.join(tmp, '%05d.png')]);
const frames = [];
for (const f of readdirSync(tmp).sort()) {
  const n = Number(f.slice(0, 5));
  const t = (n / FPS).toFixed(2);
  const dest = path.join(outDir, `${name}-${t}s.png`);
  renameSync(path.join(tmp, f), dest);
  frames.push({ n, t, dest });
}
rmSync(tmp, { recursive: true, force: true });

// 排成對照圖（直式手機一排 8 格；橫式電腦一排 4 格）
const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
const cols = h > w ? 8 : 4;
const cellW = h > w ? 195 : 400;
const cellH = Math.round((cellW * h) / w);
const cells = frames
  .map((f) => {
    const wr = white.get(f.n);
    const label = `${f.t}s #${f.n}${wr != null ? `　白 ${(wr * 100).toFixed(1)}%` : ''}`;
    const hot = wr != null && wr > 0.05;
    return `<figure><img src="data:image/png;base64,${readFileSync(f.dest).toString('base64')}"><figcaption class="${hot ? 'hot' : ''}">${label}</figcaption></figure>`;
  })
  .join('');
const html = `<html><body style="margin:0;background:#222;font:13px -apple-system,sans-serif;color:#eee">
<div style="padding:6px 8px">${name}：${file}，第 ${n0}–${n1} 格（${a}–${b} s，25 fps 每格都列；白＝RGB 都 > 235 的像素比例）</div>
<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:4px;padding:0 8px 8px">${cells}</div>
<style>figure{margin:0}img{width:${cellW}px;height:${cellH}px;display:block}figcaption{padding:2px 0}.hot{color:#ff6b6b;font-weight:bold}</style></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: cols * (cellW + 4) + 16, height: 400 } });
await page.setContent(html);
const sheet = path.join(outDir, `${name}-sheet.png`);
await page.screenshot({ path: sheet, fullPage: true });
await browser.close();
console.log(`${frames.length} 格 → ${outDir}；對照圖 ${sheet}`);
