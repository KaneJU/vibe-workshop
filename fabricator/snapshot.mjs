// 拍照：看看自己做出來的東西長什麼樣子。
// Codex 在沙盒裡開不了瀏覽器，所以這支程式只是寫一張「請幫我拍照」的紙條（snapshot.request.json），
// 由工坊伺服器在沙盒外代拍，拍好的 snapshot.png 放回這個資料夾，再用看圖工具（view_image）打開。
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const target = existsSync('part.js') ? 'part.js' : existsSync('world.js') ? 'world.js' : null;
if (!target) {
  console.log('SNAPSHOT FAILED: write part.js or world.js first');
  process.exit(1);
}
const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
rmSync('snapshot.result.json', { force: true });
writeFileSync('snapshot.request.json', JSON.stringify({ id, target, at: Date.now() }));
const deadline = Date.now() + 45_000;
for (;;) {
  if (existsSync('snapshot.result.json')) {
    let r = null;
    try {
      r = JSON.parse(readFileSync('snapshot.result.json', 'utf8'));
    } catch {
      r = null; // 還在寫
    }
    if (r && r.id === id) {
      if (r.unavailable) {
        console.log(`SNAPSHOT UNAVAILABLE: ${r.error} — skip the visual check`);
        process.exit(0);
      }
      if (!r.ok) {
        console.log(`SNAPSHOT FAILED: ${r.error}`);
        process.exit(1);
      }
      console.log('SNAPSHOT OK: snapshot.png');
      console.log(
        target === 'part.js'
          ? '  4 views: FRONT (+Z) · RIGHT SIDE (+X) · TOP (front at bottom) · 3/4 VIEW (grid cells are 0.5 m)'
          : '  4 views from the user\'s position: forward · right · back · up at the sky',
      );
      if (r.size) console.log(`  size (m): x=${r.size[0]} y=${r.size[1]} z=${r.size[2]}`);
      console.log('  Open snapshot.png with your image viewer tool (view_image) and check it against the request.');
      process.exit(0);
    }
  }
  if (Date.now() > deadline) {
    console.log('SNAPSHOT UNAVAILABLE: the workshop did not answer (only works while the workshop server runs this job) — skip the visual check');
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
