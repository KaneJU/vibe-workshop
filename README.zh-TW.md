# Vibe 工坊

[English](README.md) · **繁體中文** · [हिन्दी](README.hi.md)

在 3D／VR 世界裡跟 AI 說話打造東西，就像鋼鐵人在自己的工作室。
說一句「給我一個發光的能量方塊」，幾十秒後它就出現在你面前。
把做好的東西疊起來、存成新零件，再叫 AI 拿這些零件**當材料**做出新東西。
不用重新整理、不用重新打包，你一直待在這個世界裡。

![Vibe 工坊電腦版畫面](docs/screenshot-desktop.jpg)

## 功能

- **用說的或打字就能打造**：[OpenAI Codex CLI](https://github.com/openai/codex) 當場寫出一個 three.js「零件」，通過驗收後直接放進正在跑的世界。
- **疊起來、組起來**：把物件拖到另一個上面就會疊上去；選好幾個，就能存成可以重複使用的零件。
- **拿做好的東西再做新的**：AI 做的零件可以用 `ctx.spawn(...)` 叫出其他零件，最多套 8 層。
- **原地改造**：選一個 AI 做的物件，說「改成紅色」，新版本會在原位置換上。
- **連世界本身都能改**：說「把這裡變成月球表面」或「加上重力」，Codex 會寫出環境或規則，當場換進正在跑的世界。連開車引擎都能被規則改掉（「車子開快一點而且會甩尾」）。
- **做出來的東西能開、能飛、能戴**：選一個物件按「▶ 操作」：車子能開、飛天車能飛、手套能戴在手上。手機有拇指搖桿和 ⚡ 動作鍵，電腦用 WASD 和空白鍵。
- **全部自動存檔**：場景和工具箱都會自動儲存，關掉分頁之後再開都還在。
- **電腦、手機、VR 都能用**：滑鼠鍵盤、適合手機的觸控版面，以及實驗中的 WebXR 模式（用手把抓起來、疊上去）。

<img src="docs/screenshot-mobile.jpg" width="260" alt="Vibe 工坊手機版畫面">

## AI 是怎麼做出 3D 模型的

Codex 不是在生成網格或圖片，而是**寫 60～80 行的 JavaScript**，用基本形狀（方塊、圓柱、球、圓環、旋轉曲面、擠出形狀）照公尺尺寸一塊塊組出物件，再加上金屬或發光材質，需要的話還會寫動畫。

每次打造都會開一個小小的工作資料夾，裡面有四樣東西：

| | 內容 | 作用 |
|---|---|---|
| 1 | 任務單（[`server.mjs`](server.mjs) 的 `taskPrompt()`） | 只有四行：使用者說了什麼、要新做還是改造、「寫出 `part.js` 和 `meta.json`，跑驗收直到 PASS」。 |
| 2 | [`fabricator/AGENTS.md`](fabricator/AGENTS.md) | 施工規格書：單位公尺、原點在底部中心、正面朝 +Z、`ctx` 介面、動畫寫法、效能預算、禁止使用的功能、擺放規則。 |
| 3 | `context.json` | 使用者說的話、目前選了什麼、附近有什麼、使用者站在哪，以及工具箱裡每個零件的名字和尺寸。 |
| 4 | [`fabricator/validate.mjs`](fabricator/validate.mjs) | 真的在 Node 裡把零件組出來、跑 90 格動畫，檢查尺寸、有沒有貼地、面數和燈光預算、有沒有用到禁止的功能，卡住超過 10 秒就判失敗。Codex 自己跑、沒過就改；伺服器收件前會再驗一次。 |

「套層」其實就是程式。八個能量方塊排成一圈，核心大概就是這樣：

```js
for (let i = 0; i < 8; i++) {
  const angle = (i / 8) * Math.PI * 2;
  const cube = ctx.spawn('藍光能量方塊'); // 工具箱裡現成的零件
  cube.position.set(Math.sin(angle) * 2.2, 0, -Math.cos(angle) * 2.2);
}
```

環境和規則是 `world.js` 模組：`install(world)` 拿到一組受控的介面（`world.add`、`world.env`、`world.objects()`、`world.vehicle.tune()`、`world.hud()`⋯），模組放進世界的東西，在它被拔掉時會自動清乾淨。

零件也可以在 `meta.json` 宣告 `controls`（`drive`／`fly`／`wear`），再用 `root.userData.onControl(s, dt)` 對搖桿做出反應，例如輪子轉動、煞車燈、握拳。

## 需要什麼

- Node.js 20 以上
- 已安裝並登入的 [OpenAI Codex CLI](https://github.com/openai/codex)（終端機打 `codex` 找得到）。每次打造都會用掉你的 Codex 額度。
- 新版瀏覽器（Chrome、Edge 或 Safari）
- 選用：支援 WebXR 的頭盔瀏覽器（例如 Meta Quest），需要 HTTPS，見下方「限制與接下來」

## 快速開始

```sh
git clone https://github.com/KaneJU/vibe-workshop.git
cd vibe-workshop
npm install
npm start
```

打開 <http://localhost:5310>。第一次啟動會載入一組示範場景（`examples/starter`）。在下方輸入框打你想要的東西，按 Enter。

## 操作

| 動作 | 電腦 | 手機 |
|---|---|---|
| 看 | 拖曳空白處轉視角；右鍵拖曳平移；滾輪縮放 | 一指轉視角；兩指縮放、平移 |
| 選取 | 點一下；Shift＋點可多選 | 點一下；要選好幾個先按「多選」 |
| 移動／疊放 | 拖曳物件，放到別的物件上就會疊上去 | 按住拖曳 |
| 旋轉／縮放 | Q / E、R / F | 上方動作列的 ⟲ ⟳ ＋ － |
| 刪除／複製／復原 | Delete、⌘D、⌘Z | 上方動作列 |
| 存成零件 | G 或「存成零件」 | 上方動作列 |
| 打造 | 打字後按 Enter，或按 🎙 用說的 | 打字，或用鍵盤上的聽寫 |
| 改造 | 選一個 AI 做的物件，勾「改造選取的物件」，再說要怎麼改 | 同左 |

不經過 AI、直接執行的指令：「把這疊存成零件，叫砲台」「復原」「刪除」「拆開」「複製 3 個」（英文也可以：*save as part called turret*、*undo*、*delete*、*ungroup*、*duplicate 3*）。

用什麼語言下指令都可以，零件名稱會跟著你用的語言。

## 改世界：環境與規則

不只是物件，世界本身也是由一個個模組組成，你人在裡面就能直接換掉。固定不動的只有一個很小的核心：畫面、輸入、存檔、載入模組。

| 種類 | 改的是什麼 | 可以這樣說 |
|---|---|---|
| 🌍 環境（一次一個） | 天空、地面、燈光、天氣 | 「把這裡變成月球表面」「下雨的夜晚城市」 |
| 📜 規則（可以同時好幾個） | 物理、玩法、計分、開車手感 | 「加上重力」「做一條賽道，跑三圈計時」「車子開快一點而且會甩尾」 |

不用自己選種類，Codex 會從你說的話判斷。想改正在用的模組（例如「天空換成紫色的晚霞」），Codex 會寫一個新版本把它換掉。在工具箱的「🌍 世界」分頁可以開關、移除。

安全機制：

- 模組出錯，或每一格要花超過約 8 毫秒，會被自動拔掉，世界其他部分照常運作；如果它是換版上來的，就退回上一版。
- 新模組要先在電腦上用假的世界試跑才會被接受：跑 3 秒、試開車鉤子，還會檢查中間 28 公尺的地面是平的（物件和車子都走在 y = 0）。
- 「🛡️ 安全模式」一鍵停掉所有模組；網址加 `?safe=1` 打開時，不載入任何模組。

<img src="docs/screenshot-moon.jpg" width="220" alt="手機上的月球環境"> <img src="docs/screenshot-drift.jpg" width="220" alt="在月球上開車甩尾">

## 操作：開車、飛行、穿戴

選一個物件按 **▶ 操作**，或直接說「開車」「起飛」「戴上」。

| 模式 | 會發生什麼 | 手機 | 電腦 |
|---|---|---|---|
| 🚗 開車 | 鏡頭跟在車子後面 | 左下搖桿：往上油門、往下倒車、左右轉彎 | W／S、A／D |
| 🛸 飛行 | 跟開車一樣，再加上升降；轉彎時機身會傾斜 | 搖桿＋▲▼ | WASD＋E／Q |
| 🧤 穿戴 | 東西戴在右手、用第一人稱看；可以走路、看四周 | 搖桿走路、拖曳畫面看四周、⟲ 轉一下手上的東西 | WASD、拖曳 |

⚡（空白鍵）是動作鍵。照新規格做的零件會自己宣告怎麼操作，並用自己的 `onControl` 做出反應：示範的卡丁車輪子會滾、前輪會轉向、倒車煞車燈會亮、按 ⚡ 噴氮氣；示範的手套會握拳、發出強光。舊零件會從名字猜操作方式，猜不出來就跳出選單問你。按「✕ 離開」或 Esc 離開。手機操作以 iPhone 為主設計和測試。

彩蛋：戴上名字叫「無限手套」的東西，按 ⚡。

<img src="docs/screenshot-drive.jpg" width="220" alt="用手機開示範卡丁車"> <img src="docs/screenshot-wear.jpg" width="220" alt="用手機戴上示範手套">

## 用手機看（同一個網路）

1. 用 `HOST=0.0.0.0 npm start` 啟動（或安裝背景服務時加 `--lan`）。
2. 會在 `data/access-key` 產生一組通行碼。
3. 手機打開 `http://<電腦的 IP>:5310/?key=<通行碼>` 一次，之後這支手機會記住一年。

在電腦本機開不需要通行碼。其他裝置都要通行碼，而且不是私人網段的位址一律擋掉。

## 設定

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `5310` | 網頁埠號 |
| `HOST` | `127.0.0.1` | 設成 `0.0.0.0` 讓同網路的手機連得到（要通行碼） |
| `DATA_DIR` | `./data` | 場景、工具箱、生成的零件、通行碼 |
| `CODEX_BIN` | `codex` | Codex CLI 的路徑 |
| `CODEX_MODEL` | Codex 預設 | 傳給 `codex exec -m` 的模型 |

## 在背景常駐（macOS）

```sh
./launchd/install-macos.sh          # 只有這台電腦能用
./launchd/install-macos.sh --lan    # 同網路的手機也能用
```

會裝一個 LaunchAgent：開機登入後自動啟動，當掉會自己重開。移除方法：

```sh
launchctl bootout gui/$(id -u)/com.vibeworkshop.server
rm ~/Library/LaunchAgents/com.vibeworkshop.server.plist
```

## 安全須知

- AI 寫的程式會在你的瀏覽器分頁裡執行。這是給自己玩的創作工具，不是給陌生人用的沙盒。
- Codex 以 `--sandbox workspace-write` 執行，只能寫入 `jobs/` 底下該次任務的資料夾。
- 伺服器預設只聽本機。區網模式要通行碼，而且網址必須指名這台電腦（防 DNS rebinding）。
- 不要開放到公開網路上。

## 測試

測試會改動場景，所以要對一個用完即丟的資料夾跑（空資料夾第一次啟動時，會自動放入測試會用到的示範零件）：

```sh
npx playwright install chromium
rm -rf /tmp/vw-test-data
DATA_DIR=/tmp/vw-test-data PORT=5311 HOST=0.0.0.0 npm start &
npm test                 # 電腦版：疊放、存成零件、刪除與復原、重新整理還在
npm run test:mobile      # 模擬 iPhone 走區網：通行碼、抽屜、手指拖曳、多選
npm run test:control     # iPhone：開車、換成飛行、穿戴、選單、彈指；再加電腦 WASD
npm run test:world       # iPhone：月球、重力、甩尾、出錯隔離、換版退回、太慢自動拔掉、安全模式
WITH_CODEX=1 npm test    # 再加跑一次真的打造和改造（會用 Codex 額度）
```

## 專案結構

```
server.mjs              網頁伺服器、存檔、派工給 Codex、通行碼
fabricator/AGENTS.md    給 Codex 的零件規格書
fabricator/validate.mjs 零件驗收程式（Codex 也會自己跑）
public/runtime.mjs      瀏覽器和驗收共用的零件組裝核心（套層與數量上限）
public/app.js           工坊本體：場景、選取、拖曳疊放、工具箱、語音、WebXR
public/control.mjs      操作引擎：開車、飛行、穿戴（搖桿、按鈕、鍵盤）
public/worldhost.mjs    世界模組宿主，瀏覽器和驗收共用（隔離、清理、效能看門狗）
public/worlds.mjs       「🌍 世界」分頁：開關、退回上一版、安全模式
public/index.html       頁面與操作說明
examples/starter/       第一次啟動時載入的示範零件與場景
launchd/                macOS 背景服務範本與安裝腳本
tests/                  Playwright 測試（電腦版與手機版）
```

## 限制與接下來

- 介面目前只有繁體中文。
- VR 模式（進入 VR、用手把抓起來疊）還沒在真的頭盔上測過，VR 裡也還不能用說的打造。
- 頭盔要 HTTPS 才能進 WebXR，瀏覽器也要 HTTPS 才給網頁用麥克風。在區網用 http 連時，請改用手機鍵盤的聽寫。
- AI 看不到自己做出來的樣子，只看得到驗收回報的數字。下一步想讓它截圖、自己看、自己修。
- 還沒有物理效果：東西不會掉落、不會倒，車子也會直接穿過其他東西。
- VR 裡還不能用操作模式。
- 環境的中間 28 公尺地面一定要平；車子還不會沿著地形高低起伏。

## 授權

[MIT](LICENSE)。使用 [three.js](https://threejs.org/) 與 [OpenAI Codex CLI](https://github.com/openai/codex) 打造。
