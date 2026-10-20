// 開火閃光逐格量測：把錄影（tests/record.mjs 產生的 m-play.webm／d-play.webm）每一格都解出來，
// 算「接近白色的像素比例」（R、G、B 都 > 235），找出有沒有哪一格被白閃蓋掉大半畫面。
//   node tests/flash-frames.mjs <影片.webm> [輸出.csv]
// 印出：每格比例的最大值、超過 5% 的格子（時間）。另外算「槍口附近」和「準星附近」的白色比例，用來對開火時間。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const csv = process.argv[3];
if (!file) {
  console.error('用法：node tests/flash-frames.mjs <影片.webm> [輸出.csv]');
  process.exit(2);
}
const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
  .toString()
  .trim()
  .split(',')
  .map(Number);
const FPS = 25;
const WHITE = 235;
// 手機直拿：槍口在準星右下；電腦：槍口在畫面右側中間偏下（區域取寬一點，抓得到槍口光）
const mobile = h > w;
const muzzleBox = mobile ? [195, 420, 330, 580] : [700, 300, 1100, 560]; // x0, y0, x1, y1
const cross = [w / 2 - 40, h / 2 - 40, w / 2 + 40, h / 2 + 40];

const frameBytes = w * h * 3;
const rows = [];
let buf = Buffer.alloc(0);
const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-r', String(FPS), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
function measure(f) {
  let all = 0;
  let mz = 0;
  let mzN = 0;
  let cr = 0;
  let crN = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      const white = f[i] > WHITE && f[i + 1] > WHITE && f[i + 2] > WHITE;
      if (white) all += 1;
      if (x >= muzzleBox[0] && x < muzzleBox[2] && y >= muzzleBox[1] && y < muzzleBox[3]) {
        mzN += 1;
        if (white) mz += 1;
      }
      if (x >= cross[0] && x < cross[2] && y >= cross[1] && y < cross[3]) {
        crN += 1;
        if (white) cr += 1;
      }
    }
  }
  return { white: all / (w * h), muzzle: mz / mzN, cross: cr / crN };
}
ff.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= frameBytes) {
    const f = buf.subarray(0, frameBytes);
    rows.push({ i: rows.length, t: rows.length / FPS, ...measure(f) });
    buf = buf.subarray(frameBytes);
  }
});
await new Promise((r) => ff.on('close', r));

// 錄影開頭頁面還沒載入是整片白（空白頁），不算
let skip = 0;
while (skip < rows.length && rows[skip].white > 0.99) skip += 1;
const play = rows.slice(skip);
const max = play.reduce((a, b) => (b.white > a.white ? b : a), play[0]);
const crossMax = play.reduce((a, b) => (b.cross > a.cross ? b : a), play[0]);
const big = play.filter((r) => r.white > 0.05);
console.log(`${file}：${w}×${h}，${rows.length} 格（${FPS} fps；開頭 ${skip} 格是載入前的空白頁，不算）`);
console.log(`接近白色（RGB 都 > ${WHITE}）比例最大值：${(max.white * 100).toFixed(2)}%（第 ${max.i} 格，${max.t.toFixed(2)} s）`);
console.log(`準星周圍 80×80 白色比例最大值：${(crossMax.cross * 100).toFixed(1)}%（第 ${crossMax.i} 格，${crossMax.t.toFixed(2)} s）`);
console.log(`超過 5% 的格子：${big.length ? big.map((r) => `${r.t.toFixed(2)}s=${(r.white * 100).toFixed(1)}%`).join('、') : '無'}`);
if (csv) {
  writeFileSync(csv, 'frame,t,white,muzzle,cross\n' + rows.map((r) => `${r.i},${r.t.toFixed(2)},${r.white.toFixed(5)},${r.muzzle.toFixed(5)},${r.cross.toFixed(5)}`).join('\n') + '\n');
  console.log('逐格數據', csv);
}
